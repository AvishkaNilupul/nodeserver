const mongoose = require("mongoose");
const { createHash } = require("crypto");
const { encrypt, decrypt } = require("../utils/secretBox");

const schema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "DiscordTestAccount", required: true },
  userId: { type: String, required: true },
  questId: { type: String, required: true },
  platform: { type: Number, required: true },
  questName: String, game: String, rewardName: String,
  code: { type: String, required: true, select: false },
  codeHash: { type: String, required: true, unique: true, select: false },
  claimedAt: { type: Date, required: true },
  retrievedAt: { type: Date, default: Date.now },
  // Only an explicit reward redemption deadline belongs here. Campaign end
  // and the claim deadline do not establish when an issued key stops working.
  expiresAt: Date,
  redemptionUrl: String,
}, { timestamps: true });
schema.index({ accountId: 1, questId: 1, platform: 1 }, { unique: true });

function codeFields(code) {
  const plain = decrypt(code);
  if (!plain || plain.length > 4096) throw new Error("Unreadable Discord reward code");
  return { code: encrypt(plain), codeHash: createHash("sha256").update(plain).digest("hex") };
}
schema.pre("validate", function () {
  if (this.isModified("code")) Object.assign(this, codeFields(this.code));
});

module.exports = mongoose.models.DiscordRewardCode || mongoose.model("DiscordRewardCode", schema);
module.exports.codeFields = codeFields;
