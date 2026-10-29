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
    // G2G offers whose orders utils/epicG2g delivers by itself, through the
    // order page's account form. The offer itself is made by hand on g2g.com;
    // linking it names the games every delivered account must own.
    g2gOffers: [
      {
        _id: false,
        offerId: { type: String, required: true },
        // "order" = G2G Manual delivery (we fill the form on each order);
        // "instant" = G2G Auto delivery from the stock we load (EpicG2gUnit).
        mode: { type: String, default: "order" },
        serviceId: { type: String, default: "" },
        brandId: { type: String, default: "" },
        relationId: { type: String, default: "" },
        lastStockLoadAt: { type: Date, default: null },
        lastSaleScanAt: { type: Date, default: null },
        title: { type: String, default: "" },
        games: [{ type: String }],
        gameKey: { type: String, default: "" },
        enabled: { type: Boolean, default: true },
        // Mail page window for this market (G2G asks sellers for >= 14 days).
        sessionDays: { type: Number, default: 14 },
        // Keep the offer's stock number equal to the accounts ready to deliver.
        syncStock: { type: Boolean, default: true },
        lastStockSyncAt: { type: Date, default: null },
        lastStock: { type: Number, default: null },
        linkedAt: { type: Date, default: null },
        linkedBy: { type: String, default: "" },
      },
    ],
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
