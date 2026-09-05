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
const notify = require("./notify");

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

// MAIN-ENGINE MODE: a live lane for every game that has a live campaign.
//
// When autoFarm.farm2Main is on, the lane engine is THE engine: no game may be
// left for the legacy decision path. So every cycle, any game with a live,
// claimable campaign and no FarmLane row gets one — in mode "live", because
// in main mode there is nothing to shadow against. Existing rows are never
// touched: an operator who set a lane to shadow or off keeps that choice.
// No-claim games belong to the standalone no-claim system, as everywhere else.
// Each creation is audited. Returns the games created.
async function ensureLanesForLiveGames({ audit = true } = {}) {
  const FarmLane = require("../../models/FarmLane");
  const TwitchCampaign = require("../../models/TwitchCampaign");
  const now = new Date();
  const live = await TwitchCampaign.find({
    active: true,
    status: "ACTIVE",
    $or: [{ endAt: null }, { endAt: { $gt: now } }],
  })
    .select("game")
    .lean();
  const wanted = new Map();
  for (const c of live) {
    if (!c.game || settings.isNoClaimGame(c.game)) continue;
    const key = settings.normGameName(c.game);
    if (key && !wanted.has(key)) wanted.set(key, c.game);
  }
  if (!wanted.size) return [];
  const existing = new Set(
    (await FarmLane.find({ gameKey: { $in: [...wanted.keys()] } }).select("gameKey").lean()).map(
      (l) => l.gameKey,
    ),
  );
  const created = [];
  for (const [key, game] of wanted) {
    if (existing.has(key)) continue;
    try {
      await FarmLane.create({
        game,
        gameKey: key,
        mode: "live",
        state: "idle",
        nextRunAt: now,
        note: "auto-created: main engine",
      });
      created.push(game);
    } catch (e) {
      // A concurrent creation (the route, another cycle) is not a failure.
      if (!(e && e.code === 11000)) throw e;
    }
  }
  if (created.length) {
    ownership.invalidate();
    if (audit) {
      try {
        require("../systemLog").logEvent({
          category: "farm2",
          action: "lanes_auto_created",
          actor: "farm2/supervisor",
          subject: "main engine",
          detail: created.join(", "),
          meta: { games: created },
        });
      } catch {
        /* auditing must never block the cycle */
      }
    }
  }
  return created;
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

    // Main engine: every live game gets a live lane before dispatch, so a
    // campaign that appeared since the last cycle is decided here, not by the
    // legacy path. Failure to create is logged on the cycle, never fatal —
    // the legacy engine covers an unowned game exactly as before.
    let autoCreated = [];
    if (af.farm2Main === true) {
      try {
        autoCreated = await ensureLanesForLiveGames();
      } catch (e) {
        state.lastError = "auto-lanes: " + String(e.message || e);
      }
    }

    // Which lanes are due? A lane that is paused or off is never dispatched;
    // `force` (the UI's "Run now") ignores only the clock, never the mode.
    const now = new Date();
    const due = await FarmLane.find({
      mode: { $in: ["shadow", "live"] },
      state: { $ne: "paused" },
      ...(force ? {} : { $or: [{ nextRunAt: null }, { nextRunAt: { $lte: now } }] }),
    }).lean();

    if (!due.length) {
      state.lastSummary = { enabled: true, main: af.farm2Main === true, lanes: 0, requeued, autoCreated };
      state.lastRun = new Date();
      state.cycles += 1;
      return state.lastSummary;
    }

    // Compute the shared budget ONCE. Lanes draw from it ON DEMAND
    // (budget.js spendAccounts): the sum of what they take can never exceed
    // the budget, so no combination of lanes can overspend the pool — and a
    // lane that reuses warm bots (most of them, most cycles) takes nothing,
    // leaving the whole pool for the one that needs fresh accounts. That is
    // how the legacy tick behaves too: it fair-shares among the campaigns that
    // need accounts THIS tick, not among every game it knows. Pre-allocating
    // equal shares to every live lane — the earlier design — would have
    // trimmed a real fresh farm to a few accounts once every game had a lane.
    const cycle = await budget.computeCycleBudget(af, {});
    const shadowLanes = due.filter((l) => l.mode !== "live");

    // Shadow lanes draw from a NOTIONAL fork with the same totals, so their
    // numbers are realistic without competing with live lanes for real
    // accounts. The SSH semaphore is shared: host concurrency is physical.
    const shadowCycle = shadowLanes.length ? cycle.fork("notional (shadow lanes)") : null;

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

    // A lane that PAUSED this cycle has released its game to the legacy
    // engine (ownership.js excludes paused lanes). Drop the ownership cache
    // now rather than in 30s, and tell the operator: a paused lane is the one
    // state that needs a human.
    const paused = results.filter((r) => r && r.paused);
    if (paused.length) {
      ownership.invalidate();
      await notify.telegram(
        "⚠️ Auto-farm lane PAUSED — " +
          paused.map((r) => r.game).join(", ") +
          "\n" +
          paused.map((r) => r.game + ": " + (r.errors || []).slice(-1)[0]).join("\n") +
          "\nThe legacy engine covers the game until the lane is re-armed from the Auto farm engine page.",
      );
    }

    const summary = {
      enabled: true,
      main: af.farm2Main === true,
      lanes: due.length,
      requeued,
      autoCreated,
      paused: paused.map((r) => r.game),
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

module.exports = {
  start,
  stop,
  status,
  runCycle,
  ensureLanesForLiveGames,
  mapWithConcurrency,
  TICK_MS,
  _state: state,
};
