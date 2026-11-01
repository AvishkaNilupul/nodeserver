// Epic auto-claim orchestrator.
//
// Every run (and whenever the Epic watcher sees a giveaway go live) it:
//   1. refreshes each stock account's token (stored refresh tokens last ~1yr;
//      an account that can't refresh is flagged "needs_login"),
//   2. re-syncs the account's library (owned games, titles, retail value),
//   3. finds live free games the account doesn't own yet, and
//   4. sends ONE Telegram message per account+game with a one-tap login link
//      that opens that game's checkout signed in as that account — Epic's
//      captcha makes a blind headless "purchase" unsafe, so the final click
//      stays with the operator. Once the game shows up in the account's
//      library the claim is marked done automatically.
const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const epic = require("./epicClient");
const epicAutoClaim = require("./epicAutoClaim");
const { accountAccessToken } = require("./epicAccountToken");
const { sendTelegram } = require("./telegram");
const rateBackoff = require("./epicClaimBackoff");
const region = require("./epicRegion");

const {live} = require("./epicOfferWindow");

const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours
// After an Epic HTTP 429 pause, run again this long after it lifts instead of
// waiting out the rest of the 6-hour tick (a restart during the pause used to
// push the next try up to 6 h past its end).
const AFTER_PAUSE_MS = 2 * 60 * 1000;
// While the Mac can't take claims (screen locked, Chrome helper not checking
// in, bridge busy or unreachable) it is asked again this often. 2026-11-01:
// a locked Mac turned a whole 6-hour tick into 29 refused claims.
const MAC_RETRY_MS = 15 * 60 * 1000;
const MAC_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
const MAC_DOWN = new Set(["worker_unavailable", "busy"]);

const state = {
  started: false,
  running: false,
  lastRun: null,
  nextRunAt: null,
  lastError: "",
  lastCounts: { accounts: 0, synced: 0, needsLogin: 0, pendingClaims: 0, regionLocked: 0 },
  // { since, reason, status, checkedAt } while the Mac can't take claims.
  macDown: null,
  macAlertAt: 0,
};

// Outcomes where a Telegram "claim needed" ping can't help: the giveaway is
// region-locked for this account, Epic's 429 pause also blocks manual
// claims and the claimer resumes on its own once it lifts, or the Mac can't
// take claims (one "waiting for the Mac" message covers every account).
const NO_PING = new Set(["region_blocked", region.REFUSED, "rate_limited", "spacing", ...MAC_DOWN]);

// The claim module answers "spacing" while the gap between two Epic
// checkouts runs; a scheduled run waits it out and tries the same game again.
const MAX_SPACING_WAITS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function claimSpaced(acc, freebie, accessToken, opts) {
  let auto;
  for (let waits = 0; ; waits++) {
    auto = await epicAutoClaim.attemptAutoClaim(acc, freebie, accessToken, opts);
    if (auto.status !== "spacing" || waits >= MAX_SPACING_WAITS) return auto;
    const until = new Date(auto.retryAt).getTime();
    await wait(Math.max(1000, (Number.isFinite(until) ? until : 0) - Date.now() + 1000));
    accessToken = await accountAccessToken(acc);
  }
}

function nextDelay(now = Date.now()) {
  const pausedUntil = rateBackoff.until();
  if (pausedUntil) return Math.min(TICK_MS, Math.max(60000, pausedUntil - now + AFTER_PAUSE_MS));
  return state.macDown ? MAC_RETRY_MS : TICK_MS;
}

// One message per Mac outage (repeated at most every 6 h), not one per account.
async function alertMacDown(pending) {
  if (state.macDown.quiet || Date.now() - state.macAlertAt < MAC_ALERT_EVERY_MS) return;
  state.macAlertAt = Date.now();
  await sendTelegram(
    "⏸ Epic claims are waiting for the Mac: " + state.macDown.reason +
      "\n" + pending + " claim(s) pending. They start on their own within 15 min once the Mac is ready.",
  );
}

// Before a run while the Mac was down: ask it (one local HTTP call) instead of
// re-syncing every account. True when it still can't take claims.
async function macStillDown() {
  if (!state.macDown || rateBackoff.until() || typeof epicAutoClaim.workerReady !== "function") return false;
  const probe = await epicAutoClaim.workerReady();
  state.macDown.checkedAt = new Date();
  if (probe.ready) return false;
  if (probe.reason) state.macDown.reason = probe.reason;
  return true;
}

// account+offer pairs already pinged this pass-cycle, so one live giveaway
// doesn't ping the same account every 6h forever. Re-pings after 3 days.
const PING_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const pinged = new Map();


function parsePrice(s) {
  const n = parseFloat(String(s || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

async function syncLibrary(acc, accessToken, priceByNamespace) {
  const records = await epic.getLibraryRecords(accessToken);
  const known = new Map(
    (acc.library || []).map((g) => [g.namespace + "|" + g.catalogItemId, g]),
  );
  const library = [];
  for (const r of records) {
    if (!r || !r.namespace || !r.catalogItemId) continue;
    const key = r.namespace + "|" + r.catalogItemId;
    const prev = known.get(key);
    if (prev && prev.title) {
      library.push(prev);
      continue;
    }
    const meta = await epic.resolveCatalogItem(
      r.namespace,
      r.catalogItemId,
      accessToken,
    );
    library.push({
      namespace: r.namespace,
      catalogItemId: r.catalogItemId,
      title: (meta && meta.title) || r.sandboxName || r.catalogItemId,
      developer: (meta && meta.developer) || "",
      // The catalog API exposes no price; the giveaway rows tracked by the
      // Epic watcher carry the retail price for anything claimed via them.
      priceUsd:
        (meta && meta.priceUsd) ||
        (priceByNamespace && priceByNamespace.get(r.namespace)) ||
        0,
      acquiredAt: r.acquisitionDate ? new Date(r.acquisitionDate) : new Date(),
    });
  }
  acc.library = library;
  acc.libraryCount = library.length;
  acc.libraryValueUsd =
    Math.round(library.reduce((s, g) => s + (g.priceUsd || 0), 0) * 100) / 100;
}

function ownsOffer(acc, freebie) {
  return (acc.library || []).some(
    (g) =>
      g.namespace === freebie.namespace ||
      (g.title &&
        freebie.title &&
        g.title.trim().toLowerCase() === freebie.title.trim().toLowerCase()),
  );
}

async function pingClaim(acc, freebie, accessToken) {
  const key = acc.accountId + "|" + freebie.offerId;
  const last = pinged.get(key);
  if (last && Date.now() - last < PING_COOLDOWN_MS) return false;
  // External shared browsers must not receive launcher-backed exchange links.
  const panelBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const link = panelBase ? panelBase + "/epic-accounts.html" : freebie.url;
  await sendTelegram(
    "🎁 Epic claim needed — " +
      freebie.title +
      (freebie.originalPrice ? " (worth " + freebie.originalPrice + ")" : "") +
      "\nAccount: " +
      (acc.label || acc.displayName || acc.accountId) +
      "\nUse Claim on the Epic accounts page (runs through the isolated Mac worker).\n" +
      link,
  );
  pinged.set(key, Date.now());
  return true;
}

// Sync one account and return { missing, regionLocked } counts for the live
// freebies it still needs. blocked is the fleet's offerId -> refused-countries
// map; a refusal seen here is added to it so later accounts skip that game.
// run is shared by one pass over the fleet: once the Mac can't take a claim
// (run.macDown), later accounts are only synced, not claimed.
async function processAccount(acc, liveFreebies, notify, priceByNamespace, blocked = new Map(), run = {}) {
  const counts = { missing: 0, regionLocked: 0 };
  try {
    let accessToken = await accountAccessToken(acc);
    await syncLibrary(acc, accessToken, priceByNamespace);
    acc.status = "ok";
    acc.lastError = "";
    const notOwned = liveFreebies.filter((f) => live(f) && !ownsOffer(acc, f));
    const missing = notOwned.filter((f) => !region.regionBlock(acc, f, blocked));
    counts.regionLocked = notOwned.length - missing.length;
    if (notify && !acc.sold) {
      for (const f of missing) {
        if (run.macDown) break;
        // Try the direct-API auto-claim first. If it succeeded — or if it
        // ran and got a definitive "already owned" — skip the Telegram tap
        // link for this offer. The library re-sync on the next tick will
        // confirm ownership landed. Only ping the operator when the auto
        // path is disabled, throttled, or actually failed.
        const auto = await claimSpaced(acc, f, accessToken, { blocked });
        if (MAC_DOWN.has(auto.status)) {
          // A claim this server is already running (Claim all, a manual
          // Claim) pauses the run too, but the owner needs no message for it.
          run.macDown = { status: auto.status, quiet: !!auto.local, reason: auto.error || (auto.status === "busy" ? "Mac is running another claim" : "Mac claim helper unavailable") };
          break;
        }
        if (auto.status === region.REFUSED) {
          region.noteRefusal(blocked, acc, f.offerId);
          counts.regionLocked++;
        }
        if (auto.status === "region_blocked") counts.regionLocked++;
        if (acc.status === "needs_login") break;
        accessToken = await accountAccessToken(acc);
        if (
          (auto.attempted && auto.status === "claimed") || auto.status === "already_owned"
        ) {
          continue;
        }
        if (NO_PING.has(auto.status)) continue;
        await pingClaim(acc, f, accessToken);
      }
    }
    counts.missing = Math.max(0, notOwned.length - counts.regionLocked);
    return counts;
  } catch (err) {
    acc.lastError = err.message || String(err);
    if (err.epicCode && String(err.epicCode).indexOf("invalid_grant") !== -1) {
      acc.status = "needs_login";
    }
    return counts;
  } finally {
    acc.lastCheckedAt = new Date();
    await acc.save().catch(() => {});
  }
}

async function runOnce(opts) {
  const notify = !opts || opts.notify !== false;
  if (state.running) return state.lastCounts;
  state.running = true;
  try {
    const accounts = await EpicAccount.find({});
    const liveFreebies = await EpicFreebie.find({
      active: true,
    }).lean();
    const allFreebies = await EpicFreebie.find({}).lean();
    const priceByNamespace = new Map(
      allFreebies
        .filter((f) => f.namespace)
        .map((f) => [f.namespace, parsePrice(f.originalPrice)]),
    );
    const blocked = region.blockedCountries(accounts);
    const run = {};
    let synced = 0;
    let needsLogin = 0;
    let pendingClaims = 0;
    let regionLocked = 0;
    for (const acc of accounts) {
      const counts = await processAccount(
        acc,
        liveFreebies,
        notify,
        priceByNamespace,
        blocked,
        run,
      );
      if (acc.status === "needs_login") needsLogin++;
      else synced++;
      pendingClaims += counts.missing;
      regionLocked += counts.regionLocked;
    }
    if (needsLogin > 0 && notify) {
      await sendTelegram(
        "⚠️ Epic accounts: " +
          needsLogin +
          " account(s) need a fresh login code — open the Epic accounts tab.",
      ).catch(() => {});
    }
    // Only a claiming run can tell whether the Mac is up again.
    if (notify) {
      if (run.macDown) {
        state.macDown = { since: state.macDown ? state.macDown.since : new Date(), ...run.macDown, checkedAt: new Date() };
        await alertMacDown(pendingClaims).catch(() => {});
      } else {
        state.macDown = null;
        state.macAlertAt = 0;
      }
    }
    state.lastCounts = {
      accounts: accounts.length,
      synced,
      needsLogin,
      pendingClaims,
      regionLocked,
    };
    state.lastError = "";
    return state.lastCounts;
  } catch (err) {
    state.lastError = err.message || String(err);
    throw err;
  } finally {
    state.lastRun = new Date();
    state.running = false;
  }
}

function status() {
  return {
    running: state.running,
    lastRun: state.lastRun,
    nextRunAt: state.nextRunAt,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    intervalHours: TICK_MS / 3600000,
    macDown: state.macDown,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const schedule = (delay) => {
    state.nextRunAt = new Date(Date.now() + delay);
    const t = setTimeout(tick, delay);
    if (t.unref) t.unref();
  };
  const tick = async () => {
    let delay = 0;
    try {
      if (await macStillDown()) delay = MAC_RETRY_MS;
      else await runOnce();
    } catch (err) {
      console.error("epicClaimer error:", err.message);
    }
    schedule(delay || nextDelay());
  };
  schedule(70000);
}

module.exports = { start, runOnce, status, syncLibrary, processAccount, nextDelay, macStillDown };
