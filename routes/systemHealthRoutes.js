// ---------------------------------------------------------------------------
// SYSTEM HEALTH API (superadmin) — docs/SYSTEM-HEALTH-CONTRACT.md, PART B.
//
// Backs public/system-health.html: "is everything working?" answered without
// anyone re-checking by hand. It exists because two paid "Automatic Farming"
// orders were lost to failures nothing was watching — order e69b19d3 and one
// after it — and the 8 live gameflip/ggsel offers measured on 2026-09-09 had
// been unsellable (0 accounts holding the full DropSet) for an unknown length
// of time.
//
// Two rules this file enforces, both of which are the whole point:
//
//  * READ-ONLY. The checks live in utils/systemHealth.js and touch nothing.
//    The single write in the entire health system is the run record stored
//    below. Nothing here publishes, delists, reprices, provisions or writes
//    settings — a health check that mutates is a health check nobody dares run.
//
//  * A forced run cannot be used as a hammer. Refreshing the page must not
//    re-poll the marketplaces: a run inside the cooldown returns the previous
//    one and SAYS SO in the payload, and two concurrent forces share one run.
//    Hammering a marketplace from a health page would be the same class of
//    mistake as the mass-parallel session that is suspected of disturbing a
//    live order.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const SystemHealthRun = require("../models/SystemHealthRun");

const router = express.Router();

// A forced run may re-poll live marketplaces, so it is rate-limited to one per
// minute. The page's own refresh button, a phone waking up and the hourly
// scheduler all land in the same window; only the first of them costs anything.
const FORCE_COOLDOWN_MS = 60 * 1000;

// Shared promise for the run currently executing. Without it, two clicks a
// second apart would both pass the cooldown test (the first run has not been
// stored yet, so there is nothing for the second to see) and fire two parallel
// sweeps at the marketplaces — the exact fan-out the contract forbids.
let inFlight = null;
// Epoch ms of the last run STARTED in this process. Only a hint: the stored
// runs are the real cooldown source, because a restart resets this to 0 and
// the hourly scheduler's runs count against the cooldown too.
let lastRunStartedAt = 0;

// utils/systemHealth.js is required lazily, the same way unclaimedAutoRoutes
// loads its v3 helpers: if that module is missing or throws at load time this
// router still mounts, the admin nav still works, and only these two endpoints
// answer 503 with the real load error instead of taking the whole server down
// with them at boot.
function optionalModule(name) {
  try {
    return { mod: require(name) };
  } catch (err) {
    return { error: err };
  }
}

function moduleUnavailable(res, name, err) {
  return res.status(503).json({
    success: false,
    code: "module_unavailable",
    module: name,
    message:
      name + " is not available: " + (err && err.message ? err.message : String(err)),
  });
}

function truthy(v) {
  return v === 1 || v === "1" || v === "true" || v === "yes" || v === "on" || v === true;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Roll-up fallback. runAll() returns counts itself, but a run whose counts came
// back missing or malformed must still be storable — losing the whole run
// because a summary field was absent would throw away the evidence. Anything
// that is not one of the four frozen statuses is counted as "unknown", never as
// "ok": the contract's rule is that we never fabricate certainty.
function countStatuses(checks) {
  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const c of Array.isArray(checks) ? checks : []) {
    const s = c && c.status;
    if (s === "ok" || s === "warn" || s === "fail") counts[s] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function validCounts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of ["ok", "warn", "fail", "unknown"]) {
    const n = Number(raw[k]);
    if (!Number.isFinite(n) || n < 0) return null;
    out[k] = Math.floor(n);
  }
  return out;
}

// Coerce whatever runAll() handed back into the stored shape, preferring the
// runner's own numbers and falling back to the ones measured here. The route
// times the call itself so a runner that forgot `ms` still produces a row with
// a real duration rather than a zero that would read as "instant".
function normalizeRun(raw, fallbackStartedAt, fallbackMs) {
  const run = raw && typeof raw === "object" ? raw : {};
  const ms = Number(run.ms);
  return {
    startedAt: toDate(run.startedAt) || new Date(fallbackStartedAt),
    ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : fallbackMs,
    counts: validCounts(run.counts) || countStatuses(run.checks),
    checks: Array.isArray(run.checks) ? run.checks : [],
  };
}

function latestStored() {
  return SystemHealthRun.find({}, "startedAt ms counts checks")
    .sort({ startedAt: -1 })
    .limit(1)
    .lean()
    .then((rows) => rows[0] || null);
}

// Upsert on startedAt rather than insert: the hourly scheduler and this route
// both have a reason to persist a run, and a run that got stored twice would
// show up on the history strip as two hours of health that never happened.
// A store failure is logged and swallowed — the operator asked what the system
// looks like, and a write problem must not withhold the answer they already
// paid the marketplace calls for.
async function storeRun(run) {
  try {
    await SystemHealthRun.updateOne(
      { startedAt: run.startedAt },
      { $setOnInsert: { ms: run.ms, counts: run.counts, checks: run.checks } },
      { upsert: true },
    );
  } catch (err) {
    console.error("system health store error:", err.message);
  }
}

// Always resolves to { run, error } — never rejects, so a caller sharing the
// in-flight promise cannot be thrown into by someone else's failed run.
function startRun(health) {
  const startedAt = Date.now();
  // Claimed BEFORE the await: a run that dies mid-flight must still hold the
  // cooldown, or a permanently broken runAll() would turn an impatient refresh
  // into an unthrottled retry loop against the marketplaces.
  lastRunStartedAt = startedAt;
  inFlight = (async () => {
    try {
      const raw = await health.runAll();
      const run = normalizeRun(raw, startedAt, Date.now() - startedAt);
      await storeRun(run);
      return { run, error: null };
    } catch (err) {
      console.error("system health run error:", err.message);
      return { run: null, error: err };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// How long until a forced run is allowed again, counting the newest run from
// EITHER source. Clamped to the cooldown so a stored run with a future
// timestamp (clock skew on a restore) cannot lock refreshing out for hours.
function cooldownRemaining(latest) {
  const storedAt = latest ? toDate(latest.startedAt) : null;
  const newest = Math.max(lastRunStartedAt, storedAt ? storedAt.getTime() : 0);
  if (!newest) return 0;
  return Math.min(FORCE_COOLDOWN_MS, Math.max(0, FORCE_COOLDOWN_MS - (Date.now() - newest)));
}

function runPayload(run) {
  if (!run) return null;
  return {
    startedAt: run.startedAt,
    ms: run.ms,
    counts: validCounts(run.counts) || countStatuses(run.checks),
    checks: Array.isArray(run.checks) ? run.checks : [],
  };
}

function ageMs(run) {
  const at = run ? toDate(run.startedAt) : null;
  return at ? Math.max(0, Date.now() - at.getTime()) : null;
}

// The latest stored run; ?run=1 forces a fresh one.
//
// `success: true` means "here is a health run", NOT "everything is healthy" —
// the statuses inside it say that. So a forced run that failed outright still
// answers 200 with the last stored run plus `runError`, because losing the
// whole page over a failed refresh hides the very state the operator came to
// look at. Only when there is nothing at all to show does this 500.
router.get("/api/system-health", requireSuperadmin, enforce2fa, async (req, res) => {
  try {
    const force = truthy(req.query.run);
    const latest = await latestStored();

    if (!force) {
      return res.json({
        success: true,
        run: runPayload(latest),
        fresh: false,
        reused: false,
        reusedReason: null,
        ageMs: ageMs(latest),
        cooldownMs: FORCE_COOLDOWN_MS,
        retryAfterMs: cooldownRemaining(latest),
        message: latest ? null : "No health run has been stored yet.",
      });
    }

    const { mod: health, error } = optionalModule("../utils/systemHealth");
    if (!health || typeof health.runAll !== "function") {
      return moduleUnavailable(
        res,
        "utils/systemHealth",
        error || new Error("runAll() is not exported"),
      );
    }

    // A run is already going: join it rather than starting a second one.
    if (inFlight) {
      const result = await inFlight;
      const run = result.run || latest;
      return res.json({
        success: !!run,
        run: runPayload(run),
        fresh: !!result.run,
        reused: !result.run,
        reusedReason: result.run ? null : "run_in_progress",
        ageMs: ageMs(run),
        cooldownMs: FORCE_COOLDOWN_MS,
        retryAfterMs: cooldownRemaining(run || latest),
        runError: result.error ? result.error.message : undefined,
        message: result.run
          ? "Joined the run already in progress."
          : "The run already in progress failed.",
      });
    }

    const remaining = cooldownRemaining(latest);
    if (remaining > 0) {
      return res.json({
        success: !!latest,
        run: runPayload(latest),
        fresh: false,
        reused: true,
        reusedReason: "rate_limited",
        ageMs: ageMs(latest),
        cooldownMs: FORCE_COOLDOWN_MS,
        retryAfterMs: remaining,
        message:
          "A run finished " +
          Math.round((FORCE_COOLDOWN_MS - remaining) / 1000) +
          "s ago; showing it instead of re-checking. Fresh run available in " +
          Math.ceil(remaining / 1000) +
          "s.",
      });
    }

    const result = await startRun(health);
    const run = result.run || latest;
    if (!run) {
      return res.status(500).json({
        success: false,
        run: null,
        fresh: false,
        message: result.error ? result.error.message : "Health run produced nothing",
      });
    }
    return res.json({
      success: true,
      run: runPayload(run),
      fresh: !!result.run,
      reused: !result.run,
      reusedReason: result.run ? null : "run_failed",
      ageMs: ageMs(run),
      cooldownMs: FORCE_COOLDOWN_MS,
      retryAfterMs: cooldownRemaining(run),
      runError: result.error ? result.error.message : undefined,
      message: result.run
        ? null
        : "The fresh run failed; showing the last stored run instead.",
    });
  } catch (err) {
    console.error("system health error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Recent runs, newest first — the history strip. Summary ONLY: the projection
// deliberately omits `checks`, because prod Mongo is a bytes-bound Atlas shared
// tier where the cost of a query is what it returns, and 200 runs x ~11 checks
// (each carrying up to 20 offending rows) is megabytes to render a row of
// coloured ticks. Never widen this projection to include checks; fetch the one
// run instead.
router.get("/api/system-health/history", requireSuperadmin, enforce2fa, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const runs = await SystemHealthRun.find({}, "startedAt ms counts")
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, limit, runs });
  } catch (err) {
    console.error("system health history error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// The hourly run. Reuses `startRun` rather than calling runAll directly so the
// scheduled pass and a forced refresh share one in-flight promise, one cooldown
// and one persistence path — two independent runners would double the live
// marketplace reads for nothing.
//
// The interval timer IS unref'd (unlike the per-check timeout inside
// utils/systemHealth.js, which must hold the loop open while a check is in
// flight): a pending health tick should never be the reason a CLI process
// refuses to exit. Same setTimeout-chain shape every other loop here uses.
const HOURLY_MS = 60 * 60 * 1000;
// Not on boot: the marketplaces and the Pi are busiest while every other loop
// is doing its own first pass, and a health check is the last thing that should
// be competing with them.
const FIRST_DELAY_MS = 5 * 60 * 1000;
let scheduled = false;

function start() {
  if (scheduled) return;
  scheduled = true;
  const tick = async () => {
    try {
      const { error } = await startRun(require("../utils/systemHealth"));
      if (error) console.error("system health hourly run failed:", error.message);
    } catch (e) {
      console.error("system health hourly tick error:", e.message);
    } finally {
      const t = setTimeout(tick, HOURLY_MS);
      if (t.unref) t.unref();
    }
  };
  const t = setTimeout(tick, FIRST_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = router;
module.exports.start = start;
