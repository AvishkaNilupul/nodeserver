const mongoose = require("mongoose");

// A pool of Twitch accounts that are ready to hand to a *new* bot but aren't
// wired into any bot config yet — distinct from BotAccount, which mirrors
// accounts already deployed in a live config (see routes/accountPoolRoutes.js
// for how the two are cross-checked to avoid duplicates).
//
// Two input shapes feed this pool and either (or both, merged over time) may
// be present on a given document:
//   - Raw credentials from a supplier: username/password/email, no Twitch
//     auth yet.
//   - An already-authenticated bot-config entry: clientSecret/uniqueId/
//     twitchId, which is what TwitchDropsBot's device-auth flow produces —
//     this alone is enough to drop into a bot config, no password needed.
const availableAccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, index: true },
    // Lowercased mirror of username for case-insensitive uniqueness/lookup.
    usernameLower: { type: String, required: true, unique: true, index: true },

    // Encrypted at rest via utils/secretBox, same convention as BotAccount.
    password: { type: String, default: "" },
    email: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    // Present once the account has been through Twitch's device-auth flow.
    clientSecret: { type: String, default: "" },
    uniqueId: { type: String, default: "" },
    twitchId: { type: String, default: "" },

    status: {
      type: String,
      enum: ["available", "claimed"],
      default: "available",
      index: true,
    },
    claimedAt: { type: Date, default: null },
    claimedNote: { type: String, default: "" },

    // Bookkeeping from the on-demand "Check" button — a real call against
    // Twitch's own drops-inventory API (utils/twitchInventory.js, the same
    // one the drop archive scanner uses), so a stored clientSecret is
    // verified against Twitch itself rather than just assumed valid because
    // it's non-empty.
    //
    // "integrity_failed" is the awkward middle case: Twitch accepts the token
    // but refuses the integrity-gated drops query a bot actually runs, so the
    // account authenticates while being unusable. Only device-auth-issued
    // tokens clear that gate — re-running the account through device-auth with
    // its stored password is the fix, which is why these are surfaced by
    // /account-pool/export-needs-auth alongside dead tokens.
    lastCheckAt: { type: Date, default: null },
    lastCheckStatus: {
      type: String,
      enum: ["", "ok", "token_invalid", "integrity_failed", "error"],
      default: "",
    },
    lastCheckError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },

    source: { type: String, default: "" },

    // Set when this account was submitted by a renter (routes/renterRoutes.js)
    // and approved into the pool. Scopes a renter's account list + quota, and
    // tells the operator which renter (and their bot) an account belongs to.
    renterId: { type: String, default: "", index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AvailableAccount", availableAccountSchema);
