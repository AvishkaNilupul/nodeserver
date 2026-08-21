const mongoose = require("mongoose");

const poolUsageEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "AvailableAccount",
    index: true,
  },
  username: { type: String, default: "" },
  event: { type: String, required: true },
  game: { type: String, default: "" },
  campaignId: { type: String, default: "" },
  actor: { type: String, default: "" },
  host: { type: String, default: "" },
  note: { type: String, default: "" },
});

poolUsageEventSchema.index({ game: 1, at: -1 });
poolUsageEventSchema.index({ event: 1, at: -1 });

module.exports = mongoose.model("PoolUsageEvent", poolUsageEventSchema);
