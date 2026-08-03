// Background worker that drives TwitchFollowJob docs to completion.
//
// One in-process controller per job, but the controller can spawn N parallel
// worker sub-loops (job.concurrency) that share a single candidate pool.
// Counter updates use $inc so parallel workers can't lose an increment. Each
// worker:
//   1. Pops the next account from the shared pool (pool.shift is atomic in
//      single-threaded JS — no lock needed).
//   2. Waits a jittered delay (job.avgGapMs ± job.jitter), plus occasional
//      long "distracted human" pauses.
//   3. Fires utils/twitchFollow.followChannel from the picked account, on the
//      picked host, and records the outcome to TwitchFollowLog.
//   4. Falls back to the local host once if the account's home host is dead
//      (Pi outage), before giving up on that account.
//   5. Bails on cancellation, on 5 consecutive failures across the whole job,
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

// A short 2s floor gives operators room to pick fast pacing (batches of a few
// hundred follows over minutes rather than hours) without letting a misconfig
// hammer twitch with zero-gap requests. The 15-minute ceiling stops a
// runaway average * jitter from wedging a worker for hours per follow.
const MIN_DELAY_MS = 2 * 1000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const IDLE_PAUSE_MIN_MS = 3 * 60 * 1000;
const IDLE_PAUSE_MAX_MS = 8 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_CONCURRENCY = 5;

// Tracks the loops currently in flight so start() is idempotent and cancel
// can flip a flag every worker sub-loop reads on its next tick.
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

// Small atomic-update helpers. $inc + optional $set means two workers that
// increment `delivered` at the same time both land; the last-writer-wins
// behaviour of .save() would lose one of them.
async function incJobCounters(jobId, incFields, setFields) {
  const update = { $inc: incFields };
  if (setFields && Object.keys(setFields).length) update.$set = setFields;
  return TwitchFollowJob.findByIdAndUpdate(jobId, update, {
    new: true,
    lean: true,
  });
}

// Terminal marking is idempotent — first worker to hit an end condition wins,
// the others just exit on their next tick because status is no longer
// 'running'. Guarding on `status: 'running'` in the filter is what stops a
// second worker from stomping "done" back over "cancelled" a moment later.
async function markTerminalAtomic(jobId, status, message) {
  return TwitchFollowJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ["pending", "running"] } },
    {
      $set: {
        status,
        finishedAt: new Date(),
        ...(message ? { lastMessage: message } : {}),
      },
    },
    { new: true, lean: true },
  );
}

// One worker sub-loop — N of these run in parallel per job. shared holds
// cross-worker signals (cancelled flag, "already terminal" flag) so a peer
// stopping the job is picked up on the next iteration by every other worker.
async function runWorker(jobId, workerIndex, pool, hostCursor, shared) {
  while (true) {
    if (shared.cancelled || shared.terminated) return;

    // Fresh doc — every worker re-reads the job before deciding to continue,
    // so an operator-issued cancel or a peer's terminal decision propagates
    // without needing an in-memory signal.
    const fresh = await TwitchFollowJob.findById(jobId).lean();
    if (!fresh) return;
    if (fresh.cancelRequested) {
      shared.cancelled = true;
      await markTerminalAtomic(jobId, "cancelled", "Cancelled by operator");
      return;
    }
    if (["done", "cancelled", "failed"].includes(fresh.status)) {
      shared.terminated = true;
      return;
    }
    if (fresh.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      shared.terminated = true;
      await markTerminalAtomic(
        jobId,
        "failed",
        "Aborted after " +
          MAX_CONSECUTIVE_FAILURES +
          " consecutive failures — twitch may be pushing back",
      );
      return;
    }
    if (fresh.delivered >= fresh.requestedCount) {
      shared.terminated = true;
      await markTerminalAtomic(
        jobId,
        "done",
        "Delivered " +
          fresh.delivered +
          "/" +
          fresh.requestedCount +
          " follows",
      );
      return;
    }
    if (!pool.length) {
      shared.terminated = true;
      await markTerminalAtomic(
        jobId,
        "done",
        "Pool exhausted at " +
          fresh.delivered +
          "/" +
          fresh.requestedCount +
          " delivered",
      );
      return;
    }

    const account = pool.shift();
    if (!account) continue;
    const host = pickHostForAccount(account, fresh.hostIds, hostCursor);
    if (!host) {
      await incJobCounters(jobId, { skipped: 1 });
      continue;
    }

    // Delay BEFORE the follow so the first attempt after job creation isn't
    // an instant burst either. Skip the sleep on the very first candidate
    // when nothing has fired yet so the UI reacts responsively.
    const anyFired =
      (fresh.delivered || 0) +
        (fresh.failed || 0) +
        (fresh.alreadyFollowing || 0) >
      0;
    if (anyFired) {
      const gap = pickJitteredDelay(fresh.avgGapMs, fresh.jitter);
      // Only one worker's nextAttemptAt is preserved (each write clobbers)
      // — that's fine, the UI needs a rough ETA, not a per-worker read.
      await incJobCounters(
        jobId,
        {},
        { nextAttemptAt: new Date(Date.now() + gap) },
      );
      await sleep(gap);
      if (Math.random() < (fresh.idlePauseChance || 0)) {
        const pause = pickIdlePause();
        await incJobCounters(
          jobId,
          {},
          { nextAttemptAt: new Date(Date.now() + pause) },
        );
        await sleep(pause);
      }
    }

    // Re-check cancel/terminal after the sleep.
    if (shared.cancelled || shared.terminated) return;
    const midWait = await TwitchFollowJob.findById(jobId).lean();
    if (!midWait) return;
    if (midWait.cancelRequested) {
      shared.cancelled = true;
      await markTerminalAtomic(jobId, "cancelled", "Cancelled by operator");
      return;
    }
    if (["done", "cancelled", "failed"].includes(midWait.status)) {
      shared.terminated = true;
      return;
    }

    const token = readToken(account);
    if (!token) {
      await incJobCounters(jobId, { skipped: 1 });
      await TwitchFollowLog.create({
        jobId,
        channelId: midWait.channelId,
        channelLogin: midWait.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: host.id,
        status: "skipped",
        error: "empty token",
      });
      continue;
    }

    // The follow attempt itself. Handles three failure modes: transport
    // (retry via local once, then skip), twitch/token error (log + count as
    // a failure), success (log + increment delivered).
    const outcome = await attemptFollow({
      token,
      channelId: midWait.channelId,
      host,
    });

    if (outcome.status === "ok") {
      await incJobCounters(
        jobId,
        { delivered: 1 },
        { consecutiveFailures: 0 },
      );
      await TwitchFollowLog.create({
        jobId,
        channelId: midWait.channelId,
        channelLogin: midWait.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: outcome.hostUsed,
        status: "ok",
      });
    } else if (outcome.status === "skip_transport") {
      // Both the account's home host AND local are unreachable — extremely
      // rare, effectively a fleet-wide network outage. Log skipped and move
      // on rather than infinite-looping.
      await incJobCounters(jobId, { skipped: 1 });
      await TwitchFollowLog.create({
        jobId,
        channelId: midWait.channelId,
        channelLogin: midWait.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: host.id,
        status: "skipped",
        error: "transport: " + outcome.error,
      });
    } else {
      await incJobCounters(
        jobId,
        { failed: 1, consecutiveFailures: 1 },
        {
          lastError:
            outcome.code + ": " + String(outcome.error || "").slice(0, 200),
        },
      );
      await TwitchFollowLog.create({
        jobId,
        channelId: midWait.channelId,
        channelLogin: midWait.channelLogin,
        botAccountId: account._id,
        botLogin: account.login,
        host: outcome.hostUsed,
        status: "failed",
        error:
          outcome.code + (outcome.twitchCode ? "/" + outcome.twitchCode : ""),
      });
    }
  }
}

// Attempt a follow, with a single host-fallback: if the primary host (the
// account's home) fails as a transport error, retry the same account through
// local. Local is always reachable from the app server, so this converts a
// Pi outage from "job stalls" to "small extra load on local egress".
async function attemptFollow({ token, channelId, host }) {
  try {
    await twitchFollow.followChannel(token, channelId, { host });
    return { status: "ok", hostUsed: host.id };
  } catch (err) {
    if (err.transportFailed && host.id !== "local") {
      try {
        await twitchFollow.followChannel(token, channelId, {
          host: hosts.resolveHost("local"),
        });
        return { status: "ok", hostUsed: "local" };
      } catch (err2) {
        if (err2.transportFailed) {
          return {
            status: "skip_transport",
            hostUsed: host.id,
            error: err2.message || String(err2),
          };
        }
        return {
          status: "failed",
          hostUsed: "local",
          code: err2.code || "error",
          twitchCode: err2.twitchCode,
          error: err2.message || String(err2),
        };
      }
    }
    if (err.transportFailed) {
      return {
        status: "skip_transport",
        hostUsed: host.id,
        error: err.message || String(err),
      };
    }
    return {
      status: "failed",
      hostUsed: host.id,
      code: err.code || "error",
      twitchCode: err.twitchCode,
      error: err.message || String(err),
    };
  }
}

async function runJob(jobId) {
  const state = activeLoops.get(String(jobId));
  const job = await TwitchFollowJob.findById(jobId);
  if (!job) return;
  if (["cancelled", "done", "failed"].includes(job.status)) return;

  if (!job.startedAt) job.startedAt = new Date();
  job.status = "running";
  await job.save();

  let pool;
  try {
    pool = await buildCandidatePool(job);
  } catch (err) {
    await markTerminalAtomic(jobId, "failed", "Pool build failed: " + err.message);
    return;
  }
  if (!pool.length) {
    await markTerminalAtomic(jobId, "done", "No eligible accounts (pool empty)");
    return;
  }

  const workerCount = Math.max(
    1,
    Math.min(MAX_CONCURRENCY, Number(job.concurrency) || 1),
  );
  const hostCursor = { i: 0 };
  const shared = {
    get cancelled() {
      return state ? state.cancelled : false;
    },
    set cancelled(v) {
      if (state) state.cancelled = !!v;
    },
    terminated: false,
  };

  // Stagger worker starts a little so all N don't tick at the exact same
  // moment and hammer the pool.shift + Mongo at t=0.
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        await sleep(Math.floor(Math.random() * 500) * i);
        return runWorker(jobId, i, pool, hostCursor, shared);
      })(),
    );
  }
  await Promise.all(workers);

  // Last-resort terminal sweep: if every worker exited without one of them
  // reaching the terminal-marking branch (should not happen, but the guard is
  // cheap), stamp the doc as done based on final counters.
  const finalDoc = await TwitchFollowJob.findById(jobId).lean();
  if (finalDoc && finalDoc.status === "running") {
    await markTerminalAtomic(
      jobId,
      "done",
      "Delivered " +
        finalDoc.delivered +
        "/" +
        finalDoc.requestedCount +
        " follows",
    );
  }
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
        await markTerminalAtomic(
          jobId,
          "failed",
          "runner crash: " + (err.message || err),
        );
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
  // The workers also poll job.cancelRequested from Mongo, so a cancel issued
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
  MAX_CONCURRENCY,
};
