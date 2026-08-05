// A delist request whose platform call fails is not necessarily a failed delist.
// If the listing is already gone, or already sold, it is not on sale — which is
// exactly what was asked for — and the row must be resolved. Leaving it active
// with an error is what stranded four rows on prod for weeks, each still holding
// its account reserved out of the sellable pool.
//
// The distinction that matters is Gameflip's one message covering three states:
// "pending sale, sold, or completed". Only the resolved ones are terminal; a sale
// still pending must keep retrying.
const test = require("node:test");
const assert = require("node:assert");

const { delistOutcome } = require("../utils/marketplaces");

test("a sold Gameflip listing is terminal, not a failure", () => {
  assert.equal(
    delistOutcome(
      'Gameflip delist: {"error":{"message":"Cannot change status when listing is pending sale, sold, or completed (sold)","code":400}}',
    ),
    "sold",
  );
});

test("a Gameflip sale still pending stays retryable", () => {
  assert.equal(
    delistOutcome(
      'Gameflip delist: {"error":{"message":"Cannot change status when listing is pending sale, sold, or completed (pending_sale)","code":400}}',
    ),
    "",
  );
});

test("a Digiseller product that no longer exists is gone", () => {
  assert.equal(
    delistOutcome(
      'Digiseller delist: {"retval":-1,"retdesc":"Validation error","errors":[{"code":"product-0","message":[{"locale":"en-US","value":"Product not found"}]}]}',
    ),
    "gone",
  );
});

test("a 404 from any platform is gone", () => {
  assert.equal(delistOutcome('GGSel delist: {"http_status": 404}'), "gone");
});

test("transient failures are not treated as resolved", () => {
  for (const m of [
    "GGSel delist: 504 Gateway Time-out",
    "Gameflip delist: timeout of 20000ms exceeded",
    "G2G: The request is not authorized and cannot access the requested resource.",
    'Digiseller delist: {"retval":-1,"retdesc":"Too many requests"}',
    "",
    null,
  ]) {
    assert.equal(delistOutcome(m), "", "should stay retryable: " + m);
  }
});
