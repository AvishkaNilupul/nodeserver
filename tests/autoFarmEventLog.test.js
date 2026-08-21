const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmEvent = require("../models/AutoFarmEvent");
const { recordAutoFarmEvent } = require("../utils/autoFarmEventLog");

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auto-farm-event-log-test"));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test("recordAutoFarmEvent persists a denormalized lifecycle event", async () => {
  const taskId = new mongoose.Types.ObjectId();
  await recordAutoFarmEvent({
    type: "parked",
    game: "UFL",
    campaignId: "campaign-1",
    taskId,
    host: "pi",
    container: "twitchbotx7",
    count: 12,
    reason: "all accounts finished their assigned games",
    actor: "stopFinishedBots",
  });

  const event = await AutoFarmEvent.findOne({ type: "parked" }).lean();
  assert.equal(event.game, "UFL");
  assert.equal(String(event.taskId), String(taskId));
  assert.equal(event.container, "twitchbotx7");
  assert.equal(event.count, 12);
  assert.equal(event.actor, "stopFinishedBots");
  assert.ok(event.at instanceof Date);
});

test("recordAutoFarmEvent swallows persistence failures", async () => {
  await mongoose.disconnect();
  await assert.doesNotReject(
    recordAutoFarmEvent({ type: "task_started", actor: "executeTask" }),
  );
  await mongoose.connect(mongod.getUri("auto-farm-event-log-test"));
});
