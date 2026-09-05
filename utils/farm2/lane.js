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
const notify = require("./notify");
const { recordAutoFarmEvent } = require("../autoFarmEventLog");
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

// The skips the legacy engine re-decides every tick. Read from the legacy
// module so the two cannot drift; the local copy is only for a checkout whose
// autoFarmer predates the export, and a test asserts the two are equal.
const RETRYABLE_FALLBACK = new Set([
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
  "skip_already_covered",
  "skip_reuse_only",
  "skip_probe_budget",
]);
function retryableSet() {
  try {
    const b = require("../autoFarmer");
    if (b.RETRYABLE instanceof Set) return b.RETRYABLE;
  } catch {
    /* fall through */
  }
  return RETRYABLE_FALLBACK;
}
function isStranded(task) {
  try {
    const b = require("../autoFarmer");
    if (typeof b.isStranded === "function") return b.isStranded(task);
  } catch {
    /* fall through */
  }
  if (!task) return false;
  if (task.status === "planned") return true;
  return task.status === "failed" && !(task.bots || []).length;
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

// Does this campaign need a decision this cycle?
//
// THE CHURN FIX. The lane used to decide EVERY live campaign EVERY cycle —
// 5,400 decide rows a day on prod, one campaign decided 177 times — while the
// legacy engine treats a campaign it has acted on as settled. Those
// re-decisions were pure cost: a live lane's alreadyDone check threw the
// verdict away at the execute step, and a shadow lane's verdict was compared
// against a legacy decision days old, which the staleness gate then discarded.
//
// So the lane now re-decides on exactly the legacy tick's triggers
// (utils/autoFarmer.js runOnce, the candidate filter):
//
//   no row yet                       — a new campaign
//   skipped with a RETRYABLE reason  — conditions may have changed on their own
//   rescanRequested                  — the operator asked for a fresh look
//   stranded (live mode only)        — a plan that never executed, or a failure
//                                      that owns nothing; re-deciding is free
//
// plus ONE shadow-only trigger, because a shadow lane exists to be compared:
//
//   the legacy engine decided this campaign recently and the lane has not yet
//   decided against THAT decision — the fresh pair the comparison lives on.
//   "Recently" is the comparison's own window (decide.COMPARABLE_WINDOW_MS);
//   deciding later than that produces a row the gate discards as stale.
//
// Everything else is settled: an executed campaign, a terminal skip, a
// completed task. Terminal skips (skip_low_demand, skip_ends_soon) are decided
// ONCE, as legacy decides them — the earlier "rewrite the skip row every
// cycle" behaviour is gone with the churn.
function decisionDue({ existing, shadow, af, lastLaneDecidedAt = null }) {
  if (!existing) return { due: true, why: "new" };
  if (existing.status === "skipped" && retryableSet().has(existing.decision)) {
    return { due: true, why: "retryable" };
  }
  if (existing.rescanRequested) return { due: true, why: "rescan" };
  if (!(af && af.dryRun) && isStranded(existing)) return { due: true, why: "stranded" };
  if (shadow) {
    const at = existing.decidedAt ? new Date(existing.decidedAt).getTime() : 0;
    const last = lastLaneDecidedAt ? new Date(lastLaneDecidedAt).getTime() : 0;
    if (at && Date.now() - at <= decideStep.COMPARABLE_WINDOW_MS && last < at) {
      return { due: true, why: "fresh legacy decision" };
    }
  }
  return { due: false, why: "settled" };
}

// The (game, campaignId) rows the legacy engine and the lane share, for the
// candidate filter — one query for the whole lane, never one per campaign.
async function existingRowsFor(lane, campaigns) {
  const AutoFarmTask = require("../../models/AutoFarmTask");
  if (!campaigns.length) return new Map();
  const rows = await AutoFarmTask.find(
    {
      game: lane.game,
      campaignId: { $in: campaigns.map((c) => c.campaignId) },
    },
    { campaignId: 1, status: 1, decision: 1, rescanRequested: 1, bots: 1, decidedAt: 1 },
  ).lean();
  return new Map(rows.map((r) => [String(r.campaignId), r]));
}

// When did this lane last finish deciding each campaign? Shadow lanes only —
// it is the "have we compared against this legacy decision yet" half of the
// shadow trigger above.
async function lastDecidedAtFor(lane, campaigns) {
  const FarmJob = require("../../models/FarmJob");
  if (!campaigns.length) return new Map();
  const rows = await FarmJob.aggregate([
    {
      $match: {
        laneKey: lane.gameKey,
        kind: "decide",
        status: "done",
        campaignId: { $in: campaigns.map((c) => String(c.campaignId)) },
      },
    },
    { $group: { _id: "$campaignId", at: { $max: "$finishedAt" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.at]));
}

// The Telegram line the legacy engine sends for the terminal skips it
// announces — and only those. skip_low_demand is announced once (legacy
// decides it once); skip_already_covered on the TRANSITION into covered, not
// on every re-confirmation (legacy gates it on isNewDecision for the same
// reason: it was ~485 identical messages a day). The other skips are silent in
// legacy and stay silent here.
function skipAnnouncement(verdict, previousDecision) {
  const d = verdict.decision;
  if (previousDecision === d) return null;
  if (d === "skip_low_demand") {
    const cooldown = /untested market/i.test(verdict.reason || "");
    return (
      "🤖 Auto-farm SKIP (lane) — " +
      verdict.game +
      "\n" +
      (cooldown
        ? "Untested market — probing held off (cooldown). No accounts spent."
        : "Effective demand " +
          (verdict.effectiveDemand ?? "?") +
          " (items not salable). No accounts spent.")
    );
  }
  if (d === "skip_already_covered") {
    const cov = verdict.coverage || {};
    const notCounted = (cov.manualFarmers || 0) + (cov.stashHolders || 0) + (cov.otherHolders || 0);
    return (
      "🤖 Auto-farm SKIP (lane) — " +
      verdict.game +
      "\nAlready covered: " +
      (cov.archiveHolders || 0) +
      " of its own unsold accounts ≥ target " +
      (verdict.targetAccounts || 0) +
      "." +
      (notCounted
        ? "\n(Not counted: " +
          (cov.manualFarmers || 0) +
          " manual farmer(s), " +
          (cov.stashHolders || 0) +
          " stashed holder(s), " +
          (cov.otherHolders || 0) +
          " archive holder(s) it cannot sell.)"
        : "")
    );
  }
  return null;
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
async function drainJobs(lane, { cycle, af, summary, hostCache }) {
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
          granted: Number(job.payload && job.payload.granted) || 0,
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
        result = await verifyStep.verifyTask(job.taskId, { cache: hostCache });
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
      // The same trail the legacy tick leaves when a campaign's execution
      // throws (runOnce's per-campaign catch): a task_failed event, unless the
      // executor already recorded one for this failure.
      if (job.kind === "execute" && !e.autoFarmEventRecorded) {
        await recordAutoFarmEvent({
          type: "task_failed",
          game: lane.game,
          campaignId: job.campaignId || "",
          count: 1,
          reason: e.message || String(e),
          actor: "farm2/lane",
        });
      }
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
    // True when THIS run tripped the lane into "paused" (the supervisor
    // releases ownership and alerts the operator).
    paused: false,
    campaigns: 0,
    // Campaigns the candidate filter left alone this cycle (settled).
    settled: 0,
    decisions: [],
    executed: [],
    alreadyExecuted: 0,
    // Decide-time skips written to AutoFarmTask as legacy rows (live lanes
    // only), and those suppressed because the row already owns something.
    skipsRecorded: 0,
    skipsSuppressed: 0,
    // Telegram lines sent for terminal skips (live lanes only).
    notified: 0,
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
    const existing = await existingRowsFor(lane, campaigns);
    const lastDecided = shadow ? await lastDecidedAtFor(lane, campaigns) : new Map();

    for (const c of campaigns) {
      const prior = existing.get(String(c.campaignId)) || null;
      const due = decisionDue({
        existing: prior,
        shadow,
        af,
        lastLaneDecidedAt: lastDecided.get(String(c.campaignId)) || null,
      });
      if (!due.due) {
        summary.settled += 1;
        continue;
      }

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
          payload: { campaignName: c.name || "", endAt: c.endAt || null, trigger: due.why },
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
        summary.decisions.push({ ...verdict, diff, trigger: due.why });

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
            if (rec.written) {
              summary.skipsRecorded += 1;
              // The owner's Telegram trail, as legacy keeps it: announce the
              // terminal verdicts, once, on the transition.
              const text = skipAnnouncement(verdict, rec.previous);
              if (text) {
                await notify.telegram(text);
                summary.notified += 1;
              }
            } else {
              summary.skipsSuppressed += 1;
            }
          } catch (e) {
            summary.errors.push(`${c.campaignId}: record skip: ${e.message}`);
          }
        }

        if (verdict.wouldFarm && !shadow) {
          // LIVE mode only: spend the granted budget and queue execution.
          // Shadow lanes stop here by contract — nothing below this line may
          // run without the operator having flipped the lane to live.
          //
          // But only if this campaign has not ALREADY been executed. The
          // candidate filter above already leaves settled campaigns alone;
          // this is the belt to that braces, because an execute on an active
          // campaign restarts containers and fights the RAM saver.
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
            // What this campaign draws from the lane's sealed allowance. A
            // fresh farm/probe spends its plan; a reuse spends nothing for the
            // accounts it reuses and draws only the TOP-UP it may add on top
            // (steps/decide.js), so a reused game never eats the budget of a
            // sibling that needs fresh accounts.
            const wanted =
              verdict.decision === "reuse_existing"
                ? verdict.topUpAllowed
                  ? Number(verdict.topUpWanted) || 0
                  : 0
                : Number(verdict.plannedAccounts) || 0;
            const take = cycle ? cycle.spendAccounts(lane.gameKey, wanted) : wanted;
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
        summary.jobsDrained = await drainJobs(lane, { cycle, af, summary, hostCache });
      } catch (e) {
        summary.errors.push("drain: " + e.message);
      }
    }

    // --- MONITOR + VERIFY (drop checker) -----------------------------------
    // Read-only with respect to farming in every mode, so a shadow lane audits
    // the inventory the LEGACY engine is managing right now. That is what makes
    // the tab useful on day one rather than only after a lane goes live. In a
    // live lane it also queues the publish work for the next drain.
    //
    // One verification per task per run: the monitor pass verifies, the audit
    // reuses its results. Both used to verify independently — two DropLog
    // aggregations and two Twitch campaign fetches per active task per cycle.
    let checks = null;
    try {
      const report = await monitorStep.monitorLane(lane, { jobs, shadow, cache: hostCache });
      checks = report.checks || null;
      delete report.checks;
      summary.monitor = report;
    } catch (e) {
      summary.errors.push("monitor: " + e.message);
    }
    try {
      summary.audit = await verifyStep.auditLane(lane, { checks, cache: hostCache });
    } catch (e) {
      summary.errors.push("audit: " + e.message);
    }

    // --- Bookkeeping -------------------------------------------------------
    const hadError = summary.errors.length > 0;
    const failures = hadError ? (lane.consecutiveFailures || 0) + 1 : 0;
    const next = new Date(Date.now() + backoffMs(failures));
    summary.paused = failures >= PAUSE_AFTER_FAILURES && lane.state !== "paused";

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
          "lastBudget.accounts": cycle ? cycle.grantFor(lane.gameKey).spentAccounts : 0,
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
    summary.paused = failures >= PAUSE_AFTER_FAILURES && lane.state !== "paused";
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
  decisionDue,
  skipAnnouncement,
  retryableSet,
  RETRYABLE_FALLBACK,
  backoffMs,
  BASE_INTERVAL_MS,
  PAUSE_AFTER_FAILURES,
};
