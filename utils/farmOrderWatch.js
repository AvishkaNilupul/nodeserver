// Rent-farm orders the buyer walked away from (2026-10-01).
//
// A cancelled, refunded or disputed order simply drops out of the "paid"
// queues the fulfillers read, so its FarmServiceOrder row stays delivered and
// its account(s) keep farming for up to two years — for someone who has the
// password AND their money back — while holding a stack slot. Nothing noticed.
//
// This reads POSITIVE evidence only — Eldorado's own Canceled / Disputed order
// lists, and a G2G order's refunded quantity — and pages the operator with the
// order, buyer and logins. It never closes anything itself: "gone from the
// pending list" is also what a failed read or a rate-limited page looks like,
// and a wrong close abandons a paid order (scripts/close-farm-order.js). The
// operator closes it (POST /renters/farm-orders/:orderId/close), which ends the
// windows so renterExpiry pulls the accounts.
//
// At most hourly (on the rent-farm capacity watcher's tick). Latched per
// order: one page, then a daily reminder while the row is still open.
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 60 * 1000;
const G2G_LOOKBACK_MS = 60 * DAY_MS;
const LIST_MAX = 15;

let deps = {};
const REAL = {
  mp: () => require("./marketplaces"),
  FarmServiceOrder: () => require("../models/FarmServiceOrder"),
  sendTelegram: (m) => require("./telegram").sendTelegram(m),
  logEvent: (e) => require("./systemLog").logEvent(e),
  now: () => Date.now(),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

const paged = new Map(); // orderId|state -> ms
let lastRunAt = 0;

function short(id) {
  return String(id || "").replace(/^(g2g|pa|gf):/, "").slice(0, 8);
}

async function eldoradoFindings(FarmServiceOrder, notes) {
  const mp = dep("mp")();
  const found = [];
  for (const [orderState, label] of [["Canceled", "CANCELED"], ["Disputed", "DISPUTED"]]) {
    let list;
    try {
      list = await mp.eldoradoOrders({ orderState });
    } catch (e) {
      notes.push("Eldorado " + orderState + " list unreadable: " + String((e && e.message) || e).slice(0, 80));
      continue;
    }
    const ids = (list || []).map((o) => String((o && o.id) || "")).filter(Boolean);
    if (!ids.length) continue;
    const rows = await FarmServiceOrder.find(
      { orderId: { $in: ids }, state: { $ne: "cancelled" }, "accounts.0": { $exists: true } },
      { orderId: 1, market: 1, buyerUsername: 1, game: 1, days: 1, accounts: 1, state: 1 },
    ).lean();
    for (const r of rows) found.push({ row: r, status: label, market: "Eldorado" });
  }
  return found;
}

async function g2gFindings(FarmServiceOrder, notes, now) {
  const mp = dep("mp")();
  const rows = await FarmServiceOrder.find(
    {
      market: "g2g",
      state: { $ne: "cancelled" },
      "accounts.0": { $exists: true },
      createdAt: { $gte: new Date(now - G2G_LOOKBACK_MS) },
    },
    { orderId: 1, market: 1, buyerUsername: 1, game: 1, days: 1, accounts: 1, state: 1 },
  ).lean();
  const found = [];
  for (const r of rows) {
    let o;
    try {
      o = await mp.g2gOrder(String(r.orderId || "").replace(/^g2g:/, ""));
    } catch (e) {
      notes.push("G2G order " + short(r.orderId) + " unreadable");
      continue;
    }
    const refunded = Number(o && (o.refunded_qty != null ? o.refunded_qty : o.refundedQty)) || 0;
    const status = String((o && (o.status || o.order_status)) || "").toLowerCase();
    if (refunded > 0) found.push({ row: r, status: "REFUNDED (" + refunded + ")", market: "G2G" });
    else if (/cancel|refund|dispute/.test(status)) found.push({ row: r, status: status.toUpperCase(), market: "G2G" });
  }
  return found;
}

async function checkOnce({ notify = true, force = false } = {}) {
  const now = dep("now")();
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) return null;
  lastRunAt = now;
  const FarmServiceOrder = dep("FarmServiceOrder")();
  const notes = [];
  const found = [
    ...(await eldoradoFindings(FarmServiceOrder, notes)),
    ...(await g2gFindings(FarmServiceOrder, notes, now)),
  ];
  const toPage = [];
  const live = new Set();
  for (const f of found) {
    const key = f.row.orderId + "|" + f.status;
    live.add(key);
    const last = paged.get(key);
    if (!last || now - last >= DAY_MS) {
      toPage.push(f);
      if (notify) paged.set(key, now);
    }
  }
  for (const k of [...paged.keys()]) if (!live.has(k)) paged.delete(k);
  if (notify && toPage.length) {
    await dep("sendTelegram")(
      "💸 " + toPage.length + " rent-farm order(s) the buyer walked away from still hold farming accounts:\n" +
        toPage
          .slice(0, LIST_MAX)
          .map(
            (f) =>
              "• " + f.market + " " + short(f.row.orderId) + " is " + f.status +
              (f.row.buyerUsername ? " (buyer " + f.row.buyerUsername + ")" : "") +
              (f.row.game ? " — " + f.row.game + (f.row.days ? " " + f.row.days + "d" : "") : "") +
              " — still farming: " + (f.row.accounts || []).map((a) => a.login).filter(Boolean).join(", "),
          )
          .join("\n") +
        (toPage.length > LIST_MAX ? "\n… and " + (toPage.length - LIST_MAX) + " more" : "") +
        "\n\nIf the buyer was refunded, close the order (it ends the window; the account is pulled " +
        "off the bot within 5 min). Nothing is closed automatically.",
    ).catch((e) => console.error("farmOrderWatch telegram failed:", e.message));
    try {
      dep("logEvent")({
        category: "marketplace",
        action: "farm_order_walked_away",
        actor: "farmOrderWatch",
        severity: "warn",
        count: toPage.length,
        detail: toPage.map((f) => f.market + ":" + short(f.row.orderId) + ":" + f.status).join(", ").slice(0, 480),
      });
    } catch {
      /* diagnostics only */
    }
  }
  return { found: found.map((f) => ({ orderId: f.row.orderId, status: f.status })), paged: toPage.length, notes };
}

module.exports = {
  checkOnce,
  __setDeps: (d) => {
    deps = { ...deps, ...(d || {}) };
  },
  _reset: () => {
    deps = {};
    paged.clear();
    lastRunAt = 0;
  },
};
