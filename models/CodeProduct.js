const mongoose = require("mongoose");

// A sellable code bundle (docs/code-shop/01-DATA.md). One product owns one
// AccountOffer; its units are that offer's SuppliedAccount rows, each holding
// one code per slot in its encrypted password. The ledger (models/CodeStock)
// says which code sits in which unit.
//
// `markets` is refused in the schema, not just in publish.js: Gameflip and
// Plati/Digiseller are blocked, so the code shop may only ever name these two.
const MARKETS = ["eldorado", "ggsel"];

const slotSchema = new mongoose.Schema(
  {
    slotKey: { type: String, default: "" },
    label: { type: String, default: "" },
    image: { type: String, default: "" },
    nameRaw: { type: String, default: "" },
    campaignTitle: { type: String, default: "" },
  },
  { _id: false },
);

const competitorOfferSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    title: { type: String, default: "" },
    priceUsd: { type: Number, default: 0 },
    qty: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    sameSet: { type: Boolean, default: false },
    // Where its title-or-description match came from: "title" or "description".
    matchedIn: { type: String, default: "" },
  },
  { _id: false },
);

const codeProductSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    gameNo: { type: String, default: "", index: true },
    gameName: { type: String, default: "" },
    marketGame: { type: String, default: "" },
    groupKeys: { type: [String], default: [] },
    // Order = order of the codes in the buyer text.
    slots: { type: [slotSchema], default: [] },
    slotSetHash: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "retired"],
      default: "draft",
      index: true,
    },
    origin: {
      type: String,
      enum: ["auto", "adopted", "manual"],
      default: "auto",
    },
    kind: {
      type: String,
      enum: ["full", "leftover", "custom"],
      default: "full",
    },
    // The owner changed a draft, so the planner keeps it as it is.
    edited: { type: Boolean, default: false },
    // The planner no longer proposes this draft.
    stale: { type: Boolean, default: false },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountOffer",
      default: null,
    },
    // Unit label counter, only ever moved with $inc.
    unitSeq: { type: Number, default: 0 },

    texts: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
      deliveryTemplate: { type: String, default: "" },
      coverTitle: { type: String, default: "" },
      coverServiceText: { type: String, default: "" },
      coverBullets: { type: [String], default: [] },
    },

    // "fixed" (the default, and always for adopted offers) is never repriced.
    pricing: {
      mode: { type: String, enum: ["fixed", "auto"], default: "fixed" },
      priceUsd: { type: Number, default: 1 },
      floorUsd: { type: Number, default: 0.5 },
      clearance: { type: Boolean, default: false },
      followCompetitors: { type: Boolean, default: false },
      lastChangeAt: { type: Date, default: null },
      lastReason: { type: String, default: "" },
    },

    markets: {
      type: [String],
      default: ["eldorado"],
      validate: {
        validator: (v) =>
          Array.isArray(v) && v.every((m) => MARKETS.includes(m)),
        message: (props) =>
          "markets may only contain " +
          MARKETS.join(", ") +
          " (got " +
          JSON.stringify(props.value) +
          ")",
      },
    },

    ggsel: {
      vaultSize: { type: Number, default: 5 },
    },

    publish: {
      lastError: { type: String, default: "" },
      lastAttemptAt: { type: Date, default: null },
    },

    competitors: {
      scannedAt: { type: Date, default: null },
      queries: { type: [String], default: [] },
      lowestSameSetUsd: { type: Number, default: null },
      offers: { type: [competitorOfferSchema], default: [] },
    },

    // Earliest useBy of its on-sale codes.
    useBy: { type: Date, default: null },
    // The planner's estimate.
    proposed: {
      units: { type: Number, default: 0 },
      at: { type: Date, default: null },
    },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: "" },
    retiredAt: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CodeProduct", codeProductSchema);
