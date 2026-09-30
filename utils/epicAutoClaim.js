// Auto-claim orchestrator for Epic free games.
//
// Called by utils/epicClaimer for each (account, freebie) pair that the
// account doesn't own yet. Before falling back to the operator-tap Telegram
// link this module tries to complete the checkout headlessly against Epic's
// payment-website-pci endpoints via utils/epicClient.autoClaimFreebie. If
// Talon captcha fires, a configured 2Captcha / CapSolver key is used to
// solve it and the confirm call is retried.
//
// Everything is gated by the epicAutoClaim block in utils/settings.js and
// defaults to OFF, so the module is inert until the operator flips it on.
// Per-account cool-downs and a fleet-wide daily cap keep this from firing
// hundreds of confirms at Epic during a Mega Sale week (which is exactly
// how you get the whole account pool suspended in one wave).
const axios = require("axios");
const epic = require("./epicClient");
const settings = require("./settings");
const captchaSolver = require("./captchaSolver");
const { decrypt } = require("./secretBox");

// Optional Pi-worker path (residential IP). When EPIC_CLAIM_WORKER_URL and
// EPIC_CLAIM_WORKER_TOKEN are set, we hand the claim to that worker (which
// drives headless Chromium past Cloudflare, submits the token to Epic, and
// solves Talon hCaptcha via 2Captcha). If the env vars are missing we fall
// through to the direct-API path (which is blocked by CF on our OVH IP but
// still runs unit-tested logic in dev).
const WORKER_URL = process.env.EPIC_CLAIM_WORKER_URL || "";
const WORKER_TOKEN = process.env.EPIC_CLAIM_WORKER_TOKEN || "";

async function callWorker({ accessToken, namespace, offerId, capSolverKey, jobId, accountKey }) {
  const code = await epic.exchangeCode(accessToken);
  const res = await axios.post(
    WORKER_URL.replace(/\/$/, "") + "/claim",
    {
      exchangeCode: code,
      namespace,
      offerId,
      capSolverKey,
      jobId,
      accountKey,
    },
    {
      headers: { Authorization: "Bearer " + WORKER_TOKEN },
      timeout: 300000,
      validateStatus: () => true,
    },
  );
  if (res.status !== 200) {
    return {
      status: "error",
      error: "worker HTTP " + res.status + ": " + JSON.stringify(res.data).slice(0, 200),
    };
  }
  return res.data;
}

const state = {
  // { yyyymmdd: number } — UTC day → confirmed-or-attempted count
  dayCounts: {},
  // last N outcomes across the fleet for /status
  recent: [],
  startedAt: null,
};

function todayKey() {
  const d = new Date();
  return (
    d.getUTCFullYear() * 10000 +
    (d.getUTCMonth() + 1) * 100 +
    d.getUTCDate()
  ).toString();
}

function rememberOutcome(entry) {
  state.recent.unshift(entry);
  if (state.recent.length > 100) state.recent.length = 100;
}

function bumpDayCount() {
  const k = todayKey();
  state.dayCounts[k] = (state.dayCounts[k] || 0) + 1;
  // Prune old days so the map doesn't grow unbounded.
  for (const key of Object.keys(state.dayCounts)) {
    if (key !== k && Math.abs(Number(key) - Number(k)) > 7) {
      delete state.dayCounts[key];
    }
  }
}

function todayCount() {
  return state.dayCounts[todayKey()] || 0;
}

// Push one entry onto the account's on-disk autoClaimLog (capped at 20).
async function recordAccountOutcome(acc, offerId, status, extra) {
  try {
    if (!Array.isArray(acc.autoClaimLog)) acc.autoClaimLog = [];
    acc.autoClaimLog.unshift({
      at: new Date(),
      offerId,
      status,
      orderId: (extra && extra.orderId) || "",
      error: (extra && extra.error) || "",
    });
    if (acc.autoClaimLog.length > 20) acc.autoClaimLog.length = 20;
    if (status === "claimed") {
      acc.autoClaimCount = (acc.autoClaimCount || 0) + 1;
      acc.lastAutoClaimAt = new Date();
    }
    await acc.save();
  } catch {
    /* best-effort */
  }
}

function lastAttemptForOffer(acc, offerId) {
  const log = Array.isArray(acc.autoClaimLog) ? acc.autoClaimLog : [];
  return log.find((e) => e && e.offerId === offerId) || null;
}

// The one entry point the claimer calls. Returns:
//   { attempted, status, error?, orderId? }
// attempted=false means the caller should fall back to the Telegram tap.
async function attemptAutoClaim(acc, freebie, accessToken) {
  const cfg = settings.getEpicAutoClaim();
  if (!cfg.enabled) {
    return { attempted: false, status: "disabled" };
  }
  // Per-account cool-down. Any prior attempt on any offer counts — Epic
  // rate-limits by account, so we don't want to hammer one account on a
  // heavy giveaway week.
  const cooldownMs = Math.max(0, cfg.perAccountCooldownH) * 3600000;
  const lastAt = acc.lastAutoClaimAt ? new Date(acc.lastAutoClaimAt).getTime() : 0;
  if (cooldownMs && lastAt && Date.now() - lastAt < cooldownMs) {
    return { attempted: false, status: "cooldown" };
  }
  // Skip if we already tried THIS offer on THIS account (successful or
  // failed) — the next tick will pick it up if it needs a retry.
  const prior = lastAttemptForOffer(acc, freebie.offerId);
  if (prior) return { attempted: false, status: "already_tried" };
  // Fleet daily cap — one confirmed OR failed attempt burns one slot.
  if (cfg.dailyCap && todayCount() >= cfg.dailyCap) {
    return { attempted: false, status: "daily_cap" };
  }

  const solverKey = cfg.captchaKey ? decrypt(cfg.captchaKey) : "";
  const solveCaptcha = solverKey
    ? () =>
        captchaSolver.solveHCaptcha({
          provider: cfg.captchaProvider || "",
          apiKey: solverKey,
        })
    : null;

  bumpDayCount();
  let result;
  try {
    if (WORKER_URL && WORKER_TOKEN) {
      result = await callWorker({
        accessToken,
        namespace: freebie.namespace,
        offerId: freebie.offerId,
        capSolverKey: solverKey,
        jobId: acc.accountId.slice(0, 6) + "-" + Date.now(),
        accountKey: acc.accountId,
      });
    } else {
      result = await epic.autoClaimFreebie(
        accessToken,
        freebie.namespace,
        freebie.offerId,
        { solveCaptcha },
      );
    }
  } catch (err) {
    result = { status: "error", error: err.message || String(err) };
  }
  const summary = {
    at: new Date(),
    accountId: acc.accountId,
    label: acc.label || acc.displayName || acc.accountId,
    offerId: freebie.offerId,
    title: freebie.title,
    status: result.status,
    orderId: result.orderId || "",
    error: result.error || "",
  };
  rememberOutcome(summary);
  await recordAccountOutcome(acc, freebie.offerId, result.status, {
    orderId: result.orderId,
    error: result.error,
  });
  return { attempted: true, ...result };
}

function getStatus() {
  const cfg = settings.getEpicAutoClaim();
  return {
    enabled: cfg.enabled,
    captchaProvider: cfg.captchaProvider || captchaSolver.detectProvider(""),
    captchaKeyConfigured: !!cfg.captchaKey,
    perAccountCooldownH: cfg.perAccountCooldownH,
    dailyCap: cfg.dailyCap,
    todayCount: todayCount(),
    recent: state.recent.slice(0, 20),
  };
}

// Test-only reset. Not exported by default — use for isolation in tests.
function _reset() {
  state.dayCounts = {};
  state.recent = [];
  state.startedAt = null;
}

module.exports = {
  attemptAutoClaim,
  getStatus,
  _reset,
};
