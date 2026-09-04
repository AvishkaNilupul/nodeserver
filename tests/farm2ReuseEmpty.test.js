// An ACTIVE task with no accounts is not harmless.
//
// 2026-09-04, production, World of Tanks (live lane, reuse-only game): three
// campaigns arrived within two seconds. executeReuse served the first by
// reusing all 18 warm accounts. For the other two, `mine` came out 0 — every
// account was spoken for by the first — and the step STILL wrote ACTIVE rows
// with plannedAccounts 0 and targetAccounts 0. Legacy's backfillActiveTasks
// read both as "under target" and topped each up with 18 FRESH pool accounts.
// 36 fresh accounts on a reuse-only game, all deployed, none recoverable.
//
// The rule: any row shape the lane writes must be one legacy already produces.
// Legacy's fleet sweeps read status "active" and act on it, so an invented
// shape is acted on too. These tests pin the fix and the invariant.
//
// The real, non-dry-run executeReuse is driven here. Its two host touches are
// botFactory.startContainer and botWaker.readRegistry, both plain module
// exports read at call time; they are stubbed so nothing is restarted and the
// number of restart attempts can be counted.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const executeStep = require("../utils/farm2/steps/execute");
const botFactory = require("../utils/botFactory");
const botWaker = require("../utils/botWaker");
const settings = require("../utils/settings");

let mem;
const origStart = botFactory.startContainer;
const origRegistry = botWaker.readRegistry;
let restarts = 0;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2reuseempty"));
  await FarmJob.init();
  botFactory.startContainer = async () => {
    restarts += 1;
  };
  botWaker.readRegistry = async () => ({});
});

test.after(async () => {
  botFactory.startContainer = origStart;
  botWaker.readRegistry = origRegistry;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const accounts = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// Account names are per GAME here on purpose. executeReuse's spoken-for set is
// global — an account assigned to any live task, for any game, is unavailable —
// exactly as legacy computes it. A fixture that reused "acc1" across games
// would have every later game's accounts spoken for by an earlier test's still
// active task, which is the collision the real system is guarding against.
async function warmSource(game, n) {
  await AutoFarmTask.deleteMany({ game });
  const prefix = game.toLowerCase().replace(/[^a-z0-9]+/g, "") + "_";
  return AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "completed",
    assignedAccounts: accounts(n, prefix),
    bots: [{ host: "pi", file: "config_1.json", container: "botwarm" }],
  });
}

function verdictFor(game, campaignId, source) {
  return {
    game,
    campaignId,
    campaignName: "Weekly",
    campaignEndAt: new Date(Date.now() + 48 * 3600000),
    decision: "reuse_existing",
    reuseTaskId: source._id,
    demandScore: 3.7,
    hadResearch: true,
    internalSales: 13,
    reason: "recurring campaign",
  };
}

test("THE INCIDENT: three reuse-only campaigns together produce ONE reusing task and TWO skips — never two empty active tasks", async () => {
  const game = "World of Tanks";
  assert.equal(settings.isReuseOnlyGame(game), true, "fixture sanity: WoT is reuse-only");
  const source = await warmSource(game, 18);
  restarts = 0;

  const r1 = await executeStep.executeReuse({ verdict: verdictFor(game, "c1", source), dryRun: false });
  const r2 = await executeStep.executeReuse({ verdict: verdictFor(game, "c2", source), dryRun: false });
  const r3 = await executeStep.executeReuse({ verdict: verdictFor(game, "c3", source), dryRun: false });

  assert.equal(r1.accounts, 18, "the first campaign reuses all 18 warm accounts");
  assert.equal(r1.skipped, undefined);
  assert.equal(r2.skipped, true);
  assert.equal(r2.decision, "skip_reuse_only");
  assert.equal(r3.skipped, true);
  assert.equal(r3.decision, "skip_reuse_only");
  assert.equal(restarts, 1, "the warm bot was restarted once, for the campaign that reuses it; the skips touched no host");

  const rows = await AutoFarmTask.find({ game, campaignId: { $in: ["c1", "c2", "c3"] } }).lean();
  const active = rows.filter((r) => r.status === "active");
  const skipped = rows.filter((r) => r.status === "skipped");
  assert.equal(active.length, 1, "exactly one active task");
  assert.equal(active[0].campaignId, "c1");
  assert.equal(active[0].assignedAccounts.length, 18);
  assert.equal(skipped.length, 2, "exactly two skips");
  for (const s of skipped) {
    assert.equal(s.decision, "skip_reuse_only", "the shape executeTask's reuse-only branch writes");
    assert.equal(s.plannedAccounts, 0);
    assert.equal(s.targetAccounts, 0);
    assert.deepEqual(s.assignedAccounts, []);
    assert.deepEqual(s.bots, []);
    assert.ok(s.executedAt, "settled, like legacy's skip_reuse_only rewrite");
    assert.match(s.reason, /Reuse-only game/);
  }

  // The invariant the incident violated, stated directly: no row is ACTIVE
  // with nothing to farm. This is what backfillActiveTasks would have found.
  const emptyActive = await AutoFarmTask.countDocuments({
    game,
    status: "active",
    assignedAccounts: { $size: 0 },
  });
  assert.equal(emptyActive, 0, "an active task with no accounts is what backfill tops up with fresh accounts");
});

test("a NON-reuse-only game in the same situation records skip_no_accounts, not an empty active row", async () => {
  // Legacy would top this up with fresh accounts from its own budget. The lane
  // has no budget at execute time for a reuse decision, so it records the
  // legacy shape for "nothing to spend right now" and lets the next cycle
  // re-decide. Retryable, and not a row a fleet sweep acts on.
  const game = "Ordinary Reuse Game";
  assert.equal(settings.isReuseOnlyGame(game), false);
  const source = await warmSource(game, 5);
  restarts = 0;

  const r1 = await executeStep.executeReuse({ verdict: verdictFor(game, "c1", source), dryRun: false });
  const r2 = await executeStep.executeReuse({ verdict: verdictFor(game, "c2", source), dryRun: false });
  assert.equal(r1.accounts, 5);
  assert.equal(r2.skipped, true);
  assert.equal(r2.decision, "skip_no_accounts");
  assert.equal(restarts, 1);

  const second = await AutoFarmTask.findOne({ game, campaignId: "c2" }).lean();
  assert.equal(second.status, "skipped");
  assert.equal(second.decision, "skip_no_accounts");
  assert.deepEqual(second.assignedAccounts, []);
  assert.equal(await AutoFarmTask.countDocuments({ game, status: "active", assignedAccounts: { $size: 0 } }), 0);
});

test("the skip row carries the decision's snapshot and inputs, like every other row the lane writes", async () => {
  const game = "World of Tanks";
  const source = await warmSource(game, 3);
  await executeStep.executeReuse({ verdict: verdictFor(game, "c1", source), dryRun: false });
  const v = verdictFor(game, "c2", source);
  v.decisionInputs = {
    version: 1,
    at: new Date(),
    research: { demandScore: 3.7, sellers: 10, scannedAt: new Date() },
    sales: { count: 13, revenue: 22.75, avgPrice: 1.75 },
    af: { maxPerGame: 30 },
    probeAllowed: true,
    probeBudgetBlocked: false,
    marketStockFloor: 6,
  };
  await executeStep.executeReuse({ verdict: v, dryRun: false });
  const row = await AutoFarmTask.findOne({ game, campaignId: "c2" }).lean();
  assert.equal(row.decision, "skip_reuse_only");
  assert.equal(row.decisionInputs.version, 1);
  assert.equal(row.decisionInputs.sales.count, 13);
  assert.equal(row.internalSales, 13);
  assert.equal(row.demandScore, 3.7);
});

test("a later cycle can still reuse once accounts free up — the skip is not terminal", async () => {
  const game = "World of Tanks";
  const source = await warmSource(game, 4);
  await executeStep.executeReuse({ verdict: verdictFor(game, "c1", source), dryRun: false });
  const blocked = await executeStep.executeReuse({ verdict: verdictFor(game, "c2", source), dryRun: false });
  assert.equal(blocked.skipped, true);

  // The first campaign ends; its task completes and its accounts are no longer
  // spoken for. The lane re-decides c2 next cycle and execute runs again.
  await AutoFarmTask.updateOne({ game, campaignId: "c1" }, { $set: { status: "completed" } });
  const retried = await executeStep.executeReuse({ verdict: verdictFor(game, "c2", source), dryRun: false });
  assert.equal(retried.skipped, undefined);
  assert.equal(retried.accounts, 4, "now the accounts are free and c2 reuses them");
  const row = await AutoFarmTask.findOne({ game, campaignId: "c2" }).lean();
  assert.equal(row.status, "active");
  assert.equal(row.decision, "reuse_existing");
  assert.equal(row.assignedAccounts.length, 4);
});

test("dry-run with nothing to reuse still records the plan legacy's dry-run records (planned, 0) — unchanged", async () => {
  // Legacy's dry-run reuse path writes status planned with plannedAccounts 0
  // regardless of `mine`; a planned row is not acted on by the sweeps. Pinned so
  // the fix above is seen to change only the live path.
  const game = "World of Tanks";
  const source = await warmSource(game, 2);
  await executeStep.executeReuse({ verdict: verdictFor(game, "c1", source), dryRun: false });
  const r = await executeStep.executeReuse({ verdict: verdictFor(game, "c2", source), dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldReuseAccounts, 0);
  const row = await AutoFarmTask.findOne({ game, campaignId: "c2" }).lean();
  assert.equal(row.status, "planned");
  assert.equal(row.plannedAccounts, 0);
});
