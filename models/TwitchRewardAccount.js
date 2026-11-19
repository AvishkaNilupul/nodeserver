const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    adminId: { type: String, required: true },
    viewer: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

schema.index({ adminId: 1, viewer: 1 }, { unique: true });

module.exports = mongoose.model("TwitchRewardAccount", schema);
