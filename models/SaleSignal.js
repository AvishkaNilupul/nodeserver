const mongoose = require("mongoose");

// Training data for the auto-farmer: one document per observed sale evidence.
// Sources:
//  - "connected": the 24h drop scanner saw a drop's connection status flip
//    from not-connected to connected. A buyer linking the game account is the
//    strongest possible proof the item actually sold and got used.
//  - "drop_reserved": a drop was reserved/delivered through the Shop or a
//    marketplace order (DropLog.soldAt got stamped).
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
      enum: ["connected", "drop_reserved"],
      required: true,
    },
    // Dedupe key so one drop can't generate the same signal twice
    // (e.g. connected stays true across every future scan).
    dedupeKey: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

saleSignalSchema.index({ gameKey: 1, at: -1 });

module.exports = mongoose.model("SaleSignal", saleSignalSchema);
