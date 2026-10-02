// The farm brain's runner (utils/demandBrain/index.js): the switch, the log (one run document and
// its rows — nothing else), failure isolation, the heartbeat, the scheduler, the score cache, and the
// log queries against a REAL Mongo.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const B = require("../utils/demandBrain");
const M = require("../utils/demandBrain/model");
const farmSizing = require("../utils/farmSizing");
const DemandBrainRun = require("../models/DemandBrainRun");
const DemandBrainRow = require("../models/DemandBrainRow");

const DAY = 86400000;
// The feeder's snapshot row is internally consistent: its target IS shelfAwareTarget of its rates.
const OW_SALES = { perWeek: 76.8, shelfPerWeek: 3.3, otherPerWeek: 73.5 };
const OW_TARGET = farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 3.3, otherPerWeek: 73.5, coverageDays: 28, safetyStock: 6 }).target;

function afWith(brain) {
  return { getAutoFarm: () => ({ demandBrain: brain }) };
}

// A pack in the shape inputs.load() returns, small but complete.
function pack(now = Date.now()) {
  return {
    now,
    sizing: { coverageDays: 28, safetyStock: 6, maxPerGame: 250 },
    probeSize: 15,
    engine: { floor: 18, maxPerGame: 30 },
    claim: [
      {
        key: "game a",
        label: "Game A",
        live: true,
        hoursLeft: 40,
        reuseOnly: false,
        entries: [{ t: now - DAY, m: "gameflip" }, { t: now - 3 * DAY, m: "eldorado" }, { t: now - 9 * DAY, m: "gameflip" }],
        spans: [[now - 30 * DAY, now]],
        radar: null,
        value: 2,
        valueBasis: "our sales",
        gameCap: 0,
        stock: { onHand: 2, inFlight: 0 },
        act: { d: "farm", at: new Date(now - DAY), t: 30 },
        old: { alloc: { cap: 30, target: 30, effective: 50 }, sales: { count: 20 } },
      },
    ],
    noclaim: [
      {
        snapRow: { key: "overwatch", label: "Overwatch", target: OW_TARGET, onHand: 50, sales: OW_SALES, stock: { listed: 50, inFlight: 0 }, policy: { coverageDays: 28, safetyStock: 6 } },
        entries: null,
        spans: [],
        radarRows: [],
        keywords: ["overwatch"],
        live: true,
      },
    ],
    demandRates: null,
    notes: ["a note"],
    evidence: { at: now, claim: new Map(), spans: new Map(), noclaim: null, feed: [], radarKeys: new Set(), noclaimKeys: ["overwatch"] },
    counts: { claimGames: 1, noclaim: 1 },
  };
}

function fakeModels() {
  const runs = [];
  const rows = [];
  return {
    runs,
    rows,
    Run: () => ({
      create: async (doc) => {
        const saved = { ...JSON.parse(JSON.stringify(doc)), _id: "run" + (runs.length + 1) };
        runs.push(saved);
        return saved;
      },
    }),
    Row: () => ({
      insertMany: async (list) => {
        rows.push(...JSON.parse(JSON.stringify(list)));
        return list;
      },
    }),
  };
}

function quietHooks(extra = {}) {
  const lines = [];
  const errs = [];
  B._setHooks({ log: (...a) => lines.push(a.join(" ")), logErr: (...a) => errs.push(a.join(" ")), ...extra });
  return { lines, errs };
}

test.beforeEach(() => B._reset());
test.after(() => B._reset());

test("off by default: a tick computes nothing and says so once", async () => {
  let loads = 0;
  const { lines } = quietHooks({ settings: () => afWith(undefined), load: async () => (loads++, pack()) });
  assert.deepEqual(await B.runOnce(), { skipped: "off" });
  await B._tick();
  await B._tick();
  assert.equal(loads, 0);
  assert.equal(lines.filter((l) => /demandBrain: off/.test(l)).length, 1, "logged once, not every tick");
  assert.equal(B.status().config.enabled, false);
});

test("a run writes ONE run document and its rows — without the reasons — and keeps the full run in memory", async () => {
  const m = fakeModels();
  const { lines } = quietHooks({ settings: () => afWith({ enabled: true }), load: async ({ now }) => pack(now), Run: m.Run, Row: m.Row });
  const r = await B.runOnce();
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.equal(m.runs.length, 1);
  const doc = m.runs[0];
  assert.equal(doc.v, M.MODEL_VERSION);
  assert.equal(doc.rowsN, 2);
  assert.equal(doc.rows, undefined, "the rows are their own documents");
  assert.equal(doc.cfg.enabled, true);
  assert.equal(doc.cfg.v2, "brain");
  assert.deepEqual(doc.cfg.engine, { floor: 18, maxPerGame: 30 });
  assert.deepEqual(doc.notes, ["a note"]);
  assert.equal(m.rows.length, 2);
  assert.ok(m.rows.every((row) => row.run === "run1" && new Date(row.at).getTime() === new Date(doc.at).getTime()), "each row points at its run and carries its time");
  assert.ok(m.rows.every((row) => !("why" in row)), "reasons are not persisted");
  const mem = await B.latest();
  assert.ok(mem.rows[0].why.length > 0, "the newest run keeps its reasons in memory");
  assert.equal(B.status().runs, 1);
  assert.equal(B.status().lastError, "");
  const hb = lines.find((l) => /^demandBrain: run 1 /.test(l));
  assert.ok(hb, lines.join("\n"));
  assert.match(hb, /avg45/);
  assert.match(hb, /claim 1 games, 1 live/);
  assert.ok(hb.includes("no-claim Overwatch " + OW_TARGET + "→" + OW_TARGET), hb);
});

test("a failed log write — run or rows — is reported, never thrown; the run is still visible", async () => {
  for (const which of ["run", "rows"]) {
    B._reset();
    const m = fakeModels();
    const Run = which === "run" ? () => ({ create: async () => { throw new Error("disk full"); } }) : m.Run;
    const Row = which === "rows" ? () => ({ insertMany: async () => { throw new Error("disk full"); } }) : m.Row;
    const { lines, errs } = quietHooks({ settings: () => afWith({ enabled: true }), load: async ({ now }) => pack(now), Run, Row });
    const r = await B.runOnce();
    assert.equal(r.ok, true, which);
    assert.equal(r.persisted, false, which);
    assert.match(B.status().lastError, /disk full/);
    assert.ok(errs.some((e) => /log write failed/.test(e)));
    assert.ok(lines.some((l) => /NOT LOGGED/.test(l)));
    assert.equal((await B.latest()).persisted, false);
  }
});

test("a failed load writes nothing and the next run still happens", async () => {
  const m = fakeModels();
  let fail = true;
  const { errs } = quietHooks({ settings: () => afWith({ enabled: true }), load: async ({ now }) => { if (fail) throw new Error("db down"); return pack(now); }, Run: m.Run, Row: m.Row });
  assert.match((await B.runOnce()).error, /db down/);
  assert.equal(m.runs.length + m.rows.length, 0);
  assert.ok(errs.some((e) => /run failed — db down/.test(e)));
  fail = false;
  assert.equal((await B.runOnce()).ok, true);
  assert.equal(m.runs.length, 1);
});

test("a load that outlives the timeout: the run gives up, ticks say why, and no new run starts until the old load settles", async () => {
  const m = fakeModels();
  let release;
  const gate = new Promise((r) => (release = r));
  let loads = 0;
  const { lines } = quietHooks({ settings: () => afWith({ enabled: true }), runTimeoutMs: 20, load: async ({ now }) => { loads++; await gate; return pack(now); }, Run: m.Run, Row: m.Row });
  const r = await B.runOnce();
  assert.match(r.error, /longer than/);
  assert.equal(m.runs.length, 0);
  assert.deepEqual(await B.runOnce(), { skipped: "already running" });
  await B._tick();
  assert.ok(lines.some((l) => /skipped — the previous run's data load has been pending for \d+ min/.test(l)), lines.join("\n"));
  assert.equal(loads, 1);
  assert.ok(B.status().loadPendingSince);
  release();
  await new Promise((r2) => setTimeout(r2, 10));
  assert.equal(B.status().loadPendingSince, null);
  assert.equal((await B.runOnce()).ok, true);
  assert.equal(loads, 2);
});

test("two runs at once: the second is skipped", async () => {
  const m = fakeModels();
  let release;
  const gate = new Promise((r) => (release = r));
  quietHooks({ settings: () => afWith({ enabled: true }), load: async ({ now }) => { await gate; return pack(now); }, Run: m.Run, Row: m.Row });
  const first = B.runOnce();
  assert.deepEqual(await B.runOnce(), { skipped: "already running" });
  release();
  assert.equal((await first).ok, true);
  assert.equal(m.runs.length, 1);
});

test("the scheduler: start is idempotent, waits for boot, re-arms by the interval; stop clears it", async () => {
  const m = fakeModels();
  quietHooks({ settings: () => afWith({ enabled: true, intervalMin: 30 }), load: async ({ now }) => pack(now), Run: m.Run, Row: m.Row });
  const t0 = Date.now();
  assert.equal(B.start(), true);
  assert.equal(B.start(), false);
  const next = new Date(B.status().nextRunAt).getTime();
  assert.ok(next - t0 >= B.BOOT_DELAY_MS - 50 && next - t0 <= B.BOOT_DELAY_MS + 1000, "first run after the boot delay");
  await B._tick();
  assert.equal(m.runs.length, 1);
  const re = new Date(B.status().nextRunAt).getTime() - Date.now();
  assert.ok(re > 29 * 60000 && re <= 30 * 60000 + 100, "re-armed 30 minutes out: " + re);
  B.stop();
  assert.equal(B.status().started, false);
  assert.equal(B.status().nextRunAt, null);
});

test("switched off: the switch is re-read every ten minutes", async () => {
  quietHooks({ settings: () => afWith({ enabled: false }) });
  B.start();
  await B._tick();
  const re = new Date(B.status().nextRunAt).getTime() - Date.now();
  assert.ok(re > B.OFF_RECHECK_MS - 1000 && re <= B.OFF_RECHECK_MS + 100, String(re));
  B.stop();
});

test("unreadable settings read as off", async () => {
  quietHooks({ settings: () => ({ getAutoFarm: () => { throw new Error("bad json"); } }) });
  assert.equal(B.readConfig().enabled, false);
  assert.deepEqual(await B.runOnce(), { skipped: "off" });
});

test("rival units: from the slimmed feed, inside the span — and null for a game the radar does not watch", () => {
  const T = Date.UTC(2026, 9, 1);
  const feed = [
    { g: "a", t: T + DAY, u: 3 },
    { g: "a", t: T + 8 * DAY, u: 4 },
    { g: "b", t: T + DAY, u: 1 },
  ];
  const watched = new Set(["a", "quiet"]);
  assert.equal(B.rivalUnits(feed, watched, "a", T, T + 7 * DAY), 3);
  assert.equal(B.rivalUnits(feed, watched, "quiet", T, T + 7 * DAY), 0, "watched, nothing sold: zero");
  assert.equal(B.rivalUnits(feed, watched, "c", T, T + 7 * DAY), null, "not watched: unknown, not zero");
});

test("a score computed while a run lands is answered but never cached over the newer evidence", async () => {
  const m = fakeModels();
  let release;
  let evidenceCalls = 0;
  quietHooks({
    settings: () => afWith({ enabled: true }),
    load: async ({ now }) => pack(now),
    Run: () => ({ ...m.Run(), find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
    Row: m.Row,
    loadEvidence: async ({ now }) => {
      evidenceCalls++;
      if (evidenceCalls === 1) await new Promise((r) => (release = r));
      return { at: now, claim: new Map(), spans: new Map(), noclaim: null, feed: [], radarKeys: new Set(), noclaimKeys: [] };
    },
  });
  const slow = B.accuracy();
  await new Promise((r) => setImmediate(r));
  assert.equal((await B.runOnce()).ok, true, "a run lands while the score is computing");
  release();
  const stale = await slow;
  const fresh = await B.accuracy();
  assert.notEqual(fresh, stale, "the score computed from pre-run evidence is answered once, never served again");
  assert.equal(evidenceCalls, 1, "the recomputation uses the run's own evidence, no reload");
  assert.equal(B._state.accuracy.value, fresh);
  assert.equal(B._state.accuracy.gen, B._state.gen);
  assert.equal(await B.accuracy(), fresh, "and the fresh one is cached");
});

/* ------------------------- against a real Mongo ------------------------- */

test("real Mongo: TTL indexes on both, newest run with its rows, one game's history, one sample a day, accuracy", async (t) => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("demandbrain"));
  t.after(async () => {
    await mongoose.disconnect();
    await mem.stop();
  });
  await DemandBrainRun.init();
  await DemandBrainRow.init();
  const ttl = (await DemandBrainRun.collection.indexes()).find((i) => i.key && i.key.at === 1);
  assert.equal(ttl.expireAfterSeconds, DemandBrainRun.TTL_DAYS * 86400);
  const rowIdx = (await DemandBrainRow.collection.indexes()).map((i) => ({ key: Object.keys(i.key).join("+"), ttl: i.expireAfterSeconds }));
  assert.ok(rowIdx.some((i) => i.key === "k+f+at"), "history index");
  assert.ok(rowIdx.some((i) => i.key === "run"), "run index");
  assert.ok(rowIdx.some((i) => i.key === "at" && i.ttl === DemandBrainRun.TTL_DAYS * 86400), "rows expire with their runs");

  const now = Date.now();
  const row = (k, f, extra = {}) => ({ k, g: k.toUpperCase(), f, live: true, d: "brain-farm", old: { c: "skip", t: 0, w: 1 }, br: { c: "probe", t: 15, w: 3, b: "market" }, est: { avg30: 1, max30_14: 2 }, ...extra });
  // 10 days x 3 runs a day, written exactly as the runner writes them
  const at0 = [];
  for (let d = 10; d >= 1; d--) {
    for (const h of [1, 9, 17]) {
      const base = new Date(now - d * DAY);
      at0.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h)));
    }
  }
  for (const at of at0) {
    const run = await DemandBrainRun.create({ at, v: 1, ms: 5, rowsN: 3 });
    await DemandBrainRow.insertMany(
      [row("a", "claim"), row("b", "claim"), row("overwatch", "noclaim", { d: "agree", old: { c: "fleet", t: 250 }, br: { c: "fleet", t: 250, w: 60 } })].map((r) => ({ ...r, run: run._id, at })),
      { ordered: false },
    );
  }
  B._reset();
  quietHooks({
    settings: () => afWith({ enabled: true }),
    loadEvidence: async () => ({
      at: now,
      claim: new Map([["a", [{ t: now - 9 * DAY + 3600000, m: "gameflip" }, { t: now - 8 * DAY, m: "gameflip" }]]]),
      spans: new Map(),
      noclaim: new Map([["overwatch", [{ t: now - 9 * DAY, m: "eldorado" }]]]),
      feed: [{ g: "a", t: now - 8 * DAY, u: 6 }],
      radarKeys: new Set(["a"]),
      noclaimKeys: ["overwatch"],
      demandRates: null,
    }),
  });

  const latest = await B.latest();
  assert.equal(new Date(latest.at).getTime(), Math.max(...at0.map((d) => d.getTime())), "after a restart, the newest run comes from the log");
  assert.equal(latest.rows.length, 3, "with its rows");
  assert.equal(latest.rows[0].run, undefined, "the back-pointer is not sent");

  const h = await B.gameHistory("a", "claim", 5);
  assert.equal(h.length, 5);
  assert.ok(new Date(h[0].at) > new Date(h[4].at), "newest first");
  assert.equal(h[0].k, "a");
  assert.equal(h[0].f, "claim");
  assert.deepEqual(await B.gameHistory("nope", "claim"), []);
  assert.equal((await B.gameHistory("overwatch", "noclaim", 3))[0].br.t, 250);
  const plan = await DemandBrainRow.find({ k: "a", f: "claim" }).sort({ at: -1 }).limit(5).explain("queryPlanner");
  assert.match(JSON.stringify(plan), /k_1_f_1_at_-1/, "the history read uses its index");

  const samples = await B.dailySamples(now);
  assert.equal(samples.length, 10, "one run per UTC day");
  assert.ok(samples.every((s) => new Date(s.at).getUTCHours() === 1), "the first run of each day");
  assert.ok(samples.every((s) => s.rows.length === 3), "each with its rows");

  const acc = await B.accuracy();
  assert.equal(acc.samples, 10);
  assert.ok(acc.forward.runsScored >= 2 && acc.forward.runsWaiting >= 6, JSON.stringify(acc.forward));
  assert.ok(acc.forward.scores.claim.engine, "today's reading is scored");
  assert.ok(acc.review.length >= 1);
  assert.ok(acc.review.every((x) => x.key !== "overwatch"));
  assert.ok(acc.review.some((x) => x.key === "a" && x.rivalUnits7 === 6));
  assert.ok(acc.review.some((x) => x.key === "b" && x.rivalUnits7 === null), "an unwatched game is unknown, not 0");
  assert.equal(await B.accuracy(), acc, "cached");
  const [p1, p2] = [B.accuracy({ force: true }), B.accuracy({ force: true })];
  assert.equal(await p1, await p2, "concurrent callers share one computation");
});
