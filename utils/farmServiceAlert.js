// What happens when a rent-farm order cannot be filled.
//
// A rent-farm listing ("… Twitch Drops Automatic Farming 180 days") sells a
// WINDOW, not stock: fulfilment claims a pristine pool account, pins it to one
// game and hands over the credentials. The order is money already taken, and the
// buyer is waiting from the moment it lands.
//
// Two things used to be missing when that failed, and both cost a real delivery.
//
// Eldorado order 4b20765f-206b-411f-698d-08df0d9a5d3a (2026-09-08 15:20Z, R6
// 180d) failed four times and recorded exactly one thing:
//   "only 0 of 1 pristine pool accounts could be provisioned"
// operatorFarm.farmFreshAccounts HAD returned `skipped: [{username, reason}]`
// carrying the real error from the Pi config write — all three farm services
// read `res.added` and dropped `res.skipped` on the floor. Measured afterwards
// the pool was fine (363 eligible, quota 193 free, Pi reachable), so the cause
// was transient and that discarded reason was the only evidence of what it was.
// And nothing alerted: `grep -c sendTelegram` was 0 in the Eldorado and
// PlayerAuctions farm services. The owner found out by looking, and delivered
// it by hand.
//
// So: the reason must survive, and a human must be told.
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");

// FarmServiceOrder.lastError is capped at 400 chars by its consumers, so cap the
// REASON LIST rather than truncate mid-reason — a half-written error message is
// worse than a named count of the ones that did not fit.
const MAX_REASONS = 4;
const MAX_REASON_CHARS = 90;

// Re-alert every Nth attempt so a failure that persists for hours does not go
// quiet after its first ping, without turning a ~75s retry loop into a flood.
const REALERT_EVERY = 10;

function shortfallMessage(res, qty) {
  const added = (res && res.added) || [];
  const skipped = (res && res.skipped) || [];
  const head =
    "only " + added.length + " of " + qty +
    " pristine pool accounts could be provisioned";
  if (!skipped.length) {
    // No skips at all means nothing was even picked: the pool filter came back
    // empty. Say which, because the two have completely different fixes — one
    // is "the Pi/config write is broken", the other is "buy more accounts".
    return head + " — no candidate was picked (pool eligibility returned none)";
  }
  const shown = skipped
    .slice(0, MAX_REASONS)
    .map(
      (s) =>
        (s.username || "?") + ": " +
        String(s.reason || "unknown").slice(0, MAX_REASON_CHARS),
    );
  let msg = head + " — " + shown.join("; ");
  if (skipped.length > MAX_REASONS) {
    msg += " (+" + (skipped.length - MAX_REASONS) + " more)";
  }
  return msg.slice(0, 400);
}

// Should this attempt page the owner? First failure always; then every Nth, so
// a stuck order keeps reminding without spamming.
function shouldAlert(row) {
  if (!row) return true;
  if (row.state !== "failed") return true;
  const n = Number(row.attempts) || 0;
  return n > 0 && n % REALERT_EVERY === 0;
}

async function alertFarmFailure({
  market = "",
  orderId = "",
  offerTitle = "",
  game = "",
  days = 0,
  qty = 0,
  reason = "",
  buyerUsername = "",
}) {
  const detail = String(reason || "unknown").slice(0, 400);
  // Always on the console, whatever Telegram does — pm2 logs are the fallback
  // record and this failure previously left no trace there beyond the count.
  console.error(
    market + " farm order " + orderId + " FAILED (" + game + " " + days + "d x" +
      qty + "): " + detail,
  );
  const text =
    "⚠️ " + market + " rent-farm order NOT delivered\n" +
    "order: " + orderId + "\n" +
    (offerTitle ? "offer: " + String(offerTitle).slice(0, 120) + "\n" : "") +
    (buyerUsername ? "buyer: " + buyerUsername + "\n" : "") +
    "game: " + game + " · " + days + "d · qty " + qty + "\n" +
    "reason: " + detail;
  // Best-effort on both trails: an alert that throws must never be the reason a
  // retry does not happen.
  await sendTelegram(text).catch((e) =>
    console.error("farm alert telegram failed:", e.message),
  );
  await logEvent({
    category: "marketplace",
    action: "farm_order_failed",
    actor: market || "farm-service",
    severity: "error",
    subject: orderId,
    game,
    count: qty,
    detail,
  }).catch(() => {});
}

module.exports = {
  MAX_REASONS,
  REALERT_EVERY,
  shortfallMessage,
  shouldAlert,
  alertFarmFailure,
};
