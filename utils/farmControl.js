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
// combo is handled once its edit landed AND its bot reloaded (or needed no
// reload). One whose reload failed waits in pendingReload instead, and its
// next visit retries just the reload: the edit is already in the file, so
// re-deriving it would read "nothing to do" while the bot kept farming the
// game on its old config (2026-10-03).
const handled = new Set();
const pendingReload = new Map(); // memoKey -> { container, findingId }

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

// Reload `container` after a config edit: { ok, restarted, note }. ok is false
// only when the reload itself failed — the edit is in the file either way.
async function reloadBot(host, container) {
  if (!container) return { ok: true, restarted: false, note: " (no container known — not restarted)" };
  try {
    const r = await restartIfRunning(host, container);
    if (r.restarted) return { ok: true, restarted: true, note: "" };
    return {
      ok: true,
      restarted: false,
      note: " — " + container + " is " + r.state + ", left stopped (it reads the edit when it next starts)",
    };
  } catch (e) {
    return { ok: false, restarted: false, note: " — " + container + " restart FAILED: " + (e.message || String(e)) };
  }
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
  if (handled.has(memoKey)) return { changed: false, reason: "already done" };

  const host = hosts.resolveHost(hostId);
  if (!host) return { changed: false, reason: "unknown host " + hostId };

  const pending = pendingReload.get(memoKey);
  if (pending) return retryReload(host, memoKey, pending);

  // The read-modify-write holds the config's file lock (utils/fileLock), like
  // every other config writer (2026-10-03): two scanner lanes stopping two sold
  // accounts of one config — or a removeAccountFromConfig meanwhile — each read
  // the old file, the later write dropped the other's edit, and both were
  // memoised as done. The reload runs after, outside the lock.
  const edit = await withFileLock(host, file, () => editConfig(acc, g, host, hostId, file, memoKey));
  if (edit.result) return edit.result;
  const { next, disabled } = edit;

  // Restart only this account's container so the bot reloads its config.
  // The rest of the fleet keeps running untouched.
  const container = String(acc.container || "").trim();
  const reload = await reloadBot(host, container);
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
      (reload.restarted ? ", restarted " + container : "") +
      reload.note +
      (reload.ok ? "." : ". The bot still runs its old config; the restart is retried on the account's next scan."),
    { failed: !reload.ok },
  );
  if (reload.ok) handled.add(memoKey);
  else pendingReload.set(memoKey, { container, findingId: finding && finding._id });
  return { changed: true, reason: reload.note.trim() };
}

// A reload that failed after its edit landed: retry just the reload. Resolves
// the stop's open finding once it lands.
async function retryReload(host, memoKey, pending) {
  const reload = await reloadBot(host, pending.container);
  if (!reload.ok) return { changed: false, reason: "reload still failing" + reload.note };
  pendingReload.delete(memoKey);
  handled.add(memoKey);
  if (pending.findingId) {
    try {
      await AuditFinding.updateOne(
        { _id: pending.findingId },
        { $set: { status: "resolved", resolution: "auto", resolvedAt: new Date() } },
      );
    } catch (e) {
      console.error("farmControl: failed to resolve stop finding:", e.message);
    }
  }
  return {
    changed: false,
    reason: "reload retried" + (reload.restarted ? ": restarted " + pending.container : reload.note),
  };
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

module.exports = { stopFarmingGame, restartIfRunning, restartIfRunningScript, REMOTE_BUDGET };
