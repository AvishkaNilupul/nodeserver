// PlayerAuctions session watchdog.
//
// PlayerAuctions allows ONE session per account. Signing in anywhere — the
// operator opening the site in their own browser — rotates the session id and
// invalidates every other copy, and there is nothing the server can do to
// prevent that. Verified 2026-09-07 by watching the `sid` claim change between
// two cookie pastes while the server sat idle and refreshed nothing.
//
// So this cannot be engineered away. What it CAN be is loud: a dead session
// means the delivery bot silently stops shipping, and on a marketplace that
// charges for late delivery, the expensive part is not the outage but the hours
// before anyone notices. This checks the session on a short cycle and Telegrams
// the operator the moment it breaks, with the one instruction needed to fix it.
//
// Deliberately quiet: one alert per outage, not one per tick, and one "back up"
// when it recovers.
const mp = require("./marketplaces");

// Resolved at call time rather than destructured at require time, so the alert
// path stays interceptable in tests and cannot hold a stale binding.
const notify = (text) => require("./telegram").sendTelegram(text);

// Short enough that an outage is caught long before a buyer's delivery
// guarantee runs down, long enough to be nothing on the API.
const TICK_MS = 5 * 60 * 1000;

const state = { alerted: false, lastOkAt: null, startedAt: null };

function ago(d) {
  if (!d) return "never";
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 60) return mins + " min ago";
  return Math.round(mins / 60) + "h ago";
}

async function check() {
  if (!(mp.keyStatus().playerauctions || {}).configured) return { skipped: "not configured" };

  const r = await mp.playerauctionsTest();
  if (r.ok) {
    state.lastOkAt = Date.now();
    if (state.alerted) {
      state.alerted = false;
      await notify(
        "✅ PlayerAuctions session is back — auto-delivery is running again.",
      ).catch(() => {});
    }
    return { ok: true, detail: r.detail };
  }

  // Already told them; don't nag every 5 minutes.
  if (state.alerted) return { ok: false, detail: r.detail, alreadyAlerted: true };

  state.alerted = true;
  await notify(
    "⚠️ PlayerAuctions session is DEAD — auto-delivery has stopped.\n\n" +
      "Last good: " + ago(state.lastOkAt) + "\n" +
      "Reason: " + String(r.detail || "unknown").slice(0, 200) + "\n\n" +
      "PlayerAuctions allows only ONE session per account, so this usually means " +
      "the site was opened in a browser, which rotates the session and " +
      "invalidates the server's copy.\n\n" +
      "To fix: sign in at member.playerauctions.com, copy the whole Cookie " +
      "request header from any request there, and paste it into the " +
      "PlayerAuctions credential in the listings keys modal. Nothing else is " +
      "needed — the server keeps it alive on its own after that.",
  ).catch(() => {});
  return { ok: false, detail: r.detail, alerted: true };
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

module.exports = { start, check, state, TICK_MS };
