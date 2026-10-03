// Speed and log size on the large synthetic fixture (the owner's brief §1 "one process, live orders", §6
// "Log size", §9 "Speed"): scripts/listing-brain-fixture.js generate({ large: true }) — 150 games × 7
// markets, ≥ 3,000 listings, ≥ 5,000 sales.
//
//   - buildRun, the whole model, synchronous: median of 3 warm runs under 1,000 ms;
//   - buildRunAsync never holds the event loop: the longest gap between two turns of a setImmediate probe
//     while it runs is under 200 ms;
//   - the log: BSON bytes of what one run writes (its rows as the runner inserts them, through the log
//     models' schemas, and its run document), the daily document with fcCap per-listing forecasts, and the
//     steady state over the 21-day TTL at the default 180-minute interval — under 60 MB.
//
// Every number is printed (console.log and a test diagnostic) so it can go into docs/LISTING-BRAIN-PLAN.md.
// Run: CRED_SECRET=x node --test tests/listingBrainSpeed.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const M = require("../utils/listingBrain/model");
const FX = require("../scripts/listing-brain-fixture");

const MB = 1e6;
// Production volume, measured by the review's synthetic production world (scratchpad review/prodgen.js through
// the real loader: 20,000 listings, 32,318 sales, 100,000 no-claim units): one run logs ~1,462 cell rows and its
// daily document carries the fcCap (5,000) forecasts. The log is projected to that scale from the bytes a row
// and a forecast take here (P20-12); the assertion is on the large fixture's own scale.
const PROD_ROWS_PER_RUN = 1462;

let cache = null;
function large() {
  if (!cache) {
    const t0 = performance.now();
    const bundle = FX.generate({ large: true });
    cache = { bundle, genMs: performance.now() - t0 };
  }
  return cache;
}
const say = (t, line) => {
  console.log(line);
  t.diagnostic(line);
};
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

test("speed: the model on the large fixture runs well under a second (median of 3)", (t) => {
  const { bundle, genMs } = large();
  const c = bundle.counts || {};
  assert.ok(bundle.listings.length >= 3000 && bundle.sales.length >= 5000, "the brief's scale");
  M.buildRun(bundle); // warm the JIT
  const times = [];
  let run;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run = M.buildRun(bundle);
    times.push(performance.now() - t0);
  }
  const ms = median(times);
  say(t, `listing-brain speed: large fixture ${c.games || "?"} games, ${bundle.listings.length} listings, ${bundle.sales.length} sales (generated in ${genMs.toFixed(0)} ms)`);
  say(t, `listing-brain speed: buildRun ${times.map((x) => x.toFixed(0)).join(" / ")} ms → median ${ms.toFixed(0)} ms; ${run.rows.length} rows, ${run.offers.length} offers, ${run.fc.length} live-listing forecasts`);
  assert.ok(run.rows.length > 500, "a full run: " + run.rows.length + " rows");
  assert.ok(ms < 1000, "buildRun median " + ms.toFixed(0) + " ms");
});

test("speed: buildRunAsync never holds the event loop for 200 ms", async (t) => {
  const { bundle } = large();
  await M.buildRunAsync(bundle); // warm
  const gaps = [];
  const totals = [];
  for (let i = 0; i < 3; i++) {
    let maxGap = 0;
    let last = performance.now();
    let done = false;
    const tick = () => {
      const now = performance.now();
      if (now - last > maxGap) maxGap = now - last;
      last = now;
      if (!done) setImmediate(tick);
    };
    setImmediate(tick);
    const t0 = performance.now();
    const run = await M.buildRunAsync(bundle);
    totals.push(performance.now() - t0);
    done = true;
    // the stretch from the model's last yield to its return counts too
    const tail = performance.now() - last;
    gaps.push(Math.max(maxGap, tail));
    assert.ok(run.rows.length > 500);
  }
  const worst = Math.max(...gaps);
  say(t, `listing-brain speed: buildRunAsync ${totals.map((x) => x.toFixed(0)).join(" / ")} ms; longest synchronous stretch ${gaps.map((x) => x.toFixed(0)).join(" / ")} ms (worst ${worst.toFixed(0)} ms)`);
  assert.ok(worst < 200, "longest synchronous stretch " + worst.toFixed(0) + " ms");
});

test("log size: one run, the daily forecasts at fcCap, and the steady state under the TTLs stay under 60 MB (intraday rows 3 days)", (t) => {
  // bson ships with the mongodb driver (a production dependency); the log models cast exactly as on insert
  const { calculateObjectSize } = require("bson");
  const mongoose = require("mongoose");
  const Row = require("../models/ListingBrainRow");
  const Run = require("../models/ListingBrainRun");
  const runner = require("../utils/listingBrain/index");
  assert.equal(typeof runner.compact, "function", "rows are written through index.compact");
  const KEEP_DAILY = runner.ROW_KEEP_DAYS_DAILY;
  const KEEP_OTHER = runner.ROW_KEEP_DAYS_OTHER;
  const RUN_DAYS = Run.TTL_DAYS;
  assert.deepEqual([KEEP_DAILY, KEEP_OTHER, RUN_DAYS], [21, 3, 21], "daily rows 21 d, other runs' rows 3 d (P20-12), run documents 21 d");
  const { bundle } = large();
  const run = M.buildRun(bundle);
  const cfg = run.ctx.cfg;
  const at = new Date(bundle.now);
  const runId = new mongoose.Types.ObjectId();
  const size = (doc) => calculateObjectSize(doc.toObject({ depopulate: true }));

  // the rows, as the runner inserts them: compact(row) + run + at + exp (+ _id), through the schema
  const rowsBytes = (keepDays) => {
    const exp = new Date(bundle.now + keepDays * 86400000);
    let b = 0;
    for (const r of run.rows) b += size(new Row(Object.assign({}, runner.compact(r), { run: runId, at, exp })));
    return b;
  };
  const dailyRows = rowsBytes(KEEP_DAILY);
  const otherRows = rowsBytes(KEEP_OTHER);
  let fullRows = 0;
  for (const r of run.rows) {
    const d = Object.assign({}, r, { run: runId, at, exp: at });
    delete d.why;
    fullRows += calculateObjectSize(d) + 12 + 9; // + _id; for comparison only: the row before compaction
  }
  // the run document, as the runner builds it (notes capped at 30 × 300 characters)
  const notes = (bundle.notes || []).concat(run.notes || []).slice(0, 30).map((n) => String(n).slice(0, 300));
  const base = { at, v: M.MODEL_VERSION, ms: 600, cfg, summary: run.summary, counts: bundle.counts || {}, notes, rowsN: run.rows.length, day: "2026-10-03", fcN: 0, fc: null };
  const runBytes = size(new Run(base));
  // the daily document: fcCap per-listing forecasts (the fixture's own, repeated up to the cap)
  const cap = cfg.fcCap;
  const fc = [];
  for (let i = 0; i < cap && run.fc.length; i++) fc.push(run.fc[i % run.fc.length]);
  const dailyBytes = size(new Run(Object.assign({}, base, { fcN: fc.length, fc })));
  const fixtureDaily = size(new Run(Object.assign({}, base, { fcN: Math.min(cap, run.fc.length), fc: run.fc.slice(0, cap) })));

  // steady state: per UTC day 1 daily run (rows kept 21 d, its forecasts 21 d) + the other runs (rows 7 d);
  // every run document 21 d
  const runsPerDay = Math.floor((24 * 60) / cfg.intervalMin);
  const parts = {
    dailyRows: KEEP_DAILY * dailyRows,
    otherRows: KEEP_OTHER * (runsPerDay - 1) * otherRows,
    runDocs: RUN_DAYS * runsPerDay * runBytes,
    forecasts: RUN_DAYS * (dailyBytes - runBytes),
  };
  const total = parts.dailyRows + parts.otherRows + parts.runDocs + parts.forecasts;
  const kb = (b) => (b / 1000).toFixed(1) + " kB";
  const mb = (b) => (b / MB).toFixed(1) + " MB";
  say(t, `listing-brain log: ${run.rows.length} rows per run, ${kb(otherRows)} (${(otherRows / run.rows.length).toFixed(0)} B a row compacted; ${(fullRows / run.rows.length).toFixed(0)} B uncompacted) + run document ${kb(runBytes)} = ${kb(otherRows + runBytes)} per run`);
  say(t, `listing-brain log: daily document with fcCap ${cap} forecasts ${kb(dailyBytes)} (${((dailyBytes - runBytes) / Math.max(1, fc.length)).toFixed(0)} B a forecast; this fixture's ${run.fc.length} forecasts: ${kb(fixtureDaily)})`);
  say(t, `listing-brain log: steady state at ${runsPerDay} runs/day (every ${cfg.intervalMin} min): daily rows ${KEEP_DAILY} d ${mb(parts.dailyRows)} + other runs' rows ${KEEP_OTHER} d ${mb(parts.otherRows)} + run documents ${RUN_DAYS} d ${mb(parts.runDocs)} + daily forecasts ${RUN_DAYS} d ${mb(parts.forecasts)} = ${mb(total)} (limit 60 MB; indexes not counted)`);
  // the same arithmetic at production volume: its row count, this fixture's bytes per row and per forecast
  const perRow = (s0) => s0 / run.rows.length;
  const prod = {
    dailyRows: KEEP_DAILY * PROD_ROWS_PER_RUN * perRow(dailyRows),
    otherRows: KEEP_OTHER * (runsPerDay - 1) * PROD_ROWS_PER_RUN * perRow(otherRows),
    runDocs: parts.runDocs,
    forecasts: parts.forecasts,
  };
  const prodTotal = prod.dailyRows + prod.otherRows + prod.runDocs + prod.forecasts;
  const prod7 = prodTotal - prod.otherRows + (7 / KEEP_OTHER) * prod.otherRows;
  say(t, `listing-brain log at production volume (${PROD_ROWS_PER_RUN} rows a run, projected): daily rows ${mb(prod.dailyRows)} + other runs' rows ${KEEP_OTHER} d ${mb(prod.otherRows)} + run documents ${mb(prod.runDocs)} + daily forecasts ${mb(prod.forecasts)} = ${mb(prodTotal)} (with intraday rows kept 7 days it was ${mb(prod7)})`);
  assert.equal(runsPerDay, 8, "the default interval is 180 minutes");
  assert.ok(fc.length === cap, "the daily document is measured full");
  assert.ok(dailyBytes < 16 * 1024 * 1024, "the daily document fits MongoDB's 16 MB document limit");
  assert.ok(otherRows < fullRows, "compaction shrinks the rows");
  assert.ok(total < 60 * MB, "steady state " + mb(total));
});
