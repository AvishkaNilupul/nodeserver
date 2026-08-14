const mongoose = require("mongoose");

// One row per game per research scan — the history MarketResearch itself does
// not keep, because that doc is overwritten in place every pass.
//
// This exists for two reasons, and the second is the important one:
//
// 1. Trend. A single snapshot cannot tell a game on the way up from one on the
//    way down, so "demand 45" read the same whether it had been 20 last week or
//    80. Comparing against an older snapshot answers that.
//
// 2. It turns GGSel's and Plati's lifetime sale counters into a RATE. Those two
//    markets never date a sale — they only ever report a running total — so
//    they could only be used as a weak "this sells at all" prior, no matter how
//    much of the market they actually are. Differencing the same counter across
//    two scans gives real units sold in a real window, which is the strongest
//    kind of evidence there is, for the markets we had the least of it from.
//
// Rows are small and expire on their own; nothing reads far enough back to
// need more than a few months.
const marketResearchSnapshotSchema = new mongoose.Schema({
  game: { type: String, required: true },
  gameKey: { type: String, required: true, index: true },
  at: { type: Date, default: Date.now },

  demandScore: { type: Number, default: 0 },
  competitionScore: { type: Number, default: 0 },
  opportunityScore: { type: Number, default: 0 },

  // The raw inputs, so a later scan can difference them (and so a scoring
  // change can be re-evaluated against history instead of starting over).
  soldRecent: { type: Number, default: 0 },
  observedRevenue: { type: Number, default: 0 },
  // GGSel + Plati lifetime counters combined. The number that gets differenced.
  lifetimeSold: { type: Number, default: 0 },
  typicalPrice: { type: Number, default: 0 },
  sellers: { type: Number, default: 0 },
  offers: { type: Number, default: 0 },

  ownSales: { type: Number, default: 0 },
  ownRevenue: { type: Number, default: 0 },
});

// Newest-first lookups per game — the only access pattern.
marketResearchSnapshotSchema.index({ gameKey: 1, at: -1 });
// Expire after ~120 days. Trend windows are measured in days and weeks, and
// prod Mongo is a shared Atlas tier where unbounded history is not free.
marketResearchSnapshotSchema.index(
  { at: 1 },
  { expireAfterSeconds: 120 * 86400 },
);

module.exports = mongoose.model(
  "MarketResearchSnapshot",
  marketResearchSnapshotSchema,
);
