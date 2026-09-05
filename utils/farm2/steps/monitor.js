// Lane step 5 — MONITOR: watch this lane's active tasks and queue the next
// piece of work.
//
// WHAT THIS STEP DELIBERATELY DOES **NOT** DO, and why it matters.
//
// The legacy tick runs a set of maintenance sweeps: completeEndedTasks,
// backfillActiveTasks, reapRetiredBots, recycleSoldOutAccounts, repackAutoBots,
// expireStalePlans, reapDeadTokenAssignments. It is tempting to move a per-game
// slice of those into the lane, and that would be wrong today:
//
//   * They are inherently FLEET-WIDE. Reaping, repacking and recycling operate
//     on containers and on the shared account pool, not on one game. Repacking
//     consolidates accounts for several games into one container; a per-game
//     repack is not a smaller version of the same thing, it is a different and
//     more dangerous operation.
//   * They are NOT scoped by the ownership guard. That guard only stops the
//     legacy engine creating NEW tasks for an owned game — it deliberately
//     leaves existing tasks alone. So the legacy sweeps still complete, backfill
//     and reap tasks that a LANE created. That is a feature: it is what makes a
//     lane's tasks impossible to strand, in exactly the same way an in-flight
//     campaign survives promotion.
//   * Running both would mean two engines reaping the same containers. That is
//     the duplicate-sprawl failure mode all over again.
//
// So: the legacy engine remains the fleet's janitor, for lane-created tasks
// too. This step is a per-lane READ that reports health and enqueues the lane's
// own next steps (verify -> publish). Splitting the sweeps is a later phase and
// needs its own design, not a copy of this one.

const publishStep = require("./publish");
const verifyStep = require("./verify");

// Post-event listing window and the per-task re-check throttle.
//
// A task whose accounts completed the bundle only around the campaign's end
// is marked completed by completeEndedTasks before any sweep listed it, and
// the legacy auto-list sweep reads ACTIVE tasks only — so it was never listed
// at all. The lane's monitor looks back POST_EVENT_WINDOW_MS over its game's
// completed, unlisted tasks and queues a post-event listing for any with a
// deliverable full-bundle holder. Verification is a DropLog aggregation plus a
// Twitch campaign fetch per task, so each completed task is re-checked at most
// once per POST_EVENT_CHECK_MS (per process; a restart re-checks once).
const POST_EVENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const POST_EVENT_CHECK_MS = 6 * 60 * 60 * 1000;
const postEventChecked = new Map(); // taskId -> ms

// Inspect this lane's active tasks and decide what work to queue.
// Read-only with respect to farming; the only writes are job rows.
//
// Returns `checks` (Map taskId -> verifyTask result) alongside the report so
// the audit that follows in the same lane run can reuse them; `cache` is the
// per-cycle memo for campaign-item resolution.
async function monitorLane(lane, { jobs, shadow, cache = null }) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const tasks = await AutoFarmTask.find({
    game: lane.game,
    status: "active",
  })
    .select(
      "game campaignId campaignName assignedAccounts targetAccounts campaignEndAt listing status",
    )
    .lean();

  const report = {
    active: tasks.length,
    listable: 0,
    awaitingHoldings: 0,
    queuedPrimary: 0,
    queuedSecondaries: 0,
    endingSoon: 0,
    // Completed-but-unlisted tasks in the post-event window: how many were
    // (re-)checked this run, how many hold deliverable stock, how many were
    // queued for a post-event listing (live lanes only).
    postEventChecked: 0,
    postEventListable: 0,
    postEventQueued: 0,
    tasks: [],
    // Not serialised into the lane summary (lane.js strips it); consumed by
    // verify.auditLane in the same run.
    checks: new Map(),
  };

  for (const t of tasks) {
    const assigned = (t.assignedAccounts || []).length;
    const target = t.targetAccounts || 0;
    const hrsLeft = t.campaignEndAt
      ? (new Date(t.campaignEndAt) - Date.now()) / 3600000
      : null;
    if (hrsLeft !== null && hrsLeft < 12) report.endingSoon += 1;

    const { needsPrimary, needsSecondaries } = publishStep.publishNeeds(t);

    // Verification is what decides whether publishing is worth queueing at all.
    // Read-only, so it is safe in every mode — a shadow lane reports the same
    // finding without acting on it.
    let check = null;
    try {
      check = await verifyStep.verifyTask(t, { cache });
    } catch (e) {
      check = { ok: false, reason: "verify failed: " + e.message, verified: 0 };
    }
    report.checks.set(String(t._id), check);
    if (check.ok) report.listable += 1;
    else report.awaitingHoldings += 1;

    // Only a LIVE lane queues publish work. A shadow lane has now produced the
    // full finding — "this task is verified and unlisted" — without touching a
    // marketplace, which is precisely the audit value the trial is for.
    if (!shadow && lane.mode === "live" && check.ok) {
      if (needsPrimary) {
        await jobs.enqueue({
          lane: lane.game,
          laneKey: lane.gameKey,
          kind: "publish",
          market: "primary",
          campaignId: t.campaignId,
          taskId: t._id,
          shadow: false,
          payload: { verified: check.verified, assigned },
        });
        report.queuedPrimary += 1;
      } else if (needsSecondaries && !publishStep.secondariesSettledRecently(t._id)) {
        await jobs.enqueue({
          lane: lane.game,
          laneKey: lane.gameKey,
          kind: "publish",
          market: "secondaries",
          campaignId: t.campaignId,
          taskId: t._id,
          shadow: false,
          payload: {},
        });
        report.queuedSecondaries += 1;
      }
    }

    report.tasks.push({
      taskId: t._id,
      campaignId: t.campaignId,
      campaignName: t.campaignName || "",
      assigned,
      target,
      // Reported so the tab can show a task that never filled up. The legacy
      // backfill sweep is what actually tops it up.
      shortOfTarget: Math.max(0, target - assigned),
      hoursLeft: hrsLeft === null ? null : Math.round(hrsLeft * 10) / 10,
      verified: check.verified || 0,
      listable: !!check.ok,
      listed: !!(t.listing && t.listing.externalId),
      needsPrimary,
      needsSecondaries,
      note: check.reason || "",
    });
  }

  // --- Post-event: completed, never listed, still deliverable ---------------
  const ended = await AutoFarmTask.find({
    game: lane.game,
    status: "completed",
    completedAt: { $gte: new Date(Date.now() - POST_EVENT_WINDOW_MS) },
    "assignedAccounts.0": { $exists: true },
    $or: [{ "listing.externalId": "" }, { "listing.externalId": { $exists: false } }],
  })
    .select("game campaignId campaignName assignedAccounts campaignEndAt listing status completedAt")
    .lean();
  for (const t of ended) {
    const id = String(t._id);
    const last = postEventChecked.get(id) || 0;
    if (Date.now() - last < POST_EVENT_CHECK_MS) continue;
    postEventChecked.set(id, Date.now());
    report.postEventChecked += 1;
    let check;
    try {
      check = await verifyStep.verifyTask(t, { cache });
    } catch (e) {
      check = { ok: false, reason: "verify failed: " + e.message, verified: 0 };
    }
    if (!check.ok) continue;
    report.postEventListable += 1;
    if (!shadow && lane.mode === "live") {
      await jobs.enqueue({
        lane: lane.game,
        laneKey: lane.gameKey,
        kind: "publish",
        market: "primary",
        campaignId: t.campaignId,
        taskId: t._id,
        shadow: false,
        payload: { verified: check.verified, assigned: (t.assignedAccounts || []).length, postEvent: true },
      });
      report.postEventQueued += 1;
    }
  }

  return report;
}

module.exports = {
  monitorLane,
  POST_EVENT_WINDOW_MS,
  POST_EVENT_CHECK_MS,
  _postEventChecked: postEventChecked,
};
