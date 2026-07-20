const mongoose = require("mongoose");

// A renter's OWN account inventory — the standalone counterpart to BotAccount.
// Renter accounts are deliberately kept out of the operator's cross-host
// BotAccount index (and therefore out of the Drops Archive): they are their own
// isolated tenant inventory, scoped to the renter that owns them.
//
// Like BotAccount this is keyed by the account's Twitch auth token
// (clientSecret) — the one field every account always has and what we use to
// query Twitch. clientSecret is globally unique here so the same token can never
// sit on two renter bots; a cross-check against BotAccount (see
// routes/botConfigRoutes.js dedupeAccounts) additionally blocks a token that is
// already live on one of the operator's own bots, so no account is double-farmed.
const renterAccountSchema = new mongoose.Schema(
  {
    // The renter who owns this account (the isolation boundary).
    renter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Renter",
      required: true,
      index: true,
    },

    clientSecret: { type: String, required: true, unique: true, index: true },
    login: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    uniqueId: { type: String, default: "" },

    // The renter bot config this account currently lives in (e.g.
    // config_07.json) and the host it runs on. Mirrors BotAccount so the
    // renter scanner and quota accounting can group by bot.
    configFile: { type: String, default: "" },
    container: { type: String, default: "" },
    host: { type: String, default: "local", index: true },
    enabled: { type: Boolean, default: true },

    // Scan bookkeeping — same shape as BotAccount so utils/renterDropScanner.js
    // can reuse the exact rotation/upsert logic against this collection.
    lastScanAt: { type: Date, default: null, index: true },
    lastScanStatus: {
      type: String,
      enum: ["pending", "ok", "token_invalid", "error"],
      default: "pending",
      index: true,
    },
    lastScanError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("RenterAccount", renterAccountSchema);
