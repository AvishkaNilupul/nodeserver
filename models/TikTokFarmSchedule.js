const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  account: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  nextScanAt: Date,
  scanToken: String,
  lastScanAt: Date,
  lastResult: String,
  lastApiRoute: String,
  lastHeartbeatAt: Date,
  runtime: mongoose.Schema.Types.Mixed,
  lastCatalog: mongoose.Schema.Types.Mixed,
  credentials: { type: String, select: false },
  credentialsSavedAt: Date,
  setupState: String,
  setupSerial: String,
  setupHandle: String,
  setupReason: String,
  setupLease: { type: String, select: false },
  setupLeaseUntil: Date,
  setupLog: [{ _id: false, at: Date, state: String, reason: String }],
});

module.exports = mongoose.models.TikTokFarmSchedule || mongoose.model("TikTokFarmSchedule", schema);
