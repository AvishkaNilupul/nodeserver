// THE MONEY PATH, END TO END — the one that has never run in production.
//
// Every lane decision recorded on prod in the engine's first three days was
// reuse_existing or skip_low_demand: every game already had warm bots, so
// reuse-first won every time and farm2 never spent a fresh pool account and
// never created a listing. Promoting more games does not test this; only a
// game with no warm bots does. This test IS that game.
//
// It drives the REAL supervisor cycle, the REAL lane runner, the REAL decide
// step through all nine gates, the REAL execute step handing over to the REAL
// autoFarmer.executeTask (pool claim by atomic findOneAndUpdate, reserve and
// capacity re-checks, the AutoFarmTask row it writes, the event it records),
// then the REAL monitor -> verify -> publish jobs across three cycles, against
// an in-memory Mongo and a farm host that is a temp directory. The only stubs
// are the edges that would touch the world: the container factory, the manual
// stash sweep, the lister's Twitch/Gameflip calls, and Telegram.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const AvailableAccount = require("../models/AvailableAccount");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");
const autoFarmer = require("../utils/autoFarmer");
const autoLister = require("../utils/autoLister");
const notify = require("../utils/farm2/notify");
const farm2 = require("../utils/farm2");
const ownership = require("../utils/farm2/ownership");
const settings = require("../utils/settings");

let mem;
let tmpDir;
const sent = [];
const created = [];
const orig = {
  getAutoFarm: settings.getAutoFarm,
  resolveHost: hosts.resolveHost,
  createBot: botFactory.createBot,
  manualFarmMap: autoFarmer.manualFarmMap,
  campaignItems: autoLister.campaignItems,
  pickDeliveryAccounts: autoLister.pickDeliveryAccounts,
  listActivatedTask: autoLister.listActivatedTask,
  retryMissingSecondaries: autoLister.retryMissingSecondaries,
  telegram: notify.telegram,
};

const GAME = "Fresh Path Game";
const CAMPAIGN = "fresh-c1";
const HOST = { id: "tmp", label: "Tmp host", transport: "local", runtime: "docker", dir: "" };

function af() {
  return {
    ...orig.getAutoFarm.call(settings),
    enabled: true,
    farm2Enabled: true,
    dryRun: false,
    hostId: "tmp",
    consolidate: false,
    probeColdStart: false,
    minHoursLeft: 12,
    maxPerGame: 30,
    maxAutoBots: 5,
    accountsPerBot: 10,
    poolReserve: 0,
    perMarketStock: 3,
    platiCategoryId: "",
    forceGames: [],
    stopFinishedBots: false,
  };
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2fresh"));
  await FarmJob.init();
  await AutoFarmTask.init();
  await AvailableAccount.init();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "farm2-fresh-"));
  HOST.dir = tmpDir;

  settings.getAutoFarm = af;
  hosts.resolveHost = (id) => (String(id) === "tmp" ? HOST : orig.resolveHost(id));
  botFactory.createBot = async (host, batch, game, opts) => {
    created.push({ host: host.id, accounts: batch.map((a) => a.username), game, opts });
    return { host: host.id, file: "config_9.json", container: "twitchbotx9", config: {}, startError: "" };
  };
  autoFarmer.manualFarmMap = async () => ({ map: new Map(), wildcard: new Set(), logins: new Set() });
  autoLister.campaignItems = async () => [{ itemKey: "fresh:item", name: "Fresh Item", qty: 1 }];
  autoLister.pickDeliveryAccounts = async (task) => (task.assignedAccounts || []).slice();
  autoLister.listActivatedTask = async (taskId) => {
    await AutoFarmTask.updateOne({ _id: taskId }, { $set: { "listing.externalId": "gf-123", "listing.qty": 8 } });
    return { listed: { title: "Fresh Item bundle", price: 2.5, qty: 8, url: "https://gameflip.test/gf-123" } };
  };
  autoLister.retryMissingSecondaries = async (task) => {
    await AutoFarmTask.updateOne(
      { _id: task._id },
      { $set: { "listing.plati.externalId": "p1", "listing.ggsel.externalId": "g1", "listing.zeusx.externalId": "z1" } },
    );
    return ["plati", "ggsel", "zeusx"];
  };
  notify.telegram = async (t) => {
    sent.push(t);
  };

  // The engine must believe it is running for ownership to mean anything.
  ownership.setEngineRunning(true);

  await MarketResearch.create({ game: GAME, demandScore: 90, sellers: 8, scannedAt: new Date() });
  await TwitchCampaign.create({ campaignId: CAMPAIGN, name: "Fresh Weekly", game: GAME, status: "ACTIVE", active: true, endAt: new Date(Date.now() + 48 * 3600000) });
  for (let i = 1; i <= 8; i += 1) {
    await AvailableAccount.create({ username: "fresh_" + i, usernameLower: "fresh_" + i, password: "p", clientSecret: "tok-" + i, status: "available", lastCheckStatus: "ok", lastCheckAt: new Date() });
  }
  await FarmLane.create({ game: GAME, gameKey: settings.normGameName(GAME), mode: "live", state: "idle", nextRunAt: new Date() });
});

test.after(async () => {
  settings.getAutoFarm = orig.getAutoFarm;
  hosts.resolveHost = orig.resolveHost;
  botFactory.createBot = orig.createBot;
  autoFarmer.manualFarmMap = orig.manualFarmMap;
  autoLister.campaignItems = orig.campaignItems;
  autoLister.pickDeliveryAccounts = orig.pickDeliveryAccounts;
  autoLister.listActivatedTask = orig.listActivatedTask;
  autoLister.retryMissingSecondaries = orig.retryMissingSecondaries;
  notify.telegram = orig.telegram;
  ownership.setEngineRunning(false);
  await mongoose.disconnect();
  if (mem) await mem.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const laneResult = (summary) => (summary.results || []).find((r) => r.game === GAME);

test("cycle 1: decide FARM through all nine gates, spend from the sealed allowance, execute for real, deploy 8 fresh accounts", async () => {
  const s = await farm2.runCycle({ force: true });
  assert.equal(s.enabled, true);
  assert.equal(s.lanes, 1);
  const r = laneResult(s);
  assert.deepEqual(r.errors, [], r.errors.join("; "));

  // The arbiter: 8 ready, reserve 0, no active containers → 8 accounts, 5 free
  // containers; the one live lane asked for 30 and was granted all 8.
  assert.equal(s.budget.totalAccounts, 8);
  assert.equal(s.budget.totalContainers, 5);
  const grant = s.budget.grants[settings.normGameName(GAME)];
  assert.equal(grant.spentAccounts, 8, "the farm decision drew its plan on demand from the budget");
  assert.equal(s.budget.unallocated, 0, "nothing left for anyone else this cycle");

  const decide = await FarmJob.findOne({ lane: GAME, kind: "decide" }).lean();
  assert.equal(decide.status, "done");
  const v = decide.result.verdict;
  assert.equal(v.decision, "farm");
  assert.equal(v.plannedAccounts, 8, "min(uncovered 30, allowance 8, seats 50)");
  assert.equal(v.targetAccounts, 30, "the full tier target incl. the market floor, as legacy's row records");
  assert.equal(v.decisionInputs.version, 1);
  assert.equal(v.coverage.archiveHolders, 0);

  const exec = await FarmJob.findOne({ lane: GAME, kind: "execute" }).lean();
  assert.equal(exec.status, "done", exec.error);
  assert.equal(exec.payload.granted, 8);
  assert.equal(exec.result.accounts, 8);
  assert.equal(exec.result.host, "tmp");

  // The row the REAL executeTask wrote.
  const task = await AutoFarmTask.findOne({ game: GAME, campaignId: CAMPAIGN }).lean();
  assert.equal(task.status, "active");
  assert.equal(task.decision, "farm");
  assert.equal(task.assignedAccounts.length, 8);
  assert.equal(task.plannedAccounts, 8);
  assert.equal(task.targetAccounts, 30);
  assert.ok(task.executedAt);
  assert.equal(task.dryRun, false);
  assert.deepEqual(task.bots.map((b) => b.container), ["twitchbotx9"]);
  assert.equal(task.bots[0].reused, false);

  // The pool: every account claimed by the atomic claim, with legacy's note.
  const claimed = await AvailableAccount.find({ status: "claimed" }).lean();
  assert.equal(claimed.length, 8);
  assert.equal(await AvailableAccount.countDocuments({ status: "available" }), 0);
  for (const a of claimed) assert.equal(a.claimedNote, `auto-farm: ${GAME} (${CAMPAIGN})`);
  assert.equal(await PoolUsageEvent.countDocuments({ event: "claimed" }), 8, "the where-used history is written for lane claims too");

  // The container factory saw one batch of 8 on the farm host.
  assert.equal(created.length, 1);
  assert.equal(created[0].host, "tmp");
  assert.equal(created[0].game, GAME);
  assert.equal(created[0].accounts.length, 8);

  // The trail: legacy's own task_started event, from legacy's own executor.
  const ev = await AutoFarmEvent.find({ game: GAME }).sort({ at: 1 }).lean();
  assert.deepEqual(ev.map((e) => [e.type, e.actor]), [["task_started", "executeTask"]]);
  assert.equal(ev[0].count, 8);

  // Monitor saw the fresh task as verified and queued the primary listing.
  assert.equal(r.audit.tasks, 1);
  assert.equal(r.audit.listable, 1);
  assert.equal(r.audit.unlistedButReady, 1);
  const pub = await FarmJob.findOne({ lane: GAME, kind: "publish", market: "primary" }).lean();
  assert.equal(pub.status, "queued");
});

test("cycle 2: the campaign is settled (no re-decision); the primary listing publishes with the event and the alert", async () => {
  sent.length = 0;
  const s = await farm2.runCycle({ force: true });
  const r = laneResult(s);
  assert.deepEqual(r.errors, [], r.errors.join("; "));
  assert.equal(r.decisions, 0, "an executed campaign is settled — decided once, not once per cycle");
  assert.equal(await FarmJob.countDocuments({ lane: GAME, kind: "decide" }), 1);
  assert.equal(await FarmJob.countDocuments({ lane: GAME, kind: "execute" }), 1);
  assert.equal(s.budget.unallocated, s.budget.totalAccounts, "nothing new was spent");

  const pub = await FarmJob.findOne({ lane: GAME, kind: "publish", market: "primary" }).lean();
  assert.equal(pub.status, "done", pub.error);
  assert.equal(pub.result.listed.title, "Fresh Item bundle");
  assert.equal(pub.result.verifiedAtPublish, 8, "the holdings gate re-verified immediately before listing");

  const ev = await AutoFarmEvent.find({ game: GAME }).sort({ at: 1 }).lean();
  assert.deepEqual(ev.map((e) => [e.type, e.actor]), [
    ["task_started", "executeTask"],
    ["listed", "farm2/publishPrimary"],
  ]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Auto-listed \(lane\) — Fresh Path Game/);
  assert.match(sent[0], /qty 8/);

  const lane = await FarmLane.findOne({ game: GAME }).lean();
  assert.equal(lane.counters.executions, 1);
  assert.equal(lane.counters.listings, 1);
  assert.equal(lane.counters.failures, 0);
  assert.equal(lane.state, "idle");

  // With the primary live and no secondaries yet, the monitor queued those.
  const sec = await FarmJob.findOne({ lane: GAME, kind: "publish", market: "secondaries" }).lean();
  assert.equal(sec.status, "queued");
});

test("cycle 3: the secondaries retry on their own clock; then the lane is quiet", async () => {
  sent.length = 0;
  const s = await farm2.runCycle({ force: true });
  const r = laneResult(s);
  assert.deepEqual(r.errors, [], r.errors.join("; "));
  const sec = await FarmJob.findOne({ lane: GAME, kind: "publish", market: "secondaries" }).lean();
  assert.equal(sec.status, "done", sec.error);
  assert.deepEqual(sec.result.retried, ["plati", "ggsel", "zeusx"]);
  assert.match(sent[0], /Auto-relisted \(lane\)/);

  // Steady state: one decide, one execute, the two publish rows — and nothing
  // else accrues while the campaign runs.
  const s4 = await farm2.runCycle({ force: true });
  assert.deepEqual(laneResult(s4).errors, []);
  const counts = await FarmJob.aggregate([{ $match: { lane: GAME } }, { $group: { _id: { k: "$kind", m: "$market" }, n: { $sum: 1 } } }]);
  const byKind = Object.fromEntries(counts.map((c) => [c._id.k + (c._id.m ? "/" + c._id.m : ""), c.n]));
  assert.equal(byKind.decide, 1);
  assert.equal(byKind.execute, 1);
  assert.equal(byKind["publish/primary"], 1);
  assert.equal(byKind["publish/secondaries"], 1, "every market present — nothing more to queue");
  assert.equal(await AutoFarmTask.countDocuments({ game: GAME }), 1, "one row, as the Auto-farm page expects");
});

test("the ownership contract holds for the game the lane just farmed", async () => {
  ownership.invalidate();
  assert.equal(await ownership.isOwnedAsync(GAME), true, "a live lane owns its game — the legacy engine skips it");
  assert.equal(await ownership.isOwnedAsync("Some Other Game"), false);
});
