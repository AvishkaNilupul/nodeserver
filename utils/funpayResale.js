// FunPay resale — the engine behind an Eldorado listing linked to a FunPay offer.
//
// utils/eldoradoFulfiller.deliverOrder hands every paid order of a listing with
// `funpaySource` to deliverEldoradoOrder. For each ordered unit the engine buys one
// unit of the FunPay offer (paid from the FunPay balance), waits for the seller's
// auto-delivery, reads the login out of it, and — once every unit has one — sends
// them to the buyer in ONE message, marks the order delivered and records the units
// on the listing (so listedLogins sees them).
//
// The fulfiller works its orders one at a time every 60 s, so nothing here waits:
// each call moves the order as far as it can and returns. State lives in one
// FunpayPurchase row per unit, written BEFORE any money moves:
//   new → waiting_chat → buying → bought → received → delivered   (+ failed, needs_review)
// A row found in "buying" means a purchase was cut off and FunPay may have taken the
// money: it goes to needs_review and is NEVER bought again automatically.
//
// Results never match the fulfiller's ALERT_REASONS: this module pages by itself,
// once per row and reason (FunpayPurchase.alerted survives restarts).

const { createSession } = require("./funpayClient");
const { singleAccount } = require("./funpayCredentials");

const deps = {
  models: () => ({
    Source: require("../models/FunpaySource"),
    Purchase: require("../models/FunpayPurchase"),
  }),
  settings: () => require("./settings"),
  mp: () => require("./marketplaces"),
  notify: (text) => require("./telegram").sendTelegram(text),
  chatReady: (order) => require("./eldoradoFarmService").orderChatReady(order),
  clientFactory: (cookies) => createSession({ cookies }),
  encrypt: (s) => require("./secretBox").encrypt(s),
  decrypt: (s) => require("./secretBox").decrypt(s),
  now: () => Date.now(),
};

const CHAT_WAIT_PAGE_MS = 10 * 60 * 1000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const BUYER_GUIDE = [
  "How to get your items:",
  "1. Before anything else, check that your Epic Games account can link a NEW Twitch account:",
  "   https://www.epicgames.com/help/wizards/w4 (Epic allows one change every 365 days).",
  "2. Log in to twitch.tv with the account you received.",
  "3. Open Twitch Settings → Connections and connect your Epic Games account.",
  "4. The items arrive in Rocket League within minutes (sometimes up to 24 hours). Restart the game.",
  "Twitch only shows drops from the last 6 months in its inventory — older ones are still delivered",
  "when you link. Please link within the first hour. Any problem: message me here before opening a",
  "dispute — I reply fast.",
].join("\n");

// The buyer's message: credentials only, never where they came from.
function buildDeliveryMessage(accounts) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.username && a.password);
  if (!list.length) return "";
  const card = (a) => "Username: " + a.username + "\nPassword: " + a.password;
  const blocks =
    list.length === 1
      ? [card(list[0])]
      : list.map((a, i) => "=== ACCOUNT " + (i + 1) + " of " + list.length + " ===\n" + card(a));
  return blocks.join("\n\n") + "\n\n" + BUYER_GUIDE;
}

// One cached session per stored cookie jar.
let cachedSession = null;
function sessionFor() {
  const jar = deps.settings().getFunpaySessionCookies();
  if (!jar || !jar.golden_key) return null;
  const key = JSON.stringify(jar);
  if (!cachedSession || cachedSession.key !== key) cachedSession = { key, session: deps.clientFactory(jar) };
  return cachedSession.session;
}

// Money spent (or possibly spent) in the last 24 h, manual buys included. An
// attempt whose outcome is unknown counts at its ceiling.
async function spentLast24h() {
  const { Purchase } = deps.models();
  const since = new Date(deps.now() - 24 * 3600 * 1000);
  const rows = await Purchase.find(
    { buyingAt: { $gte: since } },
    { state: 1, chargedUsd: 1, maxPriceUsd: 1 },
  ).lean();
  let sum = 0;
  for (const r of rows) {
    if (Number(r.chargedUsd) > 0) sum += Number(r.chargedUsd);
    else if (r.state === "buying" || r.state === "needs_review") sum += Number(r.maxPriceUsd) || 0;
  }
  return round2(sum);
}

async function buysLastHour() {
  const { Purchase } = deps.models();
  return Purchase.countDocuments({ buyingAt: { $gte: new Date(deps.now() - 3600 * 1000) } });
}

// What one unit of this order sold for, before Eldorado's fee. The order total can
// include the buyer's own fees, so the lower of it and our list price is used.
function unitSalePriceUsd(order, qty, listingPrice) {
  const tp = order && order.totalPrice;
  let paid = NaN;
  if (typeof tp === "number" || typeof tp === "string") paid = Number(tp);
  else if (tp && typeof tp === "object" && (!tp.currency || /^usd$/i.test(tp.currency))) paid = Number(tp.amount);
  const each = Number.isFinite(paid) && paid > 0 ? paid / Math.max(1, qty) : NaN;
  const own = Number(listingPrice);
  const candidates = [each, own].filter((n) => Number.isFinite(n) && n > 0);
  return candidates.length ? round2(Math.min(...candidates)) : 0;
}

// ------------------------------------------------------------------ alerts

const pagedInMemory = new Set();
function orderTitle(order, listing) {
  return String(
    (order && order.orderOfferDetails && order.orderOfferDetails.offerTitle) || (listing && listing.title) || "(title unknown)",
  ).slice(0, 100);
}
function alertText(orderId, order, listing, source, what, todo) {
  return (
    "🛒 FunPay resale — Eldorado order " + orderId + "\n" + orderTitle(order, listing) + "\n" +
    "Deal: " + ((source && (source.label || source.title)) || "?") + "\n\n" + what + (todo ? "\n\n" + todo : "")
  );
}
async function pageRow(row, key, text) {
  if (!row || (row.alerted || []).includes(key)) return;
  row.alerted = (row.alerted || []).concat(key);
  await row.save();
  await Promise.resolve(deps.notify(text)).catch(() => {});
}
async function pageOnce(memKey, text) {
  if (pagedInMemory.has(memKey)) return;
  pagedInMemory.add(memKey);
  await Promise.resolve(deps.notify(text)).catch(() => {});
}

const hold = (orderId, why) => ({ orderId, skipped: "funpay resale: on hold — " + why });

// Why a NEW purchase may not start now (null = it may).
function buyBlocker(s, source) {
  if (s.dryRun) return { key: "dry_run", why: "FunPay resale is in dry run", todo: "Deliver it by hand from FunPay, or switch dry run off on the FunPay Resale page." };
  if (!s.autoBuy) return { key: "off", why: "auto-buy is switched off", todo: "Deliver it by hand, or switch auto-buy on (FunPay Resale page)." };
  if (!s.commissioned) return { key: "not_commissioned", why: "no test purchase has worked yet", todo: "Do one 'Buy 1 now' on the FunPay Resale page first." };
  if (!source.autoBuy) return { key: "source_off", why: "auto-buy is off for this deal", todo: "Deliver it by hand, or switch this deal's auto-buy on." };
  if (source.missingSince) return { key: "source_down", why: "the FunPay offer is gone", todo: "Deliver it by hand from another seller. The listing should be paused." };
  if (!(Number(source.maxBuyPriceUsd) > 0)) return { key: "no_max", why: "this deal has no max buy price", todo: "Set a max buy price on the FunPay Resale page." };
  return null;
}

// ------------------------------------------------------------------ engine

async function deliverEldoradoOrder({ order, listing, qty, dryRun }) {
  const orderId = String((order && order.id) || "");
  try {
    return await advance({ order, orderId, listing, qty: Math.max(1, parseInt(qty, 10) || 1), dryRun: dryRun !== false });
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await pageOnce("exception:" + orderId, alertText(orderId, order, listing, null, "Error: " + msg, "The bot retries every minute. Deliver it by hand if this repeats."));
    return { orderId, error: "funpay resale: " + msg };
  }
}

async function advance({ order, orderId, listing, qty, dryRun }) {
  const { Source, Purchase } = deps.models();
  const s = deps.settings().getFunpayResale();
  const source = listing && listing.funpaySource ? await Source.findById(listing.funpaySource) : null;
  if (!source) {
    await pageOnce("nosource:" + orderId, alertText(orderId, order, listing, null, "The listing's FunPay deal is missing.", "Deliver it by hand."));
    return hold(orderId, "the listing's FunPay deal is missing");
  }
  const label = source.label || source.title || source.offerId;

  // The whole Eldorado delivery is in dry run: never buy, never send.
  if (dryRun) {
    return { orderId, dryRun: true, wouldSend: 'funpay resale (dry run): would buy ' + qty + ' × "' + label + '" and deliver' };
  }

  let rows = await Purchase.find({ eldoradoOrderId: orderId }).sort({ unit: 1 });
  if (rows.length && rows.every((r) => r.state === "delivered")) return { orderId, skipped: "funpay resale: already delivered" };

  // Nothing started for this order yet: every gate must pass before a row exists.
  if (!rows.length) {
    const block = buyBlocker(s, source);
    if (block) {
      await pageOnce(block.key + ":" + orderId, alertText(orderId, order, listing, source, "Not bought: " + block.why + ".", block.todo));
      return hold(orderId, block.why);
    }
    if (qty > s.maxUnitsPerOrder) {
      await pageOnce("qty:" + orderId, alertText(orderId, order, listing, source, "The buyer ordered " + qty + " units; the limit is " + s.maxUnitsPerOrder + ".", "Deliver it by hand or raise 'max units per order'."));
      return hold(orderId, "order of " + qty + " units is above the limit of " + s.maxUnitsPerOrder);
    }
    if (!sessionFor()) {
      await pageOnce("nosession:" + orderId, alertText(orderId, order, listing, source, "No FunPay login is saved.", "Paste your FunPay cookies on the FunPay Resale page."));
      return hold(orderId, "no FunPay login saved");
    }
  }

  // One row per ordered unit (unique index: a race cannot make two).
  for (let u = 0; u < qty; u++) {
    if (rows.some((r) => r.unit === u)) continue;
    try {
      await Purchase.create({ source: source._id, offerId: source.offerId, kind: "order", eldoradoOrderId: orderId, unit: u, listing: listing._id || null, state: "new" });
    } catch (e) {
      if (!(e && e.code === 11000)) throw e;
    }
  }
  rows = await Purchase.find({ eldoradoOrderId: orderId }).sort({ unit: 1 });

  // A purchase cut off mid-way: FunPay may have taken the money. Never retried.
  for (const r of rows.filter((x) => x.state === "buying")) {
    r.state = "needs_review";
    r.reason = "a purchase was cut off mid-way — check your FunPay orders before doing anything";
    await r.save();
    await pageRow(r, "needs_review", alertText(orderId, order, listing, source, "A FunPay purchase was cut off mid-way (unit " + (r.unit + 1) + ").", "Check your FunPay purchases for this deal. If it was bought, enter the login on the FunPay Resale page; otherwise close it there."));
  }

  const session = sessionFor();
  const pending = rows.filter((r) => r.state === "new" || r.state === "waiting_chat");
  if (pending.length) {
    const block = buyBlocker(s, source) || (session ? null : { key: "no_session", why: "no FunPay login saved", todo: "Paste your FunPay cookies on the FunPay Resale page." });
    if (block) {
      await pageRow(pending[0], block.key, alertText(orderId, order, listing, source, "Not bought: " + block.why + ".", block.todo));
      return hold(orderId, block.why);
    }
    if (!deps.chatReady(order)) {
      for (const r of pending) {
        if (r.state === "new") {
          r.state = "waiting_chat";
          await r.save();
        }
      }
      const oldest = Math.min(...pending.map((r) => new Date(r.createdAt || deps.now()).getTime()));
      if (deps.now() - oldest >= CHAT_WAIT_PAGE_MS) {
        await pageRow(pending[0], "waiting_chat", alertText(orderId, order, listing, source, "Waiting 10+ minutes for the buyer's order chat (Eldorado opens it lazily). Nothing was bought yet.", "Open the order on Eldorado once — that creates the chat — and it ships on the next tick."));
      }
      return { orderId, skipped: "funpay resale: waiting for the buyer's order chat" };
    }
    const unitNet = round2(unitSalePriceUsd(order, qty, listing.price) * (1 - (Number(s.eldoradoFeePct) || 0) / 100));
    const maxPrice = round2(Math.min(Number(source.maxBuyPriceUsd) || 0, Number(s.perUnitMaxUsd) || 0, unitNet - (Number(s.minProfitUsd) || 0)));
    if (!(maxPrice > 0)) {
      await pageRow(pending[0], "profit", alertText(orderId, order, listing, source, "Not bought: no profit at this sale price (net $" + unitNet.toFixed(2) + " per unit).", "Deliver it by hand, or check the listing price and limits."));
      return hold(orderId, "no profit at this sale price");
    }
    for (const r of pending) {
      const spent = await spentLast24h();
      if (spent + maxPrice > (Number(s.dailyCapUsd) || 0) + 1e-9) {
        await pageRow(r, "daily_cap", alertText(orderId, order, listing, source, "Not bought: the 24 h spend cap ($" + Number(s.dailyCapUsd).toFixed(2) + ") would be passed (spent $" + spent.toFixed(2) + ").", "Deliver it by hand, or raise the daily cap."));
        return hold(orderId, "24 h spend cap reached");
      }
      if ((await buysLastHour()) >= s.maxBuysPerHour) {
        await pageRow(r, "rate", alertText(orderId, order, listing, source, "Waiting: " + s.maxBuysPerHour + " FunPay buys in the last hour already.", "It continues by itself within the hour, or raise the limit."));
        return hold(orderId, "hourly buy limit reached");
      }
      r.state = "buying";
      r.buyingAt = new Date(deps.now());
      r.maxPriceUsd = maxPrice;
      r.reason = "";
      await r.save();
      let res;
      try {
        res = await session.buyOne({ offerId: source.offerId, maxPriceUsd: maxPrice });
      } catch (e) {
        r.state = "needs_review";
        r.reason = "the FunPay request failed mid-purchase (" + String(e.message || e).slice(0, 160) + ") — check your FunPay orders";
        await r.save();
        await pageRow(r, "needs_review", alertText(orderId, order, listing, source, "A FunPay purchase failed mid-way: " + r.reason + ".", "Check your FunPay purchases. If it was bought, enter the login on the page; otherwise close it there."));
        return hold(orderId, "a purchase needs checking");
      }
      r.trace = res.trace || [];
      if (!res.ok) {
        r.state = "failed";
        r.reason = String(res.reason || "purchase refused").slice(0, 300);
        await r.save();
        await pageRow(r, "failed", alertText(orderId, order, listing, source, "FunPay purchase not made: " + r.reason + ".", "Deliver it by hand, or fix the cause and press Retry on the FunPay Resale page."));
        return hold(orderId, r.reason);
      }
      r.state = "bought";
      r.funpayOrderId = res.orderId;
      r.chargedUsd = round2(res.chargedUsd || 0);
      r.boughtAt = new Date(deps.now());
      await r.save();
    }
  }

  // Read what the seller delivered.
  for (const r of rows.filter((x) => x.state === "bought")) {
    if (!session) break;
    let read;
    try {
      read = await session.readOrder(r.funpayOrderId);
    } catch (e) {
      break; // network: try again next tick
    }
    const secrets = (read && read.order && read.order.secrets) || [];
    if (secrets.length) {
      const acc = singleAccount(secrets.join("\n"));
      if (acc) {
        r.credentials = deps.encrypt(JSON.stringify(acc));
        r.login = acc.username;
        r.state = "received";
        r.receivedAt = new Date(deps.now());
        r.reason = "";
        await r.save();
      } else {
        r.state = "needs_review";
        r.reason = "could not read exactly one login from the seller's delivery";
        await r.save();
        await pageRow(r, "needs_review", alertText(orderId, order, listing, source, "Bought (FunPay order " + r.funpayOrderId + ") but the login could not be read from the seller's message.", "Open the FunPay order, then enter the login on the FunPay Resale page — it ships on the next tick."));
      }
      continue;
    }
    const mins = (deps.now() - new Date(r.boughtAt || deps.now()).getTime()) / 60000;
    if (mins >= (Number(s.giveUpHours) || 24) * 60) {
      r.state = "needs_review";
      r.reason = "the seller has not delivered after " + s.giveUpHours + " h";
      await r.save();
      await pageRow(r, "needs_review", alertText(orderId, order, listing, source, "The FunPay seller has not delivered order " + r.funpayOrderId + " after " + s.giveUpHours + " h.", "Open a dispute on FunPay and deliver this Eldorado order by hand."));
    } else if (mins >= (Number(s.sellerWaitMinutes) || 15)) {
      await pageRow(r, "seller_slow", alertText(orderId, order, listing, source, "Bought on FunPay (order " + r.funpayOrderId + ") " + Math.round(mins) + " min ago; the seller has not delivered yet.", "Message the seller on FunPay. It ships by itself as soon as they deliver."));
    }
  }

  rows = await Purchase.find({ eldoradoOrderId: orderId }).sort({ unit: 1 });
  if (rows.length === qty && rows.every((r) => r.state === "received" || r.state === "delivered")) {
    return deliver({ order, orderId, listing, source, rows });
  }
  const stuck = rows.find((r) => r.state === "failed" || r.state === "needs_review");
  if (stuck) return hold(orderId, stuck.reason || stuck.state);
  return { orderId, skipped: "funpay resale: bought, waiting for the seller to deliver" };
}

async function deliver({ order, orderId, listing, source, rows }) {
  const accounts = [];
  for (const r of rows) {
    let acc = null;
    try {
      acc = JSON.parse(deps.decrypt(r.credentials) || "null");
    } catch (_) {
      acc = null;
    }
    if (!acc || !acc.username || !acc.password) {
      r.state = "needs_review";
      r.reason = "the stored login could not be read back";
      await r.save();
      await pageRow(r, "needs_review", alertText(orderId, order, listing, source, "A bought login could not be read back.", "Enter the login on the FunPay Resale page."));
      return hold(orderId, r.reason);
    }
    accounts.push(acc);
  }
  const message = buildDeliveryMessage(accounts);
  if (!message.trim()) return hold(orderId, "the delivery text came out empty");
  const mp = deps.mp();
  try {
    await mp.eldoradoSendOrderMessage(order, message);
  } catch (e) {
    await pageRow(rows[0], "send_failed", alertText(orderId, order, listing, source, "The login is bought but sending it to the buyer failed: " + String(e.message || e).slice(0, 160) + ".", "The bot retries every minute."));
    return { orderId, skipped: "funpay resale: delivery message failed, retrying — " + String(e.message || e).slice(0, 120) };
  }
  await mp.eldoradoMarkDelivered(orderId);
  const at = new Date(deps.now());
  for (const r of rows) {
    if (r.state === "delivered") continue;
    r.state = "delivered";
    r.deliveredAt = at;
    await r.save();
  }
  listing.units = (listing.units || []).concat(
    rows.map((r) => ({ contentId: String(r._id), accountId: "", login: r.login, addedAt: at, deliveredAt: at, orderId })),
  );
  if (typeof listing.markModified === "function") listing.markModified("units");
  await listing.save();
  return { orderId, delivered: rows.length, source: "funpay:" + source.offerId };
}

module.exports = {
  deliverEldoradoOrder,
  buildDeliveryMessage,
  BUYER_GUIDE,
  spentLast24h,
  buysLastHour,
  sessionFor,
  unitSalePriceUsd,
  deps,
};
