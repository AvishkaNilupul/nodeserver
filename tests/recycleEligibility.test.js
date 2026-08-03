// Recycling a sold-out account back into farming is gated hard: it must be
// spent, fully delivered (buyer connected everything), off any listing, out of
// any live bot, and past the cooldown. These lock in accept + every reject, so
// a sold account auto-farm/a buyer still relies on can never be reused.
const test = require("node:test");
const assert = require("node:assert");

const {
  recycleEligibility,
  cooldownPassed,
} = require("../utils/recycleEligibility");

const NOW = new Date("2026-08-03T00:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

// A spent, fully-delivered, cooled-down account with a normal sale note.
const ok = () => ({
  claimedNote: "",
  availableDrops: 0,
  connectedDrops: 84,
  soldUnconnectedDrops: 0,
  onActiveListing: false,
  enabledInLiveTask: false,
  newestDeliveredAt: daysAgo(20),
  cooldownDays: 14,
  now: NOW,
});

test("a spent, fully-delivered, cooled-down account is eligible", () => {
  const r = recycleEligibility(ok());
  assert.strictEqual(r.eligible, true, r.reason);
});

test("each disqualifier rejects (with a reason)", () => {
  const cases = [
    ["rental note", { claimedNote: "rented to owfarm1 until 2026-08-30" }],
    ["already recycled", { claimedNote: "recycled after Overwatch" }],
    ["still has sellable drops", { availableDrops: 5 }],
    ["never delivered", { connectedDrops: 0 }],
    ["sold but not connected", { soldUnconnectedDrops: 3 }],
    ["on active listing", { onActiveListing: true }],
    ["enabled in a live bot", { enabledInLiveTask: true }],
    ["within cooldown", { newestDeliveredAt: daysAgo(5) }],
  ];
  for (const [name, over] of cases) {
    const r = recycleEligibility({ ...ok(), ...over });
    assert.strictEqual(r.eligible, false, name + " should reject");
    assert.ok(r.reason && r.reason.length, name + " needs a reason");
  }
});

test("missing/empty facts never crash and are ineligible", () => {
  assert.strictEqual(recycleEligibility().eligible, false);
  assert.strictEqual(recycleEligibility({}).eligible, false);
});

test("cooldownPassed boundary math", () => {
  assert.strictEqual(cooldownPassed(daysAgo(14), 14, NOW), true); // exactly at
  assert.strictEqual(cooldownPassed(daysAgo(13.9), 14, NOW), false); // just shy
  assert.strictEqual(cooldownPassed(daysAgo(100), 14, NOW), true);
  assert.strictEqual(cooldownPassed(null, 14, NOW), false);
  assert.strictEqual(cooldownPassed("not-a-date", 14, NOW), false);
  assert.strictEqual(cooldownPassed(daysAgo(1), 0, NOW), true); // zero cooldown
});
