// Detects TwitchDropsBot containers that have gone silent while Docker still
// reports them "running" — the signature of a silent stall rather than a
// crash. This is exactly how the 1.2.4 dropCurrentSession breakage showed up:
// Twitch changed what a GraphQL field returned, the bot never threw, it just
// never made progress again. Nothing here waits for Alorf to publish a fix —
// this only shortens "how long until we notice," via Telegram, so a patch
// (built + rolled out through utils/botUpdater.js, upstream or from a fork)
// can start immediately instead of whenever someone happens to check.
//
// Detection has three independent triggers:
//  - Silence: a healthy bot logs at least once a minute (its watch loop's
//    "Waiting 60 seconds..." line), so ANY stretch with zero new log output
//    while the container is running is abnormal — no need to parse *what*
//    the bot is doing, just whether it's still talking. This avoids false
//    positives from a single drop campaign legitimately watching the same
//    streamer for hours: the per-minute line still changes even then.
//  - Known-bad patterns (unhandled exception, fatal error) appearing in
//    recent logs, alerted on immediately rather than waiting out the
//    silence window.
//  - Thread decay: the container keeps logging, but for a shrinking pool of
//    accounts — per-account watch threads die (401 waves) and never respawn.
//    Neither trigger above catches this; see the dedicated section below.
//
// State is in-memory only and resets on server restart (same tradeoff
// dropScanner.js makes for its session counters) — acceptable here since a
// restart just means the silence window starts counting over, not that a
// real stall goes undetected forever.
const crypto = require("crypto");

const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");

const CHECK_INTERVAL_MS =
  Number(process.env.BOT_HEALTH_INTERVAL_MS) || 15 * 60 * 1000; // 15m
const STALE_MS = Number(process.env.BOT_HEALTH_STALE_MS) || 45 * 60 * 1000; // 45m of total silence
const REMINDER_MS =
  Number(process.env.BOT_HEALTH_REMINDER_MS) || 6 * 60 * 60 * 1000; // re-ping every 6h while still stuck
const LOG_TAIL = 80;

// ---------------------------------------------------------------------------
// Thread-decay detection
// ---------------------------------------------------------------------------
// A third, independent failure mode the two checks above CANNOT see: silent
// per-account thread decay. TwitchDropsBot runs one watch thread per enabled
// account; waves of unhandled 401s kill individual threads and they don't
// respawn. The container keeps logging fine for its shrinking pool of
// survivors — nothing goes silent, nothing crashes — so it just quietly farms
// fewer and fewer accounts over days (observed: a 94-account bot decayed to 18
// active after ~2 days of uptime). The fix is a plain `docker restart`, which
// re-spins every thread with no lost progress (Twitch tracks drop watch-time
// server-side).
//
// Detection compares, per running container, the number of ENABLED accounts in
// its config against the number of DISTINCT accounts that actually logged
// activity in a recent window. Healthy: active ≈ enabled. Decayed: active ≪
// enabled.
//
// False-positive guards (a freshly-started large config, or a small config,
// legitimately reads low for a while):
//   - DECAY_MIN_ENABLED: ratio math on tiny pools is noise, so skip them.
//   - both a proportional drop (DECAY_RATIO) AND an absolute gap
//     (DECAY_MIN_GAP) must be present.
//   - DECAY_MIN_UPTIME_MS: containers up for less than this are skipped so a
//     bot still spinning up its threads isn't misread — and, crucially, this
//     makes auto-restart self-limiting: a restart resets uptime, so a bot we
//     just restarted can't be restarted again until it's had time to recover
//     (no restart loops).
const DECAY_ENABLED = process.env.BOT_DECAY_DISABLED !== "1";
const DECAY_INTERVAL_MS =
  Number(process.env.BOT_DECAY_INTERVAL_MS) || 60 * 60 * 1000; // scan hourly
const DECAY_WINDOW = process.env.BOT_DECAY_WINDOW || "6h"; // docker logs --since
const DECAY_RATIO = Number(process.env.BOT_DECAY_RATIO) || 0.6; // active/enabled floor
const DECAY_MIN_ENABLED = Number(process.env.BOT_DECAY_MIN_ENABLED) || 20; // ignore small configs
const DECAY_MIN_GAP = Number(process.env.BOT_DECAY_MIN_GAP) || 10; // ignore tiny absolute gaps
const DECAY_MIN_UPTIME_MS =
  Number(process.env.BOT_DECAY_MIN_UPTIME_MS) || 60 * 60 * 1000; // settle before judging
const DECAY_ACTION = (process.env.BOT_DECAY_ACTION || "alert").toLowerCase(); // "alert" | "restart"
const DECAY_LOG_CAP = 2000; // max log lines pulled per container per scan

// No bare exception-type patterns here (e.g. /System\.Exception/): the bot
// logs its own caught-and-retried GraphQL failures as "[ERR] ... (attempt
// 1/5)" followed by that exact type name, which isn't a crash — it recovers
// on its own within a few seconds. A real unhandled exception is already
// covered by the first pattern below (the literal string .NET's runtime
// prints when a thread's exception escapes every catch and the process
// actually goes down), so nothing broader is needed.
const CRASH_PATTERNS = [
  /unhandled exception/i,
  /fatal error/i,
  /out of memory/i,
];

const state = {
  enabled: process.env.BOT_HEALTH_DISABLED !== "1",
  lastTickAt: null,
  lastError: "",
  lastDecayAt: 0, // epoch ms of the last decay scan (0 => run on first tick)
};

// `${hostId}:${container}` -> tracking entry
const tracked = new Map();
// `${hostId}:${container}` -> decay tracking entry (last counts + cooldown)
const decayTracked = new Map();
let timer = null;
let started = false;

function key(hostId, container) {
  return hostId + ":" + container;
}

function tailHash(text) {
  return crypto
    .createHash("sha1")
    .update(text || "")
    .digest("hex");
}

function humanMs(ms) {
  const h = ms / 3600000;
  return h >= 1
    ? h.toFixed(1) + "h"
    : Math.max(1, Math.round(ms / 60000)) + "m";
}

async function checkContainer(host, container, now) {
  const k = key(host.id, container);
  let logs;
  try {
    logs = await hosts.dockerLogs(host, container, { tail: LOG_TAIL });
  } catch {
    return; // transient fetch failure — not a bot-health signal, skip this tick
  }

  const hash = tailHash(logs);
  const isCrashing = CRASH_PATTERNS.some((re) => re.test(logs));
  let entry = tracked.get(k);
  if (!entry) {
    entry = {
      hash,
      sameSince: now,
      stuckSince: null,
      crashing: isCrashing,
      lastCheckedAt: now,
      lastStuckAlertAt: 0,
      lastCrashAlertAt: 0,
    };
    tracked.set(k, entry);
    return; // first sighting — nothing to compare against yet
  }

  entry.crashing = isCrashing;
  entry.lastCheckedAt = now;
  if (isCrashing && now - entry.lastCrashAlertAt > REMINDER_MS) {
    entry.lastCrashAlertAt = now;
    await sendTelegram(
      "🔴 " +
        host.label +
        "/" +
        container +
        " has an error in its logs (unhandled exception / fatal error). " +
        "Last " +
        LOG_TAIL +
        " lines tail:\n" +
        logs.slice(-500),
    ).catch(() => {});
  }

  if (hash !== entry.hash) {
    if (entry.stuckSince) {
      await sendTelegram(
        "✅ " +
          host.label +
          "/" +
          container +
          " is logging again (was silent for " +
          humanMs(now - entry.stuckSince) +
          ").",
      ).catch(() => {});
    }
    entry.hash = hash;
    entry.sameSince = now;
    entry.stuckSince = null;
    entry.lastStuckAlertAt = 0;
    return;
  }

  const silentFor = now - entry.sameSince;
  if (silentFor < STALE_MS) return;
  if (!entry.stuckSince) entry.stuckSince = entry.sameSince;
  if (now - entry.lastStuckAlertAt < REMINDER_MS) return;
  entry.lastStuckAlertAt = now;
  await sendTelegram(
    "⚠️ " +
      host.label +
      "/" +
      container +
      " has produced no new logs for " +
      humanMs(silentFor) +
      " while still running — looks stuck, possibly Twitch changed " +
      "something the bot can't handle (same pattern as the 1.2.4 " +
      "dropCurrentSession breakage). Last log line: " +
      (logs.trim().split("\n").pop() || "(empty)"),
  ).catch(() => {});
}

async function checkHost(host, now) {
  let states;
  try {
    states = await hosts.dockerPs(host);
  } catch (e) {
    return; // host unreachable — separate concern from bot health
  }
  const running = Object.keys(states).filter(
    (name) =>
      (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
      states[name].state === "running",
  );

  for (const container of running) {
    await checkContainer(host, container, now);
  }

  const seen = new Set(running.map((c) => key(host.id, c)));
  for (const k of Array.from(tracked.keys())) {
    if (k.startsWith(host.id + ":") && !seen.has(k)) tracked.delete(k);
  }
}

// --- thread-decay helpers (pure; exported for unit tests) -----------------

// Reverse of routes/botConfigRoutes.js containerForFile: map a container name
// back to the config file backing it. "twitchbot" -> config.json;
// "twitchbotx<N>" -> config_<NN>.json, zero-padded to two digits for N < 10
// (config_02.json), left as-is for N >= 10 (config_22.json).
function fileForContainer(container) {
  if (container === "twitchbot") return "config.json";
  const m = /^twitchbotx(\d+)$/.exec(container);
  if (!m) return null;
  return "config_" + String(parseInt(m[1], 10)).padStart(2, "0") + ".json";
}

// Count enabled watch-seats in a config's TwitchUsers. "Enabled !== false"
// mirrors botFactory.usedSeats: an account occupies a thread unless explicitly
// switched off (a disabled account has Enabled:false; anything else counts).
function countEnabled(configText) {
  const data = JSON.parse(configText);
  const users =
    data &&
    data.TwitchSettings &&
    Array.isArray(data.TwitchSettings.TwitchUsers)
      ? data.TwitchSettings.TwitchUsers
      : [];
  return users.filter((u) => u && u.Enabled !== false).length;
}

// Distinct account usernames that appear in a log blob. TwitchDropsBot prefixes
// every per-account line with "[TwitchUser - <login>]", so the set of logins
// seen in a recent window is the set of accounts whose threads are still alive.
const _userRe = /TwitchUser - ([A-Za-z0-9_]+)/g;
function countActiveUsernames(logText) {
  const seen = new Set();
  _userRe.lastIndex = 0;
  let m;
  while ((m = _userRe.exec(logText || "")) !== null) seen.add(m[1]);
  return seen.size;
}

// A container is "decayed" only when ALL hold: enough seats to reason about
// (>= DECAY_MIN_ENABLED), a big proportional drop (active/enabled below
// DECAY_RATIO), AND a big absolute gap (enabled - active >= DECAY_MIN_GAP).
// Requiring all three keeps small pools and near-full bots quiet.
function isDecayed({ enabled, active }) {
  if (!Number.isFinite(enabled) || !Number.isFinite(active)) return false;
  if (enabled < DECAY_MIN_ENABLED) return false;
  if (active / enabled >= DECAY_RATIO) return false;
  if (enabled - active < DECAY_MIN_GAP) return false;
  return true;
}

// Parse docker ps "Status" for a running container into an approximate uptime
// in ms. Examples: "Up 8 minutes", "Up About an hour", "Up 2 hours",
// "Up 3 days", "Up 45 seconds", optionally trailed by "(healthy)". Returns null
// when it can't be parsed (caller treats null as "unknown" and does NOT skip).
function parseUptimeMs(status) {
  if (!status) return null;
  const m = /^Up\s+(.+?)(?:\s+\((?:un)?healthy\))?$/i.exec(
    String(status).trim(),
  );
  if (!m) return null;
  const s = m[1].toLowerCase();
  if (/less than a second|a few seconds/.test(s)) return 1000;
  if (/about a minute/.test(s)) return 60 * 1000;
  if (/about an hour/.test(s)) return 60 * 60 * 1000;
  const num = /(\d+)\s*(second|minute|hour|day|week|month)/.exec(s);
  if (!num) return null;
  const mult = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  }[num[2]];
  return mult ? parseInt(num[1], 10) * mult : null;
}

// --- thread-decay scan ----------------------------------------------------

async function checkDecay(host, container, psState, now) {
  const k = key(host.id, container);

  // Settle guard: skip freshly (re)started containers. Their logs don't yet
  // span a full account cycle, and a just-restarted bot deserves time before
  // being judged again — this is what prevents restart loops.
  const uptimeMs = parseUptimeMs(psState && psState.status);
  if (uptimeMs != null && uptimeMs < DECAY_MIN_UPTIME_MS) return;

  // Enabled seats from the config backing this container.
  let enabled;
  try {
    const file = fileForContainer(container);
    if (!file) return;
    enabled = countEnabled(await hosts.readFile(host, file));
  } catch {
    return; // missing / unreadable / unparseable config — no decay signal
  }
  if (enabled < DECAY_MIN_ENABLED) return; // cheap guard before the log pull

  // Distinct accounts active in the recent window.
  let active;
  try {
    const logs = await hosts.dockerLogs(host, container, {
      tail: DECAY_LOG_CAP,
      since: DECAY_WINDOW,
    });
    active = countActiveUsernames(logs);
  } catch {
    return; // log pull failed — skip this scan, not a decay signal
  }

  let entry = decayTracked.get(k);
  if (!entry) {
    entry = { lastAlertAt: 0, lastActionAt: 0, enabled, active };
    decayTracked.set(k, entry);
  }
  entry.enabled = enabled;
  entry.active = active;

  if (!isDecayed({ enabled, active })) return;
  if (now - entry.lastAlertAt < REMINDER_MS) return; // cooldown
  entry.lastAlertAt = now;

  const pct = Math.round((active / enabled) * 100);
  const head = host.label + "/" + container;
  const stat =
    "only " +
    active +
    "/" +
    enabled +
    " accounts (" +
    pct +
    "%) logged activity in the last " +
    DECAY_WINDOW;

  if (DECAY_ACTION === "restart") {
    let restarted = false;
    try {
      await hosts.dockerContainer(host, "restart", container);
      restarted = true;
      entry.lastActionAt = now;
    } catch {
      // fall through and alert about the failed auto-heal
    }
    await sendTelegram(
      (restarted ? "🔄 " : "🔴 ") +
        head +
        " thread decay: " +
        stat +
        ". " +
        (restarted
          ? "Auto-restarted to re-spin the dead watch threads — drop progress is tracked server-side, so nothing is lost."
          : "Auto-restart FAILED; restart it manually: docker restart " +
            container +
            "."),
    ).catch(() => {});
  } else {
    await sendTelegram(
      "⚠️ " +
        head +
        " thread decay: " +
        stat +
        " while the container is still running — its per-account watch threads " +
        "are dying off without respawning. Fix: docker restart " +
        container +
        " (re-spins every thread; Twitch tracks drop progress server-side, so " +
        "nothing is lost). Set BOT_DECAY_ACTION=restart to auto-heal.",
    ).catch(() => {});
  }
}

async function decayScanHost(host, now) {
  let states;
  try {
    states = await hosts.dockerPs(host);
  } catch {
    return; // host unreachable — not a decay signal
  }
  const running = Object.keys(states).filter(
    (name) =>
      (name === "twitchbot" || /^twitchbotx\d+$/.test(name)) &&
      states[name].state === "running",
  );
  for (const container of running) {
    await checkDecay(host, container, states[container], now).catch(() => {});
  }
  // Forget containers that are no longer running so their cooldown resets.
  const seen = new Set(running.map((c) => key(host.id, c)));
  for (const k of Array.from(decayTracked.keys())) {
    if (k.startsWith(host.id + ":") && !seen.has(k)) decayTracked.delete(k);
  }
}

async function tick() {
  state.lastTickAt = new Date();
  if (state.enabled) {
    const now = Date.now();
    try {
      for (const h of hosts.listHosts()) {
        await checkHost(hosts.resolveHost(h.id), now);
      }
      state.lastError = "";
    } catch (e) {
      state.lastError = e.message || String(e);
    }
    // Thread-decay pass runs on its own slower cadence (a 6h-window log pull
    // per container is heavier than the silence tail, and decay is a
    // slow-moving signal), independent of the per-tick silence/crash checks.
    if (DECAY_ENABLED && now - state.lastDecayAt >= DECAY_INTERVAL_MS) {
      state.lastDecayAt = now;
      try {
        for (const h of hosts.listHosts()) {
          await decayScanHost(hosts.resolveHost(h.id), now);
        }
      } catch (e) {
        state.lastError = e.message || String(e);
      }
    }
  }
  schedule(CHECK_INTERVAL_MS);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

function start() {
  if (started) return;
  started = true;
  schedule(30000); // let boot settle first
}

function status() {
  return {
    enabled: state.enabled,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    checkIntervalMs: CHECK_INTERVAL_MS,
    staleMs: STALE_MS,
    containers: Array.from(tracked.entries()).map(([k, v]) => ({
      key: k,
      stuck: !!v.stuckSince,
      crashing: !!v.crashing,
      silentSince: new Date(v.sameSince).toISOString(),
      lastCheckedAt: v.lastCheckedAt
        ? new Date(v.lastCheckedAt).toISOString()
        : null,
    })),
    decay: {
      enabled: DECAY_ENABLED,
      action: DECAY_ACTION,
      intervalMs: DECAY_INTERVAL_MS,
      window: DECAY_WINDOW,
      ratio: DECAY_RATIO,
      minEnabled: DECAY_MIN_ENABLED,
      minGap: DECAY_MIN_GAP,
      lastScanAt: state.lastDecayAt
        ? new Date(state.lastDecayAt).toISOString()
        : null,
      containers: Array.from(decayTracked.entries()).map(([k, v]) => ({
        key: k,
        enabled: v.enabled,
        active: v.active,
        decayed: isDecayed({ enabled: v.enabled, active: v.active }),
        lastAlertAt: v.lastAlertAt
          ? new Date(v.lastAlertAt).toISOString()
          : null,
        lastActionAt: v.lastActionAt
          ? new Date(v.lastActionAt).toISOString()
          : null,
      })),
    },
  };
}

module.exports = {
  start,
  status,
  // Pure helpers exported for unit tests.
  fileForContainer,
  countEnabled,
  countActiveUsernames,
  isDecayed,
  parseUptimeMs,
  // Orchestration entrypoint exposed for integration tests (drives one decay
  // scan of a host against an injectable `hosts` layer).
  decayScanHost,
};
