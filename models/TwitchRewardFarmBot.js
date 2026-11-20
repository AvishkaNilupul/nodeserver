const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  adminId: { type: String, required: true, index: true },
  poolAccountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  viewer: { type: String, required: true },
  twitchId: { type: String, required: true },
  desired: { type: String, enum: ["running", "stopped"], default: "stopped" },
  state: { type: String, default: "provisioning" },
  activity: { type: String, default: "" },
  currentMinutes: { type: Number, default: null },
  requiredMinutes: { type: Number, default: null },
  checkedAt: Date, startedAt: Date, error: String,
}, { timestamps: true });
module.exports = mongoose.model("TwitchRewardFarmBot", schema);
