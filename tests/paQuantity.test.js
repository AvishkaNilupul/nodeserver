// How many ACCOUNTS a PlayerAuctions order is owed.
//
// Order 16474028 — "Sea of Thieves Twitch Drops (11 Items)", $5.00 — shipped
// ELEVEN ACCOUNTS. PlayerAuctions reported
//   purchased: { amount: 11, suffix: "Ship Skins" }
// and the fulfiller read that 11 as a unit count. It is an ITEM count: eleven
// ship skins, i.e. ONE account holding eleven drops. Ten accounts were given
// away on a five dollar sale.
//
// The comment directly above the function already warned about this exact
// mistake for the orders-list string ("26 Other Skins") — and then the fallback
// underneath it read the same number in structured form. The suffix is the
// giveaway: it names the offer's unit, and that unit is never "accounts".
//
// The only honest route to a unit count is money: what the buyer paid against
// what one unit costs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// paQuantity is module-private, so lift it out with its helper rather than
// export something purely for the test.
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "playerauctionsFulfiller.js"),
  "utf8",
);
function loadPaQuantity() {
  const fn = SRC.match(/function paQuantity\(order, listingPriceUsd\) \{[\s\S]*?\n\}/);
  const helper = SRC.match(/function money\(v\) \{[\s\S]*?\n\}/);
  assert.ok(fn && helper, "paQuantity and money should both exist");
  // eslint-disable-next-line no-new-func
  return new Function(`${helper[0]}\n${fn[0]}\nreturn paQuantity;`)();
}
const paQuantity = loadPaQuantity();

const order = (price, amount, suffix) => ({
  detail: { orderInfo: { price, purchased: { amount, suffix } } },
});

test("REGRESSION: 11 Ship Skins for $5 is ONE account, not eleven", () => {
  // The exact order. $5.00 paid against a $5 listing is one unit, whatever the
  // item count says.
  assert.strictEqual(paQuantity(order("5.00", 11, "Ship Skins"), 5), 1);
});

test("the item count is ignored however large it gets", () => {
  // 26 Other Skins, 58 items, 125 chests — all one account.
  for (const n of [2, 11, 26, 58, 125]) {
    assert.strictEqual(
      paQuantity(order("5.00", n, "Other Skins"), 5),
      1,
      n + " items should still be one account",
    );
  }
});

test("a genuine bulk purchase is honoured, from the money", () => {
  // Three units of a $5 offer is $15. That IS three accounts.
  assert.strictEqual(paQuantity(order("15.00", 33, "Ship Skins"), 5), 3);
  assert.strictEqual(paQuantity(order("10.00", 22, "Ship Skins"), 5), 2);
});

test("a price that does not divide cleanly falls back to one", () => {
  // A coupon, a fee, a currency wobble — none of them are evidence of a bulk
  // purchase, and guessing high hands out free accounts.
  assert.strictEqual(paQuantity(order("7.30", 11, "Ship Skins"), 5), 1);
  assert.strictEqual(paQuantity(order("5.40", 11, "Ship Skins"), 5), 1);
});

test("a rounding-level difference across many units still counts", () => {
  // $14.99 against a $5 unit is three units with a cent of drift, not one.
  assert.strictEqual(paQuantity(order("15.00", 33, "Ship Skins"), 5.0), 3);
  // But a whole cent per unit out is not close enough.
  assert.strictEqual(paQuantity(order("15.30", 33, "Ship Skins"), 5), 1);
});

test("an unknown price is one unit, never a guess", () => {
  assert.strictEqual(paQuantity(order(null, 26, "Other Skins"), 5), 1);
  assert.strictEqual(paQuantity(order("5.00", 26, "Other Skins"), 0), 1);
  assert.strictEqual(paQuantity({}, 5), 1);
  assert.strictEqual(paQuantity(null, 5), 1);
});

test("an explicit purchaseQuantity from the API still wins", () => {
  // If PlayerAuctions ever states the unit count outright, believe it.
  assert.strictEqual(paQuantity({ purchaseQuantity: 2 }, 5), 2);
  assert.strictEqual(paQuantity({ purchaseQuantity: "3" }, 5), 3);
});

test("units are computed only AFTER the listing is resolved", () => {
  // The unit price lives on the listing row. Computing qty at the top of
  // deliverOrder — before the row is known — is what forced the fallback onto
  // the item count in the first place.
  const deliver = SRC.slice(SRC.indexOf("async function deliverOrder("));
  const rowAt = deliver.indexOf('if (!row) return { orderId, skipped: "no listing row');
  const qtyAt = deliver.indexOf("const qty = paQuantity(order, row.price)");
  assert.ok(qtyAt > 0, "qty should be derived from the listing price");
  assert.ok(rowAt > 0 && qtyAt > rowAt, "qty must be computed after the row is resolved");
});

test("purchased.amount is never read as a unit count again", () => {
  const fn = SRC.match(/function paQuantity\(order, listingPriceUsd\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(
    fn,
    /return Math\.round\(d\.amount\)/,
    "the item count must not be returned as a unit count",
  );
});
