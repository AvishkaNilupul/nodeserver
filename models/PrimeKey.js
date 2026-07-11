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
      enum: ["unused", "listed", "sold"],
      default: "unused",
      index: true,
    },
    soldAt: { type: Date, default: null },
    soldToUsername: { type: String, default: "" },
    soldPrice: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PrimeKey", primeKeySchema);
