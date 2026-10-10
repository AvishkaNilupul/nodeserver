const mongoose = require("mongoose");

// One document per SOOP (ex-AfreecaTV) login used for drops farming.
// The Cookie-Editor export (which must contain AuthTicket) is stored encrypted
// via utils/secretBox — the plaintext is needed to talk to SOOP, so this is
// reversible encryption rather than a hash. Never log or return `cookies`.
const soopAccountSchema = new mongoose.Schema(
  {
    loginId: { type: String, required: true, unique: true, index: true },
    nickname: { type: String, default: "" },
    country: { type: String, default: "" },
    // Encrypted JSON array of { name, value } cookies.
    cookies: { type: String, default: "" },
    // When the cookie was last imported; the panel shows its age.
    cookieAt: { type: Date, default: null },
    // ok | drops_rejected | not_logged_in | untested
    status: { type: String, default: "untested", index: true },
    lastError: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    // Set when the login was found dead, cleared by a fresh cookie import.
    deadAt: { type: Date, default: null },
    // Last health probe summary for the panel: missions, live campaigns, etc.
    check: { type: mongoose.Schema.Types.Mixed, default: null },
    // A sold account stops being farmed (mirrors how Twitch accounts work).
    sold: { type: Boolean, default: false, index: true },
    note: { type: String, default: "" },
    // { [dropsIdx]: { minutes, max, goal, done, at } } — last known watch time
    // per campaign, so the panel has numbers while no session is running.
    progress: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  // minimize: false keeps an empty `progress` object on the stored row.
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("SoopAccount", soopAccountSchema);
