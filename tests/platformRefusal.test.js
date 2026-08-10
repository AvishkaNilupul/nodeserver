// A stock read can fail for two very different reasons, and the guardian
// treats them differently: one dead product is a single-listing problem, while
// a blocked seller or a revoked key takes the WHOLE marketplace offline and is
// reported once per market as a high finding ("auto-feed for this marketplace
// is down until the account is restored").
//
// Telling them apart is a string match on the platform's reason text, and it
// got that wrong in production: digisellerProductStockDetailed prefixes EVERY
// refusal with "Digiseller refused the read: ", including "товар не найден"
// (the SKU was deleted). The matcher keyed on that shared prefix, so a single
// stale product could raise a marketplace-wide outage finding. Both directions
// are pinned here — the real account-level failures must still match.
const test = require("node:test");
const assert = require("node:assert");
const { platformRefusedRead } = require("../utils/marketplaceGuardian");

// Reason strings as digisellerProductStockDetailed / ggselOfferStockDetailed
// actually build them (observed in the prod error log, 2026-08-10).
const SELLER_BLOCKED =
  "Digiseller refused the read: продавец товара заблокирован";
const PRODUCT_GONE =
  "Digiseller refused the read: запрашиваемый вами товар не найден";
const NO_STOCK_FIELD =
  "response had no num_in_stock/in_stock/count_goods (authenticated read)";
const SHOW_REST_OFF =
  "response had no num_in_stock/in_stock/count_goods (show_rest=0) — enable " +
  "'show remaining quantity' on the product to make it readable";

test("a blocked seller is an account-level refusal", () => {
  // 5335 of these in the prod log while the Digiseller seller account was
  // blocked — every listing on the market was unfeedable, which is exactly
  // the case the one-finding-per-marketplace path exists for.
  assert.strictEqual(platformRefusedRead(SELLER_BLOCKED), true);
});

test("a deleted product is NOT a marketplace outage", () => {
  // The regression: this shares the "refused the read" prefix with the
  // blocked-seller case but means only that one SKU is gone. Matching it
  // claimed the whole of Digiseller was down off a single stale listing.
  assert.strictEqual(platformRefusedRead(PRODUCT_GONE), false);
});

test("an unparseable response is not a refusal", () => {
  // The read succeeded; we just couldn't find a stock number in it. That is a
  // per-listing "stock-unknown", never an account outage.
  assert.strictEqual(platformRefusedRead(NO_STOCK_FIELD), false);
  assert.strictEqual(platformRefusedRead(SHOW_REST_OFF), false);
});

test("revoked or rights-less keys still count as refusals", () => {
  // The other ways a market goes down account-wide. These must keep matching
  // after the prefix was removed from the pattern.
  assert.strictEqual(platformRefusedRead("request failed: HTTP 401"), true);
  assert.strictEqual(platformRefusedRead("request failed: HTTP 403"), true);
  assert.strictEqual(platformRefusedRead("access denied"), true);
  assert.strictEqual(platformRefusedRead("недостаточно прав"), true);
  assert.strictEqual(platformRefusedRead("seller account suspended"), true);
  assert.strictEqual(platformRefusedRead("auth-0 token rejected"), true);
});

test("a 404 or 500 is a transport problem, not an account refusal", () => {
  // Narrowing HTTP 40[13] to 401/403 must not start matching other codes: a
  // 404 is the product being gone, a 500 is the platform having a bad minute.
  assert.strictEqual(platformRefusedRead("request failed: HTTP 404"), false);
  assert.strictEqual(platformRefusedRead("request failed: HTTP 500"), false);
  assert.strictEqual(
    platformRefusedRead("request failed: timeout of 20000ms exceeded"),
    false,
  );
});

test("an empty or missing reason never trips the outage path", () => {
  assert.strictEqual(platformRefusedRead(""), false);
  assert.strictEqual(platformRefusedRead(null), false);
  assert.strictEqual(platformRefusedRead(undefined), false);
});
