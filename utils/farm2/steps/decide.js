// Lane step 1 — DECIDE: should this campaign be farmed, and with how many
// accounts?
//
// This step deliberately contains NO economics of its own. Every number comes
// from utils/autoFarmer.js's exported helpers, because that logic is the
// hard-won part of the system: the demand tiers, the internal-sales boost, the
// price factor, the cold-start probe gate and the per-game cap all encode bugs
// that were found and fixed the expensive way (phantom demand counting stock
// claims as sales, the coverage-gate wildcard, the probe stop-loss).
//
// Reimplementing any of it here would create a second source of truth that
// silently drifts from the Auto-farm page and the allocation forecast, and
// would reintroduce those bugs one at a time. So: the lane engine owns
// SCHEDULING and ISOLATION; the legacy module remains the brain.
//
// What this step adds is that the decision is now a durable, inspectable record
// with its own retry clock, instead of a line in an in-memory progress array.

const settings = require("../../settings");

// Load the legacy engine lazily. autoFarmer pulls in a wide dependency graph
// (and, on prod, the catalog integration) and requires autoLister lazily itself
// to dodge a cycle — requiring it at module load here would risk reintroducing
// one through a different path.
function brain() {
  return require("../../autoFarmer");
}

// Mirror of the legacy engine's cold-start probe gate. Kept as a thin wrapper
// over the same AutoFarmTask queries so a probe decision made in a lane matches
// the one the legacy engine would have made for the same campaign.
async function probeGate(game, af) {
  if (!af.probeColdStart) return { probeAllowed: true, probeBudgetBlocked: false };
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const cooldownCut = new Date(
    Date.now() - Math.max(0, Number(af.probeCooldownDays) || 0) * 86400000,
  );
  const recentlyFailed = await AutoFarmTask.exists({
    game,
    probeOutcome: "expired",
    completedAt: { $gte: cooldownCut },
  });
  const otherProbes = await AutoFarmTask.countDocuments({
    decision: "probe",
    status: { $in: ["active", "planned"] },
    game: { $ne: game },
  });
  const underBudget = otherProbes < (Number(af.probeMaxGames) || 0);
  return {
    probeAllowed: !recentlyFailed && underBudget,
    probeBudgetBlocked: !recentlyFailed && !underBudget,
  };
}

// Decide one campaign.
//
// Returns a plain object describing the verdict. In shadow mode that object is
// the ENTIRE output — nothing is written to AutoFarmTask, no pool account is
// claimed, no host is touched — which is what lets a lane run against a live
// game that the legacy engine is still really farming.
async function decideCampaign({ campaign, lane, cycle, af, shadow }) {
  const game = campaign.game || campaign.name || "?";
  const af2 = af || settings.getAutoFarm();
  const b = brain();

  // --- Sellability ---------------------------------------------------------
  // Shadow lanes use the READ-ONLY research lookup. freshResearchForGame can
  // trigger a live marketplace re-scan, which is a real side effect (API spend,
  // rate-limit budget) and must not happen from a mode whose contract is
  // "changes nothing". A live lane wants the freshest data and pays for it.
  const research =
    shadow || typeof b.freshResearchForGame !== "function"
      ? await b.researchForGame(game)
      : await b.freshResearchForGame(game);
  const salesRaw = await b.internalSalesForGame(game);
  const sales = b.salesOf(salesRaw);

  const { probeAllowed, probeBudgetBlocked } = await probeGate(game, af2);
  const alloc = b.demandAllocation(research, af2, salesRaw, { probeAllowed });

  const demandScore = research ? Number(research.demandScore || 0) : null;
  const common = {
    game,
    campaignId: campaign.campaignId,
    campaignName: campaign.name || "",
    campaignEndAt: campaign.endAt || null,
    demandScore,
    hadResearch: !!research,
    internalSales: sales.count,
    effectiveDemand: alloc.effective ?? null,
  };

  if (alloc.skip) {
    const budgetHold = alloc.probeBlocked && probeBudgetBlocked;
    return {
      ...common,
      decision: budgetHold ? "skip_probe_budget" : "skip_low_demand",
      wouldFarm: false,
      plannedAccounts: 0,
      targetAccounts: 0,
      reason: alloc.probeBlocked
        ? budgetHold
          ? `Untested market — ${Number(af2.probeMaxGames) || 0} probes already running (budget full); queued.`
          : "Untested market, but within the post-failure cooldown — no accounts spent."
        : `Effective demand ${alloc.demand} (market research + ${sales.count} own recent sales) — items for this game don't sell.`,
    };
  }

  // --- Time window ---------------------------------------------------------
  // The 12h floor gates the FRESH-account path only: warm bots carry
  // accumulated watch time and can finish a drop that fresh accounts never
  // could, so reuse is checked before this bites. Forced games bypass it.
  const hrs = campaign.endAt
    ? (new Date(campaign.endAt) - Date.now()) / 3600000
    : Infinity;

  // --- Budget --------------------------------------------------------------
  // The arbiter's sealed allowance is the hard ceiling. alloc.target is what the
  // economics WANT; the grant is what the fleet can actually afford this cycle
  // once every other lane has been considered.
  const want = Math.max(0, Number(alloc.target) || 0);
  const allowed = cycle ? cycle.remainingAccounts(lane.gameKey) : want;
  const planned = Math.min(want, allowed);

  const reuseOnly = (() => {
    try {
      return settings.isReuseOnlyGame(game);
    } catch {
      return false;
    }
  })();

  return {
    ...common,
    decision: alloc.probe ? "probe" : "farm",
    wouldFarm: planned > 0,
    plannedAccounts: planned,
    targetAccounts: want,
    probe: !!alloc.probe,
    coldStart: !!alloc.coldStart,
    reuseOnly,
    hoursLeft: Number.isFinite(hrs) ? Math.round(hrs * 10) / 10 : null,
    budgetLimited: planned < want,
    reason:
      (alloc.tierNote || "") +
      (planned < want
        ? ` — trimmed to ${planned} of ${want} by this cycle's account budget`
        : ""),
  };
}

// Compare a lane's shadow verdict against what the LEGACY engine actually
// recorded for the same campaign. This is the core of the trial: a shadow lane
// is only trustworthy once its decisions agree with the engine that is really
// running the game.
//
// Returns null when there is nothing to compare against yet (the legacy engine
// has not decided this campaign), which is a normal transient state, not a
// mismatch.
async function diffAgainstLegacy(verdict) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const legacy = await AutoFarmTask.findOne({
    game: verdict.game,
    campaignId: verdict.campaignId,
  })
    .select("decision plannedAccounts targetAccounts demandScore status reason")
    .lean();
  if (!legacy) return null;

  // Group the decisions into farm-vs-skip intent. An exact string match is too
  // strict to be useful: "farm" and "probe" both mean "spend accounts here",
  // and the several skip_* reasons all mean "spend nothing". What matters for
  // trusting the lane is whether it would have taken the same ACTION.
  const intent = (d) => (d === "farm" || d === "probe" || d === "reuse_existing" ? "act" : "skip");
  const sameIntent = intent(legacy.decision) === intent(verdict.decision);
  const acctDelta =
    Number(verdict.plannedAccounts || 0) - Number(legacy.plannedAccounts || 0);

  return {
    legacyDecision: legacy.decision,
    legacyPlanned: Number(legacy.plannedAccounts || 0),
    legacyTarget: Number(legacy.targetAccounts || 0),
    legacyDemand: legacy.demandScore ?? null,
    laneDecision: verdict.decision,
    lanePlanned: Number(verdict.plannedAccounts || 0),
    sameIntent,
    accountDelta: acctDelta,
    // "agree" is the headline the tab shows. Account counts are allowed to
    // differ — the lane's budget arbiter divides the pool differently from the
    // legacy engine's serial pass, and that is by design — so agreement is
    // judged on intent, with the delta reported alongside for context.
    agree: sameIntent,
  };
}

module.exports = { decideCampaign, diffAgainstLegacy, probeGate };
