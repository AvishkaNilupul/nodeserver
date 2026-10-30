const mongoose = require("mongoose");

// Settings + last plan of the Epic auto-distributor (utils/epicDistributor.js).
// One document, _id "main". See docs/EPIC-DISTRIBUTOR-CONTRACT.md.
const planRow = new mongoose.Schema(
  {
    accountId: { type: String, default: "" },
    label: { type: String, default: "" },
    games: [{ type: String }],
    // pa | eldorado | g2g | reserve | hold | skip
    decision: { type: String, default: "" },
    target: { type: String, default: "" },
    reason: { type: String, default: "" },
    // "placed" | "failed" | "queued" | "" (plan only)
    outcome: { type: String, default: "" },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: "main" },
    mode: { type: String, enum: ["off", "plan", "on"], default: "plan" },
    holdWhileFree: { type: Boolean, default: true },
    pa: {
      enabled: { type: Boolean, default: true },
      maxLive: { type: Number, default: 3 },
      priceUsd: { type: Number, default: 5 },
    },
    eldorado: {
      enabled: { type: Boolean, default: true },
      maxPerListing: { type: Number, default: 10 },
    },
    g2g: {
      enabled: { type: Boolean, default: true },
      maxStock: { type: Number, default: 10 },
    },
    // Encrypted JSON {phone, city}: the owner's own contact for PlayerAuctions'
    // original-owner fields. Never returned in clear.
    ownerEnc: { type: String, default: "" },
    ownerUpdatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: "" },
    lastRunAt: { type: Date, default: null },
    lastRunMode: { type: String, default: "" },
    lastRunOk: { type: Boolean, default: true },
    lastRunNote: { type: String, default: "" },
    lastPlacedAt: { type: Date, default: null },
    lastPlan: [planRow],
    lastMarkets: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicDistributorState", schema);
