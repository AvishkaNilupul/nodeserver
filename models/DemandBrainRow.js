// One game (claim farm) or bucket (no-claim farm) in one logged farm-brain run: what each farm's own
// logic said, what the brain says, and every estimator's weekly rate — the compact row
// utils/demandBrain/model.buildRun produces, minus its reasons. ~120 per run, a few hundred bytes
// each. Written once (with its run), never updated; kept as long as runs (21 days).
const mongoose = require("mongoose");
const { TTL_DAYS } = require("./DemandBrainRun");

const demandBrainRowSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true },
    k: { type: String, required: true },
    g: { type: String, default: "" },
    f: { type: String, enum: ["claim", "noclaim"], required: true },
    live: { type: Boolean, default: false },
    hl: { type: Number, default: null },
    ro: { type: Boolean, default: false },
    d: { type: String, default: "" },
    old: { type: mongoose.Schema.Types.Mixed, default: {} },
    br: { type: mongoose.Schema.Types.Mixed, default: {} },
    mk: { type: mongoose.Schema.Types.Mixed, default: null },
    est: { type: mongoose.Schema.Types.Mixed, default: null },
    stk: { type: mongoose.Schema.Types.Mixed, default: null },
    act: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false, minimize: false },
);

// One game's history, newest first.
demandBrainRowSchema.index({ k: 1, f: 1, at: -1 });
// A run's rows (the newest run after a restart; the daily samples the scorer reads).
demandBrainRowSchema.index({ run: 1 });
demandBrainRowSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });

module.exports = mongoose.model("DemandBrainRow", demandBrainRowSchema);
