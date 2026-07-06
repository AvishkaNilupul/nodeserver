// Background, rate-limit-safe scanner for the Drops Archive.
//
// Design goals:
//  - Never burst Twitch's API. We scan ONE account per tick with a delay (plus
//    jitter) between ticks, so hundreds of accounts are spread across the day
//    instead of fired all at once (which risks an IP block).
//  - Each account is re-scanned roughly once per `perAccountMs` (default 24h).
//    On each scan we upsert drops: new ones are inserted, known ones refresh
//    their lastSeenAt/state. Nothing is ever deleted, so the archive outlives
//    Twitch's ~6-month inventory window.
//  - Expose live progress for a global progress bar in the UI.
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const { fetchInventory } = require("./twitchInventory");
const { cacheImage } = require("./imageCache");
const { stopFarmingGame } = require("./farmControl");

const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  enabled: process.env.DROP_SCAN_DISABLED !== "1",
  // Delay between consecutive account scans.
  intervalMs: Number(process.env.DROP_SCAN_INTERVAL_MS) || 20000,
  // Re-scan an account at most once per this window.
  perAccountMs: Number(process.env.DROP_SCAN_PER_ACCOUNT_MS) || DAY_MS,
  scanning: false,
  currentLogin: null,
  lastTickAt: null,
  lastError: "",
  startedAt: Date.now(),
  // Session counters (since process start).
  sessionScanned: 0,
  sessionNewDrops: 0,
  sessionErrors: 0,
};

let timer = null;
let started = false;

// Priority queue for on-demand "scan this set" requests. Queued accounts
// jump ahead of the daily rotation and are scanned back-to-back with a short
// delay, so a whole bot set can be refreshed in minutes instead of a day.
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
    schedule(500);
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

// Pick the single most-stale account that is due for a scan.
async function nextDueAccount() {
  const cutoff = new Date(Date.now() - state.perAccountMs);
  return BotAccount.findOne({
    $or: [{ lastScanAt: null }, { lastScanAt: { $lte: cutoff } }],
  })
    .sort({ lastScanAt: 1 }) // nulls sort first
    .exec();
}

// Scan a single account doc: fetch inventory, upsert its drops, update status.
async function scanAccount(acc) {
  const now = new Date();
  try {
    const { twitchId, login, drops } = await fetchInventory(acc.clientSecret);
    let newDrops = 0;
    for (const d of drops) {
      // Cache the image locally (deduped on disk; a no-op once downloaded) so
      // the archive doesn't depend on Twitch's CDN long-term.
      const imageLocal = d.imageURL ? await cacheImage(d.imageURL) : "";
      const set = {
        login: login || acc.login || "",
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
        { account: acc._id, benefitId: d.benefitId },
        { $set: set, $setOnInsert: { firstSeenAt: now } },
        { upsert: true },
      );
      if (r.upsertedCount) newDrops++;
    }
    if (twitchId) acc.twitchId = twitchId;
    if (login && !acc.login) acc.login = login;
    // A sold account whose buyer has connected a game shouldn't keep farming
    // that game. Remove it from the account's bot-config FavouriteGames (the
    // account keeps farming its other games); best-effort, never fails a scan.
    if (acc.soldAt) {
      const connectedGames = [
        ...new Set(
          drops.filter((d) => d.connected && d.game).map((d) => d.game),
        ),
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
    state.sessionNewDrops += newDrops;
    return { ok: true, newDrops, total: acc.dropCount };
  } catch (e) {
    acc.lastScanAt = now;
    acc.lastScanStatus = e.code === "token_invalid" ? "token_invalid" : "error";
    acc.lastScanError = (e.message || String(e)).slice(0, 300);
    await acc.save();
    state.sessionErrors++;
    state.lastError = acc.lastScanError;
    return { ok: false, error: acc.lastScanError };
  }
}

// Force-scan one account immediately (used by the "Scan now" button). Runs
// outside the pacing loop but still serialised via the scanning flag.
async function scanAccountNow(id) {
  // Don't overlap with an in-flight scan (background tick or another manual
  // scan) — concurrent scans of the same account would race on its doc.
  if (state.scanning) {
    return { ok: false, error: "A scan is already in progress" };
  }
  const acc = await BotAccount.findById(id);
  if (!acc) return { ok: false, error: "Account not found" };
  state.scanning = true;
  state.currentLogin = maskedLogin(acc);
  try {
    const res = await scanAccount(acc);
    state.sessionScanned++;
    return res;
  } finally {
    state.scanning = false;
    state.currentLogin = null;
  }
}

async function tick() {
  // Priority (set) scans run even while the daily scheduler is paused.
  if (!state.enabled && !priorityQueue.length) {
    schedule(state.intervalMs);
    return;
  }
  state.lastTickAt = new Date();
  // A manual "Scan now" may be running; skip this tick rather than overlap.
  if (state.scanning) {
    schedule(jitter(state.intervalMs));
    return;
  }
  let fromQueue = false;
  try {
    let acc = null;
    while (priorityQueue.length && !acc) {
      acc = await BotAccount.findById(priorityQueue.shift());
    }
    if (acc) fromQueue = true;
    else if (state.enabled) acc = await nextDueAccount();
    if (!acc) {
      // Nothing due — idle a bit before checking again.
      schedule(Math.max(state.intervalMs, 60000));
      return;
    }
    state.scanning = true;
    state.currentLogin = maskedLogin(acc);
    await scanAccount(acc);
    state.sessionScanned++;
  } catch (e) {
    state.lastError = e.message || String(e);
  } finally {
    state.scanning = false;
    state.currentLogin = null;
  }
  if (!priorityQueue.length) {
    priorityTotal = 0;
    priorityLabel = "";
  }
  schedule(
    fromQueue && priorityQueue.length
      ? jitter(PRIORITY_DELAY_MS)
      : jitter(state.intervalMs),
  );
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
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
  // Small startup delay so it doesn't compete with boot.
  schedule(5000);
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
  return {
    enabled: state.enabled,
    scanning: state.scanning,
    currentLogin: state.currentLogin,
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
  };
}

function setEnabled(v) {
  state.enabled = !!v;
  if (state.enabled) schedule(1000);
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
};
