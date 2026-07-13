// Detects TwitchDropsBot containers that have gone silent while Docker still
// reports them "running" — the signature of a silent stall rather than a
// crash. This is exactly how the 1.2.4 dropCurrentSession breakage showed up:
// Twitch changed what a GraphQL field returned, the bot never threw, it just
// never made progress again. Nothing here waits for Alorf to publish a fix —
// this only shortens "how long until we notice," via Telegram, so a patch
// (built + rolled out through utils/botUpdater.js, upstream or from a fork)
// can start immediately instead of whenever someone happens to check.
//
// Detection has two independent triggers:
//  - Silence: a healthy bot logs at least once a minute (its watch loop's
//    "Waiting 60 seconds..." line), so ANY stretch with zero new log output
//    while the container is running is abnormal — no need to parse *what*
//    the bot is doing, just whether it's still talking. This avoids false
//    positives from a single drop campaign legitimately watching the same
//    streamer for hours: the per-minute line still changes even then.
//  - Known-bad patterns (unhandled exception, fatal error) appearing in
//    recent logs, alerted on immediately rather than waiting out the
//    silence window.
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
const REMINDER_MS = Number(process.env.BOT_HEALTH_REMINDER_MS) || 6 * 60 * 60 * 1000; // re-ping every 6h while still stuck
const LOG_TAIL = 80;

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
};

// `${hostId}:${container}` -> tracking entry
const tracked = new Map();
let timer = null;
let started = false;

function key(hostId, container) {
  return hostId + ":" + container;
}

function tailHash(text) {
  return crypto.createHash("sha1").update(text || "").digest("hex");
}

function humanMs(ms) {
  const h = ms / 3600000;
  return h >= 1 ? h.toFixed(1) + "h" : Math.max(1, Math.round(ms / 60000)) + "m";
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
  let entry = tracked.get(k);
  if (!entry) {
    entry = {
      hash,
      sameSince: now,
      stuckSince: null,
      lastStuckAlertAt: 0,
      lastCrashAlertAt: 0,
    };
    tracked.set(k, entry);
    return; // first sighting — nothing to compare against yet
  }

  const isCrashing = CRASH_PATTERNS.some((re) => re.test(logs));
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
      silentSince: new Date(v.sameSince).toISOString(),
    })),
  };
}

module.exports = { start, status };
