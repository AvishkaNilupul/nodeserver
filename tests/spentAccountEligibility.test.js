const test = require("node:test");
const assert = require("node:assert");
const { spentAccountEligibility, cooldownPassed } = require("../utils/spentAccountEligibility");

const NOW = new Date("2026-08-26T00:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86400000);
const ok = () => ({
  claimedNote: "assigned to a bot",
  availableDrops: 0,
  deliveredDrops: 4,
  soldUnconnectedDrops: 0,
  onActiveListing: false,
  deployed: false,
  newestDeliveredAt: daysAgo(20),
  cooldownDays: 14,
  now: NOW,
});

test("spent, delivered, cooled account is recyclable", () => {
  assert.deepStrictEqual(spentAccountEligibility(ok()), {
    recyclable: true,
    reason: "",
    cooldownPassed: true,
  });
});

test("each exclusion branch rejects", () => {
  const cases = [
    { claimedNote: "rented to bob" },
    { claimedNote: "recycled — spent" },
    { availableDrops: 1 },
    { deliveredDrops: 0 },
    { soldUnconnectedDrops: 1 },
    { onActiveListing: true },
    { deployed: true },
  ];
  for (const over of cases) {
    const result = spentAccountEligibility({ ...ok(), ...over });
    assert.strictEqual(result.recyclable, false);
    assert.ok(result.reason);
    assert.strictEqual(result.cooldownPassed, false);
  }
});

test("cooldown is inclusive at the exact boundary", () => {
  assert.strictEqual(cooldownPassed(daysAgo(14), 14, NOW), true);
  assert.strictEqual(cooldownPassed(daysAgo(13.99), 14, NOW), false);
  assert.strictEqual(spentAccountEligibility({ ...ok(), newestDeliveredAt: daysAgo(3) }).cooldownPassed, false);
});

test("missing facts fail closed", () => {
  assert.strictEqual(spentAccountEligibility().recyclable, false);
  assert.strictEqual(spentAccountEligibility({}).cooldownPassed, false);
});
