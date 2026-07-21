const mongoose = require("mongoose");

// One snapshot per game from the market-research scanner: demand and
// competition observed across the marketplaces for that game's twitch drops,
// plus our own farming/selling state, rolled up into an opportunity score.
const marketResearchSchema = new mongoose.Schema(
  {
    game: { type: String, required: true, unique: true, index: true },
    term: { type: String, default: "" },
    campaign: {
      active: { type: Boolean, default: false },
      upcoming: { type: Boolean, default: false },
      count: { type: Number, default: 0 },
      endAt: { type: Date, default: null },
    },
    farmedAccounts: { type: Number, default: 0 },
    farmedItems: { type: Number, default: 0 },
    ownActive: { type: Number, default: 0 },
    ownSold: { type: Number, default: 0 },
    markets: {
      gameflip: {
        soldRecent: { type: Number, default: 0 },
        soldTotal: { type: Number, default: 0 },
        avgSoldPrice: { type: Number, default: 0 },
        lastSoldAt: { type: Date, default: null },
        active: { type: Number, default: 0 },
        lowest: { type: Number, default: 0 },
      },
      ggsel: {
        totalSold: { type: Number, default: 0 },
        active: { type: Number, default: 0 },
        lowest: { type: Number, default: 0 },
      },
      plati: {
        totalSold: { type: Number, default: 0 },
        active: { type: Number, default: 0 },
        lowest: { type: Number, default: 0 },
      },
    },
    demandScore: { type: Number, default: 0, index: true },
    competitionScore: { type: Number, default: 0 },
    opportunityScore: { type: Number, default: 0, index: true },
    recommendation: { type: String, default: "" },
    scannedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MarketResearch", marketResearchSchema);
