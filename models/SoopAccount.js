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
    // ok | drops_rejected | not_logged_in | untested
    status: { type: String, default: "untested", index: true },
    lastError: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    // Last health probe summary for the panel: missions, live campaigns, etc.
    check: { type: mongoose.Schema.Types.Mixed, default: null },
    // A sold account stops being farmed (mirrors how Twitch accounts work).
    sold: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopAccount", soopAccountSchema);
