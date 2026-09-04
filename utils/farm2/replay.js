// REPLAY — re-run the economics against the inputs the legacy engine actually
// had, instead of against today's world.
//
// ---------------------------------------------------------------------------
// WHY THE EXISTING COMPARISON CANNOT WORK
// ---------------------------------------------------------------------------
//
// diffAgainstLegacy asks "does the lane's decision today match the legacy
// engine's decision from whenever it last decided?". Two things differ between
// those two observations: the ENGINE and the WORLD. When the answers differ you
// cannot attribute the difference to either one, which is why all ten of the
// trial's "disagreements" turned out to be both engines being right about
// different moments.
//
// The 6h staleness gate was the right diagnosis and the wrong cure. Age is a
// proxy for "the world has not moved", and a poor one in both directions: it
// throws away a decision made 200h ago on a game where nothing has changed, and
// it accepts one made 20 minutes ago on a game that was rescanned in between.
// Applied to prod it left 0 comparable pairs out of 300, which is the honest
// consequence of a proxy that is mostly measuring how often the legacy engine
// happens to re-decide things.
//
// Replay removes the confound instead of gating on it. Hold the world fixed at
// the moment the legacy engine decided, run the lane's economics against THAT
// world, and the only remaining variable is the engine. It also turns the
// sample-size problem inside out: rather than waiting days for fresh pairs to
// accumulate, every decision the legacy engine has already made is a test case
// available right now, offline.
//
// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT RECONSTRUCTABLE
// ---------------------------------------------------------------------------
//
// Recoverable for a past moment T:
//   research.demandScore  models/MarketResearchSnapshot — one row per game per
//   research.sellers      scan, retained 120 days. MarketResearch itself is
//                         overwritten in place and keeps no history, so the
//                         snapshot collection is the only route to a past scan.
//   internalSales         models/SaleSignal is append-only and timestamped, so
//                         whether the 45-day window's CONTENTS changed between T
//                         and now is a pair of existence queries.
//
// NOT recoverable, and this bounds everything below:
//   af settings           utils/settings.js is not versioned. A change to
//                         maxPerGame or the demand thresholds between T and now
//                         is invisible, and would make a replay disagree for a
//                         reason that is not the lane's fault.
//   pool depth            countReadyPool is a live count.
//   container capacity    a live host query.
//   host reachability     a live SSH probe.
//   archive coverage      archiveHoldersForCampaign reads current inventory.
//
// Those four settle every decision DOWNSTREAM of the sellability gate, so
// replay is deliberately scoped to the demand stage and reports downstream
// decisions as out of scope rather than pretending to score them. Measuring the
// reconstruction's blind spots and calling it engine disagreement is exactly
// the mistake the 6h gate made.
//
// ---------------------------------------------------------------------------
// NO SECOND SOURCE OF TRUTH
// ---------------------------------------------------------------------------
//
// Every number here comes from utils/autoFarmer.js's own exports —
// demandAllocation, salesOf, capForGame, marketStockFloor. This module
// reconstructs INPUTS and compares OUTPUTS; it does not re-derive a single
// tier, boost or cap. The one place that discipline costs us is noted at
// salesInputsFor(): reconstructing a past avgPrice would mean copying the
// SaleSignal aggregation out of internalSalesForGame, so instead we detect
// whether it is safe to reuse the live value and give up honestly when it is
// not.

const settings = require("../settings");
const classes = require("./decisionClasses");

// Load the legacy engine lazily, for the same reason steps/decide.js does: it
// pulls a wide dependency graph and, on prod, a catalog integration that does
// not exist in every checkout.
function brain() {
  return require("../autoFarmer");
}

// Mirrors SALES_WINDOW_MS in utils/autoFarmer.js. Used ONLY to ask "did the
// window's contents change?", never to recompute a sales figure — see
// salesInputsFor().
const SALES_WINDOW_MS = 45 * 86400000;

// models/MarketResearchSnapshot.js expires rows after 120 days, so a decision
// older than that has no reconstructable research and is not replayable at all.
// Held slightly inside the TTL: a row a few hours from expiry may already be
// gone, and "the snapshot vanished mid-query" would read as "no research".
const SNAPSHOT_RETENTION_DAYS = 120;
const DEFAULT_MAX_AGE_DAYS = 110;

// Fidelity of a reconstruction. Only `exact` is evidence.
//
//   exact         every input the decision depends on was recovered, or is
//                 provably irrelevant to it
//   partial       something is assumed rather than known (see `gaps`)
//   unreplayable  a required input cannot be recovered at all
const FIDELITY = Object.freeze({
  EXACT: "exact",
  PARTIAL: "partial",
  UNREPLAYABLE: "unreplayable",
});

// --- Input reconstruction --------------------------------------------------

// Own-sales input as the legacy engine saw it at time T.
//
// internalSalesForGame(game) aggregates SaleSignal rows in [now-45d, now].
// At T the window was [T-45d, T]. The two aggregate the SAME row set iff
// nothing entered after T and nothing aged out of the far end since. Both are
// existence queries on an append-only, timestamped collection.
//
// When the set is unchanged we reuse the LIVE function's output verbatim, which
// keeps internalSalesForGame the single source of truth for what a sale is
// worth — the per-source grouping in there fixes a real phantom-demand bug
// (connected writes one row per drop, listing_sold one per unit) and copying it
// to shift a date is precisely the drift this engine exists to prevent.
//
// When the set HAS changed we cannot recover avgPrice, so we say so instead of
// substituting 0 — priceFactor(0) returns a neutral 1, which would silently
// change the sales boost and manufacture a disagreement the lane did not cause.
//
// The exception that makes most rows replayable anyway: when the recorded count
// was 0, salesBoost is 0 and capForGame is at its base regardless of price, so
// no price information is needed and the reconstruction is exact.
async function salesInputsFor(task, { now = Date.now() } = {}) {
  const b = brain();
  const SaleSignal = require("../../models/SaleSignal");
  const gameKey = String(task.game || "").toLowerCase();
  const recordedCount = Math.max(0, Number(task.internalSales) || 0);
  const decidedAt = task.decidedAt ? new Date(task.decidedAt).getTime() : null;

  if (recordedCount === 0) {
    return {
      sales: { count: 0, revenue: 0, avgPrice: 0 },
      fidelity: FIDELITY.EXACT,
      gaps: [],
      note: "no own sales at decision time — price factor cannot apply",
    };
  }

  if (!decidedAt) {
    return {
      sales: null,
      fidelity: FIDELITY.UNREPLAYABLE,
      gaps: ["no_decided_at"],
      note: "decision has no timestamp, so its sales window is unknown",
    };
  }

  // Same source filter as internalSalesForGame — these two are what it counts.
  const sources = { $in: ["connected", "listing_sold"] };
  const [added, agedOut] = await Promise.all([
    SaleSignal.countDocuments({ gameKey, source: sources, at: { $gt: new Date(decidedAt) } }),
    SaleSignal.countDocuments({
      gameKey,
      source: sources,
      at: { $gte: new Date(decidedAt - SALES_WINDOW_MS), $lt: new Date(now - SALES_WINDOW_MS) },
    }),
  ]);

  if (added > 0 || agedOut > 0) {
    return {
      sales: null,
      fidelity: FIDELITY.UNREPLAYABLE,
      gaps: ["sales_window_drifted"],
      note:
        `${added} sale signal(s) landed after the decision and ${agedOut} aged out of ` +
        "the 45-day window since — the average price at decision time is not recorded " +
        "anywhere and cannot be recovered without duplicating the aggregation",
    };
  }

  // The row set is unchanged, so the live figure IS the historical figure.
  const live = b.salesOf(await b.internalSalesForGame(task.game));

  // Integrity check. If the set really is unchanged the count must match what
  // was recorded; if it does not, one of our assumptions about this collection
  // is wrong and the reconstruction must not be trusted.
  if (live.count !== recordedCount) {
    return {
      sales: null,
      fidelity: FIDELITY.UNREPLAYABLE,
      gaps: ["sales_count_mismatch"],
      note:
        `no rows entered or left the window, but the live count (${live.count}) differs ` +
        `from the recorded one (${recordedCount}) — the window is not as stable as assumed`,
    };
  }

  return { sales: live, fidelity: FIDELITY.EXACT, gaps: [], note: "" };
}

// Market research as the legacy engine saw it at time T.
//
// Returns the shape demandAllocation reads: { demandScore, sellers, scannedAt }.
// scannedAt comes from the snapshot's own `at`, because that IS the moment the
// scan happened — demandAllocation only tests it for null (a doc that exists but
// has never been scanned takes the no-market-data branch).
async function researchInputsFor(task, { af } = {}) {
  const MarketResearchSnapshot = require("../../models/MarketResearchSnapshot");
  const gameKey = String(task.game || "").toLowerCase();
  const decidedAt = task.decidedAt ? new Date(task.decidedAt) : null;
  if (!decidedAt) {
    return { research: null, fidelity: FIDELITY.UNREPLAYABLE, gaps: ["no_decided_at"], note: "" };
  }

  const snap = await MarketResearchSnapshot.findOne({ gameKey, at: { $lte: decidedAt } })
    .sort({ at: -1 })
    .lean();

  if (!snap) {
    // Either the game had never been scanned by then, or the snapshot has
    // expired. Those are opposite situations and confusing them would be a
    // silent error, so distinguish them by age.
    const ageDays = (Date.now() - decidedAt.getTime()) / 86400000;
    if (ageDays > SNAPSHOT_RETENTION_DAYS) {
      return {
        research: null,
        fidelity: FIDELITY.UNREPLAYABLE,
        gaps: ["snapshot_expired"],
        note: `decision is ${Math.round(ageDays)} days old; research snapshots expire at ${SNAPSHOT_RETENTION_DAYS}`,
      };
    }
    // No snapshot and not old enough to have expired, so the game had never
    // been scanned by then — UNLESS the task itself says otherwise. On any row
    // that records the raw market score, a non-null demandScore proves a
    // research document existed at decision time, and then a missing snapshot
    // means the history is incomplete rather than the game being unscanned.
    // Treating that as "no market data" would feed demandAllocation down the
    // probe branch and manufacture a disagreement out of a gap in our records.
    if (!classes.recordsEffectiveDemand(task.decision) && task.demandScore != null) {
      return {
        research: null,
        fidelity: FIDELITY.UNREPLAYABLE,
        gaps: ["snapshot_missing_but_research_recorded"],
        note:
          `the task recorded demandScore ${task.demandScore}, so research existed at decision ` +
          "time, but no snapshot at or before that moment survives to reconstruct it",
      };
    }
    return {
      research: null,
      fidelity: FIDELITY.EXACT,
      gaps: [],
      note: "no scan had happened for this game by then — the no-market-data branch",
    };
  }

  const research = {
    demandScore: Number(snap.demandScore || 0),
    sellers: Number(snap.sellers || 0),
    scannedAt: snap.at,
  };

  const gaps = [];
  let fidelity = FIDELITY.EXACT;

  // Cross-check the reconstruction against what the task recorded — but ONLY
  // for decisions where that field is the raw market score.
  //
  // See classes.recordsEffectiveDemand: on the sellability-skip path the stored
  // demandScore is the BLENDED effective demand (an output of the decision, not
  // an input to it), so comparing it against a snapshot would be comparing two
  // different quantities. `probe` is recorded on the ordinary path further down
  // and DOES carry the raw score, so it is cross-checked like any other row.
  if (!classes.recordsEffectiveDemand(task.decision) && task.demandScore != null) {
    if (Number(task.demandScore) !== research.demandScore) {
      gaps.push("research_snapshot_mismatch");
      fidelity = FIDELITY.PARTIAL;
    }
  }

  // `sellers` is only read on the cold-start probe branch. When cold-start
  // probing is off the value cannot affect the outcome, so an imperfect one is
  // harmless; when it is on, it decides probe-vs-skip.
  if (af && af.probeColdStart && snap.sellers == null) {
    gaps.push("sellers_unknown");
    fidelity = FIDELITY.PARTIAL;
  }

  return { research, fidelity, gaps, note: "" };
}

// The cold-start probe gate as it stood at T.
//
// Half of it is reconstructable and half is not:
//   recentlyFailed  reads completedAt, a stored timestamp — recoverable
//   otherProbes     counts tasks whose status is ACTIVE/PLANNED right now.
//                   Status is current state, not history, so how many games
//                   were probing at T is not recoverable.
//
// When af.probeColdStart is off (the default) the whole gate is inert and
// probeAllowed is unconditionally true, which is exact.
async function probeGateFor(task, { af }) {
  if (!af || !af.probeColdStart) {
    return { probeAllowed: true, fidelity: FIDELITY.EXACT, gaps: [], note: "cold-start probing off" };
  }
  const AutoFarmTask = require("../../models/AutoFarmTask");
  const decidedAt = task.decidedAt ? new Date(task.decidedAt) : null;
  if (!decidedAt) {
    return { probeAllowed: true, fidelity: FIDELITY.UNREPLAYABLE, gaps: ["no_decided_at"], note: "" };
  }
  const cooldownCut = new Date(
    decidedAt.getTime() - Math.max(0, Number(af.probeCooldownDays) || 0) * 86400000,
  );
  const recentlyFailed = await AutoFarmTask.exists({
    game: task.game,
    probeOutcome: "expired",
    completedAt: { $gte: cooldownCut, $lte: decidedAt },
  });

  return {
    probeAllowed: !recentlyFailed,
    fidelity: FIDELITY.PARTIAL,
    gaps: ["probe_budget_unreconstructable"],
    note:
      "the post-failure cooldown was recovered from completedAt, but the concurrent-probe " +
      "budget reads live task status and cannot be rebuilt for a past moment",
  };
}

// Combine the three into one input set.
async function reconstructInputs(task, { af, now = Date.now() } = {}) {
  const af2 = af || settings.getAutoFarm();
  const [salesPart, researchPart, probePart] = await Promise.all([
    salesInputsFor(task, { now }),
    researchInputsFor(task, { af: af2 }),
    probeGateFor(task, { af: af2 }),
  ]);

  const parts = [salesPart, researchPart, probePart];
  const gaps = parts.flatMap((p) => p.gaps);
  const notes = parts.map((p) => p.note).filter(Boolean);

  // Worst wins. A single unrecoverable input makes the whole reconstruction
  // unusable — averaging fidelities would let a confident guess about one input
  // paper over a blank in another.
  let fidelity = FIDELITY.EXACT;
  if (parts.some((p) => p.fidelity === FIDELITY.UNREPLAYABLE)) fidelity = FIDELITY.UNREPLAYABLE;
  else if (parts.some((p) => p.fidelity === FIDELITY.PARTIAL)) fidelity = FIDELITY.PARTIAL;

  return {
    af: af2,
    research: researchPart.research,
    sales: salesPart.sales,
    probeAllowed: probePart.probeAllowed,
    fidelity,
    gaps,
    notes,
    // Settings are not versioned, so this is an assumption on EVERY row rather
    // than a per-row gap. Recorded so a reviewer can see which values the
    // replay ran under and re-run with the ones that were actually live.
    afAssumed: {
      maxPerGame: af2.maxPerGame,
      probeColdStart: !!af2.probeColdStart,
      probeSize: af2.probeSize,
      probeMaxSellers: af2.probeMaxSellers,
      perMarketStock: af2.perMarketStock,
      minHoursLeft: af2.minHoursLeft,
    },
  };
}

// --- The replay itself -----------------------------------------------------

// Re-run the sellability stage for one recorded legacy decision.
//
// The verdict is deliberately narrow. It answers "does the economics path the
// lane engine uses reproduce what the legacy engine recorded, given the same
// inputs?" — not "would the lane have done the same thing", which additionally
// depends on gates the lane does not implement and state nobody snapshots.
async function replayDecision(task, { af, now = Date.now() } = {}) {
  const b = brain();
  const base = {
    game: task.game,
    campaignId: task.campaignId,
    decidedAt: task.decidedAt || null,
    legacyDecision: task.decision,
    legacyTarget: Number(task.targetAccounts || 0),
    legacyDemandScore: task.demandScore == null ? null : Number(task.demandScore),
  };

  const inputs = await reconstructInputs(task, { af, now });
  if (inputs.fidelity === FIDELITY.UNREPLAYABLE) {
    return {
      ...base,
      verdict: "unreplayable",
      fidelity: inputs.fidelity,
      gaps: inputs.gaps,
      notes: inputs.notes,
    };
  }

  // THE economics — imported, never re-derived.
  const alloc = b.demandAllocation(inputs.research, inputs.af, inputs.sales, {
    probeAllowed: inputs.probeAllowed,
  });

  const replayed = {
    skip: !!alloc.skip,
    probe: !!alloc.probe,
    target: Math.max(0, Number(alloc.target) || 0),
    cap: Number(alloc.cap) || 0,
    demand: alloc.demand == null ? null : Number(alloc.demand),
    effective: alloc.effective == null ? null : Number(alloc.effective),
    probeBlocked: !!alloc.probeBlocked,
  };

  const out = { ...base, replayed, fidelity: inputs.fidelity, gaps: inputs.gaps, notes: inputs.notes };

  // --- Score it ------------------------------------------------------------
  //
  // Three shapes of assertion, depending on what the recorded decision proves
  // about the demand stage.

  // (a) The legacy engine stopped AT the sellability gate. The stage's whole
  //     output is recorded, so this is a full check — and a self-validating
  //     one: the stored demandScore is alloc.demand, so a match confirms both
  //     the input reconstruction and the economics at once.
  if (classes.isDemandStageDecision(task.decision)) {
    if (task.decision === "skip_low_demand" || task.decision === "skip_probe_budget") {
      if (!replayed.skip) {
        return {
          ...out,
          verdict: "disagree",
          detail: `legacy skipped at the sellability gate; replay wants ${replayed.probe ? "probe" : "farm"} ${replayed.target}`,
        };
      }
      if (base.legacyDemandScore != null && replayed.demand != null) {
        // Both are already rounded by demandAllocation; compare with a small
        // tolerance for float noise rather than exact equality.
        const delta = Math.abs(replayed.demand - base.legacyDemandScore);
        if (delta > 0.15) {
          return {
            ...out,
            verdict: "inconclusive",
            detail:
              `both skip, but the replayed effective demand (${replayed.demand}) does not match ` +
              `the recorded one (${base.legacyDemandScore}) — the reconstruction is probably ` +
              "missing an input rather than the engines disagreeing",
          };
        }
      }
      return { ...out, verdict: "agree", detail: "sellability skip reproduced, demand figure matches" };
    }
    // probe
    if (!replayed.probe) {
      return {
        ...out,
        verdict: inputs.gaps.includes("probe_budget_unreconstructable") ? "inconclusive" : "disagree",
        detail: `legacy probed; replay says ${replayed.skip ? "skip" : "farm " + replayed.target}`,
      };
    }
    return { ...out, verdict: "agree", detail: "probe reproduced" };
  }

  // (b) The legacy engine got PAST the sellability gate — whatever it did next,
  //     the stage must not have skipped.
  if (replayed.skip) {
    return {
      ...out,
      verdict: "disagree",
      detail:
        `legacy passed the sellability gate and settled with "${task.decision}", but the replay ` +
        "skips at that gate — the lane would never have considered this campaign",
    };
  }

  // (c) The tier target is checkable when the legacy engine recorded one.
  //     targetAccounts is `wanted` from the coverage gate:
  //       min(max(alloc.target, probe ? 0 : marketStockFloor(af)), alloc.cap || af.maxPerGame)
  //     rebuilt here from the same imported helpers rather than re-derived.
  if (base.legacyTarget > 0) {
    let floor = 0;
    try {
      floor = replayed.probe ? 0 : Number(b.marketStockFloor(inputs.af)) || 0;
    } catch {
      // marketStockFloor consults the marketplaces module for key status; if
      // that is unavailable the floor is unknown, not zero.
      return {
        ...out,
        verdict: "inconclusive",
        detail: "market stock floor unavailable, so the tier target cannot be rebuilt",
      };
    }
    const cap = replayed.cap || Number(inputs.af.maxPerGame) || 0;
    const wanted = Math.min(Math.max(replayed.target, floor), cap);
    if (wanted !== base.legacyTarget) {
      return {
        ...out,
        replayedWanted: wanted,
        verdict: "disagree",
        detail: `tier target differs — replay wants ${wanted}, legacy recorded ${base.legacyTarget}`,
      };
    }
    return {
      ...out,
      replayedWanted: wanted,
      verdict: "agree",
      detail: `sellability passed and the tier target matches (${wanted})`,
    };
  }

  return {
    ...out,
    verdict: "agree",
    detail: "sellability passed, as it must have for the legacy engine to reach " + task.decision,
    downstream: true,
  };
}

// --- Batch + report --------------------------------------------------------

// Replay every recorded legacy decision for a game (or for all games).
//
// Read-only end to end: it reads AutoFarmTask, MarketResearchSnapshot and
// SaleSignal and writes nothing. Safe to point at a production dump.
async function replayHistory({
  game = null,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  limit = 500,
  af = null,
  now = Date.now(),
} = {}) {
  const AutoFarmTask = require("../../models/AutoFarmTask");
  const q = { decidedAt: { $ne: null, $gte: new Date(now - maxAgeDays * 86400000) } };
  if (game) q.game = game;

  const tasks = await AutoFarmTask.find(q)
    .sort({ decidedAt: -1 })
    .limit(Math.max(1, limit))
    .select("game campaignId decision demandScore hadResearch internalSales targetAccounts plannedAccounts decidedAt")
    .lean();

  const af2 = af || settings.getAutoFarm();
  const rows = [];
  for (const t of tasks) {
    try {
      rows.push(await replayDecision(t, { af: af2, now }));
    } catch (e) {
      // One malformed row must not cost the whole report, in the same spirit as
      // the per-campaign boundary inside a lane.
      rows.push({
        game: t.game,
        campaignId: t.campaignId,
        legacyDecision: t.decision,
        verdict: "error",
        detail: String((e && e.message) || e),
      });
    }
  }
  return summarise(rows, { maxAgeDays, af: af2 });
}

function summarise(rows, { maxAgeDays, af } = {}) {
  const by = (v) => rows.filter((r) => r.verdict === v);
  const agree = by("agree");
  const disagree = by("disagree");
  const inconclusive = by("inconclusive");
  const unreplayable = by("unreplayable");
  const errored = by("error");

  // Evidence is the EXACT-fidelity agreements and disagreements only. A partial
  // reconstruction can still be reported, but it must not count toward a
  // promotion decision — the same rule as the field-presence checks elsewhere
  // in this engine: not scored by the current logic is never "passed it".
  const scored = [...agree, ...disagree].filter((r) => r.fidelity === FIDELITY.EXACT);
  const scoredAgree = scored.filter((r) => r.verdict === "agree");
  const scoredDisagree = scored.filter((r) => r.verdict === "disagree");

  // Why the unreplayable ones failed, so the gap between "rows examined" and
  // "rows scored" is always explainable rather than a mystery number.
  const gapCounts = {};
  for (const r of rows) {
    for (const g of r.gaps || []) gapCounts[g] = (gapCounts[g] || 0) + 1;
  }

  const perGame = {};
  for (const r of rows) {
    const k = r.game || "?";
    perGame[k] = perGame[k] || { total: 0, scored: 0, agree: 0, disagree: 0 };
    perGame[k].total += 1;
    if (r.fidelity === FIDELITY.EXACT && (r.verdict === "agree" || r.verdict === "disagree")) {
      perGame[k].scored += 1;
      if (r.verdict === "agree") perGame[k].agree += 1;
      else perGame[k].disagree += 1;
    }
  }

  return {
    examined: rows.length,
    scored: scored.length,
    agree: scoredAgree.length,
    disagree: scoredDisagree.length,
    // Reported but NOT counted as evidence.
    partialFidelity: rows.filter((r) => r.fidelity === FIDELITY.PARTIAL).length,
    inconclusive: inconclusive.length,
    unreplayable: unreplayable.length,
    errors: errored.length,
    gapCounts,
    perGame,
    maxAgeDays,
    afAssumed: af
      ? {
          maxPerGame: af.maxPerGame,
          probeColdStart: !!af.probeColdStart,
          probeSize: af.probeSize,
          probeMaxSellers: af.probeMaxSellers,
          perMarketStock: af.perMarketStock,
        }
      : null,
    disagreements: scoredDisagree.map((r) => ({
      game: r.game,
      campaignId: r.campaignId,
      decidedAt: r.decidedAt,
      legacyDecision: r.legacyDecision,
      detail: r.detail,
    })),
    rows,
  };
}

module.exports = {
  replayDecision,
  replayHistory,
  reconstructInputs,
  salesInputsFor,
  researchInputsFor,
  probeGateFor,
  summarise,
  FIDELITY,
  SNAPSHOT_RETENTION_DAYS,
  DEFAULT_MAX_AGE_DAYS,
};
