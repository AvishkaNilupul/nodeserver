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
const botWaker = require("./botWaker");
const mp = require("./marketplaces");
const settings = require("./settings");
const farmSizing = require("./farmSizing");
const { sendTelegram } = require("./telegram");
const suspendedAccounts = require("./suspendedAccounts");
const deadTokenRetire = require("./deadTokenRetire");
const { recordPoolUsage } = require("./poolUsageLog");
const { recordAutoFarmEvent } = require("./autoFarmEventLog");
const { normGame } = require("./gameLabel");
const {
  buildDecisionInputs,
  buildReuseInputs,
  withReuseInputs,
} = require("./decisionInputs");
// Ownership boundary with the new lane engine (utils/farm2/*). Required
// directly rather than through utils/farm2/index.js so this stays a leaf
// dependency: ownership.js pulls in only ./settings, and reads the FarmLane
// model lazily, so there is no load-order coupling and no require cycle back
// into this file.
const farm2Ownership = require("./farm2/ownership");
const DropSet = require("../models/DropSet");
const catalogRoutes = require("../routes/catalogRoutes");
const { stampPreorderSet } = require("./catalogPreorder");

const TICK_MS = 10 * 60 * 1000; // scan every 10 minutes
const FIRST_TICK_DELAY_MS = 90 * 1000; // let the campaign watcher seed first
const DECISION_READ_CONCURRENCY = 4;
const CATALOG_VARIANT_SYNC_MS = 6 * 60 * 60 * 1000;

// Demand tiers (demandScore is 0-100 from utils/marketResearch.js).
const DEMAND_FULL = 40; // proven seller -> full allocation
const DEMAND_HALF = 15; // some demand -> half allocation; below -> skip
const RESEARCH_STALE_MS = 7 * 86400000; // re-scan markets older than a week
// How long to stay quiet after warning that the pool is starved. Long, because
// the condition persists until the operator acts and a per-tick repeat would be
// exactly the spam this system was just fixed for.
const STARVATION_COOLDOWN_MS = 12 * 3600 * 1000;
// How many "farms everything" accounts may be credited as coverage for a single
// game. See the coverage gate for why this is a constant and why it is 0.
const WILDCARD_CREDIT_CAP = 0;
// Do accounts sitting on MANUAL bots count as this game's demand already being
// covered? NO — and this is a deliberate business rule, not a safety valve.
//
// Manual bots are the owner's LONG-TERM STASH: one account farms the same game
// for months, stacking many campaigns' items into a single fat account that is
// listed later as a premium bundle. Prod is full of them — 127 accounts on
// Escape from Tarkov, 110 on Lost Ark, 100 on Warframe, 95 on Overwatch. Those
// accounts are not stock for the campaign running today; they are inventory
// being deliberately withheld from sale.
//
// Counting them as coverage meant every game the owner farms by hand was
// permanently blocked from auto-farming (EVE Online / Ravendawn: 31 "manual
// farmers" against a target of 18, so uncovered was 0 forever). The stash is
// excluded from BOTH coverage terms: the live farmers here, and the unsold
// archive holders below — a stashed account holds the game's drops, so leaving
// it in the archive count would re-impose exactly the same block.
const COUNT_MANUAL_AS_COVERAGE = false;
const SALES_WINDOW_MS = 45 * 86400000; // own-sales training window
// Each of our own recent sales is worth this many demand points (log-damped
// below). 5+ recent sales pushes any game to full allocation on its own.
const INTERNAL_SALE_WEIGHT = 18;
// What a "normal" sale is worth, USD. Own sales are scaled by how their price
// compares to this, because unit counts alone cannot tell a good game from a
// busy one: five sales at $18 is an order of magnitude better business than
// twenty at $0.30, and the account cost of farming them is identical. The
// factor is clamped hard in both directions — price is a tilt on demand, never
// a substitute for the evidence that anyone is buying at all.
//
// RECALIBRATED 2026-09-07: was 2.5, which was never measured against reality.
// The actual median realised sale across every priced row on record is $1.25
// (n=209; see the calibration table in utils/pricing.js), so a $2.50 reference
// declared the TYPICAL sale to be half-price and handed almost every game the
// 0.6 floor. Measured on prod: 19 of the 49 games with own-sales evidence were
// already pinned at the floor, and the other 24 read neutral only because
// their price was never recorded — an accident, not a judgement.
//
// That accident was about to end. Manual mark-sold now captures price (it was
// 71% of all sales and recorded none), so those 24 games were about to acquire
// real prices of $0.75-$1.42 and drop to 0.6 as well — quietly cutting demand
// ~40% across the fleet, and pushing games under DEMAND_HALF, at exactly the
// moment the operator is scaling intake up. A constant meant as a gentle tilt
// had become a near-universal penalty.
//
// At $1.25 the tilt does what it says again: $1.25 is neutral, $0.75 is
// genuinely below normal, $2.50+ genuinely above.
const REFERENCE_SALE_USD = 1.25;
const PRICE_FACTOR_MIN = 0.6;
const PRICE_FACTOR_MAX = 2;

// Bounded parallel map that preserves input order. Decision-input reads may
// overlap, but the campaign commit loop remains serial because it owns finite
// pool, config and container resources.
async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.from(items || []);
  if (!list.length) return [];
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, Number(concurrency) || 1), list.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= list.length) return;
        out[index] = await fn(list[index], index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function createSeatCounter({
  maxAutoBots,
  accountsPerBot,
  activeContainers = 0,
  freeSeats = 0,
} = {}) {
  let active = Math.max(0, Number(activeContainers) || 0);
  let free = Math.max(0, Number(freeSeats) || 0);
  const max = Math.max(0, Number(maxAutoBots) || 0);
  const perBot = Math.max(1, Number(accountsPerBot) || 1);
  const usableFree = () =>
    Math.min(free, Math.min(active, max) * perBot, max * perBot);
  return {
    activeContainers: () => active,
    freeSeats: () => usableFree(),
    slotsFree: () => Math.max(0, max - active),
    capacity: () =>
      Math.min(max * perBot, Math.max(0, max - active) * perBot + usableFree()),
    consumeExisting(count) {
      free = Math.max(0, free - Math.max(0, Number(count) || 0));
    },
    addContainer(count = 1, seatsFree = 0) {
      const requested = Math.max(0, Number(count) || 0);
      const added = Math.min(requested, Math.max(0, max - active));
      active += added;
      free += Math.min(Math.max(0, Number(seatsFree) || 0), added * perBot);
      return added;
    },
  };
}

// How much to scale a game's demand by what its sales are worth. Games we have
// no price for (connection flips only) sit at 1 — unchanged, not punished.
function priceFactor(avgPrice) {
  const p = Number(avgPrice) || 0;
  if (p <= 0) return 1;
  const raw = p / REFERENCE_SALE_USD;
  return Math.min(PRICE_FACTOR_MAX, Math.max(PRICE_FACTOR_MIN, raw));
}

// Skips that may be retried when conditions change (pool refills, a
// container slot frees up, the Pi comes back online).
const RETRYABLE = new Set([
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered", // covered accounts may sell — demand reopens
  "skip_reuse_only", // reuse-only game — retries once one of its own accounts recycles back to the pool
  "skip_probe_budget", // cold-start candidate held off by the concurrency budget — retries when a probe slot frees
]);

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastSummary: null,
  nextRunAt: null,
  // Epoch ms of the last pool-starvation alert (0 = not currently starving).
  // Plain in-process state on purpose: a missed alert after a restart is
  // harmless, and the alternative would need a schema field.
  lastPoolAlertAt: 0,
  // Epoch ms of the last container repack. Same reasoning: a restart just means
  // the next tick may re-check a plan that turns out not to be worth running.
  lastRepackAt: 0,
  lastCatalogVariantSyncAt: 0,
  // When a tick last finished with no error and with its decisions made (a
  // tick that deferred them is not ok). The health board judges by this one;
  // lastRun is stamped by every tick, failed or not.
  lastOkAt: null,
  // Consecutive ticks that deferred every decision (noteDeferredTick).
  deferredTicks: 0,
  deferredAlerted: false,
  // Main mode: lane key -> { ticks, since, alerted } for a game left waiting
  // for a lane that did not appear: consecutive ticks, when the wait began,
  // whether its fallback was announced (noteAwaitingLane).
  awaitingLaneTicks: new Map(),
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
// token_invalid / suspended accounts can't farm, so they don't count as supply
// (the enum whitelist below excludes all three).
function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
    // An account the operator handed to a buyer by hand is NOT supply: the buyer
    // holds the login AND password, so farming it again just re-sells an account
    // somebody already owns outright (the soldGames block can't help — the buyer
    // can sign in and take whatever the next campaign farms). The no-claim claim
    // path has always excluded these; this keeps the auto-farmer, farm2 (which
    // composes this query) and the recycler on one definition of "ready".
    manualSold: { $ne: true },
    // An account holding farmed-but-UNCLAIMED drops is stock, not supply: every
    // auto-farm bot claims all claimable drops within a minute of starting, which
    // destroys no-claim-game stock (Rainbow Six / Overwatch items are only
    // sellable unclaimed). The pool checker normally takes such accounts out of
    // the pool (utils/poolStock.holdForStock), but anything that puts one back as
    // "available" opens a window before the next check — on 2026-09-23 backfill
    // claimed 16 of them into CONTROL Resonant / REMATCH bots inside that window.
    // Absent/null counts as 0, so never-checked rows are unaffected.
    unclaimedDropCount: { $not: { $gt: 0 } },
  };
}

// Only a claim the auto-farm itself made is the auto-farm's to hand back. The
// three recycle paths below (task retirement, the retro-reaper, probe expiry)
// used to flip ANY claimed pool row among a task's accounts back to
// "available" — including rows other subsystems hold on purpose: unclaimed
// stock held by utils/poolStock ("unclaimed stock — …"), no-claim bot accounts
// ("noclaim-farm:…"), spent/sold notes, renter leases, audit quarantines and
// personal (manualSold) accounts. The retro-reaper re-runs over EVERY completed
// task on EVERY tick, so held stock was released and re-held about every 23
// minutes (a "📦 Account pool check" Telegram each time, ~315 in 10 days), and
// backfill claimed some of it into claiming bots in between.
const AUTO_FARM_CLAIM_NOTE = /^auto-farm( backfill)?:/i;

function isAutoFarmClaimNote(note) {
  return AUTO_FARM_CLAIM_NOTE.test(String(note || ""));
}

function recyclableClaimQuery(logins) {
  return {
    usernameLower: {
      $in: [...new Set((logins || []).map((u) => String(u).toLowerCase()))],
    },
    status: "claimed",
    claimedNote: AUTO_FARM_CLAIM_NOTE,
    manualSold: { $ne: true },
  };
}

async function countReadyPool() {
  return AvailableAccount.countDocuments(readyPoolQuery());
}

// How many of a task's assigned accounts can actually still farm and be sold.
// assignedAccounts is a login list that intentionally keeps accounts whose
// tokens died — they hold farmed drops and re-auth revives them — but a
// suspended account never comes back, so it must never count toward target,
// whether or not the release phase has reached it yet.
// Unknown logins (no BotAccount row yet, e.g. mid-deploy) count as usable so a
// timing gap can never inflate a backfill. `suspended` is the lowercased login
// set from suspendedAccounts.suspendedLoginSet(), read once per sweep rather
// than per task — 684 of prod's 3,998 logins carry capitals, so every comparison
// has to be case-folded.
function usableAssignedCount(task, suspended) {
  const logins = (task.assignedAccounts || [])
    .map((x) => String(x || "").toLowerCase())
    .filter(Boolean);
  if (!suspended || !suspended.size) return logins.length;
  return logins.filter((l) => !suspended.has(l)).length;
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

// Own sales history — the training data. Counts SaleSignal rows in the window
// for one game, and ONLY the sources that mean a buyer paid:
//
//   connected    — the drop scanner watched a buyer link the account.
//   listing_sold — a marketplace reported the purchase (Gameflip poller, a
//                  delist that came back "already sold", a Plati/GGSel stock
//                  count that dropped, a hand-delivered sale).
//
// "drop_reserved" is deliberately NOT counted. It is stamped every time stock
// is CLAIMED for a listing — auto-lister publish, guardian restock — which is
// shelf-filling, not selling. Counting it closed a loop where farming was its
// own proof of demand: farm a game, stock it on four markets, collect four
// "sales", earn full allocation and a raised cap, farm more. A game that had
// never sold a single unit could hold itself at maximum allocation forever.
async function internalSalesForGame(game) {
  const cutoff = new Date(Date.now() - SALES_WINDOW_MS);
  const gameKey = String(game).toLowerCase();
  const salesWindow = {
    gameKey,
    at: { $gte: cutoff },
    source: { $in: ["connected", "listing_sold"] },
  };
  try {
    // One SALE, not one drop row. The two real sources need different
    // collapsing, so the grouping key is per-source:
    //   - "connected" writes one row PER DROP, so a single sold account
    //     carrying a 50-item bundle would read as 50 sales — group those by
    //     account, since an account sells once.
    //   - "listing_sold" already writes one row per (listing, game, unit), and
    //     a quantity listing does not know WHICH account the buyer received,
    //     so account is null there. Grouping those by account would collapse
    //     every anonymous unit sale on every listing into a single "sale";
    //     they fall back to their dedupeKey, which is unique per unit.
    // A Gameflip sale that the buyer then connects lands on the same account
    // under both sources and is correctly counted once.
    //
    // Quantity units (a login POOL in `login`, see QUANTITY_POOL_RE) are set
    // aside by the facet and counted by quantityUnitSales below instead.
    const [out] = await SaleSignal.aggregate([
      { $match: salesWindow },
      {
        $facet: {
          sales: [
            { $match: { $nor: [QUANTITY_UNIT_MATCH] } },
            {
              $group: {
                _id: { $ifNull: ["$account", "$dedupeKey"] },
                // One sale can produce several rows (a Gameflip sale the buyer
                // then connects). Take the best price any of them carries
                // rather than summing, or the same money would be counted
                // twice.
                priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                revenue: { $sum: "$priceUsd" },
                // How many of those sales we actually know a price for. A
                // connection flip proves a sale but names no price, and
                // dividing revenue by every sale would report a game as
                // half-price purely because some of its evidence is priceless
                // rather than free.
                priced: { $sum: { $cond: [{ $gt: ["$priceUsd", 0] }, 1, 0] } },
              },
            },
          ],
          units: [
            { $match: QUANTITY_UNIT_MATCH },
            { $project: { _id: 0, login: 1, at: 1, priceUsd: 1, dedupeKey: 1 } },
          ],
        },
      },
    ]);
    const r = (out && out.sales && out.sales[0]) || {
      count: 0,
      revenue: 0,
      priced: 0,
    };
    const units = (out && out.units) || [];
    let q = { count: 0, revenue: 0, priced: 0 };
    if (units.length) {
      try {
        q = await quantityUnitSales(salesWindow, units);
      } catch (e) {
        // The pairing read failed: count every unit as its own sale (the
        // pre-pairing count for these rows) rather than lose the game's sales
        // to the catch below — a demand of 0 can skip a campaign for good.
        q = unpairedUnitSales(units);
        warnUnitPairing(gameKey, e);
      }
    }
    const count = (r.count || 0) + q.count;
    const revenue = Math.round(((r.revenue || 0) + q.revenue) * 100) / 100;
    const priced = (r.priced || 0) + q.priced;
    return {
      count,
      revenue,
      avgPrice: priced ? Math.round((revenue / priced) * 100) / 100 : 0,
    };
  } catch {
    return { count: 0, revenue: 0, avgPrice: 0 };
  }
}

// QUANTITY UNITS (2026-10-03). A GGSel / Digiseller offer sells "whichever unit
// the platform picks", so its listing_sold row cannot name the account: its
// `login` is the listing's whole delivery pool ("a, b, c"), written once per
// unit. When that buyer later connects the account, the drop scanner writes a
// `connected` row under the account's own id — and the two rows used to be
// counted as two sales (measured over 60 days: 54 such World of Tanks signals,
// 20 Albion). A pool row whose `account` happened to be set was the opposite
// error: every unit of the listing collapsed onto that one account.
//
// The rule is utils/priceTracker/games.js soldUnion's rule 3, so the engine and
// the price tracker count one sale the same way: each pool row is ONE
// anonymous unit; it is the sale behind the first connection, from a login in
// its pool, seen at or after it (a day of slack: the stock-drop inference
// stamps the sale when it notices it), that no named sale and no earlier unit
// already took — then the pair is one sale. Otherwise the unit is its own sale.
// A pool is two or more logins split the way the ledger splits them
// (priceTracker/ledger.js loginList).
const QUANTITY_POOL_RE = /[^\s,;][\s,;]+[^\s,;]/;
const QUANTITY_UNIT_MATCH = { source: "listing_sold", login: QUANTITY_POOL_RE };
const QUANTITY_CONNECT_SLACK_MS = 86400000;

function loginPool(login) {
  return String(login || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// What the units add to the count: what pairing needs is read only when a game
// has units at all (most have none). One facet: the earliest connection per
// login, and the logins the named (single-login) sales already account for.
//
// Only rows that can matter are read, so the answer is bounded by the pools'
// logins, not by how much a game sells: connections from a pool login, the
// named sales of a pool login, and the accounts of login-less named sales
// (one may map to a pool login through a connection). Returning every named
// row in one $facet document hit the 16 MB cap on a big enough game.
async function quantityUnitSales(salesWindow, units) {
  const poolLogins = [...new Set(units.flatMap((u) => loginPool(u.login)))];
  const login = {
    $trim: {
      input: { $toLower: { $ifNull: ["$login", ""] } },
      chars: " ,;\t\n\r",
    },
  };
  const [p] = await SaleSignal.aggregate([
    { $match: salesWindow },
    {
      $facet: {
        connected: [
          {
            $match: {
              source: "connected",
              $expr: { $in: [login, { $literal: poolLogins }] },
            },
          },
          {
            $group: {
              _id: login,
              at: { $min: "$at" },
              accounts: { $addToSet: "$account" },
            },
          },
        ],
        namedLogins: [
          {
            $match: {
              source: "listing_sold",
              $nor: [{ login: QUANTITY_POOL_RE }],
              $expr: { $in: [login, { $literal: poolLogins }] },
            },
          },
          { $group: { _id: login } },
        ],
        namedAccounts: [
          {
            $match: {
              source: "listing_sold",
              account: { $ne: null },
              $expr: { $eq: [login, ""] },
            },
          },
          { $group: { _id: "$account" } },
        ],
      },
    },
  ]);
  const named = ((p && p.namedLogins) || [])
    .map((r) => ({ login: r._id }))
    .concat(((p && p.namedAccounts) || []).map((r) => ({ login: "", account: r._id })));
  return pairQuantityUnits(units, (p && p.connected) || [], named);
}

// Every unit its own sale — what the units add when pairing cannot be read.
function unpairedUnitSales(units) {
  const out = { count: 0, revenue: 0, priced: 0, paired: 0 };
  for (const u of units || []) {
    const price = Math.max(0, Number(u && u.priceUsd) || 0);
    out.count += 1;
    out.revenue += price;
    if (price > 0) out.priced += 1;
  }
  return out;
}

// At most one console line an hour: a pairing read that keeps failing is a
// finding for the operator, not a log flood (every decision reads sales).
const UNIT_PAIRING_WARN_MS = 60 * 60 * 1000;
let lastUnitPairingWarnAt = 0;
function warnUnitPairing(gameKey, err) {
  if (Date.now() - lastUnitPairingWarnAt < UNIT_PAIRING_WARN_MS) return;
  lastUnitPairingWarnAt = Date.now();
  console.error(
    "autoFarmer: quantity-unit pairing read failed for " +
      gameKey +
      " — units counted one sale each:",
    (err && err.message) || err,
  );
}

// Pure. `units`: pool rows {login, at, priceUsd, dedupeKey}; `connected`: one
// row per connected login {_id: login, at: earliest, accounts}; `named`: the
// other listing_sold rows {login, account}. Returns what the units ADD to the
// account-grouped count: a paired unit adds no sale (its connection is one
// already) but brings its price, so that sale becomes a priced one.
function pairQuantityUnits(units, connected, named) {
  const connAt = new Map(); // login -> earliest connection (ms)
  const acctLogin = new Map(); // account id -> login
  for (const c of connected || []) {
    const login = String((c && c._id) || "").trim().toLowerCase();
    if (!login) continue;
    const at = new Date(c.at).getTime();
    if (Number.isFinite(at) && (!connAt.has(login) || at < connAt.get(login))) {
      connAt.set(login, at);
    }
    for (const a of c.accounts || []) {
      if (a) acctLogin.set(String(a).toLowerCase(), login);
    }
  }
  for (const s of named || []) {
    const ls = loginPool(s && s.login);
    if (s && s.account && ls.length === 1) {
      acctLogin.set(String(s.account).toLowerCase(), ls[0]);
    }
  }
  const taken = new Set();
  for (const s of named || []) {
    const ls = loginPool(s && s.login);
    const login =
      ls.length === 1
        ? ls[0]
        : s && s.account
          ? acctLogin.get(String(s.account).toLowerCase()) || ""
          : "";
    if (login) taken.add(login);
  }
  const out = { count: 0, revenue: 0, priced: 0, paired: 0 };
  const sorted = (units || []).slice().sort(
    (a, b) =>
      new Date(a.at) - new Date(b.at) ||
      String(a.dedupeKey || "").localeCompare(String(b.dedupeKey || "")),
  );
  for (const u of sorted) {
    const t = new Date(u.at).getTime();
    let best = null;
    for (const l of loginPool(u.login)) {
      const ct = connAt.get(l);
      if (ct == null || taken.has(l)) continue;
      if (ct < t - QUANTITY_CONNECT_SLACK_MS) continue; // connected before it sold
      if (!best || ct < best.at) best = { login: l, at: ct };
    }
    if (best) {
      taken.add(best.login);
      out.paired += 1;
    } else {
      out.count += 1;
    }
    const price = Math.max(0, Number(u.priceUsd) || 0);
    out.revenue += price;
    if (price > 0) out.priced += 1;
  }
  return out;
}

// ---- Existing coverage: who is ALREADY farming/holding a game? ----

// Read every non-auto bot config across all hosts once per tick and count
// enabled accounts farming each game. A config with OnlyFavouriteGames=false
// or no favourites at all farms every available campaign, so those accounts
// count toward every game (the wildcard set). Auto-bot files are excluded
// via the AutoFarmTask registry so we never count ourselves.
//
// `logins` is the full stash membership — every login enabled on a manual bot,
// however it is configured. The coverage gate subtracts it from the archive
// holder count (see COUNT_MANUAL_AS_COVERAGE), so it must be complete even for
// accounts whose game list we could not classify.
async function manualFarmMap(autoKeys) {
  const map = new Map(); // gameLower -> Set(login)
  const wildcard = new Set(); // logins farming everything
  const logins = new Set(); // every login deployed on a manual bot
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
      // The config-level FavouriteGames lives at the ROOT of the file, not
      // under TwitchSettings (verified against live configs on the Pi:
      // top-level keys are TwitchSettings, KickSettings, FavouriteGames, …
      // while OnlyFavouriteGames sits inside TwitchSettings). Reading it from
      // TwitchSettings always yielded [], so every account with an empty
      // per-account list — the normal way manual bots are set up — was
      // misfiled as a wildcard instead of as a farmer of the config's games.
      // That is where the "1615 accounts farming everything" figure came from.
      const cfgFavs = Array.isArray(cfg.FavouriteGames)
        ? cfg.FavouriteGames
        : [];
      const only = ts.OnlyFavouriteGames !== false;
      for (const u of users) {
        if (!u || u.Enabled === false) continue;
        const login = String(u.Login || "").toLowerCase();
        if (!login) continue;
        logins.add(login);
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
  return { map, wildcard, logins };
}

// Accounts that already HOLD this game's drops (unsold, unredeemed) — straight
// from the drop archive. Farming onto more accounts only makes sense when these
// holders can't cover expected demand.
//
// Deliberately keyed on GAME, not campaign. The old query added
// `campaign: c.name`, but DropLog.campaign is populated on only 1.81% of rows
// on prod (2877 of 158774), so the term returned 0 for essentially every
// campaign and the only real inventory signal in the coverage model was dead.
// Game-level counting is also the honest question: an unsold account holding
// this game's drops is sellable stock whichever campaign minted it.
//
// WHOSE STOCK COUNTS
// Only the auto-farmer's OWN. Its listings deliver out of the assigning task
// (autoLister.pickDeliveryAccounts walks task.assignedAccounts and nothing
// else), so an archive account that belongs to no auto task can never be handed
// to one of its buyers. Counting that stock as "demand already covered" stopped
// it farming stock it COULD have sold: measured on prod, nine live campaigns
// were blocked by inventory the auto system owns none of — Hunt: Showdown 219
// holders, Black Desert 166, GOALS 120, Overwatch 110, owning 0 of each.
//
// The two excluded groups are still counted and recorded, because "why didn't
// it farm this" deserves a real answer:
//   * stashed  — enabled on a manual bot: the owner's long-term hoard.
//   * other    — real archive stock, but attached to no auto task, so the
//                manual listing flow is what sells it.
async function archiveHoldersForCampaign(c, stash, owned) {
  try {
    const logins = await DropLog.distinct("login", {
      game: c.game,
      connected: { $ne: true },
      soldAt: null,
    });
    return splitHolders(logins.filter(Boolean), stash, owned);
  } catch {
    return { holders: 0, stashed: 0, other: 0 };
  }
}

// Sort one game's unsold holders into: ours to sell, stashed on a manual bot,
// and everything else. Shared by the per-campaign and per-tick versions so both
// can never drift apart.
// `owned === null` means ownership could not be determined — every non-stashed
// holder is then credited, which is the higher-coverage, lower-spend reading.
function splitHolders(all, stash, owned) {
  let holders = 0;
  let stashed = 0;
  let other = 0;
  for (const raw of all) {
    const l = String(raw).toLowerCase();
    if (stash && stash.has(l)) stashed++;
    else if (!owned || owned.has(l)) holders++;
    else other++;
  }
  return { holders, stashed, other };
}

// The same count for many games in ONE aggregation, built once per tick. The
// per-campaign version above costs a distinct() each, which was ~55 round-trips
// on a tick with a full candidate list. Scoped to the games actually being
// decided so the $addToSet stays small (prod Mongo is an Atlas shared tier with
// allowDiskUse disabled, so aggregations must stay under 100MB).
// The stash is subtracted in JS rather than with a `login: {$nin: [...]}` term:
// the stash runs to a couple of thousand logins on prod, and pushing that list
// into the match stage would both bloat the query document and stop the
// game+connected+soldAt index from doing the selective work first.
async function archiveHoldersByGame(games, stash, owned) {
  const out = new Map();
  const list = [...new Set(games.filter(Boolean))];
  if (!list.length) return out;
  try {
    const rows = await DropLog.aggregate([
      {
        $match: { game: { $in: list }, connected: { $ne: true }, soldAt: null },
      },
      { $group: { _id: { game: "$game", login: "$login" } } },
      // One entry per (game, login) pair already exists after the first
      // $group, so collecting the logins costs nothing extra in documents and
      // keeps the pipeline well under the 100MB in-memory limit (Atlas shared
      // tier: allowDiskUse is unavailable).
      { $group: { _id: "$_id.game", logins: { $addToSet: "$_id.login" } } },
    ]);
    for (const r of rows) {
      out.set(
        String(r._id).toLowerCase(),
        splitHolders((r.logins || []).filter(Boolean), stash, owned),
      );
    }
  } catch {
    /* fall back to the per-campaign query */
  }
  return out;
}

// Every account any auto-farm task has ever been given. This is exactly the
// set utils/autoLister.js can deliver from, which is why it — and not the whole
// drop archive — defines what the auto system counts as its own stock.
//
// Returns NULL if the lookup fails, and callers must treat that as "ownership
// unknown". An empty Set would be a silent fail-OPEN: owning nothing reads as
// zero coverage, which is the state that spends the most accounts. Unknown
// instead falls back to counting every non-stashed holder, the conservative
// reading this gate used before ownership was tracked.
async function ownedAccounts() {
  try {
    const out = new Set();
    for (const t of await AutoFarmTask.find(
      {},
      { assignedAccounts: 1 },
    ).lean()) {
      for (const u of t.assignedAccounts || [])
        out.add(String(u).toLowerCase());
    }
    return out;
  } catch {
    return null;
  }
}

function hoursLeft(endAt) {
  if (!endAt) return Infinity;
  return (new Date(endAt).getTime() - Date.now()) / 3600000;
}

// Games the operator wants farmed even when a campaign is inside the ends-soon
// window — e.g. multi-day esports events (Esports World Cup) whose per-day
// campaigns are each shorter than minHoursLeft, so the time gate would
// otherwise skip every one of them. Configured via af.forceGames (list of game
// names); matched case/format-insensitively so "Rainbow Six Siege" catches any
// label drift. Only bypasses the TIME gate — demand/host/capacity gates still
// apply, so a forced game with no demand or no free accounts still won't farm.
function normForce(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function isForcedGame(game, af) {
  const list = af && Array.isArray(af.forceGames) ? af.forceGames : [];
  if (!list.length) return false;
  const g = normForce(game);
  return list.some((f) => normForce(f) === g);
}

// How many accounts a game deserves. External market demand (MarketResearch)
// is blended with OUR OWN sales history: every recent PAID sale of this game's
// items adds log-damped demand points, scaled by what those sales were worth.
// A game our own data proves sells never gets skipped just because external
// scouts are quiet.
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
  //
  // ...and only while the market is SWITCHED ON (2026-10-03), the same switch
  // test as autoLister.platiTakesNewStock / ggselTakesNewStock. A switched-off
  // market gets no share of the stock, so counting its shelf made every new
  // campaign farm 18 accounts for 12 shelves while Plati was blocked (09-28).
  let markets = 1; // gameflip is the primary and always listed
  if (af.platiCategoryId && af.platiEnabled !== false) markets++;
  try {
    const ks = mp.keyStatus();
    if (ks && ks.ggsel && ks.ggsel.configured && af.ggselEnabled !== false) {
      markets++;
    }
  } catch {
    /* marketplaces module unavailable — floor covers fewer markets */
  }
  const per = Math.max(1, Number(af.perMarketStock) || 3);
  return Math.min(markets * per * 2, af.maxPerGame);
}

// Demand-scaled per-game cap. `maxPerGame` stays the SAFE base for anything
// unproven (it exists to stop burning accounts on non-sellers), but a game
// with real recorded sales of OURS earns headroom: +2 accounts per internal
// sale in the 45-day window, hard-ceilinged at 2x the base. External market
// scouts alone can never raise the cap — only our own sales history can, so
// a junk game still tops out at the base no matter how loud the market looks.
const SALES_CAP_BONUS_PER_SALE = 2;
const SALES_CAP_MULT_MAX = 2;

// Callers used to pass a bare sale count and now pass { count, revenue,
// avgPrice }. Accept both so a stale call site degrades to the old behaviour
// (no price tilt) instead of reading NaN sales and skipping a good game.
function salesOf(internalSales) {
  if (internalSales && typeof internalSales === "object") {
    return {
      count: Math.max(0, Number(internalSales.count) || 0),
      revenue: Math.max(0, Number(internalSales.revenue) || 0),
      avgPrice: Math.max(0, Number(internalSales.avgPrice) || 0),
    };
  }
  return {
    count: Math.max(0, Number(internalSales) || 0),
    revenue: 0,
    avgPrice: 0,
  };
}

// COVERAGE SIZING (2026-09-08, settings.coverageSizing, ships OFF).
//
// The clamp above is a FLAT ceiling: at maxPerGame 30 a game that sold 15 units
// and a game that sold 200 are both capped at 60. Measured on prod the same
// week: Overwatch 202 sales in 30 days, Rocket League 83, Brawlhalla 69 — all
// treated identically to a game that sold 15, so past ~15 sales a game's own
// success bought it nothing.
//
// With the switch on, the ceiling becomes what the game's real sell rate would
// justify holding (utils/farmSizing.coverageTarget: a sold account is consumed
// by the buyer, so N sales a week burns N accounts a week). Three properties
// make this safe to turn on:
//
//   * the legacy cap is the FLOOR, never the ceiling — switching on can only
//     raise a game's headroom, so no game shrinks;
//   * `coverageMaxPerGame` bounds it absolutely, because a mis-measured game
//     must not be able to drain the pool;
//   * it is only a CEILING. The demand tiers still decide the target, the
//     coverage gate still subtracts stock we already hold, and fairShare, the
//     pool reserve and container capacity all still bind afterwards. Raising a
//     cap does not spend an account.
//
// `game` is optional and everything degrades without it: no game means no
// per-game override and no coverage lookup, i.e. exactly the old behaviour.
// That is why every existing caller keeps working unchanged.
function capForGame(af, internalSales = 0, game = "") {
  const base = Math.max(1, Number(af.maxPerGame) || 1);
  const { count } = salesOf(internalSales);
  const legacy = Math.min(
    base + Math.floor(count * SALES_CAP_BONUS_PER_SALE),
    base * SALES_CAP_MULT_MAX,
  );

  // Read the sizing policy OUT OF THE `af` WE WERE GIVEN, not from a fresh
  // settings read. `af` is the auto-farm settings object the caller already
  // loaded for this decision, so this keeps one decision on one consistent
  // snapshot and saves a disk read per campaign per tick.
  let cfg = null;
  try {
    cfg = settings.getFarmSizing ? settings.getFarmSizing(af) : null;
  } catch {
    /* settings unreadable — fail closed to the legacy cap */
  }
  if (!cfg) return legacy;

  // An explicit per-game number is the operator overriding the model. It wins
  // over BOTH the legacy cap and the coverage target, in either direction.
  if (game) {
    try {
      const override = settings.gameAccountCapFor(game, af);
      if (override > 0) return override;
    } catch {
      /* fall through to the automatic path */
    }
  }

  if (!cfg.enabled) return legacy;

  const perWeek = farmSizing.salesPerWeek(count, SALES_WINDOW_MS / 86400000);
  const covered = farmSizing.coverageTarget({
    salesPerWeek: perWeek,
    coverageDays: game ? cfg.coverageDaysFor(game) : cfg.coverageDays,
    safetyStock: game ? cfg.safetyStockFor(game) : cfg.safetyStock,
    min: legacy,
    max: game ? Math.max(legacy, cfg.maxFor(game)) : Math.max(legacy, cfg.maxPerGame),
  });
  // A game with no sales at all gets nothing from the coverage model, so guard
  // the max() rather than trusting it to have returned the floor.
  return Math.max(legacy, covered || 0);
}

function demandAllocation(research, af, internalSales = 0, opts = {}) {
  // The caller gates probing on the global budget + per-game cooldown; when it
  // passes nothing (or probeColdStart is off) probing is simply allowed, which
  // preserves the original unknown-game probe behaviour exactly.
  const probeAllowed = opts.probeAllowed !== false;
  // `opts.game` is what lets the per-game override and the coverage model apply.
  // Omitting it is not a bug in a caller — it degrades to the flat legacy cap,
  // which is what every caller got before coverage sizing existed. The replay
  // harness deliberately passes it so a replayed decision is scored against the
  // same ceiling the live engine used.
  const cap = capForGame(af, internalSales, opts.game || "");
  const sales = salesOf(internalSales);
  const pf = priceFactor(sales.avgPrice);
  // Own sales are the strongest evidence there is, tilted by what they were
  // worth: the same five sales count for more when each one is $18 than when
  // each one is $0.30, because the accounts they cost us are the same either
  // way.
  const salesBoost =
    sales.count > 0 ? INTERNAL_SALE_WEIGHT * Math.log1p(sales.count) * pf : 0;
  const priceNote =
    sales.avgPrice > 0 ? " at $" + sales.avgPrice.toFixed(2) + " avg" : "";
  const probeBatch = (tierNote, coldStart) => ({
    cap,
    target: Math.min(af.probeSize, cap),
    tierNote,
    probe: true,
    coldStart: !!coldStart,
    effective: Math.round(salesBoost),
  });
  if (!research || research.scannedAt == null) {
    if (salesBoost >= DEMAND_HALF) {
      // No market data but our own sales history says it sells.
      const full = salesBoost >= DEMAND_FULL;
      return {
        cap,
        target: full ? cap : Math.max(1, Math.ceil(cap / 2)),
        tierNote:
          "no external market data, but " +
          sales.count +
          " of our own recent sales" +
          priceNote +
          " — " +
          (full ? "full" : "half") +
          " allocation",
        effective: Math.round(salesBoost),
      };
    }
    // No market data at all — the original unknown-game probe. When the budget
    // or cooldown blocks it (cold-start feature on), fall through to a skip.
    if (probeAllowed) return probeBatch("no market data — probe batch", false);
    return {
      skip: true,
      demand: Math.round(salesBoost),
      effective: Math.round(salesBoost),
      probeBlocked: true,
    };
  }
  const market = Number(research.demandScore || 0);
  const d = Math.round((market + salesBoost) * 10) / 10;
  const salesNote =
    sales.count > 0 ? " incl. " + sales.count + " own sales" + priceNote : "";
  if (d >= DEMAND_FULL) {
    return {
      cap,
      target: cap,
      tierNote:
        "demand " +
        d +
        salesNote +
        " (proven seller) — full allocation" +
        (cap > af.maxPerGame
          ? " (cap raised to " + cap + " by own sales)"
          : ""),
      effective: d,
    };
  }
  if (d >= DEMAND_HALF) {
    return {
      cap,
      target: Math.max(1, Math.ceil(cap / 2)),
      tierNote: "demand " + d + salesNote + " (moderate) — half allocation",
      effective: d,
    };
  }
  // Below the demand floor. Normally a skip — but a low score can mean two very
  // different things. With real rivals selling it, the market has spoken: skip.
  // With ~no sellers, the market is simply UNTESTED (a brand-new release nobody
  // lists yet), so the score is a cold-start artefact, not proof it won't sell.
  // When cold-start probing is on and the budget/cooldown allow it, probe such
  // a game with a small batch and let real sales decide. One sale lifts it over
  // the floor via salesBoost and it graduates on its own; none in 30 days and
  // the stop-loss sweep tears it down.
  const sellers = Number(research.sellers || 0);
  if (af.probeColdStart && sellers <= Number(af.probeMaxSellers || 0)) {
    // A probe candidate: untested market, not a proven dud. Probe it unless the
    // global budget or the post-failure cooldown says not right now (in which
    // case it's a probeBlocked skip, not a "doesn't sell" skip).
    if (probeAllowed) {
      return probeBatch(
        "demand " +
          d +
          " but only " +
          sellers +
          " rival seller" +
          (sellers === 1 ? "" : "s") +
          " — untested market, probing",
        true,
      );
    }
    return { skip: true, demand: d, effective: d, probeBlocked: true };
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
// `preferGame` gives game affinity: accounts recycled after a previous
// campaign of the SAME game (their claimedNote reads "recycled after <game>")
// are claimed FIRST, so an account keeps stacking one game's drops event after
// event instead of scattering across whatever campaign claims it next.
//
// `recycledOnly` is the reuse-only games' gate (World of Tanks / UFL, see
// settings.isReuseOnlyGame): claim ONLY accounts this game was already farmed
// on and recycled — never a brand-new pool account. It drops the generic
// fallback pass, so when none of the game's own recycled accounts are free it
// claims nothing rather than reaching for fresh stock. Requires preferGame;
// without it there is nothing game-specific to match and it claims nothing.
async function claimPoolAccounts(
  n,
  note,
  { preferGame = "", recycledOnly = false } = {},
) {
  const claimed = [];
  // Backfill's note ("auto-farm backfill: <game> (<campaignId>)") names the
  // same two things; it did not match here, so its usage events carried no
  // game and a caller that passed no preferGame got no soldGames exclusion.
  const noteMatch = String(note || "").match(
    /^auto-farm(?: backfill)?:\s*(.*?)\s*\(([^)]+)\)\s*$/i,
  );
  const targetGame = normGame(preferGame || (noteMatch && noteMatch[1]) || "");
  const passes = [];
  if (preferGame) {
    const esc = String(preferGame).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    passes.push({
      claimedNote: new RegExp("^recycled after " + esc + "$", "i"),
    });
  }
  if (!recycledOnly) passes.push({});
  // The pristine reserve (2026-10-03): never-farmed accounts are what paid
  // rent-farm orders need, and a farm claim spends them for good. While the
  // pristine count is above the reserve the filter is {} (no change); at the
  // reserve it excludes pristine rows. Re-read before EVERY claim — it is
  // cached, and noteClaimed() lowers the cached count — so one call cannot
  // dig below the reserve between two refreshes.
  let pristineReserve = null;
  // One account, one bot (utils/fleetIntegrity.js, 2026-10-06): an account that
  // sits in a no-claim bot is never claimed here, whatever its pool row says —
  // on 09-21 68 such rows read "available", were claimed for Rocket League and
  // had their unclaimed Overwatch drops claimed by these bots. When the
  // no-claim configs cannot be read and never were, claim nothing: the caller
  // keeps its plan and retries on the next tick.
  let fence;
  try {
    const integrity = require("./fleetIntegrity");
    fence = await integrity.claimFence("managed");
    await integrity.reportFencedRows("managed", fence);
  } catch (e) {
    progress(
      "Not claiming pool accounts: the no-claim bot configs could not be read (" +
        ((e && e.message) || e) +
        "), so which accounts already farm there is unknown.",
      "warn",
    );
    return claimed;
  }
  // Folded into readyPoolQuery's own token rule (clientSecret: { $gt: "" }).
  const notInNoclaim = fence.exclude.length
    ? { clientSecret: { $gt: "", $nin: fence.exclude } }
    : {};
  for (const extra of passes) {
    while (claimed.length < n) {
      let pristineGuard;
      try {
        // Inside the guard: a deploy without the module is a filter that
        // cannot be read, and takes the same safe exit.
        pristineReserve = pristineReserve || require("./pristineReserve");
        pristineGuard = await pristineReserve.farmClaimFilter();
      } catch {
        // Cannot tell whether one more claim digs into the reserve: claim no
        // more, but hand back what already landed so the caller deploys or
        // releases it (throwing here would strand those accounts claimed).
        return claimed;
      }
      const doc = await AvailableAccount.findOneAndUpdate(
        {
          $and: [
            {
              ...readyPoolQuery(),
              ...extra,
              ...(targetGame ? { soldGames: { $ne: targetGame } } : {}),
              ...notInNoclaim,
            },
            pristineGuard,
          ],
        },
        {
          $set: {
            status: "claimed",
            claimedAt: new Date(),
            claimedNote: note,
          },
        },
        { returnDocument: "after", sort: { lastCheckAt: -1 } }, // freshest-verified first
      );
      if (!doc) break;
      claimed.push(doc);
      try {
        pristineReserve.noteClaimed(doc);
      } catch {
        /* bookkeeping only — the claim itself has landed and is returned */
      }
      await recordPoolUsage(doc._id, {
        event: "claimed",
        actor: "auto-farm",
        note,
        game: preferGame || (noteMatch && noteMatch[1]) || "",
        campaignId: (noteMatch && noteMatch[2]) || "",
      });
    }
    if (claimed.length >= n) break;
  }
  return claimed;
}

async function releasePoolAccounts(docs) {
  if (!docs.length) return;
  const result = await AvailableAccount.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { status: "available", claimedAt: null, claimedNote: "" } },
  ).catch(() => {});
  if (result) {
    await recordPoolUsage(
      docs.map((d) => d._id),
      { event: "released", actor: "auto-farm" },
    );
  }
}

// Containers currently in use by live auto-farm tasks (the capacity gate).
async function activeAutoBotCount(ctx) {
  if (ctx && ctx.hostState) return ctx.hostState.activeBots.length;
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

// Ready accounts a FARM must leave in the pool for the pristine reserve
// (utils/pristineReserve.js, af.pristineReserve; 2026-10-03). Subtracted with
// poolReserve wherever ready-minus-reserve becomes a farm's spend budget —
// executeTask, backfill, the tick's fair share and the farm2 cycle budget — so
// a budget never counts accounts the claim filter will refuse. Display counts
// do not subtract it. The helper fails safe on its own count errors (it reports
// the whole reserve as protected); if the module itself cannot be used, this
// does the same.
async function pristineProtect(af) {
  try {
    const g = await require("./pristineReserve").farmGuard();
    const p = Number(g && g.protect);
    return Number.isFinite(p) && p > 0 ? Math.floor(p) : 0;
  } catch {
    return Math.max(0, Math.floor(Number(af && af.pristineReserve) || 0));
  }
}

// What a FARM may spend out of `ready` pool accounts. The LARGER of the two
// floors comes off, not their sum: the pristine accounts the reserve holds back
// are ready accounts themselves, and while they sit in the pool they are also
// the manual-work floor poolReserve keeps — subtracting both counted the same
// accounts twice (2026-10-03 review). The farm2 cycle budget does the same.
function farmSpendable(ready, poolReserve, protect) {
  const floor = Math.max(Number(poolReserve) || 0, Number(protect) || 0);
  return Math.max(0, (Number(ready) || 0) - floor);
}

// How many NEW containers a farm may create on `host`, given `slots` free under
// maxAutoBots: none while the host is short of RAM (utils/hostCapacity.js,
// af.hostMinFreeMb; 2026-10-03 — three farms share one VPS and nothing
// arbitrated its memory). Only the containers term is gated: free seats inside
// RUNNING containers cost no new RAM and stay usable. Seats inside a STOPPED
// (parked) container are not: filling one restarts it, which is a whole
// container's RAM — so while the gate is shut callers count and fill running
// containers only (`blocked` -> autoSeatCapacity / fillExistingBots
// runningOnly). That is why the gate is read even when the container cap
// leaves no slot to create. Fails OPEN, as the helper itself does on an
// unreadable host — the create needs the same SSH and fails loudly on its own.
// Never throws. { slots, blocked, reason }.
async function containerSlots(host, slots) {
  const n = Math.max(0, Number(slots) || 0);
  if (!host) return { slots: n, requested: n, blocked: false, reason: "" };
  try {
    const gate = await require("./hostCapacity").newContainerAllowed(host.id);
    if (gate && gate.ok === false) {
      const known =
        typeof gate.availableMb === "number" &&
        Number.isFinite(gate.availableMb);
      return {
        slots: 0,
        requested: n,
        blocked: true,
        reason:
          "the RAM gate is shut on " +
          (host.label || host.id) +
          (known
            ? " (" +
              gate.availableMb +
              " MB available, minimum " +
              gate.minFreeMb +
              " MB)"
            : gate.reason
              ? " (" + gate.reason + ")"
              : ""),
      };
    }
  } catch {
    /* fail open — see above */
  }
  return { slots: n, requested: n, blocked: false, reason: "" };
}

// The words both engines put on a decision row when the pool or the host is
// what stopped it, so a legacy row and a lane's skip row name the same real
// constraint (the RAM gate on <host> with its MB; the pristine reserve with
// its count). steps/decide.js uses these too.
function poolShortReason(poolReserve, pristineHeld) {
  return (
    "Pool has no spendable accounts (reserve floor " +
    poolReserve +
    " protects manual work" +
    (pristineHeld > 0
      ? "; the pristine reserve is holding " +
        pristineHeld +
        " account(s) for rent-farm orders"
      : "") +
    ") — will retry when the pool refills."
  );
}

function capacityShortReason(af, host, containers) {
  const label = host ? host.label || host.id : "?";
  if (containers && containers.blocked && containers.requested >= 1) {
    return (
      "No new bot container: " +
      containers.reason +
      ", and no running bot has a free seat — queued; retries when memory " +
      "frees up or a seat opens."
    );
  }
  return (
    "All " +
    af.maxAutoBots +
    " auto-bot slots on " +
    label +
    " are busy and no running bot has a free seat" +
    (containers && containers.blocked
      ? " (and " + containers.reason + ", so no parked bot is restarted)"
      : "") +
    " — queued; retries when a campaign ends and frees capacity."
  );
}

// Containers on `host` that are running right now, as a Set of names: from the
// tick's host snapshot when it covers the host (it is kept current as the tick
// starts containers), else one `docker ps`. null when the state cannot be
// read — callers then treat every container as stopped.
const isRunningState = (s) => !!s && String(s.state || "").toLowerCase() === "running";
async function runningContainers(host, ctx) {
  try {
    const row = ctx && ctx.hostState ? ctx.hostState.byHost.get(host.id) : null;
    const ps = row && row.ok && row.docker ? row.docker : await hosts.dockerPs(host);
    return new Set(Object.keys(ps || {}).filter((name) => isRunningState(ps[name])));
  } catch {
    return null;
  }
}

// Logins that must NEVER go back into the pool, out of the given list.
//
// Both recycle paths used to ask only `BotAccount.soldAt != null`. That is the
// wrong signal: since the per-game reservation work (utils/dropReservation.js)
// a sale commits the sold set's DROPS, not the account — an "everything"
// account is sold once per game and BotAccount.sold* is only kept as a shadow
// that "no longer gates stock". So an account delivered to a real buyer can
// carry soldAt: null and passed the old guard straight back into the pool,
// where it would be redeployed to farm again on credentials the BUYER now
// holds (they can change the password, and anything it farms next is in their
// hands). Verified on prod 2026-07-26: of 50 accounts in fulfilled orders only
// 25 had BotAccount.soldAt set, so the old guard saw half of them as unsold.
//
// The drop-level signals are the same ones dropReservation.AVAILABLE_DROP uses
// to decide sellability: `connected` (redeemed) or `soldAt` (reserved/sold).
// This can only ever recycle FEWER accounts than before, never more.
async function unrecyclableLogins(logins) {
  const lower = logins.map((u) => String(u).toLowerCase()).filter(Boolean);
  if (!lower.length) return new Set();
  const BotAccount = require("../models/BotAccount");
  const DropLog = require("../models/DropLog");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const RenterAccount = require("../models/RenterAccount");
  const [soldRows, dropSold, dropConnected, listedRows, leasedRows] =
    await Promise.all([
      BotAccount.find(
        { login: { $in: logins }, soldAt: { $ne: null } },
        { login: 1 },
      )
        .lean()
        .catch(() => []),
      DropLog.distinct("login", {
        login: { $in: logins },
        soldAt: { $ne: null },
      }).catch(() => []),
      DropLog.distinct("login", {
        login: { $in: logins },
        connected: true,
      }).catch(() => []),
      // Accounts attached to a live listing are promised stock a buyer can
      // purchase at any moment. Back in the pool they would be re-claimed and
      // redeployed while on sale — a bot logged in and rewriting the config of
      // an account mid-handover to a buyer.
      MarketplaceListing.find(
        { status: "active", accountLogin: { $ne: "" } },
        { accountLogin: 1 },
      )
        .lean()
        .catch(() => []),
      // An account RENTED OUT to a renter is invisible to every check above
      // by construction: the renting recipe clears its BotAccount placement
      // and disables it (guard 2) and pulls it from every AutoFarmTask
      // (guard 4), so nothing here would spare it — and recycling one hands a
      // LEASED account back to the sellable pool while the renter is still
      // paying for it. Found 2026-09-20: four of renter bulkfarm2's accounts
      // had been recycled mid-lease, two then listed for sale. Erring towards
      // "leave it claimed" is the rule this function already follows.
      RenterAccount.find(
        { login: { $in: logins }, enabled: true, farmEndedAt: null },
        { login: 1 },
      )
        .lean()
        .catch(() => []),
    ]);
  const out = new Set();
  for (const r of soldRows) out.add(String(r.login || "").toLowerCase());
  for (const l of dropSold) out.add(String(l || "").toLowerCase());
  for (const l of dropConnected) out.add(String(l || "").toLowerCase());
  for (const r of leasedRows) out.add(String(r.login || "").toLowerCase());
  const wanted = new Set(lower);
  for (const r of listedRows) {
    for (const l of String(r.accountLogin || "").split(/[,\s]+/)) {
      const n = l.trim().toLowerCase();
      if (n && wanted.has(n)) out.add(n);
    }
  }
  out.delete("");
  return out;
}

// Opt-in inverse of unrecyclableLogins: recycle FULLY SOLD-OUT accounts back
// into farming. Only for accounts we can prove are safe to reuse — spent (no
// sellable drops left), every bought drop connected (buyer redeemed it), past
// the cooldown, off any live listing/bot — AND still ours, verified with a
// FRESH rescan here (a buyer who changed the password fails the rescan and is
// flagged, never recycled). Gated OFF unless af.recycleSoldAccounts.
const RECYCLE_BATCH = 20; // cap live rescans per tick

async function recycleSoldOutAccounts(af, progress) {
  if (!af || af.recycleSoldAccounts !== true) return 0;
  const BotAccount = require("../models/BotAccount");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const scanner = require("./dropScanner");
  const { recycleEligibility } = require("./recycleEligibility");
  const cooldownDays = Number(af.recycleCooldownDays) || 14;

  // Sold accounts sit claimed in the pool with a non-rental, non-recycled note.
  const claimed = await AvailableAccount.find(
    { status: "claimed" },
    { username: 1, usernameLower: 1, claimedNote: 1 },
  ).lean();
  const cand = claimed.filter(
    (a) =>
      !/^rented to/i.test(a.claimedNote || "") &&
      !/^recycled/i.test(a.claimedNote || ""),
  );
  if (!cand.length) return 0;
  const names = cand.map((a) => a.username).filter(Boolean);

  // Drop-state per login (available / connected / sold-but-unconnected + newest sale).
  const dropRows = await DropLog.aggregate([
    { $match: { login: { $in: names } } },
    {
      $group: {
        _id: { $toLower: "$login" },
        available: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$connected", true] },
                  { $eq: [{ $ifNull: ["$soldAt", null] }, null] },
                ],
              },
              1,
              0,
            ],
          },
        },
        connected: { $sum: { $cond: [{ $eq: ["$connected", true] }, 1, 0] } },
        soldUnconnected: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $ifNull: ["$soldAt", null] }, null] },
                  { $ne: ["$connected", true] },
                ],
              },
              1,
              0,
            ],
          },
        },
        newestSold: { $max: "$soldAt" },
        games: { $addToSet: "$game" },
      },
    },
  ]);
  const dropBy = new Map();
  for (const d of dropRows) dropBy.set(d._id, d);

  // Logins on a live listing (never recycle mid-sale).
  const listed = new Set();
  for (const l of await MarketplaceListing.find(
    { status: "active", accountLogin: { $ne: "" } },
    { accountLogin: 1 },
  ).lean()) {
    for (const p of String(l.accountLogin || "").split(/[,\s]+/)) {
      const v = p.trim().toLowerCase();
      if (v) listed.add(v);
    }
  }

  // BotAccount state: deployed? and the id we rescan through.
  const bots = await BotAccount.find(
    { login: { $in: names } },
    { _id: 1, login: 1, configFile: 1 },
  ).lean();
  const botBy = new Map();
  for (const b of bots) botBy.set(String(b.login || "").toLowerCase(), b);

  const eligible = [];
  for (const a of cand) {
    const key = a.usernameLower;
    const d = dropBy.get(key) || {};
    const bot = botBy.get(key);
    const facts = {
      claimedNote: a.claimedNote,
      availableDrops: d.available || 0,
      connectedDrops: d.connected || 0,
      soldUnconnectedDrops: d.soldUnconnected || 0,
      onActiveListing: listed.has(key),
      enabledInLiveTask: !!(bot && bot.configFile),
      newestDeliveredAt: d.newestSold || null,
      cooldownDays,
    };
    if (!recycleEligibility(facts).eligible) continue;
    if (!bot) continue; // no BotAccount to rescan — can't verify the token
    const game =
      (d.games || []).map((g) => String(g || "").trim()).filter(Boolean)[0] ||
      "";
    eligible.push({ pool: a, botId: bot._id, game });
    if (eligible.length >= RECYCLE_BATCH) break;
  }
  if (!eligible.length) return 0;

  let recycled = 0;
  let reclaimed = 0;
  for (const e of eligible) {
    try {
      await scanner.scanAccountNow(e.botId);
    } catch {
      /* a failed scan is treated as "not ok" below */
    }
    const fresh = await BotAccount.findById(e.botId, {
      lastScanStatus: 1,
    }).lean();
    if (fresh && fresh.lastScanStatus === "ok") {
      // Still ours → back to the pool. The claimedNote matches the preferGame
      // affinity regex so it re-farms the same game preferentially.
      const result = await AvailableAccount.updateOne(
        { _id: e.pool._id, status: "claimed" },
        {
          $set: {
            status: "available",
            claimedAt: null,
            claimedNote: e.game
              ? "recycled after " + e.game
              : "recycled after sale",
          },
        },
      );
      if (result.modifiedCount || result.nModified) {
        await recordPoolUsage(e.pool._id, {
          event: "recycled",
          actor: "auto-farm",
          game: e.game || "",
          note: e.game ? "recycled after " + e.game : "recycled after sale",
        });
        await recordAutoFarmEvent({
          type: "recycled",
          game: e.game || "",
          count: 1,
          reason: e.game ? "recycled after " + e.game : "recycled after sale",
          actor: "recycleSoldOutAccounts",
        });
        recycled++;
      }
    } else {
      // Buyer changed the password (or token died) — never redeploy it.
      const result = await AvailableAccount.updateOne(
        { _id: e.pool._id },
        { $set: { claimedNote: "sold — token reclaimed by buyer" } },
      );
      if (result.modifiedCount || result.nModified) {
        await recordPoolUsage(e.pool._id, {
          event: "sold",
          actor: "auto-farm",
          note: "sold — token reclaimed by buyer",
        });
        reclaimed++;
      }
    }
  }
  if (recycled || reclaimed) {
    progress(
      "Recycle: " +
        recycled +
        " sold-out account(s) returned to the pool" +
        (reclaimed
          ? "; " + reclaimed + " skipped (token reclaimed by buyer)"
          : "") +
        ".",
    );
    try {
      await sendTelegram(
        "♻️ Auto-farm recycle — " +
          recycled +
          " sold-out account(s) back to farming" +
          (reclaimed ? ", " + reclaimed + " dead (buyer reclaimed)" : "") +
          ".",
      );
    } catch {
      /* telegram best-effort */
    }
  }
  return recycled;
}

function uniqueTaskBots(rows, hostId) {
  const seen = new Set();
  const out = [];
  for (const task of rows || []) {
    for (const bot of task.bots || []) {
      if (hostId && bot.host !== hostId) continue;
      const key = bot.host + "|" + bot.container;
      if (!bot.host || !bot.container || seen.has(key)) continue;
      seen.add(key);
      out.push(bot);
    }
  }
  return out;
}

// One batched, post-wake/park view of every auto-owned config. This replaces
// the per-campaign exists/readFile loops. If a host snapshot fails, callers
// fall back to the old conservative live reads rather than trusting partial
// data and creating replacement bots from an incomplete view.
async function buildDecisionHostState(taskRows, af, farmHost, opts = {}) {
  const started = Date.now();
  const grouped = new Map();
  for (const task of taskRows || []) {
    for (const bot of task.bots || []) {
      if (!bot.host || !bot.file) continue;
      if (!grouped.has(bot.host)) grouped.set(bot.host, new Set());
      grouped.get(bot.host).add(bot.file);
    }
  }
  const hostRows = await mapWithConcurrency(
    [...grouped.entries()],
    DECISION_READ_CONCURRENCY,
    async ([hostId, fileSet]) => {
      const host = hosts.resolveHost(hostId);
      if (!host) return [hostId, { ok: false, error: "unknown host" }];
      if ((opts.skipHosts || new Set()).has(hostId)) {
        return [hostId, { ok: false, error: "host already known offline" }];
      }
      let calls = 0;
      try {
        calls++;
        const docker = await hosts.dockerPs(host);
        calls++;
        const raw = await hosts.readFiles(host, [...fileSet]);
        const configs = new Map();
        const files = new Set();
        const missing = new Set();
        for (const file of fileSet) {
          const entry = raw[file];
          if (!entry || !entry.ok) {
            if (entry && /not found/i.test(entry.error || ""))
              missing.add(file);
            continue;
          }
          files.add(file);
          try {
            configs.set(file, JSON.parse(entry.text));
          } catch {
            /* existence remains known; malformed configs offer no seats */
          }
        }
        return [hostId, { ok: true, docker, files, missing, configs, calls }];
      } catch (error) {
        return [
          hostId,
          {
            ok: false,
            calls,
            error: error.message || String(error),
          },
        ];
      }
    },
  );
  const byHost = new Map(hostRows);
  const activeTasks = (taskRows || []).filter(
    (task) => task.status === "active",
  );
  const activeBots = uniqueTaskBots(activeTasks);
  const farmRow = farmHost && byHost.get(farmHost.id);
  let freeSeats = 0;
  if (farmRow && farmRow.ok && af.consolidate !== false) {
    for (const bot of uniqueTaskBots(activeTasks, farmHost.id)) {
      const data = farmRow.configs.get(bot.file);
      if (!data) continue;
      freeSeats += Math.max(0, af.accountsPerBot - botFactory.usedSeats(data));
    }
  }
  const seatCounter = createSeatCounter({
    maxAutoBots: af.maxAutoBots,
    accountsPerBot: af.accountsPerBot,
    activeContainers: activeBots.length,
    freeSeats,
  });
  const activeBotKeys = new Set(
    activeBots.map((bot) => bot.host + "|" + bot.container),
  );
  return {
    byHost,
    activeBots,
    seatCounter,
    elapsedMs: Date.now() - started,
    hostCalls: hostRows.reduce((n, [, row]) => n + (row.calls || 0), 0),
    fileCount: [...grouped.values()].reduce((n, files) => n + files.size, 0),
    hasFile(hostId, file, container) {
      const row = byHost.get(hostId);
      if (!row || !row.ok) return null;
      if (row.missing.has(file)) return false;
      if (!row.files.has(file)) return null;
      return container
        ? Object.prototype.hasOwnProperty.call(row.docker, container)
        : true;
    },
    config(hostId, file) {
      const row = byHost.get(hostId);
      return row && row.ok ? row.configs.get(file) || null : null;
    },
    setConfig(hostId, file, data) {
      if (!data) return;
      let row = byHost.get(hostId);
      if (!row || !row.ok) {
        row = {
          ok: true,
          docker: {},
          files: new Set(),
          missing: new Set(),
          configs: new Map(),
          calls: row ? row.calls || 0 : 0,
        };
        byHost.set(hostId, row);
      }
      row.files.add(file);
      row.missing.delete(file);
      row.configs.set(file, data);
    },
    activateBot(bot, data) {
      if (!bot || !bot.host || !bot.container) return false;
      if (data && bot.file) this.setConfig(bot.host, bot.file, data);
      const key = bot.host + "|" + bot.container;
      if (activeBotKeys.has(key)) return false;
      activeBotKeys.add(key);
      activeBots.push(bot);
      const row = byHost.get(bot.host);
      if (row && row.ok) {
        row.docker[bot.container] = { state: "running", status: "started" };
      }
      const config =
        data || (bot.file ? this.config(bot.host, bot.file) : null);
      const seatsFree = config
        ? Math.max(0, af.accountsPerBot - botFactory.usedSeats(config))
        : 0;
      seatCounter.addContainer(1, seatsFree);
      return true;
    },
  };
}

// Free seats inside containers that active auto-farm tasks already run on
// this host. A "seat" is one enabled TwitchUsers slot out of accountsPerBot.
// Unreadable configs count as zero free seats (never over-promise capacity).
//
// `runningOnly` (the RAM gate is shut, containerSlots().blocked): count seats
// in RUNNING containers only. A parked container's seats are not free while
// memory is short — filling one restarts it (fillExistingBots). Unknown
// container state counts as stopped.
async function autoSeatCapacity(host, af, ctx, { runningOnly = false } = {}) {
  if (!host || af.consolidate === false) return 0;
  let running = null;
  if (runningOnly) {
    running = await runningContainers(host, ctx);
    if (!running) return 0;
  }
  if (ctx && ctx.hostState) {
    const row = ctx.hostState.byHost.get(host.id);
    if (row && row.ok) {
      if (!running) return ctx.hostState.seatCounter.freeSeats();
      let free = 0;
      for (const b of ctx.hostState.activeBots) {
        if (b.host !== host.id || !running.has(b.container)) continue;
        const data = ctx.hostState.config(host.id, b.file);
        if (data) free += Math.max(0, af.accountsPerBot - botFactory.usedSeats(data));
      }
      // Never more than the tick's own seat ledger allows (it also tracks
      // seats this tick has already filled).
      return Math.min(free, ctx.hostState.seatCounter.freeSeats());
    }
  }
  const rows = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const seen = new Set();
  let free = 0;
  for (const t of rows) {
    for (const b of t.bots || []) {
      if (b.host !== host.id) continue;
      if (running && !running.has(b.container)) continue;
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
async function fillExistingBots(
  host,
  claimed,
  game,
  af,
  ctx,
  { runningOnly = false } = {},
) {
  const placed = [];
  let remaining = claimed.slice();
  if (!remaining.length || af.consolidate === false) {
    return { placed, remaining };
  }
  // RAM gate shut (containerSlots().blocked): pack into RUNNING containers
  // only. Packing into a parked one restarts it below, starting a whole
  // container on a host the gate says is short of memory (2026-10-03).
  let running = null;
  if (runningOnly) {
    running = await runningContainers(host, ctx);
    if (!running) return { placed, remaining };
  }
  const containers =
    ctx && ctx.hostState
      ? ctx.hostState.activeBots.filter((bot) => bot.host === host.id)
      : uniqueTaskBots(
          await AutoFarmTask.find({ status: "active" }, { bots: 1 }).lean(),
          host.id,
        );
  for (const b of containers) {
    if (!remaining.length) break;
    if (running && !running.has(b.container)) continue;
    let freeSeats = 0;
    let present = new Set();
    try {
      const cached =
        ctx && ctx.hostState ? ctx.hostState.config(host.id, b.file) : null;
      const data = cached || JSON.parse(await hosts.readFile(host, b.file));
      freeSeats = Math.max(0, af.accountsPerBot - botFactory.usedSeats(data));
      const users =
        data.TwitchSettings && Array.isArray(data.TwitchSettings.TwitchUsers)
          ? data.TwitchSettings.TwitchUsers
          : [];
      present = new Set(
        users
          .map((u) => String((u && u.ClientSecret) || "").trim())
          .filter(Boolean),
      );
    } catch {
      continue; // retired/renamed config — skip
    }
    // An account ALREADY in this config is merged (the game is unioned into
    // its FavouriteGames), which costs no new seat — so it must be offered to
    // this container even when the container is full. Skipping it on the seat
    // check is what used to push it out to createBot and spawn a duplicate
    // container for an account that was already running here.
    const secretOfAcc = (a) => String((a && a.clientSecret) || "").trim();
    const already = remaining.filter((a) => present.has(secretOfAcc(a)));
    const batch = already.concat(
      remaining.filter((a) => !present.has(secretOfAcc(a))).slice(0, freeSeats),
    );
    if (!batch.length) continue;
    try {
      const r = await botFactory.addAccountsToBot(host, b.file, batch, game);
      const landed = new Set(r.logins || []);
      const taken = batch.filter((a) => landed.has(a.username));
      if (!taken.length) continue;
      remaining = remaining.filter((a) => !taken.includes(a));
      if (ctx && ctx.hostState) {
        ctx.hostState.seatCounter.consumeExisting(r.added);
        if (r.data) ctx.hostState.setConfig(host.id, b.file, r.data);
      }
      if (r.changed) {
        await hosts
          .dockerContainer(host, "restart", b.container)
          .catch(() => {});
        // The container may have been PARKED (stopped with restart-policy "no"
        // by botWaker) when we packed accounts into it. `docker restart` brings
        // it back up but leaves the policy at "no", so a docker daemon restart
        // would silently drop a bot that is now farming again.
        await hosts.restoreRestartPolicy(host, b.container).catch(() => {});
      }
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

// Is this task stuck in a state only a human could get it out of?
//
// Two ways that happens, and BOTH were live on prod (43 tasks, all 76 hours
// old, every one of them for a campaign that was still running):
//
//   * "planned" — in live mode processCampaign records the plan and then
//     executes it, but executeTask throws on a transient shortage (pool below
//     the reserve floor, no free container seat, host hiccup). The throw leaves
//     the row at "planned", and the tick's candidate filter only ever re-decided
//     "skipped" rows, so nothing retried it. It sat there behind the UI's
//     Approve button until the owner noticed. Plans left over from a spell in
//     dry-run mode strand the same way once the switch is flipped to live.
//   * "failed" with no bots — the execution genuinely failed and released its
//     accounts. Nothing owns anything, so re-deciding is free and safe. A
//     failed task that DID create bots is left alone: it holds real state.
//
// Retrying costs nothing when conditions have not changed (the same gates
// simply skip it again) and fixes it the moment they have.
//
// A `planned` row is ALSO what a plan looks like while its executeTask is
// still running: record() / the lane's upsertTask write it just before the
// claim and the bot creation, which take minutes over a slow link. Read as
// stranded in that window, the other engine re-decided it and ran a second
// executeTask on the same row (2026-10-03: legacy planned The Quinfall, a lane
// created a minute later took the plan as stranded). So a plan only counts as
// stranded once nothing has touched it for STRANDED_PLAN_MS. A row with no
// date at all predates both writers and keeps the old answer.
const STRANDED_PLAN_MS = 15 * 60 * 1000;

function isStranded(task, now = Date.now()) {
  if (!task) return false;
  if (task.status === "planned") {
    const at = Math.max(
      task.decidedAt ? new Date(task.decidedAt).getTime() || 0 : 0,
      task.updatedAt ? new Date(task.updatedAt).getTime() || 0 : 0,
    );
    return !at || now - at >= STRANDED_PLAN_MS;
  }
  return task.status === "failed" && !(task.bots || []).length;
}

// Clear out plans whose campaign ended before they were ever executed. Without
// this they pile up in the Auto farm tab wearing an "awaiting approval" chip
// for drops nobody can farm any more — 25 of prod's 43 stranded rows were for
// EXPIRED campaigns. They own nothing (no bots, no claimed accounts), so this
// only rewrites a status.
async function expireStalePlans() {
  const stale = await AutoFarmTask.find(
    { status: { $in: ["planned", "failed"] }, "bots.0": { $exists: false } },
    { campaignId: 1, game: 1, status: 1, reason: 1 },
  ).lean();
  if (!stale.length) return 0;
  const ids = [...new Set(stale.map((t) => t.campaignId))];
  const rows = await TwitchCampaign.find(
    { campaignId: { $in: ids } },
    { campaignId: 1, status: 1, endAt: 1 },
  ).lean();
  const byId = new Map(rows.map((r) => [r.campaignId, r]));
  const dead = [];
  for (const t of stale) {
    const c = byId.get(t.campaignId);
    const ended =
      !c ||
      c.status === "EXPIRED" ||
      (c.endAt && new Date(c.endAt) < new Date());
    if (ended) dead.push(t._id);
  }
  if (!dead.length) return 0;
  await AutoFarmTask.updateMany(
    { _id: { $in: dead } },
    {
      $set: {
        status: "skipped",
        completedAt: new Date(),
        reason:
          "Campaign ended before this plan was executed — nothing was spent " +
          "and there is nothing left to farm. Cleared automatically.",
      },
    },
  );
  const expiredReason =
    "Campaign ended before this plan was executed — nothing was spent and there is nothing left to farm. Cleared automatically.";
  for (const t of stale) {
    if (!dead.some((id) => String(id) === String(t._id))) continue;
    await recordAutoFarmEvent({
      type: "plan_expired",
      game: t.game,
      campaignId: t.campaignId,
      taskId: t._id,
      count: 1,
      reason: expiredReason,
      actor: "expireStalePlans",
    });
  }
  return dead.length;
}

// The most recent task for this game that owns bots we can restart —
// weekly campaigns reuse infrastructure instead of burning new accounts.
// THE SOURCE MUST HOLD ACCOUNTS, not just bots.
//
// This picked the newest task that owns bots, full stop. That makes an empty
// reuse row a permanent trap: a task written with bots and `assignedAccounts:
// []` becomes the next campaign's reuse source, that campaign inherits zero,
// writes another empty row with the same bots, and the chain never recovers.
//
// Measured on prod 2026-09-08. Albion Online ran at 60 accounts through
// 2026-08-31, dropped to 8 and then 0 on 09-01, and every one of the 15 tasks
// since inherited 0 — while three containers went on farming it (450 drops
// across 288 accounts in the last week alone). None of it could be listed,
// because a task with no assigned accounts can never produce a listing
// (utils/autoLister.js verifiedHoldersForItems returns [] on an empty set). The
// same trap had caught Halo Infinite (3 tasks), Rainbow Six (2) and EVE (1).
//
// Requiring the source to hold at least one account both stops the chain
// forming and HEALS one already formed: the query simply skips the empty rows
// and finds the last good one, whose accounts are still on those same warm
// bots. Everything downstream re-verifies (holdings against DropLog, exclusion
// of logins already on another live listing), so reaching further back can
// surface a stale account but never sell one twice.
async function reusableTaskForGame(game) {
  return AutoFarmTask.findOne({
    game,
    "bots.0": { $exists: true },
    "assignedAccounts.0": { $exists: true },
    status: { $in: ["active", "completed", "stopped"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

function tg(text) {
  return sendTelegram(text).catch(() => {});
}

// Is the farm host reachable? Retried, because ONE failed probe costs a whole
// tick: hostOnline is latched at the top of the run and every campaign decided
// under it is recorded as skip_host_offline.
//
// Seen live on 2026-07-29: the probe failed at 10:33, yet the very next sweep
// SSH'd into the same Pi and parked six of its containers a minute later — the
// link had simply flapped. That single false negative rewrote ~30 campaigns as
// "farm host unreachable" and spent the cycle doing nothing. Twelve consecutive
// hand-run probes straight afterwards all succeeded, so the flap is brief and a
// couple of seconds of patience is all it takes to ride it out.
const HOST_PROBE_ATTEMPTS = 3;
const HOST_PROBE_DELAY_MS = 3000;

async function probeHost(host, log) {
  for (let i = 1; i <= HOST_PROBE_ATTEMPTS; i++) {
    try {
      await hosts.readdir(host);
      if (i > 1 && typeof log === "function") {
        log(
          "Farm host answered on attempt " +
            i +
            " — the first probe was a flap.",
        );
      }
      return true;
    } catch (e) {
      if (i === HOST_PROBE_ATTEMPTS) {
        if (typeof log === "function") {
          log(
            "Farm host unreachable after " +
              HOST_PROBE_ATTEMPTS +
              " attempts: " +
              (e.message || e),
            "warn",
          );
        }
        return false;
      }
      await new Promise((r) => setTimeout(r, HOST_PROBE_DELAY_MS));
    }
  }
  return false;
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
    // Any recorded decision satisfies a pending rescan request.
    rescanRequested: false,
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

  // The inputs the sellability gate saw, snapshotted once `alloc` is known
  // (below) and written by EVERY record() call on every path — including the
  // ones that never wrote internalSales. The lane engine's replay reads it
  // instead of reconstructing (utils/decisionInputs.js).
  let recordedInputs = null;
  async function record(fields) {
    // upsert keeps the unique (game, campaignId) index happy on retries
    return AutoFarmTask.findOneAndUpdate(
      { game, campaignId: c.campaignId },
      {
        $set: {
          ...base,
          ...fields,
          ...(recordedInputs ? { decisionInputs: recordedInputs } : {}),
          decidedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  }

  // 1) Sellability gate — fresh market data (Gameflip/GGSel/Plati, re-scanned
  // when stale) blended with our own sales history (SaleSignal training data).
  const info = (ctx.infoMap && ctx.infoMap.get(key)) || {
    research: await freshResearchForGame(game),
    sales: await internalSalesForGame(game),
  };
  const research = info.research;
  const sales = salesOf(info.sales);
  // The task log records the plain count, which is what the AutoFarmTask
  // schema has always stored and what every alert reads.
  const internalSales = sales.count;
  // Cold-start probing budget + per-game cooldown (both inert unless
  // af.probeColdStart). The global budget caps how many DIFFERENT games probe
  // at once — a runaway guard for a calendar full of new releases. The cooldown
  // keeps a game the stop-loss already gave up on from being re-probed for a
  // while. A game already probing is never blocked by its own budget slot (the
  // count excludes it), so an in-flight probe is never re-skipped mid-run.
  let probeAllowed = true;
  // Blocked purely by the concurrency budget (retryable) vs. by the
  // post-failure cooldown (terminal for the cooldown window).
  let probeBudgetBlocked = false;
  if (af.probeColdStart) {
    const cooldownCut = new Date(
      Date.now() - Math.max(0, Number(af.probeCooldownDays) || 0) * 86400000,
    );
    const recentlyFailed = await AutoFarmTask.exists({
      game,
      probeOutcome: "expired",
      completedAt: { $gte: cooldownCut },
    });
    const otherProbes = await AutoFarmTask.countDocuments({
      decision: "probe",
      status: { $in: ["active", "planned"] },
      game: { $ne: game },
    });
    const underBudget = otherProbes < (Number(af.probeMaxGames) || 0);
    probeAllowed = !recentlyFailed && underBudget;
    probeBudgetBlocked = !recentlyFailed && !underBudget;
  }
  const alloc = demandAllocation(research, af, sales, { probeAllowed, game });
  recordedInputs = buildDecisionInputs({
    research,
    sales,
    af,
    probeAllowed,
    probeBudgetBlocked,
    floor: alloc.probe ? 0 : marketStockFloor(af),
  });
  if (alloc.skip) {
    // A cold-start candidate held off by the BUDGET is queued, not rejected —
    // record a RETRYABLE decision so it flows into a probe slot the moment one
    // frees (a probe graduates or the stop-loss expires one). Cooldown holds and
    // genuine low demand stay terminal. Never claim "items don't sell" about a
    // game we simply chose not to probe yet.
    const budgetHold = alloc.probeBlocked && probeBudgetBlocked;
    const decision = budgetHold ? "skip_probe_budget" : "skip_low_demand";
    const reason = alloc.probeBlocked
      ? budgetHold
        ? "Untested market — " +
          (Number(af.probeMaxGames) || 0) +
          " probes already running (budget full); queued, retries when a slot frees."
        : "Untested market, but within the post-failure cooldown — no accounts spent."
      : "Effective demand " +
        alloc.demand +
        " (market research + " +
        internalSales +
        " own recent sales) — items for this game don't sell; not worth pool accounts.";
    await record({
      decision,
      status: "skipped",
      reason,
      demandScore: alloc.demand,
      hadResearch: !!research,
      internalSales,
    });
    // A budget hold re-decides every tick, so telegraphing it would spam. Only
    // announce the terminal verdicts.
    if (!budgetHold) {
      await tg(
        "🤖 Auto-farm SKIP — " +
          game +
          "\n" +
          (alloc.probeBlocked
            ? "Untested market — probing held off (cooldown). No accounts spent."
            : "Effective demand " +
              alloc.demand +
              " (items not salable). No accounts spent."),
      );
    }
    return { decision };
  }
  const demandScore = research ? Number(research.demandScore || 0) : null;

  // 2) Time window. Computed here, but the ends-soon SKIP is DEFERRED to step 4b
  // (after the reuse-first block). A short campaign can still be farmed by
  // RESTARTING already-warm bots — they carry accumulated watch-time and finish
  // a drop that fresh accounts never could in a few hours — so the 12h floor must
  // gate only the FRESH-account path, not reuse. Forced games (af.forceGames)
  // bypass it entirely, at step 4b.
  const hrs = hoursLeft(c.endAt);

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
      internalSales,
    });
    return { decision: "skip_host_offline" };
  }

  // 4) Reuse-first: weekly campaigns restart the game's existing auto-bot.
  let reusable = ctx.reusableMap
    ? ctx.reusableMap.get(game) || null
    : await reusableTaskForGame(game);
  if (reusable) {
    // Retired bots (deleted container, config renamed .done-*) can't be
    // restarted — drop them; if none survive, fall through to a fresh plan
    // (which prefers packing into running bots anyway).
    const live = [];
    for (const b of reusable.bots || []) {
      const h = hosts.resolveHost(b.host);
      if (!h) continue;
      try {
        const cached =
          ctx.hostState && ctx.hostState.hasFile(b.host, b.file, b.container);
        if (
          cached === true ||
          (cached == null && (await hosts.exists(h, b.file)))
        )
          live.push(b);
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
      // The reuse inputs, beside the sellability snapshot (utils/
      // decisionInputs.js). Dry-run computes no spoken-for set, so `free` is
      // recorded as null — not recorded, rather than 0.
      if (recordedInputs) {
        recordedInputs = withReuseInputs(
          recordedInputs,
          buildReuseInputs({
            sourceTaskId: reusable._id,
            sourceHeld: (reusable.assignedAccounts || []).length,
            free: null,
            competitors: null,
            dryRun: true,
          }),
        );
      }
      await record({
        decision: "reuse_existing",
        status: "planned",
        reason,
        demandScore,
        hadResearch: !!research,
        internalSales,
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
        if (ctx.hostState) ctx.hostState.activateBot(b);
      } catch (e) {
        failed.push(b.container + ": " + e.message);
      }
    }
    // Only accounts no OTHER live task already counts. assignedAccounts is what
    // autoLister derives listing qty from (utils/autoLister.js), so copying the
    // reused task's list wholesale made two campaigns each advertise the same
    // accounts — stock that cannot be delivered twice, because
    // pickDeliveryAccounts hands out any given login on one listing only. The
    // buyer pays and there is nothing to fulfil. The bots really are shared;
    // the sellable stock is not.
    const spokenFor = new Set();
    // Which live tasks hold any of the reused task's accounts — recorded
    // beside the count so the lane engine's comparison can tell a rule
    // difference from a world that moved (utils/decisionInputs.js).
    const reuseHeld = new Set(
      (reusable.assignedAccounts || []).map((u) => String(u).toLowerCase()),
    );
    const reuseCompetitors = [];
    for (const other of await AutoFarmTask.find(
      { status: { $in: ["active", "planned"] }, _id: { $ne: reusable._id } },
      { assignedAccounts: 1 },
    ).lean()) {
      let overlaps = false;
      for (const u of other.assignedAccounts || []) {
        spokenFor.add(String(u).toLowerCase());
        if (reuseHeld.has(String(u).toLowerCase())) overlaps = true;
      }
      if (overlaps) reuseCompetitors.push(other._id);
    }
    const mine = (reusable.assignedAccounts || []).filter(
      (u) => !spokenFor.has(String(u).toLowerCase()),
    );
    // Give the reused accounts this game back (completeEndedTasks took it off
    // and disabled the ones left with none — see utils/reuseRearm), then
    // restart the bots whose config changed: `docker start` above is a no-op on
    // a running container and a bot reads its config only at startup.
    if (started.length && mine.length) {
      const rearm = await require("./reuseRearm").rearmReusedAccounts({
        bots,
        logins: mine,
        game,
      });
      if (rearm.error) progress("Reuse re-arm skipped: " + rearm.error, "warn");
      for (const cb of rearm.changedBots || []) {
        await hosts
          .dockerContainer(hosts.resolveHost(cb.host), "restart", cb.container)
          .catch((e) => progress("Restart " + cb.container + " failed: " + e.message, "warn"));
      }
      if (rearm.rearmed) {
        progress("Re-armed " + rearm.rearmed + " reused account(s) for " + game + ".");
      }
    }
    if (recordedInputs) {
      recordedInputs = withReuseInputs(
        recordedInputs,
        buildReuseInputs({
          sourceTaskId: reusable._id,
          sourceHeld: (reusable.assignedAccounts || []).length,
          free: mine.length,
          competitors: reuseCompetitors,
          dryRun: false,
        }),
      );
    }
    const reuseTask = await record({
      decision: "reuse_existing",
      status: started.length ? "active" : "failed",
      reason,
      demandScore,
      hadResearch: !!research,
      internalSales,
      bots: bots.map((b) => ({ ...b, reused: true, shared: true })),
      assignedAccounts: mine,
      plannedAccounts: mine.length,
      error: failed.join("; "),
      executedAt: new Date(),
    });
    if (started.length) {
      await recordAutoFarmEvent({
        type: "task_started",
        game,
        campaignId: c.campaignId,
        taskId: reuseTask._id,
        host: host && host.id,
        count: mine.length,
        reason,
        actor: "processCampaign",
      });
    } else if (failed.length) {
      await recordAutoFarmEvent({
        type: "task_failed",
        game,
        campaignId: c.campaignId,
        taskId: reuseTask._id,
        host: host && host.id,
        count: failed.length,
        reason: failed.join("; "),
        actor: "processCampaign",
      });
    }
    // Top-up: the reused accounts stack this game's drops event over event and
    // sell as the stacked bundle — but demand above what they freely cover is
    // worth FRESH pool accounts too, which farm only this event and sell it
    // solo. Best-effort: a pool/capacity shortage leaves the reuse standing.
    let toppedUp = 0;
    const topUp = Math.min(
      Math.max(0, (Number(alloc.target) || 0) - mine.length),
      budgetMap.get(key) || 0,
    );
    // Fresh top-up accounts start from zero watch-time, so on a short campaign
    // (below the 12h floor) they can't finish the drop — topping up there would
    // waste pool accounts on a window they can't complete. Reuse alone still
    // farms the event. Forced games keep their existing top-up behaviour.
    const topUpAllowed = hrs >= af.minHoursLeft || isForcedGame(game, af);
    if (
      started.length &&
      Number.isFinite(topUp) &&
      topUp >= 1 &&
      topUpAllowed
    ) {
      try {
        reuseTask.plannedAccounts = topUp;
        const r = await executeTask(reuseTask, ctx, { append: true });
        toppedUp = (r && r.accounts) || 0;
      } catch {
        /* reuse alone stands; fresh accounts can join on a later campaign */
      }
    }
    await tg(
      "🤖 Auto-farm REUSE — " +
        game +
        "\nRestarted " +
        started.join(", ") +
        (failed.length ? "\nFailed: " + failed.join("; ") : "") +
        (toppedUp
          ? "\nTopped up with " + toppedUp + " fresh account(s) for solo stock."
          : "") +
        "\nCampaign: " +
        (c.name || c.campaignId),
    );
    return { decision: "reuse_existing" };
  }

  // 4b) Time gate — FRESH-account path only. Reuse already returned above, so
  // reaching here means the only way to farm this campaign is to spend FRESH
  // pool accounts, which cannot finish a drop that ends in a few hours. A short
  // campaign for a game with no warm bots to reuse stops here rather than burning
  // accounts on a window it can't complete. Forced games bypass (their campaigns
  // are deliberately short and farmed by design).
  if (hrs < af.minHoursLeft && !isForcedGame(game, af)) {
    await record({
      decision: "skip_ends_soon",
      status: "skipped",
      reason:
        "Campaign ends in " +
        Math.max(0, Math.round(hrs)) +
        "h (< " +
        af.minHoursLeft +
        "h) and no warm bots to reuse — too late to farm with fresh accounts.",
      demandScore,
      hadResearch: !!research,
      internalSales,
    });
    return { decision: "skip_ends_soon" };
  }

  // 5) Coverage gate: how much of this game's demand is ALREADY covered by
  // manual bots farming it right now and by unsold archive accounts holding
  // this campaign's items? Only the uncovered remainder is worth new accounts.
  const farmMap = ctx.farmMap || { map: new Map(), wildcard: new Set() };
  const gameKey = game.toLowerCase();
  const gameSpecificFarmers = farmMap.map.get(gameKey)
    ? farmMap.map.get(gameKey).size
    : 0;
  // Wildcard accounts (no per-account FavouriteGames, so they farm whatever the
  // config lists) were counted IN FULL against every game at once. With ~1615 of
  // them on prod and `wanted` capped at maxPerGame (30), covered always exceeded
  // wanted, so uncovered was 0 for every campaign, forever — a silent 100% block
  // on all new farming. One account cannot deliver 127 campaigns of drops
  // simultaneously, so crediting it to all of them is simply wrong.
  //
  // Capped at a constant rather than divided by the live campaign count: a
  // moving denominator inverts under load (floor(1615/N) > 30 whenever N <= 53,
  // i.e. it silently reverts to a total block whenever the calendar is quiet)
  // and risks a NaN, which would bypass BOTH spend gates. Starts at 0 because
  // archiveHoldersForCampaign now supplies real inventory-based coverage.
  const wildcardCredit = Math.min(farmMap.wildcard.size, WILDCARD_CREDIT_CAP);
  const manualFarmers = gameSpecificFarmers + wildcardCredit;
  const arch =
    (ctx.archiveHolders && ctx.archiveHolders.get(gameKey)) ||
    (ctx.archiveHolders
      ? { holders: 0, stashed: 0, other: 0 }
      : await archiveHoldersForCampaign(c, farmMap.logins, ctx.owned));
  const archiveHolders = arch.holders || 0;
  const stashHolders = arch.stashed || 0;
  const otherHolders = arch.other || 0;
  // Fail closed: a NaN here would make every comparison below false and slip
  // past both the coverage gate and the pool/fair-share gate, persisting
  // plannedAccounts: NaN straight through Mongoose.
  //
  // manualFarmers is measured and recorded but NOT added: the manual fleet is
  // the long-term stash, not stock for this campaign. archiveHolders already
  // has the stash subtracted out, so what remains is genuinely sellable.
  const coveredRaw = COUNT_MANUAL_AS_COVERAGE
    ? manualFarmers + archiveHolders
    : archiveHolders;
  const covered = Number.isFinite(coveredRaw) ? coveredRaw : 0;
  // Non-probe campaigns must at least fill every enabled market's shelf.
  const floor = alloc.probe ? 0 : marketStockFloor(af);
  const wanted = Math.min(
    Math.max(alloc.target, floor),
    alloc.cap || af.maxPerGame,
  );
  const uncovered = Math.max(0, wanted - covered);
  if (uncovered < 1) {
    await record({
      decision: "skip_already_covered",
      status: "skipped",
      reason:
        "Demand target of " +
        wanted +
        " accounts is already covered by " +
        archiveHolders +
        " unsold account(s) of its OWN holding this game's items. " +
        "No new accounts needed. Not counted, because auto-listings cannot " +
        "deliver them: " +
        manualFarmers +
        " manual-bot account(s) farming this game, " +
        stashHolders +
        " holder(s) parked on manual bots, " +
        otherHolders +
        " holder(s) in the archive that belong to no auto task.",
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders, stashHolders, otherHolders },
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
          archiveHolders +
          " of its own unsold accounts ≥ target " +
          wanted +
          "." +
          (manualFarmers || stashHolders || otherHolders
            ? "\n(Not counted: " +
              manualFarmers +
              " manual farmer(s), " +
              stashHolders +
              " stashed holder(s), " +
              otherHolders +
              " archive holder(s) it cannot sell.)"
            : ""),
      );
    }
    return { decision: "skip_already_covered" };
  }

  // 6) Allocation: fair-share budget for this tick, capped by the UNCOVERED
  // remainder of the tier target.
  const budget = budgetMap.get(key) || 0;
  const target = Math.min(uncovered, budget);
  // Fail closed alongside the coverage guard: `target < 1` is false for NaN, so
  // without this a non-finite budget would fall straight through to claiming.
  if (!Number.isFinite(target) || target < 1) {
    await record({
      decision: "skip_no_accounts",
      status: "skipped",
      reason: poolShortReason(af.poolReserve, ctx.pristineProtect),
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders, stashHolders, otherHolders },
      plannedAccounts: 0,
    });
    return { decision: "skip_no_accounts" };
  }

  // 6) Capacity gate: free SEATS, not just container slots — running bots
  // with spare TwitchUsers slots can absorb accounts without new containers.
  // No new container while the farm host is short of RAM (containerSlots),
  // and then no seat in a parked one either (it would have to be restarted).
  const activeBots = await activeAutoBotCount(ctx);
  const containers = await containerSlots(
    host,
    Math.max(0, af.maxAutoBots - activeBots),
  );
  const slotsFree = containers.slots;
  const freeSeats = await autoSeatCapacity(host, af, ctx, {
    runningOnly: containers.blocked,
  }).catch(() => 0);
  const seatCapacity = slotsFree * af.accountsPerBot + freeSeats;
  if (seatCapacity < 1) {
    await record({
      decision: "skip_no_capacity",
      status: "skipped",
      reason: capacityShortReason(af, host, containers),
      demandScore,
      hadResearch: !!research,
      internalSales,
      coverage: { manualFarmers, archiveHolders, stashHolders, otherHolders },
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
        " of its own account" +
        (covered === 1 ? "" : "s") +
        " already covering this game" +
        (manualFarmers || stashHolders || otherHolders
          ? "; not counted: " +
            manualFarmers +
            " manual farmer(s), " +
            stashHolders +
            " stashed, " +
            otherHolders +
            " archive holder(s) it cannot sell"
          : "") +
        ")"
      : "";
  const reason =
    (alloc.probe
      ? (alloc.coldStart
          ? alloc.tierNote +
            " — farming a small probe batch to test the market. "
          : "New game with no sales history — farming a small probe batch to test the market. ")
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
      coverage: { manualFarmers, archiveHolders, stashHolders, otherHolders },
      plannedAccounts: accounts,
      // Same tier target the live path records below. Without it an approved
      // plan enters "active" with targetAccounts: 0, and backfill's
      // `targetAccounts || plannedAccounts || 0` falls through to the flat
      // marketStockFloor — which is why ten active tasks sat at 18 accounts
      // regardless of demand, capping proven sellers whose tier says 30.
      targetAccounts: wanted,
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
    coverage: { manualFarmers, archiveHolders, stashHolders, otherHolders },
    plannedAccounts: accounts,
    targetAccounts: wanted,
  });
  return executeTask(task, ctx);
}

// Execute a planned task for real: claim pool accounts, create bot(s) on the
// farm host, mark active. Used by live-mode ticks AND the one-click
// "approve" button on dry-run plans.
async function executeTask(task, ctx, { append = false } = {}) {
  const af = ctx && ctx.af ? ctx.af : cfg();
  const host = ctx && ctx.host ? ctx.host : resolveFarmHost(af);
  if (!host) throw new Error("No farm host configured");
  const game = task.game;

  // Ceiling is the game's OWN cap, re-read at execution time. plannedAccounts
  // was already capped by capForGame when the plan was made, so this is a
  // re-check, not the policy — but it has to be the SAME ceiling or it silently
  // overrides it: with a per-game cap or coverage sizing raising a game above
  // the flat `maxPerGame * SALES_CAP_MULT_MAX`, that flat product would clip a
  // legitimate plan on its way to the pool.
  const want = Math.min(
    task.plannedAccounts || 0,
    capForGame(af, await internalSalesForGame(game).catch(() => 0), game),
  );
  if (want < 1) throw new Error("Task has no planned accounts");

  // Re-check the reserve floor at execution time (things may have changed
  // since the plan was made). The pristine reserve is a floor too: the claim
  // below cannot take those accounts (farmSpendable).
  const ready = await countReadyPool();
  const protect = await pristineProtect(af);
  const spendable = farmSpendable(ready, af.poolReserve, protect);
  // Re-check CONTAINER capacity here too, not just in processCampaign. The
  // decision gate runs when the plan is made; this runs when it is spent, and
  // in between other campaigns in the same tick (or a stale `planned` task
  // approved by hand days later) can have consumed every slot. Without this
  // term nothing bounded the createBot loop below at all — which is how 31
  // containers came to exist on the Pi under a maxAutoBots of 6.
  // No NEW container while the host is short of RAM (containerSlots), and no
  // seat in a parked one then either.
  const activeBots = await activeAutoBotCount(ctx);
  const containers = await containerSlots(
    host,
    Math.max(0, af.maxAutoBots - activeBots),
  );
  const slotsFree = containers.slots;
  const runningOnly = containers.blocked;
  const freeSeats = await autoSeatCapacity(host, af, ctx, {
    runningOnly,
  }).catch(() => 0);
  const capacity = slotsFree * af.accountsPerBot + freeSeats;
  if (capacity < 1) {
    throw new Error(
      "No capacity on " +
        (host.label || host.id) +
        ": " +
        (containers.blocked && containers.requested >= 1
          ? "no new container (" + containers.reason + ")"
          : "all " + af.maxAutoBots + " auto-bot slots are in use") +
        " and no running bot has a free seat",
    );
  }
  const n = Math.min(want, spendable, capacity);
  if (n < 1) {
    // Throw WITHOUT marking the task failed. Nothing has been claimed yet, so
    // there is no failure to record — the pool was simply empty this minute.
    // Writing "failed" here bricked the plan permanently: "failed" is not in
    // RETRYABLE, and the approve route only accepts "planned", so a single
    // Approve click during a pool shortage put the campaign permanently beyond
    // both the operator and the tick. Left as "planned", it stays approvable
    // and the caller still surfaces the accurate reason below.
    throw new Error(
      "Pool below reserve floor (" +
        ready +
        " ready, reserve " +
        af.poolReserve +
        (protect
          ? "; the pristine reserve is holding " +
            protect +
            " for rent-farm orders"
          : "") +
        ")",
    );
  }

  // Reuse-only games (World of Tanks / UFL) never draw a fresh pool account:
  // they may only reuse accounts already farmed on that same game, so the claim
  // is restricted to the game's own "recycled after <game>" pool entries.
  const reuseOnly = settings.isReuseOnlyGame(game);
  const claimed = await claimPoolAccounts(
    n,
    "auto-farm: " + game + " (" + task.campaignId + ")",
    { preferGame: game, recycledOnly: reuseOnly },
  );
  if (!claimed.length) {
    // Reuse-only game with none of its own recycled accounts free right now:
    // there is nothing to spend and, by design, nothing fresh is allowed. Record
    // a clean, retryable skip instead of leaving a stuck "planned" plan behind —
    // it re-decides and deploys the moment one of its accounts recycles back.
    // Append mode is the reuse top-up: it must NOT rewrite the active reuse
    // task's status, so it keeps throwing (its caller swallows that and the
    // reuse stands on its restarted bots alone).
    if (reuseOnly && !append) {
      await AutoFarmTask.updateOne(
        { _id: task._id },
        {
          $set: {
            status: "skipped",
            decision: "skip_reuse_only",
            dryRun: false,
            plannedAccounts: 0,
            reason:
              "Reuse-only game (" +
              game +
              "): no fresh pool accounts are ever spent here — only accounts " +
              "already farmed on this game. None of its own recycled accounts " +
              "are free right now; will retry when one recycles back to the pool.",
            executedAt: new Date(),
          },
        },
      ).catch(() => {});
      return { decision: "skip_reuse_only", bots: [], accounts: 0 };
    }
    // Same reasoning as the reserve-floor guard above: the claim won nothing,
    // so nothing is owned and nothing is lost. Keep the task "planned" and
    // retryable rather than burning it. The genuine terminal "failed" write
    // stays further down, after accounts HAVE been claimed and bots touched.
    throw new Error("Could not claim any pool accounts");
  }

  const bots = [];
  const deployed = [];
  let error = "";
  try {
    // Pack into free seats of running auto-bots first — one container can
    // farm many games via per-account FavouriteGames, and every container
    // we don't create is RAM the Pi keeps.
    const packed = await fillExistingBots(host, claimed, game, af, ctx, {
      runningOnly,
    });
    for (const pl of packed.placed) {
      bots.push(pl.bot);
      for (const a of pl.accounts) deployed.push(a);
    }
    const rest = packed.remaining;
    // Hard stop at the container budget. Anything that doesn't fit is released
    // back to the pool rather than silently overrunning maxAutoBots.
    let created = 0;
    let i = 0;
    for (; i < rest.length && created < slotsFree; i += af.accountsPerBot) {
      const batch = rest.slice(i, i + af.accountsPerBot);
      const bot = await botFactory.createBot(host, batch, game, {
        startRunning: true,
      });
      created++;
      if (ctx && ctx.hostState) {
        ctx.hostState.activateBot(
          {
            host: bot.host,
            file: bot.file,
            container: bot.container,
          },
          bot.config,
        );
      }
      bots.push({
        host: bot.host,
        file: bot.file,
        container: bot.container,
        reused: false,
      });
      for (const b of batch) deployed.push(b);
      if (bot.startError) error += bot.container + ": " + bot.startError + "; ";
    }
    if (i < rest.length) {
      const spare = rest.slice(i);
      await releasePoolAccounts(spare);
      progress(
        (containers.blocked && containers.requested >= 1
          ? "No new container (" + containers.reason + ")"
          : "Container budget reached (" + af.maxAutoBots + " max)") +
          " — released " +
          spare.length +
          " unplaced account(s) back to the pool.",
        "warn",
      );
    }
  } catch (e) {
    error += e.message;
    // Release the accounts that were claimed but never made it into a config.
    const leftover = claimed.filter((c) => !deployed.includes(c));
    await releasePoolAccounts(leftover);
  }

  // Append mode (the reuse top-up): the task already carries reused bots and
  // accounts — merge the fresh ones in rather than overwriting them. Normal
  // execution keeps the overwrite semantics (a retried plan must not resurrect
  // stale bots from a previous failed run).
  let finalBots = bots;
  let finalAccounts = deployed.map((d) => d.username);
  if (append) {
    const seenBot = new Set();
    finalBots = [];
    for (const b of [...(task.bots || []), ...bots]) {
      const k = b.host + "|" + b.container;
      if (seenBot.has(k)) continue;
      seenBot.add(k);
      finalBots.push(b);
    }
    const seenAcc = new Set();
    finalAccounts = [];
    for (const u of [
      ...(task.assignedAccounts || []),
      ...deployed.map((d) => d.username),
    ]) {
      const k = String(u).toLowerCase();
      if (!k || seenAcc.has(k)) continue;
      seenAcc.add(k);
      finalAccounts.push(u);
    }
  }
  const ok = finalBots.length > 0;
  await AutoFarmTask.updateOne(
    { _id: task._id },
    {
      $set: {
        status: ok ? "active" : "failed",
        dryRun: false,
        bots: finalBots,
        assignedAccounts: finalAccounts,
        error: error.trim(),
        executedAt: new Date(),
        // Anchor the stop-loss clock the first time a probe goes active, and
        // never move it again (backfill re-stamps executedAt, this survives).
        ...(ok && task.decision === "probe" && !task.probeStartedAt
          ? { probeStartedAt: new Date() }
          : {}),
      },
    },
  );
  if (ok && !append) {
    try {
      const autoLister = require("./autoLister");
      const research = await MarketResearch.findOne({ game: task.game }).lean();
      await stampPreorderSet(
        {
          ...task.toObject(),
          status: "active",
          assignedAccounts: finalAccounts,
        },
        {
          DropSet,
          campaignItems: autoLister.campaignItems,
          derivePrice: autoLister.derivePrice,
          research,
        },
      );
      catalogRoutes.invalidateCatalogCache();
    } catch (err) {
      console.error("catalog preorder stamp failed:", err.message);
    }
  }
  if (append) {
    if (deployed.length) {
      await recordAutoFarmEvent({
        type: "topped_up",
        game,
        campaignId: task.campaignId,
        taskId: task._id,
        host: host.id,
        count: deployed.length,
        reason: "fresh accounts added to reused task",
        actor: "executeTask",
      });
    }
  } else {
    await recordAutoFarmEvent({
      type: ok ? "task_started" : "task_failed",
      game,
      campaignId: task.campaignId,
      taskId: task._id,
      host: host.id,
      count: ok ? deployed.length : claimed.length,
      reason: ok
        ? deployed.length +
          " account(s) deployed" +
          (error ? "; " + error.trim() : "")
        : error.trim() || "Bot creation failed",
      actor: "executeTask",
    });
  }
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
  if (!ok) {
    const failure = new Error(error || "Bot creation failed");
    failure.autoFarmEventRecorded = true;
    throw failure;
  }
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
    { bots: 1, game: 1, campaignId: 1, assignedAccounts: 1 },
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
        await recordAutoFarmEvent({
          type: "reaped",
          game: t.game,
          campaignId: t.campaignId,
          taskId: t._id,
          host: h.id,
          container: b.container,
          count: 1,
          reason: "retired completed-task bot",
          actor: "reapRetiredBots",
        });
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
    const logins = [];
    for (const t of done) {
      for (const u of t.assignedAccounts || []) logins.push(String(u));
    }
    if (logins.length) {
      const sold = await unrecyclableLogins(logins);
      // A completed task's container is SPARED when an active task still uses
      // it (the activeKeys check above), so its accounts can still be running.
      // Recycling those put a live, enabled account back in the pool, where it
      // was re-claimed and — being already deployed everywhere — fell through
      // to a fresh container every tick. Two independent guards, both erring
      // towards leaving an account claimed:
      //   * it belongs to a task that is still active, or
      //   * BotAccount still has it enabled in a config.
      const activeRows = await AutoFarmTask.find(
        { status: "active" },
        { assignedAccounts: 1 },
      ).lean();
      const stillFarming = new Set();
      for (const t of activeRows) {
        for (const u of t.assignedAccounts || []) {
          stillFarming.add(String(u).toLowerCase());
        }
      }
      const BotAccount = require("../models/BotAccount");
      const enabledRows = await BotAccount.find(
        { login: { $in: logins }, enabled: true },
        { login: 1 },
      ).lean();
      for (const r of enabledRows) {
        stillFarming.add(String(r.login || "").toLowerCase());
      }
      const back = logins.filter(
        (u) => !sold.has(u.toLowerCase()) && !stillFarming.has(u.toLowerCase()),
      );
      if (back.length) {
        // Auto-farm's own claims only — see recyclableClaimQuery. This pass
        // re-reads every completed task on every tick, so anything it wrongly
        // matches is released again ~every 23 minutes.
        const poolRows = await AvailableAccount.find(
          recyclableClaimQuery(back),
          { _id: 1 },
        ).lean();
        const r = await AvailableAccount.updateMany(
          recyclableClaimQuery(back),
          {
            $set: {
              status: "available",
              claimedAt: null,
              claimedNote: "recycled by retro-reaper",
            },
          },
        );
        recycled = (r && r.modifiedCount) || 0;
        if (recycled) {
          await recordPoolUsage(
            poolRows.map((row) => row._id),
            {
              event: "recycled",
              actor: "retro-reaper",
              note: "recycled by retro-reaper",
            },
          );
        }
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

// Merge half-empty auto containers back together.
//
// Container COUNT is what costs RAM: a TwitchDropsBot container is a fixed
// ~130 MB of .NET runtime plus only ~1.2 MB per account, so ten containers
// holding seven accounts each cost about four times what one container holding
// seventy does. utils/botConsolidator.js has always been able to fix that, but
// it had NO CALLER anywhere in the codebase — it only ran when the owner
// invoked it by hand, and the sprawl grew straight back in between (20 → 31
// containers on the Pi in two days). This is that caller.
//
// Three deliberate limits:
//   * only the auto path — botConsolidator refuses containers it does not own,
//     so hand-made bots are never rewritten by a background tick.
//   * a savings floor, because every repack restarts the surviving containers
//     and a restart is briefly lost watch time. One container's baseline is the
//     smallest win worth that.
//   * a cooldown, so a plan that cannot improve things is not re-attempted
//     every ten minutes.
const REPACK_MIN_SAVING_MB = 130; // one container's baseline
const REPACK_COOLDOWN_MS = 6 * 3600 * 1000;

async function repackAutoBots(af, host, progress) {
  if (!host || af.consolidate === false) return null;
  if (
    state.lastRepackAt &&
    Date.now() - state.lastRepackAt < REPACK_COOLDOWN_MS
  ) {
    return null;
  }
  const consolidator = require("./botConsolidator");
  const capacity = Math.max(1, Number(af.accountsPerBot) || 70);
  const p = await consolidator.plan(host.id, { capacity });
  if (p.empty || !p.moves || !p.moves.length) return null;
  if (p.stranded) {
    // buildPlan could not fit everything at this capacity. Consolidating anyway
    // would throw; say so once rather than silently doing nothing forever.
    progress(
      "Repack skipped: " +
        p.stranded +
        " account(s) would not fit at " +
        capacity +
        "/container — raise accountsPerBot.",
      "warn",
    );
    state.lastRepackAt = Date.now();
    return null;
  }
  if ((p.savingMB || 0) < REPACK_MIN_SAVING_MB) return null;
  progress(
    "Repacking " +
      p.before.containers +
      " auto container(s) into " +
      p.after.containers +
      " (~" +
      p.savingMB +
      " MB)…",
  );
  state.lastRepackAt = Date.now();
  const r = await consolidator.consolidate(host.id, {
    capacity,
    progress: (m) => progress(m),
  });
  if (r.skipped) return null;
  await recordAutoFarmEvent({
    type: "repacked",
    host: host.id,
    count: (r.retired || []).length,
    reason:
      p.before.containers +
      " containers → " +
      p.after.containers +
      ", " +
      r.movedAccounts +
      " account(s) moved",
    actor: "repackAutoBots",
  });
  await tg(
    "🧹 Auto-farm REPACK — " +
      (host.label || host.id) +
      "\n" +
      p.before.containers +
      " containers → " +
      p.after.containers +
      ", freeing roughly " +
      p.savingMB +
      " MB.\n" +
      (r.retired || []).length +
      " container(s) retired, " +
      r.movedAccounts +
      " account(s) moved.",
  );
  return r;
}

// Restart `container` only if it is running (utils/farmControl.js, 2026-10-03):
// a parked container stays parked. Should a deploy ever ship this file without
// that helper, the old unconditional restart is kept rather than none — a
// running container that never reloads keeps farming accounts this engine has
// just returned to the pool.
async function restartIfRunning(host, container) {
  const fc = require("./farmControl");
  if (typeof fc.restartIfRunning === "function") {
    return fc.restartIfRunning(host, container);
  }
  await hosts.dockerContainer(host, "restart", container);
  return { restarted: true, state: "unknown" };
}

// Apply one task's post-event markup, recording the outcome on the task so a
// failure is visible instead of living only in the process log.
async function repriceTask(t, notify) {
  try {
    const autoLister = require("./autoLister");
    const r = await autoLister.onCampaignEnded(t._id);
    if (r && r.repriced) {
      // Clear any error left by an earlier failed attempt.
      await AutoFarmTask.updateOne(
        { _id: t._id },
        { $set: { "listing.error": "" } },
      ).catch(() => {});
      if (notify) {
        await notify(
          "📈 Post-event reprice — " +
            t.game +
            "\n$" +
            r.repriced.price +
            " · " +
            r.repriced.items +
            " item(s) stacked" +
            (r.repriced.live ? "" : " (listing not live)") +
            (r.repriced.released
              ? "\n" + r.repriced.released + " held-back unit(s) released"
              : ""),
        );
      }
    }
    return r || {};
  } catch (e) {
    // Persist it: onCampaignEnded used to fail into console.error alone, so a
    // stuck listing was invisible in the UI and looked like it had simply been
    // repriced. Prod carried four of those for up to 88h.
    await AutoFarmTask.updateOne(
      { _id: t._id },
      {
        $set: {
          "listing.error": ("reprice failed: " + e.message).slice(0, 400),
        },
      },
    ).catch(() => {});
    console.error("post-event reprice failed (" + t.game + "):", e.message);
    return { error: e.message };
  }
}

// Retry sweep for markups that never landed.
//
// completeEndedTasks flips a task to "completed" and THEN reprices, so before
// this existed a single transient Gameflip error (its rate limiter answers 429
// for minutes at a time) permanently cost the markup, the retitle AND the
// held-back stock release — nothing ever revisited a completed task. Prod had
// four listings stuck at pre-event prices with ~26 accounts frozen in holdback.
//
// Deliberately slow: MAX_REPRICE_RETRIES_PER_TICK at a time, oldest first,
// because gameflipReprice already spends up to ~3 minutes on its own restore
// backoff and hammering the limiter is what caused the failures in the first
// place. onCampaignEnded marks postEvent even when no live row remains, so this
// queue always drains rather than spinning on dead listings.
const MAX_REPRICE_RETRIES_PER_TICK = 2;

async function repriceEndedTasks() {
  const pending = await AutoFarmTask.find({
    status: "completed",
    "listing.externalId": { $nin: ["", null] },
    "listing.postEvent": { $ne: true },
  })
    .sort({ completedAt: 1 })
    .limit(MAX_REPRICE_RETRIES_PER_TICK);
  if (!pending.length) return 0;
  progress(
    "Retrying post-event reprice on " + pending.length + " ended task(s)…",
  );
  let done = 0;
  for (const t of pending) {
    const r = await repriceTask(t, tg);
    if (r && r.repriced) {
      done++;
      await recordAutoFarmEvent({
        type: "listed",
        game: t.game,
        campaignId: t.campaignId,
        taskId: t._id,
        count: r.repriced.released || 0,
        reason: "post-event reprice to $" + r.repriced.price,
        actor: "repriceEndedTasks",
      });
      progress(t.game + " repriced to $" + r.repriced.price);
    } else if (r && r.skipped) {
      progress(t.game + " reprice skipped: " + r.skipped, "warn");
    } else if (r && r.error) {
      progress(t.game + " reprice failed: " + r.error, "warn");
    }
  }
  return done;
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
      { bots: 1, game: 1, assignedAccounts: 1 },
    ).lean();
    const sharedKeys = new Set();
    for (const o of others) {
      for (const b of o.bots || []) sharedKeys.add(b.host + "|" + b.container);
    }
    const mine = new Set(
      (t.assignedAccounts || []).map((u) => String(u).toLowerCase()),
    );
    // Accounts another ACTIVE task for the SAME game still farms. A recurring
    // campaign's next wave is reused onto the same accounts, and when that
    // reuse lands BEFORE this wave ends, stripping the game here (and disabling
    // the ones left with none) switched the new wave off the moment the old one
    // closed — RavenQuest "September 05" (18/18), SMITE 2 "Sept Wk 4" (14/14)
    // and Active Matter "Week II" (18/42) all sat disabled from their first
    // hour on 2026-09-25/26. Their game stays and they are not recycled.
    const endedGame = String(t.game || "").trim().toLowerCase();
    const stillNeeded = new Set();
    for (const o of others) {
      if (String(o.game || "").trim().toLowerCase() !== endedGame) continue;
      for (const u of o.assignedAccounts || []) {
        stillNeeded.add(String(u).toLowerCase());
      }
    }
    const stopped = [];
    const removed = [];
    const trimmed = [];
    // Logins of THIS task that are still enabled in a container that survives
    // this cleanup. Recycling one of these back to the pool is what created
    // the duplicate-container loop: the account gets re-claimed while it is
    // still running, cannot be placed anywhere (it is already everywhere), and
    // falls through to a brand-new container — every tick, forever.
    const stillEnabled = new Set();
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
            if (stillNeeded.has(String(u.Login || "").toLowerCase())) {
              // The next wave of this game farms it — leave it armed.
              if (u.Enabled !== false) {
                stillEnabled.add(String(u.Login || "").toLowerCase());
              }
              continue;
            }
            const own = Array.isArray(u.FavouriteGames) ? u.FavouriteGames : [];
            const next = own.filter(
              (f) =>
                String(f).trim().toLowerCase() !==
                String(t.game).trim().toLowerCase(),
            );
            if (next.length === own.length) {
              // Nothing removed — it never farmed this game here, so whatever
              // it IS farming keeps running. Still deployed.
              if (u.Enabled !== false) {
                stillEnabled.add(String(u.Login || "").toLowerCase());
              }
              continue;
            }
            u.FavouriteGames = next;
            // An empty per-account list inherits the config-level games,
            // which could resurrect the removed one — disable instead.
            if (!next.length) u.Enabled = false;
            // Games left over means this account is still farming here for a
            // co-tenant task, so it must NOT go back to the pool.
            else stillEnabled.add(String(u.Login || "").toLowerCase());
            changed++;
          }
          if (changed) {
            await hosts.writeFileAtomic(
              h,
              b.file,
              JSON.stringify(data, null, 2),
            );
            // Reload the config only in a container that is RUNNING. A plain
            // `docker restart` starts a stopped one, so this woke a shared bot
            // botWaker had parked (the wake/park flap class, 2026-09-29); a
            // stopped container reads the trimmed config when it next starts.
            await restartIfRunning(h, b.container).catch(() => {});
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
        const sold = await unrecyclableLogins(t.assignedAccounts);
        const back = t.assignedAccounts.filter(
          (u) =>
            !sold.has(String(u).toLowerCase()) &&
            // Still running for a co-tenant task — see `stillEnabled` above.
            !stillEnabled.has(String(u).toLowerCase()) &&
            // Assigned to the next wave of this game — see `stillNeeded`.
            !stillNeeded.has(String(u).toLowerCase()),
        );
        if (stillNeeded.size) {
          const kept = t.assignedAccounts.filter((u) =>
            stillNeeded.has(String(u).toLowerCase()),
          ).length;
          if (kept) {
            progress(
              "Kept " + kept + " account(s) armed for " + t.game +
                ": the next wave of the same game farms them.",
            );
          }
        }
        if (stillEnabled.size) {
          progress(
            "Kept " +
              stillEnabled.size +
              " account(s) out of the recycle: still enabled in a shared bot.",
          );
        }
        if (back.length) {
          // Auto-farm's own claims only — see recyclableClaimQuery.
          const poolRows = await AvailableAccount.find(
            recyclableClaimQuery(back),
            { _id: 1 },
          ).lean();
          const r = await AvailableAccount.updateMany(
            recyclableClaimQuery(back),
            {
              $set: {
                status: "available",
                claimedAt: null,
                claimedNote: "recycled after " + t.game,
              },
            },
          );
          recycled = (r && r.modifiedCount) || 0;
          if (recycled) {
            await recordPoolUsage(
              poolRows.map((row) => row._id),
              {
                event: "recycled",
                actor: "auto-farm",
                game: t.game,
                note: "recycled after " + t.game,
              },
            );
            await recordAutoFarmEvent({
              type: "recycled",
              game: t.game,
              campaignId: t.campaignId,
              taskId: t._id,
              count: recycled,
              reason: "recycled after " + t.game,
              actor: "completeEndedTasks",
            });
          }
        }
      } catch {
        /* best-effort — accounts stay claimed, owner can release manually */
      }
    }
    // A probe whose campaign ends with 0 real sales failed its test — stamp the
    // cooldown marker so a later campaign for the same game isn't re-probed
    // straight away (expireStaleProbes reads probeOutcome). A probe that sold at
    // least once leaves no marker: its own sales lift future campaigns over the
    // demand floor and it graduates to a normal farm.
    if (t.decision === "probe" && salesOf(await internalSalesForGame(t.game)).count === 0) {
      t.probeOutcome = "expired";
    }
    t.status = "completed";
    t.completedAt = new Date();
    await t.save().catch(() => {});
    completed++;
    await recordAutoFarmEvent({
      type: "task_completed",
      game: t.game,
      campaignId: t.campaignId,
      taskId: t._id,
      count: (t.assignedAccounts || []).length,
      reason: t.probeOutcome === "expired" ? "probe ended — 0 sales" : "campaign ended",
      actor: "completeEndedTasks",
    });
    // Event over = supply fixed: apply the post-event scarcity markup and
    // rebuild the listing as a stacked bundle of every campaign this game's
    // accounts have farmed. A failure here is picked up by repriceEndedTasks
    // on a later tick \u2014 see why that retry had to exist in its comment.
    const repriced = await repriceTask(t, tg);
    if (repriced && repriced.repriced) {
      await recordAutoFarmEvent({
        type: "listed",
        game: t.game,
        campaignId: t.campaignId,
        taskId: t._id,
        count: repriced.repriced.released || 0,
        reason: "post-event reprice to $" + repriced.repriced.price,
        actor: "completeEndedTasks",
      });
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

// Stop-loss for cold-start probes (utils/settings.js probeColdStart). A probe
// whose Twitch campaign ends within the window is already torn down and marked
// by completeEndedTasks; this sweep catches the rarer probe whose campaign is
// still LIVE past probeMaxDays (long-running or permanent drop campaigns), so a
// losing bet can't tie up accounts forever. 0 real sales = failed → stop the
// bots, release the accounts to the pool, and stamp the cooldown marker. A
// probe that has sold at least once is left alone (its sales graduate it).
async function expireStaleProbes(af, progress) {
  if (!af.probeColdStart) return 0;
  const maxDays = Math.max(1, Number(af.probeMaxDays) || 30);
  const cutoff = new Date(Date.now() - maxDays * 86400000);
  const stale = await AutoFarmTask.find({
    status: "active",
    decision: "probe",
    probeStartedAt: { $ne: null, $lte: cutoff },
  });
  if (!stale.length) return 0;
  let expired = 0;
  for (const t of stale) {
    // Still selling? leave it — the stop-loss only fires on a cold trail.
    if (salesOf(await internalSalesForGame(t.game)).count > 0) continue;
    // Never touch a container a co-tenant task shares: switching just this
    // probe's accounts off needs the per-account FavouriteGames edit
    // completeEndedTasks does, and doing it wrong is what caused the
    // duplicate-container loop. Defer those to the normal campaign-end path.
    const others = await AutoFarmTask.find(
      { status: "active", _id: { $ne: t._id } },
      { bots: 1 },
    ).lean();
    const sharedKeys = new Set();
    for (const o of others)
      for (const b of o.bots || []) sharedKeys.add(b.host + "|" + b.container);
    if ((t.bots || []).some((b) => sharedKeys.has(b.host + "|" + b.container))) {
      progress(
        "Probe stop-loss: " +
          t.game +
          " past " +
          maxDays +
          "d with 0 sales but shares a container — deferring to campaign end.",
      );
      continue;
    }
    const stopped = [];
    for (const b of t.bots || []) {
      const h = hosts.resolveHost(b.host);
      if (!h) continue;
      try {
        await botFactory.stopContainer(h, b.container);
        stopped.push(b.container);
      } catch {
        /* container may already be gone */
      }
      if (af.deleteFinishedBots !== false) {
        try {
          await botFactory.deleteBot(h, b.file, b.container);
        } catch {
          /* best-effort */
        }
      }
    }
    // Release the accounts to the pool — except any a buyer already holds (0
    // sales makes this rare, but a connected/sold drop still spares it).
    let recycled = 0;
    if (t.assignedAccounts && t.assignedAccounts.length) {
      try {
        const sold = await unrecyclableLogins(t.assignedAccounts);
        const back = t.assignedAccounts.filter(
          (u) => !sold.has(String(u).toLowerCase()),
        );
        if (back.length) {
          // Auto-farm's own claims only — see recyclableClaimQuery.
          const poolRows = await AvailableAccount.find(
            recyclableClaimQuery(back),
            { _id: 1 },
          ).lean();
          const r = await AvailableAccount.updateMany(
            recyclableClaimQuery(back),
            {
              $set: {
                status: "available",
                claimedAt: null,
                claimedNote: "recycled — probe expired (0 sales)",
              },
            },
          );
          recycled = (r && r.modifiedCount) || 0;
          if (recycled) {
            await recordPoolUsage(
              poolRows.map((row) => row._id),
              {
                event: "recycled",
                actor: "auto-farm",
                game: t.game,
                note: "probe expired — 0 sales in " + maxDays + "d",
              },
            );
          }
        }
      } catch {
        /* best-effort — accounts stay claimed, owner can release manually */
      }
    }
    t.status = "completed";
    t.completedAt = new Date();
    t.probeOutcome = "expired";
    await t.save().catch(() => {});
    expired++;
    await recordAutoFarmEvent({
      type: "task_completed",
      game: t.game,
      campaignId: t.campaignId,
      taskId: t._id,
      count: (t.assignedAccounts || []).length,
      reason: "probe expired — 0 sales in " + maxDays + "d",
      actor: "expireStaleProbes",
    });
    progress(
      "Probe stop-loss: " +
        t.game +
        " — " +
        maxDays +
        "d, 0 sales. Stopped " +
        stopped.length +
        " bot(s), recycled " +
        recycled +
        " account(s).",
    );
    await tg(
      "🤖 Auto-farm PROBE EXPIRED — " +
        t.game +
        "\nNo sales in " +
        maxDays +
        " days. Stopped the probe" +
        (recycled
          ? " and recycled " + recycled + " account(s) to the pool"
          : "") +
        ". Won't re-probe for " +
        (Number(af.probeCooldownDays) || 0) +
        " days.",
    );
  }
  return expired;
}

/* -------------------------------- tick --------------------------------- */

// Main mode leaves a game with no lane to the supervisor, which creates one at
// the start of its next cycle (ownership.legacyMayDecide). A lane that cannot
// be created — a write that keeps failing, a name the model rejects — would
// leave that game to NOBODY, silently, while every tick still counted as ok
// (2026-10-03 review H3). So once a game has waited LANE_FALLBACK_MS (30 min)
// AND at least LANE_FALLBACK_TICKS ticks, the legacy engine decides and lists
// it itself — the fail-safe direction for a game nobody owns — and says so
// once. Both, because ticks alone are not time: "Scan now" pressed three
// times in a row reached three ticks in seconds and handed a brand-new game
// to legacy before the supervisor had had one cycle (review round 3). The
// wait is timed from the first tick that saw the game waiting, and it ends
// the moment the game stops waiting (its lane appeared, or its campaign
// ended), which re-arms the alert.
const LANE_FALLBACK_TICKS = 3;
const LANE_FALLBACK_MS = 30 * 60 * 1000;

// `w` is a game's waiting record { ticks, since, alerted }, `ticks` counting
// the tick being judged.
function laneFallbackDue(w, now = Date.now()) {
  return (
    !!w &&
    w.ticks >= LANE_FALLBACK_TICKS &&
    now - (Number(w.since) || now) >= LANE_FALLBACK_MS
  );
}

async function noteAwaitingLane(awaitingNow, now = Date.now()) {
  const next = new Map();
  const reached = [];
  for (const [key, game] of awaitingNow) {
    const prev = state.awaitingLaneTicks.get(key);
    const w = {
      ticks: (prev ? prev.ticks : 0) + 1,
      since: prev ? prev.since : now,
      alerted: !!(prev && prev.alerted),
    };
    if (!w.alerted && laneFallbackDue(w, now)) {
      w.alerted = true;
      reached.push({ game, ticks: w.ticks, minutes: Math.floor((now - w.since) / 60000) });
    }
    next.set(key, w);
  }
  state.awaitingLaneTicks = next;
  for (const { game, ticks, minutes } of reached) {
    try {
      require("./systemLog").logEvent({
        category: "autofarm",
        action: "lane_missing_fallback",
        actor: "autoFarmer",
        severity: "warn",
        subject: game,
        game,
        count: ticks,
        detail:
          game +
          " has waited " +
          minutes +
          " min (" +
          ticks +
          " ticks) for a farm2 lane that was never created; the legacy " +
          "engine decides and lists it until one exists.",
      });
    } catch {
      /* auditing must never break a tick */
    }
    await tg(
      "⚠️ Auto-farm — " +
        game +
        " has had no farm2 lane for " +
        minutes +
        " min (" +
        ticks +
        " ticks): the lane engine is the main engine but its lane " +
        "was never created (see the supervisor's last error). The legacy " +
        "engine now decides and lists this game itself until the lane exists.",
    );
  }
}

// A main-mode tick that cannot read the lane table decides nothing (runOnce,
// ownershipUnknown) — and the lane supervisor, reading the same table, is then
// usually down too, so NO engine decides while both loops keep ticking. Say so
// once it has lasted DEFERRED_ALERT_TICKS ticks (~30 min); one alert per stall,
// re-armed by the first tick that can read the table again.
const DEFERRED_ALERT_TICKS = 3;

async function noteDeferredTick(deferred) {
  if (!deferred) {
    state.deferredTicks = 0;
    state.deferredAlerted = false;
    return;
  }
  state.deferredTicks += 1;
  if (state.deferredTicks < DEFERRED_ALERT_TICKS || state.deferredAlerted) return;
  state.deferredAlerted = true;
  const text =
    "legacy decisions deferred " +
    state.deferredTicks +
    " ticks: lane ownership unreadable";
  try {
    require("./systemLog").logEvent({
      category: "autofarm",
      action: "decisions_deferred",
      actor: "autoFarmer",
      severity: "warn",
      subject: "main engine",
      count: state.deferredTicks,
      detail:
        text +
        " — the lane engine is the main engine and its FarmLane table could " +
        "not be read, so no campaign is being decided.",
    });
  } catch {
    /* auditing must never break a tick */
  }
  await tg(
    "⚠️ Auto-farm — " +
      text +
      ". The lane engine is the main engine and its lane table cannot be " +
      "read, so no new campaign is being decided by either engine. Check the " +
      "database connection; this clears itself on the first readable tick.",
  );
}

async function runOnce() {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  progressBegin();
  try {
    const af = cfg();
    const catalogChanges = await catalogRoutes
      .updateAutofarmCatalogStates()
      .catch((e) => {
        progress("Catalog state refresh failed: " + e.message, "warn");
        return 0;
      });
    if (catalogChanges) {
      progress("Updated " + catalogChanges + " event catalog listing(s).");
    }
    if (
      !state.lastCatalogVariantSyncAt ||
      Date.now() - state.lastCatalogVariantSyncAt >= CATALOG_VARIANT_SYNC_MS
    ) {
      const started = catalogRoutes.startVariantSync({
        apply: true,
        source: "auto-farm",
        syncEventSets: true,
        onFinish(job) {
          if (job.error) {
            progress(
              "Scheduled catalog inventory sync failed: " + job.error,
              "warn",
            );
          } else {
            state.lastCatalogVariantSyncAt = Date.now();
            progress(
              "Scheduled catalog inventory sync completed: " +
                (job.result?.count || 0) +
                " profile(s) across " +
                (job.result?.games || 0) +
                " game(s); " +
                (job.result?.eventSets?.stocked || 0) +
                " stocked event set(s).",
            );
          }
          recordAutoFarmEvent({
            type: "catalog_sync",
            count: Number(job.result?.count) || 0,
            actor: "auto-farm",
            reason: job.error
              ? `failed: ${job.error}`
              : `${Number(job.result?.games) || 0} games; ${Number(job.result?.eventSets?.stocked) || 0} stocked event sets`,
          });
        },
      });
      if (started) {
        progress("Started scheduled catalog inventory sync (6-hour cycle).");
      } else {
        progress("Scheduled catalog sync skipped: another sync is running.");
      }
    }
    if (!af.enabled) {
      progress("Auto farmer is disabled in settings — nothing to do.", "warn");
      state.lastSummary = { enabled: false, catalogChanges };
      state.lastError = "";
      state.lastOkAt = new Date();
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
    // Catch up any markup that failed on an earlier tick (dry runs never touch
    // a live marketplace, so they must not reprice either).
    if (!af.dryRun) {
      const rp = await repriceEndedTasks().catch((e) => {
        progress("Reprice sweep failed: " + e.message, "warn");
        return 0;
      });
      if (rp) progress("Applied " + rp + " catch-up reprice(s).");
    }
    const expired = await expireStalePlans().catch(() => 0);
    if (expired)
      progress(
        "Cleared " + expired + " plan(s) whose campaign ended unexecuted.",
      );

    const host = resolveFarmHost(af);
    const hostOnline = host ? await probeHost(host, progress) : false;
    progress(
      host
        ? "Farm host: " +
            (host.label || host.id) +
            " — " +
            (hostOnline ? "online" : "OFFLINE")
        : "No farm host configured.",
      hostOnline ? "info" : "warn",
    );

    // Wake any bot we stopped as "finished" whose game now has a NEW campaign,
    // then park any bot that has finished everything it was given.
    //
    // Runs across EVERY configured host, not just the farm host. Container RAM
    // is a whole-fleet cost and the biggest idle bots are the owner's manual
    // stash ones, which never live on the auto-farm host: prod's own box runs
    // 11 hand-made containers in ~2.45 GB of a 4.5 GB machine. Waking runs
    // first on purpose — a woken bot's accounts already hold that game's
    // drops, so reusing them beats spending fresh pool accounts a few lines
    // further down.
    const woken = [];
    const parked = [];
    const parkedIdle = [];
    const parkedNoCampaign = [];
    for (const h of hosts.listHosts()) {
      try {
        const w = await botWaker.wakeFinishedBots(h.id, { progress });
        for (const x of w.woken) woken.push({ ...x, host: h.id });
      } catch (e) {
        progress(
          "Wake check failed on " + h.id + ": " + (e.message || e),
          "warn",
        );
      }
      // Stream-gate idle park (utils/streamScout.js): park bots that are only
      // waiting for a broadcast. Self-guards on af.streamGate (cheap no-op when
      // off) and is INDEPENDENT of stopFinishedBots below — it parks idle-waiting
      // bots, not finished ones.
      try {
        const p = await botWaker.parkIdleBots(h.id, { progress });
        for (const x of p.parked) parkedIdle.push({ ...x, host: h.id });
      } catch (e) {
        progress(
          "Idle-stream park failed on " + h.id + ": " + (e.message || e),
          "warn",
        );
      }
      // Idle-no-campaign park (utils/botWaker.js): park bots whose games have no
      // active campaign at all. Self-guards on af.parkIdleNoCampaignBots.
      try {
        const p = await botWaker.parkIdleNoCampaignBots(h.id, { progress });
        for (const x of p.parked) parkedNoCampaign.push({ ...x, host: h.id });
      } catch (e) {
        progress(
          "Idle-no-campaign park failed on " + h.id + ": " + (e.message || e),
          "warn",
        );
      }
      if (!af.stopFinishedBots) continue;
      try {
        const s = await botWaker.stopFinishedBots(h.id, { progress });
        for (const x of s.stopped) parked.push({ ...x, host: h.id });
      } catch (e) {
        progress(
          "Stop-finished check failed on " + h.id + ": " + (e.message || e),
          "warn",
        );
      }
    }
    if (woken.length) {
      await tg(
        "⏰ Auto-farm — woke " +
          woken.length +
          " finished bot(s) for new campaigns: " +
          woken
            .map((x) => x.host + "/" + x.container + " (" + x.game + ")")
            .join(", "),
      );
    }
    if (parked.length) {
      const accts = parked.reduce((s, x) => s + (x.accounts || 0), 0);
      await tg(
        "💤 Auto-farm — parked " +
          parked.length +
          " finished bot(s) holding " +
          accts +
          " account(s), freeing roughly " +
          Math.round(parked.length * 130) +
          " MB: " +
          parked.map((x) => x.host + "/" + x.container).join(", ") +
          "\nThey restart automatically when a new campaign for their games " +
          "goes live.",
      );
    }
    if (parkedIdle.length) {
      const accts = parkedIdle.reduce((s, x) => s + (x.accounts || 0), 0);
      await tg(
        "📺 Stream-gate — parked " +
          parkedIdle.length +
          " bot(s) waiting for a broadcast, holding " +
          accts +
          " account(s), freeing roughly " +
          Math.round(parkedIdle.length * 130) +
          " MB: " +
          parkedIdle.map((x) => x.host + "/" + x.container).join(", ") +
          "\nThey restart automatically the moment an assigned channel goes live.",
      );
    }
    if (parkedNoCampaign.length) {
      const accts = parkedNoCampaign.reduce((s, x) => s + (x.accounts || 0), 0);
      await tg(
        "🅿️ Idle-no-campaign — parked " +
          parkedNoCampaign.length +
          " bot(s) with nothing to farm, holding " +
          accts +
          " account(s), freeing roughly " +
          Math.round(parkedNoCampaign.length * 130) +
          " MB: " +
          parkedNoCampaign.map((x) => x.host + "/" + x.container).join(", ") +
          "\nThey restart automatically when a campaign for their games starts.",
      );
    }

    // Read the auto-task registry once after wake/park has finished mutating
    // containers. The same rows feed the manual-stash exclusion, reusable-task
    // lookup and the batched host snapshot below.
    const autoTasks = await AutoFarmTask.find(
      { "bots.0": { $exists: true } },
      {
        status: 1,
        game: 1,
        campaignId: 1,
        createdAt: 1,
        assignedAccounts: 1,
        bots: 1,
      },
    )
      .sort({ createdAt: -1 })
      .lean();
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
    const existingKeys = live
      .filter((c) => c.game && !settings.isNoClaimGame(c.game))
      .map((c) => ({ game: c.game, campaignId: c.campaignId }));
    const existingRows = existingKeys.length
      ? await AutoFarmTask.find(
          {
            $or: existingKeys.map((x) => ({
              game: x.game,
              campaignId: x.campaignId,
            })),
          },
          {
            game: 1,
            campaignId: 1,
            status: 1,
            decision: 1,
            rescanRequested: 1,
            bots: 1,
            // isStranded dates a `planned` row by these (STRANDED_PLAN_MS).
            decidedAt: 1,
            updatedAt: 1,
          },
        ).lean()
      : [];
    const existingByKey = new Map(
      existingRows.map((row) => [row.game + "|" + row.campaignId, row]),
    );
    // The loop below asks the lane engine's ownership cache once per campaign,
    // synchronously. Bring the cache up to date first — the ONE await before
    // the loop; the loop itself stays synchronous. A cold cache (boot, a lane
    // auto-create, a failed read) answers "not owned" for every game, and this
    // engine then decided campaigns the lane engine owns (2026-10-03).
    await farm2Ownership.ensureFresh();
    // Lane engine is the MAIN engine but its lane table still could not be
    // read: which games it owns is unknown, so this tick decides nothing
    // (below). Outside main mode the old fail-safe stands — this engine
    // decides, because a lane engine that is only on trial owns nothing it
    // is not running.
    const ownershipUnknown = farm2Ownership.isMain() && farm2Ownership.isCold();
    let noClaimSkipped = 0;
    let farm2Skipped = 0;
    // Main mode: games with no lane at all yet, left to the supervisor —
    // and those that have waited long enough (laneFallbackDue), decided here.
    const awaitingLane = new Set();
    const awaitingNow = new Map(); // lane key -> game, this tick
    const laneFallback = new Set();
    const tickNow = Date.now();
    for (const c of live) {
      if (!c.game) continue;
      // No-claim games (Overwatch, Rainbow Six) are handled by the standalone
      // no-claim farming system — never farm or list them here. Skipping at the
      // candidate stage means no NEW task is created; any already-active task
      // for such a game is left to its normal lifecycle (leave existing as-is).
      if (settings.isNoClaimGame(c.game)) {
        noClaimSkipped++;
        continue;
      }
      // Games owned by the new lane engine (utils/farm2/*) are farmed there
      // instead. Same contract as the no-claim skip directly above: no NEW task
      // is created here, while any already-active task keeps its normal
      // lifecycle under this engine — so flipping a lane to "live" can never
      // strand a campaign that is already mid-flight.
      //
      // isOwned() is synchronous and answers from a 30s cache, and every
      // uncertainty (engine stopped, master switch off, lane table unreadable,
      // cache cold) resolves to NOT owned so this engine keeps covering the
      // game. See the fail-safe note at the top of utils/farm2/ownership.js.
      // (In main mode an unreadable table defers instead: ownershipUnknown.)
      if (farm2Ownership.isOwned(c.game)) {
        farm2Skipped++;
        continue;
      }
      // Main mode: a game with no lane yet is the lane engine's too — the
      // supervisor creates its lane within a cycle (farm2/ownership.js
      // legacyMayDecide). Outside main mode this is the isOwned test above.
      // A game that has waited 30 min and 3 ticks is decided here after all
      // (laneFallbackDue, noteAwaitingLane): nobody else is going to.
      if (!ownershipUnknown && !farm2Ownership.legacyMayDecide(c.game)) {
        const laneKey = farm2Ownership.normKey(c.game);
        awaitingNow.set(laneKey, c.game);
        const prev = state.awaitingLaneTicks.get(laneKey);
        const waiting = {
          ticks: (prev ? prev.ticks : 0) + 1,
          since: prev ? prev.since : tickNow,
        };
        if (!laneFallbackDue(waiting, tickNow)) {
          awaitingLane.add(c.game);
          continue;
        }
        laneFallback.add(c.game);
      }
      const existing = existingByKey.get(c.game + "|" + c.campaignId);
      if (!existing) {
        candidates.push(c);
      } else if (
        (existing.status === "skipped" && RETRYABLE.has(existing.decision)) ||
        existing.rescanRequested
      ) {
        // Either the conditions may have changed on their own, or the operator
        // asked for a fresh look via "Rescan all". Both re-decide; both keep the
        // prior decision so an unchanged verdict is not re-announced.
        candidates.push(c);
        priorTasks.set(c.campaignId, existing);
      } else if (!af.dryRun && isStranded(existing)) {
        // A task the owner would otherwise have to rescue by hand. In LIVE mode
        // nothing should ever wait for a click, so it is re-decided from
        // scratch like any other candidate.
        candidates.push(c);
        priorTasks.set(c.campaignId, existing);
      }
    }
    if (noClaimSkipped)
      progress(
        "Skipped " +
          noClaimSkipped +
          " no-claim campaign(s) (Overwatch/Rainbow Six) — handled by the " +
          "standalone no-claim farming system.",
      );
    if (farm2Skipped)
      progress(
        "Skipped " +
          farm2Skipped +
          " campaign(s) owned by the lane engine (" +
          farm2Ownership.ownedKeys().join(", ") +
          ").",
      );
    if (awaitingLane.size) {
      progress(
        "Left " +
          awaitingLane.size +
          " game(s) with no lane yet to the lane engine (main mode; the " +
          "supervisor creates their lanes within a cycle): " +
          [...awaitingLane].join(", ") +
          ".",
      );
    }
    if (laneFallback.size) {
      progress(
        "Deciding " +
          laneFallback.size +
          " game(s) here although the lane engine is the main engine: no lane " +
          "for " +
          LANE_FALLBACK_MS / 60000 +
          "+ min — " +
          [...laneFallback].join(", ") +
          ".",
        "warn",
      );
    }
    // An unreadable table says nothing about which games have lanes, so the
    // per-game waiting counts are only advanced by a tick that could read it.
    if (!ownershipUnknown) await noteAwaitingLane(awaitingNow, tickNow);
    if (ownershipUnknown) {
      // Not a fallback to this engine: in main mode the lanes decide, and the
      // next tick (10 min) re-reads the table. Maintenance sweeps still run.
      progress(
        "decisions deferred: lane ownership unknown — the lane engine is the " +
          "main engine but its lane table could not be read; " +
          candidates.length +
          " campaign(s) left undecided this tick. Maintenance sweeps still run.",
        "warn",
      );
      candidates.length = 0;
      priorTasks.clear();
    }
    await noteDeferredTick(ownershipUnknown);
    progress(candidates.length + " campaign(s) to decide this tick.");

    // The tick-level twin of reusableTaskForGame, and it must apply the SAME
    // rule — processCampaign prefers this map over that function, so a
    // divergence here is the one that reaches production.
    //
    // `assignedAccounts.0` is the load-bearing condition: without it an empty
    // reuse row (bots, no accounts) becomes the next campaign's source, that
    // campaign inherits zero and writes another empty row, and the game can
    // never recover. Albion Online sat in exactly that trap for 15 consecutive
    // tasks; see reusableTaskForGame for the measurement.
    const reusableMap = new Map();
    const candidateGames = new Set(candidates.map((c) => c.game));
    for (const task of autoTasks) {
      if (
        candidateGames.has(task.game) &&
        ["active", "completed", "stopped"].includes(task.status) &&
        (task.assignedAccounts || []).length > 0 &&
        !reusableMap.has(task.game)
      ) {
        reusableMap.set(task.game, task);
      }
    }
    const snapshotTasks = [];
    const snapshotTaskIds = new Set();
    const tasksToSnapshot =
      candidates.length && hostOnline
        ? [
            ...autoTasks.filter((t) => t.status === "active"),
            ...reusableMap.values(),
          ]
        : [];
    for (const task of tasksToSnapshot) {
      const key = String(task._id || task.game + "|" + task.campaignId);
      if (snapshotTaskIds.has(key)) continue;
      snapshotTaskIds.add(key);
      snapshotTasks.push(task);
    }
    const skipSnapshotHosts = new Set();
    if (host && !hostOnline) skipSnapshotHosts.add(host.id);
    const hostState = await buildDecisionHostState(snapshotTasks, af, host, {
      skipHosts: skipSnapshotHosts,
    });
    progress(
      "Auto-host snapshot: " +
        hostState.fileCount +
        " config file(s), " +
        hostState.hostCalls +
        " host call(s) in " +
        hostState.elapsedMs +
        "ms.",
      "info",
    );

    // Prefetch decision inputs once per game, with bounded parallel reads. Two
    // campaigns for one game share the exact same market and sales snapshot.
    const infoMap = new Map();
    const researchGames = [...new Set(candidates.map((c) => c.game))];
    let researched = 0;
    const researchedRows = await mapWithConcurrency(
      researchGames,
      DECISION_READ_CONCURRENCY,
      async (game) => {
        const [research, sales] = await Promise.all([
          freshResearchForGame(game),
          internalSalesForGame(game),
        ]);
        researched++;
        progress(
          "Researched " +
            game +
            " (" +
            researched +
            "/" +
            researchGames.length +
            ").",
        );
        progress(
          game +
            ": " +
            (research && research.scannedAt
              ? "market demand " +
                (research.demandScore != null ? research.demandScore : "?")
              : "no market data") +
            ", " +
            sales.count +
            " own sale(s) in 45d" +
            (sales.revenue > 0 ? " worth $" + sales.revenue.toFixed(2) : "") +
            ".",
        );
        return { game, research, sales };
      },
    );
    const infoByGame = new Map(
      researchedRows.map((row) => [
        row.game,
        { research: row.research, sales: row.sales },
      ]),
    );
    for (const c of candidates)
      infoMap.set(c.campaignId, infoByGame.get(c.game));

    // Snapshot which games manual bots are farming right now (one config
    // sweep across all hosts per tick; auto-bot files excluded via registry).
    const autoKeys = new Set();
    for (const t of autoTasks) {
      for (const b of t.bots || []) autoKeys.add(b.host + "|" + b.file);
    }
    // The stash sweep reads every config on every host — the most expensive
    // read in the tick — and feeds only the coverage gate of the campaigns
    // decided below. With nothing to decide (every game owned by the lane
    // engine, or simply a quiet calendar) it is skipped.
    if (candidates.length) {
      progress("Sweeping manual bot configs to identify the stash\u2026");
    }
    const farmMap =
      hostOnline && candidates.length
        ? await manualFarmMap(autoKeys)
        : { map: new Map(), wildcard: new Set(), logins: new Set() };
    progress(
      "Stash sweep done: " +
        farmMap.logins.size +
        " account(s) on manual bots across " +
        farmMap.map.size +
        " game(s) \u2014 held for long-term bundles, so they do NOT block " +
        "auto-farming and are excluded from the archive coverage count.",
    );

    // Unsold archive holders for every candidate game, in one aggregation,
    // split into stock this system can actually sell vs. stock it cannot (the
    // manual stash, and archive accounts belonging to no auto task).
    const owned = await ownedAccounts();
    const archiveHolders = await archiveHoldersByGame(
      candidates.map((c) => c.game),
      farmMap.logins,
      owned,
    );
    let stashedTotal = 0;
    let otherTotal = 0;
    for (const v of archiveHolders.values()) {
      stashedTotal += v.stashed || 0;
      otherTotal += v.other || 0;
    }
    progress(
      owned
        ? "Archive coverage: " +
            archiveHolders.size +
            " game(s) checked against the " +
            owned.size +
            " account(s) this system owns; excluded " +
            stashedTotal +
            " stashed on manual bots and " +
            otherTotal +
            " archive holder(s) its listings cannot deliver."
        : "Archive coverage: ownership lookup failed — counting every " +
            "non-stashed holder (conservative).",
      owned ? "info" : "warn",
    );

    // Fair-share budget across everything competing in this tick. Weights use
    // the blended demand (market + own sales) so proven sellers win supply.
    // The pristine reserve is not this engine's to spend (pristineProtect).
    const ready = await countReadyPool();
    const pristineHeld = await pristineProtect(af);
    const spendable = farmSpendable(ready, af.poolReserve, pristineHeld);
    const requests = [];
    for (const c of candidates) {
      const info = infoMap.get(c.campaignId);
      const alloc = demandAllocation(info.research, af, info.sales, {
        game: c.game,
      });
      if (alloc.skip) {
        requests.push({ key: c.campaignId, want: 0, weight: 0 });
      } else {
        requests.push({
          key: c.campaignId,
          want: Math.min(
            Math.max(alloc.target, alloc.probe ? 0 : marketStockFloor(af)),
            alloc.cap || af.maxPerGame,
          ),
          weight: Math.max(1, Number(alloc.effective || 0) || 5),
        });
      }
    }
    const budgetMap = fairShare(requests, spendable);

    // Phase timing (scan visibility): mark boundaries so "Scan complete" can
    // report where the tick spent its wall-clock. Timestamps only, no logic change.
    const decideStartMs = Date.now();
    const results = [];
    for (let index = 0; index < candidates.length; index++) {
      const c = candidates[index];
      try {
        progress(
          "Deciding " +
            c.game +
            " (" +
            (index + 1) +
            "/" +
            candidates.length +
            ", " +
            (c.name || c.campaignId) +
            ")\u2026",
        );
        const r = await processCampaign(c, {
          af,
          host,
          hostOnline,
          budgetMap,
          pristineProtect: pristineHeld,
          infoMap,
          farmMap,
          archiveHolders,
          owned,
          priorTasks,
          reusableMap,
          hostState,
        });
        progress(
          "Decided " +
            (index + 1) +
            "/" +
            candidates.length +
            ": " +
            c.game +
            " \u2192 " +
            (r && r.decision ? r.decision : "done") +
            ".",
        );
        results.push({ game: c.game, ...r });
      } catch (e) {
        progress(c.game + " FAILED: " + e.message, "error");
        if (!e.autoFarmEventRecorded) {
          await recordAutoFarmEvent({
            type: "task_failed",
            game: c.game,
            campaignId: c.campaignId,
            count: 1,
            reason: e.message || String(e),
            actor: "processCampaign",
          });
        }
        results.push({ game: c.game, error: e.message });
      }
    }
    const sweepStartMs = Date.now();
    progress(
      "Decisions done (" +
        results.length +
        " campaign(s)); running maintenance sweeps…",
    );
    // Suspension sweep runs before the dead-token reaper, because the reaper
    // cannot tell the two apart and its "keep it, the owner will re-auth" rule is
    // exactly wrong for an account Twitch has deleted: it holds its task slot and
    // its container seat forever, backfill reads the task as full and adds
    // nobody, and the owner is nudged to re-auth something that no longer exists.
    // Classifying them first is what turns "waiting for accounts" back into an
    // actual refill, and leaves the reaper the accounts it was written for.
    // Deletion is opt-in (af.purgeSuspended) — classify and release are
    // reversible, purging is not.
    if (!af.dryRun) {
      try {
        await suspendedAccounts.sweep({
          purge: af.purgeSuspended === true,
          limit: Number(af.suspendCheckLimit) || 0,
          onProgress: (m) => progress(m),
        });
      } catch (e) {
        progress("Suspension sweep failed: " + e.message, "warn");
      }
    }
    // Sold accounts whose token died — the buyer secured the account, so no
    // re-auth will ever revive it — leave the bot config they still occupy.
    // Opt-in (af.retireSoldDeadTokens); unsold dead accounts stay for re-auth.
    // See utils/deadTokenRetire.js.
    if (!af.dryRun && af.retireSoldDeadTokens === true) {
      try {
        await deadTokenRetire.retireSoldDeadTokens({
          hours: af.deadTokenRetireHours,
          onProgress: (m) => progress(m),
        });
      } catch (e) {
        progress("Dead-token retire failed: " + e.message, "warn");
      }
    }
    // Reap dead-token accounts out of task assignments, so the freed slots are
    // refilled with healthy accounts by the backfill sweep below on this same
    // tick (and the owner is nudged to re-auth the farmed ones).
    if (!af.dryRun) {
      try {
        const r = await reapDeadTokenAssignments(af, progress);
        if (r.unassigned) {
          progress(
            "Dead-token reaper: unassigned " +
              r.unassigned +
              " account(s); " +
              r.reauth +
              " farmed account(s) awaiting re-auth.",
          );
        }
      } catch (e) {
        progress("Dead-token reaper failed: " + e.message, "warn");
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
      // Recycle sweep (opt-in): return fully sold-out, safe-to-reuse accounts
      // to the pool so they re-farm. No-op unless af.recycleSoldAccounts.
      try {
        await recycleSoldOutAccounts(af, progress);
      } catch (e) {
        progress("Recycle failed: " + e.message, "warn");
      }
      // Probe stop-loss (opt-in): give up a cold-start probe that has run
      // probeMaxDays with 0 real sales. No-op unless af.probeColdStart.
      try {
        const gaveUp = await expireStaleProbes(af, progress);
        if (gaveUp) progress("Probe stop-loss: gave up on " + gaveUp + " probe(s).");
      } catch (e) {
        progress("Probe stop-loss failed: " + e.message, "warn");
      }
      // Repack sweep: merge half-empty auto containers back together.
      try {
        await repackAutoBots(af, host, progress);
      } catch (e) {
        progress("Repack failed: " + e.message, "warn");
      }
    }

    // Who lists a task in the two listing sweeps below: the SAME rule as who
    // decides (2026-10-03 review H1). Asking isOwned() alone read "not owned"
    // for every game while the cache was cold — in a deferred tick, or right
    // after an invalidate() — so this engine listed tasks a live lane owns, a
    // second Gameflip create racing the lane's own publish job. In main mode:
    // not while ownership is unknown, not for a game a lane owns or is about
    // to own; yes for what legacyMayDecide gives this engine, for a game it
    // took over after waiting for a lane (noteAwaitingLane), and — as before —
    // for the old tasks of no-claim games, which no lane ever takes. Outside
    // main mode this is exactly the old isOwned() test.
    const laneFallbackKeys = new Set(
      [...state.awaitingLaneTicks]
        .filter(([, w]) => laneFallbackDue(w, tickNow))
        .map(([key]) => key),
    );
    const legacyLists = (game) =>
      settings.isNoClaimGame(game) ||
      farm2Ownership.legacyMayDecide(game) ||
      (!ownershipUnknown && laneFallbackKeys.has(farm2Ownership.normKey(game)));

    // Refill sweep: every LISTED active task gets its markets topped up —
    // sold-out (or shorted) gameflip/plati/ggsel stock is refilled from
    // spare accounts, then the post-event holdback, no delist/relist.
    const listStartMs = Date.now();
    if (!af.dryRun) {
      const autoListerR = require("./autoLister");
      const listed = await AutoFarmTask.find({
        status: "active",
        "listing.externalId": { $nin: ["", null] },
      });
      // Visibility: this sweep makes serial marketplace API calls (Gameflip
      // rate-limits hard, so it is deliberately NOT parallelized) and used to
      // log only when it topped stock up — the long silent stretch that made a
      // tick feel stalled. Announce the workload + heartbeat every few tasks.
      if (listed.length) {
        progress(
          "Refilling markets on " + listed.length + " listed task(s)…",
        );
      }
      let refillDone = 0;
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
        // A secondary market that failed at listing time (e.g. a Digiseller
        // auth/permission error) leaves the task Gameflip-listed but with no
        // Plati/GGSel product. The auto-listing sweep below skips it (it only
        // claims tasks with NO Gameflip listing) and refill above can't help
        // (there is no product to top up), so without this the market would
        // stay unlisted forever. Retry it here \u2014 once the original cause is
        // cleared it self-heals, binding spare accounts to a fresh product.
        //
        // Games owned by a LIVE lane (utils/farm2/*) re-list through the lane's
        // own publish/secondaries job, which calls this same helper on its own
        // retry clock. Two callers on one task would race two Plati/GGSel
        // creates. Who re-lists here is legacyLists (above): the decision rule,
        // so with the lane engine off or stopped this engine re-lists every
        // game, and in main mode it never does while ownership is unknown.
        // Refill above is deliberately NOT gated: it tops up stock on an
        // existing product and the lane has no equivalent.
        try {
          const retried = !legacyLists(t.game)
            ? null
            : await autoListerR.retryMissingSecondaries(t);
          if (retried) {
            progress("Re-listed " + t.game + " on: " + retried.join(", "));
            await tg(
              "\ud83d\udecd Auto-relisted \u2014 " +
                t.game +
                "\n" +
                retried.join(", "),
            );
          }
        } catch (e) {
          progress("Re-list " + t.game + " failed: " + e.message, "warn");
        }
        refillDone += 1;
        if (listed.length > 8 && refillDone % 10 === 0) {
          progress(
            "Refill progress: " +
              refillDone +
              "/" +
              listed.length +
              " task(s) checked…",
          );
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
    let farm2ListSkipped = 0;
    for (const t of unlisted) {
      if (af.dryRun && t.wouldList && t.wouldList.title) continue; // previewed
      // Games owned by a LIVE lane (utils/farm2/*) are listed by the lane's
      // own publish/primary job — same listActivatedTask, own retry clock,
      // gated on a fresh holdings check. Listing here as well would race two
      // Gameflip creates on one task. The rule is legacyLists above — the
      // decision rule, so a deferred tick defers its listings too.
      if (!legacyLists(t.game)) {
        farm2ListSkipped++;
        continue;
      }
      try {
        progress("Auto-listing " + t.game + " on Gameflip\u2026");
        const r = await autoLister.listActivatedTask(t._id, {
          dryRun: af.dryRun,
        });
        if (r.listed) {
          await recordAutoFarmEvent({
            type: "listed",
            game: t.game,
            campaignId: t.campaignId,
            taskId: t._id,
            count: r.listed.qty || 0,
            reason: r.listed.title + " ($" + r.listed.price + ")",
            actor: "listActivatedTask",
          });
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
        // The process log is not somewhere an operator looks. listActivatedTask
        // records its own "waiting: ..." state on the task, so a task that keeps
        // THROWING (a campaign with no resolvable items, a Gameflip 429, a
        // ZeusX category that was never mapped) was the one failure mode that
        // left no trace at all: on the auto-farm page it looked exactly like a
        // healthy task still waiting for its first complete account.
        if (!af.dryRun) {
          await AutoFarmTask.updateOne(
            { _id: t._id },
            {
              $set: {
                "listing.error": ("auto-list failed: " + e.message).slice(
                  0,
                  400,
                ),
              },
            },
          ).catch(() => {});
        }
      }
    }

    if (farm2ListSkipped) {
      progress(
        "Left " +
          farm2ListSkipped +
          " unlisted task(s) to the lane engine (" +
          farm2Ownership.ownedKeys().join(", ") +
          ").",
      );
    }

    // Stacked-bundle sweep: tasks whose reused accounts hold earlier
    // campaigns' bundles TOO get a second, combined-bundle listing (old + new
    // events, combined price) — the solo listing above keeps selling the
    // current event alone. Live mode only; already-stacked tasks skip cheaply.
    if (!af.dryRun) {
      const stackable = await AutoFarmTask.find({
        status: "active",
        "listing.externalId": { $nin: ["", null] },
        $or: [
          { "stackListing.externalId": "" },
          { "stackListing.externalId": { $exists: false } },
        ],
      }).lean();
      // Visibility: same serial, rate-limited API tail as the refill sweep.
      if (stackable.length) {
        progress(
          "Checking " +
            stackable.length +
            " task(s) for stacked bundles…",
        );
      }
      let stackDone = 0;
      for (const t of stackable) {
        try {
          const r = await autoLister.listStackedBundle(t._id, {});
          if (r.listed) {
            progress(
              t.game +
                " STACKED bundle listed: " +
                r.listed.title +
                " ($" +
                r.listed.price +
                ", qty " +
                r.listed.qty +
                ") " +
                r.listed.url,
            );
            await tg(
              "\ud83d\udce6 Auto-listed STACKED bundle \u2014 " +
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
          }
        } catch (e) {
          progress(
            "Stacked listing " + t.game + " failed: " + e.message,
            "warn",
          );
        }
        stackDone += 1;
        if (stackable.length > 8 && stackDone % 10 === 0) {
          progress(
            "Stacked-bundle progress: " +
              stackDone +
              "/" +
              stackable.length +
              " task(s) checked…",
          );
        }
      }
    }

    // Per-phase wall-clock so "it takes forever" is attributable at a glance:
    // decide = campaign decisions; sweeps = suspension/dead-token/backfill/
    // reaper/recycle/repack; listing = serial marketplace refill + stacked
    // bundle API calls (the unavoidably slow, rate-limited path).
    const scanEndMs = Date.now();
    const phaseSecs = (a, b) => Math.max(0, Math.round((a - b) / 1000));
    progress(
      "Scan complete: " +
        results.length +
        " decision(s) this tick. Timing — decide " +
        phaseSecs(sweepStartMs, decideStartMs) +
        "s · sweeps " +
        phaseSecs(listStartMs, sweepStartMs) +
        "s · listing " +
        phaseSecs(scanEndMs, listStartMs) +
        "s · total " +
        phaseSecs(
          scanEndMs,
          progressLog.startedAt ? progressLog.startedAt.getTime() : scanEndMs,
        ) +
        "s.",
    );

    // Pool starvation is the one condition that silently stops everything: with
    // spendable at 0 no campaign can be decided and no active task can be
    // topped up, yet every previous surface for it was a muted number in the
    // UI. Alert once, then stay quiet for STARVATION_COOLDOWN_MS — the point of
    // today's notification work was to stop crying wolf, so this must not
    // become the next per-tick spam. Deliberately placed AFTER every sweep and
    // wrapped, so a Telegram hiccup can never abort a tick's real work.
    try {
      const starving = !af.dryRun && spendable < 1;
      if (starving) {
        const due =
          !state.lastPoolAlertAt ||
          Date.now() - state.lastPoolAlertAt > STARVATION_COOLDOWN_MS;
        const underTarget = await AutoFarmTask.countDocuments({
          status: "active",
        });
        if (due && underTarget > 0) {
          state.lastPoolAlertAt = Date.now();
          await tg(
            "⚠️ Auto-farm STARVED — pool has " +
              ready +
              " ready but the reserve floor is " +
              af.poolReserve +
              (pristineHeld
                ? " and " +
                  pristineHeld +
                  " pristine account(s) are kept for rent-farm orders"
                : "") +
              ", so 0 are spendable.\n" +
              "Nothing can be farmed or topped up until the pool refills or the " +
              "reserve is lowered. " +
              underTarget +
              " active task(s) affected.",
          );
        }
      } else if (state.lastPoolAlertAt) {
        // Recovered — clear the latch so the next starvation alerts promptly.
        state.lastPoolAlertAt = 0;
      }
    } catch {
      /* alerting must never break a tick */
    }

    // A tick that deferred its decisions finished, but did not do its job:
    // it is not ok (the health board reads lastOkAt), and says why.
    if (ownershipUnknown) {
      state.lastError =
        "decisions deferred: lane ownership unknown (" +
        state.deferredTicks +
        " tick(s) in a row)";
    } else {
      state.lastError = "";
      state.lastOkAt = new Date();
    }
    state.lastSummary = {
      enabled: true,
      dryRun: af.dryRun,
      host: host ? host.id : null,
      hostOnline,
      poolReady: ready,
      poolSpendable: spendable,
      pristineHeld,
      candidates: candidates.length,
      decisionsDeferred: ownershipUnknown,
      awaitingLane: [...awaitingLane],
      laneFallback: [...laneFallback],
      completed,
      catalogChanges,
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

// Dead-token reaper + re-auth alert. A Twitch token that has died can no longer
// farm, yet its account still occupies a slot in a task's assignedAccounts —
// which holds `have` at target so backfillActiveTasks never tops the task up
// with a live farmer, and the task quietly stops producing sellable stock (this
// is exactly why farmed campaigns were sitting unlisted). This UN-ASSIGNS the
// dead accounts that hold NOTHING for the task's game (pure dead weight —
// backfill then refills the freed slots with healthy accounts on the SAME tick),
// while KEEPING dead accounts that already farmed drops for this game assigned
// (their stock is real and becomes sellable the instant the token is re-minted)
// and surfacing those via Telegram so the owner runs the device-auth tool.
// Never deletes a BotAccount or a drop — every account stays re-authable; and it
// only edits task.assignedAccounts (no bot-config surgery). Off only when
// af.reapDeadAssignments === false.
let lastReauthAlertAt = 0;
async function reapDeadTokenAssignments(af, progress) {
  if (af.dryRun || af.reapDeadAssignments === false) {
    return { unassigned: 0, reauth: 0 };
  }
  const BotAccount = require("../models/BotAccount");
  const DEAD = ["token_invalid", "error", "suspended"];
  const tasks = await AutoFarmTask.find({ status: "active" });
  let unassigned = 0;
  const reauthByGame = new Map();
  for (const task of tasks) {
    const logins = (task.assignedAccounts || []).map((u) =>
      String(u).toLowerCase(),
    );
    if (!logins.length) continue;
    const dead = await BotAccount.find(
      { login: { $in: logins }, lastScanStatus: { $in: DEAD } },
      { _id: 1, login: 1, lastScanStatus: 1 },
    ).lean();
    if (!dead.length) continue;
    // Which of these dead accounts hold real, unsold, unconnected drops FOR THIS
    // game — those are farmed progress worth preserving for re-auth. One
    // aggregation per task keeps the Atlas round-trips low.
    const deadIds = dead.map((a) => a._id);
    let keepIds = new Set();
    try {
      const holders = await DropLog.aggregate([
        {
          $match: {
            account: { $in: deadIds },
            game: task.game,
            itemKey: { $ne: "" },
            connected: { $ne: true },
            soldAt: null,
          },
        },
        { $group: { _id: "$account" } },
      ]);
      keepIds = new Set(holders.map((h) => String(h._id)));
    } catch {
      // If the holdings check fails, keep everyone (never unassign blind).
      keepIds = new Set(deadIds.map((id) => String(id)));
    }
    const weightLogins = new Set();
    let heldForReauth = 0;
    for (const a of dead) {
      // Holding drops only earns a reprieve if a re-auth could actually recover
      // them. An account Twitch has deleted is never coming back, so keeping it
      // pins the slot forever and nudging the owner to re-mint its token asks for
      // something impossible — it is dead weight no matter what it farmed.
      const reauthable = a.lastScanStatus !== "suspended";
      if (reauthable && keepIds.has(String(a._id))) heldForReauth++;
      else weightLogins.add(String(a.login).toLowerCase());
    }
    if (weightLogins.size) {
      task.assignedAccounts = (task.assignedAccounts || []).filter(
        (u) => !weightLogins.has(String(u).toLowerCase()),
      );
      await task.save();
      unassigned += weightLogins.size;
      await recordAutoFarmEvent({
        type: "dead_token_pulled",
        game: task.game,
        campaignId: task.campaignId,
        taskId: task._id,
        count: weightLogins.size,
        reason: "dead-token accounts removed from task assignments",
        actor: "reapDeadTokenAssignments",
      });
      progress(
        "Reaped " +
          weightLogins.size +
          " dead-token account(s) from " +
          task.game +
          " — backfill will replace them.",
      );
    }
    if (heldForReauth) {
      reauthByGame.set(
        task.game,
        (reauthByGame.get(task.game) || 0) + heldForReauth,
      );
    }
  }
  const reauthTotal = [...reauthByGame.values()].reduce((a, b) => a + b, 0);
  // Nudge at most once every 12h: enough to prompt a re-auth run, not spam.
  if (reauthTotal > 0 && Date.now() - lastReauthAlertAt > 12 * 3600 * 1000) {
    lastReauthAlertAt = Date.now();
    const lines = [...reauthByGame.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([g, n]) => "• " + g + ": " + n)
      .join("\n");
    await tg(
      "🔑 Re-auth needed — " +
        reauthTotal +
        " farmed account(s) can't be listed until their Twitch token is re-minted:\n" +
        lines +
        "\n\nExport /account-pool/export-needs-auth?source=all → device-auth tool.",
    );
  }
  return { unassigned, reauth: reauthTotal };
}

// Backfill: active tasks whose account count is below their tier target get
// topped up as the pool refills — "the more accounts I add to the pool, the
// more it fetches to fill the gaps". Respects the reserve floor and container
// slots; new accounts go into NEW bots (existing containers keep running
// untouched). The Gameflip listing grows too, keeping the half-now /
// half-post-event split.
async function backfillActiveTasks(af, host, progress) {
  if (af.dryRun || !host) return 0;
  // Highest demand first, not oldest first. With a scarce pool the old
  // executedAt ordering let whichever campaign happened to run earliest drain
  // the refill before proven sellers were served — and backfill is where most
  // of the pool actually goes (140 of 174 claims in a day on prod).
  const tasks = await AutoFarmTask.find({ status: "active" }).sort({
    demandScore: -1,
    executedAt: 1,
  });
  const suspendedLogins = await suspendedAccounts
    .suspendedLoginSet()
    .catch(() => new Set());
  // No-claim games (Overwatch/Rainbow Six) are handled by the standalone
  // system: never spend more pool accounts topping up an old-system task for
  // one (existing accounts stay put — leave as-is — they just don't grow).
  const spendable = tasks.filter((t) => !settings.isNoClaimGame(t.game));
  const noClaimTopSkipped = tasks.length - spendable.length;
  if (noClaimTopSkipped)
    progress(
      "Backfill: skipping " +
        noClaimTopSkipped +
        " no-claim task(s) (Overwatch/Rainbow Six).",
    );
  // Fresh accounts cannot finish a drop that ends in a few hours, so a task
  // whose campaign is inside the same time gate that blocks new farming is not
  // worth spending on either.
  const worthTopping = spendable.filter(
    (t) =>
      !t.campaignEndAt ||
      hoursLeft(t.campaignEndAt) >= af.minHoursLeft ||
      isForcedGame(t.game, af),
  );
  if (worthTopping.length < spendable.length) {
    progress(
      "Backfill: skipping " +
        (spendable.length - worthTopping.length) +
        " task(s) whose campaign ends within " +
        af.minHoursLeft +
        "h.",
    );
  }
  // Never let one game absorb an entire refill: cap this tick's backfill at
  // half of what is spendable so a fresh campaign can still be started.
  // Spendable leaves the pristine reserve alone, as everywhere a farm spends.
  const readyNow = await countReadyPool();
  const backfillCap = Math.max(
    1,
    Math.floor(
      farmSpendable(readyNow, af.poolReserve, await pristineProtect(af)) / 2,
    ),
  );
  let added = 0;
  // Per-pass memo for capForGame's sales input (see the ceiling below).
  const backfillSales = new Map();
  for (const task of worthTopping) {
    if (added >= backfillCap) {
      progress(
        "Backfill: reached this tick's cap of " +
          backfillCap +
          " account(s); the rest stays available for new campaigns.",
      );
      break;
    }
    // A probe is a deliberately small market test (target = probeSize) — never
    // top it up to the market-shelf floor the way a proven farm is stocked, or
    // backfill would silently inflate every probe to marketStockFloor the tick
    // after it is created (decision path already exempts probes; this is the
    // matching exemption on the backfill side).
    const floor = task.decision === "probe" ? 0 : marketStockFloor(af);
    // The ceiling is the game's OWN cap, not the flat fleet maximum.
    //
    // This used to be a hard `af.maxPerGame * SALES_CAP_MULT_MAX`. Backfill is
    // where most of the pool actually goes (measured on prod: 140 of 174 claims
    // in a day), so a flat 60 here silently overrode every per-game decision
    // made upstream — a game with a raised cap could be decided at 120 and then
    // be topped up only to 60, and the operator's own `gameAccountCaps`
    // override was ignored entirely. capForGame is the single ceiling both
    // engines use; backfill has to read it too or it is the real policy.
    //
    // Sales are looked up once per GAME per pass, not once per task: several
    // tasks share a game and internalSalesForGame is a full aggregation.
    let gameSales = backfillSales.get(task.game);
    if (gameSales === undefined) {
      gameSales = await internalSalesForGame(task.game).catch(() => ({
        count: 0,
        revenue: 0,
        avgPrice: 0,
      }));
      backfillSales.set(task.game, gameSales);
    }
    const target = Math.min(
      Math.max(
        Number(task.targetAccounts) || Number(task.plannedAccounts) || 0,
        floor,
      ),
      capForGame(af, gameSales, task.game),
    );
    // Count only accounts that can still farm. The sweep above normally has
    // already unassigned the suspended ones, but this is the check that must not
    // be wrong: counting a dead account as supply is what silently starved
    // listing on prod — 583 suspended accounts held slots across the active
    // tasks, every task read as at-target, backfill added nobody, and no live
    // account ever held a full bundle to list while 1,471 healthy accounts sat
    // idle in the pool. A row that failed to save, or one classified after the
    // release phase, must not be able to reproduce that.
    // Accounts SOLD from this task stay in assignedAccounts and count here
    // (defect 10b, 2026-10-03: left as is on purpose — counting policy for the
    // farm brain's wiring; not counting them now would grow farming).
    const have = usableAssignedCount(task, suspendedLogins);
    const missing = target - have;
    if (missing < 1) continue;

    const ready = await countReadyPool();
    const protect = await pristineProtect(af);
    const spendable = farmSpendable(ready, af.poolReserve, protect);
    if (spendable < 1) {
      // Pool exhausted — later tasks can't get any either. Say so: this used to
      // break silently, so a fleet sitting far under target looked healthy
      // while nothing was being delivered tick after tick.
      progress(
        "Pool exhausted (" +
          ready +
          " ready, reserve " +
          af.poolReserve +
          (protect
            ? "; the pristine reserve is holding " +
              protect +
              " for rent-farm orders"
            : "") +
          ") — " +
          (worthTopping.length - worthTopping.indexOf(task)) +
          " task(s) left under target this tick.",
        "warn",
      );
      break;
    }

    // No new container while the farm host is short of RAM; free seats in
    // RUNNING bots are still filled (a parked one would have to restart).
    const activeBots = await activeAutoBotCount();
    const containers = await containerSlots(
      host,
      Math.max(0, af.maxAutoBots - activeBots),
    );
    const slotsFree = containers.slots;
    const runningOnly = containers.blocked;
    const freeSeats = await autoSeatCapacity(host, af, null, {
      runningOnly,
    }).catch(() => 0);
    if (slotsFree < 1 && freeSeats < 1) {
      if (containers.blocked) {
        progress(
          "Backfill: no new container (" +
            containers.reason +
            ") and no running bot has a free seat — the rest waits.",
          "warn",
        );
      }
      break;
    }

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
    // Reuse-only games (World of Tanks / UFL) top up ONLY from their own
    // "recycled after <game>" accounts — never a fresh pool account.
    //
    // The game is passed for EVERY task (2026-10-03). The other games used to
    // claim unscoped, so neither pass applied the soldGames exclusion: a
    // recycled account the buyer already holds for this very game could be
    // put back on it. Passing it also tries the game's own recycled accounts
    // first, exactly as executeTask's claim does.
    const reuseOnly = settings.isReuseOnlyGame(task.game);
    const claimed = await claimPoolAccounts(
      n,
      "auto-farm backfill: " + task.game + " (" + task.campaignId + ")",
      { preferGame: task.game, recycledOnly: reuseOnly },
    );
    if (!claimed.length) continue;

    const deployed = [];
    let error = "";
    try {
      const packed = await fillExistingBots(host, claimed, task.game, af, null, {
        runningOnly,
      });
      for (const pl of packed.placed) {
        const key = pl.bot.host + "|" + pl.bot.container;
        const already = (task.bots || []).some(
          (x) => x.host + "|" + x.container === key,
        );
        if (!already) task.bots.push(pl.bot);
        for (const a of pl.accounts) deployed.push(a);
      }
      const rest = packed.remaining;
      // Same container budget as executeTask: `slotsFree` was computed above
      // from maxAutoBots, and nothing may overrun it.
      let created = 0;
      let i = 0;
      for (; i < rest.length && created < slotsFree; i += af.accountsPerBot) {
        const batch = rest.slice(i, i + af.accountsPerBot);
        const bot = await botFactory.createBot(host, batch, task.game, {
          startRunning: true,
        });
        created++;
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
      if (i < rest.length) {
        const spare = rest.slice(i);
        await releasePoolAccounts(spare);
        progress(
          (containers.blocked && containers.requested >= 1
            ? "Backfill: no new container (" + containers.reason + ")"
            : "Backfill hit the container budget (" + af.maxAutoBots + " max)") +
            " — released " +
            spare.length +
            " unplaced account(s) back to the pool.",
          "warn",
        );
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
          bulkOfferId: null, // never grow a bulk pack's queue (docs/bulk-packs/CONTRACT.md H8)
        },
        { $inc: { qtyRemaining: addNow } },
      );
      task.listing.qty = (Number(task.listing.qty) || 0) + addNow;
      task.listing.heldBack = (Number(task.listing.heldBack) || 0) + addHold;
    }
    await task.save();
    added += deployed.length;
    await recordAutoFarmEvent({
      type: "topped_up",
      game: task.game,
      campaignId: task.campaignId,
      taskId: task._id,
      host: host.id,
      count: deployed.length,
      reason: "backfilled toward target " + target,
      actor: "backfillActiveTasks",
    });
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
  // Mark, don't delete. Deleting made every campaign look like it had never
  // been decided, so the next tick re-announced every skip as brand new (~60
  // Telegram messages from one button press) and threw away the decision log
  // this model's header calls its reason for existing. The flag makes the row
  // a candidate again while its previous decision stays readable, so an
  // unchanged verdict stays silent.
  const upd = await AutoFarmTask.updateMany(
    {
      campaignId: { $in: ids },
      status: { $in: ["skipped", "failed", "completed", "stopped"] },
    },
    { $set: { rescanRequested: true } },
  );
  return { cleared: upd.modifiedCount || 0, campaigns: ids.length };
}

function status() {
  return {
    started: state.started,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    nextRunAt: state.nextRunAt,
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

// Liveness for the health page (utils/systemHealth.js). Synchronous and never
// throws. `lastTickAt` is when the last tick FINISHED — a disabled tick still
// finishes, so an old value means the loop has stopped, not that the master
// switch is off; `enabled` says that. `lastOkAt` is the last tick that
// finished with no error and made its decisions (a tick that threw, or that
// deferred every decision for want of the lane table, is not ok); `lastError`
// is "" when the last tick was ok.
function loopStatus() {
  let enabled = false;
  try {
    enabled = cfg().enabled === true;
  } catch {
    enabled = !!(state.lastSummary && state.lastSummary.enabled);
  }
  return {
    lastTickAt: state.lastRun || null,
    lastOkAt: state.lastOkAt || null,
    lastError: state.lastError || "",
    intervalMin: TICK_MS / 60000,
    enabled,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    state.nextRunAt = null;
    try {
      await runOnce();
    } catch (err) {
      console.error("autoFarmer error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    state.nextRunAt = new Date(Date.now() + TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, FIRST_TICK_DELAY_MS);
  state.nextRunAt = new Date(Date.now() + FIRST_TICK_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = {
  // exported for the read-only allocation forecast (utils/allocationForecast.js).
  // The forecast reuses the SAME clamp-chain helpers the tick uses so its numbers
  // match the engine by construction; all are pure/DB-only (no host SSH).
  countReadyPool,
  marketStockFloor,
  researchForGame,
  archiveHoldersByGame,
  ownedAccounts,
  start,
  runOnce,
  rescanAll,
  status,
  // Liveness hook for the health page (utils/systemHealth.js).
  loopStatus,
  executeTask,
  completeEndedTasks,
  reapRetiredBots,
  recycleSoldOutAccounts,
  reapDeadTokenAssignments,
  expireStalePlans,
  repackAutoBots,
  // For the pool's Unclaim route (routes/accountPoolRoutes.js), which refuses
  // to hand back an auto-farm account a buyer holds or a listing sells — the
  // same sold / connected / listed / leased check every recycle path uses.
  unrecyclableLogins,
  // exported for tests
  fairShare,
  demandAllocation,
  capForGame,
  salesOf,
  internalSalesForGame,
  resolveFarmHost,
  isStranded,
  STRANDED_PLAN_MS,
  mapWithConcurrency,
  createSeatCounter,
  buildDecisionHostState,
  // Additive export for the lane engine's decide step (utils/farm2/steps/decide.js),
  // so a LIVE lane makes its decision on the same freshly-rescanned research this
  // engine would have used. Shadow lanes deliberately call researchForGame instead,
  // because a re-scan is a real side effect. No behaviour change here.
  freshResearchForGame,
  // Additive export for the lane engine's reuse-first check. Without it the lane
  // engine had no reuse path at all and always reached for FRESH pool accounts,
  // so a recurring campaign on a game that already has warm bots would have spent
  // real accounts and new containers to do worse than reusing what is running.
  // Caught by the shadow trial before any lane went live. Read-only query.
  reusableTaskForGame,
  // Additive exports for the lane engine's downstream gates
  // (utils/farm2/steps/decide.js). The lane previously implemented only the
  // sellability stage and reuse-first, so on any campaign this engine settles
  // with the host, time, coverage, pool-floor, capacity or reuse-only gate a
  // live lane would have carried on and spent. These let the lane run the SAME
  // gates from the SAME helpers instead of re-deriving them. All are read-only
  // (probeHost, manualFarmMap and autoSeatCapacity read the host, never write
  // to it). No behaviour change to this engine.
  probeHost,
  isForcedGame,
  manualFarmMap,
  activeAutoBotCount,
  autoSeatCapacity,
  readyPoolQuery,
  isAutoFarmClaimNote,
  recyclableClaimQuery,
  WILDCARD_CREDIT_CAP,
  COUNT_MANUAL_AS_COVERAGE,
  // Additive export so the per-campaign decision can be driven directly by a
  // test (tests/farm2DecisionInputs.test.js exercises the real record() path on
  // the two branches that need no host). runOnce is unchanged.
  processCampaign,
  // Additive export for the lane engine's candidate filter (utils/farm2/lane.js):
  // which skips are re-decided every tick. The lane used to re-decide EVERY
  // campaign every cycle (5,400 decide rows a day on prod, one campaign decided
  // 177 times); it now re-decides on exactly this engine's triggers, from this
  // engine's own set, so the two cannot drift.
  RETRYABLE,
  // Additive exports for the lane engine (utils/farm2/budget.js and
  // steps/decide.js), so both engines take the pristine reserve and the host
  // RAM gate off their budgets with ONE implementation (2026-10-03).
  pristineProtect,
  // The lane-missing fallback rule (exported for tests).
  laneFallbackDue,
  LANE_FALLBACK_MS,
  LANE_FALLBACK_TICKS,
  containerSlots,
  farmSpendable,
  poolShortReason,
  capacityShortReason,
  // Pure: how quantity-listing units pair with buyer connections (exported
  // for tests; internalSalesForGame is the caller).
  pairQuantityUnits,
};
