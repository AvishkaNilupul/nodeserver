const mongoose = require("mongoose");

// One Epic Games account offer on a marketplace (Eldorado's "Account" shelf,
// instant delivery). Each unit of stock is one EpicAccount; the offer stores a
// delivery entry per account (Epic login + our mail page login), and Eldorado
// hands one entry to each buyer. See utils/epicSales.js.
//
// An account belongs to at most ONE live listing at a time (utils/epicSales
// enforces it), so a sale can never hand the same account to two buyers.
const listedAccountSchema = new mongoose.Schema(
  {
    epicAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EpicAccount", required: true },
    // The mail-page session minted for this unit. Its password is part of the
    // delivery entry; it turns into the buyer's session once the unit sells.
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "BuyerMailSession", default: null },
    // Eldorado's id for this unit's delivery entry (learned by reading the
    // offer back after a create/edit).
    entryId: { type: String, default: "" },
    login: { type: String, default: "" }, // lowercase Epic login email — matches entries and orders
    label: { type: String, default: "" }, // snapshot for the panel
    state: { type: String, enum: ["listed", "sold", "removed"], default: "listed" },
    addedAt: { type: Date, default: Date.now },
    soldAt: { type: Date, default: null },
    orderId: { type: String, default: "" },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, default: "" },
    // First time the unit was no longer in the offer's stock while no order
    // had been matched to it yet.
    missingSince: { type: Date, default: null },
    missingAlertedAt: { type: Date, default: null },
  },
  { _id: false },
);

const epicListingSchema = new mongoose.Schema(
  {
    market: { type: String, default: "eldorado", index: true },
    externalId: { type: String, default: "", index: true },
    url: { type: String, default: "" },
    // draft | active | paused | sold_out | removed | error
    status: { type: String, default: "draft", index: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    priceUsd: { type: Number, default: 0 },
    hasOriginalEmail: { type: Boolean, default: false },
    gameKey: { type: String, default: "", index: true },
    games: [{ type: String }],
    coverSource: { type: String, default: "" },
    mainOfferImage: {
      smallImage: { type: String, default: "" },
      largeImage: { type: String, default: "" },
      originalSizeImage: { type: String, default: "" },
    },
    accounts: [listedAccountSchema],
    // Last read of the offer itself.
    remote: {
      offerState: { type: String, default: "" },
      quantity: { type: Number, default: null },
      entries: { type: Number, default: null },
      expireDate: { type: String, default: "" },
      readAt: { type: Date, default: null },
    },
    lastSyncAt: { type: Date, default: null },
    lastOrderScanAt: { type: Date, default: null },
    lastRenewedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicListing", epicListingSchema);
