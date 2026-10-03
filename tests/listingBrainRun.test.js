// The listing brain's runner (utils/listingBrain/index.js): the switch, one run at a time, the
// timeout, the log (one run document and its rows — nothing else), failure isolation, the daily
// per-listing forecasts, the cool-down memory, the heartbeat, the scheduler and the three answers.
// Everything is injected (loader, models, settings, clock): no Mongo, no network.
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
    Run: () => ({
      create: async (doc) => {
        if (failRun) throw new Error("run write refused");
        const saved = { ...JSON.parse(JSON.stringify(doc)), _id: "run" + (runs.length + 1) };
        runs.push(saved);
        return saved;
      },
      findOne: (filter) =>
        chain(() => {
          if (filter && filter.day) return seenDay === filter.day ? { _id: "old" } : runs.find((r) => r.day === filter.day && r.fcN > 0) || null;
          if (filter && filter._id) return runs.find((r) => r._id === filter._id) || null;
          const withFc = runs.filter((r) => r.fcN > 0);
          return withFc.length ? withFc[withFc.length - 1] : runs[runs.length - 1] || null;
        }),
      find: () => chain(() => runs.filter((r) => r.fcN > 0).map((r) => ({ _id: r._id, at: r.at, day: r.day }))),
    }),
    Row: () => ({
      insertMany: async (list) => {
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

test("a failed run-document write is reported the same way", async () => {
  const models = fakeModels({ failRun: true });
  setup({ models });
  const r = await B.runOnce();
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.equal(models.rows.length, 0);
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
