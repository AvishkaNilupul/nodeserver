const mongoose = require("mongoose");

// One observed sale on a RIVAL's listing, recorded by the market radar (utils/marketData).
//
// Two sources, both read from pages the research scanner already fetches:
//   "sold-feed" — Gameflip's `status=sold` search. One row per sold listing, keyed on the
//                 listing id so the same sale seen on every later scan is one row. `soldAt`
//                 is the listing's `updated` stamp at first sight and `ttsHours` is
//                 `updated - onsale`: how long that listing took to sell, for ANY seller.
//   "counter"   — GGSel `cnt_sell` / Plati `numsold` are lifetime counters, never dated. When
//                 the counter of a product rises between two scans, that many units sold in
//                 the window [prevObservedAt, soldAt]. The key carries the new count so a
//                 retry or a duplicate tap cannot record the same increase twice.
//
// This is evidence of what buyers PAID other sellers, which nothing else in the system
// has: asking prices are not proof anyone bought.
const marketSaleSchema = new mongoose.Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },
    market: { type: String, required: true, enum: ["gameflip", "ggsel", "plati"] },
    listingId: { type: String, required: true },
    game: { type: String, default: "" },
    gameKey: { type: String, required: true },
    title: { type: String, default: "" },
    // Advertised item count parsed from the title (null when it states none).
    itemCount: { type: Number, default: null },
    // "drops" | "farm" (marketPricing.classifyKind). A rent-farm window is a different product.
    kind: { type: String, default: "drops" },
    // Unit price in USD as the page showed it (and the seller's rouble price on GGSel / Plati).
    priceUsd: { type: Number, default: 0 },
    priceNative: { type: Number, default: null },
    units: { type: Number, default: 1 },
    seller: { type: String, default: "" },
    sellerName: { type: String, default: "" },
    // The seller's reputation on THAT market's own scale (Gameflip 0..1, GGSel ~0..5,
    // Plati unbounded points): only ever compared within one market.
    sellerScore: { type: Number, default: null },
    sellerRatings: { type: Number, default: null },
    onsaleAt: { type: Date, default: null },
    listedAt: { type: Date, default: null },
    soldAt: { type: Date, required: true },
    // Counter sales: when the lower counter was last seen (the window's start), and the counter
    // this sale brought the listing to (so a later reading is never counted from an older one).
    prevObservedAt: { type: Date, default: null },
    counterAfter: { type: Number, default: null },
    ttsHours: { type: Number, default: null },
    source: { type: String, required: true, enum: ["sold-feed", "counter"] },
    // One of OUR listings (kept so our share and position can be measured; never a rival).
    ours: { type: Boolean, default: false },
    firstSeenAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

marketSaleSchema.index({ gameKey: 1, soldAt: -1 });
marketSaleSchema.index({ market: 1, soldAt: -1 });
marketSaleSchema.index({ seller: 1, market: 1, soldAt: -1 });
marketSaleSchema.index({ market: 1, listingId: 1, counterAfter: -1 });
// Small rows, ~hundreds a day: a year of history is cheap and is what a campaign playbook needs.
marketSaleSchema.index({ soldAt: 1 }, { expireAfterSeconds: 400 * 86400 });

module.exports = mongoose.model("MarketSale", marketSaleSchema);
