// Coverage for the recorded decision inputs (utils/decisionInputs.js): the
// snapshot every legacy record() call now writes, the lane's copy of it, and
// replay's preference for it over reconstruction.
//
// Replay exists because the inputs a decision saw were not recorded, so they
// had to be rebuilt after the fact — and every rebuild has a hole: research
// snapshots expire, a sale since the decision loses the price, the probe budget
// can only be inferred, and yesterday's decision was replayed under today's
// settings. Recording the inputs closes all four for every row written since.
// These tests pin three things:
//
//   1. the real legacy record() writes a recognised snapshot (driven through
//      processCampaign itself on the two branches that need no host)
//   2. the lane writes the same shape, so its rows replay like any other
//   3. replay uses a recognised snapshot and NOTHING else; an unknown version
//      or no snapshot at all means reconstruct, never assume
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const MarketResearch = require("../models/MarketResearch");
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const SaleSignal = require("../models/SaleSignal");
const FarmJob = require("../models/FarmJob");
const inputsMod = require("../utils/decisionInputs");
const autoFarmer = require("../utils/autoFarmer");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const replay = require("../utils/farm2/replay");
const { BudgetCycle } = require("../utils/farm2/budget");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2inputs"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

// Cold-start probing OFF (the probe gate is inert), dry-run ON so nothing the
// legacy engine reaches could ever spend.
function af(overrides = {}) {
  return {
    ...settings.getAutoFarm(),
    probeColdStart: false,
    dryRun: true,
    minHoursLeft: 12,
    maxPerGame: 30,
    accountsPerBot: 10,
    maxAutoBots: 20,
    poolReserve: 20,
    platiCategoryId: "",
    forceGames: [],
    ...overrides,
  };
}

async function reset(game) {
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    MarketResearch.deleteMany({ game }),
    MarketResearchSnapshot.deleteMany({ gameKey: game.toLowerCase() }),
    SaleSignal.deleteMany({ gameKey: game.toLowerCase() }),
  ]);
}

/* ------------------------------- the shape -------------------------------- */

test("the snapshot carries version 1 and everything demandAllocation reads", () => {
  const scanned = new Date("2026-09-01T00:00:00Z");
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 3.7, sellers: 10, scannedAt: scanned, extra: "ignored" },
    sales: { count: 13, revenue: 22.75, avgPrice: 1.75 },
    af: af({ maxPerGame: 30, probeColdStart: true }),
    probeAllowed: false,
    probeBudgetBlocked: true,
    floor: 6,
  });
  assert.equal(di.version, inputsMod.DECISION_INPUTS_VERSION);
  assert.equal(di.version, 1);
  assert.deepEqual(di.research, { demandScore: 3.7, sellers: 10, scannedAt: scanned });
  assert.deepEqual(di.sales, { count: 13, revenue: 22.75, avgPrice: 1.75 });
  for (const k of inputsMod.AF_FIELDS) assert.ok(k in di.af, `af.${k} recorded`);
  assert.equal(di.af.maxPerGame, 30);
  assert.equal(di.af.probeColdStart, true);
  assert.equal(di.probeAllowed, false);
  assert.equal(di.probeBudgetBlocked, true);
  assert.equal(di.marketStockFloor, 6);
  assert.ok(di.at instanceof Date);
  assert.equal(inputsMod.isRecordedInputs(di), true);
});

test("no research is recorded as null; an unscanned document is NOT collapsed to null", () => {
  // demandAllocation treats both as no-market-data, but they are different
  // facts and the snapshot keeps them apart.
  const none = inputsMod.buildDecisionInputs({
    research: null,
    sales: { count: 0 },
    af: af(),
    probeAllowed: true,
    floor: 0,
  });
  assert.equal(none.research, null);
  const unscanned = inputsMod.buildDecisionInputs({
    research: { demandScore: 0, sellers: 0, scannedAt: null },
    sales: { count: 0 },
    af: af(),
    probeAllowed: true,
    floor: 0,
  });
  assert.deepEqual(unscanned.research, { demandScore: 0, sellers: 0, scannedAt: null });
});

test("the recogniser accepts only the version it knows — absence is never a passing value", () => {
  const good = inputsMod.buildDecisionInputs({
    research: null,
    sales: { count: 0 },
    af: af(),
    probeAllowed: true,
    floor: 0,
  });
  assert.equal(inputsMod.isRecordedInputs(good), true);
  assert.equal(inputsMod.isRecordedInputs(undefined), false);
  assert.equal(inputsMod.isRecordedInputs(null), false);
  assert.equal(inputsMod.isRecordedInputs({}), false);
  assert.equal(inputsMod.isRecordedInputs({ ...good, version: 2 }), false, "a later version is not understood");
  assert.equal(inputsMod.isRecordedInputs({ ...good, version: undefined }), false);
  assert.equal(inputsMod.isRecordedInputs({ ...good, sales: null }), false);
  assert.equal(inputsMod.isRecordedInputs({ ...good, af: null }), false);
  assert.equal(inputsMod.isRecordedInputs({ ...good, probeAllowed: "yes" }), false);
});

/* -------------------------------- the model ------------------------------- */

test("AutoFarmTask keeps the sub-document — Mongoose strict mode would silently drop an undeclared path", async () => {
  const game = "Model Round Trip";
  await reset(game);
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 42, sellers: 3, scannedAt: hoursAgo(2) },
    sales: { count: 2, revenue: 10, avgPrice: 5 },
    af: af(),
    probeAllowed: true,
    probeBudgetBlocked: false,
    floor: 6,
  });
  await AutoFarmTask.findOneAndUpdate(
    { game, campaignId: "m1" },
    {
      $set: {
        game,
        campaignId: "m1",
        decision: "farm",
        status: "planned",
        decisionInputs: di,
        decidedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const row = await AutoFarmTask.findOne({ game, campaignId: "m1" }).lean();
  assert.ok(row.decisionInputs, "the sub-document survived the $set");
  assert.equal(row.decisionInputs.version, 1);
  assert.equal(row.decisionInputs.research.demandScore, 42);
  assert.equal(row.decisionInputs.research.sellers, 3);
  assert.equal(row.decisionInputs.sales.count, 2);
  assert.equal(row.decisionInputs.sales.avgPrice, 5);
  assert.equal(row.decisionInputs.af.maxPerGame, 30);
  assert.equal(row.decisionInputs.probeAllowed, true);
  assert.equal(row.decisionInputs.marketStockFloor, 6);
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true, "and reads back as recognised");
});

/* ----------------------------- the legacy path ---------------------------- */

// processCampaign(c, ctx) is the legacy per-campaign decision. Two of its
// branches need no host at all: the sellability skip returns before the host
// gate, and the host gate itself fires on hostOnline: false. Both go through
// the REAL record(), so these exercise the actual hunk rather than a stand-in.
// infoMap is supplied so the engine never reaches for a live market scan.
function legacyCtx({ campaignId, research, sales, hostOnline = false, afOverrides = {} }) {
  return {
    af: af(afOverrides),
    host: null,
    hostOnline,
    budgetMap: new Map(),
    infoMap: new Map([[campaignId, { research, sales }]]),
    priorTasks: new Map(),
  };
}

test("LEGACY record(): the sellability skip writes a recognised snapshot of what it saw", async () => {
  const game = "Legacy Skip Game";
  await reset(game);
  const research = { demandScore: 3, sellers: 20, scannedAt: hoursAgo(1) };
  const sales = { count: 0, revenue: 0, avgPrice: 0 };
  const c = { game, campaignId: "ls1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(c, legacyCtx({ campaignId: "ls1", research, sales }));
  assert.equal(r.decision, "skip_low_demand");
  const row = await AutoFarmTask.findOne({ game, campaignId: "ls1" }).lean();
  assert.equal(row.decision, "skip_low_demand");
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true, "snapshot present and recognised");
  assert.equal(row.decisionInputs.research.demandScore, 3);
  assert.equal(row.decisionInputs.research.sellers, 20);
  assert.equal(row.decisionInputs.sales.count, 0);
  assert.equal(row.decisionInputs.af.maxPerGame, 30);
  assert.equal(row.decisionInputs.af.probeColdStart, false);
  assert.equal(row.decisionInputs.probeAllowed, true, "cold-start off: the gate is inert");
});

test("LEGACY record(): skip_host_offline — a path that never wrote internalSales — carries the snapshot with the real sales", async () => {
  const game = "Legacy Offline Game";
  await reset(game);
  const research = { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) };
  const sales = { count: 7, revenue: 35, avgPrice: 5 };
  const c = { game, campaignId: "lo1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    legacyCtx({ campaignId: "lo1", research, sales, hostOnline: false }),
  );
  assert.equal(r.decision, "skip_host_offline");
  const row = await AutoFarmTask.findOne({ game, campaignId: "lo1" }).lean();
  assert.equal(row.decision, "skip_host_offline");
  // The Black Desert lesson: this path's flat fields cannot be trusted, but the
  // snapshot carries what the gate actually saw.
  assert.equal(row.decisionInputs.sales.count, 7);
  assert.equal(row.decisionInputs.sales.avgPrice, 5);
  assert.equal(row.decisionInputs.research.demandScore, 90);
  assert.ok(row.decisionInputs.marketStockFloor > 0, "a non-probe records the real market floor");
});

test("LEGACY record(): a re-decided row gets a FRESH snapshot, not the old one", async () => {
  // Retryable skips are re-decided every tick and record() is a $set upsert.
  // The snapshot must move with the decision, or a re-decided row would carry
  // the inputs of a decision it no longer represents.
  const game = "Legacy Redecide Game";
  await reset(game);
  const c = { game, campaignId: "rd1", name: "Weekly", endAt: hoursFromNow(48) };
  await autoFarmer.processCampaign(
    c,
    legacyCtx({
      campaignId: "rd1",
      research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(2) },
      sales: { count: 1, revenue: 2, avgPrice: 2 },
      hostOnline: false,
    }),
  );
  const first = await AutoFarmTask.findOne({ game, campaignId: "rd1" }).lean();
  assert.equal(first.decisionInputs.sales.count, 1);
  await autoFarmer.processCampaign(
    c,
    legacyCtx({
      campaignId: "rd1",
      research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) },
      sales: { count: 4, revenue: 8, avgPrice: 2 },
      hostOnline: false,
    }),
  );
  const second = await AutoFarmTask.findOne({ game, campaignId: "rd1" }).lean();
  assert.equal(second.decisionInputs.sales.count, 4, "the snapshot followed the re-decision");
  assert.ok(second.decisionInputs.at > first.decisionInputs.at);
});

test("LEGACY record(): the dry-run reuse path — the Black Desert path — carries the snapshot with the real sales", async () => {
  // reuse_existing is the other path whose record() never wrote internalSales.
  // Reachable without a host: the reusable task comes from ctx.reusableMap, the
  // bot-file existence check is answered by ctx.hostState.hasFile, and dryRun
  // records the plan instead of restarting anything.
  const game = "Legacy Reuse Game";
  await reset(game);
  const reusable = {
    _id: new mongoose.Types.ObjectId(),
    game,
    campaignId: "old",
    status: "completed",
    assignedAccounts: ["a1", "a2", "a3"],
    bots: [{ host: "local", file: "config_7.json", container: "bot7" }],
  };
  const ctx = legacyCtx({
    campaignId: "lr1",
    research: { demandScore: 3.7, sellers: 10, scannedAt: hoursAgo(1) },
    sales: { count: 13, revenue: 22.75, avgPrice: 1.75 },
    hostOnline: true,
  });
  ctx.host = { id: "local", label: "Server" };
  ctx.reusableMap = new Map([[game, reusable]]);
  ctx.hostState = { hasFile: () => true, activateBot() {} };
  const c = { game, campaignId: "lr1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(c, ctx);
  assert.equal(r.decision, "reuse_existing");
  assert.equal(r.dryRun, true, "nothing was restarted");
  const row = await AutoFarmTask.findOne({ game, campaignId: "lr1" }).lean();
  assert.equal(row.decision, "reuse_existing");
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true);
  assert.equal(row.decisionInputs.sales.count, 13, "the thirteen sales the gate saw are on the row");
  assert.equal(row.decisionInputs.sales.avgPrice, 1.75);
  assert.equal(row.decisionInputs.research.demandScore, 3.7);
});

/* ------------------------------- the lane path ---------------------------- */

const laneCtx = () => ({
  host: { id: "pi", label: "Pi" },
  hostOnline: true,
  farmMap: { map: new Map(), wildcard: new Set(), logins: new Set() },
  owned: new Set(),
  archiveHolders: new Map(),
});

test("LANE: the verdict carries the same snapshot, and upsertTask persists it", async () => {
  const game = "Lane Inputs Game";
  await reset(game);
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  const cycle = new BudgetCycle({ accounts: 30, seats: 30, containers: 3, perGameCap: 30 });
  cycle.allocate([{ key: game.toLowerCase(), want: 30, weight: 1 }]);
  const verdict = await decideStep.decideCampaign({
    campaign: { game, campaignId: "li1", name: "Weekly", endAt: hoursFromNow(48) },
    lane: { game, gameKey: game.toLowerCase(), mode: "shadow" },
    cycle,
    af: af(),
    shadow: true,
    hostCache: new Map(),
    ctx: laneCtx(),
  });
  assert.equal(verdict.decision, "farm");
  assert.equal(inputsMod.isRecordedInputs(verdict.decisionInputs), true, "a recognised snapshot rides on the verdict");
  assert.equal(verdict.decisionInputs.research.demandScore, 90);
  assert.ok(verdict.decisionInputs.marketStockFloor > 0);

  const task = await executeStep.upsertTask(verdict, { dryRun: true });
  const row = await AutoFarmTask.findById(task._id).lean();
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true, "persisted exactly as legacy record() does");
  assert.equal(row.decisionInputs.research.demandScore, 90);
});

test("LANE: a skip verdict carries the snapshot too — every verdict does", async () => {
  const game = "Lane Skip Inputs";
  await reset(game);
  await MarketResearch.create({ game, demandScore: 2, sellers: 30, scannedAt: new Date() });
  const v = await decideStep.decideCampaign({
    campaign: { game, campaignId: "lsk1", endAt: hoursFromNow(48) },
    lane: { game, gameKey: game.toLowerCase(), mode: "shadow" },
    cycle: null,
    af: af(),
    shadow: true,
    hostCache: new Map(),
  });
  assert.equal(v.decision, "skip_low_demand");
  assert.equal(inputsMod.isRecordedInputs(v.decisionInputs), true);
  assert.equal(v.decisionInputs.research.demandScore, 2);
});

test("LANE: executeReuse persists the snapshot on a dry-run reuse", async () => {
  const game = "Reuse Inputs Game";
  await reset(game);
  const source = await AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "active",
    assignedAccounts: ["a1", "a2"],
    bots: [{ host: "pi", file: "config_1.json", container: "bot1" }],
  });
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 50, sellers: 2, scannedAt: hoursAgo(1) },
    sales: { count: 1, revenue: 3, avgPrice: 3 },
    af: af(),
    probeAllowed: true,
    floor: 6,
  });
  const r = await executeStep.executeReuse({
    verdict: {
      game,
      campaignId: "new",
      decision: "reuse_existing",
      reuseTaskId: source._id,
      reason: "recurring",
      decisionInputs: di,
    },
    dryRun: true,
  });
  assert.equal(r.dryRun, true);
  const row = await AutoFarmTask.findOne({ game, campaignId: "new" }).lean();
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true);
  assert.equal(row.decisionInputs.sales.count, 1);
});

/* --------------------------------- replay --------------------------------- */

test("REPLAY: a row with a recorded snapshot is exact from the snapshot alone — no research snapshot, no SaleSignal", async () => {
  const game = "Recorded Replay Game";
  await reset(game);
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 4, sellers: 25, scannedAt: hoursAgo(31) },
    sales: { count: 0, revenue: 0, avgPrice: 0 },
    af: af(),
    probeAllowed: true,
    probeBudgetBlocked: false,
    floor: 6,
  });
  const task = {
    game,
    campaignId: "rr1",
    decision: "skip_low_demand",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  };
  const out = await replay.replayDecision(task, { af: af() });
  assert.equal(out.inputsBasis, "recorded");
  assert.equal(out.inputsVersion, 1);
  assert.equal(out.salesBasis, "recorded");
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.deepEqual(out.gaps, []);
  assert.equal(out.verdict, "agree", out.detail);
});

test("REPLAY: the recorded settings win over today's — the settings-versioning hole closed for recorded rows", async () => {
  // Decided under maxPerGame 30 (tier target 30). Today maxPerGame is 10. A
  // reconstruction rebuilds `wanted` as 10 and calls the recorded 30 a
  // disagreement; the snapshot replays under the settings then in force.
  const game = "Settings Drift Game";
  await reset(game);
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(31) },
    sales: { count: 0, revenue: 0, avgPrice: 0 },
    af: af({ maxPerGame: 30 }),
    probeAllowed: true,
    probeBudgetBlocked: false,
    floor: 6,
  });
  const task = {
    game,
    campaignId: "sd1",
    decision: "farm",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 30,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  };
  const today = af({ maxPerGame: 10 });
  const withSnapshot = await replay.replayDecision(task, { af: today });
  assert.equal(withSnapshot.inputsBasis, "recorded");
  assert.equal(withSnapshot.verdict, "agree", withSnapshot.detail);
  assert.equal(withSnapshot.replayedWanted, 30, "the tier target is rebuilt under the recorded maxPerGame");

  // Control: the same row WITHOUT its snapshot, reconstructed under today's
  // settings — the hole the snapshot exists to close.
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: hoursAgo(31),
    demandScore: 90,
    sellers: 5,
  });
  const bare = { ...task };
  delete bare.decisionInputs;
  const reconstructed = await replay.replayDecision(bare, { af: today });
  assert.equal(reconstructed.inputsBasis, "reconstructed");
  assert.equal(reconstructed.verdict, "disagree", "today's cap applied to yesterday's decision");
  assert.equal(reconstructed.kind, "tier_target");
});

test("REPLAY: a reuse row with a snapshot is exact although its sales window has moved — the reuse-row cost recovered", async () => {
  const game = "Recovered Reuse Game";
  await reset(game);
  // A sale since the decision: reconstruction would be unreplayable here.
  await SaleSignal.create({
    game,
    gameKey: game.toLowerCase(),
    source: "listing_sold",
    dedupeKey: `${game}-late`,
    account: null,
    priceUsd: 1.75,
    at: hoursAgo(1),
  });
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 3.7, sellers: 10, scannedAt: hoursAgo(31) },
    sales: { count: 13, revenue: 22.75, avgPrice: 1.75 },
    af: af(),
    probeAllowed: true,
    probeBudgetBlocked: false,
    floor: 6,
  });
  const task = {
    game,
    campaignId: "rc1",
    decision: "reuse_existing",
    demandScore: 3.7,
    hadResearch: true,
    internalSales: 0,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  };
  const out = await replay.replayDecision(task, { af: af() });
  assert.equal(out.inputsBasis, "recorded");
  assert.equal(out.salesCount, 13);
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.equal(out.verdict, "agree", out.detail);
});

test("REPLAY: with cold-start ON, a recorded probeAllowed makes the probe row exact — no sensitivity check needed", async () => {
  const game = "Recorded Probe Game";
  await reset(game);
  const cold = af({ probeColdStart: true, probeMaxSellers: 1 });
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 4, sellers: 0, scannedAt: hoursAgo(31) },
    sales: { count: 0 },
    af: cold,
    probeAllowed: true,
    probeBudgetBlocked: false,
    floor: 0,
  });
  const task = {
    game,
    campaignId: "rp1",
    decision: "probe",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 5,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  };
  const out = await replay.replayDecision(task, { af: cold });
  assert.equal(out.inputsBasis, "recorded");
  assert.equal(out.fidelity, replay.FIDELITY.EXACT, "the budget is known, not inferred");
  assert.equal(out.probeGateMatters, null, "no sensitivity check was needed");
  assert.equal(out.verdict, "agree", out.detail);
});

test("REPLAY: a snapshot of an unknown version is reconstructed, never trusted, and says so", async () => {
  const game = "Future Version Game";
  await reset(game);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: hoursAgo(31),
    demandScore: 4,
    sellers: 25,
  });
  // A v99 snapshot claiming demand 99. If it were trusted the replay would
  // want to farm and call the recorded skip a disagreement.
  const di = {
    ...inputsMod.buildDecisionInputs({
      research: { demandScore: 99, sellers: 0, scannedAt: hoursAgo(31) },
      sales: { count: 0 },
      af: af(),
      probeAllowed: true,
      floor: 0,
    }),
    version: 99,
  };
  const task = {
    game,
    campaignId: "fv1",
    decision: "skip_low_demand",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  };
  const out = await replay.replayDecision(task, { af: af() });
  assert.equal(out.inputsBasis, "reconstructed", "the v99 snapshot was NOT used");
  assert.ok(out.gaps.includes("decision_inputs_version_unknown"));
  assert.match(out.notes.join(" "), /version 99/);
  assert.equal(out.verdict, "agree", "reconstruction from the real research (demand 4) agrees with the recorded skip");
});

test("REPLAY: a row with no snapshot behaves exactly as before", async () => {
  const game = "Old Row Game";
  await reset(game);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: hoursAgo(31),
    demandScore: 4,
    sellers: 25,
  });
  const task = {
    game,
    campaignId: "or1",
    decision: "skip_low_demand",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    decidedAt: hoursAgo(30),
  };
  const out = await replay.replayDecision(task, { af: af() });
  assert.equal(out.inputsBasis, "reconstructed");
  assert.equal(out.inputsVersion, null);
  assert.ok(!out.gaps.includes("decision_inputs_version_unknown"), "absence is not an unknown version");
  assert.equal(out.verdict, "agree", out.detail);
});

test("REPLAY: the summary reports how many rows came from snapshots", () => {
  const s = replay.summarise([
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.EXACT, inputsBasis: "recorded" },
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.EXACT, inputsBasis: "recorded" },
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.EXACT, inputsBasis: "reconstructed" },
    {
      game: "G",
      verdict: "unreplayable",
      fidelity: replay.FIDELITY.UNREPLAYABLE,
      inputsBasis: "reconstructed",
      gaps: [],
    },
  ]);
  assert.deepEqual(s.inputsBasis, { recorded: 2, reconstructed: 2 });
});

test("REPLAY: replayHistory selects the snapshot off the row", async () => {
  const game = "History Inputs Game";
  await reset(game);
  const di = inputsMod.buildDecisionInputs({
    research: { demandScore: 3, sellers: 30, scannedAt: hoursAgo(31) },
    sales: { count: 0 },
    af: af(),
    probeAllowed: true,
    floor: 0,
  });
  await AutoFarmTask.create({
    game,
    campaignId: "hi1",
    decision: "skip_low_demand",
    status: "skipped",
    demandScore: 3,
    hadResearch: true,
    internalSales: 0,
    decidedAt: hoursAgo(30),
    decisionInputs: di,
  });
  const report = await replay.replayHistory({ game, af: af() });
  assert.equal(report.examined, 1);
  assert.equal(report.inputsBasis.recorded, 1);
  assert.equal(report.scored, 1);
  assert.equal(report.agree, 1);
});
