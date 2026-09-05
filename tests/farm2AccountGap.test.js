// The account-count comparison (utils/farm2/accountGap.js): when is
// "lane − legacy accounts" a number worth reading?
//
// Production, 2026-09-05: the shadow account delta was contaminated by three
// independent artifacts and had held three lanes back from promotion on them.
//   1. skip rows carry a plannedAccounts LEFTOVER from an earlier decision on
//      the same row (the skip paths never write it): seven skip_low_demand
//      lanes showed −15 where the lane planned 0 by definition
//   2. reuse rows: the campaign's own legacy row sat in the lane's spokenFor
//      (fixed in decide.js), and the world can still move between the two
//      engines' decisions — a competitor activated after legacy decided, or
//      one of legacy's competitors released since
//   3. dry-run reuse rows carry plannedAccounts 0 by construction
// A delta is now SCORED only on reuse-vs-reuse rows the comparison can hold
// still; everything else is reported with the reason it was not scored, and
// the readiness warning counts scored rows only.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const MarketResearch = require("../models/MarketResearch");
const inputsMod = require("../utils/decisionInputs");
const accountGap = require("../utils/farm2/accountGap");
const decideStep = require("../utils/farm2/steps/decide");
const farm2 = require("../utils/farm2");
const autoFarmer = require("../utils/autoFarmer");
const botFactory = require("../utils/botFactory");
const botWaker = require("../utils/botWaker");
const settings = require("../utils/settings");

const { compareAccounts, NOT_SCORED } = accountGap;

let mem;
const origStart = botFactory.startContainer;
const origRegistry = botWaker.readRegistry;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2accountgap"));
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
const oid = () => new mongoose.Types.ObjectId();
const accounts = (game, n) =>
  Array.from({ length: n }, (_, i) => `${game.toLowerCase().replace(/[^a-z0-9]+/g, "")}_${i + 1}`);
const BOT = { host: "local", file: "config_9.json", container: "bot9" };

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
    research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) },
    sales: { count: 7, revenue: 35, avgPrice: 5 },
    af: af(),
    probeAllowed: true,
    floor: 6,
  });

// A legacy row as diffAgainstLegacy selects it.
function legacyRow({ decision, plannedAccounts = 0, dryRun = false, reuse = null, decidedAt = hoursAgo(0.5) }) {
  return {
    _id: oid(),
    decision,
    plannedAccounts,
    dryRun,
    decidedAt,
    decisionInputs: reuse ? inputsMod.withReuseInputs(snapshot(), reuse) : snapshot(),
  };
}
const legacyAtOf = (row) => new Date(row.decidedAt).getTime();
const reuseVerdict = (planned, source, extra = {}) => ({
  decision: "reuse_existing",
  plannedAccounts: planned,
  reuseTaskId: source,
  reuseCompetitors: [],
  ...extra,
});
const recorded = (source, free, held, competitors = []) =>
  inputsMod.buildReuseInputs({ sourceTaskId: source, sourceHeld: held, free, competitors, dryRun: false });

/* ------------------------------ not scored -------------------------------- */

test("ARTIFACT 3: skip vs skip — the legacy plannedAccounts is a leftover and is not compared, in either direction", async () => {
  // The seven skip_low_demand lanes: legacy row carrying 15 from an earlier
  // decision on the same row, lane planning 0 by definition.
  const legacy = legacyRow({ decision: "skip_low_demand", plannedAccounts: 15 });
  const r = await compareAccounts({
    verdict: { decision: "skip_low_demand", plannedAccounts: 0 },
    legacy,
    legacyAt: legacyAtOf(legacy),
  });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.SKIP);
  assert.equal(r.legacyPlanned, null, "the row has no honest count");
  assert.equal(r.legacyPlannedField, 15, "the raw field stays visible");
  assert.equal(r.accountDelta, null, "no −15");
  assert.equal(r.lanePlanned, 0);
});

test("different action classes: no account comparison at all", async () => {
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 12 });
  const r = await compareAccounts({ verdict: { decision: "farm", plannedAccounts: 12 }, legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.DIFFERENT_CLASS);
  assert.equal(r.accountDelta, null);
});

test("spend vs spend: the numbers are reported (farm/probe write the field) but not scored — budgets differ by design", async () => {
  const legacy = legacyRow({ decision: "farm", plannedAccounts: 5 });
  const r = await compareAccounts({ verdict: { decision: "farm", plannedAccounts: 18 }, legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.SPEND);
  assert.equal(r.accountBasis, "planned_field");
  assert.equal(r.legacyPlanned, 5);
  assert.equal(r.accountDelta, 13, "shown, so an operator can still look");
});

test("legacy dry-run reuse: plannedAccounts 0 by construction — not scored", async () => {
  const src = oid();
  const legacy = legacyRow({
    decision: "reuse_existing",
    plannedAccounts: 0,
    dryRun: true,
    reuse: inputsMod.buildReuseInputs({ sourceTaskId: src, sourceHeld: 3, free: null, competitors: null, dryRun: true }),
  });
  const r = await compareAccounts({ verdict: reuseVerdict(3, src), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.LEGACY_DRY_RUN);
  assert.equal(r.accountDelta, null, "not +3");
});

test("source mismatch: the two engines reused different warm tasks — different account sets, reported but not scored", async () => {
  const legacySrc = oid();
  const laneSrc = oid();
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 19, reuse: recorded(legacySrc, 19, 19) });
  const r = await compareAccounts({ verdict: reuseVerdict(3, laneSrc), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.SOURCE_MISMATCH);
  assert.equal(r.sourceVerified, true);
  assert.equal(r.legacyPlanned, 19);
  assert.equal(r.accountDelta, -16, "visible: this is the §5.3 signal, not a rule difference");
});

test("competitor after legacy: a live task the lane saw was activated AFTER legacy decided — legacy could not have counted it", async () => {
  const src = oid();
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 19, reuse: recorded(src, 19, 19), decidedAt: hoursAgo(1) });
  const after = await compareAccounts({
    verdict: reuseVerdict(7, src, {
      reuseCompetitors: [{ taskId: oid(), campaignId: "sib", status: "active", executedAt: hoursAgo(0.5), overlap: 12 }],
    }),
    legacy,
    legacyAt: legacyAtOf(legacy),
  });
  assert.equal(after.accountComparable, false);
  assert.equal(after.accountNote, NOT_SCORED.COMPETITOR_AFTER_LEGACY);
  assert.equal(after.competitorsAfter, 1);
  assert.equal(after.accountDelta, -12, "reported for the record");

  // The same competitor activated BEFORE legacy decided: legacy saw it too, so
  // a difference here would be a real one — scored.
  const before = await compareAccounts({
    verdict: reuseVerdict(7, src, {
      reuseCompetitors: [{ taskId: oid(), campaignId: "sib", status: "active", executedAt: hoursAgo(2), overlap: 12 }],
    }),
    legacy,
    legacyAt: legacyAtOf(legacy),
  });
  assert.equal(before.accountComparable, true);
  assert.equal(before.accountDelta, -12);
});

test("competitor released since (exact, from legacy's recorded competitors): the lane sees more free than legacy could — not scored", async () => {
  const game = "Released Since Game";
  await AutoFarmTask.deleteMany({ game });
  const src = oid();
  const comp = await AutoFarmTask.create({ game, campaignId: "comp", decision: "farm", status: "completed", assignedAccounts: ["x1"] });
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 12, reuse: recorded(src, 12, 19, [comp._id]) });
  const r = await compareAccounts({ verdict: reuseVerdict(19, src), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.COMPETITOR_RELEASED_SINCE);
  assert.equal(r.competitorsReleased, 1);
  assert.equal(r.accountDelta, 7, "the World of Tanks +delta shape, now named");

  // Still live: nothing released, the delta is real — scored.
  await AutoFarmTask.updateOne({ _id: comp._id }, { $set: { status: "active" } });
  const live = await compareAccounts({ verdict: reuseVerdict(19, src), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(live.accountComparable, true);
  assert.equal(live.accountDelta, 7);
  // A recorded competitor that no longer exists counts as released.
  const gone = legacyRow({ decision: "reuse_existing", plannedAccounts: 12, reuse: recorded(src, 12, 19, [oid()]) });
  const g = await compareAccounts({ verdict: reuseVerdict(19, src), legacy: gone, legacyAt: legacyAtOf(gone) });
  assert.equal(g.accountNote, NOT_SCORED.COMPETITOR_RELEASED_SINCE);
});

test("competitor completed since (approximation, no recorded inputs): a task holding the source's accounts completed after legacy decided", async () => {
  const game = "Completed Since Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await AutoFarmTask.create({ game, campaignId: "source", decision: "farm", status: "completed", assignedAccounts: accounts(game, 5), bots: [BOT] });
  await AutoFarmTask.create({
    game,
    campaignId: "sib",
    decision: "reuse_existing",
    status: "completed",
    assignedAccounts: R.assignedAccounts.slice(0, 2),
    completedAt: hoursAgo(0.25),
  });
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 3, decidedAt: hoursAgo(1) }); // no reuse inputs: pre-record row
  const r = await compareAccounts({ verdict: reuseVerdict(5, R._id), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, false);
  assert.equal(r.accountNote, NOT_SCORED.COMPETITOR_COMPLETED_SINCE);
  assert.equal(r.accountBasis, "planned_field");
  assert.equal(r.sourceVerified, false);
});

/* -------------------------------- scored ---------------------------------- */

test("SCORED: reuse vs reuse, same source, recorded free — basis recorded_reuse_free, source verified", async () => {
  const src = oid();
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 19, reuse: recorded(src, 19, 19) });
  const r = await compareAccounts({ verdict: reuseVerdict(19, src), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, true);
  assert.equal(r.accountBasis, "recorded_reuse_free");
  assert.equal(r.sourceVerified, true);
  assert.equal(r.legacyPlanned, 19);
  assert.equal(r.accountDelta, 0);
  assert.equal(r.accountNote, "");
});

test("SCORED: the recorded free wins over the row field when they differ", async () => {
  const src = oid();
  // A row whose plannedAccounts was later rewritten by something (defensive:
  // the recorded snapshot is the dated truth).
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 3, reuse: recorded(src, 19, 19) });
  const r = await compareAccounts({ verdict: reuseVerdict(19, src), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.legacyPlanned, 19);
  assert.equal(r.legacyPlannedField, 3);
  assert.equal(r.accountDelta, 0);
});

test("SCORED, unverified: a legacy reuse row written before the inputs were recorded compares on plannedAccounts and says so", async () => {
  const game = "Unverified Source Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await AutoFarmTask.create({ game, campaignId: "source", decision: "farm", status: "completed", assignedAccounts: accounts(game, 19), bots: [BOT] });
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 19 });
  const r = await compareAccounts({ verdict: reuseVerdict(19, R._id), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(r.accountComparable, true);
  assert.equal(r.accountBasis, "planned_field");
  assert.equal(r.sourceVerified, false);
  assert.equal(r.accountDelta, 0);
});

test("own-row source (P4): the lane reused the campaign's own legacy row — scored while legacy's source is settled, not while it is still live", async () => {
  const game = "Own Row Source Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await AutoFarmTask.create({ game, campaignId: "source", decision: "farm", status: "completed", assignedAccounts: accounts(game, 40), bots: [BOT] });
  const legacy = legacyRow({ decision: "reuse_existing", plannedAccounts: 40, reuse: recorded(R._id, 40, 40) });
  // The lane's source is legacy's row itself (legacy._id).
  const settled = await compareAccounts({ verdict: reuseVerdict(40, legacy._id), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(settled.accountComparable, true);
  assert.equal(settled.accountNote, "own_row_source");
  assert.equal(settled.accountDelta, 0, "Black Desert / Apex, delta 0, reusedOwnRow TRUE");

  // Legacy's source still active: the own row's accounts are counted against
  // it — the mirror of the own-row collision — so the 0 the lane would see is
  // not a rule difference.
  await AutoFarmTask.updateOne({ _id: R._id }, { $set: { status: "active" } });
  const mirrored = await compareAccounts({ verdict: reuseVerdict(0, legacy._id), legacy, legacyAt: legacyAtOf(legacy) });
  assert.equal(mirrored.accountComparable, false);
  assert.equal(mirrored.accountNote, NOT_SCORED.LEGACY_SOURCE_STILL_LIVE);
  assert.equal(mirrored.accountDelta, -40, "reported, so the configuration can be counted on prod");
});

/* ------------------------------- the diff --------------------------------- */

test("diffAgainstLegacy carries the account fields; a skip row's leftover no longer produces a delta", async () => {
  const game = "Diff Skip Leftover Game";
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.create({
    game,
    campaignId: "c1",
    decision: "skip_low_demand",
    status: "skipped",
    plannedAccounts: 15, // the leftover
    decidedAt: new Date(),
  });
  const d = await decideStep.diffAgainstLegacy({ game, campaignId: "c1", decision: "skip_low_demand", plannedAccounts: 0 });
  assert.equal(d.agree, true);
  assert.equal(d.accountComparable, false);
  assert.equal(d.accountNote, NOT_SCORED.SKIP);
  assert.equal(d.accountDelta, null);
  assert.equal(d.legacyPlanned, null);
  assert.equal(d.legacyPlannedField, 15);
  assert.equal(d.lanePlanned, 0);
});

test("diffAgainstLegacy: a stale row is not account-scored either", async () => {
  const game = "Diff Stale Game";
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.create({ game, campaignId: "c1", decision: "reuse_existing", status: "active", plannedAccounts: 19, decidedAt: hoursAgo(30) });
  const d = await decideStep.diffAgainstLegacy({ game, campaignId: "c1", decision: "reuse_existing", plannedAccounts: 0 });
  assert.equal(d.stale, true);
  assert.equal(d.accountComparable, false);
});

/* ------------------------------ end to end -------------------------------- */

// Legacy really reuses (processCampaign, containers stubbed), then the shadow
// lane decides the same campaign and the diff scores it. Both configurations
// production showed: the lane picking legacy's source (P2 rows) and the lane
// picking the campaign's own row (P4 rows).
function legacyCtx({ campaignId, reusable }) {
  return {
    af: af(),
    host: { id: "local", label: "Local" },
    hostOnline: true,
    budgetMap: new Map(),
    infoMap: new Map([[campaignId, { research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) }, sales: { count: 7, revenue: 35, avgPrice: 5 } }]]),
    priorTasks: new Map(),
    reusableMap: new Map([[reusable.game, reusable]]),
    hostState: { hasFile: () => true, activateBot() {} },
  };
}

async function laneDecides(game, campaignId) {
  return decideStep.decideCampaign({
    campaign: { game, campaignId, name: "Weekly", endAt: hoursFromNow(48) },
    lane: { game, gameKey: settings.normGameName(game), mode: "shadow" },
    cycle: null,
    af: af(),
    shadow: true,
    hostCache: new Map([["local|config_9.json", true]]),
    ctx: { host: { id: "local", label: "Local" }, hostOnline: true },
  });
}

test("END TO END (P2): legacy reuses 19 from R; the lane, deciding after, picks R too and now scores delta 0 with the source verified", async () => {
  const game = "E2E P2 Game";
  await AutoFarmTask.deleteMany({ game });
  await MarketResearch.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  // The campaign's row pre-exists as a skip (older than R), as on prod.
  await AutoFarmTask.create({ game, campaignId: "c1", decision: "skip_host_offline", status: "skipped", createdAt: hoursAgo(30), decidedAt: hoursAgo(30) });
  const R = (await AutoFarmTask.create({ game, campaignId: "source", decision: "farm", status: "completed", assignedAccounts: accounts(game, 19), bots: [BOT], createdAt: hoursAgo(2) })).toObject();

  const legacyResult = await autoFarmer.processCampaign({ game, campaignId: "c1", name: "Weekly", endAt: hoursFromNow(48) }, legacyCtx({ campaignId: "c1", reusable: R }));
  assert.equal(legacyResult.decision, "reuse_existing");
  const L = await AutoFarmTask.findOne({ game, campaignId: "c1" }).lean();
  assert.equal(L.status, "active");
  assert.equal(L.plannedAccounts, 19);
  assert.equal(L.decisionInputs.reuse.free, 19);
  assert.ok(L.createdAt < R.createdAt, "fixture: the own row is older, so R is the pick");

  const v = await laneDecides(game, "c1");
  assert.equal(v.decision, "reuse_existing");
  assert.equal(String(v.reuseTaskId), String(R._id), "the lane picked legacy's source");
  assert.equal(v.plannedAccounts, 19, "was 0 before the own-row exemption");

  const d = await decideStep.diffAgainstLegacy(v);
  assert.equal(d.agree, true);
  assert.equal(d.accountComparable, true);
  assert.equal(d.accountBasis, "recorded_reuse_free");
  assert.equal(d.sourceVerified, true);
  assert.equal(d.legacyPlanned, 19);
  assert.equal(d.accountDelta, 0);
});

test("END TO END (P4): the campaign's row is newest, the lane reuses it — scored as own_row_source with delta 0", async () => {
  const game = "E2E P4 Game";
  await AutoFarmTask.deleteMany({ game });
  await MarketResearch.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  const R = (await AutoFarmTask.create({ game, campaignId: "source", decision: "farm", status: "completed", assignedAccounts: accounts(game, 40), bots: [BOT], createdAt: hoursAgo(2) })).toObject();

  await autoFarmer.processCampaign({ game, campaignId: "c1", name: "Weekly", endAt: hoursFromNow(48) }, legacyCtx({ campaignId: "c1", reusable: R }));
  const L = await AutoFarmTask.findOne({ game, campaignId: "c1" }).lean();
  assert.equal(L.plannedAccounts, 40);
  assert.ok(L.createdAt > R.createdAt, "fixture: a fresh row — newest");

  const v = await laneDecides(game, "c1");
  assert.equal(String(v.reuseTaskId), String(L._id), "the lane reused the campaign's own row, as in the P4 rows");
  assert.equal(v.plannedAccounts, 40);
  const d = await decideStep.diffAgainstLegacy(v);
  assert.equal(d.agree, true);
  assert.equal(d.accountComparable, true);
  assert.equal(d.accountNote, "own_row_source");
  assert.equal(d.sourceVerified, true);
  assert.equal(d.accountDelta, 0);
});

/* ------------------------------- readiness -------------------------------- */

async function readinessWith(gameKey, diffs) {
  await FarmJob.deleteMany({ laneKey: gameKey });
  await FarmLane.deleteMany({ gameKey });
  const lane = await FarmLane.create({ game: gameKey, gameKey, mode: "shadow" });
  let i = 0;
  for (const diff of diffs) {
    await FarmJob.create({
      lane: gameKey,
      laneKey: gameKey,
      kind: "decide",
      campaignId: "c" + i++,
      status: "done",
      shadow: true,
      result: { verdict: { decision: "reuse_existing" }, diff: { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: false, ...diff } },
    });
  }
  return farm2.laneReadiness(lane.toObject());
}

test("READINESS: the 10+ warning counts SCORED rows only; unscored rows are listed by reason as a caveat, never a warning", async () => {
  const scoredGap = { accountComparable: true, accountDelta: 12, sourceVerified: true, accountNote: "" };
  const skipLeftover = { accountComparable: false, accountDelta: null, accountNote: NOT_SCORED.SKIP };
  const movedWorld = { accountComparable: false, accountDelta: -40, accountNote: NOT_SCORED.COMPETITOR_AFTER_LEGACY };

  const warned = await readinessWith("gap warn lane", [scoredGap, scoredGap, { accountComparable: true, accountDelta: 0, sourceVerified: true, accountNote: "" }]);
  assert.equal(warned.ready, true, warned.blockers.join("; "));
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /2 of 3 account-scored reuse decision\(s\)/);
  assert.match(warned.warnings[0], /\+12, \+12/);
  assert.deepEqual(warned.accountGaps, { scored: 3, gaps: 2, unverifiedSource: 0, notScored: {}, preGate: 0 });

  const quiet = await readinessWith("gap quiet lane", [skipLeftover, movedWorld, movedWorld, { accountComparable: true, accountDelta: 0, sourceVerified: true, accountNote: "" }]);
  assert.equal(quiet.ready, true);
  assert.equal(quiet.warnings.length, 0, "a −40 the world explains is not a warning");
  assert.equal(quiet.accountGaps.scored, 1);
  assert.deepEqual(quiet.accountGaps.notScored, { [NOT_SCORED.SKIP]: 1, [NOT_SCORED.COMPETITOR_AFTER_LEGACY]: 2 });
  const caveat = quiet.caveats.find((c) => /account counts not scored/.test(c));
  assert.ok(caveat, "the exclusions are stated");
  assert.match(caveat, /3 of 4 compared decision\(s\)/);
  assert.match(caveat, new RegExp(`${NOT_SCORED.COMPETITOR_AFTER_LEGACY} 2`));
});

test("READINESS: rows that predate the account comparison are not scored — absence is never a passing value — and unverified sources are counted", async () => {
  const pre = { accountDelta: -40 }; // the old shape: a delta, no accountComparable
  const unverified = { accountComparable: true, accountDelta: 0, sourceVerified: false, accountNote: "" };
  const r = await readinessWith("gap pregate lane", [pre, pre, unverified]);
  assert.equal(r.warnings.length, 0, "an old −40 does not warn");
  assert.equal(r.accountGaps.preGate, 2);
  assert.equal(r.accountGaps.scored, 1);
  assert.equal(r.accountGaps.unverifiedSource, 1);
  assert.ok(r.caveats.some((c) => /2 compared decision\(s\) predate the account comparison/.test(c)));
  assert.ok(r.caveats.some((c) => /same-source unverified/.test(c)));
});
