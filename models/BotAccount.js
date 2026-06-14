const mongoose = require("mongoose");

// One document per Twitch farming account. Keyed by the account's Twitch auth
// token (ClientSecret) since that's the one field every account always has and
// is what we use to query Twitch. Credentials (password/email) are stored
// encrypted at rest via utils/secretBox.
const botAccountSchema = new mongoose.Schema(
  {
    clientSecret: { type: String, required: true, unique: true, index: true },
    login: { type: String, default: "", index: true },
    twitchId: { type: String, default: "" },
    uniqueId: { type: String, default: "" },
    // Last bot config file this account was seen in (e.g. config_02.json).
    configFile: { type: String, default: "" },
    container: { type: String, default: "" },
    enabled: { type: Boolean, default: true },

    // Provided separately by the operator and matched to the account by login.
    // username is stored in the clear (it's the login); password/email are
    // encrypted. hasPassword lets us filter/badge without decrypting.
    credUsername: { type: String, default: "" },
    credPassword: { type: String, default: "" },
    credEmail: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    // Scan bookkeeping.
    lastScanAt: { type: Date, default: null },
    lastScanStatus: {
      type: String,
      enum: ["pending", "ok", "token_invalid", "error"],
      default: "pending",
      index: true,
    },
    lastScanError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BotAccount", botAccountSchema);
