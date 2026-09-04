// The "Main farm watcher" from the architecture sketch.
//
// Its job is deliberately small: decide WHICH lanes run, compute the budget they
// share, dispatch them with bounded concurrency, and stay out of the way. All
// the per-game work lives in lane.js, and all the economics live in the legacy
// module's exported helpers.
//
// Contrast with the legacy engine, where the equivalent function is ~900 lines
// that also does cleanup, wake/park, research, allocation, execution, reaping,
// recycling, repacking, refilling, re-listing, auto-listing and Telegram. The
// supervisor's entire contract is scheduling.

const settings = require("../settings");
const budget = require("./budget");
const lane = require("./lane");
const jobs = require("./jobs");
const ownership = require("./ownership");

// How many lanes may run at once. The real constraint is not CPU but SSH
// concurrency to the Pi, which the budget cycle's semaphore bounds separately;
// this simply keeps the Mongo working set of one cycle reasonable.
const LANE_CONCURRENCY = 3;

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastSummary: null,
  cycles: 0,
};

// Run a bounded number of async tasks concurrently. Same shape as the legacy
// engine's mapWithConcurrency; kept local so the supervisor has no load-order
// dependency on autoFarmer.
async function mapWithConcurrency(items, concurrency, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// One supervisor cycle.
async function runCycle({ force = false } = {}) {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  const startedAt = Date.now();

  try {
    const FarmLane = require("../../models/FarmLane");
    const af = settings.getAutoFarm();

    // Master switch. When off the engine does nothing at all — and because
    // ownership.killSwitchOn() reads the same flag, every lane's game falls
    // back to the legacy engine in the same instant.
    if (af.farm2Enabled !== true) {
      state.lastSummary = { enabled: false, lanes: 0 };
      state.lastRun = new Date();
      return state.lastSummary;
    }

    // Re-drive anything a restart left stranded, then trim old history.
    const requeued = await jobs.requeueStale().catch(() => 0);
    if (state.cycles % 50 === 0) await jobs.pruneHistory().catch(() => 0);

    // Which lanes are due? A lane that is paused or off is never dispatched;
    // `force` (the UI's "Run now") ignores only the clock, never the mode.
    const now = new Date();
    const due = await FarmLane.find({
      mode: { $in: ["shadow", "live"] },
      state: { $ne: "paused" },
      ...(force ? {} : { $or: [{ nextRunAt: null }, { nextRunAt: { $lte: now } }] }),
    }).lean();

    if (!due.length) {
      state.lastSummary = { enabled: true, lanes: 0, requeued };
      state.lastRun = new Date();
      state.cycles += 1;
      return state.lastSummary;
    }

    // Compute the shared budget ONCE, then seal each lane's allowance. This is
    // the invariant that makes concurrent lanes safe to run: the grants sum to
    // the budget, so no combination of lanes can overspend the pool or the
    // container cap.
    const cycle = await budget.computeCycleBudget(af, {});

    // Live lanes are allocated from the REAL ledger.
    const liveLanes = due.filter((l) => l.mode === "live");
    const shadowLanes = due.filter((l) => l.mode !== "live");
    const perGame = Math.max(0, Number(af.maxPerGame) || 0);
    cycle.allocate(liveLanes.map((l) => ({ key: l.gameKey, want: perGame, weight: 2 })));

    // Shadow lanes are allocated from a NOTIONAL fork with the same totals.
    // Granting them from the real ledger would strand accounts a live lane
    // could use; granting them zero (the original behaviour) made every shadow
    // decision read "trimmed to 0 of N", so the comparison could never validate
    // an allocation amount — only intent. The fork gives realistic numbers
    // while the real budget stays untouched.
    const shadowCycle = shadowLanes.length
      ? cycle.fork("notional (shadow lanes)")
      : null;
    if (shadowCycle) {
      shadowCycle.allocate(
        shadowLanes.map((l) => ({ key: l.gameKey, want: perGame, weight: 1 })),
      );
    }

    // One host-read cache per cycle, shared by every lane. The reuse-first
    // check asks "does this bot's config file still exist?", and several lanes
    // routinely reuse the SAME containers (twitchbotx42 serves Albion, WoT and
    // Black Desert at once), so without this each lane would re-ask the Pi for
    // the same file — over a link measured in seconds of round trip.
    const hostCache = new Map();

    const results = await mapWithConcurrency(due, LANE_CONCURRENCY, (l) =>
      lane.runLane(l, {
        cycle: l.mode === "live" ? cycle : shadowCycle,
        af,
        hostCache,
      }),
    );

    const summary = {
      enabled: true,
      lanes: due.length,
      requeued,
      budget: cycle.summary(),
      results: results.map((r) => ({
        game: r.game,
        mode: r.mode,
        campaigns: r.campaigns,
        decisions: r.decisions.length,
        wouldFarm: r.decisions.filter((d) => d.wouldFarm).length,
        disagreements: r.decisions.filter((d) => d.diff && !d.diff.agree).length,
        audit: r.audit
          ? {
              tasks: r.audit.tasks,
              listable: r.audit.listable,
              blocked: r.audit.blocked,
              unlistedButReady: r.audit.unlistedButReady,
            }
          : null,
        errors: r.errors,
      })),
      durationMs: Date.now() - startedAt,
    };

    state.lastSummary = summary;
    state.lastRun = new Date();
    state.lastError = "";
    state.cycles += 1;
    return summary;
  } catch (e) {
    state.lastError = String(e.message || e);
    state.lastRun = new Date();
    return { error: state.lastError };
  } finally {
    state.running = false;
  }
}

// Cycle cadence. Shorter than the legacy engine's 10 minutes because a cycle is
// cheap: lanes that are not due are skipped by an indexed query, and a lane that
// has nothing to do returns almost immediately.
const TICK_MS = Number(process.env.FARM2_TICK_MS) || 3 * 60 * 1000;
const FIRST_TICK_MS = 60 * 1000;

function start() {
  if (state.started) return;
  state.started = true;
  ownership.setEngineRunning(true);
  const loop = async () => {
    try {
      await runCycle();
    } catch (err) {
      state.lastError = String(err.message || err);
      console.error("farm2 supervisor error:", state.lastError);
    }
    const t = setTimeout(loop, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(loop, FIRST_TICK_MS);
  if (t.unref) t.unref();
}

function stop() {
  state.started = false;
  // Ownership must drop the instant the engine stops, or every live lane's game
  // would be skipped by the legacy engine while nothing was running it.
  ownership.setEngineRunning(false);
}

function status() {
  return {
    started: state.started,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    cycles: state.cycles,
    tickMs: TICK_MS,
    laneConcurrency: LANE_CONCURRENCY,
    killSwitch: ownership.killSwitchOn(),
    ownedKeys: ownership.ownedKeys(),
  };
}

module.exports = { start, stop, status, runCycle, mapWithConcurrency, TICK_MS, _state: state };
