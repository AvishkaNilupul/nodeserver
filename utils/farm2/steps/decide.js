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
// The action-class table and the two engines' decision vocabularies. This used
// to be written out twice IN THIS FILE (`classOf` for the stale branch,
// `actionClass` for the live one) with no shared definition — two copies of the
// rule that gates whether a lane may take over a real game.
const classes = require("../decisionClasses");

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

// ---------------------------------------------------------------------------
// Decision context.
//
// Legacy processCampaign receives a `ctx` the tick assembled once: the farm
// host and whether it answered, the manual-bot stash, the auto system's own
// account set, per-game archive coverage. The lane resolves the same things
// lazily here and memoises them in the cycle's shared hostCache, so several
// lanes running in one cycle never repeat a host sweep the legacy tick does
// once. A caller may also hand in a ready-made `ctx` (tests do; a future
// supervisor could), in which case nothing is fetched.
//
// Every one of these is a READ. Shadow mode's contract is "no writes, no
// spending"; the probe, the stash sweep and the config reads are exactly the
// reads the legacy engine performs each tick, routed through the cycle's SSH
// semaphore. A lane that skipped them would decide differently from the engine
// it is being measured against, and the comparison would be measuring the
// skip rather than the lane.
// ---------------------------------------------------------------------------

// Memoise an async read in the per-cycle cache. The PROMISE is stored, so two
// lanes asking at the same moment share one in-flight read.
function memo(hostCache, key, fn) {
  if (!hostCache) return fn();
  if (!hostCache.has(key)) hostCache.set(key, Promise.resolve().then(fn));
  return hostCache.get(key);
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const emptyStash = () => ({ map: new Map(), wildcard: new Set(), logins: new Set() });

// Legacy: `hostOnline = host ? await probeHost(host) : false`. No configured
// farm host is OFFLINE, not unknown — the legacy engine records
// skip_host_offline for every campaign in that state, and so must the lane.
async function resolveHostState({ af, cycle, hostCache }) {
  return memo(hostCache, "__farm2:host", async () => {
    const b = brain();
    const host = b.resolveFarmHost(af);
    if (!host) return { host: null, hostOnline: false };
    // probeHost carries the flap-tolerant retry the legacy engine learned the
    // hard way (three attempts, seconds apart, after one false negative rewrote
    // ~30 campaigns as unreachable). Fall back to a single readdir only if this
    // checkout's autoFarmer predates the export.
    const probe = () =>
      typeof b.probeHost === "function"
        ? b.probeHost(host)
        : require("../../botHosts")
            .readdir(host)
            .then(() => true);
    let hostOnline = false;
    try {
      hostOnline = !!(cycle ? await cycle.withHost(probe) : await probe());
    } catch {
      hostOnline = false;
    }
    return { host, hostOnline };
  });
}

// The manual-bot stash: every login deployed on a manual bot, and the games it
// farms. The legacy tick sweeps every config on every host once and uses an
// EMPTY stash when the farm host is offline. This is the most expensive read in
// the whole decision, so it is shared by every lane in the cycle.
async function resolveStash({ hostOnline, cycle, hostCache }) {
  if (!hostOnline) return emptyStash();
  return memo(hostCache, "__farm2:stash", async () => {
    const b = brain();
    if (typeof b.manualFarmMap !== "function") return emptyStash();
    // The same registry the legacy sweep excludes: every bot file any auto
    // task has ever registered, whatever that task's status is now.
    const AutoFarmTask = require("../../../models/AutoFarmTask");
    const rows = await AutoFarmTask.find({ "bots.0": { $exists: true } }, { bots: 1 }).lean();
    const autoKeys = new Set();
    for (const t of rows) {
      for (const bot of t.bots || []) autoKeys.add(bot.host + "|" + bot.file);
    }
    const sweep = () => b.manualFarmMap(autoKeys);
    try {
      return cycle ? await cycle.withHost(sweep) : await sweep();
    } catch {
      return emptyStash();
    }
  });
}

// Every account any auto task has ever been given — what the auto-lister can
// deliver from, and so what counts as the system's OWN stock. null means
// unknown, which the legacy gate reads conservatively (every non-stashed holder
// is credited). Passed straight through here for the same reason.
function resolveOwned({ hostCache }) {
  return memo(hostCache, "__farm2:owned", () => brain().ownedAccounts());
}

// The coverage gate's inputs for one game, from the same helpers and the same
// constants the legacy gate uses. `arch` may be supplied in legacy's
// ctx.archiveHolders shape ({ holders, stashed, other }); otherwise it comes
// from the exported one-game aggregation.
async function coverageFor(game, { stash, owned, arch, hostCache }) {
  const b = brain();
  const gameKey = String(game).toLowerCase();
  const holders =
    arch ||
    (await memo(hostCache, "__farm2:arch|" + gameKey, async () => {
      const m = await b.archiveHoldersByGame([game], stash.logins, owned);
      return m.get(gameKey) || { holders: 0, stashed: 0, other: 0 };
    }));
  const gameSpecificFarmers = stash.map.get(gameKey) ? stash.map.get(gameKey).size : 0;
  // Both constants are exported by the legacy engine. The fallbacks are their
  // current values and apply only if this checkout's autoFarmer predates the
  // export — a wildcard account cannot deliver every campaign at once, and the
  // manual fleet is the long-term stash, not stock for this campaign.
  const wildcardCap = Number.isFinite(b.WILDCARD_CREDIT_CAP) ? b.WILDCARD_CREDIT_CAP : 0;
  const countManual = b.COUNT_MANUAL_AS_COVERAGE === true;
  const manualFarmers = gameSpecificFarmers + Math.min(stash.wildcard.size, wildcardCap);
  const archiveHolders = holders.holders || 0;
  // Fail closed exactly as the legacy gate does: a NaN here would make every
  // comparison downstream false and read as "nothing is covered".
  const coveredRaw = countManual ? manualFarmers + archiveHolders : archiveHolders;
  return {
    manualFarmers,
    archiveHolders,
    stashHolders: holders.stashed || 0,
    otherHolders: holders.other || 0,
    covered: Number.isFinite(coveredRaw) ? coveredRaw : 0,
  };
}

// Free capacity: container slots first, then — ONLY when no slot is free —
// spare seats inside running bots, which costs one config read per container
// and so is paid only when it can change the answer. The legacy gate computes
// both from a tick-start host snapshot; the cycle's free-container count is
// the lane's equivalent of that snapshot.
async function seatCapacityFor({ host, af, cycle, hostCache }) {
  const b = brain();
  const perBot = Math.max(1, Number(af.accountsPerBot) || 1);
  let slotsFree;
  if (cycle && Number.isFinite(cycle.totalContainers)) {
    slotsFree = Math.max(0, cycle.totalContainers);
  } else {
    const active =
      typeof b.activeAutoBotCount === "function" ? await b.activeAutoBotCount({}) : 0;
    slotsFree = Math.max(0, (Number(af.maxAutoBots) || 0) - active);
  }
  if (slotsFree >= 1) return { seatCapacity: slotsFree * perBot, slotsFree, freeSeats: null };
  const freeSeats = await memo(
    hostCache,
    "__farm2:freeSeats|" + (host ? host.id : "-"),
    async () => {
      if (!host || typeof b.autoSeatCapacity !== "function") return 0;
      const read = () => b.autoSeatCapacity(host, af, {});
      try {
        return Number(cycle ? await cycle.withHost(read) : await read()) || 0;
      } catch {
        return 0;
      }
    },
  );
  return { seatCapacity: slotsFree * perBot + freeSeats, slotsFree, freeSeats };
}

// Reuse-only games (World of Tanks / UFL) never draw a fresh pool account. The
// legacy engine settles this at CLAIM time: claimPoolAccounts with recycledOnly
// finds nothing and executeTask rewrites the row as skip_reuse_only. A lane has
// to know at DECISION time, so this counts what that claim would find — the
// recycled pass of claimPoolAccounts, composed from its exported primitives.
//
// This is the one place this file leans on the SHAPE of a legacy query rather
// than calling it: if the recycled filter in claimPoolAccounts changes, this
// must change with it. The alternative was a claim with n=0, which claims
// nothing and therefore tells us nothing.
async function recycledPoolCount(game) {
  const b = brain();
  const { normGame } = require("../../gameLabel");
  const AvailableAccount = require("../../../models/AvailableAccount");
  const ready =
    typeof b.readyPoolQuery === "function" ? b.readyPoolQuery() : { status: "available" };
  return AvailableAccount.countDocuments({
    ...ready,
    claimedNote: new RegExp("^recycled after " + escapeRe(game) + "$", "i"),
    soldGames: { $ne: normGame(game) },
  });
}

// Decide one campaign.
//
// Returns a plain object describing the verdict. In shadow mode that object is
// the ENTIRE output — nothing is written to AutoFarmTask, no pool account is
// claimed, no host is written to — which is what lets a lane run against a live
// game that the legacy engine is still really farming.
//
// GATE ORDER IS THE LEGACY ORDER. The comparison is only meaningful if the two
// engines stop at the same gate for the same inputs, so the sequence below is
// processCampaign's, not a tidier one:
//
//   sellability -> host -> reuse-first -> time -> coverage -> pool floor ->
//   capacity -> reuse-only -> farm/probe
//
// Until this rewrite the lane implemented only the first and third of those,
// so on any campaign the legacy engine settled at one of the other six a live
// lane would have carried on and spent. That gap went unobserved because the
// shadow comparison it should have surfaced in was itself broken.
async function decideCampaign({ campaign, lane, cycle, af, shadow, hostCache, ctx }) {
  const game = campaign.game || campaign.name || "?";
  const af2 = af || settings.getAutoFarm();
  const b = brain();

  // --- 1. Sellability ------------------------------------------------------
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
  const hrs = campaign.endAt ? (new Date(campaign.endAt) - Date.now()) / 3600000 : Infinity;
  const common = {
    game,
    campaignId: campaign.campaignId,
    campaignName: campaign.name || "",
    campaignEndAt: campaign.endAt || null,
    demandScore,
    hadResearch: !!research,
    internalSales: sales.count,
    effectiveDemand: alloc.effective ?? null,
    hoursLeft: Number.isFinite(hrs) ? Math.round(hrs * 10) / 10 : null,
  };
  const skip = (decision, reason, extra = {}) => ({
    ...common,
    decision,
    wouldFarm: false,
    plannedAccounts: 0,
    targetAccounts: 0,
    reason,
    ...extra,
  });

  if (alloc.skip) {
    const budgetHold = alloc.probeBlocked && probeBudgetBlocked;
    return skip(
      budgetHold ? "skip_probe_budget" : "skip_low_demand",
      alloc.probeBlocked
        ? budgetHold
          ? `Untested market — ${Number(af2.probeMaxGames) || 0} probes already running (budget full); queued.`
          : "Untested market, but within the post-failure cooldown — no accounts spent."
        : `Effective demand ${alloc.demand} (market research + ${sales.count} own recent sales) — items for this game don't sell.`,
    );
  }

  // --- 2. Host gate --------------------------------------------------------
  // Before reuse-first, as in the legacy engine: an unreachable host cannot
  // restart a warm bot any more than it can take a fresh one.
  const hostState =
    ctx && Object.prototype.hasOwnProperty.call(ctx, "hostOnline")
      ? { host: ctx.host || null, hostOnline: !!ctx.hostOnline }
      : await resolveHostState({ af: af2, cycle, hostCache });
  if (!hostState.hostOnline) {
    return skip(
      "skip_host_offline",
      "Farm host " +
        (hostState.host ? hostState.host.label || hostState.host.id : "?") +
        " unreachable — will retry next tick.",
    );
  }

  // --- 3. Reuse-first ------------------------------------------------------
  // Checked BEFORE the time gate and the budget, because reuse costs no pool
  // accounts and no container slots, and warm bots carry accumulated watch
  // time that can finish a drop fresh accounts never could. A lane with a zero
  // account budget can still reuse; the legacy engine reuses in exactly this
  // situation.
  const reuse = await reuseCandidate(game, { cycle, hostCache });
  if (reuse) {
    return {
      ...common,
      decision: "reuse_existing",
      wouldFarm: reuse.accounts.length > 0,
      plannedAccounts: reuse.accounts.length,
      targetAccounts: reuse.accounts.length,
      reuseTaskId: reuse.taskId,
      reuseBots: reuse.bots.map((x) => x.container),
      // Reuse spends nothing from the cycle budget, so it is never "budget
      // limited" and must not be trimmed.
      budgetLimited: false,
      reason: reuse.reason,
    };
  }

  // --- 4. Time gate --------------------------------------------------------
  // FRESH-account path only, which is why it sits after reuse-first. Forced
  // games (multi-day events whose per-day campaigns are each shorter than the
  // floor) bypass it, and only it.
  const forced = typeof b.isForcedGame === "function" ? b.isForcedGame(game, af2) : false;
  if (hrs < af2.minHoursLeft && !forced) {
    return skip(
      "skip_ends_soon",
      "Campaign ends in " +
        Math.max(0, Math.round(hrs)) +
        "h (< " +
        af2.minHoursLeft +
        "h) and no warm bots to reuse — too late to farm with fresh accounts.",
    );
  }

  // --- 5. Coverage gate ----------------------------------------------------
  // How much of the tier target is ALREADY covered by unsold accounts of the
  // system's own holding this game's items. Only the uncovered remainder is
  // worth new accounts. This is the gate whose wildcard bug once silently
  // blocked all farming; it comes from the legacy helpers, not a rewrite.
  const stash =
    ctx && ctx.farmMap ? ctx.farmMap : await resolveStash({ hostOnline: true, cycle, hostCache });
  const owned =
    ctx && Object.prototype.hasOwnProperty.call(ctx, "owned")
      ? ctx.owned
      : await resolveOwned({ hostCache });
  const archFromCtx =
    ctx && ctx.archiveHolders && typeof ctx.archiveHolders.get === "function"
      ? ctx.archiveHolders.get(String(game).toLowerCase()) || { holders: 0, stashed: 0, other: 0 }
      : null;
  const cov = await coverageFor(game, { stash, owned, arch: archFromCtx, hostCache });
  const coverage = {
    manualFarmers: cov.manualFarmers,
    archiveHolders: cov.archiveHolders,
    stashHolders: cov.stashHolders,
    otherHolders: cov.otherHolders,
  };

  // Non-probe campaigns must at least fill every enabled market's shelf.
  const floor = alloc.probe ? 0 : Number(b.marketStockFloor(af2)) || 0;
  const wanted = Math.min(
    Math.max(Number(alloc.target) || 0, floor),
    alloc.cap || Number(af2.maxPerGame) || 0,
  );
  const uncovered = Math.max(0, wanted - cov.covered);
  if (uncovered < 1) {
    return skip(
      "skip_already_covered",
      "Demand target of " +
        wanted +
        " accounts is already covered by " +
        cov.archiveHolders +
        " unsold account(s) of its OWN holding this game's items. Not counted: " +
        cov.manualFarmers +
        " manual farmer(s), " +
        cov.stashHolders +
        " stashed holder(s), " +
        cov.otherHolders +
        " archive holder(s) it cannot sell.",
      { targetAccounts: wanted, coverage },
    );
  }

  // --- 6. Pool floor -------------------------------------------------------
  // The arbiter's sealed allowance is the lane's fair share of the spendable
  // pool, exactly as budgetMap is in the legacy tick. Fail closed alongside the
  // coverage gate: `target < 1` is false for NaN.
  const budget = cycle ? cycle.remainingAccounts(lane.gameKey) : uncovered;
  const target = Math.min(uncovered, budget);
  if (!Number.isFinite(target) || target < 1) {
    return skip(
      "skip_no_accounts",
      "Pool has no spendable accounts (reserve floor " +
        af2.poolReserve +
        " protects manual work) — will retry when the pool refills.",
      { targetAccounts: wanted, coverage },
    );
  }

  // --- 7. Capacity gate ----------------------------------------------------
  // Free SEATS, not just container slots: a running bot with a spare
  // TwitchUsers slot can absorb accounts without a new container.
  const cap = await seatCapacityFor({ host: hostState.host, af: af2, cycle, hostCache });
  if (cap.seatCapacity < 1) {
    return skip(
      "skip_no_capacity",
      "All " +
        af2.maxAutoBots +
        " auto-bot slots on " +
        (hostState.host ? hostState.host.label || hostState.host.id : "?") +
        " are busy and no running bot has a free seat — queued; retries when a " +
        "campaign ends and frees capacity.",
      // The legacy row keeps the intended plan on a capacity skip.
      { plannedAccounts: target, targetAccounts: wanted, coverage },
    );
  }

  // --- 8. Reuse-only -------------------------------------------------------
  // Settled by the legacy engine at claim time; the lane settles it here so a
  // shadow lane records what the legacy row will end up saying.
  const reuseOnly = (() => {
    try {
      return settings.isReuseOnlyGame(game);
    } catch {
      return false;
    }
  })();
  if (reuseOnly && (await recycledPoolCount(game)) < 1) {
    return skip(
      "skip_reuse_only",
      "Reuse-only game (" +
        game +
        "): no fresh pool accounts are ever spent here — only accounts already " +
        "farmed on this game. None of its own recycled accounts are free right " +
        "now; will retry when one recycles back to the pool.",
      { targetAccounts: wanted, coverage },
    );
  }

  // --- 9. Plan -------------------------------------------------------------
  // Trim to what free seats can hold, as the legacy plan does. targetAccounts
  // is the full tier target INCLUDING the market floor — the same `wanted` the
  // legacy row records, which is what backfill tops the task up toward and
  // what the replay harness rebuilds to check against.
  const planned = Math.min(target, cap.seatCapacity);
  return {
    ...common,
    decision: alloc.probe ? "probe" : "farm",
    wouldFarm: planned > 0,
    plannedAccounts: planned,
    targetAccounts: wanted,
    probe: !!alloc.probe,
    coldStart: !!alloc.coldStart,
    reuseOnly,
    coverage,
    budgetLimited: planned < wanted,
    reason:
      (alloc.tierNote || "") +
      (planned < wanted
        ? ` — trimmed to ${planned} of ${wanted} by this cycle's account budget and free seats`
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

  const classOf = classes.actionClass;

  if (ageMs > COMPARABLE_WINDOW_MS) {
    return {
      legacyDecision: legacy.decision,
      legacyPlanned: Number(legacy.plannedAccounts || 0),
      laneDecision: verdict.decision,
      lanePlanned: Number(verdict.plannedAccounts || 0),
      // Classes are still recorded on a stale row. They are not used for
      // agreement (agree stays null), but their PRESENCE marks the row as
      // scored by the current logic — without them a stale row is
      // indistinguishable from a pre-gate one and gets counted in both
      // buckets, making the "recorded vs comparable" explanation wrong.
      laneClass: classOf(verdict.decision),
      legacyClass: classOf(legacy.decision),
      stale: true,
      // Explicit reason code rather than leaving the caller to infer "why" from
      // a combination of flags. Same discipline as the presence checks: a row
      // states what happened to it, it is not read by elimination.
      comparability: "stale",
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
  const actionClass = classes.actionClass;
  const laneClass = actionClass(verdict.decision);
  const legacyClass = actionClass(legacy.decision);
  const sameClass = laneClass === legacyClass;
  const acctDelta =
    Number(verdict.plannedAccounts || 0) - Number(legacy.plannedAccounts || 0);

  // An unclassified decision on either side is NOT a disagreement — it is a
  // comparison we are not equipped to make. Scoring it as `false` would block
  // promotion on a reporting gap; scoring it as `true` would pass a lane on a
  // decision nobody classified. Both are wrong, so it is simply not evidence.
  if (laneClass === "unknown" || legacyClass === "unknown") {
    return {
      legacyDecision: legacy.decision,
      legacyPlanned: Number(legacy.plannedAccounts || 0),
      laneDecision: verdict.decision,
      lanePlanned: Number(verdict.plannedAccounts || 0),
      laneClass,
      legacyClass,
      stale: false,
      comparability: "unknown_class",
      legacyAgeHours: Math.round(ageMs / 3600000),
      agree: null,
    };
  }

  // Why did they differ? "12 disagreements" is not actionable on its own: a
  // disagreement caused by a gate the lane does not implement needs a feature,
  // one caused by the arbiter needs no action at all, and only the remainder
  // needs a human to work out which engine was right.
  const taxonomy = classes.classifyDisagreement(verdict.decision, legacy.decision);

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
    comparability: "comparable",
    // The taxonomy of the difference (agree / lane_missing_gate /
    // class_mismatch). `lane_missing_gate` is the important one: the lane's
    // decision vocabulary is a strict subset of the legacy engine's, so on any
    // campaign the legacy engine settles with a gate the lane does not
    // implement, the lane will disagree deterministically until that gate is
    // built. Reporting it as an ordinary disagreement sends an operator looking
    // for a bug that is really a missing feature.
    disagreementKind: taxonomy.kind,
    disagreementNote: taxonomy.note || "",
    laneCanEmitLegacy: classes.laneCanEmit(legacy.decision),
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
  // Re-exported so callers reading a diff do not need a second require to
  // interpret it, and so there remains exactly one definition of these.
  actionClass: classes.actionClass,
  LANE_DECISIONS: classes.LANE_DECISIONS,
  LEGACY_ONLY_DECISIONS: classes.LEGACY_ONLY_DECISIONS,
};
