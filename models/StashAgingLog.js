const mongoose = require("mongoose");

// One row per thing the aging runner did to a stashed account. This is the
// "flow" the Account Stash page renders: open an account and you get its story
// in order — landed, verified, settled, watched X for N minutes, followed
// someone, matured, graduated.
//
// Deliberately append-only and cheap. The runner writes one of these per event
// and never reads them back for decisions; all scheduling state lives on
// StashAccount.aging. That separation matters — losing this collection costs
// you history, never correctness.
//
// TTL'd at 60 days: long enough to cover a full aging window plus a good margin
// of hindsight, short enough that a fleet of accounts logging a few events a
// day doesn't grow without bound on a shared-tier Atlas cluster.
const stashAgingLogSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StashAccount",
      required: true,
      index: true,
    },
    setId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StashSet",
      required: true,
      index: true,
    },
    // Denormalised so a log row still reads sensibly after its account has
    // graduated out of the stash and the StashAccount row is gone.
    username: { type: String, default: "" },

    // stage      - moved from one rung of the ladder to another
    // session    - a watch session finished (ok or not)
    // follow     - followed a channel it had watched
    // verify     - live-check result that gated entry into aging
    // graduate   - handed to the Account Pool
    // error      - something went wrong that didn't fit a session
    // note       - operator action (pause, resume, reset, run-now)
    kind: {
      type: String,
      enum: ["stage", "session", "follow", "verify", "graduate", "error", "note"],
      required: true,
      index: true,
    },

    // Human-readable one-liner — this is what the timeline actually shows.
    message: { type: String, default: "" },

    // Optional structured detail for the richer rows.
    fromStage: { type: String, default: "" },
    toStage: { type: String, default: "" },
    channel: { type: String, default: "" },
    minutes: { type: Number, default: 0 },
    host: { type: String, default: "" },
    // "watched" (minute-watched pings accepted) or "presence" (browser-shaped
    // queries only). Worth keeping per row: a set that only ever logs
    // "presence" is a set whose sessions aren't accruing real watch time.
    kindDetail: { type: String, default: "" },
    ok: { type: Boolean, default: true },
    dryRun: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// The timeline query: newest-first for one account.
stashAgingLogSchema.index({ accountId: 1, createdAt: -1 });
// The set-wide activity feed on the aging panel.
stashAgingLogSchema.index({ setId: 1, createdAt: -1 });

stashAgingLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 24 * 60 * 60 },
);

module.exports = mongoose.model("StashAgingLog", stashAgingLogSchema);
