// One recorded sale of Steam account(s) (utils/steamSales.js). orderId is
// unique, so a sale is never recorded twice, whichever pass sees it first.
const mongoose = require("mongoose");

const steamSaleSchema = new mongoose.Schema(
  {
    market: { type: String, default: "eldorado" },
    orderId: { type: String, required: true, unique: true },
    offerId: { type: String, default: "" },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: "SteamListing", default: null },
    title: { type: String, default: "" },
    region: { type: String, default: "" },
    priceUsd: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    buyerUsername: { type: String, default: "" },
    orderState: { type: String, default: "" },
    orderCreatedAt: { type: Date, default: null },
    // order-details | stock-diff | unmatched
    matchedBy: { type: String, default: "" },
    needsAttention: { type: Boolean, default: false },
    note: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    accounts: [
      {
        _id: false,
        steamAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "SteamAccount" },
        sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "BuyerMailSession", default: null },
        label: { type: String, default: "" },
        login: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.models.SteamSale || mongoose.model("SteamSale", steamSaleSchema);
