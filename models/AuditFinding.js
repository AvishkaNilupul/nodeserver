const mongoose = require("mongoose");

// One row per issue the marketplace guardian found (duplicate account across
// platforms, account already sold to a buyer, redeemed drops in a live
// listing, dead token, restock events…). Findings are upserted by dedupeKey so
// repeated passes don't spam duplicates, and auto-resolve when the underlying
// condition clears.
const auditFindingSchema = new mongoose.Schema(
  {
    // duplicate-account | claim-mismatch | redeemed-drops | dead-token |
    // stock-unknown | restocked | restock-failed
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
      enum: ["open", "resolved", "ignored"],
      default: "open",
      index: true,
    },
    resolution: { type: String, default: "" },
    detectedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AuditFinding", auditFindingSchema);
