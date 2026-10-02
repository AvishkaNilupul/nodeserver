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
const AuditFinding = require("../models/AuditFinding");

// Log each stop as an already-resolved finding so it shows up as activity on
// the Integrity page, next to the guardian's restock log.
async function logStop(acc, game, detail) {
  try {
    await AuditFinding.create({
      type: "farm-stopped",
      severity: "info",
      accountId: String(acc._id || ""),
      accountLogin: acc.login || "",
      dedupeKey: "farm-stopped:" + acc._id + ":" + Date.now(),
      status: "resolved",
      resolution: "auto",
      resolvedAt: new Date(),
      message: detail,
    });
  } catch (e) {
    console.error("farmControl: failed to log stop:", e.message);
  }
}

// (hostId|configFile|clientSecret|game) combos already handled this process,
// so a scan of the same sold account doesn't re-read the config every pass.
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
//   opts.restorePolicy — after a REAL restart, set the restart policy back to
//     "always" (what restartConfigContainer does), inside the same lock.
// Returns { restarted, state }; state is docker's status or "missing".
function restartIfRunningScript(container) {
  const c = hosts.shq(container);
  return (
    "s=$(docker inspect -f '{{.State.Status}}' " + c + " 2>/dev/null) || s=missing; " +
    'if [ "$s" = running ]; then docker restart ' + c + " >/dev/null && echo RESTARTED; " +
    'else echo "STATE ${s:-missing}"; fi'
  );
}

const unlocked = (_host, _container, fn) => fn();

async function restartIfRunning(host, container, { restorePolicy = false } = {}) {
  // Taken before the first await, while the caller is still on the stack.
  const caller =
    typeof hosts.callerFrames === "function" ? hosts.callerFrames(new Error().stack) : "";
  const lock =
    typeof hosts.withContainerLock === "function" ? hosts.withContainerLock : unlocked;
  return lock(host, container, async () => {
    if (host && host.runtime === "native") {
      // botctl hosts (none since 2026-08-11) have no `docker inspect`: the
      // old two steps, still inside the lock. dockerContainer reports the start.
      const st = ((await hosts.dockerPs(host)) || {})[container];
      const state = (st && st.state) || "missing";
      if (state !== "running") return { restarted: false, state };
      await hosts.dockerContainer(host, "restart", container);
    } else {
      const { stdout } = await hosts.runShell(host, restartIfRunningScript(container), {
        timeout: 60000,
      });
      const last = String(stdout || "").trim().split("\n").pop().trim();
      if (last !== "RESTARTED") {
        const state = last.startsWith("STATE ") ? last.slice(6).trim() || "missing" : "unknown";
        return { restarted: false, state };
      }
      if (typeof hosts.notifyContainerStart === "function") {
        hosts.notifyContainerStart(host, "restart", container, caller);
      }
    }
    if (restorePolicy) await hosts.restoreRestartPolicy(host, container);
    return { restarted: true, state: "running" };
  });
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

  const raw = await hosts.readFile(host, file);
  const cfg = JSON.parse(raw);
  const users =
    cfg && cfg.TwitchSettings && Array.isArray(cfg.TwitchSettings.TwitchUsers)
      ? cfg.TwitchSettings.TwitchUsers
      : null;
  if (!users) return { changed: false, reason: "config has no TwitchUsers" };

  const me = users.find(
    (u) =>
      u &&
      ((u.ClientSecret && u.ClientSecret === acc.clientSecret) ||
        (u.Login && acc.login && norm(u.Login) === norm(acc.login))),
  );
  if (!me) {
    handled.add(memoKey);
    return { changed: false, reason: "account not in config" };
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
    return { changed: false, reason: "account already disabled" };
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
    return { changed: false, reason: "game not in FavouriteGames" };
  }
  me.FavouriteGames = next;
  // An empty per-account list means "inherit the config-level games", which
  // would bring the removed game right back — so when no games remain for
  // this account, disable it instead. The other accounts keep farming.
  const disabled = !next.length;
  if (disabled) me.Enabled = false;

  await hosts.saveSnapshot(hostId, file, raw);
  await hosts.writeFileAtomic(host, file, JSON.stringify(cfg, null, 2));
  handled.add(memoKey);

  // Restart only this account's container so the bot reloads its config.
  // The rest of the fleet keeps running untouched.
  const container = String(acc.container || "").trim();
  let restartNote = container ? "" : " (no container known — not restarted)";
  let restarted = false;
  if (container) {
    try {
      const r = await restartIfRunning(host, container);
      restarted = r.restarted;
      if (!restarted) {
        restartNote =
          " — " + container + " is " + r.state +
          ", left stopped (it reads the edit when it next starts)";
      }
    } catch (e) {
      restartNote =
        " — " + container + " restart FAILED: " + (e.message || String(e));
    }
  }
  await logStop(
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
      (restarted ? ", restarted " + container : "") +
      restartNote +
      ".",
  );
  if (restartNote && container) {
    return { changed: true, reason: restartNote.trim() };
  }
  return { changed: true, reason: "" };
}

module.exports = { stopFarmingGame, restartIfRunning, restartIfRunningScript };
