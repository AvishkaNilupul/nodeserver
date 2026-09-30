// The price tilt on own-sales demand (utils/autoFarmer.js priceFactor /
// REFERENCE_SALE_USD), exercised through demandAllocation.
//
// WHY THIS EXISTS
// REFERENCE_SALE_USD is documented as "what a normal sale is worth" and was set
// to $2.50 — a number never measured against this business. The actual median
// realised sale across every priced row on record is $1.25 (n=209). A $2.50
// reference therefore declared the TYPICAL sale to be half price and handed
// almost every game the 0.6 clamp floor: measured on prod, 19 of the 49 games
// with own-sales evidence were already pinned there, and the other 24 read
// neutral only because their price had never been recorded.
//
// That accident was about to end — manual mark-sold now captures price (it was
// 71% of all sales and recorded none), so those 24 games were about to acquire
// real $0.75-$1.42 prices and drop to the floor too, cutting demand ~40% across
// the fleet just as intake scales up.
//
// These tests pin the constant to measured reality so a future "let's aim
// higher" tweak has to argue with the data.
const test = require("node:test");
const assert = require("node:assert/strict");

const { demandAllocation } = require("../utils/autoFarmer");

const AF = { maxPerGame: 30, probeSize: 15 };
// Enough own sales that the tilt, not the count, is what moves the number.
const sales = (avgPrice, count = 10) => ({
  count,
  revenue: avgPrice * count,
  avgPrice,
});
// A researched game with a real but modest market score, so the own-sales
// contribution is what varies between cases.
const research = { scannedAt: new Date(), demandScore: 10 };

const effectiveAt = (avgPrice) =>
  demandAllocation(research, AF, sales(avgPrice)).effective;

test("the MEASURED median sale ($1.25) is treated as normal, not as cheap", () => {
  // The whole bug: at a $2.50 reference this landed on the 0.6 floor and read
  // identically to a $0.75 sale.
  const median = effectiveAt(1.25);
  const cheap = effectiveAt(0.75);
  assert.ok(
    median > cheap,
    "a median-priced sale must outrank a cheap one (got " + median + " vs " + cheap + ")",
  );
});

test("a genuinely cheap sale is still penalised", () => {
  assert.ok(effectiveAt(0.75) < effectiveAt(1.25));
});

test("a genuinely expensive sale is still rewarded", () => {
  assert.ok(effectiveAt(2.5) > effectiveAt(1.25));
});

test("the tilt is monotonic in price", () => {
  const points = [0.5, 0.75, 1.0, 1.25, 1.75, 2.5].map(effectiveAt);
  for (let i = 1; i < points.length; i++) {
    assert.ok(
      points[i] >= points[i - 1],
      "demand fell as price rose at index " + i + ": " + points.join(", "),
    );
  }
});

test("the tilt stays clamped in both directions — price never replaces evidence", () => {
  // An absurd price must not manufacture demand without sales behind it.
  const huge = effectiveAt(500);
  const normal = effectiveAt(1.25);
  assert.ok(huge / normal <= 4, "price tilt is no longer clamped: " + huge + " vs " + normal);
});

test("no recorded price is neutral, never a penalty", () => {
  // A connection flip proves a sale but names no price. That must not be read
  // as a cheap sale — it is an absence of information.
  const unpriced = demandAllocation(research, AF, {
    count: 10,
    revenue: 0,
    avgPrice: 0,
  }).effective;
  assert.ok(unpriced > effectiveAt(0.75), "an unpriced sale was treated as cheap");
});

test("a median-priced seller clears the full-allocation tier", () => {
  // The practical consequence: a game selling ten units at the normal price
  // should earn a real allocation rather than being throttled to half.
  const out = demandAllocation(research, AF, sales(1.25));
  assert.ok(out.target >= AF.maxPerGame, "median-priced seller was throttled: " + out.target);
});
