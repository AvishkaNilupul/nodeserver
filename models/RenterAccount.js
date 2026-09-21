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
    // Per-account farming lease. The renter's own lease (Renter.accessEnd)
    // governs the whole bot; this governs ONE account, for "farm this one for
    // 15 days" deals. Null = runs as long as the renter's lease does. When it
    // passes, utils/renterExpiry pulls just this account out of the config.
    farmUntil: { type: Date, default: null, index: true },
    // Stamped when the sweep has already pulled the account, so it doesn't
    // retry every tick (mirrors Renter.botStoppedAt).
    farmEndedAt: { type: Date, default: null },

    lastScanAt: { type: Date, default: null, index: true },
    lastScanStatus: {
      type: String,
      enum: ["pending", "ok", "token_invalid", "error"],
      default: "pending",
      index: true,
    },
    lastScanError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },

    // Farming-progress bookkeeping, mirroring BotAccount.inProgressCount.
    //
    // dropCount counts CLAIMED rewards only and never goes down, so on its own
    // it can prove an account NEVER farmed but never that it STOPPED: a bot
    // that has lost its stream and a bot happily at 11/30 minutes are the same
    // row. The scanner already receives this in the very same Twitch response
    // it uses for dropCount, so persisting it costs no extra API call.
    //
    // 26 paid rent-farm buyers sat on a stack producing nothing for ~47h
    // (2026-09-21) precisely because no field here could tell the two apart.
    inProgressCount: { type: Number, default: 0, index: true },
    inProgressGames: { type: [String], default: [] },
    // When the two fields above were last recomputed. Deliberately distinct
    // from lastScanAt, which also moves on a FAILED scan — a stale snapshot
    // must never be read as a fresh zero.
    farmingSnapshotAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("RenterAccount", renterAccountSchema);
