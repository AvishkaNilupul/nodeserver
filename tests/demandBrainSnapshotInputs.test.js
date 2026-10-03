// The farm brain's v2 and v2g come from ONE read of the feeder's tables (review round 2, e4): the real
// utils/farmDemand.js, its opt-in `inputs` option and snapshotInputs(), and the brain's loader
// (utils/demandBrain/inputs.noclaimInputs) on top of them. No database: the five models and
// utils/settings are stubbed at require time, as tests/farmDemandEvidence.test.js does.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const I = require("../utils/demandBrain/inputs");
const M = require("../utils/demandBrain/model");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const ago = (d) => new Date(NOW - d * DAY);

// --- a world: Overwatch sales on Eldorado, optionally a hand-sale lump and a bulk pack ------------
let seq = 0;
function ledger(login, daysAgo, extra = {}) {
  seq++;
  return {
    _id: "u" + String(seq).padStart(4, "0"),
    source: "noclaim",
    login,
    loginLower: login.toLowerCase(),
    game: "Overwatch 2",
    status: "sold",
    market: "eldorado",
    soldMarket: "eldorado",
    soldAt: ago(daysAgo),
    soldPriceUsd: 4,
    set: null,
    manualListing: "",
    listedAt: ago(daysAgo + 1),
    ...extra,
  };
}
const PACK_LISTING = "cccccccccccccccccccccc01";
function world({ bursts = false } = {}) {
  const ledgers = [];
  for (let i = 0; i < 12; i++) ledgers.push(ledger("ow" + i, 2 + i * 2));
  if (bursts) {
    for (let i = 0; i < 10; i++) ledgers.push(ledger("hand" + i, 3, { soldMarket: "manual", market: "" }));
    for (let i = 0; i < 5; i++) ledgers.push(ledger("pack" + i, 5, { manualListing: PACK_LISTING }));
  }
  return {
    ledgers,
    signals: [{ gameKey: "overwatch 2", login: "ow0", source: "connected", marketplace: "", at: ago(2), priceUsd: 0, dedupeKey: "c:ow0" }],
    spent: [],
    pool: [],
    listings: [{ _id: PACK_LISTING, bulkOfferId: "offer-1", set: null, price: 9 }],
  };
}

// --- the stand-ins (the operators farmDemand's queries use; anything else throws) ------------------
function cmp(v, cond) {
  if (cond instanceof RegExp) return cond.test(v == null ? "" : String(v));
  if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$gte") return v != null && v >= arg;
      if (op === "$in") return arg.some((a) => String(a) === String(v));
      if (op === "$ne") return arg === null ? v != null : v !== arg;
      throw new Error("fake model: unsupported operator " + op);
    });
  }
  return v === cond;
}
const matches = (doc, q = {}) => Object.entries(q).every(([k, c]) => (k === "$or" ? c.some((x) => matches(doc, x)) : cmp(doc[k], c)));
function project(doc, proj) {
  if (!proj || !Object.keys(proj).length) return { ...doc };
  const out = {};
  if (proj._id !== 0 && "_id" in doc) out._id = doc._id;
  for (const [k, on] of Object.entries(proj)) if (on && k in doc) out[k] = doc[k];
  return out;
}

function fakeModels(w) {
  const reads = [];
  const finder = (name, rows) => ({
    find(q, proj) {
      reads.push({ model: name, op: "find", q });
      const out = rows().filter((r) => matches(r, q)).map((r) => project(r, proj));
      return { lean: async () => out };
    },
  });
  return {
    reads,
    UnclaimedAccount: {
      ...finder("UnclaimedAccount", () => w.ledgers),
      async aggregate() {
        reads.push({ model: "UnclaimedAccount", op: "aggregate" });
        const by = new Map();
        for (const l of w.ledgers) {
          const k = l.game + "\u0000" + l.status;
          const cur = by.get(k) || by.set(k, { _id: { g: l.game, s: l.status }, n: 0 }).get(k);
          cur.n++;
        }
        return [...by.values()];
      },
    },
    SaleSignal: {
      async distinct(field) {
        reads.push({ model: "SaleSignal", op: "distinct" });
        return [...new Set(w.signals.map((s) => s[field]))];
      },
      async aggregate(pipeline) {
        reads.push({ model: "SaleSignal", op: "aggregate" });
        const groups = new Map();
        for (const s of w.signals.filter((x) => matches(x, pipeline[0].$match))) {
          const who = s.login > "" ? s.login : "anon:" + s.dedupeKey;
          const k = s.gameKey + "\u0000" + who;
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { _id: { g: s.gameKey, who }, sources: [], markets: [], priceUsd: 0, at: null, first: null }));
          if (!g.sources.includes(s.source)) g.sources.push(s.source);
          if (!g.markets.includes(s.marketplace)) g.markets.push(s.marketplace);
          g.priceUsd = Math.max(g.priceUsd, s.priceUsd || 0);
          if (!g.at || s.at > g.at) g.at = s.at;
          if (!g.first || s.at < g.first) g.first = s.at;
        }
        return [...groups.values()];
      },
    },
    NoclaimSpentAccount: finder("NoclaimSpentAccount", () => w.spent),
    AvailableAccount: finder("AvailableAccount", () => w.pool),
    MarketplaceListing: finder("MarketplaceListing", () => w.listings),
  };
}

const fakeSettings = () => ({
  normGameName: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  getAutoFarm: () => ({ noClaimGames: ["overwatch"], noclaimBurstGuard: false }),
  getNoclaimSizing: () => ({ coverageDays: 28, safetyStock: 6, coverageDaysFor: () => 28, safetyStockFor: () => 6, minFor: () => 0, maxFor: () => 250 }),
});

function loadFarmDemand(w) {
  const models = fakeModels(w);
  const stubs = new Map([
    [require.resolve("../models/AvailableAccount"), models.AvailableAccount],
    [require.resolve("../models/NoclaimSpentAccount"), models.NoclaimSpentAccount],
    [require.resolve("../models/SaleSignal"), models.SaleSignal],
    [require.resolve("../models/UnclaimedAccount"), models.UnclaimedAccount],
    [require.resolve("../models/MarketplaceListing"), models.MarketplaceListing],
    [require.resolve("../utils/settings"), fakeSettings()],
  ]);
  const target = require.resolve("../utils/farmDemand");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    return stubs.has(resolved) ? stubs.get(resolved) : origLoad.apply(this, arguments);
  };
  delete require.cache[target];
  try {
    return { fd: require("../utils/farmDemand"), reads: models.reads };
  } finally {
    Module._load = origLoad;
    delete require.cache[target];
  }
}

async function atNow(fn) {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// One snapshot's three reads, told apart by their query: the evidence's ledger read (window + 90
// days of history), the stock aggregate and the time-to-sale read.
const evidenceReads = (reads, days) => reads.filter((r) => r.model === "UnclaimedAccount" && r.op === "find" && r.q.soldAt && !r.q.listedAt && r.q.soldAt.$gte.getTime() === NOW - (days + 90) * DAY).length;
const stockReads = (reads) => reads.filter((r) => r.model === "UnclaimedAccount" && r.op === "aggregate").length;
const ttsReads = (reads) => reads.filter((r) => r.model === "UnclaimedAccount" && r.op === "find" && r.q.listedAt).length;

/* ------------------------------------------------------------------------------------------------ */

test("farmDemand's opt-in `inputs`: a snapshot built from snapshotInputs() is the one that reads for itself — the default path is untouched", async () => {
  await atNow(async () => {
    const w = world({ bursts: true });
    const { fd, reads } = loadFarmDemand(w);
    for (const burstGuard of [false, true]) {
      const own = await fd.unclaimedDemandSnapshot({ days: 30, burstGuard });
      const shared = await fd.unclaimedDemandSnapshot({ days: 30, burstGuard, inputs: await fd.snapshotInputs({ days: 30 }) });
      assert.deepEqual(shared, own, "burstGuard " + burstGuard);
    }
    const rows = await fd.unclaimedDemandSnapshot({ days: 30, burstGuard: true });
    assert.ok(rows[0].sales.burstSales > 0, "the world does exercise the guard");
    // given inputs, the snapshot reads nothing at all
    const inputs = await fd.snapshotInputs({ days: 30 });
    reads.length = 0;
    await fd.unclaimedDemandSnapshot({ days: 30, burstGuard: true, inputs });
    await fd.unclaimedDemandSnapshot({ days: 30, burstGuard: false, inputs });
    assert.deepEqual(reads, []);
  });
});

test("round 2 (e4) — the brain reads the feeder's tables ONCE for both rules: one evidence, one stock, one time-to-sale read", async () => {
  await atNow(async () => {
    const { fd, reads } = loadFarmDemand(world({ bursts: true }));
    const nc = await I.noclaimInputs({ farmDemand: fd }, { guardLive: false });
    assert.equal(nc.snap.length, 1);
    assert.equal(nc.alt.length, 1);
    // before: 2, 2 and 2 — the second snapshot repeated every read of the first
    assert.equal(evidenceReads(reads, 30), 1, "the snapshots' 30-day evidence");
    assert.equal(stockReads(reads), 1);
    assert.equal(ttsReads(reads), 1);
    assert.equal(evidenceReads(reads, M.HISTORY_DAYS), 1, "plus the brain's own 135-day evidence for the other estimators");
    // and the two rows are the guard's two answers on that one read
    assert.ok(nc.alt[0].sales.otherPerWeek < nc.snap[0].sales.otherPerWeek, "the hand sales and the pack, guarded");
    assert.equal(nc.alt[0].sales.count, nc.snap[0].sales.count);
  });
});

test("round 2 (e4) — a sale written while the brain reads cannot land in one rule only: with nothing to guard, v2g = v2", async () => {
  await atNow(async () => {
    const w = world();
    const { fd } = loadFarmDemand(w);
    // the reviewer's race: three Eldorado sales land right after the first snapshot call
    let landed = false;
    const raced = {
      ...fd,
      unclaimedDemandSnapshot: async (o) => {
        const r = await fd.unclaimedDemandSnapshot(o);
        if (!landed) {
          landed = true;
          for (let i = 0; i < 3; i++) w.ledgers.push(ledger("late" + i, 0.1));
        }
        return r;
      },
    };
    const nc = await I.noclaimInputs({ farmDemand: raced }, { guardLive: false });
    const snapRow = nc.snap[0];
    const altRow = nc.alt[0];
    // before: 12 sales for v2 and 15 for v2g, est.v2 6 and est.v2g 9 (review 2, e4)
    assert.equal(altRow.sales.count, snapRow.sales.count);
    const v = M.noclaimVerdict({ snapRow, altRow, entries: nc.evidence.get("overwatch") || [], now: NOW, cfg: M.readConfig({ demandBrain: { enabled: true } }), demandRates: fd.demandRates, guardLive: false });
    assert.equal(v.est.v2g, v.est.v2);
  });
});

test("a farmDemand without snapshotInputs (an older build) is still asked for both rules, as before", async () => {
  await atNow(async () => {
    const { fd, reads } = loadFarmDemand(world());
    const older = { ...fd };
    delete older.snapshotInputs;
    const nc = await I.noclaimInputs({ farmDemand: older }, { guardLive: false });
    assert.equal(nc.alt.length, 1);
    assert.equal(evidenceReads(reads, 30), 2, "two reads: the older behaviour");
  });
});
