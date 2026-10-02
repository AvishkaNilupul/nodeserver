// Order-intake watchdog (2026-10-01).
//
// Every paid marketplace order — rent-farm ones included — is found by one
// "read the paid orders" call per fulfiller tick. When that read fails (session
// lapsed, cookie refresh failing, API down), the fulfillers used to log one
// console line and return: no FarmServiceOrder row is ever created, so neither
// farmServiceAlert nor the health page's undelivered-orders check can see it,
// and paid orders sit undelivered while every dial reads fine.
//
// This pages once a market's reads have been failing for FAIL_MS (and at
// least MIN_FAILURES times in a row — one blip is not an outage), re-pages
// every REALERT_MS while it lasts, and says so when reads recover. In memory:
// a restart re-arms it, which is the safe direction.
const FAIL_MS = 5 * 60 * 1000;
const MIN_FAILURES = 3;
const REALERT_MS = 6 * 60 * 60 * 1000;

const state = new Map(); // market -> { since, failures, alertedAt, lastError }

function telegram() {
  return require("./telegram");
}
function systemLog() {
  return require("./systemLog");
}

function minutes(ms) {
  return Math.max(1, Math.round(ms / 60000));
}

// A read failed. Returns true when this call paged.
async function failed(market, err, now = Date.now()) {
  const s = state.get(market) || { since: now, failures: 0, alertedAt: 0, lastError: "" };
  s.failures += 1;
  s.lastError = String((err && err.message) || err || "unknown error").slice(0, 200);
  state.set(market, s);
  const due =
    s.failures >= MIN_FAILURES &&
    now - s.since >= FAIL_MS &&
    (!s.alertedAt || now - s.alertedAt >= REALERT_MS);
  if (!due) return false;
  s.alertedAt = now;
  const msg =
    "🚨 " + market + " paid orders cannot be read — failing for " + minutes(now - s.since) +
    " min (" + s.failures + " reads). New sales (rent-farm orders included) are NOT being " +
    "delivered until this recovers. Last error: " + s.lastError;
  try {
    await telegram().sendTelegram(msg);
  } catch (e) {
    console.error("intakeWatch telegram failed:", e.message);
  }
  try {
    systemLog().logEvent({
      category: "marketplace",
      action: "order_intake_failing",
      actor: "intakeWatch",
      severity: "error",
      subject: market,
      count: s.failures,
      detail: s.lastError,
    });
  } catch {
    /* diagnostics only */
  }
  return true;
}

// A read succeeded. Returns true when this call sent a recovery message.
async function ok(market, now = Date.now()) {
  const s = state.get(market);
  if (!s) return false;
  state.delete(market);
  if (!s.alertedAt) return false;
  try {
    await telegram().sendTelegram(
      "✅ " + market + " paid-order reads are working again (were failing for " +
        minutes(now - s.since) + " min).",
    );
  } catch (e) {
    console.error("intakeWatch telegram failed:", e.message);
  }
  return true;
}

module.exports = { failed, ok, FAIL_MS, MIN_FAILURES, REALERT_MS, _state: state };
