const mongoose = require("mongoose");

// Per-account ledger for the UNCLAIMED auto-listing system (no-claim farm +
// web-token farm). One row per farmed account that is (or was) auto-listed as
// a sellable unclaimed-drops account.
//
// The row exists so the Auto-list panel can show what is going on even after
// the account's MarketplaceListing rows are sold/delisted and the account has
// left the bot. State changes are logged here with timestamps; the live
// sellable inventory is NEVER stored as truth — it is re-read on every pass.
//
// One item-set (a game + an exact set of unclaimed drops) is published as ONE
// listing per marketplace, and the ledger rows for that set are its stock
// units: Gameflip exposes one "live" unit at a time (a relist chain), while
// Digiseller/GGSel attach every unit as a delivery code on one product. Each
// account is attached to exactly one marketplace (split round-robin), so a
// sale on one platform can never hand out an account a buyer already received
// elsewhere.
const unclaimedAccountSchema = new mongoose.Schema(
  {
    // Where the account came from: "noclaim" (Pi no-claim bot config).
    source: {
      type: String,
      enum: ["noclaim"],
      required: true,
      index: true,
    },
    login: { type: String, default: "", index: true },
    // Lowercased mirror so sweeps collapse onto one row per account.
    loginLower: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    game: { type: String, default: "", index: true },

    // Owner reference: the pool row (no-claim).
    poolAccountId: { type: String, default: "" },

    // The no-claim bot this account was farming from.
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

    // The item-set's DropSet (ONE per game + exact drop set). Stock units of
    // the same set share it.
    set: { type: mongoose.Schema.Types.ObjectId, ref: "DropSet", default: null },

    // Which marketplace this account is attached to as a stock unit:
    // "gameflip" (live unit or waiting in the relist chain), "digiseller" or
    // "ggsel" (a delivery-code unit on the set's product), "eldorado"/"playerauctions" (handed to
    // a buyer in an Eldorado order chat), "z2u" (handed over in a Z2U order
    // delivery), "g2g" (handed over on a G2G order). "" while deciding.
    market: {
      type: String,
      enum: [
        "",
        "gameflip",
        "digiseller",
        "ggsel",
        "eldorado",
        "playerauctions",
        "z2u",
        "g2g",
      ],
      default: "",
      index: true,
    },

    // Lifecycle. listed -> sold | expired; expired -> released once the pool
    // return has happened. "skipped" = a candidate that failed eligibility and
    // was recorded with a note so the panel shows why it never listed.
    status: {
      type: String,
      enum: ["listed", "sold", "expired", "released", "skipped", "removed"],
      default: "skipped",
      index: true,
    },
    note: { type: String, default: "" },

    // Marketplace rows created for this account (origin:"unclaimed").
    listingIds: { type: [String], default: [] },
    listingExternalIds: { type: [String], default: [] },

    listedAt: { type: Date, default: null, index: true },
    soldAt: { type: Date, default: null },

    // What the unit actually sold for, and where. Stamped by spendAccount from
    // the listing row that carried it.
    //
    // The ledger used to record a sale with FIVE fields and no money at all —
    // `price` was passed into ledgerAccount and never written — so per-game
    // revenue for the whole no-claim farm could only be reconstructed by joining
    // the set's CURRENT listing price, which drifts every time the repricer
    // runs. Unit counts were exact and revenue was a guess, which is the wrong
    // way round for deciding how many accounts a game deserves.
    //
    // 0 means "sold, price unknown" (a buyer-claimed-the-drop detection names no
    // price), which is deliberately distinct from a genuine $0.
    soldPriceUsd: { type: Number, default: 0 },
    soldMarket: { type: String, default: "" },
    expiredAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null, index: true },

    // v3 (docs/UNCLAIMED-BUNDLES-CONTRACT.md). Expiry confirmation: how many
    // consecutive check passes read an EMPTY sellable inventory, and when the
    // first of them happened. One empty read used to delist + release the
    // account, which flapped on transient reads. Reset on any non-empty read.
    emptyReads: { type: Number, default: 0 },
    firstEmptyAt: { type: Date, default: null },
    // Event bundle this account's listed drops resolve to (utils/
    // unclaimedBundles.js classifyHoldings) — "" when no event resolves.
    bundleKey: { type: String, default: "", index: true },
    bundleLabel: { type: String, default: "" },
    // Gameflip lot this waiting unit is a member of ("" = not in a lot).
    lotId: { type: String, default: "", index: true },
  },
  { timestamps: true },
);

// Sales analytics are always "this game, over this window", and `soldAt` was
// unindexed — so every per-game sell-rate query scanned the collection. The
// fleet allocator asks this question on every pass.
unclaimedAccountSchema.index({ game: 1, soldAt: -1 });
unclaimedAccountSchema.index({ status: 1, soldAt: -1 });

module.exports = mongoose.model("UnclaimedAccount", unclaimedAccountSchema);
