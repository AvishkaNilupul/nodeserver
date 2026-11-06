const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  account: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  nextScanAt: Date,
  scanToken: String,
  lastScanAt: Date,
  lastResult: String,
});

module.exports = mongoose.models.TikTokFarmSchedule || mongoose.model("TikTokFarmSchedule", schema);
