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

    // Append-only trail of pool usage. Writers cap this to the newest 50
    // entries so long-lived accounts cannot grow the document unbounded.
    usageHistory: {
      type: [
        {
          at: { type: Date, default: Date.now },
          event: {
            type: String,
            enum: ["claimed", "released", "recycled", "rented", "returned", "sold", "deleted"],
          },
          game: { type: String, default: "" },
          campaignId: { type: String, default: "" },
          note: { type: String, default: "" },
          actor: { type: String, default: "" },
          host: { type: String, default: "" },
          _id: false,
        },
      ],
      default: [],
    },

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
    //
    // "suspended" is the one verdict that is final: Twitch no longer has the
    // account at all (utils/twitchAccountState.js). Unlike a dead token or a
    // failed integrity gate there is nothing to re-auth, so these rows are not
    // supply — 71 of them were still sitting here as `available`/`ok` on prod,
    // getting claimed and deployed into bots that could never farm anything.
    lastCheckStatus: {
      type: String,
      enum: [
        "",
        "ok",
        "token_invalid",
        "integrity_failed",
        "error",
        "suspended",
      ],
      default: "",
    },
    lastCheckError: { type: String, default: "" },
    suspendedAt: { type: Date, default: null },
    // Last time the token-less existence probe looked this login up on Twitch.
    // Separate from lastCheckAt because the two answer different questions ("can
    // this token still farm" vs "does this account still exist") and because it
    // is what keeps the sweep from re-probing the whole claimable pool every ten
    // minutes: a row is re-probed once a day at most.
    existsProbeAt: { type: Date, default: null },
    dropCount: { type: Number, default: 0 },

    source: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AvailableAccount", availableAccountSchema);
