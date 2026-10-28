/* global fetch */
// End-to-end flow of the Epic account sales system against mongodb-memory-
// server, with Eldorado, the Mac mail proxy and Telegram replaced by fakes:
//
//   list (sessions minted, delivery entries built) → the buyer signs in to the
//   mail page with the password from their entry → a sale (the entry leaves
//   the stock, an order appears) → the sale is recorded against the RIGHT
//   account, the account is marked sold, the mail page clock starts at the
//   sale → remove / delete / the money-path refusals.
//
// Every refusal here guards a way to sell one account twice, hand a buyer the
// wrong account, or switch off a mail page a buyer still needs.
process.env.SESSION_SECRET ||= "epic-sales-flow-test-secret";
process.env.CRED_SECRET ||= "epic-sales-flow-test-cred";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const axios = require("axios");
const bcrypt = require("bcrypt");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { encrypt } = require("../utils/secretBox");
const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const EpicListing = require("../models/EpicListing");
const EpicSale = require("../models/EpicSale");
const BuyerMailSession = require("../models/BuyerMailSession");
const eld = require("../utils/eldoradoAccountOffers");
const outlook = require("../utils/outlookGraphReader");
const telegram = require("../utils/telegram");
const sales = require("../utils/epicSales");

// ---- fakes -----------------------------------------------------------------
const sent = [];
telegram.sendTelegram = async (text) => {
  sent.push(text);
  return true;
};

const USES = new Map(); // inbox → uses list
const MAIL = []; // { inbox, from, subject, receivedDateTime }
let lastSince = "";
outlook.checkInbox = async (email) => {
  const uses = USES.get(email);
  if (!uses) return { sellable: false, sharedWith: [], status: "unknown" };
  return { sellable: true, sharedWith: uses.filter((u) => u !== "epic"), status: "live" };
};
outlook.proxyHealth = async () => ({ ok: true, inboxes: USES.size });
outlook.readEpicMailFor = async ({ inboxAddress, sinceIso }) => {
  lastSince = sinceIso;
  const since = Date.parse(sinceIso);
  return {
    messages: MAIL.filter((m) => m.inbox === inboxAddress && Date.parse(m.receivedDateTime) >= since).map((m, i) => ({
      id: "m" + i,
      subject: m.subject,
      from: m.from,
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.subject,
      body: m.subject + " body",
    })),
  };
};

const ELD = { offers: new Map(), orders: [], orderDetails: new Map(), seq: 0, failOrderDetails: false, updates: [] };
function fakeEntries(list) {
  return list.map((e) => ({ ...e, id: e.id || "e" + ++ELD.seq }));
}
eld.uploadImage = async () => ({ smallImage: "s.png", largeImage: "l.png", originalSizeImage: "o.png" });
eld.createAccountOffer = async (opts) => {
  const id = "00000000-0000-4000-8000-" + String(++ELD.seq).padStart(12, "0");
  ELD.offers.set(id, {
    id,
    offerState: "Active",
    offerTitle: opts.title,
    description: opts.description,
    pricePerUnit: { amount: opts.priceUsd, currency: "USD" },
    hasOriginalEmail: !!opts.hasOriginalEmail,
    mainOfferImage: opts.mainOfferImage,
    expireDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 19),
    entries: fakeEntries(opts.entries),
  });
  return { id };
};
eld.getAccountOffer = async (id) => {
  const o = ELD.offers.get(id);
  if (!o) {
    const e = new Error("Eldorado account offer read failed (HTTP 404)");
    e.status = 404;
    throw e;
  }
  return { ...o, quantity: o.entries.length };
};
eld.getAccountEntries = async (id) => {
  const o = ELD.offers.get(id);
  if (!o) {
    const e = new Error("not found");
    e.status = 404;
    throw e;
  }
  if (o.brokenRead) return [];
  return o.entries.map((e) => ({
    id: e.id,
    accountLogin: e.accountLogin,
    accountPassword: e.accountPassword,
    emailProviderUrl: e.emailProviderUrl,
    emailLogin: e.emailLogin,
    emailPassword: e.emailPassword,
    additionalInfo: e.additionalInfo,
    legacy: false,
  }));
};
eld.updateAccountOffer = async (id, opts) => {
  const o = ELD.offers.get(id);
  ELD.updates.push({ id, entries: opts.entries.map((e) => ({ id: e.id || null, login: e.accountLogin })) });
  o.entries = fakeEntries(opts.entries);
  o.offerTitle = opts.title;
  o.description = opts.description;
  return true;
};
eld.pauseAccountOffer = async (id) => (ELD.offers.get(id).offerState = "Paused");
eld.resumeAccountOffer = async (id) => (ELD.offers.get(id).offerState = "Active");
eld.changeAccountOfferPrice = async (id, p) => {
  ELD.offers.get(id).pricePerUnit = { amount: p, currency: "USD" };
  return p;
};
eld.deleteAccountOffer = async (id) => ELD.offers.delete(id);
eld.myAccountOffers = async () => [...ELD.offers.values()].map((o) => ({ ...o, quantity: o.entries.length }));
eld.ordersInStates = async (states) => ELD.orders.filter((o) => states.includes(o.state.state));
eld.orderAccountDetails = async (orderId) => {
  if (ELD.failOrderDetails) throw new Error("Eldorado order account details failed (HTTP 403)");
  return (ELD.orderDetails.get(orderId) || []).map((login) => ({ accountLogin: login }));
};

// The cover download goes through axios; answer it with a tiny PNG.
const realGet = axios.get;
axios.get = async (url, opts) => {
  if (/cdn\.example\.test/.test(String(url))) {
    return { status: 200, headers: { "content-type": "image/png" }, data: Buffer.from("89504e470d0a1a0a", "hex") };
  }
  return realGet.call(axios, url, opts);
};

// Simulate Eldorado's instant delivery of one unit: the entry leaves the
// offer and a Delivered order appears.
function sell(offerId, login, { orderId, details = true, minutesAgo = 0 } = {}) {
  const o = ELD.offers.get(offerId);
  const i = o.entries.findIndex((e) => e.accountLogin === login);
  assert.ok(i >= 0, "unit is in stock before the sale");
  o.entries.splice(i, 1);
  ELD.orders.push({
    id: orderId,
    offerId,
    purchaseQuantity: 1,
    state: { state: "Delivered" },
    createdDate: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    totalPrice: { amount: 0.49, currency: "USD" },
    buyerUsername: "buyer_" + orderId,
  });
  if (details) ELD.orderDetails.set(orderId, [login]);
}

// ---- app -------------------------------------------------------------------
let mongod;
let server;
let base;
let cookie;
const acc = {};

function call(method, path, body, extra = {}) {
  const headers = { Accept: "application/json" };
  const c = "cookie" in extra ? extra.cookie : cookie;
  if (c) headers.Cookie = c;
  const init = { method, headers, redirect: "manual" };
  if (body !== undefined) {
    if (extra.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(body).toString();
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  return fetch(base + path, init);
}

async function mkAccount(label, email, games, uses = ["soop", "epic"]) {
  USES.set(email, uses);
  const a = await EpicAccount.create({
    accountId: "acc-" + label,
    displayName: label,
    label,
    email: encrypt(email),
    password: encrypt("EpicPw-" + label),
    source: "generated",
    status: "ok",
    library: games.map((t) => ({ title: t, namespace: "ns-" + t })),
    libraryCount: games.length,
  });
  acc[label] = { id: String(a._id), email };
  return a;
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("epic-sales-flow"));
  await EpicSale.init();
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(require("../routes/buyerMailRoutes"));
  app.use(require("../routes/epicAccountRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(base + "/test/session")).headers.get("set-cookie").split(";")[0];

  await EpicFreebie.create({ offerId: "f1", title: "Sker Ritual", image: "https://cdn.example.test/sker.png", active: false });
  const both = ["Sker Ritual", "Home - A Unique Horror Adventure"];
  await mkAccount("gen-a", "gen.a@outlook.com", both);
  await mkAccount("gen-b", "gen.b@outlook.com", both);
  await mkAccount("gen-c", "gen.c@outlook.com", both);
  await mkAccount("empty", "empty.x@outlook.com", []);
  await mkAccount("twitchy", "tw.x@outlook.com", ["Sker Ritual"], ["soop", "twitch", "epic"]);
  await mkAccount("unknown", "nobody.x@outlook.com", ["Sker Ritual"]);
  USES.delete("nobody.x@outlook.com");
  await EpicAccount.create({ accountId: "acc-old", label: "old-no-creds", status: "ok", library: [{ title: "Fortnite" }], libraryCount: 1 });
});

test.after(async () => {
  sales.stop();
  axios.get = realGet;
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let listingId;
let offerId;

test("the overview says which accounts can be sold and why", async () => {
  const r = await call("GET", "/api/epic/sales/overview");
  assert.equal(r.status, 200);
  const j = await r.json();
  const by = Object.fromEntries(j.stock.map((s) => [s.label, s]));
  assert.equal(by["gen-a"].state, "ready");
  assert.ok(by["gen-a"].warnings.some((w) => /SOOP/.test(w)), "SOOP sharing is shown, not hidden");
  assert.equal(by["twitchy"].state, "blocked");
  assert.match(by["twitchy"].blockers.join(" "), /twitch/);
  assert.equal(by["unknown"].state, "blocked");
  assert.equal(by["old-no-creds"].state, "blocked");
  const group = j.groups.find((g) => g.games.length === 2);
  assert.equal(group.count, 3);
  assert.equal(j.health.providerUrl, "https://shop.example.test/mail/");
  // Nothing secret in the panel's payload.
  const body = JSON.stringify(j);
  assert.ok(!body.includes("EpicPw-"), "Epic passwords never reach the panel");
});

test("preview needs a price and finds the cover art; create lists the accounts", async () => {
  const ids = [acc["gen-a"].id, acc["gen-b"].id, acc["gen-c"].id];
  let r = await call("POST", "/api/epic/sales/preview", { accountIds: ids });
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.preview.problems.includes("Set a price"));
  assert.equal(j.preview.coverUrl, "https://cdn.example.test/sker.png");
  r = await call("POST", "/api/epic/sales/listings", { accountIds: ids, priceUsd: 0.49 });
  assert.equal(r.status, 400, "publishing without confirm is refused");
  r = await call("POST", "/api/epic/sales/listings", { accountIds: ids, priceUsd: 0.49, confirm: true });
  j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  listingId = j.listing._id;
  offerId = j.listing.externalId;
  assert.equal(j.listing.status, "active");
  assert.equal(j.listing.counts.listed, 3);
  assert.ok(sent.some((t) => /listing is live/.test(t)));

  const o = ELD.offers.get(offerId);
  assert.equal(o.entries.length, 3);
  assert.equal(o.hasOriginalEmail, false);
  for (const e of o.entries) {
    assert.equal(e.emailProviderUrl, "https://shop.example.test/mail/");
    assert.equal(e.emailLogin, e.accountLogin);
    assert.match(e.accountPassword, /^EpicPw-/);
    const s = await BuyerMailSession.findOne({ inboxAddress: e.accountLogin, revokedAt: null });
    assert.equal(s.stage, "listed");
    assert.ok(await bcrypt.compare(e.emailPassword, s.passwordHash), "the entry's email password opens that inbox's session");
    assert.ok(s.expiresAt - Date.now() > 300 * 864e5, "no expiry clock while listed");
  }
});

test("a listed account can't be listed again, delivered by hand, or marked sold", async () => {
  let r = await call("POST", "/api/epic/sales/preview", { accountIds: [acc["gen-a"].id], priceUsd: 1 });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /already on/);
  r = await call("POST", "/api/epic/accounts/" + acc["gen-a"].id + "/buyer-session", { marketplace: "manual" });
  assert.equal(r.status, 409);
  r = await call("PATCH", "/api/epic/accounts/" + acc["gen-a"].id, { sold: true });
  assert.equal(r.status, 409);
  assert.equal((await EpicAccount.findById(acc["gen-a"].id)).sold, false);
});

test("the buyer's mail page login works with the delivered password, and shows only mail since listing", async () => {
  const entry = ELD.offers.get(offerId).entries.find((e) => e.accountLogin === "gen.a@outlook.com");
  let r = await call("POST", "/mail/login", { email: "gen.a@outlook.com", password: "wrong-password" }, { form: true, cookie: "" });
  assert.equal(r.status, 401);
  r = await call("POST", "/mail/login", { email: "GEN.A@outlook.com", password: entry.emailPassword }, { form: true, cookie: "" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/mail/inbox");
  const mailCookie = r.headers.get("set-cookie").split(";")[0];
  MAIL.push({ inbox: "gen.a@outlook.com", from: "noreply@acct-auth.epicgames.com", subject: "Your Security Code", receivedDateTime: new Date().toISOString() });
  r = await call("GET", "/mail/inbox", undefined, { cookie: mailCookie });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Your Security Code/);
  const s = await BuyerMailSession.findOne({ inboxAddress: "gen.a@outlook.com", revokedAt: null });
  assert.equal(lastSince, new Date(s.createdAt).toISOString(), "before the sale is recorded the cutoff is the listing time");
});

test("a sale is recorded against the account the buyer received (order details)", async () => {
  sell(offerId, "gen.b@outlook.com", { orderId: "order-1" });
  const t = await sales.tick({ force: true });
  assert.equal(t.ok, true, JSON.stringify(t));
  const sale = await EpicSale.findOne({ orderId: "order-1" }).lean();
  assert.equal(sale.matchedBy, "order-details");
  assert.equal(sale.accounts.length, 1);
  assert.equal(sale.accounts[0].login, "gen.b@outlook.com");
  assert.equal(sale.needsAttention, false);
  assert.equal((await EpicAccount.findById(acc["gen-b"].id)).sold, true);
  const s = await BuyerMailSession.findById(sale.accounts[0].sessionId).lean();
  assert.equal(s.stage, "sold");
  assert.equal(s.passwordEnc, "", "no recoverable password kept after the sale");
  const days = (new Date(s.expiresAt) - new Date(s.soldAt)) / 864e5;
  assert.ok(Math.abs(days - 7) < 0.01, "mail page open 7 days from the sale");
  const l = await EpicListing.findById(listingId).lean();
  assert.equal(l.accounts.find((u) => u.login === "gen.b@outlook.com").state, "sold");
  assert.equal(l.status, "active");
  assert.ok(sent.some((x) => /Epic account sold/.test(x) && /gen-b/.test(x)));
  // A second pass doesn't record it twice.
  await sales.tick({ force: true });
  assert.equal(await EpicSale.countDocuments({ orderId: "order-1" }), 1);
});

test("the buyer of a recorded sale only sees mail from the sale on", async () => {
  const s = await BuyerMailSession.findOne({ inboxAddress: "gen.b@outlook.com", stage: "sold" }).lean();
  // The mail page cookie carries the session id.
  const r = await call("GET", "/mail/inbox", undefined, { cookie: "redeemer_mail_sid=" + s._id });
  assert.equal(r.status, 200);
  assert.equal(lastSince, new Date(s.soldAt).toISOString());
});

test("when Eldorado hides the order's entry, the unit that left the stock is matched", async () => {
  ELD.failOrderDetails = true;
  sell(offerId, "gen.c@outlook.com", { orderId: "order-2", details: false });
  await sales.tick({ force: true });
  const sale = await EpicSale.findOne({ orderId: "order-2" }).lean();
  assert.equal(sale.matchedBy, "stock-diff");
  assert.equal(sale.accounts[0].login, "gen.c@outlook.com");
  ELD.failOrderDetails = false;
});

test("a fresh unmatched order waits; an old one is recorded and paged", async () => {
  // Stock unchanged (nothing left), details unreadable: not matchable.
  ELD.failOrderDetails = true;
  ELD.orders.push({ id: "order-3", offerId, purchaseQuantity: 1, state: { state: "Paid" }, createdDate: new Date().toISOString(), totalPrice: { amount: 0.49, currency: "USD" } });
  await sales.tick({ force: true });
  assert.equal(await EpicSale.countDocuments({ orderId: "order-3" }), 0, "a just-paid order is not recorded as unmatched yet");
  ELD.orders.find((o) => o.id === "order-3").createdDate = new Date(Date.now() - 60 * 60000).toISOString();
  await sales.tick({ force: true });
  const sale = await EpicSale.findOne({ orderId: "order-3" }).lean();
  assert.equal(sale.matchedBy, "unmatched");
  assert.equal(sale.needsAttention, true);
  ELD.failOrderDetails = false;
});

test("a disputed order is flagged and paged", async () => {
  ELD.orders.find((o) => o.id === "order-1").state.state = "Disputed";
  await sales.tick({ force: true });
  const sale = await EpicSale.findOne({ orderId: "order-1" }).lean();
  assert.equal(sale.orderState, "Disputed");
  assert.equal(sale.needsAttention, true);
  assert.ok(sent.some((t) => /order-1/.test(t) && /Disputed/.test(t)));
});

test("adding stock keeps the units already on sale (same entry ids)", async () => {
  await mkAccount("gen-d", "gen.d@outlook.com", ["Sker Ritual", "Home - A Unique Horror Adventure"]);
  const before = ELD.offers.get(offerId).entries.map((e) => e.id);
  const r = await call("POST", "/api/epic/sales/listings/" + listingId + "/accounts", { accountIds: [acc["gen-d"].id] });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const upd = ELD.updates[ELD.updates.length - 1];
  assert.deepEqual(upd.entries.filter((e) => e.id).map((e) => e.id), before, "existing entries are sent back with their ids");
  assert.deepEqual(upd.entries.filter((e) => !e.id).map((e) => e.login), ["gen.d@outlook.com"]);
  assert.equal(j.listing.counts.listed, 2);
});

test("a stock read that disagrees with the offer's quantity is never written back", async () => {
  const o = ELD.offers.get(offerId);
  o.brokenRead = true;
  await mkAccount("gen-e", "gen.e@outlook.com", ["Sker Ritual", "Home - A Unique Horror Adventure"]);
  const n = ELD.updates.length;
  const r = await call("POST", "/api/epic/sales/listings/" + listingId + "/accounts", { accountIds: [acc["gen-e"].id] });
  assert.equal(r.status, 502);
  assert.equal(ELD.updates.length, n, "no rewrite was sent");
  assert.equal(await BuyerMailSession.countDocuments({ inboxAddress: "gen.e@outlook.com", revokedAt: null }), 0);
  const t = await sales.tick({ force: true });
  assert.equal(t.ok, false);
  const l = await EpicListing.findById(listingId).lean();
  assert.ok(l.accounts.filter((u) => u.state === "listed").every((u) => !u.missingSince), "no unit judged gone on a bad read");
  o.brokenRead = false;
});

test("removing a unit takes only that entry off and switches its mail login off", async () => {
  const r = await call("DELETE", "/api/epic/sales/listings/" + listingId + "/accounts/" + acc["gen-d"].id);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual(ELD.offers.get(offerId).entries.map((e) => e.accountLogin), ["gen.a@outlook.com"]);
  const s = await BuyerMailSession.findOne({ inboxAddress: "gen.d@outlook.com" }).sort({ createdAt: -1 }).lean();
  assert.equal(s.revokedReason, "unlisted");
  const last = await call("DELETE", "/api/epic/sales/listings/" + listingId + "/accounts/" + acc["gen-a"].id);
  assert.equal(last.status, 400, "the last unit can't be removed (pause or delete instead)");
});

test("pause, resume and price go to Eldorado", async () => {
  let r = await call("POST", "/api/epic/sales/listings/" + listingId + "/pause");
  assert.equal((await r.json()).listing.status, "paused");
  r = await call("POST", "/api/epic/sales/listings/" + listingId + "/resume");
  assert.equal((await r.json()).listing.status, "active");
  r = await call("POST", "/api/epic/sales/listings/" + listingId + "/price", { priceUsd: 0.59 });
  assert.equal((await r.json()).listing.priceUsd, 0.59);
  r = await call("POST", "/api/epic/sales/listings/" + listingId + "/price", { priceUsd: 0.01 });
  assert.equal(r.status, 400);
});

test("Eldorado's fulfiller skips an Epic offer quietly and still pages an unknown one", async () => {
  const f = require("../utils/eldoradoFulfiller");
  const epic = await f.deliverOrder({ id: "o-epic", offerId }, { dryRun: true });
  assert.match(epic.skipped, /Epic account offer/);
  assert.ok(!f.alertsOperator(epic.skipped), "not a paging reason");
  const other = await f.deliverOrder({ id: "o-x", offerId: "not-ours" }, { dryRun: true });
  assert.match(other.skipped, /no listing row/);
  const none = await f.deliverOrder({ id: "o-y", offerId: "" }, { dryRun: true });
  assert.match(none.skipped, /no listing row/);
});

test("an email change on a LISTED unit closes its mail page and pages", async () => {
  const watcher = require("../utils/buyerSessionWatcher");
  MAIL.push({ inbox: "gen.a@outlook.com", from: "help@acct.epicgames.com", subject: "Your email address has been changed", receivedDateTime: new Date().toISOString() });
  const r = await watcher.sweepOnce();
  assert.ok(r.revoked >= 1);
  const s = await BuyerMailSession.findOne({ inboxAddress: "gen.a@outlook.com" }).sort({ createdAt: -1 }).lean();
  assert.equal(s.revokedReason, "email_changed");
  assert.ok(sent.some((t) => /had its email changed/.test(t)));
});

test("delete waits while a unit is unaccounted for, then takes the rest down", async () => {
  // gen-a leaves the stock without any order yet.
  const o = ELD.offers.get(offerId);
  o.entries = o.entries.filter((e) => e.accountLogin !== "gen.a@outlook.com");
  let r = await call("POST", "/api/epic/sales/listings/" + listingId + "/delete");
  assert.equal(r.status, 409);
  // Its order shows up: recorded, then the delete goes through.
  ELD.orders.push({ id: "order-4", offerId, purchaseQuantity: 1, state: { state: "Delivered" }, createdDate: new Date().toISOString(), totalPrice: { amount: 0.59, currency: "USD" } });
  ELD.orderDetails.set("order-4", ["gen.a@outlook.com"]);
  r = await call("POST", "/api/epic/sales/listings/" + listingId + "/delete");
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.listing.status, "removed");
  assert.equal(ELD.offers.has(offerId), false);
  assert.equal((await EpicSale.findOne({ orderId: "order-4" }).lean()).accounts[0].login, "gen.a@outlook.com");
});

test("resend gives a sold buyer a new mail password and closes the old one", async () => {
  const before = await BuyerMailSession.findOne({ inboxAddress: "gen.b@outlook.com", stage: "sold", revokedAt: null }).lean();
  const r = await call("POST", "/api/epic/sales/sales/order-1/resend", { days: 3 });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.access.accounts[0].email, "gen.b@outlook.com");
  assert.match(j.access.message, /New email password: [A-Za-z0-9]{16}/);
  const old = await BuyerMailSession.findById(before._id).lean();
  assert.equal(old.revokedReason, "replaced");
  const fresh = await BuyerMailSession.findOne({ inboxAddress: "gen.b@outlook.com", revokedAt: null }).lean();
  assert.ok(await bcrypt.compare(j.access.accounts[0].password, fresh.passwordHash));
});

test("the sales panel's data shows the sales with their mail page state", async () => {
  const r = await call("GET", "/api/epic/sales/overview?others=0");
  const j = await r.json();
  const byOrder = Object.fromEntries(j.sales.map((s) => [s.orderId, s]));
  assert.equal(byOrder["order-1"].accounts[0].label, "gen-b");
  assert.equal(byOrder["order-3"].needsAttention, true);
  assert.ok(!JSON.stringify(j).includes("EpicPw-"));
});

test("every sales endpoint refuses a caller without a superadmin session", async () => {
  for (const [m, p] of [
    ["GET", "/api/epic/sales/overview"],
    ["POST", "/api/epic/sales/listings"],
    ["POST", "/api/epic/sales/sync"],
    ["POST", "/api/epic/sales/config"],
    ["POST", "/api/epic/sales/sales/order-1/resend"],
  ]) {
    const r = await call(m, p, m === "POST" ? {} : undefined, { cookie: "" });
    assert.equal(r.status, 401, m + " " + p);
  }
});
