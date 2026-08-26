const mongoose = require("mongoose");

// Unified, queryable audit trail for the WHOLE system: one row per meaningful
// state change (or mutating request), across every subsystem. The single place
// to answer "what happened, when, and who did it" — it deliberately generalizes
// the per-domain AutoFarmEvent / PoolUsageEvent pattern into one collection so a
// single query spans accounts, bots, no-claim, listings, sales, pool, settings…
//
// Rows are DIAGNOSTIC only: writing one must NEVER break the action it records
// (see utils/systemLog.js — every write is best-effort). Kept small (short
// strings, tiny meta) because prod Mongo is a bytes-bound Atlas shared tier, and
// auto-expired after 90 days by the TTL index below (same convention as
// models/CatalogEvent.js).
const systemEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  // Broad area: accounts | autofarm | bots | noclaim | listings | sales | pool |
  // scanner | suspended | settings | request | deploy | error | …
  category: { type: String, default: "" },
  // The verb: created | deleted | suspended | token_invalid | started | stopped |
  // parked | woke | reaped | published | relisted | sold | delivered | recycled |
  // released | claimed | settings_changed | purged | …
  action: { type: String, default: "" },
  // Who/what triggered it: "admin:<id>" | "renter:<id>" | "reseller:<id>" |
  // "system" | "scanner" | "noclaim" | "tick" | "script" | "anon" | …
  actor: { type: String, default: "system" },
  severity: { type: String, enum: ["info", "warn", "error"], default: "info" },
  // The thing acted on, as a short human label (login / game / container / id).
  // NEVER a secret — accounts are identified by login, never by token.
  subject: { type: String, default: "" },
  subjectId: { type: mongoose.Schema.Types.ObjectId },
  count: { type: Number, default: 0 },
  game: { type: String, default: "" },
  host: { type: String, default: "" },
  container: { type: String, default: "" },
  detail: { type: String, default: "" },
  meta: { type: mongoose.Schema.Types.Mixed },
  // Request-log fields (category "request").
  method: { type: String, default: "" },
  route: { type: String, default: "" },
  status: { type: Number, default: 0 },
  sessionId: { type: String, default: "" },
});

systemEventSchema.index({ at: -1 });
systemEventSchema.index({ category: 1, at: -1 });
systemEventSchema.index({ actor: 1, at: -1 });
systemEventSchema.index({ action: 1, at: -1 });
systemEventSchema.index({ subject: 1, at: -1 });
// Auto-expire after 90 days (this {at:1} index doubles as the ascending index).
systemEventSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("SystemEvent", systemEventSchema);
