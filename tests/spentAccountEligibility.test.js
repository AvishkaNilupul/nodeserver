const test = require("node:test");
const assert = require("node:assert");
const {
  spentAccountEligibility,
  cooldownPassed,
  isFarmSpentNote,
} = require("../utils/spentAccountEligibility");

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

test("farm-spent accounts are recyclable without delivery history or cooldown", () => {
  const base = {
    ...ok(),
    claimedNote: "spent — no-claim removed Overwatch",
    deliveredDrops: 0,
    availableDrops: 424,
    newestDeliveredAt: null,
    farmSpent: true,
  };
  assert.deepStrictEqual(spentAccountEligibility(base), {
    recyclable: true,
    reason: "",
    cooldownPassed: true,
  });
});

test("farm-spent accounts still respect the other guards", () => {
  const base = {
    ...ok(),
    claimedNote: "spent — no-claim removed Overwatch",
    deliveredDrops: 0,
    availableDrops: 424,
    newestDeliveredAt: null,
    farmSpent: true,
  };
  const cases = [
    { claimedNote: "rented to bob" },
    { claimedNote: "recycled — spent" },
    { soldUnconnectedDrops: 1 },
    { onActiveListing: true },
    { deployed: true },
  ];
  for (const over of cases) {
    const result = spentAccountEligibility({ ...base, ...over });
    assert.strictEqual(result.recyclable, false);
    assert.ok(result.reason);
    assert.strictEqual(result.cooldownPassed, false);
  }
});

test("missing facts fail closed", () => {
  assert.strictEqual(spentAccountEligibility().recyclable, false);
  assert.strictEqual(spentAccountEligibility({}).cooldownPassed, false);
});

// ---------------------------------------------------------------------------
// The handoff protocol: which pool-row notes mean "a farm engine spent this".
// ---------------------------------------------------------------------------
test("every farm engine's spent stamp is recognised as a handoff", () => {
  // routes/noclaimFarmRoutes.js — spent sweep on the standalone no-claim bots.
  assert.equal(isFarmSpentNote("spent — no-claim removed Overwatch"), true);
  // utils/unclaimedAutoList.js — the unclaimed auto-lister sold the account.
  // Keying on the no-claim wording alone stranded every one of these.
  assert.equal(isFarmSpentNote("spent — unclaimed auto-listed (sold)"), true);
  assert.equal(isFarmSpentNote("spent — unclaimed auto-listed (claimed elsewhere)"), true);
});

test("notes that are not a spent handoff are not treated as one", () => {
  assert.equal(isFarmSpentNote(""), false);
  assert.equal(isFarmSpentNote(null), false);
  assert.equal(isFarmSpentNote("assigned to a bot"), false);
  assert.equal(isFarmSpentNote("rented to alice"), false);
  assert.equal(isFarmSpentNote("recycled — spent (never re-farm sold games)"), false);
  assert.equal(isFarmSpentNote("sold — token reclaimed by buyer"), false);
  // A plain hyphen is a different note shape; only the em-dash stamp counts.
  assert.equal(isFarmSpentNote("spent - something else"), false);
});

test("a farm-spent account that is still on sale is never recyclable", () => {
  // The farm-spent branch skips the DropLog stock gate, so onActiveListing is
  // the only thing protecting stock a buyer can still purchase. The caller
  // folds three records into it: marketplace listing rows, the unclaimed
  // engine's ledger, and the pool row's engine-owned `listed` flag.
  const base = {
    claimedNote: "spent — unclaimed auto-listed (sold)",
    farmSpent: true,
    availableDrops: 7,
    deliveredDrops: 0,
    soldUnconnectedDrops: 0,
    deployed: false,
    cooldownDays: 14,
  };
  assert.equal(spentAccountEligibility({ ...base, onActiveListing: false }).recyclable, true);
  const onSale = spentAccountEligibility({ ...base, onActiveListing: true });
  assert.equal(onSale.recyclable, false);
  assert.equal(onSale.reason, "on an active marketplace listing");
});
