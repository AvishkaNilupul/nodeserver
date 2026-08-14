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
    // Per-marketplace observations. Every market carries the same shape so a
    // new one can be added without another schema shuffle; a market that
    // cannot report a given number just leaves it at 0 (Gameflip dates its
    // sales but has no lifetime counter; GGSel/Plati count lifetime sales but
    // never say when).
    //
    // `sellers` and `offers` are what competition is actually measured from.
    // `active` counts rows, and rows are not rivals: measured live, a search
    // for one busy game returned 20 Gameflip listings that were 3 products
    // from a single seller. Scoring that as 20 competitors punished exactly
    // the markets worth taking — one rival papering the page over.
    markets: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    // Recent money observed moving on the markets we can date, USD. Unit
    // counts alone cannot separate a good game from a busy one: five sales at
    // $18 beats twenty at $0.30 for identical farming cost.
    observedRevenue: { type: Number, default: 0 },
    // Distinct competitors and distinct products across every scanned market.
    sellers: { type: Number, default: 0 },
    offers: { type: Number, default: 0 },
    // Units per week moving on GGSel + Plati, from differencing their lifetime
    // counters between scans (see models/MarketResearchSnapshot.js). null until
    // there is a week of history for this game; those two markets never date a
    // sale, so this is the only way to get a recent rate out of them.
    salesPerWeek: { type: Number, default: null },
    // Change in demandScore since the comparison snapshot ~7 days back. null on
    // a game's first scan. A single score cannot tell a game on the way up from
    // one on the way down, and those want opposite decisions.
    demandTrend: { type: Number, default: null },
    // Our own realised sales for this game in the research window, from
    // SaleSignal (real purchases only — never stock claims).
    ownSales: { type: Number, default: 0 },
    ownRevenue: { type: Number, default: 0 },
    // Those sales split by marketplace: { zeusx: { sales, revenue }, ... }.
    // For ZeusX, Z2U and EpicNPC this is the ONLY demand signal that exists —
    // ZeusX publishes no keyword search and the other two sit behind bot
    // protection a server-side fetch cannot pass, so their competitors are
    // unobservable. What we sell there is still measurable, and it is the
    // number that says where the next batch of stock should go.
    ownByMarket: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    // All three are 0-100 and calibrated to mean something at that scale.
    //
    // They did not used to be. The old demand score was an unbounded sum of
    // log terms that the model documented as 0-100 and that in practice ran to
    // ~300 for a normal game: a game with two lifetime sales anywhere scored
    // 20, over the 15 "moderate demand" line, and two recent sales scored 102,
    // 2.5x the 40 "proven seller" line. Every game that existed on any market
    // at all therefore cleared the gate, so the sellability check the whole
    // auto-farmer is built around was very nearly a no-op. Each term is now a
    // saturating fraction with an explicit half-way point, so the tiers in
    // utils/autoFarmer.js discriminate the way they were always written to.
    demandScore: { type: Number, default: 0, index: true },
    competitionScore: { type: Number, default: 0 },
    opportunityScore: { type: Number, default: 0, index: true },
    recommendation: { type: String, default: "" },
    scannedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MarketResearch", marketResearchSchema);
