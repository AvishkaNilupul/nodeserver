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
    // "suspended" is token_invalid's terminal twin: Twitch rejects the token AND
    // the account no longer exists at all (utils/twitchAccountState.js proves it
    // with the public user query). The distinction is the point — a token_invalid
    // account is re-authable and its farmed drops are still worth keeping
    // assigned, a suspended one never comes back, so it must free its slot and
    // stop being counted as supply.
    lastScanStatus: {
      type: String,
      enum: ["pending", "ok", "token_invalid", "error", "suspended"],
      default: "pending",
      index: true,
    },
    lastScanError: { type: String, default: "" },
    // When the account was confirmed gone from Twitch.
    suspendedAt: { type: Date, default: null },
    dropCount: { type: Number, default: 0 },

    // Farming progress, captured from the same inventory fetch the drop scan
    // already makes — fetchInventory has always returned `inProgress` and the
    // scanner simply discarded it. An account with nothing unclaimed left is
    // one that has finished every campaign it was watching and is now idling
    // in TwitchDropsBot's 300-second sleep loop, still costing its share of a
    // container. That idling is most of the fleet, so this is the signal a
    // scheduler needs to stop paying for work that is already done.
    //
    // RAW DATA, NOT A VERDICT. Two traps make these unsafe to read alone, and
    // utils/farmCompletion.js exists to apply both rules — use it instead:
    //
    //  1. inProgressCount counts EVERY campaign with unclaimed progress,
    //     including games the bot does not farm and can never advance
    //     (containers run OnlyFavouriteGames = true). Measured on the Pi:
    //     twitchbotx19/x20 accounts all showed 2 pending drops for
    //     "Assassin's Creed Black Flag Resynced" while farming Sea of Thieves
    //     and Delta Force — stranded at 2/120 min forever. On the raw count
    //     those bots look permanently busy; against their assigned games they
    //     were finished. Completion is the INTERSECTION with assigned games.
    //  2. Twitch only lists a campaign once watching has begun, so an account
    //     that hasn't started yet also reports zero pending. Zero pending with
    //     dropCount 0 means "not started", never "done".
    //
    // A scan that fails returns before these are written, so a dead token or
    // an unreachable host cannot fake completion — but a STALE value can, so
    // freshness is checked too.
    inProgressCount: { type: Number, default: 0 },
    inProgressGames: { type: [String], default: [] },
    farmingCompleteAt: { type: Date, default: null, index: true },

    // How many times this account's credentials were copied from the archive
    // UI (delivery bookkeeping — flags accounts already handed to a buyer).
    copiedCount: { type: Number, default: 0 },
    lastCopiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BotAccount", botAccountSchema);
