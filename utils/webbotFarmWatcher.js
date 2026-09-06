// Web-farm auto power — the live/dark gate for the STANDALONE web-token farm
// (routes/webbotFarmRoutes.js). It is to the webbot-bot-* containers what
// utils/noclaimWatcher.js is to the no-claim bots and streamScout + botWaker are
// to the managed bots: it keeps a bot's container ON only while a qualifying
// stream for its pinned game is actually live, and OFF (docker stop) during
// broadcast gaps or when the game has no active drop campaign at all.
//
// WHY A SEPARATE WATCHER
// The web farm is deliberately decoupled from every other subsystem: its
// containers are webbot-bot-* in a dedicated Pi dir (BASE), it has no
// BotAccount / AutoFarmTask rows, and neither botWaker (managed fleet) nor
// noclaimWatcher (noclaim-bot-*) can see or touch a webbot-bot-* container. So
// without this loop the web farm has NO liveness gating at all — a webbot bot
// pinned to a dark game (e.g. Overwatch with no active campaign) just idles its
// container forever (the farmer backs off 2 min and retries, never exits). This
// watcher reuses the read-only liveness PRIMITIVES from Stream Scout
// (getStreamsLive / getGameDropsLive / fetchCampaignDetails) and drives docker
// on the Pi directly. It never writes CampaignLiveState (owned by streamScout).
//
// TWO DIFFERENCES FROM noclaimWatcher (deliberate)
//  1. DYNAMIC game set. No-claim gates a fixed list (noClaimGames). A webbot bot
//     can be pinned to ANY game (create accepts any label), so the set of games
//     to check is derived each pass from the pinned games of the bots that
//     actually exist on the Pi — not a settings list.
//  2. The "uncertain" verdict (the boot-window flap fix from noclaimWatcher's
//     history) is baked in from day one: a game with no active campaign is only
//     trusted as dark when the campaign catalog is FRESH; otherwise it is
//     UNCERTAIN — keep a running bot up, but never WAKE a stopped one on an
//     unverifiable signal. This means a process restart can never cold-start a
//     bot to farm a campaign that does not exist.
//
// SAFETY (mirrors noclaimWatcher / streamScout)
//  * Ships OFF (settings.webbotStreamGate) — zero Twitch calls, zero container
//    activity until flipped on. It can NEVER surprise-kill a manually
//    pre-positioned bot (e.g. an Overwatch set staged before a campaign) until
//    the operator enables it.
//  * FAIL TOWARD FARMING: any uncertainty — a Twitch error, no token, a stale
//    catalog — keeps bots UP.
//  * A stop fires only after a game is confidently dark for a hysteresis window
//    (no flapping); a start fires immediately (drops are time-sensitive).
//  * Cold-start on live, EXCEPT a bot the operator explicitly stopped. Two
//    marker files in the bot dir separate the cases: `.autostopped` = the
//    watcher parked it (dark game) → resume when live; `.operatoroff` = the
//    operator hit Stop → stay off until Start/Create. Start/Create clear both.
const TwitchCampaign = require("../models/TwitchCampaign");
const BotAccount = require("../models/BotAccount");
const settings = require("./settings");
const hosts = require("./botHosts");
const campaignWatcher = require("./campaignWatcher");
const { getStreamsLive, getGameDropsLive } = require("./twitchWatch");
const { fetchCampaignDetails } = require("./twitchInventory");
const { recordAutoFarmEvent } = require("./autoFarmEventLog");
const { sendTelegram } = require("./telegram");
const crypto = require("crypto");

// Keep these in lock-step with routes/webbotFarmRoutes.js — same Pi dir + names.
const HOST_ID = "pi";
const BASE = "/home/avishka/webbot-drops-farm";
const BOTS_DIR = BASE + "/bots";
const CONTAINER_PREFIX = "webbot-bot-";
const containerFor = (id) => CONTAINER_PREFIX + id;
const markerPath = (id) => BOTS_DIR + "/" + id + "/.autostopped"; // watcher park
// ACL-aware channel hints for the farmer (docs/WEBBOT-ACL-CHANNELS-CONTRACT.md).
// The bot dir is mounted :ro at /config, so the farmer reads this as
// /config/channels.json.
const channelsPath = (id) => BOTS_DIR + "/" + id + "/channels.json";
// Rewrite an UNCHANGED channels.json at most every 20 min: the farmer treats
// an `updatedAt` older than 45 min as stale, so 20 keeps it fresh with slack.
const CHANNELS_REWRITE_MS = Number(process.env.WEBBOT_CHANNELS_REWRITE_MS) || 20 * 60 * 1000;
// Heartbeat window: how far back `docker logs --since` looks per running bot.
const HEARTBEAT_WINDOW = "6m";
// Idle alert: verdict "idle" on this many consecutive ticks, at most one
// Telegram per bot per cooldown.
const IDLE_ALERT_TICKS = 2;
// A bot is only "farming" when at least this share of its accounts credited a
// drop minute in the heartbeat window. Below it (but above zero) the bot is
// PARTIAL: some accounts are earning and some are silently not — the failure
// mode a raw line count cannot see. Deliberately loose: accounts legitimately
// go quiet while rotating channels or during a lease hand-off, so this catches
// a collapsed fleet, not routine churn.
const COVERAGE_MIN = Number(process.env.WEBBOT_COVERAGE_MIN) || 0.5;
// Heartbeat verdicts that mean "this bot is not doing its job".
const ALERTABLE = new Set(["idle", "partial"]);
const IDLE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const TICK_MS = Number(process.env.WEBBOT_WATCHER_TICK_MS) || 3 * 60 * 1000; // 3 min
const RETRY_MS = 60 * 1000; // a failed pass retries on a short fuse
const ACL_TTL_MS = 6 * 60 * 60 * 1000; // 6h — an ACL rarely changes, liveness does
// A game with no active campaign is only "dark" if the campaign catalog is
// FRESH. campaignWatcher refreshes every 2h; give it slack before trusting a
// "no campaign" verdict, else a lagging (or just-booted) catalog stops bots.
const CAMPAIGN_STALE_MS =
  Number(process.env.WEBBOT_CAMPAIGN_STALE_MS) || 3 * 60 * 60 * 1000; // 3h
// How long a game must stay dark before we stop its bots (hysteresis).
const PARK_AFTER_DARK_MS =
  Number(process.env.WEBBOT_PARK_AFTER_DARK_MS) || 20 * 60 * 1000; // 20 min

const norm = (s) => settings.normGameName(s);
const normLogin = (s) => String(s || "").trim().toLowerCase();

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { games: 0, live: 0, started: 0, stopped: 0, errors: 0 },
  games: [], // per-game verdict for the UI
  bots: [], // last-seen bot snapshot for the UI
  // gameKey -> ms the game first went dark this streak (hysteresis anchor).
  darkSince: {},
  // botId -> { hash, at } of the last channels.json we pushed to the Pi.
  lastWritten: {},
  // botId -> { at, progress, noSession, attaches } parsed from docker logs.
  heartbeat: {},
  // botId -> the last IDLE_ALERT_TICKS heartbeat verdicts (most recent last).
  hbHistory: {},
  // botId -> ms of the last idle Telegram alert (cooldown anchor).
  lastIdleAlertAt: {},
  // Last error from the channels/heartbeat sync (kept apart from lastError so
  // a Telegram/ACL hiccup never puts the gate loop on its 1-min retry fuse).
  lastSyncError: "",
  lastSyncAt: null,
};

// campaignId -> { channels: [login], fetchedAt: ms }
const aclCache = new Map();

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error(`Pi host "${HOST_ID}" is not configured.`);
    e.status = 503;
    throw e;
  }
  return host;
}

// Healthy integrity-valid tokens to read liveness with (read-only stream
// queries, never the integrity gate). Borrowed from the managed BotAccount rig
// exactly like noclaimWatcher — the web farm's own web tokens are a different
// client id, and liveness reads are game-agnostic, so any healthy token works.
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
    // No data → treat as un-gated (category / fail toward farming), never dark.
    return hit ? hit.channels : [];
  }
}

// Active drop campaigns right now whose game matches one of the managed
// keywords (the games our live bots are pinned to). Same catalog streamScout
// and noclaimWatcher read.
async function activeCampaignsForGames(keywords) {
  const now = new Date();
  const rows = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1, name: 1, endAt: 1 },
  ).lean();
  return rows.filter((c) => {
    if (!c.game) return false;
    const g = norm(c.game);
    return keywords.some((k) => g === k || g.includes(k) || k.includes(g));
  });
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

// Build a per-game verdict for every managed keyword. Returns a map keyed by the
// normalised game keyword: { live, hadCampaign, checked, error, uncertain }.
// live=true also when uncertain (fail toward farming). `hadCampaign` is only
// meaningful when the catalog is fresh; a stale catalog forces uncertain.
async function gameVerdicts(keywords) {
  const verdict = {};
  for (const k of keywords) {
    verdict[k] = {
      live: true,
      hadCampaign: false,
      checked: false,
      error: "",
      uncertain: false,
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

  const campaigns = await activeCampaignsForGames(keywords);
  const tokens = await borrowTokens();

  for (const k of keywords) {
    const forGame = campaigns.filter((c) => {
      const g = norm(c.game);
      return g === k || g.includes(k) || k.includes(g);
    });
    const v = verdict[k];
    v.checked = true;
    v.hadCampaign = forGame.length > 0;

    if (!forGame.length) {
      // No active campaign for this game — nothing to farm (no drops to earn),
      // regardless of any live stream. Never cold-start a stopped bot here. Trust
      // "no campaign" as dark ONLY when the catalog is fresh; otherwise mark
      // UNCERTAIN (keep a running bot up, but do not WAKE a parked one on an
      // unverifiable signal) so a boot window / catalog stall can't wake bots for
      // a campaign that does not exist.
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

    // Live if ANY of the game's active campaigns is watchable now.
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

// Read every webbot bot from the Pi: id, config game, running?, autostopped?,
// operatorOff? One round trip (docker ps + a config sweep). Config is a flat
// JSON with a top-level "game" field (routes/webbotFarmRoutes.js writes it).
async function readBots() {
  const script =
    `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}' 2>/dev/null; echo "PS_END"; ` +
    `echo "BOTS_START"; for d in ${hosts.shq(BOTS_DIR)}/*/config.json; do [ -f "$d" ] || continue; ` +
    `id=$(basename $(dirname "$d")); ` +
    `game=$(tr -d '\\n' < "$d" | sed -n 's/.*"game"[^"]*"\\([^"]*\\)".*/\\1/p'); ` +
    `mk=no; [ -f ${hosts.shq(BOTS_DIR)}/"$id"/.autostopped ] && mk=yes; ` +
    `oo=no; [ -f ${hosts.shq(BOTS_DIR)}/"$id"/.operatoroff ] && oo=yes; ` +
    `n=$(grep -o '"webToken"' "$d" 2>/dev/null | wc -l | tr -d ' '); ` +
    `echo "$id|$game|$mk|$oo|$n"; done; echo "BOTS_END"`;
  const { stdout } = await hosts.runShell(pi(), script, { timeout: 25000 });
  const lines = String(stdout || "").split("\n");
  let section = "";
  const psMap = {};
  const bots = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "PS_START") { section = "ps"; continue; }
    if (line === "PS_END") { section = ""; continue; }
    if (line === "BOTS_START") { section = "bots"; continue; }
    if (line === "BOTS_END") { section = ""; continue; }
    if (section === "ps" && line) {
      const [name, st] = line.split("|");
      psMap[name.replace(CONTAINER_PREFIX, "")] = st;
    } else if (section === "bots" && line) {
      const [id, game, mk, oo, n] = line.split("|");
      bots.push({
        id,
        game: game || "",
        autostopped: mk === "yes",
        operatorOff: oo === "yes",
        accounts: Number(n) || 0,
      });
    }
  }
  for (const b of bots) b.running = psMap[b.id] === "running";
  return bots;
}

// PURE decision core (unit-tested): given the bots and a resolved per-game
// verdict, decide which to start and which to stop. `verdict[gameKey]` carries
// { live, uncertain, canStop } where canStop already folds in dark-hysteresis. A
// bot whose game matches no managed keyword is left untouched.
//   START: game CONFIRMED-live + bot stopped + NOT operator-off (never override
//          an explicit Stop, and never on an `uncertain` verdict).
//   STOP:  game confidently dark + bot running.
function decideActions(bots, verdict) {
  const starts = [];
  const stops = [];
  const match = (label) => {
    const g = norm(label);
    for (const k of Object.keys(verdict)) {
      if (g === k || g.includes(k) || k.includes(g)) return verdict[k];
    }
    return null;
  };
  for (const b of bots) {
    const v = match(b.game);
    if (!v) continue; // unknown game — never touch
    if (v.live && !v.uncertain && !b.running && !b.operatorOff) {
      starts.push(b.id);
    } else if (v.canStop && b.running) {
      stops.push(b.id);
    }
  }
  return { starts, stops };
}

// Apply start/stop on the Pi in ONE round trip. Starts clear the park marker;
// stops set it. Each action is independent (`;`, `|| true`) so one failure never
// blocks the rest.
async function applyActions(starts, stops) {
  const parts = [];
  for (const id of starts) {
    parts.push(
      `docker start ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `rm -f ${hosts.shq(markerPath(id))} || true`,
    );
  }
  for (const id of stops) {
    parts.push(
      `docker stop ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true`,
      `touch ${hosts.shq(markerPath(id))} || true`,
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
  for (const k of Object.keys(state.darkSince)) {
    if (!(k in rawVerdict)) delete state.darkSince[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// channels.json + heartbeat + idle alert (docs/WEBBOT-ACL-CHANNELS-CONTRACT.md,
// "Watcher additions"). Everything below runs AFTER the start/stop actions and
// is fully try/caught inside runOnce — a Twitch/SSH/Telegram failure here can
// never block the gate. It never starts or stops a container and never writes
// CampaignLiveState.
// ---------------------------------------------------------------------------

const gameMatches = (label, key) => {
  const g = norm(label);
  return !!g && !!key && (g === key || g.includes(key) || key.includes(g));
};

// PURE. Build the channels.json document for one bot from its game's active
// campaigns. `campaignsWithAcl` = [{ campaignId, name, endAt, acl, live, error }]
// where `acl` is the campaign's ACL logins ([]/null = un-gated) and `live` is
// the set/array of logins known live now. Output rules:
//   * campaigns already ended at `now` are dropped;
//   * `acl` is null when the campaign has no (or a disabled) ACL;
//   * `live` is always a subset of `acl` (sorted, deduped, lowercased) — [] for
//     an un-gated campaign or when liveness was unreadable;
//   * a per-campaign `error` bubbles up as a top-level "error" (first one wins)
//     and forces that campaign's `live` to [] (fail toward "nothing known").
function buildChannelsFile(bot, campaignsWithAcl, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const out = {
    v: 1,
    game: String((bot && bot.game) || ""),
    updatedAt: new Date(nowMs).toISOString(),
    campaigns: [],
  };
  let error = "";
  for (const c of Array.isArray(campaignsWithAcl) ? campaignsWithAcl : []) {
    if (!c) continue;
    let endAt = null;
    if (c.endAt) {
      const t = new Date(c.endAt).getTime();
      if (Number.isFinite(t)) {
        if (t <= nowMs) continue; // ended → not a candidate
        endAt = new Date(t).toISOString();
      }
    }
    const acl = Array.isArray(c.acl) && c.acl.length
      ? [...new Set(c.acl.map((l) => String(l || "").toLowerCase().trim()).filter(Boolean))].sort()
      : null;
    let live = [];
    if (acl && !c.error) {
      const liveSet = c.live instanceof Set
        ? c.live
        : new Set((Array.isArray(c.live) ? c.live : []).map((l) => String(l || "").toLowerCase().trim()));
      live = acl.filter((l) => liveSet.has(l));
    }
    if (c.error && !error) error = String((c.error && c.error.message) || c.error);
    out.campaigns.push({
      id: String(c.campaignId || c.id || ""),
      name: String(c.name || ""),
      endAt,
      acl,
      live,
    });
  }
  if (error) out.error = error;
  return out;
}

// PURE. Content hash of a channels file EXCLUDING updatedAt, so a tick that
// changes nothing but the timestamp does not cost an SSH write.
function channelsHash(file) {
  const { updatedAt, ...rest } = file || {};
  return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

// PURE. Classify one bot's 6-minute log window. `gameVerdict` is accepted for
// symmetry with the contract (and future use) but the verdict is log-only:
//   farming  — at least one "progress → drop" (minutes credited);
//   idle     — no credit but the farmer IS attached and polling a channel that
//              has no drop session (the R6 ACL failure mode);
//   starting — nothing at all yet (fresh container / still picking a channel);
//   unknown  — no heartbeat for this bot.
function heartbeatVerdict(hb, gameVerdict, totalAccounts) { // eslint-disable-line no-unused-vars
  if (!hb || typeof hb !== "object") return "unknown";
  const progress = Number(hb.progress) || 0;
  const noSession = Number(hb.noSession) || 0;
  const pa = Number(hb.progressAccounts);
  const total = Number(totalAccounts) || 0;
  // Prefer DISTINCT-ACCOUNT coverage when the farmer labels its lines. A raw
  // line count says "farming" when a single healthy account out of fifty is
  // logging, which is how partial farm loss went unnoticed for days.
  //
  // A pre-label farmer image reports progressAccounts = 0 while progress > 0.
  // That is "coverage unknown", NOT a stalled fleet, so it must fall through to
  // the line-count verdict — otherwise a rolling image upgrade would alert on
  // every healthy bot.
  if (total > 0 && Number.isFinite(pa) && pa > 0) {
    return pa / total >= COVERAGE_MIN ? "farming" : "partial";
  }
  if (progress > 0) return "farming";
  if (noSession > 0) return "idle";
  return "starting";
}

// PURE. Debounce for the idle alert: fire only when the bot has been "idle" on
// IDLE_ALERT_TICKS consecutive ticks (this one + the previous ones) and no
// alert went out for it within the cooldown. `prevVerdicts` = earlier verdicts,
// most recent last; `lastAlertAt` = ms or null.
function shouldAlertIdle(prevVerdicts, nowVerdict, lastAlertAt, now = Date.now()) {
  if (!ALERTABLE.has(nowVerdict)) return false;
  const prev = Array.isArray(prevVerdicts) ? prevVerdicts : [];
  const need = IDLE_ALERT_TICKS - 1;
  if (prev.length < need) return false;
  // Consecutive BAD ticks, not consecutive identical ones: a bot flapping
  // idle → partial → idle is still failing and must not dodge the alert.
  for (let i = prev.length - need; i < prev.length; i++) {
    if (!ALERTABLE.has(prev[i])) return false;
  }
  if (lastAlertAt && now - lastAlertAt < IDLE_ALERT_COOLDOWN_MS) return false;
  return true;
}

// Bot ids are directory names read off the Pi; only plain ones may be spliced
// into a shell script / path.
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

// Pulls the account label out of a farmer log line
// (`[<stamp>] [<login>] progress → drop …`) and de-duplicates it, so the
// heartbeat reports DISTINCT ACCOUNTS. `sed -n …p` prints only on a match, so a
// farmer image that predates per-account labels yields 0 rather than a bogus
// count — heartbeatVerdict reads that as "coverage unknown" and falls back.
const DISTINCT_LABELS = `sed -n -E 's/^\\[[^]]*\\] \\[([^]]+)\\].*/\\1/p' | sort -u | wc -l | tr -d ' '`;

// PURE. The ONE SSH script for a tick → { script, input }. Heredoc-free:
//   * channels.json writes travel on STDIN as `<id> <base64>` lines (a big ACL
//     could blow past the 128KB single-argument cap if inlined) and land
//     atomically: `echo "$b64" | base64 -d > <path>.tmp && mv <path>.tmp <path>`;
//   * heartbeat counts for every running bot: ONE `docker logs --since 6m`
//     into a temp file, then the three `grep -c` counts the contract names.
// Each step is independent (`|| true`) so one bad bot never blocks the rest.
// Output lines:
//   WR|<id>|ok   or   WR|<id>|fail          per write
//   HB_START / <id>|<progress>|<noSession>|<attaches> … / HB_END
function buildSyncScript(runningIds, writes) {
  const parts = [];
  const okWrites = (writes || []).filter((w) => w && SAFE_ID.test(String(w.id)));
  const okRunning = (runningIds || []).filter((id) => SAFE_ID.test(String(id)));
  const input = okWrites
    .map((w) => `${w.id} ${Buffer.from(JSON.stringify(w.file), "utf8").toString("base64")}\n`)
    .join("");
  if (okWrites.length) {
    parts.push(
      `while read -r id b64; do [ -n "$id" ] || continue; ` +
        `d=${hosts.shq(BOTS_DIR)}/"$id"; ` +
        `if [ -d "$d" ] && echo "$b64" | base64 -d > "$d/channels.json.tmp" && mv "$d/channels.json.tmp" "$d/channels.json"; ` +
        `then echo "WR|$id|ok"; else rm -f "$d/channels.json.tmp"; echo "WR|$id|fail"; fi; done`,
    );
  }
  parts.push('echo "HB_START"');
  if (okRunning.length) parts.push("hb=$(mktemp 2>/dev/null || echo /tmp/webbot-hb.$$)");
  for (const id of okRunning) {
    parts.push(
      `docker logs --since ${HEARTBEAT_WINDOW} ${hosts.shq(containerFor(id))} > "$hb" 2>&1 </dev/null || true; ` +
        `p=$(grep -c -F 'progress → drop' "$hb"); ` +
        `s=$(grep -c -F 'no active drop-session' "$hb"); ` +
        `a=$(grep -c -E 'farming .* via' "$hb"); ` +
        `pa=$(grep -F 'progress → drop' "$hb" | ${DISTINCT_LABELS}); ` +
        `sa=$(grep -F 'no active drop-session' "$hb" | ${DISTINCT_LABELS}); ` +
        `echo "${id}|$p|$s|$a|$pa|$sa"`,
    );
  }
  if (okRunning.length) parts.push('rm -f "$hb"');
  parts.push('echo "HB_END"');
  return { script: parts.join("; "), input };
}

// PURE. Parse buildSyncScript's output → { heartbeat: {id: {progress,noSession,attaches}}, written: [id], failed: [id] }.
function parseSyncOutput(stdout) {
  const heartbeat = {};
  const written = [];
  const failed = [];
  let inHb = false;
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "HB_START") { inHb = true; continue; }
    if (line === "HB_END") { inHb = false; continue; }
    if (line.startsWith("WR|")) {
      const [, id, st] = line.split("|");
      (st === "ok" ? written : failed).push(id);
      continue;
    }
    if (inHb) {
      const cols = line.split("|");
      // 6 = labelled farmer (with distinct-account counts), 4 = the older
      // image. Anything else is docker/grep noise, not a row.
      if (cols.length !== 4 && cols.length !== 6) continue;
      const [id, p, s, a, pa, sa] = cols;
      if (!SAFE_ID.test(id)) continue;
      heartbeat[id] = {
        progress: Number(p) || 0,
        noSession: Number(s) || 0,
        attaches: Number(a) || 0,
        // Present ONLY on a labelled image, so the verdict can tell "no
        // coverage data" (key absent) from "no accounts progressing" (key 0).
        // Absent rather than undefined keeps the pre-label row shape identical.
        ...(cols.length === 6
          ? { progressAccounts: Number(pa) || 0, noSessionAccounts: Number(sa) || 0 }
          : null),
      };
    }
  }
  return { heartbeat, written, failed };
}

// Which of these ACL logins are live now? Same batching / token rotation as
// anyChannelLive but collects the full set (no early exit). Throws on a
// non-auth Twitch failure so the caller can mark `live` unknown.
async function liveAmong(channels, tokens) {
  const live = new Set();
  let tokenIdx = 0;
  for (let i = 0; i < channels.length; i += LIVENESS_BATCH) {
    const chunk = channels.slice(i, i + LIVENESS_BATCH);
    let done = false;
    while (!done) {
      const token = tokens[tokenIdx] || null;
      try {
        const got = await getStreamsLive(token, chunk);
        for (const l of got || []) live.add(l);
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
  return live;
}

// Resolve every active campaign of the managed games with its ACL + live
// subset. One liveness sweep over the UNION of all ACL logins (deduped, ≤100
// per batch). A Twitch failure yields live=[] + a per-campaign `error` (never
// throws — the file still gets written so the farmer falls back sanely).
async function campaignsWithAclFor(keywords) {
  const campaigns = await activeCampaignsForGames(keywords);
  if (!campaigns.length) return [];
  const tokens = await borrowTokens();
  const out = [];
  for (const c of campaigns) {
    let acl = [];
    try {
      acl = tokens.length ? await aclChannels(c.campaignId, tokens[0]) : [];
    } catch {
      acl = [];
    }
    out.push({ campaignId: c.campaignId, game: c.game, name: c.name, endAt: c.endAt, acl, live: [], error: "" });
  }
  const union = [...new Set(out.flatMap((c) => c.acl))];
  if (union.length) {
    try {
      if (!tokens.length) throw new Error("no token to read ACL liveness");
      const live = await liveAmong(union, tokens);
      for (const c of out) c.live = c.acl.filter((l) => live.has(l));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      for (const c of out) {
        if (c.acl.length) c.error = msg;
      }
    }
  }
  return out;
}

// The per-tick sync: build every bot's channels.json, diff against the last
// write, gather heartbeats for running bots, push it all in ONE SSH round trip,
// then run the idle-alert debounce. `runningIds` already reflects this tick's
// start/stop actions. Mutates state.{lastWritten,heartbeat,hbHistory,
// lastIdleAlertAt,lastSyncAt}; annotates each bot in `bots` with hb/hbVerdict/
// channels for the UI.
async function syncChannelsAndHeartbeat(bots, verdict, runningIds, now = Date.now()) {
  const keywords = [...new Set(bots.map((b) => norm(b.game)).filter(Boolean))];
  const all = await campaignsWithAclFor(keywords);

  // 1. channels.json per bot (running AND stopped — a bot that gets started
  //    must find a fresh file).
  const writes = [];
  const liveIds = new Set(bots.map((b) => b.id));
  for (const b of bots) {
    const key = norm(b.game);
    const mine = all.filter((c) => gameMatches(c.game, key));
    const file = buildChannelsFile(b, mine, now);
    const hash = channelsHash(file);
    const last = state.lastWritten[b.id];
    const fresh = last && last.hash === hash && now - last.at < CHANNELS_REWRITE_MS;
    b.channels = {
      updatedAt: file.updatedAt,
      campaigns: file.campaigns.map((c) => ({
        name: c.name,
        gated: c.acl !== null,
        aclCount: c.acl ? c.acl.length : 0,
        liveCount: c.live.length,
        live: c.live,
      })),
      error: file.error || "",
      pending: !fresh,
    };
    if (!fresh) writes.push({ id: b.id, file, hash });
  }
  for (const id of Object.keys(state.lastWritten)) {
    if (!liveIds.has(id)) delete state.lastWritten[id];
  }

  // 2. Heartbeat for running bots, same round trip.
  const { script, input } = buildSyncScript(runningIds, writes);
  const { stdout } = await hosts.runShell(pi(), script, { timeout: 60000, input });
  const parsed = parseSyncOutput(stdout);
  for (const w of writes) {
    if (parsed.written.includes(w.id)) state.lastWritten[w.id] = { hash: w.hash, at: now };
  }
  const heartbeat = {};
  for (const id of runningIds) {
    const hb = parsed.heartbeat[id];
    if (hb) heartbeat[id] = { at: new Date(now), ...hb };
  }
  state.heartbeat = heartbeat;
  state.lastSyncAt = new Date(now);

  // 3. Idle alert (debounced; gated by settings.webbotIdleAlerts, missing=true).
  let alertsOn = true;
  try {
    const af = settings.getAutoFarm() || {};
    alertsOn = af.webbotIdleAlerts !== false;
  } catch {
    alertsOn = true;
  }
  const running = new Set(runningIds);
  for (const b of bots) {
    const hb = heartbeat[b.id] || null;
    const key = norm(b.game);
    const v = Object.keys(verdict).map((k) => (gameMatches(b.game, k) ? verdict[k] : null)).find(Boolean) || null;
    const hbVerdict = running.has(b.id) ? heartbeatVerdict(hb, v, b.accounts) : "unknown";
    b.hb = hb;
    b.hbVerdict = hbVerdict;
    if (!running.has(b.id)) {
      delete state.hbHistory[b.id];
      continue;
    }
    const prev = state.hbHistory[b.id] || [];
    const gameLive = !!(v && v.live && !v.uncertain);
    if (gameLive && alertsOn && shouldAlertIdle(prev, hbVerdict, state.lastIdleAlertAt[b.id], now)) {
      state.lastIdleAlertAt[b.id] = now;
      const liveAcl = [...new Set((b.channels ? b.channels.campaigns : []).flatMap((c) => c.live))];
      const total = b.accounts || 0;
      const paRaw = hb ? Number(hb.progressAccounts) : NaN;
      const pa = Number.isFinite(paRaw) ? paRaw : null;
      // "partial" is the failure a raw line count hides: the bot IS farming,
      // just not on most of its accounts. Name the ratio so the alert is
      // actionable without opening the console.
      const what =
        hbVerdict === "partial" && pa !== null
          ? `only ${pa} of ${total} accounts credited a drop minute in the last 6 min`
          : "credited 0 minutes for 6+ min";
      const text =
        `⚠️ ${containerFor(b.id)} (${b.game || key || "?"}, ${total} accounts) is running but ` +
        `${what} while the game is live — channel ACL: ` +
        (liveAcl.length ? liveAcl.join(", ") : "none live");
      try {
        await sendTelegram(text);
      } catch (e) {
        state.lastSyncError = "telegram: " + ((e && e.message) || String(e));
      }
      try {
        await recordAutoFarmEvent({
          type: "webbot_idle_alert",
          game: b.game || "",
          host: HOST_ID,
          container: containerFor(b.id),
          count: b.accounts || 0,
          actor: "webbot-watcher",
          reason: `running but ${what} while live — ACL live: ` +
            (liveAcl.length ? liveAcl.join(", ") : "none"),
          verdict: hbVerdict,
        });
      } catch {
        /* audit is best-effort */
      }
    }
    state.hbHistory[b.id] = [...prev, hbVerdict].slice(-IDLE_ALERT_TICKS);
  }
  for (const id of Object.keys(state.hbHistory)) {
    if (!running.has(id)) delete state.hbHistory[id];
  }
  for (const id of Object.keys(state.lastIdleAlertAt)) {
    if (!liveIds.has(id)) delete state.lastIdleAlertAt[id];
  }
  return { writes: writes.length, written: parsed.written.length, failed: parsed.failed };
}

async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  const counts = { games: 0, live: 0, started: 0, stopped: 0, errors: 0 };
  try {
    if (!settings.getWebbotGate().enabled) {
      // Off → do nothing at all (no Twitch calls, no SSH). Publish an empty
      // status so the UI can show "auto power: off".
      state.games = [];
      state.bots = [];
      state.lastError = "";
      state.lastCounts = counts;
      return counts;
    }

    // Read bots FIRST — the games to gate are whatever the live bots are pinned
    // to (dynamic set), not a fixed settings list.
    const bots = await readBots();
    state.bots = bots;
    const keywords = [...new Set(bots.map((b) => norm(b.game)).filter(Boolean))];

    const raw = await gameVerdicts(keywords);
    const verdict = resolveWithHysteresis(raw);
    const keys = Object.keys(verdict);
    counts.games = keys.length;
    counts.live = keys.filter((k) => verdict[k].live).length;
    counts.errors = keys.filter((k) => verdict[k].error).length;

    const { starts, stops } = decideActions(bots, verdict);
    await applyActions(starts, stops);
    counts.started = starts.length;
    counts.stopped = stops.length;

    for (const id of stops) {
      const b = bots.find((x) => x.id === id);
      await recordAutoFarmEvent({
        type: "webbot_autostop",
        game: b ? b.game : "",
        host: HOST_ID,
        container: containerFor(id),
        actor: "webbot-watcher",
        reason: "no live stream for this game — stopping to save RAM",
      });
    }
    for (const id of starts) {
      const b = bots.find((x) => x.id === id);
      await recordAutoFarmEvent({
        type: "webbot_autostart",
        game: b ? b.game : "",
        host: HOST_ID,
        container: containerFor(id),
        actor: "webbot-watcher",
        reason: "stream live again — resuming farming",
      });
    }

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

    // channels.json + heartbeat + idle alert — AFTER the actions above and
    // fully isolated: a failure here is reported in lastSyncError only and can
    // never block the gate (nor put its loop on the retry fuse).
    try {
      state.lastSyncError = "";
      const runningIds = bots
        .filter((b) => (b.running && !stops.includes(b.id)) || starts.includes(b.id))
        .map((b) => b.id);
      await syncChannelsAndHeartbeat(bots, verdict, runningIds);
    } catch (e) {
      state.lastSyncError = (e && e.message) || String(e);
    }
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
    enabled: settings.getWebbotGate().enabled,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    games: state.games,
    bots: state.bots,
    heartbeat: state.heartbeat,
    lastSyncAt: state.lastSyncAt,
    lastSyncError: state.lastSyncError,
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
  setTimeout(loop, 25 * 1000); // first pass shortly after boot
}

module.exports = {
  start,
  runOnce,
  status,
  // exported for tests + read-only dry-run (never call applyActions from those)
  decideActions,
  resolveWithHysteresis,
  readBots,
  gameVerdicts,
  // channels.json / heartbeat / idle alert (pure, unit-tested)
  buildChannelsFile,
  channelsHash,
  heartbeatVerdict,
  shouldAlertIdle,
  buildSyncScript,
  parseSyncOutput,
  _state: state,
};
