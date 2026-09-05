// A live lane's decide-time skips are written to AutoFarmTask as the rows
// legacy writes (FARM2-VERIFICATION §7.8, closed; §12).
//
// Until this, a campaign a live lane decided NOT to farm left no AutoFarmTask
// row: the decision lived only in FarmJob. The World of Tanks incident (§11)
// set the rule for closing that — any row the lane writes must be one legacy
// already produces, because legacy's sweeps read status and act on it. These
// tests pin the mapping (identity on decision, legacy's field set per
// decision), the one edge (skip_reuse_only, produced by legacy at claim time),
// the guard (never over a row that owns something), and the shadow guarantee.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const laneMod = require("../utils/farm2/lane");
const executeStep = require("../utils/farm2/steps/execute");
const classes = require("../utils/farm2/decisionClasses");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2skiprows"));
  await FarmJob.init();
  await AutoFarmTask.init(); // the unique (game, campaignId) index is the guard's backstop
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

function af(overrides = {}) {
  return {
    ...settings.getAutoFarm(),
    probeColdStart: false,
    dryRun: false,
    minHoursLeft: 12,
    maxPerGame: 30,
    platiCategoryId: "",
    ...overrides,
  };
}

const snapshot = () => ({
  version: 1,
  at: new Date(),
  research: { demandScore: 2, sellers: 30, scannedAt: new Date() },
  sales: { count: 0, revenue: 0, avgPrice: 0 },
  af: { maxPerGame: 30 },
  probeAllowed: true,
  probeBudgetBlocked: false,
  marketStockFloor: 6,
});

// A verdict in the shape decide.js produces for each skip.
function skipVerdict(game, campaignId, decision, extra = {}) {
  return {
    game,
    campaignId,
    campaignName: "Weekly",
    campaignEndAt: hoursFromNow(48),
    decision,
    wouldFarm: false,
    plannedAccounts: 0,
    targetAccounts: 0,
    demandScore: 90,
    effectiveDemand: 90,
    hadResearch: true,
    internalSales: 3,
    reason: `reason for ${decision}`,
    decisionInputs: snapshot(),
    ...extra,
  };
}

const coverage = { manualFarmers: 0, archiveHolders: 31, stashHolders: 2, otherHolders: 5 };

async function liveLane(game) {
  const gameKey = settings.normGameName(game);
  await FarmLane.deleteMany({ gameKey });
  return (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();
}

async function campaign(game, campaignId) {
  await TwitchCampaign.deleteMany({ campaignId });
  await TwitchCampaign.create({
    campaignId,
    name: "Weekly",
    game,
    status: "ACTIVE",
    active: true,
    endAt: hoursFromNow(48),
  });
}

async function research(game, demandScore) {
  await MarketResearch.deleteMany({ game });
  // Fresh, so a LIVE lane's freshResearchForGame does not try a market re-scan.
  await MarketResearch.create({ game, demandScore, sellers: 20, scannedAt: new Date() });
}

/* -------------------------------- the mapping ----------------------------- */

test("the mapping is the identity on decision, and every lane skip has a legacy equivalent", () => {
  const skips = classes.LEGACY_DECISIONS.filter((d) => classes.actionClass(d) === "skip");
  assert.equal(skips.length, 8);
  for (const d of skips) {
    assert.ok(classes.LANE_DECISIONS.includes(d), `${d} is a lane decision`);
    const f = executeStep.legacySkipFields(skipVerdict("G", "c", d, { coverage }), af());
    assert.equal(f.decision, d, "identity on decision");
    assert.equal(f.status, "skipped", "the one status no sweep acts on");
    assert.equal(f.rescanRequested, false);
    assert.equal(f.decisionInputs.version, 1, "carries the snapshot like every lane row");
  }
  assert.throws(() => executeStep.legacySkipFields(skipVerdict("G", "c", "farm"), af()), /not a skip/);
});

test("the sellability skips record EFFECTIVE demand; every other skip records the raw score", () => {
  // Legacy: `demandScore: alloc.demand` on skip_low_demand / skip_probe_budget,
  // `demandScore` (raw) everywhere else (§5.1). An unscanned game that skips
  // has raw null and effective 0 — the two must not be confused.
  const noResearch = { demandScore: null, effectiveDemand: 0, hadResearch: false };
  assert.equal(executeStep.legacySkipFields(skipVerdict("G", "c", "skip_low_demand", noResearch), af()).demandScore, 0);
  assert.equal(executeStep.legacySkipFields(skipVerdict("G", "c", "skip_probe_budget", noResearch), af()).demandScore, 0);
  assert.equal(executeStep.legacySkipFields(skipVerdict("G", "c", "skip_ends_soon", { demandScore: 90, effectiveDemand: 97 }), af()).demandScore, 90);
  assert.equal(executeStep.legacySkipFields(skipVerdict("G", "c", "skip_host_offline", { demandScore: 90, effectiveDemand: 97 }), af()).demandScore, 90);
});

test("per-decision fields match the record() call legacy makes", () => {
  const a = af({ dryRun: true });
  const low = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_low_demand"), a);
  assert.equal("coverage" in low, false, "sellability skip writes no coverage");
  assert.equal("plannedAccounts" in low, false);
  assert.equal("targetAccounts" in low, false);
  assert.equal(low.dryRun, true, "base carries af.dryRun");

  const offline = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_host_offline"), a);
  assert.equal("coverage" in offline, false);
  assert.equal(offline.internalSales, 3, "written since commit 7");

  const covered = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_already_covered", { coverage, targetAccounts: 30 }), a);
  assert.deepEqual(covered.coverage, coverage);
  assert.equal("plannedAccounts" in covered, false);
  assert.equal("targetAccounts" in covered, false, "legacy does not write targetAccounts on this skip");

  const noAcc = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_no_accounts", { coverage, targetAccounts: 30 }), a);
  assert.deepEqual(noAcc.coverage, coverage);
  assert.equal(noAcc.plannedAccounts, 0);
  assert.equal("targetAccounts" in noAcc, false);

  const noCap = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_no_capacity", { coverage, plannedAccounts: 12, targetAccounts: 30 }), a);
  assert.deepEqual(noCap.coverage, coverage);
  assert.equal(noCap.plannedAccounts, 12, "the target it could not seat, as legacy records");
  assert.equal("targetAccounts" in noCap, false);

  const reuseOnly = executeStep.legacySkipFields(skipVerdict("G", "c", "skip_reuse_only", { coverage, targetAccounts: 30 }), a);
  assert.deepEqual(reuseOnly.coverage, coverage);
  assert.equal(reuseOnly.plannedAccounts, 0);
  assert.equal(reuseOnly.targetAccounts, 30, "the farm record's `wanted`, which the claim-time rewrite keeps");
  assert.ok(reuseOnly.executedAt instanceof Date, "the claim-time rewrite stamps executedAt");
  assert.equal(reuseOnly.dryRun, false, "the claim-time rewrite sets dryRun false");
});

/* --------------------------------- the guard ------------------------------ */

const lane = { game: "Guard Game", gameKey: "guard game", mode: "live" };

test("a skip never overwrites a row that owns something", async () => {
  const game = "Guard Game";
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.create({
    game,
    campaignId: "g1",
    decision: "farm",
    status: "active",
    assignedAccounts: ["a1", "a2"],
    bots: [{ host: "pi", file: "config_1.json", container: "bot1" }],
    executedAt: new Date(),
  });
  const r = await executeStep.recordSkip({ verdict: skipVerdict(game, "g1", "skip_low_demand"), lane, af: af(), shadow: false });
  assert.equal(r.written, false);
  assert.match(r.suppressed, /row is active/);
  const row = await AutoFarmTask.findOne({ game, campaignId: "g1" }).lean();
  assert.equal(row.status, "active", "untouched");
  assert.equal(row.decision, "farm");
  assert.deepEqual(row.assignedAccounts, ["a1", "a2"]);

  for (const status of ["planned", "completed", "stopped", "failed"]) {
    await AutoFarmTask.deleteMany({ game, campaignId: "g-" + status });
    await AutoFarmTask.create({ game, campaignId: "g-" + status, decision: "farm", status });
    const rr = await executeStep.recordSkip({ verdict: skipVerdict(game, "g-" + status, "skip_low_demand"), lane, af: af(), shadow: false });
    assert.equal(rr.written, false, `${status} is never overwritten`);
    assert.equal((await AutoFarmTask.findOne({ game, campaignId: "g-" + status }).lean()).status, status);
  }
});

test("an absent row is written; a skipped row is rewritten on re-decision, with a fresh snapshot", async () => {
  const game = "Guard Game";
  await AutoFarmTask.deleteMany({ game, campaignId: "g2" });
  const first = await executeStep.recordSkip({
    verdict: skipVerdict(game, "g2", "skip_no_capacity", { coverage, plannedAccounts: 12 }),
    lane,
    af: af(),
    shadow: false,
  });
  assert.equal(first.written, true);
  assert.equal(first.previous, null);
  const before = await AutoFarmTask.findOne({ game, campaignId: "g2" }).lean();
  assert.equal(before.decision, "skip_no_capacity");
  assert.equal(before.plannedAccounts, 12);

  await new Promise((r) => setTimeout(r, 5));
  const second = await executeStep.recordSkip({ verdict: skipVerdict(game, "g2", "skip_low_demand"), lane, af: af(), shadow: false });
  assert.equal(second.written, true);
  assert.equal(second.previous, "skip_no_capacity", "the transition is reported");
  const after = await AutoFarmTask.findOne({ game, campaignId: "g2" }).lean();
  assert.equal(after.decision, "skip_low_demand");
  assert.equal(after.status, "skipped");
  assert.ok(after.decidedAt > before.decidedAt, "decidedAt follows the re-decision, as legacy's does for retryable skips");
  assert.equal(await AutoFarmTask.countDocuments({ game, campaignId: "g2" }), 1, "still one row");
});

test("skip_reuse_only: nothing under af.dryRun, the claim-time end state when live", async () => {
  const game = "Guard Game";
  await AutoFarmTask.deleteMany({ game, campaignId: "g3" });
  const v = skipVerdict(game, "g3", "skip_reuse_only", { coverage, targetAccounts: 30 });
  const dry = await executeStep.recordSkip({ verdict: v, lane, af: af({ dryRun: true }), shadow: false });
  assert.equal(dry.written, false);
  assert.match(dry.suppressed, /no legacy row corresponds/);
  assert.equal(await AutoFarmTask.countDocuments({ game, campaignId: "g3" }), 0);

  const live = await executeStep.recordSkip({ verdict: v, lane, af: af({ dryRun: false }), shadow: false });
  assert.equal(live.written, true);
  const row = await AutoFarmTask.findOne({ game, campaignId: "g3" }).lean();
  assert.equal(row.decision, "skip_reuse_only");
  assert.equal(row.status, "skipped");
  assert.equal(row.plannedAccounts, 0);
  assert.equal(row.targetAccounts, 30);
  assert.equal(row.dryRun, false);
  assert.ok(row.executedAt);
  assert.deepEqual(row.coverage, coverage);
});

test("recordSkip refuses a shadow lane, and a non-live lane", async () => {
  await assert.rejects(
    () => executeStep.recordSkip({ verdict: skipVerdict("G", "c", "skip_low_demand"), lane, af: af(), shadow: true }),
    /shadow lane/,
  );
  await assert.rejects(
    () => executeStep.recordSkip({ verdict: skipVerdict("G", "c", "skip_low_demand"), lane: { ...lane, mode: "shadow" }, af: af(), shadow: false }),
    /only a live lane/,
  );
});

/* ------------------------------- end to end ------------------------------- */

test("END TO END: a live lane's sellability skip lands in AutoFarmTask exactly as legacy would write it", async () => {
  const game = "E2E Low Demand Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  await research(game, 2); // below the floor with 20 sellers: a plain skip_low_demand
  await campaign(game, "e2e-low");
  const l = await liveLane(game);

  const summary = await laneMod.runLane(l, { cycle: null, af: af(), hostCache: new Map() });
  assert.deepEqual(summary.errors, [], summary.errors.join("; "));
  assert.equal(summary.decisions.length, 1);
  assert.equal(summary.decisions[0].decision, "skip_low_demand");
  assert.equal(summary.skipsRecorded, 1);
  assert.equal(summary.skipsSuppressed, 0);

  const row = await AutoFarmTask.findOne({ game, campaignId: "e2e-low" }).lean();
  assert.ok(row, "the skip is now a row");
  assert.equal(row.decision, "skip_low_demand");
  assert.equal(row.status, "skipped");
  assert.equal(row.demandScore, 2, "effective demand — equals the raw score with no own sales");
  assert.equal(row.hadResearch, true);
  assert.equal(row.internalSales, 0);
  assert.equal(row.dryRun, false);
  assert.equal(row.rescanRequested, false);
  assert.equal(row.decisionInputs.version, 1, "replay can read it without reconstructing");
  assert.equal(row.decisionInputs.research.demandScore, 2);
  assert.equal("coverage" in row === false || row.coverage == null || row.coverage.archiveHolders === 0, true);

  // The FarmJob record is unchanged — the row is in addition to it, not instead.
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "decide", status: "done" }), 1);
});

test("END TO END: with no farm host configured, a live lane writes skip_host_offline — as legacy does", async () => {
  const game = "E2E Offline Game";
  await AutoFarmTask.deleteMany({ game });
  await research(game, 90); // passes sellability, stops at the host gate
  await campaign(game, "e2e-off");
  const l = await liveLane(game);

  const summary = await laneMod.runLane(l, { cycle: null, af: af({ hostId: "does-not-exist-xyz" }), hostCache: new Map() });
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.decisions[0].decision, "skip_host_offline");
  assert.equal(summary.skipsRecorded, 1);
  const row = await AutoFarmTask.findOne({ game, campaignId: "e2e-off" }).lean();
  assert.equal(row.decision, "skip_host_offline");
  assert.equal(row.status, "skipped");
  assert.equal(row.demandScore, 90, "raw score on every non-sellability skip");
  assert.equal(row.internalSales, 0, "written since commit 7");
  assert.equal(row.decisionInputs.version, 1);
});

test("END TO END: the next cycle re-decides and rewrites the row — the retry state now lives where legacy's does", async () => {
  const game = "E2E Retry Game";
  await AutoFarmTask.deleteMany({ game });
  await research(game, 90);
  await campaign(game, "e2e-retry");
  const l = await liveLane(game);
  const a = af({ hostId: "does-not-exist-xyz" });

  await laneMod.runLane(l, { cycle: null, af: a, hostCache: new Map() });
  const first = await AutoFarmTask.findOne({ game, campaignId: "e2e-retry" }).lean();
  await new Promise((r) => setTimeout(r, 5));
  const again = await FarmLane.findById(l._id).lean();
  const s2 = await laneMod.runLane(again, { cycle: null, af: a, hostCache: new Map() });
  assert.equal(s2.skipsRecorded, 1);
  const second = await AutoFarmTask.findOne({ game, campaignId: "e2e-retry" }).lean();
  assert.equal(await AutoFarmTask.countDocuments({ game, campaignId: "e2e-retry" }), 1, "one row, rewritten");
  assert.ok(second.decidedAt > first.decidedAt);
  assert.ok(second.decisionInputs.at > first.decisionInputs.at, "a fresh snapshot each cycle");
});

test("END TO END: a SHADOW lane writes nothing — the legacy engine owns its rows", async () => {
  const game = "E2E Shadow Game";
  await AutoFarmTask.deleteMany({ game });
  await research(game, 2);
  await campaign(game, "e2e-shadow");
  const gameKey = settings.normGameName(game);
  await FarmLane.deleteMany({ gameKey });
  const l = (await FarmLane.create({ game, gameKey, mode: "shadow", state: "idle" })).toObject();

  const summary = await laneMod.runLane(l, { cycle: null, af: af(), hostCache: new Map() });
  assert.equal(summary.decisions[0].decision, "skip_low_demand");
  assert.equal(summary.skipsRecorded, 0);
  assert.equal(await AutoFarmTask.countDocuments({ game }), 0, "no row: shadow changes nothing");
});

test("END TO END: a live lane leaves an ACTIVE task alone — settled, never re-decided, never clobbered", async () => {
  // An active task is a campaign the engine has acted on. The legacy tick never
  // re-decides one; the lane's candidate filter now agrees, so the skip that
  // used to be decided-then-suppressed is simply never decided. The guard
  // inside recordSkip is still pinned directly above ("a skip never overwrites
  // a row that owns something") for the paths that can still reach it.
  const game = "E2E Active Game";
  await AutoFarmTask.deleteMany({ game });
  await research(game, 90);
  await campaign(game, "e2e-active");
  await AutoFarmTask.create({
    game,
    campaignId: "e2e-active",
    decision: "farm",
    status: "active",
    assignedAccounts: ["x1"],
    bots: [{ host: "pi", file: "config_2.json", container: "bot2" }],
    executedAt: new Date(),
  });
  const l = await liveLane(game);
  const summary = await laneMod.runLane(l, { cycle: null, af: af({ hostId: "does-not-exist-xyz" }), hostCache: new Map() });
  assert.equal(summary.campaigns, 1);
  assert.equal(summary.settled, 1);
  assert.equal(summary.decisions.length, 0, "an active campaign is not re-decided");
  assert.equal(summary.skipsRecorded, 0);
  assert.equal(summary.skipsSuppressed, 0);
  const row = await AutoFarmTask.findOne({ game, campaignId: "e2e-active" }).lean();
  assert.equal(row.status, "active", "the running task is untouched");
  assert.deepEqual(row.assignedAccounts, ["x1"]);
});
