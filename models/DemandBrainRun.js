// One logged run of the farm brain (utils/demandBrain, docs/DEMAND-BRAIN-PLAN.md): the run's
// settings, summary and notes. Its per-game rows are DemandBrainRow documents pointing back here,
// so a game's history is an indexed read of small rows rather than of every whole run. Written once
// per run (hourly while enabled), never updated; kept 21 days — the test is one week, and a run is
// scored when its week is over.
const mongoose = require("mongoose");

const TTL_DAYS = 21;

const demandBrainRunSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    v: { type: Number, default: 1 },
    ms: { type: Number, default: 0 },
    cfg: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: [String], default: [] },
    rowsN: { type: Number, default: 0 },
  },
  { versionKey: false, minimize: false },
);

// Serves "newest first", "first run of each day" and the TTL.
demandBrainRunSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });

module.exports = mongoose.model("DemandBrainRun", demandBrainRunSchema);
module.exports.TTL_DAYS = TTL_DAYS;
