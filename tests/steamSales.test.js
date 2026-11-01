/* global fetch */
// Steam account sales (utils/steamSales.js) against mongodb-memory-server with
// a fake Eldorado, a fake Mac mail proxy and no Telegram. Contract:
// docs/STEAM-SALES.md. Every refusal here guards a way to sell one account
// twice, hand a buyer the wrong account, or show a buyer the wrong mail.
process.env.SESSION_SECRET ||= "steam-sales-test-secret";
process.env.CRED_SECRET ||= "steam-sales-test-cred";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { encrypt } = require("../utils/secretBox");
const SteamAccount = require("../models/SteamAccount");
const SteamListing = require("../models/SteamListing");
const SteamSale = require("../models/SteamSale");
const BuyerMailSession = require("../models/BuyerMailSession");
const outlook = require("../utils/outlookGraphReader");
const sales = require("../utils/steamSales");

// ---- fakes ------------------------------------------------------------------
let offers; // id -> { title, description, price, state, entries: [{id, ...entry}], section }
let orders; // [{ order, entries }]
let createFails = null;
let seq = 0;
const telegrams = [];
const inboxUses = new Map(); // email -> uses[]

const fakeEld = {
  MIN_PRICE: 0.05,
  uploadImage: async () => ({ smallImage: "s.jpg", largeImage: "l.jpg", originalSizeImage: "o.jpg" }),
  offerUrl: (id, section) => "https://www.eldorado.gg/" + section.seoAlias + "/oa/" + id,
  async createAccountOffer(opts) {
    if (createFails) throw Object.assign(new Error(createFails), { status: 400 });
    const id = "offer-" + ++seq;
    offers.set(id, {
      title: opts.title,
      description: opts.description,
      price: opts.priceUsd,
      state: "Active",
      section: opts.section,
      hasOriginalEmail: opts.hasOriginalEmail,
      entries: opts.entries.map((e) => ({ ...e, id: "e" + ++seq })),
    });
    return { id };
  },
  async getAccountOffer(id) {
    const o = offers.get(id);
    if (!o) throw Object.assign(new Error("404"), { status: 404 });
    return {
      offerState: o.state,
      quantity: o.entries.length,
      pricePerUnit: { amount: o.price, currency: "USD" },
      offerTitle: o.title,
      description: o.description,
      expireDate: new Date(Date.now() + 20 * 86400000).toISOString(),
      mainOfferImage: { largeImage: "l.jpg" },
    };
  },
  async getAccountEntries(id) {
    return offers.get(id).entries.map((e) => ({ ...e }));
  },
  async updateAccountOffer(id, opts) {
    const o = offers.get(id);
    o.entries = opts.entries.map((e) => ({ ...e, id: e.id || "e" + ++seq }));
    o.section = opts.section;
    o.title = opts.title;
    o.description = opts.description;
    o.price = opts.priceUsd;
    return true;
  },
  async pauseAccountOffer(id) {
    offers.get(id).state = "Paused";
  },
  async resumeAccountOffer(id) {
    offers.get(id).state = "Active";
  },
  async changeAccountOfferPrice(id, p) {
    offers.get(id).price = p;
    return p;
  },
  async deleteAccountOffer(id) {
    offers.delete(id);
  },
  async orderAccountDetails(orderId) {
    const hit = orders.find((o) => o.order.id === orderId);
    return hit ? hit.entries : [];
  },
  async ordersInStates() {
    return orders.map((o) => o.order);
  },
};

const fakeOutlook = {
  async checkInbox(email) {
    if (!inboxUses.has(email)) return { sellable: false, sharedWith: [], status: "unknown" };
    return { sellable: false, sharedWith: inboxUses.get(email), status: "live" };
  },
  proxyHealth: async () => ({ ok: true }),
};

// A buyer pays: Eldorado takes one entry out of the offer and makes an order.
function buy(offerId, login, { details = true, minutesAgo = 1 } = {}) {
  const o = offers.get(offerId);
  const i = o.entries.findIndex((e) => e.accountLogin.toLowerCase() === login.toLowerCase());
  assert.ok(i >= 0, "entry " + login + " in stock");
  const [entry] = o.entries.splice(i, 1);
  const order = {
    id: "order-" + ++seq,
    offerId,
    purchaseQuantity: 1,
    createdDate: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    state: { state: "Paid" },
    totalPrice: { amount: 1, currency: "USD" },
    buyerUsername: "buyer1",
  };
  orders.push({ order, entries: details ? [entry] : [] });
  return order;
}

async function account(name, country, over = {}) {
  const email = name + "@outlook.com";
  inboxUses.set(email, over.uses || ["steam"]);
  return SteamAccount.create({
    localId: "local-" + name,
    accountName: name,
    password: encrypt("pw-" + name),
    email: encrypt(email),
    signupCountry: country,
    requestedCountry: country,
    proxyCountry: country,
    signedUpAt: new Date(),
    importedAt: new Date(),
    games: over.games || [],
    stage: over.stage || "stock",
  });
}

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([SteamAccount.init(), SteamSale.init(), SteamListing.init(), BuyerMailSession.init()]);
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
test.beforeEach(async () => {
  offers = new Map();
  orders = [];
  createFails = null;
  telegrams.length = 0;
  inboxUses.clear();
  sales._setDeps({ eld: fakeEld, outlook: fakeOutlook, notify: async (t) => telegrams.push(t) });
  await Promise.all([SteamAccount.deleteMany({}), SteamListing.deleteMany({}), SteamSale.deleteMany({}), BuyerMailSession.deleteMany({})]);
});

// ---- tests --------------------------------------------------------------------

test("a region listing takes only that region's ready accounts and reserves them", async () => {
  const a1 = await account("jp_one", "JP");
  const a2 = await account("jp_two", "JP");
  await account("jp_loaded", "JP", { games: [{ name: "Portal 2", appId: 620, priceUsd: 9.99 }] });
  await account("jp_shared", "JP", { uses: ["steam", "soop"] });
  await account("jp_nouse", "JP", { uses: [] });
  await account("us_one", "US");

  const pv = await sales.previewListing({ region: "JP" });
  assert.deepEqual(pv.problems, []);
  assert.deepEqual(pv.accounts.map((a) => a.accountName).sort(), ["jp_one", "jp_two"]);
  assert.match(pv.title, /Japan Region/);
  assert.match(pv.description, /Region: Japan/);
  assert.equal(pv.priceUsd, 1);

  const l = await sales.createListing({ region: "JP", priceUsd: 1 }, "tester");
  assert.equal(l.status, "active");
  assert.equal(l.listed, 2);
  assert.match(l.url, /steam-accounts\/oa\/offer-/);

  const offer = offers.get(l.url.split("/oa/")[1]);
  assert.equal(offer.section.gameId, "42", "filed under Steam › Accounts");
  assert.equal(offer.hasOriginalEmail, false);
  assert.equal(offer.price, 1);
  assert.equal(offer.entries.length, 2);
  const e = offer.entries.find((x) => x.accountLogin === "jp_one");
  assert.equal(e.accountPassword, "pw-jp_one");
  assert.equal(e.emailLogin, "jp_one@outlook.com");
  assert.equal(e.emailProviderUrl, "https://shop.example.test/mail/");
  assert.ok(e.emailPassword && e.emailPassword !== "pw-jp_one");
  assert.ok(!/pw-/.test(e.additionalInfo), "the plain-text note carries no secret");

  for (const id of [a1._id, a2._id]) assert.equal((await SteamAccount.findById(id)).stage, "listed");
  const sess = await BuyerMailSession.findOne({ steamAccountId: a1._id });
  assert.equal(sess.kind, "steam");
  assert.equal(sess.stage, "listed");
  assert.ok(await bcrypt.compare(e.emailPassword, sess.passwordHash), "entry password opens that session");
  assert.ok(telegrams.some((t) => /Steam listing is live/.test(t)));

  // Only one live listing per region; the US account is untouched.
  await assert.rejects(sales.createListing({ region: "JP" }), /already a live Japan listing|No ready Japan/);
  assert.equal((await SteamAccount.findOne({ accountName: "us_one" })).stage, "stock");

  const ov = await sales.overview();
  const blockedNames = ov.blocked.map((b) => b.accountName).sort();
  assert.deepEqual(blockedNames, ["jp_loaded", "jp_nouse", "jp_shared"]);
  assert.deepEqual(ov.ready.map((g) => g.region), ["US"]);
});

test("a create Eldorado refuses gives every account back", async () => {
  const a = await account("tr_one", "TR");
  createFails = "Eldorado account offer create failed (HTTP 400): nope";
  await assert.rejects(sales.createListing({ region: "TR" }), /HTTP 400/);
  assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
  const s = await BuyerMailSession.findOne({ steamAccountId: a._id });
  assert.ok(s.revokedAt, "minted session revoked");
  assert.equal((await SteamListing.findOne({ region: "TR" })).status, "removed");
});

test("a sale is recorded once, by the order's own entry, and opens the buyer's mail window", async () => {
  const a = await account("ua_one", "UA");
  await account("ua_two", "UA");
  const l = await sales.createListing({ region: "UA" });
  const offerId = l.url.split("/oa/")[1];
  const order = buy(offerId, "ua_one");

  const r1 = await sales.tick({ force: true });
  assert.ok(r1.ok, JSON.stringify(r1.notes));
  const sale = await SteamSale.findOne({ orderId: order.id });
  assert.equal(sale.matchedBy, "order-details");
  assert.equal(sale.needsAttention, false);
  assert.deepEqual(sale.accounts.map((x) => x.label), ["ua_one"]);
  const acc = await SteamAccount.findById(a._id);
  assert.equal(acc.stage, "sold");
  assert.match(acc.soldNote, new RegExp(order.id));
  const sess = await BuyerMailSession.findOne({ steamAccountId: a._id });
  assert.equal(sess.stage, "sold");
  assert.equal(sess.passwordEnc, "", "listed password dropped once sold");
  assert.ok(Math.abs(sess.expiresAt - (new Date(order.createdDate).getTime() + 7 * 86400000)) < 1000);
  assert.ok(telegrams.some((t) => /Steam account sold on Eldorado/.test(t)));

  await sales.tick({ force: true });
  assert.equal(await SteamSale.countDocuments({ orderId: order.id }), 1, "never recorded twice");
  assert.equal(await sales.isSteamOffer(offerId), true, "the order fulfiller skips this offer");
  assert.equal(await sales.isSteamOffer("someone-elses"), false);
});

test("without order details the single unit that left the stock is the match; two gone is never guessed", async () => {
  await account("br_one", "BR");
  await account("br_two", "BR");
  await account("br_three", "BR");
  const l = await sales.createListing({ region: "BR" });
  const offerId = l.url.split("/oa/")[1];
  const o1 = buy(offerId, "br_one", { details: false });
  await sales.tick({ force: true });
  assert.equal((await SteamSale.findOne({ orderId: o1.id })).matchedBy, "stock-diff");
  assert.equal((await SteamAccount.findOne({ accountName: "br_one" })).stage, "sold");

  buy(offerId, "br_two", { details: false });
  buy(offerId, "br_three", { details: false });
  await sales.tick({ force: true });
  assert.equal(await SteamSale.countDocuments({}), 1, "fresh unmatched orders wait instead of guessing");
  assert.equal((await SteamAccount.findOne({ accountName: "br_two" })).stage, "listed");
});

test("top-up, remove and delete keep one account on one offer and give accounts back", async () => {
  await account("kz_one", "KZ");
  await account("kz_two", "KZ");
  const l = await sales.createListing({ region: "KZ" });
  const offerId = l.url.split("/oa/")[1];

  const late = await account("kz_three", "KZ");
  await account("ar_one", "AR");
  const topped = await sales.addAccounts(l._id);
  assert.equal(topped.listed, 3);
  assert.equal(offers.get(offerId).entries.length, 3);
  assert.equal((await SteamAccount.findById(late._id)).stage, "listed");
  assert.equal((await SteamAccount.findOne({ accountName: "ar_one" })).stage, "stock", "other region not added");
  await assert.rejects(sales.addAccounts(l._id), /No ready Kazakhstan account/);

  const removed = await sales.removeAccount(l._id, String(late._id), "tester");
  assert.equal(removed.listed, 2);
  assert.equal((await SteamAccount.findById(late._id)).stage, "stock");
  assert.ok(!offers.get(offerId).entries.some((e) => e.accountLogin === "kz_three"));
  const mailPwKept = offers.get(offerId).entries.every((e) => e.emailPassword && e.accountPassword.startsWith("pw-"));
  assert.ok(mailPwKept, "the rewrite rebuilt every other entry in full");

  // A unit gone from the stock with no order blocks the delete.
  offers.get(offerId).entries.splice(0, 1);
  await assert.rejects(sales.deleteListing(l._id, "tester"), /no order for it is recorded/);
  offers.get(offerId).entries.push({ id: "back", accountLogin: "kz_one", accountPassword: "pw-kz_one", emailLogin: "kz_one@outlook.com", emailPassword: "x", emailProviderUrl: "https://shop.example.test/mail/" });
  const gone = await sales.deleteListing(l._id, "tester");
  assert.equal(gone.status, "removed");
  assert.equal(offers.has(offerId), false);
  assert.equal(await SteamAccount.countDocuments({ stage: "listed" }), 0, "everything back in stock");
});

test("the stock is never rewritten from a partial read", async () => {
  await account("us_a", "US");
  await account("us_b", "US");
  const l = await sales.createListing({ region: "US" });
  const offerId = l.url.split("/oa/")[1];
  const real = fakeEld.getAccountEntries;
  fakeEld.getAccountEntries = async (id) => (await real(id)).slice(0, 1);
  await account("us_c", "US");
  try {
    await assert.rejects(sales.addAccounts(l._id), /not rewritten/);
  } finally {
    fakeEld.getAccountEntries = real;
  }
  assert.equal(offers.get(offerId).entries.length, 2);
  assert.equal((await SteamAccount.findOne({ accountName: "us_c" })).stage, "stock", "nothing reserved on a refused rewrite");
});

test("the mail page shows a Steam buyer only Steam mail, and an Epic row keeps its old path", async () => {
  const acc = await account("jp_mail", "JP");
  const password = "MailPagePass123";
  await BuyerMailSession.create({
    kind: "steam",
    steamAccountId: acc._id,
    inboxAddress: "jp_mail@outlook.com",
    passwordHash: await bcrypt.hash(password, 4),
    expiresAt: new Date(Date.now() + 86400000),
    stage: "sold",
    soldAt: new Date(Date.now() - 3600000),
  });
  const calls = [];
  const realRead = outlook.readMailFor;
  const realEpic = outlook.readEpicMailFor;
  outlook.readMailFor = async (args) => {
    calls.push({ fn: "readMailFor", kind: args.kind });
    return { messages: [{ from: "noreply@steampowered.com", subject: "Steam Guard code", receivedDateTime: new Date().toISOString(), body: "CODE 12345" }] };
  };
  outlook.readEpicMailFor = async () => {
    calls.push({ fn: "readEpicMailFor" });
    return { messages: [] };
  };
  const app = express();
  app.use(require("../routes/buyerMailRoutes"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const login = await fetch(base + "/mail/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=jp_mail%40outlook.com&password=" + password,
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const inbox = await (await fetch(base + "/mail/inbox", { headers: { cookie } })).text();
    assert.match(inbox, /Steam Guard code/);
    assert.match(inbox, /store\.steampowered\.com\/account/);
    assert.match(inbox, /only shows mail from Steam/);
    assert.doesNotMatch(inbox, /epicgames\.com\/account/);
    assert.deepEqual(calls, [{ fn: "readMailFor", kind: "steam" }]);
  } finally {
    outlook.readMailFor = realRead;
    outlook.readEpicMailFor = realEpic;
    await new Promise((r) => server.close(r));
  }
});

test("an account on a live listing can't change stage by hand", async () => {
  await account("gb_one", "GB");
  await sales.createListing({ region: "GB" });
  const acc = await SteamAccount.findOne({ accountName: "gb_one" });
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => {
    req.session = { admin: { id: "t", role: "superadmin" } };
    n();
  });
  app.use(require("../routes/steamAccountRoutes"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const r = await fetch(base + "/api/steam/accounts/" + acc._id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "stock" }),
    });
    assert.equal(r.status, 409);
    const ok = await fetch(base + "/api/steam/accounts/" + acc._id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "still editable" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await SteamAccount.findById(acc._id)).stage, "listed");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("the owner's region warning is in every description, and a live offer's text can be refreshed with its stock intact", async () => {
  const { REGION_WARNING, suggestDescription } = sales._internal;
  assert.match(REGION_WARNING, /at least 1 month/);
  assert.ok(suggestDescription("TR", 7).includes(REGION_WARNING));
  assert.ok(suggestDescription("TR", 7).length <= 2000);

  await account("tr_a", "TR");
  await account("tr_b", "TR");
  const l = await sales.createListing({ region: "TR" });
  const offerId = l.url.split("/oa/")[1];
  const before = offers.get(offerId).entries.map((e) => ({ id: e.id, login: e.accountLogin, pw: e.accountPassword, mail: e.emailPassword }));
  offers.get(offerId).description = "old text without the warning";

  const v = await sales.refreshDescription(l._id);
  assert.equal(v.status, "active");
  const after = offers.get(offerId);
  assert.ok(after.description.includes(REGION_WARNING), "Eldorado got the new description");
  assert.equal(after.title, l.title, "title kept");
  assert.equal(after.section.gameId, "42", "still filed under Steam › Accounts");
  assert.deepEqual(
    after.entries.map((e) => ({ id: e.id, login: e.accountLogin, pw: e.accountPassword, mail: e.emailPassword })),
    before,
    "every stock entry written back unchanged (same ids, logins, passwords)",
  );
  assert.ok((await SteamListing.findById(l._id)).description.includes(REGION_WARNING));
  await assert.rejects(sales.updateText(l._id, {}), /Nothing to change/);
  await assert.rejects(sales.updateText(l._id, { description: "x".repeat(2001) }), /2000/);
});
