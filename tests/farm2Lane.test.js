// Coverage for lane isolation and the job queue (utils/farm2/lane.js,
// utils/farm2/jobs.js).
//
// Lane isolation is the headline claim of the whole lane engine: in the legacy
// utils/autoFarmer.js one exception inside a ~900-line runOnce() costs every
// game a full 10-minute tick. These tests pin the two properties that claim
// rests on:
//
//   1. a lane that fails records the failure on ITS OWN row and returns
//      normally, so the supervisor keeps dispatching the other lanes
//   2. a healthy lane running alongside a failing one is completely unaffected
//
// Plus the job-queue guarantees that make a restart survivable: exactly-once
// claiming, deduplicated enqueue, bounded retries, and crash recovery.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmLane = require("../models/FarmLane");
const FarmJob = require("../models/FarmJob");
const TwitchCampaign = require("../models/TwitchCampaign");
const jobs = require("../utils/farm2/jobs");
const laneMod = require("../utils/farm2/lane");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2lane"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function makeLane(game, mode = "shadow") {
  const gameKey = settings.normGameName(game);
  await FarmLane.deleteMany({ gameKey });
  return (await FarmLane.create({ game, gameKey, mode, state: "idle" })).toObject();
}

/* ------------------------------ lane isolation ---------------------------- */

test("a lane whose campaign lookup throws records the failure and does NOT propagate", async () => {
  const lane = await makeLane("Broken Game");
  const orig = TwitchCampaign.find;
  TwitchCampaign.find = () => {
    throw new Error("simulated database failure");
  };
  try {
    // The contract: runLane resolves. If this rejects, the supervisor's
    // dispatch loop would die and take every other lane down with it.
    const summary = await laneMod.runLane(lane, { cycle: null, af: settings.getAutoFarm() });
    assert.equal(typeof summary, "object", "runLane must resolve, never reject");
  } finally {
    TwitchCampaign.find = orig;
  }

  const row = await FarmLane.findById(lane._id).lean();
  assert.ok(row.lastError, "the error is recorded on the lane's own row");
  assert.ok(row.consecutiveFailures > 0, "the failure counter advanced");
  assert.ok(row.nextRunAt > new Date(), "the lane backed off rather than hot-looping");
});

test("a healthy lane is unaffected by another lane's failure", async () => {
  const broken = await makeLane("Broken Game 2");
  const healthy = await makeLane("Healthy Game");

  const orig = TwitchCampaign.find;
  let calls = 0;
  TwitchCampaign.find = function (...args) {
    calls += 1;
    // Fail only the first lane's lookup.
    if (calls === 1) throw new Error("simulated failure");
    return orig.apply(this, args);
  };
  try {
    await laneMod.runLane(broken, { cycle: null, af: settings.getAutoFarm() });
    await laneMod.runLane(healthy, { cycle: null, af: settings.getAutoFarm() });
  } finally {
    TwitchCampaign.find = orig;
  }

  const b = await FarmLane.findById(broken._id).lean();
  const h = await FarmLane.findById(healthy._id).lean();
  assert.ok(b.lastError, "the broken lane carries the error");
  assert.equal(h.lastError, "", "the healthy lane carries no error");
  assert.equal(h.consecutiveFailures, 0, "the healthy lane's failure counter is untouched");
  assert.ok(h.lastOkAt, "the healthy lane completed normally");
});

test("repeated failures back off and eventually pause the lane", async () => {
  const lane = await makeLane("Always Broken");
  const orig = TwitchCampaign.find;
  TwitchCampaign.find = () => {
    throw new Error("permanent failure");
  };
  try {
    let cur = lane;
    for (let i = 0; i < laneMod.PAUSE_AFTER_FAILURES; i += 1) {
      await laneMod.runLane(cur, { cycle: null, af: settings.getAutoFarm() });
      cur = await FarmLane.findById(lane._id).lean();
    }
    assert.equal(cur.state, "paused", "a permanently broken lane parks itself for an operator");
  } finally {
    TwitchCampaign.find = orig;
  }
});

test("backoff grows with consecutive failures and is capped", () => {
  assert.ok(laneMod.backoffMs(1) < laneMod.backoffMs(3));
  assert.ok(laneMod.backoffMs(3) < laneMod.backoffMs(5));
  // Capped, so a long-broken lane settles at hourly retries rather than growing
  // without bound.
  assert.equal(laneMod.backoffMs(50), laneMod.backoffMs(99));
});

/* -------------------------------- job queue ------------------------------- */

test("enqueue deduplicates in-flight work even with no unique index built", async () => {
  await FarmJob.deleteMany({ campaignId: "DEDUP" });
  // Drop indexes to simulate the window after a fresh deploy, before Mongoose
  // has finished building them in the background. Correctness must not depend
  // on that timing — this is the bug the atomic upsert fixes.
  await FarmJob.collection.dropIndexes().catch(() => {});

  const a = await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "DEDUP" });
  const b = await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "DEDUP" });
  assert.equal(String(a._id), String(b._id), "the same in-flight job is returned");
  assert.equal(await FarmJob.countDocuments({ campaignId: "DEDUP" }), 1);

  await FarmJob.init(); // restore indexes for later tests
});

test("claiming a job is exclusive", async () => {
  await FarmJob.deleteMany({ campaignId: "CLAIM" });
  await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "CLAIM" });
  const first = await jobs.claimNext({ campaignId: "CLAIM" });
  assert.ok(first, "the first claim wins");
  assert.equal(first.attempts, 1);
  assert.equal(await jobs.claimNext({ campaignId: "CLAIM" }), null, "no second claim");
});

test("a finished job does not block re-enqueueing the same work later", async () => {
  await FarmJob.deleteMany({ campaignId: "REDO" });
  const a = await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "REDO" });
  const claimed = await jobs.claimNext({ campaignId: "REDO" });
  await jobs.finish(claimed, { ok: true });
  const b = await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "REDO" });
  assert.notEqual(String(a._id), String(b._id), "a fresh row is created");
  assert.equal(await FarmJob.countDocuments({ campaignId: "REDO" }), 2, "history is kept");
});

test("per-marketplace publish jobs are independent of each other", async () => {
  await FarmJob.deleteMany({ campaignId: "PUB" });
  await jobs.enqueue({ lane: "L", laneKey: "l", kind: "publish", market: "gameflip", campaignId: "PUB" });
  await jobs.enqueue({ lane: "L", laneKey: "l", kind: "publish", market: "plati", campaignId: "PUB" });
  await jobs.enqueue({ lane: "L", laneKey: "l", kind: "publish", market: "ggsel", campaignId: "PUB" });
  // This is the point of splitting publish per marketplace: one failing
  // marketplace cannot drag the others down, because they are separate rows
  // with separate retry clocks.
  assert.equal(await FarmJob.countDocuments({ campaignId: "PUB", kind: "publish" }), 3);
});

test("retries are bounded and an exhausted job is parked, not lost", async () => {
  await FarmJob.deleteMany({ campaignId: "RETRY" });
  const j = await jobs.enqueue({
    lane: "L",
    laneKey: "l",
    kind: "decide",
    campaignId: "RETRY",
    maxAttempts: 3,
  });
  let cur = await jobs.claimNext({ campaignId: "RETRY" });
  const first = await jobs.fail(cur, new Error("boom"));
  assert.equal(first.retrying, true, "the first failure retries");

  for (let i = 0; i < 3; i += 1) {
    await FarmJob.updateOne({ _id: j._id }, { $set: { status: "running", nextAttemptAt: new Date(0) } });
    cur = await FarmJob.findById(j._id);
    cur.attempts = i + 2;
    await jobs.fail(cur, new Error("still broken"));
  }
  const dead = await FarmJob.findById(j._id).lean();
  assert.equal(dead.status, "failed", "it is parked as failed, visible with its log");
  assert.ok(dead.error, "the reason is retained");
  assert.ok(dead.log.length <= jobs.MAX_LOG_ENTRIES, "the log stays bounded");
});

test("a job stranded by a crash is requeued, but a fresh one is left alone", async () => {
  await FarmJob.deleteMany({ campaignId: "CRASH" });
  const j = await jobs.enqueue({ lane: "L", laneKey: "l", kind: "decide", campaignId: "CRASH" });
  // Simulate a process death after claiming: status stuck at "running".
  await FarmJob.updateOne(
    { _id: j._id },
    { $set: { status: "running", startedAt: new Date(Date.now() - 60 * 60 * 1000) } },
  );
  assert.equal(await jobs.requeueStale(), 1, "the stranded job is recovered");
  const back = await FarmJob.findById(j._id).lean();
  assert.equal(back.status, "queued");

  // A job that started moments ago belongs to a live worker and must not be
  // yanked out from under it.
  await FarmJob.updateOne({ _id: j._id }, { $set: { status: "running", startedAt: new Date() } });
  assert.equal(await jobs.requeueStale(), 0, "an in-flight job is not stolen");
});
