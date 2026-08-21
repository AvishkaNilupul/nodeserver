const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AvailableAccount = require("../models/AvailableAccount");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const { recordPoolUsage } = require("../utils/poolUsageLog");

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("pool-usage-log-test"));
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test("recordPoolUsage writes both capped account history and flat watcher events", async () => {
  const accounts = await AvailableAccount.create([
    { username: "pool_one", usernameLower: "pool_one" },
    { username: "pool_two", usernameLower: "pool_two" },
  ]);

  await recordPoolUsage(
    accounts.map((account) => account._id),
    {
      event: "claimed",
      game: "UFL",
      campaignId: "90210",
      actor: "auto-farm",
      host: "pi",
    },
  );

  const storedAccounts = await AvailableAccount.find({}, { username: 1, usageHistory: 1 })
    .sort({ username: 1 })
    .lean();
  assert.equal(storedAccounts.length, 2);
  assert.equal(storedAccounts[0].usageHistory.length, 1);
  assert.equal(storedAccounts[0].usageHistory[0].game, "UFL");

  const events = await PoolUsageEvent.find({}).sort({ username: 1 }).lean();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => ({ username: event.username, game: event.game, actor: event.actor })),
    [
      { username: "pool_one", game: "UFL", actor: "auto-farm" },
      { username: "pool_two", game: "UFL", actor: "auto-farm" },
    ],
  );
});
