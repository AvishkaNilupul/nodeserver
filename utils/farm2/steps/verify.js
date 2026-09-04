// Lane step 2 — VERIFY (the "drop checker" box in the architecture sketch).
//
// Confirm that a task's assigned accounts ACTUALLY hold the drops the listing
// will promise, BEFORE anything is offered for sale.
//
// In the legacy engine this check lives inside the publish call itself, so a
// task with wrong or incomplete holdings is only discovered at the moment
// someone tries to list it — and the failure surfaces as a listing error rather
// than as "these accounts do not hold what we think they hold". Splitting it
// into its own stage means:
//
//   * it can run in SHADOW mode against the tasks the legacy engine is farming
//     right now, auditing live inventory without changing anything
//   * a holdings problem is reported as a holdings problem, with the count of
//     verified vs assigned accounts, instead of a downstream publish failure
//   * publish jobs are only ever created for stock that is provably real
//
// The verification itself is NOT reimplemented here. It calls
// autoLister.pickDeliveryAccounts — the exact function the real listing path
// uses to choose what it can deliver, so the checker and the lister agree by
// construction rather than by keeping two implementations in step.

function lister() {
  return require("../../autoLister");
}

// Verify one task's holdings. Pure read: runs aggregations and decrypts
// passwords in memory, writes nothing, contacts no marketplace and no host.
// Safe to run against live legacy-owned tasks, which is exactly what shadow
// lanes do.
async function verifyTask(taskDoc) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const task =
    taskDoc && taskDoc.assignedAccounts
      ? taskDoc
      : await AutoFarmTask.findById(taskDoc && (taskDoc._id || taskDoc)).lean();

  if (!task) {
    return { ok: false, reason: "task not found", verified: 0, assigned: 0 };
  }

  const assigned = (task.assignedAccounts || []).filter(Boolean);
  if (!assigned.length) {
    return {
      ok: false,
      reason: "task has no assigned accounts",
      verified: 0,
      assigned: 0,
      items: [],
    };
  }

  const L = lister();

  // Resolve what this campaign actually promises. campaignItems is the same
  // resolver the listing path uses, including the non-Latin placeholder fix —
  // a Cyrillic or CJK drop name is a real item, not an unresolved placeholder.
  //
  // Its signature is (campaignId, game, campaignName) — three positional
  // arguments, NOT the task. Passing the task object made campaignId an object,
  // so the Twitch fetch failed and every single task reported "could not
  // resolve campaign items", which made the audit read as though all 16
  // unlisted tasks were broken. In a LIVE lane it would have been worse:
  // publishPrimary gates on this, so nothing would ever have been listed.
  let items = [];
  try {
    items =
      (await L.campaignItems(task.campaignId, task.game, task.campaignName)) || [];
  } catch (e) {
    return {
      ok: false,
      reason: "could not resolve campaign items: " + e.message,
      verified: 0,
      assigned: assigned.length,
      items: [],
    };
  }

  if (!items.length) {
    return {
      ok: false,
      reason: "no resolvable drop items for this campaign",
      verified: 0,
      assigned: assigned.length,
      items: [],
    };
  }

  if (typeof L.pickDeliveryAccounts !== "function") {
    // The export is additive and ships with this engine; if a host is running
    // an older autoLister the checker degrades to "unknown" rather than
    // guessing, because a false "verified" would put wrong content on sale.
    return {
      ok: false,
      reason: "autoLister.pickDeliveryAccounts unavailable on this host",
      verified: 0,
      assigned: assigned.length,
      items: items.map((i) => i.name || i.itemKey),
      degraded: true,
    };
  }

  // pickDeliveryAccounts, NOT verifiedHoldersForItems.
  //
  // The two differ by one crucial subtraction: pickDeliveryAccounts also
  // excludes logins already live on ANOTHER active MarketplaceListing. Holding
  // the bundle is not the same as being deliverable — an account already
  // advertised elsewhere cannot be sold twice.
  //
  // The first live publish exposed this: this checker reported 7 verified
  // holders for World of Tanks while the real lister declined with "no assigned
  // account holds the full bundle yet", because all 7 were already committed to
  // other listings. No harm followed — the lister's own gate caught it — but
  // the checker was over-reporting, which also inflated the "sellable but
  // unlisted" audit and made the monitor re-queue a publish job every cycle
  // that could never succeed.
  //
  // Using the same function the real listing path uses makes the two agree by
  // construction rather than by keeping a second implementation in step.
  const holders = await L.pickDeliveryAccounts(task, assigned.length, items);
  const verified = holders.length;

  return {
    // "ok" means there is at least one account that provably holds the FULL
    // bundle and is deliverable. Listing fewer than assigned is normal and
    // expected mid-farm; listing ZERO verified accounts is the condition that
    // must block publishing.
    ok: verified > 0,
    verified,
    assigned: assigned.length,
    shortfall: Math.max(0, assigned.length - verified),
    items: items.map((i) => ({ key: i.itemKey, name: i.name, qty: i.qty || 1 })),
    reason:
      verified > 0
        ? `${verified} of ${assigned.length} assigned account(s) are deliverable (hold the full bundle and are not already on another listing)`
        : `none of the ${assigned.length} assigned account(s) are deliverable yet`,
  };
}

// Audit every active task for a lane's game. This is what a shadow lane runs:
// it reports on the inventory the LEGACY engine is currently managing, which
// makes the new tab useful before a single game is flipped to live.
async function auditLane(lane) {
  const AutoFarmTask = require("../../../models/AutoFarmTask");
  const tasks = await AutoFarmTask.find({
    game: lane.game,
    status: "active",
  })
    .select(
      "game campaignId campaignName assignedAccounts listing.externalId listing.qty campaignEndAt",
    )
    .lean();

  const results = [];
  for (const t of tasks) {
    // Sequential on purpose: each verification runs a DropLog aggregation, and
    // fanning those out per task would put avoidable load on an Atlas shared
    // tier whose binding constraint is bytes returned.
    const r = await verifyTask(t);
    results.push({
      taskId: t._id,
      campaignId: t.campaignId,
      campaignName: t.campaignName || "",
      listed: !!(t.listing && t.listing.externalId),
      listedQty: (t.listing && t.listing.qty) || 0,
      ...r,
    });
  }

  const listable = results.filter((r) => r.ok);
  return {
    tasks: results.length,
    listable: listable.length,
    blocked: results.length - listable.length,
    // The finding that matters most: stock that is verified and deliverable but
    // has no live listing. In the legacy engine this is the silent failure mode
    // where a task never reaches a marketplace and nobody notices.
    unlistedButReady: results.filter((r) => r.ok && !r.listed).length,
    results,
  };
}

module.exports = { verifyTask, auditLane };
