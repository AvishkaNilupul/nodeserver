// How many ACCOUNTS a PlayerAuctions bundle order is owed.
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
// what one unit costs. Verified against real order history on 2026-09-09:
//   16474028  $5.00  "11 Ship Skins"   -> 1 account   (11 items, one unit)
//   16425336 $10.00  "52 Other Skins"  -> 2 accounts  (a real 2-unit purchase)
// The old code would have shipped 11 and 52.
//
// These tests call the REAL exported function. They used to lift it out of the
// source with a regex, which is the same source-shape testing that let the G2G
// "Username: undefined" bug through untouched.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { paUnits, paQuantity } = require("../utils/playerauctionsFulfiller");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "playerauctionsFulfiller.js"),
  "utf8",
);

// An order as playerauctionsPendingOrders hands it over: the list row plus the
// attached detail.
const order = (price, amount, suffix) => ({
  detail: { orderInfo: { price, purchased: { amount, suffix } } },
});

/* --------------------------- the regression ---------------------------- */

test("REGRESSION: 11 Ship Skins for $5 is ONE account, not eleven", () => {
  assert.strictEqual(paQuantity(order("5.00", 11, "Ship Skins"), 5), 1);
});

test("the item count is ignored however large it gets", () => {
  for (const n of [2, 11, 26, 52, 58, 125]) {
    assert.strictEqual(
      paQuantity(order("5.00", n, "Other Skins"), 5),
      1,
      n + " items should still be one account",
    );
  }
});

test("a genuine bulk purchase is honoured, from the money", () => {
  // Order 16425336, real: $10.00 against a $5 unit, reported as "52 Other Skins".
  assert.strictEqual(paQuantity(order("10.00", 52, "Other Skins"), 5), 2);
  assert.strictEqual(paQuantity(order("15.00", 33, "Ship Skins"), 5), 3);
});

test("a rounding-level difference across many units still counts", () => {
  assert.strictEqual(paQuantity(order("15.00", 33, "Ship Skins"), 5.0), 3);
  // A whole cent per unit out is not close enough to be evidence.
  assert.strictEqual(paQuantity(order("15.30", 33, "Ship Skins"), 5), 1);
});

test("an unknown price is one unit, never a guess", () => {
  assert.strictEqual(paQuantity(order(null, 26, "Other Skins"), 5), 1);
  assert.strictEqual(paQuantity(order("5.00", 26, "Other Skins"), 0), 1);
  assert.strictEqual(paQuantity({}, 5), 1);
  assert.strictEqual(paQuantity(null, 5), 1);
});

test("an explicit purchaseQuantity from the API still wins", () => {
  assert.strictEqual(paQuantity({ purchaseQuantity: 2 }, 5), 2);
  assert.strictEqual(paQuantity({ purchaseQuantity: "3" }, 5), 3);
});

/* ------------- a guess must never be delivered silently ---------------- */

test("REGRESSION: an unprovable count is flagged, not just quietly rounded down", () => {
  // $12.50 against a $5 unit is 2.5 units. Delivering one is the safe half; the
  // unsafe half was staying quiet while playerauctionsMarkDelivered then stamped
  // the WHOLE order complete.
  const u = paUnits(order("12.50", 60, "Other Skins"), 5);
  assert.strictEqual(u.qty, 1, "still deliver only what we can prove");
  assert.strictEqual(u.suspect, true, "but say so");
  assert.match(u.why, /does not divide cleanly/);
});

test("a genuinely single-unit order is never flagged", () => {
  // The common case must stay silent or the alert becomes noise.
  for (const [paid, unit] of [["5.00", 5], ["5.40", 5], ["4.99", 5], ["7.00", 5]]) {
    const u = paUnits(order(paid, 26, "Other Skins"), unit);
    assert.strictEqual(u.qty, 1);
    assert.ok(!u.suspect, "$" + paid + " on a $" + unit + " unit should not alert");
  }
});

test("a proved multi-unit order is not flagged either", () => {
  const u = paUnits(order("10.00", 52, "Other Skins"), 5);
  assert.strictEqual(u.qty, 2);
  assert.ok(!u.suspect);
});

test("every result explains itself", () => {
  // `why` is what reaches the operator's Telegram; an empty one is useless.
  for (const u of [
    paUnits(order("10.00", 52, "x"), 5),
    paUnits(order("12.50", 60, "x"), 5),
    paUnits(order("5.00", 11, "x"), 5),
    paUnits({}, 5),
    paUnits({ purchaseQuantity: 2 }, 5),
  ]) {
    assert.ok(u.why && u.why.length > 4, "expected a reason, got " + JSON.stringify(u.why));
  }
});

/* ------------------------ wiring and relapse ---------------------------- */

test("units are computed only AFTER the listing is resolved", () => {
  // The unit price lives on the listing row. Computing qty at the top of
  // deliverOrder — before the row is known — is what forced the fallback onto
  // the item count in the first place.
  const deliver = SRC.slice(SRC.indexOf("async function deliverOrder("));
  const rowAt = deliver.indexOf('if (!row) return { orderId, skipped: "no listing row');
  const qtyAt = deliver.indexOf("const units = paUnits(order, row.price)");
  assert.ok(qtyAt > 0, "qty should be derived from the listing price");
  assert.ok(rowAt > 0 && qtyAt > rowAt, "qty must be computed after the row is resolved");
});

test("purchased.amount is never read as a unit count again", () => {
  const fn = SRC.slice(
    SRC.indexOf("function paUnits(order, listingPriceUsd) {"),
    SRC.indexOf("// The number on its own"),
  );
  assert.doesNotMatch(
    fn,
    /return Math\.round\(d\.amount\)/,
    "the item count must not be returned as a unit count",
  );
  // Strip comments first: the block deliberately EXPLAINS purchased.amount at
  // length, and an assertion that cannot tell prose from code would fail on its
  // own documentation.
  const code = fn
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /purchased/,
    "the derivation must not dereference the item count at all",
  );
});

test("the suspect alert fires once, and never on a dry run", () => {
  const at = SRC.indexOf("if (units.suspect && !mine.length && !dryRun)");
  assert.ok(at > 0, "the alert must be gated on first handling and on a real run");
  assert.match(SRC.slice(at, at + 700), /CHECK THE UNIT COUNT BY HAND/);
});
