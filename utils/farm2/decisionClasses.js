// The decision vocabulary of the two engines, and the action classes the
// shadow comparison is scored on.
//
// WHY THIS FILE EXISTS
//
// The action-class mapping was written out twice inside steps/decide.js — once
// as `classOf` for the stale branch and once as `actionClass` for the live
// branch — with no shared definition. Two copies of the rule that decides
// whether a lane may take over a real game is exactly the drift risk this
// engine exists to avoid: adding a decision to one copy and not the other
// produces a comparison that silently scores it as `skip`, which reads as
// "agrees with a lane that is doing nothing".
//
// It also gives the comparison something it did not have before: an explicit
// record of WHICH decisions each engine is capable of emitting. That turns a
// whole category of disagreement from noise into a named, actionable finding —
// see LEGACY_ONLY_DECISIONS below.

// Everything utils/autoFarmer.js can record. Kept in sync with the enum on
// models/AutoFarmTask.js — that enum is the authority; this is the classifier.
const LEGACY_DECISIONS = Object.freeze([
  "farm",
  "probe",
  "reuse_existing",
  "skip_low_demand",
  "skip_probe_budget",
  "skip_ends_soon",
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered",
  "skip_reuse_only",
]);

// Everything utils/farm2/steps/decide.js can return.
//
// This used to be a STRICT SUBSET of the above — five of the eleven. The lane
// implemented the sellability stage and reuse-first and nothing downstream, so
// on any campaign the legacy engine settled with the host, time, coverage,
// pool-floor, capacity or reuse-only gate, a live lane would have carried on
// and spent. Nobody had observed it because the shadow comparison was broken
// (zero comparable pairs, zero chances to notice).
//
// decide.js now runs all six gates, in the legacy order, from the legacy
// engine's own exported helpers. This list is kept as a SEPARATE declaration
// rather than aliased to LEGACY_DECISIONS on purpose: the moment a decision is
// added to the legacy engine and not to the lane, the two diverge again, the
// gap reappears in LEGACY_ONLY_DECISIONS, and the comparison starts labelling
// those disagreements `lane_missing_gate` instead of burying them. The machinery
// below is the tripwire for that; it should currently have nothing to report.
const LANE_DECISIONS = Object.freeze([
  "farm",
  "probe",
  "reuse_existing",
  "skip_low_demand",
  "skip_probe_budget",
  "skip_ends_soon",
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered",
  "skip_reuse_only",
]);

// The gates the lane cannot express. Expected to be EMPTY; a test asserts it.
const LEGACY_ONLY_DECISIONS = Object.freeze(
  LEGACY_DECISIONS.filter((d) => !LANE_DECISIONS.includes(d)),
);

// Decisions grouped by the ACTION they cause, not by their string.
//
// An earlier version lumped farm, probe and reuse_existing together as one
// "act" class, and that hid the trial's first real finding: the lane said
// `farm` (claim fresh pool accounts, burn a container slot) while the legacy
// engine said `reuse_existing` (restart warm bots, spend nothing), and the
// comparison called it agreement. Spending and reusing are different actions
// with different costs, so they are different classes.
//
// Written as an explicit table rather than an if-chain with a default, so that
// adding a decision to models/AutoFarmTask.js without classifying it here fails
// LOUDLY (actionClass returns "unknown", which is not comparable) instead of
// quietly landing in `skip`. A new spend-class decision defaulting to `skip`
// would read as "agrees with a lane that is doing nothing" — the same
// absence-is-not-a-passing-value trap that has already bitten this comparison
// twice.
const ACTION_CLASS = Object.freeze({
  farm: "spend",
  probe: "spend",
  reuse_existing: "reuse",
  skip_low_demand: "skip",
  skip_probe_budget: "skip",
  skip_ends_soon: "skip",
  skip_no_accounts: "skip",
  skip_no_capacity: "skip",
  skip_host_offline: "skip",
  skip_already_covered: "skip",
  skip_reuse_only: "skip",
});

// "unknown" for anything unclassified — never a silent fallback to "skip".
function actionClass(decision) {
  return ACTION_CLASS[decision] || "unknown";
}

function laneCanEmit(decision) {
  return LANE_DECISIONS.includes(decision);
}

// Which pipeline stage settles a decision.
//
// This matters for replay. The sellability stage (demandAllocation) is a pure
// function of research + own sales + settings, all of which are recoverable for
// a past moment. Everything downstream of it depends on state nobody snapshots
// — pool depth, container capacity, host reachability, archive coverage — and
// is therefore NOT replayable. Scoring a replay against a downstream decision
// would be measuring the reconstruction's blind spots, not the engine.
const DEMAND_STAGE_DECISIONS = Object.freeze([
  "probe",
  "skip_low_demand",
  "skip_probe_budget",
]);

// Decisions that prove the demand stage PASSED (it wanted to farm) but that
// were then settled by a later gate.
const DOWNSTREAM_DECISIONS = Object.freeze([
  "farm",
  "reuse_existing",
  "skip_ends_soon",
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered",
  "skip_reuse_only",
]);

function isDemandStageDecision(decision) {
  return DEMAND_STAGE_DECISIONS.includes(decision);
}

// The two decisions for which AutoFarmTask.demandScore is NOT the raw market
// score.
//
// utils/autoFarmer.js records the sellability skip with
// `demandScore: alloc.demand` — the BLENDED effective demand (market score plus
// the internal-sales boost) — and hardcodes `hadResearch: true` on that path
// even when there was no research document at all. Every other decision,
// including `probe`, is recorded further down with the raw
// `research ? research.demandScore : null` and a truthful `hadResearch`.
//
// So the same two fields mean different things depending on the decision beside
// them: an input on most rows, an OUTPUT on these two, and a constant on one.
// Anything reading AutoFarmTask.demandScore — a replay, a dashboard, an alert —
// has to branch on this or it is silently comparing two different quantities.
const EFFECTIVE_DEMAND_DECISIONS = Object.freeze(["skip_low_demand", "skip_probe_budget"]);

function recordsEffectiveDemand(decision) {
  return EFFECTIVE_DEMAND_DECISIONS.includes(decision);
}

// Which decision-input fields legacy record() actually WRITES, per path.
//
// record() is a $set upsert. A field the path does not name is left as the
// schema default on a fresh row, or as whatever an EARLIER decision on the same
// (game, campaignId) row wrote — a retryable skip re-decided into a reuse, say.
// In neither case is it the value at decision time, so anything reading these
// rows must know which fields the path in question really wrote:
//
//   internalSales    written on every path EXCEPT reuse_existing (both the live
//                    and dry-run record calls) and skip_host_offline.
//   targetAccounts   written ONLY on farm/probe (the `wanted` tier target).
//
// skip_reuse_only is a later updateOne on a row record() had just written as
// farm/probe in the same tick, touching neither field, so both are still the
// decision-time values there.
//
// Found the expensive way (prod, 2026-09-04): 15 Black Desert reuse_existing
// rows carried internalSales 0 because that path never writes it, SaleSignal
// held 13 sales, the replay trusted the 0, skipped at the sellability gate and
// called every one a disagreement — while the live shadow lane, reading
// SaleSignal, agreed with legacy each time.
const OMITS_INTERNAL_SALES = Object.freeze(["reuse_existing", "skip_host_offline"]);
const WRITES_TARGET_ACCOUNTS = Object.freeze(["farm", "probe", "skip_reuse_only"]);

function recordsInternalSales(decision) {
  return LEGACY_DECISIONS.includes(decision) && !OMITS_INTERNAL_SALES.includes(decision);
}

function recordsTargetAccounts(decision) {
  return WRITES_TARGET_ACCOUNTS.includes(decision);
}

// Why did these two decisions differ? The taxonomy is the actionable part: an
// operator staring at "12 disagreements" cannot tell a lane bug from a missing
// feature from an expected budget effect, and those need three different
// responses.
//
//   agree             — same action class, nothing to explain
//   lane_missing_gate — the legacy engine used a gate the lane does not
//                       implement at all. Deterministic, not a mystery: the
//                       lane WILL disagree here every time until the gate is
//                       built. The most actionable output this produces.
//   class_mismatch    — both engines could have produced either answer and they
//                       differed. This is the one that needs a human.
//   not_comparable    — one side is missing or unclassified.
function classifyDisagreement(laneDecision, legacyDecision) {
  const lc = actionClass(laneDecision);
  const gc = actionClass(legacyDecision);
  if (lc === "unknown" || gc === "unknown") {
    return {
      kind: "not_comparable",
      laneClass: lc,
      legacyClass: gc,
      note: "at least one decision is not in the action-class table",
    };
  }
  if (lc === gc) return { kind: "agree", laneClass: lc, legacyClass: gc };
  if (!laneCanEmit(legacyDecision)) {
    return {
      kind: "lane_missing_gate",
      laneClass: lc,
      legacyClass: gc,
      note:
        `the legacy engine settled this with "${legacyDecision}", which the lane ` +
        "engine cannot currently emit — the lane has no such gate, so it will " +
        "disagree here on every campaign until one is implemented",
    };
  }
  return {
    kind: "class_mismatch",
    laneClass: lc,
    legacyClass: gc,
    note: "both engines can emit both answers, and they differed",
  };
}

module.exports = {
  LEGACY_DECISIONS,
  LANE_DECISIONS,
  LEGACY_ONLY_DECISIONS,
  ACTION_CLASS,
  DEMAND_STAGE_DECISIONS,
  DOWNSTREAM_DECISIONS,
  EFFECTIVE_DEMAND_DECISIONS,
  OMITS_INTERNAL_SALES,
  WRITES_TARGET_ACCOUNTS,
  actionClass,
  laneCanEmit,
  isDemandStageDecision,
  recordsEffectiveDemand,
  recordsInternalSales,
  recordsTargetAccounts,
  classifyDisagreement,
};
