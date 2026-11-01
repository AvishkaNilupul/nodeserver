// Settings + last-run state of the Steam sale sync (utils/steamSales.js).
// One document, _id "main".
const mongoose = require("mongoose");

const steamSalesStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "main" },
    syncEnabled: { type: Boolean, default: true },
    sessionDays: { type: Number, default: 7 }, // mail page window after a sale
    priceUsd: { type: Number, default: 1 }, // default price for a new listing
    lastTickAt: { type: Date, default: null },
    lastTickOk: { type: Boolean, default: null },
    lastTickNote: { type: String, default: "" },
    lastOrderScanAt: { type: Date, default: null },
    updatedBy: { type: String, default: "" },

    // G2G region offers (utils/steamG2g.js), one per country.
    g2gOffers: [
      {
        _id: false,
        offerId: { type: String, required: true },
        region: { type: String, default: "" },
        serviceId: { type: String, default: "" },
        brandId: { type: String, default: "" },
        relationId: { type: String, default: "" },
        title: { type: String, default: "" },
        priceUsd: { type: Number, default: 1 },
        sessionDays: { type: Number, default: 14 },
        enabled: { type: Boolean, default: true },
        createdAt: { type: Date, default: null },
        createdBy: { type: String, default: "" },
        lastStock: { type: Number, default: null },
        lastStockSyncAt: { type: Date, default: null },
        lastSaleScanAt: { type: Date, default: null },
        lastError: { type: String, default: "" },
      },
    ],
    g2gLastSweepAt: { type: Date, default: null },
    g2gLastSweepNote: { type: String, default: "" },

    // The distributor (utils/steamDistributor.js): which market gets each new
    // account. on = places them; plan = only says what it would do; off.
    distributor: { type: String, enum: ["on", "plan", "off"], default: "on" },
    distributorLastRunAt: { type: Date, default: null },
    distributorLastNote: { type: String, default: "" },
    distributorLast: [
      {
        _id: false,
        at: { type: Date, default: null },
        accountName: { type: String, default: "" },
        region: { type: String, default: "" },
        market: { type: String, default: "" },
        why: { type: String, default: "" },
        done: { type: Boolean, default: false },
        error: { type: String, default: "" },
      },
    ],
    // market|region -> time until which that market is skipped for the region
    // (its offer could not be made or loaded).
    distributorSkip: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

module.exports = mongoose.models.SteamSalesState || mongoose.model("SteamSalesState", steamSalesStateSchema);
