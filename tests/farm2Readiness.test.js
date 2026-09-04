// Coverage for one specific property of the promotion gate: it must not accept
// evidence produced by the comparison logic it replaced.
//
// When the action-class diff shipped, the three live lanes already had job rows
// scored by the OLD intent grouping — the one that called "lane wants to spend
// fresh accounts" and "legacy reused warm bots" an agreement. Those rows carry
// agree: true. Counting them would let a lane be promoted on exactly the
// evidence that motivated the gate, and on prod all three lanes briefly showed
// ready=true for that reason.
//
// `laneClass` is only written by the current diff, so its presence is the marker
// that a comparison is trustworthy.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const farm2 = require("../utils/farm2");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2readiness"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function laneWith(key, diffs) {
  await FarmJob.deleteMany({ laneKey: key });
  await FarmLane.deleteMany({ gameKey: key });
  const lane = await FarmLane.create({ game: key, gameKey: key, mode: "shadow" });
  for (let i = 0; i < diffs.length; i += 1) {
    await FarmJob.create({
      lane: key,
      laneKey: key,
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      result: { verdict: { decision: "farm" }, diff: diffs[i] },
    });
  }
  return lane.toObject();
}

test("rows from the OLD diff logic are not counted as evidence", async () => {
  // Exactly the prod situation: four "agreeing" rows, all scored by the old
  // intent grouping (no laneClass).
  const lane = await laneWith("old evidence", [
    { agree: true },
    { agree: true },
    { agree: true },
    { agree: true },
  ]);
  const r = await farm2.laneReadiness(lane);
  assert.equal(r.compared, 0, "none of them are comparable under the current logic");
  assert.equal(r.ready, false, "so the lane cannot be promoted on them");
  assert.match(r.blockers.join(" "), /comparable against the legacy engine/i);
  // The message must explain the discrepancy, or an operator sees "4 recorded"
  // in one place and "0 comparable" in another with no way to reconcile them.
  assert.match(r.blockers.join(" "), /predate the current comparison logic/i);
  assert.equal(r.shadowDecisions, 4, "the raw count is still reported");
});

test("rows from the CURRENT diff logic do count", async () => {
  const lane = await laneWith("new evidence", [
    { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: false },
    { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: false },
    { agree: true, laneClass: "skip", legacyClass: "skip", stale: false },
  ]);
  const r = await farm2.laneReadiness(lane);
  assert.equal(r.compared, 3);
  assert.equal(r.disagreements, 0);
  assert.equal(r.ready, true, "blockers: " + r.blockers.join("; "));
});

test("a mix counts only the trustworthy rows", async () => {
  const lane = await laneWith("mixed evidence", [
    { agree: true }, // old
    { agree: true }, // old
    { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: false }, // new
  ]);
  const r = await farm2.laneReadiness(lane);
  assert.equal(r.compared, 1, "only the current-logic row counts");
  assert.equal(r.ready, false, "one comparison is below the threshold");
});

test("a pending row (no legacy decision yet) is not evidence either", async () => {
  // diffAgainstLegacy returns null when the legacy engine has not decided that
  // campaign. That is a normal transient state, not agreement.
  const lane = await laneWith("pending evidence", [
    null,
    null,
    { agree: true, laneClass: "reuse", legacyClass: "reuse", stale: false },
  ]);
  const r = await farm2.laneReadiness(lane);
  assert.equal(r.compared, 1);
  assert.equal(r.ready, false);
});
