// Farm control: stop a bot account from farming a specific game without
// touching the other games it farms and without restarting the whole fleet.
//
// When a sold account's buyer connects a game (its drops show as
// connected/redeemed), farming that game again is wasted effort and could
// even interfere with the buyer. The account's TwitchDropsBot config entry
// is edited in place — the game is removed from that account's
// FavouriteGames — and only that account's container is restarted. The bot
// script itself is never modified, so nothing needs to be re-deployed to the
// Raspberry Pi or the server.

const hosts = require("./botHosts");

// (hostId|configFile|clientSecret|game) combos already handled this process,
// so a scan of the same sold account doesn't re-read the config every pass.
const handled = new Set();

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Remove `game` from `acc`'s FavouriteGames inside its bot config and restart
// just that container. Returns { changed, reason }. Best-effort by design:
// callers log failures but never let them break a scan.
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
  if (!next.length) me.Enabled = false;

  await hosts.saveSnapshot(hostId, file, raw);
  await hosts.writeFileAtomic(host, file, JSON.stringify(cfg, null, 2));
  handled.add(memoKey);

  // Restart only this account's container so the bot reloads its config.
  // The rest of the fleet keeps running untouched.
  const container = String(acc.container || "").trim();
  if (container) {
    try {
      await hosts.dockerContainer(host, "restart", container);
    } catch (e) {
      return {
        changed: true,
        reason:
          "config updated but container restart failed: " +
          (e.message || String(e)),
      };
    }
  }
  return { changed: true, reason: "" };
}

module.exports = { stopFarmingGame };
