// One Steam account offer on Eldorado (Steam › Accounts, instant delivery).
// Each unit of stock is one SteamAccount; the offer stores a delivery entry per
// account (Steam login + our mail page login) and Eldorado hands one entry to
// each buyer. v1 lists ONE region per offer. See utils/steamSales.js and
// docs/STEAM-SALES.md.
//
// An account belongs to at most ONE live listing (utils/steamSales enforces
// it), so a sale can never hand the same account to two buyers.
const mongoose = require("mongoose");

const listedAccountSchema = new mongoose.Schema(
  {
    steamAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "SteamAccount", required: true },
    // The mail-page session minted for this unit; its password is in the entry.
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "BuyerMailSession", default: null },
    entryId: { type: String, default: "" }, // Eldorado's id for this unit's entry
    login: { type: String, default: "" }, // lowercase Steam account name — matches entries and orders
    label: { type: String, default: "" }, // snapshot for the panel
    state: { type: String, enum: ["listed", "sold", "removed"], default: "listed" },
    addedAt: { type: Date, default: Date.now },
    soldAt: { type: Date, default: null },
    orderId: { type: String, default: "" },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, default: "" },
    // First time the unit was missing from the offer's stock with no order yet.
    missingSince: { type: Date, default: null },
    missingAlertedAt: { type: Date, default: null },
  },
  { _id: false },
);

const steamListingSchema = new mongoose.Schema(
  {
    market: { type: String, default: "eldorado", index: true },
    kind: { type: String, enum: ["region", "game", "boosted", "rivals"], default: "region" },
    preparationId: { type: String, default: "" },
    appId: { type: Number, default: 0 },
    minHours: { type: Number, default: 0 },
    section: { type: mongoose.Schema.Types.Mixed, default: null },
    region: { type: String, default: "", index: true }, // two-letter signup country
    externalId: { type: String, default: "", index: true },
    url: { type: String, default: "" },
    // draft | active | paused | sold_out | removed | error
    status: { type: String, default: "draft", index: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    priceUsd: { type: Number, default: 0 },
    coverSource: { type: String, default: "" },
    mainOfferImage: {
      smallImage: { type: String, default: "" },
      largeImage: { type: String, default: "" },
      originalSizeImage: { type: String, default: "" },
    },
    accounts: [listedAccountSchema],
    remote: {
      offerState: { type: String, default: "" },
      quantity: { type: Number, default: null },
      entries: { type: Number, default: null },
      expireDate: { type: String, default: "" },
      readAt: { type: Date, default: null },
    },
    lastSyncAt: { type: Date, default: null },
    lastRenewedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.models.SteamListing || mongoose.model("SteamListing", steamListingSchema);
