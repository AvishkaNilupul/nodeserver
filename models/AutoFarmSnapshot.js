const mongoose = require("mongoose");

// Persisted last-known-good watcher payload. Request handlers only read this
// one document; all Mongo joins and host polling happen in the background.
const autoFarmSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, default: "auto-farm", unique: true },
    schemaVersion: { type: Number, default: 1 },
    builtAt: { type: Date, default: null },
    buildMs: { type: Number, default: 0 },
    hostBuiltAt: { type: Date, default: null },
    header: { type: mongoose.Schema.Types.Mixed, default: {} },
    bots: { type: mongoose.Schema.Types.Mixed, default: [] },
    games: { type: mongoose.Schema.Types.Mixed, default: [] },
    attention: { type: mongoose.Schema.Types.Mixed, default: [] },
    decisionSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
    autoBotKeys: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("AutoFarmSnapshot", autoFarmSnapshotSchema);
