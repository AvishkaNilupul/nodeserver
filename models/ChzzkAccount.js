const mongoose = require("mongoose");

// One document per CHZZK (Naver) login used for drops farming (docs/CHZZK-FARM.md §7).
//
// The Cookie-Editor export is stored encrypted via utils/secretBox — the
// plaintext is needed to talk to CHZZK, so this is reversible encryption
// rather than a hash. Never log or return `cookies`.
const chzzkAccountSchema = new mongoose.Schema(
  {
    // Naver's stable per-login hash from getUserStatus. Required and unique.
    userIdHash: { type: String, required: true, unique: true, index: true },
    nickname: { type: String, default: "" },
    // Encrypted JSON array of { name, value, domain }.
    cookies: { type: String, default: "" },
    cookieAt: { type: Date, default: null },
    // The web client's deviceId (ba.uuid cookie value). Lets the worker send
    // the same deviceId CHZZK saw at import, so heartbeats look like one browser.
    deviceId: { type: String, default: "" },
    // untested | ok | not_logged_in
    status: { type: String, default: "untested", index: true },
    lastError: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    penalties: { type: Number, default: 0 },
    unusableSince: { type: Date, default: null },
    unusableAlertAt: { type: Date, default: null },
    sold: { type: Boolean, default: false, index: true },
    paused: { type: Boolean, default: false },
    note: { type: String, default: "" },
    // { [campaignNo]: { minutes, at } } — last known watch minutes per campaign.
    progress: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // What the worker is doing right now (§9). Null when idle.
    current: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  // minimize: false keeps an empty `progress` object on the stored row.
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("ChzzkAccount", chzzkAccountSchema);
