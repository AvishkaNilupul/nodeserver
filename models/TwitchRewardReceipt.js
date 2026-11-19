const mongoose = require("mongoose");

// An operator's confirmation from a viewer's Twitch inventory. Kept apart
// from drop entitlements, account reservations and marketplace stock.
const schema = new mongoose.Schema(
  {
    adminId: { type: String, required: true },
    viewer: { type: String, required: true },
    campaignId: { type: String, required: true },
    reward: { type: String, required: true },
    recordedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

schema.index(
  { adminId: 1, viewer: 1, campaignId: 1, reward: 1 },
  { unique: true },
);

module.exports = mongoose.model("TwitchRewardReceipt", schema);
