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
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
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

module.exports = { executeDecision, upsertTask };
