const mongoose = require("mongoose");

// One row per no-claim account that has been identified as SPENT (sold to a
// buyer and/or connected to a game account) and pulled OUT of its no-claim bot.
//
// The No-claim farming page (routes/noclaimFarmRoutes.js) scans each bot's live
// Twitch inventory + the account DB, and when the operator removes a spent
// account from a bot the account is deleted from that bot's config on the Pi and
// recorded here. This is the backing store for the page's "Spent (sold /
// connected)" view: once an account leaves the config it can't be re-derived
// from the config sweep, so the removal is logged here so the view keeps a
// history of what was pulled and why.
//
// Deliberately NOT coupled to the pool/BotAccount rows — this is a flat audit
// list scoped to the no-claim system, mirroring how the whole no-claim console
// stays decoupled from the auto-farmer's models.
const noclaimSpentAccountSchema = new mongoose.Schema(
  {
    login: { type: String, default: "", index: true },
    // Lowercased mirror so a re-sweep of the same login collapses onto one row.
    loginLower: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },

    // The no-claim game the account was farming when it was pulled.
    game: { type: String, default: "" },

    // Where it came from: the bot's numeric id and its container name.
    botId: { type: String, default: "" },
    container: { type: String, default: "" },

    // Why it was spent. Both can be true (sold AND connected).
    sold: { type: Boolean, default: false },
    connected: { type: Boolean, default: false },
    // Human-readable detail for the sold flag ("shop sale" / "reseller" /
    // "bulk order" / "recycled/sold-game marker").
    soldWhy: { type: String, default: "" },

    // Token health at sweep time, so the view can flag a dead/reclaimed token
    // (a connected account whose buyer already took it over).
    tokenStatus: { type: String, default: "" },

    actor: { type: String, default: "" },
    sweptAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("NoclaimSpentAccount", noclaimSpentAccountSchema);
