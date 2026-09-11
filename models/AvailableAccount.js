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

    // Games already delivered to a buyer on this login. Missing legacy fields
    // are treated as an empty set; manual spent-account recycling stamps this
    // list so claim-time allocation never re-farms a sold game.
    soldGames: { type: [String], default: [] },

    // Append-only trail of pool usage. Writers cap this to the newest 50
    // entries so long-lived accounts cannot grow the document unbounded.
    usageHistory: {
      type: [
        {
          at: { type: Date, default: Date.now },
          event: {
            type: String,
            // "spent" is written by the no-claim side (utils/unclaimedAutoList
            // and routes/noclaimFarmRoutes) when a farmed account's drops have
            // been handed over and it is done. It was missing here: the $push
            // that records it skips validation, so the value landed in the DB
            // fine — and then every later doc.save() on that account threw,
            // which is why accountPoolChecker could not persist a result for
            // any of the 172 accounts that had ever been marked spent.
            // "held" is written by utils/poolStock.holdForStock when a pool
            // check finds farmed-but-unclaimed drops on an available account.
            // It MUST be listed here for the same reason as "spent" above.
            enum: [
              "claimed",
              "released",
              "recycled",
              "rented",
              "returned",
              "sold",
              "spent",
              "deleted",
              "held",
            ],
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
    lastCheckAt: { type: Date, default: null, index: true },
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
    // CLAIMED rewards only (inv.drops) — see unclaimedDropCount for the rest.
    dropCount: { type: Number, default: 0 },
    // Drops watched to 100% and never claimed (inv.inProgress): farmed stock,
    // the thing the no-claim farm sells and a claiming bot destroys. An
    // available account with any is held out of the pool
    // (utils/poolStock.js). Absent on rows not checked since this existed.
    unclaimedDropCount: { type: Number, default: 0 },

    source: { type: String, default: "" },

    // Operator tick in the farm consoles: "sold by hand" — the account keeps
    // farming; the mark is only so the human remembers it already went to a
    // buyer (a manual hand-over, not a platform auto-sale).
    manualSold: { type: Boolean, default: false, index: true },

    // Operator tick in the farm consoles: "listed" — memory only, so the
    // human can see at a glance which accounts are on sale. The account keeps
    // farming; nothing else changes.
    listed: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AvailableAccount", availableAccountSchema);
