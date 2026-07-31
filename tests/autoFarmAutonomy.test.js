// A task the owner would otherwise have to rescue by hand.
//
// Live prod state on 2026-07-29: 43 AutoFarmTask rows sat at status "planned",
// every one of them 76 hours old, 18 of them for campaigns that were STILL
// RUNNING. In live mode processCampaign writes the plan and then executes it,
// but executeTask throws on any transient shortage (pool under the reserve
// floor, no free container seat), and the tick's candidate filter only ever
// re-decided rows in status "skipped". So a single unlucky minute parked a
// campaign behind the UI's Approve button indefinitely — the exact "it needs my
// action" the farmer exists to remove.
const test = require("node:test");
const assert = require("node:assert");

const { isStranded } = require("../utils/autoFarmer");

test("a plan that never executed is stranded and must be retried", () => {
  assert.strictEqual(isStranded({ status: "planned", bots: [] }), true);
});

test("a failed task that owns nothing is stranded", () => {
  // executeTask released its claimed accounts before writing "failed", so
  // re-deciding costs nothing and cannot double-spend.
  assert.strictEqual(isStranded({ status: "failed", bots: [] }), true);
  assert.strictEqual(isStranded({ status: "failed" }), true);
});

test("a failed task that DID create bots is left alone", () => {
  // It holds real state — containers, deployed accounts — so a blind re-decide
  // could hand the same campaign a second set of bots.
  assert.strictEqual(
    isStranded({ status: "failed", bots: [{ container: "twitchbotx22" }] }),
    false,
  );
});

test("healthy states are never treated as stranded", () => {
  for (const status of ["active", "completed", "stopped", "skipped"]) {
    assert.strictEqual(isStranded({ status, bots: [] }), false, status);
  }
  assert.strictEqual(isStranded(null), false);
  assert.strictEqual(isStranded(undefined), false);
});

// Dry-run mode is the one place a plan SHOULD wait for a human: that is what
// the mode means. The tick gates the retry on `!af.dryRun`, so this pins the
// combination rather than the helper.
test("stranded plans are only auto-retried when the farmer is live", () => {
  const retry = (dryRun, task) => !dryRun && isStranded(task);
  const plan = { status: "planned", bots: [] };
  assert.strictEqual(retry(true, plan), false, "dry-run waits for approval");
  assert.strictEqual(retry(false, plan), true, "live never waits");
});
