const mongoose = require("mongoose");

// One document per follow ATTEMPT — every candidate the worker actually fired
// the mutation at, whether it succeeded, was already following, or errored.
//
// Why it's a separate collection from TwitchFollowJob:
//   * Jobs TTL out at 30 days; the log lives longer so "who has already
//     followed channel X" survives the job disappearing.
//   * The eligibility check when planning a new job is a distinct query on
//     this collection ({channelId, status:'ok'} => distinct botAccountId).
//
// Status:
//   ok                 -> follow succeeded (new follow OR already following)
//   already_following  -> mutation said the account already follows the target;
//                         counted as "used up" for future dedupe purposes just
//                         like ok
//   failed             -> mutation returned an error (bad token, integrity,
//                         banned, rate-limited). NOT excluded from future
//                         jobs — a fresh token or a different host may work.
//   skipped            -> discarded before firing (host unreachable, token
//                         went bad in the pre-check); same retry semantics as
//                         failed
const twitchFollowLogSchema = new mongoose.Schema(
  {
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TwitchFollowJob",
      required: true,
      index: true,
    },
    channelId: { type: String, required: true, index: true },
    channelLogin: { type: String, default: "" },

    botAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
      index: true,
    },
    botLogin: { type: String, default: "" },
    host: { type: String, default: "" },

    status: {
      type: String,
      enum: ["ok", "already_following", "failed", "skipped"],
      required: true,
      index: true,
    },
    error: { type: String, default: "" },

    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

// The dedupe query — "give me every account already committed to this
// channel". Both terminal-success states count as committed so an
// already-following account never wastes a slot in a future job.
twitchFollowLogSchema.index({ channelId: 1, status: 1, botAccountId: 1 });

module.exports = mongoose.model("TwitchFollowLog", twitchFollowLogSchema);
