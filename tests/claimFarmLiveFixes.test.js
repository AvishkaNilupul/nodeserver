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
    if (STUBS.has(abs)) {
      const s = STUBS.get(abs);
      // An Error stub is a module that fails to load (a partial deploy).
      if (s instanceof Error) throw s;
      return s;
    }
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
    telegram: [],
    events: [],
    listed: [],
    relisted: [],
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
// Container states `docker ps` reports on the farm host (name -> state).
let DOCKER = {};
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
    dockerPs: async () =>
      Object.fromEntries(
        Object.entries(DOCKER).map(([name, st]) => [name, { state: st, status: st }]),
      ),
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
stub("telegram", {
  sendTelegram: async (text) => {
    calls.telegram.push(text);
  },
});
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
  retryMissingSecondaries: async (t) => {
    calls.relisted.push(t.game);
    return null;
  },
  listActivatedTask: async (id) => {
    calls.listed.push(String(id));
    return {};
  },
  listStackedBundle: async () => ({}),
});
stub("systemLog", {
  logEvent: (e) => {
    calls.events.push(e);
  },
});
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
  Date.now = realDateNow;
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
    maxTimeMS: () => chain,
    then: (ok, bad) => settle().then(ok, bad),
    catch: (bad) => settle().catch(bad),
  };
  return chain;
}

// A movable clock for the waits the engine times (the lane-missing fallback):
// Date.now() runs CLOCK ms ahead of the real one, and every test starts at 0.
let CLOCK = 0;
const realDateNow = Date.now;
Date.now = () => realDateNow() + CLOCK;
const MIN = 60000;

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

let ACTIVE_TASKS;
let LIVE;
let CAMPAIGNS;
let SALES;
let READY;
let LANES;
// The (game, campaignId) rows the legacy candidate loop finds for live campaigns.
let EXISTING;
// Active tasks the two listing sweeps see: UNLISTED (no Gameflip listing yet)
// and LISTED (secondaries retried in live mode).
let UNLISTED;
let LISTED;
const RESERVE_STUB = STUBS.get(path.join(UTILS, "pristineReserve"));
const lane = (gameKey, mode = "live", state = "idle") => ({ gameKey, mode, state });

function isActiveTaskQuery(filter) {
  return (
    !!filter &&
    filter.status === "active" &&
    !filter.$or &&
    !Object.prototype.hasOwnProperty.call(filter, "listing.externalId")
  );
}

test.beforeEach(() => {
  CLOCK = 0;
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
  EXISTING = [];
  UNLISTED = [];
  LISTED = [];
  DOCKER = {};
  STUBS.set(path.join(UTILS, "pristineReserve"), RESERVE_STUB);
  if (typeof ownership._setRefreshTimeoutForTests === "function") {
    ownership._setRefreshTimeoutForTests(0); // back to the shipped 15 s
  }
  ownership.setEngineRunning(false);

  AutoFarmTask.find = (filter = {}) =>
    q(() => {
      // The legacy candidate loop's (game, campaignId) lookup.
      if (filter.$or && filter.$or.every((x) => x.game && x.campaignId)) return EXISTING;
      // The listing sweeps: no Gameflip listing yet / a listing to re-check.
      const listingKey = (x) => Object.prototype.hasOwnProperty.call(x, "listing.externalId");
      if (filter.status === "active" && filter.$or && filter.$or.some(listingKey)) {
        return filter["listing.externalId"] ? [] : UNLISTED;
      }
      if (filter.status === "active" && listingKey(filter) && !filter.$or) return LISTED;
      if (!isActiveTaskQuery(filter)) return [];
      const not = filter._id && filter._id.$ne;
      return ACTIVE_TASKS.filter((t) => not === undefined || String(t._id) !== String(not));
    });
  AutoFarmTask.findOne = () => q(null);
  AutoFarmTask.findById = () => q(null);
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
  // Honours the query, as Mongo would (the evaluator below), so a code path
  // that filters in the query and one that filters in JS read the same rows.
  FarmLane.find = (filter = {}) => {
    calls.lanesRead += 1;
    return q(() => {
      const rows = LANES();
      return rows instanceof Error ? rows : rows.filter((r) => matches(filter, r));
    });
  };
  FarmLane.create = async (doc) => doc;
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
    if (op === "$trim") {
      const v = expr(a.input, doc);
      if (v == null) return null;
      const chars = a.chars == null ? " \t\n\r" : String(expr(a.chars, doc));
      let s = String(v);
      while (s && chars.includes(s[0])) s = s.slice(1);
      while (s && chars.includes(s[s.length - 1])) s = s.slice(0, -1);
      return s;
    }
    if (op === "$in") {
      const [x, arr] = expr(a, doc);
      return (arr || []).some((y) => same(x, y));
    }
    if (op === "$literal") return a;
    if (op === "$eq") {
      const [x, y] = expr(a, doc);
      return same(x, y);
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
    if (op === "$lte") return v != null && cmp(v, arg) <= 0;
    if (op === "$lt") return v != null && cmp(v, arg) < 0;
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
    if (k === "$expr") return !!expr(cond, doc);
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
  LANES = () => [lane("albion online")];
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
    return q([lane("albion online")]);
  };
  await ownership.refresh();
  assert.equal(calls.lanesRead, 1, "the second refresh really read the table");
  assert.equal(ownership.isOwned("Albion Online"), true);
});

test("a failed read after a good one is cold, not a warm empty set", async () => {
  mainMode();
  LANES = () => [lane("albion online")];
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

test("legacyMayDecide in main mode: only the games no lane will take (old bytes: no such rule)", async () => {
  mainMode();
  LANES = () => [
    lane("game a"),
    lane("game b", "shadow"),
    lane("game c", "off"),
    lane("game d", "live", "paused"),
    lane("game e", "live", "error"),
  ];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  assert.equal(ownership.legacyMayDecide("Game A"), false, "a live lane decides it");
  assert.equal(ownership.legacyMayDecide("Game B"), true, "shadow: the legacy engine still farms it");
  assert.equal(ownership.legacyMayDecide("Game C"), true, "off");
  assert.equal(ownership.legacyMayDecide("Game D"), true, "paused: released to legacy");
  assert.equal(ownership.legacyMayDecide("Game E"), false, "an erroring live lane still owns its game");
  assert.equal(ownership.legacyMayDecide("The Quinfall"), false, "no lane yet: the supervisor creates one");
  assert.equal(ownership.legacyMayDecide("原神"), true, "no key: no lane can ever take it");
  LANES = () => new Error("db down");
  await ownership.refresh();
  assert.equal(ownership.legacyMayDecide("Game B"), false, "unknown ownership defers in main mode");
});

test("legacyMayDecide outside main mode, or with the lane engine stopped, is the old rule", async () => {
  AF = { ...AF, farm2Enabled: true, farm2Main: false };
  LANES = () => [lane("game a")];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  assert.equal(ownership.legacyMayDecide("Game A"), false, "owned by its live lane");
  assert.equal(ownership.legacyMayDecide("The Quinfall"), true, "trial mode: no lane, legacy decides");
  mainMode();
  ownership.setEngineRunning(false);
  assert.equal(ownership.legacyMayDecide("The Quinfall"), true, "nobody would create its lane");
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
  LANES = () => [lane("game a"), lane("game b", "shadow")];
  ownership.setEngineRunning(true); // cold, exactly as at boot
  await autoFarmer.runOnce();
  assert.deepEqual(
    calls.records.map((r) => r.game),
    ["Game B"],
  );
});

test("main mode with a warm cache: a live lane's game is skipped, a shadow lane's still decided by legacy", async () => {
  mainMode();
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  LANES = () => [lane("game a"), lane("game b", "shadow")];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  await autoFarmer.runOnce();
  assert.deepEqual(
    calls.records.map((r) => r.game),
    ["Game B"],
  );
  assert.equal(calls.records[0].decision, "skip_host_offline", "fixture: no farm host, so the gate records host-offline");
});

test("main mode: a brand-new game with no lane yet is left to the supervisor (old bytes: legacy farmed it, 30 claimed)", async () => {
  // Review proof p1: the campaign watcher has just upserted The Quinfall's
  // first campaign; its lane comes at the supervisor's next cycle start.
  mainMode();
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  LANES = () => [lane("albion online")];
  LIVE = [campaign("Albion Online", "a1"), campaign("The Quinfall", "q1")];
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  ownership.setEngineRunning(true);
  await ownership.refresh();
  const summary = await autoFarmer.runOnce();
  assert.deepEqual(calls.records, []);
  assert.equal(calls.claimed, 0);
  assert.deepEqual(summary.awaitingLane, ["The Quinfall"]);
  assert.ok(progressLines().some((m) => /no lane yet/.test(m) && /The Quinfall/.test(m)));
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

/* ============ a planned row is not stranded while it may execute ============ */

test("isStranded dates a plan: one touched in the last 15 min may still be executing (old bytes: stranded at once)", () => {
  const now = Date.now();
  const min = 60000;
  assert.equal(autoFarmer.isStranded({ status: "planned", decidedAt: new Date(now - min) }), false);
  assert.equal(autoFarmer.isStranded({ status: "planned", decidedAt: new Date(now - 16 * min) }), true);
  assert.equal(
    autoFarmer.isStranded({ status: "planned", decidedAt: new Date(now - 20 * min), updatedAt: new Date(now - min) }),
    false,
    "touched a minute ago",
  );
  assert.equal(autoFarmer.isStranded({ status: "planned" }), true, "an undated plan keeps the old answer");
  assert.equal(autoFarmer.isStranded({ status: "failed", bots: [] }), true);
  assert.equal(autoFarmer.isStranded({ status: "failed", bots: [{ container: "x" }] }), false);
});

test("a lane does not re-decide a planned row another engine may still be executing (old bytes: 'stranded')", () => {
  // Review proof p1b: legacy's executeTask was mid-claim on The Quinfall when
  // the new lane read the row as stranded and queued a second executeTask.
  const realLane = require(path.join(UTILS, "farm2", "lane.js"));
  const fresh = realLane.decisionDue({
    existing: { status: "planned", decision: "farm", bots: [], decidedAt: new Date() },
    shadow: false,
    af: { dryRun: false },
  });
  assert.deepEqual(fresh, { due: false, why: "settled" });
  const old = realLane.decisionDue({
    existing: { status: "planned", decision: "farm", bots: [], decidedAt: hoursAgo(1) },
    shadow: false,
    af: { dryRun: false },
  });
  assert.deepEqual(old, { due: true, why: "stranded" });
});

test("the legacy tick leaves a fresh planned row alone and re-decides a stale one", async () => {
  AF = { ...AF, dryRun: false };
  LIVE = [campaign("Game A", "a1"), campaign("Game B", "b1")];
  EXISTING = [
    { game: "Game A", campaignId: "a1", status: "planned", decision: "farm", bots: [], decidedAt: new Date() },
    { game: "Game B", campaignId: "b1", status: "planned", decision: "farm", bots: [], decidedAt: hoursAgo(1) },
  ];
  await autoFarmer.runOnce();
  assert.deepEqual(calls.records.map((r) => r.game), ["Game B"]);
});

/* ============== a long stall is said out loud, and loops report ok ============== */

test("three deferred ticks in a row raise one alarm; a readable tick re-arms it (old bytes: silent)", async () => {
  await autoFarmer.runOnce(); // a readable tick first: the count starts at 0
  mainMode();
  LIVE = [campaign("Game A", "a1")];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  const alarms = () =>
    calls.telegram.filter((t) => /legacy decisions deferred \d+ ticks: lane ownership unreadable/.test(t));
  await autoFarmer.runOnce();
  await autoFarmer.runOnce();
  assert.equal(alarms().length, 0, "two ticks are a blip");
  await autoFarmer.runOnce();
  assert.equal(alarms().length, 1);
  assert.ok(calls.events.some((e) => e.action === "decisions_deferred" && e.count === 3));
  await autoFarmer.runOnce();
  assert.equal(alarms().length, 1, "one alarm per stall");
  LANES = () => [lane("game a")];
  await autoFarmer.runOnce();
  LANES = () => new Error("db down");
  for (let i = 0; i < 3; i++) {
    ownership.invalidate(); // ten minutes pass between ticks: the 30 s cache is stale
    await autoFarmer.runOnce();
  }
  assert.equal(alarms().length, 2, "a new stall alarms again");
});

test("autoFarmer.loopStatus: lastOkAt is the last tick that decided; a deferred tick is not ok (old bytes: no lastOkAt)", async () => {
  await autoFarmer.runOnce();
  const ok1 = autoFarmer.loopStatus();
  assert.ok(ok1.lastOkAt instanceof Date);
  assert.equal(ok1.lastError, "");
  await new Promise((r) => setTimeout(r, 5));
  mainMode();
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  await autoFarmer.runOnce();
  const s = autoFarmer.loopStatus();
  assert.equal(s.lastOkAt.getTime(), ok1.lastOkAt.getTime(), "a deferred tick is not ok");
  assert.match(s.lastError, /^decisions deferred: lane ownership unknown/);
  assert.ok(s.lastTickAt.getTime() > ok1.lastOkAt.getTime(), "lastTickAt is stamped as before");
});

test("supervisor.loopStatus: a cycle whose FarmLane read failed is not ok (old bytes: no lastOkAt)", async () => {
  AF = { ...AF, enabled: true, farm2Enabled: true, farm2Main: false };
  await supervisor.runCycle();
  const ok1 = supervisor.loopStatus();
  assert.ok(ok1.lastOkAt instanceof Date);
  assert.equal(ok1.lastError, "");
  await new Promise((r) => setTimeout(r, 5));
  FarmLane.find = () => q(new Error("FarmLane read failed"));
  const r = await supervisor.runCycle();
  assert.equal(r.error, "FarmLane read failed");
  const s = supervisor.loopStatus();
  assert.equal(s.lastOkAt.getTime(), ok1.lastOkAt.getTime());
  assert.equal(s.lastError, "FarmLane read failed");
  assert.ok(s.lastRun.getTime() > ok1.lastOkAt.getTime());
});

test("a failed lane auto-create makes the cycle not ok, and one bad game does not block the rest (old bytes: stopped at it)", async () => {
  AF = { ...AF, enabled: true, farm2Enabled: true, farm2Main: true };
  LIVE = [campaign("Good Game", "g1"), campaign("Bad Game", "x1"), campaign("Other Game", "o1")];
  const created = [];
  FarmLane.create = async (doc) => {
    if (doc.game === "Bad Game") throw new Error("validation failed");
    created.push(doc.game);
    return doc;
  };
  const before = supervisor.loopStatus().lastOkAt;
  const r = await supervisor.runCycle();
  assert.deepEqual(created.sort(), ["Good Game", "Other Game"]);
  assert.deepEqual(r.autoCreated.sort(), ["Good Game", "Other Game"]);
  const s = supervisor.loopStatus();
  assert.match(s.lastError, /^auto-lanes: could not create lane\(s\): Bad Game: validation failed/);
  assert.equal(s.lastOkAt === before || (s.lastOkAt && before && s.lastOkAt.getTime() === before.getTime()), true);
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

test("a failed pairing read keeps the game's sales: every unit counts once (review p3b; old bytes: 0 for the whole game)", async () => {
  SALES = [
    connected("bravo", "acc-bravo", hoursAgo(20)),
    signal({ source: "listing_sold", login: "gf_user", account: "acc-gf", priceUsd: 3, marketplace: "gameflip", at: hoursAgo(10) }),
    quantityUnit("alpha, bravo", hoursAgo(30), 2),
    quantityUnit("alpha, bravo", hoursAgo(29), 2),
  ];
  let reads = 0;
  SaleSignal.aggregate = (pipeline) => {
    reads += 1;
    if (reads > 1) return Promise.reject(new Error("BSONObjectTooLarge"));
    return Promise.resolve(runPipeline(SALES, pipeline));
  };
  const s = await autoFarmer.internalSalesForGame("World of Tanks");
  assert.equal(reads, 2);
  assert.equal(s.count, 4, "2 account-grouped sales + 2 units, each its own sale");
  assert.equal(s.revenue, 7);
});

test("the pairing read returns only rows that can pair with the pools, however much the game sells (old bytes: every named row)", async () => {
  SALES = [quantityUnit("alpha, bravo", hoursAgo(30), 2), connected("bravo", "acc-bravo", hoursAgo(20))];
  for (let i = 0; i < 50; i++) {
    SALES.push(signal({ source: "listing_sold", login: "seller_" + i, account: "acc-s" + i, priceUsd: 1, at: hoursAgo(5) }));
  }
  // A login-less named sale on bravo's account: through the connection it
  // names bravo, so the unit cannot be bravo's sale.
  SALES.push(signal({ source: "listing_sold", login: "", account: "acc-bravo", priceUsd: 1, at: hoursAgo(4) }));
  const outs = [];
  SaleSignal.aggregate = (pipeline) => {
    const out = runPipeline(SALES, pipeline);
    outs.push(out);
    return Promise.resolve(out);
  };
  const s = await autoFarmer.internalSalesForGame("World of Tanks");
  assert.equal(outs.length, 2);
  const second = outs[1][0];
  const rows = Object.values(second).reduce((n, arr) => n + arr.length, 0);
  assert.ok(rows <= 2, "bravo's connection and one login-less account: " + JSON.stringify(second));
  // 51 account groups (bravo's, the 50 sellers'), plus the unit unpaired.
  assert.equal(s.count, 52);
  assert.equal(s.revenue, 53);
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

test("executeTask leaves the pristine reserve alone: ready - max(poolReserve, hold) (old bytes: claimed 5)", async () => {
  // 100 ready, reserve floor 20, the pristine reserve holding 75: the held
  // accounts ARE ready accounts and stand as the floor too, so 25 are
  // spendable — the sum (100 - 20 - 75 = 5) counted the overlap twice.
  GUARD.protect = 75;
  const r = await autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST });
  assert.equal(r.accounts, 25);
  assert.equal(calls.claimed, 25);
});

test("with the hold under the floor, the floor alone binds (the old arithmetic)", async () => {
  GUARD.protect = 10; // max(20, 10) = 20 -> 80 spendable, capped by the plan's 30
  const r = await autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST });
  assert.equal(r.accounts, 30);
});

test("executeTask's shortage message names the pristine reserve", async () => {
  GUARD.protect = 100;
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST }),
    /reserve 20; the pristine reserve is holding 100 for rent-farm orders/,
  );
  assert.equal(calls.claimed, 0);
});

test("the legacy tick's fair share leaves the pristine reserve alone, and the row names it", async () => {
  AF = { ...AF, hostId: "contabo" };
  LIVE = [campaign("Fresh Game", "f1")];
  GUARD.protect = 100;
  const summary = await autoFarmer.runOnce();
  assert.equal(summary.poolSpendable, 0);
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].decision, "skip_no_accounts");
  assert.match(
    calls.records[0].reason,
    /the pristine reserve is holding 100 account\(s\) for rent-farm orders/,
  );
});

test("backfill leaves the pristine reserve alone (old bytes: claimed none)", async () => {
  GUARD.protect = 90; // 100 - max(20, 90) = 10 spendable
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 10);
});

test("the farm2 cycle budget leaves the pristine reserve alone: ready - max(floor, hold) (old bytes: 50)", async () => {
  GUARD.protect = 30;
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalAccounts, 70);
  assert.equal(cycle.totalContainers, 20);
  assert.equal(cycle.pristineHeld, 30);
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

// A running bot (twitchbotx5) and/or a parked one (twitchbotx6), each with 3
// of 10 seats used, on one active task.
function seatFixture({ running = true, parked = false } = {}) {
  const bots = [];
  if (running) bots.push({ host: "contabo", file: "config_5.json", container: "twitchbotx5" });
  if (parked) bots.push({ host: "contabo", file: "config_6.json", container: "twitchbotx6" });
  ACTIVE_TASKS = [{ _id: "shared", status: "active", bots, assignedAccounts: [] }];
  DOCKER = {};
  if (running) DOCKER.twitchbotx5 = "running";
  if (parked) DOCKER.twitchbotx6 = "exited";
  hosts.readFile = async () =>
    JSON.stringify({
      TwitchSettings: {
        TwitchUsers: [1, 2, 3].map((i) => ({ Login: "u" + i, ClientSecret: "s" + i, Enabled: true })),
      },
    });
}

test("farm2 budget: no NEW container while the host is short of RAM; accounts untouched (old bytes: 20 containers)", async () => {
  RAM.ok = false;
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalContainers, 0);
  assert.equal(cycle.totalSeats, 0);
  assert.equal(cycle.totalAccounts, 80);
  assert.equal(cycle.ramBlocked, true);
  assert.match(
    cycle.reason,
    /no new container: the RAM gate is shut on Contabo \(900 MB available, minimum 1500 MB\)/,
  );
});

test("farm2 budget: at the container cap the RAM gate is still read, so parked seats can be ruled out", async () => {
  ACTIVE_TASKS = [
    {
      _id: "full",
      status: "active",
      bots: Array.from({ length: 20 }, (_, i) => ({ host: "contabo", container: "twitchbotx" + i })),
    },
  ];
  RAM.ok = false;
  const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
  assert.equal(cycle.totalContainers, 0);
  assert.deepEqual(calls.ram, ["contabo"]);
  assert.equal(cycle.ramBlocked, true);
  assert.equal(cycle.ramDenied, 0, "the cap, not RAM, took the slots");
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

test("the legacy decision records skip_no_capacity, naming the RAM gate, when no container may be created and no seat is free", async () => {
  AF = { ...AF, hostId: "contabo" };
  LIVE = [campaign("Fresh Game", "f1")];
  RAM.ok = false;
  await autoFarmer.runOnce();
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].decision, "skip_no_capacity");
  assert.match(
    calls.records[0].reason,
    /No new bot container: the RAM gate is shut on Contabo \(900 MB available, minimum 1500 MB\)/,
  );
});

test("executeTask fills free seats in running bots but creates no container while RAM is short (old bytes: created bots)", async () => {
  AF = { ...AF, consolidate: true };
  seatFixture({ running: true });
  RAM.ok = false;
  const r = await autoFarmer.executeTask(albionTask(), {
    af: { ...AF, dryRun: false, consolidate: true },
    host: HOST,
  });
  assert.equal(r.accounts, 7, "the 7 free seats of the running bot");
  assert.deepEqual(calls.createBot, []);
  assert.deepEqual(calls.addToBot, [{ file: "config_5.json", n: 7 }]);
});

test("RAM gate shut: a running bot's seats are filled, a parked bot is neither counted nor restarted (old bytes: restarted it)", async () => {
  AF = { ...AF, consolidate: true };
  seatFixture({ running: true, parked: true });
  RAM.ok = false;
  const r = await autoFarmer.executeTask(albionTask(), {
    af: { ...AF, dryRun: false, consolidate: true },
    host: HOST,
  });
  assert.equal(r.accounts, 7, "only the running bot's 7 seats");
  assert.deepEqual(calls.addToBot, [{ file: "config_5.json", n: 7 }]);
  assert.deepEqual(
    calls.docker,
    [{ action: "restart", container: "twitchbotx5" }],
    "the running bot reloads; the parked one stays stopped",
  );
  assert.deepEqual(calls.createBot, []);
});

test("RAM gate shut, the task's only bot parked: backfill claims nothing and starts nothing (review p2; old bytes: 7 claimed, restarted)", async () => {
  const bot = { host: "contabo", file: "config_5.json", container: "twitchbotx5" };
  liveTickWith(huntTask({ assignedAccounts: ["u1", "u2", "u3"], bots: [bot] }));
  AF = { ...AF, consolidate: true };
  DOCKER = { twitchbotx5: "exited" };
  hosts.readFile = async () =>
    JSON.stringify({
      TwitchSettings: {
        TwitchUsers: [1, 2, 3].map((i) => ({ Login: "u" + i, ClientSecret: "s" + i, Enabled: true })),
      },
    });
  RAM.ok = false;
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.addToBot, []);
  assert.deepEqual(calls.docker.filter((d) => d.action === "restart"), []);
});

test("at the container cap with the RAM gate shut, a parked bot's seats do not count either (old bytes: packed and restarted it)", async () => {
  AF = { ...AF, consolidate: true, maxAutoBots: 1 };
  seatFixture({ running: false, parked: true });
  RAM.ok = false;
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST }),
    /all 1 auto-bot slots are in use and no running bot has a free seat/,
  );
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.docker, []);
});

test("with the RAM gate open a parked bot's seats are used as before (it is woken to farm them)", async () => {
  AF = { ...AF, consolidate: true, maxAutoBots: 1 };
  seatFixture({ running: false, parked: true });
  const r = await autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST });
  assert.equal(r.accounts, 7);
  assert.deepEqual(calls.docker, [{ action: "restart", container: "twitchbotx6" }]);
});

test("executeTask with no free seat and RAM short throws without claiming, and says why", async () => {
  RAM.ok = false;
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF, dryRun: false }, host: HOST }),
    /no new container \(the RAM gate is shut on Contabo/,
  );
  assert.equal(calls.claimed, 0);
});

test("backfill stops at the RAM gate when no running bot has a seat (old bytes: claimed and created)", async () => {
  RAM.ok = false;
  liveTickWith(huntTask());
  await autoFarmer.runOnce();
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.createBot, []);
  assert.ok(progressLines().some((m) => /^Backfill: no new container \(the RAM gate is shut on Contabo/.test(m)));
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

/* ========= farm2 skip rows name the real constraint (review p4) ========= */

const goodResearch = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });

test("a lane's capacity skip names the RAM gate with its host and MB (old bytes: 'all 20 slots busy')", async () => {
  AF = { ...AF, hostId: "contabo" };
  MarketResearch.findOne = goodResearch;
  RAM.ok = false;
  const cycle = await budget.computeCycleBudget({ ...AF });
  const v = await decide.decideCampaign({
    campaign: campaign("Fresh Game", "f1"),
    lane: { gameKey: "fresh game", mode: "live" },
    cycle,
    af: { ...AF },
    shadow: false,
    ctx: laneCtx(),
  });
  assert.equal(v.decision, "skip_no_capacity");
  assert.match(v.reason, /^No new bot container: the RAM gate is shut on Contabo \(900 MB available, minimum 1500 MB\)/);
});

test("a lane's pool skip names the pristine reserve holding N accounts (old bytes: only the reserve floor)", async () => {
  AF = { ...AF, hostId: "contabo" };
  MarketResearch.findOne = goodResearch;
  GUARD.protect = 100; // 100 ready - max(20, 100) = 0 spendable
  const cycle = await budget.computeCycleBudget({ ...AF });
  assert.equal(cycle.totalAccounts, 0);
  const v = await decide.decideCampaign({
    campaign: campaign("Fresh Game", "f2"),
    lane: { gameKey: "fresh game", mode: "live" },
    cycle,
    af: { ...AF },
    shadow: false,
    ctx: laneCtx(),
  });
  assert.equal(v.decision, "skip_no_accounts");
  assert.match(v.reason, /reserve floor 20 protects manual work; the pristine reserve is holding 100 account\(s\) for rent-farm orders/);
});

/* ============ cross-file calls survive a partial deploy (review p6) ============ */

test("the farm2 cycle budget works with an autoFarmer that lacks the new exports (old bytes: every cycle threw)", async () => {
  const savedProtect = autoFarmer.pristineProtect;
  const savedSlots = autoFarmer.containerSlots;
  delete autoFarmer.pristineProtect;
  delete autoFarmer.containerSlots;
  try {
    RAM.ok = false;
    GUARD.protect = 50;
    const cycle = await budget.computeCycleBudget({ ...AF, hostId: "contabo" });
    assert.equal(cycle.totalAccounts, 80, "no hold without the helper");
    assert.equal(cycle.totalContainers, 20, "no RAM gate without the helper");
  } finally {
    autoFarmer.pristineProtect = savedProtect;
    autoFarmer.containerSlots = savedSlots;
  }
});

test("a pristine-reserve module that fails to load stops the claim, it does not throw out of it (old bytes: the load error escaped)", async () => {
  READY = 500; // spendable even with pristineProtect's fail-safe hold of 150
  STUBS.set(path.join(UTILS, "pristineReserve"), new Error("Cannot find module './pristineReserve'"));
  await assert.rejects(
    autoFarmer.executeTask(albionTask({ plannedAccounts: 4 }), {
      af: { ...AF, dryRun: false },
      host: HOST,
    }),
    /Could not claim any pool accounts/,
  );
  assert.equal(calls.claimed, 0);
});

test("a lane's reuse-only count is 0 when the pristine module cannot load (old bytes: the decision threw)", async () => {
  REUSE_ONLY.add("World of Tanks");
  STUBS.set(path.join(UTILS, "pristineReserve"), new Error("Cannot find module './pristineReserve'"));
  const v = await decide.decideCampaign({
    campaign: campaign("World of Tanks", "w1"),
    lane: { gameKey: "world of tanks", mode: "shadow" },
    af: { ...AF },
    shadow: true,
    ctx: laneCtx(),
  });
  assert.equal(v.decision, "skip_reuse_only");
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

/* ======== an execute job that runs twice changes nothing (review 2, H8) ======== */

// One AutoFarmTask row, modelled: the lane's upsertTask, executeTask's final
// write and every read see the same object, as they would the same document.
function oneTaskRow() {
  const ROW = {};
  const view = () => (ROW._id ? { ...ROW, toObject: () => ({ ...ROW }) } : null);
  AutoFarmTask.findOneAndUpdate = (f, u) =>
    q(() => {
      if (!ROW._id) Object.assign(ROW, { _id: "row-1", game: f.game, campaignId: f.campaignId });
      Object.assign(ROW, u.$set);
      return view();
    });
  AutoFarmTask.updateOne = (f, u) =>
    q(() => {
      Object.assign(ROW, u.$set || {});
      return { modifiedCount: 1 };
    });
  AutoFarmTask.findOne = () => q(() => view());
  AutoFarmTask.findById = () => q(() => view());
  return ROW;
}

const quinfallVerdict = () => ({
  game: "The Quinfall",
  campaignId: "q1",
  decision: "farm",
  plannedAccounts: 10,
  targetAccounts: 10,
  wouldFarm: true,
  reason: "demand",
});
const quinfallLane = { game: "The Quinfall", gameKey: "the quinfall", mode: "live" };

test("an execute job that runs again finishes as a no-op: no second claim, the row keeps its first set (old bytes: 20 claimed, first set dropped)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  const ROW = oneTaskRow();
  const exec = require(path.join(UTILS, "farm2", "steps", "execute.js"));
  const r1 = await exec.executeDecision({ verdict: quinfallVerdict(), lane: quinfallLane, af: { ...AF }, shadow: false });
  assert.equal(r1.accounts, 10);
  const first = { status: ROW.status, accounts: ROW.assignedAccounts.slice(), bots: ROW.bots.slice() };
  assert.equal(first.status, "active");
  const r2 = await exec.executeDecision({ verdict: quinfallVerdict(), lane: quinfallLane, af: { ...AF }, shadow: false });
  assert.equal(r2.alreadyExecuted, true);
  assert.equal(calls.claimed, 10, "nothing claimed the second time");
  assert.equal(ROW.status, "active", "never flipped back to planned");
  assert.deepEqual(ROW.assignedAccounts, first.accounts);
  assert.deepEqual(ROW.bots, first.bots);
});

test("executeTask refuses a stopped row keeping its accounts, before claiming anything (old bytes: overwrote it)", async () => {
  AF = { ...AF, dryRun: false };
  AutoFarmTask.findById = () =>
    q({ _id: "t-albion", status: "stopped", executedAt: hoursAgo(5), assignedAccounts: ["kept1", "kept2"], bots: [{ container: "twitchbotx4" }] });
  await assert.rejects(
    autoFarmer.executeTask(albionTask(), { af: { ...AF }, host: HOST }),
    (e) => e.alreadyExecuted === true && /the task is stopped and keeps its 2 account\(s\)/.test(e.message),
  );
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.createBot, []);
});

test("row rules: running or an interrupted execute holds work, stopped/completed keep inventory, a failed row never holds work (round-2 bytes: a failed row held work)", () => {
  const { taskHoldsWork: h, taskKeepsInventory: k, taskRefusesExecution: r, taskNeedsAppend: a } = autoFarmer;
  const t = new Date();
  assert.equal(h(null), false);
  assert.equal(h({ status: "active" }), true);
  assert.equal(h({ status: "planned", executedAt: t, assignedAccounts: ["a"] }), true, "an interrupted execute");
  assert.equal(h({ status: "planned", bots: [{ container: "x" }], executedAt: null }), false, "a dry-run reuse plan");
  assert.equal(h({ status: "planned" }), false);
  assert.equal(h({ status: "skipped", executedAt: t, bots: [], assignedAccounts: [] }), false);
  // A failed row never holds work: its retry must run, as a top-up of itself.
  const failedReuse = { status: "failed", executedAt: t, bots: [{ container: "x" }], assignedAccounts: ["a1"] };
  assert.equal(h(failedReuse), false);
  assert.equal(r(failedReuse), false);
  assert.equal(a(failedReuse), true);
  assert.equal(a({ status: "failed", bots: [], assignedAccounts: [] }), false, "an empty failure is a plain retry");
  // A skip recorded over an executed row keeps what that row listed: topped up too.
  assert.equal(a({ status: "skipped", decision: "skip_no_capacity", executedAt: t, assignedAccounts: ["k1"] }), true);
  assert.equal(a({ status: "skipped", decision: "skip_no_capacity", bots: [{ container: "x" }] }), false, "a dry-run plan's bots, never executed");
  assert.equal(a({ status: "planned", executedAt: null, bots: [{ container: "x" }] }), false);
  // Stopped and completed rows keep their accounts and are never executed again.
  for (const status of ["stopped", "completed"]) {
    const row = { status, executedAt: t, assignedAccounts: ["inv"] };
    assert.equal(h(row), false, status);
    assert.equal(k(row), true, status);
    assert.equal(r(row), true, status);
    assert.equal(a(row), false, status);
  }
  assert.equal(r({ status: "active" }), true);
  assert.equal(r({ status: "skipped", decision: "skip_no_accounts" }), false);
});

test("the legacy tick leaves a rescanned stopped task out and settles it (old bytes: planned over it; round 2: decided every tick)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  LIVE = [campaign("Game A", "a1")];
  const stopped = {
    _id: "row-a1",
    game: "Game A",
    campaignId: "a1",
    status: "stopped",
    decision: "farm",
    rescanRequested: true,
    executedAt: hoursAgo(30),
    bots: [{ host: "contabo", file: "config_3.json", container: "twitchbotx3" }],
    assignedAccounts: ["inv1", "inv2", "inv3"],
    error: "twitchbotx3: exited",
  };
  // The tick reads one assigned account per row ($slice: 1).
  EXISTING = [{ ...stopped, assignedAccounts: ["inv1"] }];
  const writes = [];
  AutoFarmTask.updateOne = (f, u) => q(() => (writes.push({ f, u }), { modifiedCount: 1 }));
  AutoFarmTask.findOne = () => q(stopped);
  AutoFarmTask.findById = () => q(stopped);
  const summary = await autoFarmer.runOnce();
  assert.deepEqual(calls.records, [], "no plan written over it");
  assert.equal(calls.claimed, 0);
  assert.equal(summary.candidates, 0, "not a candidate, so it takes no share of the pool");
  assert.equal(summary.rescansRefused, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].f, { _id: "row-a1", status: "stopped", rescanRequested: true }, "only while it is still that row");
  assert.equal(writes[0].u.$set.rescanRequested, false);
  assert.match(writes[0].u.$set.error, /^Not executed again \(.*\): the task is stopped and keeps its 3 account\(s\)/, "counted on the full row, not the tick's projection");
  assert.match(writes[0].u.$set.error, /\| twitchbotx3: exited$/, "its earlier error is kept");
  assert.deepEqual(Object.keys(writes[0].u.$set).sort(), ["error", "rescanRequested"], "status, bots and accounts untouched");
});

test("unrecyclableLogins is exported for the pool's Unclaim route (old bytes: not exported)", () => {
  assert.equal(typeof autoFarmer.unrecyclableLogins, "function");
});

/* ===== review 3: a failed row is retried; a refused row is settled, once ===== */

// Two rows: the warm source task (the game's previous campaign) and this
// campaign's own row, modelled as one object every read and write sees.
function reuseWorld() {
  const SRC = {
    _id: "src-1",
    game: "The Quinfall",
    campaignId: "q1",
    status: "completed",
    executedAt: hoursAgo(200),
    bots: [{ host: "contabo", file: "config_5.json", container: "twitchbotx5" }],
    assignedAccounts: ["a1", "a2", "a3"],
  };
  const OWN = {};
  const view = () => (OWN._id ? { ...OWN, toObject: () => ({ ...OWN }) } : null);
  AutoFarmTask.findById = (id) => q(() => (String(id) === "src-1" ? SRC : view()));
  AutoFarmTask.findOne = (f) => q(() => (f && f.campaignId === "q2" ? view() : null));
  AutoFarmTask.findOneAndUpdate = (f, u) =>
    q(() => {
      if (!OWN._id) Object.assign(OWN, { _id: "own-q2", game: f.game, campaignId: f.campaignId });
      Object.assign(OWN, u.$set);
      return view();
    });
  AutoFarmTask.updateOne = (f, u) =>
    q(() => {
      Object.assign(OWN, (u && u.$set) || {});
      return { modifiedCount: 1 };
    });
  return { SRC, OWN };
}
const reuseVerdict = () => ({
  game: "The Quinfall",
  campaignId: "q2",
  campaignName: "Week 2",
  decision: "reuse_existing",
  reuseTaskId: "src-1",
  reuseBots: ["twitchbotx5"],
  plannedAccounts: 3,
  targetAccounts: 3,
  wouldFarm: true,
  topUpAllowed: false,
  reason: "recurring",
});

test("a lane reuse whose bot did not restart is retried by its job: the retry restarts it and the task goes active (round-2 bytes: a no-op, never farmed)", async () => {
  // Review round 3, p1: an SSH flap fails the restart, executeReuse writes the
  // row failed WITH the bots/accounts it borrowed and throws for a retry.
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  const { OWN } = reuseWorld();
  const factory = STUBS.get(path.join(UTILS, "botFactory"));
  const realStart = factory.startContainer;
  let starts = 0;
  factory.startContainer = async () => {
    starts += 1;
    if (starts === 1) throw new Error("ssh: connect to host contabo port 22: Connection timed out");
  };
  const exec = require(path.join(UTILS, "farm2", "steps", "execute.js"));
  const ql = { game: "The Quinfall", gameKey: "the quinfall", mode: "live" };
  try {
    await assert.rejects(
      exec.executeDecision({ verdict: reuseVerdict(), lane: ql, af: { ...AF }, shadow: false }),
      /no bot could be restarted/,
    );
    assert.equal(OWN.status, "failed");
    assert.equal(OWN.bots.length, 1, "fixture: the failed row lists the bot it borrowed");
    const r2 = await exec.executeDecision({ verdict: reuseVerdict(), lane: ql, af: { ...AF }, shadow: false });
    assert.notEqual(r2.alreadyExecuted, true);
    assert.deepEqual(r2.restarted, ["twitchbotx5"]);
    assert.equal(starts, 2, "the retry restarted the bot");
    assert.equal(OWN.status, "active");
    assert.deepEqual(OWN.assignedAccounts, ["a1", "a2", "a3"]);
    assert.equal(calls.claimed, 0, "a reuse claims nothing");
  } finally {
    factory.startContainer = realStart;
  }
});

test("an operator rescan revives a failed reuse too, and clears its flag (round-2 bytes: refused, flag left set for ever)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  const { OWN } = reuseWorld();
  Object.assign(OWN, {
    _id: "own-q2",
    game: "The Quinfall",
    campaignId: "q2",
    status: "failed",
    decision: "reuse_existing",
    bots: [{ host: "contabo", file: "config_5.json", container: "twitchbotx5", reused: true, shared: true }],
    assignedAccounts: ["a1", "a2", "a3"],
    executedAt: hoursAgo(1),
    rescanRequested: true,
  });
  const exec = require(path.join(UTILS, "farm2", "steps", "execute.js"));
  const realLane = require(path.join(UTILS, "farm2", "lane.js"));
  assert.deepEqual(
    realLane.decisionDue({ existing: { ...OWN }, shadow: false, af: { dryRun: false } }),
    { due: true, why: "rescan" },
    "a failed row's rescan is due: it is not refused",
  );
  const r = await exec.executeDecision({
    verdict: reuseVerdict(),
    lane: { game: "The Quinfall", gameKey: "the quinfall", mode: "live" },
    af: { ...AF },
    shadow: false,
  });
  assert.notEqual(r.alreadyExecuted, true);
  assert.equal(OWN.status, "active");
  assert.equal(OWN.rescanRequested, false);
  assert.deepEqual(
    realLane.decisionDue({ existing: { ...OWN }, shadow: false, af: { dryRun: false } }),
    { due: false, why: "settled" },
  );
});

// A failed reuse row (bots borrowed, accounts listed) that is now decided as a
// FRESH farm — the reuse source is gone.
function failedRowWorld() {
  const ROW = {
    _id: "row-f1",
    game: "The Quinfall",
    campaignId: "q1",
    status: "failed",
    decision: "reuse_existing",
    executedAt: hoursAgo(2),
    bots: [{ host: "contabo", file: "config_5.json", container: "twitchbotx5", reused: true, shared: true }],
    assignedAccounts: ["b1", "b2", "b3"],
    rescanRequested: true,
  };
  const statuses = [];
  const view = () => ({ ...ROW, toObject: () => ({ ...ROW }) });
  AutoFarmTask.findOne = (f) => q(() => (f && f["bots.0"] ? null : f && f.campaignId === "q1" ? view() : null));
  AutoFarmTask.findById = () => q(() => view());
  AutoFarmTask.findOneAndUpdate = (f, u) =>
    q(() => {
      calls.records.push(u.$set);
      Object.assign(ROW, u.$set);
      statuses.push(ROW.status);
      return view();
    });
  AutoFarmTask.updateOne = (f, u) =>
    q(() => {
      Object.assign(ROW, (u && u.$set) || {});
      statuses.push(ROW.status);
      return { modifiedCount: 1 };
    });
  return { ROW, statuses };
}

test("a fresh plan over a failed row that lists accounts tops it up: keeps them, adds only what is missing, never flips it to planned (round-2 bytes: refused)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  const { ROW, statuses } = failedRowWorld();
  const exec = require(path.join(UTILS, "farm2", "steps", "execute.js"));
  const r = await exec.executeDecision({
    verdict: quinfallVerdict(), // farm, 10 planned
    lane: quinfallLane,
    af: { ...AF },
    shadow: false,
  });
  assert.notEqual(r.alreadyExecuted, true);
  assert.equal(calls.claimed, 7, "10 planned, 3 already listed");
  assert.equal(r.accounts, 7);
  assert.ok(!statuses.includes("planned"), "never read as an interrupted execute: " + statuses.join(","));
  assert.equal(ROW.status, "active");
  assert.deepEqual(ROW.assignedAccounts.slice(0, 3), ["b1", "b2", "b3"], "what it listed is kept");
  assert.equal(ROW.assignedAccounts.length, 10);
  assert.equal(ROW.bots[0].container, "twitchbotx5");
  assert.equal(ROW.bots.length, 2, "its bot plus the new one");
  assert.equal(ROW.rescanRequested, false);
});

test("the legacy tick tops up a failed row the same way (round-2 bytes: 'already_executed', never farmed)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  const { ROW, statuses } = failedRowWorld();
  LIVE = [campaign("The Quinfall", "q1")];
  EXISTING = [{ ...ROW, assignedAccounts: ROW.assignedAccounts.slice(0, 1) }];
  const summary = await autoFarmer.runOnce();
  assert.equal(summary.candidates, 1, "a rescanned failed row is re-decided");
  assert.equal(calls.records.length, 1);
  assert.equal(calls.records[0].decision, "farm");
  assert.ok(!("status" in calls.records[0]), "the plan keeps the row failed until it runs");
  assert.ok(!statuses.includes("planned"));
  const planned = calls.records[0].plannedAccounts;
  assert.ok(planned > 3, "fixture: a plan larger than what the row lists (" + planned + ")");
  assert.equal(calls.claimed, planned - 3, "adds only what is missing");
  assert.equal(ROW.status, "active");
  assert.deepEqual(ROW.assignedAccounts.slice(0, 3), ["b1", "b2", "b3"]);
});

test("a failed row's retry that places nothing stays failed — the bots it lists are the ones that did not start", async () => {
  AF = { ...AF, dryRun: false };
  const { ROW } = failedRowWorld();
  const factory = STUBS.get(path.join(UTILS, "botFactory"));
  const realCreate = factory.createBot;
  factory.createBot = async () => {
    throw new Error("compose up failed");
  };
  try {
    await assert.rejects(
      autoFarmer.executeTask({ ...ROW, plannedAccounts: 5, toObject: () => ({ ...ROW, plannedAccounts: 5 }) }, { af: { ...AF }, host: HOST }),
      /compose up failed/,
    );
  } finally {
    factory.createBot = realCreate;
  }
  assert.equal(ROW.status, "failed");
  assert.deepEqual(ROW.assignedAccounts, ["b1", "b2", "b3"], "nothing it listed is dropped");
  assert.equal(calls.claimed, 2, "5 planned, 3 listed");
});

test("a failed row whose plan it already covers adds nothing and says so", async () => {
  AF = { ...AF, dryRun: false };
  const { ROW } = failedRowWorld();
  await assert.rejects(
    autoFarmer.executeTask({ ...ROW, plannedAccounts: 3 }, { af: { ...AF }, host: HOST }),
    /Nothing to add: the failed task already lists 3 account\(s\) for a plan of 3/,
  );
  assert.equal(calls.claimed, 0);
  assert.equal(ROW.status, "failed");
});

// A retryable skip recorded over a row that still lists accounts from an
// earlier execution (before 2026-10-03 a rescanned stopped or completed task
// could be skipped like this: its inventory stays listed on the row).
function skippedLeftoversWorld() {
  const ROW = {
    _id: "row-k1",
    game: "The Quinfall",
    campaignId: "q1",
    status: "skipped",
    decision: "skip_no_capacity",
    reason: "No capacity on Contabo",
    executedAt: hoursAgo(40),
    bots: [{ host: "contabo", file: "config_7.json", container: "twitchbotx7" }],
    assignedAccounts: ["k1", "k2", "k3"],
  };
  const statuses = [];
  const view = () => ({ ...ROW, toObject: () => ({ ...ROW }) });
  AutoFarmTask.findOne = (f) => q(() => (f && f["bots.0"] ? null : f && f.campaignId === "q1" ? view() : null));
  AutoFarmTask.findById = () => q(() => view());
  AutoFarmTask.findOneAndUpdate = (f, u) =>
    q(() => {
      calls.records.push(u.$set);
      Object.assign(ROW, u.$set);
      statuses.push(ROW.status);
      return view();
    });
  AutoFarmTask.updateOne = (f, u) =>
    q(() => {
      if (f.status && f.status !== ROW.status) return { modifiedCount: 0 };
      Object.assign(ROW, (u && u.$set) || {});
      statuses.push(ROW.status);
      return { modifiedCount: 1 };
    });
  LIVE = [campaign("The Quinfall", "q1")];
  EXISTING = [{ ...ROW, assignedAccounts: ["k1"] }];
  return { ROW, statuses };
}

test("a retryable skip over a row that lists accounts is re-planned as a top-up: kept, never flipped to planned (before: planned over them, then refused for ever)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  const { ROW, statuses } = skippedLeftoversWorld();
  const summary = await autoFarmer.runOnce();
  assert.equal(summary.candidates, 1);
  assert.ok(!statuses.includes("planned"), "never read as an interrupted execute: " + statuses.join(","));
  const planned = calls.records[0].plannedAccounts;
  assert.equal(calls.claimed, planned - 3, "adds only what is missing");
  assert.equal(ROW.status, "active");
  assert.deepEqual(ROW.assignedAccounts.slice(0, 3), ["k1", "k2", "k3"], "its accounts are kept");
});

test("that top-up, unable to start (nothing claimable), puts the retryable skip back", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  const { ROW } = skippedLeftoversWorld();
  let tried = 0;
  AvailableAccount.findOneAndUpdate = () => {
    tried += 1;
    return q(null); // every claim misses
  };
  await autoFarmer.runOnce();
  assert.ok(tried > 0, "the top-up was tried");
  assert.equal(ROW.status, "skipped");
  assert.equal(ROW.decision, "skip_no_capacity", "still a retryable skip, re-decided next tick");
  assert.equal(ROW.reason, "No capacity on Contabo");
  assert.deepEqual(ROW.assignedAccounts, ["k1", "k2", "k3"]);
});

test("the lane's execute step tops up such a row too, and puts the skip back when it cannot start", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  const exec = require(path.join(UTILS, "farm2", "steps", "execute.js"));
  let world = skippedLeftoversWorld();
  const r = await exec.executeDecision({ verdict: quinfallVerdict(), lane: quinfallLane, af: { ...AF }, shadow: false });
  assert.notEqual(r.alreadyExecuted, true);
  assert.equal(calls.claimed, 7);
  assert.equal(world.ROW.status, "active");
  assert.ok(!world.statuses.includes("planned"));
  resetCalls();
  world = skippedLeftoversWorld();
  AvailableAccount.findOneAndUpdate = () => q(null);
  await assert.rejects(
    exec.executeDecision({ verdict: quinfallVerdict(), lane: quinfallLane, af: { ...AF }, shadow: false }),
    /Could not claim any pool accounts/,
  );
  assert.equal(world.ROW.status, "skipped");
  assert.equal(world.ROW.decision, "skip_no_capacity");
});

test("a rescanned completed row takes no share of the tick's pool and is decided once (round-2 bytes: halved a fresh campaign's budget, every tick)", async () => {
  // Review round 3, p2.
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  READY = 50; // poolReserve 20 -> 30 spendable this tick
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  LIVE = [campaign("Fresh Game", "f1")];
  const freshPlan = () => calls.records.filter((r) => r.game === "Fresh Game").map((r) => r.plannedAccounts);
  await autoFarmer.runOnce();
  const alone = calls.claimed;
  assert.ok(alone > 0, "fixture: the fresh campaign farms");
  const alonePlan = freshPlan();
  resetCalls();
  const stuck = {
    _id: "row-a1",
    game: "Game A",
    campaignId: "a1",
    status: "completed",
    decision: "farm",
    rescanRequested: true,
    executedAt: hoursAgo(30),
    bots: [{ host: "contabo", file: "config_3.json", container: "twitchbotx3" }],
    assignedAccounts: ["inv1"],
  };
  LIVE = [campaign("Game A", "a1"), campaign("Fresh Game", "f1")];
  EXISTING = [stuck];
  AutoFarmTask.findOne = (f) => q(() => (f && f.campaignId === "a1" ? stuck : null));
  AutoFarmTask.findById = (id) => q(() => (String(id) === "row-a1" ? stuck : null));
  AutoFarmTask.updateOne = (f, u) =>
    q(() => {
      if (f && f._id === "row-a1") Object.assign(stuck, u.$set);
      return { modifiedCount: 1 };
    });
  const s1 = await autoFarmer.runOnce();
  assert.deepEqual(freshPlan(), alonePlan, "the fresh campaign's plan is not cut by a share for the refused row");
  assert.equal(calls.claimed, alone, "and it claims what it claimed alone");
  assert.equal(s1.candidates, 1);
  assert.equal(stuck.rescanRequested, false, "settled");
  assert.equal(stuck.status, "completed");
  assert.deepEqual(stuck.assignedAccounts, ["inv1"]);
  LIVE = [campaign("Game A", "a1")];
  const s2 = await autoFarmer.runOnce();
  assert.equal(s2.candidates, 0, "not decided again");
  assert.equal(s2.rescansRefused, 0, "and not even refused again: it is no longer due");
});

test("settleRefusedTask re-reads the row, writes only a flagged refused one, keeps its earlier error, and never throws", async () => {
  const writes = [];
  AutoFarmTask.updateOne = (f, u) => q(() => (writes.push({ f, u }), { modifiedCount: 1 }));
  let row = { _id: "r1", status: "completed", rescanRequested: true, assignedAccounts: ["a", "b"], error: "old" };
  AutoFarmTask.findById = () => q(() => row);
  assert.equal(await autoFarmer.settleRefusedTask({ _id: "r1", rescanRequested: true }), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].f, { _id: "r1", status: "completed", rescanRequested: true });
  assert.equal(writes[0].u.$set.rescanRequested, false);
  assert.match(writes[0].u.$set.error, /^Not executed again \(\d{4}-\d\d-\d\d \d\d:\d\dZ\): the task is completed and keeps its 2 account\(s\); a rescan does not re-execute it \| old$/);
  assert.equal(await autoFarmer.settleRefusedTask({ ...row, rescanRequested: false }), false);
  assert.equal(writes.length, 1, "an unflagged row is not due anyway");
  // Changed since the caller read it: failed now, so it is retried, not settled.
  row = { ...row, status: "failed" };
  assert.equal(await autoFarmer.settleRefusedTask({ _id: "r1", rescanRequested: true }), false);
  assert.equal(writes.length, 1);
  AutoFarmTask.findById = () => q(new Error("db down"));
  assert.equal(await autoFarmer.settleRefusedTask({ _id: "r1", rescanRequested: true }), false);
});

test("the lane's candidate filter refuses a rescanned running, stopped, completed or interrupted row, and still decides a failed or skipped one", () => {
  const realLane = require(path.join(UTILS, "farm2", "lane.js"));
  const due = (existing) => realLane.decisionDue({ existing, shadow: false, af: { dryRun: false } });
  const t = hoursAgo(3);
  for (const status of ["active", "stopped", "completed"]) {
    assert.deepEqual(due({ status, decision: "farm", rescanRequested: true, executedAt: t, assignedAccounts: ["a"] }), { due: false, why: "refused" }, status);
  }
  assert.deepEqual(
    due({ status: "planned", decision: "farm", rescanRequested: true, executedAt: t, assignedAccounts: ["a"], decidedAt: t }),
    { due: false, why: "refused" },
    "an interrupted execute",
  );
  assert.deepEqual(due({ status: "failed", decision: "reuse_existing", rescanRequested: true, executedAt: t, bots: [{ container: "x" }] }), { due: true, why: "rescan" });
  assert.deepEqual(due({ status: "skipped", decision: "skip_low_demand", rescanRequested: true }), { due: true, why: "rescan" });
});

// The lane's job queue, in memory, behind the farm2/jobs stub.
function laneJobsQueue() {
  const JOBS = [];
  const jobsStub = STUBS.get(path.join(UTILS, "farm2/jobs"));
  const saved = { ...jobsStub };
  let n = 0;
  Object.assign(jobsStub, {
    enqueue: async (j) => {
      const row = { _id: "job" + ++n, attempts: 0, status: "queued", market: "", campaignId: "", ...j };
      JOBS.push(row);
      return row;
    },
    claimNext: async (f = {}) => {
      const j = JOBS.find((x) => x.status === "queued" && (!f._id || x._id === f._id));
      if (!j) return null;
      j.status = "running";
      return j;
    },
    claimDueForLane: async (laneKey, limit, filter) => {
      const kinds = (filter && filter.kind && filter.kind.$in) || null;
      const out = JOBS.filter((j) => j.laneKey === laneKey && j.status === "queued" && (!kinds || kinds.includes(j.kind)));
      for (const j of out) j.status = "running";
      return out;
    },
    finish: async (j, result, { status = "done" } = {}) => {
      j.status = status;
      j.result = result;
    },
    fail: async (j, e) => {
      j.status = "failed";
      j.error = e.message;
    },
  });
  return {
    JOBS,
    restore: () => {
      for (const k of Object.keys(jobsStub)) delete jobsStub[k];
      Object.assign(jobsStub, saved);
    },
  };
}

function stoppedRescannedRow() {
  return {
    _id: "row-g1",
    game: "Game A",
    campaignId: "g1",
    status: "stopped", // the operator pressed Stop: its accounts stay as inventory
    decision: "farm",
    rescanRequested: true, // ...then "Rescan all"
    executedAt: hoursAgo(20),
    createdAt: hoursAgo(20),
    bots: [{ host: "contabo", file: "config_3.json", container: "twitchbotx3" }],
    assignedAccounts: ["inv1", "inv2", "inv3"],
  };
}

test("a live lane settles a rescanned stopped task once: no decision, no budget, no execute job (round-2 bytes: all three, every cycle)", async () => {
  // Review round 3, p2b and p2c.
  AF = { ...AF, dryRun: false, hostId: "contabo", farm2Enabled: true, farm2Main: true };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  hosts.exists = async () => true;
  FarmLane.updateOne = () => q({});
  const ROW = stoppedRescannedRow();
  LIVE = [campaign("Game A", "g1")];
  AutoFarmTask.find = (f = {}) => q(() => (f.game === "Game A" && f.campaignId && f.campaignId.$in ? [ROW] : []));
  AutoFarmTask.findOne = (f = {}) =>
    q(() => {
      if (f["bots.0"]) return null;
      if (f.status && f.status.$in) return f.status.$in.includes(ROW.status) ? ROW : null;
      return f.campaignId === "g1" ? ROW : null;
    });
  AutoFarmTask.findById = () => q(() => ROW);
  const writes = [];
  AutoFarmTask.findOneAndUpdate = (f, u) => q(() => (writes.push(u.$set), Object.assign(ROW, u.$set)));
  AutoFarmTask.updateOne = (f, u) => q(() => (writes.push(u.$set), Object.assign(ROW, u.$set), { modifiedCount: 1 }));
  const { JOBS, restore } = laneJobsQueue();
  const realLane = require(path.join(UTILS, "farm2", "lane.js"));
  const { BudgetCycle } = require(path.join(UTILS, "farm2", "budget.js"));
  try {
    const drawn = [];
    const refused = [];
    for (let i = 0; i < 3; i++) {
      const cycle = new BudgetCycle({ accounts: 40, seats: 40, containers: 4, perGameCap: 60, hostConcurrency: 2, reason: "" });
      cycle.allocate([]);
      const before = cycle.unallocated;
      const summary = await realLane.runLane(
        { _id: "lane-a", game: "Game A", gameKey: "game a", mode: "live", state: "idle", consecutiveFailures: 0 },
        { cycle, af: { ...AF }, hostCache: new Map() },
      );
      drawn.push(before - cycle.unallocated);
      refused.push(summary.rescansRefused);
    }
    assert.deepEqual(drawn, [0, 0, 0], "no budget drawn");
    assert.deepEqual(JOBS.filter((j) => j.kind === "decide" || j.kind === "execute"), [], "nothing decided or queued");
    assert.deepEqual(refused, [1, 0, 0], "refused once, then no longer due");
    assert.equal(writes.length, 1, "one write: the settle");
    assert.deepEqual(Object.keys(writes[0]).sort(), ["error", "rescanRequested"]);
    assert.equal(ROW.status, "stopped");
    assert.deepEqual(ROW.assignedAccounts, ["inv1", "inv2", "inv3"]);
  } finally {
    restore();
  }
});

test("a row that turns refused between the lane's filter and its decision draws no budget and queues nothing (round-2 bytes: a stopped row drew the plan)", async () => {
  AF = { ...AF, dryRun: false, hostId: "contabo", farm2Enabled: true, farm2Main: true };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  hosts.exists = async () => true;
  FarmLane.updateOne = () => q({});
  LIVE = [campaign("Game A", "g1")];
  // The filter reads a retryable skip; by the time the decision is made the
  // operator has a stopped task there (rescanned, so it is also settled).
  const SKIP = { _id: "row-g1", game: "Game A", campaignId: "g1", status: "skipped", decision: "skip_no_accounts" };
  const NOW = stoppedRescannedRow();
  AutoFarmTask.find = (f = {}) => q(() => (f.game === "Game A" && f.campaignId && f.campaignId.$in ? [SKIP] : []));
  AutoFarmTask.findOne = (f = {}) =>
    q(() => {
      if (f["bots.0"]) return null;
      if (f.status && f.status.$in) return f.status.$in.includes(NOW.status) ? NOW : null;
      return f.campaignId === "g1" ? NOW : null;
    });
  AutoFarmTask.findById = () => q(() => NOW);
  const settled = [];
  AutoFarmTask.updateOne = (f, u) => q(() => (settled.push(u.$set), { modifiedCount: 1 }));
  const { JOBS, restore } = laneJobsQueue();
  const realLane = require(path.join(UTILS, "farm2", "lane.js"));
  const { BudgetCycle } = require(path.join(UTILS, "farm2", "budget.js"));
  try {
    const cycle = new BudgetCycle({ accounts: 40, seats: 40, containers: 4, perGameCap: 60, hostConcurrency: 2, reason: "" });
    cycle.allocate([]);
    const before = cycle.unallocated;
    const summary = await realLane.runLane(
      { _id: "lane-a", game: "Game A", gameKey: "game a", mode: "live", state: "idle", consecutiveFailures: 0 },
      { cycle, af: { ...AF }, hostCache: new Map() },
    );
    assert.equal(summary.decisions.length, 1, "fixture: the retryable skip was decided");
    assert.equal(summary.decisions[0].wouldFarm, true, "fixture: and would farm (" + summary.decisions[0].decision + ")");
    assert.equal(summary.alreadyExecuted, 1);
    assert.equal(before - cycle.unallocated, 0, "no budget drawn");
    assert.deepEqual(JOBS.filter((j) => j.kind === "execute"), []);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].rescanRequested, false);
  } finally {
    restore();
  }
});

/* ====== a deferred tick defers its listings too (review 2, H1) ====== */

const unlistedTask = (game, id) => ({ _id: "task-" + id, game, campaignId: id, status: "active", listing: { externalId: "" } });

test("main mode, lane table unreadable: the listing sweep leaves a lane's task alone (old bytes: listed it)", async () => {
  mainMode();
  LIVE = [campaign("Albion Online", "a1")];
  UNLISTED = [unlistedTask("Albion Online", "a0")];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  const s = await autoFarmer.runOnce();
  assert.equal(s.decisionsDeferred, true);
  assert.deepEqual(calls.listed, []);
});

test("main mode, lane table unreadable: the secondaries retry leaves a lane's task alone too (old bytes: retried it)", async () => {
  mainMode();
  AF = { ...AF, dryRun: false };
  LISTED = [{ _id: "task-a0", game: "Albion Online", campaignId: "a0", status: "active", listing: { externalId: "gf-1" } }];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  await autoFarmer.runOnce();
  assert.deepEqual(calls.relisted, []);
});

test("main mode, right after an invalidate(): a live lane's task is not listed by legacy (old bytes: listed it)", async () => {
  mainMode();
  UNLISTED = [unlistedTask("Albion Online", "a0")];
  LANES = () => [lane("albion online")];
  ownership.setEngineRunning(true);
  await ownership.refresh();
  // The lane engine invalidates the cache (a lane auto-created or paused)
  // between the tick's decisions and its listing sweep.
  const lister = STUBS.get(path.join(UTILS, "autoLister"));
  const realRefill = lister.refillMarkets;
  AF = { ...AF, dryRun: false };
  LISTED = [{ _id: "task-b0", game: "Black Desert", campaignId: "b0", status: "active", listing: { externalId: "gf-2" } }];
  lister.refillMarkets = async () => {
    ownership.invalidate();
    return null;
  };
  try {
    await autoFarmer.runOnce();
  } finally {
    lister.refillMarkets = realRefill;
  }
  assert.deepEqual(calls.listed, []);
});

test("main mode, warm: legacy lists what it may decide — shadow lanes, no-key games, old no-claim tasks — and not a lane's", async () => {
  mainMode();
  LANES = () => [lane("albion online"), lane("game b", "shadow")];
  UNLISTED = [
    unlistedTask("Albion Online", "a0"),
    unlistedTask("Game B", "b0"),
    unlistedTask("原神", "y0"),
    unlistedTask("No Claim Game", "n0"),
  ];
  const settingsStub = STUBS.get(path.join(UTILS, "settings"));
  const realNoClaim = settingsStub.isNoClaimGame;
  settingsStub.isNoClaimGame = (g) => g === "No Claim Game";
  try {
    ownership.setEngineRunning(true);
    await ownership.refresh();
    await autoFarmer.runOnce();
  } finally {
    settingsStub.isNoClaimGame = realNoClaim;
  }
  assert.deepEqual(calls.listed.sort(), ["task-b0", "task-n0", "task-y0"]);
});

test("outside main mode a cold cache keeps the old rule: legacy lists", async () => {
  AF = { ...AF, farm2Enabled: true, farm2Main: false };
  UNLISTED = [unlistedTask("Albion Online", "a0")];
  LANES = () => new Error("db down");
  ownership.setEngineRunning(true);
  await autoFarmer.runOnce();
  assert.deepEqual(calls.listed, ["task-a0"]);
});

/* ====== a game whose lane never comes is not farmed by nobody (review 2, H3) ====== */

test("a game with no lane for 30 min is decided by legacy, with one alert naming the real wait; its lane appearing re-arms it (old bytes: deferred for ever, silent)", async () => {
  // Start from a clean count: one tick with the lane engine stopped.
  await autoFarmer.runOnce();
  mainMode();
  AF = { ...AF, dryRun: true };
  LIVE = [campaign("Albion Online", "a1"), campaign("The Quinfall", "q1")];
  LANES = () => [lane("albion online")]; // The Quinfall's lane is never created
  ownership.setEngineRunning(true);
  const alerts = () => calls.telegram.filter((t) => /The Quinfall has had no farm2 lane for/.test(t));
  // Ten minutes between ticks, as the loop runs them.
  const tick = async () => {
    CLOCK += 10 * MIN;
    ownership.invalidate();
    calls.records = [];
    return autoFarmer.runOnce();
  };
  for (const n of [1, 2, 3]) {
    const s = await tick();
    assert.deepEqual(s.awaitingLane, ["The Quinfall"], "tick " + n + " waits for the lane");
    assert.deepEqual(calls.records, []);
  }
  let s = await tick(); // 30 min after the first tick that saw it waiting
  assert.deepEqual(s.laneFallback, ["The Quinfall"]);
  assert.deepEqual(calls.records.map((r) => r.game), ["The Quinfall"], "tick 4: legacy decides it");
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /no farm2 lane for 30 min \(4 ticks\)/);
  assert.ok(calls.events.some((e) => e.action === "lane_missing_fallback" && e.game === "The Quinfall"));
  s = await tick();
  assert.deepEqual(s.laneFallback, ["The Quinfall"]);
  assert.equal(alerts().length, 1, "one alert per streak");
  // The lane appears: the lane engine owns the game again, the wait resets.
  LANES = () => [lane("albion online"), lane("the quinfall")];
  s = await tick();
  assert.deepEqual(calls.records, []);
  assert.deepEqual(s.laneFallback, []);
  // ...and if it goes missing again, the alert is re-armed.
  LANES = () => [lane("albion online")];
  for (let i = 0; i < 4; i++) s = await tick();
  assert.equal(alerts().length, 2);
});

test("a game legacy took over for want of a lane is also listed by legacy", async () => {
  await autoFarmer.runOnce();
  mainMode();
  LIVE = [campaign("The Quinfall", "q1")];
  UNLISTED = [unlistedTask("The Quinfall", "q0")];
  LANES = () => [];
  ownership.setEngineRunning(true);
  for (let i = 0; i < 3; i++) {
    CLOCK += 10 * MIN;
    ownership.invalidate();
    await autoFarmer.runOnce();
  }
  assert.deepEqual(calls.listed, [], "waiting for its lane: the lane will list it");
  CLOCK += 10 * MIN;
  ownership.invalidate();
  await autoFarmer.runOnce();
  assert.deepEqual(calls.listed, ["task-q0"], "taken over after 30 min: legacy lists it");
});

test("'Scan now' pressed again and again does not hand a new game to legacy: ticks alone are not time (round-2 bytes: three presses did)", async () => {
  // Review round 3, p3: three ticks a moment apart reached the old 3-tick
  // fallback in milliseconds — the 10-02 Quinfall shape, legacy farming a
  // brand-new game before the supervisor's next cycle created its lane.
  await autoFarmer.runOnce();
  mainMode();
  AF = { ...AF, dryRun: false, hostId: "contabo" };
  MarketResearch.findOne = () => q({ game: "x", demandScore: 45, scannedAt: new Date(), sellers: 9 });
  LIVE = [campaign("Albion Online", "a1"), campaign("The Quinfall", "q1")];
  LANES = () => [lane("albion online")];
  ownership.setEngineRunning(true);
  let s;
  for (let i = 0; i < 5; i++) {
    CLOCK += 2000; // pressed again as soon as the last scan finished
    ownership.invalidate();
    s = await autoFarmer.runOnce();
  }
  assert.deepEqual(s.laneFallback, []);
  assert.deepEqual(s.awaitingLane, ["The Quinfall"]);
  assert.deepEqual(calls.records, []);
  assert.equal(calls.claimed, 0);
  assert.deepEqual(calls.telegram.filter((t) => /no farm2 lane/.test(t)), []);
  // Half an hour after the first of them, and it is still waiting: now legacy
  // decides it, and the alert says how long it really waited.
  CLOCK += 31 * MIN;
  ownership.invalidate();
  s = await autoFarmer.runOnce();
  assert.deepEqual(s.laneFallback, ["The Quinfall"]);
  const alert = calls.telegram.filter((t) => /no farm2 lane/.test(t));
  assert.equal(alert.length, 1);
  assert.match(alert[0], /The Quinfall has had no farm2 lane for 31 min \(6 ticks\)/);
});

test("laneFallbackDue needs both: 3 ticks and 30 minutes of waiting", () => {
  const due = autoFarmer.laneFallbackDue;
  const now = Date.now();
  assert.equal(due({ ticks: 3, since: now - 30 * MIN }, now), true);
  assert.equal(due({ ticks: 9, since: now - 29 * MIN }, now), false, "many ticks, too little time");
  assert.equal(due({ ticks: 2, since: now - 120 * MIN }, now), false, "long, but only two ticks");
  assert.equal(due(undefined, now), false);
});

/* ============ a hung lane read never freezes the tick (review p5b) ============ */
// Last in the file on purpose: on bytes without the timeout these leave a
// read pending for ever, which must not reach any other test.

// A FarmLane query that never answers (a dead connection: no error, no rows).
const hungLaneQuery = () => {
  const hung = {
    select: () => hung,
    maxTimeMS: () => hung,
    lean: () => new Promise(() => {}),
  };
  return hung;
};
const within = (p, ms) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("still waiting"), ms))]);

test("ensureFresh gives up on a lane read that never answers; the cache is cold, not wedged (old bytes: waited for ever)", async () => {
  mainMode();
  if (typeof ownership._setRefreshTimeoutForTests === "function") {
    ownership._setRefreshTimeoutForTests(40);
  }
  FarmLane.find = () => {
    calls.lanesRead += 1;
    return hungLaneQuery();
  };
  ownership.setEngineRunning(true);
  const r = await within(ownership.ensureFresh().then(() => "returned"), 1000);
  assert.equal(r, "returned");
  assert.equal(ownership.isCold(), true);
  // The next read is a new read, and a good table warms the cache again.
  FarmLane.find = () => {
    calls.lanesRead += 1;
    return q([lane("albion online")]);
  };
  await within(ownership.ensureFresh(), 1000);
  assert.equal(calls.lanesRead, 2);
  assert.equal(ownership.isCold(), false);
  assert.equal(ownership.isOwned("Albion Online"), true);
});

test("main mode with a hung lane read: the tick finishes, deferring its decisions and running its sweeps (old bytes: hung, then 'already running')", async () => {
  mainMode();
  if (typeof ownership._setRefreshTimeoutForTests === "function") {
    ownership._setRefreshTimeoutForTests(40);
  }
  FarmLane.find = () => hungLaneQuery();
  LIVE = [campaign("Game A", "a1")];
  ownership.setEngineRunning(true);
  // The previous tick's listing sweep had already started the hung read.
  ownership.isOwned("Game A");
  const r = await within(autoFarmer.runOnce(), 2000);
  assert.notEqual(r, "still waiting");
  assert.equal(r.candidates, 0);
  assert.equal(r.decisionsDeferred, true);
  assert.deepEqual(calls.records, []);
  const next = await within(autoFarmer.runOnce(), 2000);
  assert.notEqual(next, "still waiting");
  assert.notDeepEqual(next, { skipped: "already running" });
});
