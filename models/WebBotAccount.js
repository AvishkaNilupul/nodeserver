const mongoose = require("mongoose");

// Twitch farming account driven by a WEB-client OAuth token instead of the
// Android-app token BotAccount uses. Web tokens can't clear Twitch's Client-
// Integrity gate on `ViewerDropsDashboard`/`DropCampaignDetails`, but they
// CAN spade-ping their way to progressing time-based drops — which is all a
// farmer strictly needs. Kept separate from BotAccount so the existing rig
// (containers, dropScanner, config files, sale bookkeeping) is untouched.
//
// The identity key is `webToken` (the third field of a supplier's
// "user:pass:clienttoken" line). `login` is populated from `/validate`.
const webBotAccountSchema = new mongoose.Schema(
  {
    webToken: { type: String, required: true, unique: true, index: true },
    login: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    credUsername: { type: String, default: "" },
    // Passwords are optional — the webbot never needs one to farm. Stored
    // encrypted only if the operator opts to keep them for future re-auth.
    credPasswordEnc: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    enabled: { type: Boolean, default: true, index: true },
    host: { type: String, default: "webbot", index: true },

    // "ok" = last watch tick spade-credited us and progress ticked
    // "attaching" = watching but no drop-session yet
    // "dead" = /validate failed, token needs replacing
    lastStatus: {
      type: String,
      enum: ["pending", "ok", "attaching", "dead", "idle", "error"],
      default: "pending",
      index: true,
    },
    lastStatusMessage: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null, index: true },

    // What this account is currently doing, refreshed by the manager loop.
    currentGame: { type: String, default: "" },
    currentChannel: { type: String, default: "" },
    currentDropId: { type: String, default: "" },
    currentMinutes: { type: Number, default: 0 },
    requiredMinutes: { type: Number, default: 0 },

    // Rolling counters
    totalMinutesWatched: { type: Number, default: 0 },
    dropsClaimed: { type: Number, default: 0 },
    lastClaimAt: { type: Date, default: null },

    // Web tokens can't clear Twitch's integrity gate on ClaimDropRewards, so
    // this farmer progresses drops but can't claim them. When that's detected
    // the account is flagged and the ready-but-unclaimed count recorded, so an
    // integrity-valid rig (or a human) can claim them externally.
    claimBlocked: { type: Boolean, default: false, index: true },
    dropsReadyUnclaimed: { type: Number, default: 0 },

    // Set when this row was pulled from the shared account pool
    // (AvailableAccount) rather than seeded by hand — so deleting it here can
    // release that pool account back to "available".
    fromPool: { type: Boolean, default: false, index: true },

    // Which farm bot this account is assigned to ("" = idle/unassigned). A bot
    // is a group of accounts farming one game as an isolated Pi container.
    botId: { type: String, default: "", index: true },

    // Operator hint — force this account onto a specific game (bypasses
    // auto-picker). Empty = auto.
    pinnedGame: { type: String, default: "" },

    // Operator tick in the farm console: "sold by hand" — the account keeps
    // farming; the mark is only so the human remembers it already went to a
    // buyer (a manual hand-over, not a platform auto-sale).
    manualSold: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("WebBotAccount", webBotAccountSchema);
