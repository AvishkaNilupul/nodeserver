const mongoose = require("mongoose");

// Per-account ledger for the UNCLAIMED auto-listing system (no-claim farm +
// web-token farm). One row per farmed account that is (or was) auto-listed as
// a sellable unclaimed-drops account.
//
// The row exists so the Auto-list panel can show what is going on even after
// the account's MarketplaceListing rows are sold/delisted and the account has
// left the bot. State changes are logged here with timestamps; the live
// sellable inventory is NEVER stored as truth — it is re-read on every pass.
const unclaimedAccountSchema = new mongoose.Schema(
  {
    // Where the account came from: "noclaim" (Pi no-claim bot config) or
    // "webbot" (WebBotAccount registry).
    source: {
      type: String,
      enum: ["noclaim", "webbot"],
      required: true,
      index: true,
    },
    login: { type: String, default: "", index: true },
    // Lowercased mirror so sweeps collapse onto one row per account.
    loginLower: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    game: { type: String, default: "", index: true },

    // Owner references: the pool row (no-claim) / WebBotAccount row (webbot).
    poolAccountId: { type: String, default: "" },
    webBotAccountId: { type: String, default: "" },

    // The no-claim bot this account was farming from ("" for webbot).
    botId: { type: String, default: "" },
    container: { type: String, default: "" },

    // Snapshot of the unclaimed drops that were listed, for the panel.
    drops: {
      type: [
        {
          _id: false,
          name: { type: String, default: "" },
          game: { type: String, default: "" },
          campaign: { type: String, default: "" },
          itemKey: { type: String, default: "" },
        },
      ],
      default: [],
    },

    // Lifecycle. listed -> sold | expired; expired -> released once the pool
    // return has happened. "skipped" = a candidate that failed eligibility and
    // was recorded with a note so the panel shows why it never listed.
    status: {
      type: String,
      enum: ["listed", "sold", "expired", "released", "skipped"],
      default: "skipped",
      index: true,
    },
    note: { type: String, default: "" },

    // Marketplace rows created for this account (origin:"unclaimed").
    listingIds: { type: [String], default: [] },
    listingExternalIds: { type: [String], default: [] },

    listedAt: { type: Date, default: null, index: true },
    soldAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("UnclaimedAccount", unclaimedAccountSchema);
