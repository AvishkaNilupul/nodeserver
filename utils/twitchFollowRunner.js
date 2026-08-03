// Background worker that drives TwitchFollowJob docs to completion.
//
// One in-process loop per job so multiple jobs on different channels can run
// side by side without one blocking the others. Each loop:
//   1. Loads the eligible-account list once at start (BotAccount ∩ has token
//      ∩ not sold ∩ not already logged 'ok' for THIS channel).
//   2. Waits a jittered delay (job.avgGapMs ± job.jitter), plus occasional
//      long "distracted human" pauses, so the outbound traffic doesn't look
//      like a fixed-cadence bot burst.
//   3. Fires utils/twitchFollow.followChannel from the picked account, on the
//      picked host, and records the outcome to TwitchFollowLog.
//   4. Bails on cancellation, on 5 consecutive failures (Twitch is angry),
//      when requestedCount is reached, or when the candidate pool is drained.
//
// State is persisted on the job doc, so a server restart resumes cleanly:
// start() picks up any pending/running job on boot and re-spawns its loop.
const mongoose = require("mongoose");

const BotAccount = require("../models/BotAccount");
const TwitchFollowJob = require("../models/TwitchFollowJob");
const TwitchFollowLog = require("../models/TwitchFollowLog");
const secretBox = require("./secretBox");
const twitchFollow = require("./twitchFollow");
const hosts = require("./botHosts");

// Cap so a runaway config can't wedge the loop into a pathological wait.
const MIN_DELAY_MS = 15 * 1000; // 15s floor per follow
const MAX_DELAY_MS = 15 * 60 * 1000; // 15 minutes ceiling
const IDLE_PAUSE_MIN_MS = 3 * 60 * 1000;
const IDLE_PAUSE_MAX_MS = 8 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;

// Tracks the loops currently in flight so start() is idempotent and cancel
// can flip a flag the loop reads on its next tick.
const activeLoops = new Map(); // jobId -> { cancelled: false, promise }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickJitteredDelay(avgMs, jitter) {
  const j = Math.max(0, Math.min(1, jitter));
  const lo = avgMs * (1 - j);
  const hi = avgMs * (1 + j);
  const raw = lo + Math.random() * (hi - lo);
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(raw)));
}

function pickIdlePause() {
  return (
    IDLE_PAUSE_MIN_MS +
    Math.floor(Math.random() * (IDLE_PAUSE_MAX_MS - IDLE_PAUSE_MIN_MS))
  );
}

// Best-effort decrypt — the token column (clientSecret) is stored in the
// clear on BotAccount today (unlike credPassword). secretBox.decrypt returns
// its input for a plaintext value that isn't a sealed envelope, so calling it
// unconditionally is safe and future-proofs the runner if we ever wrap the
// token too.
function readToken(account) {
  const raw = account.clientSecret || "";
  if (!raw) return "";
  try {
    return secretBox.decrypt(raw);
  } catch {
    return raw;
  }
}

// Which host does the follow egress from? By default, the account's own
// farming host — that keeps a consistent IP/device fingerprint per token,
// which is what integrity gating cares about. If the operator restricted the
// job to a specific host set, round-robin across that set instead.
function pickHostForAccount(account, hostIds, hostCursor) {
  if (hostIds && hostIds.length) {
    const chosen = hostIds[hostCursor.i % hostIds.length];
    hostCursor.i += 1;
    return hosts.resolveHost(chosen);
  }
  return hosts.resolveHost(account.host || "local");
}

// Snapshot the eligible-account pool for this job ONCE at start. Re-scanning
// on every follow would be quadratic on the log; instead we work from the
// snapshot and let the log dedupe handle future jobs against the same
// channel.
async function buildCandidatePool(job) {
  const already = await TwitchFollowLog.distinct("botAccountId", {
    channelId: job.channelId,
    status: { $in: ["ok", "already_following"] },
  });
  const filter = {
    enabled: true,
    soldAt: null,
    clientSecret: { $gt: "" },
    _id: { $nin: already },
  };
  if (job.integrityOnly) {
    // Fresh 'ok' scan is our best available integrity proxy — a dead/
    // integrity-failing token surfaces as token_invalid or 'error' here.
    filter.lastScanStatus = "ok";
  }
  if (job.hostIds && job.hostIds.length) {
    // If the operator narrowed to specific hosts, only offer accounts that
    // live on one of them (their token is bound to that host's IP anyway).
    filter.host = { $in: job.hostIds };
  }
  const candidates = await BotAccount.find(filter)
    .sort({ dropCount: -1, lastScanAt: -1 }) // seasoned accounts first
    .select("_id login host clientSecret lastScanStatus")
    .lean();
  // Shuffle so consecutive jobs against different channels don't all pick
  // the same top-of-list accounts in identical order.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates;
}

async function markTerminal(job, status, message) {
  job.status = status;
  job.finishedAt = new Date();
  if (message) job.lastMessage = message;
  await job.save();
}

async function runJob(jobId) {
  const state = activeLoops.get(String(jobId));
  const job = await TwitchFollowJob.findById(jobId);
  if (!job) return;
  if (job.status === "cancelled" || job.status === "done" || job.status === "failed") {
    return;
  }

  if (!job.startedAt) job.startedAt = new Date();
  job.status = "running";
  await job.save();

  let pool;
  try {
    pool = await buildCandidatePool(job);
  } catch (err) {
    await markTerminal(job, "failed", "Pool build failed: " + err.message);
    return;
  }
  if (!pool.length) {
    await markTerminal(job, "done", "No eligible accounts (pool empty)");
    return;
  }

  const hostCursor = { i: 0 };

  while (job.delivered < job.requestedCount) {
    if (state && state.cancelled) {
      await markTerminal(job, "cancelled", "Cancelled by operator");
      return;
    }
    // Re-read the doc every iteration so an operator flipping cancelRequested
    // from the UI takes effect without needing an in-memory signal.
    const fresh = await TwitchFollowJob.findById(jobId).lean();
    if (!fresh) return;
    if (fresh.cancelRequested) {
      if (state) state.cancelled = true;
      await markTerminal(job, "cancelled", "Cancelled by operator");
      return;
    }
    if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await markTerminal(
        job,
        "failed",
        "Aborted after " +
          MAX_CONSECUTIVE_FAILURES +
          " consecutive failures — twitch may be pushing back",
      );
      return;
    }
    if (!pool.length) {
      await markTerminal(
        job,
        "done",
        "Pool exhausted at " +
          job.delivered +
          "/" +
          job.requestedCount +
          " delivered",
      );
      return;
    }

    const account = pool.shift();
    const host = pickHostForAccount(account, job.hostIds, hostCursor);
    if (!host) {
      job.skipped += 1;
      await job.save();
      continue;
    }

    // Delay BEFORE the follow so the first attempt after job creation isn't
    // an instant burst either. Skip the sleep on the very first candidate
    // when delivered is 0 to keep the UI responsive.
    if (job.delivered + job.failed + job.alreadyFollowing > 0) {
      const gap = pickJitteredDelay(job.avgGapMs, job.jitter);
      job.nextAttemptAt = new Date(Date.now() + gap);
      await job.save();
      await sleep(gap);
      // Occasional long pause — humans don't follow at a metronomic gap.
      if (Math.random() < (job.idlePauseChance || 0)) {
        const pause = pickIdlePause();
        job.nextAttemptAt = new Date(Date.now() + pause);
        await job.save();
        await sleep(pause);
      }
    }

    // A last cancel/failure check after the sleep — the operator or an
    // earlier iteration may have changed the picture.
    const beforeFire = await TwitchFollowJob.findById(jobId).lean();
    if (!beforeFire) return;
    if (beforeFire.cancelRequested) {
      await markTerminal(job, "cancelled", "Cancelled by operator");
      return;
    }

    const token = readToken(account);
    if (!token) {
      job.skipped += 1;
      await job.save();
      await TwitchFollowLog.create({
        jobId: job._id,
        channelId: job.channelId,
        channelLogin: job.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: host.id,
        status: "skipped",
        error: "empty token",
      });
      continue;
    }

    try {
      await twitchFollow.followChannel(token, job.channelId, { host });
      job.delivered += 1;
      job.consecutiveFailures = 0;
      await job.save();
      await TwitchFollowLog.create({
        jobId: job._id,
        channelId: job.channelId,
        channelLogin: job.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: host.id,
        status: "ok",
      });
    } catch (err) {
      // Transport failure: the host, not the account. Put the account back at
      // the end of the queue and try a different one next iteration.
      if (err.transportFailed) {
        job.skipped += 1;
        await job.save();
        pool.push(account);
        continue;
      }
      const code = err.code || "error";
      job.failed += 1;
      job.consecutiveFailures += 1;
      job.lastError = code + ": " + (err.message || "").slice(0, 200);
      await job.save();
      await TwitchFollowLog.create({
        jobId: job._id,
        channelId: job.channelId,
        channelLogin: job.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: host.id,
        status: "failed",
        error: code + (err.twitchCode ? "/" + err.twitchCode : ""),
      });
    }
  }

  await markTerminal(
    job,
    "done",
    "Delivered " + job.delivered + "/" + job.requestedCount + " follows",
  );
}

function enqueueJob(jobId) {
  const key = String(jobId);
  if (activeLoops.has(key)) return activeLoops.get(key).promise;
  const state = { cancelled: false, promise: null };
  activeLoops.set(key, state);
  state.promise = (async () => {
    try {
      await runJob(jobId);
    } catch (err) {
      // Last-chance catch so the loop map doesn't leak a Promise rejection.
      try {
        const job = await TwitchFollowJob.findById(jobId);
        if (job && !["done", "cancelled", "failed"].includes(job.status)) {
          job.status = "failed";
          job.lastError = "runner crash: " + (err.message || err);
          job.finishedAt = new Date();
          await job.save();
        }
      } catch {
        // Nothing we can do at this point.
      }
    } finally {
      activeLoops.delete(key);
    }
  })();
  return state.promise;
}

function cancelJob(jobId) {
  const key = String(jobId);
  const state = activeLoops.get(key);
  if (state) state.cancelled = true;
  // The loop also polls job.cancelRequested from Mongo, so a cancel issued
  // while the runner isn't in memory (e.g. after a restart, before start()
  // has repicked the job) still takes effect on next resume.
}

async function start() {
  if (mongoose.connection.readyState !== 1) {
    // Called too early during boot — retry once the connection is up.
    mongoose.connection.once("connected", () => start());
    return;
  }
  const pending = await TwitchFollowJob.find({
    status: { $in: ["pending", "running"] },
    cancelRequested: { $ne: true },
  })
    .select("_id")
    .lean();
  for (const p of pending) enqueueJob(p._id);
}

function status() {
  return {
    active: activeLoops.size,
    jobIds: [...activeLoops.keys()],
  };
}

module.exports = {
  start,
  enqueueJob,
  cancelJob,
  status,
};
