const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  account: { type: String, required: true },
  campaign: { type: String, required: true },
  room: { type: String, required: true },
  task: { type: String, required: true },
  batch: { type: String, required: true },
  active: { type: Boolean, default: true },
  state: {
    type: String,
    enum: ["queued", "running", "completed", "failed", "cancelled", "review"],
    default: "queued",
  },
  lease: { type: String, select: false },
  leaseUntil: Date,
  claimAuthorized: { type: Boolean, default: false },
  stopRequested: { type: Boolean, default: false },
  phase: { type: String, default: "queued" },
  anchor: String,
  eventName: String,
  duration: Number,
  seconds: { type: Number, default: 0 },
  code: { type: String, select: false },
  codeHash: { type: String, select: false },
}, { timestamps: true });

schema.index({ account: 1, campaign: 1, task: 1 }, { unique: true });
schema.index({ account: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ codeHash: 1 }, { unique: true, partialFilterExpression: { codeHash: { $type: "string" } } });
schema.index({ state: 1, leaseUntil: 1 });
schema.index({ createdAt: -1 });

module.exports = mongoose.models.TikTokFarmRun || mongoose.model("TikTokFarmRun", schema);
