// Candidate selection and the notification gate, and how "Rescan all"
// interacts with them.
//
// The gate only suppresses a repeat when the campaign's PREVIOUS decision is
// still readable. Rescan used to delete terminal tasks, which made every
// re-decision look brand new and re-announced ~60 skips from one button press —
// the exact spam the gate was added to stop. Rescan now flags instead.
//
// These mirror the logic in utils/autoFarmer.js runOnce()/processCampaign()
// rather than driving them, since those need Mongo and live hosts.
const test = require("node:test");
const assert = require("node:assert");

const RETRYABLE = new Set([
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered",
]);

// Mirrors runOnce()'s candidate arm. Returns { candidate, prior }.
function select(existing) {
  if (!existing) return { candidate: true, prior: null };
  if (
    (existing.status === "skipped" && RETRYABLE.has(existing.decision)) ||
    existing.rescanRequested
  ) {
    return { candidate: true, prior: existing };
  }
  return { candidate: false, prior: null };
}

// Mirrors processCampaign()'s isNewDecision().
const isNewDecision = (prior, decision) => !prior || prior.decision !== decision;

test("a retryable skip is re-decided but not re-announced", () => {
  const existing = { status: "skipped", decision: "skip_already_covered" };
  const { candidate, prior } = select(existing);
  assert.strictEqual(candidate, true, "must be re-decided each tick");
  assert.strictEqual(
    isNewDecision(prior, "skip_already_covered"),
    false,
    "an unchanged verdict must stay silent",
  );
});

test("a genuinely changed verdict IS announced", () => {
  const existing = { status: "skipped", decision: "skip_no_accounts" };
  const { prior } = select(existing);
  assert.strictEqual(isNewDecision(prior, "skip_already_covered"), true);
});

test("rescan re-decides a NON-retryable skip that would otherwise be stuck", () => {
  // skip_low_demand is not retryable, so only a rescan brings it back.
  const stuck = { status: "skipped", decision: "skip_low_demand" };
  assert.strictEqual(select(stuck).candidate, false);
  assert.strictEqual(
    select({ ...stuck, rescanRequested: true }).candidate,
    true,
  );
});

test("rescan does NOT resurrect the notification blast", () => {
  // The regression this fixes: 63 skip_low_demand rows, all rescanned. Each is
  // re-decided, reaches the same verdict, and must stay silent.
  const rows = Array.from({ length: 63 }, () => ({
    status: "skipped",
    decision: "skip_low_demand",
    rescanRequested: true,
  }));
  let announced = 0;
  for (const r of rows) {
    const { candidate, prior } = select(r);
    assert.strictEqual(candidate, true);
    if (isNewDecision(prior, "skip_low_demand")) announced++;
  }
  assert.strictEqual(announced, 0, "a rescan must not re-announce settled skips");
});

test("deleting the task instead of flagging it DOES cause the blast", () => {
  // Documents why rescanAll stops deleting: with the row gone, prior is null.
  let announced = 0;
  for (let i = 0; i < 63; i++) {
    const { prior } = select(null); // deleted -> looks brand new
    if (isNewDecision(prior, "skip_low_demand")) announced++;
  }
  assert.strictEqual(announced, 63);
});

test("an untouched terminal task is left alone", () => {
  for (const status of ["completed", "stopped", "failed"]) {
    assert.strictEqual(select({ status, decision: "farm" }).candidate, false);
  }
  // ...and a plan awaiting approval is never auto-executed by the tick.
  assert.strictEqual(
    select({ status: "planned", decision: "farm", dryRun: true }).candidate,
    false,
  );
});

// The reuse branch must not advertise stock another live task already counts.
test("reuse claims only accounts no other live task holds", () => {
  const reusable = { assignedAccounts: ["a", "b", "c", "d"] };
  const others = [{ assignedAccounts: ["b"] }, { assignedAccounts: ["d"] }];
  const spokenFor = new Set(
    others.flatMap((o) => o.assignedAccounts.map((u) => u.toLowerCase())),
  );
  const mine = reusable.assignedAccounts.filter(
    (u) => !spokenFor.has(u.toLowerCase()),
  );
  assert.deepStrictEqual(mine, ["a", "c"]);
  // qty is derived from this list, so it can never exceed deliverable stock.
  assert.strictEqual(Math.max(1, mine.length), 2);
});
