// Background, rate-limit-safe scanner for the Drops Archive.
//
// Design goals:
//  - Never burst Twitch's API. Each worker scans ONE account per tick with a
//    delay (plus jitter) between ticks, so hundreds of accounts are spread
//    across the day instead of fired all at once (which risks an IP block).
//  - Each account is re-scanned roughly once per `perAccountMs` (default 24h).
//    On each scan we upsert drops: new ones are inserted, known ones refresh
//    their lastSeenAt/state. Nothing is ever deleted, so the archive outlives
//    Twitch's ~6-month inventory window.
//  - Expose live progress for a global progress bar in the UI.
//
// The scanning is SPLIT ACROSS MACHINES. The server always runs one worker; in
// addition, each configured remote bot host (a Raspberry Pi, …) runs its own
// worker that makes the very same Twitch calls *from that host* over SSH + curl
// (see utils/twitchInventory.js's host transport). All workers share one due-
// account rotation and one priority queue, claiming accounts through an in-
// flight set so the same account is never scanned on two machines at once. The
// net effect: the archive is swept faster AND the Twitch traffic is spread over
// several IPs instead of hammering everything from the server's one address.
// Each worker keeps the same per-tick delay, so the per-IP request rate is
// unchanged — only the aggregate throughput rises.
//
// A remote host can vanish at any instant (a Pi gets unplugged, drops off
// Wi-Fi), so that's treated as normal, never an error:
//   - a "couldn't reach Twitch through this host" failure (.transportFailed)
//     leaves the account completely untouched — it stays due and the server
//     worker scans it on its next rotation, so no drop data is lost and no
//     account is falsely marked errored/token-invalid;
//   - the worker whose host just died marks itself down and backs off, re-
//     probing on a slow timer instead of hammering a dead host, and rejoins
//     automatically once the host answers again.
// The server worker alone always drains the whole rotation, so losing every
// remote host only makes scanning slower — never wrong, never stuck.
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const botHosts = require("./botHosts");
const { fetchInventory } = require("./twitchInventory");
const { cacheImage } = require("./imageCache");
const { stopFarmingGame } = require("./farmControl");

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a worker whose host just went unreachable waits before re-probing.
const HOST_DOWN_BACKOFF_MS =
  Number(process.env.DROP_SCAN_HOST_BACKOFF_MS) || 60000;

const state = {
  enabled: process.env.DROP_SCAN_DISABLED !== "1",
  // Delay between consecutive account scans (per worker).
  intervalMs: Number(process.env.DROP_SCAN_INTERVAL_MS) || 20000,
  // Re-scan an account at most once per this window.
  perAccountMs: Number(process.env.DROP_SCAN_PER_ACCOUNT_MS) || DAY_MS,
  lastTickAt: null,
  lastError: "",
  startedAt: Date.now(),
  // Session counters (since process start), summed across all workers.
  sessionScanned: 0,
  sessionNewDrops: 0,
  sessionErrors: 0,
};

let started = false;

// Accounts currently being scanned by SOME worker, by string id. This is what
// keeps two workers (server + Pi) from grabbing the same account: a worker only
// claims an id that isn't already here, and the due-account query excludes them.
const inFlight = new Set();

const LOCAL_HOST = { id: "local", label: "Server", transport: "local" };

// One worker per machine. Built in start(); each has its own timer + counters.
let workers = [];
function makeWorker(host) {
  return {
    host,
    timer: null,
    scanning: false,
    currentLogin: null,
    // Remote hosts start "down" so their first act is a reachability probe
    // rather than a doomed scan attempt; the server is always up.
    up: host.transport === "local",
    lastError: "",
    scanned: 0,
    newDrops: 0,
    errors: 0,
  };
}

// Priority queue for on-demand "scan this set" requests. Queued accounts jump
// ahead of the daily rotation and are scanned back-to-back with a short delay,
// so a whole bot set can be refreshed in minutes instead of a day. Shared by
// every worker, so a set scan is split across machines too.
const PRIORITY_DELAY_MS = 5000;
let priorityQueue = [];
let priorityTotal = 0;
let priorityLabel = "";

async function queueSetScan(filter, label) {
  const rows = await BotAccount.find(filter).select("_id").lean();
  const have = new Set(priorityQueue);
  let added = 0;
  for (const r of rows) {
    const id = String(r._id);
    if (!have.has(id)) {
      priorityQueue.push(id);
      added++;
    }
  }
  if (added) {
    priorityTotal += added;
    priorityLabel = label || priorityLabel;
    // Nudge every idle worker to pick up the queue promptly.
    for (const w of workers) scheduleWorker(w, 500);
  }
  return { queued: added, pending: priorityQueue.length };
}

function jitter(ms) {
  // +/- 30% so the cadence isn't perfectly periodic.
  const f = 0.7 + Math.random() * 0.6;
  return Math.round(ms * f);
}

function maskedLogin(acc) {
  return acc.login || (acc.clientSecret ? acc.clientSecret.slice(0, 6) : "");
}

// Which remote hosts help the server scan. Defaults to every configured remote
// host; a host that's offline is skipped at run time and one that lacks curl
// simply transport-fails and backs off, so the default is safe. Override with
// DROP_SCAN_HOSTS: a comma-separated list of host ids, or "none"/"off"/"local"
// to keep all scanning on the server.
function resolveScanHosts() {
  const raw = (process.env.DROP_SCAN_HOSTS || "").trim();
  if (/^(none|off|local)$/i.test(raw)) return [];
  const remoteIds = botHosts
    .listHosts()
    .map((h) => h.id)
    .filter((id) => id !== "local");
  let ids = remoteIds;
  if (raw) {
    const want = new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    ids = remoteIds.filter((id) => want.has(id.toLowerCase()));
  }
  return ids.map((id) => botHosts.resolveHost(id)).filter(Boolean);
}

// Cheap "is this host up right now" probe, used to recover a host that went
// down without committing an account to it first.
async function hostReachable(host) {
  try {
    await botHosts.runShell(host, "true", { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Pick the single most-stale account that is due for a scan and isn't already
// being scanned by another worker.
async function nextDueAccount() {
  const cutoff = new Date(Date.now() - state.perAccountMs);
  return BotAccount.findOne({
    $or: [{ lastScanAt: null }, { lastScanAt: { $lte: cutoff } }],
    _id: { $nin: [...inFlight] },
  })
    .sort({ lastScanAt: 1 }) // nulls sort first
    .exec();
}

// Claim the next account for a worker: priority queue first, then the daily
// rotation. Claiming (adding to inFlight) happens synchronously right after the
// DB read with no await in between, so two interleaving workers can never end
// up owning the same id. Returns { acc, fromQueue } or null when nothing's due.
async function claimNext() {
  // Priority (set) scans — even while the daily scheduler is paused.
  while (priorityQueue.length) {
    const id = priorityQueue.shift();
    if (inFlight.has(id)) continue; // another worker already has it
    const acc = await BotAccount.findById(id);
    if (!acc) continue;
    const sid = String(acc._id);
    if (inFlight.has(sid)) continue; // claimed during the await
    inFlight.add(sid);
    return { acc, fromQueue: true };
  }
  if (!state.enabled) return null;
  // Daily rotation. A couple of retries absorb the rare case where two workers
  // read the same "most stale" account before either claimed it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const acc = await nextDueAccount();
    if (!acc) return null;
    const sid = String(acc._id);
    if (inFlight.has(sid)) continue; // lost the race; nextDueAccount now skips it
    inFlight.add(sid);
    return { acc, fromQueue: false };
  }
  return null;
}

// Upserts one account's inventory drops into the archive. Shared by the
// BotAccount scan loop below and the account-pool checks (utils/
// accountPoolChecker.js, routes/accountPoolRoutes.js's manual check) — a
// pool account's `accountModel` is "AvailableAccount" so it never gets
// counted as deployed/sellable stock by the drops-archive aggregates, but it
// still shows up there as a distinct, clearly-labelled "in pool" entry.
async function upsertDrops(accountId, accountModel, login, drops) {
  const now = new Date();
  let newDrops = 0;
  for (const d of drops) {
    // Cache the image locally (deduped on disk; a no-op once downloaded) so
    // the archive doesn't depend on Twitch's CDN long-term.
    const imageLocal = d.imageURL ? await cacheImage(d.imageURL) : "";
    const set = {
      login: login || "",
      accountModel,
      dropId: d.dropId,
      name: d.name,
      imageURL: d.imageURL,
      game: d.game,
      gameId: d.gameId,
      campaign: d.campaign || "",
      itemKey: d.itemKey || "",
      count: d.count,
      awardedAt: d.awardedAt,
      connected: d.connected,
      requiredAccountLink: d.requiredAccountLink,
      state: d.state,
      source: d.source,
      lastSeenAt: now,
    };
    if (imageLocal) set.imageLocal = imageLocal;
    const r = await DropLog.updateOne(
      { account: accountId, benefitId: d.benefitId },
      { $set: set, $setOnInsert: { firstSeenAt: now } },
      { upsert: true },
    );
    if (r.upsertedCount) newDrops++;
  }
  return newDrops;
}

// Scan a single account doc: fetch inventory (optionally through `worker`'s
// remote host), upsert its drops, update status. A .transportFailed error (the
// host went away) propagates out WITHOUT touching the account — the caller
// leaves it due and backs the worker off. Every other outcome, including a real
// Twitch rejection, is recorded on the row exactly as the single-machine path
// always did.
async function scanAccount(acc, worker) {
  const host = worker.host.transport === "local" ? null : worker.host;
  const now = new Date();
  let inv;
  try {
    inv = await fetchInventory(acc.clientSecret, { host });
  } catch (e) {
    if (e.transportFailed) throw e; // leave account untouched; worker backs off
    acc.lastScanAt = now;
    acc.lastScanStatus = e.code === "token_invalid" ? "token_invalid" : "error";
    acc.lastScanError = (e.message || String(e)).slice(0, 300);
    await acc.save();
    worker.errors++;
    state.sessionErrors++;
    state.lastError = acc.lastScanError;
    return { ok: false, error: acc.lastScanError };
  }

  const { twitchId, login, drops } = inv;
  const newDrops = await upsertDrops(
    acc._id,
    "BotAccount",
    login || acc.login || "",
    drops,
  );
  if (twitchId) acc.twitchId = twitchId;
  if (login && !acc.login) acc.login = login;
  // A sold account whose buyer has connected a game shouldn't keep farming
  // that game. Remove it from the account's bot-config FavouriteGames (the
  // account keeps farming its other games); best-effort, never fails a scan.
  if (acc.soldAt) {
    const connectedGames = [
      ...new Set(drops.filter((d) => d.connected && d.game).map((d) => d.game)),
    ];
    for (const game of connectedGames) {
      try {
        const r = await stopFarmingGame(acc, game);
        if (r.changed) {
          console.log(
            `dropScanner: stopped farming "${game}" on sold account ` +
              `${maskedLogin(acc)}${r.reason ? " (" + r.reason + ")" : ""}`,
          );
        }
      } catch (e) {
        console.error(
          `dropScanner: stop-farming "${game}" on ${maskedLogin(acc)} ` +
            `failed: ${e.message}`,
        );
      }
    }
  }
  acc.dropCount = await DropLog.countDocuments({ account: acc._id });
  acc.lastScanAt = now;
  acc.lastScanStatus = "ok";
  acc.lastScanError = "";
  await acc.save();
  worker.newDrops += newDrops;
  state.sessionNewDrops += newDrops;
  return { ok: true, newDrops, total: acc.dropCount };
}

// The always-present server worker, so manual "Scan now" has a home.
function localWorker() {
  return workers.find((w) => w.host.transport === "local");
}

// Force-scan one account immediately (used by the "Scan now" button), on the
// server. Runs outside the pacing loop but still serialised against the server
// worker and guarded by the in-flight set so it can't race a background scan of
// the same account.
async function scanAccountNow(id) {
  const sid = String(id);
  const w = localWorker();
  if (w && w.scanning) {
    return { ok: false, error: "A scan is already in progress" };
  }
  if (inFlight.has(sid)) {
    return { ok: false, error: "This account is already being scanned" };
  }
  const acc = await BotAccount.findById(id);
  if (!acc) return { ok: false, error: "Account not found" };
  inFlight.add(sid);
  if (w) {
    w.scanning = true;
    w.currentLogin = maskedLogin(acc);
  }
  try {
    const res = await scanAccount(acc, w || makeWorker(LOCAL_HOST));
    state.sessionScanned++;
    if (w) w.scanned++;
    return res;
  } finally {
    inFlight.delete(sid);
    if (w) {
      w.scanning = false;
      w.currentLogin = null;
    }
  }
}

async function tickWorker(worker) {
  const remote = worker.host.transport !== "local";
  // Idle when disabled and nothing queued.
  if (!state.enabled && !priorityQueue.length) {
    scheduleWorker(worker, state.intervalMs);
    return;
  }
  // A downed remote host: probe on the slow timer; only rejoin once it answers.
  if (remote && !worker.up) {
    if (await hostReachable(worker.host)) {
      worker.up = true;
      worker.lastError = "";
    } else {
      scheduleWorker(worker, HOST_DOWN_BACKOFF_MS);
      return;
    }
  }
  // Don't overlap this worker's own scans.
  if (worker.scanning) {
    scheduleWorker(worker, jitter(state.intervalMs));
    return;
  }

  let claim = null;
  try {
    claim = await claimNext();
  } catch (e) {
    state.lastError = e.message || String(e);
  }
  if (!claim) {
    // Nothing due — idle a bit before checking again.
    scheduleWorker(worker, Math.max(state.intervalMs, 60000));
    return;
  }

  const { acc, fromQueue } = claim;
  const sid = String(acc._id);
  worker.scanning = true;
  worker.currentLogin = maskedLogin(acc);
  state.lastTickAt = new Date();
  let transportDied = false;
  try {
    await scanAccount(acc, worker);
    worker.scanned++;
    state.sessionScanned++;
  } catch (e) {
    if (e && e.transportFailed) {
      // Host vanished mid-scan. Leave the account due (already untouched) for
      // the server worker, mark this host down, and back off.
      transportDied = true;
      worker.up = false;
      worker.lastError = e.message || String(e);
      console.warn(
        "dropScanner: scan host " +
          (worker.host.label || worker.host.id) +
          " unreachable, backing off; account stays due for the server",
      );
    } else {
      state.lastError = e.message || String(e);
    }
  } finally {
    inFlight.delete(sid);
    worker.scanning = false;
    worker.currentLogin = null;
  }
  if (!priorityQueue.length) {
    priorityTotal = 0;
    priorityLabel = "";
  }
  const delay = transportDied
    ? HOST_DOWN_BACKOFF_MS
    : fromQueue && priorityQueue.length
      ? jitter(PRIORITY_DELAY_MS)
      : jitter(state.intervalMs);
  scheduleWorker(worker, delay);
}

function scheduleWorker(worker, ms) {
  clearTimeout(worker.timer);
  worker.timer = setTimeout(() => tickWorker(worker), ms);
}

// One-time backfill: older rows were logged before itemKey/imageLocal existed.
// Compute itemKey (name|game, lowercased+trimmed) for any drop missing it so
// the aggregate views group correctly instead of merging into one item.
async function backfillItemKeys() {
  try {
    // Use the native driver so the aggregation-pipeline update is accepted.
    const r = await DropLog.collection.updateMany(
      { $or: [{ itemKey: "" }, { itemKey: { $exists: false } }] },
      [
        {
          $set: {
            itemKey: {
              $concat: [
                { $toLower: { $trim: { input: { $ifNull: ["$name", ""] } } } },
                "|",
                { $toLower: { $trim: { input: { $ifNull: ["$game", ""] } } } },
              ],
            },
          },
        },
      ],
    );
    if (r.modifiedCount) {
      console.log(
        "dropScanner: backfilled itemKey on",
        r.modifiedCount,
        "drops",
      );
    }
    return r.modifiedCount || 0;
  } catch (e) {
    console.error("dropScanner backfill error:", e.message);
    return 0;
  }
}

function start() {
  if (started) return;
  started = true;
  backfillItemKeys();
  workers = [makeWorker(LOCAL_HOST), ...resolveScanHosts().map(makeWorker)];
  // Stagger startups so the workers don't tick in lockstep (which would make
  // them race for the same "most stale" account every time). Small delay so it
  // doesn't compete with boot.
  workers.forEach((w, i) => scheduleWorker(w, 5000 + i * 2500));
}

// Live snapshot for the UI progress bar.
async function getProgress() {
  const now = Date.now();
  const cutoff = new Date(now - state.perAccountMs);
  const [total, scannedWindow, due, ok, tokenInvalid, errored, totalDrops] =
    await Promise.all([
      BotAccount.countDocuments({}),
      BotAccount.countDocuments({ lastScanAt: { $gt: cutoff } }),
      BotAccount.countDocuments({
        $or: [{ lastScanAt: null }, { lastScanAt: { $lte: cutoff } }],
      }),
      BotAccount.countDocuments({ lastScanStatus: "ok" }),
      BotAccount.countDocuments({ lastScanStatus: "token_invalid" }),
      BotAccount.countDocuments({ lastScanStatus: "error" }),
      DropLog.countDocuments({}),
    ]);
  const anyScanning = workers.some((w) => w.scanning);
  const firstScanning = workers.find((w) => w.scanning);
  return {
    enabled: state.enabled,
    scanning: anyScanning,
    // Kept for backward compat with the old single-worker UI; the per-host
    // breakdown below is what shows the split.
    currentLogin: firstScanning ? firstScanning.currentLogin : null,
    intervalMs: state.intervalMs,
    perAccountMs: state.perAccountMs,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    counts: {
      total,
      scannedWindow,
      due,
      ok,
      tokenInvalid,
      error: errored,
      totalDrops,
    },
    session: {
      scanned: state.sessionScanned,
      newDrops: state.sessionNewDrops,
      errors: state.sessionErrors,
      startedAt: state.startedAt,
    },
    queue: {
      pending: priorityQueue.length,
      total: priorityTotal,
      label: priorityLabel,
    },
    // Per-machine split, so the UI can show what each host is doing.
    hosts: workers.map((w) => ({
      id: w.host.id,
      label: w.host.label,
      transport: w.host.transport,
      scanning: w.scanning,
      currentLogin: w.currentLogin,
      up: w.up,
      scanned: w.scanned,
      newDrops: w.newDrops,
      errors: w.errors,
    })),
  };
}

function setEnabled(v) {
  state.enabled = !!v;
  if (state.enabled) for (const w of workers) scheduleWorker(w, 1000);
  return state.enabled;
}

function setIntervalMs(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 2000 && n <= 3600000) {
    state.intervalMs = Math.round(n);
  }
  return state.intervalMs;
}

module.exports = {
  start,
  getProgress,
  scanAccountNow,
  queueSetScan,
  setEnabled,
  setIntervalMs,
  backfillItemKeys,
  upsertDrops,
};
