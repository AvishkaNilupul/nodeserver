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

  // 2. There must be shadow evidence to promote ON. Counted for information
  //    here; the blocking threshold below is applied to COMPARABLE evidence,
  //    because a decision the legacy engine never weighed in on proves nothing.
  const decided = await FarmJob.countDocuments({
    laneKey: lane.gameKey,
    kind: "decide",
    status: "done",
    shadow: true,
  });

  // 3. Disagreement with the legacy engine BLOCKS promotion.
  //
  //    This was originally only a warning, on the reasoning that some
  //    disagreements are legitimate. The trial immediately proved that wrong:
  //    all three lanes reported "agree" while actually planning to spend fresh
  //    pool accounts on games the legacy engine was serving by reusing warm
  //    bots. Promoting on that evidence would have made the system worse, and
  //    a warning would not have stopped it.
  //
  //    A disagreement now means one of the two engines is wrong about a real
  //    game, and that must be understood before the lane takes the game over —
  //    so it is a blocker. `force` still exists for the case where the operator
  //    has looked and decided the lane is the correct one; that is audited.
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
  // Only trust comparisons produced by the CURRENT diff logic.
  //
  // `laneClass` is written by the action-class diff. Rows recorded before it
  // existed were scored by the old intent-based grouping, which reported
  // "farm vs reuse_existing" as agreement — the exact mistake that made this
  // gate necessary. Counting those would let a lane be promoted on evidence
  // from the logic this gate replaced, so a row without a laneClass is not
  // evidence at all.
  const compared = recent
    .map((r) => r.result && r.result.diff)
    .filter(
      (d) =>
        d &&
        d.agree !== null &&
        d.agree !== undefined &&
        d.laneClass &&
        // A stale row compares a fresh lane decision against a legacy decision
        // made hours or days earlier, under conditions that no longer hold. It
        // is not evidence in EITHER direction — see the staleness gate in
        // steps/decide.js.
        //
        // `=== false`, NOT `!d.stale`. A row written before the staleness gate
        // existed has no `stale` field at all, and `!undefined` is true — so the
        // loose test silently readmitted exactly the rows this filter exists to
        // exclude. Same trap as the `laneClass` check above: when a comparison
        // metric changes, absence of the new field means "not scored by the
        // current logic", never "passed it".
        d.stale === false,
    );
  const stale = recent
    .map((r) => r.result && r.result.diff)
    .filter((d) => d && d.stale === true).length;
  // Rows that predate either gate — reported separately so the difference
  // between "recorded" and "comparable" is always explainable.
  const preGate = recent
    .map((r) => r.result && r.result.diff)
    .filter((d) => d && (!d.laneClass || d.stale === undefined)).length;
  if (compared.length < MIN_SHADOW_DECISIONS) {
    blockers.push(
      `only ${compared.length} decision(s) comparable against the legacy engine — need at least ${MIN_SHADOW_DECISIONS}` +
        (decided > compared.length
          ? ` (${decided} recorded; ${stale} compared against a legacy decision too old to be evidence, ${preGate} predate the current comparison logic, the rest have no legacy row yet)`
          : ""),
    );
  }

  const diffs = compared.filter((d) => d.agree === false);
  if (diffs.length) {
    const detail = diffs
      .slice(0, 3)
      .map((d) => `lane ${d.laneDecision} vs legacy ${d.legacyDecision}`)
      .join("; ");
    blockers.push(
      `${diffs.length} of the last ${compared.length} compared decisions disagreed with the legacy engine (${detail})`,
    );
  }

  // A large account-count gap is worth surfacing even when the action matches —
  // same intent, very different spend, is still worth a look before promoting.
  const bigGaps = compared.filter((d) => Math.abs(Number(d.accountDelta) || 0) >= 10);
  if (bigGaps.length) {
    warnings.push(
      `${bigGaps.length} decision(s) agreed on the action but differed by 10+ accounts`,
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    shadowDecisions: decided,
    compared: compared.length,
    stale,
    preGate,
    disagreements: diffs.length,
  };
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
