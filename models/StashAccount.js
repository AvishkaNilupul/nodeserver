const mongoose = require("mongoose");

// One account parked inside a StashSet. Deliberately mirrors the storable shape
// of models/AvailableAccount.js (so "Move set -> Account Pool" is a clean
// hand-off), but lives in its own collection that no bot/pool/drop-scanner code
// touches. Credentials are encrypted at rest via utils/secretBox, same
// convention as AvailableAccount and BotAccount.
//
// The live-check bookkeeping here is intentionally lighter than the pool's: a
// stash scan only asks "does this token still authenticate against Twitch, and
// how many drops does it see" (see utils/stashChecker.js). It never writes to
// the Drops Archive, so scanning a stash set has zero side effects anywhere
// else in the app.
// Per-account aging state, driven by utils/stashAging.js.
//
// The lifecycle is a small forward-only ladder, and every account walks it in
// the same order so the timeline is legible:
//
//   new     -> just landed; nothing has looked at it yet
//   verify  -> prove the token authenticates before spending any effort on it
//   settle  -> deliberate do-nothing window (policy.settleDays)
//   warmup  -> first few short sessions, no follows yet
//   active  -> the long haul: full-length sessions, follows start appearing
//   mature  -> gates satisfied; ready for the pool (auto or by hand)
//
// Off to the side, and never re-entered automatically:
//   dead    -> Twitch rejected the token; excluded from every sweep
//   paused  -> an operator (or the strike limit) stopped this account
//
// Nothing here is ever consulted by bot / pool / scanner code. Aging state that
// goes missing is not a correctness problem — the ladder just restarts.
const agingStateSchema = new mongoose.Schema(
  {
    stage: {
      type: String,
      enum: ["new", "verify", "settle", "warmup", "active", "mature", "dead", "paused"],
      default: "new",
      index: true,
    },

    // When the runner should next look at this account. The whole scheduler is
    // built on this one field: each account carries its own jittered wake time,
    // so the runner never has to iterate a set to work out who is due, and a
    // thousand accounts spread themselves out for free.
    nextEligibleAt: { type: Date, default: null },

    // Set while a session is in flight. A claim is a short lease rather than a
    // boolean so a crash mid-session can't strand an account forever — the
    // lease simply expires and the account becomes claimable again.
    leaseUntil: { type: Date, default: null },

    // The account's stable handful of channels (logins). Assigned on the first
    // session and then mostly left alone; a slot is only replaced when its
    // channel has been offline for several attempts running.
    taste: { type: [String], default: [] },

    sessions: { type: Number, default: 0 },
    watchMinutes: { type: Number, default: 0 },
    follows: { type: Number, default: 0 },

    lastSessionAt: { type: Date, default: null },
    lastChannel: { type: String, default: "" },
    // "watched" when minute-watched pings were accepted, "presence" when only
    // the browser-shaped queries went through (see utils/twitchWatch.js).
    lastSessionKind: { type: String, default: "" },

    // Consecutive failed sessions. Reset by any success; at the runner's limit
    // the account is parked in `paused` rather than retried forever.
    strikes: { type: Number, default: 0 },
    lastError: { type: String, default: "" },

    startedAt: { type: Date, default: null },
    maturedAt: { type: Date, default: null },
    // Stamped just before the promote helper runs, so a graduation that fails
    // halfway is visible rather than silent.
    graduatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const stashAccountSchema = new mongoose.Schema(
  {
    setId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StashSet",
      required: true,
      index: true,
    },

    username: { type: String, required: true, index: true },
    // Lowercased mirror; uniqueness is per-set (same account can't sit twice in
    // one set, but may exist in different sets), enforced by the compound index
    // below.
    usernameLower: { type: String, required: true },

    // Encrypted at rest.
    password: { type: String, default: "" },
    email: { type: String, default: "" },
    hasPassword: { type: Boolean, default: false },

    // Present once the account has been through Twitch's device-auth flow.
    clientSecret: { type: String, default: "" },
    uniqueId: { type: String, default: "" },
    twitchId: { type: String, default: "" },

    // Result of the last stash live-check.
    //   ""              - never checked
    //   "ok"            - token authenticates and passes the integrity gate
    //   "token_invalid" - Twitch rejected the token
    //   "integrity_failed" - authenticates but fails the bot's drops query gate
    //   "error"         - transient/other failure; retry next scan
    lastCheckAt: { type: Date, default: null },
    lastCheckStatus: {
      type: String,
      enum: ["", "ok", "token_invalid", "integrity_failed", "error"],
      default: "",
    },
    lastCheckError: { type: String, default: "" },
    dropCount: { type: Number, default: 0 },

    source: { type: String, default: "" },

    aging: { type: agingStateSchema, default: () => ({}) },
  },
  { timestamps: true },
);

// One row per username within a given set.
stashAccountSchema.index({ setId: 1, usernameLower: 1 }, { unique: true });

// The runner's only hot query: "which accounts are due right now". Compound so
// the stage filter and the due-time range are served by one index — this runs
// every tick, and prod Mongo is an Atlas shared tier where a collection scan
// per minute is not free.
stashAccountSchema.index({ "aging.stage": 1, "aging.nextEligibleAt": 1 });

module.exports = mongoose.model("StashAccount", stashAccountSchema);
