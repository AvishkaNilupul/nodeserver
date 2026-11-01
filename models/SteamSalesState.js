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
  },
  { timestamps: true },
);

module.exports = mongoose.models.SteamSalesState || mongoose.model("SteamSalesState", steamSalesStateSchema);
