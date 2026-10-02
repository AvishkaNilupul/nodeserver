// Retire SOLD accounts whose Twitch token has died from the bot configs they
// still occupy (opt-in: autoFarm.retireSoldDeadTokens, default OFF).
//
// Why this exists (2026-10-01): the system-health host card read "Unhealthy 7"
// on the Contabo VPS. All seven were BotAccounts with lastScanStatus
// "token_invalid" that still held a config entry — and six of the seven had
// already been SOLD (by hand, through Digiseller or Gameflip, or as a delivered
// Eldorado unit). A token that dies after the sale is the buyer securing the
// account they bought; re-auth is impossible (and not ours to do), so the entry
// only makes its bot retry a dead login forever. Nothing removed them:
//   * utils/autoFarmer.js reapDeadTokenAssignments only un-assigns dead
//     accounts from ACTIVE tasks, and keeps the ones holding drops "for re-auth";
//   * utils/suspendedAccounts.evictSuspendedFromConfigs handles accounts Twitch
//     DELETED ("suspended") — these still exist.
//
// The rules, each one deliberately narrow:
//   DEAD   — lastScanStatus is "token_invalid" now, the scanner's audit trail
//            (SystemEvent accounts/token_invalid, written on the transition)
//            says it went bad at least `hours` ago, and a LATER scan confirmed
//            it again. No transition event inside the 90-day audit TTL means it
//            went bad before the window; an inconsistent trail (latest event is
//            "recovered") waits. "error" is never dead — it is the scanner's
//            transient verdict.
//   SOLD   — proof a buyer got the account: a real-sale reservation on one of
//            its drops (utils/marketClaimTags.isRealSale — a marketplace tag
//            alone only means LISTED), a listing row that sold it (status
//            "sold" with its accountId), or a delivered unit naming it. Never
//            "connected": that is a Twitch↔game link every claiming account
//            carries, not a sale (see the spent-accounts false positive).
//   LEFT ALONE — renter accounts (RenterAccount, by secret or login), renter
//            stack configs (RenterBotStack host+file), reseller-owned rows, the
//            no-claim fleet (its configs are written outside dupeGuard and its
//            rows carry no configFile), and every unsold dead account: those are
//            reported for re-auth and keep showing on the host card.
//
// The removal is the same one the suspended eviction uses: removeAccountFromConfig
// (fresh read under the in-process file lock + writeFileAtomic, so this must run
// inside the server — the farmer tick calls it), then the row leaves its bot
// (enabled false, configFile/container "") and active tasks release the login.
// Rows, drops and sales are kept. A touched config's container is restarted once,
// and only if it is RUNNING (`docker restart` would also start a parked bot) —
// checked and restarted in ONE shell command under the container's lock
// (farmControl.restartIfRunning, 2026-10-03). A config the retirement empties
// is stopped instead (botHosts.stopIfNoAccounts).
const MarketplaceListing = require("../models/MarketplaceListing");
const { isRealSale } = require("./marketClaimTags");

const DEFAULT_HOURS = 48;
const MIN_HOURS = 24;
const MAX_HOURS = 24 * 30;
// A scan counts as a re-confirmation only if it ran at least this long after
// the transition — the scanner's next visit is ~a day later in practice.
const RECONFIRM_GAP_MS = 60 * 60 * 1000;

function lower(s) {
  return String(s || "").trim().toLowerCase();
}

function clampHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURS;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

/**
 * Decide one account. Pure.
 * @param {object} p
 * @param {object} p.acc       BotAccount row (login, lastScanStatus, lastScanAt, configFile, container, resellerId)
 * @param {number} p.now       ms
 * @param {number} p.minDeadMs how long the token must have been dead
 * @param {{at:number, action:string}|null} p.lastEvent latest accounts/token_invalid|recovered event, null when none
 * @param {string[]} p.sold    proof of sale (empty = none)
 * @param {boolean} p.rented
 * @param {boolean} p.renterStack
 * @returns {{verdict:"retire"|"surface"|"skip", reason:string, deadSince:number|null}}
 */
function decide({ acc, now, minDeadMs, lastEvent, sold = [], rented = false, renterStack = false }) {
  const a = acc || {};
  if (a.lastScanStatus !== "token_invalid") return { verdict: "skip", reason: "token not dead", deadSince: null };
  if (!a.configFile) return { verdict: "skip", reason: "not in a bot config", deadSince: null };
  if (/^noclaim-bot-/i.test(String(a.container || ""))) return { verdict: "skip", reason: "no-claim fleet", deadSince: null };
  if (a.resellerId) return { verdict: "skip", reason: "reseller account", deadSince: null };
  if (rented) return { verdict: "skip", reason: "rented out", deadSince: null };
  if (renterStack) return { verdict: "skip", reason: "renter stack config", deadSince: null };

  const scanAt = a.lastScanAt ? new Date(a.lastScanAt).getTime() : 0;
  let deadSince = null;
  if (lastEvent) {
    if (lastEvent.action !== "token_invalid") {
      return { verdict: "skip", reason: "audit trail says it recovered; waiting for the scanner", deadSince: null };
    }
    deadSince = lastEvent.at;
    if (now - deadSince < minDeadMs) return { verdict: "skip", reason: "dead for less than the wait", deadSince };
    if (!(scanAt >= deadSince + RECONFIRM_GAP_MS)) {
      return { verdict: "skip", reason: "waiting for a later scan to re-confirm", deadSince };
    }
  } else if (!scanAt) {
    return { verdict: "skip", reason: "never scanned", deadSince: null };
  }
  if (!sold.length) return { verdict: "surface", reason: "unsold — needs re-auth, not retirement", deadSince };
  return { verdict: "retire", reason: "sold (" + sold.slice(0, 3).join("; ") + "), token dead", deadSince };
}

function defaultDeps() {
  return {
    BotAccount: require("../models/BotAccount"),
    DropLog: require("../models/DropLog"),
    MarketplaceListing,
    SystemEvent: require("../models/SystemEvent"),
    RenterBotStack: require("../models/RenterBotStack"),
    AutoFarmTask: require("../models/AutoFarmTask"),
    hosts: require("./botHosts"),
    rentedAccounts: require("./rentedAccounts"),
    logEvent: require("./systemLog").logEvent,
    sendTelegram: require("./telegram").sendTelegram,
    // Lazily: routes/botConfigRoutes pulls in the whole route stack.
    configOps: () => {
      const r = require("../routes/botConfigRoutes");
      return { removeAccountFromConfig: r.removeAccountFromConfig, restartConfigContainer: r.restartConfigContainer };
    },
    restartIfRunning: (...a) => require("./farmControl").restartIfRunning(...a),
  };
}

/**
 * Read-only: what a retirement pass would do right now.
 * Returns { hours, retire:[...], surface:[...], skipped:[...] }; every entry
 * names the account, its bot and the reason.
 */
async function plan({ hours = DEFAULT_HOURS, now = Date.now(), deps } = {}) {
  const d = deps || defaultDeps();
  const h = clampHours(hours);
  const minDeadMs = h * 3600000;
  const rows = await d.BotAccount.find(
    { lastScanStatus: "token_invalid", configFile: { $gt: "" } },
    { login: 1, clientSecret: 1, host: 1, configFile: 1, container: 1, enabled: 1, lastScanStatus: 1, lastScanAt: 1, resellerId: 1 },
  ).lean();
  const out = { hours: h, retire: [], surface: [], skipped: [] };
  if (!rows.length) return out;

  const ids = rows.map((r) => r._id);
  const idStr = ids.map(String);

  // Scanner transitions, newest first: the first one seen per account wins.
  const events = await d.SystemEvent.find(
    { category: "accounts", subjectId: { $in: ids }, action: { $in: ["token_invalid", "recovered"] } },
    { subjectId: 1, action: 1, at: 1 },
  )
    .sort({ at: -1 })
    .lean();
  const lastEvent = new Map();
  for (const e of events) {
    const k = String(e.subjectId);
    if (!lastEvent.has(k)) lastEvent.set(k, { at: new Date(e.at).getTime(), action: e.action });
  }

  // Proof of sale, three sources, batched.
  const sold = new Map(idStr.map((k) => [k, []]));
  const add = (k, why) => {
    const list = sold.get(String(k));
    if (list && !list.includes(why)) list.push(why);
  };
  const reserved = await d.DropLog.aggregate([
    { $match: { account: { $in: ids }, soldAt: { $ne: null } } },
    { $group: { _id: { a: "$account", to: "$soldToUsername" }, soldAt: { $max: "$soldAt" }, n: { $sum: 1 } } },
  ]);
  for (const r of reserved) {
    if (isRealSale({ soldAt: r.soldAt, soldToUsername: r._id.to })) {
      add(r._id.a, (r._id.to || "unnamed buyer") + " ×" + r.n);
    }
  }
  const soldRows = await d.MarketplaceListing.find(
    { status: "sold", accountId: { $in: idStr } },
    { marketplace: 1, accountId: 1 },
  ).lean();
  for (const r of soldRows) add(r.accountId, "sold on " + (r.marketplace || "?"));
  const unitRows = await d.MarketplaceListing.find(
    { "units.accountId": { $in: idStr } },
    { marketplace: 1, "units.accountId": 1, "units.deliveredAt": 1 },
  ).lean();
  const idSet = new Set(idStr);
  for (const r of unitRows) {
    for (const u of r.units || []) {
      if (u && u.deliveredAt && idSet.has(String(u.accountId))) add(u.accountId, "delivered on " + (r.marketplace || "?"));
    }
  }

  const rentedIdx = await d.rentedAccounts.rentedIndex({ fresh: true });
  const stacks = await d.RenterBotStack.find({}, { host: 1, file: 1 }).lean();
  const stackKeys = new Set(stacks.map((s) => lower(s.host || "local") + "|" + lower(s.file)));

  for (const acc of rows) {
    const k = String(acc._id);
    const verdict = decide({
      acc,
      now,
      minDeadMs,
      lastEvent: lastEvent.get(k) || null,
      sold: sold.get(k) || [],
      rented: d.rentedAccounts.isRented(rentedIdx, acc),
      renterStack: stackKeys.has(lower(acc.host || "local") + "|" + lower(acc.configFile)),
    });
    const entry = {
      id: k,
      login: acc.login || "",
      host: acc.host || "local",
      configFile: acc.configFile,
      container: acc.container || "",
      enabled: !!acc.enabled,
      deadSince: verdict.deadSince ? new Date(verdict.deadSince).toISOString() : null,
      reason: verdict.reason,
    };
    if (verdict.verdict === "retire") out.retire.push(entry);
    else if (verdict.verdict === "surface") out.surface.push(entry);
    else out.skipped.push(entry);
  }
  return out;
}

/**
 * Plan, then act on the "retire" verdicts (unless dryRun). Never throws for one
 * account or one host: an unreachable host is skipped and retried next tick.
 */
async function retireSoldDeadTokens({ hours = DEFAULT_HOURS, dryRun = false, now = Date.now(), onProgress, deps } = {}) {
  const d = deps || defaultDeps();
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const p = await plan({ hours, now, deps: d });
  const report = { ...p, dryRun: !!dryRun, retired: [], errors: [], configs: 0, restarted: [], stopped: [] };
  if (dryRun || !p.retire.length) return report;

  const { removeAccountFromConfig } = d.configOps();
  const restartIfRunning = d.restartIfRunning || require("./farmControl").restartIfRunning;
  const allowRestart = process.env.TWITCHBOT_ALLOW_RESTART !== "0";
  const groups = new Map();
  for (const e of p.retire) {
    const key = e.host + "|" + e.configFile;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const list of groups.values()) {
    const { host: hostId, configFile: file } = list[0];
    const host = d.hosts.resolveHost(hostId);
    if (!host) {
      report.errors.push(hostId + "/" + file + ": unknown host");
      continue;
    }
    let touched = false;
    for (const e of list) {
      try {
        // Re-read right before the write: a token that came back since the plan,
        // or an account moved to another config, is left exactly as it is.
        const fresh = await d.BotAccount.findById(e.id, { login: 1, clientSecret: 1, lastScanStatus: 1, configFile: 1 }).lean();
        if (!fresh || fresh.lastScanStatus !== "token_invalid" || fresh.configFile !== file) continue;
        const removed = await removeAccountFromConfig(host, file, { clientSecret: fresh.clientSecret, login: fresh.login });
        await d.BotAccount.updateOne(
          { _id: fresh._id, lastScanStatus: "token_invalid", configFile: file },
          { $set: { enabled: false, configFile: "", container: "" } },
        );
        const variants = [...new Set([fresh.login, lower(fresh.login)].filter(Boolean))];
        if (variants.length) {
          await d.AutoFarmTask.updateMany(
            { status: "active", assignedAccounts: { $in: variants } },
            { $pull: { assignedAccounts: { $in: variants } } },
          );
        }
        if (removed) touched = true;
        report.retired.push(e);
        await d.logEvent({
          category: "accounts",
          action: "retired_dead_token",
          actor: "dead-token-retire",
          severity: "info",
          subject: fresh.login || "",
          subjectId: fresh._id,
          host: hostId,
          container: e.container,
          detail:
            "removed from " + file + " (" + e.reason + "; dead since " + (e.deadSince || "before the audit window") +
            "). Row, drops and sales kept.",
        });
      } catch (err) {
        report.errors.push((e.login || e.id) + ": " + err.message);
      }
    }
    if (!touched) continue;
    report.configs++;
    // The bot drops the retired logins on a restart, made only while it RUNS:
    // the check and the restart are ONE shell command under the container's
    // lock (2026-10-03) — a `docker ps` followed by a separate restart let a
    // park that landed in between be undone. restorePolicy keeps what
    // restartConfigContainer did; TWITCHBOT_ALLOW_RESTART=0 still turns the
    // restart off. A config left with no accounts is stopped instead: a bot
    // with none spins in a login-retry loop (botHosts.stopIfNoAccounts).
    const container = list[0].container;
    if (!container) continue;
    try {
      if (
        typeof d.hosts.stopIfNoAccounts === "function" &&
        (await d.hosts.stopIfNoAccounts(host, file, container)).stopped
      ) {
        report.stopped.push(container);
        continue;
      }
      if (!allowRestart) continue;
      const r = await restartIfRunning(host, container, { restorePolicy: true });
      if (r && r.restarted) report.restarted.push(container);
    } catch (err) {
      report.errors.push(hostId + "/" + file + " restart: " + err.message);
    }
  }
  if (report.retired.length) {
    progress(
      "Dead-token retire: took " + report.retired.length + " sold account(s) out of " + report.configs +
        " bot config(s)" + (report.restarted.length ? "; restarted " + report.restarted.join(", ") : "") +
        (report.stopped.length ? "; stopped " + report.stopped.join(", ") + " (no accounts left)" : "") +
        (report.surface.length ? "; " + report.surface.length + " unsold dead-token account(s) left for re-auth" : "") + ".",
    );
    await d
      .sendTelegram(
        "🧹 Took " + report.retired.length + " sold account(s) with a dead Twitch token out of their bots (" +
          report.retired.map((e) => e.login).slice(0, 8).join(", ") + (report.retired.length > 8 ? ", …" : "") +
          ") — the buyers secured them. Rows, drops and sales kept." +
          (report.surface.length ? " " + report.surface.length + " unsold dead-token account(s) still need re-auth." : ""),
      )
      .catch(() => {});
  }
  return report;
}

module.exports = {
  DEFAULT_HOURS,
  MIN_HOURS,
  MAX_HOURS,
  RECONFIRM_GAP_MS,
  clampHours,
  decide,
  plan,
  retireSoldDeadTokens,
};
