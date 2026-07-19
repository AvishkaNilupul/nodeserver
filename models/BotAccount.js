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
    // Which managed host this account's config lives on ("local" for the
    // server itself, or a configured remote host id such as "pi"). Defaults to
    // local so accounts synced before multi-host support keep grouping under
    // the server tab.
    host: { type: String, default: "local", index: true },
    enabled: { type: Boolean, default: true },

    // Provided separately by the operator and matched to the account by login.
    // username is stored in the clear (it's the login); password/email are
    // encrypted. hasPassword lets us filter/badge without decrypting.
    credUsername: { type: String, default: "" },
    credPassword: { type: String, default: "" },
    credEmail: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    // Shop sale bookkeeping. When an account is delivered to a buyer via the
    // Shop it is retired from the sellable pool by stamping soldAt; the
    // remaining fields record who got it and as part of which bundle.
    soldAt: { type: Date, default: null, index: true },
    soldToAdminId: { type: String, default: "" },
    soldToUsername: { type: String, default: "" },
    soldSetId: { type: String, default: "" },
    soldPurchaseId: { type: String, default: "" },
    // Set instead of soldPurchaseId when the account is reserved as part of a
    // bulk order rather than a single Shop purchase. The soldAt:null guard is
    // shared, so a bulk reservation and a Shop sale can never collide.
    soldBulkOrderId: { type: String, default: "" },

    // Scan bookkeeping. Indexed because the scanner picks the oldest-scanned
    // account each tick and the progress view sorts/filters on it.
    lastScanAt: { type: Date, default: null, index: true },
    lastScanStatus: {
      type: String,
      enum: ["pending", "ok", "token_invalid", "error"],
      default: "pending",
      index: true,
    },
    lastScanError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },

    // How many times this account's credentials were copied from the archive
    // UI (delivery bookkeeping — flags accounts already handed to a buyer).
    copiedCount: { type: Number, default: 0 },
    lastCopiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BotAccount", botAccountSchema);
