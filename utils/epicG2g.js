// Epic Games accounts sold on G2G, delivered by the server itself.
//
// A G2G Game Accounts offer with MANUAL delivery is delivered through the order
// page: the seller fills the brand's account form (Account ID, Password,
// registration details, Account Email + Email Password, Additional Note) and
// G2G shows it to the buyer on the order. G2G's rules want exactly that for
// accounts (never the chat). This module does it the moment the G2G fulfiller
// (utils/g2gFulfiller, every minute) sees a paid order on a LINKED offer:
//
//   1. EpicSale row first (orderId "g2g:<order item>", unique), so a second
//      tick or a restart resumes this order instead of starting another.
//   2. Pick a ready account that owns every game the offer sells (the same
//      readiness rules as the Eldorado listings: email + password saved, not
//      sold, not listed, inbox checked through the Mac mail proxy, no open
//      buyer mail page). It is written into the sale, THEN marked sold.
//   3. Mint its mail-page login (BuyerMailSession stage "sold", open
//      `sessionDays` from now; G2G asks account sellers for >= 14 days).
//   4. Move the order to "delivering" (start_deliver, mark_as_delivering) and
//      submit one CSV row per account in the form's field order.
//   5. Read the order back until G2G shows it delivered. G2G answers the
//      submit at once and checks it in a background job, so the answer alone
//      proves nothing (utils/marketplaces g2gSubmitOrderAccounts).
//
// The buyer receives: Account ID = the Epic login email, Password = the Epic
// password, the registration details we saved at sign-up, Account Email = the
// same email, Email Password = the MAIL PAGE password (never the Outlook one),
// and a note saying where that password works. G2G refuses a link with a path
// in the note ("URLs with paths are not supported"), so the note names the bare
// site and its front page carries the button to the mail page.
//
// Whatever it cannot finish pages the owner once per order with what to do; the
// order keeps its account, so a hand delivery uses the same one.

const bcrypt = require("bcrypt");

const EpicAccount = require("../models/EpicAccount");
const EpicSale = require("../models/EpicSale");
const EpicSalesState = require("../models/EpicSalesState");
const EpicG2gUnit = require("../models/EpicG2gUnit");
const BuyerMailSession = require("../models/BuyerMailSession");
const { encrypt, decrypt } = require("./secretBox");
const sales = require("./epicSales");
const mp = require("./marketplaces");

const DAY_MS = 24 * 60 * 60 * 1000;
const GAME_ACCOUNTS_SERVICE = "f6a1aba5-473a-4044-836a-8968bbab16d7";
const DEFAULT_DAYS = 14;
const MAX_QTY = 5; // a bigger order is unusual enough for a person to look at
const CONFIRM_POLLS = 9;
const CONFIRM_GAP_MS = Number(process.env.EPIC_G2G_CONFIRM_GAP_MS) || 5000;
const RESUBMIT_AFTER_MS = 10 * 60 * 1000;
const PAGE_AFTER_MS = 25 * 60 * 1000;
const REPAGE_MS = 3 * 60 * 60 * 1000;
const TEMPLATE_CACHE_MS = 6 * 60 * 60 * 1000;
const SWEEP_MS = Number(process.env.EPIC_G2G_SWEEP_MS) || 3 * 60 * 1000;
const SWEEP_AFTER_MS = 15 * 60 * 1000;
// Instant offers
const INSTANT_STUCK_MS = 15 * 60 * 1000;
const LOAD_CONFIRM_POLLS = 12;
const LOAD_PAGE_AFTER_MS = 20 * 60 * 1000;
const MAX_LOAD_PER_PASS = 50;
const SCAN_PAGES = 2;
const SCAN_STATUSES = ["preparing", "delivering", "completed"];

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.user = true;
  return e;
}

function dec(v) {
  try {
    return v ? String(decrypt(v) || "") : "";
  } catch {
    return "";
  }
}

function labelOf(acc) {
  return (acc && (acc.label || acc.displayName || acc.accountId)) || "";
}

async function notify(text) {
  try {
    await require("./telegram").sendTelegram(text);
  } catch (e) {
    console.error("[epicG2g] telegram:", (e && e.message) || e);
  }
}

function saleIdFor(orderItemId) {
  return "g2g:" + String(orderItemId || "");
}

// The bare site (G2G's note field takes no link with a path).
function siteUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/i.test(base) ? base : "";
}

// One order at a time per order id, inside this process.
const orderLocks = new Map();
function withOrderLock(id, fn) {
  const prev = orderLocks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  orderLocks.set(id, tail);
  tail.then(() => {
    if (orderLocks.get(id) === tail) orderLocks.delete(id);
  });
  return run;
}

// ---------------------------------------------------------------------------
// The account form -> one CSV row
// ---------------------------------------------------------------------------

// csv-string's stringify, which G2G's own page uses: a value holding a quote,
// CR, LF or the comma is wrapped in quotes with quotes doubled; CRLF ends it.
function csvField(v) {
  const s = v == null ? "" : String(v);
  return /["\r\n,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(values) {
  return values.map(csvField).join(",") + "\r\n";
}

function inputFields(template) {
  return (template || [])
    .filter((f) => f && f.input_field && (!f.form_content_type || f.form_content_type === "collection"))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (Number(a.f.sort_order) || 0) - (Number(b.f.sort_order) || 0) || a.i - b.i)
    .map((x) => x.f);
}

function fieldLabel(f) {
  return String((f && f.label && (f.label.en || Object.values(f.label).find(Boolean))) || "").trim();
}

// What we put in a field, read from its English label (and G2G's own key in
// `value`, e.g. "Game Account Registration Email Password"). Order matters:
// "Email Password" is a password too, and "Account Email" holds an "account".
function fieldKind(f) {
  const label = fieldLabel(f).toLowerCase();
  const key = String((f && f.value) || "").toLowerCase();
  const has = (re) => re.test(label) || re.test(key);
  if (has(/email\s*password/)) return "mailPassword";
  if (has(/account\s*email/) || label === "email") return "email";
  if (label === "account id" || /accountid/.test(key) || label === "login" || label === "username") return "login";
  if (label === "password" || (/password/.test(key) && !/email/.test(key))) return "password";
  if (has(/first\s*name/)) return "firstName";
  if (has(/last\s*name/)) return "lastName";
  if (has(/country/)) return "country";
  if (has(/date of birth|\bdob\b|birth/)) return "dob";
  if (has(/additional\s*note|\bnote\b/)) return "note";
  if (has(/character|secret\s*question|secret\s*answer/)) return "blank";
  return "";
}

// Refuse a form we cannot fill properly BEFORE an account is spent on it.
function checkTemplate(template) {
  const fields = inputFields(template);
  if (!fields.length) throw userError("G2G shows no account form for this game");
  const kinds = fields.map(fieldKind);
  for (let i = 0; i < fields.length; i++) {
    if (!kinds[i] && fields[i].is_required) {
      throw userError('G2G\'s account form asks for "' + fieldLabel(fields[i]) + '", which we do not know how to fill');
    }
  }
  for (const need of ["login", "password"]) {
    if (!kinds.includes(need)) throw userError("G2G's account form has no " + need + " field we recognise");
  }
  return fields;
}

function buildRow(template, data) {
  const fields = checkTemplate(template);
  const values = fields.map((f) => {
    const kind = fieldKind(f);
    const v = kind && kind !== "blank" ? String(data[kind] == null ? "" : data[kind]) : "";
    if (f.is_required && !v.trim()) {
      throw userError('G2G\'s account form needs "' + fieldLabel(f) + '" and this account has none');
    }
    return v;
  });
  return csvRow(values);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// "1998-03-05" -> "05 Mar 1998" for G2G's "%d %b %Y" (the strftime codes its
// date fields carry in input_settings.format).
function formatDate(iso, format) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return "";
  const fmt = String(format || "%d %b %Y");
  return fmt.replace(/%([dmbBYy])/g, (_, c) => {
    if (c === "d") return m[3];
    if (c === "m") return m[2];
    if (c === "b") return MONTHS[Number(m[2]) - 1] || "";
    if (c === "B") return MONTHS_LONG[Number(m[2]) - 1] || "";
    if (c === "Y") return m[1];
    return m[1].slice(2);
  });
}

function countryName(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return String(code || "").trim();
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(c) || c;
  } catch {
    return c;
  }
}

function noteText(days) {
  const site = siteUrl();
  return [
    "Email Password is NOT an Outlook password. It signs in to our mail page, which shows the emails Epic Games " +
      "sends to this account (security codes, verification) for " + days + " days.",
    "Mail page: " + site + " , press \"Epic account emails\", then sign in with Account Email + Email Password.",
    "Please change the account email to your own right after you log in (Epic Games > Account > Personal details). " +
      "Epic sends the code to the mail page. The mail page closes once the email is changed.",
  ].join("\n");
}

function profileOf(acc) {
  try {
    const raw = dec(acc && acc.accountDetails);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Everything one row needs. `mailPassword` comes from the sale's own session.
function rowData(acc, mailPassword, days, dobFormat) {
  const email = dec(acc.email).trim().toLowerCase();
  const p = profileOf(acc);
  return {
    login: email,
    password: dec(acc.password),
    email,
    mailPassword,
    firstName: String(p.firstName || "").trim(),
    lastName: String(p.lastName || "").trim(),
    country: countryName(p.country),
    dob: formatDate(p.dateOfBirth, dobFormat),
    note: noteText(days),
  };
}

const templateCache = new Map();
async function formTemplate(serviceId, brandId) {
  const k = serviceId + "|" + brandId;
  const hit = templateCache.get(k);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.value;
  const value = await mp.g2gFormTemplate(serviceId, brandId);
  templateCache.set(k, { at: Date.now(), value });
  return value;
}

function dobFormatOf(template) {
  const f = inputFields(template).find((x) => fieldKind(x) === "dob");
  return (f && f.input_settings && f.input_settings.format) || "%d %b %Y";
}

// ---------------------------------------------------------------------------
// Linked offers
// ---------------------------------------------------------------------------

// The linked offers. The G2G fulfiller asks this for EVERY order it sees, so a
// database that is not connected must not stall or fail the other products'
// orders: Mongoose would buffer the query for 10 s and then throw. The last
// list read is kept, so an Epic order is still recognised (and left alone)
// while the database is away.
let linkCache = { at: 0, list: [] };
function dbConnected() {
  return EpicSalesState.db && EpicSalesState.db.readyState === 1;
}
async function links() {
  if (!dbConnected()) {
    if (linkCache.at) return linkCache.list;
    const e = new Error("database not connected");
    e.dbDown = true;
    throw e;
  }
  const doc = await EpicSalesState.findById("main").lean();
  linkCache = { at: Date.now(), list: (doc && doc.g2gOffers) || [] };
  return linkCache.list;
}

async function linkFor(offerId) {
  const id = String(offerId || "");
  if (!id) return null;
  return (await links()).find((l) => String(l.offerId) === id) || null;
}

// How a G2G offer delivers: "order" = Manual delivery, we fill the account form
// on each paid order; "instant" = Auto delivery, G2G hands out the rows we
// loaded into its stock. Read off the offer each sweep, so switching it on
// g2g.com is all it takes.
function modeOf(offer) {
  const s = String((offer && offer.delivery_speed) || "").toLowerCase();
  if (s === "manual") return "order";
  if (s === "instant") return "instant";
  return "";
}

function ownsAll(titles, games) {
  const have = new Set((titles || []).map((t) => String(t).trim().toLowerCase()));
  return (games || []).every((g) => have.has(String(g).trim().toLowerCase()));
}

// Ready accounts for a link, the ones with the fewest extra games first (an
// account with more games is worth more on a listing that sells them), then
// the oldest.
async function readyAccounts(link, { fresh = true, ctx = null } = {}) {
  const c = ctx || (await sales.stockContext({ fresh }));
  const out = [];
  for (const a of c.accounts) {
    const r = sales.readinessOf(a, c);
    if (r.state !== "ready" || !ownsAll(r.titles, link.games)) continue;
    out.push({ acc: a, titles: r.titles, email: r.email });
  }
  out.sort(
    (x, y) => x.titles.length - y.titles.length || new Date(x.acc.createdAt) - new Date(y.acc.createdAt),
  );
  return { ctx: c, ready: out };
}

// How many accounts could go to this offer. An inbox the Mac proxy could not
// confirm right now still counts (the proxy being asleep is not the account's
// fault); the delivery itself always re-checks.
function stockCount(link, ctx) {
  let n = 0;
  for (const a of ctx.accounts) {
    const r = sales.readinessOf(a, ctx);
    const proxyOnly = r.state === "blocked" && r.inbox && r.inbox.code === "proxy" && r.blockers.length === 1;
    if ((r.state === "ready" || proxyOnly) && ownsAll(r.titles, link.games)) n++;
  }
  return n;
}

async function linkOffer(opts, actor) {
  const o = opts || {};
  const offerId = String(o.offerId || "").trim().toUpperCase();
  if (!/^G\d{10,}[A-Z0-9]{0,6}$/.test(offerId)) {
    throw userError("That isn't a G2G offer number. It starts with G, e.g. G1793242175124IO");
  }
  let games = Array.isArray(o.games) ? o.games.map((g) => String(g).trim()).filter(Boolean) : [];
  if (!games.length && o.gameKey) {
    const ctx = await sales.stockContext({ fresh: false });
    for (const a of ctx.accounts) {
      const titles = sales.gameTitles(a);
      if (sales.gameKey(titles) === String(o.gameKey)) {
        games = titles;
        break;
      }
    }
  }
  if (!games.length) throw userError("Pick the games every account delivered for this offer must own");
  let offer;
  try {
    offer = await mp.g2gGetOffer(offerId);
  } catch (e) {
    throw userError("G2G didn't return that offer: " + ((e && e.message) || e));
  }
  if (!offer || !(offer.offer_id || offer.service_id)) throw userError("G2G doesn't show offer " + offerId);
  if (String(offer.service_id) !== GAME_ACCOUNTS_SERVICE) {
    throw userError("That offer is not in G2G's Game Accounts category");
  }
  const mode = modeOf(offer);
  if (!mode) throw userError("G2G reports an unknown delivery setting for that offer (" + offer.delivery_speed + ")");
  checkTemplate(await formTemplate(offer.service_id, offer.brand_id));
  const days = Math.min(14, Math.max(1, Math.round(Number(o.sessionDays) || DEFAULT_DAYS)));
  const row = {
    offerId,
    mode,
    serviceId: String(offer.service_id),
    brandId: String(offer.brand_id || ""),
    relationId: String(offer.relation_id || ""),
    title: String(offer.title || o.title || "").slice(0, 200),
    games,
    gameKey: sales.gameKey(games),
    enabled: o.enabled !== false,
    sessionDays: days,
    syncStock: o.syncStock !== false,
    lastStockSyncAt: null,
    lastStock: null,
    linkedAt: new Date(),
    linkedBy: String(actor || ""),
  };
  await EpicSalesState.updateOne({ _id: "main" }, { $pull: { g2gOffers: { offerId } } }, { upsert: true });
  await EpicSalesState.updateOne({ _id: "main" }, { $push: { g2gOffers: row } }, { upsert: true });
  return row;
}

async function setLink(offerId, patch) {
  const id = String(offerId || "");
  const set = {};
  const p = patch || {};
  if (typeof p.enabled === "boolean") set["g2gOffers.$.enabled"] = p.enabled;
  if (typeof p.syncStock === "boolean") set["g2gOffers.$.syncStock"] = p.syncStock;
  if (p.sessionDays != null) {
    const d = Math.round(Number(p.sessionDays));
    if (!(d >= 1 && d <= 14)) throw userError("The mail page window must be 1 to 14 days");
    set["g2gOffers.$.sessionDays"] = d;
  }
  if (!Object.keys(set).length) throw userError("Nothing to change");
  const r = await EpicSalesState.updateOne({ _id: "main", "g2gOffers.offerId": id }, { $set: set });
  if (!r.matchedCount) throw userError("That G2G offer isn't linked", 404);
  return linkFor(id);
}

async function unlinkOffer(offerId) {
  const id = String(offerId || "");
  const stocked = await EpicG2gUnit.countDocuments({ offerId: id, state: { $in: ["loading", "listed"] } });
  if (stocked) {
    throw userError(
      stocked + " account(s) are in this offer's G2G stock, and their sales are only recorded while it is linked. " +
        "Switch the offer back to Manual delivery on G2G (it asks you to empty the stock first), then unlink.",
      409,
    );
  }
  const open = await EpicSale.countDocuments({
    market: "g2g",
    offerId: id,
    deliveredAt: null,
    releasedAt: null,
  });
  if (open) throw userError("An order on this offer is still being delivered. Unlink it after that order is done", 409);
  await EpicSalesState.updateOne({ _id: "main" }, { $pull: { g2gOffers: { offerId: id } } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Delivering one order
// ---------------------------------------------------------------------------

const paged = new Map(); // key -> last page time (things with no sale row yet)
const held = new Set(); // orders held after an error (also kept on the sale)
async function pageOnce(key, text) {
  const last = paged.get(key) || 0;
  if (Date.now() - last < REPAGE_MS) return;
  paged.set(key, Date.now());
  await notify(text);
}

async function pageSale(sale, why, todo) {
  const now = new Date();
  const fresh = await EpicSale.findOneAndUpdate(
    {
      _id: sale._id,
      $or: [{ alertedAt: null }, { alertedAt: { $lt: new Date(now.getTime() - REPAGE_MS) } }],
    },
    { $set: { alertedAt: now, needsAttention: true, note: String(why).slice(0, 500) } },
    { returnDocument: "after" },
  );
  if (!fresh) {
    await EpicSale.updateOne({ _id: sale._id }, { $set: { needsAttention: true, note: String(why).slice(0, 500) } });
    return;
  }
  const order = sale.orderId.replace(/^g2g:/, "");
  const names = (sale.accounts || []).map((a) => a.label).filter(Boolean).join(", ");
  await notify(
    "⚠️ G2G order " + order + " (Epic account" + (names ? ": " + names : "") + ") was NOT delivered automatically.\n\n" +
      "Why: " + why + "\n\n" + todo,
  );
}

const HAND_TODO =
  "To deliver it by hand: Epic accounts → Listings & sales → Sales → this order → “Show delivery details”, " +
  "then paste them into the account form on the G2G order page (never the chat). The account is already set " +
  "aside for this order.";

// G2G's own count of delivered units. A submitted account shows up in
// order_inventories first; it is not "delivered" until G2G counts it.
function deliveredCount(item) {
  return Number(item && item.delivered_qty) || 0;
}

function landedCount(item) {
  return Array.isArray(item && item.order_inventories) ? item.order_inventories.length : 0;
}

function cancelledOrRefunded(item) {
  const status = String((item && (item.order_item_status || item.status)) || "").toLowerCase();
  const refunded = Number(item && item.refunded_qty) || 0;
  return refunded > 0 || /cancel|refund/.test(status);
}

async function loadSale(id) {
  return EpicSale.findOne({ orderId: saleIdFor(id) });
}

async function openSale(order, link) {
  const id = String(order.orderItemId || "");
  const qty = Math.max(1, Number(order.purchasedQty) || 1);
  const existing = await loadSale(id);
  if (existing) return existing;
  try {
    return await EpicSale.create({
      market: "g2g",
      orderId: saleIdFor(id),
      offerId: String(order.offerId || link.offerId),
      title: String(order.title || link.title || "").slice(0, 300),
      priceUsd: Number(order.amount) || 0,
      quantity: qty,
      buyerUsername: String(order.buyerId || ""),
      orderState: "picking",
      orderCreatedAt: orderPlacedAt(order),
      matchedBy: "auto-delivery",
      accounts: [],
    });
  } catch (e) {
    if (e && e.code === 11000) return loadSale(id);
    throw e;
  }
}

function orderPlacedAt(order) {
  const raw = (order && order.raw) || {};
  for (const v of [raw.created_at, raw.payment_success_at]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12 && n < 4e12) return new Date(n);
  }
  const m = /^(\d{13})/.exec(String((order && order.orderItemId) || ""));
  return m ? new Date(Number(m[1])) : new Date();
}

// Name accounts in the sale until it holds `need`, each one marked sold right
// after it is written into the sale (and taken back out if someone else sold
// it in between). Returns the reloaded sale.
async function reserveAccounts(sale, link, need) {
  const already = (sale.accounts || []).map((a) => a.epicAccountId);
  if (already.length) {
    // A restart between "written into the sale" and "marked sold" leaves the
    // account unmarked; finish that first.
    await EpicAccount.updateMany({ _id: { $in: already }, sold: { $ne: true } }, { $set: { sold: true } });
  }
  let current = sale;
  if (already.length >= need) return current;
  const { ready } = await readyAccounts(link, { fresh: true });
  for (const cand of ready) {
    if ((current.accounts || []).length >= need) break;
    if ((current.accounts || []).some((a) => String(a.epicAccountId) === String(cand.acc._id))) continue;
    const pushed = await EpicSale.updateOne(
      { _id: current._id, "accounts.epicAccountId": { $ne: cand.acc._id } },
      { $push: { accounts: { epicAccountId: cand.acc._id, label: labelOf(cand.acc), login: cand.email } } },
    );
    if (!pushed.modifiedCount) continue;
    const marked = await EpicAccount.updateOne({ _id: cand.acc._id, sold: { $ne: true } }, { $set: { sold: true } });
    if (!marked.modifiedCount) {
      await EpicSale.updateOne({ _id: current._id }, { $pull: { accounts: { epicAccountId: cand.acc._id } } });
    }
    current = await EpicSale.findById(current._id);
  }
  return current;
}

async function ensureSessions(sale, days, now) {
  for (const a of sale.accounts || []) {
    if (a.sessionId) continue;
    const email = String(a.login || "").toLowerCase();
    await BuyerMailSession.updateMany(
      { inboxAddress: email, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { revokedAt: now, revokedReason: "replaced" } },
    );
    const password = sales.mintPassword();
    const row = await BuyerMailSession.create({
      epicAccountId: a.epicAccountId,
      inboxAddress: email,
      passwordHash: await bcrypt.hash(password, 10),
      // Kept until G2G shows the order delivered, so a retry sends the very
      // same row and "Show delivery details" can still show it.
      passwordEnc: encrypt(password),
      expiresAt: new Date(now.getTime() + days * DAY_MS),
      stage: "sold",
      soldAt: now,
      marketplace: "g2g",
      orderRef: sale.orderId.replace(/^g2g:/, ""),
      note: "G2G automatic delivery",
    });
    await EpicSale.updateOne(
      { _id: sale._id, "accounts.epicAccountId": a.epicAccountId },
      { $set: { "accounts.$.sessionId": row._id } },
    );
  }
  return EpicSale.findById(sale._id);
}

// The rows for a sale, exactly as G2G receives them.
async function rowsFor(sale, link) {
  const template = await formTemplate(link.serviceId || GAME_ACCOUNTS_SERVICE, link.brandId);
  const dobFormat = dobFormatOf(template);
  const days = Math.min(14, Math.max(1, Number(link.sessionDays) || DEFAULT_DAYS));
  const rows = [];
  for (const a of sale.accounts || []) {
    const acc = await EpicAccount.findById(a.epicAccountId).lean();
    if (!acc) throw userError("Account " + (a.label || a.epicAccountId) + " no longer exists");
    const session = a.sessionId ? await BuyerMailSession.findById(a.sessionId).lean() : null;
    const mailPassword = dec(session && session.passwordEnc);
    if (!mailPassword) throw userError("The mail-page password for " + (a.label || "an account") + " is gone");
    rows.push(buildRow(template, rowData(acc, mailPassword, days, dobFormat)));
  }
  return rows;
}

async function openForDelivery(id) {
  let item = await mp.g2gOrder(id);
  const status = () => String((item && item.order_item_status) || "").toLowerCase();
  const sub = () => String((item && item.seller_sub_status) || "").toLowerCase();
  if (status() === "preparing") {
    if (sub() === "to_deliver") await mp.g2gStartDeliver(id).catch(() => {});
    await mp.g2gMarkDelivering(id).catch(() => {});
    item = await mp.g2gOrder(id);
  }
  return item;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDelivered(id, qty) {
  let item = null;
  for (let i = 0; i < CONFIRM_POLLS; i++) {
    await sleep(CONFIRM_GAP_MS);
    try {
      item = await mp.g2gOrder(id);
    } catch {
      continue;
    }
    if (deliveredCount(item) >= qty) return { done: true, item };
  }
  return { done: false, item };
}

async function finishSale(sale, item) {
  const now = new Date();
  const done = await EpicSale.findOneAndUpdate(
    { _id: sale._id, deliveredAt: null },
    {
      $set: {
        deliveredAt: now,
        orderState: String((item && item.order_item_status) || "delivered"),
        needsAttention: false,
        note: "",
        lastCheckedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!done) return sale;
  const ids = (done.accounts || []).map((a) => a.sessionId).filter(Boolean);
  if (ids.length) await BuyerMailSession.updateMany({ _id: { $in: ids } }, { $set: { passwordEnc: "" } });
  const names = (done.accounts || []).map((a) => a.label).join(", ");
  const order = done.orderId.replace(/^g2g:/, "");
  if (!done.submittedAt) {
    // G2G shows it delivered, but not by us: someone filled the form by hand.
    await notify(
      "G2G order " + order + " now shows delivered, but not by the automatic delivery (it was done by hand). " +
        (names
          ? "Set aside for it and kept as sold: " + names + ". If a different account was handed over, " +
            "unmark " + names + " in Epic accounts → Claims."
          : "No account had been set aside for it."),
    );
    return done;
  }
  await notify(
    "✅ G2G order " + order + " delivered automatically: Epic account " + names +
      " ($" + (Number(done.priceUsd) || 0).toFixed(2) + "). The buyer has the login and the mail page.",
  );
  try {
    require("./systemLog")
      .logEvent({
        category: "marketplace",
        action: "epic_g2g_delivered",
        actor: "epic-g2g",
        subject: done.orderId,
        detail: "Epic account(s) " + names + " delivered on the G2G order page",
      })
      .catch(() => {});
  } catch {
    /* diagnostics only */
  }
  return done;
}

async function handleOrder(order, link, { dryRun }) {
  const id = String(order.orderItemId || "");
  const qty = Math.max(1, Number(order.purchasedQty) || 1);
  const out = (state) => ({ orderId: id, skipped: "Epic account order: " + state });

  if (link.mode === "instant") {
    // G2G hands out our stock by itself. A paid order still waiting here
    // means it could not (out of stock?): say so once it has waited a while.
    const waited = Date.now() - orderPlacedAt(order).getTime();
    if (waited > INSTANT_STUCK_MS) {
      await pageOnce(
        "stuck:" + id,
        "G2G order " + id + " on the Instant Epic offer has waited " + Math.round(waited / 60000) +
          " min and G2G has not handed out an account (out of stock?). Open the order on G2G and deliver or refund it.",
      );
    }
    return out("Instant offer: G2G delivers it from our stock");
  }

  if (!link.enabled) {
    await pageOnce(
      "off:" + id,
      "G2G order " + id + " is PAID: an Epic account (" + (order.title || link.title) + ").\n\n" +
        "Automatic delivery is switched OFF for this offer, so deliver it by hand: Epic accounts → Claims → " +
        "Deliver (G2G, this order number, 14 days), then the account form on the G2G order page.",
    );
    return out("automatic delivery is off for this offer");
  }
  if (qty > MAX_QTY) {
    await pageOnce(
      "qty:" + id,
      "G2G order " + id + " bought " + qty + " Epic accounts at once. That is unusual, so it was left for you: " +
        "deliver it by hand or refund it.",
    );
    return out("quantity " + qty + " left for the owner");
  }

  let sale = await loadSale(id);
  if (held.has(id) || (sale && sale.held)) {
    return out("held for the owner after an error (nothing is sent by itself)");
  }
  if (sale && sale.deliveredAt) {
    // Delivered but G2G still lists it as waiting: say so once, change nothing.
    await pageOnce(
      "stale:" + id,
      "G2G order " + id + " still shows as waiting although its Epic account was delivered at " +
        sale.deliveredAt.toISOString() + ". Check the order page; nothing else was sent.",
    );
    return out("already delivered");
  }
  if (sale && sale.releasedAt) return out("cancelled earlier, its account went back on the shelf");

  // Submitted before: did it land?
  if (sale && sale.submittedAt) {
    let item = null;
    try {
      item = await mp.g2gOrder(id);
    } catch (e) {
      return out("could not read the order (" + ((e && e.message) || e) + ")");
    }
    if (deliveredCount(item) >= qty) {
      await finishSale(sale, item);
      return { orderId: id, delivered: qty, source: "epic-g2g" };
    }
    const since = Date.now() - new Date(sale.submittedAt).getTime();
    if (landedCount(item) >= qty) {
      // The account is on the order but G2G has not counted it: never send it
      // again (it is there); ask a person to look if that lasts.
      if (since >= PAGE_AFTER_MS) {
        await pageSale(
          sale,
          "G2G shows the account on the order but has not marked the order delivered",
          "Open the order on G2G and check it shows the account. Nothing more is sent by itself.",
        );
      }
      return out("the account is on the order, waiting for G2G to count it");
    }
    if (since < RESUBMIT_AFTER_MS) return out("waiting for G2G to accept the account");
    if (sale.submitCount >= 2) {
      if (since >= PAGE_AFTER_MS - RESUBMIT_AFTER_MS) {
        await pageSale(
          sale,
          "the account form was sent to G2G twice but the order still does not show it delivered",
          "Open the order on G2G. If the account shows there, nothing to do. If not: " + HAND_TODO,
        );
      }
      return out("G2G has not accepted the account yet");
    }
    // One more try with the very same rows: G2G keeps Account ID unique, so a
    // first submission that did land cannot be doubled by this one.
  }

  if (dryRun) return out("dry run (would deliver an account now)");

  sale = await openSale(order, link);
  sale = await reserveAccounts(sale, link, qty);
  if ((sale.accounts || []).length < qty) {
    const { ctx } = await readyAccounts(link, { fresh: false });
    const proxyDown = [...ctx.checks.values()].some((c) => c && c.error);
    await pageSale(
      sale,
      (proxyDown
        ? "the Mac mail proxy is not answering, so no account's mail page can be confirmed"
        : "no account that owns " + link.games.join(" + ") + " is ready") +
        " (" + (sale.accounts || []).length + " of " + qty + " set aside)",
      proxyDown
        ? "Wake the Mac (the mail proxy runs there). Delivery is retried every minute and goes out by itself once it answers."
        : "Refund the order on G2G, or add a ready account and it goes out on the next minute.",
    );
    return out("waiting for a ready account");
  }

  const days = Math.min(14, Math.max(1, Number(link.sessionDays) || DEFAULT_DAYS));
  sale = await ensureSessions(sale, days, new Date());

  let rows;
  try {
    rows = await rowsFor(sale, link);
  } catch (e) {
    await pageSale(sale, (e && e.message) || String(e), HAND_TODO);
    return out("could not build the account form");
  }

  let item;
  try {
    item = await openForDelivery(id);
  } catch (e) {
    return out("could not open the order for delivery (" + ((e && e.message) || e) + ")");
  }
  if (cancelledOrRefunded(item)) {
    await releaseSale(sale, "order " + String(item.order_item_status || "cancelled"));
    return out("the order was cancelled before delivery");
  }
  if (deliveredCount(item) >= qty) {
    await finishSale(sale, item);
    return { orderId: id, delivered: qty, source: "epic-g2g" };
  }
  if (landedCount(item) >= qty) {
    // Accounts already on the order (filled in by hand?): send nothing more.
    return out("accounts are already on the order, waiting for G2G to count them");
  }
  const status = String((item && item.order_item_status) || "").toLowerCase();
  if (status && status !== "delivering") {
    if (Date.now() - new Date(sale.createdAt).getTime() > PAGE_AFTER_MS) {
      await pageSale(sale, "G2G would not move the order to delivering (it says “" + status + "”)", HAND_TODO);
    }
    return out("the order is “" + status + "”, not open for delivery yet");
  }

  try {
    await mp.g2gSubmitOrderAccounts(id, rows);
  } catch (e) {
    await EpicSale.updateOne({ _id: sale._id }, { $set: { note: "submit failed: " + String((e && e.message) || e).slice(0, 300) } });
    if (Date.now() - new Date(sale.createdAt).getTime() > PAGE_AFTER_MS) {
      await pageSale(sale, "G2G refused the account form: " + ((e && e.message) || e), HAND_TODO);
    }
    return out("submit failed, retried next minute");
  }
  await EpicSale.updateOne(
    { _id: sale._id },
    { $set: { submittedAt: new Date(), orderState: "submitted", note: "" }, $inc: { submitCount: 1 } },
  );

  const res = await waitDelivered(id, qty);
  if (res.done) {
    await finishSale(sale, res.item);
    return { orderId: id, delivered: qty, source: "epic-g2g" };
  }
  return out("submitted, waiting for G2G to confirm");
}

// The fulfiller's entry point. null = not an Epic account offer (the order
// goes on to the fulfiller's other paths). Never throws for an order it owns.
async function deliverOrder(order, { dryRun = false } = {}) {
  let link;
  try {
    link = await linkFor(order && order.offerId);
  } catch (e) {
    if (e && e.dbDown) return null; // never seen a link: not knowably ours
    throw e;
  }
  if (!link) return null;
  const id = String(order.orderItemId || "");
  if (!dbConnected()) {
    // Ours, but nothing can be set aside or recorded now: no page (that would
    // invite a hand delivery the next minute might double). Retried each tick.
    return { orderId: id, skipped: "Epic account order: database unavailable, retried next minute" };
  }
  return withOrderLock(id, async () => {
    try {
      return await handleOrder(order, link, { dryRun });
    } catch (e) {
      console.error("[epicG2g] order " + id + ":", (e && e.stack) || e);
      // The owner is told to deliver it by hand, so this order must never go
      // out by itself afterwards (that could hand over a second account).
      held.add(id);
      await EpicSale.updateOne(
        { orderId: saleIdFor(id), deliveredAt: null },
        { $set: { held: true, needsAttention: true, note: "held after an error: " + String((e && e.message) || e).slice(0, 300) } },
      ).catch(() => {});
      await pageOnce(
        "crash:" + id,
        "⚠️ G2G order " + id + " (Epic account) hit an error in automatic delivery, so it is held for you: " +
          String((e && e.message) || e).slice(0, 300) + "\n\n" + HAND_TODO +
          " (If no account was set aside yet, use Epic accounts → Claims → Deliver with G2G and this order number.)",
      );
      return { orderId: id, skipped: "Epic account order: error, held for the owner" };
    }
  });
}

// ---------------------------------------------------------------------------
// After the order: cancellations, proofs, the offer's stock number
// ---------------------------------------------------------------------------

async function releaseSale(sale, why) {
  const now = new Date();
  const r = await EpicSale.findOneAndUpdate(
    { _id: sale._id, deliveredAt: null, releasedAt: null },
    { $set: { releasedAt: now, orderState: "cancelled", needsAttention: false, note: String(why).slice(0, 300) } },
    { returnDocument: "after" },
  );
  if (!r) return false;
  const accIds = (r.accounts || []).map((a) => a.epicAccountId).filter(Boolean);
  const sessIds = (r.accounts || []).map((a) => a.sessionId).filter(Boolean);
  if (accIds.length) await EpicAccount.updateMany({ _id: { $in: accIds } }, { $set: { sold: false } });
  if (sessIds.length) {
    await BuyerMailSession.updateMany(
      { _id: { $in: sessIds }, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: "refunded", passwordEnc: "" } },
    );
  }
  await notify(
    "G2G order " + r.orderId.replace(/^g2g:/, "") + " was cancelled before its Epic account was delivered (" + why +
      "). " + ((r.accounts || []).map((a) => a.label).join(", ") || "No account") + " is back on the shelf.",
  );
  return true;
}

// For utils/g2gFulfiller's delivery-proof sweep: an Epic order we delivered.
async function proofFor(orderItemId) {
  if (!dbConnected()) return null;
  const sale = await EpicSale.findOne({ orderId: saleIdFor(orderItemId), market: "g2g", deliveredAt: { $ne: null } }).lean();
  if (!sale) return null;
  const instant = sale.matchedBy === "g2g-stock";
  return {
    listing: null,
    units: [],
    accounts: (sale.accounts || []).length || 1,
    sentAt: sale.deliveredAt,
    method: instant ? "Delivered instantly by G2G from the offer's stock" : "Submitted in the account form on the G2G order page",
    banner: instant
      ? "G2G delivered the Epic Games account details to the buyer from this offer's stock at the moment of payment."
      : "The Epic Games account details were submitted in the account form on the G2G order page for this order.",
  };
}

// ---------------------------------------------------------------------------
// Instant offers: our accounts inside G2G's own stock
// ---------------------------------------------------------------------------

const keyLocks = new Map();
function withKeyLock(key, fn) {
  const prev = keyLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  keyLocks.set(key, tail);
  tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

function sessionDaysOf(link) {
  return Math.min(14, Math.max(1, Number(link && link.sessionDays) || DEFAULT_DAYS));
}

// What G2G says is in this offer's stock, from both places it says it: the
// stock stats (null = no stock was ever loaded, or the read failed) and the
// offer's own quantity (which can still hold the old Manual number right after
// the switch, so it only counts when it moves).
async function stockCounts(offerId, offer) {
  const stats = await mp.g2gStockStats(offerId).catch(() => null);
  const s = stats && Number.isFinite(Number(stats.active_inventory)) ? Number(stats.active_inventory) : null;
  let o = offer;
  if (!o) o = await mp.g2gGetOffer(offerId).catch(() => null);
  const q = o ? Number(o.actual_qty != null ? o.actual_qty : o.available_qty) : NaN;
  return { stats: s, qty: Number.isFinite(q) ? q : null };
}

function grewBy(before, after, n) {
  if (after.stats != null && after.stats >= (before.stats || 0) + n) return true;
  return after.qty != null && before.qty != null && after.qty >= before.qty + n;
}

function countOf(c) {
  return c.stats != null ? c.stats : c.qty;
}

// The link with its mode as G2G shows it now (switching the offer on g2g.com
// is all it takes). Returns [link, offer].
async function refreshMode(link) {
  const offer = await mp.g2gGetOffer(link.offerId);
  const mode = modeOf(offer);
  if (mode && mode !== (link.mode || "order")) {
    await EpicSalesState.updateOne({ _id: "main", "g2gOffers.offerId": link.offerId }, { $set: { "g2gOffers.$.mode": mode } });
    let released = 0;
    if (mode === "order") released = await releaseStock(link, "offer switched back to Manual delivery on G2G");
    await notify(
      mode === "instant"
        ? "G2G offer " + link.offerId + " is on Auto delivery (Instant) now. Its ready Epic accounts are being loaded into its G2G stock."
        : "G2G offer " + link.offerId + " is back on Manual delivery: each order is filled in by the server again." +
            (released ? " " + released + " account(s) that were in its G2G stock are back on the shelf." : ""),
    );
    return [{ ...link, mode }, offer, { changed: true, released }];
  }
  return [link, offer, { changed: false, released: 0 }];
}

function refOf(inv) {
  return String((inv && (inv.upload_reference || inv.account_id || inv.reference)) || "").trim().toLowerCase();
}

async function mintStockSession(acc, email, offerId) {
  const now = new Date();
  const password = sales.mintPassword();
  const row = await BuyerMailSession.create({
    epicAccountId: acc._id,
    inboxAddress: email,
    passwordHash: await bcrypt.hash(password, 10),
    // Kept while the row waits in G2G's stock, so it can be sent again.
    passwordEnc: encrypt(password),
    // No clock until it sells (the sale scan sets soldAt + sessionDays).
    expiresAt: new Date(now.getTime() + 365 * DAY_MS),
    stage: "listed",
    marketplace: "g2g",
    note: "G2G stock " + offerId,
  });
  return { row, password };
}

const formFailures = new Map(); // accountId -> time (skip for a while)

// Load every ready account that owns the offer's games into its G2G stock.
// Units sent earlier and not yet confirmed are checked first; units whose
// upload never went out are sent again.
async function loadStock(link, { offer = null } = {}) {
  if (!link || link.mode !== "instant") return { skipped: "not an Instant offer" };
  if (link.enabled === false) return { skipped: "automatic delivery is off for this offer" };
  return withKeyLock("load:" + link.offerId, async () => {
    const o = offer || (await mp.g2gGetOffer(link.offerId));
    if (modeOf(o) !== "instant") return { skipped: "the offer is not on Auto delivery on G2G" };
    const confirmed = await confirmLoading(link, o);

    const { ready: cached } = await readyAccounts(link, { fresh: false });
    let candidates = cached.filter((c) => !(Date.now() - (formFailures.get(String(c.acc._id)) || 0) < 6 * 3600 * 1000));
    if (candidates.length) {
      // Re-check the inboxes for real before anything goes into G2G's stock.
      const { ready } = await readyAccounts(link, { fresh: true });
      const ok = new Set(ready.map((r) => String(r.acc._id)));
      candidates = candidates.filter((c) => ok.has(String(c.acc._id)));
    }
    const retry = await EpicG2gUnit.find({ offerId: link.offerId, state: "loading", uploadedAt: null });
    if (!candidates.length && !retry.length) return { loaded: 0, confirmed };

    const template = await formTemplate(link.serviceId || GAME_ACCOUNTS_SERVICE, link.brandId);
    const dobFormat = dobFormatOf(template);
    const days = sessionDaysOf(link);
    const rows = [];
    const unitIds = [];
    const addRow = async (unit, acc, password) => {
      try {
        rows.push(buildRow(template, rowData(acc, password, days, dobFormat)));
        unitIds.push(unit._id);
      } catch (e) {
        formFailures.set(String(acc._id), Date.now());
        await EpicG2gUnit.updateOne(
          { _id: unit._id },
          { $set: { state: "removed", removedAt: new Date(), removedReason: "form: " + String(e.message || e).slice(0, 200) } },
        );
        if (unit.sessionId) {
          await BuyerMailSession.updateOne({ _id: unit.sessionId }, { $set: { revokedAt: new Date(), revokedReason: "unlisted", passwordEnc: "" } });
        }
      }
    };
    for (const u of retry) {
      const acc = await EpicAccount.findById(u.epicAccountId).lean();
      const s = u.sessionId ? await BuyerMailSession.findById(u.sessionId).lean() : null;
      const pw = dec(s && s.passwordEnc);
      if (acc && pw) await addRow(u, acc, pw);
    }
    for (const cand of candidates.slice(0, MAX_LOAD_PER_PASS)) {
      let unit;
      try {
        unit = await EpicG2gUnit.create({
          offerId: link.offerId,
          epicAccountId: cand.acc._id,
          login: cand.email,
          label: labelOf(cand.acc),
          state: "loading",
        });
      } catch (e) {
        if (e && e.code === 11000) continue; // already in some G2G stock
        throw e;
      }
      const { row, password } = await mintStockSession(cand.acc, cand.email, link.offerId);
      await EpicG2gUnit.updateOne({ _id: unit._id }, { $set: { sessionId: row._id } });
      unit.sessionId = row._id;
      await addRow(unit, cand.acc, password);
    }
    if (!rows.length) return { loaded: 0, confirmed };

    const before = await stockCounts(link.offerId, o).catch(() => ({ stats: null, qty: null }));
    await mp.g2gUploadStock(o, rows.join(""));
    await EpicG2gUnit.updateMany({ _id: { $in: unitIds } }, { $set: { uploadedAt: new Date() } });
    await EpicSalesState.updateOne(
      { _id: "main", "g2gOffers.offerId": link.offerId },
      { $set: { "g2gOffers.$.lastStockLoadAt": new Date() } },
    );
    // G2G imports in the background: watch the stock number grow.
    for (let i = 0; i < LOAD_CONFIRM_POLLS; i++) {
      await sleep(CONFIRM_GAP_MS);
      const after = await stockCounts(link.offerId).catch(() => null);
      if (after && grewBy(before, after, rows.length)) {
        const n = countOf(after);
        await EpicG2gUnit.updateMany({ _id: { $in: unitIds }, state: "loading" }, { $set: { state: "listed", listedAt: new Date() } });
        await recordStock(link.offerId, n);
        await notify(
          "G2G Instant offer " + link.offerId + ": " + rows.length + " Epic account" + (rows.length > 1 ? "s" : "") +
            " loaded into its stock (" + n + " in stock now). Buyers get them the moment they pay.",
        );
        return { loaded: rows.length, confirmed: true, stock: n };
      }
    }
    return { loaded: rows.length, confirmed: false };
  });
}

async function recordStock(offerId, n) {
  await EpicSalesState.updateOne(
    { _id: "main", "g2gOffers.offerId": offerId },
    { $set: { "g2gOffers.$.lastStock": n, "g2gOffers.$.lastStockSyncAt": new Date() } },
  );
}

// Units sent to G2G but not seen in its stock yet: G2G's stock count says
// whether they all landed (sold ones are already moved out by the sale scan).
async function confirmLoading(link, offer) {
  const loading = await EpicG2gUnit.find({ offerId: link.offerId, state: "loading", uploadedAt: { $ne: null } }).lean();
  if (!loading.length) return 0;
  const listed = await EpicG2gUnit.countDocuments({ offerId: link.offerId, state: "listed" });
  const c = await stockCounts(link.offerId, offer).catch(() => null);
  // Only G2G's stock stats can confirm here: the offer's quantity may still be
  // the old Manual number and would "confirm" rows G2G never took.
  const n = c ? c.stats : null;
  if (n != null && n >= listed + loading.length) {
    await EpicG2gUnit.updateMany({ _id: { $in: loading.map((u) => u._id) }, state: "loading" }, { $set: { state: "listed", listedAt: new Date() } });
    await recordStock(link.offerId, n);
    return loading.length;
  }
  const oldest = Math.min(...loading.map((u) => new Date(u.uploadedAt).getTime()));
  if (Date.now() - oldest > LOAD_PAGE_AFTER_MS) {
    await pageOnce(
      "load:" + link.offerId,
      "⚠️ G2G Instant offer " + link.offerId + ": " + loading.length + " Epic account(s) were sent to its stock " +
        Math.round((Date.now() - oldest) / 60000) + " min ago, but G2G shows " + (n == null ? "no stock count" : n + " in stock") + " (expected " +
        (listed + loading.length) + "). Open the offer's stock on G2G and check what it took. Those accounts stay " +
        "set aside meanwhile, so nothing is sold twice.",
    );
  }
  return 0;
}

// Orders on an Instant offer never wait for us: G2G delivered them already.
// Each one says which stock row went out (Account ID = the Epic email).
async function scanInstantSales(link) {
  if (!link || link.mode !== "instant") return { skipped: "not an Instant offer" };
  return withKeyLock("scan:" + link.offerId, async () => {
    const since = link.linkedAt ? new Date(link.linkedAt).getTime() - DAY_MS : Date.now() - 7 * DAY_MS;
    const seen = new Map();
    for (const status of SCAN_STATUSES) {
      for (let page = 1; page <= SCAN_PAGES; page++) {
        let rows;
        try {
          rows = await mp.g2gOrders({ page, pageSize: 30, status });
        } catch {
          break;
        }
        for (const o of rows || []) if (String(o.offerId) === String(link.offerId)) seen.set(String(o.orderItemId), o);
        if (!rows || rows.length < 30) break;
      }
    }
    let recorded = 0;
    for (const order of seen.values()) {
      if (orderPlacedAt(order).getTime() < since) continue;
      if (await EpicSale.exists({ orderId: saleIdFor(order.orderItemId) })) continue;
      if (await recordInstantOrder(link, order)) recorded++;
    }
    await EpicSalesState.updateOne(
      { _id: "main", "g2gOffers.offerId": link.offerId },
      { $set: { "g2gOffers.$.lastSaleScanAt": new Date() } },
    );
    return { orders: seen.size, recorded };
  });
}

async function recordInstantOrder(link, order) {
  const id = String(order.orderItemId || "");
  let item;
  try {
    item = await mp.g2gOrder(id);
  } catch {
    return false;
  }
  const refs = [...new Set((Array.isArray(item && item.order_inventories) ? item.order_inventories : []).map(refOf).filter(Boolean))];
  if (!refs.length) {
    if (cancelledOrRefunded(item)) return false; // nothing was handed out
    if (Date.now() - orderPlacedAt(order).getTime() > INSTANT_STUCK_MS) {
      await pageOnce(
        "noref:" + id,
        "G2G order " + id + " on the Instant Epic offer shows no delivered Account ID after " +
          Math.round((Date.now() - orderPlacedAt(order).getTime()) / 60000) + " min. Open the order on G2G: if it shows an " +
          "Account ID, tell me which; if not, deliver or refund it there.",
      );
    }
    return false;
  }
  const units = await EpicG2gUnit.find({ offerId: link.offerId, login: { $in: refs } });
  const byLogin = new Map();
  for (const u of units) {
    const cur = byLogin.get(u.login);
    // Prefer the live unit when an account was loaded more than once.
    if (!cur || (cur.state !== "listed" && cur.state !== "loading")) byLogin.set(u.login, u);
  }
  const matched = refs.map((r) => byLogin.get(r)).filter(Boolean);
  const unknown = refs.filter((r) => !byLogin.has(r));
  const placed = orderPlacedAt(order);
  const days = sessionDaysOf(link);
  let sale;
  try {
    sale = await EpicSale.create({
      market: "g2g",
      orderId: saleIdFor(id),
      offerId: String(link.offerId),
      title: String(order.title || link.title || "").slice(0, 300),
      priceUsd: Number(order.amount) || 0,
      quantity: Math.max(1, Number(order.purchasedQty) || refs.length),
      buyerUsername: String(order.buyerId || ""),
      orderState: String((item && item.order_item_status) || ""),
      orderCreatedAt: placed,
      matchedBy: "g2g-stock",
      deliveredAt: placed,
      accounts: matched.map((u) => ({ epicAccountId: u.epicAccountId, sessionId: u.sessionId, label: u.label, login: u.login })),
      needsAttention: unknown.length > 0,
      note: unknown.length ? "G2G handed out Account ID(s) we have no record of: " + unknown.join(", ") : "",
    });
  } catch (e) {
    if (e && e.code === 11000) return false;
    throw e;
  }
  const flagged = matched.filter((u) => u.state === "removed");
  for (const u of matched) {
    await EpicG2gUnit.updateOne({ _id: u._id }, { $set: { state: "sold", soldAt: placed, orderId: id } });
    await EpicAccount.updateOne({ _id: u.epicAccountId }, { $set: { sold: true } });
    if (u.sessionId) {
      // The stored login becomes the buyer's: open `days` from the purchase.
      // One already closed (the buyer changed the email first) stays closed.
      await BuyerMailSession.updateOne(
        { _id: u.sessionId },
        {
          $set: {
            stage: "sold",
            soldAt: placed,
            expiresAt: new Date(placed.getTime() + days * DAY_MS),
            passwordEnc: "",
            orderRef: id,
          },
        },
      );
    }
  }
  const names = matched.map((u) => u.label).join(", ");
  await notify(
    "✅ G2G sold instantly: Epic account " + (names || "?") + " ($" + (Number(order.amount) || 0).toFixed(2) +
      ", order " + id + "). G2G gave the buyer the login; the mail page is open " + days + " days from the purchase.",
  );
  if (unknown.length || flagged.length) {
    await notify(
      "⚠️ G2G order " + id + " needs a look: " +
        (unknown.length ? "it handed out Account ID(s) we have no record of (" + unknown.join(", ") + "). " : "") +
        (flagged.length ? "It sold " + flagged.map((u) => u.label).join(", ") + ", which had been flagged (" + flagged.map((u) => u.removedReason).join("; ") + "). " : "") +
        "Check the order on G2G.",
    );
  }
  try {
    require("./systemLog")
      .logEvent({ category: "marketplace", action: "epic_g2g_instant_sale", actor: "epic-g2g", subject: sale.orderId, detail: "Epic account(s) " + names + " sold from G2G stock" })
      .catch(() => {});
  } catch {
    /* diagnostics only */
  }
  return true;
}

// The watcher closed a stored (still unsold) login because Epic says the email
// changed. Either a buyer got it and the scan has not caught up, or someone
// else is in the account.
async function onStockEmailChanged(rows) {
  for (const r of rows || []) {
    const unit = await EpicG2gUnit.findOne({ sessionId: r.id });
    if (!unit) continue;
    const link = await linkFor(unit.offerId);
    if (link) await scanInstantSales(link).catch(() => {});
    const fresh = await EpicG2gUnit.findById(unit._id).lean();
    if (!fresh || fresh.state === "sold") continue; // a buyer: normal
    const r2 = await EpicG2gUnit.updateOne(
      { _id: unit._id, state: { $in: ["loading", "listed"] } },
      { $set: { state: "removed", removedAt: new Date(), removedReason: "email changed with no G2G order" } },
    );
    if (!r2.modifiedCount) continue;
    // Out of every sale path until a person has looked.
    await EpicAccount.updateOne({ _id: unit.epicAccountId }, { $set: { sold: true } });
    await notify(
      "⚠️ Epic account " + unit.label + " in the G2G stock of offer " + unit.offerId + " had its email changed, and no G2G " +
        "order shows it sold. Someone else may be in this account.\n\nRemove it from G2G's stock so nobody buys it: g2g.com → " +
        "Manage offer → this offer → Manage stock → search Account ID " + unit.login + " → delete (G2G asks for your " +
        "6-digit code). It is marked sold here so nothing else sells it.",
    );
  }
}

// The offer left Instant on G2G (back to Manual): G2G only allows that once
// its stock is empty, so our stored rows are gone. Put the accounts back.
async function releaseStock(link, why) {
  const units = await EpicG2gUnit.find({ offerId: link.offerId, state: { $in: ["loading", "listed"] } });
  if (!units.length) return 0;
  const now = new Date();
  await EpicG2gUnit.updateMany(
    { _id: { $in: units.map((u) => u._id) } },
    { $set: { state: "removed", removedAt: now, removedReason: why } },
  );
  const sess = units.map((u) => u.sessionId).filter(Boolean);
  if (sess.length) {
    await BuyerMailSession.updateMany(
      { _id: { $in: sess }, revokedAt: null, stage: "listed" },
      { $set: { revokedAt: now, revokedReason: "unlisted", passwordEnc: "" } },
    );
  }
  return units.length;
}

// The details of a sale for a hand delivery (or a buyer who asks again).
async function deliveryDetails(orderId) {
  const key = String(orderId || "").startsWith("g2g:") ? String(orderId) : saleIdFor(orderId);
  const sale = await EpicSale.findOne({ orderId: key, market: "g2g" });
  if (!sale) throw userError("Sale not found", 404);
  if (!(sale.accounts || []).length) throw userError("No account is set aside for this order yet");
  const link = (await linkFor(sale.offerId)) || { sessionDays: DEFAULT_DAYS, serviceId: GAME_ACCOUNTS_SERVICE };
  const days = Math.min(14, Math.max(1, Number(link.sessionDays) || DEFAULT_DAYS));
  const out = [];
  let now = new Date();
  for (const a of sale.accounts) {
    const acc = await EpicAccount.findById(a.epicAccountId).lean();
    if (!acc) continue;
    let session = a.sessionId ? await BuyerMailSession.findById(a.sessionId).lean() : null;
    let mailPassword = dec(session && session.passwordEnc);
    if (!mailPassword) {
      // Delivered already (password cleared) or never minted: a fresh login for
      // the mail page; the old one stops working.
      const email = String(a.login || dec(acc.email)).toLowerCase();
      await BuyerMailSession.updateMany(
        { inboxAddress: email, revokedAt: null, expiresAt: { $gt: now } },
        { $set: { revokedAt: now, revokedReason: "replaced" } },
      );
      mailPassword = sales.mintPassword();
      const soldAt = (session && session.soldAt) || now;
      const expiresAt = new Date(Math.max(now.getTime() + DAY_MS, new Date(soldAt).getTime() + days * DAY_MS));
      session = await BuyerMailSession.create({
        epicAccountId: acc._id,
        inboxAddress: email,
        passwordHash: await bcrypt.hash(mailPassword, 10),
        passwordEnc: sale.deliveredAt ? "" : encrypt(mailPassword),
        expiresAt,
        stage: "sold",
        soldAt,
        marketplace: "g2g",
        orderRef: sale.orderId.replace(/^g2g:/, ""),
        note: "delivery details shown to the owner",
      });
      await EpicSale.updateOne(
        { _id: sale._id, "accounts.epicAccountId": a.epicAccountId },
        { $set: { "accounts.$.sessionId": session._id } },
      );
    }
    const d = rowData(acc, mailPassword, days, "%d %b %Y");
    out.push({
      label: a.label,
      fields: [
        ["Account ID", d.login],
        ["Password", d.password],
        ["First Name", d.firstName],
        ["Last Name", d.lastName],
        ["Account Country", d.country],
        ["Date of Birth", d.dob],
        ["Account Email", d.email],
        ["Email Password", mailPassword],
        ["Additional Note", d.note],
      ],
      mailPageOpenUntil: session.expiresAt,
    });
  }
  return { orderId: sale.orderId.replace(/^g2g:/, ""), delivered: !!sale.deliveredAt, accounts: out };
}

let sweeping = false;
async function sweep({ now = Date.now() } = {}) {
  if (sweeping) return { skipped: "busy" };
  sweeping = true;
  const notes = [];
  try {
    // Orders set aside but not delivered for a while: cancelled? delivered?
    const open = await EpicSale.find({
      market: "g2g",
      deliveredAt: null,
      releasedAt: null,
      createdAt: { $lt: new Date(now - SWEEP_AFTER_MS) },
    });
    for (const sale of open) {
      const id = sale.orderId.replace(/^g2g:/, "");
      let item;
      try {
        item = await mp.g2gOrder(id);
      } catch (e) {
        notes.push(id + ": unreadable");
        continue;
      }
      if (cancelledOrRefunded(item)) {
        if (await releaseSale(sale, "order " + String(item.order_item_status || "cancelled"))) notes.push(id + ": released");
      } else if (deliveredCount(item) >= (sale.quantity || 1)) {
        await finishSale(sale, item);
        notes.push(id + ": delivered");
      }
    }
    const all = await links();
    let ctx = null;
    for (const stored of all) {
      // Switching the offer between Manual and Auto delivery on g2g.com is
      // all it takes: follow it.
      let link;
      let offer;
      try {
        let info;
        [link, offer, info] = await refreshMode(stored);
        if (info.changed) notes.push(link.offerId + ": now " + link.mode + (info.released ? ", " + info.released + " stock account(s) back on the shelf" : ""));
      } catch (e) {
        notes.push(stored.offerId + ": offer unreadable");
        continue;
      }
      if (!offer) continue;
      if (link.mode === "instant") {
        // Sales first (they move sold rows out of the stock count), then stock.
        try {
          const s = await scanInstantSales(link);
          if (s && s.recorded) notes.push(link.offerId + ": " + s.recorded + " instant sale(s)");
        } catch (e) {
          notes.push(link.offerId + ": sale scan failed (" + ((e && e.message) || e) + ")");
        }
        if (link.enabled !== false) {
          try {
            const r = await loadStock(link, { offer });
            if (r && r.loaded) notes.push(link.offerId + ": loaded " + r.loaded + (r.confirmed ? "" : " (not confirmed yet)"));
          } catch (e) {
            notes.push(link.offerId + ": stock load failed (" + ((e && e.message) || e) + ")");
          }
        }
        continue;
      }
      // Manual offers: the stock number follows the accounts ready for it,
      // never while one of its orders is being delivered.
      if (link.syncStock === false) continue;
      {
        const busy = await EpicSale.countDocuments({ market: "g2g", offerId: link.offerId, deliveredAt: null, releasedAt: null });
        if (busy) continue;
        if (!ctx) ctx = await sales.stockContext({ fresh: false });
        const want = stockCount(link, ctx);
        if (Number(offer.reserved_qty) > 0) continue;
        const have = Number(offer.actual_qty);
        if (Number.isFinite(have) && have !== want) {
          try {
            await mp.g2gSetQuantity(link.offerId, want);
            notes.push(link.offerId + ": stock " + have + " -> " + want);
            await EpicSalesState.updateOne(
              { _id: "main", "g2gOffers.offerId": link.offerId },
              { $set: { "g2gOffers.$.lastStock": want, "g2gOffers.$.lastStockSyncAt": new Date() } },
            );
          } catch (e) {
            notes.push(link.offerId + ": stock update failed (" + ((e && e.message) || e) + ")");
          }
        }
      }
    }
  } finally {
    sweeping = false;
  }
  return { notes };
}

let timer = null;
function start() {
  if (timer) return;
  const run = async () => {
    try {
      const r = await sweep();
      if (r && r.notes && r.notes.length) console.log("[epicG2g] sweep:", r.notes.join("; "));
    } catch (e) {
      console.error("[epicG2g] sweep error:", (e && e.message) || e);
    }
    timer = setTimeout(run, SWEEP_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(run, 4 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// For the panel (epicSales.overview).
async function panelView(ctx) {
  const list = await links();
  const counts = await EpicG2gUnit.aggregate([
    { $match: { offerId: { $in: list.map((l) => l.offerId) } } },
    { $group: { _id: { offerId: "$offerId", state: "$state" }, n: { $sum: 1 } } },
  ]);
  const unitsOf = (offerId) => {
    const out = { loading: 0, listed: 0, sold: 0, removed: 0 };
    for (const c of counts) if (c._id.offerId === offerId) out[c._id.state] = c.n;
    return out;
  };
  return {
    siteUrl: siteUrl(),
    offers: list.map((l) => ({
      offerId: l.offerId,
      mode: l.mode || "order",
      url: mp.g2gOfferUrl ? mp.g2gOfferUrl(l.offerId) : "",
      title: l.title,
      games: l.games || [],
      enabled: l.enabled !== false,
      sessionDays: l.sessionDays || DEFAULT_DAYS,
      syncStock: l.syncStock !== false,
      lastStock: l.lastStock,
      lastStockSyncAt: l.lastStockSyncAt,
      lastStockLoadAt: l.lastStockLoadAt,
      lastSaleScanAt: l.lastSaleScanAt,
      units: unitsOf(l.offerId),
      ready: ctx ? stockCount(l, ctx) : null,
      linkedAt: l.linkedAt,
    })),
  };
}

module.exports = {
  deliverOrder,
  linkOffer,
  setLink,
  unlinkOffer,
  deliveryDetails,
  proofFor,
  sweep,
  start,
  stop,
  panelView,
  // Instant (G2G Auto delivery) offers
  loadStock: async (offerId) => {
    const stored = await linkFor(offerId);
    if (!stored) throw userError("That G2G offer isn't linked", 404);
    const [link, offer] = await refreshMode(stored);
    if (link.mode !== "instant") return { skipped: "The offer is on Manual delivery on G2G. Switch it to Auto delivery there first." };
    return loadStock(link, { offer });
  },
  scanInstantSales: async (offerId) => {
    const stored = await linkFor(offerId);
    if (!stored) throw userError("That G2G offer isn't linked", 404);
    const [link] = await refreshMode(stored);
    return scanInstantSales(link);
  },
  onStockEmailChanged,
  modeOf,
  // pure, for tests
  csvRow,
  buildRow,
  checkTemplate,
  fieldKind,
  formatDate,
  countryName,
  noteText,
  saleIdFor,
  GAME_ACCOUNTS_SERVICE,
  _internals: { templateCache, paged, orderLocks },
};
