const mongoose = require("mongoose");

// Training data for the auto-farmer: one document per observed sale evidence.
// Sources, in descending order of how much they prove:
//  - "connected": the 24h drop scanner saw a drop's connection status flip
//    from not-connected to connected. A buyer linking the game account is the
//    strongest possible proof the item actually sold and got used.
//  - "listing_sold": a marketplace told us a listing (or one unit of a
//    quantity listing) was BOUGHT — the Gameflip sale poller, a delist that
//    came back "already sold", a Plati/GGSel stock count that went down, or
//    the operator's manual mark-sold. Money changed hands.
//  - "drop_reserved": a drop was reserved on an account. NOT a sale — this is
//    written every time stock is CLAIMED for a listing (auto-lister publish,
//    guardian restock), which happens long before any buyer appears. It is
//    kept for the audit trail and deliberately excluded from demand learning;
//    counting it made farming its own evidence of demand (farm -> stock ->
//    "sales" -> farm more). See internalSalesForGame in utils/autoFarmer.js.
// The auto-farmer aggregates these per game to boost (or create) demand for
// games our own sales history proves are sellable — even when external
// market APIs are quiet.
const saleSignalSchema = new mongoose.Schema(
  {
    game: { type: String, required: true, index: true },
    gameKey: { type: String, required: true, index: true }, // lowercased for grouping
    itemKey: { type: String, default: "" },
    name: { type: String, default: "" },
    login: { type: String, default: "" },
    account: { type: mongoose.Schema.Types.ObjectId, default: null },
    source: {
      type: String,
      enum: ["connected", "listing_sold", "drop_reserved"],
      required: true,
      index: true,
    },
    // Which marketplace the sale came from, when known ("" for connection
    // flips, which prove a sale happened but not where). Lets research score
    // demand per market instead of one global number.
    marketplace: { type: String, default: "" },
    // What the buyer paid, USD, when the platform tells us (0 = unknown).
    // Demand is worth more when it is worth more money.
    priceUsd: { type: Number, default: 0 },
    // Dedupe key so one drop can't generate the same signal twice
    // (e.g. connected stays true across every future scan).
    dedupeKey: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

saleSignalSchema.index({ gameKey: 1, at: -1 });

module.exports = mongoose.model("SaleSignal", saleSignalSchema);
