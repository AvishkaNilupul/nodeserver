const mongoose = require("mongoose");

// One document per stock Epic Games account used for free-game bundles.
// The refresh token (valid ~1 year) is stored encrypted via utils/secretBox;
// everything else is metadata for the Epic accounts tab + auto-claim runs.
const epicAccountSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, default: "" },
    label: { type: String, default: "" },
    // Encrypted OAuth refresh token + its expiry (accounts need a fresh
    // authorization code once the refresh token expires, ~1 year).
    refreshToken: { type: String, default: "" },
    refreshExpiresAt: { type: Date, default: null },
    status: { type: String, default: "ok", index: true }, // ok | needs_login
    lastError: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },

    // Owned games (from the launcher library, resolved to titles).
    library: [
      {
        namespace: { type: String, default: "" },
        catalogItemId: { type: String, default: "" },
        title: { type: String, default: "" },
        developer: { type: String, default: "" },
        priceUsd: { type: Number, default: 0 },
        acquiredAt: { type: Date, default: null },
      },
    ],
    libraryCount: { type: Number, default: 0 },
    libraryValueUsd: { type: Number, default: 0 },

    // Sales lifecycle — mirrors how Twitch bot accounts are handled: a sold
    // account stops being fed new claims.
    sold: { type: Boolean, default: false, index: true },

    // Login credentials — populated only for accounts created by the Chrome
    // extension generator (source="generated"); older manually-imported rows
    // leave these empty. Email + password + TOTP secret are encrypted at
    // rest via utils/secretBox so a buyer can be handed the account whole.
    email: { type: String, default: "" },
    password: { type: String, default: "" },
    totpSecret: { type: String, default: "" },
    source: { type: String, default: "manual", index: true }, // manual | generated
  },
  { timestamps: true },
);

module.exports = mongoose.model("EpicAccount", epicAccountSchema);
