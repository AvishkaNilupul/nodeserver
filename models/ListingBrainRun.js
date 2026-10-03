// One logged run of the listing brain (utils/listingBrain, docs/LISTING-BRAIN-PLAN.md): the run's
// settings, summary and notes. Its per-cell rows (one game × farm × marketplace) are ListingBrainRow
// documents pointing back here, so a cell's history is an indexed read of small rows rather than of
// every whole run.
//
// `fc` holds the per-listing sell-through forecasts the forward score needs. They are written only
// on the first run of each UTC day (capped, see utils/listingBrain/index.js) — every other run
// leaves `fc` null — and are never read by a page route, only by the scorer.
//
// Written once per run (every few hours while enabled), never updated; kept 21 days — a forecast is
// scored a week after it was made, and the scorer reads three weeks of daily samples.
const mongoose = require("mongoose");

const TTL_DAYS = 21;

const listingBrainRunSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    v: { type: Number, default: 1 },
    ms: { type: Number, default: 0 },
    cfg: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: [String], default: [] },
    rowsN: { type: Number, default: 0 },
    // UTC day of `at` ("2026-10-03"), and whether this run carries that day's forecasts.
    day: { type: String, default: "" },
    fcN: { type: Number, default: 0 },
    fc: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false, minimize: false },
);

// Serves "newest first", "first run of each day" and the TTL.
listingBrainRunSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });

module.exports = mongoose.model("ListingBrainRun", listingBrainRunSchema);
module.exports.TTL_DAYS = TTL_DAYS;
