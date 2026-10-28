const mongoose = require("mongoose");

// Settings + heartbeat for the Epic account sales system (utils/epicSales.js).
// A single document with _id "main". Kept out of utils/settings.json so the
// panel can change it without touching the shared settings file.
const epicSalesStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "main" },
    // The sale sync reads Eldorado only while at least one listing is live.
    // Off = no reads at all (sales still happen on Eldorado; they are just not
    // recorded until it is back on).
    syncEnabled: { type: Boolean, default: true },
    // Days the buyer's mail page stays open after the sale.
    sessionDays: { type: Number, default: 7 },
    // Accounts whose Outlook inbox is ALSO the email of one of our SOOP
    // accounts. The buyer only ever sees mail from Epic on the mail page, never
    // the inbox itself, so listing them is allowed unless this is switched off.
    allowSharedInbox: { type: Boolean, default: true },
    lastTickAt: { type: Date, default: null },
    lastTickOk: { type: Boolean, default: true },
    lastTickNote: { type: String, default: "" },
    lastOrderScanAt: { type: Date, default: null },
    lastProxyCheckAt: { type: Date, default: null },
    lastProxyOk: { type: Boolean, default: null },
    lastProxyAlertAt: { type: Date, default: null },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicSalesState", epicSalesStateSchema);
