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
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const SaleSignal = require("../models/SaleSignal");
const TwitchCampaign = require("../models/TwitchCampaign");
const {
  gameflipScout,
  gameflipSoldScout,
  platiScout,
  ggselScout,
  funpayScout,
} = require("./priceScout");
const mp = require("./marketplaces");
const settings = require("./settings");

// The scanner wakes hourly and scans only the games that are DUE, rather than
// sweeping every game it has ever seen on a flat 12h clock. That clock gave a
// campaign ending tomorrow exactly the same freshness as a game with no
// campaign since last year, while the sweep itself grew with every game ever
// farmed — so the urgent work got slower as the archive got bigger.
const TICK_MS = 60 * 60 * 1000;
const CONCURRENCY = 3;
const RECENT_DAYS = 30;
// Ceiling on games per tick so one pass cannot run for hours or hammer the
// marketplaces; anything still due is picked up by the next tick, worst-first.
const MAX_PER_TICK = 60;

// How stale a game's research may get before it is rescanned, by how much the
// answer can still change anything. A decision that has to be made this week
// deserves fresh data; a game nobody can farm does not.
const FRESHNESS_MS = {
  endingSoon: 3 * 3600000, // active campaign, < 48h left — the last call to act
  active: 6 * 3600000, // campaign running now — allocation still open
  upcoming: 12 * 3600000, // campaign announced — decide before it starts
  seller: 24 * 3600000, // no campaign but it sells — worth watching
  idle: 72 * 3600000, // no campaign, no demand — a background check
};

function freshnessFor(camp, demandScore) {
  const endAt = camp && camp.endAt ? new Date(camp.endAt).getTime() : null;
  const hoursLeft = endAt == null ? null : (endAt - Date.now()) / 3600000;
  if (camp && camp.active) {
    if (hoursLeft != null && hoursLeft > 0 && hoursLeft < 48) {
      return FRESHNESS_MS.endingSoon;
    }
    return FRESHNESS_MS.active;
  }
  if (camp && camp.upcoming) return FRESHNESS_MS.upcoming;
  if (Number(demandScore) >= 15) return FRESHNESS_MS.seller;
  return FRESHNESS_MS.idle;
}
// How many sold rows to ask Gameflip for. This was 20 and it was not a page
// size but a ceiling on demand: recent verified sales are the heaviest term in
// the score, so every game with 20+ of them scored the same and the best games
// were indistinguishable. Measured live, a busy game has ~40.
const MAX_SCAN_ROWS = 100;

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  progress: { done: 0, total: 0 },
};

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Saturating 0..1 curve: `half` is the value that scores 0.5, and nothing can
// ever exceed 1. This replaced raw log sums, which were unbounded — the score
// ran to ~300 on a normal game while the tiers that read it were written for
// 0-100, so every game with any market presence at all cleared them. A bounded
// term means a threshold keeps meaning the same thing however loud one market
// gets, and one runaway number can no longer drown out the others.
function sat(n, half) {
  const x = Math.max(0, Number(n) || 0);
  return x / (x + half);
}

// Where each term reaches half marks. These are the calibration, so they are
// named rather than inlined: raising one makes that evidence harder to earn.
const HALF_RECENT_SALES = 6; // verified sales in the 30d window
const HALF_REVENUE_USD = 40; // observed money moved in that window
const HALF_LIFETIME_SALES = 150; // GGSel + Plati lifetime counters
const HALF_PRICE_USD = 3; // typical unit price
const HALF_SELLERS = 8; // distinct rival sellers
const HALF_VELOCITY = 5; // GGSel+Plati units sold per week

// Trend/velocity window. A snapshot at least this old is compared against the
// current scan; scans run every 12h, so there are ~14 in between.
const TREND_DAYS = 7;
// How far back beyond the trend cutoff to look for a comparison snapshot. Keeps
// the history query bounded — see priorSnapshots.
const TREND_BAND_DAYS = 14;
// Counters only ever go up. A drop means the seller delisted or the market
// reindexed, not negative sales, so a decrease is read as "no information"
// rather than allowed to subtract from a game's demand.
function velocityPerWeek(nowTotal, thenTotal, days) {
  const d = Number(days) || 0;
  if (d <= 0) return null;
  const delta = Number(nowTotal) - Number(thenTotal);
  if (!Number.isFinite(delta) || delta < 0) return null;
  return (delta / d) * 7;
}

// Distinct sellers and distinct products behind a pile of listing rows.
// Rows are not rivals: one seller can paper a search page with the same
// bundle, and counting rows made the busiest-looking markets score as the most
// contested when they were often the emptiest.
function competitionOf(rowsByMarket) {
  const sellers = new Set();
  const offers = new Set();
  for (const [market, rows] of Object.entries(rowsByMarket)) {
    for (const r of rows) {
      // Seller ids are only unique within a marketplace, so namespace them.
      // Rows from a market that exposes no seller id fall back to the title,
      // which at worst counts distinct products — never one seller as many.
      const id = String(r.seller || r.sellerName || r.title || "").trim();
      if (id) sellers.add(market + ":" + id.toLowerCase());
      const t = String(r.title || "").trim().toLowerCase();
      if (t) offers.add(market + ":" + t);
    }
  }
  return { sellers: sellers.size, offers: offers.size };
}

// Middle price of a set of rows — the typical asking price, unmoved by one
// junk $0.01 listing or one 10000-item mega-bundle at the top.
function medianPrice(rows) {
  const prices = rows
    .map((r) => Number(r.price))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return 0;
  return Math.round(prices[Math.floor(prices.length / 2)] * 100) / 100;
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

// FunPay node ids per game, learned from our own listings and overridable by
// hand. FunPay has no cross-game search — each game's Twitch-drop category is a
// separate page — so research can only see a game there once it knows the node.
// Every FunPay listing we publish records its node (externalNode, needed for
// delisting), which makes the map build itself for every game we already sell,
// with autoFarm.funpayNodes covering anything not published yet.
async function funpayNodeMap() {
  const map = {};
  try {
    const af = settings.getAutoFarm();
    const manual = (af && af.funpayNodes) || {};
    for (const [g, node] of Object.entries(manual)) {
      const n = String(node || "").trim();
      if (g && n) map[String(g).toLowerCase()] = n;
    }
  } catch {
    /* settings unreadable — fall back to whatever our listings teach us */
  }
  try {
    const rows = await MarketplaceListing.find({
      marketplace: "funpay",
      externalNode: { $nin: ["", null] },
    })
      .select("set externalNode")
      .lean();
    if (rows.length) {
      const sets = await DropSet.find({
        _id: { $in: rows.map((r) => r.set) },
      })
        .select("coverGame items.game")
        .lean();
      const gameOf = {};
      for (const s of sets) {
        const g =
          s.coverGame ||
          (Array.isArray(s.items) && s.items[0] && s.items[0].game) ||
          "";
        if (g) gameOf[String(s._id)] = g.toLowerCase();
      }
      for (const r of rows) {
        const g = gameOf[String(r.set)];
        // A hand-set override wins over anything inferred.
        if (g && !map[g]) map[g] = String(r.externalNode);
      }
    }
  } catch (e) {
    console.error("funpay node map:", e.message);
  }
  return map;
}

async function scanGame(game, campaignsByGame, ctx = {}) {
  const term = game + " twitch drops";
  const settle = (p) =>
    p.then(
      (v) => v,
      () => [],
    );
  const fpNode = (ctx.funpayNodes || {})[game.toLowerCase()] || "";
  const [gfSold, gfActive, gg, pl, fp] = await Promise.all([
    settle(gameflipSoldScout(term, MAX_SCAN_ROWS)),
    settle(gameflipScout(term)),
    settle(ggselScout(term)),
    settle(platiScout(term)),
    fpNode ? settle(funpayScout(fpNode, ctx.usdPerEur || 1)) : Promise.resolve([]),
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
      median: medianPrice(gfActiveRel),
      ...competitionOf({ gameflip: gfActiveRel }),
    },
    ggsel: {
      totalSold: sumSold(ggRel),
      active: ggRel.length,
      lowest: lowestOf(ggRel),
      median: medianPrice(ggRel),
      ...competitionOf({ ggsel: ggRel }),
    },
    plati: {
      totalSold: sumSold(plRel),
      active: plRel.length,
      lowest: lowestOf(plRel),
      median: medianPrice(plRel),
      ...competitionOf({ plati: plRel }),
    },
  };
  // FunPay only appears for games whose node we know. Its rows need no
  // relevance filter — the whole node IS this game's Twitch-drop market — and
  // it publishes no sale counters, so it contributes competition and price
  // only, never demand.
  if (fpNode) {
    markets.funpay = {
      node: fpNode,
      totalSold: 0,
      active: fp.length,
      lowest: lowestOf(fp),
      median: medianPrice(fp),
      ...competitionOf({ funpay: fp }),
    };
  }

  // Money the markets moved recently, as far as anything dates its sales.
  // Gameflip is the only one that does, so this is a floor on real turnover,
  // not a total — which is fine, it is used comparatively between games.
  const observedRevenue =
    Math.round(markets.gameflip.soldRecent * avgSoldPrice * 100) / 100;
  const lifetime = markets.ggsel.totalSold + markets.plati.totalSold;
  // Typical price across every live listing anywhere, so a game that only
  // sells on the Russian markets still gets a price signal.
  const typicalPrice = medianPrice([...gfActiveRel, ...ggRel, ...plRel, ...fp]);

  // GGSel and Plati never date a sale, but their lifetime counters move, and
  // the previous scan recorded where they stood. The difference is real units
  // sold in a real window — strictly better evidence than the lifetime total,
  // so when it is available it takes that term's place at the same weight
  // rather than being added on top (which would count the same sales twice).
  const prior = ctx.prior && ctx.prior[game.toLowerCase()];
  const perWeek = prior
    ? velocityPerWeek(lifetime, prior.lifetimeSold, prior.days)
    : null;
  const lifetimeTerm =
    perWeek == null
      ? sat(lifetime, HALF_LIFETIME_SALES)
      : sat(perWeek, HALF_VELOCITY);

  // Demand, 0-100. Four kinds of evidence, weighted by how much each proves:
  //   verified recent sales  — dated and confirmed, the strongest thing we see
  //   the money those moved  — separates a good game from a merely busy one
  //   RU-market sales        — a real weekly rate once there is history to
  //                            difference, the lifetime total before that
  //   typical price          — a market that sustains real prices is worth more
  const demandScore = round1(
    100 *
      (0.4 * sat(markets.gameflip.soldRecent, HALF_RECENT_SALES) +
        0.3 * sat(observedRevenue, HALF_REVENUE_USD) +
        0.2 * lifetimeTerm +
        0.1 * sat(typicalPrice, HALF_PRICE_USD)),
  );

  const comp = competitionOf({
    gameflip: gfActiveRel,
    ggsel: ggRel,
    plati: plRel,
    funpay: fp,
  });
  const competitionScore = round1(100 * sat(comp.sellers, HALF_SELLERS));
  // Never negative: a crowded market is worth nothing, not less than nothing,
  // and a negative opportunity sorted below games with no data at all.
  const opportunityScore = round1(
    Math.max(0, demandScore - 0.5 * competitionScore),
  );

  const camp = campaignsByGame[game.toLowerCase()] || {
    active: false,
    upcoming: false,
    count: 0,
    endAt: null,
  };
  return {
    term,
    markets,
    observedRevenue,
    sellers: comp.sellers,
    offers: comp.offers,
    lifetimeSold: lifetime,
    typicalPrice,
    // Units per week across GGSel + Plati, null until there is history to
    // difference against.
    salesPerWeek: perWeek == null ? null : Math.round(perWeek * 10) / 10,
    // How the score has moved since the comparison snapshot. null on a game's
    // first-ever scan.
    demandTrend:
      prior && prior.demandScore != null
        ? round1(demandScore - prior.demandScore)
        : null,
    demandScore,
    competitionScore,
    opportunityScore,
    camp,
  };
}

// A meaningful move in demand between the trend snapshots. Below this is
// scan-to-scan noise (a competitor relisting, one sale landing either side of
// the window) and saying "rising"/"falling" about it would be wrong more often
// than right.
const TREND_NOTE = 8;

function recommend(doc) {
  const d = doc.demandScore;
  const camp = doc.campaign || {};
  const daysLeft = camp.endAt
    ? (new Date(camp.endAt).getTime() - Date.now()) / 86400000
    : null;
  // Direction, when there is enough history to have one. The same score means
  // different things depending on which way it is going — a game at 35 and
  // climbing is worth starting, the same game sliding is worth leaving.
  const t = doc.demandTrend;
  const arrow =
    t == null || Math.abs(t) < TREND_NOTE
      ? ""
      : t > 0
        ? " (rising)"
        : " (falling)";
  if (!camp.active && !camp.upcoming) {
    return d >= 40
      ? "Sells well — watch for next campaign" + arrow
      : "No campaign";
  }
  if (d >= 40 && camp.active && daysLeft != null && daysLeft <= 5) {
    return "Ends soon — act now";
  }
  if (d >= 40) {
    return (doc.farmedAccounts > 0 ? "Farm more" : "Start farming") + arrow;
  }
  if (d >= 15) {
    return (doc.farmedAccounts > 0 ? "Keep farming" : "Worth trying") + arrow;
  }
  // A low score that is climbing hard is the one case worth flagging rather
  // than dismissing — it is what a game looks like just before a campaign.
  if (t != null && t >= TREND_NOTE) return "Low demand but rising — watch";
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

  // Our own realised sales in the research window, per game, with the money
  // they brought in. Only sources that mean a buyer paid — "drop_reserved" is
  // stock being claimed for a shelf and is not evidence of anything selling.
  const salesBy = {};
  try {
    const rows = await SaleSignal.aggregate([
      {
        $match: {
          at: { $gte: new Date(Date.now() - RECENT_DAYS * 86400000) },
          source: { $in: ["connected", "listing_sold"] },
        },
      },
      {
        $group: {
          _id: {
            game: "$gameKey",
            sale: { $ifNull: ["$account", "$dedupeKey"] },
          },
          priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
        },
      },
      {
        $group: {
          _id: "$_id.game",
          sales: { $sum: 1 },
          revenue: { $sum: "$priceUsd" },
        },
      },
    ]);
    for (const r of rows) {
      salesBy[r._id] = {
        sales: r.sales || 0,
        revenueRaw: r.revenue || 0,
        revenue: Math.round((r.revenue || 0) * 100) / 100,
      };
    }
  } catch (e) {
    console.error("market research own-sales rollup:", e.message);
  }

  // The same sales split by marketplace. This is the only demand signal that
  // exists at all for the markets nothing can scout: ZeusX publishes no
  // keyword search, and Z2U and EpicNPC sit behind bot protection that a
  // server-side fetch cannot pass. We cannot see their competitors — but we
  // can see what WE sell there, which is the number that decides where stock
  // should go next.
  const marketBy = {};
  try {
    const rows = await SaleSignal.aggregate([
      {
        $match: {
          at: { $gte: new Date(Date.now() - RECENT_DAYS * 86400000) },
          source: "listing_sold",
          marketplace: { $nin: ["", null] },
        },
      },
      {
        $group: {
          _id: { game: "$gameKey", market: "$marketplace" },
          sales: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$priceUsd", 0] } },
        },
      },
    ]);
    for (const r of rows) {
      const g = r._id.game;
      if (!marketBy[g]) marketBy[g] = {};
      marketBy[g][r._id.market] = {
        sales: r.sales || 0,
        revenue: Math.round((r.revenue || 0) * 100) / 100,
      };
    }
  } catch (e) {
    console.error("market research per-market rollup:", e.message);
  }
  return { farmBy, soldBy, activeBy, salesBy, marketBy };
}

// The comparison snapshot for every game: the newest one at least TREND_DAYS
// old. One aggregation for the whole scan rather than a query per game —
// prod Mongo is a shared Atlas tier that serialises concurrent queries, so
// round trips are the thing to spend carefully.
//
// Taking the newest snapshot OLDER than the window (rather than the oldest
// inside it) keeps the comparison window from stretching as history builds up:
// a rate needs a known interval, and `days` is carried along for exactly that.
async function priorSnapshots() {
  const cutoff = new Date(Date.now() - TREND_DAYS * 86400000);
  // Only look inside a bounded band ending at the cutoff, never at all history
  // before it. Prod Mongo is a shared Atlas tier with allowDiskUse disabled, so
  // a blocking sort has a hard 100MB ceiling — and this collection grows every
  // scan of every game forever. Matching `at <= cutoff` alone would sort the
  // entire archive and fail with no warning once it got big enough, months
  // after the code shipped and looked fine.
  //
  // The band is wide enough that every priority lane has several snapshots in
  // it (the slowest games are scanned every 72h), so nothing loses its
  // comparison point.
  const bandStart = new Date(
    Date.now() - (TREND_DAYS + TREND_BAND_DAYS) * 86400000,
  );
  const rows = await MarketResearchSnapshot.aggregate([
    { $match: { at: { $gte: bandStart, $lte: cutoff } } },
    { $sort: { gameKey: 1, at: -1 } },
    {
      $group: {
        _id: "$gameKey",
        at: { $first: "$at" },
        demandScore: { $first: "$demandScore" },
        lifetimeSold: { $first: "$lifetimeSold" },
      },
    },
  ]);
  const out = {};
  const now = Date.now();
  for (const r of rows) {
    out[r._id] = {
      demandScore: r.demandScore,
      lifetimeSold: r.lifetimeSold,
      days: (now - new Date(r.at).getTime()) / 86400000,
    };
  }
  return out;
}

// Everything a scan needs that is the same for every game, resolved once per
// pass rather than per game: which FunPay node each game lives in, the FX rate
// for FunPay's prices (its /en/ pages quote EUR), and the history each game is
// compared against.
async function scanContext() {
  const ctx = { funpayNodes: {}, usdPerEur: 1, prior: {} };
  try {
    ctx.funpayNodes = await funpayNodeMap();
  } catch (e) {
    console.error("scan context funpay nodes:", e.message);
  }
  try {
    ctx.prior = await priorSnapshots();
  } catch (e) {
    console.error("scan context history:", e.message);
  }
  try {
    // usdRate("EUR") gives EUR per USD; FunPay prices are EUR, so invert.
    const eurPerUsd = await mp.usdRate("EUR");
    if (eurPerUsd > 0) ctx.usdPerEur = 1 / eurPerUsd;
  } catch (e) {
    console.error("scan context fx:", e.message);
  }
  return ctx;
}

// Which games this tick should actually scan, worst-overdue first.
//
// `all` forces every game, which is what the operator's "Scan now" button
// means — they asked for a full refresh, not for the scheduler's opinion.
async function dueGames(games, campaignsByGame, all) {
  // No cap on a forced scan. MAX_PER_TICK exists to stop the hourly tick from
  // running for hours unattended; an operator who pressed the button asked for
  // every game, and silently doing 60 of 300 would be a worse answer than a
  // slow one.
  if (all) return games;
  const rows = await MarketResearch.find({})
    .select("game scannedAt demandScore")
    .lean();
  const seen = new Map();
  for (const r of rows) {
    seen.set(String(r.game || "").toLowerCase(), r);
  }
  const now = Date.now();
  const scored = [];
  for (const game of games) {
    const prev = seen.get(game.toLowerCase());
    // Never scanned: maximally overdue, so a brand-new campaign is picked up
    // on the very next tick rather than waiting out somebody else's window.
    if (!prev || !prev.scannedAt) {
      scored.push({ game, overdue: Infinity });
      continue;
    }
    const age = now - new Date(prev.scannedAt).getTime();
    const budget = freshnessFor(
      campaignsByGame[game.toLowerCase()],
      prev.demandScore,
    );
    if (age >= budget) scored.push({ game, overdue: age / budget });
  }
  scored.sort((a, b) => b.overdue - a.overdue);
  return scored.slice(0, MAX_PER_TICK).map((s) => s.game);
}

async function runScan(opts = {}) {
  if (state.running) return { started: false, reason: "already running" };
  state.running = true;
  state.lastError = "";
  try {
    const [{ games, campaignsByGame }, own, ctx] = await Promise.all([
      candidateGames(),
      ownStats(),
      scanContext(),
    ]);
    const due = await dueGames(games, campaignsByGame, !!opts.all);
    state.lastDue = { due: due.length, known: games.length };
    if (!due.length) {
      state.lastRun = new Date();
      state.progress = { done: 0, total: 0 };
      return { started: true, scanned: 0, reason: "nothing due" };
    }
    state.progress = { done: 0, total: due.length };
    const queue = [...due];
    const worker = async () => {
      for (;;) {
        const game = queue.shift();
        if (!game) return;
        try {
          const r = await scanGame(game, campaignsByGame, ctx);
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
            ownSales: (own.salesBy[k] || {}).sales || 0,
            ownRevenue: (own.salesBy[k] || {}).revenue || 0,
            ownByMarket: own.marketBy[k] || {},
            markets: r.markets,
            observedRevenue: r.observedRevenue,
            sellers: r.sellers,
            offers: r.offers,
            salesPerWeek: r.salesPerWeek,
            demandTrend: r.demandTrend,
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
          // History for the next scan to difference against. Best-effort: it
          // improves later scans and must never fail the current one.
          await MarketResearchSnapshot.create({
            game,
            gameKey: k,
            at: doc.scannedAt,
            demandScore: r.demandScore,
            competitionScore: r.competitionScore,
            opportunityScore: r.opportunityScore,
            soldRecent: (r.markets.gameflip || {}).soldRecent || 0,
            observedRevenue: r.observedRevenue,
            lifetimeSold: r.lifetimeSold,
            typicalPrice: r.typicalPrice,
            sellers: r.sellers,
            offers: r.offers,
            ownSales: doc.ownSales,
            ownRevenue: doc.ownRevenue,
          }).catch((e) =>
            console.error("research snapshot:", game, e.message),
          );
        } catch (e) {
          console.error("market research:", game, e.message);
        }
        state.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    state.lastRun = new Date();
    return { started: true, scanned: due.length };
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
    // What the last pass found to do, so the UI can show "12 of 300 due"
    // rather than implying every game is rescanned every time.
    lastDue: state.lastDue || null,
    freshnessHours: Object.fromEntries(
      Object.entries(FRESHNESS_MS).map(([k, v]) => [k, v / 3600000]),
    ),
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
  // First pass shortly after boot (let Mongo connect), then hourly — each tick
  // scanning only what has gone stale for its own priority.
  const t = setTimeout(tick, 60 * 1000);
  if (t.unref) t.unref();
}

// On-demand single-game research for the auto-farmer: hit Gameflip (sold +
// active), GGSel and Plati live, score the game, upsert the MarketResearch
// doc, and return it. Used when the farmer meets a campaign whose research
// is missing or stale — a fresh decision needs fresh market data.
async function refreshGame(game) {
  const [{ campaignsByGame }, ctx] = await Promise.all([
    candidateGames(),
    scanContext(),
  ]);
  const r = await scanGame(game, campaignsByGame, ctx);
  const doc = {
    game,
    term: r.term,
    campaign: {
      active: !!r.camp.active,
      upcoming: !!r.camp.upcoming,
      count: r.camp.count || 0,
      endAt: r.camp.endAt || null,
    },
    markets: r.markets,
    observedRevenue: r.observedRevenue,
    sellers: r.sellers,
    offers: r.offers,
    salesPerWeek: r.salesPerWeek,
    demandTrend: r.demandTrend,
    demandScore: r.demandScore,
    competitionScore: r.competitionScore,
    opportunityScore: r.opportunityScore,
    scannedAt: new Date(),
  };
  // recommend() reads farmedAccounts to say "farm more" vs "start farming",
  // and this path does not recompute the own-side stats — so read the ones the
  // last full scan stored rather than letting an absent field read as zero.
  const prior = await MarketResearch.findOne({ game })
    .select("farmedAccounts")
    .lean();
  doc.recommendation = recommend({
    ...doc,
    farmedAccounts: (prior && prior.farmedAccounts) || 0,
  });
  await MarketResearch.updateOne({ game }, { $set: doc }, { upsert: true });
  // The auto-farmer calls this whenever a game's research is stale, which for
  // an actively-farmed game is most of the scans it ever gets. Recording the
  // snapshot here too is what keeps the GGSel/Plati velocity working for
  // exactly the games the farmer cares most about.
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: doc.scannedAt,
    demandScore: r.demandScore,
    competitionScore: r.competitionScore,
    opportunityScore: r.opportunityScore,
    soldRecent: (r.markets.gameflip || {}).soldRecent || 0,
    observedRevenue: r.observedRevenue,
    lifetimeSold: r.lifetimeSold,
    typicalPrice: r.typicalPrice,
    sellers: r.sellers,
    offers: r.offers,
  }).catch((e) => console.error("research snapshot:", game, e.message));
  return MarketResearch.findOne({ game }).lean();
}

module.exports = {
  runScan,
  status,
  start,
  refreshGame,
  // Exported for tests: the scoring calibration, the scheduling/velocity
  // arithmetic, and the database rollups (whose aggregation pipelines only
  // fail at runtime, so they need to actually run against Mongo somewhere).
  sat,
  competitionOf,
  medianPrice,
  freshnessFor,
  velocityPerWeek,
  ownStats,
  priorSnapshots,
  dueGames,
  funpayNodeMap,
  recommend,
};
