// Durable job helpers for the lane engine.
//
// Everything the engine does is a FarmJob row, so this module is the only place
// that writes job state. Keeping it in one file means the retry policy, the
// backoff curve and the log bound are defined exactly once.

const FarmJob = require("../../models/FarmJob");

// Keep a job's inline log bounded. A publish job that retries against a
// rate-limited marketplace for a week would otherwise grow without limit inside
// a single document.
const MAX_LOG_ENTRIES = 60;

// Exponential backoff with a ceiling, so a permanently broken job settles into
// hourly retries instead of either hot-looping or giving up silently.
const BACKOFF_MS = [
  60 * 1000, //  1 min
  5 * 60 * 1000, //  5 min
  15 * 60 * 1000, // 15 min
  30 * 60 * 1000, // 30 min
  60 * 60 * 1000, //  1 hour
];

function backoffFor(attempt) {
  const i = Math.min(Math.max(0, attempt - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i];
}

// Create a job unless an identical one is already in flight.
//
// Deduplication is done with an atomic upsert rather than a create-and-catch.
// The difference matters: create-and-catch relies on the partial unique index
// being BUILT, and Mongoose builds indexes in the background after connecting,
// so on a fresh database (or the first boot after this collection is added)
// there is a window where duplicate rows are inserted happily. That window is
// not theoretical — it produced two rows for one campaign in testing, and the
// duplicate was then picked up by a second claimNext, so one campaign was
// decided twice.
//
// findOneAndUpdate + upsert is atomic at the server regardless of index state,
// which makes correctness independent of index-build timing. The unique index
// stays as a second line of defence for the genuine simultaneous-write race.
async function enqueue({
  lane,
  laneKey,
  kind,
  market = "",
  campaignId = "",
  taskId = null,
  payload = {},
  shadow = false,
  maxAttempts = 5,
  runAt = null,
}) {
  // Identity of an in-flight job. Anything terminal (done/failed/skipped/
  // cancelled) is deliberately NOT matched, so a campaign can be re-decided on
  // a later cycle without being blocked by its own history.
  const identity = {
    laneKey,
    kind,
    campaignId,
    market,
    status: { $in: ["queued", "running"] },
  };
  const onInsert = {
    lane,
    laneKey,
    kind,
    market,
    campaignId,
    taskId,
    payload,
    shadow: !!shadow,
    maxAttempts,
    status: "queued",
    nextAttemptAt: runAt || new Date(),
  };
  try {
    return await FarmJob.findOneAndUpdate(
      identity,
      { $setOnInsert: onInsert },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    // Two writers upserting at the same instant: one wins, the other gets a
    // duplicate-key error from the unique index. That is the expected outcome
    // of the race, not a failure — resolve to the row the winner created.
    if (err && err.code === 11000) {
      return FarmJob.findOne(identity);
    }
    throw err;
  }
}

// Atomically take ownership of a due job. findOneAndUpdate is what makes this
// safe if the engine is ever run in more than one process: only one caller can
// transition a given row out of "queued".
async function claimNext(filter = {}) {
  return FarmJob.findOneAndUpdate(
    {
      status: "queued",
      nextAttemptAt: { $lte: new Date() },
      ...filter,
    },
    {
      $set: { status: "running", startedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1 } },
  );
}

// Claim every due job for one lane, up to a cap. Returns them in queue order.
//
// `filter` narrows which kinds are drained. The lane runner uses it to take
// only execute/publish/verify work: "decide" jobs are created, claimed and
// finished synchronously in the lane's decide phase, so a drain that also
// claimed them could pick up a decide job that had been requeued after a
// failure and then have no handler for it.
async function claimDueForLane(laneKey, limit = 25, filter = {}) {
  const out = [];
  for (let i = 0; i < limit; i += 1) {
    const job = await claimNext({ laneKey, ...filter });
    if (!job) break;
    out.push(job);
  }
  return out;
}

async function appendLog(job, msg, level = "info") {
  if (!job) return;
  const entry = { at: new Date(), level, msg: String(msg || "").slice(0, 500) };
  await FarmJob.updateOne(
    { _id: job._id },
    { $push: { log: { $each: [entry], $slice: -MAX_LOG_ENTRIES } } },
  ).catch(() => {});
}

async function finish(job, result = {}, { status = "done" } = {}) {
  if (!job) return;
  const finishedAt = new Date();
  const startedAt = job.startedAt ? new Date(job.startedAt) : finishedAt;
  await FarmJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status,
        result: result || {},
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        error: "",
      },
    },
  );
}

// Record a failure. Retries while attempts remain, then parks the job as
// "failed" — visible in the tab with its full log rather than vanishing.
async function fail(job, err) {
  if (!job) return { retrying: false };
  const message = String((err && err.message) || err || "unknown error").slice(0, 800);
  const attempts = Number(job.attempts) || 1;
  const maxAttempts = Number(job.maxAttempts) || 5;
  const finishedAt = new Date();
  const startedAt = job.startedAt ? new Date(job.startedAt) : finishedAt;

  if (attempts < maxAttempts) {
    const delay = backoffFor(attempts);
    await FarmJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "queued",
          error: message,
          errorAt: finishedAt,
          nextAttemptAt: new Date(Date.now() + delay),
        },
        $push: {
          log: {
            $each: [
              {
                at: finishedAt,
                level: "warn",
                msg: `attempt ${attempts}/${maxAttempts} failed: ${message} — retrying in ${Math.round(delay / 1000)}s`,
              },
            ],
            $slice: -MAX_LOG_ENTRIES,
          },
        },
      },
    );
    return { retrying: true, delay };
  }

  await FarmJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        error: message,
        errorAt: finishedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
      },
      $push: {
        log: {
          $each: [
            {
              at: finishedAt,
              level: "error",
              msg: `gave up after ${attempts} attempt(s): ${message}`,
            },
          ],
          $slice: -MAX_LOG_ENTRIES,
        },
      },
    },
  );
  return { retrying: false };
}

// Re-queue jobs left in "running" by a crash or restart.
//
// Without this, a process death mid-job strands the row forever — precisely the
// legacy engine's failure mode, where in-memory state simply disappeared. Only
// rows older than the grace window are touched so a genuinely in-flight job in
// another worker is never yanked out from under it.
async function requeueStale({ olderThanMs = 15 * 60 * 1000 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await FarmJob.updateMany(
    { status: "running", startedAt: { $lt: cutoff } },
    {
      $set: { status: "queued", nextAttemptAt: new Date() },
      $push: {
        log: {
          $each: [
            {
              at: new Date(),
              level: "warn",
              msg: "requeued after restart (was left running)",
            },
          ],
          $slice: -MAX_LOG_ENTRIES,
        },
      },
    },
  );
  return res.modifiedCount || 0;
}

// Drop old terminal rows so the collection stays small. History is valuable but
// unbounded history is a liability on an Atlas shared tier, where the binding
// constraint is bytes returned rather than query time.
async function pruneHistory({ olderThanDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 864e5);
  const res = await FarmJob.deleteMany({
    status: { $in: ["done", "skipped", "cancelled"] },
    finishedAt: { $lt: cutoff },
  });
  return res.deletedCount || 0;
}

module.exports = {
  enqueue,
  claimNext,
  claimDueForLane,
  appendLog,
  finish,
  fail,
  requeueStale,
  pruneHistory,
  backoffFor,
  MAX_LOG_ENTRIES,
};
