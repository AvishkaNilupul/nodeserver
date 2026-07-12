const mongoose = require("mongoose");

// One row per redeemed Prime Gaming code (typically a GOG key) kept for
// resale — the operator claims it manually on Amazon and pastes the code in
// here; title/image/platform are denormalized from PrimeOffer at add-time so
// this stays browsable even after the offer itself expires and is pruned.
const primeKeySchema = new mongoose.Schema(
  {
    offerId: { type: String, default: "", index: true },
    title: { type: String, required: true },
    image: { type: String, default: "" },
    platform: { type: String, default: "gog" },
    // Encrypted at rest via utils/secretBox, same treatment as bot account
    // passwords — this is a real, once-only-redeemable game key.
    code: { type: String, required: true },
    claimedAt: { type: Date, default: Date.now },
    // Free-text label for which Amazon account claimed it — not a managed
    // credential, just a note (e.g. "main", "alt 2").
    claimedFrom: { type: String, default: "" },
    status: {
      type: String,
      enum: ["unused", "listed", "sold", "redeemed"],
      default: "unused",
      index: true,
    },
    soldAt: { type: Date, default: null },
    soldToUsername: { type: String, default: "" },
    soldPrice: { type: Number, default: 0 },
    note: { type: String, default: "" },
    // When the code itself expires unredeemed (GOG shows this on claim) — lets
    // the watcher warn before the code goes dead, and sorts the vault by
    // what's most urgent to sell or redeem.
    expiresAt: { type: Date, default: null, index: true },
    // Set once the "expiring soon" Telegram alert has fired, so it isn't
    // repeated every watcher tick.
    expiryAlertSentAt: { type: Date, default: null },
    // Set when a key was redeemed onto a stored GogAccount instead of being
    // sold as a raw code (the fallback for a key that didn't sell in time).
    redeemedAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GogAccount",
      default: null,
    },
    redeemedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PrimeKey", primeKeySchema);
