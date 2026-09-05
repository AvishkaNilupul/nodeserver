// Lane step 4 — PUBLISH: put verified stock on sale.
//
// Split from farming entirely, which is the point. In the legacy engine
// auto-listing is phase 15 INSIDE the farm tick (utils/autoFarmer.js), so a
// Gameflip 429 or a hung Plati login delays farm decisions for every game.
// Here publishing is its own job with its own retry clock, and farming never
// waits on a marketplace.
//
// TWO ROWS, NOT FOUR. See the `market` field docs in models/FarmJob.js for why
// this is "primary" + "secondaries" rather than one row per marketplace: the
// per-market publish helpers take a payload assembled inside
// retryMissingSecondaries (set, grid image, split, and reserved accounts), and
// reimplementing that assembly would duplicate the stock-reservation logic.
// The boundary still buys the thing that matters — a secondary-market outage
// cannot block or delay the primary listing, and vice versa.
//
// THE HARD GATE: nothing is published without a fresh verification that the
// accounts actually hold the bundle. The holdings gate exists because an
// earlier auto-list path put 55 of 188 wrong-content accounts on sale. The
// legacy path re-checks internally too; this is a second, explicit gate so a
// publish job can never run on stale evidence.

const verifyStep = require("./verify");
const { recordAutoFarmEvent } = require("../../autoFarmEventLog");
const notify = require("../notify");

// A secondaries job that found every market present (or unmapped) need not be
// re-queued every cycle: publishNeeds reads the listing's externalIds, but
// whether ZeusX/Plati/GGSel are even ENABLED for a game is known only inside
// retryMissingSecondaries. Remember its "nothing to do" verdict for a while.
// Per process, deliberately — a restart simply re-checks once.
const SECONDARIES_SETTLED_MS = 6 * 60 * 60 * 1000;
const secondariesSettled = new Map(); // taskId -> ms

function secondariesSettledRecently(taskId) {
  const at = secondariesSettled.get(String(taskId));
  return !!at && Date.now() - at < SECONDARIES_SETTLED_MS;
}

function lister() {
  return require("../../autoLister");
}

// Publish the primary (Gameflip) listing. autoLister.listActivatedTask also
// makes the first attempt at the secondary markets, so a healthy run often
// leaves the secondaries job with nothing to do — which is correct and cheap.
async function publishPrimary({ taskId, af, shadow, lane }) {
  if (shadow || (lane && lane.mode !== "live")) {
    throw new Error("publish reached from a non-live lane — refusing to list");
  }
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const task = await AutoFarmTask.findById(taskId).lean();
  if (!task) return { skipped: "task gone" };

  // Gate: re-verify holdings immediately before listing.
  const check = await verifyStep.verifyTask(task);
  if (!check.ok) {
    // Not an error — this is the normal mid-farm state. Returning a skip keeps
    // the job from burning its retry budget on a task that simply is not ready
    // yet; the lane re-enqueues when monitoring says it has become listable.
    return { skipped: "holdings not verified", detail: check.reason, verified: check.verified };
  }

  const dryRun = !!(af && af.dryRun);
  let r;
  try {
    r = await lister().listActivatedTask(taskId, { dryRun });
  } catch (e) {
    // The same trace the legacy sweep leaves. The job's own log is not
    // somewhere an operator looks; the Auto-farm tab reads listing.error, and
    // without it a task that keeps THROWING (no resolvable items, a Gameflip
    // 429, an unmapped ZeusX category) looks exactly like a healthy task still
    // waiting for its first complete account.
    if (!dryRun) {
      await AutoFarmTask.updateOne(
        { _id: task._id },
        { $set: { "listing.error": ("auto-list failed: " + e.message).slice(0, 400) } },
      ).catch(() => {});
    }
    throw e;
  }
  // A campaign that has already ENDED is listed post-event: the same markup,
  // retitle and stacking pass completeEndedTasks runs for a task that was
  // listed while live (autoLister.onCampaignEnded). This is what lets a task
  // whose accounts completed the bundle only around the campaign's end still
  // reach a marketplace — the legacy sweep lists ACTIVE tasks only, so once
  // completeEndedTasks had marked such a task completed nothing ever listed
  // it (128 completed-but-unlisted tasks in 30 days on prod; Halo Infinite
  // alone had 39 deliverable accounts sitting unsold).
  let postEvent = null;
  const ended =
    task.status === "completed" ||
    (task.campaignEndAt && new Date(task.campaignEndAt).getTime() < Date.now());
  if (r && r.listed && ended && !dryRun) {
    try {
      postEvent = await lister().onCampaignEnded(task._id);
    } catch (e) {
      postEvent = { error: e.message };
    }
  }
  if (r && r.listed) {
    // Same event and same alert the legacy sweep records, so the Activity page
    // and the owner's Telegram see a lane listing exactly as a legacy one.
    await recordAutoFarmEvent({
      type: "listed",
      game: task.game,
      campaignId: task.campaignId,
      taskId: task._id,
      count: r.listed.qty || 0,
      reason: r.listed.title + " ($" + r.listed.price + ")",
      actor: "farm2/publishPrimary",
    });
    await notify.telegram(
      "🛍 Auto-listed (lane" +
        (ended ? ", post-event" : "") +
        ") — " +
        task.game +
        "\n" +
        r.listed.title +
        "\n$" +
        r.listed.price +
        " · qty " +
        r.listed.qty +
        "\n" +
        r.listed.url,
    );
  }
  return {
    listed: r && r.listed ? r.listed : null,
    wouldList: r && r.wouldList ? r.wouldList : null,
    skipped: r && r.skipped ? r.skipped : null,
    retried: r && r.retried ? r.retried : null,
    verifiedAtPublish: check.verified,
    ...(postEvent ? { postEvent } : {}),
  };
}

// Retry whichever secondary markets are still missing. Independent retry clock:
// this is what stops a Plati outage from touching the Gameflip listing.
async function publishSecondaries({ taskId, shadow, lane }) {
  if (shadow || (lane && lane.mode !== "live")) {
    throw new Error("publish reached from a non-live lane — refusing to list");
  }
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const task = await AutoFarmTask.findById(taskId);
  if (!task) return { skipped: "task gone" };
  if (!task.listing || !task.listing.externalId) {
    // The primary has not landed yet. Not an error; the secondaries job simply
    // has nothing to attach to and will be re-enqueued after the primary lists.
    return { skipped: "no primary listing yet" };
  }

  const retried = await lister().retryMissingSecondaries(task);
  if (!retried) {
    secondariesSettled.set(String(task._id), Date.now());
    return { skipped: "all secondary markets already present" };
  }
  await notify.telegram("🛍 Auto-relisted (lane) — " + task.game + "\n" + retried.join(", "));
  return { retried };
}

// Which publish work does this task still need? Used by the monitor step to
// decide what to enqueue, so jobs are only created when there is real work.
function publishNeeds(task) {
  const L = (task && task.listing) || {};
  const needsPrimary = !L.externalId;
  const needsSecondaries =
    !!L.externalId &&
    (!(L.plati && L.plati.externalId) ||
      !(L.ggsel && L.ggsel.externalId) ||
      !(L.zeusx && L.zeusx.externalId));
  return { needsPrimary, needsSecondaries };
}

module.exports = {
  publishPrimary,
  publishSecondaries,
  publishNeeds,
  secondariesSettledRecently,
  SECONDARIES_SETTLED_MS,
  _secondariesSettled: secondariesSettled,
};
