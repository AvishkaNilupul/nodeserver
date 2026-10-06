const mongoose = require("mongoose");

// A "bot": N accounts farming one campaign, one game, or everything. The watch
// sockets themselves live in memory, but the definition is persisted so that a
// restart of the redeemer process resumes the bot instead of silently dropping
// it. A v1 row has no `mode` and reads back as "campaign", which is what it was.
const soopFarmTaskSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" }, // the bot name
    // campaign: one pinned dropsIdx · game: every guaranteed campaign of one
    // gameNo · auto: the same for every game.
    mode: {
      type: String,
      enum: ["campaign", "game", "auto"],
      default: "campaign",
    },
    dropsIdx: { type: String, default: null, index: true },
    gameNo: { type: String, default: null },
    target: { type: String, default: "all" }, // all | first
    targetMinutes: { type: Number, default: null }, // v1 field, kept for old rows
    // Skip campaigns whose rewards need a linked game account.
    codesOnly: { type: Boolean, default: false },
    accountIds: { type: [String], default: [] },
    // Accounts that reached their goal (campaign mode).
    doneIds: { type: [String], default: [] },
    active: { type: Boolean, default: true, index: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopFarmTask", soopFarmTaskSchema);
