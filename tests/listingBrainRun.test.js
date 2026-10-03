// The listing brain's runner (utils/listingBrain/index.js): the switch, one run at a time, the
// timeout, the log (one run document and its rows — nothing else), failure isolation, the daily
// per-listing forecasts, the cool-down memory, the heartbeat, the scheduler and the three answers.
// Everything is injected (loader, models, settings, clock): no Mongo, no network.
/* global setInterval, clearInterval */
const test = require("node:test");
const assert = require("node:assert/strict");

const B = require("../utils/listingBrain");
const M = require("../utils/listingBrain/model");
const { generate } = require("../scripts/listing-brain-fixture");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 3, 12);

function afWith(brain) {
  return { getAutoFarm: () => ({ listingBrain: brain }) };
}

// A fake Run/Row pair that records what would have been written, with the few read shapes the
// runner uses (findOne/find + sort/limit/lean chains).
function fakeModels({ failRows = false, failRun = false, seenDay = null } = {}) {
  const runs = [];
  const rows = [];
  // every write and every findOne filter, in order (the write order and the day query are rules)
  const writes = [];
  const filters = [];
  let ids = 0;
  const chain = (value) => {
    const q = {
      sort: () => q,
      limit: () => q,
      lean: async () => (typeof value === "function" ? value() : value),
    };
    return q;
  };
  return {
    runs,
    rows,
    writes,
    filters,
    newId: () => "run" + ++ids,
    Run: () => ({
      create: async (doc) => {
        writes.push({ what: "run", _id: doc._id });
        if (failRun) throw new Error("run write refused");
        const saved = { ...JSON.parse(JSON.stringify(doc)), _id: doc._id || "run" + (runs.length + 1) };
        runs.push(saved);
        return saved;
      },
      findOne: (filter) =>
        chain(() => {
          filters.push(filter);
          // firstOfDay: the day's time range on `at` (an index), never the unindexed `day` field
          if (filter && filter.at && filter.at.$lt) {
            const from = new Date(filter.at.$gte).getTime();
            const to = new Date(filter.at.$lt).getTime();
            if (seenDay && Date.parse(seenDay + "T00:00:00Z") === from) return { _id: "old" };
            return runs.find((r) => new Date(r.at).getTime() >= from && new Date(r.at).getTime() < to && r.fcN > 0) || null;
          }
          if (filter && filter._id) return runs.find((r) => r._id === filter._id) || null;
          const withFc = runs.filter((r) => r.fcN > 0);
          return withFc.length ? withFc[withFc.length - 1] : runs[runs.length - 1] || null;
        }),
      find: () => chain(() => runs.filter((r) => r.fcN > 0).map((r) => ({ _id: r._id, at: r.at, day: r.day }))),
    }),
    Row: () => ({
      insertMany: async (list, opts) => {
        writes.push({ what: "rows", n: list.length, opts });
        if (failRows) throw new Error("rows write refused");
        rows.push(...list);
        return list;
      },
      find: (filter) => chain(() => rows.filter((r) => (!filter.run || r.run === filter.run) && (!filter.k || (r.k === filter.k && r.f === filter.f && r.m === filter.m)))),
    }),
  };
}

function setup({ enabled = true, models = fakeModels(), load = null, now = NOW, brain = {} } = {}) {
  B._reset();
  const logs = [];
  const errs = [];
  let t = now;
  B._setHooks({
    settings: () => afWith({ enabled, ...brain }),
    load: load || (async () => generate({ seed: 1, now: t })),
    Run: models.Run,
    Row: models.Row,
    newId: models.newId,
    log: (...a) => logs.push(a.join(" ")),
    logErr: (...a) => errs.push(a.join(" ")),
    now: () => t,
  });
  return { models, logs, errs, setNow: (v) => (t = v) };
}

test.afterEach(() => B._reset());

test("off by default: nothing is computed or written", async () => {
  const models = fakeModels();
  B._reset();
  B._setHooks({ settings: () => ({ getAutoFarm: () => ({}) }), Run: models.Run, Row: models.Row, load: async () => assert.fail("must not load") });
  const r = await B.runOnce();
  assert.deepEqual(r, { skipped: "off" });
  assert.equal(models.runs.length, 0);
  assert.equal(models.rows.length, 0);
  assert.equal(B.readConfig().enabled, false);
});

test("a typo or an object never turns it on; only an explicit on does", () => {
  for (const v of ["yes please", { on: true }, null, 2, "false", "off"]) assert.equal(M.readConfig({ listingBrain: { enabled: v } }).enabled, false, String(v));
  for (const v of [true, "true", "on", 1, "1"]) assert.equal(M.readConfig({ listingBrain: { enabled: v } }).enabled, true, String(v));
});

test("a run logs one run document and its cell rows — and nothing else", async () => {
  const { models, logs } = setup();
  const r = await B.runOnce();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.persisted, true);
  assert.equal(models.runs.length, 1);
  assert.ok(models.rows.length > 0);
  assert.equal(models.rows.length, models.runs[0].rowsN);
  for (const row of models.rows) {
    assert.equal(row.run, "run1");
    assert.equal(row.why, undefined, "reasons are kept in memory only");
    assert.ok(["claim", "noclaim"].includes(row.f));
  }
  assert.ok(logs.some((l) => l.startsWith("listingBrain: run 1")), logs.join("\n"));
  const mem = await B.latest();
  assert.ok(mem.rows.some((row) => Array.isArray(row.why)), "the newest run keeps its reasons in memory");
  assert.equal(mem.fc, undefined, "the per-listing forecasts are not kept on the in-memory run document");
});

test("one run at a time: a second call while the first loads is skipped", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  setup({ load: async () => (await gate, generate({ seed: 1, now: NOW })) });
  const first = B.runOnce();
  const second = await B.runOnce();
  assert.deepEqual(second, { skipped: "already running" });
  release();
  assert.equal((await first).ok, true);
});

test("a load that outlives the timeout logs nothing and blocks new runs until it settles", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { models } = setup({ load: async () => (await gate, generate({ seed: 1, now: NOW })) });
  B._setHooks({ runTimeoutMs: 30 });
  // The runner's timeout timer is unref'd (it must never keep the server alive on its own), so while
  // the gated load is the only thing pending, a ref'd timer keeps the test's event loop running.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const r = await B.runOnce();
    assert.match(r.error, /took longer/);
    assert.equal(models.runs.length, 0);
    assert.deepEqual(await B.runOnce(), { skipped: "already running" });
    release();
    await new Promise((res) => setTimeout(res, 10));
    B._setHooks({ runTimeoutMs: 5000 });
    assert.equal((await B.runOnce()).ok, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a failed load writes nothing; the next run still happens", async () => {
  let fail = true;
  const { models, errs } = setup({ load: async () => (fail ? Promise.reject(new Error("report unreadable")) : generate({ seed: 1, now: NOW })) });
  const r = await B.runOnce();
  assert.match(r.error, /report unreadable/);
  assert.equal(models.runs.length, 0);
  assert.equal(models.rows.length, 0);
  assert.ok(errs.some((e) => /run failed/.test(e)));
  assert.equal(B.status().lastRunAt, null, "a failed load leaves lastRunAt alone, so a stuck brain shows as late");
  fail = false;
  assert.equal((await B.runOnce()).ok, true);
});

test("a loader that returns something else is a failed load, not a run", async () => {
  const { models } = setup({ load: async () => ({ hello: "world" }) });
  const r = await B.runOnce();
  assert.ok(r.error);
  assert.equal(models.runs.length, 0);
});

test("a failed row insert is reported as NOT LOGGED, never thrown; the run is still visible", async () => {
  const models = fakeModels({ failRows: true });
  const { logs } = setup({ models });
  const r = await B.runOnce();
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.equal(B.status().lastPersisted, false);
  assert.match(B.status().lastError, /log write failed/);
  assert.ok(logs.some((l) => /NOT LOGGED/.test(l)), logs.join("\n"));
  const mem = await B.latest();
  assert.equal(mem.persisted, false);
  assert.ok(mem.rows.length > 0);
});

test("a failed run-document write is reported the same way (its rows, written first, expire with their TTL)", async () => {
  const models = fakeModels({ failRun: true });
  setup({ models });
  const r = await B.runOnce();
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.equal(models.runs.length, 0, "no run document: the day does not count as sampled");
  assert.ok(models.rows.length > 0 && models.rows.every((row) => row.exp instanceof Date));
  assert.match(B.status().lastError, /log write failed/);
});

/* ------------------------- review batch 2: the runner's fixes ------------------------- */

test("P20-13 rows first, then the run document under the id they point to; a failed row insert leaves no run document", async () => {
  const { models } = setup();
  await B.runOnce();
  assert.deepEqual(
    models.writes.map((w) => w.what),
    ["rows", "run"],
    "the run document — what marks a day as sampled — is written last",
  );
  assert.equal(models.runs[0]._id, "run1", "the id was made before any write");
  assert.ok(models.rows.every((row) => row.run === "run1"));
  // a failed row insert: no run document at all, so firstOfDay and dailySamples never see a half-written sample
  const failing = fakeModels({ failRows: true });
  setup({ models: failing });
  const r = await B.runOnce();
  assert.equal(r.persisted, false);
  assert.deepEqual(
    failing.writes.map((w) => w.what),
    ["rows"],
  );
  assert.equal(failing.runs.length, 0);
  assert.notEqual(B._state.fcDay, new Date(NOW).toISOString().slice(0, 10), "the day is not marked as sampled");
});

test("P20-14 rows are inserted lean and unordered (already typed: no per-document casting)", async () => {
  const { models } = setup();
  await B.runOnce();
  const w = models.writes.find((x) => x.what === "rows");
  assert.deepEqual(w.opts, { ordered: false, lean: true });
  for (const row of models.rows) {
    assert.ok(row.at instanceof Date && row.exp instanceof Date, "dates are Dates, not strings to cast");
    assert.equal(typeof row.run, "string", "the pre-made id (an ObjectId in production)");
  }
});

test("P20-14 the default id is a real ObjectId, made lazily (a lean insert casts nothing; requiring the runner loads no mongoose)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "utils", "listingBrain", "index.js"), "utf8");
  assert.match(src, /newId: \(\) => new \(require\("mongoose"\)\.Types\.ObjectId\)\(\)/, "the default hook");
  const mongoose = require("mongoose");
  assert.ok(mongoose.isValidObjectId(new mongoose.Types.ObjectId()));
});

test("P20-11 the restart check reads the day's runs by their `at` range (indexed), never by the unindexed `day`", async () => {
  const day = new Date(NOW).toISOString().slice(0, 10);
  const models = fakeModels({ seenDay: day });
  setup({ models });
  await B.runOnce();
  assert.equal(models.runs[0].fcN, 0, "a sample already logged today: no second one");
  const f = models.filters.find((x) => x && x.at && x.at.$lt);
  assert.ok(f, "the day's range was queried");
  assert.equal(f.day, undefined);
  assert.equal(new Date(f.at.$gte).getTime(), Date.parse(day + "T00:00:00Z"));
  assert.equal(new Date(f.at.$lt).getTime(), Date.parse(day + "T00:00:00Z") + DAY);
  assert.deepEqual(f.fcN, { $gt: 0 });
  // a run logged earlier the same UTC day (a restart without the in-memory flag) is found by its `at`
  const again = fakeModels();
  setup({ models: again });
  await B.runOnce();
  B._state.fcDay = "";
  B._setHooks({ now: () => NOW + 2 * 3600000 });
  await B.runOnce();
  assert.ok(again.runs[0].fcN > 0);
  assert.equal(again.runs[1].fcN, 0, "found by its at, so no second daily sample");
});

test("M7 a tick that reads the switch off drops the newest run and its evidence: the three answers abstain", async () => {
  const { logs } = setup();
  await B.runOnce();
  assert.ok(B._state.run && B._state.bundle);
  const q = { marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest" };
  B._setHooks({ settings: () => afWith({ enabled: false }) });
  await B._tick();
  B.stop();
  assert.equal(B._state.run, null);
  assert.equal(B._state.bundle, null);
  assert.ok(B._state.latest, "the page still shows the newest run, with its age");
  const p = B.priceFor(q);
  assert.equal(p.confidence, "none");
  assert.equal(p.price, 1.25);
  assert.deepEqual(B.shelfFor({ game: "alpha quest", farm: "claim", stock: 4 }).shelf, {});
  assert.equal(B.valueFor("alpha quest").value, null);
  assert.ok(logs.some((l) => /off —/.test(l)));
});

test("M7 the three answers are asked with the runner's clock (`now`), so the model can abstain from a stale run", () => {
  B._reset();
  const seen = [];
  const keep = { p: M.priceForRun, s: M.shelfForRun, v: M.valueForRun };
  M.priceForRun = (run, q, o) => (seen.push(["price", o]), { price: 1, confidence: "none" });
  M.shelfForRun = (run, q, o) => (seen.push(["shelf", o]), { shelf: {} });
  M.valueForRun = (run, g, o) => (seen.push(["value", o]), { value: null });
  try {
    B._setHooks({ now: () => NOW + 5 * DAY });
    B.priceFor({ marketplace: "gameflip", basePriceUsd: 1 });
    B.shelfFor({ game: "g", stock: 1 });
    B.valueFor("g");
  } finally {
    Object.assign(M, { priceForRun: keep.p, shelfForRun: keep.s, valueForRun: keep.v });
  }
  assert.deepEqual(
    seen.map(([w, o]) => [w, o && o.now]),
    [
      ["price", NOW + 5 * DAY],
      ["shelf", NOW + 5 * DAY],
      ["value", NOW + 5 * DAY],
    ],
  );
});

test("C5 accuracy with the brain off and no evidence reads nothing: 'no run yet'", async () => {
  const models = fakeModels();
  let loads = 0;
  let reads = 0;
  B._reset();
  B._setHooks({
    settings: () => afWith({ enabled: false }),
    load: async () => (loads++, generate({ seed: 1, now: NOW })),
    Run: () => ({ ...models.Run(), find: (...a) => (reads++, models.Run().find(...a)), findOne: (...a) => (reads++, models.Run().findOne(...a)) }),
    Row: models.Row,
    log: () => {},
    logErr: () => {},
    now: () => NOW,
  });
  const a = await B.accuracy({ force: true });
  assert.equal(a.empty, true);
  assert.match(a.reason, /No run yet/);
  assert.equal(loads, 0, "no load");
  assert.equal(reads, 0, "no log read");
  assert.equal(B._state.bundle, null);
});

test("C5 accuracy never starts a load beside a run's: while a run is loading it answers 'loading'", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let loads = 0;
  setup({ load: async () => (loads++, await gate, generate({ seed: 1, now: NOW })) });
  const run = B.runOnce();
  const a = await B.accuracy({ force: true });
  assert.equal(a.empty, true);
  assert.match(a.reason, /loading/);
  assert.equal(loads, 1, "only the run's load");
  release();
  assert.equal((await run).ok, true);
});

test("C5 accuracy's own load goes through the run's guard and timeout: a run waits for it, a hung load cannot wedge it", async () => {
  // a slow load: while the scorer loads, a run is skipped (one load at a time)
  let release;
  const gate = new Promise((r) => (release = r));
  setup({ load: async () => (await gate, generate({ seed: 1, now: NOW })) });
  const acc = B.accuracy({ force: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await B.runOnce(), { skipped: "already running" });
  release();
  const a = await acc;
  assert.ok(a.backtest && a.forward, "scored once its load landed");
  assert.ok(B._state.bundle, "and the bundle is kept for the next call");
  // a hung load: the answer comes back after the run timeout, with the reason; nothing is left inflight
  setup({ load: () => new Promise(() => {}) });
  B._setHooks({ runTimeoutMs: 30 });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const h = await B.accuracy({ force: true });
    assert.equal(h.empty, true);
    assert.match(h.reason, /could not be read: inputs took longer/);
    assert.equal(B._state.accuracyInflight, null);
    const again = await B.accuracy({ force: true });
    assert.match(again.reason, /loading/, "the hung load still holds the guard: no second load is started");
  } finally {
    clearInterval(keepAlive);
  }
});

test("C5 accuracy reuses the newest run's bundle whatever its age, and says how old it is", async () => {
  let loads = 0;
  const { setNow } = setup({ load: async () => (loads++, generate({ seed: 1, now: NOW })) });
  await B.runOnce({ persist: false });
  assert.equal(loads, 1);
  setNow(NOW + 3 * DAY);
  const a = await B.accuracy({ force: true });
  assert.equal(loads, 1, "no reload: the bundle in memory is used");
  assert.equal(new Date(a.evidenceAt).getTime(), NOW);
  assert.equal(a.evidenceAgeH, 72);
});

test("persist: false computes and keeps the run in memory but writes nothing", async () => {
  const { models, logs } = setup();
  const r = await B.runOnce({ persist: false });
  assert.equal(r.ok, true);
  assert.equal(models.runs.length, 0);
  assert.equal(models.rows.length, 0);
  const mem = await B.latest();
  assert.equal(mem.logged, false);
  assert.ok(mem.rows.length > 0);
  assert.equal(B.status().lastPersisted, null);
  assert.ok(logs.some((l) => /persist off/.test(l)));
});

test("force runs while switched off (the staging check); the scheduler never forces", async () => {
  const { models } = setup({ enabled: false });
  assert.deepEqual(await B.runOnce(), { skipped: "off" });
  assert.equal((await B.runOnce({ force: true })).ok, true);
  assert.equal(models.runs.length, 1);
});

test("per-listing forecasts are written once a UTC day: the first run of the day only", async () => {
  const { models, setNow } = setup();
  await B.runOnce();
  setNow(NOW + 3 * 3600000);
  await B.runOnce();
  setNow(NOW + DAY);
  await B.runOnce();
  assert.equal(models.runs.length, 3);
  assert.ok(models.runs[0].fcN > 0, "first run of the day carries the forecasts");
  assert.equal(models.runs[1].fcN, 0);
  assert.equal(models.runs[1].fc, null);
  assert.ok(models.runs[2].fcN > 0, "the next day's first run carries them again");
  for (const f of models.runs[0].fc) {
    assert.equal(typeof f.l, "string");
    assert.ok(["claim", "noclaim"].includes(f.f));
    assert.ok(f.p == null || (f.p >= 0 && f.p <= 1));
  }
});

test("a restart in the middle of a day does not write a second daily sample", async () => {
  const day = new Date(NOW).toISOString().slice(0, 10);
  const models = fakeModels({ seenDay: day });
  setup({ models });
  await B.runOnce();
  assert.equal(models.runs[0].fcN, 0);
});

test("the daily forecasts are capped by fcCap", async () => {
  const { models } = setup({ brain: { fcCap: 3 } });
  await B.runOnce();
  assert.ok(models.runs[0].fcN <= 3);
  assert.ok(models.runs[0].notes.some((n) => /capped/.test(n)) || models.runs[0].fcN < 3);
});

test("the cool-down memory is filled from advised moves and read back after a restart", async () => {
  const { models } = setup();
  await B.runOnce();
  const moved = (models.runs[0].fc || []).filter((f) => ["lower", "raise", "test"].includes(f.a));
  for (const f of moved) assert.equal(B._state.prior.get(f.l).a, f.a);
  // A restart: the in-memory map is gone, the log is not.
  const kept = models.runs.slice();
  B._reset();
  const again = fakeModels();
  again.runs.push(...kept);
  B._setHooks({ settings: () => afWith({ enabled: true }), load: async () => generate({ seed: 1, now: NOW + 3600000 }), Run: again.Run, Row: again.Row, log: () => {}, logErr: () => {}, now: () => NOW + 3600000 });
  await B.runOnce();
  for (const f of moved) assert.ok(B._state.prior.has(f.l), "advised move read back for the cool-down");
});

test("loopStatus never throws, and unreadable settings read as off", () => {
  B._reset();
  B._setHooks({
    settings: () => {
      throw new Error("settings.json damaged");
    },
  });
  const s = B.loopStatus();
  assert.equal(s.enabled, false);
  assert.equal(s.lastRunAt, null);
  assert.equal(s.since, null);
  assert.equal(typeof s.intervalMin, "number");
});

test("start is idempotent; stop clears the timer; a tick while off logs once and re-arms", async () => {
  const { logs } = setup({ enabled: false });
  assert.equal(B.start(), true);
  assert.equal(B.start(), false);
  assert.ok(B._state.timer);
  assert.ok(B.loopStatus().since instanceof Date);
  await B._tick();
  await B._tick();
  assert.equal(logs.filter((l) => /off — autoFarm.listingBrain.enabled/.test(l)).length, 1);
  B.stop();
  assert.equal(B._state.timer, null);
  assert.equal(B.loopStatus().since, null);
});

test("requiring the runner starts nothing", () => {
  B._reset();
  assert.equal(B._state.started, false);
  assert.equal(B._state.timer, null);
});

test("with no run in memory the three answers are today's, with confidence none", () => {
  B._reset();
  const p = B.priceFor({ marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest" });
  assert.equal(p.price, 1.25);
  assert.equal(p.confidence, "none");
  const s = B.shelfFor({ game: "alpha quest", farm: "claim", stock: 7 });
  assert.deepEqual(s.shelf, {});
  assert.equal(s.reserve, 7);
  const v = B.valueFor("alpha quest");
  assert.equal(v.value, null);
});

test("cellHistory reads one cell by its key, newest first, bounded", async () => {
  const { models } = setup();
  await B.runOnce();
  const any = models.rows.find((r) => r.m !== "all");
  const hist = await B.cellHistory(any.k + "|" + any.f + "|" + any.m, 5);
  assert.ok(hist.length >= 1);
  assert.ok(hist.every((r) => r.k === any.k && r.f === any.f && r.m === any.m));
  assert.deepEqual(await B.cellHistory("no-pipes"), []);
});

test("rows are written sparse: no reasons, no nulls/false/empties, zero action counts dropped — every other 0 kept", () => {
  const row = {
    k: "alpha quest", g: "Alpha Quest", f: "claim", m: "gameflip", live: false, hl: null, pc: "agree", sc: "",
    old: { a: null, n: 0, np: 1.5, sh: 0, cur: 0 },
    br: { p: 1.5, ref: null, sh: 0, a: { hold: 2, lower: 0, raise: 0, test: 0, ladder: 0 } },
    pol: { old: 1.5, tracker: null, curve: 1.5, clear: null },
    pf: { flat: 0, share30: 0.4, instock: null, newsvendor: 0 },
    ev: { thin: false, el: "open" },
    fl: [],
    why: ["a reason"],
  };
  const c = B.compact(row);
  assert.equal(c.why, undefined);
  assert.equal(c.live, undefined);
  assert.equal(c.hl, undefined);
  assert.equal(c.fl, undefined);
  assert.equal(c.sc, "", "strings are kept, even empty ones");
  assert.deepEqual(c.old, { n: 0, np: 1.5, sh: 0, cur: 0 });
  assert.deepEqual(c.br.a, { hold: 2 });
  assert.equal(c.br.sh, 0, "a shelf of 0 is a number, not an absence");
  assert.deepEqual(c.pf, { flat: 0, share30: 0.4, newsvendor: 0 }, "a forecast of 0 is kept: missing is not zero");
  assert.deepEqual(c.ev, { el: "open" });
  // Read back, it has the in-memory shape again (minus its reasons).
  const e = B.expand(c);
  assert.deepEqual(e.br.a, { hold: 2, lower: 0, raise: 0, test: 0, ladder: 0 });
  assert.equal(e.live, false);
  assert.deepEqual(e.fl, []);
  assert.equal(e.pf.instock, undefined);
  assert.equal(e.pol.tracker, undefined);
  assert.deepEqual(B.expand({ k: "x", f: "claim", m: "all" }).br, {});
});

test("rows of the day's first run are kept 21 days; every other run's rows 3 days (P20-12)", async () => {
  const { models, setNow } = setup();
  await B.runOnce();
  setNow(NOW + 3 * 3600000);
  await B.runOnce();
  const first = models.rows.filter((r) => r.run === "run1");
  const second = models.rows.filter((r) => r.run === "run2");
  assert.ok(first.length && second.length);
  assert.ok(first.every((r) => r.exp.getTime() === NOW + B.ROW_KEEP_DAYS_DAILY * DAY));
  assert.ok(second.every((r) => r.exp.getTime() === NOW + 3 * 3600000 + B.ROW_KEEP_DAYS_OTHER * DAY));
  assert.deepEqual([B.ROW_KEEP_DAYS_DAILY, B.ROW_KEEP_DAYS_OTHER], [21, 3]);
});

test("the row schema keeps a sparse row sparse (no defaults filled back in) and keeps every field the runner writes", () => {
  const Row = require("../models/ListingBrainRow");
  const row = B.compact({ k: "g", g: "G", f: "noclaim", m: "ggsel", pc: "agree", sc: "managed", old: { n: 0 }, br: { p: 1, a: { hold: 1 } }, pol: { curve: 1 }, pf: { flat: 0 }, ev: { el: "open" }, fl: ["managed"] });
  const doc = new Row({ ...row, run: "507f1f77bcf86cd799439011", at: new Date(NOW), exp: new Date(NOW) }).toObject();
  for (const k of Object.keys(row)) assert.deepEqual(doc[k], row[k], k);
  for (const k of ["live", "hl"]) assert.equal(doc[k], undefined, k + " stays absent");
});

/* ------------------------- review findings: error text (P4) ------------------------- */

test("P4 the runner's lastError, its notes and its console lines carry cleaned error text", async () => {
  const HOSTY = /myshop|mongo-primary-7|\/var\/www|jdoefarm01/;
  // a load that fails with infrastructure in its message
  const a = setup({
    load: async () => {
      throw new Error("getaddrinfo ENOTFOUND db01.prod.myshop.lk at /var/www/app/utils/x.js");
    },
  });
  const r = await B.runOnce();
  assert.match(r.error, /ENOTFOUND/, "the error's code word stays");
  assert.ok(!HOSTY.test(r.error), r.error);
  assert.ok(!HOSTY.test(B.status().lastError), B.status().lastError);
  assert.ok(!a.errs.some((e) => HOSTY.test(e)), a.errs.join("\n"));
  // a failed log write and an unreadable cool-down history
  const base = fakeModels();
  const models = {
    ...base,
    Run: () => ({
      ...base.Run(),
      findOne: (filter) => {
        const fail = async () => {
          throw new Error("connection 5 to db.myshop.lk:27017 closed; getaddrinfo ENOTFOUND mongo-primary-7");
        };
        return { sort: () => ({ lean: fail }), lean: filter && filter.day ? async () => null : fail };
      },
    }),
    Row: () => ({
      ...base.Row(),
      insertMany: async () => {
        throw new Error('E11000 duplicate key error dup key: { login: "jdoefarm01" } host mongo-primary-7 /var/www/nodeserver');
      },
    }),
  };
  const b = setup({ models });
  const r2 = await B.runOnce();
  assert.equal(r2.ok, true);
  assert.equal(r2.persisted, false);
  const st = B.status();
  assert.match(st.lastError, /log write failed: E11000 duplicate key/);
  assert.ok(!HOSTY.test(st.lastError), st.lastError);
  const mem = await B.latest();
  const note = mem.notes.find((n) => /cool-down history/.test(n));
  assert.ok(note, mem.notes.join(" | "));
  assert.match(note, /ENOTFOUND/);
  assert.ok(!HOSTY.test(note), note);
  assert.ok(!b.errs.some((e) => HOSTY.test(e)), b.errs.join("\n"));
});
