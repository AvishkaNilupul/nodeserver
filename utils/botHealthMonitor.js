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
//  - Stale build: the container logs every minute, never crashes and keeps
//    every account "active" — yet runs an image too old to be credited. None
//    of the three triggers above can see it; see "Stale-build + disk" below.
//  - Full disk on a bot host, which silently stops every container on it.
//
// State is in-memory only and resets on server restart (same tradeoff
// dropScanner.js makes for its session counters) — acceptable here since a
// restart just means the silence window starts counting over, not that a
// real stall goes undetected forever.
const crypto = require("crypto");

const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");

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

// ---------------------------------------------------------------------------
// Stale-build + disk detection
// ---------------------------------------------------------------------------
// 2026-09-23: every rent-farm and auto-farm bot on contabo had been running a
// June 2026 image — pulled from Docker Hub as "avishkarex/twitchbot:latest" —
// that predates Twitch dropping `completedRewardCampaigns`. The bots logged
// every minute, never crashed and kept every account's thread alive, so the
// silence, crash and decay checks all read healthy while not one account was
// credited a minute for days. Buyers noticed first.
//
// Two tells, either one is enough:
//  - the container's image is not the host's current FARM_IMAGE (the
//    local-only tag utils/botUpdater.js builds). Parked bots count: they are
//    woken with a plain `docker start`, which reuses the image they were
//    created with, so a stale parked bot wakes broken.
//  - its logs carry the old build's progress line "Progress: X/Y minutes";
//    current sources print "Waiting N seconds... X/Y minutes watched." instead.
// No-claim bots (noclaim-bot-*) run their own image and are not compared.
//
// Same day, an emptied no-claim bot spun on its login prompt and wrote a 186GB
// log; at 100% disk every container on the host stopped being able to write.
// Nothing alerted, so the disk is checked too.
const BUILD_ENABLED = process.env.BOT_BUILD_CHECK_DISABLED !== "1";
const BUILD_INTERVAL_MS =
  Number(process.env.BOT_BUILD_INTERVAL_MS) || 60 * 60 * 1000; // hourly
const FARM_IMAGE = process.env.BOT_FARM_IMAGE || "twitchbot-farm:latest";
const DISK_ALERT_PCT = Number(process.env.BOT_DISK_ALERT_PCT) || 85;
const OLD_BUILD_PATTERN = /\bProgress: \d+\/\d+ minutes\b/;

const state = {
  enabled: process.env.BOT_HEALTH_DISABLED !== "1",
  lastTickAt: null,
  lastError: "",
  lastDecayAt: 0, // epoch ms of the last decay scan (0 => run on first tick)
  lastBuildScanAt: 0, // epoch ms of the last stale-build/disk scan
};

// `${hostId}:${container}` -> tracking entry
const tracked = new Map();
// `${hostId}:${container}` -> decay tracking entry (last counts + cooldown)
const decayTracked = new Map();
// hostId -> { signature, lastAlertAt, stale, missingImage, expectedId }
const buildTracked = new Map();
// hostId -> { pct, alerting, lastAlertAt }
const diskTracked = new Map();
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
  const oldBuild = isOldBuildLog(logs);
  let entry = tracked.get(k);
  const firstSighting = !entry;
  if (!entry) {
    entry = {
      hash,
      sameSince: now,
      stuckSince: null,
      crashing: isCrashing,
      oldBuild,
      lastCheckedAt: now,
      lastStuckAlertAt: 0,
      lastCrashAlertAt: 0,
      lastOldBuildAlertAt: 0,
    };
    tracked.set(k, entry);
  }
  // Visible from the very first tail, unlike silence — so no baseline needed.
  entry.oldBuild = oldBuild;
  if (oldBuild && now - (entry.lastOldBuildAlertAt || 0) > REMINDER_MS) {
    entry.lastOldBuildAlertAt = now;
    logEvent({
      category: "bots",
      action: "stale_build",
      actor: "healthMonitor",
      severity: "error",
      host: host.id,
      container,
      detail: "logs show the pre-July build's 'Progress: X/Y minutes' line",
    });
    await sendTelegram(
      "🧱 " +
        host.label +
        "/" +
        container +
        " is running an OLD bot build: its logs show \"Progress: X/Y minutes\" " +
        "(current builds print \"... minutes watched\"). That build watches " +
        "streams without ever being credited. Recreate it on " +
        FARM_IMAGE +
        " (Bots page rollout, or docker compose up -d --force-recreate " +
        container +
        ").",
    ).catch(() => {});
  }
  if (firstSighting) return; // nothing to compare against yet for silence

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
    logEvent({
      category: "bots",
      action: "stall_restart",
      actor: "healthMonitor",
      severity: restarted ? "warn" : "error",
      host: host.id,
      container,
      detail: stat + (restarted ? " — auto-restarted" : " — auto-restart FAILED"),
    });
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
    logEvent({
      category: "bots",
      action: "stall_detected",
      actor: "healthMonitor",
      severity: "warn",
      host: host.id,
      container,
      detail: stat,
    });
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

// --- stale-build + disk helpers (pure; exported for unit tests) -----------

function isOldBuildLog(logText) {
  return OLD_BUILD_PATTERN.test(logText || "");
}

// Farm bots are the compose-managed "twitchbot" / "twitchbotx<N>" containers.
// No-claim bots and one-off containers (the updater's testrun) are not.
function isFarmBot(name) {
  return name === "twitchbot" || /^twitchbotx\d+$/.test(name);
}

// Parse `docker inspect -f '{{.Name}}|{{.Image}}|{{.State.Status}}'` output.
function parseBotImages(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 3 || !parts[0]) continue;
    rows.push({
      name: parts[0].replace(/^\//, ""),
      imageId: parts[1],
      status: parts[2],
    });
  }
  return rows;
}

// Farm bots whose image is not the host's current farm image (by id, so a
// retag or rollout is compared on content, not on the name it was created
// with). Returns [] when the expected id is unknown — that case is reported
// separately as a missing image, never as "every bot is stale".
function staleBuilds(rows, expectedId) {
  if (!expectedId) return [];
  return rows
    .filter((r) => isFarmBot(r.name) && r.imageId && r.imageId !== expectedId)
    .map((r) => ({ name: r.name, running: r.status === "running" }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
}

// The one image id every farm bot on the host runs, or "" when they differ or
// there are none. When the farm tag goes missing, this is the build the bots
// are still on — and the id to put the tag back on, if it is a farm build.
function sharedImageId(rows) {
  const ids = new Set(
    rows.filter((r) => isFarmBot(r.name) && r.imageId).map((r) => r.imageId),
  );
  return ids.size === 1 ? Array.from(ids)[0] : "";
}

// Docker's 12-character short form of "sha256:<hex>", accepted by docker tag.
function shortImageId(id) {
  return String(id || "").replace(/^sha256:/, "").slice(0, 12);
}

function diskPct(stats) {
  if (!stats || !stats.diskTotal || stats.diskUsed == null) return null;
  return Math.round((stats.diskUsed / stats.diskTotal) * 1000) / 10;
}

// One read per host (never a per-container SSH loop): the expected image id
// plus every farm-bot container's image id and state.
async function buildScanHost(host, now) {
  if (host.runtime === "native") return; // no docker images to compare
  const script =
    "echo \"EXPECTED $(docker image inspect -f '{{.Id}}' " +
    hosts.shq(FARM_IMAGE) +
    ' 2>/dev/null)"; ' +
    "ids=$(docker ps -aq --filter name=twitchbot); " +
    '[ -n "$ids" ] && docker inspect -f ' +
    "'{{.Name}}|{{.Image}}|{{.State.Status}}' $ids; true";
  let out;
  try {
    out = (await hosts.runShell(host, script, { timeout: 60000 })).stdout || "";
  } catch {
    return; // host unreachable — not a build signal
  }
  const lines = out.split("\n");
  const expLine = lines.find((l) => l.startsWith("EXPECTED")) || "";
  const expectedId = expLine.replace(/^EXPECTED\s*/, "").trim();
  const rows = parseBotImages(
    lines.filter((l) => !l.startsWith("EXPECTED")).join("\n"),
  );
  const missingImage = !expectedId && rows.some((r) => isFarmBot(r.name));
  const stale = staleBuilds(rows, expectedId);
  const signature =
    (missingImage ? "MISSING;" : "") +
    stale.map((s) => s.name + (s.running ? "*" : "")).join(",");

  const prev = buildTracked.get(host.id) || { signature: "", lastAlertAt: 0 };
  const entry = {
    signature,
    lastAlertAt: prev.lastAlertAt,
    stale,
    missingImage,
    expectedId,
    // Last id the farm tag was seen on here; outlives the tag being removed.
    lastFarmId: expectedId || prev.lastFarmId || "",
    label: host.label,
    checkedAt: now,
  };
  buildTracked.set(host.id, entry);

  if (!signature) {
    if (prev.signature) {
      await sendTelegram(
        "✅ " + host.label + ": every farm bot is on the current " + FARM_IMAGE + " build again.",
      ).catch(() => {});
    }
    return;
  }
  // Re-alert when the set of stale bots changes, else only as a reminder.
  if (signature === prev.signature && now - prev.lastAlertAt < REMINDER_MS) return;
  entry.lastAlertAt = now;

  const running = stale.filter((s) => s.running).map((s) => s.name);
  const parked = stale.filter((s) => !s.running).map((s) => s.name);
  const parts = [];
  let fix =
    "Fix: the Bots page rollout recreates running AND parked bots; for one " +
    "bot, docker compose up -d --force-recreate <bot>.";
  if (missingImage) {
    // 2026-09-23: a hand-run `docker rmi` took the tag off the server while
    // its 16 bots kept running the image under another name. Recreating a bot
    // cannot fix that (compose would try to pull the tag from Docker Hub), and
    // a rollout is a rebuild; putting the tag back is one command. Advise it
    // only with proof the bots' image IS a farm build — the tag's own id here
    // before it vanished, or another host's farm tag — never a stale pull.
    const id = sharedImageId(rows);
    let proof = "";
    if (id && prev.lastFarmId === id) {
      proof = "the build " + FARM_IMAGE + " pointed at before it disappeared";
    } else if (id) {
      for (const [hostId, e] of buildTracked) {
        if (hostId !== host.id && e.expectedId === id) {
          proof = "the same build as " + FARM_IMAGE + " on " + e.label;
          break;
        }
      }
    }
    if (proof) {
      const n = rows.filter((r) => isFarmBot(r.name)).length;
      parts.push(
        "the " +
          FARM_IMAGE +
          " tag is gone, but all " +
          n +
          " farm bots here still run " +
          shortImageId(id) +
          " (" +
          proof +
          "), so nothing is down — only a farm bot created or recreated here " +
          "would fail to start",
      );
      fix = "Fix, no restart needed: docker tag " + shortImageId(id) + " " + FARM_IMAGE;
    } else {
      parts.push(
        "no local " +
          FARM_IMAGE +
          " image — any farm bot created or recreated here will fail to start",
      );
      fix = "Fix: build it with the Bots page rollout, which recreates running AND parked bots.";
    }
  }
  if (running.length) {
    parts.push(running.length + " RUNNING on an older build: " + running.join(", "));
  }
  if (parked.length) {
    parts.push(
      parked.length + " parked on an older build (they wake broken): " + parked.join(", "),
    );
  }
  logEvent({
    category: "bots",
    action: "stale_build",
    actor: "healthMonitor",
    severity: running.length || missingImage ? "error" : "warn",
    host: host.id,
    detail: parts.join("; "),
  });
  await sendTelegram("🧱 " + host.label + ": " + parts.join(". ") + ". " + fix).catch(() => {});
}

async function diskCheckHost(host, now) {
  let stats;
  try {
    stats = await hosts.hostStats(host);
  } catch {
    return; // host unreachable — not a disk signal
  }
  const pct = diskPct(stats);
  if (pct == null) return;
  const prev = diskTracked.get(host.id) || { alerting: false, lastAlertAt: 0 };
  const entry = {
    pct,
    alerting: pct >= DISK_ALERT_PCT,
    lastAlertAt: prev.lastAlertAt,
    checkedAt: now,
  };
  diskTracked.set(host.id, entry);
  if (!entry.alerting) {
    if (prev.alerting) {
      await sendTelegram("✅ " + host.label + " disk is back to " + pct + "% used.").catch(() => {});
    }
    return;
  }
  if (prev.alerting && now - prev.lastAlertAt < REMINDER_MS) return;
  entry.lastAlertAt = now;
  logEvent({
    category: "bots",
    action: "disk_full",
    actor: "healthMonitor",
    severity: pct >= 95 ? "error" : "warn",
    host: host.id,
    detail: pct + "% used (" + host.dir + ")",
  });
  await sendTelegram(
    "💾 " +
      host.label +
      " disk is " +
      pct +
      "% full (" +
      host.dir +
      "). At 100% every bot on this host loses the ability to write and " +
      "farming stops. Usual cause is a runaway container log; find it with: " +
      "sudo du -ah /var/lib/docker/containers | sort -rh | head",
  ).catch(() => {});
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
    // Stale-build + disk pass: hourly, one cheap read per host. These catch
    // the two silent failures that stopped rent/auto farming for days in
    // 2026-09 (an old image that no longer accrues progress, and a host disk
    // at 100%) — both look like "bot is up, just not farming" otherwise.
    if (BUILD_ENABLED && now - state.lastBuildScanAt >= BUILD_INTERVAL_MS) {
      state.lastBuildScanAt = now;
      for (const h of hosts.listHosts()) {
        const host = hosts.resolveHost(h.id);
        try {
          await buildScanHost(host, now);
          await diskCheckHost(host, now);
        } catch (e) {
          state.lastError = e.message || String(e);
        }
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
    build: {
      enabled: BUILD_ENABLED,
      image: FARM_IMAGE,
      intervalMs: BUILD_INTERVAL_MS,
      lastScanAt: state.lastBuildScanAt
        ? new Date(state.lastBuildScanAt).toISOString()
        : null,
      hosts: Array.from(buildTracked.entries()).map(([id, v]) => ({
        host: id,
        missingImage: !!v.missingImage,
        stale: v.stale || [],
      })),
    },
    disk: {
      alertPct: DISK_ALERT_PCT,
      hosts: Array.from(diskTracked.entries()).map(([id, v]) => ({
        host: id,
        pct: v.pct,
        alerting: !!v.alerting,
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
  isOldBuildLog,
  isFarmBot,
  parseBotImages,
  staleBuilds,
  sharedImageId,
  shortImageId,
  diskPct,
  // Orchestration entrypoints exposed for integration tests (each drives one
  // scan of a host against an injectable `hosts` layer).
  decayScanHost,
  buildScanHost,
  diskCheckHost,
};
