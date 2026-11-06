const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  account: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  nextScanAt: Date,
  scanToken: String,
  lastScanAt: Date,
  lastResult: String,
  lastApiRoute: String,
  credentials: { type: String, select: false },
  credentialsSavedAt: Date,
});

module.exports = mongoose.models.TikTokFarmSchedule || mongoose.model("TikTokFarmSchedule", schema);
