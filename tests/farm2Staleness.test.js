// Coverage for the comparison staleness gate (utils/farm2/steps/decide.js).
//
// The live trial produced ten "disagreements" between the lane and the legacy
// engine. Every one of them was both engines being RIGHT — for different
// moments. The legacy engine had decided those campaigns 41 to 229 hours
// earlier and, once it acts on a campaign, it never re-decides it:
//
//   legacy said `probe` 171h ago when a game was untested; the probe found no
//   sales, so the lane now correctly says skip_low_demand
//   legacy said `farm` 229h ago when the game had no bots; it created them, so
//   the lane now correctly says reuse_existing
//
// Comparing a fresh decision against a days-old one is not evidence. Counting
// those as disagreement would block promotion forever; counting the stale
// AGREEMENTS would inflate confidence just as wrongly. Both must be excluded.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const decideStep = require("../utils/farm2/steps/decide");
const farm2 = require("../utils/farm2");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2stale"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);

async function legacyTask(game, campaignId, decision, decidedAt) {
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.create({
    game,
    campaignId,
    decision,
    status: "active",
    plannedAccounts: 10,
    decidedAt,
  });
}

test("a legacy decision inside the window is comparable", async () => {
  await legacyTask("Fresh Game", "c1", "reuse_existing", hoursAgo(1));
  const d = await decideStep.diffAgainstLegacy({
    game: "Fresh Game",
    campaignId: "c1",
    decision: "reuse_existing",
    plannedAccounts: 10,
  });
  assert.equal(d.stale, false);
  assert.equal(d.agree, true);
  assert.equal(d.legacyAgeHours, 1);
});

test("the exact trial case — legacy probed 171h ago, lane now skips — is NOT a disagreement", async () => {
  await legacyTask("Plants on Fire", "c2", "probe", hoursAgo(171));
  const d = await decideStep.diffAgainstLegacy({
    game: "Plants on Fire",
    campaignId: "c2",
    decision: "skip_low_demand",
    plannedAccounts: 0,
  });
  assert.equal(d.stale, true);
  assert.equal(d.agree, null, "not comparable — not evidence in either direction");
  assert.equal(d.legacyAgeHours, 171);
});

test("the other trial case — legacy farmed 229h ago, lane now reuses — is NOT a disagreement", async () => {
  await legacyTask("NBA 2K27", "c3", "farm", hoursAgo(229));
  const d = await decideStep.diffAgainstLegacy({
    game: "NBA 2K27",
    campaignId: "c3",
    decision: "reuse_existing",
    plannedAccounts: 3,
  });
  assert.equal(d.stale, true);
  assert.equal(d.agree, null);
});

test("a stale AGREEMENT is excluded too, not just a stale disagreement", async () => {
  // Symmetry matters: counting stale agreements would inflate confidence and
  // let a lane be promoted on comparisons that were never valid.
  await legacyTask("Stale Agree", "c4", "reuse_existing", hoursAgo(200));
  const d = await decideStep.diffAgainstLegacy({
    game: "Stale Agree",
    campaignId: "c4",
    decision: "reuse_existing",
    plannedAccounts: 5,
  });
  assert.equal(d.stale, true);
  assert.equal(d.agree, null, "a stale agreement is not evidence either");
});

test("a legacy row with no decidedAt at all is treated as stale", async () => {
  await AutoFarmTask.deleteMany({ game: "No Date" });
  await AutoFarmTask.create({
    game: "No Date",
    campaignId: "c5",
    decision: "farm",
    status: "active",
  });
  const d = await decideStep.diffAgainstLegacy({
    game: "No Date",
    campaignId: "c5",
    decision: "farm",
    plannedAccounts: 1,
  });
  assert.equal(d.stale, true, "unknown age cannot be assumed fresh");
});

test("the readiness gate ignores stale rows and says so", async () => {
  await FarmJob.deleteMany({ laneKey: "stale lane" });
  await FarmLane.deleteMany({ gameKey: "stale lane" });
  const lane = await FarmLane.create({ game: "Stale Lane", gameKey: "stale lane", mode: "shadow" });
  // Five stale rows that all "agree" — the shape that would otherwise have let
  // a lane sail through the gate on comparisons made days apart.
  for (let i = 0; i < 5; i += 1) {
    await FarmJob.create({
      lane: "Stale Lane",
      laneKey: "stale lane",
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "reuse_existing" },
        diff: { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: true },
      },
    });
  }
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.compared, 0, "none of them count");
  assert.equal(r.stale, 5, "but they are reported, so the gap is explainable");
  assert.equal(r.ready, false);
  assert.match(r.blockers.join(" "), /too old to be evidence/i);
});
