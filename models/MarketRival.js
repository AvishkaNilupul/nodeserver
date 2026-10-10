const mongoose = require("mongoose");

// One rival listing on a public market page, as last seen by the market radar
// (utils/marketData). The research scanner reads these pages every hour and used to throw
// the rows away after counting them; this is what survives: who sells what, at what price,
// for how long, and (GGSel/Plati) how many units the listing's lifetime counter has moved.
// `price` is USD as shown; `native` is the rouble price the seller set on GGSel / Plati (the USD
// figure drifts with the exchange rate, so a seller's move is judged on `native`).
const pricePoint = new mongoose.Schema({ at: Date, price: Number, native: Number }, { _id: false });
const counterPoint = new mongoose.Schema({ at: Date, n: Number }, { _id: false });

const marketRivalSchema = new mongoose.Schema(
  {
    market: { type: String, required: true, enum: ["gameflip", "ggsel", "plati"] },
    // The market's own id for the listing (Gameflip uuid, GGSel id_goods, Plati item id).
    listingId: { type: String, required: true },
    game: { type: String, default: "" },
    gameKey: { type: String, required: true },
    title: { type: String, default: "" },
    itemCount: { type: Number, default: null },
    kind: { type: String, default: "drops" },
    seller: { type: String, default: "" },
    sellerName: { type: String, default: "" },
    sellerScore: { type: Number, default: null },
    sellerRatings: { type: Number, default: null },
    priceUsd: { type: Number, default: 0 },
    priceNative: { type: Number, default: null },
    currency: { type: String, default: "USD" },
    // Bounded: a point is added only when the seller actually moved the price.
    priceHistory: { type: [pricePoint], default: [] },
    // GGSel cnt_sell / Plati numsold (a lifetime counter); null on Gameflip.
    counter: { type: Number, default: null },
    // The highest counter ever seen: only a rise above it is a sale (a dip and its return are not).
    counterMax: { type: Number, default: null },
    counterHistory: { type: [counterPoint], default: [] },
    ours: { type: Boolean, default: false },
    onsaleAt: { type: Date, default: null },
    listedAt: { type: Date, default: null },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    // Gameflip only: consecutive scans with a COMPLETE result page that did not contain it.
    missed: { type: Number, default: 0 },
    goneAt: { type: Date, default: null },
    // "sold" once the sold feed shows the same listing id.
    outcome: { type: String, default: "", enum: ["", "sold"] },
  },
  { versionKey: false },
);

marketRivalSchema.index({ market: 1, listingId: 1 }, { unique: true });
marketRivalSchema.index({ gameKey: 1, market: 1, lastSeenAt: -1 });
marketRivalSchema.index({ seller: 1, market: 1 });
marketRivalSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 150 * 86400 });

module.exports = mongoose.model("MarketRival", marketRivalSchema);
