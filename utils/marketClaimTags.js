// The reservation tags the marketplace publishers/fulfillers write into
// DropLog.soldToUsername when a drop is attached to a LIVE LISTING.
//
// A drop carrying one of these is committed to an offer, not sold to anyone:
// soldAt is stamped so no second listing can take it, but no buyer has it yet.
// Everything else in soldToUsername IS a real delivery — a Shop buyer's name,
// "bulk:<order>", "reseller:<name>", or a manual/hand sale.
//
// This list used to be copy-pasted into every consumer, and each copy drifted:
// when Eldorado and PlayerAuctions went live their tags were missing, so a
// merely-listed drop read as a real sale in the drop archive, made the scanner
// stop farming a game that had not sold, and made the recycler treat listed
// stock as spent inventory. One list, one import, no drift.
//
// Keep this a superset: adding a marketplace we no longer use costs nothing,
// while a missing tag silently reclassifies live stock as sold.
const MARKET_CLAIM_TAGS = [
  "gameflip",
  "digiseller",
  "ggsel",
  "funpay",
  "zeusx",
  "eldorado",
  "playerauctions",
  "g2g",
  "plati",
  "epicnpc",
  "z2u",
];

const MARKET_CLAIM_TAG_SET = new Set(MARKET_CLAIM_TAGS);

// True when this soldToUsername is a listing reservation rather than a buyer.
function isMarketClaimTag(soldToUsername) {
  return MARKET_CLAIM_TAG_SET.has(String(soldToUsername || "").trim().toLowerCase());
}

// A drop that is reserved (soldAt set) AND carries a buyer rather than a
// listing tag — the "this really went to someone" test.
function isRealSale(drop) {
  if (!drop || !drop.soldAt) return false;
  return !isMarketClaimTag(drop.soldToUsername);
}

module.exports = { MARKET_CLAIM_TAGS, MARKET_CLAIM_TAG_SET, isMarketClaimTag, isRealSale };
