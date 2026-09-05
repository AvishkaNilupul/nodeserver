// The recorded REUSE inputs (utils/decisionInputs.js buildReuseInputs): which
// warm task a reuse_existing decision counted on, how many accounts it held,
// how many another live task spoke for, and so how many were free.
//
// Why they exist: the shadow comparison scored a lane's reuse count against the
// legacy row's plannedAccounts, and production (2026-09-05) showed that field
// is not a usable input — never written on the skip paths (a leftover), 0 by
// construction on a dry-run reuse, and undated even when it is the honest
// mine.length. The recorded `free` is the count at the moment of the decision,
// `sourceTaskId` says what it was counted on and `competitors` who held the
// rest, so the comparison can tell "the rule differs" from "the world moved".
//
// Three writers, one shape: the lane's decide step (on the verdict), the lane's
// execute step (on the row it writes) and legacy's two reuse record() calls.
// These tests cover the shape and the lane; the legacy hunk has its own below.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const MarketResearch = require("../models/MarketResearch");
const inputsMod = require("../utils/decisionInputs");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const botFactory = require("../utils/botFactory");
const botWaker = require("../utils/botWaker");
const settings = require("../utils/settings");

let mem;
const origStart = botFactory.startContainer;
const origRegistry = botWaker.readRegistry;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2reuseinputs"));
  await FarmJob.init();
  await AutoFarmTask.init();
  botFactory.startContainer = async () => {};
  botWaker.readRegistry = async () => ({});
});

test.after(async () => {
  botFactory.startContainer = origStart;
  botWaker.readRegistry = origRegistry;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
const accounts = (game, n) =>
  Array.from({ length: n }, (_, i) => `${game.toLowerCase().replace(/[^a-z0-9]+/g, "")}_${i + 1}`);
const BOT = { host: "local", file: "config_9.json", container: "bot9" };
const hostCache = () => new Map([["local|config_9.json", true]]);

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

const snapshot = () =>
  inputsMod.buildDecisionInputs({
    research: { demandScore: 50, sellers: 2, scannedAt: hoursAgo(1) },
    sales: { count: 1, revenue: 3, avgPrice: 3 },
    af: af(),
    probeAllowed: true,
    floor: 6,
  });

async function source(game, held, createdAt) {
  return AutoFarmTask.create({
    game,
    campaignId: "source",
    decision: "farm",
    status: "completed",
    assignedAccounts: accounts(game, held),
    bots: [BOT],
    createdAt,
  });
}

/* --------------------------------- the shape ------------------------------ */

test("buildReuseInputs: spokenFor is derived from held and free; competitors kept as given", () => {
  const id = new mongoose.Types.ObjectId();
  const r = inputsMod.buildReuseInputs({
    sourceTaskId: id,
    sourceHeld: 19,
    free: 16,
    competitors: [id],
    ownRowExcluded: 12,
    dryRun: false,
  });
  assert.equal(r.sourceTaskId, id);
  assert.equal(r.sourceHeld, 19);
  assert.equal(r.spokenFor, 3, "19 held, 16 free — 3 spoken for");
  assert.equal(r.free, 16);
  assert.deepEqual(r.competitors, [id]);
  assert.equal(r.ownRowExcluded, 12);
  assert.equal(r.dryRun, false);
});

test("buildReuseInputs: a dry-run that computed no spoken-for set records free null, spokenFor null, competitors null — absent, not zero", () => {
  const r = inputsMod.buildReuseInputs({
    sourceTaskId: new mongoose.Types.ObjectId(),
    sourceHeld: 3,
    free: null,
    competitors: null,
    dryRun: true,
  });
  assert.equal(r.sourceHeld, 3);
  assert.equal(r.free, null);
  assert.equal(r.spokenFor, null);
  assert.equal(r.competitors, null);
  assert.equal(r.ownRowExcluded, null);
  assert.equal(r.dryRun, true);
});

test("hasReuseInputs requires a numeric free — dry-run, absent and non-reuse all read as not recorded", () => {
  const di = snapshot();
  assert.equal(inputsMod.hasReuseInputs(di), false, "a plain snapshot has no reuse inputs");
  assert.equal(inputsMod.hasReuseInputs(null), false);
  assert.equal(
    inputsMod.hasReuseInputs(
      inputsMod.withReuseInputs(di, inputsMod.buildReuseInputs({ sourceHeld: 3, free: null, dryRun: true })),
    ),
    false,
    "dry-run: free is null",
  );
  assert.equal(
    inputsMod.hasReuseInputs(
      inputsMod.withReuseInputs(di, inputsMod.buildReuseInputs({ sourceHeld: 3, free: 0, competitors: [] })),
    ),
    true,
    "free: 0 IS recorded — zero is a value, absence is not",
  );
});

test("withReuseInputs leaves the sellability snapshot recognised, and needs one to attach to", () => {
  const di = snapshot();
  const with_ = inputsMod.withReuseInputs(di, inputsMod.buildReuseInputs({ sourceHeld: 5, free: 5, competitors: [] }));
  assert.equal(inputsMod.isRecordedInputs(with_), true, "the version-1 reader still accepts it");
  assert.equal(with_.version, inputsMod.DECISION_INPUTS_VERSION, "no version bump: nothing existing changed meaning");
  assert.equal(with_.reuse.free, 5);
  assert.equal(inputsMod.withReuseInputs(null, { free: 1 }), null, "reuse inputs never travel alone");
});

/* ----------------------------------- the lane ----------------------------- */

test("LANE decide: the verdict carries the reuse inputs — source, held, spoken for, free, competitors, own row", async () => {
  const game = "Lane Reuse Inputs Game";
  await AutoFarmTask.deleteMany({ game });
  await MarketResearch.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  const R = await source(game, 19, hoursAgo(2));
  // The campaign's own legacy row holds 12 of R's accounts (exempt); a sibling
  // campaign's live task holds 3 (a competitor).
  await AutoFarmTask.create({
    game,
    campaignId: "c1",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: R.assignedAccounts.slice(0, 12),
    bots: [{ ...BOT, reused: true, shared: true }],
    executedAt: hoursAgo(1),
    createdAt: hoursAgo(30),
  });
  const sib = await AutoFarmTask.create({
    game,
    campaignId: "c2",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: R.assignedAccounts.slice(16, 19),
    bots: [{ ...BOT, reused: true, shared: true }],
    executedAt: hoursAgo(1),
    createdAt: hoursAgo(20),
  });

  const v = await decideStep.decideCampaign({
    campaign: { game, campaignId: "c1", name: "Weekly", endAt: hoursFromNow(48) },
    lane: { game, gameKey: settings.normGameName(game), mode: "shadow" },
    cycle: null,
    af: af(),
    shadow: true,
    hostCache: hostCache(),
    ctx: { host: { id: "local", label: "Local" }, hostOnline: true },
  });
  assert.equal(v.decision, "reuse_existing");
  assert.equal(v.plannedAccounts, 16);
  assert.equal(inputsMod.isRecordedInputs(v.decisionInputs), true, "the sellability snapshot is intact");
  assert.equal(inputsMod.hasReuseInputs(v.decisionInputs), true);
  const r = v.decisionInputs.reuse;
  assert.equal(String(r.sourceTaskId), String(R._id));
  assert.equal(r.sourceHeld, 19);
  assert.equal(r.spokenFor, 3);
  assert.equal(r.free, 16);
  assert.deepEqual(r.competitors.map(String), [String(sib._id)]);
  assert.equal(r.ownRowExcluded, 12);
  assert.equal(r.dryRun, false);
  // And the competitor detail the comparison reads (not persisted to the row).
  assert.equal(v.reuseCompetitors.length, 1);
  assert.equal(String(v.reuseCompetitors[0].taskId), String(sib._id));
  assert.equal(v.reuseCompetitors[0].overlap, 3);
  assert.ok(v.reuseCompetitors[0].executedAt instanceof Date);
});

test("MODEL: the sub-document round-trips under strict mode; a null competitor list stays null, an empty one stays empty", async () => {
  const game = "Reuse Inputs Model Game";
  await AutoFarmTask.deleteMany({ game });
  const id = new mongoose.Types.ObjectId();
  const base = { game, decision: "reuse_existing", status: "planned" };
  await AutoFarmTask.create({
    ...base,
    campaignId: "computed",
    decisionInputs: inputsMod.withReuseInputs(
      snapshot(),
      inputsMod.buildReuseInputs({ sourceTaskId: id, sourceHeld: 4, free: 4, competitors: [], dryRun: true }),
    ),
  });
  await AutoFarmTask.create({
    ...base,
    campaignId: "uncomputed",
    decisionInputs: inputsMod.withReuseInputs(
      snapshot(),
      inputsMod.buildReuseInputs({ sourceTaskId: id, sourceHeld: 4, free: null, competitors: null, dryRun: true }),
    ),
  });
  const computed = await AutoFarmTask.findOne({ game, campaignId: "computed" }).lean();
  const uncomputed = await AutoFarmTask.findOne({ game, campaignId: "uncomputed" }).lean();
  assert.deepEqual(computed.decisionInputs.reuse.competitors, [], "computed, none");
  assert.equal(computed.decisionInputs.reuse.free, 4);
  assert.equal(String(computed.decisionInputs.reuse.sourceTaskId), String(id));
  assert.equal(uncomputed.decisionInputs.reuse.competitors, null, "not computed — stored as null, not as []");
  assert.equal(uncomputed.decisionInputs.reuse.free, null);
  assert.equal(inputsMod.hasReuseInputs(computed.decisionInputs), true);
  assert.equal(inputsMod.hasReuseInputs(uncomputed.decisionInputs), false);
  // A non-reuse row carries no reuse inputs at all.
  await AutoFarmTask.create({ game, campaignId: "farm", decision: "farm", status: "planned", decisionInputs: snapshot() });
  const farm = await AutoFarmTask.findOne({ game, campaignId: "farm" }).lean();
  assert.equal(farm.decisionInputs.reuse, null);
});

test("LANE execute (dry-run): the planned row records the execution-time reuse inputs with dryRun true", async () => {
  const game = "Reuse Inputs Dry Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await source(game, 5, hoursAgo(2));
  const r = await executeStep.executeReuse({
    verdict: { game, campaignId: "new", decision: "reuse_existing", reuseTaskId: R._id, reason: "recurring", decisionInputs: snapshot() },
    dryRun: true,
  });
  assert.equal(r.wouldReuseAccounts, 5);
  const row = await AutoFarmTask.findOne({ game, campaignId: "new" }).lean();
  assert.equal(row.status, "planned");
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true);
  assert.equal(row.decisionInputs.reuse.free, 5);
  assert.equal(row.decisionInputs.reuse.sourceHeld, 5);
  assert.deepEqual(row.decisionInputs.reuse.competitors, []);
  assert.equal(row.decisionInputs.reuse.dryRun, true);
});

test("LANE execute (live): the active row records free = what it assigned; the empty-mine skip records free 0 and WHO held the accounts", async () => {
  const game = "Reuse Inputs Live Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await source(game, 18, hoursAgo(2));
  const verdict = (campaignId) => ({
    game,
    campaignId,
    campaignName: "Weekly",
    campaignEndAt: hoursFromNow(48),
    decision: "reuse_existing",
    reuseTaskId: R._id,
    demandScore: 3.7,
    hadResearch: true,
    internalSales: 13,
    reason: "recurring",
    decisionInputs: snapshot(),
  });
  const first = await executeStep.executeReuse({ verdict: verdict("c1"), dryRun: false });
  assert.equal(first.accounts, 18);
  const row1 = await AutoFarmTask.findOne({ game, campaignId: "c1" }).lean();
  assert.equal(row1.status, "active");
  assert.equal(row1.decisionInputs.reuse.free, 18, "equals plannedAccounts and assignedAccounts.length at write time");
  assert.equal(row1.plannedAccounts, 18);
  assert.equal(row1.decisionInputs.reuse.spokenFor, 0);
  assert.deepEqual(row1.decisionInputs.reuse.competitors, []);
  assert.equal(String(row1.decisionInputs.reuse.sourceTaskId), String(R._id));

  const second = await executeStep.executeReuse({ verdict: verdict("c2"), dryRun: false });
  assert.equal(second.skipped, true);
  const row2 = await AutoFarmTask.findOne({ game, campaignId: "c2" }).lean();
  assert.equal(row2.status, "skipped");
  assert.equal(row2.decisionInputs.reuse.free, 0, "zero is recorded as zero");
  assert.equal(row2.decisionInputs.reuse.spokenFor, 18);
  assert.deepEqual(row2.decisionInputs.reuse.competitors.map(String), [String(row1._id)], "the first campaign's task held them");
  assert.equal(inputsMod.hasReuseInputs(row2.decisionInputs), true);
});

/* --------------------------------- legacy --------------------------------- */

// processCampaign(c, ctx) is the legacy per-campaign decision. Its reuse block
// is reachable without a host: the reusable task comes from ctx.reusableMap,
// the bot-file existence check is answered by ctx.hostState.hasFile, and
// botFactory.startContainer is stubbed above so the LIVE path restarts
// nothing. Both reuse record() calls are driven for real here.
const autoFarmer = require("../utils/autoFarmer");

function legacyCtx({ campaignId, research, sales, reusable, afOverrides = {} }) {
  return {
    af: af(afOverrides),
    host: { id: "local", label: "Local" },
    hostOnline: true,
    budgetMap: new Map(),
    infoMap: new Map([[campaignId, { research, sales }]]),
    priorTasks: new Map(),
    reusableMap: new Map([[reusable.game, reusable]]),
    hostState: { hasFile: () => true, activateBot() {} },
  };
}

const sellable = () => ({
  research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) },
  sales: { count: 7, revenue: 35, avgPrice: 5 },
});

test("LEGACY record(), live reuse: the row carries source, held, spoken for, free and the competitors — free equals plannedAccounts", async () => {
  const game = "Legacy Reuse Inputs Game";
  await AutoFarmTask.deleteMany({ game });
  const R = (await source(game, 5, hoursAgo(2))).toObject();
  // A sibling campaign's live task holds two of R's five accounts.
  const sib = await AutoFarmTask.create({
    game,
    campaignId: "sib",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: R.assignedAccounts.slice(0, 2),
    executedAt: hoursAgo(1),
  });
  const c = { game, campaignId: "lr-live", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(c, legacyCtx({ campaignId: "lr-live", ...sellable(), reusable: R }));
  assert.equal(r.decision, "reuse_existing");
  assert.equal(r.dryRun, undefined, "the live path");

  const row = await AutoFarmTask.findOne({ game, campaignId: "lr-live" }).lean();
  assert.equal(row.status, "active");
  assert.equal(row.plannedAccounts, 3);
  assert.equal(row.assignedAccounts.length, 3);
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true, "the sellability snapshot is still there");
  assert.equal(inputsMod.hasReuseInputs(row.decisionInputs), true);
  const ri = row.decisionInputs.reuse;
  assert.equal(String(ri.sourceTaskId), String(R._id));
  assert.equal(ri.sourceHeld, 5);
  assert.equal(ri.spokenFor, 2);
  assert.equal(ri.free, 3, "the number legacy recorded as plannedAccounts, now dated and sourced");
  assert.deepEqual(ri.competitors.map(String), [String(sib._id)]);
  assert.equal(ri.ownRowExcluded, null, "legacy never has an own row to exclude");
  assert.equal(ri.dryRun, false);
});

test("LEGACY record(), dry-run reuse: source and held are recorded, free is null — not recorded, not zero", async () => {
  const game = "Legacy Dry Reuse Inputs Game";
  await AutoFarmTask.deleteMany({ game });
  const R = (await source(game, 3, hoursAgo(2))).toObject();
  const c = { game, campaignId: "lr-dry", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    legacyCtx({ campaignId: "lr-dry", ...sellable(), reusable: R, afOverrides: { dryRun: true } }),
  );
  assert.equal(r.dryRun, true);
  const row = await AutoFarmTask.findOne({ game, campaignId: "lr-dry" }).lean();
  assert.equal(row.status, "planned");
  assert.equal(row.plannedAccounts, 0, "0 by construction on this path — which is why it cannot be compared");
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true);
  assert.equal(inputsMod.hasReuseInputs(row.decisionInputs), false);
  const ri = row.decisionInputs.reuse;
  assert.equal(String(ri.sourceTaskId), String(R._id));
  assert.equal(ri.sourceHeld, 3);
  assert.equal(ri.free, null);
  assert.equal(ri.spokenFor, null);
  assert.equal(ri.competitors, null);
  assert.equal(ri.dryRun, true);
});

test("LEGACY record(), a non-reuse path: no reuse inputs at all", async () => {
  const game = "Legacy Skip Reuse Inputs Game";
  await AutoFarmTask.deleteMany({ game });
  const R = (await source(game, 3, hoursAgo(2))).toObject();
  const c = { game, campaignId: "ls-none", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    legacyCtx({
      campaignId: "ls-none",
      research: { demandScore: 3, sellers: 20, scannedAt: hoursAgo(1) },
      sales: { count: 0, revenue: 0, avgPrice: 0 },
      reusable: R,
    }),
  );
  assert.equal(r.decision, "skip_low_demand");
  const row = await AutoFarmTask.findOne({ game, campaignId: "ls-none" }).lean();
  assert.equal(inputsMod.isRecordedInputs(row.decisionInputs), true);
  assert.equal(row.decisionInputs.reuse, null);
});
