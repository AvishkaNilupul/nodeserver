const mongoose = require("mongoose");

// One row per Paid Eldorado "Overwatch Loot Boxes | Dupe Boxes" order (offerId
// pinned in settings.twitchDupeOfferId). Powers the auto-delivery flow: the
// server reserves farmed Twitch accounts + posts a t.me deep-link in the
// Eldorado chat, the buyer opens the Telegram bot, the bot fires the dupe over
// the same GQL Claim path the operator's /fire uses, and the row closes.
//
// This exists BECAUSE the dupe fire needs strict single-flight (races 2600
// parallel ClaimDropRewards mutations against Twitch — two orders firing at
// once would blur each other's Client-Integrity slot) and because the job
// hops two processes (Node coordinator on prod → Python bot on the Mac) that
// must not lose track of who is holding the buyer's money. The row is claimed
// on a unique orderId BEFORE anything is reserved, and each stage is stamped
// as it lands, so a restart resumes at the right step instead of starting
// over.
const twitchDupeFireJobSchema = new mongoose.Schema(
  {
    // The Eldorado order. Unique — the idempotency key. Every insert races on
    // this, so a fulfiller tick that fires twice for the same order finds the
    // duplicate on the second write instead of double-reserving.
    orderId: { type: String, required: true, unique: true, index: true },

    // Short, human-typeable reference we mint per job ("DPBX-a4f3c1"). Sent
    // to the buyer in the t.me?start=<ref> deep link and echoed back by the
    // bot on every state transition, so an out-of-order call (e.g. /linked
    // arriving before /claim landed) can be rejected loudly rather than
    // silently mis-routing.
    orderRef: { type: String, required: true, unique: true, index: true },

    // Copied off the Eldorado order for auditing without a re-fetch.
    offerId: { type: String, default: "", index: true },
    offerTitle: { type: String, default: "" },
    buyerUsername: { type: String, default: "" },
    purchaseQuantity: { type: Number, default: 1 },

    // Farm-Twitch logins reserved for this order. We store logins only — the
    // password / clientSecret are resolved on demand via utils/accountLookup
    // so a stolen dump of this collection can never hand out plaintext creds.
    // Order matters: the bot reads them in this order when it DMs the buyer.
    reservedUsernames: {
      type: [
        {
          _id: false,
          login: { type: String, required: true },
        },
      ],
      default: [],
    },

    // The Telegram chat that "owns" the delivery, stamped on the bot's /claim
    // call. Every later bot call (mark-linked, complete) must present the
    // same chatId — otherwise a stranger who guessed the orderRef could hijack
    // the flow. The routes enforce this.
    telegramChatId: { type: Number, default: null, index: true },

    state: {
      type: String,
      // awaitingClaim  — deep link posted to Eldorado chat, buyer hasn't
      //                  opened Telegram yet
      // awaitingLink   — bot DMed the buyer their user:pass block, waiting
      //                  on the buyer's /linked
      // readyToFire    — buyer replied /linked, the bot will fire as soon
      //                  as FIRE_LOCK is free
      // firing         — the bot has the lock and is spamming ClaimDropRewards
      // done           — fire finished, Eldorado order marked delivered
      // failed         — fire threw or Twitch refused every claim; needs a
      //                  hand-touch
      // cancelled      — buyer walked away / dispute / owner cancelled;
      //                  reserved usernames are returned to the pool
      enum: [
        "awaitingClaim",
        "awaitingLink",
        "readyToFire",
        "firing",
        "done",
        "failed",
        "cancelled",
      ],
      default: "awaitingClaim",
      index: true,
    },

    // Per-username outcome, appended by the bot at fire time. Empty for a
    // job that never made it past awaitingLink.
    results: {
      type: [
        {
          _id: false,
          login: { type: String, default: "" },
          dropsAttempted: { type: Number, default: 0 },
          dropsClaimed: { type: Number, default: 0 },
          fireCount: { type: Number, default: 0 },
          success: { type: Boolean, default: false },
          error: { type: String, default: "" },
        },
      ],
      default: [],
    },

    // Stage stamps. Each is set exactly once, on the transition INTO that
    // stage. Missing = the stage never happened (e.g. a cancelled order has
    // no firedAt).
    reservedAt: { type: Date, default: null },
    sentToEldoradoAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    linkedAt: { type: Date, default: null },
    firedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },

    // Set the ONE time the fallback tick pages the owner after N minutes of
    // silence (default 30). Presence is the dedupe — never re-page.
    ownerNotifiedAt: { type: Date, default: null },

    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TwitchDupeFireJob", twitchDupeFireJobSchema);
