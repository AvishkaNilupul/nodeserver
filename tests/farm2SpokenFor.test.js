// The decide step's spoken-for set counts PLANNED tasks as well as ACTIVE ones.
//
// Legacy's inline reuse computes "which of the warm bots' accounts are still
// free" against tasks in status active OR planned. The lane's execute step
// recomputes the same way at execution time. The decide step counted only
// active, so for the same inputs a shadow verdict could plan more reuse
// accounts than legacy would — a comparison error in the accounts delta — and
// in a live cycle a sibling campaign already written as `planned` by
// upsertTask was invisible to it. Aligned here; pinned by these tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const decideStep = require("../utils/farm2/steps/decide");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2spokenfor"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// A completed task with five accounts on one warm bot; the bot-file existence
// check is answered from the cache so no host is read.
async function warm(game) {
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "completed",
    assignedAccounts: ["s1", "s2", "s3", "s4", "s5"].map((s) => `${game}-${s}`),
    bots: [{ host: "local", file: "config_9.json", container: "bot9" }],
  });
  return new Map([["local|config_9.json", true]]);
}

async function sibling(game, status, accounts) {
  await AutoFarmTask.create({
    game: `${game} Sibling`,
    campaignId: "sib-" + status,
    decision: "farm",
    status,
    assignedAccounts: accounts,
  });
}

test("a PLANNED sibling's accounts are spoken for — as legacy counts them", async () => {
  const game = "Planned Sibling Game";
  const hostCache = await warm(game);
  await sibling(game, "planned", [`${game}-s1`, `${game}-s2`]);
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache });
  assert.ok(r, "the warm bot is still reusable");
  assert.equal(r.accounts.length, 3, "5 held, 2 planned elsewhere — only 3 are free");
  assert.deepEqual(r.accounts.sort(), [`${game}-s3`, `${game}-s4`, `${game}-s5`]);
});

test("an ACTIVE sibling's accounts are spoken for — unchanged", async () => {
  const game = "Active Sibling Game";
  const hostCache = await warm(game);
  await sibling(game, "active", [`${game}-s1`]);
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache });
  assert.equal(r.accounts.length, 4);
});

test("a COMPLETED or SKIPPED sibling's accounts are NOT spoken for", async () => {
  // Those tasks farm nothing and advertise nothing; their old assignments do
  // not block a new reuse. Legacy's query excludes them too.
  const game = "Settled Sibling Game";
  const hostCache = await warm(game);
  await sibling(game, "completed", [`${game}-s1`, `${game}-s2`]);
  await sibling(game, "skipped", [`${game}-s3`]);
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache });
  assert.equal(r.accounts.length, 5, "all five are free");
});

test("decide and execute now agree on what is spoken for", async () => {
  // The two steps used to differ (active-only vs active+planned). With a
  // planned sibling present, the verdict's plannedAccounts must match what
  // execute would find, or the lane plans one number and spends another.
  const game = "Agree Sibling Game";
  const hostCache = await warm(game);
  await sibling(game, "planned", [`${game}-s1`, `${game}-s2`, `${game}-s3`]);
  const decided = await decideStep.reuseCandidate(game, { cycle: null, hostCache });
  const reusable = await AutoFarmTask.findOne({ game, campaignId: "old" }).lean();
  const others = await AutoFarmTask.find(
    { status: { $in: ["active", "planned"] }, _id: { $ne: reusable._id } },
    { assignedAccounts: 1 },
  ).lean();
  const spokenFor = new Set(others.flatMap((o) => (o.assignedAccounts || []).map((u) => String(u).toLowerCase())));
  const executeWouldFind = reusable.assignedAccounts.filter((u) => !spokenFor.has(String(u).toLowerCase()));
  assert.equal(decided.accounts.length, executeWouldFind.length);
  assert.equal(decided.accounts.length, 2);
});
