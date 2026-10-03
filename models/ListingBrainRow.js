// One cell — a game × farm (claim / noclaim) × marketplace — in one logged listing-brain run: what
// today's rules do there (median live ask, units, the price a new listing would get, today's shelf),
// what the brain says (price, shelf, regime, confidence), the evidence behind it and the two diff
// classes. The compact row utils/listingBrain/model.buildRun produces, minus its reasons and its
// per-offer detail (both kept for the newest run, in memory). Written once (with its run), never
// updated; kept as long as runs (21 days).
const mongoose = require("mongoose");
const { TTL_DAYS } = require("./ListingBrainRun");

const listingBrainRowSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true },
    k: { type: String, required: true },
    g: { type: String, default: "" },
    f: { type: String, enum: ["claim", "noclaim"], required: true },
    m: { type: String, required: true },
    live: { type: Boolean, default: false },
    hl: { type: Number, default: null },
    // price class and placement (shelf) class, docs/LISTING-BRAIN-PLAN.md §4.6
    pc: { type: String, default: "" },
    sc: { type: String, default: "" },
    old: { type: mongoose.Schema.Types.Mixed, default: {} },
    br: { type: mongoose.Schema.Types.Mixed, default: {} },
    ev: { type: mongoose.Schema.Types.Mixed, default: null },
    fl: { type: [String], default: [] },
  },
  { versionKey: false, minimize: false },
);

// One cell's history, newest first.
listingBrainRowSchema.index({ k: 1, f: 1, m: 1, at: -1 });
// A run's rows (the newest run after a restart; the daily samples the scorer reads).
listingBrainRowSchema.index({ run: 1 });
listingBrainRowSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });

module.exports = mongoose.model("ListingBrainRow", listingBrainRowSchema);
