const mongoose = require("mongoose");

// Tiny key/value state for the market radar. Today it holds one document, `ownSellers`: the
// seller ids that are OURS on each public market, learned from our own listings (our GGSel /
// Digiseller `externalId` is the same id the public page uses), so a row from one of our
// other offers is never counted as a rival.
const marketDataStateSchema = new mongoose.Schema(
  {
    _id: { type: String },
    gameflip: { type: [String], default: [] },
    ggsel: { type: [String], default: [] },
    plati: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

module.exports = mongoose.model("MarketDataState", marketDataStateSchema);
