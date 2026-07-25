const mongoose = require("mongoose");

// One account parked inside a StashSet. Deliberately mirrors the storable shape
// of models/AvailableAccount.js (so "Move set -> Account Pool" is a clean
// hand-off), but lives in its own collection that no bot/pool/drop-scanner code
// touches. Credentials are encrypted at rest via utils/secretBox, same
// convention as AvailableAccount and BotAccount.
//
// The live-check bookkeeping here is intentionally lighter than the pool's: a
// stash scan only asks "does this token still authenticate against Twitch, and
// how many drops does it see" (see utils/stashChecker.js). It never writes to
// the Drops Archive, so scanning a stash set has zero side effects anywhere
// else in the app.
const stashAccountSchema = new mongoose.Schema(
  {
    setId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StashSet",
      required: true,
      index: true,
    },

    username: { type: String, required: true, index: true },
    // Lowercased mirror; uniqueness is per-set (same account can't sit twice in
    // one set, but may exist in different sets), enforced by the compound index
    // below.
    usernameLower: { type: String, required: true },

    // Encrypted at rest.
    password: { type: String, default: "" },
    email: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    // Present once the account has been through Twitch's device-auth flow.
    clientSecret: { type: String, default: "" },
    uniqueId: { type: String, default: "" },
    twitchId: { type: String, default: "" },

    // Result of the last stash live-check.
    //   ""              - never checked
    //   "ok"            - token authenticates and passes the integrity gate
    //   "token_invalid" - Twitch rejected the token
    //   "integrity_failed" - authenticates but fails the bot's drops query gate
    //   "error"         - transient/other failure; retry next scan
    lastCheckAt: { type: Date, default: null },
    lastCheckStatus: {
      type: String,
      enum: ["", "ok", "token_invalid", "integrity_failed", "error"],
      default: "",
    },
    lastCheckError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },

    source: { type: String, default: "" },
  },
  { timestamps: true },
);

// One row per username within a given set.
stashAccountSchema.index({ setId: 1, usernameLower: 1 }, { unique: true });

module.exports = mongoose.model("StashAccount", stashAccountSchema);
