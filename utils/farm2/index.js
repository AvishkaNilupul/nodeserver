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

// The evidence window the gate scores: the most recent READINESS_WINDOW_ROWS
// shadow decisions, no older than READINESS_WINDOW_DAYS. It used to be the
// last 25 rows, full stop — and at ~180 decisions per lane per day (before the
// churn fix in lane.js) that window rolled over every few minutes, so a lane
// read ready:true and ready:false minutes apart. Now that a campaign is
// decided once rather than every cycle, 200 rows spans days of evidence and a
// single read is stable; the day bound stops evidence from a previous version
// of the comparison lingering forever on a quiet game.
const READINESS_WINDOW_ROWS = 200;
const READINESS_WINDOW_DAYS = 14;

// How many EXACT-fidelity replayed decisions constitute evidence, when replay
// evidence is required. Higher than MIN_SHADOW_DECISIONS because replay rows
// are cheap — they come from history rather than from waiting — so there is no
// reason to accept a thin sample.
const MIN_REPLAY_DECISIONS = 20;

// `opts.replay` is a report from utils/farm2/replay.js (replayHistory), scoped
// to this lane's game. It is passed IN rather than computed here so that
// readiness stays a fast, read-only check the promotion dialog can call, while
// the replay — which walks months of history — is run deliberately.
//
// `opts.requireReplay` decides whether missing replay evidence BLOCKS or merely
// warns. It defaults to false so this change cannot silently raise the bar on
// the existing gate; the recommendation to flip it is in
// docs/FARM2-VERIFICATION.md and is a decision for review, not for this module.
async function laneReadiness(lane, opts = {}) {
  const FarmJob = require("../../models/FarmJob");
  const classes = require("./decisionClasses");
  const { replay = null, requireReplay = false } = opts;
  const blockers = [];
  const warnings = [];
  // Standing facts about the ENGINE that apply to every lane, kept separate
  // from `warnings` (which are observations about THIS lane's evidence) so that
  // a clean lane still reads as clean. Folding them into warnings would make
  // that list never empty and train an operator to ignore it.
  const caveats = [];

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
    createdAt: { $gte: new Date(Date.now() - READINESS_WINDOW_DAYS * 864e5) },
  })
    .sort({ createdAt: -1 })
    .limit(READINESS_WINDOW_ROWS)
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

  // Split the disagreements by cause. A count on its own cannot distinguish a
  // lane bug from a gate the lane has never had, and those need opposite
  // responses — investigate vs. implement.
  //
  // `disagreementKind` is written only by the current diff. A disagreement
  // WITHOUT it is counted as unclassified rather than assumed benign: absence
  // of the field means "not scored by the current logic", never "passed it".
  const missingGate = diffs.filter((d) => d.disagreementKind === "lane_missing_gate");
  const genuineMismatch = diffs.filter((d) => d.disagreementKind === "class_mismatch");
  const unclassified = diffs.filter((d) => !d.disagreementKind);
  if (missingGate.length) {
    const gates = [...new Set(missingGate.map((d) => d.legacyDecision))].join(", ");
    blockers.push(
      `${missingGate.length} disagreement(s) are the lane having no equivalent of a legacy gate (${gates}) — ` +
        "the lane engine cannot emit those decisions at all, so it will disagree on every such " +
        "campaign until the gate is implemented. This is a missing feature, not a mystery",
    );
  }

  // The vocabulary gap is worth surfacing even on a lane that currently shows
  // no disagreements, because whether it has bitten yet is a property of which
  // campaigns happened to come up, not of the lane being safe.
  if (classes.LEGACY_ONLY_DECISIONS.length) {
    caveats.push(
      `the lane engine cannot emit ${classes.LEGACY_ONLY_DECISIONS.length} of the legacy engine's ` +
        `decisions (${classes.LEGACY_ONLY_DECISIONS.join(", ")}); on campaigns the legacy engine ` +
        "settles with one of those, a live lane would carry on and spend instead",
    );
  }

  // A large account-count gap is worth surfacing even when the action matches —
  // same intent, very different spend, is still worth a look before promoting.
  //
  // SCORED ROWS ONLY. `accountComparable === true` is written by the current
  // comparison when both sides are reuse decisions that counted the same
  // source with no competitor moving between the two decisions
  // (utils/farm2/accountGap.js). Everything else — skip rows whose legacy
  // plannedAccounts is a leftover, dry-run rows, a lane that saw a competitor
  // legacy could not, fresh-spend rows whose budgets differ by design — is
  // reported with its reason and not warned about. On 2026-09-05 this warning
  // held three lanes back on deltas that were all of those things and not one
  // rule difference. A row without the field predates the current comparison
  // and is not scored: absence is never a passing value.
  const accountGap = require("./accountGap");
  const accountRows = compared.filter((d) => d.accountComparable === true);
  const bigGaps = accountRows.filter(
    (d) => Math.abs(Number(d.accountDelta) || 0) >= accountGap.BIG_GAP,
  );
  if (bigGaps.length) {
    const sample = bigGaps
      .slice(0, 3)
      .map((d) => (d.accountDelta > 0 ? "+" : "") + d.accountDelta)
      .join(", ");
    warnings.push(
      `${bigGaps.length} of ${accountRows.length} account-scored reuse decision(s) agreed on the ` +
        `action but reused ${accountGap.BIG_GAP}+ accounts more or fewer than the legacy engine ` +
        `recorded for the same source (lane − legacy: ${sample})`,
    );
  }
  const notScored = {};
  for (const d of compared) {
    if (d.accountComparable === false && d.accountNote) {
      notScored[d.accountNote] = (notScored[d.accountNote] || 0) + 1;
    }
  }
  const notScoredTotal = Object.values(notScored).reduce((s, n) => s + n, 0);
  if (notScoredTotal) {
    caveats.push(
      `account counts not scored on ${notScoredTotal} of ${compared.length} compared decision(s): ` +
        Object.entries(notScored)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") +
        " — the action-class comparison above is unaffected",
    );
  }
  const accountPreGate = compared.filter((d) => d.accountComparable === undefined).length;
  if (accountPreGate) {
    caveats.push(
      `${accountPreGate} compared decision(s) predate the account comparison and are not scored on accounts`,
    );
  }
  const unverifiedSource = accountRows.filter((d) => d.sourceVerified === false).length;
  if (unverifiedSource) {
    caveats.push(
      `${unverifiedSource} account-scored decision(s) compare against a legacy row written before ` +
        "the reuse inputs were recorded — same-source unverified, counted anyway",
    );
  }

  // --- Replay evidence -----------------------------------------------------
  //
  // Shadow comparisons answer "did the two engines agree on the campaigns that
  // happened to come up while both were looking?". Replay answers "does the
  // lane's economics reproduce what the legacy engine actually decided, given
  // the inputs it had?" — over months of history rather than days of waiting.
  // The second is the stronger evidence and the one that scales to 34 lanes.
  let replaySummary = null;
  if (replay && typeof replay === "object") {
    replaySummary = {
      examined: Number(replay.examined) || 0,
      scored: Number(replay.scored) || 0,
      agree: Number(replay.agree) || 0,
      disagree: Number(replay.disagree) || 0,
      unreplayable: Number(replay.unreplayable) || 0,
      inconclusive: Number(replay.inconclusive) || 0,
    };
    if (replaySummary.disagree > 0) {
      const sample = (replay.disagreements || [])
        .slice(0, 3)
        .map((d) => `${d.legacyDecision}: ${d.detail}`)
        .join("; ");
      blockers.push(
        `${replaySummary.disagree} of ${replaySummary.scored} replayed decisions did not reproduce ` +
          `the legacy engine's recorded outcome (${sample})`,
      );
    }
    if (requireReplay && replaySummary.scored < MIN_REPLAY_DECISIONS) {
      blockers.push(
        `only ${replaySummary.scored} replayed decision(s) at full fidelity — need at least ` +
          `${MIN_REPLAY_DECISIONS} (${replaySummary.examined} examined, ${replaySummary.unreplayable} ` +
          `could not be reconstructed, ${replaySummary.inconclusive} inconclusive)`,
      );
    }
  } else if (requireReplay) {
    blockers.push(
      "no replay evidence supplied — run the replay harness for this game before promoting",
    );
  } else {
    caveats.push(
      "no replay evidence — shadow comparisons alone only cover campaigns decided while both " +
        "engines were looking; run scripts/farm2-replay.js for this game to check the economics " +
        "against recorded history",
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    caveats,
    shadowDecisions: decided,
    compared: compared.length,
    stale,
    preGate,
    disagreements: diffs.length,
    disagreementKinds: {
      lane_missing_gate: missingGate.length,
      class_mismatch: genuineMismatch.length,
      unclassified: unclassified.length,
    },
    accountGaps: {
      scored: accountRows.length,
      gaps: bigGaps.length,
      unverifiedSource,
      notScored,
      preGate: accountPreGate,
    },
    replay: replaySummary,
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
  replay: require("./replay"),
  decisionClasses: require("./decisionClasses"),
  TRIAL_GAMES,
  MIN_SHADOW_DECISIONS,
  MIN_REPLAY_DECISIONS,
  READINESS_WINDOW_ROWS,
  READINESS_WINDOW_DAYS,
};
