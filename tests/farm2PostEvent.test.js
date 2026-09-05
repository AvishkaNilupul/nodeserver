// Post-event listing and the secondaries throttle (utils/farm2/steps/{monitor,publish}.js).
//
// A task whose accounts completed the bundle only around the campaign's end
// is marked completed before any sweep listed it, and the legacy auto-list
// sweep reads ACTIVE tasks only — so it was never listed. On prod: 128 such
// tasks in 30 days, Halo Infinite alone with 39 deliverable accounts unsold.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const FarmJob = require("../models/FarmJob");
const autoLister = require("../utils/autoLister");
const notify = require("../utils/farm2/notify");
const jobs = require("../utils/farm2/jobs");
const monitorStep = require("../utils/farm2/steps/monitor");
const publishStep = require("../utils/farm2/steps/publish");

let mem;
const sent = [];
const orig = {
  campaignItems: autoLister.campaignItems,
  pickDeliveryAccounts: autoLister.pickDeliveryAccounts,
  listActivatedTask: autoLister.listActivatedTask,
  onCampaignEnded: autoLister.onCampaignEnded,
  retryMissingSecondaries: autoLister.retryMissingSecondaries,
  telegram: notify.telegram,
};
const calls = { onCampaignEnded: 0, retry: 0, items: 0 };

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2postevent"));
  await FarmJob.init();
  autoLister.campaignItems = async () => {
    calls.items += 1;
    return [{ itemKey: "k", name: "Item", qty: 1 }];
  };
  autoLister.pickDeliveryAccounts = async (task) => (task.assignedAccounts || []).slice(0, 2);
  autoLister.listActivatedTask = async (taskId) => {
    await AutoFarmTask.updateOne({ _id: taskId }, { $set: { "listing.externalId": "gf-" + String(taskId).slice(-4) } });
    return { listed: { title: "Bundle", price: 2, qty: 2, url: "https://gameflip.test/x" } };
  };
  autoLister.onCampaignEnded = async () => {
    calls.onCampaignEnded += 1;
    return { repriced: { price: 3 } };
  };
  autoLister.retryMissingSecondaries = async () => {
    calls.retry += 1;
    return null;
  };
  notify.telegram = async (t) => {
    sent.push(t);
  };
});

test.after(async () => {
  Object.assign(autoLister, {
    campaignItems: orig.campaignItems,
    pickDeliveryAccounts: orig.pickDeliveryAccounts,
    listActivatedTask: orig.listActivatedTask,
    onCampaignEnded: orig.onCampaignEnded,
    retryMissingSecondaries: orig.retryMissingSecondaries,
  });
  notify.telegram = orig.telegram;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const daysAgo = (d) => new Date(Date.now() - d * 864e5);
const liveLane = (game) => ({ game, gameKey: game.toLowerCase(), mode: "live" });
const shadowLane = (game) => ({ game, gameKey: game.toLowerCase(), mode: "shadow" });

async function completedTask(game, campaignId, over = {}) {
  return AutoFarmTask.create({
    game,
    campaignId,
    campaignName: "Ended " + campaignId,
    decision: "farm",
    status: "completed",
    assignedAccounts: ["a1", "a2", "a3"],
    bots: [{ host: "pi", file: "c.json", container: "b" }],
    executedAt: daysAgo(10),
    campaignEndAt: daysAgo(3),
    completedAt: daysAgo(3),
    ...over,
  });
}

test("a completed, unlisted task with deliverable stock is queued for a post-event listing — once per throttle window", async () => {
  const game = "Post Event Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  monitorStep._postEventChecked.clear();
  const t = await completedTask(game, "pe-1");
  await completedTask(game, "pe-old", { completedAt: daysAgo(40), campaignEndAt: daysAgo(40) }); // outside the window
  await completedTask(game, "pe-listed", { listing: { externalId: "gf-already" } }); // already listed

  const r1 = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(r1.active, 0);
  assert.equal(r1.postEventChecked, 1, "only the in-window, unlisted task is checked");
  assert.equal(r1.postEventListable, 1);
  assert.equal(r1.postEventQueued, 1);
  const job = await FarmJob.findOne({ lane: game, kind: "publish", market: "primary" }).lean();
  assert.equal(String(job.taskId), String(t._id));
  assert.equal(job.payload.postEvent, true);

  const r2 = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(r2.postEventChecked, 0, "throttled — not re-verified within the window");
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "publish" }), 1);
});

test("a SHADOW lane reports the finding and queues nothing", async () => {
  const game = "Post Event Shadow Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  monitorStep._postEventChecked.clear();
  await completedTask(game, "pes-1");
  const r = await monitorStep.monitorLane(shadowLane(game), { jobs, shadow: true, cache: new Map() });
  assert.equal(r.postEventListable, 1);
  assert.equal(r.postEventQueued, 0);
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "publish" }), 0);
});

test("publishPrimary lists an ended campaign and then applies the post-event pass (markup, retitle, stacking)", async () => {
  const game = "Post Event Publish Game";
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmEvent.deleteMany({ game });
  const t = await completedTask(game, "pep-1");
  calls.onCampaignEnded = 0;
  sent.length = 0;
  const r = await publishStep.publishPrimary({ taskId: t._id, af: { dryRun: false }, shadow: false, lane: liveLane(game) });
  assert.equal(r.listed.title, "Bundle");
  assert.equal(calls.onCampaignEnded, 1, "onCampaignEnded ran after the listing landed");
  assert.deepEqual(r.postEvent, { repriced: { price: 3 } });
  assert.match(sent[0], /post-event/);
  assert.equal((await AutoFarmEvent.findOne({ game }).lean()).type, "listed");

  // A LIVE campaign is listed without the post-event pass.
  await AutoFarmTask.deleteMany({ game });
  const live = await completedTask(game, "pep-2", { status: "active", campaignEndAt: new Date(Date.now() + 48 * 3600e3), completedAt: null });
  calls.onCampaignEnded = 0;
  const r2 = await publishStep.publishPrimary({ taskId: live._id, af: { dryRun: false }, shadow: false, lane: liveLane(game) });
  assert.equal(r2.listed.title, "Bundle");
  assert.equal(calls.onCampaignEnded, 0);
  assert.equal(r2.postEvent, undefined);
});

test("a secondaries job that finds nothing to do is not re-queued every cycle", async () => {
  const game = "Secondaries Throttle Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  publishStep._secondariesSettled.clear();
  const t = await AutoFarmTask.create({
    game,
    campaignId: "st-1",
    decision: "farm",
    status: "active",
    assignedAccounts: ["a1", "a2"],
    bots: [{ host: "pi", file: "c.json", container: "b" }],
    executedAt: new Date(),
    campaignEndAt: new Date(Date.now() + 48 * 3600e3),
    listing: { externalId: "gf-1" }, // primary present, secondaries "missing"
  });
  const r1 = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(r1.queuedSecondaries, 1);
  const job = await jobs.claimNext({ laneKey: game.toLowerCase(), kind: "publish" });
  calls.retry = 0;
  const res = await publishStep.publishSecondaries({ taskId: t._id, shadow: false, lane: liveLane(game) });
  await jobs.finish(job, res);
  assert.equal(calls.retry, 1);
  assert.match(res.skipped, /already present/);
  assert.equal(publishStep.secondariesSettledRecently(t._id), true);
  const r2 = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(r2.queuedSecondaries, 0, "settled recently — not re-queued");
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "publish", market: "secondaries" }), 1);
});
