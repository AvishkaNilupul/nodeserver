const mongoose = require("mongoose");

// One document per follow-bot job an admin creates from /twitch-follows.html.
// The worker in utils/twitchFollowRunner.js drives it: picks eligible bot
// accounts (see TwitchFollowLog for the "already followed" exclusion), fires
// Twitch's followUser mutation from each, and stamps progress back on this
// doc so the tab can render live status.
//
// Status lifecycle:
//   pending    -> just created; worker will pick it up on next tick
//   running    -> worker owns it; startedAt set, progress fields update
//   done       -> requestedCount reached OR eligible pool ran out
//   cancelled  -> operator hit Cancel (cancelRequested flipped true)
//   failed     -> worker gave up (5+ consecutive transient errors, or the
//                 channel couldn't be resolved)
const twitchFollowJobSchema = new mongoose.Schema(
  {
    // Resolved once at job creation so re-labelling / re-scoping doesn't drift
    // the log. channelId is the numeric Twitch user id (targetID of the
    // followUser mutation); login is the URL slug; displayName is cosmetic.
    channelId: { type: String, required: true, index: true },
    channelLogin: { type: String, required: true },
    channelDisplayName: { type: String, default: "" },
    // Whatever the operator pasted (URL or bare login) — kept for the UI.
    channelInput: { type: String, default: "" },

    requestedCount: { type: Number, required: true, min: 1 },

    // Pacing knobs. avgGapMs is the target average delay between follows;
    // jitter (0..1) widens the uniform window to [avg*(1-j), avg*(1+j)].
    // idlePauseChance (0..1) is the per-follow probability of an extra
    // 3-8 minute "distracted human" pause on top of the base jitter.
    avgGapMs: { type: Number, default: 60000 },
    jitter: { type: Number, default: 0.4 },
    idlePauseChance: { type: Number, default: 0.08 },

    // Which scan hosts the worker is allowed to egress from. Empty => every
    // enabled host. Same ids as botHosts.listHosts().
    hostIds: { type: [String], default: [] },

    // Parallel worker sub-loops per job. Each worker drains from the same
    // candidate pool, so N workers ≈ N× throughput. Capped at 5 — beyond
    // that the follow burst against a single channel starts looking too
    // synchronised regardless of jitter. Counter updates run through $inc
    // so parallel workers can't lose an increment.
    concurrency: { type: Number, default: 1, min: 1, max: 5 },

    // Only offer accounts whose token has passed a recent integrity check
    // (utils/twitchInventory records that indirectly — dead tokens surface as
    // lastScanStatus token_invalid). No dedicated integrity flag exists on
    // BotAccount today; we prefer accounts with a fresh ok scan.
    integrityOnly: { type: Boolean, default: true },

    status: {
      type: String,
      enum: ["pending", "running", "done", "cancelled", "failed"],
      default: "pending",
      index: true,
    },
    cancelRequested: { type: Boolean, default: false },

    // Progress counters, updated after every attempt. delivered = new follows
    // this job produced; alreadyFollowing = twitch returned success with no
    // change; skipped = candidate discarded before the mutation (dead token,
    // host offline); failed = mutation returned a hard error.
    delivered: { type: Number, default: 0 },
    alreadyFollowing: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },

    // Terminal message on failure/done — surfaces in the job card.
    lastError: { type: String, default: "" },
    lastMessage: { type: String, default: "" },

    // Who created the job (admin session id or login) — bookkeeping only.
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

// Jobs older than 30 days are strictly history — the useful log lives on
// TwitchFollowLog. TTL keeps the job list light.
twitchFollowJobSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

module.exports = mongoose.model("TwitchFollowJob", twitchFollowJobSchema);
