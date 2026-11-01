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
      offer_attributes: opts.offerAttributes.map((a) => ({ ...a, value: String(a.value) })),
    });
    return { offer: g2gOffers.get(id), offerId: id, url: "https://www.g2g.com/offer/" + id };
  },
  async g2gGetOwnOffer(id) {
    return g2gOffers.get(id);
  },
  async g2gUpdateOffer(id, fields) {
    updateCalls.push({ id, fields });
    if (fields.offerAttributes) g2gOffers.get(id).offer_attributes = fields.offerAttributes.map((a) => ({ ...a, value: String(a.value) }));
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
    { collection_id: "33e42e40", value: 0, is_subscription: false },
    { collection_id: "294cea68", value: "Japan", is_subscription: false },
  ]);
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

test("distributor rule: fewer unsold first, then recent sales, then G2G", () => {
  const stock = (e, g) => ({ eldorado: new Map([["JP", e]]), g2g: new Map([["JP", g]]) });
  const none = () => false;
  assert.equal(distributor.choose("JP", stock(1, 0), { eldorado: 0, g2g: 0 }, none).market, "g2g");
  assert.equal(distributor.choose("JP", stock(0, 2), { eldorado: 0, g2g: 9 }, none).market, "eldorado");
  assert.equal(distributor.choose("JP", stock(1, 1), { eldorado: 3, g2g: 1 }, none).market, "eldorado");
  assert.equal(distributor.choose("JP", stock(1, 1), { eldorado: 2, g2g: 2 }, none).market, "g2g");
  assert.equal(distributor.choose("JP", stock(0, 5), { eldorado: 0, g2g: 0 }, (m) => m === "eldorado").market, "g2g");
  assert.equal(distributor.choose("JP", stock(0, 0), {}, () => true), null);
});

test("the distributor places new accounts across both markets and creates missing offers", async () => {
  await account("kz_d1", "KZ", { signedUpAt: new Date(Date.now() - 3000) });
  await account("kz_d2", "KZ", { signedUpAt: new Date(Date.now() - 2000) });
  await account("kz_d3", "KZ", { signedUpAt: new Date(Date.now() - 1000) });

  await distributor.setMode("plan");
  const plan = await distributor.run();
  assert.equal(plan.plan, true);
  assert.deepEqual(plan.decisions.map((d) => d.market), ["g2g", "eldorado", "g2g"]);
  assert.equal(await SteamAccount.countDocuments({ stage: "listed" }), 0, "plan places nothing");

  await distributor.setMode("on");
  const r = await distributor.run();
  assert.equal(r.placed, 3);
  assert.equal(createCalls.length, 1, "one G2G offer created for KZ");
  assert.equal(await SteamG2gUnit.countDocuments({ state: "listed" }), 2);
  const eld = await SteamListing.findOne({ region: "KZ", status: "active" });
  assert.ok(eld, "an Eldorado KZ listing was created");
  assert.equal(eld.accounts.filter((u) => u.state === "listed").length, 1);
  assert.equal(await SteamAccount.countDocuments({ stage: "listed" }), 3);
  const v = await distributor.view();
  assert.equal(v.mode, "on");
  assert.ok(v.last.length >= 3);

  // A new KZ account: Eldorado has 1, G2G 2 → Eldorado, added to its listing.
  await account("kz_d4", "KZ");
  await distributor.run();
  const eld2 = await SteamListing.findById(eld._id);
  assert.equal(eld2.accounts.filter((u) => u.state === "listed").length, 2);
  assert.equal(await SteamListing.countDocuments({ region: "KZ" }), 1, "no second Eldorado listing");
});

test("when G2G can't take a country's accounts they go to Eldorado next pass", async () => {
  await account("ua_d1", "UA");
  failCreate = "G2G publish account offer failed (HTTP 400): bad";
  const r1 = await distributor.run();
  assert.equal(r1.placed, 0);
  assert.match(r1.decisions[0].error, /HTTP 400/);
  assert.equal((await SteamAccount.findOne({ accountName: "ua_d1" })).stage, "stock", "nothing half-placed");
  assert.ok(telegrams.some((t) => /skipped for UA/.test(t)));
  const r2 = await distributor.run();
  assert.equal(r2.placed, 1);
  assert.equal(r2.decisions[0].market, "eldorado");
  assert.equal((await SteamAccount.findOne({ accountName: "ua_d1" })).stage, "listed");
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
  assert.equal(attrs.find((a) => a.collection_id === "33e42e40").value, "0", "Steam Age kept");
  assert.equal(attrs.length, 3);
  const st = await SteamSalesState.findById("main").lean();
  assert.equal(st.g2gOffers.find((l) => l.offerId === link.offerId).countrySet, true);
  await g2g.sweep();
  assert.equal(updateCalls.length, 1, "set once, never again");
});
