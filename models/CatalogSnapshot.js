const mongoose = require("mongoose");

// Persisted public catalog payload (key "public"). Restored into the in-memory
// cache at boot so the first visitor after a restart is served immediately
// instead of waiting on the ~46 s cold build, which then refreshes it.
const catalogSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    generatedAt: { type: Date, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("CatalogSnapshot", catalogSnapshotSchema);
