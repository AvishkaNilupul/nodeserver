// Park a finished bot, and bring it back when its game gets a new campaign.
//
// WHY A SERVER-SIDE TRIGGER IS REQUIRED
// A stopped container cannot notice anything. TwitchDropsBot discovers new
// campaigns from inside its own 300-second poll loop, so the moment we stop it
// to reclaim RAM we also remove the only thing that would have restarted the
// work. Something outside the container has to watch for new campaigns and
// start it again — that is this module, driven from the auto-farm tick.
//
// WHY A PARK REGISTRY RATHER THAN AN INFERRED TIMESTAMP
// Three tempting signals all fail:
//   * BotAccount.farmingCompleteAt — only stamped when the RAW pending count
//     hits zero, and accounts routinely carry unclaimed progress for games
//     their bot does not farm (Pi bots 19/20 are permanently stuck on an
//     "Assassin's Creed Black Flag Resynced" entry they can never advance).
//     Those bots are finished, yet the field is never set, so a waker keyed on
//     it would leave them asleep forever.
//   * "accounts have work in progress" — Twitch only lists a campaign once
//     watching has begun, and a stopped bot watches nothing, so its accounts
//     can never accumulate in-progress work.
//   * DropLog.campaign — empty on every row for these accounts (they come from
//     the gameEventDrop source, which carries no campaign name), so "does this
//     account already hold that campaign's drops" is not answerable.
// So the moment we park a bot we simply RECORD it, and compare live campaign
// start times against that. A container we did not park has no entry and is
// never touched — someone stopped it by hand and it stays stopped.
const hosts = require("./botHosts");
const TwitchCampaign = require("../models/TwitchCampaign");
const { botCompletion } = require("./farmCompletion");
const settings = require("./settings");

const REGISTRY = "parked-bots.json";

// Broadcast-lag grace for the PARK decision. Esports/Twitch-Rivals drops become
// earnable while a broadcast airs, which is AFTER the campaign's startAt — so a
// scan taken minutes after startAt sees "nothing in progress", judges the
// account finished, and parks it right before the broadcast drops land (this is
// how local twitchbotx13 missed OWCS MSC Day 2: start 09:45Z, scan 10:10Z).
// Refusing to park when a campaign started within this window BEFORE the scan
// keeps the bot up through the broadcast. Long seasonal campaigns (started
// weeks ago) fall outside the window and still park, reclaiming RAM. Waking is
// unaffected — it passes graceMs 0.
const PARK_CAMPAIGN_GRACE_MS =
  Number(process.env.BOT_PARK_CAMPAIGN_GRACE_MS) || 48 * 60 * 60 * 1000; // 48h

// twitchbotx7 -> config_07.json (inverse of botFactory.containerForFile)
function fileForContainer(container) {
  const c = String(container || "").trim();
  if (c === "twitchbot") return "config.json";
  const m = c.match(/^twitchbotx(\d+)$/);
  if (!m) return null;
  return "config_" + String(parseInt(m[1], 10)).padStart(2, "0") + ".json";
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Every game any enabled account in this config farms, honouring the rule that
// an empty per-account FavouriteGames inherits the config-level list.
function gamesOf(data) {
  const top = Array.isArray(data.FavouriteGames) ? data.FavouriteGames : [];
  const users =
    data.TwitchSettings && Array.isArray(data.TwitchSettings.TwitchUsers)
      ? data.TwitchSettings.TwitchUsers
      : [];
  const out = new Set();
  for (const u of users) {
    if (!u || u.Enabled === false) continue;
    const own = Array.isArray(u.FavouriteGames) ? u.FavouriteGames : [];
    for (const g of own.length ? own : top) {
      const n = norm(g);
      if (n) out.add(n);
    }
  }
  return out;
}

// The decision itself, kept pure so it can be tested without docker or Mongo.
// Returns the campaign that justifies waking, or null.
//
// A campaign with no startAt is treated as a wake trigger: unknown timing on a
// live campaign for a game we farm is exactly the case where guessing "old"
// would silently cost drops, and a needless wake only costs RAM until the next
// sweep parks it again.
// `graceMs` shifts the comparison floor earlier so a campaign that started up
// to graceMs BEFORE `parkedAt` still counts. Waking passes 0 (unchanged: only a
// campaign strictly newer than the park wakes a bot). The PARK path passes
// PARK_CAMPAIGN_GRACE_MS so a bot isn't parked into a just-started campaign
// whose broadcast drops haven't landed yet.
function wakeTrigger(games, parkedAt, campaigns, graceMs = 0) {
  const since = parkedAt ? new Date(parkedAt).getTime() : 0;
  if (!Number.isFinite(since)) return null;
  const floor = since - (Number(graceMs) || 0);
  for (const c of campaigns || []) {
    if (!games.has(norm(c.game))) continue;
    // No-claim games (Overwatch/Rainbow Six) are farmed by the standalone
    // system now — a new campaign for one must never wake an old-system bot.
    if (settings.isNoClaimGame(c.game)) continue;
    if (!c.startAt) return c;
    if (new Date(c.startAt).getTime() > floor) return c;
  }
  return null;
}

async function readRegistry() {
  try {
    const raw = await hosts.readMeta(REGISTRY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

async function writeRegistry(reg) {
  await hosts.writeMeta(REGISTRY, JSON.stringify(reg, null, 2));
}

const keyOf = (hostId, container) => hostId + "|" + container;

// Record that we parked a bot (exported so a hand-stopped bot can be adopted
// into the wake cycle rather than being stranded off forever).
async function recordParked(hostId, container, info = {}) {
  const reg = await readRegistry();
  reg[keyOf(hostId, container)] = {
    parkedAt: info.parkedAt || new Date().toISOString(),
    games: info.games || [],
    accounts: info.accounts || 0,
    reason: info.reason || "all accounts finished their assigned games",
  };
  await writeRegistry(reg);
  return reg[keyOf(hostId, container)];
}

async function liveCampaigns() {
  const now = new Date();
  return TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { game: 1, name: 1, startAt: 1, endAt: 1 },
  ).lean();
}

// Start any bot we parked whose game has a campaign that began afterwards.
async function wakeFinishedBots(hostId, opts = {}) {
  const log = typeof opts.progress === "function" ? opts.progress : () => {};
  const host = hosts.resolveHost(hostId);
  if (!host) return { woken: [], checked: 0 };

  const reg = await readRegistry();
  const mine = Object.keys(reg).filter((k) => k.startsWith(host.id + "|"));
  if (!mine.length) return { woken: [], checked: 0 };

  const states = await hosts.dockerPs(host).catch(() => null);
  if (!states) return { woken: [], checked: 0 };

  const campaigns = await liveCampaigns();
  const woken = [];
  let dirty = false;

  for (const k of mine) {
    const container = k.slice(host.id.length + 1);
    const entry = reg[k];
    const state = states[container];
    // Gone, or already running (someone started it by hand) — drop the entry
    // so the registry cannot accumulate stale keys.
    if (!state || state.state === "running") {
      delete reg[k];
      dirty = true;
      continue;
    }
    let games;
    try {
      games = gamesOf(
        JSON.parse(await hosts.readFile(host, fileForContainer(container))),
      );
    } catch {
      continue; // config unreadable — leave it parked, try again next tick
    }
    // Auto parks are protected at park time (stopFinishedBots refuses to park
    // into a campaign newer than the scan its verdict rests on), so a strict
    // "started after the park" comparison is safe for them. A MANUAL park has
    // no such check — a campaign already running when the operator stopped the
    // bot would never wake it, because nothing newer ever arrives. Manual
    // entries therefore get the same broadcast grace the park path uses.
    const graceMs = /manual/i.test(entry.reason || "")
      ? PARK_CAMPAIGN_GRACE_MS
      : 0;
    const trigger = wakeTrigger(games, entry.parkedAt, campaigns, graceMs);
    if (!trigger) continue;

    await hosts.restoreRestartPolicy(host, container).catch(() => {});
    try {
      await hosts.dockerContainer(host, "start", container);
      delete reg[k];
      dirty = true;
      woken.push({ container, game: trigger.game, campaign: trigger.name });
      log(
        "Woke " +
          container +
          " — new campaign for " +
          trigger.game +
          ' ("' +
          (trigger.name || "?") +
          '").',
      );
    } catch (e) {
      log("Could not start " + container + ": " + (e.message || e), "warn");
    }
  }
  if (dirty) await writeRegistry(reg).catch(() => {});
  return { woken, checked: mine.length };
}

// How fresh the scan evidence must be before a container may be parked.
//
// Measured on prod 2026-07-29 across the 2239 enabled accounts with a good last
// scan: p50 age 18.3h, p90 22.3h, p100 24.0h — the drop scanner takes about a
// full day to work through the fleet. One stale account blocks its whole
// container, so anything under a day makes parking impossible in practice: at a
// 6h threshold only 410 of 2239 accounts qualified and exactly ONE container on
// the whole estate was parkable.
//
// So the freshness bound is set just above a full pass, and the newer-campaign
// guard below — not the clock — does the real safety work. It compares live
// campaign start times against the actual scan behind the verdict, which is the
// precise question ("could this bot have picked up work I cannot see?") that a
// staleness threshold only approximates.
const STOP_FRESH_MS = 30 * 60 * 60 * 1000;

// Stop any RUNNING bot whose accounts have all finished their assigned games.
// farmCompletion.botCompletion refuses to answer while any account is unscanned,
// stale or not-yet-started, and this adds the one guard it cannot make on its
// own (it has no notion of campaigns):
//
//   A "finished" verdict is only as good as the scan behind it. If a campaign
//   for one of this bot's games started AFTER its oldest scan, the bot may have
//   begun watching that campaign in the meantime and the verdict simply predates
//   the evidence. Parking then loses live drops — and worse, it loses them
//   permanently: wakeTrigger only fires for campaigns that start after the park,
//   so a campaign already running at park time never wakes the bot again.
//
// The restart policy is cleared too, or a docker daemon restart would quietly
// undo the stop.
async function stopFinishedBots(hostId, opts = {}) {
  const log = typeof opts.progress === "function" ? opts.progress : () => {};
  const host = hosts.resolveHost(hostId);
  if (!host) return { stopped: [] };

  const states = await hosts.dockerPs(host).catch(() => null);
  if (!states) return { stopped: [] };
  const running = Object.keys(states).filter(
    (name) =>
      (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
      states[name].state === "running",
  );
  if (!running.length) return { stopped: [] };
  const campaigns = await liveCampaigns();

  const stopped = [];
  for (const container of running) {
    const file = fileForContainer(container);
    if (!file) continue;
    let verdict;
    try {
      verdict = await botCompletion(host.id, file, { freshMs: STOP_FRESH_MS });
    } catch {
      continue;
    }
    // A container with no enabled accounts farms nothing at all yet still pays
    // the full ~130 MB .NET baseline. There is no verdict to second-guess here
    // and no campaign that could change the answer, so it is parked outright —
    // prod had exactly one of these (an auto-bot drained to zero) sitting
    // "running" indefinitely.
    const empty = !verdict.total;
    if (!empty) {
      if (!verdict.stoppable) continue;
      // Same test wakeTrigger applies, run against the verdict's own evidence:
      // any live campaign for an assigned game that this verdict cannot have
      // seen means "unknown", not "finished".
      const assigned = new Set((verdict.assignedGames || []).map(norm));
      const newer = wakeTrigger(
        assigned,
        verdict.oldestScanAt,
        campaigns,
        PARK_CAMPAIGN_GRACE_MS,
      );
      if (newer) {
        log(
          "Keeping " +
            container +
            " — " +
            (newer.game || "a game it farms") +
            " has a campaign newer than the scan this verdict rests on.",
        );
        continue;
      }
    }
    await hosts.setRestartPolicy(host, container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", container);
      // Record BEFORE reporting success: an unrecorded park is a bot that can
      // never be woken again.
      await recordParked(host.id, container, {
        // An empty container records no games: there is nothing in it for a new
        // campaign to farm, so it must not be woken by one. (wakeFinishedBots
        // re-reads the config anyway and would reach the same conclusion — this
        // just makes the registry honest about why it is parked.)
        games: empty ? [] : verdict.assignedGames,
        accounts: verdict.total,
        reason: empty
          ? "no enabled accounts left in the config"
          : "all accounts finished their assigned games",
      });
      stopped.push({ container, accounts: verdict.total, empty });
      log(
        empty
          ? "Parked " + container + " — it holds no enabled accounts."
          : "Parked " +
              container +
              " — all " +
              verdict.total +
              " account(s) finished [" +
              verdict.assignedGames.join(", ") +
              "].",
      );
    } catch (e) {
      log("Could not stop " + container + ": " + (e.message || e), "warn");
    }
  }
  return { stopped };
}

module.exports = {
  wakeFinishedBots,
  stopFinishedBots,
  recordParked,
  readRegistry,
  wakeTrigger,
  fileForContainer,
  gamesOf,
};
