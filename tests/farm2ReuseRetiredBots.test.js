// A retired bot must not ride along into a reuse.
//
// decide.reuseCandidate drops bots whose config is gone (deleted from the Bots
// page, config renamed .done-*) and hands the survivors to execute as
// verdict.reuseBots. executeReuse re-read the source task and used every bot it
// had ever listed, so a deleted bot was restarted (and failed) and recorded on
// the new row — carried into every later reuse of the game. On prod, contabo
// twitchbotx34 (deleted 2026-09-21) was still being copied onto new Marvel
// Rivals rows on 09-26, and the Auto-farm tab flagged it "expected container is
// missing" on every snapshot.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const executeStep = require("../utils/farm2/steps/execute");
const botFactory = require("../utils/botFactory");
const botWaker = require("../utils/botWaker");

let mem;
const origStart = botFactory.startContainer;
const origRegistry = botWaker.readRegistry;
let started = [];

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2reuseretired"));
  await FarmJob.init();
  botFactory.startContainer = async (_h, container) => {
    started.push(container);
  };
  botWaker.readRegistry = async () => ({});
});

test.after(async () => {
  botFactory.startContainer = origStart;
  botWaker.readRegistry = origRegistry;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// Account names are per game: executeReuse treats an account held by ANY live
// task as spoken for, so a shared name would let one test starve the next.
async function source(game) {
  await AutoFarmTask.deleteMany({ game });
  const p = game.toLowerCase().replace(/[^a-z0-9]+/g, "") + "_";
  return AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "completed",
    assignedAccounts: [p + "1", p + "2", p + "3"],
    bots: [
      { host: "contabo", file: "config_24.json", container: "twitchbotx24" },
      { host: "contabo", file: "config_34.json", container: "twitchbotx34" },
      { host: "contabo", file: "config_42.json", container: "twitchbotx42" },
    ],
  });
}

const verdict = (game, campaignId, src, reuseBots) => ({
  game,
  campaignId,
  campaignName: "Weekly",
  campaignEndAt: new Date(Date.now() + 48 * 3600000),
  decision: "reuse_existing",
  reuseTaskId: src._id,
  reuseBots,
  demandScore: 3.7,
  hadResearch: true,
  internalSales: 13,
  reason: "recurring campaign",
});

test("only the bots decide found alive are restarted and recorded", async () => {
  const game = "Retired Bot Game";
  const src = await source(game);
  started = [];
  await executeStep.executeReuse({
    verdict: verdict(game, "new", src, ["twitchbotx24", "twitchbotx42"]),
    dryRun: false,
  });
  assert.deepEqual(started.sort(), ["twitchbotx24", "twitchbotx42"], "the retired bot is not restarted");
  const row = await AutoFarmTask.findOne({ game, campaignId: "new" }).lean();
  assert.equal(row.status, "active");
  assert.deepEqual(
    row.bots.map((b) => b.container).sort(),
    ["twitchbotx24", "twitchbotx42"],
    "the retired bot is not carried onto the new row",
  );
});

test("a verdict without reuseBots keeps every bot, exactly as before", async () => {
  const game = "Legacy Verdict Game";
  const src = await source(game);
  started = [];
  await executeStep.executeReuse({ verdict: verdict(game, "new", src, undefined), dryRun: false });
  assert.deepEqual(started.sort(), ["twitchbotx24", "twitchbotx34", "twitchbotx42"]);
});
