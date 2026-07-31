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

function norm(s) {
  return String(s || "").trim().toLowerCase();
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

// Classify every enabled account in `file` on `host`.
//
// Returns { assignedGames, total, working, finished, unknown, notStarted,
//           stoppable, accounts }. `stoppable` is the only field a caller
//           should act on, and it is deliberately conservative: it requires at
//           least one account and zero working / unknown / not-started.
async function botCompletion(hostId, file, opts = {}) {
  const host = hosts.resolveHost(hostId);
  if (!host) throw new Error("Unknown host: " + hostId);
  const freshMs = Number(opts.freshMs) || FRESH_MS;

  const data = JSON.parse(await hosts.readFile(host, file));
  const configLevel = Array.isArray(data.FavouriteGames)
    ? data.FavouriteGames
    : [];
  // OnlyFavouriteGames off means the bot may wander onto any campaign, so the
  // "assigned games" narrowing is unsound — fall back to counting all pending
  // work, which is the strictly safer reading.
  const onlyFavourites =
    !data.TwitchSettings || data.TwitchSettings.OnlyFavouriteGames !== false;

  const users = usersOf(data).filter((u) => u && u.Enabled !== false);
  const secrets = users
    .map((u) => String((u && u.ClientSecret) || "").trim())
    .filter(Boolean);
  if (!secrets.length) {
    return {
      host: host.id, file, assignedGames: configLevel.map(norm),
      total: 0, working: 0, finished: 0, unknown: 0, notStarted: 0,
      stoppable: false, reason: "no enabled accounts", accounts: [],
    };
  }

  const rows = await BotAccount.find(
    { clientSecret: { $in: secrets } },
    {
      clientSecret: 1, login: 1, inProgressCount: 1, inProgressGames: 1,
      dropCount: 1, lastScanAt: 1, lastScanStatus: 1,
    },
  ).lean();
  const bySecret = new Map(rows.map((r) => [r.clientSecret, r]));

  const cutoff = Date.now() - freshMs;
  const out = { working: [], finished: [], unknown: [], notStarted: [] };
  const assignedAll = new Set();
  // The oldest scan behind this verdict. A caller that stops containers uses it
  // to ask "did a campaign for these games start AFTER the evidence I am
  // judging on?" — see the newer-campaign guard in botWaker.stopFinishedBots.
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
    if (oldestScanAt == null || scannedAt < oldestScanAt) oldestScanAt = scannedAt;
    const pendingGames = (rec.inProgressGames || []).map(norm);
    const onAssigned = onlyFavourites
      ? pendingGames.filter((g) => mine.includes(g))
      : pendingGames;
    if (onAssigned.length) {
      out.working.push(label);
    } else if (!rec.dropCount) {
      // Nothing pending and nothing earned: hasn't started, not finished.
      out.notStarted.push(label);
    } else {
      out.finished.push(label);
    }
  }

  const total = users.length;
  // A config whose accounts name no games at all is unreadable as a verdict.
  // With OnlyFavouriteGames on and an empty list there is nothing to intersect
  // pending work against, so EVERY scanned account trivially looks finished and
  // the whole container would be parked on no evidence. Several manual bots on
  // prod are shaped exactly like this and hold 100+ accounts each.
  const noAssignedGames = assignedAll.size === 0;
  const stoppable =
    total > 0 &&
    !noAssignedGames &&
    out.working.length === 0 &&
    out.unknown.length === 0 &&
    out.notStarted.length === 0;

  return {
    host: host.id,
    file,
    onlyFavourites,
    assignedGames: [...assignedAll],
    oldestScanAt: oldestScanAt == null ? null : new Date(oldestScanAt),
    total,
    working: out.working.length,
    finished: out.finished.length,
    unknown: out.unknown.length,
    notStarted: out.notStarted.length,
    stoppable,
    reason: stoppable
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

module.exports = { botCompletion, gamesForUser };
