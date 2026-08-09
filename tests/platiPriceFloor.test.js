// Plati enforces a ~100 RUB (~$1.28) platform floor. Publishing under it did
// not just get individual listings rejected — it got the whole seller account
// blocked ("продавец товара заблокирован"), which took every Plati stock read
// and the entire auto-feed for the marketplace offline. The shared price model
// floors at Gameflip's $0.75 and knows nothing about the marketplace it is
// publishing to, so the floor is pinned here at the connector.
const test = require("node:test");
const assert = require("node:assert");
const {
  digisellerFloorPrice,
  DS_MIN_PRICE_USD,
} = require("../utils/marketplaces");

test("the floor is Plati's ~100 RUB minimum", () => {
  assert.equal(DS_MIN_PRICE_USD, 1.28);
});

test("the price that blocked the account is lifted to the floor", () => {
  // 88 live listings sat at exactly this price.
  assert.equal(digisellerFloorPrice(0.75), 1.28);
});

test("every under-floor price the model can produce is lifted", () => {
  for (const p of [0.6, 0.75, 1, 1.25, 1.27]) {
    assert.equal(digisellerFloorPrice(p), 1.28, "failed for " + p);
  }
});

test("a price at or above the floor is left alone", () => {
  assert.equal(digisellerFloorPrice(1.28), 1.28);
  assert.equal(digisellerFloorPrice(1.75), 1.75);
  assert.equal(digisellerFloorPrice(12.5), 12.5);
});

test("sub-cent noise is rounded before the floor is applied", () => {
  assert.equal(digisellerFloorPrice(1.999), 2);
  assert.equal(digisellerFloorPrice(1.2751), 1.28);
});

test("a missing or nonsense price is still refused, not floored", () => {
  // Silently publishing at $1.28 would hide a caller that lost its price.
  for (const bad of [0, -1, null, undefined, NaN, "abc"]) {
    assert.throws(() => digisellerFloorPrice(bad), /price above 0/);
  }
});
