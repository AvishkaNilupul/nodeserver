// No-claim auto power — the RAM-saving watcher for the STANDALONE no-claim
// farming system (routes/noclaimFarmRoutes.js). It is to the no-claim bots what
// utils/streamScout.js + botWaker are to the managed bots: it turns a game's
// no-claim containers ON only while a qualifying stream for that game is
// actually live, and OFF (docker stop) during broadcast gaps or when the game
// has no active drop campaign at all. For Overwatch / Rainbow Six that is a big
// RAM win — those games are dark most of the time, and a stopped container
// costs ~130MB less (see project_bot_ram_consolidation).
//
// WHY A SEPARATE WATCHER (not botWaker)
// The no-claim system is deliberately decoupled from the old auto-farm plumbing:
// its containers are noclaim-bot-* in a dedicated Pi dir, it has no BotAccount /
// AutoFarmTask rows, and botWaker's isGateableGame EXCLUDES no-claim games on
// purpose. So the managed-bot park/wake machinery can never touch these. This
// watcher reuses only the read-only liveness PRIMITIVES from Stream Scout
// (getStreamsLive / getGameDropsLive / fetchCampaignDetails) and drives docker
// on the Pi directly. It never writes CampaignLiveState (that collection is
// owned by streamScout, which prunes rows it does not track).
//
// SAFETY (mirrors streamScout's contract)
//  * Ships OFF (settings.noClaimStreamGate) — zero Twitch calls, zero container
//    activity until flipped on.
//  * FAIL TOWARD FARMING: any uncertainty — a Twitch error, no token to check
//    with, a stale campaign catalog — keeps the bots UP. A needless container is
//    cheap; a missed live window means unclaimed drops that expire (~24h /
//    campaign end — see project_noclaim_test_harness).
//  * A stop fires only after a game has been confidently dark for a hysteresis
//    window (no flapping); a start fires immediately (low latency, drops are
//    time-sensitive).
//  * Cold-start on live: any stopped bot whose game is live is started (so it
//    also recovers bots after a Pi reboot/crash) EXCEPT one the operator
//    explicitly stopped. Two marker files in the bot dir separate the cases:
//    `.autostopped` = the watcher parked it (dark game) → resume when live;
//    `.operatoroff` = the operator hit Stop → stay off until Restart/Create.
//    Restart / Create clear both (operator taking control). So the watcher farms
//    live events automatically but never overrides an explicit Stop.
const TwitchCampaign = require("../models/TwitchCampaign");
const BotAccount = require("../models/BotAccount");
const settings = require("./settings");
const hosts = require("./botHosts");
const campaignWatcher = require("./campaignWatcher");
const { getStreamsLive, getGameDropsLive } = require("./twitchWatch");
const { fetchCampaignDetails } = require("./twitchInventory");
const { recordAutoFarmEvent } = require("./autoFarmEventLog");
const { farmableCampaigns } = require("./campaignFarmability");

// Keep these in lock-step with routes/noclaimFarmRoutes.js — same Pi dir + names.
const HOST_ID = "contabo";
const BASE = "/home/ubuntu/twitchbot-noclaim";
const BOTS_DIR = BASE + "/bots";
const CONTAINER_PREFIX = "noclaim-bot-";
const containerFor = (id) => CONTAINER_PREFIX + id;
const markerPath = (id) => BOTS_DIR + "/" + id + "/.autostopped"; // watcher park
// `.operatoroff` (the operator's explicit Stop) is read by readBots and written
// only by the routes; the watcher never needs its path, just its presence.
// `.finished` = the watcher stopped the bot because every enabled account had
// already finished the game's live campaigns. It records WHICH campaigns and
// which config (md5), so the bot is not cold-started again for those same
// campaigns — only a new campaign or a changed config (e.g. new accounts)
// wakes it. JSON: { at, campaignIds: [...], accountsKey }.
const finishedPath = (id) => BOTS_DIR + "/" + id + "/.finished";

// A campaign is only recorded as "finished" if it was already active this long
// before the stop — otherwise the bot may not have seen it in a full cycle yet,
// and recording it would suppress the wake that should farm it.
const FINISH_CAMPAIGN_MARGIN_MS = 30 * 60 * 1000;
// The per-bot "nothing left to farm" classifier (runs on the host, reads the
// bot's own log) is shared with the managed-bot park: utils/botLogVerdict.js.
const {
  LOG_VERDICT_PY,
  LOG_TAIL,
  isNothingLeft,
} = require("./botLogVerdict");

const TICK_MS = Number(process.env.NOCLAIM_WATCHER_TICK_MS) || 3 * 60 * 1000; // 3 min
const RETRY_MS = 60 * 1000; // a failed pass retries on a short fuse
const ACL_TTL_MS = 6 * 60 * 60 * 1000; // 6h — an ACL rarely changes, liveness does
// A game with no active campaign is only "dark" if the campaign catalog is
// FRESH. campaignWatcher refreshes every 2h; give it slack before trusting a
// "no campaign" verdict, else a lagging catalog would stop every bot.
const CAMPAIGN_STALE_MS =
  Number(process.env.NOCLAIM_CAMPAIGN_STALE_MS) || 3 * 60 * 60 * 1000; // 3h
// How long a game must stay dark before we stop its bots (hysteresis).
const PARK_AFTER_DARK_MS =
  Number(process.env.NOCLAIM_PARK_AFTER_DARK_MS) || 20 * 60 * 1000; // 20 min

const norm = (s) => settings.normGameName(s);
const normLogin = (s) => String(s || "").trim().toLowerCase();

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { games: 0, live: 0, started: 0, stopped: 0, finished: 0, errors: 0 },
  games: [], // per-game verdict for the UI
  // gameKey -> ms the game first went dark this streak (hysteresis anchor).
  darkSince: {},
};

// campaignId -> { channels: [login], fetchedAt: ms }
const aclCache = new Map();

// Healthy tokens to read liveness with (read-only, never hits the integrity
// gate). Same idea as streamScout.borrowTokens.
async function borrowTokens(limit = 5) {
  const rows = await BotAccount.find(
    { clientSecret: { $exists: true, $ne: "" }, lastScanStatus: "ok" },
    { clientSecret: 1 },
  )
    .sort({ lastScanAt: -1 })
    .limit(limit)
    .lean();
  return rows.map((r) => String(r.clientSecret || "").trim()).filter(Boolean);
}

async function aclChannels(campaignId, token) {
  const hit = aclCache.get(campaignId);
  if (hit && Date.now() - hit.fetchedAt < ACL_TTL_MS) return hit.channels;
  try {
    const camp = await fetchCampaignDetails(token, campaignId);
    const allow = camp && camp.allow;
    let channels = [];
    if (allow && allow.isEnabled !== false && Array.isArray(allow.channels)) {
      // Twitch LOGINS, not game labels: keep underscores ("ow_esports"), only
      // lowercase/trim. normGameName turned "ow_esports" into "ow esports", so
      // getStreamsLive never matched it and the channel could never read live.
      channels = allow.channels.map((c) => normLogin(c && c.name)).filter(Boolean);
    }
    aclCache.set(campaignId, { channels, fetchedAt: Date.now() });
    return channels;
  } catch {
    // Leave any prior cache in place; no data → treat as un-gated (category /
    // fail toward farming), never as "dark".
    return hit ? hit.channels : [];
  }
}

// Active no-claim drop campaigns right now (the same catalog streamScout reads).
async function activeNoClaimCampaigns() {
  const now = new Date();
  const rows = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1, name: 1, startAt: 1, firstSeenAt: 1 },
  ).lean();
  // Subscription-only campaigns are nothing to farm — and one with no channel
  // ACL ("DRON-E Chat Badge") read the game as live around the clock through
  // the category directory, which kept every Rainbow Six bot up.
  return farmableCampaigns(
    rows.filter((c) => c.game && settings.isNoClaimGame(c.game)),
  );
}

// Is any of these channels live now? Batched, early-exit on first live channel,
// rotates off a dead token. Throws on a non-auth failure so the caller can fail
// toward farming (treat as live) rather than mistake an outage for "dark".
const LIVENESS_BATCH = 100;
async function anyChannelLive(channels, tokens) {
  let tokenIdx = 0;
  for (let i = 0; i < channels.length; i += LIVENESS_BATCH) {
    const chunk = channels.slice(i, i + LIVENESS_BATCH);
    let done = false;
    while (!done) {
      const token = tokens[tokenIdx] || null;
      try {
        const live = await getStreamsLive(token, chunk);
        if (live && live.size) return true;
        done = true;
      } catch (e) {
        if (e && e.code === "token_invalid" && tokenIdx + 1 < tokens.length) {
          tokenIdx++;
          continue;
        }
        throw e;
      }
    }
  }
  return false;
}

// Build a per-game verdict for every no-claim game we manage. Returns a map
// keyed by the normalised noClaimGames keyword:
//   { live, hadCampaign, checked, error }
// live=true also when uncertain (fail toward farming). `hadCampaign` is only
// meaningful when the catalog is fresh; a stale catalog forces live=true.
async function gameVerdicts() {
  const keywords = (settings.getAutoFarm().noClaimGames || [])
    .map(norm)
    .filter(Boolean);
  const verdict = {};
  for (const k of keywords) {
    verdict[k] = {
      live: true,
      hadCampaign: false,
      checked: false,
      error: "",
      uncertain: false,
      campaigns: [], // [{ id, startAt }] — the game's active farmable campaigns
    };
  }
  if (!keywords.length) return verdict;

  // Is "no campaign" trustworthy? Only if campaignWatcher ran recently.
  let catalogFresh = false;
  try {
    const cw = campaignWatcher.status();
    catalogFresh =
      cw && cw.lastRun && Date.now() - new Date(cw.lastRun).getTime() < CAMPAIGN_STALE_MS;
  } catch {
    catalogFresh = false;
  }

  const campaigns = await activeNoClaimCampaigns();
  const tokens = await borrowTokens();

  // Group active campaigns under each managed keyword (inclusive match).
  for (const k of keywords) {
    const forGame = campaigns.filter((c) => {
      const g = norm(c.game);
      return g === k || g.includes(k) || k.includes(g);
    });
    const v = verdict[k];
    v.checked = true;
    v.hadCampaign = forGame.length > 0;
    v.campaigns = forGame.map((c) => ({
      id: String(c.campaignId),
      startAt: c.startAt || c.firstSeenAt || null,
    }));

    if (!forGame.length) {
      // No active campaign for this game — there is literally nothing to farm
      // (no drops to earn), regardless of whether any stream is live. So we
      // must NEVER cold-start a stopped bot here. When the catalog is fresh we
      // trust "no campaign" as genuinely dark. When it is NOT fresh — e.g. the
      // boot window before campaignWatcher's first pass has run, or a watcher
      // stall — mark the game UNCERTAIN rather than "live": keep any running
      // bot up (fail toward farming) but do not WAKE a parked one on an
      // unverifiable signal. Without this, every process restart woke all bots
      // for ~20 min to farm a campaign that does not exist (campaignWatcher's
      // first pass lags the no-claim watcher's by ~15s at boot, so lastRun is
      // briefly null → catalogFresh false → live).
      if (catalogFresh) {
        v.live = false;
      } else {
        v.live = true;
        v.uncertain = true;
      }
      continue;
    }
    if (!tokens.length) {
      v.live = true; // no token to check liveness → fail toward farming
      v.error = "no token to check liveness";
      continue;
    }

    // The game is live if ANY of its active campaigns is watchable now.
    let live = false;
    let error = "";
    for (const c of forGame) {
      try {
        const channels = await aclChannels(c.campaignId, tokens[0]);
        if (channels.length) {
          if (await anyChannelLive(channels, tokens)) {
            live = true;
            break;
          }
        } else {
          // No ACL → category-wide: is any drops-enabled stream live for the
          // game directory? Rotate off a dead token.
          let idx = 0;
          let done = false;
          while (!done) {
            try {
              const chans = await getGameDropsLive(tokens[idx] || null, c.game);
              if (chans.length) live = true;
              done = true;
            } catch (e) {
              if (e && e.code === "token_invalid" && idx + 1 < tokens.length) {
                idx++;
                continue;
              }
              throw e;
            }
          }
          if (live) break;
        }
      } catch (e) {
        // A Twitch error on this campaign → fail toward farming for the game.
        live = true;
        error = (e && e.message) || String(e);
        break;
      }
    }
    v.live = live;
    v.error = error;
  }
  return verdict;
}

// Read every no-claim bot from the host: id, config game, running?, markers,
// config fingerprint, and — for running bots — the finished verdict from its
// own log. One round trip (docker ps + a config sweep + a per-bot log verdict
// computed ON the host, so only one short line per bot crosses the link).
async function readBots() {
  const dir = hosts.shq(BOTS_DIR);
  const script =
    `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}' 2>/dev/null; echo "PS_END"; ` +
    `echo "BOTS_START"; for d in ${dir}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
    `id=$(basename $(dirname $(dirname "$d"))); ` +
    `game=$(tr -d '\\n' < "$d" | sed -n 's/.*"FavouriteGames"[^[]*\\[[^"]*"\\([^"]*\\)".*/\\1/p'); ` +
    `mk=no; [ -f ${dir}/"$id"/.autostopped ] && mk=yes; ` +
    `oo=no; [ -f ${dir}/"$id"/.operatoroff ] && oo=yes; ` +
    `key=$(md5sum < "$d" 2>/dev/null | cut -c1-32); ` +
    `fin=; [ -f ${dir}/"$id"/.finished ] && fin=$(head -c 4000 ${dir}/"$id"/.finished | tr -d '\\n|'); ` +
    `echo "$id|$game|$mk|$oo|$key|$fin"; done; echo "BOTS_END"; ` +
    `echo "LOGS_START"; for c in $(docker ps --filter name=${CONTAINER_PREFIX} --format '{{.Names}}' 2>/dev/null); do ` +
    `case "$c" in ${CONTAINER_PREFIX}*) ;; *) continue ;; esac; ` +
    `id=$(echo "$c" | sed 's/^${CONTAINER_PREFIX}//'); ` +
    `st=$(docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null); ` +
    `up=$(( $(date +%s) - $(date -d "$st" +%s 2>/dev/null || date +%s) )); ` +
    `v=$(docker logs --tail ${LOG_TAIL} "$c" 2>&1 | python3 -c ${hosts.shq(LOG_VERDICT_PY)} ${dir}/"$id"/Configuration/config.json "$st" 2>/dev/null); ` +
    `[ -n "$v" ] || v="ERR|py"; echo "$id|$up|$v"; done; echo "LOGS_END"`;
  const { stdout } = await hosts.runShell(pi(), script, { timeout: 90000 });
  return parseBots(stdout);
}

function parseMarker(text) {
  if (!text) return null;
  try {
    const m = JSON.parse(text);
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

// Pure parser for readBots' output (unit-tested).
function parseBots(stdout) {
  const lines = String(stdout || "").split("\n");
  let section = "";
  const psMap = {};
  const logs = {};
  const bots = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "PS_START") { section = "ps"; continue; }
    if (line === "PS_END") { section = ""; continue; }
    if (line === "BOTS_START") { section = "bots"; continue; }
    if (line === "BOTS_END") { section = ""; continue; }
    if (line === "LOGS_START") { section = "logs"; continue; }
    if (line === "LOGS_END") { section = ""; continue; }
    if (section === "ps" && line) {
      const [name, st] = line.split("|");
      psMap[name.replace(CONTAINER_PREFIX, "")] = st;
    } else if (section === "bots" && line) {
      const [id, game, mk, oo, key, fin] = line.split("|");
      bots.push({
        id,
        game: game || "",
        autostopped: mk === "yes",
        operatorOff: oo === "yes",
        accountsKey: key || "",
        finishedMarker: parseMarker(fin),
      });
    } else if (section === "logs" && line) {
      const [id, up, enabled, finished, pending, unknown] = line.split("|");
      if (enabled === "ERR") continue; // no verdict → never judged finished
      logs[id] = {
        uptimeS: Number(up) || 0,
        enabled: Number(enabled) || 0,
        finished: Number(finished) || 0,
        pending: Number(pending) || 0,
        unknown: Number(unknown) || 0,
      };
    }
  }
  for (const b of bots) {
    b.running = psMap[b.id] === "running";
    const lv = logs[b.id] || null;
    b.logVerdict = lv;
    // Every enabled account showed a clean "nothing left" cycle since this
    // container started, and it has been up long enough for that to mean
    // something. Anything short of that keeps the bot up.
    b.finishedNow = !!(b.running && isNothingLeft(lv));
  }
  return bots;
}

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error(`Pi host "${HOST_ID}" is not configured.`);
    e.status = 503;
    throw e;
  }
  return host;
}

// PURE decision core (unit-tested): given the bots and a resolved per-game
// verdict, decide which to start and which to stop. `verdict[gameKey]` carries
// { live, canStop } where canStop already folds in the dark-hysteresis. A bot
// whose game matches no managed keyword is left untouched.
//   START: game CONFIRMED-live + bot stopped + NOT operator-off (cold-start /
//          resume / reboot-recovery — but never override an explicit Stop, and
//          never on an `uncertain` verdict, i.e. no active campaign + an
//          unverifiable catalog, so a restart's boot window can't wake bots for
//          a campaign that does not exist).
//   STOP:  game confidently dark + bot running.
//   FINISHED: bot running + every enabled account has nothing left to farm
//          (its own log says so) → stop it, whether or not the game is live.
//          A live game used to cold-start every bot of that game, including
//          ones whose accounts had already finished the campaign — 21 finished
//          Overwatch bots sat running through each OWCS broadcast.
//   A `.finished` marker then blocks the cold-start while the game's live
//   campaigns are the same ones it finished and its config is unchanged.
function verdictFor(verdict, label) {
  const g = norm(label);
  for (const k of Object.keys(verdict)) {
    if (g === k || g.includes(k) || k.includes(g)) return verdict[k];
  }
  return null;
}

// Does the bot's `.finished` marker cover every farmable campaign that is live
// for its game now, with the same config it finished with?
function finishedCovers(b, v) {
  const m = b && b.finishedMarker;
  if (!m || !Array.isArray(m.campaignIds) || !m.campaignIds.length) return false;
  if (!b.accountsKey || m.accountsKey !== b.accountsKey) return false;
  const ids = ((v && v.campaigns) || []).map((c) => String(c.id));
  if (!ids.length) return false;
  return ids.every((id) => m.campaignIds.includes(id));
}

// Campaigns to record as finished: only ones active long enough that the bot
// has certainly seen them in a full cycle.
function markerCampaignIds(v, now = Date.now()) {
  return ((v && v.campaigns) || [])
    .filter((c) => {
      const t = c.startAt ? new Date(c.startAt).getTime() : NaN;
      return !Number.isFinite(t) || now - t >= FINISH_CAMPAIGN_MARGIN_MS;
    })
    .map((c) => String(c.id))
    .sort();
}

function decideActions(bots, verdict) {
  const starts = [];
  const stops = [];
  const finished = [];
  for (const b of bots) {
    const v = verdictFor(verdict, b.game);
    if (!v) continue; // unknown game — never touch
    if (b.running && b.finishedNow) {
      finished.push(b.id);
    } else if (
      v.live &&
      !v.uncertain &&
      !b.running &&
      !b.operatorOff &&
      !finishedCovers(b, v)
    ) {
      starts.push(b.id);
    } else if (v.canStop && b.running) {
      stops.push(b.id);
    }
  }
  return { starts, stops, finished };
}

// Apply start/stop on the host in ONE round trip. Starts clear the markers;
// stops set `.autostopped`; finished stops also write `.finished` (JSON from
// `markers[id]`). Each action is independent (`;`, `|| true`) so one failure
// never blocks the rest.
async function applyActions(starts, stops, finished = [], markers = {}) {
  const parts = [];
  for (const id of starts) {
    parts.push(
      `docker start ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `rm -f ${hosts.shq(markerPath(id))} ${hosts.shq(finishedPath(id))} || true`,
    );
  }
  for (const id of stops) {
    parts.push(
      `docker stop ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `touch ${hosts.shq(markerPath(id))} || true`,
    );
  }
  for (const id of finished) {
    parts.push(
      `docker stop ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `touch ${hosts.shq(markerPath(id))} || true`,
      `printf '%s' ${hosts.shq(markers[id] || "{}")} > ${hosts.shq(finishedPath(id))} || true`,
    );
  }
  if (!parts.length) return;
  await hosts.runShell(pi(), parts.join("; "), { timeout: 60000 });
}

// Fold the raw per-game verdict + dark hysteresis into { live, canStop } and
// update the darkSince anchors. Mutates state.darkSince.
function resolveWithHysteresis(rawVerdict, now = Date.now()) {
  const out = {};
  for (const k of Object.keys(rawVerdict)) {
    const v = rawVerdict[k];
    if (v.live) {
      delete state.darkSince[k];
      out[k] = { ...v, canStop: false, darkForMs: 0 };
    } else {
      if (!state.darkSince[k]) state.darkSince[k] = now;
      const darkForMs = now - state.darkSince[k];
      out[k] = { ...v, canStop: darkForMs >= PARK_AFTER_DARK_MS, darkForMs };
    }
  }
  // Forget anchors for games no longer managed.
  for (const k of Object.keys(state.darkSince)) {
    if (!(k in rawVerdict)) delete state.darkSince[k];
  }
  return out;
}

async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  const counts = { games: 0, live: 0, started: 0, stopped: 0, finished: 0, errors: 0 };
  try {
    if (!settings.getNoClaimGate().enabled) {
      // Off → do nothing at all (no Twitch calls, no SSH). Still publish a
      // status row so the UI can show "auto power: off".
      state.games = [];
      state.lastError = "";
      state.lastCounts = counts;
      return counts;
    }

    const raw = await gameVerdicts();
    const verdict = resolveWithHysteresis(raw);
    const keys = Object.keys(verdict);
    counts.games = keys.length;
    counts.live = keys.filter((k) => verdict[k].live).length;
    counts.errors = keys.filter((k) => verdict[k].error).length;

    const bots = await readBots();
    const { starts, stops, finished } = decideActions(bots, verdict);
    const now = Date.now();
    const markers = {};
    for (const id of finished) {
      const b = bots.find((x) => x.id === id);
      markers[id] = JSON.stringify({
        at: new Date(now).toISOString(),
        campaignIds: markerCampaignIds(verdictFor(verdict, b.game), now),
        accountsKey: b.accountsKey || "",
      });
    }
    await applyActions(starts, stops, finished, markers);
    counts.started = starts.length;
    counts.stopped = stops.length + finished.length;
    counts.finished = finished.length;

    // Lifecycle log (shows in the Auto-farm tab's timeline too).
    for (const id of finished) {
      const b = bots.find((x) => x.id === id);
      const lv = (b && b.logVerdict) || {};
      await recordAutoFarmEvent({
        type: "noclaim_autostop",
        game: b ? b.game : "",
        host: HOST_ID,
        container: containerFor(id),
        count: lv.enabled || 0,
        actor: "noclaim-watcher",
        reason:
          "all " + (lv.enabled || 0) + " account(s) finished the live " +
          "campaign(s) — stopping to save RAM; a new campaign or new " +
          "accounts wake it",
      });
    }
    for (const id of stops) {
      const b = bots.find((x) => x.id === id);
      await recordAutoFarmEvent({
        type: "noclaim_autostop",
        game: b ? b.game : "",
        host: HOST_ID,
        container: containerFor(id),
        actor: "noclaim-watcher",
        reason: "no live stream for this game — stopping to save RAM",
      });
    }
    for (const id of starts) {
      const b = bots.find((x) => x.id === id);
      await recordAutoFarmEvent({
        type: "noclaim_autostart",
        game: b ? b.game : "",
        host: HOST_ID,
        container: containerFor(id),
        actor: "noclaim-watcher",
        reason: "stream live again — resuming farming",
      });
    }

    // Publish per-game status for the UI.
    state.games = keys.map((k) => ({
      game: k,
      live: verdict[k].live,
      uncertain: verdict[k].uncertain,
      hadCampaign: verdict[k].hadCampaign,
      canStop: verdict[k].canStop,
      darkForMs: verdict[k].darkForMs,
      error: verdict[k].error,
    }));
    state.lastError = "";
    return counts;
  } catch (e) {
    state.lastError = (e && e.message) || String(e);
    counts.errors++;
    return counts;
  } finally {
    state.lastCounts = counts;
    state.lastRun = new Date();
    state.running = false;
  }
}

function status() {
  return {
    started: state.started,
    running: state.running,
    enabled: settings.getNoClaimGate().enabled,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    games: state.games,
    tickMs: TICK_MS,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const loop = async () => {
    let delay = TICK_MS;
    try {
      await runOnce();
    } catch {
      delay = RETRY_MS;
    }
    if (state.lastError) delay = RETRY_MS;
    setTimeout(loop, delay);
  };
  setTimeout(loop, 20 * 1000); // first pass shortly after boot
}

module.exports = {
  start,
  runOnce,
  status,
  // exported for tests
  decideActions,
  resolveWithHysteresis,
  parseBots,
  finishedCovers,
  markerCampaignIds,
  LOG_VERDICT_PY,
  _state: state,
};
