const mongoose = require("mongoose");

// A renter's OWN drops inventory — the standalone counterpart to DropLog. One
// document per (RenterAccount, drop benefit). Completely separate from the
// operator's DropLog / Drops Archive: utils/renterDropScanner.js writes here and
// only here for renter accounts, so renter drops never appear in, or are counted
// by, the operator's archive.
//
// Same upsert semantics as DropLog: scans upsert by (account, benefitId) — new
// drops are inserted, already-known ones just refresh lastSeenAt / state — so the
// archive outlives Twitch's ~6-month inventory window.
const renterDropSchema = new mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RenterAccount",
      required: true,
      index: true,
    },
    // Denormalised owner, so per-renter drop views/aggregates don't need to
    // join back through RenterAccount.
    renter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Renter",
      required: true,
      index: true,
    },
    login: { type: String, default: "", index: true },

    // Stable identifier of the reward within an account (benefit id when
    // available, otherwise the drop id).
    benefitId: { type: String, required: true },
    dropId: { type: String, default: "" },

    name: { type: String, default: "" },
    imageURL: { type: String, default: "" },
    imageLocal: { type: String, default: "" },
    game: { type: String, default: "", index: true },
    gameId: { type: String, default: "" },
    campaign: { type: String, default: "", index: true },
    // Normalised key used to group the same reward across accounts (name+game).
    itemKey: { type: String, default: "", index: true },
    count: { type: Number, default: 1 },

    awardedAt: { type: Date, default: null },
    connected: { type: Boolean, default: false },
    requiredAccountLink: { type: String, default: "" },
    state: { type: String, default: "claimed" },
    source: { type: String, default: "gameEventDrop" },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// A reward is unique per account; this both dedupes and powers fast upserts.
renterDropSchema.index({ account: 1, benefitId: 1 }, { unique: true });

module.exports = mongoose.model("RenterDrop", renterDropSchema);
