// Market-research scanner: figures out which games' twitch drops actually
// sell so the bot fleet can be pointed at the most profitable campaigns.
//
// For every game with an active/upcoming Twitch campaign (campaign watcher
// catalog) or already-farmed drops, it searches "<game> twitch drops" across
// Gameflip (sold + on-sale), GGSel and Plati, and rolls the signals into a
// per-game snapshot with demand / competition / opportunity scores.
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const TwitchCampaign = require("../models/TwitchCampaign");
const {
  gameflipScout,
  gameflipSoldScout,
  platiScout,
  ggselScout,
} = require("./priceScout");

const TICK_MS = 12 * 60 * 60 * 1000; // full rescan every 12 hours
const CONCURRENCY = 3;
const RECENT_DAYS = 30;

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  progress: { done: 0, total: 0 },
};

function log1p(n) {
  return Math.log(1 + Math.max(0, Number(n) || 0));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Only count listings that actually look like this game's twitch-drop stock:
// a plain term search also matches skins/keys/accounts for other things.
function relevant(rows, game) {
  const g = String(game || "").toLowerCase();
  const words = g.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return rows.filter((r) => {
    const t = String(r.title || "").toLowerCase();
    if (!/twitch|drop/.test(t)) return false;
    if (!words.length) return true;
    let hits = 0;
    for (const w of words) if (t.includes(w)) hits++;
    return hits >= Math.min(2, words.length);
  });
}

async function scanGame(game, campaignsByGame) {
  const term = game + " twitch drops";
  const settle = (p) =>
    p.then(
      (v) => v,
      () => [],
    );
  const [gfSold, gfActive, gg, pl] = await Promise.all([
    settle(gameflipSoldScout(term, 20)),
    settle(gameflipScout(term)),
    settle(ggselScout(term)),
    settle(platiScout(term)),
  ]);
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const gfSoldRel = relevant(gfSold, game);
  const gfActiveRel = relevant(gfActive, game);
  const ggRel = relevant(gg, game);
  const plRel = relevant(pl, game);

  const soldRecentRows = gfSoldRel.filter(
    (r) => r.updated && new Date(r.updated).getTime() >= cutoff,
  );
  const soldPrices = soldRecentRows.map((r) => r.price).filter((p) => p > 0);
  const avgSoldPrice = soldPrices.length
    ? soldPrices.reduce((a, b) => a + b, 0) / soldPrices.length
    : 0;
  const lastSold = gfSoldRel
    .map((r) => (r.updated ? new Date(r.updated) : null))
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  const lowestOf = (rows) =>
    rows.length ? Math.min(...rows.map((r) => r.price)) : 0;
  const sumSold = (rows) => rows.reduce((a, r) => a + (Number(r.sold) || 0), 0);

  const markets = {
    gameflip: {
      soldRecent: soldRecentRows.length,
      soldTotal: gfSoldRel.length,
      avgSoldPrice: Math.round(avgSoldPrice * 100) / 100,
      lastSoldAt: lastSold || null,
      active: gfActiveRel.length,
      lowest: lowestOf(gfActiveRel),
    },
    ggsel: {
      totalSold: sumSold(ggRel),
      active: ggRel.length,
      lowest: lowestOf(ggRel),
    },
    plati: {
      totalSold: sumSold(plRel),
      active: plRel.length,
      lowest: lowestOf(plRel),
    },
  };

  // Demand: recent Gameflip sales carry the most weight (dated, verified
  // sales); GGSel/Plati lifetime sale counters back them up. Log-dampened so
  // one mega-seller doesn't drown everything.
  const demandScore = round1(
    35 * log1p(markets.gameflip.soldRecent) +
      12 * log1p(markets.ggsel.totalSold) +
      12 * log1p(markets.plati.totalSold) +
      8 * log1p(avgSoldPrice),
  );
  const competitionScore = round1(
    10 *
      log1p(
        markets.gameflip.active + markets.ggsel.active + markets.plati.active,
      ),
  );
  const opportunityScore = round1(demandScore - 0.5 * competitionScore);

  const camp = campaignsByGame[game.toLowerCase()] || {
    active: false,
    upcoming: false,
    count: 0,
    endAt: null,
  };
  return {
    term,
    markets,
    demandScore,
    competitionScore,
    opportunityScore,
    camp,
  };
}

function recommend(doc) {
  const d = doc.demandScore;
  const camp = doc.campaign || {};
  const daysLeft = camp.endAt
    ? (new Date(camp.endAt).getTime() - Date.now()) / 86400000
    : null;
  if (!camp.active && !camp.upcoming) {
    return d >= 40 ? "Sells well — watch for next campaign" : "No campaign";
  }
  if (d >= 40 && camp.active && daysLeft != null && daysLeft <= 5) {
    return "Ends soon — act now";
  }
  if (d >= 40) {
    return doc.farmedAccounts > 0 ? "Farm more" : "Start farming";
  }
  if (d >= 15) {
    return doc.farmedAccounts > 0 ? "Keep farming" : "Worth trying";
  }
  return "Low demand";
}

async function candidateGames() {
  const [campaigns, farmed] = await Promise.all([
    TwitchCampaign.find({ active: true }).select("game status endAt").lean(),
    DropLog.distinct("game"),
  ]);
  const byGame = {};
  for (const c of campaigns) {
    const g = String(c.game || "").trim();
    if (!g) continue;
    const k = g.toLowerCase();
    const cur = byGame[k] || {
      name: g,
      active: false,
      upcoming: false,
      count: 0,
      endAt: null,
    };
    cur.count++;
    if (c.status === "ACTIVE") cur.active = true;
    if (c.status === "UPCOMING") cur.upcoming = true;
    if (c.endAt && (!cur.endAt || new Date(c.endAt) > new Date(cur.endAt))) {
      cur.endAt = c.endAt;
    }
    byGame[k] = cur;
  }
  const names = new Map();
  for (const k of Object.keys(byGame)) names.set(k, byGame[k].name);
  for (const g of farmed) {
    const t = String(g || "").trim();
    if (t && !names.has(t.toLowerCase())) names.set(t.toLowerCase(), t);
  }
  return { games: [...names.values()], campaignsByGame: byGame };
}

async function ownStats() {
  const [farm, sets, sold] = await Promise.all([
    DropLog.aggregate([
      { $match: { game: { $ne: "" } } },
      {
        $group: {
          _id: { $toLower: "$game" },
          accounts: { $addToSet: "$account" },
          items: { $sum: 1 },
        },
      },
    ]),
    DropSet.find({}).select("coverGame items.game listed").lean(),
    MarketplaceListing.find({ status: "sold" }).select("set").lean(),
  ]);
  const farmBy = {};
  for (const f of farm) {
    farmBy[f._id] = { accounts: (f.accounts || []).length, items: f.items };
  }
  // Active/sold listings per game via the set's game(s).
  const setGame = {};
  for (const s of sets) {
    const g =
      s.coverGame ||
      (Array.isArray(s.items) && s.items[0] && s.items[0].game) ||
      "";
    if (g) setGame[String(s._id)] = g.toLowerCase();
  }
  const soldBy = {};
  for (const l of sold) {
    const g = setGame[String(l.set)];
    if (g) soldBy[g] = (soldBy[g] || 0) + 1;
  }
  const activeBy = {};
  const active = await MarketplaceListing.find({ status: "active" })
    .select("set")
    .lean();
  for (const l of active) {
    const g = setGame[String(l.set)];
    if (g) activeBy[g] = (activeBy[g] || 0) + 1;
  }
  return { farmBy, soldBy, activeBy };
}

async function runScan() {
  if (state.running) return { started: false, reason: "already running" };
  state.running = true;
  state.lastError = "";
  try {
    const [{ games, campaignsByGame }, own] = await Promise.all([
      candidateGames(),
      ownStats(),
    ]);
    state.progress = { done: 0, total: games.length };
    const queue = [...games];
    const worker = async () => {
      for (;;) {
        const game = queue.shift();
        if (!game) return;
        try {
          const r = await scanGame(game, campaignsByGame);
          const k = game.toLowerCase();
          const doc = {
            game,
            term: r.term,
            campaign: {
              active: !!r.camp.active,
              upcoming: !!r.camp.upcoming,
              count: r.camp.count || 0,
              endAt: r.camp.endAt || null,
            },
            farmedAccounts: (own.farmBy[k] || {}).accounts || 0,
            farmedItems: (own.farmBy[k] || {}).items || 0,
            ownActive: own.activeBy[k] || 0,
            ownSold: own.soldBy[k] || 0,
            markets: r.markets,
            demandScore: r.demandScore,
            competitionScore: r.competitionScore,
            opportunityScore: r.opportunityScore,
            scannedAt: new Date(),
          };
          doc.recommendation = recommend(doc);
          await MarketResearch.updateOne(
            { game },
            { $set: doc },
            { upsert: true },
          );
        } catch (e) {
          console.error("market research:", game, e.message);
        }
        state.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    state.lastRun = new Date();
  } catch (e) {
    state.lastError = e.message;
    console.error("market research scan failed:", e.message);
  } finally {
    state.running = false;
  }
  return { started: true };
}

function status() {
  return {
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    progress: state.progress,
    intervalHours: TICK_MS / 3600000,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runScan();
    } finally {
      const t = setTimeout(tick, TICK_MS);
      if (t.unref) t.unref();
    }
  };
  // First scan shortly after boot (let Mongo connect), then every 12h.
  const t = setTimeout(tick, 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { runScan, status, start };
