// The inputs the sellability gate saw, snapshotted onto the AutoFarmTask row at
// record() time.
//
// WHY THIS EXISTS
//
// utils/farm2/replay.js verifies a lane by re-running the economics against the
// inputs the legacy engine had when it decided. Until this module existed those
// inputs had to be RECONSTRUCTED after the fact, and every reconstruction has a
// hole that the prod runs found one at a time:
//
//   research   from MarketResearchSnapshot — gone after 120 days, or never
//              written for the moment in question
//   sales      from a SaleSignal window-stability check — any sale since the
//              decision makes the row unreplayable, because the price at
//              decision time is recorded nowhere
//   probe gate the concurrent-probe budget counts CURRENT task status, so it
//              can only be inferred by sensitivity analysis, never rebuilt
//   settings   utils/settings.js is not versioned, so yesterday's decision was
//              being replayed under today's maxPerGame — the largest
//              unquantified risk in the design (FARM2-VERIFICATION §7.3)
//
// Recording the inputs closes all four for every row written after this ships.
// Rows written before it are reconstructed exactly as before.
//
// ONE SHAPE, THREE WRITERS, ONE READER. autoFarmer.processCampaign, the lane's
// decide step and the replay harness all import this module; none of them
// describes the shape itself. That is what keeps the three from drifting.
//
// VERSIONED, AND CHECKED FOR EQUALITY. The reader accepts a snapshot only when
// `version` equals the version it knows. A row with no snapshot, a null one, or
// an unrecognised version is reconstructed — never assumed to have matched.
// Absence of a field is never a passing value; that trap has bitten this
// codebase three times. Bump the version whenever the shape changes.

const DECISION_INPUTS_VERSION = 1;

// The settings demandAllocation, the probe gate and the tier target read. Only
// these are snapshotted; the market floor they feed is recorded as a value.
const AF_FIELDS = Object.freeze([
  "maxPerGame",
  "probeColdStart",
  "probeSize",
  "probeMaxSellers",
  "probeMaxGames",
  "probeCooldownDays",
  "perMarketStock",
  "poolReserve",
  "minHoursLeft",
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build the snapshot from exactly what the decision used.
//
//   research   the MarketResearch doc (or null) demandAllocation was given
//   sales      what salesOf() returned — { count, revenue, avgPrice }
//   af         the settings object in force
//   probeAllowed / probeBudgetBlocked   the probe gate's two outputs
//   floor      `alloc.probe ? 0 : marketStockFloor(af)` at decision time
function buildDecisionInputs({ research, sales, af, probeAllowed, probeBudgetBlocked, floor }) {
  const afSnap = {};
  for (const k of AF_FIELDS) {
    if (af && af[k] !== undefined) afSnap[k] = af[k];
  }
  return {
    version: DECISION_INPUTS_VERSION,
    at: new Date(),
    // null when there was no research document — demandAllocation's
    // no-market-data branch. A document with scannedAt null takes the same
    // branch and is recorded as such, not collapsed to null.
    research: research
      ? {
          demandScore: num(research.demandScore),
          sellers: num(research.sellers),
          scannedAt: research.scannedAt ? new Date(research.scannedAt) : null,
        }
      : null,
    sales: {
      count: Math.max(0, num(sales && sales.count) || 0),
      revenue: Math.max(0, num(sales && sales.revenue) || 0),
      avgPrice: Math.max(0, num(sales && sales.avgPrice) || 0),
    },
    af: afSnap,
    probeAllowed: probeAllowed !== false,
    probeBudgetBlocked: probeBudgetBlocked === true,
    marketStockFloor: Math.max(0, num(floor) || 0),
  };
}

// Is this a snapshot the current reader understands? Equality on the version,
// then the fields the economics actually consume must be present with the
// right shape. Anything else is "reconstruct it".
function isRecordedInputs(di) {
  if (!di || typeof di !== "object") return false;
  if (di.version !== DECISION_INPUTS_VERSION) return false;
  if (!di.sales || typeof di.sales !== "object") return false;
  if (!di.af || typeof di.af !== "object") return false;
  if (di.research !== null && di.research !== undefined && typeof di.research !== "object") {
    return false;
  }
  if (typeof di.probeAllowed !== "boolean") return false;
  return true;
}

// ---------------------------------------------------------------------------
// The REUSE inputs — an optional extension under the same version.
//
// A reuse_existing decision has inputs the sellability snapshot above does not
// cover: which warm task it reused, how many accounts that task held, how many
// of those another live task already spoke for, and so how many were free —
// the number legacy records as plannedAccounts and assigns to the campaign.
//
// Why record it. The shadow comparison scores a lane's reuse count against the
// legacy row's plannedAccounts, and production showed that field is not a
// usable input: never written on the skip paths (so a leftover from an earlier
// decision on the same row), 0 by construction on a dry-run reuse, and — even
// when it is the honest mine.length — undated, so nothing says whether the two
// engines counted the same world. The recorded `free` is the count at the
// moment of the decision; `sourceTaskId` says which task it was counted on;
// `competitors` says which live tasks held the rest. With those three the
// comparison can tell "the lane's rule differs" from "the world moved between
// the two decisions", which is the whole question.
//
// Optional, not a version bump: nothing about the existing fields changes
// meaning, and absence is read as "not recorded" — never as zero and never as
// a match. A reader uses hasReuseInputs(), which requires a numeric `free`;
// the dry-run legacy path records the source and its size but computes no
// spoken-for set, so it writes free: null and is correctly "not recorded".
//
//   sourceTaskId     the task whose accounts were reused (R)
//   sourceHeld       R.assignedAccounts.length at decision time
//   spokenFor        of those, how many another active/planned task held
//   free             sourceHeld - spokenFor: what this campaign got
//   competitors      the _ids of the active/planned tasks that held any of
//                    R's accounts (the campaign's own row excluded); [] when
//                    none, null when not computed (dry-run)
//   ownRowExcluded   lane only: accounts on the campaign's OWN active/planned
//                    row that overlapped R and were deliberately not counted
//                    (steps/decide.js); null when there was no such row
//   dryRun           the decision was a dry-run plan
function buildReuseInputs({
  sourceTaskId,
  sourceHeld,
  free,
  spokenFor,
  competitors,
  ownRowExcluded,
  dryRun,
}) {
  const held = Math.max(0, num(sourceHeld) || 0);
  const freeN = free === null || free === undefined ? null : Math.max(0, num(free) || 0);
  let spoken = null;
  if (freeN !== null) {
    spoken =
      spokenFor === null || spokenFor === undefined
        ? Math.max(0, held - freeN)
        : Math.max(0, num(spokenFor) || 0);
  }
  return {
    sourceTaskId: sourceTaskId || null,
    sourceHeld: held,
    spokenFor: spoken,
    free: freeN,
    competitors: Array.isArray(competitors) ? competitors.slice() : null,
    ownRowExcluded:
      ownRowExcluded === null || ownRowExcluded === undefined
        ? null
        : Math.max(0, num(ownRowExcluded) || 0),
    dryRun: dryRun === true,
  };
}

// Attach reuse inputs to a snapshot. A snapshot is required: reuse inputs
// never travel without the sellability inputs they belong to.
function withReuseInputs(di, reuse) {
  if (!di || typeof di !== "object") return di;
  return { ...di, reuse: reuse || null };
}

// Were the reuse inputs recorded? Requires a numeric `free`; a dry-run record
// (free: null), an older row (no `reuse`) or a non-reuse decision all read as
// "no" — absence is never a passing value.
function hasReuseInputs(di) {
  if (!di || typeof di !== "object" || !di.reuse || typeof di.reuse !== "object") return false;
  return typeof di.reuse.free === "number" && Number.isFinite(di.reuse.free);
}

module.exports = {
  DECISION_INPUTS_VERSION,
  AF_FIELDS,
  buildDecisionInputs,
  isRecordedInputs,
  buildReuseInputs,
  withReuseInputs,
  hasReuseInputs,
};
