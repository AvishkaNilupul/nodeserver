const mongoose = require("mongoose");

// One FunPay offer we can resell (utils/funpayResale.js, utils/funpayWatch.js).
// The list is data, not code: which sellers we buy from is never committed.
const competitorSchema = new mongoose.Schema(
  {
    offerId: { type: String, default: "" },
    seller: { type: String, default: "" },
    priceUsd: { type: Number, default: null },
    quantity: { type: Number, default: null },
    title: { type: String, default: "" },
    state: { type: String, default: "" },
    seenAt: { type: Date, default: null },
    sold24h: { type: Number, default: 0 },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    offerId: { type: String, default: "" },
    quantity: { type: Number, default: null },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const funpaySourceSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" },
    offerId: { type: String, required: true, unique: true },
    // FunPay category id, learned from the offer page's back link.
    node: { type: String, default: "" },
    // Eldorado game name handed to mp.eldoradoPublish for a listing of this source.
    game: { type: String, default: "Rocket League" },
    // What the buyer gets, one item per line — the owner's own wording.
    itemsText: { type: String, default: "" },
    // 0 = never buy. The engine also applies the global per-unit maximum.
    maxBuyPriceUsd: { type: Number, default: 0 },
    // May this source be bought automatically for an Eldorado order?
    autoBuy: { type: Boolean, default: false },
    // The watcher keeps the linked Eldorado offer's quantity at this.
    listingQuantity: { type: Number, default: 5 },

    // Last public FunPay read.
    title: { type: String, default: "" },
    sellerId: { type: String, default: "" },
    sellerName: { type: String, default: "" },
    sellerRating: { type: Number, default: null },
    sellerReviews: { type: Number, default: 0 },
    sellerRecentLow: { type: Number, default: 0 },
    sellerCheckedAt: { type: Date, default: null },
    online: { type: Boolean, default: false },
    autoDelivery: { type: Boolean, default: false },
    priceUsd: { type: Number, default: null },
    seenAt: { type: Date, default: null },
    missingSince: { type: Date, default: null },

    // Same-set offers on Eldorado (full offer GUIDs).
    competitorOfferIds: { type: [String], default: [] },
    competitors: { type: [competitorSchema], default: [] },
    competitorHistory: { type: [historySchema], default: [] },
    lowestCompetitorUsd: { type: Number, default: null },
    suggestedPriceUsd: { type: Number, default: null },
    estProfitUsd: { type: Number, default: null },

    watchedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.model("FunpaySource", funpaySourceSchema);
