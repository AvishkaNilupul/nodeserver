const mongoose = require("mongoose");

// The persistent drop archive: one document per (account, drop benefit). This
// outlives Twitch's ~6-month inventory window — once a drop is logged here it
// stays even after Twitch stops returning it. Scans upsert by (account,
// benefitId): new drops are inserted, already-known ones just refresh
// lastSeenAt / state.
const dropLogSchema = new mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
      index: true,
    },
    login: { type: String, default: "", index: true },

    // Stable identifier of the reward within an account. Benefit id when
    // available, otherwise the drop id.
    benefitId: { type: String, required: true },
    dropId: { type: String, default: "" },

    name: { type: String, default: "" },
    imageURL: { type: String, default: "" },
    game: { type: String, default: "", index: true },
    gameId: { type: String, default: "" },
    count: { type: Number, default: 1 },

    awardedAt: { type: Date, default: null },
    connected: { type: Boolean, default: false },
    requiredAccountLink: { type: String, default: "" },
    // claimed | connect | connected
    state: { type: String, default: "claimed" },
    // gameEventDrop | inProgressClaimed
    source: { type: String, default: "gameEventDrop" },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// A reward is unique per account; this both dedupes and powers fast upserts.
dropLogSchema.index({ account: 1, benefitId: 1 }, { unique: true });

module.exports = mongoose.model("DropLog", dropLogSchema);
