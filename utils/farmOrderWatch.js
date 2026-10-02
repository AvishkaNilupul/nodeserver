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
// order: one page, then a daily reminder while the order still has an account
// farming. The latch survives a restart (a SystemEvent per page), a read that
// failed never re-arms it, and an order whose accounts no longer farm (their
// windows ended) is not paged at all — there is nothing left to stop.
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 60 * 1000;
// Longer than any window sold (up to a year): a 180-day G2G window refunded in
// its fourth month must still be seen.
const G2G_LOOKBACK_MS = 400 * DAY_MS;
const LIST_MAX = 15;
const LOGINS_MAX = 5;
const MESSAGE_MAX = 3800; // Telegram rejects over 4096
const PAGE_ACTION = "farm_order_walked_away_page";

let deps = {};
const REAL = {
  mp: () => require("./marketplaces"),
  FarmServiceOrder: () => require("../models/FarmServiceOrder"),
  RenterAccount: () => require("../models/RenterAccount"),
  Renter: () => require("../models/Renter"),
  SystemEvent: () => require("../models/SystemEvent"),
  sendTelegram: (m) => require("./telegram").sendTelegram(m),
  logEvent: (e) => require("./systemLog").logEvent(e),
  now: () => Date.now(),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

const paged = new Map(); // orderId|status -> ms
let lastRunAt = 0;

async function eldoradoFindings(FarmServiceOrder, notes) {
  const mp = dep("mp")();
  const found = [];
  let readOk = true;
  for (const [orderState, label] of [["Canceled", "CANCELED"], ["Disputed", "DISPUTED"]]) {
    let list;
    try {
      list = await mp.eldoradoOrders({ orderState });
    } catch (e) {
      readOk = false;
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
  // Only a market read in full may clear its latches: "not in the list" after
  // a failed read is not "no longer cancelled".
  return { found, readOk: readOk ? "all" : "none" };
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
  const unread = new Set(); // orderIds whose read failed: their latches stay
  for (const r of rows) {
    let o;
    try {
      o = await mp.g2gOrder(String(r.orderId || "").replace(/^g2g:/, ""));
    } catch (e) {
      unread.add(r.orderId);
      notes.push("G2G order " + r.orderId + " unreadable");
      continue;
    }
    const refunded = Number(o && (o.refunded_qty != null ? o.refunded_qty : o.refundedQty)) || 0;
    // The raw order item's status field is order_item_status.
    const status = String((o && (o.order_item_status || o.status || o.order_status)) || "").toLowerCase();
    if (refunded > 0) found.push({ row: r, status: "REFUNDED (" + refunded + ")", market: "G2G" });
    else if (/cancel|refund|dispute/.test(status)) found.push({ row: r, status: status.toUpperCase(), market: "G2G" });
  }
  return { found, unread };
}

// The rent-farm holder's LIVE rows for an order's logins: what is still
// farming for a buyer who walked away. Ended or lapsed windows are not.
async function liveLogins(found, now) {
  const Renter = dep("Renter")();
  const RenterAccount = dep("RenterAccount")();
  const holder = await Renter.findOne({ usernameLower: "operator-selffarm" }, { _id: 1 }).lean();
  if (!holder) return new Map();
  const wanted = [...new Set(found.flatMap((f) => (f.row.accounts || []).map((a) => String(a.login || "").toLowerCase())).filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await RenterAccount.find(
    {
      renter: holder._id,
      enabled: true,
      farmEndedAt: null,
      $or: [{ farmUntil: null }, { farmUntil: { $gt: new Date(now) } }],
    },
    { login: 1 },
  ).lean();
  const live = new Map(); // lower login -> login as the ledger has it
  for (const r of rows) {
    const k = String(r.login || "").toLowerCase();
    if (wanted.includes(k)) live.set(k, r.login);
  }
  return live;
}

// lower login -> the orderId of the newest FarmServiceOrder naming it.
async function latestOrderByLogin(FarmServiceOrder, lowerLogins) {
  const out = new Map();
  if (!lowerLogins.length) return out;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await FarmServiceOrder.find(
    { "accounts.login": { $in: lowerLogins.map((l) => new RegExp("^" + esc(l) + "$", "i")) } },
    { orderId: 1, createdAt: 1, "accounts.login": 1 },
  )
    .sort({ createdAt: 1 })
    .lean();
  for (const o of rows) {
    for (const a of o.accounts || []) {
      const k = String(a.login || "").toLowerCase();
      if (lowerLogins.includes(k)) out.set(k, o.orderId); // ascending: the last one wins
    }
  }
  return out;
}

async function checkOnce({ notify = true, force = false } = {}) {
  const now = dep("now")();
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) return null;
  lastRunAt = now;
  const FarmServiceOrder = dep("FarmServiceOrder")();
  const notes = [];
  const eld = await eldoradoFindings(FarmServiceOrder, notes);
  const g2g = await g2gFindings(FarmServiceOrder, notes, now);
  const all = [...eld.found, ...g2g.found];
  const live = await liveLogins(all, now);
  // A login counts for THIS order only while this is the latest order naming
  // it: a recycled account sold again belongs to the newer buyer (the close
  // route leaves it farming — "keptForNewer"), so the old order is not paged
  // over it.
  const latest = await latestOrderByLogin(FarmServiceOrder, [...live.keys()]);
  // Only orders that still have an account farming for them are worth a page.
  const found = [];
  for (const f of all) {
    const logins = (f.row.accounts || [])
      .map((a) => String(a.login || "").toLowerCase())
      .filter((k) => live.has(k) && (!latest.has(k) || latest.get(k) === f.row.orderId))
      .map((k) => live.get(k));
    if (logins.length) found.push({ ...f, logins });
  }

  // Latches: in memory, and — so a restart does not re-page everything —
  // each page is also recorded as a SystemEvent and honoured for a day.
  const keys = found.map((f) => f.row.orderId + "|" + f.status);
  const recent = new Map(); // key -> ms of its last recorded page
  if (keys.length) {
    try {
      // SystemEvent's own time field is `at` (it has no createdAt).
      const rows = await dep("SystemEvent")()
        .find(
          { action: PAGE_ACTION, subject: { $in: keys }, at: { $gte: new Date(now - DAY_MS) } },
          { subject: 1, at: 1 },
        )
        .lean();
      for (const r of rows) {
        const t = new Date(r.at).getTime();
        if (!recent.has(r.subject) || t > recent.get(r.subject)) recent.set(r.subject, t);
      }
    } catch {
      /* no persisted latches: the in-memory ones still apply */
    }
  }
  const toPage = [];
  const liveKeys = new Set();
  for (const f of found) {
    const key = f.row.orderId + "|" + f.status;
    liveKeys.add(key);
    let last = paged.get(key);
    if (!last && recent.has(key)) {
      last = recent.get(key); // paged before a restart: that page's day stands
      paged.set(key, last);
    }
    if (!last || now - last >= DAY_MS) {
      toPage.push(f);
      if (notify) paged.set(key, now);
    }
  }
  // Forget a latch only when its order was READ and is no longer a finding.
  for (const k of [...paged.keys()]) {
    if (liveKeys.has(k)) continue;
    const orderId = k.slice(0, k.lastIndexOf("|"));
    const isG2g = /^g2g:/.test(orderId);
    const readFine = isG2g ? !g2g.unread.has(orderId) : eld.readOk === "all";
    if (readFine) paged.delete(k);
  }
  if (notify && toPage.length) {
    const lines = toPage.slice(0, LIST_MAX).map(
      (f) =>
        "• " + f.market + " order " + f.row.orderId + " is " + f.status +
        (f.row.buyerUsername ? " (buyer " + f.row.buyerUsername + ")" : "") +
        (f.row.game ? " — " + f.row.game + (f.row.days ? " " + f.row.days + "d" : "") : "") +
        " — still farming: " + f.logins.slice(0, LOGINS_MAX).join(", ") +
        (f.logins.length > LOGINS_MAX ? " +" + (f.logins.length - LOGINS_MAX) + " more" : ""),
    );
    let msg =
      "💸 " + toPage.length + " rent-farm order(s) the buyer walked away from still hold farming accounts:\n" +
      lines.join("\n") +
      (toPage.length > LIST_MAX ? "\n… and " + (toPage.length - LIST_MAX) + " more" : "") +
      "\n\nIf the buyer was refunded, close the order (it ends the window; the account is pulled " +
      "off the bot within 5 min). Nothing is closed automatically.";
    if (msg.length > MESSAGE_MAX) msg = msg.slice(0, MESSAGE_MAX - 1) + "…";
    await dep("sendTelegram")(msg).catch((e) => console.error("farmOrderWatch telegram failed:", e.message));
    for (const f of toPage) {
      try {
        await dep("logEvent")({
          category: "marketplace",
          action: PAGE_ACTION,
          actor: "farmOrderWatch",
          severity: "warn",
          subject: f.row.orderId + "|" + f.status,
          detail: (f.market + " " + f.status + " — still farming: " + f.logins.join(", ")).slice(0, 480),
        });
      } catch {
        /* diagnostics only */
      }
    }
  }
  return {
    found: found.map((f) => ({ orderId: f.row.orderId, status: f.status, logins: f.logins })),
    paged: toPage.length,
    notes,
  };
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
