// One cell — a game × farm (claim / noclaim) × marketplace — in one logged listing-brain run: what
// today's rules do there (median live ask, units, the price a new listing would get, today's shelf),
// what the brain says (price, shelf, regime, confidence), the evidence behind it and the two diff
// classes. The compact row utils/listingBrain/model.buildRun produces, minus its reasons and its
// per-offer detail (both kept for the newest run, in memory). Written once (before its run document),
// never updated; rows of the first run of each UTC day are kept 21 days, every other run's rows 3 days.
const mongoose = require("mongoose");
const { TTL_DAYS } = require("./ListingBrainRun");

const listingBrainRowSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true },
    k: { type: String, required: true },
    g: { type: String },
    f: { type: String, enum: ["claim", "noclaim"], required: true },
    m: { type: String, required: true },
    live: { type: Boolean },
    hl: { type: Number },
    // price class and placement (shelf) class, docs/LISTING-BRAIN-PLAN.md §4.6
    pc: { type: String },
    sc: { type: String },
    old: { type: mongoose.Schema.Types.Mixed },
    br: { type: mongoose.Schema.Types.Mixed },
    // the four price policies, the four placement forecasts and the four placement policies' weekly
    // demand splits (plan §4.6, §5): the forward score ranks the policies from these logged rows —
    // undeclared, strict mode would drop them wherever a row is cast
    pol: { type: mongoose.Schema.Types.Mixed },
    pf: { type: mongoose.Schema.Types.Mixed },
    pd: { type: mongoose.Schema.Types.Mixed },
    ev: { type: mongoose.Schema.Types.Mixed },
    fl: { type: [String], default: undefined },
    // When this row expires: 21 days for the first run of a UTC day (the daily sample the forward
    // score reads), 3 days for every other run (utils/listingBrain/index.js ROW_KEEP_DAYS_*).
    exp: { type: Date, default: null },
  },
  // Rows are written sparse (index.compact): absent fields stay absent rather than being filled
  // with defaults, so readers treat a missing field as null / false / none.
  { versionKey: false },
);

// One cell's history, newest first.
listingBrainRowSchema.index({ k: 1, f: 1, m: 1, at: -1 });
// A run's rows (the newest run after a restart; the daily samples the scorer reads).
listingBrainRowSchema.index({ run: 1 });
// Per-row expiry, and the 21-day backstop for any row written without one.
listingBrainRowSchema.index({ exp: 1 }, { expireAfterSeconds: 0 });
listingBrainRowSchema.index({ at: 1 }, { expireAfterSeconds: TTL_DAYS * 86400 });

module.exports = mongoose.model("ListingBrainRow", listingBrainRowSchema);
