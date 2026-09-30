// routes/catalogRoutes.js recommendedProfilePrice — the catalog profile pricer.
//
// THE BUG THIS PINS
// The original body was `base = catalogRate * rewards`: LINEAR in reward count
// and uncapped. `catalogRate` is the median (price / rewards) of already-
// approved sets, so small sets priced ~$1.50 for 1-2 rewards yielded a rate
// near $1/reward, and a 40-reward World of Tanks profile came out at $227.86.
// On prod, 48 catalog profiles carried a price above $50 and the highest was
// $227.86 — in a business whose largest realised sale on record is $4.50.
const test = require("node:test");
const assert = require("node:assert");

const { recommendedProfilePrice } = require("../routes/catalogRoutes");

// Real Gameflip sale prices from prod, 2026-09-08.
const REAL_SALES = [1.25, 1.25, 0.75, 1.5, 2.75, 1, 1.25, 0.75, 1.25];
// The per-reward rate prod actually computed for World of Tanks.
const PROD_CATALOG_RATE = 6.06;

test("REGRESSION: the 40-reward World of Tanks profile is no longer $227", () => {
  const price = recommendedProfilePrice(
    { totalRewards: 40 },
    1.25,
    PROD_CATALOG_RATE,
    REAL_SALES,
  );
  assert.ok(price < 10, "priced at $" + price);
  assert.equal(price, 2.42);
});

test("REGRESSION: the per-reward rate can no longer scale the price at all", () => {
  // The whole defect was this parameter acting as a multiplier. Changing it
  // across two orders of magnitude must not move the price by a cent.
  const cheap = recommendedProfilePrice({ totalRewards: 40 }, 1.25, 0.01, REAL_SALES);
  const dear = recommendedProfilePrice({ totalRewards: 40 }, 1.25, 999, REAL_SALES);
  assert.equal(cheap, dear);
});

test("price grows with reward count, but sub-linearly", () => {
  const one = recommendedProfilePrice({ totalRewards: 1 }, 1.25, 1, REAL_SALES);
  const ten = recommendedProfilePrice({ totalRewards: 10 }, 1.25, 1, REAL_SALES);
  const forty = recommendedProfilePrice({ totalRewards: 40 }, 1.25, 1, REAL_SALES);
  assert.ok(one < ten && ten < forty, "must be monotonic");
  assert.ok(forty < one * 4, "40x the rewards must not approach 4x the price");
});

test("no reward count can produce a price outside the realised envelope", () => {
  for (const rewards of [1, 5, 20, 40, 100, 5000]) {
    const price = recommendedProfilePrice({ totalRewards: rewards }, 1.25, 6.06, REAL_SALES);
    assert.ok(price <= 5.5, "rewards=" + rewards + " priced $" + price);
  }
});

test("with no evidence it still returns a sane floor price", () => {
  const price = recommendedProfilePrice({ totalRewards: 12 });
  assert.ok(price > 0 && price <= 5.5, "priced at $" + price);
});

test("a missing/garbage profile never throws or returns NaN", () => {
  for (const profile of [{}, { totalRewards: 0 }, { totalRewards: -3 }, { totalRewards: "x" }]) {
    const price = recommendedProfilePrice(profile, 1.25, 1, REAL_SALES);
    assert.ok(Number.isFinite(price) && price > 0, "bad price for " + JSON.stringify(profile));
  }
});
