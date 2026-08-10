const mongoose = require("mongoose");

// One row per issue the marketplace guardian found (duplicate account across
// platforms, account already sold to a buyer, redeemed drops in a live
// listing, dead token, restock events…). Findings are upserted by dedupeKey so
// repeated passes don't spam duplicates, and auto-resolve when the underlying
// condition clears.
const auditFindingSchema = new mongoose.Schema(
  {
    // duplicate-account | claim-mismatch | redeemed-drops | dead-token |
    // account-gone | stock-unknown | restocked | restock-failed
    // `account-gone` is deliberately separate from `dead-token`: a dead token can
    // be re-authed, an account Twitch has deleted can only be taken off sale.
    type: { type: String, required: true, index: true },
    severity: {
      type: String,
      enum: ["high", "medium", "low", "info"],
      default: "medium",
      index: true,
    },
    marketplace: { type: String, default: "" },
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MarketplaceListing",
      default: null,
      index: true,
    },
    accountId: { type: String, default: "" },
    accountLogin: { type: String, default: "" },
    message: { type: String, default: "" },
    // Stable key so one real-world issue maps to one finding across passes.
    dedupeKey: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["open", "resolved", "ignored", "needs-human"],
      default: "open",
      index: true,
    },
    resolution: { type: String, default: "" },
    // Auto-heal bookkeeping (utils/guardianAutoHeal.js). A finding the healer
    // could not fix carries its attempt count so it is retried a bounded number
    // of times and then parked as "needs-human" rather than retried forever.
    healAttempts: { type: Number, default: 0 },
    healLastError: { type: String, default: "" },
    healLastAttemptAt: { type: Date, default: null },
    detectedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AuditFinding", auditFindingSchema);
