// Coverage for the live-mode steps (utils/farm2/steps/{execute,publish,monitor}.js)
// and the promotion readiness gate (utils/farm2/index.js).
//
// The single worst bug this engine could have is "a shadow lane spent real
// accounts" or "a shadow lane listed something for sale". Shadow mode is the
// entire basis on which the trial is allowed to run against live games, so the
// assertions that enforce it are pinned here first and hardest.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmLane = require("../models/FarmLane");
const FarmJob = require("../models/FarmJob");
const AutoFarmTask = require("../models/AutoFarmTask");
const executeStep = require("../utils/farm2/steps/execute");
const publishStep = require("../utils/farm2/steps/publish");
const monitorStep = require("../utils/farm2/steps/monitor");
const jobs = require("../utils/farm2/jobs");
const farm2 = require("../utils/farm2");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2live"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const verdict = (over = {}) => ({
  game: "Test Game",
  campaignId: "c-live-1",
  campaignName: "Test Campaign",
  decision: "farm",
  plannedAccounts: 5,
  targetAccounts: 5,
  reason: "test",
  ...over,
});

/* ------------------------- the shadow assertions -------------------------- */

test("execute REFUSES to run for a shadow lane", async () => {
  const lane = { game: "Test Game", gameKey: "test game", mode: "shadow" };
  await assert.rejects(
    () => executeStep.executeDecision({ verdict: verdict(), lane, shadow: true }),
    /shadow lane/i,
    "a shadow lane must never reach the spending path",
  );
});

test("execute REFUSES even if the shadow flag is wrong but the lane is not live", async () => {
  // Defence in depth: the flag and the lane's own mode are checked separately,
  // so a caller passing shadow:false by mistake still cannot spend from a lane
  // that is not actually live.
  const lane = { game: "Test Game", gameKey: "test game", mode: "shadow" };
  await assert.rejects(
    () => executeStep.executeDecision({ verdict: verdict(), lane, shadow: false }),
    /only a live lane may spend/i,
  );
});

test("execute refuses for an 'off' lane too", async () => {
  const lane = { game: "Test Game", gameKey: "test game", mode: "off" };
  await assert.rejects(
    () => executeStep.executeDecision({ verdict: verdict(), lane, shadow: false }),
    /only a live lane may spend/i,
  );
});

test("publish REFUSES from a shadow or non-live lane", async () => {
  const shadowLane = { game: "Test Game", gameKey: "test game", mode: "shadow" };
  await assert.rejects(
    () => publishStep.publishPrimary({ taskId: new mongoose.Types.ObjectId(), lane: shadowLane, shadow: true }),
    /non-live lane/i,
  );
  await assert.rejects(
    () => publishStep.publishSecondaries({ taskId: new mongoose.Types.ObjectId(), lane: shadowLane, shadow: true }),
    /non-live lane/i,
  );
  // And by lane mode alone, with the flag unset.
  await assert.rejects(
    () => publishStep.publishPrimary({ taskId: new mongoose.Types.ObjectId(), lane: shadowLane, shadow: false }),
    /non-live lane/i,
  );
});

test("a shadow lane's monitor pass queues NO publish jobs", async () => {
  await FarmJob.deleteMany({});
  await AutoFarmTask.deleteMany({ game: "Shadow Game" });
  await AutoFarmTask.create({
    game: "Shadow Game",
    campaignId: "c-shadow",
    decision: "farm",
    status: "active",
    assignedAccounts: ["a", "b"],
    targetAccounts: 2,
  });
  const lane = { game: "Shadow Game", gameKey: "shadow game", mode: "shadow" };
  const report = await monitorStep.monitorLane(lane, { jobs, shadow: true });
  assert.equal(report.active, 1, "it still SEES the task");
  assert.equal(report.queuedPrimary, 0, "but queues no publish work");
  assert.equal(report.queuedSecondaries, 0);
  assert.equal(await FarmJob.countDocuments({ kind: "publish" }), 0);
});

/* --------------------------- the readiness gate --------------------------- */

test("a lane with no shadow evidence is NOT ready to go live", async () => {
  await FarmJob.deleteMany({});
  await FarmLane.deleteMany({ gameKey: "ready test" });
  const lane = await FarmLane.create({ game: "Ready Test", gameKey: "ready test", mode: "shadow" });
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.ready, false);
  assert.match(r.blockers.join(" "), /comparable against the legacy engine/i);
  assert.equal(r.shadowDecisions, 0);
  assert.equal(r.compared, 0);
});

test("a lane becomes ready once it has enough shadow decisions", async () => {
  await FarmJob.deleteMany({});
  await FarmLane.deleteMany({ gameKey: "ready test 2" });
  const lane = await FarmLane.create({ game: "Ready Test 2", gameKey: "ready test 2", mode: "shadow" });
  for (let i = 0; i < farm2.MIN_SHADOW_DECISIONS; i += 1) {
    await FarmJob.create({
      lane: "Ready Test 2",
      laneKey: "ready test 2",
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      result: { verdict: { decision: "farm" }, diff: { agree: true, laneClass: "spend", legacyClass: "spend", stale: false } },
    });
  }
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.ready, true, "blockers: " + r.blockers.join("; "));
  assert.equal(r.warnings.length, 0, "agreeing decisions produce no warning");
});

// This test previously asserted the OPPOSITE — that a disagreement only warns,
// on the reasoning that some disagreements are legitimate and judging them is
// the operator's call. The live shadow trial on 2026-09-04 proved that wrong:
// three lanes reported agreement while planning to spend fresh pool accounts on
// games the legacy engine was serving by reusing warm bots, and a warning would
// not have stopped a promotion that made the system worse. A disagreement now
// means one of the two engines is wrong about a real game, which must be
// understood BEFORE the lane takes it over.
test("a disagreement blocks promotion (force still overrides, and is audited)", async () => {
  await FarmJob.deleteMany({});
  await FarmLane.deleteMany({ gameKey: "ready test 3" });
  const lane = await FarmLane.create({ game: "Ready Test 3", gameKey: "ready test 3", mode: "shadow" });
  for (let i = 0; i < 4; i += 1) {
    await FarmJob.create({
      lane: "Ready Test 3",
      laneKey: "ready test 3",
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "farm" },
        diff: {
          agree: i !== 0,
          // laneClass is what marks a row as scored by the CURRENT diff logic;
          // the gate ignores rows without it, since those were scored by the
          // intent grouping this finding disproved.
          laneClass: i === 0 ? "spend" : "reuse",
          legacyClass: "reuse",
          stale: false,
          laneDecision: "farm",
          legacyDecision: "reuse_existing",
          accountDelta: 12,
        },
      },
    });
  }
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.ready, false, "a disagreement must stop an automatic promotion");
  assert.match(r.blockers.join(" "), /disagreed with the legacy engine/i);
  assert.equal(r.disagreements, 1);
  assert.equal(r.compared, 4);
});

/* ----------------------------- publish needs ------------------------------ */

test("publishNeeds reads the listing state correctly", () => {
  assert.deepEqual(publishStep.publishNeeds({ listing: {} }), {
    needsPrimary: true,
    needsSecondaries: false,
  });
  // Primary present, every secondary missing.
  assert.deepEqual(publishStep.publishNeeds({ listing: { externalId: "gf1" } }), {
    needsPrimary: false,
    needsSecondaries: true,
  });
  // Fully published.
  assert.deepEqual(
    publishStep.publishNeeds({
      listing: {
        externalId: "gf1",
        plati: { externalId: "p1" },
        ggsel: { externalId: "g1" },
        zeusx: { externalId: "z1" },
      },
    }),
    { needsPrimary: false, needsSecondaries: false },
  );
  // One missing secondary is still work to do.
  assert.equal(
    publishStep.publishNeeds({
      listing: {
        externalId: "gf1",
        plati: { externalId: "p1" },
        ggsel: { externalId: "g1" },
        zeusx: {},
      },
    }).needsSecondaries,
    true,
  );
});

/* --------------------------- task row creation ---------------------------- */

test("execute writes an AutoFarmTask indistinguishable from a legacy one", async () => {
  await AutoFarmTask.deleteMany({ game: "Upsert Game" });
  const t = await executeStep.upsertTask(
    verdict({ game: "Upsert Game", campaignId: "c-upsert", demandScore: 30, internalSales: 2 }),
    { dryRun: true },
  );
  assert.equal(t.game, "Upsert Game");
  assert.equal(t.status, "planned");
  assert.equal(t.plannedAccounts, 5);
  assert.equal(t.decision, "farm");
  assert.ok(t.decidedAt, "decidedAt is stamped — the Auto-farm page sorts on it");
  // Reusing AutoFarmTask (rather than a parallel store) is what keeps the
  // Auto-farm page, archive, fulfiller and forecast working for lane tasks.
  const again = await executeStep.upsertTask(
    verdict({ game: "Upsert Game", campaignId: "c-upsert", plannedAccounts: 9 }),
    { dryRun: true },
  );
  assert.equal(String(again._id), String(t._id), "upsert, not duplicate");
  assert.equal(again.plannedAccounts, 9, "re-decision updates in place");
});

test("execute honours the engine-wide dry-run flag without spending", async () => {
  const orig = settings.getAutoFarm;
  settings.getAutoFarm = () => ({ ...orig.call(settings), dryRun: true, hostId: "" });
  try {
    const lane = { game: "Dry Game", gameKey: "dry game", mode: "live" };
    const r = await executeStep.executeDecision({
      verdict: verdict({ game: "Dry Game", campaignId: "c-dry" }),
      lane,
      shadow: false,
      af: { ...orig.call(settings), dryRun: true },
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.wouldSpend, 5);
    const t = await AutoFarmTask.findOne({ game: "Dry Game", campaignId: "c-dry" }).lean();
    assert.equal(t.dryRun, true, "the task is marked dry-run");
    assert.equal((t.assignedAccounts || []).length, 0, "nothing was claimed");
  } finally {
    settings.getAutoFarm = orig;
  }
});

/* --------------------- churn + RAM-saver interaction ---------------------- */

test("a reuse never restarts a container the RAM saver parked", async () => {
  const botWaker = require("../utils/botWaker");
  const botFactory = require("../utils/botFactory");
  const origReg = botWaker.readRegistry;
  const origStart = botFactory.startContainer;
  const startedCalls = [];
  // pi|twitchbotx42 is parked; pi|twitchbotx34 is not.
  botWaker.readRegistry = async () => ({ "pi|twitchbotx42": { parkedAt: new Date().toISOString() } });
  botFactory.startContainer = async (host, container) => { startedCalls.push(container); };
  await AutoFarmTask.deleteMany({ game: "Park Test" });
  const src = await AutoFarmTask.create({
    game: "Park Test",
    campaignId: "c-src",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: ["p1", "p2"],
    bots: [
      { host: "pi", file: "a.json", container: "twitchbotx42" },
      { host: "pi", file: "b.json", container: "twitchbotx34" },
    ],
  });
  try {
    const r = await executeStep.executeReuse({
      verdict: { game: "Park Test", campaignId: "c-new", decision: "reuse_existing", reuseTaskId: src._id },
      dryRun: false,
    });
    // Starting a parked container would undo the RAM saving on the next cycle
    // and bypass botWaker's liveness/grace logic — the "two engines fighting"
    // failure this engine exists to avoid.
    assert.deepEqual(startedCalls, ["twitchbotx34"], "only the un-parked container is started");
    assert.deepEqual(r.skippedParked, ["twitchbotx42"]);
  } finally {
    botWaker.readRegistry = origReg;
    botFactory.startContainer = origStart;
  }
});

test("everything parked is not treated as a failure", async () => {
  const botWaker = require("../utils/botWaker");
  const botFactory = require("../utils/botFactory");
  const origReg = botWaker.readRegistry;
  const origStart = botFactory.startContainer;
  botWaker.readRegistry = async () => ({ "pi|onlybot": { parkedAt: new Date().toISOString() } });
  botFactory.startContainer = async () => { throw new Error("should not be called"); };
  await AutoFarmTask.deleteMany({ game: "All Parked" });
  const src = await AutoFarmTask.create({
    game: "All Parked",
    campaignId: "c-src",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: ["x"],
    bots: [{ host: "pi", file: "a.json", container: "onlybot" }],
  });
  try {
    // botWaker will wake it when the campaign warrants; that is not our error.
    const r = await executeStep.executeReuse({
      verdict: { game: "All Parked", campaignId: "c-new", decision: "reuse_existing", reuseTaskId: src._id },
      dryRun: false,
    });
    assert.deepEqual(r.restarted, []);
    assert.deepEqual(r.skippedParked, ["onlybot"]);
  } finally {
    botWaker.readRegistry = origReg;
    botFactory.startContainer = origStart;
  }
});
