// Coverage for the reuse-first path, the notional shadow budget, and the
// tightened action-class diff.
//
// All three exist because of one finding from the live shadow trial on
// 2026-09-04: Albion Online, World of Tanks and Black Desert were ALL being
// served by the legacy engine as `reuse_existing` (restart warm bots, spend
// nothing), while the lane engine decided `farm` (claim fresh pool accounts,
// burn a container slot) — and the comparison reported that as AGREEMENT,
// because the original diff lumped both into one "act" class.
//
// Promoting on that evidence would have spent real accounts to do something
// strictly worse than what was already running. These tests pin all three
// halves of the fix.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const { BudgetCycle } = require("../utils/farm2/budget");
const farm2 = require("../utils/farm2");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2reuse"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

/* ------------------------- the action-class diff -------------------------- */

test("farm vs reuse_existing is a DISAGREEMENT, not agreement", async () => {
  await AutoFarmTask.deleteMany({ game: "Diff Game" });
  await AutoFarmTask.create({
    game: "Diff Game",
    campaignId: "c-diff",
    decision: "reuse_existing",
    status: "active",
    plannedAccounts: 18,
  });
  const diff = await decideStep.diffAgainstLegacy({
    game: "Diff Game",
    campaignId: "c-diff",
    decision: "farm",
    plannedAccounts: 12,
  });
  assert.equal(diff.laneClass, "spend");
  assert.equal(diff.legacyClass, "reuse");
  assert.equal(
    diff.agree,
    false,
    "spending fresh accounts is NOT the same action as reusing warm bots",
  );
});

test("reuse vs reuse agrees, and farm vs probe still agrees", async () => {
  await AutoFarmTask.deleteMany({ game: "Diff Game 2" });
  await AutoFarmTask.create({
    game: "Diff Game 2",
    campaignId: "c-r",
    decision: "reuse_existing",
    status: "active",
  });
  const same = await decideStep.diffAgainstLegacy({
    game: "Diff Game 2",
    campaignId: "c-r",
    decision: "reuse_existing",
    plannedAccounts: 18,
  });
  assert.equal(same.agree, true);

  await AutoFarmTask.deleteMany({ game: "Diff Game 3" });
  await AutoFarmTask.create({
    game: "Diff Game 3",
    campaignId: "c-p",
    decision: "probe",
    status: "active",
  });
  const spend = await decideStep.diffAgainstLegacy({
    game: "Diff Game 3",
    campaignId: "c-p",
    decision: "farm",
    plannedAccounts: 5,
  });
  assert.equal(spend.agree, true, "farm and probe are both 'spend fresh accounts'");
});

test("every skip_* reason is one class", async () => {
  await AutoFarmTask.deleteMany({ game: "Skip Game" });
  await AutoFarmTask.create({
    game: "Skip Game",
    campaignId: "c-s",
    decision: "skip_ends_soon",
    status: "skipped",
  });
  const d = await decideStep.diffAgainstLegacy({
    game: "Skip Game",
    campaignId: "c-s",
    decision: "skip_low_demand",
    plannedAccounts: 0,
  });
  assert.equal(d.agree, true, "both mean 'spend nothing'");
});

/* -------------------------- the readiness gate ---------------------------- */

test("a disagreement now BLOCKS promotion instead of only warning", async () => {
  await FarmJob.deleteMany({});
  await FarmLane.deleteMany({ gameKey: "block me" });
  const lane = await FarmLane.create({ game: "Block Me", gameKey: "block me", mode: "shadow" });
  for (let i = 0; i < 5; i += 1) {
    await FarmJob.create({
      lane: "Block Me",
      laneKey: "block me",
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      result: {
        verdict: { decision: "farm" },
        // The exact shape the trial produced: lane wants to spend, legacy reused.
        diff: {
          agree: i === 0 ? false : true,
          laneDecision: "farm",
          legacyDecision: "reuse_existing",
          accountDelta: 12,
        },
      },
    });
  }
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.ready, false, "one disagreement is enough to block");
  assert.match(r.blockers.join(" "), /disagreed with the legacy engine/i);
  assert.match(r.blockers.join(" "), /farm vs legacy reuse_existing/i);
});

/* ------------------------ the notional shadow budget ---------------------- */

test("a forked budget gives shadow lanes real numbers without touching the real ledger", () => {
  const real = new BudgetCycle({ accounts: 30, seats: 40, containers: 4, perGameCap: 18 });
  real.allocate([{ key: "live-lane", want: 18, weight: 2 }]);

  const notional = real.fork("shadow");
  notional.allocate([
    { key: "shadow-a", want: 18, weight: 1 },
    { key: "shadow-b", want: 18, weight: 1 },
  ]);

  // The whole point: a shadow lane's number is no longer 0.
  assert.ok(notional.grantFor("shadow-a").accounts > 0, "shadow lanes get a realistic grant");
  assert.equal(notional.summary().notional, true);

  // And it did not come out of the real ledger.
  assert.equal(real.grantFor("shadow-a").accounts, 0, "the real cycle never heard of it");
  assert.equal(real.grantFor("live-lane").accounts, 18, "the live grant is untouched");
  const realTotal = Object.values(real.summary().grants).reduce((s, g) => s + g.accounts, 0);
  assert.ok(realTotal <= 30, "the real budget invariant still holds");
});

test("the forked budget shares the host semaphore with the real one", async () => {
  const real = new BudgetCycle({ accounts: 10, seats: 10, containers: 1, perGameCap: 5, hostConcurrency: 1 });
  const notional = real.fork();
  let inFlight = 0;
  let peak = 0;
  const task = (c) =>
    c.withHost(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    });
  // Host concurrency is a physical limit on the Pi — shadow reads consume it
  // exactly as live ones do, so the fork must NOT get its own extra slots.
  await Promise.all([task(real), task(notional), task(real), task(notional)]);
  assert.ok(peak <= 1, `peak ${peak} must respect the shared limit of 1`);
});

/* --------------------------- reuse execution ------------------------------ */

test("a reuse decision does NOT go down the fresh-spend path", async () => {
  await AutoFarmTask.deleteMany({ game: "Reuse Exec" });
  const source = await AutoFarmTask.create({
    game: "Reuse Exec",
    campaignId: "c-old",
    decision: "farm",
    status: "active",
    assignedAccounts: ["acc1", "acc2", "acc3"],
    bots: [{ host: "pi", file: "config_1.json", container: "twitchbotx1" }],
  });

  const r = await executeStep.executeReuse({
    verdict: {
      game: "Reuse Exec",
      campaignId: "c-new",
      decision: "reuse_existing",
      reuseTaskId: source._id,
      reason: "recurring campaign",
    },
    dryRun: true,
  });
  assert.equal(r.reuse, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.wouldRestart, ["twitchbotx1"], "it restarts the warm bot");
  assert.equal(r.wouldReuseAccounts, 3, "and reuses its accounts rather than claiming new ones");
});

test("reuse never double-counts accounts another live task already owns", async () => {
  await AutoFarmTask.deleteMany({ game: /Reuse Share/ });
  const source = await AutoFarmTask.create({
    game: "Reuse Share A",
    campaignId: "c-src",
    decision: "farm",
    status: "active",
    assignedAccounts: ["shared1", "shared2", "free1"],
    bots: [{ host: "pi", file: "c.json", container: "botA" }],
  });
  // Another ACTIVE task already advertises two of those logins.
  await AutoFarmTask.create({
    game: "Reuse Share B",
    campaignId: "c-other",
    decision: "farm",
    status: "active",
    assignedAccounts: ["shared1", "SHARED2"], // case differs on purpose
  });

  const r = await executeStep.executeReuse({
    verdict: {
      game: "Reuse Share A",
      campaignId: "c-new",
      decision: "reuse_existing",
      reuseTaskId: source._id,
    },
    dryRun: true,
  });
  // Listing quantity is derived from assignedAccounts, so counting a login twice
  // would advertise stock that cannot be delivered twice — the buyer pays and
  // there is nothing to fulfil.
  assert.equal(r.wouldReuseAccounts, 1, "only the genuinely free login counts");
});

test("reuse fails loudly when its target is gone", async () => {
  await assert.rejects(
    () =>
      executeStep.executeReuse({
        verdict: {
          game: "Nothing",
          campaignId: "c",
          decision: "reuse_existing",
          reuseTaskId: new mongoose.Types.ObjectId(),
        },
        dryRun: true,
      }),
    /no longer exists/i,
  );
});
