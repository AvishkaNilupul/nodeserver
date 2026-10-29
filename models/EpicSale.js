const mongoose = require("mongoose");

// One marketplace order for an Epic account listing. Written by the sale sync
// in utils/epicSales.js the first time the order is seen, then kept up to date
// (state changes, disputes). `accounts` are the accounts the buyer received —
// read from the order's delivery entries when Eldorado shows them, else from
// which unit left the offer's stock.
const soldAccountSchema = new mongoose.Schema(
  {
    epicAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EpicAccount", default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "BuyerMailSession", default: null },
    label: { type: String, default: "" },
    login: { type: String, default: "" },
  },
  { _id: false },
);

const epicSaleSchema = new mongoose.Schema(
  {
    market: { type: String, default: "eldorado", index: true },
    orderId: { type: String, required: true, unique: true, index: true },
    offerId: { type: String, default: "", index: true },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: "EpicListing", default: null, index: true },
    accounts: [soldAccountSchema],
    title: { type: String, default: "" },
    priceUsd: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    buyerUsername: { type: String, default: "" },
    orderState: { type: String, default: "", index: true },
    orderCreatedAt: { type: Date, default: null },
    // order-details | stock-diff | unmatched
    matchedBy: { type: String, default: "" },
    needsAttention: { type: Boolean, default: false, index: true },
    note: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    // G2G (utils/epicG2g): we deliver these ourselves through the order page.
    // submittedAt = the account form was sent; deliveredAt = G2G's order shows
    // it delivered. releasedAt = the order was cancelled before delivery and
    // the accounts went back on the shelf.
    submittedAt: { type: Date, default: null },
    submitCount: { type: Number, default: 0 },
    deliveredAt: { type: Date, default: null },
    alertedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    // Automatic delivery stopped for this order after an unexpected error: the
    // owner was paged to deliver it by hand, so nothing is sent by itself.
    held: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicSale", epicSaleSchema);
