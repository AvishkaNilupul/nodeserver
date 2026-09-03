// Public entry point for the lane engine.
//
// server.js requires exactly this file and calls start(). Everything else in
// utils/farm2/* is internal.
//
// SAFETY POSTURE
//
// The engine is inert until BOTH are true:
//   1. settings.autoFarm.farm2Enabled === true  (master switch, default false)
//   2. a FarmLane row exists with mode "shadow" or "live"
//
// and it only takes a game away from the legacy engine when a lane is "live".
// A fresh deploy therefore changes nothing: no lanes exist, the switch is off,
// and utils/autoFarmer.js keeps running every game exactly as it does today.

const supervisor = require("./supervisor");
const ownership = require("./ownership");
const settings = require("./../settings");

// The trial lanes, chosen from live prod data rather than picked by hand:
//
//   Albion Online  — 17 farm/reuse/probe decisions in 60 days, the highest churn
//                    of any game, so it exercises decide -> verify most often
//                    and produces comparison evidence fastest.
//   World of Tanks — a REUSE-ONLY game (settings.isReuseOnlyGame): it must never
//                    claim a fresh pool account. Deliberately included so the
//                    trial covers a genuinely different branch instead of three
//                    variations of the same happy path.
//   Black Desert   — 12 decisions in 60 days on the normal fresh-spend path, the
//                    control case against World of Tanks.
const TRIAL_GAMES = ["Albion Online", "World of Tanks", "Black Desert"];

// Create the trial lanes if they do not exist. Idempotent, and deliberately
// NON-DESTRUCTIVE: an existing lane's mode is never changed, so re-running this
// can't silently demote a lane an operator has already promoted to live.
async function seedTrialLanes({ games = TRIAL_GAMES, mode = "shadow" } = {}) {
  const FarmLane = require("../../models/FarmLane");
  const out = [];
  for (const game of games) {
    const gameKey = settings.normGameName(game);
    const existing = await FarmLane.findOne({ gameKey }).lean();
    if (existing) {
      out.push({ game, created: false, mode: existing.mode });
      continue;
    }
    await FarmLane.create({
      game,
      gameKey,
      mode,
      state: "idle",
      nextRunAt: new Date(),
      note: "trial lane",
    });
    out.push({ game, created: true, mode });
  }
  return out;
}

// Is this lane safe to promote to live?
//
// Promotion is the one irreversible-feeling action here: it moves a real game
// off the engine that has been farming it successfully for months. The rollout
// plan says "watch the comparison for a few days, then promote", and this is
// that plan expressed as code rather than as a paragraph someone has to
// remember at the moment they are clicking a button.
//
// It is a guard, not a lock — the caller may override with an explicit force,
// which is audited. The point is that going live is a decision made against
// evidence, not by accident.
const MIN_SHADOW_DECISIONS = 3;

async function laneReadiness(lane) {
  const FarmJob = require("../../models/FarmJob");
  const blockers = [];
  const warnings = [];

  // 1. The live path must actually exist on this host. A lane promoted on a
  //    box running an older build would own its game with no way to farm it —
  //    the exact "owned by nobody" outage the ownership guard exists to avoid.
  try {
    const execute = require("./steps/execute");
    const publish = require("./steps/publish");
    if (typeof execute.executeDecision !== "function") blockers.push("execute step missing");
    if (typeof publish.publishPrimary !== "function") blockers.push("publish step missing");
  } catch (e) {
    blockers.push("live-mode steps unavailable: " + e.message);
  }

  // 2. There must be shadow evidence to promote ON.
  const decided = await FarmJob.countDocuments({
    laneKey: lane.gameKey,
    kind: "decide",
    status: "done",
    shadow: true,
  });
  if (decided < MIN_SHADOW_DECISIONS) {
    blockers.push(
      `only ${decided} shadow decision(s) recorded — need at least ${MIN_SHADOW_DECISIONS} before promoting`,
    );
  }

  // 3. Disagreements with the legacy engine are a warning, not a blocker: some
  //    are legitimate (the lane's budget arbiter divides the pool differently),
  //    and judging which is the operator's call. But they must be surfaced at
  //    the moment of promotion, not buried in a table.
  const recent = await FarmJob.find({
    laneKey: lane.gameKey,
    kind: "decide",
    status: "done",
    shadow: true,
  })
    .sort({ createdAt: -1 })
    .limit(25)
    .select("result")
    .lean();
  const diffs = recent
    .map((r) => r.result && r.result.diff)
    .filter((d) => d && d.agree === false);
  if (diffs.length) {
    warnings.push(
      `${diffs.length} of the last ${recent.length} decisions disagreed with the legacy engine`,
    );
  }

  return { ready: blockers.length === 0, blockers, warnings, shadowDecisions: decided };
}

function start() {
  supervisor.start();
}

function stop() {
  supervisor.stop();
}

function status() {
  return supervisor.status();
}

module.exports = {
  start,
  stop,
  status,
  runCycle: supervisor.runCycle,
  seedTrialLanes,
  laneReadiness,
  ownership,
  TRIAL_GAMES,
  MIN_SHADOW_DECISIONS,
};
