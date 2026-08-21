const mongoose = require("mongoose");

const autoFarmEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  type: { type: String, required: true },
  game: { type: String, default: "" },
  campaignId: { type: String, default: "" },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "AutoFarmTask",
    index: true,
  },
  host: { type: String, default: "" },
  container: { type: String, default: "" },
  count: { type: Number, default: 0 },
  reason: { type: String, default: "" },
  actor: { type: String, default: "" },
});

autoFarmEventSchema.index({ at: -1 });
autoFarmEventSchema.index({ type: 1, at: -1 });
autoFarmEventSchema.index({ game: 1, at: -1 });

module.exports = mongoose.model("AutoFarmEvent", autoFarmEventSchema);
