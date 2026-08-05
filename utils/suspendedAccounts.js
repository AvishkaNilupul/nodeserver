// Retire Twitch accounts that no longer exist.
//
// A suspended/deleted account is not a broken account, it is an absent one, and
// until now nothing in the system could tell the two apart: Twitch rejects the
// token with the same 401 either way, so both landed on "token_invalid" and both
// were treated as re-authable. That single conflation caused every symptom below
// on prod, measured before this module existed:
//
//   * 1,512 of 1,516 "bad token" BotAccounts did not exist on Twitch any more.
//   * 583 of them were still assigned to active auto-farm tasks, deliberately
//     kept there because they hold farmed drops and a re-auth would revive
//     them — which for a deleted account never happens. They counted toward
//     each task's target, so backfill saw every task as full, added nobody, and
//     no listing could ever find a live account holding a full bundle. 1,471
//     healthy accounts sat unclaimed in the pool at the same time.
//   * 85 pool rows were still `available` (71 of them checked "ok"), so backfill
//     kept claiming accounts that could never farm.
//
// The sweep therefore has three phases, and each one is safe to run alone:
//   1. classify — prove absence with utils/twitchAccountState.js and stamp
//      lastScanStatus/lastCheckStatus = "suspended".
//   2. release  — pull suspended logins out of active tasks and out of the bot
//      configs they occupy, so slots and container seats come back and backfill
//      refills them with live accounts.
//   3. purge    — permanently delete what is provably safe to delete.
//
// Nothing here deletes on suspicion. Only a definite "gone" from a clean HTTP
// 200 marks an account suspended (a 429/5xx/network error is UNKNOWN and changes
// nothing), and the purge additionally keeps every row that still carries
// evidence somebody may need: anything sold or reserved, and anything attached
// to a live marketplace listing.
const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const accountState = require("./twitchAccountState");
const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");

// Statuses worth re-probing: Twitch refused the token, or the scan errored in a
// way that may have been a suspension all along. "ok" accounts are never probed
// — a working token proves the account exists.
const PROBE_SCAN_STATUSES = ["token_invalid", "error"];
const PROBE_CHECK_STATUSES = ["token_invalid", "error", "integrity_failed"];

// How long an existence answer is trusted for a claimable pool row, and how many
// such rows one sweep may re-probe. A ban does not un-ban, so daily is plenty,
// and the cap is what keeps "I will feed new accounts" from turning every tick
// into thousands of Twitch lookups.
const PROBE_TTL_MS = 24 * 3600 * 1000;
const POOL_PROBE_CAP = 600;

function lower(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Lowercased logins of every BotAccount confirmed gone. 684 of 3,998 prod logins
// carry capitals while task.assignedAccounts stores whatever case it was given,
// so every comparison against this set must be lowercased too.
async function suspendedLoginSet() {
  const rows = await BotAccount.find(
    { lastScanStatus: "suspended" },
    { login: 1 },
  ).lean();
  return new Set(rows.map((r) => lower(r.login)).filter(Boolean));
}

// A pool row and a BotAccount can be the same Twitch account in two tables (the
// pool row is where it came from, the BotAccount is where it was deployed), so a
// login proven gone on one side is gone on the other. Propagating it saves a
// second probe and, more importantly, closes a loop that survived the first
// prod sweep: backfill claims a dead pool row, deployment fails, the claim is
// rolled back to `available`/`ok` (see releasePoolAccounts in utils/autoFarmer),
// and the row is right back in the supply it was never part of.
async function propagateSuspensionToPool(logins) {
  const list = [...new Set(logins.map(lower).filter(Boolean))];
  if (!list.length) return 0;
  const res = await AvailableAccount.updateMany(
    { usernameLower: { $in: list }, lastCheckStatus: { $ne: "suspended" } },
    {
      $set: {
        lastCheckStatus: "suspended",
        suspendedAt: new Date(),
        existsProbeAt: new Date(),
        lastCheckError:
          "Account no longer exists on Twitch (suspended or deleted)",
      },
    },
  );
  return res.modifiedCount || 0;
}

/* ------------------------------- 1. classify ------------------------------ */

// Probe accounts whose token Twitch refused and mark the ones that are gone.
// Returns counts; `limit` caps a run so a first sweep over thousands of rows can
// be done in slices.
async function classifyBotAccounts({ limit = 0, onProgress } = {}) {
  const q = BotAccount.find(
    { lastScanStatus: { $in: PROBE_SCAN_STATUSES }, login: { $gt: "" } },
    { login: 1, _id: 1 },
  ).lean();
  if (limit > 0) q.limit(limit);
  const rows = await q;
  if (!rows.length) return { probed: 0, suspended: 0, alive: 0, unknown: 0 };
  const verdicts = await accountState.probeAccounts(rows.map((r) => r.login));
  const gone = [];
  const goneLogins = [];
  let alive = 0;
  let unknown = 0;
  for (const r of rows) {
    const v = verdicts.get(r.login);
    if (v === accountState.GONE) {
      gone.push(r._id);
      goneLogins.push(r.login);
    } else if (v === accountState.EXISTS) alive++;
    else unknown++;
  }
  if (gone.length) {
    await BotAccount.updateMany(
      { _id: { $in: gone } },
      {
        $set: {
          lastScanStatus: "suspended",
          suspendedAt: new Date(),
          lastScanError:
            "Account no longer exists on Twitch (suspended or deleted)",
        },
      },
    );
    await propagateSuspensionToPool(goneLogins);
  }
  if (onProgress) {
    onProgress(
      "Suspension check: " +
        rows.length +
        " bad-token account(s) probed — " +
        gone.length +
        " gone, " +
        alive +
        " still exist (re-auth those), " +
        unknown +
        " inconclusive (left as-is).",
    );
  }
  return {
    probed: rows.length,
    suspended: gone.length,
    alive,
    unknown,
  };
}

// Same for the account pool, plus the case the bad-status filter cannot see: a
// row that is `available` with a perfectly good "ok" token. A token minted before
// the ban still authenticates, so 71 rows on prod sat here as available/ok while
// the accounts behind them no longer existed — backfill claimed them, deployed
// them into bots and they farmed nothing. Anything claimable is therefore probed
// on its own merit, at most once a day per row (existsProbeAt) and at most
// POOL_PROBE_CAP rows a sweep, so feeding in thousands of fresh accounts cannot
// turn a ten-minute tick into thousands of Twitch calls.
async function classifyPoolAccounts({ limit = 0, onProgress } = {}) {
  const stale = new Date(Date.now() - PROBE_TTL_MS);
  const q = AvailableAccount.find(
    {
      $or: [
        { lastCheckStatus: { $in: PROBE_CHECK_STATUSES } },
        {
          status: "available",
          $or: [{ existsProbeAt: null }, { existsProbeAt: { $lt: stale } }],
        },
      ],
    },
    { usernameLower: 1 },
  )
    .limit(limit > 0 ? limit : POOL_PROBE_CAP)
    .lean();
  const rows = await q;
  if (!rows.length) return { probed: 0, suspended: 0, alive: 0, unknown: 0 };
  const verdicts = await accountState.probeAccounts(
    rows.map((r) => r.usernameLower),
  );
  const gone = [];
  let alive = 0;
  let unknown = 0;
  for (const r of rows) {
    const v = verdicts.get(r.usernameLower);
    if (v === accountState.GONE) gone.push(r._id);
    else if (v === accountState.EXISTS) alive++;
    else unknown++;
  }
  const now = new Date();
  if (gone.length) {
    await AvailableAccount.updateMany(
      { _id: { $in: gone } },
      {
        $set: {
          lastCheckStatus: "suspended",
          suspendedAt: now,
          lastCheckError:
            "Account no longer exists on Twitch (suspended or deleted)",
        },
      },
    );
  }
  // Stamped for every row we got a definite answer about, gone or not, so the
  // daily re-probe window starts now. An inconclusive probe is deliberately left
  // unstamped: it answered nothing, so it must not buy the row a day of silence.
  const settled = rows
    .filter((r) => verdicts.get(r.usernameLower) !== accountState.UNKNOWN)
    .map((r) => r._id);
  if (settled.length) {
    await AvailableAccount.updateMany(
      { _id: { $in: settled } },
      { $set: { existsProbeAt: now } },
    );
  }
  if (onProgress) {
    onProgress(
      "Suspension check (pool): " +
        rows.length +
        " probed — " +
        gone.length +
        " gone, " +
        alive +
        " still exist, " +
        unknown +
        " inconclusive.",
    );
  }
  return { probed: rows.length, suspended: gone.length, alive, unknown };
}

/* -------------------------------- 2. release ------------------------------ */

// Drop suspended logins from every active task's assignedAccounts. This is the
// one place that deliberately overrides the dead-token reaper's "keep accounts
// that hold unsold drops" rule: that rule exists so a re-auth can recover the
// drops, and a deleted account has no re-auth. Holding the slot only blocks a
// live replacement.
async function releaseSuspendedAssignments({ onProgress } = {}) {
  const suspended = await suspendedLoginSet();
  if (!suspended.size) return { tasks: 0, unassigned: 0 };
  const tasks = await AutoFarmTask.find({ status: "active" });
  let touched = 0;
  let unassigned = 0;
  for (const task of tasks) {
    const before = task.assignedAccounts || [];
    const kept = before.filter((u) => !suspended.has(lower(u)));
    if (kept.length === before.length) continue;
    const removed = before.length - kept.length;
    task.assignedAccounts = kept;
    // The task stays active with whatever it has left — possibly nothing. That
    // is the intended resting state: backfill tops it up as accounts arrive, and
    // auto-list already reports "waiting: no assigned account holds the full
    // bundle yet" until one does. Cancelling it would lose the campaign.
    await task.save();
    touched++;
    unassigned += removed;
    if (onProgress) {
      onProgress(
        "Released " +
          removed +
          " suspended account(s) from " +
          task.game +
          " (" +
          kept.length +
          " left) — backfill will replace them.",
      );
    }
  }
  return { tasks: touched, unassigned };
}

// Pull suspended accounts out of the bot configs they still occupy, so the
// container stops trying to farm an account that does not exist and the seat can
// be reused. Config writes go through the same helper the renter expiry sweep
// uses, and each touched config is restarted once, after all its accounts are
// out. A host that is unreachable is skipped silently and retried next sweep —
// never an error, the Pi drops off Wi-Fi all the time.
async function evictSuspendedFromConfigs({ onProgress } = {}) {
  // Required lazily: routes/botConfigRoutes pulls in the whole route stack, and
  // this module is loaded by utils/autoFarmer at require time.
  const {
    removeAccountFromConfig,
    restartConfigContainer,
  } = require("../routes/botConfigRoutes");
  const rows = await BotAccount.find(
    { lastScanStatus: "suspended", configFile: { $gt: "" } },
    { login: 1, clientSecret: 1, configFile: 1, host: 1 },
  ).lean();
  const touched = new Map();
  let evicted = 0;
  for (const a of rows) {
    const host = hosts.resolveHost(a.host || "local");
    if (!host) continue;
    try {
      const removed = await removeAccountFromConfig(host, a.configFile, {
        clientSecret: a.clientSecret,
        login: a.login,
      });
      if (!removed) continue;
      evicted += removed;
      touched.set(host.id + "|" + a.configFile, { host, file: a.configFile });
      await BotAccount.updateOne(
        { _id: a._id },
        { $set: { enabled: false, configFile: "", container: "" } },
      );
    } catch (e) {
      console.error(
        "[suspendedAccounts] could not evict " + (a.login || a._id) + ":",
        e.message,
      );
    }
  }
  for (const b of touched.values()) {
    try {
      await restartConfigContainer(b.host, b.file);
    } catch (e) {
      console.error(
        "[suspendedAccounts] could not restart " + b.file + ":",
        e.message,
      );
    }
  }
  if (evicted && onProgress) {
    onProgress(
      "Evicted " +
        evicted +
        " suspended account(s) from " +
        touched.size +
        " bot config(s); seats are free again.",
    );
  }
  return { evicted, configs: touched.size };
}

/* --------------------------------- 3. purge ------------------------------- */

// Which suspended BotAccounts may be deleted outright, and which must be kept
// for the record. Pure so the rules are testable without a database.
//   sold/reserved     -> KEEP. A buyer received this login; the row is the only
//                        evidence behind a refund or dispute.
//   sold/reserved drop-> KEEP. An "everything" account is sold once PER GAME, so
//                        the real sale lives on DropLog and BotAccount.soldAt is
//                        only a shadow of it (see models/DropLog.js) — checking
//                        the account alone would delete a per-game sale whole.
//   on a listing      -> KEEP. Something is still selling against it; deleting
//                        the row would strand the listing's audit trail.
//   otherwise         -> DELETE. It cannot farm, cannot be sold, and cannot be
//                        re-authed.
function purgePlanFor(acc, listedRefs, soldDropIds) {
  if (!acc || acc.lastScanStatus !== "suspended") {
    return { action: "keep", reason: "not confirmed suspended" };
  }
  if (acc.soldAt) {
    return { action: "keep", reason: "sold/reserved — kept as sale evidence" };
  }
  if (acc.soldPurchaseId || acc.soldBulkOrderId) {
    return { action: "keep", reason: "attached to an order" };
  }
  if (soldDropIds && soldDropIds.has(String(acc._id))) {
    return { action: "keep", reason: "holds a sold or reserved drop" };
  }
  if (
    listedRefs &&
    (listedRefs.has(String(acc._id)) || listedRefs.has(lower(acc.login)))
  ) {
    return { action: "keep", reason: "attached to a marketplace listing" };
  }
  return { action: "delete", reason: "gone from Twitch and unsold" };
}

// Every account id AND login referenced by any marketplace listing, whatever its
// status. Deliberately unfiltered: a delisted or errored row is still the audit
// trail for whatever was sold against it. `units` matters as much as the
// top-level pair — that is where Digiseller/GGSel record the account behind each
// delivered unit, so reading only accountId/accountLogin would miss every
// quantity-fed listing and delete the accounts underneath it.
async function listedAccountRefs() {
  const rows = await MarketplaceListing.find(
    {},
    { accountId: 1, accountLogin: 1, units: 1 },
  ).lean();
  const out = new Set();
  for (const r of rows) {
    if (r.accountId) out.add(String(r.accountId).trim());
    if (r.accountLogin) out.add(lower(r.accountLogin));
    for (const u of r.units || []) {
      if (u && u.accountId) out.add(String(u.accountId).trim());
      if (u && u.login) out.add(lower(u.login));
    }
  }
  out.delete("");
  return out;
}

// Accounts (of either collection) holding at least one drop that is sold or
// reserved to a marketplace. Those drops are somebody's purchase record.
async function soldDropAccountIds(ids) {
  if (!ids.length) return new Set();
  const rows = await DropLog.aggregate([
    {
      $match: {
        account: { $in: ids },
        $or: [{ soldAt: { $ne: null } }, { soldToUsername: { $gt: "" } }],
      },
    },
    { $group: { _id: "$account" } },
  ]);
  return new Set(rows.map((r) => String(r._id)));
}

// Permanently delete the suspended accounts that are safe to delete, together
// with their archived drops. The drops go with the account on purpose: they
// describe items on an account nobody can ever log into, and leaving them behind
// would orphan rows whose `account` reference no longer resolves — which is
// exactly what makes a holder lookup think stock exists when it does not.
async function purgeSuspended({ dryRun = false, onProgress } = {}) {
  const listed = await listedAccountRefs();
  const rows = await BotAccount.find(
    { lastScanStatus: "suspended" },
    {
      login: 1,
      soldAt: 1,
      soldPurchaseId: 1,
      soldBulkOrderId: 1,
      lastScanStatus: 1,
    },
  ).lean();
  const soldDrops = await soldDropAccountIds(rows.map((r) => r._id));
  const doomed = [];
  const kept = [];
  for (const acc of rows) {
    const plan = purgePlanFor(acc, listed, soldDrops);
    (plan.action === "delete" ? doomed : kept).push({ acc, plan });
  }
  const report = {
    suspended: rows.length,
    deletable: doomed.length,
    kept: kept.length,
    deletedAccounts: 0,
    deletedDrops: 0,
    dryRun: !!dryRun,
  };
  if (dryRun || !doomed.length) {
    if (onProgress) {
      onProgress(
        "Suspended purge (" +
          (dryRun ? "dry run" : "nothing to do") +
          "): " +
          doomed.length +
          " deletable, " +
          kept.length +
          " kept for the record.",
      );
    }
    return report;
  }
  const ids = doomed.map((d) => d.acc._id);
  // Before the rows go: their pool twins must be retired too, or a deleted
  // account comes straight back as supply the next time a claim is rolled back.
  await propagateSuspensionToPool(doomed.map((d) => d.acc.login));
  // Drops first: an account row that survives a failed drop delete can be
  // purged again next sweep, whereas orphaned drops would have nothing left
  // pointing at them.
  // Matched on the account id alone: rows written before accountModel existed
  // don't carry it, and an id from another collection can't collide.
  const drops = await DropLog.deleteMany({ account: { $in: ids } });
  report.deletedDrops = drops.deletedCount || 0;
  const del = await BotAccount.deleteMany({ _id: { $in: ids } });
  report.deletedAccounts = del.deletedCount || 0;
  if (onProgress) {
    onProgress(
      "Purged " +
        report.deletedAccounts +
        " suspended account(s) and " +
        report.deletedDrops +
        " of their drop rows; kept " +
        kept.length +
        " that are sold or on a live listing.",
    );
  }
  return report;
}

// Pool rows are supply, so a confirmed-gone one has no reason to exist — and
// deleting rather than flagging frees the unique usernameLower index, so
// re-importing the same name later is not blocked by a dead row. A pool account
// can still have been checked, farmed and sold from before it was ever wired
// into a bot, so the same sold/reserved and listing guards apply here.
async function purgeSuspendedPool({ dryRun = false, onProgress } = {}) {
  const rows = await AvailableAccount.find(
    { lastCheckStatus: "suspended" },
    { usernameLower: 1 },
  ).lean();
  if (!rows.length) return { suspended: 0, deleted: 0, dryRun: !!dryRun };
  const listed = await listedAccountRefs();
  const soldDrops = await soldDropAccountIds(rows.map((r) => r._id));
  const ids = rows
    .filter(
      (r) =>
        !soldDrops.has(String(r._id)) &&
        !listed.has(String(r._id)) &&
        !listed.has(lower(r.usernameLower)),
    )
    .map((r) => r._id);
  const report = {
    suspended: rows.length,
    deletable: ids.length,
    kept: rows.length - ids.length,
    deleted: 0,
    deletedDrops: 0,
    dryRun: !!dryRun,
  };
  if (dryRun || !ids.length) {
    if (onProgress) {
      onProgress(
        "Suspended pool purge (" +
          (dryRun ? "dry run" : "nothing to do") +
          "): " +
          ids.length +
          " row(s) deletable, " +
          report.kept +
          " kept for the record.",
      );
    }
    return report;
  }
  const drops = await DropLog.deleteMany({ account: { $in: ids } });
  report.deletedDrops = drops.deletedCount || 0;
  const res = await AvailableAccount.deleteMany({ _id: { $in: ids } });
  report.deleted = res.deletedCount || 0;
  if (onProgress) {
    onProgress(
      "Purged " +
        report.deleted +
        " suspended account-pool row(s) and " +
        report.deletedDrops +
        " of their drop rows; kept " +
        report.kept +
        ".",
    );
  }
  return report;
}

/* --------------------------------- sweep --------------------------------- */

// Classify, release, then optionally purge. Default is classify+release only:
// those are reversible (a re-probe can flip a row back, an unassigned task gets
// refilled) whereas a purge is not, so deletion stays opt-in per call.
async function sweep({
  purge = false,
  dryRun = false,
  limit = 0,
  onProgress,
} = {}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const bots = await classifyBotAccounts({ limit, onProgress: progress });
  const pool = await classifyPoolAccounts({ limit, onProgress: progress });
  const released = await releaseSuspendedAssignments({ onProgress: progress });
  const evicted = await evictSuspendedFromConfigs({ onProgress: progress });
  const purged = purge
    ? await purgeSuspended({ dryRun, onProgress: progress })
    : null;
  const purgedPool = purge
    ? await purgeSuspendedPool({ dryRun, onProgress: progress })
    : null;
  const newlyDead = bots.suspended + pool.suspended;
  if (newlyDead) {
    await sendTelegram(
      "🚫 " +
        newlyDead +
        " account(s) confirmed gone from Twitch (suspended/deleted): " +
        bots.suspended +
        " farming, " +
        pool.suspended +
        " in the pool. " +
        released.unassigned +
        " slot(s) freed — feed new accounts to refill them." +
        (bots.alive
          ? " " +
            bots.alive +
            " bad-token account(s) still exist and only need re-auth."
          : ""),
    ).catch(() => {});
  }
  return { bots, pool, released, evicted, purged, purgedPool };
}

module.exports = {
  PROBE_SCAN_STATUSES,
  PROBE_CHECK_STATUSES,
  suspendedLoginSet,
  propagateSuspensionToPool,
  classifyBotAccounts,
  classifyPoolAccounts,
  releaseSuspendedAssignments,
  evictSuspendedFromConfigs,
  purgePlanFor,
  listedAccountRefs,
  purgeSuspended,
  purgeSuspendedPool,
  sweep,
};
