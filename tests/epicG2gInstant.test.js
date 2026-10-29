// Epic accounts on a G2G "Instant" (Auto delivery) offer: our server loads the
// accounts into G2G's own stock and records what G2G hands out (utils/epicG2g),
// against mongodb-memory-server with G2G, the Mac mail proxy and Telegram faked.
//
// Must never happen: an account in G2G's stock sold anywhere else, a sale left
// unrecorded (its mail page never gets its clock, the account never marked
// sold), a row whose mail password does not open that account's mail page, or
// a stored account whose email changed staying quietly on sale.
process.env.SESSION_SECRET ||= "epic-g2g-instant-secret";
process.env.CRED_SECRET ||= "epic-g2g-instant-cred";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";
process.env.EPIC_G2G_CONFIRM_GAP_MS = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { encrypt } = require("../utils/secretBox");
const EpicAccount = require("../models/EpicAccount");
const EpicSale = require("../models/EpicSale");
const EpicSalesState = require("../models/EpicSalesState");
const EpicG2gUnit = require("../models/EpicG2gUnit");
const BuyerMailSession = require("../models/BuyerMailSession");
const outlook = require("../utils/outlookGraphReader");
const telegram = require("../utils/telegram");
const mp = require("../utils/marketplaces");
const sales = require("../utils/epicSales");
const g2g = require("../utils/epicG2g");

const TEMPLATE = [
  { form_content_type: "section", label: { en: "GAME ACCOUNT DETAILS" }, sort_order: "100" },
  { form_content_type: "collection", label: { en: "Account ID" }, sort_order: "110", input_field: "text", is_required: true, is_reference: true },
  { form_content_type: "collection", label: { en: "Password" }, sort_order: "120", input_field: "password", is_required: true },
  { form_content_type: "collection", label: { en: "Character ID" }, sort_order: "130", input_field: "text" },
  { form_content_type: "collection", label: { en: "First Name" }, sort_order: "310", input_field: "text" },
  { form_content_type: "collection", label: { en: "Last Name" }, sort_order: "320", input_field: "text" },
  { form_content_type: "collection", label: { en: "Account Country" }, sort_order: "330", input_field: "text" },
  { form_content_type: "collection", label: { en: "Date of Birth" }, sort_order: "340", input_field: "date", input_settings: { format: "%d %b %Y" } },
  { form_content_type: "collection", label: { en: "Account Email" }, sort_order: "350", input_field: "text", is_required: true },
  { form_content_type: "collection", label: { en: "Email Password" }, sort_order: "360", input_field: "password", is_required: true },
  { form_content_type: "collection", label: { en: "Additional Note" }, sort_order: "410", input_field: "textarea" },
];
const BOTH = ["Sker Ritual", "Home - A Unique Horror Adventure"];
const OFFER = "G1793242175124IO";

// ---- fakes -------------------------------------------------------------------
const sent = [];
telegram.sendTelegram = async (t) => {
  sent.push(t);
  return true;
};
const USES = new Map();
outlook.checkInbox = async (email) => {
  const uses = USES.get(email);
  if (!uses) return { sellable: false, sharedWith: [], status: "unknown" };
  return { sellable: true, sharedWith: uses.filter((u) => u !== "epic"), status: "live" };
};
outlook.proxyHealth = async () => ({ ok: true, inboxes: USES.size });

// G2G: an Instant offer whose stock is a list of stored rows.
const G = { speed: "instant", stock: [], uploads: [], reject: false, orders: new Map(), items: new Map() };
function parseRow(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}
mp.g2gFormTemplate = async () => TEMPLATE;
mp.g2gGetOwnOffer = async (id) => ({
  offer_id: id,
  service_id: g2g.GAME_ACCOUNTS_SERVICE,
  brand_id: "lgc_game_33228",
  relation_id: "rel-1",
  title: "Sker Ritual + Home | Epic Games PC Account",
  delivery_speed: G.speed,
  actual_qty: G.qtyOverride != null ? G.qtyOverride : G.stock.length,
  available_qty: G.qtyOverride != null ? G.qtyOverride : G.stock.length,
  reserved_qty: 0,
});
mp.g2gStockStats = async () => (G.statsNull ? null : G.stock.length || G.uploads.length ? { active_inventory: G.stock.length } : null);
mp.g2gUploadStock = async (offer, csv) => {
  assert.equal(offer.relation_id, "rel-1");
  const rows = csv.split("\r\n").filter(Boolean).map(parseRow);
  G.uploads.push(rows);
  if (G.reject) return { ok: true };
  for (const r of rows) if (!G.stock.some((s) => s[0] === r[0])) G.stock.push(r);
  return { ok: true };
};
mp.g2gOrders = async ({ status }) => [...G.orders.values()].filter((o) => !status || o.status === status);
mp.g2gOrder = async (id) => {
  const it = G.items.get(id);
  if (!it) throw new Error("not found");
  return JSON.parse(JSON.stringify(it));
};
mp.g2gSubmitOrderAccounts = async () => {
  throw new Error("an Instant offer must never be filled in by hand");
};

// A buyer buys `n` units: G2G takes rows from its stock and makes an order.
let seq = 0;
function buy(n = 1, { minutesAgo = 1, status = "delivering", unknown = null } = {}) {
  const id = "17933000000" + String(++seq).padStart(2, "0") + "BUY-1";
  const taken = unknown ? [[unknown]] : G.stock.splice(0, n);
  G.items.set(id, {
    order_item_id: id,
    order_item_status: status,
    seller_sub_status: "awaiting_buyer_confirmation",
    purchased_qty: n,
    delivered_qty: n,
    order_inventories: taken.map((r, i) => ({ inventory_id: "inv-" + id + "-" + i, upload_reference: r[0] })),
  });
  G.orders.set(id, {
    orderItemId: id,
    offerId: OFFER,
    title: "Sker Ritual + Home | Epic Games PC Account",
    buyerId: "buyer-" + id,
    status,
    purchasedQty: n,
    deliveredQty: n,
    amount: n,
    raw: { created_at: Date.now() - minutesAgo * 60000 },
  });
  return { id, logins: taken.map((r) => r[0]) };
}

let mongod;
const acc = {};
async function mkAccount(label, email, games, uses = ["soop", "epic"]) {
  USES.set(email, uses);
  const a = await EpicAccount.create({
    accountId: "acc-" + label,
    label,
    email: encrypt(email),
    password: encrypt("Pw-" + label),
    accountDetails: encrypt(JSON.stringify({ firstName: "Ann", lastName: "Lee", dateOfBirth: "1999-12-31", country: "DE" })),
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
  await mongoose.connect(mongod.getUri("epic-g2g-instant"));
  await EpicSale.init();
  await EpicG2gUnit.init();
  for (let i = 1; i <= 4; i++) await mkAccount("a" + i, "a" + i + "@outlook.com", BOTH);
  await mkAccount("only-sker", "only.sker@outlook.com", ["Sker Ritual"]);
  await mkAccount("twitchy", "tw@outlook.com", BOTH, ["soop", "twitch", "epic"]);
  await EpicSalesState.create({ _id: "main" });
});

test.after(async () => {
  g2g.stop();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("linking an Auto-delivery offer makes it an Instant link", async () => {
  const row = await g2g.linkOffer({ offerId: OFFER, games: BOTH }, "test");
  assert.equal(row.mode, "instant");
  assert.equal(row.relationId, "rel-1");
});

test("every ready account that owns the games goes into G2G's stock, each with its own mail login", async () => {
  sent.length = 0;
  await g2g.sweep();
  assert.equal(G.uploads.length, 1);
  const logins = G.stock.map((r) => r[0]).sort();
  assert.deepEqual(logins, ["a1@outlook.com", "a2@outlook.com", "a3@outlook.com", "a4@outlook.com"]);
  const units = await EpicG2gUnit.find({ state: "listed" }).lean();
  assert.equal(units.length, 4);
  for (const r of G.stock) {
    const u = units.find((x) => x.login === r[0]);
    const s = await BuyerMailSession.findById(u.sessionId).lean();
    assert.equal(s.stage, "listed");
    assert.ok(s.passwordEnc, "kept so the row can be sent again");
    assert.ok(await bcrypt.compare(r[8], s.passwordHash), "Email Password opens THIS account's mail page");
    assert.equal(r[1], "Pw-" + u.label);
    assert.equal(r[6], "31 Dec 1999");
  }
  assert.ok(sent.some((t) => /4 Epic accounts loaded/.test(t)));
});

test("an account in G2G's stock can't be sold anywhere else", async () => {
  const ctx = await sales.stockContext({ fresh: false });
  const a1 = ctx.accounts.find((a) => String(a._id) === acc.a1.id);
  assert.equal(sales.readinessOf(a1, ctx).state, "listed");
  const ref = await sales.listingForAccount(acc.a1.id);
  assert.ok(ref && ref.market === "g2g", "the hand Deliver and Mark sold guards see it");
});

test("a second pass loads nothing twice", async () => {
  await g2g.sweep();
  assert.equal(G.uploads.length, 1);
  assert.equal(await EpicG2gUnit.countDocuments({}), 4);
});

test("a sale on G2G is recorded against the account G2G handed out", async () => {
  sent.length = 0;
  const { id, logins } = buy(1, { minutesAgo: 2 });
  await g2g.sweep();
  const sale = await EpicSale.findOne({ orderId: "g2g:" + id }).lean();
  assert.ok(sale, "sale recorded");
  assert.equal(sale.matchedBy, "g2g-stock");
  assert.equal(sale.accounts.length, 1);
  assert.equal(sale.accounts[0].login, logins[0]);
  const a = await EpicAccount.findById(sale.accounts[0].epicAccountId).lean();
  assert.equal(a.sold, true);
  const u = await EpicG2gUnit.findOne({ login: logins[0] }).lean();
  assert.equal(u.state, "sold");
  const s = await BuyerMailSession.findById(sale.accounts[0].sessionId).lean();
  assert.equal(s.stage, "sold");
  assert.equal(s.passwordEnc, "");
  const days = (new Date(s.expiresAt) - new Date(s.soldAt)) / 864e5;
  assert.ok(Math.abs(days - 14) < 0.01);
  assert.ok(Date.now() - new Date(s.soldAt).getTime() >= 60000, "the clock starts at the purchase, not at our scan");
  assert.ok(sent.some((t) => /sold instantly/.test(t)));
  // Seen again: nothing doubles.
  await g2g.sweep();
  assert.equal(await EpicSale.countDocuments({ orderId: "g2g:" + id }), 1);
  // The proof sweep knows it was G2G's own delivery.
  const p = await g2g.proofFor(id);
  assert.match(p.method, /instantly by G2G/);
});

test("an order handing out an Account ID we don't know is flagged", async () => {
  sent.length = 0;
  const { id } = buy(1, { unknown: "stranger@outlook.com" });
  await g2g.sweep();
  const sale = await EpicSale.findOne({ orderId: "g2g:" + id }).lean();
  assert.equal(sale.needsAttention, true);
  assert.match(sale.note, /stranger@outlook.com/);
  assert.ok(sent.some((t) => /needs a look/.test(t)));
});

test("a new account is topped up; one G2G does not take stays set aside and pages after a while", async () => {
  sent.length = 0;
  await mkAccount("late", "late@outlook.com", BOTH);
  G.reject = true;
  await g2g.sweep();
  const u = await EpicG2gUnit.findOne({ login: "late@outlook.com" }).lean();
  assert.equal(u.state, "loading", "not in G2G's stock yet");
  assert.equal((await sales.listingForAccount(acc.late.id)).market, "g2g", "still set aside: it may be there");
  await EpicG2gUnit.updateOne({ _id: u._id }, { $set: { uploadedAt: new Date(Date.now() - 25 * 60000) } });
  await g2g.sweep();
  await g2g.sweep();
  assert.equal(sent.filter((t) => /were sent to its stock/.test(t)).length, 1);
  // G2G finally shows it.
  G.reject = false;
  G.stock.push(["late@outlook.com"]);
  await g2g.sweep();
  assert.equal((await EpicG2gUnit.findById(u._id).lean()).state, "listed");
});

test("a stored account whose email changed with no order is pulled out of every sale path and the owner told how to remove it", async () => {
  sent.length = 0;
  const unit = await EpicG2gUnit.findOne({ state: "listed" }).lean();
  await BuyerMailSession.updateOne({ _id: unit.sessionId }, { $set: { revokedAt: new Date(), revokedReason: "email_changed" } });
  await sales.onListedEmailChanged([{ id: String(unit.sessionId), stage: "listed", listingId: null }]);
  const after = await EpicG2gUnit.findById(unit._id).lean();
  assert.equal(after.state, "removed");
  assert.equal((await EpicAccount.findById(unit.epicAccountId).lean()).sold, true);
  assert.ok(sent.some((t) => /Manage stock/.test(t) && t.includes(unit.login)));
});

test("an email change on a stored account that DID sell is just a sale", async () => {
  sent.length = 0;
  const unit = await EpicG2gUnit.findOne({ state: "listed" }).lean();
  const idx = G.stock.findIndex((r) => r[0] === unit.login);
  G.stock.splice(idx, 1);
  G.stock.unshift([unit.login]);
  const { id } = buy(1);
  await BuyerMailSession.updateOne({ _id: unit.sessionId }, { $set: { revokedAt: new Date(), revokedReason: "email_changed" } });
  await sales.onListedEmailChanged([{ id: String(unit.sessionId), stage: "listed", listingId: null }]);
  assert.equal((await EpicG2gUnit.findById(unit._id).lean()).state, "sold");
  assert.ok(await EpicSale.exists({ orderId: "g2g:" + id }));
  assert.ok(!sent.some((t) => /Someone else may be in this account/.test(t)));
});

test("an order on an Instant offer is never filled in by hand; one stuck for long is reported", async () => {
  sent.length = 0;
  const r = await g2g.deliverOrder({ orderItemId: "1793000000000OLD-1", offerId: OFFER, purchasedQty: 1, raw: { created_at: Date.now() - 20 * 60000 } });
  assert.match(r.skipped, /Instant offer/);
  assert.ok(sent.some((t) => /has not handed out an account/.test(t)));
});

test("an offer quantity that never moved (the old Manual number) never counts as loaded stock", async () => {
  await mkAccount("stale", "stale@outlook.com", BOTH);
  G.reject = true;
  G.statsNull = true;
  G.qtyOverride = 99;
  await g2g.sweep();
  await g2g.sweep();
  const u = await EpicG2gUnit.findOne({ login: "stale@outlook.com" }).lean();
  assert.equal(u.state, "loading", "not confirmed on a quantity that did not move");
  G.reject = false;
  G.statsNull = false;
  G.qtyOverride = null;
  G.stock.push(["stale@outlook.com"]);
  await g2g.sweep();
  assert.equal((await EpicG2gUnit.findById(u._id).lean()).state, "listed");
});

test("unlinking is refused while accounts sit in the offer's G2G stock", async () => {
  await assert.rejects(g2g.unlinkOffer(OFFER), /G2G stock/);
});

test("the offer switched back to Manual on G2G: its stored accounts go back on the shelf", async () => {
  sent.length = 0;
  G.speed = "manual";
  G.stock.length = 0;
  const listedBefore = await EpicG2gUnit.find({ state: { $in: ["listed", "loading"] } }).lean();
  assert.ok(listedBefore.length > 0);
  await g2g.sweep();
  const st = await EpicSalesState.findById("main").lean();
  assert.equal(st.g2gOffers[0].mode, "order");
  assert.equal(await EpicG2gUnit.countDocuments({ state: { $in: ["listed", "loading"] } }), 0);
  for (const u of listedBefore) {
    const s = await BuyerMailSession.findById(u.sessionId).lean();
    assert.ok(s.revokedAt);
    assert.equal(await sales.listingForAccount(String(u.epicAccountId)), null);
  }
  assert.ok(sent.some((t) => /back on Manual delivery/.test(t)));
});
