const mongoose = require("mongoose");

// An operator's confirmation from a viewer's Twitch inventory. Kept apart
// from drop entitlements, account reservations and marketplace stock.
const schema = new mongoose.Schema(
  {
    adminId: { type: String, required: true },
    viewer: { type: String, required: true },
    campaignId: { type: String, required: true },
    campaignName: String,
    reward: { type: String, required: true },
    recordedAt: { type: Date, default: Date.now },
    codeCipher: { type: String, select: false },
    codeFingerprint: { type: String, select: false },
    codeVersion: String,
    changedAt: Date,
    codeSavedAt: Date,
    codeRedeemedAt: Date,
    platform: String,
    region: String,
  },
  { versionKey: false },
);

schema.index(
  { adminId: 1, viewer: 1, campaignId: 1, reward: 1 },
  { unique: true },
);
schema.index(
  { adminId: 1, codeFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { codeFingerprint: { $type: "string" } },
  },
);

module.exports = mongoose.model("TwitchRewardReceipt", schema);
