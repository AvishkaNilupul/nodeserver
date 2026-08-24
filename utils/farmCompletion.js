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
const settings = require("./settings");

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
// VERIFY-EARNED (opts.requireEarned + opts.heldByLogin [+ opts.expectedByGame]):
// Without it, an account with no in-progress work on its assigned games is
// "finished" as long as it earned SOME drop globally (rec.dropCount). That is
// the hole this closes: a bot that never farmed its assigned game (no stream was
// ever live) still looked finished. With requireEarned on, `heldByLogin`
// (login → {games, benefitIds, itemKeys} the account actually HOLDS, from
// DropLog) is consulted: an account missing a drop for any assigned game is
// counted as notStarted (not finished), so the bot stays up until it has really
// earned every game. When `expectedByGame` is supplied (built from the
// persisted per-campaign manifests, models/CampaignDrops.js), the account must
// additionally hold every expected drop of every ACTIVE campaign of its games —
// the owner's "check everyone farmed everything correctly before sleeping".
// Fail-safe: a login we can't resolve counts as notStarted (keeps the bot up),
// so missing evidence can only ever keep a bot up, never strand it.
// Inclusive game↔game match, mirroring botWaker.gameMatchesCampaign so a
// config "overwatch" and a DropLog "Overwatch 2" still count as the same game.
// A false positive here only keeps a bot up (the safe direction).
function gameMatches(a, b) {
  const x = settings.normGameName(a);
  const y = settings.normGameName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function heldGamesMatch(heldGames, g) {
  for (const h of heldGames || []) if (gameMatches(h, g)) return true;
  return false;
}

// Any expected drop of any ACTIVE campaign of the assigned games missing from
// the account's held set → the bot is NOT fully farmed, keep it up. Matched by
// benefitId with itemKey (normalised name|game) as the fallback. A game with
// no persisted manifest skips the per-campaign check entirely — the per-game
// check below is still applied, and a missing manifest can only ever keep a
// bot up (fail toward farming).
function missingExpectedDrops(held, mine, expectedByGame) {
  if (!expectedByGame) return false;
  for (const g of mine) {
    const exp = expectedByGame.get(g);
    if (!exp || !exp.length) continue;
    for (const e of exp) {
      const okBenefit = !!e.benefitId && held.benefitIds.has(e.benefitId);
      const okItem = !!e.itemKey && held.itemKeys.has(e.itemKey);
      if (!okBenefit && !okItem) return true;
    }
  }
  return false;
}

function classifyBotCompletion(data, rows, opts = {}) {
  const freshMs = Number(opts.freshMs) || FRESH_MS;
  const nowMs = opts.now == null ? Date.now() : new Date(opts.now).getTime();
  // Verify-earned evidence. heldByLogin is the rich shape botCompletion builds
  // (games + benefitIds + itemKeys per login); the legacy dropGamesByLogin
  // map (login → Set of games) is still accepted and converted so existing
  // callers/tests keep working unchanged.
  const legacy =
    opts.dropGamesByLogin instanceof Map ? opts.dropGamesByLogin : null;
  const heldByLogin =
    opts.heldByLogin instanceof Map
      ? opts.heldByLogin
      : legacy
        ? new Map(
            [...legacy].map(([login, games]) => [
              login,
              {
                games: games instanceof Set ? games : new Set(),
                benefitIds: new Set(),
                itemKeys: new Set(),
              },
            ]),
          )
        : null;
  const requireEarned = !!opts.requireEarned && heldByLogin != null;
  const expectedByGame =
    opts.expectedByGame instanceof Map ? opts.expectedByGame : null;
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
    } else if (requireEarned && heldByLogin && (rec.login || u.Login)) {
      const held =
        heldByLogin.get(norm(rec.login || u.Login)) || {
          games: new Set(),
          benefitIds: new Set(),
          itemKeys: new Set(),
        };
      // Per-game evidence: finished only when the account holds a drop for
      // every game it was assigned (INCLUSIVE label match — "overwatch" must
      // match a "Overwatch 2" DropLog row). Missing any → it hasn't farmed it.
      const missing = mine.filter((g) => !heldGamesMatch(held.games, g));
      if (missing.length) {
        out.notStarted.push(label);
      } else if (missingExpectedDrops(held, mine, expectedByGame)) {
        // Per-campaign completeness: the account is missing drops its active
        // campaigns expect (e.g. a never-live game farmed nothing, or only
        // some of a multi-drop event). Keep the bot up until truly finished.
        out.notStarted.push(label);
      } else {
        out.finished.push(label);
      }
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

  // Verify-earned: build login → {games + benefitIds + itemKeys actually
  // held} from DropLog, and game → expected drops from the persisted campaign
  // manifests (models/CampaignDrops.js), so the classifier can require a real
  // drop per assigned game AND per active campaign. Only when asked (the extra
  // queries are skipped for the default global-dropCount verdict).
  let heldByLogin = null;
  let expectedByGame = null;
  if (opts.requireEarned) {
    const logins = rows.map((r) => r.login).filter(Boolean);
    heldByLogin = new Map();
    if (logins.length) {
      const DropLog = require("../models/DropLog");
      const drops = await DropLog.find(
        { login: { $in: logins } },
        { login: 1, game: 1, benefitId: 1, itemKey: 1 },
      ).lean();
      for (const d of drops) {
        const key = norm(d.login);
        if (!key) continue;
        let h = heldByLogin.get(key);
        if (!h) {
          h = { games: new Set(), benefitIds: new Set(), itemKeys: new Set() };
          heldByLogin.set(key, h);
        }
        const g = norm(d.game);
        if (g) h.games.add(g);
        if (d.benefitId) h.benefitIds.add(String(d.benefitId));
        if (d.itemKey) h.itemKeys.add(String(d.itemKey));
      }
    }
    expectedByGame = await buildExpectedByGame(data);
  }

  return {
    host: host.id,
    file,
    ...classifyBotCompletion(data, rows, { ...opts, heldByLogin, expectedByGame }),
  };
}

// Expected drops per ASSIGNED game, from the persisted manifests of every
// ACTIVE campaign whose game matches the config label inclusively. Keyed by
// the same normalised label classifyBotCompletion uses for `mine`, so a config
// "naraka" and a campaign "NARAKA: BLADEPOINT" land on the same key.
async function buildExpectedByGame(data) {
  const configLevel = Array.isArray(data && data.FavouriteGames)
    ? data.FavouriteGames
    : [];
  const assigned = new Set();
  for (const u of usersOf(data)) {
    if (!u || u.Enabled === false) continue;
    for (const g of gamesForUser(u, configLevel)) assigned.add(g);
  }
  if (!assigned.size) return new Map();
  const now = new Date();
  const TwitchCampaign = require("../models/TwitchCampaign");
  const CampaignDrops = require("../models/CampaignDrops");
  const camps = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1 },
  ).lean();
  const manis = await CampaignDrops.find({
    campaignId: { $in: camps.map((c) => c.campaignId) },
  }).lean();
  const byCampaign = new Map(manis.map((m) => [m.campaignId, m]));
  const out = new Map();
  for (const g of assigned) {
    const expected = [];
    const seen = new Set();
    for (const c of camps) {
      if (!gameMatches(g, c.game)) continue;
      const m = byCampaign.get(c.campaignId);
      if (!m || !Array.isArray(m.drops)) continue;
      for (const d of m.drops) {
        const key = String(d.benefitId || "") + "|" + String(d.itemKey || "");
        if (seen.has(key)) continue;
        seen.add(key);
        expected.push({ benefitId: d.benefitId || "", itemKey: d.itemKey || "" });
      }
    }
    if (expected.length) out.set(g, expected);
  }
  return out;
}

module.exports = {
  FRESH_MS,
  PARK_FRESH_MS,
  botCompletion,
  classifyBotCompletion,
  gamesForUser,
};
