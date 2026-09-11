// The "Add from pool" renter feature auto-picks pristine, unentangled pool
// accounts so it never takes something auto-farm is using. These lock in that
// a perfect account passes and every single disqualifier rejects it.
const test = require("node:test");
const assert = require("node:assert");

const {
  poolAccountEligibility,
  isEligible,
  pickCount,
} = require("../utils/renterPoolEligibility");

// A fully functional, unused, unentangled pool account.
const perfect = () => ({
  status: "available",
  clientSecret: "sk_live_abc",
  hasPassword: true,
  passwordDecryptable: true,
  lastCheckStatus: "ok",
  deployedOnBot: false,
  hasSoldOrReservedDrops: false,
  sellable: false,
  inAssignedAccounts: false,
  onActiveListing: false,
});

test("a pristine, unentangled account is eligible", () => {
  const r = poolAccountEligibility(perfect());
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.reason, "");
  assert.ok(isEligible(perfect()));
});

test("each disqualifier rejects it (with a reason)", () => {
  const cases = [
    ["status", { status: "claimed" }],
    ["no token", { clientSecret: "" }],
    ["no hasPassword", { hasPassword: false }],
    ["undecryptable password", { passwordDecryptable: false }],
    ["unverified token", { lastCheckStatus: "" }],
    ["bad token", { lastCheckStatus: "token_invalid" }],
    ["integrity failed", { lastCheckStatus: "integrity_failed" }],
    // The rent-farm incident of 2026-09-11: a re-imported web-token farm
    // account with six unclaimed Overwatch drops and no DB trace at all.
    ["holds unclaimed farmed drops", { unclaimedDrops: 6 }],
    ["already has claimed drops", { claimedDrops: 1 }],
    ["deployed on operator bot", { deployedOnBot: true }],
    ["sold/reserved drops", { hasSoldOrReservedDrops: true }],
    ["sellable stock", { sellable: true }],
    ["in an auto-farm task", { inAssignedAccounts: true }],
    ["on an active listing", { onActiveListing: true }],
  ];
  for (const [name, over] of cases) {
    const r = poolAccountEligibility({ ...perfect(), ...over });
    assert.strictEqual(r.eligible, false, name + " should be rejected");
    assert.ok(r.reason && r.reason.length > 0, name + " should carry a reason");
  }
});

test("zero or missing drop counts leave a pristine account eligible", () => {
  // Rows checked before unclaimedDropCount existed have no such field at all.
  for (const over of [{ claimedDrops: 0, unclaimedDrops: 0 }, { claimedDrops: undefined }, { unclaimedDrops: null }]) {
    assert.strictEqual(poolAccountEligibility({ ...perfect(), ...over }).eligible, true);
  }
});

test("the drop reason names what the account holds", () => {
  assert.match(poolAccountEligibility({ ...perfect(), unclaimedDrops: 6 }).reason, /6 unclaimed/);
  assert.match(poolAccountEligibility({ ...perfect(), claimedDrops: 2 }).reason, /2 claimed/);
});

test("missing/empty facts never crash and are ineligible", () => {
  assert.strictEqual(poolAccountEligibility().eligible, false);
  assert.strictEqual(poolAccountEligibility({}).eligible, false);
});

test("pickCount is the min of requested, quota room, and eligible", () => {
  assert.strictEqual(pickCount({ requested: 10, quotaRemaining: 5, eligibleTotal: 8 }), 5);
  assert.strictEqual(pickCount({ requested: 3, quotaRemaining: 5, eligibleTotal: 8 }), 3);
  assert.strictEqual(pickCount({ requested: 10, quotaRemaining: 5, eligibleTotal: 2 }), 2);
  assert.strictEqual(pickCount({ requested: 0, quotaRemaining: 5, eligibleTotal: 8 }), 0);
});

test("pickCount coerces junk/negatives to a safe 0", () => {
  assert.strictEqual(pickCount({ requested: -4, quotaRemaining: 5, eligibleTotal: 8 }), 0);
  assert.strictEqual(pickCount({ requested: "abc", quotaRemaining: 5, eligibleTotal: 8 }), 0);
  assert.strictEqual(pickCount({ requested: 5, quotaRemaining: -1, eligibleTotal: 8 }), 0);
  assert.strictEqual(pickCount(), 0);
  assert.strictEqual(pickCount({ requested: 2.9, quotaRemaining: 5, eligibleTotal: 8 }), 2);
});
