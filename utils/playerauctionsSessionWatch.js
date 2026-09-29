// PlayerAuctions session watchdog.
//
// PlayerAuctions allows ONE session per account. Signing in anywhere — the
// operator opening the site in their own browser — rotates the session id and
// invalidates every other copy, and there is nothing the server can do to
// prevent that. Verified 2026-09-07 by watching the `sid` claim change between
// two cookie pastes while the server sat idle and refreshed nothing.
//
// Worse, the session has a HARD ~24h ceiling: the refresh token keeps the expiry
// it was minted with at the browser sign-in, and POST SignIn/RefreshToken renews
// only the 30-minute access half — it never pushes that ceiling out. So a cookie
// pasted at time T dies at T+24h no matter how healthy the server is, and the
// login page is captcha-gated (Turnstile + reCAPTCHA), so the server cannot log
// itself back in. The re-paste is therefore a DAILY chore, not an incident.
//
// So this cannot be engineered away. What it CAN be is loud and EARLY: a dead
// session means the delivery bot silently stops shipping, and on a marketplace
// that charges for late delivery, the expensive part is not the outage but the
// hours before anyone notices. This does two things:
//   1. A PREDICTIVE reminder ~1h before the known expiry, read straight out of
//      the stored token (no network, no session risk), so the operator re-pastes
//      BEFORE anything goes dark instead of finding out via a dispute.
//   2. The reactive alert: it Telegrams the moment the session actually breaks,
//      tailored to which of the two death shapes it is.
//
// Deliberately quiet: one predictive reminder per cookie, one "dead" alert per
// outage (not one per tick), and one "back up" when it recovers.
const mp = require("./marketplaces");

// Resolved at call time rather than destructured at require time, so the alert
// path stays interceptable in tests and cannot hold a stale binding.
const notify = (text) => require("./telegram").sendTelegram(text);

// Short enough that an outage is caught long before a buyer's delivery
// guarantee runs down, long enough to be nothing on the API.
const TICK_MS = 5 * 60 * 1000;

// How long before the known 24h ceiling to send the "re-paste now" reminder.
// One hour is enough lead time to sign in and paste before any gap in delivery.
const WARN_BEFORE_MS = 60 * 60 * 1000;

const state = {
  alerted: false,
  lastOkAt: null,
  startedAt: null,
  // The refresh-token expiry (ms) we have already sent a pre-expiry reminder
  // for. Keyed by the timestamp itself, so a fresh paste — which mints a new,
  // later expiry — automatically re-arms the reminder without any reset step.
  warnedForExpiry: null,
};

function ago(d) {
  if (!d) return "never";
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 60) return mins + " min ago";
  return Math.round(mins / 60) + "h ago";
}

// The operator works in JST, so state the deadline in their own clock. Falls
// back to ISO if the runtime has no ICU (prod's Node 20 does).
function fmtJst(ms) {
  try {
    return (
      new Date(ms).toLocaleString("en-GB", {
        timeZone: "Asia/Tokyo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " JST"
    );
  } catch {
    return new Date(ms).toISOString();
  }
}

// The refresh-token expiry, read locally from the stored jar. This calls
// PlayerAuctions NOT AT ALL — playerauctionsTokenExpiry decodes the JWT in the
// cookie — so it is safe to run every tick and can never spend or rotate the
// session (the trap that killed it four times).
function refreshExpiryMs() {
  try {
    const exp = mp.playerauctionsTokenExpiry();
    return exp && exp.refresh ? exp.refresh.getTime() : null;
  } catch {
    return null;
  }
}

function expiryLine(refreshExp) {
  if (!refreshExp) return "";
  const left = refreshExp - Date.now();
  if (left <= 0) return "\n\nThe session has already reached its 24h limit.";
  const h = Math.floor(left / 3600000);
  const m = Math.round((left % 3600000) / 60000);
  return "\n\nExpires " + fmtJst(refreshExp) + " (" + (h ? h + "h " : "") + m + "m from now).";
}

// The one instruction that fixes every shape of outage. Kept in one place so the
// predictive reminder and the dead-alert say exactly the same thing.
const REPASTE_STEPS =
  "Sign in at member.playerauctions.com, copy the whole Cookie request header " +
  "from any request there, and paste it into the PlayerAuctions credential in " +
  "the listings keys modal — then CLOSE that tab so the server stays the only " +
  "session. Nothing else is needed.";

// Fire once, ~1h before the known ceiling, so the re-paste happens before any
// downtime. Guarded on the expiry timestamp so it is exactly one message per
// cookie, and only ever when the session is currently healthy.
async function maybeWarnBeforeExpiry(refreshExp) {
  if (!refreshExp) return false;
  const left = refreshExp - Date.now();
  if (left <= 0 || left > WARN_BEFORE_MS) return false; // outside the window
  if (state.warnedForExpiry === refreshExp) return false; // already warned for this cookie
  state.warnedForExpiry = refreshExp;
  await notify(
    "⏰ PlayerAuctions cookie expires soon — re-paste to avoid downtime." +
      expiryLine(refreshExp) +
      "\n\n" +
      REPASTE_STEPS,
  ).catch(() => {});
  return true;
}

async function check() {
  if (!(mp.keyStatus().playerauctions || {}).configured) return { skipped: "not configured" };

  const refreshExp = refreshExpiryMs(); // local read, no network

  const r = await mp.playerauctionsTest();
  if (r.ok) {
    state.lastOkAt = Date.now();
    if (state.alerted) {
      state.alerted = false;
      await notify(
        "✅ PlayerAuctions session is back — auto-delivery is running again." +
          expiryLine(refreshExp),
      ).catch(() => {});
    }
    // Only nudge ahead of expiry while the session is actually alive; a dead
    // one is handled by the branch below.
    await maybeWarnBeforeExpiry(refreshExp);
    return { ok: true, detail: r.detail };
  }

  // Already told them; don't nag every 5 minutes.
  if (state.alerted) return { ok: false, detail: r.detail, alreadyAlerted: true };

  state.alerted = true;
  // Distinguish the two death shapes so the operator knows whether they did
  // anything wrong. Natural ceiling: the refresh token's own expiry is in the
  // past — nothing was raced, just re-paste. Early death with the expiry still
  // in the future: the session was rotated out from under the server, almost
  // always by the site being open in a browser tab.
  const naturalCeiling = refreshExp != null && refreshExp <= Date.now();
  const cause = naturalCeiling
    ? "The 24h session limit was reached — this is the normal daily expiry, " +
      "nothing was broken."
    : "The session was cut short before its 24h limit — this usually means " +
      "PlayerAuctions is open in a browser tab, which rotates the session and " +
      "invalidates the server's copy.";

  await notify(
    "⚠️ PlayerAuctions session is DEAD — auto-delivery has stopped.\n\n" +
      "Last good: " +
      ago(state.lastOkAt) +
      "\n" +
      "Reason: " +
      String(r.detail || "unknown").slice(0, 200) +
      "\n\n" +
      cause +
      "\n\n" +
      "To fix: " +
      REPASTE_STEPS,
  ).catch(() => {});
  return { ok: false, detail: r.detail, alerted: true, naturalCeiling };
}

let started = false;

function start() {
  if (started) return;
  started = true;
  state.startedAt = Date.now();
  const tick = async () => {
    try {
      await check();
    } catch (e) {
      console.error("playerauctions session watch:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  // After the session refresher's first pass, so a cookie that merely needed
  // renewing is not reported as an outage.
  const t = setTimeout(tick, 3 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start, check, state, TICK_MS, WARN_BEFORE_MS };
