// Background, rate-limit-safe scanner for the RENTER drops inventory — the
// standalone counterpart to utils/dropScanner.js. It sweeps RenterAccount tokens
// and upserts their Twitch inventory into RenterDrop, and ONLY there: renter
// drops never touch the operator's DropLog / Drops Archive.
//
// Deliberately simpler than dropScanner: a single server-side worker (renter
// account counts are small, so there's no need for the multi-host split). It
// keeps the same pacing discipline — one account per tick with a delay + jitter
// — so it never bursts Twitch's API. Each account is re-scanned about once per
// `perAccountMs` (default 24h); nothing is ever deleted, so the inventory
// outlives Twitch's ~6-month window.
const RenterAccount = require("../models/RenterAccount");
const RenterDrop = require("../models/RenterDrop");
const { fetchInventory } = require("./twitchInventory");
const { cacheImage } = require("./imageCache");

const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  enabled: process.env.RENTER_DROP_SCAN_DISABLED !== "1",
  // Delay between consecutive account scans.
  intervalMs: Number(process.env.RENTER_DROP_SCAN_INTERVAL_MS) || 20000,
  // Re-scan an account at most once per this window.
  perAccountMs: Number(process.env.RENTER_DROP_SCAN_PER_ACCOUNT_MS) || DAY_MS,
  lastTickAt: null,
  lastError: "",
  startedAt: Date.now(),
  scanning: false,
  currentLogin: null,
  sessionScanned: 0,
  sessionNewDrops: 0,
  sessionErrors: 0,
};

let started = false;
let timer = null;

function jitter(ms) {
  const f = 0.7 + Math.random() * 0.6; // +/- 30%
  return Math.round(ms * f);
}

function maskedLogin(acc) {
  return acc.login || (acc.clientSecret ? acc.clientSecret.slice(0, 6) : "");
}

// Upsert one renter account's inventory drops into RenterDrop. Same upsert
// semantics as dropScanner.upsertDrops but keyed to the renter as well.
async function upsertDrops(accountId, renterId, login, drops) {
  const now = new Date();
  let newDrops = 0;
  for (const d of drops) {
    const imageLocal = d.imageURL ? await cacheImage(d.imageURL) : "";
    const set = {
      renter: renterId,
      login: login || "",
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
    const r = await RenterDrop.updateOne(
      { account: accountId, benefitId: d.benefitId },
      { $set: set, $setOnInsert: { firstSeenAt: now } },
      { upsert: true },
    );
    if (r.upsertedCount) newDrops++;
  }
  return newDrops;
}

// Scan a single RenterAccount doc: fetch inventory (always from the server —
// this scanner has no remote workers), upsert its drops, update status.
async function scanAccount(acc) {
  const now = new Date();
  let inv;
  try {
    inv = await fetchInventory(acc.clientSecret, { host: null });
  } catch (e) {
    if (e.transportFailed) throw e; // leave account untouched
    acc.lastScanAt = now;
    acc.lastScanStatus = e.code === "token_invalid" ? "token_invalid" : "error";
    acc.lastScanError = (e.message || String(e)).slice(0, 300);
    await acc.save();
    state.sessionErrors++;
    state.lastError = acc.lastScanError;
    return { ok: false, error: acc.lastScanError };
  }

  const { twitchId, login, drops } = inv;
  const newDrops = await upsertDrops(
    acc._id,
    acc.renter,
    login || acc.login || "",
    drops,
  );
  if (twitchId) acc.twitchId = twitchId;
  if (login && !acc.login) acc.login = login;
  // NOTE (rent program): renter accounts DELIBERATELY keep farming a game even
  // after its drops show as connected/redeemed on Twitch. That is the whole
  // point of the rental business — an account is rented for a fixed term and
  // must keep farming for the renter regardless of connection state. This is the
  // intentional counterpart to utils/dropScanner.js's sold-account block (its
  // `if (acc.soldAt)` -> stopFarmingGame call): the "connected => stop farming"
  // law applies ONLY to the operator's SOLD BotAccounts, never to renters.
  // Do NOT port that block here (no farmControl / stopFarmingGame on the renter
  // path) or rented accounts would stop farming the instant they're connected.
  acc.dropCount = await RenterDrop.countDocuments({ account: acc._id });
  acc.lastScanAt = now;
  acc.lastScanStatus = "ok";
  acc.lastScanError = "";
  await acc.save();
  state.sessionNewDrops += newDrops;
  return { ok: true, newDrops, total: acc.dropCount };
}

// Most-stale account that is due for a scan.
async function nextDueAccount() {
  const cutoff = new Date(Date.now() - state.perAccountMs);
  return RenterAccount.findOne({
    $or: [{ lastScanAt: null }, { lastScanAt: { $lte: cutoff } }],
  })
    .sort({ lastScanAt: 1 }) // nulls sort first
    .exec();
}

// Force-scan one renter account immediately (for a manual "scan now").
async function scanAccountNow(id) {
  if (state.scanning) return { ok: false, error: "A scan is already in progress" };
  const acc = await RenterAccount.findById(id);
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
  if (!state.enabled) {
    schedule(state.intervalMs);
    return;
  }
  if (state.scanning) {
    schedule(jitter(state.intervalMs));
    return;
  }
  let acc = null;
  try {
    acc = await nextDueAccount();
  } catch (e) {
    state.lastError = e.message || String(e);
  }
  if (!acc) {
    schedule(Math.max(state.intervalMs, 60000));
    return;
  }
  state.scanning = true;
  state.currentLogin = maskedLogin(acc);
  state.lastTickAt = new Date();
  try {
    await scanAccount(acc);
    state.sessionScanned++;
  } catch (e) {
    state.lastError = e.message || String(e);
  } finally {
    state.scanning = false;
    state.currentLogin = null;
  }
  schedule(jitter(state.intervalMs));
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

function start() {
  if (started) return;
  started = true;
  schedule(7000); // small offset from boot
}

async function getProgress() {
  const now = Date.now();
  const cutoff = new Date(now - state.perAccountMs);
  const [total, scannedWindow, due, ok, tokenInvalid, errored, totalDrops] =
    await Promise.all([
      RenterAccount.countDocuments({}),
      RenterAccount.countDocuments({ lastScanAt: { $gt: cutoff } }),
      RenterAccount.countDocuments({
        $or: [{ lastScanAt: null }, { lastScanAt: { $lte: cutoff } }],
      }),
      RenterAccount.countDocuments({ lastScanStatus: "ok" }),
      RenterAccount.countDocuments({ lastScanStatus: "token_invalid" }),
      RenterAccount.countDocuments({ lastScanStatus: "error" }),
      RenterDrop.countDocuments({}),
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
  };
}

function setEnabled(v) {
  state.enabled = !!v;
  if (state.enabled) schedule(1000);
  return state.enabled;
}

module.exports = {
  start,
  getProgress,
  scanAccountNow,
  setEnabled,
  upsertDrops,
};
