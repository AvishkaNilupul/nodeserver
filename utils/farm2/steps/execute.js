// Lane step 3 — EXECUTE: turn an approved decision into real bots.
//
// This is the first step that spends anything, so it is also the first that can
// do damage. Two rules govern it:
//
//   1. It is UNREACHABLE from a shadow lane. The guard below is an assertion,
//      not a branch — if a shadow lane ever reaches this code that is a bug in
//      the lane runner, and failing loudly is much safer than quietly claiming
//      accounts on a lane whose entire contract is "changes nothing".
//
//   2. It does NOT reimplement the spending logic. autoFarmer.executeTask
//      already carries every guard that was learned the hard way:
//        * a re-check of the pool reserve floor at execution time, not just at
//          decision time
//        * a re-check of CONTAINER capacity — the term whose absence once let
//          31 containers exist under a maxAutoBots of 6
//        * reuse-only handling (World of Tanks / UFL never draw a fresh
//          account, and record a retryable skip when none of their own
//          recycled accounts are free)
//        * the subtle "throw WITHOUT marking failed" cases, because writing
//          "failed" on a transient pool shortage permanently bricks a plan
//          (failed is not retryable and the approve route only takes "planned")
//      So this step prepares the AutoFarmTask row and hands it over.
//
// The lane's contribution is the budget ceiling applied BEFORE the claim, and a
// durable record of what happened.

const settings = require("../../settings");
// The reuse inputs a reuse row records beside its sellability snapshot
// (utils/decisionInputs.js) — the same shape legacy's reuse record() writes.
const { buildReuseInputs, withReuseInputs } = require("../../decisionInputs");

function brain() {
  return require("../../autoFarmer");
}

// Write (or refresh) the AutoFarmTask row for this decision.
//
// The lane engine deliberately reuses AutoFarmTask rather than inventing a
// parallel task store: the Auto-farm page, the Drop Archive, the fulfiller, the
// allocation forecast and the legacy maintenance sweeps all read it. A task
// created by a lane must be indistinguishable from one created by the legacy
// engine, or half the system stops seeing it.
async function upsertTask(verdict, { dryRun = false } = {}) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  return AutoFarmTask.findOneAndUpdate(
    { game: verdict.game, campaignId: verdict.campaignId },
    {
      $set: {
        game: verdict.game,
        campaignId: verdict.campaignId,
        campaignName: verdict.campaignName || "",
        campaignEndAt: verdict.campaignEndAt || null,
        decision: verdict.decision,
        reason: verdict.reason || "",
        demandScore: verdict.demandScore ?? null,
        hadResearch: !!verdict.hadResearch,
        internalSales: verdict.internalSales || 0,
        plannedAccounts: verdict.plannedAccounts || 0,
        targetAccounts: verdict.targetAccounts || 0,
        status: "planned",
        dryRun: !!dryRun,
        decidedAt: new Date(),
        rescanRequested: false,
        // A probe's stop-loss anchor is written once and never moved, so only
        // stamp it when this is a probe that has not started before.
        ...(verdict.probe ? { probeStartedAt: new Date() } : {}),
        // The inputs this decision saw, in the shape the legacy engine records
        // (utils/decisionInputs.js), so replay treats a lane row like any other.
        ...(verdict.decisionInputs ? { decisionInputs: verdict.decisionInputs } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// ---------------------------------------------------------------------------
// Decide-time skips, written as the rows legacy writes.
//
// A live lane re-decides every campaign every cycle. Until this existed, a
// campaign it decided NOT to farm left no AutoFarmTask row at all: the decision
// lived only in FarmJob, so the Auto-farm tab showed nothing, replay had
// nothing to read, and the lane's retry state was invisible outside its own
// queue (FARM2-VERIFICATION §7.8). The World of Tanks incident (§11) fixed the
// rule for closing that: any row the lane writes must be a row legacy already
// produces, because legacy's fleet sweeps read status and act on it.
//
// So the mapping is the IDENTITY on `decision` — since the six gates shipped,
// the lane's skip vocabulary is legacy's — and per-decision on the FIELDS,
// copied from the record() calls in autoFarmer.processCampaign:
//
//   skip_low_demand / skip_probe_budget   demandScore = the EFFECTIVE demand
//                                          (alloc.demand — not the raw score),
//                                          hadResearch, internalSales
//   skip_host_offline / skip_ends_soon    demandScore raw, hadResearch,
//                                          internalSales
//   skip_already_covered                  the above + coverage
//   skip_no_accounts                      the above + coverage, plannedAccounts 0
//   skip_no_capacity                      the above + coverage, plannedAccounts
//                                          = the target it could not seat
//   skip_reuse_only                       the one edge. Legacy produces this at
//                                          CLAIM time by rewriting a farm/probe
//                                          row, so the row it leaves also has
//                                          that record's targetAccounts and
//                                          coverage, plus executedAt and dryRun
//                                          false. The lane decides it up front
//                                          and writes the same END state. Under
//                                          af.dryRun legacy never reaches the
//                                          claim — it records a planned farm —
//                                          so no legacy row corresponds, and the
//                                          lane writes nothing there.
//
// Every skip row is status "skipped" — the one status no sweep acts on — and
// carries the decisionInputs snapshot like every other row the lane writes.
// ---------------------------------------------------------------------------

const SKIP_WITH_COVERAGE = new Set([
  "skip_already_covered",
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_reuse_only",
]);

function legacySkipFields(verdict, af) {
  const classes = require("../decisionClasses");
  const d = verdict.decision;
  if (classes.actionClass(d) !== "skip") {
    throw new Error(`legacySkipFields: "${d}" is not a skip decision`);
  }
  const fields = {
    game: verdict.game,
    campaignId: verdict.campaignId,
    campaignName: verdict.campaignName || "",
    campaignEndAt: verdict.campaignEndAt || null,
    decision: d,
    status: "skipped",
    reason: verdict.reason || "",
    // record() writes the BLENDED effective demand on the sellability skip and
    // the raw market score everywhere else (FARM2-VERIFICATION §5.1).
    demandScore: classes.recordsEffectiveDemand(d)
      ? (verdict.effectiveDemand ?? null)
      : (verdict.demandScore ?? null),
    hadResearch: !!verdict.hadResearch,
    internalSales: verdict.internalSales || 0,
    dryRun: !!(af && af.dryRun),
    rescanRequested: false,
    decidedAt: new Date(),
    ...(verdict.decisionInputs ? { decisionInputs: verdict.decisionInputs } : {}),
  };
  if (SKIP_WITH_COVERAGE.has(d) && verdict.coverage) fields.coverage = verdict.coverage;
  if (d === "skip_no_accounts") fields.plannedAccounts = 0;
  if (d === "skip_no_capacity") fields.plannedAccounts = Number(verdict.plannedAccounts) || 0;
  if (d === "skip_reuse_only") {
    fields.plannedAccounts = 0;
    fields.targetAccounts = Number(verdict.targetAccounts) || 0;
    fields.dryRun = false;
    fields.executedAt = new Date();
  }
  return fields;
}

// Write a live lane's decide-time skip as the legacy row. Returns
// { written: true, previous } or { written: false, suppressed: <why> } —
// suppression is a normal outcome, never an error.
async function recordSkip({ verdict, lane, af, shadow }) {
  // The same two guards as executeDecision. A shadow lane changes nothing —
  // and the legacy engine is still farming a shadow lane's game and writing
  // this very (game, campaignId) row; an upsert here would overwrite legacy's
  // own decision with the lane's.
  if (shadow) {
    throw new Error(
      "recordSkip reached from a shadow lane — refusing to write; this is a lane-runner bug",
    );
  }
  if (!lane || lane.mode !== "live") {
    throw new Error(
      `recordSkip reached for lane "${lane && lane.game}" in mode "${lane && lane.mode}" — only a live lane writes rows`,
    );
  }

  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const af2 = af || settings.getAutoFarm();

  if (verdict.decision === "skip_reuse_only" && af2.dryRun) {
    return {
      written: false,
      suppressed:
        "dry-run: legacy would have recorded a planned farm and discovered reuse-only " +
        "emptiness at approval time — no legacy row corresponds to a decide-time skip here",
    };
  }

  // NEVER over a row that owns something. Legacy re-decides only rows that are
  // absent, skipped-and-retryable, rescan-requested or stranded; a planned,
  // active, completed, stopped or failed row is a task with a history and
  // possibly bots and accounts, and a $set of status "skipped" over it would
  // orphan those (the incident in §11 is what an unexpected row shape costs).
  // The pre-check is deterministic; the conditional filter plus the unique
  // (game, campaignId) index is the race backstop — a concurrent insert turns
  // the upsert into a duplicate-key error, which is treated as suppressed.
  const existing = await AutoFarmTask.findOne({
    game: verdict.game,
    campaignId: verdict.campaignId,
  })
    .select("status decision")
    .lean();
  if (existing && existing.status !== "skipped") {
    return {
      written: false,
      suppressed: `row is ${existing.status} (${existing.decision}) — a skip never overwrites a task that owns something`,
    };
  }

  const fields = legacySkipFields(verdict, af2);
  try {
    await AutoFarmTask.updateOne(
      { game: verdict.game, campaignId: verdict.campaignId, status: "skipped" },
      { $set: fields },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (e) {
    if (e && (e.code === 11000 || /duplicate key/i.test(e.message || ""))) {
      return { written: false, suppressed: "a non-skipped row appeared concurrently — left alone" };
    }
    throw e;
  }
  return { written: true, decision: verdict.decision, previous: existing ? existing.decision : null };
}

// Execute a REUSE decision: restart the game's existing warm bots rather than
// claiming fresh pool accounts.
//
// autoFarmer.executeTask is the FRESH-spend path and must not be used here — it
// would claim new accounts for a campaign that needs none. The legacy engine
// runs this restart inline inside processCampaign, so there is no exported
// helper to borrow; this mirrors that block.
//
// The account arithmetic is the subtle part and is deliberately stricter than
// the decide-time estimate. `assignedAccounts` is what autoLister derives
// listing quantity from, so copying the reused task's list wholesale would make
// two campaigns advertise the SAME accounts — stock that cannot be delivered
// twice, because pickDeliveryAccounts hands out any given login on one listing
// only. The buyer pays and there is nothing to fulfil. The bots really are
// shared; the sellable stock is not. So "spoken for" is computed against
// active AND planned tasks, matching the legacy execution path exactly.
async function executeReuse({ verdict, dryRun }) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const hosts = require("../../botHosts");
  const botFactory = require("../../botFactory");
  const botWaker = require("../../botWaker");
  const b = brain();

  const reusable = verdict.reuseTaskId
    ? await AutoFarmTask.findById(verdict.reuseTaskId).lean()
    : await b.reusableTaskForGame(verdict.game);
  if (!reusable) throw new Error("reuse target task no longer exists");

  const bots = (reusable.bots || []).filter((x) => x.container);
  if (!bots.length) throw new Error("reuse target has no bots left");

  // Recompute the deliverable account set at EXECUTION time — the decide-time
  // number can be stale by the time this runs. Same rule as the decide step
  // (steps/decide.reuseCandidate), including that this campaign's OWN row is
  // never a competitor for its own reuse: decide and execute must count the
  // same set, or the lane plans one number and spends another. Reaching here
  // with an own row that holds accounts does not happen in practice — an
  // active own row means the campaign was executed and lane.js stops before
  // enqueueing — so this is symmetry, not a behaviour change.
  const isOwnRow = require("./decide").ownRowMatcher(verdict.game, verdict.campaignId);
  const others = await AutoFarmTask.find(
    { status: { $in: ["active", "planned"] }, _id: { $ne: reusable._id } },
    { assignedAccounts: 1, game: 1, campaignId: 1 },
  ).lean();
  const held = new Set((reusable.assignedAccounts || []).map((u) => String(u).toLowerCase()));
  const spokenFor = new Set();
  const competitors = [];
  let ownOverlap = null;
  for (const o of others) {
    let overlap = 0;
    for (const u of o.assignedAccounts || []) if (held.has(String(u).toLowerCase())) overlap += 1;
    if (isOwnRow(o)) {
      ownOverlap = overlap;
      continue;
    }
    for (const u of o.assignedAccounts || []) spokenFor.add(String(u).toLowerCase());
    if (overlap) competitors.push(o._id);
  }
  const mine = (reusable.assignedAccounts || []).filter(
    (u) => !spokenFor.has(String(u).toLowerCase()),
  );

  // What THIS recompute counted on, recorded on whichever row is written
  // below — the execution-time numbers, since they are what the row's
  // assignedAccounts reflect. Rides only on a verdict that carries the
  // sellability snapshot; reuse inputs never travel without it.
  const recorded = (dry) =>
    verdict.decisionInputs
      ? {
          decisionInputs: withReuseInputs(
            verdict.decisionInputs,
            buildReuseInputs({
              sourceTaskId: reusable._id,
              sourceHeld: (reusable.assignedAccounts || []).length,
              free: mine.length,
              competitors,
              ownRowExcluded: ownOverlap,
              dryRun: dry,
            }),
          ),
        }
      : {};

  if (dryRun) {
    await upsertTask(
      {
        ...verdict,
        plannedAccounts: mine.length,
        targetAccounts: mine.length,
        ...recorded(true),
      },
      { dryRun: true },
    );
    return {
      dryRun: true,
      reuse: true,
      wouldRestart: bots.map((x) => x.container),
      wouldReuseAccounts: mine.length,
    };
  }

  // NOTHING THIS CAMPAIGN COULD SELL: every account on the warm bots is already
  // advertised by another live task. Restarting the bots anyway and recording
  // an ACTIVE row with zero accounts is what this step used to do — and it is
  // not harmless. Legacy's fleet sweeps read status "active" and act on it:
  // on 2026-09-04 three World of Tanks campaigns arrived within two seconds,
  // the first reused all 18 warm accounts, the other two found them spoken for
  // and were written as ACTIVE with none, and backfillActiveTasks then read
  // both as "under target" and topped each up with 18 FRESH pool accounts — 36
  // on a reuse-only game, all deployed, none recoverable.
  //
  // Legacy's own inline reuse would produce the same empty row here, but it
  // immediately tops it up from its budget through executeTask, whose
  // reuse-only branch refuses fresh accounts. The lane has no such top-up, so
  // the empty row would stand. The rule this fixes into place: any row shape
  // the lane writes must be one legacy already produces, and an ACTIVE task
  // with no accounts is not one of them.
  //
  // So: touch no host, and record what legacy records for "nothing to spend" —
  // skip_reuse_only on a reuse-only game (exactly what executeTask's reuse-only
  // branch writes), skip_no_accounts otherwise. Both are RETRYABLE; the lane
  // re-decides every cycle and reuses the moment an account frees up.
  if (!mine.length) {
    const reuseOnly = (() => {
      try {
        return settings.isReuseOnlyGame(verdict.game);
      } catch {
        return false;
      }
    })();
    const held = (reusable.assignedAccounts || []).length;
    const decision = reuseOnly ? "skip_reuse_only" : "skip_no_accounts";
    const reason = reuseOnly
      ? `Reuse-only game (${verdict.game}): all ${held} account(s) on its warm bots are already ` +
        "assigned to another live task, and no fresh pool account is ever spent here — nothing " +
        "this campaign could sell; will retry when one frees up."
      : `All ${held} account(s) on the game's warm bots are already assigned to another live task — ` +
        "nothing this campaign could sell without spending fresh accounts it has no budget for; " +
        "will retry when one frees up.";
    const task = await AutoFarmTask.findOneAndUpdate(
      { game: verdict.game, campaignId: verdict.campaignId },
      {
        $set: {
          game: verdict.game,
          campaignId: verdict.campaignId,
          campaignName: verdict.campaignName || "",
          campaignEndAt: verdict.campaignEndAt || null,
          decision,
          status: "skipped",
          reason,
          demandScore: verdict.demandScore ?? null,
          hadResearch: !!verdict.hadResearch,
          internalSales: verdict.internalSales || 0,
          bots: [],
          assignedAccounts: [],
          plannedAccounts: 0,
          targetAccounts: 0,
          error: "",
          dryRun: false,
          decidedAt: new Date(),
          executedAt: new Date(),
          rescanRequested: false,
          // Carries the reuse inputs too: `free: 0` and WHICH live tasks held
          // the accounts is the record of why this campaign got nothing.
          ...recorded(false),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return {
      reuse: true,
      skipped: true,
      decision,
      taskId: task._id,
      restarted: [],
      skippedParked: [],
      failed: [],
      accounts: 0,
      reason,
    };
  }

  // NEVER restart a container the RAM saver deliberately parked.
  //
  // utils/botWaker.js parks idle containers to save memory (~130MB each) and
  // keeps a registry of what IT stopped, along with the wake logic — campaign
  // grace windows, Stream Scout liveness, the idle-no-campaign case. Starting a
  // parked container here would bypass all of that and undo the saving on the
  // very next cycle, which is precisely the "two engines fighting over the same
  // containers" failure this engine exists to avoid.
  //
  // botWaker owns waking. If a parked bot's game has a live campaign, its own
  // wake pass will start it — with the liveness checks this step does not have.
  // So a parked bot is skipped, not fought over.
  let parked = new Set();
  try {
    const reg = await botWaker.readRegistry();
    parked = new Set(Object.keys(reg || {}));
  } catch {
    // Registry unreadable: assume nothing is parked rather than refusing to
    // start anything. The failure mode of a needless start (a no-op on a
    // running container) is far milder than never farming.
  }

  const started = [];
  const failed = [];
  const skippedParked = [];
  for (const bot of bots) {
    if (parked.has(bot.host + "|" + bot.container)) {
      skippedParked.push(bot.container);
      continue;
    }
    try {
      await botFactory.startContainer(hosts.resolveHost(bot.host), bot.container);
      started.push(bot.container);
    } catch (e) {
      failed.push(bot.container + ": " + e.message);
    }
  }

  const task = await AutoFarmTask.findOneAndUpdate(
    { game: verdict.game, campaignId: verdict.campaignId },
    {
      $set: {
        game: verdict.game,
        campaignId: verdict.campaignId,
        campaignName: verdict.campaignName || "",
        campaignEndAt: verdict.campaignEndAt || null,
        decision: "reuse_existing",
        // A restart that started nothing is a real failure, not a quiet success.
        status: started.length ? "active" : "failed",
        reason: verdict.reason || "",
        demandScore: verdict.demandScore ?? null,
        hadResearch: !!verdict.hadResearch,
        internalSales: verdict.internalSales || 0,
        bots: bots.map((x) => ({ ...x, reused: true, shared: true })),
        assignedAccounts: mine,
        plannedAccounts: mine.length,
        targetAccounts: mine.length,
        error: failed.join("; "),
        dryRun: false,
        decidedAt: new Date(),
        executedAt: new Date(),
        rescanRequested: false,
        ...recorded(false),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (!started.length && !skippedParked.length) {
    throw new Error("no bot could be restarted: " + (failed.join("; ") || "unknown"));
  }

  return {
    reuse: true,
    taskId: task._id,
    restarted: started,
    // Reported, not treated as an error: botWaker parked these on purpose and
    // owns waking them when their game's campaign warrants it.
    skippedParked,
    failed,
    accounts: mine.length,
  };
}

// Execute one decision. Returns a plain summary; throws on real failure so the
// job queue can retry it on its own backoff.
async function executeDecision({ verdict, lane, cycle, af, shadow }) {
  // Rule 1 — the shadow assertion.
  if (shadow) {
    throw new Error(
      "execute reached from a shadow lane — refusing to spend accounts; this is a lane-runner bug",
    );
  }
  if (lane.mode !== "live") {
    throw new Error(
      `execute reached for lane "${lane.game}" in mode "${lane.mode}" — only a live lane may spend`,
    );
  }

  const b = brain();
  const af2 = af || settings.getAutoFarm();

  // The engine's own dry-run flag still applies: an operator may run the whole
  // system in dry-run, and a live lane must honour that exactly as the legacy
  // engine does.
  const dryRun = !!af2.dryRun;

  // Reuse takes a completely different execution path from a fresh spend:
  // restart the warm bots, claim nothing. Dispatched before anything else
  // because routing a reuse decision into executeTask would claim fresh pool
  // accounts for a campaign that needs none — the defect the shadow trial found.
  if (verdict.decision === "reuse_existing") {
    const run = () => executeReuse({ verdict, dryRun });
    return cycle ? await cycle.withHost(run) : await run();
  }

  const task = await upsertTask(verdict, { dryRun });

  if (dryRun) {
    // Mirror the legacy dry-run behaviour: record what WOULD have happened and
    // spend nothing.
    //
    // Deliberately returns BEFORE the host is resolved. A dry run never
    // contacts a host, so requiring one would make the preview fail on exactly
    // the occasions it is most useful — a host outage, or a machine where the
    // farm host is not configured at all.
    return {
      dryRun: true,
      taskId: task._id,
      wouldSpend: verdict.plannedAccounts || 0,
      decision: verdict.decision,
    };
  }

  const host = b.resolveFarmHost(af2);
  if (!host) throw new Error("no farm host configured");

  // Hand over to the legacy executor, which owns claiming, capacity and bot
  // creation. ctx.hostState is deliberately omitted: the lane does not build a
  // fleet-wide host snapshot (that is the legacy tick's job), so executeTask
  // falls back to its own DB/host reads. Those reads go through the cycle's
  // SSH semaphore when one is available, so parallel lanes cannot storm the Pi.
  const run = () => b.executeTask(task, { af: af2, host });
  const result = cycle ? await cycle.withHost(run) : await run();

  return {
    taskId: task._id,
    decision: result && result.decision ? result.decision : verdict.decision,
    accounts: (result && result.accounts) || 0,
    bots: (result && result.bots) || [],
    host: host.id,
  };
}

module.exports = { executeDecision, executeReuse, upsertTask, recordSkip, legacySkipFields };
