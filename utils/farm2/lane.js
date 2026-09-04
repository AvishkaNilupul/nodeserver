// One game lane — the unit of isolation.
//
// A lane owns everything about a single game: its campaigns, its decisions, its
// verification, its retry clock and its errors. Nothing in this file may throw
// past runLane(); a lane that fails records the failure on its OWN row, backs
// off on its OWN schedule, and leaves every other lane untouched.
//
// That single property is the fix for the biggest structural flaw in the legacy
// engine, where one exception inside a ~900-line runOnce() costs the whole
// fleet a 10-minute tick.

const settings = require("../settings");
const jobs = require("./jobs");
const classes = require("./decisionClasses");
const decideStep = require("./steps/decide");
const verifyStep = require("./steps/verify");
const executeStep = require("./steps/execute");
const publishStep = require("./steps/publish");
const monitorStep = require("./steps/monitor");

// Backoff after consecutive failures, and the point at which a lane is parked
// for an operator to look at instead of retrying forever.
const BASE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const PAUSE_AFTER_FAILURES = 8;

function backoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return BASE_INTERVAL_MS;
  return Math.min(MAX_BACKOFF_MS, BASE_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 6));
}

// Live campaigns for this lane's game that are worth a decision.
//
// Mirrors the legacy engine's candidate query (active + ACTIVE + not ended, and
// never a no-claim game) but scoped to one game, which is the whole point: a
// lane never reads the fleet-wide campaign list.
async function candidatesFor(lane) {
  const TwitchCampaign = require("../../models/TwitchCampaign");
  const now = new Date();
  const rows = await TwitchCampaign.find({
    active: true,
    status: "ACTIVE",
    $or: [{ endAt: null }, { endAt: { $gt: now } }],
  }).lean();

  const key = settings.normGameName(lane.game);
  return rows.filter((c) => {
    if (!c.game) return false;
    if (settings.normGameName(c.game) !== key) return false;
    // No-claim games belong to the standalone no-claim system and must never be
    // touched here, exactly as the legacy engine excludes them.
    if (settings.isNoClaimGame(c.game)) return false;
    return true;
  });
}

// Drain this lane's due execute/publish/verify jobs.
//
// LIVE LANES ONLY. Every one of these steps has its own internal shadow
// assertion as well — defence in depth, because "a shadow lane spent accounts"
// is the single worst bug this engine could have.
//
// Each job is individually boundaried: one failing publish must not stop the
// next job in the queue, in exactly the same way one failing lane must not stop
// the next lane.
async function drainJobs(lane, { cycle, af, summary }) {
  const due = await jobs.claimDueForLane(lane.gameKey, 25, {
    kind: { $in: ["execute", "publish", "verify"] },
  });

  for (const job of due) {
    try {
      let result;
      if (job.kind === "execute") {
        const verdict = (job.payload && job.payload.verdict) || null;
        if (!verdict) throw new Error("execute job has no verdict payload");
        result = await executeStep.executeDecision({
          verdict,
          lane,
          cycle,
          af,
          shadow: false,
        });
        summary.executed.push({ game: lane.game, ...result });
      } else if (job.kind === "publish" && job.market === "primary") {
        result = await publishStep.publishPrimary({
          taskId: job.taskId,
          af,
          shadow: false,
          lane,
        });
        if (result && result.listed) summary.listed.push(result.listed);
      } else if (job.kind === "publish" && job.market === "secondaries") {
        result = await publishStep.publishSecondaries({
          taskId: job.taskId,
          shadow: false,
          lane,
        });
      } else if (job.kind === "verify") {
        result = await verifyStep.verifyTask(job.taskId);
      } else {
        // An unrecognised row (a kind added by a newer version, say) is parked
        // rather than retried forever against a handler that does not exist.
        await jobs.finish(job, { unhandled: job.kind, market: job.market }, { status: "skipped" });
        continue;
      }
      await jobs.finish(job, result || {});
    } catch (e) {
      summary.errors.push(`${job.kind}${job.market ? "/" + job.market : ""}: ${e.message}`);
      await jobs.fail(job, e).catch(() => {});
    }
  }
  return due.length;
}

// Run one lane to completion. Never throws.
async function runLane(lane, { cycle, af, hostCache }) {
  const FarmLane = require("../../models/FarmLane");
  const started = Date.now();
  const shadow = lane.mode === "shadow";
  const summary = {
    game: lane.game,
    mode: lane.mode,
    campaigns: 0,
    decisions: [],
    executed: [],
    alreadyExecuted: 0,
    // Decide-time skips written to AutoFarmTask as legacy rows (live lanes
    // only), and those suppressed because the row already owns something.
    skipsRecorded: 0,
    skipsSuppressed: 0,
    listed: [],
    jobsDrained: 0,
    monitor: null,
    audit: null,
    errors: [],
  };

  await FarmLane.updateOne(
    { _id: lane._id },
    { $set: { state: "running", lastRunAt: new Date() } },
  ).catch(() => {});

  try {
    // --- DECIDE ------------------------------------------------------------
    const campaigns = await candidatesFor(lane);
    summary.campaigns = campaigns.length;

    for (const c of campaigns) {
      // Per-campaign error boundary INSIDE the lane: one malformed campaign
      // must not cost this lane its other campaigns, the same way one lane must
      // not cost the fleet.
      let job = null;
      try {
        job = await jobs.enqueue({
          lane: lane.game,
          laneKey: lane.gameKey,
          kind: "decide",
          campaignId: c.campaignId,
          shadow,
          payload: { campaignName: c.name || "", endAt: c.endAt || null },
        });
        // enqueue returns the EXISTING row when one is already in flight; only
        // drive a job this pass actually owns.
        if (!job) continue;
        const claimed = await jobs.claimNext({ _id: job._id });
        if (!claimed) continue;

        const verdict = await decideStep.decideCampaign({
          campaign: c,
          lane,
          cycle,
          af,
          shadow,
          hostCache,
        });

        // In shadow mode the verdict is compared against what the legacy engine
        // actually did. That diff is the evidence for flipping this lane live.
        const diff = shadow ? await decideStep.diffAgainstLegacy(verdict) : null;

        await jobs.finish(claimed, { verdict, diff });
        summary.decisions.push({ ...verdict, diff });

        // LIVE lanes write their decide-time skips to AutoFarmTask as the rows
        // legacy writes (steps/execute.recordSkip), so the Auto-farm tab, replay
        // and the retry picture are the same whichever engine owns a game.
        // Shadow lanes write nothing: the legacy engine is still farming their
        // game and owns its (game, campaignId) rows. A failure to record is
        // noted on the lane and never fails the decision itself.
        if (
          !shadow &&
          lane.mode === "live" &&
          !verdict.wouldFarm &&
          classes.actionClass(verdict.decision) === "skip"
        ) {
          try {
            const rec = await executeStep.recordSkip({ verdict, lane, af, shadow: false });
            if (rec.written) summary.skipsRecorded += 1;
            else summary.skipsSuppressed += 1;
          } catch (e) {
            summary.errors.push(`${c.campaignId}: record skip: ${e.message}`);
          }
        }

        if (verdict.wouldFarm && !shadow) {
          // LIVE mode only: spend the granted budget and queue execution.
          // Shadow lanes stop here by contract — nothing below this line may
          // run without the operator having flipped the lane to live.
          //
          // But only if this campaign has not ALREADY been executed. The legacy
          // engine treats a campaign it has acted on as settled and never
          // revisits it; without this check the lane re-decided and re-executed
          // the same live campaign every cycle, which meant a `docker start` on
          // its containers every few minutes — a no-op on a running container,
          // but pointless SSH churn that would also fight the RAM saver, and
          // real load once several lanes are live.
          const AutoFarmTask = require("../../models/AutoFarmTask");
          const alreadyDone = await AutoFarmTask.findOne({
            game: lane.game,
            campaignId: c.campaignId,
            status: { $in: ["active", "completed"] },
            executedAt: { $ne: null },
          })
            .select("_id")
            .lean();

          if (alreadyDone) {
            summary.alreadyExecuted += 1;
          } else {
            const take = cycle ? cycle.spendAccounts(lane.gameKey, verdict.plannedAccounts) : 0;
            await jobs.enqueue({
              lane: lane.game,
              laneKey: lane.gameKey,
              kind: "execute",
              campaignId: c.campaignId,
              shadow: false,
              payload: { verdict, granted: take },
            });
          }
        }
      } catch (e) {
        summary.errors.push(`${c.campaignId}: ${e.message}`);
        if (job) await jobs.fail(job, e).catch(() => {});
      }
    }

    // --- EXECUTE / PUBLISH (live lanes only) -------------------------------
    // Drained AFTER the decide phase so work queued this cycle can run in the
    // same cycle rather than waiting for the next one.
    if (!shadow && lane.mode === "live") {
      try {
        summary.jobsDrained = await drainJobs(lane, { cycle, af, summary });
      } catch (e) {
        summary.errors.push("drain: " + e.message);
      }
    }

    // --- MONITOR + VERIFY (drop checker) -----------------------------------
    // Read-only with respect to farming in every mode, so a shadow lane audits
    // the inventory the LEGACY engine is managing right now. That is what makes
    // the tab useful on day one rather than only after a lane goes live. In a
    // live lane it also queues the publish work for the next drain.
    try {
      summary.monitor = await monitorStep.monitorLane(lane, { jobs, shadow });
    } catch (e) {
      summary.errors.push("monitor: " + e.message);
    }
    try {
      summary.audit = await verifyStep.auditLane(lane);
    } catch (e) {
      summary.errors.push("audit: " + e.message);
    }

    // --- Bookkeeping -------------------------------------------------------
    const hadError = summary.errors.length > 0;
    const failures = hadError ? (lane.consecutiveFailures || 0) + 1 : 0;
    const next = new Date(Date.now() + backoffMs(failures));

    await FarmLane.updateOne(
      { _id: lane._id },
      {
        $set: {
          state: failures >= PAUSE_AFTER_FAILURES ? "paused" : "idle",
          nextRunAt: next,
          lastDurationMs: Date.now() - started,
          consecutiveFailures: failures,
          lastError: hadError ? summary.errors.join("; ").slice(0, 500) : "",
          lastErrorAt: hadError ? new Date() : lane.lastErrorAt || null,
          ...(hadError ? {} : { lastOkAt: new Date() }),
          "lastBudget.accounts": cycle ? cycle.grantFor(lane.gameKey).accounts : 0,
          "lastBudget.seats": cycle ? cycle.grantFor(lane.gameKey).seats : 0,
          "lastBudget.grantedAt": new Date(),
          "lastBudget.reason": cycle ? cycle.reason : "",
        },
        $inc: {
          "counters.runs": 1,
          "counters.decisions": summary.decisions.length,
          "counters.executions": summary.executed.length,
          "counters.listings": summary.listed.length,
          "counters.failures": hadError ? 1 : 0,
        },
      },
    ).catch(() => {});

    return summary;
  } catch (e) {
    // The outer boundary. Reaching here means a bug in the lane runner itself
    // rather than in a step; record it and back off, but never propagate — the
    // supervisor must keep dispatching the other lanes.
    const failures = (lane.consecutiveFailures || 0) + 1;
    await FarmLane.updateOne(
      { _id: lane._id },
      {
        $set: {
          state: failures >= PAUSE_AFTER_FAILURES ? "paused" : "error",
          lastError: String(e.message || e).slice(0, 500),
          lastErrorAt: new Date(),
          consecutiveFailures: failures,
          nextRunAt: new Date(Date.now() + backoffMs(failures)),
          lastDurationMs: Date.now() - started,
        },
        $inc: { "counters.runs": 1, "counters.failures": 1 },
      },
    ).catch(() => {});
    summary.errors.push("lane: " + e.message);
    return summary;
  }
}

module.exports = {
  runLane,
  drainJobs,
  candidatesFor,
  backoffMs,
  BASE_INTERVAL_MS,
  PAUSE_AFTER_FAILURES,
};
