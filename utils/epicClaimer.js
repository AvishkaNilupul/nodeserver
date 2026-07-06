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
const { decrypt, encrypt } = require("./secretBox");
const { sendTelegram } = require("./telegram");

const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { accounts: 0, synced: 0, needsLogin: 0, pendingClaims: 0 },
};

// account+offer pairs already pinged this pass-cycle, so one live giveaway
// doesn't ping the same account every 6h forever. Re-pings after 3 days.
const PING_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const pinged = new Map();

async function refreshAccountToken(acc) {
  const tok = await epic.refresh(decrypt(acc.refreshToken));
  acc.refreshToken = encrypt(tok.refresh_token);
  acc.refreshExpiresAt = tok.refresh_expires_at
    ? new Date(tok.refresh_expires_at)
    : null;
  acc.displayName = tok.displayName || acc.displayName;
  return tok.access_token;
}

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
  let link = freebie.url;
  try {
    const code = await epic.exchangeCode(accessToken);
    link = epic.claimLink(code, freebie.namespace, freebie.offerId);
  } catch {
    // fall back to the plain store link if the exchange code fails
  }
  await sendTelegram(
    "🎁 Epic claim needed — " +
      freebie.title +
      (freebie.originalPrice ? " (worth " + freebie.originalPrice + ")" : "") +
      "\nAccount: " +
      (acc.label || acc.displayName || acc.accountId) +
      "\nTap within 5 min (logs into the account and opens checkout):\n" +
      link,
  );
  pinged.set(key, Date.now());
  return true;
}

// Sync one account and return the live freebies it still needs.
async function processAccount(acc, liveFreebies, notify, priceByNamespace) {
  try {
    const accessToken = await refreshAccountToken(acc);
    await syncLibrary(acc, accessToken, priceByNamespace);
    acc.status = "ok";
    acc.lastError = "";
    const missing = liveFreebies.filter((f) => !ownsOffer(acc, f));
    if (notify && !acc.sold) {
      for (const f of missing) await pingClaim(acc, f, accessToken);
    }
    return missing.length;
  } catch (err) {
    acc.lastError = err.message || String(err);
    if (err.epicCode && String(err.epicCode).indexOf("invalid_grant") !== -1) {
      acc.status = "needs_login";
    } else if (String(err.message || "").match(/refresh|expired|grant/i)) {
      acc.status = "needs_login";
    }
    return 0;
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
      upcoming: false,
    }).lean();
    const allFreebies = await EpicFreebie.find({}).lean();
    const priceByNamespace = new Map(
      allFreebies
        .filter((f) => f.namespace)
        .map((f) => [f.namespace, parsePrice(f.originalPrice)]),
    );
    let synced = 0;
    let needsLogin = 0;
    let pendingClaims = 0;
    for (const acc of accounts) {
      const missing = await processAccount(
        acc,
        liveFreebies,
        notify,
        priceByNamespace,
      );
      if (acc.status === "needs_login") needsLogin++;
      else synced++;
      pendingClaims += missing;
    }
    if (needsLogin > 0 && notify) {
      await sendTelegram(
        "⚠️ Epic accounts: " +
          needsLogin +
          " account(s) need a fresh login code — open the Epic accounts tab.",
      ).catch(() => {});
    }
    state.lastCounts = {
      accounts: accounts.length,
      synced,
      needsLogin,
      pendingClaims,
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
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    intervalHours: TICK_MS / 3600000,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("epicClaimer error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, 70000);
  if (t.unref) t.unref();
}

module.exports = { start, runOnce, status };
