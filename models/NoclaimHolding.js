const mongoose = require("mongoose");

// One row per no-claim farm account: what it holds RIGHT NOW that a buyer can
// claim (in-progress drops at 100%, not claimed), from the last live read.
// Refreshed by utils/noclaimHoldings.js. Never stores credentials.
//
// This is a SNAPSHOT for browsing, not a source of truth for delivery
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §0). The Listings picker and the
// stock counts need "which accounts hold item X" across the whole farm, and a
// live Twitch inventory read per account per page load is not affordable — so
// the sweep reads a budget of accounts per tick and parks the result here.
// Every CLAIM re-reads the account live before anything is committed, so a
// stale row can only ever cost a skipped candidate, never a wrong delivery.
const noclaimHoldingSchema = new mongoose.Schema(
  {
    loginLower: { type: String, required: true, unique: true },
    login: { type: String, default: "" },
    twitchId: { type: String, default: "" },
    // The pool row (AvailableAccount _id), joined by clientSecret. "" = no pool
    // row, so the account is never free to sell (contract §0 rule 2).
    poolAccountId: { type: String, default: "", index: true },
    botId: { type: String, default: "" },
    container: { type: String, default: "" },
    game: { type: String, default: "" }, // bot's FavouriteGames[0]
    // Folded sellable drops (utils/noclaimHoldings.js foldSellable): one entry
    // per itemKey, `qty` = how many copies of it the account holds.
    items: [
      {
        _id: false,
        itemKey: String,
        name: String,
        game: String,
        campaign: String,
        image: String,
        qty: { type: Number, default: 1 },
      },
    ],
    sellableCount: { type: Number, default: 0 }, // sum of qty
    readAt: { type: Date, default: null, index: true }, // last SUCCESSFUL live read
    // Why the last read failed ("" = it did not). A failed read keeps the
    // previous items/readAt, so the row ages into "stale" instead of looking
    // empty — an unreachable account is not the same as an empty one.
    readError: { type: String, default: "" },
    seenAt: { type: Date, default: null }, // last time found in a config
    // false once the account is no longer in any no-claim bot config (the sweep
    // flips it rather than deleting the row). Everything that sells or counts
    // stock reads only inConfig:true rows — rule 1 of a free account.
    inConfig: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("NoclaimHolding", noclaimHoldingSchema);
