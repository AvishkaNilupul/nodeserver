// Live-defect fixes 2026-10-03, section A3 of docs/LIVE-FIXES-1003.md: the
// claim farm (utils/autoFarmer.js) and the lane engine's ownership, supervisor,
// budget and decide steps.
//
// No database and no network. Every module that would reach a host, a
// marketplace, Telegram or a route is replaced through Module._load before the
// engine loads (matched on the RESOLVED path, so "./settings", "../settings"
// and "../../settings" all get the same stub), and the Mongoose models' statics
// are replaced before every test. The pristine-reserve, host-RAM and
// farmControl helpers belong to sibling sections (A5, A7); they are stubbed
// here to the signatures the contract fixes for them (§2, §A7).
//
// SaleSignal.aggregate runs through a small evaluator of the aggregation
// stages these pipelines use, so the SAME rows can go through the engine and
// through the pipeline production ran before (oldInternalSales below).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/* ------------------------------ module stubs ------------------------------ */

const UTILS = path.join(__dirname, "..", "utils");
const STUBS = new Map();
function stub(rel, obj) {
  STUBS.set(path.join(UTILS, rel), obj);
  return obj;
}
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && /^\.\.?\//.test(request)) {
    const abs = path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, "");
    if (STUBS.has(abs)) return STUBS.get(abs);
  }
  return realLoad.call(this, request, parent, isMain);
};

// The auto-farm settings every engine reads, fixed and mutable per test.
// Production's shape on 2026-10-02: Plati switched off, GGSel on.
const AF0 = Object.freeze({
  enabled: true,
  dryRun: true,
  hostId: "",
  maxPerGame: 30,
  accountsPerBot: 10,
  poolReserve: 20,
  probeSize: 5,
  probeColdStart: false,
  probeMaxSellers: 1,
  probeMaxGames: 8,
  probeMaxDays: 30,
  probeCooldownDays: 90,
  maxAutoBots: 20,
  minHoursLeft: 12,
  perMarketStock: 3,
  platiCategoryId: "34187",
  platiEnabled: false,
  ggselEnabled: true,
  consolidate: false,
  deleteFinishedBots: true,
  stopFinishedBots: false,
  reapDeadAssignments: true,
  retireSoldDeadTokens: false,
  recycleSoldAccounts: false,
  farm2Enabled: false,
  farm2Main: false,
  pristineReserve: 150,
  hostMinFreeMb: 1500,
});
let AF = { ...AF0 };
const REUSE_ONLY = new Set();
stub("settings", {
  getAutoFarm: () => ({ ...AF }),
  isNoClaimGame: () => false,
  isReuseOnlyGame: (g) => REUSE_ONLY.has(String(g)),
  normGameName: (g) =>
    String(g || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  getFarmSizing: () => ({
    enabled: false,
    gameCaps: {},
    maxPerGame: 250,
    coverageDays: 28,
    safetyStock: 6,
    coverageDaysFor: () => 28,
    safetyStockFor: () => 6,
    maxFor: () => 250,
  }),
  gameAccountCapFor: () => 0,
});

let calls;
function resetCalls() {
  calls = {
    records: [],
    claims: [],
    claimed: 0,
    noted: [],
    ram: [],
    restartIfRunning: [],
    docker: [],
    createBot: [],
    addToBot: [],
    usage: [],
    lanesRead: 0,
    requeue: 0,
    counted: [],
  };
}
resetCalls();

// utils/pristineReserve.js (§2): farmGuard / farmClaimFilter / noteClaimed.
const GUARD = { protect: 0, filter: {} };
stub("pristineReserve", {
  farmGuard: async () => ({
    reserve: GUARD.protect,
    pristine: GUARD.protect,
    headroom: 0,
    protect: GUARD.protect,
  }),
  farmClaimFilter: async () => GUARD.filter,
  noteClaimed: (doc) => calls.noted.push(doc),
});

// utils/hostCapacity.js (§2): newContainerAllowed(hostId).
const RAM = { ok: true };
stub("hostCapacity", {
  newContainerAllowed: async (hostId) => {
    calls.ram.push(hostId);
    return RAM.ok
      ? { ok: true, availableMb: 4000, minFreeMb: 1500, reason: "" }
      : { ok: false, availableMb: 900, minFreeMb: 1500, reason: "below minimum" };
  },
  memAvailableMb: async () => null,
  lastReading: () => null,
});

// utils/farmControl.js (§A7): restartIfRunning(host, container) -> { restarted, state }.
const farmControl = stub("farmControl", {});

const HOST = { id: "contabo", label: "Contabo", transport: "ssh" };
const hosts = stub("botHosts", {});
function resetHosts() {
  for (const k of Object.keys(hosts)) delete hosts[k];
  Object.assign(hosts, {
    listHosts: () => [],
    resolveHost: (id) => (id === "contabo" ? HOST : null),
    readdir: async () => ["config.json"],
    readFile: async (h, f) => {
      throw new Error("not found: " + f);
    },
    readFiles: async () => ({}),
    exists: async () => false,
    dockerPs: async () => ({}),
    dockerContainer: async (h, action, container) => {
      calls.docker.push({ action, container });
    },
    restoreRestartPolicy: async () => {},
    writeFileAtomic: async () => {},
    saveSnapshot: async () => {},
  });
}
resetHosts();

stub("botFactory", {
  usedSeats: (data) =>
    ((data && data.TwitchSettings && data.TwitchSettings.TwitchUsers) || []).filter(
      (u) => u && u.Enabled !== false,
    ).length,
  createBot: async (host, batch, game) => {
    calls.createBot.push({ game, n: batch.length });
    const k = calls.createBot.length;
    return { host: host.id, file: "config_9" + k + ".json", container: "twitchbotx9" + k, config: {} };
  },
  addAccountsToBot: async (host, file, batch) => {
    calls.addToBot.push({ file, n: batch.length });
    return { logins: batch.map((a) => a.username), added: batch.length, changed: true, data: null };
  },
  startContainer: async () => {},
  stopContainer: async () => {},
  deleteBot: async () => {},
});
stub("botWaker", {
  wakeFinishedBots: async () => ({ woken: [] }),
  parkIdleBots: async () => ({ parked: [] }),
  parkIdleNoCampaignBots: async () => ({ parked: [] }),
  stopFinishedBots: async () => ({ stopped: [] }),
  readRegistry: async () => ({}),
});
stub("marketplaces", { keyStatus: () => ({ ggsel: { configured: true } }) });
stub("marketResearch", { refreshGame: async () => null });
stub("telegram", { sendTelegram: async () => {} });
stub("suspendedAccounts", { sweep: async () => ({}), suspendedLoginSet: async () => new Set() });
stub("deadTokenRetire", { retireSoldDeadTokens: async () => ({}) });
stub("poolUsageLog", {
  recordPoolUsage: async (id, ev) => {
    calls.usage.push(ev);
  },
});
stub("autoFarmEventLog", { recordAutoFarmEvent: async () => {} });
stub("catalogPreorder", { stampPreorderSet: async () => {} });
stub("../routes/catalogRoutes", {
  updateAutofarmCatalogStates: async () => 0,
  startVariantSync: () => false,
  invalidateCatalogCache: () => {},
});
stub("autoLister", {
  onCampaignEnded: async () => ({}),
  campaignItems: () => [],
  derivePrice: () => 0,
  refillMarkets: async () => null,
  retryMissingSecondaries: async () => null,
  listActivatedTask: async () => ({}),
  listStackedBundle: async () => ({}),
});
stub("systemLog", { logEvent: () => {} });
stub("farm2/jobs", {
  requeueStale: async () => {
    calls.requeue += 1;
    return 0;
  },
  pruneHistory: async () => 0,
});
stub("farm2/lane", {
  runLane: async () => {
    throw new Error("no lane may run in these tests");
  },
});
stub("farm2/notify", { telegram: async () => {} });

const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const AvailableAccount = require("../models/AvailableAccount");
const SaleSignal = require("../models/SaleSignal");
const DropLog = require("../models/DropLog");
const FarmLane = require("../models/FarmLane");
const BotAccount = require("../models/BotAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const RenterAccount = require("../models/RenterAccount");

const autoFarmer = require("../utils/autoFarmer");
const ownership = require("../utils/farm2/ownership");
const supervisor = require("../utils/farm2/supervisor");
const budget = require("../utils/farm2/budget");
const decide = require("../utils/farm2/steps/decide");
const { normGame } = require("../utils/gameLabel");

test.after(() => {
  Module._load = realLoad;
  ownership.setEngineRunning(false);
});

/* ------------------------------ query stubs ------------------------------- */

// A Mongoose query stand-in: chainable, awaitable, .catch-able. An Error value
// rejects; a function value is called when the query is awaited.
function q(value) {
  const settle = () => {
    try {
      const v = typeof value === "function" ? value() : value;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const chain = {
    lean: () => chain,
    sort: () => chain,
    select: () => chain,
    limit: () => chain,
    then: (ok, bad) => settle().then(ok, bad),
    catch: (bad) => settle().catch(bad),
  };
  return chain;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

let ACTIVE_TASKS;
let LIVE;
let CAMPAIGNS;
let SALES;
let READY;
let LANES;

function isActiveTaskQuery(filter) {
  return (
    !!filter &&
    filter.status === "active" &&
    !filter.$or &&
    !Object.prototype.hasOwnProperty.call(filter, "listing.externalId")
  );
}

test.beforeEach(() => {
  AF = { ...AF0 };
  REUSE_ONLY.clear();
  GUARD.protect = 0;
  GUARD.filter = {};
  RAM.ok = true;
  for (const k of Object.keys(farmControl)) delete farmControl[k];
  farmControl.restartIfRunning = async (host, container) => {
    calls.restartIfRunning.push({ host, container });
    return { restarted: false, state: "exited" };
  };
  resetHosts();
  resetCalls();
  ACTIVE_TASKS = [];
  LIVE = [];
  CAMPAIGNS = new Map();
  SALES = [];
  READY = 100;
  LANES = () => [];
  ownership.setEngineRunning(false);

  AutoFarmTask.find = (filter = {}) =>
    q(() => {
      if (!isActiveTaskQuery(filter)) return [];
      const not = filter._id && filter._id.$ne;
      return ACTIVE_TASKS.filter((t) => not === undefined || String(t._id) !== String(not));
    });
  AutoFarmTask.findOne = () => q(null);
  AutoFarmTask.findOneAndUpdate = (f, u) => {
    calls.records.push(u.$set);
    return q({ _id: "row-" + calls.records.length, ...u.$set });
  };
  AutoFarmTask.updateOne = () => q({ modifiedCount: 1 });
  AutoFarmTask.updateMany = () => q({ modifiedCount: 0 });
  AutoFarmTask.countDocuments = () => q(0);
  AutoFarmTask.exists = () => q(null);
  TwitchCampaign.find = () => q(() => LIVE);
  TwitchCampaign.findOne = (f) =>
    q(
      () =>
        CAMPAIGNS.get(f.campaignId) || {
          campaignId: f.campaignId,
          status: "ACTIVE",
          endAt: hoursFromNow(48),
        },
    );
  MarketResearch.findOne = () => q(null);
  AvailableAccount.countDocuments = (filter) => {
    calls.counted.push(filter);
    return q(() => READY);
  };
  AvailableAccount.findOneAndUpdate = (filter) => {
    calls.claims.push(filter);
    // No recycled ("recycled after <game>") account is free in these
    // fixtures, so the affinity pass finds nothing and the generic pass
    // supplies every claim.
    const base = filter.$and ? filter.$and[0] : filter;
    if (base.claimedNote) return q(null);
    calls.claimed += 1;
    const i = calls.claimed;
    return q({ _id: "acc" + i, username: "acc" + i, usernameLower: "acc" + i, clientSecret: "secret" + i });
  };
  AvailableAccount.find = () => q([]);
  AvailableAccount.updateMany = () => q({ modifiedCount: 0 });
  SaleSignal.aggregate = (pipeline) => Promise.resolve(runPipeline(SALES, pipeline));
  DropLog.aggregate = async () => [];
  DropLog.distinct = () => q([]);
  FarmLane.find = () => {
    calls.lanesRead += 1;
    return q(() => LANES());
  };
  BotAccount.find = () => q([]);
  MarketplaceListing.find = () => q([]);
  RenterAccount.find = () => q([]);
});

/* ------------------- aggregation evaluator (SaleSignal) ------------------- */

const getPath = (doc, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
const isOp = (o) =>
  !!o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  !(o instanceof Date) &&
  !(o instanceof RegExp) &&
  Object.keys(o).length > 0 &&
  Object.keys(o).every((k) => k.startsWith("$"));
const num = (v) => (v instanceof Date ? v.getTime() : v);
const cmp = (a, b) => (num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0);
const same = (a, b) => (a == null && b == null) || num(a) === num(b);

function expr(e, doc) {
  if (typeof e === "string") return e.startsWith("$") ? getPath(doc, e.slice(1)) : e;
  if (Array.isArray(e)) return e.map((x) => expr(x, doc));
  if (isOp(e)) {
    const [op] = Object.keys(e);
    const a = e[op];
    if (op === "$ifNull") {
      const v = expr(a[0], doc);
      return v == null ? expr(a[1], doc) : v;
    }
    if (op === "$cond") {
      const [c, t, f] = Array.isArray(a) ? a : [a.if, a.then, a.else];
      return expr(c, doc) ? expr(t, doc) : expr(f, doc);
    }
    if (op === "$gt") {
      const [x, y] = expr(a, doc);
      return x != null && cmp(x, y) > 0;
    }
    if (op === "$toLower") {
      const v = expr(a, doc);
      return v == null ? "" : String(v).toLowerCase();
    }
    throw new Error("evaluator: unsupported expression " + op);
  }
  return e;
}

function valueMatches(cond, v) {
  if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
  if (!isOp(cond)) return same(cond, v);
  return Object.entries(cond).every(([op, arg]) => {
    if (op === "$in") return arg.some((x) => valueMatches(x, v));
    if (op === "$gte") return v != null && cmp(v, arg) >= 0;
    if (op === "$gt") return v != null && typeof v === typeof arg && cmp(v, arg) > 0;
    if (op === "$ne") return !same(arg, v);
    if (op === "$not") return !valueMatches(arg, v);
    throw new Error("evaluator: unsupported query operator " + op);
  });
}

function matches(query, doc) {
  return Object.entries(query).every(([k, cond]) => {
    if (k === "$and") return cond.every((c) => matches(c, doc));
    if (k === "$or") return cond.some((c) => matches(c, doc));
    if (k === "$nor") return !cond.some((c) => matches(c, doc));
    return valueMatches(cond, getPath(doc, k));
  });
}

function group(docs, spec) {
  const groups = new Map();
  for (const d of docs) {
    const id = expr(spec._id, d);
    const key = JSON.stringify(id == null ? null : num(id));
    if (!groups.has(key)) groups.set(key, { id: id == null ? null : id, docs: [] });
    groups.get(key).docs.push(d);
  }
  return [...groups.values()].map(({ id, docs: ds }) => {
    const out = { _id: id };
    for (const [field, acc] of Object.entries(spec)) {
      if (field === "_id") continue;
      const [op] = Object.keys(acc);
      const vals = ds.map((d) => expr(acc[op], d));
      const present = vals.filter((v) => v != null);
      if (op === "$sum") out[field] = vals.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
      else if (op === "$max")
        out[field] = present.reduce((m, v) => (m == null || cmp(v, m) > 0 ? v : m), null);
      else if (op === "$min")
        out[field] = present.reduce((m, v) => (m == null || cmp(v, m) < 0 ? v : m), null);
      else if (op === "$addToSet")
        out[field] = [...new Map(present.map((v) => [JSON.stringify(num(v)), v])).values()];
      else throw new Error("evaluator: unsupported accumulator " + op);
    }
    return out;
  });
}

function project(d, spec) {
  const out = {};
  if (spec._id !== 0 && spec._id !== false && d._id !== undefined) out._id = d._id;
  for (const [k, v] of Object.entries(spec)) {
    if (k !== "_id" && v && d[k] !== undefined) out[k] = d[k];
  }
  return out;
}

function runPipeline(rows, pipeline) {
  let docs = rows.map((r) => ({ ...r }));
  for (const stage of pipeline) {
    const [name] = Object.keys(stage);
    const arg = stage[name];
    if (name === "$match") docs = docs.filter((d) => matches(arg, d));
    else if (name === "$group") docs = group(docs, arg);
    else if (name === "$project") docs = docs.map((d) => project(d, arg));
    else if (name === "$facet")
      docs = [Object.fromEntries(Object.entries(arg).map(([k, p]) => [k, runPipeline(docs, p)]))];
    else throw new Error("evaluator: unsupported stage " + name);
  }
  return docs;
}

// The pipeline production ran before 2026-10-03, verbatim, finished the same way.
function oldInternalSales(rows, game) {
  const cutoff = new Date(Date.now() - 45 * 86400000);
  const [r] = runPipeline(rows, [
    {
      $match: {
        gameKey: String(game).toLowerCase(),
        at: { $gte: cutoff },
        source: { $in: ["connected", "listing_sold"] },
      },
    },
    {
      $group: {
        _id: { $ifNull: ["$account", "$dedupeKey"] },
        priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        revenue: { $sum: "$priceUsd" },
        priced: { $sum: { $cond: [{ $gt: ["$priceUsd", 0] }, 1, 0] } },
      },
    },
  ]);
  const x = r || { count: 0, revenue: 0, priced: 0 };
  const revenue = Math.round((x.revenue || 0) * 100) / 100;
  return {
    count: x.count || 0,
    revenue,
    avgPrice: x.priced ? Math.round((revenue / x.priced) * 100) / 100 : 0,
  };
}

let seq = 0;
function signal(over) {
  seq += 1;
  return {
    game: "World of Tanks",
    gameKey: "world of tanks",
    login: "",
    account: null,
    priceUsd: 0,
    dedupeKey: "k" + seq,
    at: hoursAgo(24),
    ...over,
  };
}
const connected = (login, account, at, over = {}) =>
  signal({ source: "connected", login, account, at, dedupeKey: "connected:" + account + ":" + (seq + 1), ...over });
const quantityUnit = (pool, at, priceUsd, over = {}) =>
  signal({ source: "listing_sold", login: pool, priceUsd, at, marketplace: "ggsel", ...over });

/* ========================== defect 8: ownership ========================== */

const campaign = (game, id) => ({
  game,
  campaignId: id,
  name: game + " weekly",
  active: true,
  status: "ACTIVE",
  endAt: hoursFromNow(48),
});

function mainMode() {
  AF = { ...AF, farm2Enabled: true, farm2Main: true };
}

function progressLines() {
  return autoFarmer.status().progress.steps.map((s) => s.msg);
}

test("ensureFresh reads a stale lane table before the hot loop asks", async () => {
  mainMode();
  LANES = () => [{ gameKey: "albion online" }];
  ownership.setEngineRunning(true);
  assert.equal(ownership.isCold(), true, "fixture: a fresh start is cold");
  await ownership.ensureFresh();
  assert.equal(calls.lanesRead, 1);
  assert.equal(ownership.isCold(), false);
  assert.equal(ownership.isOwned("Albion Online"), true);
  // Fresh now: a second call inside the TTL reads nothing.
  await ownership.ensureFresh();
  assert.equal(calls.lanesRead, 1);
});

test("ensureFresh never throws, and an unreadable lane table leaves ownership cold", async () => {
  mainMode();
  FarmLane.find = () => {
    calls.lanesRead += 1;
    throw new Error("db down");
  };
  ownership.setEngineRunning(true);
  await assert.doesNotReject(ownership.ensureFresh());
  assert.equal(calls.lanesRead, 1);
  assert.equal(ownership.isCold(), true);
  assert.equal(ownership.isOwned("Albion Online"), false, "still the safe answer for the hot loop");
});

test("a lane read that throws synchronously does not wedge every later refresh (old bytes: stuck)", async () => {
  mainMode();
  ownership.setEngineRunning(true);
  FarmLane.find = () => {
    throw new Error("model failed to load");
  };
  await ownership.refresh();
  FarmLane.find = () => {
    calls.lanesRead += 1;
    return q([{ gameKey: "albion online" }]);
  };
  await ownership.refresh();
  assert.equal(calls.lanesRead, 1, "the second refresh really read the table");
  assert.equal(ownership.isOwned("Albion Online"), true);
});

test("a failed read after a good one is cold, not a warm empty set", async () => {
  mainMode();
  LANES = () => [{ gameKey: "albion online" }];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  assert.equal(ownership.isCold(), false);
  LANES = () => new Error("db down");
  await ownership.refresh();
  assert.equal(ownership.isCold(), true);
  assert.deepEqual(ownership.ownedKeys(), []);
});

test("ensureFresh reads nothing while the lane engine is stopped or switched off, and is never cold then", async () => {
  mainMode();
  ownership.setEngineRunning(false);
  await ownership.ensureFresh();
  assert.equal(ownership.isCold(), false, "a stopped lane engine must never block the legacy engine");
  ownership.setEngineRunning(true);
  AF = { ...AF, farm2Enabled: false };
  await ownership.ensureFresh();
  assert.equal(ownership.isCold(), false);
  assert.equal(calls.lanesRead, 0);
});

test("main mode, lane table unreadable: the legacy tick defers every decision (old bytes decided them all)", async () => {
  mainMode();
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  const summary = await autoFarmer.runOnce();
  assert.equal(summary.candidates, 0);
  assert.deepEqual(calls.records, [], "no AutoFarmTask decision row was written");
  assert.ok(
    progressLines().some((m) => m.startsWith("decisions deferred: lane ownership unknown")),
    "the tick says why it decided nothing",
  );
});

test("main mode right after a boot or lane auto-create: the lane table is read first, so a lane's game is left to its lane", async () => {
  // The 10-02 00:01 The Quinfall shape: the cache was cold, the table was
  // readable, and the legacy tick still decided the lane's game.
  mainMode();
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  LANES = () => [{ gameKey: "game a" }];
  ownership.setEngineRunning(true); // cold, exactly as at boot
  await autoFarmer.runOnce();
  assert.deepEqual(
    calls.records.map((r) => r.game),
    ["Game B"],
  );
});

test("main mode with a warm cache decides exactly as before (lane games skipped, the rest decided)", async () => {
  mainMode();
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  LANES = () => [{ gameKey: "game a" }];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  await autoFarmer.runOnce();
  assert.deepEqual(
    calls.records.map((r) => r.game),
    ["Game B"],
  );
  assert.equal(calls.records[0].decision, "skip_host_offline", "fixture: no farm host, so the gate records host-offline");
});

test("outside main mode an unreadable lane table keeps the old fail-safe: the legacy engine decides", async () => {
  AF = { ...AF, farm2Enabled: true, farm2Main: false };
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  await autoFarmer.runOnce();
  assert.deepEqual(calls.records.map((r) => r.game).sort(), ["Game A", "Game B"]);
});

test("main mode but the lane engine is not running: the legacy engine decides", async () => {
  mainMode();
  LIVE = [campaign("Game A", "a1")];
  ownership.setEngineRunning(false);
  await autoFarmer.runOnce();
  assert.deepEqual(calls.records.map((r) => r.game), ["Game A"]);
});

/* ======================= defect 9: the market floor ======================= */

test("the shelf floor counts only switched-on markets: 12 with Plati off (old bytes: 18)", () => {
  const af = { ...AF0 };
  assert.equal(autoFarmer.marketStockFloor(af), 12);
});

test("the shelf floor is 18 with Gameflip, Plati and GGSel all on", () => {
  assert.equal(autoFarmer.marketStockFloor({ ...AF0, platiEnabled: true, ggselEnabled: true }), 18);
});

test("GGSel switched off leaves its shelf out of the floor too", () => {
  assert.equal(autoFarmer.marketStockFloor({ ...AF0, platiEnabled: true, ggselEnabled: false }), 12);
  assert.equal(autoFarmer.marketStockFloor({ ...AF0, platiEnabled: false, ggselEnabled: false }), 6);
});

test("the floor keeps its maxPerGame clamp, and a hand-built af without the switches reads as before", () => {
  assert.equal(autoFarmer.marketStockFloor({ ...AF0, platiEnabled: true, maxPerGame: 10 }), 10);
  const legacyShape = { platiCategoryId: "34187", perMarketStock: 3, maxPerGame: 30 };
  assert.equal(autoFarmer.marketStockFloor(legacyShape), 18);
});

/* ================== defect 10a: farm2 obeys the master switch ================== */

test("the lane supervisor does nothing while the auto-farm master switch is off (old bytes: ran the cycle)", async () => {
  AF = { ...AF, enabled: false, farm2Enabled: true, farm2Main: true };
  const r = await supervisor.runCycle();
  assert.equal(r.enabled, false);
  assert.equal(calls.requeue, 0, "no job was re-driven");
  assert.equal(calls.lanesRead, 0, "no lane was even looked up");
});

test("with the master switch on the supervisor still runs its cycle", async () => {
  AF = { ...AF, enabled: true, farm2Enabled: true, farm2Main: false };
  const r = await supervisor.runCycle();
  assert.equal(r.enabled, true);
  assert.equal(calls.requeue, 1);
});

/* ======================= defect 13-hook: loopStatus ======================= */

test("autoFarmer.loopStatus reports the last tick, a 10-minute interval and the master switch", async () => {
  await autoFarmer.runOnce();
  const s = autoFarmer.loopStatus();
  assert.ok(s.lastTickAt instanceof Date);
  assert.ok(Date.now() - s.lastTickAt.getTime() < 60000);
  assert.equal(s.intervalMin, 10);
  assert.equal(s.enabled, true);
  AF = { ...AF, enabled: false };
  assert.equal(autoFarmer.loopStatus().enabled, false);
});

test("supervisor.loopStatus reports the last cycle, a 3-minute interval and farm2Enabled", async () => {
  AF = { ...AF, farm2Enabled: false };
  await supervisor.runCycle();
  const s = supervisor.loopStatus();
  assert.ok(s.lastRun instanceof Date);
  assert.equal(s.intervalMin, 3);
  assert.equal(s.enabled, false);
  AF = { ...AF, farm2Enabled: true };
  assert.equal(supervisor.loopStatus().enabled, true);
});

/* ================ defect 14: backfill respects sold games ================= */

function huntTask(over = {}) {
  return {
    _id: "t-hunt",
    game: "Hunt: Showdown",
    campaignId: "h1",
    decision: "farm",
    status: "active",
    targetAccounts: 18,
    plannedAccounts: 18,
    assignedAccounts: [],
    bots: [],
    campaignEndAt: hoursFromNow(48),
    listing: null,
    error: "",
    save: async () => {},
    ...over,
  };
}

function liveTickWith(task) {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  ACTIVE_TASKS = [task];
}

test("backfill claims carry the task's game, so the soldGames exclusion applies (old bytes: unscoped)", async () => {
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.ok(calls.claims.length >= 2, "an affinity pass, then the generic pass");
  const sold = normGame("Hunt: Showdown");
  for (const f of calls.claims) {
    const base = f.$and ? f.$and[0] : f;
    assert.deepEqual(base.soldGames, { $ne: sold }, "every pass excludes accounts already sold for the game");
  }
  const first = calls.claims[0].$and ? calls.claims[0].$and[0] : calls.claims[0];
  assert.ok(first.claimedNote instanceof RegExp && first.claimedNote.test("recycled after Hunt: Showdown"));
  assert.equal(calls.claimed, 18);
  // The note regex now reads backfill notes: usage events name the campaign.
  assert.ok(calls.usage.length === 18 && calls.usage.every((e) => e.game === "Hunt: Showdown" && e.campaignId === "h1"));
});

test("a reuse-only game's backfill still claims recycled accounts only", async () => {
  REUSE_ONLY.add("Hunt: Showdown");
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.ok(calls.claims.length >= 1);
  for (const f of calls.claims) {
    const base = f.$and ? f.$and[0] : f;
    assert.ok(base.claimedNote, "no generic pass for a reuse-only game");
  }
  assert.equal(calls.claimed, 0);
});

/* ============= defect 5 (claim farm): quantity units counted once ============= */

test("a quantity unit and its buyer's later connection are ONE sale (old pipeline: two)", async () => {
  SALES = [
    quantityUnit("alpha, bravo, charlie", hoursAgo(30), 2, { dedupeKey: "sold:L1:world of tanks:0" }),
    connected("Bravo", "acc-bravo", hoursAgo(20)),
    connected("Bravo", "acc-bravo", hoursAgo(20)),
  ];
  assert.deepEqual(oldInternalSales(SALES, "World of Tanks"), { count: 2, revenue: 2, avgPrice: 2 });
  assert.deepEqual(await autoFarmer.internalSalesForGame("World of Tanks"), {
    count: 1,
    revenue: 2,
    avgPrice: 2,
  });
});

test("a quantity unit nobody connects is one sale; one connection pairs with one unit only", async () => {
  SALES = [quantityUnit("alpha, bravo", hoursAgo(30), 2)];
  assert.equal((await autoFarmer.internalSalesForGame("World of Tanks")).count, 1);
  SALES = [
    quantityUnit("alpha, bravo", hoursAgo(30), 2),
    quantityUnit("alpha, bravo", hoursAgo(29), 2),
    connected("alpha", "acc-alpha", hoursAgo(10)),
  ];
  const s = await autoFarmer.internalSalesForGame("World of Tanks");
  assert.equal(s.count, 2, "two units sold; one buyer connected");
  assert.equal(s.revenue, 4);
  assert.equal(oldInternalSales(SALES, "World of Tanks").count, 3);
});

test("a connection more than a day BEFORE the unit sold is not its buyer", async () => {
  SALES = [quantityUnit("alpha, bravo", hoursAgo(10), 2), connected("bravo", "acc-bravo", hoursAgo(40))];
  assert.equal((await autoFarmer.internalSalesForGame("World of Tanks")).count, 2);
  // Within the day of slack (the stock-drop inference stamps late) it pairs.
  SALES = [quantityUnit("alpha, bravo", hoursAgo(10), 2), connected("bravo", "acc-bravo", hoursAgo(20))];
  assert.equal((await autoFarmer.internalSalesForGame("World of Tanks")).count, 1);
});

test("a login a named sale already accounts for is not paired with a quantity unit", async () => {
  SALES = [
    // Gameflip sold bravo by name, and bravo's buyer connected: one sale.
    signal({ source: "listing_sold", login: "bravo", account: "acc-bravo", priceUsd: 3, marketplace: "gameflip", at: hoursAgo(40) }),
    connected("bravo", "acc-bravo", hoursAgo(35)),
    // A GGSel unit whose pool happens to list bravo too: a second sale.
    quantityUnit("alpha, bravo", hoursAgo(30), 2),
  ];
  const s = await autoFarmer.internalSalesForGame("World of Tanks");
  assert.equal(s.count, 2);
  assert.equal(s.revenue, 5);
});

test("units whose row carries the listing's one account id are each a unit, not one", async () => {
  SALES = [
    quantityUnit("alpha, bravo, charlie", hoursAgo(30), 2, { account: "acc-listing" }),
    quantityUnit("alpha, bravo, charlie", hoursAgo(29), 2, { account: "acc-listing" }),
    quantityUnit("alpha, bravo, charlie", hoursAgo(28), 2, { account: "acc-listing" }),
  ];
  assert.equal(oldInternalSales(SALES, "World of Tanks").count, 1, "the old grouping collapsed them");
  assert.equal((await autoFarmer.internalSalesForGame("World of Tanks")).count, 3);
});

test("without quantity units the count is exactly the old pipeline's (randomised fixtures)", async () => {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let round = 0; round < 40; round++) {
    const rows = [];
    const n = Math.floor(rnd() * 25);
    for (let i = 0; i < n; i++) {
      const kind = pick(["connected", "named", "anonymous", "reserved", "old", "other"]);
      const at = hoursAgo(rnd() * 900);
      if (kind === "connected") rows.push(connected(pick(["a", "b", "c", ""]), pick(["acc1", "acc2", "acc3"]), at));
      if (kind === "named")
        rows.push(signal({ source: "listing_sold", login: pick(["a", "b"]), account: pick(["acc1", "acc2", null]), priceUsd: pick([0, 1.5, 3]), at }));
      if (kind === "anonymous") rows.push(signal({ source: "listing_sold", priceUsd: pick([0, 0.99, 2.5]), at }));
      if (kind === "reserved") rows.push(signal({ source: "drop_reserved", account: "acc1", at }));
      if (kind === "old") rows.push(signal({ source: "listing_sold", priceUsd: 5, at: hoursAgo(24 * 50) }));
      if (kind === "other") rows.push(signal({ source: "listing_sold", gameKey: "albion online", game: "Albion Online", priceUsd: 4, at }));
    }
    SALES = rows;
    assert.deepEqual(
      await autoFarmer.internalSalesForGame("World of Tanks"),
      oldInternalSales(rows, "World of Tanks"),
      "round " + round,
    );
  }
});

test("pairQuantityUnits: the earliest qualifying connection wins and is used once", () => {
  const t0 = Date.now() - 50 * 3600000;
  const units = [
    { login: "a, b, c", at: new Date(t0), priceUsd: 1, dedupeKey: "u1" },
    { login: "a, b, c", at: new Date(t0 + 1000), priceUsd: 0, dedupeKey: "u2" },
  ];
  const conns = [
    { _id: "b", at: new Date(t0 + 7200000), accounts: ["acc-b"] },
    { _id: "c", at: new Date(t0 + 3600000), accounts: ["acc-c"] },
  ];
  const r = autoFarmer.pairQuantityUnits(units, conns, []);
  assert.deepEqual(r, { count: 0, revenue: 1, priced: 1, paired: 2 });
  const taken = autoFarmer.pairQuantityUnits(units, conns, [{ login: "", account: "acc-c" }]);
  assert.deepEqual(taken, { count: 1, revenue: 1, priced: 1, paired: 1 }, "c is the named sale's (via its account)");
});

/* ================== defect 13: the pristine reserve ================== */

function albionTask(over = {}) {
  return {
    _id: "t-albion",
    game: "Albion Online",
    campaignId: "c9",
    decision: "farm",
    plannedAccounts: 30,
    bots: [],
    assignedAccounts: [],
    toObject() {
      return { ...this };
    },
    ...over,
  };
}

test("every farm claim ANDs the pristine filter and reports each claim back", async () => {
  GUARD.filter = { $nor: [{ lastCheckStatus: "ok", hasPassword: true }] };
  const r = await autoFarmer.executeTask(albionTask({ plannedAccounts: 4 }), {
    af: { ...AF, dryRun: false },
    host: HOST,
  });
  assert.equal(r.accounts, 4);
  assert.ok(calls.claims.length >= 4);
  for (const f of calls.claims) {
    assert.ok(Array.isArray(f.$and), "the claim query is an $and");
    assert.deepEqual(f.$and[1], GUARD.filter);
    assert.equal(f.$and[0].status, "available", "the ready-pool query is intact");
  }
  assert.equal(calls.noted.length, 4, "noteClaimed once per claimed account");
});

test("a pristine filter that fails mid-claim stops claiming but hands back what landed", async () => {
  const reserveStub = STUBS.get(path.join(UTILS, "pristineReserve"));
  const real = reserveStub.farmClaimFilter;
  let n = 0;
  reserveStub.farmClaimFilter = async () => {
    n += 1;
    if (n > 3) throw new Error("count failed");
    return {};
  };
  try {
    // Pass 1 (recycled) reads once and finds nothing; pass 2 claims two, then
    // the fourth read fails: the two claimed accounts are still deployed.
    const r = await autoFarmer.executeTask(albionTask({ plannedAccounts: 10 }), {
      af: { ...AF, dryRun: false },
      host: HOST,
    });
    assert.equal(calls.claimed, 2);
    assert.equal(r.accounts, 2);
  } finally {
    reserveStub.farmClaimFilter = real;
  }
});

test("executeTask leaves the pristine reserve alone (old bytes: claimed 30)", async () => {
  GUARD.protect = 75; // 100 ready - 20 reserve - 75 protected = 5 spendable
  const r = await autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST });
  assert.equal(r.accounts, 5);
  assert.equal(calls.claimed, 5);
});

test("executeTask's shortage message names the pristine reserve", async () => {
  GUARD.protect = 80;
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST }),
    /reserve 20 \+ 80 pristine kept for rent-farm orders/,
  );
  assert.equal(calls.claimed, 0);
});

test("the legacy tick's fair share leaves the pristine reserve alone (old bytes: planned a farm)", async () => {
  AF = { ...AF, hostId: "contabo" };
  LIVE = [campaign("Fresh Game", "f1")];
  GUARD.protect = 80;
  const summary = await autoFarmer.runOnce();
  assert.equal(summary.poolSpendable, 0);
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].decision, "skip_no_accounts");
  assert.match(calls.records[0].reason, /80 pristine account\(s\) are kept for rent-farm orders/);
});

test("backfill leaves the pristine reserve alone (old bytes: claimed 18)", async () => {
  GUARD.protect = 70; // 100 - 20 - 70 = 10 spendable
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 10);
});

test("the farm2 cycle budget leaves the pristine reserve alone (old bytes: 80)", async () => {
  GUARD.protect = 30;
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalAccounts, 50);
  assert.equal(cycle.totalContainers, 20);
});

test("a lane's reuse-only count applies the same pristine filter as the claim", async () => {
  REUSE_ONLY.add("World of Tanks");
  GUARD.filter = { $nor: [{ lastCheckStatus: "ok", hasPassword: true }] };
  AvailableAccount.countDocuments = (filter) => {
    calls.counted.push(filter);
    return q(0);
  };
  const v = await decide.decideCampaign({
    campaign: campaign("World of Tanks", "w1"),
    lane: { gameKey: "world of tanks", mode: "shadow" },
    af: { ...AF },
    shadow: true,
    ctx: laneCtx(),
  });
  assert.equal(v.decision, "skip_reuse_only");
  const f = calls.counted[calls.counted.length - 1];
  assert.ok(Array.isArray(f.$and));
  assert.deepEqual(f.$and[1], GUARD.filter);
  assert.ok(f.$and[0].claimedNote.test("recycled after World of Tanks"));
});

/* ================ defect 16 (auto-farm): the RAM gate ================ */

function laneCtx() {
  return {
    hostOnline: true,
    host: HOST,
    farmMap: { map: new Map(), wildcard: new Set(), logins: new Set() },
    owned: null,
    archiveHolders: new Map(),
  };
}

test("farm2 budget: no NEW container while the host is short of RAM; accounts untouched (old bytes: 20 containers)", async () => {
  RAM.ok = false;
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalContainers, 0);
  assert.equal(cycle.totalSeats, 0);
  assert.equal(cycle.totalAccounts, 80);
  assert.match(cycle.reason, /no new container: farm host Contabo is short of RAM \(900 MB available, minimum 1500 MB\)/);
});

test("farm2 budget: at the container cap the RAM gate is not even read", async () => {
  ACTIVE_TASKS = [
    {
      _id: "full",
      status: "active",
      bots: Array.from({ length: 20 }, (_, i) => ({ host: "contabo", container: "twitchbotx" + i })),
    },
  ];
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalContainers, 0);
  assert.deepEqual(calls.ram, []);
});

test("a lane deciding without a cycle creates no container on a host short of RAM (old bytes: planned a probe)", async () => {
  RAM.ok = false;
  const v = await decide.decideCampaign({
    campaign: campaign("Fresh Game", "f1"),
    lane: { gameKey: "fresh game", mode: "shadow" },
    af: { ...AF },
    shadow: true,
    ctx: laneCtx(),
  });
  assert.equal(v.decision, "skip_no_capacity");
  RAM.ok = true;
  const ok = await decide.decideCampaign({
    campaign: campaign("Fresh Game", "f1"),
    lane: { gameKey: "fresh game", mode: "shadow" },
    af: { ...AF },
    shadow: true,
    ctx: laneCtx(),
  });
  assert.equal(ok.decision, "probe");
});

test("the legacy decision records skip_no_capacity, naming RAM, when no container may be created and no seat is free", async () => {
  AF = { ...AF, hostId: "contabo" };
  LIVE = [campaign("Fresh Game", "f1")];
  RAM.ok = false;
  await autoFarmer.runOnce();
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].decision, "skip_no_capacity");
  assert.match(calls.records[0].reason, /No new bot container: farm host Contabo is short of RAM/);
});

test("executeTask fills free seats in running bots but creates no container while RAM is short (old bytes: created bots)", async () => {
  AF = { ...AF, consolidate: true };
  ACTIVE_TASKS = [
    {
      _id: "shared",
      status: "active",
      bots: [{ host: "contabo", file: "config_5.json", container: "twitchbotx5" }],
      assignedAccounts: [],
    },
  ];
  hosts.readFile = async () =>
    JSON.stringify({
      TwitchSettings: {
        TwitchUsers: [
          { Login: "u1", ClientSecret: "s1", Enabled: true },
          { Login: "u2", ClientSecret: "s2", Enabled: true },
          { Login: "u3", ClientSecret: "s3", Enabled: true },
        ],
      },
    });
  RAM.ok = false;
  const r = await autoFarmer.executeTask(albionTask(), {
    af: { ...AF, dryRun: false, consolidate: true },
    host: HOST,
  });
  assert.equal(r.accounts, 7, "the 7 free seats of the running bot");
  assert.deepEqual(calls.createBot, []);
  assert.deepEqual(calls.addToBot, [{ file: "config_5.json", n: 7 }]);
});

test("executeTask with no free seat and RAM short throws without claiming, and says why", async () => {
  RAM.ok = false;
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST }),
    /no new container \(farm host Contabo is short of RAM/,
  );
  assert.equal(calls.claimed, 0);
});

test("backfill stops at the RAM gate when no running bot has a seat (old bytes: claimed and created)", async () => {
  RAM.ok = false;
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.createBot, []);
  assert.ok(progressLines().some((m) => /^Backfill: no new container \(farm host Contabo is short of RAM/.test(m)));
});

test("with RAM available nothing changes: backfill creates its containers as before", async () => {
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 18);
  assert.deepEqual(
    calls.createBot.map((c) => c.n),
    [10, 8],
  );
});

/* ============ the engine never restarts a parked (stopped) bot ============ */

function endedSharedFixture() {
  const bot = { host: "contabo", file: "config_7.json", container: "twitchbotx7" };
  ACTIVE_TASKS = [
    {
      _id: "t-ended",
      game: "Ended Game",
      campaignId: "e1",
      decision: "farm",
      status: "active",
      bots: [bot],
      assignedAccounts: ["olduser"],
      save: async () => {},
    },
    {
      _id: "t-live",
      game: "Other Game",
      campaignId: "o1",
      decision: "farm",
      status: "active",
      bots: [bot],
      assignedAccounts: ["otheruser"],
      save: async () => {},
    },
  ];
  CAMPAIGNS.set("e1", { campaignId: "e1", status: "EXPIRED", endAt: hoursAgo(2) });
  hosts.readFile = async () =>
    JSON.stringify({
      TwitchSettings: {
        TwitchUsers: [
          { Login: "olduser", ClientSecret: "s1", Enabled: true, FavouriteGames: ["Ended Game"] },
          { Login: "otheruser", ClientSecret: "s2", Enabled: true, FavouriteGames: ["Other Game"] },
        ],
      },
    });
}

test("an ended task trimmed off a shared bot reloads it only if running (old bytes: docker restart)", async () => {
  endedSharedFixture();
  const done = await autoFarmer.completeEndedTasks();
  assert.equal(done, 1);
  assert.deepEqual(calls.restartIfRunning, [{ host: HOST, container: "twitchbotx7" }]);
  assert.deepEqual(
    calls.docker.filter((d) => d.action === "restart"),
    [],
    "no unconditional restart, so a parked bot stays parked",
  );
});

test("without farmControl.restartIfRunning (a partial deploy) the old restart is kept", async () => {
  endedSharedFixture();
  delete farmControl.restartIfRunning;
  await autoFarmer.completeEndedTasks();
  assert.deepEqual(calls.docker, [{ action: "restart", container: "twitchbotx7" }]);
});
