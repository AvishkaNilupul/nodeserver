// The listing brain's log against a REAL Mongo (mongodb-memory-server): the two collections' indexes
// (cell history, run rows, TTL), what one run writes, reading the newest run back after a restart,
// a cell's history and the daily samples the forward score reads.
//
// NEEDS mongodb-memory-server's mongod binary, which it downloads on first use. The build sandbox's
// network policy blocks that download, so THIS FILE WAS NOT RUN when the brain was built
// (docs/LISTING-BRAIN-HANDOFF.md, "Tests"). Every other runner behaviour is covered without Mongo in
// tests/listingBrainRun.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const B = require("../utils/listingBrain");
const ListingBrainRun = require("../models/ListingBrainRun");
const ListingBrainRow = require("../models/ListingBrainRow");
const { generate } = require("../scripts/listing-brain-fixture");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 3, 12);

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ListingBrainRun.init();
  await ListingBrainRow.init();
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.afterEach(async () => {
  B._reset();
  await ListingBrainRun.deleteMany({});
  await ListingBrainRow.deleteMany({});
});

function arm(now) {
  let t = now;
  B._setHooks({
    settings: () => ({ getAutoFarm: () => ({ listingBrain: { enabled: true } }) }),
    load: async () => generate({ seed: 1, now: t }),
    log: () => {},
    logErr: () => {},
    now: () => t,
  });
  return (v) => (t = v);
}

test("indexes: a cell's history, a run's rows, and both TTLs", async () => {
  const rowIdx = await ListingBrainRow.collection.indexes();
  const keys = rowIdx.map((i) => JSON.stringify(i.key));
  assert.ok(keys.includes(JSON.stringify({ k: 1, f: 1, m: 1, at: -1 })));
  assert.ok(keys.includes(JSON.stringify({ run: 1 })));
  const ttl = rowIdx.find((i) => JSON.stringify(i.key) === JSON.stringify({ at: 1 }));
  assert.equal(ttl.expireAfterSeconds, 21 * 86400);
  const exp = rowIdx.find((i) => JSON.stringify(i.key) === JSON.stringify({ exp: 1 }));
  assert.equal(exp.expireAfterSeconds, 0, "per-row expiry: 21 days for daily samples, 7 for the rest");
  const runIdx = await ListingBrainRun.collection.indexes();
  const runTtl = runIdx.find((i) => JSON.stringify(i.key) === JSON.stringify({ at: 1 }));
  assert.equal(runTtl.expireAfterSeconds, 21 * 86400);
});

test("one run writes one run document and one row per cell; a restart reads it back without reasons", async () => {
  arm(NOW);
  const r = await B.runOnce();
  assert.equal(r.persisted, true, JSON.stringify(r));
  assert.equal(await ListingBrainRun.countDocuments({}), 1);
  const run = await ListingBrainRun.findOne({}).lean();
  assert.equal(await ListingBrainRow.countDocuments({ run: run._id }), run.rowsN);
  assert.ok(run.fcN > 0, "the first run of the day carries its forecasts");
  // A restart: memory is gone, the log is not.
  B._reset();
  B._setHooks({ settings: () => ({ getAutoFarm: () => ({}) }) });
  const back = await B.latest();
  assert.equal(String(back._id), String(run._id));
  assert.equal(back.rows.length, run.rowsN);
  assert.equal(back.fc, undefined, "latest() never loads the daily forecasts");
  assert.ok(back.rows.every((row) => row.why === undefined));
});

test("cellHistory is an indexed read of one cell, newest first", async () => {
  const setNow = arm(NOW);
  await B.runOnce();
  setNow(NOW + 3 * 3600000);
  await B.runOnce();
  const row = await ListingBrainRow.findOne({ m: { $ne: "all" } }).lean();
  const hist = await B.cellHistory(row.k + "|" + row.f + "|" + row.m, 10);
  assert.equal(hist.length, 2);
  assert.ok(new Date(hist[0].at) > new Date(hist[1].at));
  const plan = await ListingBrainRow.find({ k: row.k, f: row.f, m: row.m }).sort({ at: -1 }).limit(10).explain("queryPlanner");
  assert.match(JSON.stringify(plan), /IXSCAN/);
});

test("dailySamples returns the first run of each UTC day that carries forecasts", async () => {
  const setNow = arm(NOW);
  await B.runOnce();
  setNow(NOW + 3 * 3600000);
  await B.runOnce();
  setNow(NOW + DAY);
  await B.runOnce();
  const samples = await B.dailySamples(NOW + DAY + 3600000);
  assert.equal(samples.length, 2);
  assert.ok(samples.every((s) => s.fc.length > 0 && s.rows.length > 0));
});
