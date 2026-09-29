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
const CampaignLiveState = require("../models/CampaignLiveState");
const path = require("path");
const { botCompletion } = require("./farmCompletion");
const { farmableCampaigns } = require("./campaignFarmability");
const botLogVerdict = require("./botLogVerdict");
const settings = require("./settings");
const { recordAutoFarmEvent } = require("./autoFarmEventLog");

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

// --- Stream-gate (utils/streamScout.js) ---------------------------------------
// A CampaignLiveState row older than this is treated as UNKNOWN, and every
// unknown resolves toward farming (wake, don't park). So a Scout outage can
// never strand a bot: stale liveness ⇒ behave exactly like the un-gated system.
const LIVE_STALE_MS =
  Number(process.env.STREAM_LIVE_STALE_MS) || 20 * 60 * 1000; // 20 min
// How long every one of a container's gated campaigns must be continuously DARK
// before the idle-no-stream gate parks it. Hysteresis so a brief between-matches
// gap doesn't thrash park↔wake. Waking has no such delay — it is instant.
const PARK_AFTER_DARK_MS =
  Number(process.env.BOT_PARK_AFTER_DARK_MS) || 20 * 60 * 1000; // 20 min

function liveIsFresh(row) {
  return !!(
    row &&
    row.checkedAt &&
    Date.now() - new Date(row.checkedAt).getTime() < LIVE_STALE_MS
  );
}

// A game the stream-gate may act on: opted-in AND wakeable by this module. We
// deliberately EXCLUDE no-claim games — wakeFinishedBots filters their campaigns
// out (they are owned by the standalone no-claim system), so gating/parking one
// here would strand it off forever. Keeping the gate's park side and wake side
// over the SAME game set is what preserves the wake/park symmetry that §4 of
// docs/STREAM-SCOUT-PLAN.md warns about.
function isGateableGame(game) {
  return (
    settings.getStreamGate().enabled &&
    settings.isStreamGatedGame(game) &&
    !settings.isNoClaimGame(game)
  );
}

async function liveStateByCampaign() {
  const rows = await CampaignLiveState.find(
    {},
    {
      campaignId: 1,
      game: 1,
      gated: 1,
      liveNow: 1,
      lastLiveAt: 1,
      darkSince: 1,
      checkedAt: 1,
    },
  ).lean();
  const m = new Map();
  for (const r of rows) m.set(r.campaignId, r);
  return m;
}

// Should we HOLD a normal (finished-park) wake because the triggering campaign
// is a gated one that is confidently dark right now? Only a FRESH, gated row
// that says liveNow:false holds the wake; anything uncertain fails toward
// farming (wake now, the idle gate can park it again later if still dark).
function gatedDark(campaign, liveMap) {
  if (!isGateableGame(campaign.game)) return false;
  const row = liveMap.get(campaign.campaignId);
  if (!row || !row.gated || !liveIsFresh(row)) return false; // uncertain → wake
  return row.liveNow !== true;
}

// Wake key for an idle_no_stream park: a LIVENESS transition, never startAt (the
// campaign started days ago, so startAt would leave the bot parked through a
// resumed broadcast — the §4 trap). Wake when any assigned gated campaign is
// live now, went live after the park, or has gone stale/unknown (fail toward
// farming).
function liveWakeTrigger(games, parkedAt, campaigns, liveMap) {
  const since = parkedAt ? new Date(parkedAt).getTime() : 0;
  for (const c of campaigns || []) {
    if (!anyGameMatches(games, c.game)) continue;
    const row = liveMap.get(c.campaignId);
    if (!row || !row.gated) return c; // no gated row → wake (fail toward farming)
    if (!liveIsFresh(row)) return c; // stale → wake
    if (row.liveNow === true) return c;
    if (row.lastLiveAt && new Date(row.lastLiveAt).getTime() > since) return c;
  }
  return null;
}

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

// True when any of the bot's assigned games matches a campaign game. Uses the
// same INCLUSIVE bidirectional rule as parkIdleNoCampaignBots (gameMatchesCampaign)
// so the wake path can never miss a campaign whose label drifted ("naraka" vs
// "NARAKA: BLADEPOINT") — a false positive here only wakes a bot early (RAM
// cost, safe direction); a false negative strands it off forever.
function anyGameMatches(games, campaignGame) {
  for (const g of games || []) {
    if (gameMatchesCampaign(g, campaignGame)) return true;
  }
  return false;
}

// Every campaign that could justify waking this bot, in catalog order. The
// decision itself, kept pure so it can be tested without docker or Mongo.
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
function wakeCandidates(games, parkedAt, campaigns, graceMs = 0) {
  const since = parkedAt ? new Date(parkedAt).getTime() : 0;
  if (!Number.isFinite(since)) return [];
  const floor = since - (Number(graceMs) || 0);
  const out = [];
  for (const c of campaigns || []) {
    if (!anyGameMatches(games, c.game)) continue;
    if (!c.startAt) out.push(c);
    else if (new Date(c.startAt).getTime() > floor) out.push(c);
  }
  return out;
}

function wakeTrigger(games, parkedAt, campaigns, graceMs = 0) {
  return wakeCandidates(games, parkedAt, campaigns, graceMs)[0] || null;
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
// into the wake cycle rather than being stranded off forever). `recordedAt` is
// when the entry was written — parkedAt can be backdated (nothing_left parks).
async function recordParked(hostId, container, info = {}) {
  const reg = await readRegistry();
  reg[keyOf(hostId, container)] = {
    parkedAt: info.parkedAt || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    games: info.games || [],
    accounts: info.accounts || 0,
    reason: info.reason || "all accounts finished their assigned games",
  };
  await writeRegistry(reg);
  return reg[keyOf(hostId, container)];
}

// Parks write their registry entry BEFORE the stop (so a stopped bot can never
// be unregistered), so for a moment a freshly parked bot is still running. A
// wake pass running concurrently (streamScout's nudge) must not read that as
// "started by someone else" and drop the entry — the stop then lands and the
// bot is parked with no entry, never to be woken.
const PARK_SETTLE_MS = 3 * 60 * 1000;

function parkInFlight(entry, now = Date.now()) {
  const t = new Date((entry && (entry.recordedAt || entry.parkedAt)) || 0).getTime();
  return Number.isFinite(t) && now - t < PARK_SETTLE_MS;
}

// Who last started (or restarted, or compose-up'd) each container through
// utils/botHosts, and from which code path — so a parked bot found running can
// be pinned on whatever woke it. Process-local and bounded: a start from a
// shell, a script, or before this server's last restart shows as unknown.
const LAST_START_MAX = 500;
const lastStartBy = new Map();

function noteContainerStart({ hostId, action, container, caller } = {}) {
  const k = keyOf(hostId, container);
  lastStartBy.delete(k); // re-insert so Map order tracks recency
  lastStartBy.set(k, { action, caller: caller || "", at: Date.now() });
  while (lastStartBy.size > LAST_START_MAX) {
    lastStartBy.delete(lastStartBy.keys().next().value);
  }
}
// Guarded so a botWaker deployed ahead of its botHosts still loads.
if (typeof hosts.onContainerStart === "function") {
  hosts.onContainerStart(noteContainerStart);
}

// A container we parked is running, and the waker did not start it. Record
// who did (when the start went through utils/botHosts) instead of silently
// dropping the registry entry: for weeks the drop scanner restarted parked
// bots about daily and the tick parked them straight back, with no record of
// what kept starting them.
async function recordParkedBotStarted(hostId, container, entry, state) {
  const seen = lastStartBy.get(keyOf(hostId, container));
  const since = new Date(entry.recordedAt || entry.parkedAt || 0).getTime();
  const by = seen && !(seen.at < since) ? seen : null;
  const games = Array.isArray(entry.games) ? entry.games : [];
  await recordAutoFarmEvent({
    type: "started",
    game: games.join(", "),
    host: hostId,
    container,
    count: Number(entry.accounts) || 0,
    reason:
      "parked bot found running — not started by the waker; " +
      (by
        ? "docker " + by.action + " from " + (by.caller || "an unknown code path")
        : "no start through this server since the park (a shell, a script, " +
          "or before the last server restart)") +
      ". Parked " +
      (entry.parkedAt || "?") +
      " (" +
      (entry.reason || "?") +
      "); docker: " +
      ((state && (state.status || state.state)) || "running"),
    actor: by ? by.caller || "unknown" : "external",
  });
  return { container, by: by ? by.caller || "unknown" : "external" };
}

async function liveCampaigns() {
  const now = new Date();
  return TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1, name: 1, startAt: 1, endAt: 1 },
  ).lean();
}

// Start any bot we parked whose game has a campaign that began afterwards.
async function wakeFinishedBots(hostId, opts = {}) {
  const log = typeof opts.progress === "function" ? opts.progress : () => {};
  const host = hosts.resolveHost(hostId);
  if (!host) return { woken: [], external: [], checked: 0 };

  const reg = await readRegistry();
  const mine = Object.keys(reg).filter((k) => k.startsWith(host.id + "|"));
  if (!mine.length) return { woken: [], external: [], checked: 0 };

  const states = await hosts.dockerPs(host).catch(() => null);
  if (!states) return { woken: [], external: [], checked: 0 };

  // Old-system bots re-wake on their games' campaigns INCLUDING no-claim
  // (Overwatch/Rainbow Six). Owner's decision 2026-08-24: the SERVER runs no
  // no-claim system, so its OW bots (x17/x20) must resume via the old system;
  // parking with no wake path would strand them. stopFinishedBots' newer-campaign
  // guard already refuses to park THROUGH a live campaign, so resuming on the
  // next one loses nothing. (Previously this filtered no-claim campaigns out to
  // defer them to the standalone no-claim system.) CAVEAT: the Pi also runs a
  // no-claim bot (noclaim-bot-2) alongside old-system OW/R6 bots, so OW/R6 there
  // can be double-farmed — retire whichever side is unwanted.
  const campaigns = await liveCampaigns();
  // Real-time stream liveness (utils/streamScout.js). Empty/absent when the
  // Scout isn't running or nothing is gated — in which case every gate helper
  // below fails toward farming and wake behaves exactly as before.
  const liveMap = await liveStateByCampaign();
  // What parkIdleNoCampaignBots counts, built on first use (only
  // idle_no_campaign parks need it). If CampaignDrops cannot be read, fail
  // toward waking — every non-no-claim live campaign counts — just as
  // campaignFarmability treats a campaign with no manifest as farmable.
  let idleSet = null;
  const idleCampaigns = async () => {
    if (!idleSet) {
      idleSet = await idleNoCampaignSet(campaigns).catch(() =>
        campaigns.filter((c) => !settings.isNoClaimGame(c.game)),
      );
    }
    return idleSet;
  };
  const woken = [];
  const external = [];
  let dirty = false;

  for (const k of mine) {
    const container = k.slice(host.id.length + 1);
    const entry = reg[k];
    const state = states[container];
    // Gone — drop the entry so the registry cannot accumulate stale keys.
    if (!state) {
      delete reg[k];
      dirty = true;
      continue;
    }
    if (state.state === "running") {
      // Parked moments ago and its stop has not landed yet — leave it be.
      if (parkInFlight(entry)) continue;
      // Running, but we did not wake it: something else started it. Record
      // that, then drop the entry (it is no longer parked).
      try {
        external.push(await recordParkedBotStarted(host.id, container, entry, state));
      } catch {
        /* diagnostic only — never block the cleanup */
      }
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
    // An idle_no_stream park (utils/streamScout.js) was made because every
    // assigned gated campaign went DARK, not because farming finished. Its
    // campaign started days ago, so the normal startAt-based wakeTrigger would
    // leave it parked straight through a resumed broadcast (the §4 trap). It
    // must wake on a LIVENESS transition instead.
    let trigger;
    let why = "new campaign started: ";
    if (/idle_no_stream/i.test(entry.reason || "")) {
      trigger = liveWakeTrigger(games, entry.parkedAt, campaigns, liveMap);
    } else {
      let candidates;
      if (
        /idle_no_campaign/i.test(entry.reason || "") &&
        ![...games].some((g) => settings.isNoClaimGame(g))
      ) {
        // Wake by the PARKER's own rule (campaignsForGames over
        // idleNoCampaignSet): any campaign it counts for these games. No
        // startAt test — at park time that set held nothing for them, so
        // anything in it now (new, found late by the catalog, or newly proven
        // farmable) is work the parker keeps the bot up for. A wake here is
        // therefore never parked straight back. (A bot whose games now include
        // a no-claim game is outside the parker's rule and falls through to
        // the grace test below, as before.)
        candidates = campaignsForGames(games, await idleCampaigns());
        why = "campaign to farm: ";
      } else {
        // Auto parks are protected at park time (stopFinishedBots refuses to
        // park into a campaign newer than the scan its verdict rests on), so a
        // strict "started after the park" comparison is safe for them. A
        // MANUAL park has no such protection, so a campaign already running at
        // park time would never wake it. Those entries get the broadcast grace
        // so a just-appeared campaign still wakes them.
        const graceMs = /manual|idle_no_campaign/i.test(entry.reason || "")
          ? PARK_CAMPAIGN_GRACE_MS
          : 0;
        candidates = wakeCandidates(games, entry.parkedAt, campaigns, graceMs);
      }
      // Try every candidate, not just the first: a confidently-dark gated
      // campaign must not suppress a wake that one of the bot's OTHER games
      // justifies (a mixed bot would otherwise miss the ungated game's drops
      // until the gated channel came back).
      for (const cand of candidates) {
        if (gatedDark(cand, liveMap)) continue;
        trigger = cand;
        break;
      }
    }
    if (!trigger) continue;

    await hosts.restoreRestartPolicy(host, container).catch(() => {});
    try {
      await hosts.dockerContainer(host, "start", container);
      delete reg[k];
      dirty = true;
      woken.push({ container, game: trigger.game, campaign: trigger.name });
      await recordAutoFarmEvent({
        type: "woken",
        game: trigger.game,
        campaignId: trigger.campaignId,
        host: host.id,
        container,
        count: Number(entry.accounts) || 0,
        reason: why + (trigger.name || trigger.campaignId || trigger.game),
        actor: "wakeFinishedBots",
      });
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
  return { woken, external, checked: mine.length };
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
  // When on, the "finished" verdict requires a real drop per assigned game
  // (utils/farmCompletion.js), not just a global dropCount. Read once per sweep.
  const requireEarned = !!settings.getAutoFarm().verifyEarnedBeforePark;

  const stopped = [];
  const logCandidates = [];
  for (const container of running) {
    const file = fileForContainer(container);
    if (!file) continue;
    let verdict;
    try {
      verdict = await botCompletion(host.id, file, {
        freshMs: STOP_FRESH_MS,
        requireEarned,
      });
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
      if (!verdict.stoppable) {
        logCandidates.push({ container, file, verdict });
        continue;
      }
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
    // Record FIRST: if the stop below succeeds, an unrecorded park is a bot
    // that can never be woken again. If the stop FAILS, the registry entry is
    // harmless — wakeFinishedBots deletes entries whose container is running,
    // so the next tick self-heals it.
    const parkReason = empty
      ? "no enabled accounts left in the config"
      : "all accounts finished their assigned games";
    try {
      await recordParked(host.id, container, {
        // An empty container records no games: there is nothing in it for a new
        // campaign to farm, so it must not be woken by one. (wakeFinishedBots
        // re-reads the config anyway and would reach the same conclusion — this
        // just makes the registry honest about why it is parked.)
        games: empty ? [] : verdict.assignedGames,
        accounts: verdict.total,
        reason: parkReason,
      });
    } catch (e) {
      log(
        "Could not record park for " +
          container +
          " — leaving it running: " +
          (e.message || e),
        "warn",
      );
      continue;
    }
    await hosts.setRestartPolicy(host, container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", container);
      await recordAutoFarmEvent({
        type: "parked",
        game: empty ? "" : (verdict.assignedGames || []).join(", "),
        host: host.id,
        container,
        count: verdict.total,
        reason: parkReason,
        actor: "stopFinishedBots",
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
      // Stop failed — undo the restart-policy change so a docker daemon
      // restart can't strand a still-running bot. The registry entry self-heals
      // next tick (wakeFinishedBots drops entries whose container is running).
      await hosts.restoreRestartPolicy(host, container).catch(() => {});
      log("Could not stop " + container + ": " + (e.message || e), "warn");
    }
  }
  // Second opinion from the bot itself for everything the data verdict could
  // not clear (utils/botLogVerdict.js).
  if (logCandidates.length && settings.getAutoFarm().parkNothingLeftBots !== false) {
    try {
      for (const x of await parkNothingLeft(host, logCandidates, campaigns, log)) {
        stopped.push(x);
      }
    } catch (e) {
      log("Nothing-left check failed on " + host.id + ": " + (e.message || e), "warn");
    }
  }
  return { stopped };
}

// Park bots whose OWN log says every enabled account has nothing left to farm,
// when the server's verdict still reads them as unfinished. That verdict leans
// on DropLog ↔ campaign-manifest matching, which misses campaigns a bot can
// never earn (a linked game account, drops only a subscriber gets) and item
// names that do not line up — Contabo's twitchbot/x18/x41/x50/x53 sat running
// for days logging "No broadcaster or campaign left" on every account.
//
// SAFETY (fail toward farming):
//   * Never a renter's bot — a registered rental stack, or any config holding a
//     RenterAccount — whatever its log says (renter start/stop has its own
//     contract: Renter.botStoppedAt).
//   * Never a bot the scanner sees in-progress work on an assigned game.
//   * Every enabled account needs a clean full cycle since the container last
//     started (botLogVerdict.isNothingLeft); anything unclear keeps it up.
//   * A campaign for its games that started within NOTHING_LEFT_MARGIN_MS may
//     not have been through a full cycle yet — keep the bot up.
//   * Recorded with parkedAt = now − margin and a reason wakeFinishedBots wakes
//     without grace, so the next campaign that starts wakes it.
const NOTHING_LEFT_MARGIN_MS = 30 * 60 * 1000;
const NOTHING_LEFT_REASON =
  "nothing_left — every account's own log says no campaign is left to farm";

async function parkNothingLeft(host, candidates, campaigns, log) {
  if (host.runtime === "native") return [];
  const stacks = require("./renterBotStacks");
  const rental = await stacks.dedicatedConfigSet(); // throws → touch nothing
  let pool = candidates.filter(
    (c) =>
      c.verdict.total > 0 &&
      c.verdict.working === 0 &&
      !rental.has(stacks.stackKey(host.id, c.file)),
  );
  if (!pool.length) return [];
  const raw = await hosts.readFiles(host, pool.map((c) => c.file));
  const RenterAccount = require("../models/RenterAccount");
  const keep = [];
  for (const c of pool) {
    const e = raw[c.file];
    if (!e || !e.ok) continue;
    let data;
    try {
      data = JSON.parse(e.text);
    } catch {
      continue;
    }
    const secrets = (((data.TwitchSettings || {}).TwitchUsers) || [])
      .map((u) => String((u && u.ClientSecret) || "").trim())
      .filter(Boolean);
    if (!secrets.length) continue;
    const renters = await RenterAccount.countDocuments({ clientSecret: { $in: secrets } });
    if (renters) continue;
    keep.push(c);
  }
  pool = keep;
  if (!pool.length) return [];
  const verdicts = await botLogVerdict.hostLogVerdicts(
    host,
    pool.map((c) => ({ container: c.container, configPath: path.posix.join(host.dir, c.file) })),
  );
  const parkedAt = new Date(Date.now() - NOTHING_LEFT_MARGIN_MS);
  const out = [];
  for (const c of pool) {
    if (!botLogVerdict.isNothingLeft(verdicts[c.container])) continue;
    const games = c.verdict.assignedGames || [];
    const fresh = wakeTrigger(new Set(games.map(norm)), parkedAt, campaigns, 0);
    if (fresh) {
      log("Keeping " + c.container + " — " + (fresh.game || "a game it farms") +
        " has a campaign too new for its log to have covered.");
      continue;
    }
    try {
      await recordParked(host.id, c.container, {
        parkedAt: parkedAt.toISOString(),
        games,
        accounts: c.verdict.total,
        reason: NOTHING_LEFT_REASON,
      });
    } catch (e) {
      log("Could not record park for " + c.container + " — leaving it running: " + (e.message || e), "warn");
      continue;
    }
    await hosts.setRestartPolicy(host, c.container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", c.container);
    } catch (e) {
      await hosts.restoreRestartPolicy(host, c.container).catch(() => {});
      log("Could not stop " + c.container + ": " + (e.message || e), "warn");
      continue;
    }
    await recordAutoFarmEvent({
      type: "parked",
      game: games.join(", "),
      host: host.id,
      container: c.container,
      count: c.verdict.total,
      reason: NOTHING_LEFT_REASON,
      actor: "stopFinishedBots",
    });
    out.push({ container: c.container, accounts: c.verdict.total, empty: false, nothingLeft: true });
    log("Parked " + c.container + " — all " + c.verdict.total +
      " account(s) report nothing left to farm [" + games.join(", ") + "].");
  }
  return out;
}

// Park a RUNNING bot that is only waiting for a broadcast — every one of its
// assigned games is stream-gated and confidently DARK, so it is watching
// nothing and just idle-polling Twitch. This is the RAM/bandwidth win the Stream
// Scout unlocks; it is INDEPENDENT of stopFinishedBots (that one parks *finished*
// bots; this one parks *idle-waiting* ones).
//
// The safety rules mirror docs/STREAM-SCOUT-PLAN.md §3c/§6:
//   * Never touch a bot with in-progress work (verdict.working > 0).
//   * Only park when EVERY assigned game is gateable (opted-in, non-no-claim) —
//     a container also farming an always-watchable game has real work to do. And
//     "gateable" excludes no-claim games precisely so the bot stays wakeable.
//   * Require a FRESH, gated, dark liveness row for every assigned campaign, dark
//     for at least PARK_AFTER_DARK_MS. Any uncertainty (missing/stale row, or a
//     live channel) aborts the park — fail toward farming.
// A bot parked here is recorded with reason "idle_no_stream", which wakes on a
// LIVENESS transition (see wakeFinishedBots), never on startAt.
async function parkIdleBots(hostId, opts = {}) {
  const log = typeof opts.progress === "function" ? opts.progress : () => {};
  if (!settings.getStreamGate().enabled) return { parked: [] };
  const host = hosts.resolveHost(hostId);
  if (!host) return { parked: [] };

  const states = await hosts.dockerPs(host).catch(() => null);
  if (!states) return { parked: [] };
  const running = Object.keys(states).filter(
    (name) =>
      (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
      states[name].state === "running",
  );
  if (!running.length) return { parked: [] };

  const campaigns = (await liveCampaigns()).filter(
    (c) => !settings.isNoClaimGame(c.game),
  );
  const liveMap = await liveStateByCampaign();
  const parked = [];

  for (const container of running) {
    const file = fileForContainer(container);
    if (!file) continue;
    let games;
    try {
      games = gamesOf(JSON.parse(await hosts.readFile(host, file)));
    } catch {
      continue; // config unreadable — leave it running
    }
    // No games (handled by stopFinishedBots) or any non-gateable game (real,
    // always-watchable work) → not an idle-waiting bot.
    if (!games.size) continue;
    if (![...games].every((g) => isGateableGame(g))) continue;

    const myCampaigns = campaigns.filter(
      (c) => games.has(norm(c.game)) && isGateableGame(c.game),
    );
    if (!myCampaigns.length) continue; // no active gated campaign for its games

    // Every assigned gated campaign must be confidently dark long enough.
    let ok = true;
    for (const c of myCampaigns) {
      const row = liveMap.get(c.campaignId);
      if (!row || !row.gated || !liveIsFresh(row)) {
        ok = false;
        break;
      } // uncertain
      if (row.liveNow === true) {
        ok = false;
        break;
      } // a channel is live — don't park
      const darkMs = row.darkSince
        ? Date.now() - new Date(row.darkSince).getTime()
        : 0;
      if (darkMs < PARK_AFTER_DARK_MS) {
        ok = false;
        break;
      } // not dark long enough (hysteresis)
    }
    if (!ok) continue;

    // Never park a bot that is actively farming something right now.
    let verdict;
    try {
      verdict = await botCompletion(host.id, file, { freshMs: STOP_FRESH_MS });
    } catch {
      continue; // can't confirm it's idle — leave it running
    }
    if (verdict.working > 0) continue;

    // Record FIRST — an unrecorded park is a bot that can never be woken
    // again; a failed stop self-heals via the running-container cleanup.
    const gameList = [...games];
    try {
      await recordParked(host.id, container, {
        games: gameList,
        accounts: verdict.total,
        reason: "idle_no_stream — no assigned broadcast is live",
      });
    } catch (e) {
      log(
        "Could not record park for " +
          container +
          " — leaving it running: " +
          (e.message || e),
        "warn",
      );
      continue;
    }
    await hosts.setRestartPolicy(host, container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", container);
      await recordAutoFarmEvent({
        type: "parked",
        game: gameList.join(", "),
        host: host.id,
        container,
        count: verdict.total,
        reason: "idle_no_stream — no assigned broadcast is live",
        actor: "parkIdleBots",
      });
      parked.push({ container, accounts: verdict.total, games: gameList });
      log(
        "Parked " +
          container +
          " — waiting for a stream; no assigned broadcast is live [" +
          gameList.join(", ") +
          "].",
      );
    } catch (e) {
      await hosts.restoreRestartPolicy(host, container).catch(() => {});
      log("Could not stop " + container + ": " + (e.message || e), "warn");
    }
  }
  return { parked };
}

// Inclusive game↔campaign match. Config game labels and TwitchCampaign game
// labels diverge ("overwatch" vs "Overwatch 2"), so an exact-equality test
// produces FALSE NEGATIVES — and a false negative here ("this game has no
// campaign") would park a farming bot. Bidirectional substring catches the
// divergent pairs. The opposite error (false positive: thinking a campaign
// exists when it doesn't) only keeps a bot up, which is the safe direction.
function gameMatchesCampaign(botGame, campaignGame) {
  // Punctuation-insensitive ("NARAKA: BLADEPOINT" vs "naraka bladepoint") — more
  // matching only ever keeps a bot up (the safe direction).
  const a = settings.normGameName(botGame);
  const b = settings.normGameName(campaignGame);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const IDLE_NO_CAMPAIGN_REASON =
  "idle_no_campaign — no active campaign for its games";

// The campaigns parkIdleNoCampaignBots counts as work for a bot: live, not a
// no-claim game (the no-claim system owns those, and wakes none of this), and
// earnable by watching — a campaign whose every drop is subscription-only is
// nothing to farm (the bot itself logs "No campaign found" for it,
// utils/campaignFarmability.js).
async function idleNoCampaignSet(campaigns) {
  return farmableCampaigns(
    (campaigns || []).filter((c) => !settings.isNoClaimGame(c.game)),
  );
}

// Every campaign in `campaigns` for one of the bot's games (inclusive match).
// This ONE predicate over idleNoCampaignSet is both halves of the
// idle_no_campaign cycle: the parker parks when it is empty, the waker wakes
// when it is not. Before, the waker tested "any live campaign that started in
// the 48h before the park" instead — so a sub-only campaign the parker ignores
// woke the bot, and the next tick parked it straight back.
function campaignsForGames(games, campaigns) {
  return (campaigns || []).filter((c) => anyGameMatches(games, c.game));
}

// Park a RUNNING bot whose assigned games have NO active drop campaign at all —
// it has literally nothing to farm, so it is pure idle RAM. This is the case
// stopFinishedBots deliberately will not touch (a never-started bot is "not
// started", not "finished") and the stream gate does not cover (there is no
// active campaign to be dark). Example: 50 fresh Rocket League accounts left
// running after the RL campaign ended. Wakes on the normal new-campaign trigger
// (with grace — see wakeFinishedBots).
//
// SAFETY (fail toward farming):
//   * INCLUSIVE campaign matching, so a farming bot is never read as idle.
//   * Skip any bot with a no-claim game (owned by the no-claim system; not
//     wakeable here) — never strand one.
//   * Require a FRESH verdict with zero working AND zero unknown accounts, so a
//     stale scan or an in-flight drop can never be parked.
//   * Any error / uncertainty leaves the bot running.
async function parkIdleNoCampaignBots(hostId, opts = {}) {
  const log = typeof opts.progress === "function" ? opts.progress : () => {};
  if (!settings.getAutoFarm().parkIdleNoCampaignBots) return { parked: [] };
  const host = hosts.resolveHost(hostId);
  if (!host) return { parked: [] };

  const states = await hosts.dockerPs(host).catch(() => null);
  if (!states) return { parked: [] };
  const running = Object.keys(states).filter(
    (name) =>
      (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
      states[name].state === "running",
  );
  if (!running.length) return { parked: [] };

  // The same campaign set wakeFinishedBots wakes an idle_no_campaign park by
  // (idleNoCampaignSet + campaignsForGames), so a bot parked here is woken
  // exactly when this would keep it up — never for a campaign it ignores.
  const campaigns = await idleNoCampaignSet(await liveCampaigns());
  const parked = [];

  for (const container of running) {
    const file = fileForContainer(container);
    if (!file) continue;
    let games;
    try {
      games = gamesOf(JSON.parse(await hosts.readFile(host, file)));
    } catch {
      continue; // config unreadable — leave it running
    }
    if (!games.size) continue; // empties are stopFinishedBots' job
    // A no-claim game means the no-claim system owns it and wakeFinishedBots
    // won't wake it — never park such a bot here.
    if ([...games].some((g) => settings.isNoClaimGame(g))) continue;
    // Does ANY assigned game have an active campaign (inclusive match)? If so,
    // there is work or imminent work — keep it up.
    if (campaignsForGames(games, campaigns).length) continue;

    // No campaign for any assigned game. Confirm it isn't mid-farm on a fresh
    // verdict before parking (guards against a stale campaign catalog).
    let verdict;
    try {
      verdict = await botCompletion(host.id, file, { freshMs: STOP_FRESH_MS });
    } catch {
      continue; // can't confirm idle — leave running
    }
    if (verdict.working > 0 || verdict.unknown > 0) continue;

    // Record FIRST — an unrecorded park is a bot that can never be woken
    // again; a failed stop self-heals via the running-container cleanup.
    const gameList = [...games];
    try {
      await recordParked(host.id, container, {
        games: gameList,
        accounts: verdict.total,
        reason: IDLE_NO_CAMPAIGN_REASON,
      });
    } catch (e) {
      log(
        "Could not record park for " +
          container +
          " — leaving it running: " +
          (e.message || e),
        "warn",
      );
      continue;
    }
    await hosts.setRestartPolicy(host, container, "no").catch(() => {});
    try {
      await hosts.dockerContainer(host, "stop", container);
      await recordAutoFarmEvent({
        type: "parked",
        game: gameList.join(", "),
        host: host.id,
        container,
        count: verdict.total,
        reason: IDLE_NO_CAMPAIGN_REASON,
        actor: "parkIdleNoCampaignBots",
      });
      parked.push({ container, accounts: verdict.total, games: gameList });
      log(
        "Parked " +
          container +
          " — no active campaign for its games [" +
          gameList.join(", ") +
          "]; wakes when one starts.",
      );
    } catch (e) {
      await hosts.restoreRestartPolicy(host, container).catch(() => {});
      log("Could not stop " + container + ": " + (e.message || e), "warn");
    }
  }
  return { parked };
}

module.exports = {
  NOTHING_LEFT_REASON,
  IDLE_NO_CAMPAIGN_REASON,
  wakeFinishedBots,
  stopFinishedBots,
  parkIdleBots,
  parkIdleNoCampaignBots,
  recordParked,
  readRegistry,
  wakeTrigger,
  wakeCandidates,
  anyGameMatches,
  liveWakeTrigger,
  gatedDark,
  isGateableGame,
  gameMatchesCampaign,
  idleNoCampaignSet,
  campaignsForGames,
  parkInFlight,
  noteContainerStart,
  liveIsFresh,
  fileForContainer,
  gamesOf,
};
