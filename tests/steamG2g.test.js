/* global fetch */
// Steam on G2G (utils/steamG2g.js) + the distributor (utils/steamDistributor.js)
// against mongodb-memory-server, with a fake G2G seller API and a fake Eldorado.
// Contract: docs/STEAM-SALES.md (v2). Every refusal guards a way to sell one
// account twice, lose one in a half-made upload, or send a buyer the wrong mail.
process.env.SESSION_SECRET ||= "steam-g2g-test-secret";
process.env.CRED_SECRET ||= "steam-g2g-test-cred";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";
process.env.STEAM_G2G_CONFIRM_GAP_MS = "1";

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
const SteamSalesState = require("../models/SteamSalesState");
const SteamBoost = require("../models/SteamBoost");
const boost = require("../utils/steamBoost");
const SteamG2gUnit = require("../models/SteamG2gUnit");
const BuyerMailSession = require("../models/BuyerMailSession");
const sales = require("../utils/steamSales");
const g2g = require("../utils/steamG2g");
const distributor = require("../utils/steamDistributor");

// ---- G2G's Steam Accounts form, as sls.g2g.com returns it (2026-11-01) --------
const field = (sort, label, key, required, type = "text", fmt) => ({
  form_id: "f",
  input_field: type,
  label: { en: label },
  value: key,
  sort_order: String(sort),
  is_required: required,
  input_settings: fmt ? { format: fmt } : {},
});
const TEMPLATE = [
  { form_id: "f", label: { en: "Game Account Details" }, sort_order: "1", form_content_type: "header" },
  field(110, "Account ID", "Game Account Information AccountID", true),
  field(120, "Password", "Game Account Informatiom Password", true, "password"),
  field(130, "Character ID", "Game Account CharacterID", false),
  field(210, "Secret Question", "Game Account Secret Question", false),
  field(220, "Secret Answer", "Game Account Secret Answer", false),
  field(310, "First Name", "Game Account Registration First Name", false),
  field(320, "Last Name", "Game Account Registration Last Name", false),
  field(330, "Account Country", "Game Account Registration Account Country", false),
  field(340, "Date of Birth", "Game Account Registration DOB", false, "date", "%d %b %Y"),
  field(350, "Account Email", "Game Account Registration Account Email", true),
  field(360, "Email Password", "Game Account Registration Email Password", true, "password"),
  field(410, "Additional Note", "Game Account Additional Note", false, "textarea"),
];

// ---- fakes ----------------------------------------------------------------------
let g2gOffers; // id -> offer
let uploads; // [{offerId, csv}]
let stock; // offerId -> active count
let g2gOrders; // [{order, item}]
let createCalls;
let updateCalls;
let failCreate;
let failUpload;
let rejectRows; // G2G answers the upload but its importer refuses the rows
let seq;
const telegrams = [];
const inboxUses = new Map();

const fakeMp = {
  g2gFormTemplate: async () => TEMPLATE,
  async g2gCreateInstantAccountOffer(opts) {
    createCalls.push(opts);
    if (failCreate) throw new Error(failCreate);
    const id = "G" + (1793000000000 + ++seq) + "AB";
    g2gOffers.set(id, {
      offer_id: id,
      service_id: opts.serviceId,
      brand_id: opts.brandId,
      relation_id: opts.relationId,
      title: opts.title,
      delivery_speed: "instant",
      offer_attributes: [
        ...opts.offerAttributes.map((a) => ({ ...a, value: String(a.value) })),
        // G2G adds Steam Age "0" by itself when it is not sent.
        ...(opts.offerAttributes.some((a) => a.collection_id === "33e42e40") ? [] : [{ collection_id: "33e42e40", value: "0", is_subscription: false }]),
      ],
    });
    return { offer: g2gOffers.get(id), offerId: id, url: "https://www.g2g.com/offer/" + id };
  },
  async g2gGetOwnOffer(id) {
    return g2gOffers.get(id);
  },
  async g2gUpdateOffer(id, fields) {
    updateCalls.push({ id, fields });
    if (fields.offerAttributes) {
      // As G2G does: an edit sending Steam Age under 1 is refused; an
      // attribute left out keeps the value G2G has.
      const age = fields.offerAttributes.find((a) => a.collection_id === "33e42e40");
      if (age && !(Number(age.value) >= 1)) throw new Error("G2G update offer failed (HTTP 400): Validation error: offer attribute Steam Age value must have min value of 1");
      const sent = fields.offerAttributes.map((a) => ({ ...a, value: String(a.value) }));
      const kept = (g2gOffers.get(id).offer_attributes || []).filter((a) => !sent.some((b) => b.collection_id === a.collection_id));
      g2gOffers.get(id).offer_attributes = [...sent, ...kept];
    }
    return { externalId: id };
  },
  async g2gUploadStock(offer, csv) {
    if (failUpload) throw new Error(failUpload);
    uploads.push({ offerId: offer.offer_id, csv });
    if (rejectRows) return { ok: true };
    stock.set(offer.offer_id, (stock.get(offer.offer_id) || 0) + csv.split("\r\n").filter(Boolean).length);
    return { ok: true };
  },
  async g2gStockStats(id) {
    return stock.has(id) ? { active_inventory: stock.get(id) } : null;
  },
  async g2gOrders({ status }) {
    return g2gOrders.filter((o) => o.status === status).map((o) => o.order);
  },
  async g2gOrder(id) {
    return (g2gOrders.find((o) => o.order.orderItemId === id) || {}).item || null;
  },
};

let eldOffers;
const fakeEld = {
  MIN_PRICE: 0.05,
  uploadImage: async () => ({ smallImage: "s", largeImage: "l", originalSizeImage: "o" }),
  offerUrl: (id, s) => "https://www.eldorado.gg/" + s.seoAlias + "/oa/" + id,
  async createAccountOffer(o) {
    const id = "eld-" + ++seq;
    eldOffers.set(id, { ...o, state: "Active", entries: o.entries.map((e) => ({ ...e, id: "e" + ++seq })) });
    return { id };
  },
  async getAccountOffer(id) {
    const o = eldOffers.get(id);
    return { offerState: o.state, quantity: o.entries.length, pricePerUnit: { amount: o.priceUsd, currency: "USD" }, offerTitle: o.title, expireDate: new Date(Date.now() + 20 * 864e5).toISOString() };
  },
  getAccountEntries: async (id) => eldOffers.get(id).entries.map((e) => ({ ...e })),
  async updateAccountOffer(id, o) {
    eldOffers.get(id).entries = o.entries.map((e) => ({ ...e, id: e.id || "e" + ++seq }));
  },
  resumeAccountOffer: async () => {},
  pauseAccountOffer: async () => {},
  orderAccountDetails: async () => [],
  ordersInStates: async () => [],
};

const fakeOutlook = {
  async checkInbox(email) {
    return { sellable: false, sharedWith: inboxUses.get(email) || [], uses: inboxUses.get(email) || [], status: inboxUses.has(email) ? "live" : "unknown" };
  },
  proxyHealth: async () => ({ ok: true }),
};

async function account(name, country, over = {}) {
  const email = name + "@outlook.com";
  inboxUses.set(email, over.uses || ["steam"]);
  return SteamAccount.create({
    localId: "local-" + name,
    accountName: name,
    password: encrypt("pw-" + name),
    email: encrypt(email),
    signupCountry: country,
    signedUpAt: over.signedUpAt || new Date(),
    importedAt: new Date(),
    games: [],
    stage: "stock",
  });
}

// One CSV row back into its fields (no quoted commas in our test data except
// the note, which is the last field).
function parseRow(row) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (q) {
      if (c === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === "\r" && row[i + 1] === "\n") break;
    else cur += c;
  }
  out.push(cur);
  return out;
}

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([SteamAccount.init(), SteamSale.init(), SteamListing.init(), SteamG2gUnit.init(), BuyerMailSession.init()]);
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
test.beforeEach(async () => {
  g2gOffers = new Map();
  eldOffers = new Map();
  uploads = [];
  stock = new Map();
  g2gOrders = [];
  createCalls = [];
  updateCalls = [];
  failCreate = null;
  failUpload = null;
  rejectRows = false;
  seq = 0;
  telegrams.length = 0;
  inboxUses.clear();
  const notify = async (t) => telegrams.push(t);
  sales._setDeps({ eld: fakeEld, outlook: fakeOutlook, notify });
  g2g._setDeps({ mp: fakeMp, notify, sleep: async () => {} });
  distributor._setDeps({ notify });
  await Promise.all([
    SteamBoost.deleteMany({}),
    SteamAccount.deleteMany({}),
    SteamListing.deleteMany({}),
    SteamSale.deleteMany({}),
    SteamG2gUnit.deleteMany({}),
    BuyerMailSession.deleteMany({}),
    SteamSalesState.deleteMany({}),
  ]);
});

// ---- tests ----------------------------------------------------------------------

test("a country's G2G offer is created once, shaped like the live Epic Instant offer", async () => {
  const link = await g2g.createRegionOffer("JP", "tester");
  assert.equal(createCalls.length, 1);
  const c = createCalls[0];
  assert.equal(c.serviceId, g2g.SERVICE);
  assert.equal(c.brandId, g2g.BRAND);
  assert.equal(c.relationId, g2g.RELATION);
  assert.equal(c.priceUsd, 1);
  assert.equal(c.minQty, 1);
  assert.deepEqual(c.offerAttributes, [
    { collection_id: "b7811700", dataset_id: "a5be43d2", value: "4 or below", is_subscription: false },
    { collection_id: "294cea68", value: "Japan", is_subscription: false },
  ]);
  assert.ok(!c.offerAttributes.some((a) => a.collection_id === "33e42e40"), "Steam Age never sent (G2G refuses 0)");
  assert.match(c.title, /^\[Steam\] Japan Region \| Fresh New Account/);
  assert.ok(c.title.length <= 128);
  assert.ok(c.description.includes(sales._internal.REGION_WARNING), "owner's warning in the G2G description");
  assert.equal(link.region, "JP");
  assert.equal(link.sessionDays, 14);
  assert.equal(link.countrySet, true, "Steam Country set at creation");
  await g2g.sweep();
  assert.equal(updateCalls.length, 0, "nothing to fix on a new offer");
  const again = await g2g.createRegionOffer("JP", "tester");
  assert.equal(again.offerId, link.offerId);
  assert.equal(createCalls.length, 1, "never a second offer for the same country");
});

test("loading a G2G offer: reserve, mail login, one form row per account, confirmed by G2G's stock", async () => {
  const a = await account("jp_g1", "JP");
  const link = await g2g.createRegionOffer("JP");
  const r = await g2g.loadAccounts(link, [String(a._id)]);
  assert.equal(r.loaded, 1);
  assert.equal(r.confirmed, true);
  assert.equal((await SteamAccount.findById(a._id)).stage, "listed");
  const unit = await SteamG2gUnit.findOne({ steamAccountId: a._id });
  assert.equal(unit.state, "listed");
  assert.equal(unit.login, "jp_g1");

  assert.equal(uploads.length, 1);
  const cols = parseRow(uploads[0].csv);
  assert.equal(cols.length, 12, "every input field, in G2G's order");
  assert.equal(cols[0], "jp_g1", "Account ID = Steam account name");
  assert.equal(cols[1], "pw-jp_g1");
  assert.equal(cols[7], "Japan", "Account Country");
  assert.equal(cols[9], "jp_g1@outlook.com", "Account Email = the Outlook address");
  const sess = await BuyerMailSession.findById(unit.sessionId);
  assert.equal(sess.kind, "steam");
  assert.equal(sess.marketplace, "g2g");
  assert.ok(await bcrypt.compare(cols[10], sess.passwordHash), "Email Password opens our mail page");
  assert.notEqual(cols[10], "pw-jp_g1");
  assert.match(cols[11], /https:\/\/shop\.example\.test ,/, "bare site, no path (G2G refuses paths)");
  assert.ok(!/example\.test\/mail/.test(cols[11]));
  assert.match(cols[11], /Steam account emails/);
  assert.match(cols[11], /Do not buy anything on the Steam Store for 1 month/);
  assert.ok(/^[\x00-\x7f]*$/.test(cols[11]), "plain ASCII note (G2G refused one with an emoji)");
  assert.ok(cols[11].length <= g2g._internal.NOTE_MAX, "short note (G2G refused a 624-character one)");

  // Already listed: can't be loaded again, here or on Eldorado.
  await assert.rejects(g2g.loadAccounts(link, [String(a._id)]), /already on sale/);
});

test("a refused upload gives the accounts back; an offer off Auto delivery is refused", async () => {
  const a = await account("tr_g1", "TR");
  const link = await g2g.createRegionOffer("TR");
  failUpload = "G2G stock upload failed (HTTP 400)";
  await assert.rejects(g2g.loadAccounts(link, [String(a._id)]), /HTTP 400/);
  assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
  assert.equal((await SteamG2gUnit.findOne({ steamAccountId: a._id })).state, "removed");
  assert.ok((await BuyerMailSession.findOne({ steamAccountId: a._id })).revokedAt);

  failUpload = null;
  g2gOffers.get(link.offerId).delivery_speed = "manual";
  await assert.rejects(g2g.loadAccounts(link, [String(a._id)]), /not on Auto delivery/);
  assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
});

test("a G2G sale is read from the order's Account ID and recorded once", async () => {
  const a = await account("us_g1", "US");
  const link = await g2g.createRegionOffer("US");
  await g2g.loadAccounts(link, [String(a._id)]);
  const placed = Date.now() - 60000;
  const id = String(placed) + "XYZ";
  g2gOrders.push({
    status: "completed",
    order: { orderItemId: id, offerId: link.offerId, amount: 1, purchasedQty: 1, buyerId: "b1", raw: { created_at: placed } },
    item: { order_item_status: "completed", order_inventories: [{ upload_reference: "US_G1" }] },
  });
  g2gOrders.push({
    status: "completed",
    order: { orderItemId: "1793000000999OTHER", offerId: "G-someone-else", amount: 5, raw: { created_at: placed } },
    item: { order_inventories: [{ upload_reference: "us_g1" }] },
  });
  await g2g.sweep();
  const sale = await SteamSale.findOne({ orderId: "g2g:" + id });
  assert.ok(sale, "sale recorded");
  assert.equal(sale.market, "g2g");
  assert.equal(sale.needsAttention, false);
  const acc = await SteamAccount.findById(a._id);
  assert.equal(acc.stage, "sold");
  assert.match(acc.soldNote, /G2G order/);
  const unit = await SteamG2gUnit.findOne({ steamAccountId: a._id });
  assert.equal(unit.state, "sold");
  const sess = await BuyerMailSession.findById(unit.sessionId);
  assert.equal(sess.stage, "sold");
  assert.ok(Math.abs(sess.expiresAt - (placed + 14 * 86400000)) < 1000, "mail page open 14 days from the purchase");
  await g2g.sweep();
  assert.equal(await SteamSale.countDocuments({}), 1, "one sale, never twice; another seller's offer ignored");
  assert.ok(telegrams.some((t) => /Steam account sold on G2G/.test(t)));

  assert.deepEqual(await g2g.deliverOrder({ offerId: "not-ours" }), null);
  const r = await g2g.deliverOrder({ offerId: link.offerId, orderItemId: String(Date.now()) + "A" });
  assert.match(r.skipped, /G2G delivers it/);
});

test("distributor chooses Eldorado regardless of other markets' stock or sales", () => {
  const stock = { eldorado: new Map([["JP", 10]]), g2g: new Map() };
  assert.equal(distributor.choose("JP", stock, { eldorado: 0, g2g: 100 }, () => false).market, "eldorado");
  assert.equal(distributor.choose("JP", stock, {}, m => m === "eldorado"), null);
});

test("new accounts go only to Eldorado in plan and live distribution", async () => {
  await SteamSalesState.updateOne({ _id: "main" }, { $set: { "boost.enabled": false } }, { upsert: true });
  for (let i = 1; i <= 3; i++) await account("kz_d" + i, "KZ");
  await distributor.setMode("plan");
  const plan = await distributor.run();
  assert.equal(plan.plan, true);
  assert.deepEqual(plan.decisions.map(d => d.market), ["eldorado", "eldorado", "eldorado"]);
  assert.equal(await SteamAccount.countDocuments({ stage: "listed" }), 0);
  await distributor.setMode("on");
  const r = await distributor.run();
  assert.equal(r.placed, 3);
  assert.equal(createCalls.length, 0, "no G2G offer created");
  assert.equal(await SteamG2gUnit.countDocuments({}), 0);
  const eld = await SteamListing.findOne({ region: "KZ", status: "active" });
  assert.equal(eld.accounts.filter(u => u.state === "listed").length, 3);
  await account("kz_d4", "KZ");
  await distributor.run();
  assert.equal((await SteamListing.findById(eld._id)).accounts.filter(u => u.state === "listed").length, 4);
  assert.equal(await SteamListing.countDocuments({ region: "KZ" }), 1);
  assert.deepEqual((await distributor.view()).markets, ["eldorado"]);
});

test("Eldorado failure holds accounts for retry without falling back to G2G", async () => {
  const a = await account("ua_d1", "UA");
  sales._setDeps({ eld: { ...fakeEld, createAccountOffer: async () => { throw Error("Eldorado unavailable"); } } });
  try {
    const r = await distributor.run();
    assert.equal(r.placed, 0);
    assert.match(r.decisions[0].error, /unavailable/);
    assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
    assert.equal(createCalls.length, 0);
    assert.ok(telegrams.some(t => /wait in stock/.test(t)));
    const again = await distributor.run();
    assert.equal(again.placed, 0);
    assert.equal(again.decisions[0].market, "");
    assert.equal(createCalls.length, 0);
  } finally { sales._setDeps({ eld: fakeEld }); }
  // After the pause expires the account goes to Eldorado.
  const retry = await distributor.run({ now: Date.now() + 7 * 3600000 });
  assert.equal(retry.placed, 1);
  assert.equal(retry.decisions[0].market, "eldorado");
});

test("an account in G2G stock can't change stage by hand", async () => {
  const a = await account("br_g1", "BR");
  const link = await g2g.createRegionOffer("BR");
  await g2g.loadAccounts(link, [String(a._id)]);
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
  try {
    const r = await fetch("http://127.0.0.1:" + server.address().port + "/api/steam/accounts/" + a._id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "stock" }),
    });
    assert.equal(r.status, 409);
    assert.match((await r.json()).message, /G2G/);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test("rows G2G does not take are sent once more, then the accounts go back to stock and G2G is skipped for the country", async () => {
  const a = await account("co_r1", "CO");
  const link = await g2g.createRegionOffer("CO");
  rejectRows = true;
  const r = await g2g.loadAccounts(link, [String(a._id)]);
  assert.equal(r.confirmed, false);
  assert.equal(uploads.length, 1);
  const unit = await SteamG2gUnit.findOne({ steamAccountId: a._id });
  assert.equal(unit.state, "loading");

  // Not yet time to retry: nothing happens.
  await g2g.sweep();
  assert.equal(uploads.length, 1);

  // 9 min later, still not in G2G's stock: sent once more, same mail login.
  await SteamG2gUnit.updateOne({ _id: unit._id }, { $set: { uploadedAt: new Date(Date.now() - 9 * 60000) } });
  await g2g.sweep();
  assert.equal(uploads.length, 2);
  assert.equal((await SteamG2gUnit.findById(unit._id)).retries, 1);
  assert.equal(parseRow(uploads[1].csv)[10], parseRow(uploads[0].csv)[10], "same mail-page password in the re-sent row");

  // Still refused 13 min after the re-send: released, G2G skipped for CO.
  await SteamG2gUnit.updateOne({ _id: unit._id }, { $set: { uploadedAt: new Date(Date.now() - 13 * 60000) } });
  await g2g.sweep();
  assert.equal(uploads.length, 2, "no third try");
  assert.equal((await SteamG2gUnit.findById(unit._id)).state, "removed");
  assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
  assert.ok((await BuyerMailSession.findById(unit.sessionId)).revokedAt);
  const st = await SteamSalesState.findById("main").lean();
  assert.ok(Number(st.distributorSkip["g2g|CO"]) > Date.now(), "G2G skipped for CO");
  assert.ok(telegrams.some((t) => /did not take/.test(t)));

  // The distributor now sends it to Eldorado.
  const d = await distributor.run();
  assert.equal(d.decisions[0].market, "eldorado");
  assert.equal((await SteamAccount.findById(a._id)).stage, "listed");
});

test("a re-send that landed is confirmed, never released", async () => {
  const a = await account("pe_r1", "PE");
  const link = await g2g.createRegionOffer("PE");
  rejectRows = true;
  await g2g.loadAccounts(link, [String(a._id)]);
  rejectRows = false;
  await SteamG2gUnit.updateOne({ steamAccountId: a._id }, { $set: { uploadedAt: new Date(Date.now() - 9 * 60000) } });
  await g2g.sweep(); // re-send lands (the fake counts it)
  await g2g.sweep(); // confirmed from G2G's stock count
  assert.equal((await SteamG2gUnit.findOne({ steamAccountId: a._id })).state, "listed");
  assert.equal((await SteamAccount.findById(a._id)).stage, "listed");
});

test("an offer G2G blocks with an old failed upload pages the owner with the fix, and retries once cleared", async () => {
  const a = await account("cl_b1", "CL");
  const link = await g2g.createRegionOffer("CL");
  rejectRows = true;
  await g2g.loadAccounts(link, [String(a._id)]);
  rejectRows = false;
  failUpload = "G2G stock import failed (HTTP 409): Data already exists: Duplicated offer_id: " + link.offerId;
  await SteamG2gUnit.updateOne({ steamAccountId: a._id }, { $set: { uploadedAt: new Date(Date.now() - 9 * 60000) } });
  await g2g.sweep();
  assert.ok(telegrams.some((t) => /Upload more/.test(t) && t.includes(link.offerId)), "owner told how to clear it");
  assert.equal((await SteamG2gUnit.findOne({ steamAccountId: a._id })).state, "loading", "kept aside, not lost");
  failUpload = null; // owner pressed Upload more
  await g2g.sweep(); // re-send goes through
  await g2g.sweep(); // confirmed
  assert.equal((await SteamG2gUnit.findOne({ steamAccountId: a._id })).state, "listed");

  // A fresh load on a blocked offer: accounts back, a clear message.
  const b = await account("cl_b2", "CL");
  failUpload = "G2G stock import failed (HTTP 409): Data already exists: Duplicated offer_id: " + link.offerId;
  await assert.rejects(g2g.loadAccounts(link, [String(b._id)]), /Upload more/);
  assert.equal((await SteamAccount.findById(b._id)).stage, "stock");
});

test("offers made before the Steam Country filter get it once, keeping their other attributes", async () => {
  const link = await g2g.createRegionOffer("TR");
  // As G2G held the first live offers: country blank, link not marked.
  g2gOffers.get(link.offerId).offer_attributes = [
    { collection_id: "b7811700", dataset_id: "a5be43d2", value: "4 or below", is_subscription: false },
    { collection_id: "33e42e40", value: "0", is_subscription: false },
    { collection_id: "294cea68", value: "", is_subscription: false },
  ];
  await SteamSalesState.updateOne({ _id: "main", "g2gOffers.offerId": link.offerId }, { $set: { "g2gOffers.$.countrySet": false } });
  await g2g.sweep();
  assert.equal(updateCalls.length, 1);
  const attrs = g2gOffers.get(link.offerId).offer_attributes;
  assert.equal(attrs.find((a) => a.collection_id === "294cea68").value, "Turkey", "plain English name buyers search");
  assert.equal(attrs.find((a) => a.collection_id === "b7811700").dataset_id, "a5be43d2", "Games Owned kept");
  assert.ok(!updateCalls[0].fields.offerAttributes.some((a) => a.collection_id === "33e42e40"), "Steam Age left out of the edit");
  assert.equal(attrs.find((a) => a.collection_id === "33e42e40").value, "0", "Steam Age kept by G2G");
  assert.equal(attrs.length, 3);
  const st = await SteamSalesState.findById("main").lean();
  assert.equal(st.g2gOffers.find((l) => l.offerId === link.offerId).countrySet, true);
  await g2g.sweep();
  assert.equal(updateCalls.length, 1, "set once, never again");
});


test("boost allocation reserves an incoming account before either marketplace can list it", async () => {
  await SteamBoost.init();
  await SteamSalesState.updateOne({ _id: "main" }, { $set: {
    "boost.enabled": true, "boost.keepPerRegion": 0, "boost.maxAccounts": 1, "boost.prepareGames": false,
    "boost.games": [730, 1172470],
  } }, { upsert: true });
  const a = await account("boost_jp", "JP");
  const r = await distributor.run();
  assert.equal(r.placed, 1);
  assert.equal(r.decisions[0].market, "boost");
  assert.equal((await SteamAccount.findById(a._id)).stage, "boosting");
  const b = await SteamBoost.findOne({ steamAccountId: a._id }).lean();
  assert.ok(b);
  assert.equal((await boost.assignments()).accounts[0].id, String(b._id));
  assert.equal(await SteamG2gUnit.countDocuments({ steamAccountId: a._id }), 0);
  assert.equal(await SteamListing.countDocuments({}), 0);
  assert.equal((await sales._shared.stockView({ checkInboxes: false })).groups.length, 0);
  // A delayed report cannot turn CS2-only hours into an Apex+CS2 tier.
  boost._setDeps({ notify: async () => {} });
  await boost.report({ accounts: [{ id: String(b._id), gen: b.gen, state: "playing",
    playing: [730, 1172470], playtime: { 730: { minutes: 60000 }, 1172470: { minutes: 0 } },
  }] });
  const reported = await SteamBoost.findById(b._id).lean();
  assert.equal(reported.hours, 0);
  assert.equal(reported.reached1000At, null);
  await boost.stop(String(b._id), "test completed", "test");
  assert.equal((await boost.assignments()).accounts.length, 0);
  assert.equal((await SteamAccount.findById(a._id)).stage, "boosting", "hold remains until logout acknowledgement");
  await boost.report({ accounts: [{ id: String(b._id), gen: b.gen, stopped: true }] });
  assert.equal((await SteamAccount.findById(a._id)).stage, "stock");
  assert.equal((await sales._shared.stockView({ checkInboxes: false })).groups.length, 0,
    "a stopped boosted account stays out of empty-account offers");
});


test("a stage edit cannot overwrite a boost reservation made after its initial checks", async () => {
  const a = await account("boost_edit_race", "JP");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { admin: { id: "test", role: "superadmin" } }; next(); });
  app.use(require("../routes/steamAccountRoutes"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const original = SteamAccount.findOneAndUpdate;
  let raced = false;
  SteamAccount.findOneAndUpdate = function (...args) {
    const query = original.apply(this, args);
    const lean = query.lean.bind(query);
    query.lean = async function (...leanArgs) {
      // The distributor wins immediately before the editor's database write.
      raced = true;
      await SteamAccount.updateOne({ _id: a._id, stage: "stock" }, { $set: { stage: "boosting", boostedAt: new Date() } });
      return lean(...leanArgs);
    };
    return query;
  };
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/steam/accounts/" + a._id, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage: "sold" }),
    });
    assert.ok(raced);
    assert.equal(response.status, 409);
    assert.equal((await SteamAccount.findById(a._id)).stage, "boosting");
  } finally {
    SteamAccount.findOneAndUpdate = original;
    await new Promise(resolve => server.close(resolve));
  }
});


test("only Eldorado regional stock counts before allocating overflow to boosting", async () => {
  // Existing G2G inventory must not make an empty Eldorado shelf look stocked.
  const old = await account("legacy_jp", "JP");
  const link = await g2g.createRegionOffer("JP");
  await g2g.loadAccounts(link, [String(old._id)]);
  await SteamSalesState.updateOne({ _id: "main" }, { $set: {
    "boost.enabled": true, "boost.keepPerRegion": 1, "boost.maxAccounts": 5,
    "boost.games": [730, 1172470],
  } }, { upsert: true });
  await account("incoming_jp_empty", "JP", { signedUpAt: new Date(Date.now() - 1000) });
  await account("incoming_jp_boost", "JP");
  const loaded = await account("incoming_jp_loaded", "JP");
  await SteamAccount.updateOne({ _id: loaded._id }, { $set: { games: [{ appId: 730, name: "Counter-Strike 2" }] } });
  const r = await distributor.run();
  assert.deepEqual(r.decisions.map(d => d.market), ["eldorado", "boost"]);
  assert.equal((await SteamAccount.findById(loaded._id)).stage, "stock", "loaded stock waits for per-game selling");
  assert.equal((await SteamAccount.findById(old._id)).stage, "listed", "existing G2G stock remains reserved");
  assert.equal(await SteamG2gUnit.countDocuments({}), 1, "no new accounts sent to G2G");
});
