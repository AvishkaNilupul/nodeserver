// Farm control: stop a bot account from farming a specific game without
// touching the other games it farms and without restarting the whole fleet.
//
// When a sold account's buyer connects a game (its drops show as
// connected/redeemed), farming that game again is wasted effort and could
// even interfere with the buyer. The account's TwitchDropsBot config entry
// is edited in place — the game is removed from that account's
// FavouriteGames — and only that account's container is restarted, and only
// if it is running (a parked bot is never started by this). The bot script
// itself is never modified, so nothing needs to be re-deployed to the
// Raspberry Pi or the server.

const hosts = require("./botHosts");
const { withFileLock } = require("./fileLock");
const AuditFinding = require("../models/AuditFinding");

// Log each stop as an already-resolved finding so it shows up as activity on
// the Integrity page, next to the guardian's restock log. A stop whose reload
// FAILED is not done — the bot still runs the old config — so it is logged
// open, and resolved when a later visit's retry lands. Returns the finding.
async function logStop(acc, game, detail, { failed = false } = {}) {
  try {
    return await AuditFinding.create({
      type: "farm-stopped",
      severity: failed ? "low" : "info",
      accountId: String(acc._id || ""),
      accountLogin: acc.login || "",
      dedupeKey: "farm-stopped:" + acc._id + ":" + Date.now(),
      status: failed ? "open" : "resolved",
      resolution: failed ? "" : "auto",
      resolvedAt: failed ? null : new Date(),
      message: detail,
    });
  } catch (e) {
    console.error("farmControl: failed to log stop:", e.message);
    return null;
  }
}

// (hostId|configFile|clientSecret|game) combos already handled this process,
// so a scan of the same sold account doesn't re-read the config every pass. A
// handled edit whose reload failed is still owed — see pendingReloads below.
const handled = new Set();

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Reload a bot's config by restarting its container — but ONLY while it runs.
// `docker restart` STARTS a stopped container, and a stopped bot is parked
// (utils/botWaker.js) or was stopped on purpose; starting it wakes it with no
// wake trigger and nothing recorded, and the next tick just parks it again. A
// bot reads its config at startup, so a stopped one picks the edit up whenever
// it is next started.
//
// The check and the restart are ONE shell command on the host (2026-10-03).
// Reading `docker ps` and then sending `docker restart` in a second SSH call
// left a round trip between them, and a park whose stop landed in it was
// undone. And the step holds the container's lock (botHosts.withContainerLock),
// which a park holds from its restart-policy change to the end of its stop: a
// park still in flight reads "running" until the bot exits, so it is waited
// out rather than restarted over. The check is docker's State.Status, the
// value `docker ps` shows (State.Running is also true while paused/restarting).
//
// Round-2 review (2026-10-03):
//   * Only "No such object/container" is "missing". Any other inspect failure
//     (daemon down, permission, no docker) is an error the caller sees — read
//     as "missing" it was a reload recorded as done that never happened.
//   * Every docker step runs under `timeout` on the host, inside a budget the
//     SSH call outlasts: an SSH client that gives up leaves its remote command
//     running, and a `docker restart` sent after a park had taken the lock and
//     stopped the bot started it again. A restart cut off mid-way may still be
//     finished by the daemon, so the command then waits settleS before exiting
//     — still inside the lock.
//   * A restart of a container that is running starts nothing, so it is not
//     reported to the start observers (botWaker would blame it for a start
//     someone else made).
//   opts.restorePolicy — after a REAL restart, set the restart policy back to
//     "always" (what restartConfigContainer does), inside the same lock.
//   opts.budget — overrides of REMOTE_BUDGET (seconds).
// Returns { restarted, state }; state is docker's status or "missing". Throws
// when the check or the restart failed.
const REMOTE_BUDGET = { inspectS: 20, restartS: 45, settleS: 15 };
const SSH_MARGIN_MS = 40000; // the SSH connection (ConnectTimeout 20 s) + slack

function restartIfRunningScript(container, budget = {}) {
  const b = { ...REMOTE_BUDGET, ...budget };
  const c = hosts.shq(container);
  return [
    "o=$(timeout -k 5 " + b.inspectS + " docker inspect -f '{{.State.Status}}' " + c + " 2>&1); rc=$?",
    'if [ "$rc" -ne 0 ]; then',
    '  case "$o" in *"No such object"*|*"No such container"*) echo "STATE missing"; exit 0;; esac',
    '  echo "docker inspect failed ($rc): $o" >&2; exit 1',
    "fi",
    's=$(printf \'%s\\n\' "$o" | tail -n 1)',
    'if [ "$s" != running ]; then echo "STATE ${s:-unknown}"; exit 0; fi',
    "timeout -k 5 " + b.restartS + " docker restart " + c + " >/dev/null; rc=$?",
    'if [ "$rc" -eq 0 ]; then echo RESTARTED; exit 0; fi',
    'case "$rc" in 124|137) sleep ' + b.settleS + ";; esac",
    'exit "$rc"',
  ].join("\n");
}

const unlocked = (_host, _container, fn) => fn();

async function restartIfRunning(host, container, { restorePolicy = false, budget } = {}) {
  const lock =
    typeof hosts.withContainerLock === "function" ? hosts.withContainerLock : unlocked;
  return lock(host, container, async () => {
    if (host && host.runtime === "native") {
      // botctl hosts (none since 2026-08-11) have no `docker inspect` or
      // `timeout`: the old two steps, still inside the lock.
      const st = ((await hosts.dockerPs(host)) || {})[container];
      const state = (st && st.state) || "missing";
      if (state !== "running") return { restarted: false, state };
      await hosts.dockerContainer(host, "restart", container, { notAStart: true });
    } else {
      const b = { ...REMOTE_BUDGET, ...(budget || {}) };
      const { stdout } = await hosts.runShell(host, restartIfRunningScript(container, b), {
        timeout: (b.inspectS + b.restartS + b.settleS) * 1000 + SSH_MARGIN_MS,
      });
      const last = String(stdout || "").trim().split("\n").pop().trim();
      if (last !== "RESTARTED") {
        if (!last.startsWith("STATE ")) {
          throw new Error(container + ": unexpected answer from the restart check: " + (last || "(nothing)"));
        }
        return { restarted: false, state: last.slice(6).trim() || "unknown" };
      }
    }
    if (restorePolicy) await hosts.restoreRestartPolicy(host, container);
    return { restarted: true, state: "running" };
  });
}

// ---------------------------------------------------------------------------
// Making a bot pick up an edit to its config — the ONE rule every config editor
// here uses (stopFarmingGame; the suspended-account and dead-token sweeps):
//   * no ENABLED account left → stop it if it runs (botHosts.stopIfNoAccounts),
//     never restart it: a bot with none spins in a login-retry loop. (Round-3
//     review, 2026-10-03: a sold account that was its config's last enabled
//     one used to be followed by a restart.)
//   * accounts left → restart it if it runs (restartIfRunning);
//   * cannot tell (config unreadable, `docker ps` failed) or the restart failed
//     → nothing now; the config is OWED a reload (pendingReloads) and it is
//     retried by the next sweep (retryPendingReloads) and by the next
//     stopFarmingGame visit to that config — first, before anything else.
// decideReload answers { done, outcome, note, why?, error? }; outcome is
// "restarted" | "stopped" | "left" (not running, or restarts turned off: it
// reads the edit when it next starts) | "unknown" | "failed".
// opts: restorePolicy (after a real restart, as restartConfigContainer);
// allowRestart (false = TWITCHBOT_ALLOW_RESTART=0); ops (stopIfNoAccounts /
// restartIfRunning stand-ins — utils/deadTokenRetire.js passes its deps).
// ---------------------------------------------------------------------------
async function decideReload(host, file, container, { restorePolicy = false, allowRestart = true, ops } = {}) {
  const o = ops || {};
  const stopIfEmpty = o.stopIfNoAccounts || hosts.stopIfNoAccounts;
  const restart = o.restartIfRunning || restartIfRunning;
  let s;
  try {
    s = (await stopIfEmpty(host, file, container, { noneEnabled: true })) || {};
  } catch (e) {
    const error = e.message || String(e);
    return { done: false, outcome: "failed", error, note: container + " not checked: " + error };
  }
  if (s.stopped) {
    return { done: true, outcome: "stopped", note: container + " stopped: no enabled account left in " + file };
  }
  if (s.empty === true && s.state && s.state !== "unknown") {
    return { done: true, outcome: "left", note: container + " is " + s.state + " with no enabled account left — left stopped" };
  }
  if (s.empty !== false) {
    const why = s.empty === null ? "config unreadable" : "no enabled account; docker ps failed";
    return { done: false, outcome: "unknown", why, note: container + " not restarted (" + why + ")" };
  }
  if (!allowRestart) {
    return { done: true, outcome: "left", note: container + " not restarted: restarts are turned off" };
  }
  try {
    const r = await restart(host, container, { restorePolicy });
    if (r && r.restarted) return { done: true, outcome: "restarted", note: "restarted " + container };
    return {
      done: true,
      outcome: "left",
      note: container + " is " + ((r && r.state) || "?") + ", left stopped (it reads the edit when it next starts)",
    };
  } catch (e) {
    const error = e.message || String(e);
    return { done: false, outcome: "failed", error, note: container + " restart FAILED: " + error };
  }
}

// hostId|file -> { host, file, container, opts, findings: [{ id, gen }], gen,
// retrying }. In memory: a server restart forgets it (the next restart of the
// bot, for any reason, then picks the edit up). `gen` orders failures against
// reloads: a reload that STARTED after a failure covers it; one that started
// before may have read the config before that failure's edit.
const pendingReloads = new Map();
const settledUpTo = new Map(); // hostId|file -> newest gen a reload has covered
let genSeq = 0;

const reloadKey = (host, file) => String((host && host.id) || "") + "|" + String(file || "");

function owe(key, host, file, container, opts) {
  let e = pendingReloads.get(key);
  if (!e) {
    e = { host, file, container, opts: {}, findings: [], gen: 0, retrying: null };
    pendingReloads.set(key, e);
  }
  e.container = container || e.container;
  e.opts = {
    restorePolicy: !!(e.opts.restorePolicy || (opts && opts.restorePolicy)),
    allowRestart: !(opts && opts.allowRestart === false),
    ops: (opts && opts.ops) || e.opts.ops,
  };
  e.gen = ++genSeq;
  return e.gen;
}

async function resolveFindings(ids) {
  for (const id of ids) {
    try {
      await AuditFinding.updateOne(
        { _id: id },
        { $set: { status: "resolved", resolution: "auto", resolvedAt: new Date() } },
      );
    } catch (e) {
      console.error("farmControl: failed to resolve stop finding:", e.message);
    }
  }
}

// A reload that started at `gen` has landed: every failure owed up to then is
// covered — its findings resolve, and the entry goes unless a newer failure
// arrived meanwhile.
async function settle(key, gen) {
  settledUpTo.set(key, Math.max(settledUpTo.get(key) || 0, gen));
  const e = pendingReloads.get(key);
  if (!e) return;
  const covered = e.findings.filter((f) => f.gen <= gen).map((f) => f.id);
  e.findings = e.findings.filter((f) => f.gen > gen);
  if (e.gen <= gen) pendingReloads.delete(key);
  await resolveFindings(covered);
}

// The stop finding of a failure owed at `gen`: resolved now if a later reload
// already covered it, else resolved when one does.
async function attachFinding(key, id, gen) {
  if (!id) return;
  if ((settledUpTo.get(key) || 0) >= gen) return resolveFindings([id]);
  const e = pendingReloads.get(key);
  if (e) e.findings.push({ id, gen });
}

// Reload a config's bot now; owed (and retried later) when it cannot be done.
async function reloadConfig(host, file, container, opts = {}) {
  const key = reloadKey(host, file);
  const start = genSeq;
  const r = await decideReload(host, file, container, opts);
  if (r.done) {
    await settle(key, start);
    return r;
  }
  return { ...r, gen: owe(key, host, file, container, opts) };
}

// Retry one config's owed reload. Two retries of one config share the attempt.
function retryPending(key) {
  const e = pendingReloads.get(key);
  if (!e) return Promise.resolve(null);
  if (!e.retrying) {
    const start = genSeq;
    e.retrying = decideReload(e.host, e.file, e.container, e.opts)
      .then(async (r) => {
        if (r.done) await settle(key, start);
        return r;
      })
      .finally(() => {
        e.retrying = null;
      });
  }
  return e.retrying;
}

// Retry every owed reload (the sweeps call this each tick). A host that cannot
// be read costs one attempt per call, not one per config on it.
async function retryPendingReloads() {
  const out = [];
  const skipHosts = new Set();
  for (const [key, e] of [...pendingReloads]) {
    const hostId = String((e.host && e.host.id) || "");
    if (skipHosts.has(hostId)) continue;
    const r = await retryPending(key);
    if (!r) continue;
    out.push({ host: hostId, file: e.file, container: e.container, ...r });
    if (!r.done) skipHosts.add(hostId);
  }
  return out;
}

// Remove `game` from `acc`'s FavouriteGames inside its bot config and restart
// just that container (when it is running). Returns { changed, reason }.
// Best-effort by design: callers log failures but never let them break a scan.
async function stopFarmingGame(acc, game) {
  const g = String(game || "").trim();
  if (!g) return { changed: false, reason: "no game name" };
  const file = String(acc.configFile || "").trim();
  if (!file) return { changed: false, reason: "account has no config file" };
  const hostId = String(acc.host || "local");
  const memoKey = hostId + "|" + file + "|" + acc.clientSecret + "|" + norm(g);

  const host = hosts.resolveHost(hostId);
  if (!host) return { changed: false, reason: "unknown host " + hostId };

  // A reload this config still owes goes FIRST — even when this account's edit
  // is already done (round-3 review): a second visit while the first reload was
  // still in flight read the edit as "nothing to do" and marked it done, and the
  // first visit's failed reload then waited where nothing looked.
  const key = reloadKey(host, file);
  let owed = "";
  if (pendingReloads.has(key)) {
    const r = await retryPending(key);
    if (r) owed = "; owed reload " + (r.done ? "done: " : "still owed: ") + r.note;
  }
  if (handled.has(memoKey)) return { changed: false, reason: "already done" + owed };

  // The read-modify-write holds the config's file lock (utils/fileLock), like
  // every other config writer (2026-10-03): two scanner lanes stopping two sold
  // accounts of one config — or a removeAccountFromConfig meanwhile — each read
  // the old file, the later write dropped the other's edit, and both were
  // memoised as done. The reload runs after, outside the lock.
  const edit = await withFileLock(host, file, () => editConfig(acc, g, host, hostId, file, memoKey));
  if (edit.result) return owed ? { ...edit.result, reason: edit.result.reason + owed } : edit.result;
  const { next, disabled } = edit;
  handled.add(memoKey);

  // Reload only this account's container; the rest of the fleet is untouched.
  const container = String(acc.container || "").trim();
  const reload = container
    ? await reloadConfig(host, file, container)
    : { done: true, outcome: "none", note: "(no container known — not restarted)" };
  const finding = await logStop(
    acc,
    g,
    'Buyer connected "' +
      g +
      '" on sold account ' +
      (acc.login || String(acc.clientSecret || "").slice(0, 6)) +
      " — " +
      (disabled
        ? "no games left, account disabled"
        : "stopped farming it (still farming: " + next.join(", ") + ")") +
      " in " +
      file +
      " on " +
      hostId +
      (reload.outcome === "restarted" ? ", restarted " + container : " — " + reload.note) +
      (reload.done
        ? "."
        : ". The bot still runs its old config; the reload is retried by the next sweep or scan."),
    { failed: !reload.done },
  );
  if (!reload.done) await attachFinding(key, finding && finding._id, reload.gen);
  return { changed: true, reason: reload.outcome === "restarted" ? "" : "— " + reload.note };
}

// For tests: forget every owed reload and handled combo.
function _resetForTests() {
  handled.clear();
  pendingReloads.clear();
  settledUpTo.clear();
}

// The config edit of stopFarmingGame, run under the file lock. Returns
// { result } when there is nothing to change, else { next, disabled } once the
// edit is written.
async function editConfig(acc, g, host, hostId, file, memoKey) {
  const raw = await hosts.readFile(host, file);
  const cfg = JSON.parse(raw);
  const users =
    cfg && cfg.TwitchSettings && Array.isArray(cfg.TwitchSettings.TwitchUsers)
      ? cfg.TwitchSettings.TwitchUsers
      : null;
  if (!users) return { result: { changed: false, reason: "config has no TwitchUsers" } };

  const me = users.find(
    (u) =>
      u &&
      ((u.ClientSecret && u.ClientSecret === acc.clientSecret) ||
        (u.Login && acc.login && norm(u.Login) === norm(acc.login))),
  );
  if (!me) {
    handled.add(memoKey);
    return { result: { changed: false, reason: "account not in config" } };
  }
  // A disabled account farms nothing, so there is nothing to stop. This must
  // be checked FIRST: disabling (below) leaves the account's own list EMPTY,
  // which reads as "inherit the config-level games", so re-deriving the
  // effective list on the next scan "removed" the same game again, rewrote an
  // identical config and restarted the container — after every server restart
  // cleared `handled`, i.e. about daily per sold account. Measured 2026-09-29:
  // 770 such restarts in 8 days across 16 bots, and each one STARTED a parked
  // bot (`docker restart` starts a stopped container) that the next tick
  // parked again — the contabo twitchbotx8/x19/x11 wake/park flap.
  if (me.Enabled === false) {
    handled.add(memoKey);
    return { result: { changed: false, reason: "account already disabled" } };
  }

  // Accounts usually have no FavouriteGames of their own and inherit the
  // config-level list; a per-account list overrides it. So the effective list
  // is the account's own when set, else the config-level one — and to stop
  // just this account we give it its OWN list with the game removed, leaving
  // every other account (and the config-level list) untouched.
  const own = Array.isArray(me.FavouriteGames) ? me.FavouriteGames : [];
  const inherited = Array.isArray(cfg.FavouriteGames) ? cfg.FavouriteGames : [];
  const effective = own.length ? own : inherited;
  const next = effective.filter((f) => norm(f) !== norm(g));
  if (next.length === effective.length) {
    handled.add(memoKey);
    return { result: { changed: false, reason: "game not in FavouriteGames" } };
  }
  me.FavouriteGames = next;
  // An empty per-account list means "inherit the config-level games", which
  // would bring the removed game right back — so when no games remain for
  // this account, disable it instead. The other accounts keep farming.
  const disabled = !next.length;
  if (disabled) me.Enabled = false;

  await hosts.saveSnapshot(hostId, file, raw);
  await hosts.writeFileAtomic(host, file, JSON.stringify(cfg, null, 2));
  return { next, disabled };
}

module.exports = {
  stopFarmingGame,
  restartIfRunning,
  restartIfRunningScript,
  reloadConfig,
  retryPendingReloads,
  REMOTE_BUDGET,
  _resetForTests,
};
