const test = require("node:test");
const assert = require("node:assert/strict");

const {
  signatureForItems,
  sourceEventKeyFor,
} = require("../utils/catalogProfiles");
const { thumbnailUrl } = require("../utils/catalogImage");
const { recommendedProfilePrice } = require("../routes/catalogRoutes");

test("catalog profile signatures group by item type, order and count independent", () => {
  const left = signatureForItems([
    { itemKey: "rare|game", count: 2 },
    { itemKey: "common|game", count: 1 },
  ]);
  const right = signatureForItems([
    { itemKey: "COMMON|GAME", count: 1 },
    { itemKey: "rare|game", count: 2 },
  ]);
  assert.equal(left, right);
  // Copy counts no longer affect grouping — same item TYPES => same signature,
  // so accounts farmed at different times bundle together.
  assert.equal(
    left,
    signatureForItems([
      { itemKey: "rare|game", count: 1 },
      { itemKey: "common|game", count: 1 },
    ]),
  );
  // A different set of item TYPES still produces a different signature.
  assert.notEqual(
    left,
    signatureForItems([{ itemKey: "rare|game", count: 1 }]),
  );
});

test("catalog profile source keys are deterministic and game scoped", () => {
  const signature = "item|game:2";
  assert.equal(
    sourceEventKeyFor("Rocket League", signature),
    sourceEventKeyFor("rocket league", signature),
  );
  assert.notEqual(
    sourceEventKeyFor("Rocket League", signature),
    sourceEventKeyFor("Warframe", signature),
  );
});

// REPLACED 2026-09-08. These two tests previously asserted the LINEAR pricer:
//
//   assert.equal(recommendedProfilePrice({ totalRewards: 30 }, 0.75, 0.1), 2.82);
//
// i.e. rate 0.1 x 30 rewards x 0.94 = 2.82 — they pinned `catalogRate * rewards`
// as the intended contract. That formula is the defect: with prod's real World
// of Tanks rate of ~$6.06/reward it produced $227.86 for a 40-reward profile,
// and 48 profiles ended up above $50, against a highest-ever realised sale of
// $4.50. Prod's sold-listing data shows the realised median is FLAT across
// bundle size (~$1.25 whether the account holds 1 drop or 58), so proportional
// scaling was never supported by evidence.
//
// The contract is now: price from realised sales, sub-linear in reward count,
// bounded by a band the evidence defines. See utils/pricing.js and
// tests/catalogProfilePrice.test.js.

test("profile pricing grows with reward volume, sub-linearly", () => {
  const sales = [1.25, 1.25, 1.5];
  const small = recommendedProfilePrice({ totalRewards: 5 }, 3, 0, sales);
  const medium = recommendedProfilePrice({ totalRewards: 15 }, 3, 0, sales);
  const large = recommendedProfilePrice({ totalRewards: 30 }, 3, 0, sales);
  assert.ok(small < medium && medium < large, "must be monotonic in rewards");
  // 6x the rewards must not approach 6x the price.
  assert.ok(large < small * 2, "growth is not sub-linear: " + small + " -> " + large);
});

test("profile pricing IGNORES the per-reward rate that caused the $227 bug", () => {
  const sales = [1.25, 1.25, 1.5];
  const withLowRate = recommendedProfilePrice({ totalRewards: 30 }, 0.75, 0.1, sales);
  const withProdRate = recommendedProfilePrice({ totalRewards: 30 }, 0.75, 6.06, sales);
  assert.equal(withLowRate, withProdRate, "the rate must no longer scale price");
  assert.ok(withProdRate < 10, "priced at $" + withProdRate);
});

test("profile pricing never exceeds what the business has actually sold for", () => {
  const sales = [1.25, 1.25, 1.5];
  for (const rewards of [1, 15, 30, 60, 500]) {
    const price = recommendedProfilePrice({ totalRewards: rewards }, 3, 6.06, sales);
    assert.ok(price <= 5.5, "rewards=" + rewards + " priced $" + price);
  }
});

test("catalog thumbnails accept only cached hash image paths", () => {
  const hash = "a".repeat(40);
  assert.equal(
    thumbnailUrl(`/drop-images/${hash}.png`),
    `/catalog/thumb/${hash}.png`,
  );
  assert.equal(thumbnailUrl("/drop-images/../../server.js"), "");
  assert.equal(thumbnailUrl("https://example.com/image.png"), "");
});
