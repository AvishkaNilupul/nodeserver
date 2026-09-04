// Coverage for the replay harness (utils/farm2/replay.js) and the shared
// decision vocabulary (utils/farm2/decisionClasses.js).
//
// The point of replay is to remove the confound that made the shadow
// comparison useless. diffAgainstLegacy varies the ENGINE and the WORLD at the
// same time, so a difference cannot be attributed to either; the 6h staleness
// gate tried to hold the world still by proxy and left 0 comparable pairs out
// of 300 on prod. Replay holds the world still directly, by reconstructing the
// inputs the legacy engine had, and so turns months of recorded decisions into
// evidence that is available immediately.
//
// These tests pin the three properties that make that trustworthy:
//   1. it reproduces recorded decisions when the inputs ARE recoverable
//   2. it refuses to score anything when they are not, rather than guessing
//   3. only full-fidelity rows count as evidence
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const SaleSignal = require("../models/SaleSignal");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const replay = require("../utils/farm2/replay");
const classes = require("../utils/farm2/decisionClasses");
const farm2 = require("../utils/farm2");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2replay"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const daysAgo = (d) => new Date(Date.now() - d * 86400000);

// Settings with cold-start probing OFF (the shipped default), which makes the
// probe gate inert and therefore exactly reconstructable.
const AF = {
  maxPerGame: 30,
  probeSize: 5,
  probeColdStart: false,
  probeMaxSellers: 1,
  probeMaxGames: 8,
  probeCooldownDays: 90,
  perMarketStock: 3,
  minHoursLeft: 12,
  platiCategoryId: "",
};

async function reset(game) {
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    MarketResearchSnapshot.deleteMany({ gameKey: game.toLowerCase() }),
    SaleSignal.deleteMany({ gameKey: game.toLowerCase() }),
  ]);
}

// --- The vocabulary --------------------------------------------------------

test("an unclassified decision is `unknown`, never a silent `skip`", () => {
  // The old inline classifier ended in `return "skip"`, so a decision added to
  // AutoFarmTask's enum without being classified would read as "the lane is
  // doing nothing" and agree with any skipping lane. That is the same
  // absence-is-not-a-passing-value trap the presence checks exist to close.
  assert.equal(classes.actionClass("skip_low_demand"), "skip");
  assert.equal(classes.actionClass("farm"), "spend");
  assert.equal(classes.actionClass("reuse_existing"), "reuse");
  assert.equal(classes.actionClass("skip_some_future_thing"), "unknown");
  assert.equal(classes.actionClass(undefined), "unknown");
});

test("every decision in the AutoFarmTask enum is classified", () => {
  // Guards against the table drifting from the model. If someone adds a
  // decision to models/AutoFarmTask.js this fails here rather than silently
  // scoring it as `unknown` in production.
  const enumValues = AutoFarmTask.schema.path("decision").enumValues;
  const unclassified = enumValues.filter((d) => classes.actionClass(d) === "unknown");
  assert.deepEqual(unclassified, [], "unclassified decisions: " + unclassified.join(", "));
});

test("the lane's vocabulary covers every legacy decision — the gap is closed", () => {
  // The lane used to implement only the sellability stage and reuse-first, so
  // six legacy gates sat outside its vocabulary. decide.js now runs all of
  // them; this pins that the tripwire has nothing to report.
  assert.deepEqual(classes.LEGACY_ONLY_DECISIONS, []);
  for (const d of classes.LEGACY_DECISIONS) {
    assert.ok(classes.LANE_DECISIONS.includes(d), `lane cannot emit ${d}`);
  }
});

test("with every gate implemented, farm-vs-skip is a genuine mismatch, not a missing gate", () => {
  // Before the gates existed this pair was `lane_missing_gate` — deterministic,
  // a feature request. Now both engines can reach skip_already_covered, so a
  // difference here means one of them is WRONG about a real game and needs a
  // human. The taxonomy stays as a tripwire for the next time the two
  // vocabularies drift apart.
  const t = classes.classifyDisagreement("farm", "skip_already_covered");
  assert.equal(t.kind, "class_mismatch");

  const g = classes.classifyDisagreement("farm", "reuse_existing");
  assert.equal(g.kind, "class_mismatch");

  // An unclassified decision on either side is still not comparable at all.
  assert.equal(
    classes.classifyDisagreement("farm", "skip_some_future_thing").kind,
    "not_comparable",
  );
});

test("demandScore means different things on different rows", () => {
  // The sellability skip records the BLENDED effective demand; every other
  // decision records the raw market score.
  assert.equal(classes.recordsEffectiveDemand("skip_low_demand"), true);
  assert.equal(classes.recordsEffectiveDemand("skip_probe_budget"), true);
  assert.equal(classes.recordsEffectiveDemand("probe"), false, "probe records the raw score");
  assert.equal(classes.recordsEffectiveDemand("farm"), false);
});

// --- Reconstruction fidelity ----------------------------------------------

test("zero recorded sales is exactly replayable even when sales have since moved", async () => {
  const game = "Zero Sales Game";
  await reset(game);
  // Sales landed AFTER the decision — irrelevant, because with a recorded count
  // of 0 the sales boost was 0 and the price factor cannot apply.
  await SaleSignal.create({
    game,
    gameKey: game.toLowerCase(),
    source: "connected",
    dedupeKey: "zs-1",
    priceUsd: 12,
    at: hoursAgo(2),
  });
  const task = { game, campaignId: "c1", decision: "farm", internalSales: 0, decidedAt: hoursAgo(50) };
  const r = await replay.salesInputsFor(task);
  assert.equal(r.fidelity, replay.FIDELITY.EXACT);
  assert.deepEqual(r.sales, { count: 0, revenue: 0, avgPrice: 0 });
});

test("a drifted sales window is unreplayable rather than guessed", async () => {
  const game = "Drifted Sales Game";
  await reset(game);
  await SaleSignal.create({
    game,
    gameKey: game.toLowerCase(),
    source: "connected",
    dedupeKey: "ds-1",
    priceUsd: 20,
    at: hoursAgo(1),
  });
  // The decision recorded 3 sales; one has landed since, so the average price
  // at decision time is not recoverable. Substituting 0 would make
  // priceFactor return a neutral 1 and silently change the sales boost.
  const task = { game, campaignId: "c1", decision: "farm", internalSales: 3, decidedAt: hoursAgo(50) };
  const r = await replay.salesInputsFor(task);
  assert.equal(r.fidelity, replay.FIDELITY.UNREPLAYABLE);
  assert.ok(r.gaps.includes("sales_window_drifted"));
  assert.equal(r.sales, null, "no guessed value is offered");
});

test("a decision older than the snapshot TTL is unreplayable, and says why", async () => {
  const game = "Ancient Game";
  await reset(game);
  const task = {
    game,
    campaignId: "c1",
    decision: "farm",
    demandScore: 40,
    internalSales: 0,
    decidedAt: daysAgo(200),
  };
  const r = await replay.researchInputsFor(task, { af: AF });
  assert.equal(r.fidelity, replay.FIDELITY.UNREPLAYABLE);
  assert.ok(r.gaps.includes("snapshot_expired"));
  assert.match(r.note, /expire/);
});

test("a missing snapshot that CONTRADICTS the recorded score is unreplayable", async () => {
  // No snapshot survives, but the task recorded a demand score — so research
  // existed and our history is simply incomplete. Treating that as "never
  // scanned" would send demandAllocation down the no-market-data probe branch
  // and invent a disagreement out of a gap in our own records.
  const game = "Missing Snapshot Game";
  await reset(game);
  const task = {
    game,
    campaignId: "c1",
    decision: "farm",
    demandScore: 55,
    internalSales: 0,
    decidedAt: hoursAgo(40),
  };
  const r = await replay.researchInputsFor(task, { af: AF });
  assert.equal(r.fidelity, replay.FIDELITY.UNREPLAYABLE);
  assert.ok(r.gaps.includes("snapshot_missing_but_research_recorded"));
});

test("a genuinely unscanned game reconstructs exactly as no-market-data", async () => {
  const game = "Never Scanned Game";
  await reset(game);
  const task = {
    game,
    campaignId: "c1",
    decision: "probe",
    demandScore: null,
    internalSales: 0,
    decidedAt: hoursAgo(40),
  };
  const r = await replay.researchInputsFor(task, { af: AF });
  assert.equal(r.fidelity, replay.FIDELITY.EXACT);
  assert.equal(r.research, null);
});

// --- Replaying real decisions ---------------------------------------------

test("THE TRIAL CASE: a 171h-old probe the staleness gate discarded is replayable evidence", async () => {
  // This is the decision from docs/FARM2-TASK-comparison-evidence.md that the
  // 6h window threw away: the legacy engine probed an untested game 171 hours
  // ago. The shadow comparison can say nothing about it, because the probe has
  // since run and changed the world.
  //
  // Replay does not care that the world moved. It asks whether the economics
  // reproduce the decision GIVEN THE INPUTS OF THAT MOMENT — an untested game
  // with no research and no sales — and that question is still answerable.
  const game = "Plants on Fire";
  await reset(game);
  const decidedAt = hoursAgo(171);
  const task = {
    game,
    campaignId: "c2",
    decision: "probe",
    demandScore: null,
    hadResearch: false,
    internalSales: 0,
    targetAccounts: 5,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.fidelity, replay.FIDELITY.EXACT, out.notes && out.notes.join("; "));
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.replayed.probe, true);
});

test("a sellability skip is reproduced AND self-validating on its demand figure", async () => {
  // skip_low_demand records `demandScore: alloc.demand`, the blended effective
  // demand — an output. So reproducing it checks the input reconstruction and
  // the economics at the same time: a matching number is hard to get by luck.
  const game = "Dud Game";
  await reset(game);
  const decidedAt = hoursAgo(80);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 4,
    sellers: 25,
  });
  const task = {
    game,
    campaignId: "c3",
    decision: "skip_low_demand",
    // 4 market + 0 sales boost = 4 effective.
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.replayed.skip, true);
});

test("a demand figure that does not reproduce is inconclusive, not a disagreement", async () => {
  // If the replayed effective demand misses the recorded one, the likeliest
  // explanation is a missing input, not the engines differing. Calling that a
  // disagreement would block a promotion on our own reconstruction gap.
  const game = "Mismatch Game";
  await reset(game);
  const decidedAt = hoursAgo(80);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 4,
    sellers: 25,
  });
  const task = {
    game,
    campaignId: "c4",
    decision: "skip_low_demand",
    demandScore: 17, // not what a replay of these inputs produces
    hadResearch: true,
    internalSales: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "inconclusive", out.detail);
  assert.match(out.detail, /missing an input rather than the engines disagreeing/);
});

test("a real economics disagreement IS caught", async () => {
  // A high-demand game the legacy engine recorded as a sellability skip. The
  // replay wants to farm it, and that is a genuine contradiction rather than a
  // reconstruction gap.
  const game = "Should Farm Game";
  await reset(game);
  const decidedAt = hoursAgo(80);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 12,
  });
  const task = {
    game,
    campaignId: "c5",
    decision: "skip_low_demand",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "disagree", out.detail);
  assert.match(out.detail, /legacy skipped at the sellability gate/);
});

test("a downstream decision is scored only on the stage replay can see", async () => {
  // skip_already_covered is settled by the coverage gate, which reads live
  // archive inventory that nobody snapshots. All replay can legitimately assert
  // is that the sellability stage PASSED — as it must have, for the legacy
  // engine to have reached the coverage gate at all.
  const game = "Covered Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 70,
    sellers: 8,
  });
  const task = {
    game,
    campaignId: "c6",
    decision: "skip_already_covered",
    demandScore: 70,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.downstream, true, "flagged as scored on the stage only");
});

test("the recorded tier target is checked when there is one", async () => {
  const game = "Target Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 8,
  });
  const task = {
    game,
    campaignId: "c7",
    decision: "farm",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    // Deliberately wrong: a proven seller's tier target is the cap (30), not 3.
    targetAccounts: 3,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "disagree", out.detail);
  assert.match(out.detail, /tier target differs/);
});

test("probe decisions are only PARTIAL fidelity when cold-start probing is on", async () => {
  // The concurrent-probe budget counts tasks by their CURRENT status, so how
  // many games were probing at a past moment is not recoverable. That has to
  // downgrade the row rather than being quietly assumed.
  const game = "Cold Start Game";
  await reset(game);
  const task = {
    game,
    campaignId: "c8",
    decision: "probe",
    demandScore: null,
    internalSales: 0,
    decidedAt: hoursAgo(30),
  };
  const on = await replay.probeGateFor(task, { af: { ...AF, probeColdStart: true } });
  assert.equal(on.fidelity, replay.FIDELITY.PARTIAL);
  assert.ok(on.gaps.includes("probe_budget_unreconstructable"));

  const off = await replay.probeGateFor(task, { af: AF });
  assert.equal(off.fidelity, replay.FIDELITY.EXACT);
});

// --- The probe gate is only load-bearing on two branches --------------------
//
// Prod, 2026-09-04: probeColdStart is ON there, so probeGateFor downgraded every
// one of 363 rows to partial and the harness scored nothing. The budget half of
// the gate really is unreconstructable — but demandAllocation only READS
// probeAllowed on two branches. Everywhere else the unknown value cannot change
// the output, so the row is exact. Measured on those 363 rows: 53 had no
// snapshot (unreplayable, correctly), 27 sat on a probe-reachable branch
// (partial, correctly), 283 did not (78%) — and those must score exact.

const COLD_START = { ...AF, probeColdStart: true, probeMaxSellers: 1 };

test("THE PROD CASE: research, sellers > probeMaxSellers, d below the half tier is EXACT with cold-start ON", async () => {
  // Below the demand floor WITH real rivals selling: the market has spoken, it
  // is a plain skip, and probeAllowed is never consulted. The unreconstructable
  // probe budget cannot touch this row.
  const game = "Rival Heavy Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 4,
    sellers: 25, // > probeMaxSellers (1): a proven dud, not an untested market
  });
  const task = {
    game,
    campaignId: "p1",
    decision: "skip_low_demand",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: COLD_START });
  assert.equal(out.fidelity, replay.FIDELITY.EXACT, (out.gaps || []).join(","));
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.probeGateMatters, false, "checked, and found irrelevant for these inputs");
  assert.ok(!(out.gaps || []).includes("probe_budget_unreconstructable"));
});

test("high demand with cold-start ON is exact too — the tier is settled before probing is considered", async () => {
  const game = "Proven Cold Start Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 0, // few sellers, but irrelevant: d is far above the floor
  });
  const task = {
    game,
    campaignId: "p2",
    decision: "farm",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 30,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: COLD_START });
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.probeGateMatters, false);
});

test("a probe-REACHABLE branch stays partial: sub-floor score with an untested market", async () => {
  // sellers <= probeMaxSellers and d below the floor is exactly where
  // probeAllowed decides probe-vs-skip, and the budget half of it cannot be
  // rebuilt. The honest answer is partial — reported, never counted.
  const game = "Untested Cold Start Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 4,
    sellers: 0,
  });
  const task = {
    game,
    campaignId: "p3",
    decision: "probe",
    demandScore: 4,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 5,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: COLD_START });
  assert.equal(out.fidelity, replay.FIDELITY.PARTIAL);
  assert.equal(out.probeGateMatters, true);
  assert.ok(out.gaps.includes("probe_budget_unreconstructable"));
});

test("no market data and no sales is probe-reachable as well — partial", async () => {
  // The other branch that reads probeAllowed: an unscanned game with no own
  // sales is the original unknown-game probe.
  const game = "Never Scanned Cold Start Game";
  await reset(game);
  const task = {
    game,
    campaignId: "p4",
    decision: "probe",
    demandScore: null,
    hadResearch: false,
    internalSales: 0,
    decidedAt: hoursAgo(30),
  };
  const out = await replay.replayDecision(task, { af: COLD_START });
  assert.equal(out.fidelity, replay.FIDELITY.PARTIAL);
  assert.equal(out.probeGateMatters, true);
});

test("probeGateLoadBearing asks the economics rather than restating them", () => {
  const rivals = { demandScore: 4, sellers: 25, scannedAt: new Date() };
  const untested = { demandScore: 4, sellers: 0, scannedAt: new Date() };
  const proven = { demandScore: 90, sellers: 0, scannedAt: new Date() };
  const none = { count: 0, revenue: 0, avgPrice: 0 };
  assert.equal(replay.probeGateLoadBearing(rivals, COLD_START, none), false);
  assert.equal(replay.probeGateLoadBearing(untested, COLD_START, none), true);
  assert.equal(replay.probeGateLoadBearing(proven, COLD_START, none), false);
  assert.equal(replay.probeGateLoadBearing(null, COLD_START, none), true, "no market data probes");
  // With cold-start OFF the sub-floor branch never probes, so probeAllowed is
  // dead there — but the original no-market-data probe predates the cold-start
  // switch and reads it regardless. Both are the economics' answer, not ours.
  assert.equal(replay.probeGateLoadBearing(untested, AF, none), false);
  assert.equal(replay.probeGateLoadBearing(null, AF, none), true);
});

test("when the probe gate is irrelevant the row drops the gap and the summary scores it", async () => {
  const game = "Scored Cold Start Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 3,
    sellers: 40,
  });
  for (let i = 0; i < 3; i += 1) {
    await AutoFarmTask.create({
      game,
      campaignId: "s" + i,
      decision: "skip_low_demand",
      status: "skipped",
      demandScore: 3,
      hadResearch: true,
      internalSales: 0,
      decidedAt,
    });
  }
  const report = await replay.replayHistory({ game, af: COLD_START });
  assert.equal(report.examined, 3);
  assert.equal(report.scored, 3, "exact rows are scored");
  assert.equal(report.agree, 3);
  assert.equal(
    report.gapCounts.probe_budget_unreconstructable,
    undefined,
    "the gap is gone from the breakdown for rows it cannot affect",
  );
});

// --- The row's own fields are not inputs ----------------------------------
//
// Prod, 2026-09-04, second run: 315 scored of 364, 38 disagreements — and 15 of
// them false. All Black Desert, all reuse_existing, all "legacy passed the
// sellability gate but the replay skips". The rows recorded internalSales 0;
// SaleSignal held 13 sales at $1.75; demandAllocation with 13 sales does not
// skip, with 0 it does. The live shadow lane, reading SaleSignal, agreed with
// legacy every time. The replay was wrong, because it trusted a field that
// legacy's record() never writes on the reuse path.

// Thirteen distinct unit sales of one game, all inside the 45-day window and
// all BEFORE `before`. listing_sold rows carry no account, so
// internalSalesForGame groups them by dedupeKey — one sale each.
async function thirteenSales(game, before) {
  const rows = [];
  for (let i = 0; i < 13; i += 1) {
    rows.push({
      game,
      gameKey: game.toLowerCase(),
      source: "listing_sold",
      dedupeKey: `${game}-unit-${i}`,
      account: null,
      priceUsd: 1.75,
      at: new Date(before.getTime() - (i + 1) * 5 * 3600000), // 5h..65h before the decision
    });
  }
  await SaleSignal.insertMany(rows);
}

test("THE BLACK DESERT CASE: a reuse_existing row's internalSales 0 is ignored — sales come from SaleSignal", async () => {
  const game = "Black Desert Case";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 3.7,
    sellers: 10,
  });
  await thirteenSales(game, decidedAt);
  const task = {
    game,
    campaignId: "bd1",
    decision: "reuse_existing",
    demandScore: 3.7,
    hadResearch: true,
    internalSales: 0, // never written on this path — the schema default
    targetAccounts: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.salesBasis, "window_unchanged", "sales were taken from SaleSignal, not the row");
  assert.equal(out.salesCount, 13, "the thirteen sales were seen");
  assert.equal(out.replayed.skip, false, "with the real sales the sellability gate passes");
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.equal(out.verdict, "agree", out.detail);
});

test("...and if a sale landed AFTER the decision the row is unreplayable, never a disagreement", async () => {
  // Same row, but the world moved: one more sale since. On a path that does not
  // write internalSales we then know neither the count nor the price at T.
  // The honest answer is "cannot tell", not "the lane is wrong".
  const game = "Black Desert Drifted";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 3.7,
    sellers: 10,
  });
  await thirteenSales(game, decidedAt);
  await SaleSignal.create({
    game,
    gameKey: game.toLowerCase(),
    source: "listing_sold",
    dedupeKey: `${game}-late`,
    account: null,
    priceUsd: 1.75,
    at: hoursAgo(1),
  });
  const task = {
    game,
    campaignId: "bd2",
    decision: "reuse_existing",
    demandScore: 3.7,
    hadResearch: true,
    internalSales: 0,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "unreplayable");
  assert.ok(out.gaps.includes("sales_window_drifted"));
  assert.match(out.notes.join(" "), /never writes internalSales/);
  assert.notEqual(out.verdict, "disagree", "a false disagreement is worse than an unscored row");
});

test("a recorded internalSales that contradicts SaleSignal, on a path that WRITES it, is an integrity failure", async () => {
  // skip_ends_soon does write internalSales. The row says 5; SaleSignal has
  // nothing and the window has not moved. The two were produced by the same
  // aggregation, so they cannot legitimately differ — an assumption is wrong
  // and the row must not be scored either way.
  const game = "Integrity Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 5,
  });
  const task = {
    game,
    campaignId: "ig1",
    decision: "skip_ends_soon",
    demandScore: 90,
    hadResearch: true,
    internalSales: 5,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.verdict, "unreplayable");
  assert.ok(out.gaps.includes("sales_count_mismatch"));
});

test("a recorded zero on a path that writes it stays exact even after later sales", async () => {
  // The legitimate half of the old shortcut. farm writes internalSales; it
  // recorded 0; the boost was 0 and the cap at base regardless of price. A sale
  // since cannot change what the decision saw.
  const game = "Recorded Zero Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 5,
  });
  await SaleSignal.create({
    game,
    gameKey: game.toLowerCase(),
    source: "listing_sold",
    dedupeKey: `${game}-late`,
    account: null,
    priceUsd: 9,
    at: hoursAgo(1),
  });
  const task = {
    game,
    campaignId: "rz1",
    decision: "farm",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 30,
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.salesBasis, "recorded_zero");
  assert.equal(out.fidelity, replay.FIDELITY.EXACT);
  assert.equal(out.verdict, "agree", out.detail);
});

test("a stale targetAccounts on a reuse_existing row is not checked — legacy never writes it there", async () => {
  // The sibling bug. This row was once a probe (targetAccounts 3) and was later
  // re-decided as reuse_existing, which does not touch the field. Comparing the
  // replayed tier target (30) against that leftover 3 would be a false
  // "tier target differs".
  const game = "Stale Target Game";
  await reset(game);
  const decidedAt = hoursAgo(30);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 90,
    sellers: 5,
  });
  const task = {
    game,
    campaignId: "st1",
    decision: "reuse_existing",
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    targetAccounts: 3, // leftover from an earlier probe decision on this row
    decidedAt,
  };
  const out = await replay.replayDecision(task, { af: AF });
  assert.equal(out.legacyTarget, null, "not evidence on this path");
  assert.equal(out.verdict, "agree", out.detail);
  assert.equal(out.downstream, true);
});

test("which fields each legacy path writes is pinned", () => {
  // From utils/autoFarmer.js processCampaign/executeTask record() calls.
  assert.equal(classes.recordsInternalSales("reuse_existing"), false);
  assert.equal(classes.recordsInternalSales("skip_host_offline"), false);
  for (const d of ["farm", "probe", "skip_low_demand", "skip_probe_budget", "skip_ends_soon",
    "skip_already_covered", "skip_no_accounts", "skip_no_capacity", "skip_reuse_only"]) {
    assert.equal(classes.recordsInternalSales(d), true, `${d} writes internalSales`);
  }
  assert.equal(classes.recordsInternalSales("not_a_decision"), false, "unknown paths write nothing");

  for (const d of ["farm", "probe", "skip_reuse_only"]) {
    assert.equal(classes.recordsTargetAccounts(d), true, `${d} writes targetAccounts`);
  }
  for (const d of ["reuse_existing", "skip_host_offline", "skip_ends_soon", "skip_already_covered",
    "skip_no_accounts", "skip_no_capacity", "skip_low_demand", "skip_probe_budget"]) {
    assert.equal(classes.recordsTargetAccounts(d), false, `${d} does not write targetAccounts`);
  }
});

test("disagreements are broken down by kind in the summary", () => {
  const s = replay.summarise([
    { game: "G", verdict: "disagree", fidelity: replay.FIDELITY.EXACT, kind: "tier_target", detail: "a" },
    { game: "G", verdict: "disagree", fidelity: replay.FIDELITY.EXACT, kind: "tier_target", detail: "b" },
    { game: "G", verdict: "disagree", fidelity: replay.FIDELITY.EXACT, kind: "legacy_passed_replay_skips", detail: "c" },
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.EXACT },
  ]);
  assert.deepEqual(s.disagreementKinds, { tier_target: 2, legacy_passed_replay_skips: 1 });
  assert.equal(s.disagreements[0].kind, "tier_target");
});

// --- The summary and the gate ---------------------------------------------

test("only EXACT-fidelity rows count as evidence in the summary", () => {
  const s = replay.summarise([
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.EXACT },
    { game: "G", verdict: "agree", fidelity: replay.FIDELITY.PARTIAL },
    { game: "G", verdict: "disagree", fidelity: replay.FIDELITY.EXACT, detail: "d" },
    { game: "G", verdict: "unreplayable", fidelity: replay.FIDELITY.UNREPLAYABLE, gaps: ["x"] },
    { game: "G", verdict: "inconclusive", fidelity: replay.FIDELITY.EXACT },
  ]);
  assert.equal(s.examined, 5);
  assert.equal(s.scored, 2, "the partial agreement is reported but not counted");
  assert.equal(s.agree, 1);
  assert.equal(s.disagree, 1);
  assert.equal(s.partialFidelity, 1);
  assert.equal(s.unreplayable, 1);
  assert.equal(s.inconclusive, 1);
  assert.equal(s.gapCounts.x, 1, "the reason a row was dropped is always reported");
});

test("replayHistory walks recorded decisions and groups them per game", async () => {
  const game = "History Game";
  await reset(game);
  const decidedAt = hoursAgo(60);
  await MarketResearchSnapshot.create({
    game,
    gameKey: game.toLowerCase(),
    at: new Date(decidedAt.getTime() - 3600000),
    demandScore: 3,
    sellers: 30,
  });
  for (let i = 0; i < 3; i += 1) {
    await AutoFarmTask.create({
      game,
      campaignId: "h" + i,
      decision: "skip_low_demand",
      status: "skipped",
      demandScore: 3,
      hadResearch: true,
      internalSales: 0,
      decidedAt,
    });
  }
  const report = await replay.replayHistory({ game, af: AF });
  assert.equal(report.examined, 3);
  assert.equal(report.scored, 3);
  assert.equal(report.agree, 3);
  assert.equal(report.disagree, 0);
  assert.equal(report.perGame[game].agree, 3);
  assert.ok(report.afAssumed, "the settings the replay assumed are recorded");
});

test("replay disagreements block promotion", async () => {
  await FarmJob.deleteMany({ laneKey: "replay gate" });
  await FarmLane.deleteMany({ gameKey: "replay gate" });
  const lane = await FarmLane.create({
    game: "Replay Gate",
    gameKey: "replay gate",
    mode: "shadow",
  });
  // Enough agreeing shadow evidence to pass the existing gate on its own.
  for (let i = 0; i < 3; i += 1) {
    await FarmJob.create({
      lane: "Replay Gate",
      laneKey: "replay gate",
      kind: "decide",
      campaignId: "rg" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "farm" },
        diff: { agree: true, laneClass: "spend", legacyClass: "spend", stale: false },
      },
    });
  }
  const clean = await farm2.laneReadiness(lane.toObject());
  assert.equal(clean.ready, true, "baseline: shadow evidence alone passes");

  const withReplay = await farm2.laneReadiness(lane.toObject(), {
    replay: {
      examined: 40,
      scored: 30,
      agree: 28,
      disagree: 2,
      unreplayable: 10,
      inconclusive: 0,
      disagreements: [
        { legacyDecision: "skip_low_demand", detail: "replay wants farm 30" },
        { legacyDecision: "farm", detail: "tier target differs" },
      ],
    },
  });
  assert.equal(withReplay.ready, false, "a replay disagreement is a blocker");
  assert.match(withReplay.blockers.join(" "), /did not reproduce/);
  assert.equal(withReplay.replay.disagree, 2);
});

test("requireReplay makes missing replay evidence a blocker, not a caveat", async () => {
  await FarmJob.deleteMany({ laneKey: "require replay" });
  await FarmLane.deleteMany({ gameKey: "require replay" });
  const lane = await FarmLane.create({
    game: "Require Replay",
    gameKey: "require replay",
    mode: "shadow",
  });
  for (let i = 0; i < 3; i += 1) {
    await FarmJob.create({
      lane: "Require Replay",
      laneKey: "require replay",
      kind: "decide",
      campaignId: "rr" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "farm" },
        diff: { agree: true, laneClass: "spend", legacyClass: "spend", stale: false },
      },
    });
  }
  const off = await farm2.laneReadiness(lane.toObject());
  assert.equal(off.ready, true);
  assert.match(off.caveats.join(" "), /no replay evidence/);

  const on = await farm2.laneReadiness(lane.toObject(), { requireReplay: true });
  assert.equal(on.ready, false);
  assert.match(on.blockers.join(" "), /no replay evidence supplied/);
});

test("with every gate implemented, the vocabulary caveat no longer fires", async () => {
  await FarmJob.deleteMany({ laneKey: "caveat lane" });
  await FarmLane.deleteMany({ gameKey: "caveat lane" });
  const lane = await FarmLane.create({
    game: "Caveat Lane",
    gameKey: "caveat lane",
    mode: "shadow",
  });
  const r = await farm2.laneReadiness(lane.toObject());
  assert.doesNotMatch(r.caveats.join(" "), /cannot emit/, "the gap is closed — no standing caveat");
  // The OTHER caveat — no replay evidence supplied — is still expected.
  assert.match(r.caveats.join(" "), /no replay evidence/);
});

test("a disagreement from a missing gate is reported as a feature gap", async () => {
  await FarmJob.deleteMany({ laneKey: "gap lane" });
  await FarmLane.deleteMany({ gameKey: "gap lane" });
  const lane = await FarmLane.create({ game: "Gap Lane", gameKey: "gap lane", mode: "shadow" });
  for (let i = 0; i < 3; i += 1) {
    await FarmJob.create({
      lane: "Gap Lane",
      laneKey: "gap lane",
      kind: "decide",
      campaignId: "gl" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "farm" },
        diff: {
          agree: false,
          laneDecision: "farm",
          legacyDecision: "skip_already_covered",
          laneClass: "spend",
          legacyClass: "skip",
          stale: false,
          disagreementKind: "lane_missing_gate",
        },
      },
    });
  }
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.ready, false);
  assert.equal(r.disagreementKinds.lane_missing_gate, 3);
  assert.match(r.blockers.join(" "), /missing feature, not a mystery/);
});

test("a disagreement with no kind is counted as unclassified, not benign", async () => {
  // Same discipline as the laneClass and stale checks: a row that predates the
  // taxonomy has not passed it.
  await FarmJob.deleteMany({ laneKey: "unclassified lane" });
  await FarmLane.deleteMany({ gameKey: "unclassified lane" });
  const lane = await FarmLane.create({
    game: "Unclassified Lane",
    gameKey: "unclassified lane",
    mode: "shadow",
  });
  await FarmJob.create({
    lane: "Unclassified Lane",
    laneKey: "unclassified lane",
    kind: "decide",
    campaignId: "u1",
    status: "done",
    shadow: true,
    result: {
      verdict: { decision: "farm" },
      diff: {
        agree: false,
        laneDecision: "farm",
        legacyDecision: "reuse_existing",
        laneClass: "spend",
        legacyClass: "reuse",
        stale: false,
      },
    },
  });
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.disagreementKinds.unclassified, 1);
  assert.equal(r.ready, false);
});
