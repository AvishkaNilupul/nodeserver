// AUTO-FARMER — the brain that turns new Twitch drop campaigns into running
// bots without a human in the loop.
//
// Decision pipeline per campaign (see docs in the PR description):
//   master switch -> sellability (MarketResearch demandScore) -> time-left
//   gate -> reuse-first (weekly campaigns restart the game's existing
//   auto-bot) -> allocation math (30/game hard cap, pool reserve floor,
//   fair-share across simultaneous campaigns) -> host capacity gate ->
//   execute (or just plan + Telegram in dry-run mode).
//
// Every decision — including every skip — is stored as an AutoFarmTask and
// alerted via Telegram, so the owner can audit exactly why the system did or
// didn't spend accounts on a game.
const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const AvailableAccount = require("../models/AvailableAccount");
const SaleSignal = require("../models/SaleSignal");
const DropLog = require("../models/DropLog");
const marketResearch = require("./marketResearch");
const hosts = require("./botHosts");
const botFactory = require("./botFactory");
const mp = require("./marketplaces");
const settings = require("./settings");
const { sendTelegram } = require("./telegram");

const TICK_MS = 10 * 60 * 1000; // scan every 10 minutes
const FIRST_TICK_DELAY_MS = 90 * 1000; // let the campaign watcher seed first

// Demand tiers (demandScore is 0-100 from utils/marketResearch.js).
const DEMAND_FULL = 40; // proven seller -> full allocation
const DEMAND_HALF = 15; // some demand -> half allocation; below -> skip
const RESEARCH_STALE_MS = 7 * 86400000; // re-scan markets older than a week
const SALES_WINDOW_MS = 45 * 86400000; // own-sales training window
// Each of our own recent sales is worth this many demand points (log-damped
// below). 5+ recent sales pushes any game to full allocation on its own.
const INTERNAL_SALE_WEIGHT = 18;

// Skips that may be retried when conditions change (pool refills, a
// container slot frees up, the Pi comes back online).
const RETRYABLE = new Set([
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered", // covered accounts may sell — demand reopens
]);

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastSummary: null,
};

// Live progress log for the UI: every scan appends human-readable steps here
// so "Scan now" can show exactly what the brain is doing in real time.
// Ring buffer — keeps the last MAX_PROGRESS entries of the current/last run.
const MAX_PROGRESS = 300;
const progressLog = {
  runId: 0,
  startedAt: null,
  finishedAt: null,
  steps: [],
};

function progress(msg, level = "info") {
  progressLog.steps.push({ at: new Date(), level, msg });
  if (progressLog.steps.length > MAX_PROGRESS) {
    progressLog.steps.splice(0, progressLog.steps.length - MAX_PROGRESS);
  }
}

function progressBegin() {
  progressLog.runId += 1;
  progressLog.startedAt = new Date();
  progressLog.finishedAt = null;
  progressLog.steps = [];
}

function progressEnd() {
  progressLog.finishedAt = new Date();
}

/* ------------------------------ helpers ------------------------------- */

function cfg() {
  return settings.getAutoFarm();
}

// Resolve the host auto-bots run on. Explicit hostId wins; otherwise the
// first SSH-transport host (the Raspberry Pi in this deployment). Never
// auto-picks the local server: auto-bots must not compete with the main
// host's workload unless the owner explicitly configures it.
function resolveFarmHost(af) {
  if (af.hostId) return hosts.resolveHost(af.hostId);
  const remote = hosts.listHosts().find((h) => h.transport === "ssh");
  return remote ? hosts.resolveHost(remote.id) : null;
}

// Ready = claimable right now with a working token. integrity_failed /
// token_invalid accounts can't farm, so they don't count as supply.
function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  };
}

async function countReadyPool() {
  return AvailableAccount.countDocuments(readyPoolQuery());
}

// Case-insensitive MarketResearch lookup (campaign names and research rows
// both come from Twitch's game names, but hedge against case drift).
async function researchForGame(game) {
  const doc = await MarketResearch.findOne({
    game: new RegExp(
      "^" + game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      "i",
    ),
  }).lean();
  return doc || null;
}

// Research that is missing or stale gets refreshed live against Gameflip,
// GGSel and Plati before we decide — a decision that spends up to 30
// accounts deserves market data younger than a week. Best-effort: if the
// scouts fail we fall back to whatever stored research exists.
async function freshResearchForGame(game) {
  let doc = await researchForGame(game);
  const stale =
    !doc ||
    !doc.scannedAt ||
    Date.now() - new Date(doc.scannedAt).getTime() > RESEARCH_STALE_MS;
  if (stale) {
    try {
      doc = (await marketResearch.refreshGame(game)) || doc;
    } catch {
      /* scouts unreachable — use stored doc (possibly null) */
    }
  }
  return doc;
}

// Own sales history — the training data. Counts SaleSignal rows (connection
// flips seen by the 24h drop scanner + reserved-drop sales from orders) in
// the window, per game.
async function internalSalesForGame(game) {
  const cutoff = new Date(Date.now() - SALES_WINDOW_MS);
  try {
    return await SaleSignal.countDocuments({
      gameKey: String(game).toLowerCase(),
      at: { $gte: cutoff },
    });
  } catch {
    return 0;
  }
}

// ---- Existing coverage: who is ALREADY farming/holding a game? ----

// Read every non-auto bot config across all hosts once per tick and count
// enabled accounts farming each game. A config with OnlyFavouriteGames=false
// or no favourites at all farms every available campaign, so those accounts
// count toward every game (the wildcard set). Auto-bot files are excluded
// via the AutoFarmTask registry so we never count ourselves.
async function manualFarmMap(autoKeys) {
  const map = new Map(); // gameLower -> Set(login)
  const wildcard = new Set(); // logins farming everything
  for (const h of hosts.listHosts()) {
    let host;
    let files;
    try {
      host = hosts.resolveHost(h.id);
      files = await hosts.readdir(host);
    } catch {
      continue; // host offline — its bots aren't farming right now anyway
    }
    for (const f of files) {
      if (!/^config(_\d{1,3})?\.json$/.test(f)) continue;
      if (autoKeys.has(h.id + "|" + f)) continue; // our own auto-bots
      let cfg;
      try {
        cfg = JSON.parse(await hosts.readFile(host, f));
      } catch {
        continue;
      }
      const ts = cfg.TwitchSettings || {};
      const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : [];
      const cfgFavs = Array.isArray(ts.FavouriteGames) ? ts.FavouriteGames : [];
      const only = ts.OnlyFavouriteGames !== false;
      for (const u of users) {
        if (!u || u.Enabled === false) continue;
        const login = String(u.Login || "").toLowerCase();
        if (!login) continue;
        const own = Array.isArray(u.FavouriteGames) ? u.FavouriteGames : [];
        const favs = own.length ? own : cfgFavs;
        if (!favs.length || !only) {
          wildcard.add(login); // farms whatever campaign is live
          continue;
        }
        for (const g of favs) {
          const k = String(g || "").toLowerCase();
          if (!k) continue;
          if (!map.has(k)) map.set(k, new Set());
          map.get(k).add(login);
        }
      }
    }
  }
  return { map, wildcard };
}

// Accounts that already HOLD this campaign's drops (unsold, unredeemed) —
// straight from the drop archive. Farming the same campaign onto more
// accounts only makes sense when these holders can't cover expected demand.
async function archiveHoldersForCampaign(c) {
  try {
    const q = {
      game: c.game,
      connected: { $ne: true },
      soldAt: null,
    };
    if (c.name) q.campaign = c.name;
    const logins = await DropLog.distinct("login", q);
    return logins.filter(Boolean).length;
  } catch {
    return 0;
  }
}

function hoursLeft(endAt) {
  if (!endAt) return Infinity;
  return (new Date(endAt).getTime() - Date.now()) / 3600000;
}

// How many accounts a game deserves. External market demand (Gameflip/GGSel/
// Plati via MarketResearch) is blended with OUR OWN sales history: every
// recent sale of this game's items (connection flips + reserved drops) adds
// log-damped demand points. A game our own data proves sells never gets
// skipped just because external scouts are quiet.
// Returns { target, tierNote, skip, effective } — skip=true means proven low demand.
// Minimum accounts a campaign needs so EVERY enabled marketplace (gameflip +
// plati + ggsel) can hold perMarketStock sellable accounts, doubled to keep
// the 50% post-event holdback intact. With 3 markets x 3 x 2 = 18 the pool
// (180+ ready) stops starving plati/ggsel ("no spare account for this
// market yet") while maxPerGame still caps runaway allocation.
function marketStockFloor(af) {
  // Same enablement signals the auto-lister uses to decide which markets get
  // a share: plati needs platiCategoryId, ggsel rides along when its key is
  // configured (category can come from the drop or ggselCategoryId).
  let markets = 1; // gameflip is the primary and always listed
  if (af.platiCategoryId) markets++;
  try {
    const ks = mp.keyStatus();
    if (ks && ks.ggsel && ks.ggsel.configured) markets++;
  } catch {
    /* marketplaces module unavailable — floor covers fewer markets */
  }
  const per = Math.max(1, Number(af.perMarketStock) || 3);
  return Math.min(markets * per * 2, af.maxPerGame);
}

function demandAllocation(research, af, internalSales = 0) {
  const salesBoost =
    internalSales > 0 ? INTERNAL_SALE_WEIGHT * Math.log1p(internalSales) : 0;
  if (!research || research.scannedAt == null) {
    if (salesBoost >= DEMAND_HALF) {
      // No market data but our own sales history says it sells.
      const full = salesBoost >= DEMAND_FULL;
      return {
        target: full
          ? af.maxPerGame
          : Math.max(1, Math.ceil(af.maxPerGame / 2)),
        tierNote:
          "no external market data, but " +
          internalSales +
          " of our own recent sales — " +
          (full ? "full" : "half") +
          " allocation",
        effective: Math.round(salesBoost),
      };
    }
    return {
      target: Math.min(af.probeSize, af.maxPerGame),
      tierNote: "no market data — probe batch",
      probe: true,
      effective: Math.round(salesBoost),
    };
  }
  const market = Number(research.demandScore || 0);
  const d = Math.round((market + salesBoost) * 10) / 10;
  const salesNote =
    internalSales > 0 ? " incl. " + internalSales + " own sales" : "";
  if (d >= DEMAND_FULL) {
    return {
      target: af.maxPerGame,
      tierNote:
        "demand " + d + salesNote + " (proven seller) — full allocation",
      effective: d,
    };
  }
  if (d >= DEMAND_HALF) {
    return {
      target: Math.max(1, Math.ceil(af.maxPerGame / 2)),
      tierNote: "demand " + d + salesNote + " (moderate) — half allocation",
      effective: d,
    };
  }
  return { skip: true, demand: d, effective: d };
}

// Split a limited budget across several campaigns proportionally to their
// demand weight, never giving any campaign more than it asked for. Leftover
// from capped campaigns is re-distributed greedily by weight.
function fairShare(requests, budget) {
  const out = new Map(requests.map((r) => [r.key, 0]));
  let remaining = Math.max(0, budget);
  let pending = requests.filter((r) => r.want > 0);
  while (remaining > 0 && pending.length) {
    const totalW = pending.reduce((s, r) => s + Math.max(1, r.weight), 0);
    let gaveAny = false;
    for (const r of pending) {
      const share = Math.max(
        1,
        Math.floor((remaining * Math.max(1, r.weight)) / totalW),
      );
      const need = r.want - out.get(r.key);
      const give = Math.min(share, need, remaining);
      if (give > 0) {
        out.set(r.key, out.get(r.key) + give);
        remaining -= give;
        gaveAny = true;
      }
    }
    pending = pending.filter((r) => out.get(r.key) < r.want);
    if (!gaveAny) break;
  }
  return out;
}

// Atomically reserve N ready pool accounts. Returns the claimed docs; on
// partial failure the caller must release them via releasePoolAccounts.
async function claimPoolAccounts(n, note) {
  const claimed = [];
  for (let i = 0; i < n; i++) {
    const doc = await AvailableAccount.findOneAndUpdate(
      readyPoolQuery(),
      {
        $set: {
          status: "claimed",
          claimedAt: new Date(),
          claimedNote: note,
        },
      },
      { new: true, sort: { lastCheckAt: -1 } }, // freshest-verified first
    );
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

async function releasePoolAccounts(docs) {
  if (!docs.length) return;
  await AvailableAccount.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { status: "available", claimedAt: null, claimedNote: "" } },
  ).catch(() => {});
}

// Containers currently in use by live auto-farm tasks (the capacity gate).
async function activeAutoBotCount() {
  const rows = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const seen = new Set();
  for (const t of rows) {
    for (const b of t.bots || []) seen.add(b.host + "|" + b.container);
  }
  return seen.size;
}

// Free seats inside containers that active auto-farm tasks already run on
// this host. A "seat" is one enabled TwitchUsers slot out of accountsPerBot.
// Unreadable configs count as zero free seats (never over-promise capacity).
async function autoSeatCapacity(host, af) {
  if (!host || af.consolidate === false) return 0;
  const rows = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const seen = new Set();
  let free = 0;
  for (const t of rows) {
    for (const b of t.bots || []) {
      if (b.host !== host.id) continue;
      const key = b.host + "|" + b.container;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const data = JSON.parse(await hosts.readFile(host, b.file));
        free += Math.max(0, af.accountsPerBot - botFactory.usedSeats(data));
      } catch {
        /* config renamed/unreadable — no seats there */
      }
    }
  }
  return free;
}

// Consolidation-first allocation: before paying RAM for a new container,
// pack claimed accounts into free seats of bots that active tasks already
// run on this host. Per-account FavouriteGames means one container can farm
// many games at once. Returns { placed, remaining }; placed entries carry
// the task.bots row plus the accounts that landed there. Every filled
// container is restarted once so TwitchDropsBot reloads its config.
async function fillExistingBots(host, claimed, game, af) {
  const placed = [];
  let remaining = claimed.slice();
  if (!remaining.length || af.consolidate === false) {
    return { placed, remaining };
  }
  const rows = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const seen = new Set();
  const containers = [];
  for (const t of rows) {
    for (const b of t.bots || []) {
      if (b.host !== host.id) continue;
      const key = b.host + "|" + b.container;
      if (seen.has(key)) continue;
      seen.add(key);
      containers.push(b);
    }
  }
  for (const b of containers) {
    if (!remaining.length) break;
    let freeSeats = 0;
    try {
      const data = JSON.parse(await hosts.readFile(host, b.file));
      freeSeats = Math.max(0, af.accountsPerBot - botFactory.usedSeats(data));
    } catch {
      continue; // retired/renamed config — skip
    }
    if (freeSeats < 1) continue;
    const batch = remaining.slice(0, freeSeats);
    try {
      const r = await botFactory.addAccountsToBot(host, b.file, batch, game);
      if (!r.added) continue;
      const landed = new Set(r.logins);
      const taken = batch.filter((a) => landed.has(a.username));
      if (!taken.length) continue;
      remaining = remaining.filter((a) => !taken.includes(a));
      await hosts.dockerContainer(host, "restart", b.container).catch(() => {});
      placed.push({
        bot: {
          host: host.id,
          file: b.file,
          container: b.container,
          reused: true,
          shared: true,
        },
        accounts: taken,
      });
    } catch {
      /* config/container raced away — the remainder gets a new bot */
    }
  }
  return { placed, remaining };
}

// The most recent task for this game that owns bots we can restart —
// weekly campaigns reuse infrastructure instead of burning new accounts.
async function reusableTaskForGame(game) {
  return AutoFarmTask.findOne({
    game,
    "bots.0": { $exists: true },
    status: { $in: ["active", "completed", "stopped"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

function tg(text) {
  return sendTelegram(text).catch(() => {});
}

/* --------------------------- decision + exec --------------------------- */

// Decide (and in live mode execute) one campaign. `budgetMap` caps how many
// accounts this campaign may claim this tick (fair-share result).
async function processCampaign(c, ctx) {
  const { af, host, hostOnline, budgetMap } = ctx;
  const game = c.game || c.name || "?";
  const key = c.campaignId;

  const base = {
    game,
    campaignId: c.campaignId,
    campaignName: c.name || "",
    campaignEndAt: c.endAt || null,
    dryRun: !!af.dryRun,
  };

  // Decision this campaign was last left in (null on the first pass). Only set
  // for RETRYABLE skips, which are the ones re-decided on every tick.
  const prior = (ctx.priorTasks && ctx.priorTasks.get(key)) || null;

  // True when `decision` is not simply a repeat of the verdict this campaign
  // already carried. Notifications for retryable skips are gated on this so a
  // steady state is announced once, not once per tick. The task row is still
  // rewritten every tick either way — only the Telegram send is suppressed.
  function isNewDecision(decision) {
    return !prior || prior.decision !== decision;
  }

  async function record(fields) {
    // upsert keeps the unique (game, campaignId) index happy on retries
    return AutoFarmTask.findOneAndUpdate(
      { game, campaignId: c.campaignId },
      { $set: { ...base, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // 1) Sellability gate — fresh market data (Gameflip/GGSel/Plati, re-scanned
  // when stale) blended with our own sales history (SaleSignal training data).
  const info = (ctx.infoMap && ctx.infoMap.get(key)) || {
    research: await freshResearchForGame(game),
    internalSales: await internalSalesForGame(game),
  };
  const research = info.research;
  const internalSales = info.internalSales || 0;
  const alloc = demandAllocation(research, af, internalSales);
  if (alloc.skip) {
    await record({
      decision: "skip_low_demand",
      status: "skipped",
      reason:
        "Effective demand " +
        alloc.demand +
        " (market research + " +
        internalSales +
        " own recent sales) — items for this game don't sell; not worth pool accounts.",
      demandScore: alloc.demand,
      hadResearch: true,
      internalSales,
    });
    await tg(
      "🤖 Auto-farm SKIP — " +
        game +
        "\nEffective demand " +
        alloc.demand +
        " (items not salable). No accounts spent.",
    );
    return { decision: "skip_low_demand" };
  }
  const demandScore = research ? Number(research.demandScore || 0) : null;

  // 2) Time gate.
  const hrs = hoursLeft(c.endAt);
  if (hrs < af.minHoursLeft) {
    await record({
      decision: "skip_ends_soon",
      status: "skipped",
      reason:
        "Campaign ends in " +
        Math.max(0, Math.round(hrs)) +
        "h (< " +
        af.minHoursLeft +
        "h) — too late to farm meaningfully.",
      demandScore,
      hadResearch: !!research,
      internalSales,
    });
    return { decision: "skip_ends_soon" };
  }

  // 3) Host gate.
  if (!hostOnline) {
    await record({
      decision: "skip_host_offline",
      status: "skipped",
      reason:
        "Farm host " +
        (host ? host.label : "?") +
        " unreachable — will retry next tick.",
      demandScore,
      hadResearch: !!research,
    });
    return { decision: "skip_host_offline" };
  }

  // 4) Reuse-first: weekly campaigns restart the game's existing auto-bot.
  let reusable = await reusableTaskForGame(game);
  if (reusable) {
    // Retired bots (deleted container, config renamed .done-*) can't be
    // restarted — drop them; if none survive, fall through to a fresh plan
    // (which prefers packing into running bots anyway).
    const live = [];
    for (const b of reusable.bots || []) {
      const h = hosts.resolveHost(b.host);
      if (!h) continue;
      try {
        if (await hosts.exists(h, b.file)) live.push(b);
      } catch {
        /* host unreachable — treat as not reusable */
      }
    }
    reusable = live.length ? { ...reusable, bots: live } : null;
  }
  if (reusable) {
    const bots = reusable.bots || [];
    const reason =
      "Recurring campaign for a game we already farm — reusing existing bot" +
      (bots.length > 1 ? "s" : "") +
      " (" +
      bots.map((b) => b.container).join(", ") +
      ") with their " +
      (reusable.assignedAccounts || []).length +
      " accounts instead of spending new pool accounts.";
    if (af.dryRun) {
      await record({
        decision: "reuse_existing",
        status: "planned",
        reason,
        demandScore,
        hadResearch: !!research,
        bots: bots.map((b) => ({ ...b, reused: true })),
        plannedAccounts: 0,
      });
      await tg("🤖 Auto-farm PLAN (dry-run) — " + game + "\n" + reason);
      return { decision: "reuse_existing", dryRun: true };
    }
    const started = [];
    const failed = [];
    for (const b of bots) {
      try {
        await botFactory.startContainer(hosts.resolveHost(b.host), b.container);
        started.push(b.container);
      } catch (e) {
        failed.push(b.container + ": " + e.message);
      }
    }
    await record({
      decision: "reuse_existing",
      status: started.length ? "active" : "failed",
      reason,
      demandScore,
      hadResearch: !!research,
      bots: bots.map((b) => ({ ...b, reused: true })),
      assignedAccounts: reusable.assignedAccounts || [],
      plannedAccounts: (reusable.assignedAccounts || []).length,
      error: failed.join("; "),
      executedAt: new Date(),
    });
    await tg(
      "🤖 Auto-farm REUSE — " +
        game +
        "\nRestarted " +
        started.join(", ") +
        (failed.length ? "\nFailed: " + failed.join("; ") : "") +
        "\nCampaign: " +
        (c.name || c.campaignId),
    );
    return { decision: "reuse_existing" };
  }

  // 5) Coverage gate: how much of this game's demand is ALREADY covered by
  // manual bots farming it right now and by unsold archive accounts holding
  // this campaign's items? Only the uncovered remainder is worth new accounts.
  const farmMap = ctx.farmMap || { map: new Map(), wildcard: new Set() };
  const gameKey = game.toLowerCase();
  const manualFarmers =
    (farmMap.map.get(gameKey) ? farmMap.map.get(gameKey).size : 0) +
    farmMap.wildcard.size;
  const archiveHolders = await archiveHoldersForCampaign(c);
  const covered = manualFarmers + archiveHolders;
  // Non-probe campaigns must at least fill every enabled market's shelf.
  const floor = alloc.probe ? 0 : marketStockFloor(af);
  const wanted = Math.min(Math.max(alloc.target, floor), af.maxPerGame);
  const uncovered = Math.max(0, wanted - covered);
  if (uncovered < 1) {
    await record({
      decision: "skip_already_covered",
      status: "skipped",
      reason:
        "Demand target of " +
        wanted +
        " accounts is already covered: " +
        manualFarmers +
        " account" +
        (manualFarmers === 1 ? "" : "s") +
        " farming this game in manual bots + " +
        archiveHolders +
        " unsold archive account" +
        (archiveHolders === 1 ? "" : "s") +
        " already holding this campaign's items. No new accounts needed.",
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders },
    });
    // Announce the transition into "covered", not every re-confirmation of it.
    // This branch is retryable (demand reopens when covering accounts sell), so
    // it is re-decided every tick; sending unconditionally was ~485 identical
    // Telegram messages a day. The reason is recorded above regardless and is
    // visible in the Bots → Auto farm tab.
    if (isNewDecision("skip_already_covered")) {
      await tg(
        "🤖 Auto-farm SKIP — " +
          game +
          "\nAlready covered: " +
          manualFarmers +
          " manual farmers + " +
          archiveHolders +
          " archive holders ≥ target " +
          wanted +
          ".",
      );
    }
    return { decision: "skip_already_covered" };
  }

  // 6) Allocation: fair-share budget for this tick, capped by the UNCOVERED
  // remainder of the tier target.
  const budget = budgetMap.get(key) || 0;
  const target = Math.min(uncovered, budget);
  if (target < 1) {
    await record({
      decision: "skip_no_accounts",
      status: "skipped",
      reason:
        "Pool has no spendable accounts (reserve floor " +
        af.poolReserve +
        " protects manual work) — will retry when the pool refills.",
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders },
      plannedAccounts: 0,
    });
    return { decision: "skip_no_accounts" };
  }

  // 6) Capacity gate: free SEATS, not just container slots — running bots
  // with spare TwitchUsers slots can absorb accounts without new containers.
  const activeBots = await activeAutoBotCount();
  const slotsFree = Math.max(0, af.maxAutoBots - activeBots);
  const freeSeats = await autoSeatCapacity(host, af).catch(() => 0);
  const seatCapacity = slotsFree * af.accountsPerBot + freeSeats;
  if (seatCapacity < 1) {
    await record({
      decision: "skip_no_capacity",
      status: "skipped",
      reason:
        "All " +
        af.maxAutoBots +
        " auto-bot slots on " +
        host.label +
        " are busy and no running bot has a free seat — queued; retries " +
        "when a campaign ends and frees capacity.",
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders },
      plannedAccounts: target,
    });
    return { decision: "skip_no_capacity" };
  }
  // Trim the plan to fit free seats (existing bots first, then new ones).
  const accounts = Math.min(target, seatCapacity);
  const botCount = Math.ceil(accounts / af.accountsPerBot);
  const decision = alloc.probe ? "probe" : "farm";
  const covNote =
    covered > 0
      ? " (" +
        covered +
        " account" +
        (covered === 1 ? "" : "s") +
        " already covering: " +
        manualFarmers +
        " manual + " +
        archiveHolders +
        " archive)"
      : "";
  const reason =
    (alloc.probe
      ? "New game with no sales history — farming a small probe batch to test the market. "
      : alloc.tierNote + ". ") +
    "Plan: " +
    accounts +
    " account" +
    (accounts === 1 ? "" : "s") +
    " across " +
    botCount +
    " bot" +
    (botCount === 1 ? "" : "s") +
    " on " +
    host.label +
    " (campaign ends in " +
    Math.round(hrs) +
    "h)" +
    covNote +
    ".";

  // 7) Dry-run: record the plan, alert, touch nothing.
  if (af.dryRun) {
    await record({
      decision,
      status: "planned",
      reason,
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders },
      plannedAccounts: accounts,
    });
    await tg(
      "🤖 Auto-farm PLAN (dry-run) — " +
        game +
        "\n" +
        reason +
        "\nApprove it from the Bots → Auto farm tab to execute.",
    );
    return { decision, dryRun: true };
  }

  // 8) Live: claim accounts, create bots, activate.
  const task = await record({
    decision,
    status: "planned",
    reason,
    demandScore,
    hadResearch: !!research,
    internalSales,
    coverage: { manualFarmers, archiveHolders },
    plannedAccounts: accounts,
    targetAccounts: wanted,
  });
  return executeTask(task, ctx);
}

// Execute a planned task for real: claim pool accounts, create bot(s) on the
// farm host, mark active. Used by live-mode ticks AND the one-click
// "approve" button on dry-run plans.
async function executeTask(task, ctx) {
  const af = ctx && ctx.af ? ctx.af : cfg();
  const host = ctx && ctx.host ? ctx.host : resolveFarmHost(af);
  if (!host) throw new Error("No farm host configured");
  const game = task.game;

  const want = Math.min(task.plannedAccounts || 0, af.maxPerGame);
  if (want < 1) throw new Error("Task has no planned accounts");

  // Re-check the reserve floor at execution time (things may have changed
  // since the plan was made).
  const ready = await countReadyPool();
  const spendable = Math.max(0, ready - af.poolReserve);
  const n = Math.min(want, spendable);
  if (n < 1) {
    await AutoFarmTask.updateOne(
      { _id: task._id },
      {
        $set: {
          status: "failed",
          error: "Pool below reserve floor at execution time",
        },
      },
    );
    throw new Error(
      "Pool below reserve floor (" +
        ready +
        " ready, reserve " +
        af.poolReserve +
        ")",
    );
  }

  const claimed = await claimPoolAccounts(
    n,
    "auto-farm: " + game + " (" + task.campaignId + ")",
  );
  if (!claimed.length) {
    await AutoFarmTask.updateOne(
      { _id: task._id },
      {
        $set: { status: "failed", error: "Could not claim any pool accounts" },
      },
    );
    throw new Error("Could not claim any pool accounts");
  }

  const bots = [];
  const deployed = [];
  let error = "";
  try {
    // Pack into free seats of running auto-bots first — one container can
    // farm many games via per-account FavouriteGames, and every container
    // we don't create is RAM the Pi keeps.
    const packed = await fillExistingBots(host, claimed, game, af);
    for (const pl of packed.placed) {
      bots.push(pl.bot);
      for (const a of pl.accounts) deployed.push(a);
    }
    const rest = packed.remaining;
    for (let i = 0; i < rest.length; i += af.accountsPerBot) {
      const batch = rest.slice(i, i + af.accountsPerBot);
      const bot = await botFactory.createBot(host, batch, game, {
        startRunning: true,
      });
      bots.push({
        host: bot.host,
        file: bot.file,
        container: bot.container,
        reused: false,
      });
      for (const b of batch) deployed.push(b);
      if (bot.startError) error += bot.container + ": " + bot.startError + "; ";
    }
  } catch (e) {
    error += e.message;
    // Release the accounts that were claimed but never made it into a config.
    const leftover = claimed.filter((c) => !deployed.includes(c));
    await releasePoolAccounts(leftover);
  }

  const ok = bots.length > 0;
  await AutoFarmTask.updateOne(
    { _id: task._id },
    {
      $set: {
        status: ok ? "active" : "failed",
        dryRun: false,
        bots,
        assignedAccounts: deployed.map((d) => d.username),
        error: error.trim(),
        executedAt: new Date(),
      },
    },
  );
  await tg(
    (ok ? "🤖 Auto-farm LIVE — " : "🤖 Auto-farm FAILED — ") +
      game +
      "\n" +
      (ok
        ? deployed.length +
          " accounts across " +
          bots.length +
          " bot(s) on " +
          host.label +
          ": " +
          bots.map((b) => b.container).join(", ") +
          (bots.some((b) => b.shared)
            ? " (" +
              bots.filter((b) => b.shared).length +
              " packed into existing bots)"
            : "")
        : "Could not create bots") +
      (error ? "\nIssues: " + error : ""),
  );
  if (!ok) throw new Error(error || "Bot creation failed");
  return { bots, accounts: deployed.length };
}

// Retire the bots of tasks whose campaign has ended.
// - SHARED containers (other active tasks also farm there) survive: only
//   this task's accounts get the game removed from their per-account
//   FavouriteGames (disabled when nothing remains), then one restart.
// - DEDICATED containers are stopped and — with deleteFinishedBots on —
//   deleted: container removed, compose service dropped, config RENAMED to
//   .done-<ts> (tokens survive; BotAccount rows keep the drop inventory the
//   scanner sells from).
// - This task's accounts are recycled back to the ready pool (unless the
//   account itself was sold) so the next event reuses them in fresh bots.
// Retro-reaper: tasks that completed BEFORE bot retirement shipped left
// their containers behind (stopped or even still running). Apply the same
// delete process to them: shared-with-active containers are spared, the
// rest get container removed + compose service dropped + config renamed.
// Idempotent by construction — a reaped bot's config no longer exists under
// its old name, so it's skipped on every later pass. Manual bots are never
// touched (only bots recorded on auto-farm tasks are considered).
async function reapRetiredBots(af, host, progress) {
  if (af.deleteFinishedBots === false || !host) return 0;
  const done = await AutoFarmTask.find(
    { status: "completed", "bots.0": { $exists: true } },
    { bots: 1, game: 1, assignedAccounts: 1 },
  ).lean();
  if (!done.length) return 0;
  const active = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const activeKeys = new Set();
  for (const t of active) {
    for (const b of t.bots || []) activeKeys.add(b.host + "|" + b.container);
  }
  let reaped = 0;
  const seen = new Set();
  for (const t of done) {
    for (const b of t.bots || []) {
      const key = b.host + "|" + b.container;
      if (seen.has(key)) continue;
      seen.add(key);
      if (activeKeys.has(key)) continue; // an active campaign shares it
      const h = hosts.resolveHost(b.host);
      if (!h || h.id !== host.id) continue;
      try {
        if (!(await hosts.exists(h, b.file))) continue; // already reaped
      } catch {
        continue;
      }
      try {
        await botFactory.stopContainer(h, b.container).catch(() => {});
        await botFactory.deleteBot(h, b.file, b.container);
        reaped++;
        progress("Reaped leftover bot " + b.container + " (" + t.game + ")");
      } catch {
        /* best-effort — retried next tick while the config exists */
      }
    }
  }
  // Retro-recycle: accounts of pre-retirement completed tasks were left
  // "claimed" in the pool forever. Return them (minus sold ones) so the
  // next event can reuse them — same rules as the live retirement path.
  let recycled = 0;
  try {
    const BotAccount = require("../models/BotAccount");
    const logins = [];
    for (const t of done) {
      for (const u of t.assignedAccounts || []) logins.push(String(u));
    }
    if (logins.length) {
      const soldRows = await BotAccount.find(
        { login: { $in: logins }, soldAt: { $ne: null } },
        { login: 1 },
      ).lean();
      const sold = new Set(soldRows.map((r) => String(r.login).toLowerCase()));
      const back = logins.filter((u) => !sold.has(u.toLowerCase()));
      if (back.length) {
        const r = await AvailableAccount.updateMany(
          {
            usernameLower: { $in: back.map((u) => u.toLowerCase()) },
            status: "claimed",
          },
          {
            $set: {
              status: "available",
              claimedAt: null,
              claimedNote: "recycled by retro-reaper",
            },
          },
        );
        recycled = (r && r.modifiedCount) || 0;
      }
    }
  } catch {
    /* best-effort */
  }
  if (recycled)
    progress("Retro-recycled " + recycled + " account(s) to the pool.");
  if (reaped) {
    await tg(
      "\ud83e\uddf9 Auto-farm cleanup \u2014 reaped " +
        reaped +
        " leftover bot container(s) from campaigns that ended before " +
        "bot retirement shipped.",
    );
  }
  return reaped;
}

async function completeEndedTasks() {
  const active = await AutoFarmTask.find({ status: "active" });
  let completed = 0;
  for (const t of active) {
    const c = await TwitchCampaign.findOne({ campaignId: t.campaignId }).lean();
    const ended =
      !c ||
      c.status === "EXPIRED" ||
      (c.endAt && new Date(c.endAt) < new Date());
    if (!ended) continue;
    const af = cfg();
    // Containers other ACTIVE tasks still use must survive this task ending.
    const others = await AutoFarmTask.find(
      { status: "active", _id: { $ne: t._id } },
      { bots: 1 },
    ).lean();
    const sharedKeys = new Set();
    for (const o of others) {
      for (const b of o.bots || []) sharedKeys.add(b.host + "|" + b.container);
    }
    const mine = new Set(
      (t.assignedAccounts || []).map((u) => String(u).toLowerCase()),
    );
    const stopped = [];
    const removed = [];
    const trimmed = [];
    for (const b of t.bots || []) {
      const h = hosts.resolveHost(b.host);
      if (!h) continue;
      if (sharedKeys.has(b.host + "|" + b.container)) {
        // Shared: switch only THIS task's accounts off the ended game (same
        // per-account FavouriteGames edit farmControl.stopFarmingGame uses),
        // one write + one restart; co-tenants keep farming untouched.
        try {
          const raw = await hosts.readFile(h, b.file);
          const data = JSON.parse(raw);
          const users =
            data &&
            data.TwitchSettings &&
            Array.isArray(data.TwitchSettings.TwitchUsers)
              ? data.TwitchSettings.TwitchUsers
              : [];
          let changed = 0;
          for (const u of users) {
            if (!u || !mine.has(String(u.Login || "").toLowerCase())) continue;
            const own = Array.isArray(u.FavouriteGames) ? u.FavouriteGames : [];
            const next = own.filter(
              (f) =>
                String(f).trim().toLowerCase() !==
                String(t.game).trim().toLowerCase(),
            );
            if (next.length === own.length) continue;
            u.FavouriteGames = next;
            // An empty per-account list inherits the config-level games,
            // which could resurrect the removed one — disable instead.
            if (!next.length) u.Enabled = false;
            changed++;
          }
          if (changed) {
            await hosts.writeFileAtomic(
              h,
              b.file,
              JSON.stringify(data, null, 2),
            );
            await hosts
              .dockerContainer(h, "restart", b.container)
              .catch(() => {});
            trimmed.push(b.container + " (" + changed + " acct)");
          }
        } catch {
          /* config unreadable — leave the shared bot alone */
        }
        continue;
      }
      // Dedicated: stop it (frees the RAM), then optionally delete it
      // (frees the slot + compose clutter; config renamed, never deleted).
      try {
        await botFactory.stopContainer(h, b.container);
        stopped.push(b.container);
      } catch {
        /* container may already be gone; completing anyway */
      }
      if (af.deleteFinishedBots !== false) {
        try {
          await botFactory.deleteBot(h, b.file, b.container);
          removed.push(b.container);
        } catch {
          /* best-effort */
        }
      }
    }
    // Recycle the accounts for the next event: back to the ready pool unless
    // the account itself was sold to a buyer. The farmed drops live on the
    // Twitch account either way, and a later sale still triggers
    // farmControl.stopFarmingGame on whatever it farms next.
    let recycled = 0;
    if (t.assignedAccounts && t.assignedAccounts.length) {
      try {
        const BotAccount = require("../models/BotAccount");
        const soldRows = await BotAccount.find(
          { login: { $in: t.assignedAccounts }, soldAt: { $ne: null } },
          { login: 1 },
        ).lean();
        const sold = new Set(
          soldRows.map((r) => String(r.login).toLowerCase()),
        );
        const back = t.assignedAccounts.filter(
          (u) => !sold.has(String(u).toLowerCase()),
        );
        if (back.length) {
          const r = await AvailableAccount.updateMany(
            {
              usernameLower: { $in: back.map((u) => String(u).toLowerCase()) },
              status: "claimed",
            },
            {
              $set: {
                status: "available",
                claimedAt: null,
                claimedNote: "recycled after " + t.game,
              },
            },
          );
          recycled = (r && r.modifiedCount) || 0;
        }
      } catch {
        /* best-effort — accounts stay claimed, owner can release manually */
      }
    }
    t.status = "completed";
    t.completedAt = new Date();
    await t.save().catch(() => {});
    completed++;
    // Event over = supply fixed: apply the post-event scarcity markup and
    // rebuild the listing as a stacked bundle of every campaign this game's
    // accounts have farmed. Failures are non-fatal; retried on manual rescan.
    try {
      const autoLister = require("./autoLister");
      const r = await autoLister.onCampaignEnded(t._id);
      if (r && r.repriced) {
        await tg(
          "\ud83d\udcc8 Post-event reprice \u2014 " +
            t.game +
            "\n$" +
            r.repriced.price +
            " \u00b7 " +
            r.repriced.items +
            " item(s) stacked" +
            (r.repriced.live ? "" : " (listing not live)"),
        );
      }
    } catch (e) {
      console.error("post-event reprice failed:", e.message);
    }
    await tg(
      "🤖 Auto-farm DONE — " +
        t.game +
        "\nCampaign ended." +
        (stopped.length ? " Stopped: " + stopped.join(", ") + "." : "") +
        (removed.length ? " Deleted: " + removed.join(", ") + "." : "") +
        (trimmed.length
          ? " Trimmed from shared: " + trimmed.join(", ") + "."
          : "") +
        " " +
        (t.assignedAccounts || []).length +
        " farmed account(s) keep their drops" +
        (recycled ? "; " + recycled + " recycled to the pool" : "") +
        ".",
    );
  }
  return completed;
}

/* -------------------------------- tick --------------------------------- */

async function runOnce() {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  progressBegin();
  try {
    const af = cfg();
    if (!af.enabled) {
      progress("Auto farmer is disabled in settings — nothing to do.", "warn");
      state.lastSummary = { enabled: false };
      return state.lastSummary;
    }
    progress(
      "Scan started (" +
        (af.dryRun ? "dry-run" : "LIVE") +
        " mode, cap " +
        af.maxPerGame +
        "/game, reserve " +
        af.poolReserve +
        ").",
    );

    // Always tidy up ended campaigns first — this frees container slots that
    // this same tick can then hand to queued campaigns.
    progress("Checking for ended campaigns to clean up\u2026");
    const completed = await completeEndedTasks();
    if (completed)
      progress("Cleaned up " + completed + " ended campaign task(s).");

    const host = resolveFarmHost(af);
    let hostOnline = false;
    if (host) {
      try {
        await hosts.readdir(host);
        hostOnline = true;
      } catch {
        hostOnline = false;
      }
    }
    progress(
      host
        ? "Farm host: " +
            (host.label || host.id) +
            " — " +
            (hostOnline ? "online" : "OFFLINE")
        : "No farm host configured.",
      hostOnline ? "info" : "warn",
    );

    // Candidates: live campaigns not yet decided, plus retryable skips.
    const now = new Date();
    const live = await TwitchCampaign.find({
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    }).lean();

    progress(
      "Found " +
        live.length +
        " live campaign(s); checking which need decisions\u2026",
    );
    const candidates = [];
    // The decision each retried candidate was last left in. RETRYABLE skips are
    // re-decided every tick by design, so a branch that notifies would otherwise
    // re-announce an unchanged verdict on every tick, forever. Passing the prior
    // task down lets processCampaign tell a NEW decision from a repeat of one.
    const priorTasks = new Map();
    for (const c of live) {
      if (!c.game) continue;
      const existing = await AutoFarmTask.findOne({
        game: c.game,
        campaignId: c.campaignId,
      }).lean();
      if (!existing) {
        candidates.push(c);
      } else if (
        existing.status === "skipped" &&
        RETRYABLE.has(existing.decision)
      ) {
        candidates.push(c); // conditions may have changed — re-decide
        priorTasks.set(c.campaignId, existing);
      }
    }
    progress(candidates.length + " campaign(s) to decide this tick.");

    // Prefetch decision inputs once per candidate: live-refreshed market
    // research (Gameflip/GGSel/Plati when stale) + our own sales history.
    const infoMap = new Map();
    for (const c of candidates) {
      progress(
        "Researching " + c.game + " (markets + own sales history)\u2026",
      );
      const research = await freshResearchForGame(c.game);
      const internalSales = await internalSalesForGame(c.game);
      infoMap.set(c.campaignId, { research, internalSales });
      progress(
        c.game +
          ": " +
          (research && research.scannedAt
            ? "market demand " +
              (research.demandScore != null ? research.demandScore : "?")
            : "no market data") +
          ", " +
          internalSales +
          " own sale(s) in 45d.",
      );
    }

    // Snapshot which games manual bots are farming right now (one config
    // sweep across all hosts per tick; auto-bot files excluded via registry).
    const autoTasks = await AutoFarmTask.find(
      { "bots.0": { $exists: true } },
      { bots: 1 },
    ).lean();
    const autoKeys = new Set();
    for (const t of autoTasks) {
      for (const b of t.bots || []) autoKeys.add(b.host + "|" + b.file);
    }
    progress("Sweeping manual bot configs for existing coverage\u2026");
    const farmMap = hostOnline
      ? await manualFarmMap(autoKeys)
      : { map: new Map(), wildcard: new Set() };
    progress(
      "Coverage sweep done: " +
        farmMap.map.size +
        " game(s) farmed by manual bots, " +
        farmMap.wildcard.size +
        " account(s) farming everything.",
    );

    // Fair-share budget across everything competing in this tick. Weights use
    // the blended demand (market + own sales) so proven sellers win supply.
    const ready = await countReadyPool();
    const spendable = Math.max(0, ready - af.poolReserve);
    const requests = [];
    for (const c of candidates) {
      const info = infoMap.get(c.campaignId);
      const alloc = demandAllocation(info.research, af, info.internalSales);
      if (alloc.skip) {
        requests.push({ key: c.campaignId, want: 0, weight: 0 });
      } else {
        requests.push({
          key: c.campaignId,
          want: Math.min(
            Math.max(alloc.target, alloc.probe ? 0 : marketStockFloor(af)),
            af.maxPerGame,
          ),
          weight: Math.max(1, Number(alloc.effective || 0) || 5),
        });
      }
    }
    const budgetMap = fairShare(requests, spendable);

    const results = [];
    for (const c of candidates) {
      try {
        progress(
          "Deciding " + c.game + " (" + (c.name || c.campaignId) + ")\u2026",
        );
        const r = await processCampaign(c, {
          af,
          host,
          hostOnline,
          budgetMap,
          infoMap,
          farmMap,
          priorTasks,
        });
        progress(
          c.game + " \u2192 " + (r && r.decision ? r.decision : "done") + ".",
        );
        results.push({ game: c.game, ...r });
      } catch (e) {
        progress(c.game + " FAILED: " + e.message, "error");
        results.push({ game: c.game, error: e.message });
      }
    }
    // Backfill sweep: top up under-target tasks from whatever the pool has.
    if (!af.dryRun && hostOnline) {
      try {
        const topped = await backfillActiveTasks(af, host, progress);
        if (topped) progress("Backfill added " + topped + " account(s) total.");
      } catch (e) {
        progress("Backfill failed: " + e.message, "warn");
      }
      // Retro-reaper: delete leftover containers from campaigns that ended
      // before bot retirement shipped (idempotent, skips shared bots).
      try {
        const reaped = await reapRetiredBots(af, host, progress);
        if (reaped) progress("Reaped " + reaped + " leftover bot(s).");
      } catch (e) {
        progress("Reaper failed: " + e.message, "warn");
      }
    }

    // Refill sweep: every LISTED active task gets its markets topped up —
    // sold-out (or shorted) gameflip/plati/ggsel stock is refilled from
    // spare accounts, then the post-event holdback, no delist/relist.
    if (!af.dryRun) {
      const autoListerR = require("./autoLister");
      const listed = await AutoFarmTask.find({
        status: "active",
        "listing.externalId": { $nin: ["", null] },
      });
      for (const t of listed) {
        try {
          const acts = await autoListerR.refillMarkets(t, {
            perMarketStock: af.perMarketStock,
          });
          if (acts) {
            progress("Refilled " + t.game + ": " + acts.join(", "));
            await tg(
              "\ud83d\udd04 Auto-refill \u2014 " +
                t.game +
                "\n" +
                acts.join(", "),
            );
          }
        } catch (e) {
          progress("Refill " + t.game + " failed: " + e.message, "warn");
        }
      }
    }

    // Auto-listing sweep: every active task that has no Gameflip listing yet
    // gets one NOW — bots that started this very tick are listed in the same
    // pass (early-bird flow). Failures retry automatically next tick.
    const autoLister = require("./autoLister"); // lazy: avoids require cycles
    const unlisted = await AutoFarmTask.find({
      status: "active",
      $or: [
        { "listing.externalId": "" },
        { "listing.externalId": { $exists: false } },
      ],
    }).lean();
    for (const t of unlisted) {
      if (af.dryRun && t.wouldList && t.wouldList.title) continue; // previewed
      try {
        progress("Auto-listing " + t.game + " on Gameflip\u2026");
        const r = await autoLister.listActivatedTask(t._id, {
          dryRun: af.dryRun,
        });
        if (r.listed) {
          progress(
            t.game +
              " LISTED: " +
              r.listed.title +
              " ($" +
              r.listed.price +
              ", qty " +
              r.listed.qty +
              ") " +
              r.listed.url,
          );
          await tg(
            "\ud83d\udecd Auto-listed \u2014 " +
              t.game +
              "\n" +
              r.listed.title +
              "\n$" +
              r.listed.price +
              " \u00b7 qty " +
              r.listed.qty +
              "\n" +
              r.listed.url,
          );
        } else if (r.wouldList) {
          progress(
            t.game +
              " would list: " +
              r.wouldList.title +
              " ($" +
              r.wouldList.price +
              ") [dry-run]",
          );
        }
      } catch (e) {
        progress("Auto-list " + t.game + " failed: " + e.message, "warn");
      }
    }

    progress("Scan complete: " + results.length + " decision(s) this tick.");

    state.lastError = "";
    state.lastSummary = {
      enabled: true,
      dryRun: af.dryRun,
      host: host ? host.id : null,
      hostOnline,
      poolReady: ready,
      poolSpendable: spendable,
      candidates: candidates.length,
      completed,
      results,
    };
    return state.lastSummary;
  } catch (err) {
    state.lastError = err.message || String(err);
    progress("Scan aborted: " + (err.message || String(err)), "error");
    throw err;
  } finally {
    state.lastRun = new Date();
    state.running = false;
    progressEnd();
  }
}

// Backfill: active tasks whose account count is below their tier target get
// topped up as the pool refills — "the more accounts I add to the pool, the
// more it fetches to fill the gaps". Respects the reserve floor and container
// slots; new accounts go into NEW bots (existing containers keep running
// untouched). The Gameflip listing grows too, keeping the half-now /
// half-post-event split.
async function backfillActiveTasks(af, host, progress) {
  if (af.dryRun || !host) return 0;
  const tasks = await AutoFarmTask.find({ status: "active" }).sort({
    executedAt: 1,
  });
  let added = 0;
  for (const task of tasks) {
    const target = Math.min(
      Math.max(
        Number(task.targetAccounts) || Number(task.plannedAccounts) || 0,
        marketStockFloor(af),
      ),
      af.maxPerGame,
    );
    const have = (task.assignedAccounts || []).length;
    const missing = target - have;
    if (missing < 1) continue;

    const ready = await countReadyPool();
    const spendable = Math.max(0, ready - af.poolReserve);
    if (spendable < 1) break; // pool exhausted — later tasks can't get any either

    const activeBots = await activeAutoBotCount();
    const slotsFree = Math.max(0, af.maxAutoBots - activeBots);
    const freeSeats = await autoSeatCapacity(host, af).catch(() => 0);
    if (slotsFree < 1 && freeSeats < 1) break;

    const n = Math.min(
      missing,
      spendable,
      slotsFree * af.accountsPerBot + freeSeats,
    );
    if (n < 1) continue;
    progress(
      "Backfilling " +
        task.game +
        ": +" +
        n +
        " account(s) toward target " +
        target +
        " (have " +
        have +
        ")\u2026",
    );
    const claimed = await claimPoolAccounts(
      n,
      "auto-farm backfill: " + task.game + " (" + task.campaignId + ")",
    );
    if (!claimed.length) continue;

    const deployed = [];
    let error = "";
    try {
      const packed = await fillExistingBots(host, claimed, task.game, af);
      for (const pl of packed.placed) {
        const key = pl.bot.host + "|" + pl.bot.container;
        const already = (task.bots || []).some(
          (x) => x.host + "|" + x.container === key,
        );
        if (!already) task.bots.push(pl.bot);
        for (const a of pl.accounts) deployed.push(a);
      }
      const rest = packed.remaining;
      for (let i = 0; i < rest.length; i += af.accountsPerBot) {
        const batch = rest.slice(i, i + af.accountsPerBot);
        const bot = await botFactory.createBot(host, batch, task.game, {
          startRunning: true,
        });
        task.bots.push({
          host: bot.host,
          file: bot.file,
          container: bot.container,
          reused: false,
        });
        for (const b of batch) deployed.push(b);
        if (bot.startError)
          error += bot.container + ": " + bot.startError + "; ";
      }
    } catch (e) {
      error += e.message;
      const leftover = claimed.filter((c) => !deployed.includes(c));
      await releasePoolAccounts(leftover);
    }
    if (!deployed.length) continue;
    task.assignedAccounts.push(...deployed.map((d) => d.username));
    if (error)
      task.error = (task.error ? task.error + "; " : "") + error.trim();

    // Grow the live listing while keeping the half/half split for the new
    // accounts: half sell now, half wait for the post-event markup.
    if (task.listing && task.listing.externalId && !task.listing.postEvent) {
      const addNow = Math.ceil(deployed.length / 2);
      const addHold = deployed.length - addNow;
      const MarketplaceListing = require("../models/MarketplaceListing");
      await MarketplaceListing.updateOne(
        {
          set: task.listing.setId,
          marketplace: "gameflip",
          status: "active",
        },
        { $inc: { qtyRemaining: addNow } },
      );
      task.listing.qty = (Number(task.listing.qty) || 0) + addNow;
      task.listing.heldBack = (Number(task.listing.heldBack) || 0) + addHold;
    }
    await task.save();
    added += deployed.length;
    progress(
      task.game +
        " backfilled: now " +
        task.assignedAccounts.length +
        "/" +
        target +
        " account(s).",
    );
    await tg(
      "\ud83e\udd16 Auto-farm BACKFILL \u2014 " +
        task.game +
        "\n+" +
        deployed.length +
        " account(s), now " +
        task.assignedAccounts.length +
        "/" +
        target +
        ".",
    );
  }
  return added;
}

// Fresh full rescan: forget prior terminal decisions for LIVE campaigns so the
// next tick re-decides every one of them from scratch (fresh research + all).
// Active bots and pending (planned) approvals are preserved.
async function rescanAll() {
  const now = new Date();
  const live = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1 },
  ).lean();
  const ids = live.map((c) => c.campaignId);
  const del = await AutoFarmTask.deleteMany({
    campaignId: { $in: ids },
    status: { $in: ["skipped", "failed", "completed", "stopped"] },
  });
  return { cleared: del.deletedCount || 0, campaigns: ids.length };
}

function status() {
  return {
    started: state.started,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    intervalMinutes: TICK_MS / 60000,
    progress: {
      runId: progressLog.runId,
      startedAt: progressLog.startedAt,
      finishedAt: progressLog.finishedAt,
      running: state.running,
      steps: progressLog.steps,
    },
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("autoFarmer error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, FIRST_TICK_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = {
  start,
  runOnce,
  rescanAll,
  status,
  executeTask,
  completeEndedTasks,
  reapRetiredBots,
  // exported for tests
  fairShare,
  demandAllocation,
  resolveFarmHost,
};
