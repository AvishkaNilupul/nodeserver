const mongoose = require("mongoose");

// The precomputed Drops Archive rollup — one document, rewritten by
// utils/archiveSnapshot.js every few minutes.
//
// Why this is stored at all: the rollup is derived data and could live purely
// in memory, but the process restarts often (deploys, pm2), and rebuilding it
// costs tens of seconds of aggregation over ~200k drops on the Atlas shared
// tier. Persisting it means a restart serves the last known-good rollup
// instantly and refreshes in the background, instead of making whoever opens
// the page first pay the full rebuild.
const archiveRollupSchema = new mongoose.Schema(
  {
    // Always "drops-archive". A fixed key so the collection holds exactly one
    // row and an upsert can find it without an _id round trip.
    key: { type: String, default: "drops-archive", unique: true },
    builtAt: { type: Date, default: null },
    buildMs: { type: Number, default: 0 },
    // When the per-item display metadata (name / images / campaign) was last
    // re-read in full. Counts refresh every cycle; metadata is far more
    // expensive to gather and changes only when a new reward appears or an
    // image finishes caching, so it is refreshed incrementally.
    metaBuiltAt: { type: Date, default: null },
    // Mixed: these are plain rollup rows assembled in JS, not documents the
    // app ever queries by field. Casting them through a schema would cost more
    // than it could ever catch.
    items: { type: mongoose.Schema.Types.Mixed, default: [] },
    games: { type: mongoose.Schema.Types.Mixed, default: [] },
    overview: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("ArchiveRollup", archiveRollupSchema);
