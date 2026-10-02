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
//
// "waiting_chat" (the buyer's Eldorado order chat is not open yet) is throttled
// exactly like "failed": attempts accrue ~1 per tick, so the first page lands
// around attempt REALERT_EVERY (~10 min) — quiet for a chat that opens promptly,
// loud for one that never does.
//
// "sent" (the login reached the buyer; only confirming the delivery on the
// market keeps failing) is throttled the same way: the next tick retries the
// confirmation by itself, so a page is only worth it once that keeps failing.
function shouldAlert(row) {
  if (!row) return true;
  if (row.state !== "failed" && row.state !== "waiting_chat" && row.state !== "sent") return true;
  const n = Number(row.attempts) || 0;
  return n > 0 && n % REALERT_EVERY === 0;
}

const MAX_LOGINS = 10;

async function alertFarmFailure({
  market = "",
  orderId = "",
  offerTitle = "",
  game = "",
  days = 0,
  qty = 0,
  reason = "",
  buyerUsername = "",
  // The accounts the order holds (provisioned), so the operator knows which
  // logins are involved without opening the database.
  logins = [],
  // The login already reached the buyer: only confirming the delivery on the
  // market failed. Worded so nobody hands it over a second time.
  sent = false,
  // "buffer": Gameflip buffer housekeeping — NO buyer order is involved, so it
  // must never read "order NOT delivered" (that trains the owner to skim the
  // one alert that means money).
  // "not_farming": a DELIVERED order (Gameflip hands the login over at
  // payment) whose account is not on a bot — the buyer is owed farming, not
  // a second login.
  kind = "order",
}) {
  // 900, not 400: buffer pages lead with the pool id and login but carry the
  // instruction at the end, and 400 cut exactly that off (2026-10-01 review).
  const detail = String(reason || "unknown").slice(0, 900);
  // Always on the console, whatever Telegram does — pm2 logs are the fallback
  // record and this failure previously left no trace there beyond the count.
  console.error(
    market + " farm order " + orderId +
      (kind === "not_farming" ? " DELIVERED, NOT FARMING" : sent ? " SENT, NOT CONFIRMED" : " FAILED") +
      " (" + game + " " + days + "d x" + qty + "): " + detail,
  );
  const list = (Array.isArray(logins) ? logins : []).filter(Boolean);
  if (kind === "buffer") {
    console.error(market + " rent-farm buffer (" + orderId + "): " + detail);
    await sendTelegram(
      "🧺 " + market + " rent-farm BUFFER (" + String(orderId).replace(/^buffer:/, "") +
        ") — no buyer order is involved.\n" + detail,
    ).catch((e) => console.error("farm alert telegram failed:", e.message));
    await logEvent({
      category: "marketplace",
      action: "gameflip_buffer_alert",
      actor: market || "farm-service",
      severity: "warn",
      subject: orderId,
      detail,
    }).catch(() => {});
    return;
  }
  const notFarming = kind === "not_farming";
  const text =
    (notFarming
      ? "🟠 " + market + " rent-farm order DELIVERED (the buyer has the login) but NOT FARMING\n"
      : sent
        ? "⚠️ " + market + " rent-farm order DELIVERED to the buyer but not yet confirmed on " + market + "\n"
        : "⚠️ " + market + " rent-farm order NOT delivered\n") +
    "order: " + orderId + "\n" +
    (offerTitle ? "offer: " + String(offerTitle).slice(0, 120) + "\n" : "") +
    (buyerUsername ? "buyer: " + buyerUsername + "\n" : "") +
    "game: " + game + " · " + days + "d · qty " + qty + "\n" +
    (list.length
      ? "accounts: " + list.slice(0, MAX_LOGINS).join(", ") +
        (list.length > MAX_LOGINS ? " +" + (list.length - MAX_LOGINS) + " more" : "") + "\n"
      : "") +
    "reason: " + detail +
    (notFarming
      ? "\n\nDo NOT send the login again — the buyer has it. Put the account back on a bot."
      : sent
        ? "\n\nDo NOT send the login again — the buyer has it. The confirmation retries " +
          "every tick; or mark the order delivered on " + market + " by hand."
        : "");
  // Best-effort on both trails: an alert that throws must never be the reason a
  // retry does not happen.
  await sendTelegram(text).catch((e) =>
    console.error("farm alert telegram failed:", e.message),
  );
  await logEvent({
    category: "marketplace",
    action: notFarming ? "farm_order_not_farming" : sent ? "farm_order_unconfirmed" : "farm_order_failed",
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
