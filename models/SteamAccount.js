// Steam accounts made by the local generator on the Mac (tools/steam-signup).
// Rows arrive through tools/steam-signup/cloud-import.cjs and are then managed
// on /steam-accounts.html. Contract: docs/STEAM-ACCOUNTS.md.
const mongoose = require("mongoose");

// boosting = in the hour-boost pool (utils/steamBoost.js), not on sale.
const STAGES = ["stock", "listed", "sold", "problem", "boosting"];

const gameSchema = new mongoose.Schema(
  {
    appId: { type: Number, default: null },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    priceUsd: { type: Number, default: 0, min: 0 },
    addedAt: { type: Date, default: Date.now },
    playtimeMinutes: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const steamAccountSchema = new mongoose.Schema(
  {
    // The account's id in the Mac vault. Repeat uploads match on it.
    localId: { type: String, required: true, unique: true },
    accountName: { type: String, required: true, trim: true },
    // secretBox ciphertext ("enc:v1:…"). Never sent in list responses.
    password: { type: String, default: "" },
    email: { type: String, default: "" },

    signupCountry: { type: String, default: null },
    requestedCountry: { type: String, default: null },
    proxyCountry: { type: String, default: null },
    proxyCity: { type: String, default: "" },
    // Steam store region. null = nobody has checked it in Steam yet.
    storeCountry: { type: String, default: null },
    steamId64: { type: String, default: "" },

    games: { type: [gameSchema], default: [] },
    stage: { type: String, enum: STAGES, default: "stock" },
    notes: { type: String, default: "", maxlength: 2000 },
    soldAt: { type: Date, default: null },
    soldNote: { type: String, default: "", maxlength: 300 },
    // Set when hour boosting starts, never cleared: the account now owns free
    // games and idle hours, so the empty-account region offers refuse it.
    boostedAt: { type: Date, default: null },

    source: { type: String, default: "generator" },
    signedUpAt: { type: Date, default: null },
    importedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

steamAccountSchema.statics.STAGES = STAGES;

module.exports =
  mongoose.models.SteamAccount ||
  mongoose.model("SteamAccount", steamAccountSchema);
