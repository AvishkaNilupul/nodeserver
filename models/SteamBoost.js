// One Steam account in the hour-boost pool (utils/steamBoost.js). The worker on
// contabo2 (workers/steam-boost) logs in to it and "plays" free games so Steam
// books idle hours. Contract: docs/STEAM-BOOST.md.
const mongoose = require("mongoose");

const STATES = ["queued", "boosting", "stopping", "ready", "stopped", "failed"];

const steamBoostSchema = new mongoose.Schema(
  {
    steamAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "SteamAccount", required: true },
    accountName: { type: String, default: "" },
    region: { type: String, default: "" },
    // queued = waiting for the worker; boosting = logged in and playing;
    // stopped = taken out of the pool; failed = Steam refused for good.
    state: { type: String, enum: STATES, default: "queued", index: true },
    // Bumped by Retry: the worker starts the account again from scratch.
    gen: { type: Number, default: 1 },
    purpose: { type: String, enum: ["game", "boost"], default: "boost" },
    targetHours: { type: Number, default: 1000 },
    saleAppId: { type: Number, default: 730 },
    logoutAt: { type: Date, default: null },
    games: { type: [Number], default: [] }, // AppIDs to idle
    licensed: { type: [Number], default: [] }, // AppIDs Steam granted
    // secretBox ciphertext of the Steam refresh token (the saved login).
    refreshToken: { type: String, default: "" },
    steamID: { type: String, default: "" },

    // Steam's own playtime, minutes per AppID, as last reported.
    minutes: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The LOWEST hours among the games Steam lists as owned.
    hours: { type: Number, default: 0 },
    gamesWithHours: { type: Number, default: 0 },
    hoursAt: { type: Date, default: null },
    reached500At: { type: Date, default: null },
    reached1000At: { type: Date, default: null },

    workerState: { type: String, default: "" }, // the booster's own state word
    playing: { type: Number, default: 0 }, // games being played right now
    exitCountry: { type: String, default: "" },
    exitCity: { type: String, default: "" },
    lastError: { type: String, default: "" },
    lastSeenAt: { type: Date, default: null },
    onlineAt: { type: Date, default: null }, // first time it played

    addedBy: { type: String, default: "" },
    stoppedAt: { type: Date, default: null },
    stopReason: { type: String, default: "" },
  },
  { timestamps: true },
);

// An account is in the pool at most once at a time.
steamBoostSchema.index(
  { steamAccountId: 1 },
  { name: "one_live_boost_per_steam_account", unique: true, partialFilterExpression: { state: { $in: ["queued", "boosting", "stopping"] } } },
);

steamBoostSchema.statics.STATES = STATES;

module.exports = mongoose.models.SteamBoost || mongoose.model("SteamBoost", steamBoostSchema);
