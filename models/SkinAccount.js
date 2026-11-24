const mongoose = require("mongoose");
const item = new mongoose.Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    count: { type: Number, required: true, min: 1 },
    kind: {
      type: String,
      enum: ["reward", "body", "goal", "decal", "other"],
      default: "other",
    },
    paint: { type: String, default: "" },
    certification: { type: String, default: "" },
  },
  { _id: false },
);
const home = new mongoose.Schema(
  { host: String, file: String, container: String },
  { _id: false },
);
// The lifetime ownership ledger. A linked/redeemed identity is never released
// back into the fresh-account or per-game Twitch pools, even after delisting.
const schema = new mongoose.Schema(
  {
    epicAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EpicAccount",
      required: true,
      unique: true,
    },
    botAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
      unique: true,
    },
    twitchLogin: {
      type: String,
      required: true,
      lowercase: true,
      unique: true,
    },
    twitchId: { type: String, required: true, unique: true },
    gameKey: {
      type: String,
      enum: ["rocket-league"],
      default: "rocket-league",
    },
    gameName: { type: String, default: "Rocket League" },
    listingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EpicListing",
      default: null,
    },
    remoteOfferId: { type: String, default: "" },
    sellerId: { type: String, default: "" },
    listingPriceUsd: { type: Number, default: 4.99 },
    state: {
      type: String,
      enum: ["preparing", "ready", "listed", "paused", "attention", "sold"],
      default: "preparing",
      index: true,
    },
    ownershipStatus: {
      type: String,
      enum: ["owned", "quarantined", "sold"],
      default: "owned",
    },
    // Only the worker's own pause of a previously active offer can be undone.
    farmReadRecovery: {
      type: String,
      enum: ["", "recheck", "resume"],
      default: "",
    },
    pendingPauseOfferId: { type: String, default: "" },
    soldAt: { type: Date, default: null },
    holdTag: { type: String, required: true },
    heldAt: { type: Date, default: Date.now },
    profile: {
      region: String,
      level: { type: Number, default: 0 },
      rank: { type: String, default: "Unranked" },
      credits: { type: Number, default: 0 },
      platform: { type: String, default: "PC" },
    },
    link: {
      status: {
        type: String,
        enum: ["pending", "verified", "broken"],
        default: "pending",
      },
      verifiedAt: Date,
      epicAccountId: String,
      twitchId: String,
      detail: String,
      lastCheckedAt: Date,
    },
    farm: {
      enabled: { type: Boolean, default: false },
      allowed: { type: Boolean, default: false },
      status: { type: String, default: "stopped" },
      host: String,
      configFile: String,
      container: String,
      lastCheckedAt: Date,
      lastError: String,
      needsReload: { type: Boolean, default: false },
      owedHomes: { type: [home], default: [] },
    },
    inventory: {
      verified: { type: [item], default: [] },
      pending: { type: [item], default: [] },
      verifiedAt: Date,
      evidence: String,
      lastScanAt: Date,
      scanError: String,
      // Cumulative per-benefit high water survives disappearing archive rows.
      baseline: { type: mongoose.Schema.Types.Mixed, default: {} },
      highWater: { type: mongoose.Schema.Types.Mixed, default: {} },
      baselineAt: Date,
    },
    pricing: {
      mode: {
        type: String,
        enum: ["manual", "market", "growth"],
        default: "growth",
      },
      floorUsd: { type: Number, default: 4.99 },
      ceilingUsd: { type: Number, default: 100 },
      basePriceUsd: { type: Number, default: 4.99 },
      currentUsd: Number,
      proposedUsd: Number,
      reason: String,
      checkedAt: Date,
      growthRates: {
        type: mongoose.Schema.Types.Mixed,
        default: {
          basicDropUsd: 0.1,
          premiumDropUsd: 0.2,
          cosmeticUsd: 0.5,
          duplicateCosmeticUsd: 0.1,
          apexUsd: 1,
        },
      },
      growthBaseline: { type: mongoose.Schema.Types.Mixed, default: {} },
      growthBaselineAt: Date,
    },
    listingMeta: {
      mainOfferImage: mongoose.Schema.Types.Mixed,
      offerImages: { type: [mongoose.Schema.Types.Mixed], default: [] },
      section: mongoose.Schema.Types.Mixed,
      coverSource: String,
      lastContentHash: String,
    },
    // Durable intent is written BEFORE a remote call. Ambiguous creates are
    // never retried; ambiguous edits remain paused until an operator refresh.
    mutation: { kind: String, at: Date, wasActive: Boolean, detail: String },
    lastSaleCheckAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    history: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            event: String,
            message: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
module.exports = mongoose.model("SkinAccount", schema);
