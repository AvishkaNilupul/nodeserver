// The ACCOUNT-COUNT comparison between a lane's shadow verdict and the legacy
// row for the same campaign — the part of diffAgainstLegacy that says whether
// "lane − legacy accounts" is a number worth reading.
//
// WHY THIS IS ITS OWN MODULE
//
// The action-class comparison (agree / disagree) is sound: it compares two
// decisions. The account delta compared two NUMBERS and assumed both meant
// "accounts this decision planned". Production (2026-09-05) showed the legacy
// number rarely means that, in three independent ways:
//
//   1. skip rows: the skip paths never write plannedAccounts, so the row
//      carries whatever an EARLIER decision on the same (game, campaignId)
//      row left there. Seven skip_low_demand lanes showed −15 where the lane
//      planned 0 by definition. Meaningless in both directions.
//   2. reuse rows: legacy's count was made while the campaign had no row;
//      the lane's was made after legacy's row existed and held the accounts.
//      The lane's spokenFor exempts that row now (steps/decide.js), but the
//      world can still have moved between the two decisions — a sibling's
//      task activated after legacy decided, or one of legacy's competitors
//      completed since — and then the two engines counted different worlds,
//      not different rules.
//   3. dry-run reuse rows carry plannedAccounts 0 by construction.
//
// So a delta is SCORED only when both sides are reuse decisions and the
// comparison can establish that they counted the same thing: the same source
// task, no competitor legacy could not have seen, none of legacy's
// competitors released since. Everything else is reported with the reason it
// was not scored. Absence of a reason is never a pass: a row that predates
// this module has no accountComparable field and is not scored.
//
// Fresh-spend rows (farm/probe on both sides) are reported but not scored
// either: the lane's count comes from the arbiter's sealed allowance and
// legacy's from a serial fair share — different allocators by design — and
// legacy's claim at T shrinks the pool the lane counts at T+Δ.

const classes = require("./decisionClasses");
const { hasReuseInputs } = require("../decisionInputs");

// The gap the readiness report warns about, on scored rows only.
const BIG_GAP = 10;

// Why an account delta was not scored. The readiness report groups by these,
// so they are named here once.
const NOT_SCORED = Object.freeze({
  DIFFERENT_CLASS: "different_action_class",
  SKIP: "skip_rows_carry_no_plan",
  SPEND: "fresh_spend_budgets_differ_by_design",
  LEGACY_DRY_RUN: "legacy_dry_run",
  SOURCE_MISMATCH: "source_mismatch",
  LEGACY_SOURCE_STILL_LIVE: "own_row_source_while_legacy_source_live",
  COMPETITOR_AFTER_LEGACY: "competitor_after_legacy",
  COMPETITOR_RELEASED_SINCE: "competitor_released_since",
  COMPETITOR_COMPLETED_SINCE: "competitor_completed_since",
});

const LIVE = ["active", "planned"];

// Compare the counts. `legacy` is the AutoFarmTask row (lean) with at least
// _id, decision, plannedAccounts, dryRun, decidedAt, decisionInputs;
// `legacyAt` is its decidedAt in ms (0 when unknown). Async because the
// world-moved checks read the current state of the competitors.
async function compareAccounts({ verdict, legacy, legacyAt = 0 }) {
  const AutoFarmTask = require("../../models/AutoFarmTask");
  const lanePlanned = Number(verdict.plannedAccounts || 0);
  const field = Number(legacy.plannedAccounts || 0);
  const laneClass = classes.actionClass(verdict.decision);
  const legacyClass = classes.actionClass(legacy.decision);

  const base = {
    lanePlanned,
    // The raw row field, kept visible so a reader can see what the old
    // comparison was scoring.
    legacyPlannedField: field,
    sourceVerified: null,
  };
  const notScored = (note, extra = {}) => ({
    ...base,
    accountComparable: false,
    accountBasis: "none",
    accountNote: note,
    legacyPlanned: null,
    accountDelta: null,
    ...extra,
  });

  if (laneClass !== legacyClass) return notScored(NOT_SCORED.DIFFERENT_CLASS);
  if (laneClass === "skip") return notScored(NOT_SCORED.SKIP);
  if (laneClass === "spend") {
    // Both planned a fresh spend: the field IS this decision's (farm/probe
    // write it), so the numbers are shown — but not scored (module comment).
    return notScored(NOT_SCORED.SPEND, {
      accountBasis: "planned_field",
      legacyPlanned: field,
      accountDelta: lanePlanned - field,
    });
  }
  if (laneClass !== "reuse") return notScored(NOT_SCORED.DIFFERENT_CLASS);

  // --- reuse vs reuse ------------------------------------------------------
  if (legacy.dryRun) return notScored(NOT_SCORED.LEGACY_DRY_RUN);

  const rec = hasReuseInputs(legacy.decisionInputs) ? legacy.decisionInputs.reuse : null;
  const legacyPlanned = rec ? rec.free : field;
  const accountBasis = rec ? "recorded_reuse_free" : "planned_field";
  const numbers = { accountBasis, legacyPlanned, accountDelta: lanePlanned - legacyPlanned };

  const laneSource = verdict.reuseTaskId ? String(verdict.reuseTaskId) : null;
  const legacySource = rec && rec.sourceTaskId ? String(rec.sourceTaskId) : null;
  let note = "";
  let sourceVerified = false;
  if (legacySource) {
    sourceVerified = true;
    if (laneSource === legacySource) {
      // Same warm task on both sides.
    } else if (laneSource === String(legacy._id)) {
      // The lane reused the campaign's OWN legacy row — whose accounts are
      // legacy's reuse output, so the count is comparable... unless legacy's
      // source is itself still live, in which case the own row's accounts are
      // being counted against it (the mirror of the own-row collision).
      const src = await AutoFarmTask.findById(legacySource).select("status").lean();
      if (src && LIVE.includes(src.status)) {
        return notScored(NOT_SCORED.LEGACY_SOURCE_STILL_LIVE, { ...numbers, sourceVerified });
      }
      note = "own_row_source";
    } else {
      // Different warm tasks: different account sets, different counts.
      return notScored(NOT_SCORED.SOURCE_MISMATCH, { ...numbers, sourceVerified });
    }
  }

  // A competitor the lane saw that was activated AFTER legacy decided is one
  // legacy could not have counted. (executedAt is re-stamped by a backfill
  // top-up, so an old task that gained these accounts since is caught too.)
  const after = (verdict.reuseCompetitors || []).filter(
    (c) => legacyAt && c && c.executedAt && new Date(c.executedAt).getTime() > legacyAt,
  );
  if (after.length) {
    return notScored(NOT_SCORED.COMPETITOR_AFTER_LEGACY, {
      ...numbers,
      sourceVerified,
      competitorsAfter: after.length,
    });
  }

  // One of the tasks that spoke for legacy's accounts has since let go of
  // them (completed, stopped, failed, deleted): the lane sees more free than
  // legacy could. Exact when legacy recorded its competitors; approximated
  // from completedAt otherwise (a stopped task has no timestamp — the
  // residual blind spot, in the positive direction, for pre-record rows).
  if (rec && Array.isArray(rec.competitors)) {
    if (rec.competitors.length) {
      const now = await AutoFarmTask.find({ _id: { $in: rec.competitors } })
        .select("status")
        .lean();
      const stillLive = now.filter((t) => LIVE.includes(t.status)).length;
      const released = rec.competitors.length - stillLive;
      if (released > 0) {
        return notScored(NOT_SCORED.COMPETITOR_RELEASED_SINCE, {
          ...numbers,
          sourceVerified,
          competitorsReleased: released,
        });
      }
    }
  } else if (laneSource && legacyAt) {
    const src = await AutoFarmTask.findById(laneSource).select("assignedAccounts").lean();
    const held = src ? src.assignedAccounts || [] : [];
    if (held.length) {
      const completedSince = await AutoFarmTask.countDocuments({
        _id: { $ne: src._id },
        status: "completed",
        completedAt: { $gt: new Date(legacyAt) },
        assignedAccounts: { $in: held },
      });
      if (completedSince) {
        return notScored(NOT_SCORED.COMPETITOR_COMPLETED_SINCE, {
          ...numbers,
          sourceVerified,
          competitorsReleased: completedSince,
        });
      }
    }
  }

  return {
    ...base,
    ...numbers,
    accountComparable: true,
    accountNote: note,
    sourceVerified,
  };
}

module.exports = { compareAccounts, BIG_GAP, NOT_SCORED };
