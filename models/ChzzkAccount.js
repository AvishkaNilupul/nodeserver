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
    // What the export said about the login cookie (NID_AUT): "persistent"
    // (exported with "Stay signed in"; cookieExpiresAt set), "session", or
    // "unknown" (a raw header line, or imported before 2026-10-23 PM).
    cookieKind: { type: String, default: "unknown" },
    cookieExpiresAt: { type: Date, default: null },
    // When the farm last saved a cookie Naver renewed (Set-Cookie, usually
    // NID_SES on getUserStatus), and how many times since the import.
    // Reset by every import (docs/CHZZK-COOKIE-KEEPALIVE.md).
    cookieRenewedAt: { type: Date, default: null },
    cookieRenewals: { type: Number, default: 0 },
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
    // { [campaignNo]: { minutes, at, next, rewards: {rewardNo: state}, done,
    //   verified, doneAt } } — only done+verified means finished (v1 wrote
    //   unverified done marks; see utils/chzzk/progress.js).
    progress: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // What the worker is doing right now (§9). Null when idle.
    current: { type: mongoose.Schema.Types.Mixed, default: null },
    lastHeartbeatAt: { type: Date, default: null },
  },
  // minimize: false keeps an empty `progress` object on the stored row.
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("ChzzkAccount", chzzkAccountSchema);
