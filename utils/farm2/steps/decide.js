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

// Reuse-first check: can this campaign be served by restarting the game's
// EXISTING warm bots instead of spending fresh pool accounts?
//
// This mirrors step 4 of the legacy processCampaign, and its absence was the
// first real defect the shadow trial caught. Without it the lane always reached
// for fresh accounts, so a recurring campaign on a game that already has warm
// bots (Albion Online, Black Desert and World of Tanks were ALL in exactly that
// state) would have claimed real pool accounts and burned container slots to do
// something strictly worse than what was already running.
//
// Reuse is close to free — the bots exist, the accounts already hold prior
// drops, and warm accounts carry accumulated watch time that fresh ones cannot
// match in a short campaign — so it must be checked BEFORE allocation, not as a
// fallback.
//
// The bot-file existence check is a host READ. Shadow mode's contract is "no
// writes, no spending"; reads are both allowed and necessary, because a reuse
// decision that skipped them would not match what a live lane would do and the
// comparison would be worthless. Reads go through the cycle's SSH semaphore and
// a per-cycle cache so several lanes cannot storm the Pi.
async function reuseCandidate(game, { cycle, hostCache }) {
  const b = brain();
  const hosts = require("../../botHosts");

  const reusable = await b.reusableTaskForGame(game);
  if (!reusable || !(reusable.bots || []).length) return null;

  // Retired bots (deleted container, config renamed .done-*) cannot be
  // restarted. Drop them; if none survive there is nothing to reuse.
  const live = [];
  for (const bot of reusable.bots || []) {
    const h = hosts.resolveHost(bot.host);
    if (!h) continue;
    const key = bot.host + "|" + bot.file;
    let exists = hostCache ? hostCache.get(key) : undefined;
    if (exists === undefined) {
      try {
        const read = () => hosts.exists(h, bot.file);
        exists = cycle ? await cycle.withHost(read) : await read();
      } catch {
        // Host unreachable — treat as not reusable rather than assuming a bot
        // is there. Claiming reuse against a bot we cannot see would produce a
        // task that farms nothing.
        exists = false;
      }
      if (hostCache) hostCache.set(key, exists);
    }
    if (exists) live.push(bot);
  }
  if (!live.length) return null;

  // Which of the reusable task's accounts are still free? An account already
  // assigned to another ACTIVE task is spoken for and must not be double-counted.
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const others = await AutoFarmTask.find(
    { status: "active", _id: { $ne: reusable._id } },
    { assignedAccounts: 1 },
  ).lean();
  const spokenFor = new Set();
  for (const t of others) {
    for (const u of t.assignedAccounts || []) spokenFor.add(String(u).toLowerCase());
  }
  const mine = (reusable.assignedAccounts || []).filter(
    (u) => !spokenFor.has(String(u).toLowerCase()),
  );

  return {
    taskId: reusable._id,
    bots: live,
    accounts: mine,
    reason:
      "Recurring campaign for a game we already farm — reusing existing bot" +
      (live.length > 1 ? "s" : "") +
      " (" +
      live.map((x) => x.container).join(", ") +
      ") with their " +
      mine.length +
      " accounts instead of spending new pool accounts.",
  };
}

// Decide one campaign.
//
// Returns a plain object describing the verdict. In shadow mode that object is
// the ENTIRE output — nothing is written to AutoFarmTask, no pool account is
// claimed, no host is written to — which is what lets a lane run against a live
// game that the legacy engine is still really farming.
async function decideCampaign({ campaign, lane, cycle, af, shadow, hostCache }) {
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

  // --- Reuse-first ---------------------------------------------------------
  // Checked BEFORE the budget, because reuse costs no pool accounts and no
  // container slots: a lane with a zero account budget can still reuse. That
  // ordering is the whole point — the legacy engine reuses in exactly this
  // situation, and a lane that fell through to "farm 0 accounts" would simply
  // stop farming a game that is currently being farmed fine.
  const reuse = await reuseCandidate(game, { cycle, hostCache });
  if (reuse) {
    return {
      ...common,
      decision: "reuse_existing",
      wouldFarm: reuse.accounts.length > 0,
      plannedAccounts: reuse.accounts.length,
      targetAccounts: reuse.accounts.length,
      reuseTaskId: reuse.taskId,
      reuseBots: reuse.bots.map((b) => b.container),
      hoursLeft: Number.isFinite(hrs) ? Math.round(hrs * 10) / 10 : null,
      // Reuse spends nothing from the cycle budget, so it is never "budget
      // limited" and must not be trimmed.
      budgetLimited: false,
      reason: reuse.reason,
    };
  }

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
// How recent a legacy decision must be to be worth comparing against.
//
// The legacy tick runs every 10 minutes, so anything decided within a few hours
// was made under substantially the same conditions. Beyond that the two engines
// are answering different questions.
const COMPARABLE_WINDOW_MS = 6 * 60 * 60 * 1000;

async function diffAgainstLegacy(verdict) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const legacy = await AutoFarmTask.findOne({
    game: verdict.game,
    campaignId: verdict.campaignId,
  })
    .select("decision plannedAccounts targetAccounts demandScore status reason decidedAt")
    .lean();
  if (!legacy) return null;

  // STALENESS GATE.
  //
  // Once the legacy engine acts on a campaign it never re-decides it — only
  // retryable skips come back round. So a lane deciding a campaign today is
  // routinely compared against a legacy decision made days ago, under
  // conditions that no longer exist. Every one of the first trial's ten
  // "disagreements" was this, and all ten were both engines being RIGHT for
  // their own moment:
  //
  //   legacy said `probe` 171h ago when a game was untested; the probe found no
  //   sales, so the lane now correctly says skip_low_demand
  //   legacy said `farm` 229h ago when the game had no bots; it created them, so
  //   the lane now correctly says reuse_existing
  //
  // Counting those as disagreement would block promotion forever on a
  // comparison that was never valid. Counting the stale AGREEMENTS is just as
  // wrong in the other direction — it inflates confidence. So a stale row is
  // reported as "not comparable" (agree: null), exactly like having no legacy
  // row at all, and the readiness gate ignores it.
  const legacyAt = legacy.decidedAt ? new Date(legacy.decidedAt).getTime() : 0;
  const ageMs = legacyAt ? Date.now() - legacyAt : Infinity;
  if (ageMs > COMPARABLE_WINDOW_MS) {
    return {
      legacyDecision: legacy.decision,
      legacyPlanned: Number(legacy.plannedAccounts || 0),
      laneDecision: verdict.decision,
      lanePlanned: Number(verdict.plannedAccounts || 0),
      stale: true,
      legacyAgeHours: Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null,
      agree: null,
    };
  }

  // Group decisions by the ACTION they cause, not by their string.
  //
  // The first version of this lumped "farm", "probe" and "reuse_existing"
  // together as one "act" class, and that hid the trial's first real finding:
  // the lane said "farm" (spend fresh pool accounts, burn a container slot)
  // while the legacy engine said "reuse_existing" (restart warm bots, spend
  // nothing) — reported as agreement, when in fact promoting that lane would
  // have made the system actively worse.
  //
  // Spending and reusing are different actions with different costs, so they
  // are different classes. Getting this wrong is not a cosmetic reporting bug:
  // the readiness gate is built on it.
  const actionClass = (d) => {
    if (d === "farm" || d === "probe") return "spend";
    if (d === "reuse_existing") return "reuse";
    return "skip";
  };
  const laneClass = actionClass(verdict.decision);
  const legacyClass = actionClass(legacy.decision);
  const sameClass = laneClass === legacyClass;
  const acctDelta =
    Number(verdict.plannedAccounts || 0) - Number(legacy.plannedAccounts || 0);

  return {
    legacyDecision: legacy.decision,
    legacyPlanned: Number(legacy.plannedAccounts || 0),
    legacyTarget: Number(legacy.targetAccounts || 0),
    legacyDemand: legacy.demandScore ?? null,
    laneDecision: verdict.decision,
    lanePlanned: Number(verdict.plannedAccounts || 0),
    laneClass,
    legacyClass,
    sameClass,
    stale: false,
    legacyAgeHours: Math.round(ageMs / 3600000),
    accountDelta: acctDelta,
    // "agree" is the headline the tab shows and what the readiness gate blocks
    // on. Account COUNTS may legitimately differ (the arbiter divides the pool
    // differently from a serial pass), so the delta is reported separately —
    // but the action class must match.
    agree: sameClass,
  };
}

module.exports = {
  decideCampaign,
  diffAgainstLegacy,
  probeGate,
  reuseCandidate,
  COMPARABLE_WINDOW_MS,
};
