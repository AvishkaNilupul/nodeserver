const test = require("node:test");
const assert = require("node:assert");
const {
  MARKET_CLAIM_TAGS,
  isMarketClaimTag,
  isRealSale,
} = require("../utils/marketClaimTags");

// Every marketplace the site can publish to writes its own reservation tag into
// DropLog.soldToUsername. A tag missing from this list reads as a buyer's name,
// which turns listed-but-unsold stock into a "sale" everywhere the list is
// consulted — the drop archive's sold counts, the scanner's stop-farming
// decision, and the spent-accounts recycler.
const PUBLISHED_MARKETS = require("../models/MarketplaceListing").schema
  .path("marketplace").enumValues;

test("every marketplace we publish to has its reservation tag listed", () => {
  for (const market of PUBLISHED_MARKETS) {
    assert.ok(
      isMarketClaimTag(market),
      `"${market}" can hold live listings but is not a known reservation tag`,
    );
  }
});

test("the tags that went live most recently are covered", () => {
  // Eldorado and PlayerAuctions were added after the original copy-pasted
  // lists were written, and were the ones actually missing in production.
  assert.ok(isMarketClaimTag("eldorado"));
  assert.ok(isMarketClaimTag("playerauctions"));
  assert.ok(isMarketClaimTag("ELDORADO"));
  assert.ok(isMarketClaimTag("  PlayerAuctions  "));
});

test("real buyers are never mistaken for reservation tags", () => {
  assert.equal(isMarketClaimTag(""), false);
  assert.equal(isMarketClaimTag(null), false);
  assert.equal(isMarketClaimTag("manual"), false);
  assert.equal(isMarketClaimTag("Avishka"), false);
  assert.equal(isMarketClaimTag("bulk:BULK-A4C231"), false);
  assert.equal(isMarketClaimTag("reseller:someone"), false);
});

test("isRealSale separates a delivery from a listing reservation", () => {
  const at = new Date();
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "eldorado" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "playerauctions" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "digiseller" }), false);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "somebuyer" }), true);
  assert.equal(isRealSale({ soldAt: at, soldToUsername: "bulk:BULK-1" }), true);
  assert.equal(isRealSale({ soldAt: null, soldToUsername: "somebuyer" }), false);
  assert.equal(isRealSale(null), false);
});

test("the list stays a superset of every copy it replaced", () => {
  // The three former copies, verbatim, so a future trim cannot silently
  // reintroduce the drift this module exists to end.
  for (const tag of ["gameflip", "ggsel", "digiseller", "funpay", "zeusx", "plati", "epicnpc"]) {
    assert.ok(MARKET_CLAIM_TAGS.includes(tag), `${tag} dropped from the shared list`);
  }
});
