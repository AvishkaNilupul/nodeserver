// Is a bot container actually finished with the work it was given?
//
// WHY THIS IS NOT JUST `inProgressCount === 0`
// BotAccount.inProgressCount is raw Twitch data: it counts EVERY campaign the
// account has partial, unclaimed progress on. That is not the same as work the
// bot can still do. Auto-created bots (and the big manual ones) run with
// TwitchSettings.OnlyFavouriteGames = true, so a container only ever watches
// the games in its FavouriteGames list. Progress on anything else is stranded —
// nothing will ever advance it.
//
// Observed on the Pi 2026-07-28: every sampled account in twitchbotx19
// ("Sea of Thieves") and twitchbotx20 ("Delta Force") reported 2 unclaimed
// drops in progress, all of them "Assassin's Creed Black Flag Resynced" — a
// game neither container farms, frozen at 2/120 minutes. Judged on
// inProgressCount alone both bots look busy forever; judged on the games they
// were actually assigned, both are done. So completion MUST be the
// intersection of in-progress work with assigned games.
//
// The other half of the rule (see models/BotAccount.js): an account that has
// never been scanned, or whose last scan failed, is UNKNOWN — never finished.
// Twitch also only lists a campaign as in-progress once watching has started,
// so "no pending work" on an account holding no drops means "hasn't begun",
// not "done". Both cases are counted separately here and a bot is only
// stoppable when there are none of either.
const hosts = require("./botHosts");
const BotAccount = require("../models/BotAccount");

// Stale scans are worthless for this decision — a verdict from before the
// current campaign started would happily stop a bot that is mid-drop.
const FRESH_MS = 24 * 60 * 60 * 1000;
const PARK_FRESH_MS = 30 * 60 * 60 * 1000;

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function usersOf(data) {
  return data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
    ? data.TwitchSettings.TwitchUsers
    : [];
}

// The games one account in this config actually farms. An empty per-account
// FavouriteGames INHERITS the config-level list — the same rule
// botConsolidator.materializeGames exists to protect.
function gamesForUser(user, configLevel) {
  const own = Array.isArray(user && user.FavouriteGames)
    ? user.FavouriteGames
    : [];
  const list = own.length ? own : configLevel;
  return (Array.isArray(list) ? list : []).map(norm).filter(Boolean);
}

// Pure, batch-friendly half of botCompletion. A fleet watcher can read every
// config on a host in one hosts.readFiles() call and every referenced account
// in one Mongo query, then apply the exact same completion rules per bot.
//
// VERIFY-EARNED (opts.requireEarned + opts.dropGamesByLogin):
// Without it, an account with no in-progress work on its assigned games is
// "finished" as long as it earned SOME drop globally (rec.dropCount). That is
// the hole this closes: a bot that never farmed its assigned game (no stream was
// ever live) still looked finished. With requireEarned on, `dropGamesByLogin`
// (login → Set of normalised games the account actually HOLDS a drop for, from
// DropLog) is consulted: an account missing a drop for any assigned game is
// counted as notStarted (not finished), so the bot stays up until it has really
// earned every game. Fail-safe: a login we can't resolve falls back to the
// dropCount rule, so a missing map can only keep a bot up, never strand it.
function classifyBotCompletion(data, rows, opts = {}) {
  const freshMs = Number(opts.freshMs) || FRESH_MS;
  const nowMs = opts.now == null ? Date.now() : new Date(opts.now).getTime();
  const requireEarned = !!opts.requireEarned && opts.dropGamesByLogin != null;
  const dropGamesByLogin =
    opts.dropGamesByLogin instanceof Map ? opts.dropGamesByLogin : null;
  const configLevel = Array.isArray(data && data.FavouriteGames)
    ? data.FavouriteGames
    : [];
  const onlyFavourites =
    !data ||
    !data.TwitchSettings ||
    data.TwitchSettings.OnlyFavouriteGames !== false;
  const users = usersOf(data).filter((u) => u && u.Enabled !== false);
  const bySecret = new Map(
    (rows || [])
      .filter((r) => r && r.clientSecret)
      .map((r) => [String(r.clientSecret), r]),
  );
  const cutoff = nowMs - freshMs;
  const out = { working: [], finished: [], unknown: [], notStarted: [] };
  const assignedAll = new Set();
  let oldestScanAt = null;

  for (const u of users) {
    const secret = String(u.ClientSecret || "").trim();
    const rec = bySecret.get(secret);
    const label = (rec && rec.login) || u.Login || secret.slice(0, 8);
    const mine = gamesForUser(u, configLevel);
    mine.forEach((g) => assignedAll.add(g));

    if (
      !rec ||
      rec.inProgressCount == null ||
      rec.lastScanStatus !== "ok" ||
      !rec.lastScanAt ||
      new Date(rec.lastScanAt).getTime() < cutoff
    ) {
      out.unknown.push(label);
      continue;
    }
    const scannedAt = new Date(rec.lastScanAt).getTime();
    if (oldestScanAt == null || scannedAt < oldestScanAt)
      oldestScanAt = scannedAt;
    const pendingGames = (rec.inProgressGames || []).map(norm);
    const onAssigned = onlyFavourites
      ? pendingGames.filter((g) => mine.includes(g))
      : pendingGames;
    if (onAssigned.length) {
      out.working.push(label);
    } else if (requireEarned && dropGamesByLogin && (rec.login || u.Login)) {
      // Per-game evidence: finished only when the account holds a drop for every
      // game it was assigned. Missing any → it hasn't actually farmed that game.
      const held =
        dropGamesByLogin.get(norm(rec.login || u.Login)) || new Set();
      const missing = mine.filter((g) => !held.has(g));
      if (missing.length) out.notStarted.push(label);
      else out.finished.push(label);
    } else if (!rec.dropCount) {
      out.notStarted.push(label);
    } else {
      out.finished.push(label);
    }
  }

  const total = users.length;
  const noAssignedGames = assignedAll.size === 0;
  const stoppable =
    total > 0 &&
    !noAssignedGames &&
    out.working.length === 0 &&
    out.unknown.length === 0 &&
    out.notStarted.length === 0;

  return {
    onlyFavourites,
    assignedGames: total ? [...assignedAll] : configLevel.map(norm),
    oldestScanAt: oldestScanAt == null ? null : new Date(oldestScanAt),
    total,
    working: out.working.length,
    finished: out.finished.length,
    unknown: out.unknown.length,
    notStarted: out.notStarted.length,
    stoppable,
    reason: !total
      ? "no enabled accounts"
      : stoppable
        ? "every enabled account has finished its assigned games"
        : [
            noAssignedGames ? "no assigned games — cannot judge" : "",
            out.working.length ? out.working.length + " still working" : "",
            out.unknown.length ? out.unknown.length + " unscanned/stale" : "",
            out.notStarted.length ? out.notStarted.length + " not started" : "",
          ]
            .filter(Boolean)
            .join(", "),
    samples: {
      working: out.working.slice(0, 5),
      unknown: out.unknown.slice(0, 5),
      notStarted: out.notStarted.slice(0, 5),
    },
  };
}

// Classify every enabled account in `file` on `host`.
//
// Returns { assignedGames, total, working, finished, unknown, notStarted,
//           stoppable, accounts }. `stoppable` is the only field a caller
//           should act on, and it is deliberately conservative: it requires at
//           least one account and zero working / unknown / not-started.
async function botCompletion(hostId, file, opts = {}) {
  const host = hosts.resolveHost(hostId);
  if (!host) throw new Error("Unknown host: " + hostId);
  const data = JSON.parse(await hosts.readFile(host, file));
  const users = usersOf(data).filter((u) => u && u.Enabled !== false);
  const secrets = users
    .map((u) => String((u && u.ClientSecret) || "").trim())
    .filter(Boolean);
  const rows = secrets.length
    ? await BotAccount.find(
        { clientSecret: { $in: secrets } },
        {
          clientSecret: 1,
          login: 1,
          inProgressCount: 1,
          inProgressGames: 1,
          dropCount: 1,
          lastScanAt: 1,
          lastScanStatus: 1,
        },
      ).lean()
    : [];

  // Verify-earned: build login → {games actually held} from DropLog so the
  // classifier can require a real drop per assigned game. Only when asked (the
  // extra query is skipped for the default global-dropCount verdict).
  let dropGamesByLogin = null;
  if (opts.requireEarned) {
    const logins = rows.map((r) => r.login).filter(Boolean);
    dropGamesByLogin = new Map();
    if (logins.length) {
      const DropLog = require("../models/DropLog");
      const drops = await DropLog.find(
        { login: { $in: logins } },
        { login: 1, game: 1 },
      ).lean();
      for (const d of drops) {
        const key = norm(d.login);
        const g = norm(d.game);
        if (!key || !g) continue;
        if (!dropGamesByLogin.has(key)) dropGamesByLogin.set(key, new Set());
        dropGamesByLogin.get(key).add(g);
      }
    }
  }

  return {
    host: host.id,
    file,
    ...classifyBotCompletion(data, rows, { ...opts, dropGamesByLogin }),
  };
}

module.exports = {
  FRESH_MS,
  PARK_FRESH_MS,
  botCompletion,
  classifyBotCompletion,
  gamesForUser,
};
