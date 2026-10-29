// Epic Games accounts sold on G2G and delivered by the server through the
// order page's account form (utils/epicG2g), against mongodb-memory-server with
// G2G, the Mac mail proxy and Telegram replaced by fakes.
//
// What must never happen: one account to two buyers, a buyer without the mail
// page password that opens THEIR account's mail, a second submission doubling
// a delivery, an account lost on a cancelled order, or a failure nobody hears.
process.env.SESSION_SECRET ||= "epic-g2g-test-secret";
process.env.CRED_SECRET ||= "epic-g2g-test-cred";
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
const BuyerMailSession = require("../models/BuyerMailSession");
const outlook = require("../utils/outlookGraphReader");
const telegram = require("../utils/telegram");
const mp = require("../utils/marketplaces");
const g2g = require("../utils/epicG2g");

// G2G's real form for Sker Ritual (Game Accounts), read 2026-10-29.
const TEMPLATE = [
  { form_content_type: "header", label: { en: "Game Account Details" } },
  { form_content_type: "section", section_id: "s1", label: { en: "GAME ACCOUNT DETAILS" }, sort_order: "100" },
  { form_content_type: "collection", collection_id: "a", label: { en: "Account ID" }, sort_order: "110", input_field: "text", is_required: true, is_reference: true, is_unique: true, value: "Game Account Information AccountID" },
  { form_content_type: "collection", collection_id: "b", label: { en: "Password" }, sort_order: "120", input_field: "password", is_required: true, value: "Game Account Informatiom Password" },
  { form_content_type: "collection", collection_id: "c", label: { en: "Character ID" }, sort_order: "130", input_field: "text", is_required: false, value: "Game Account CharacterID" },
  { form_content_type: "section", section_id: "s2", label: { en: "SECRET QUESTION & ANSWER" }, sort_order: "200" },
  { form_content_type: "collection", collection_id: "d", label: { en: "Secret Question" }, sort_order: "210", input_field: "text", value: "Game Account Secret Question" },
  { form_content_type: "collection", collection_id: "e", label: { en: "Secret Answer" }, sort_order: "220", input_field: "text", value: "Game Account Secret Answer" },
  { form_content_type: "section", section_id: "s3", label: { en: "REGISTRATION INFORMATION" }, sort_order: "300" },
  { form_content_type: "collection", collection_id: "f", label: { en: "First Name" }, sort_order: "310", input_field: "text", value: "Game Account Registration First Name" },
  { form_content_type: "collection", collection_id: "g", label: { en: "Last Name" }, sort_order: "320", input_field: "text", value: "Game Account Registration Last Name" },
  { form_content_type: "collection", collection_id: "h", label: { en: "Account Country" }, sort_order: "330", input_field: "text", value: "Game Account Registration Account Country" },
  { form_content_type: "collection", collection_id: "i", label: { en: "Date of Birth" }, sort_order: "340", input_field: "date", input_settings: { format: "%d %b %Y" }, value: "Game Account Registration DOB" },
  { form_content_type: "collection", collection_id: "j", label: { en: "Account Email" }, sort_order: "350", input_field: "text", is_required: true, is_unique: true, input_settings: { is_email: true, is_url: false }, value: "Game Account Registration Account Email" },
  { form_content_type: "collection", collection_id: "k", label: { en: "Email Password" }, sort_order: "360", input_field: "password", is_required: true, value: "Game Account Registration Email Password" },
  { form_content_type: "section", section_id: "s4", label: { en: "" }, sort_order: "400" },
  { form_content_type: "collection", collection_id: "l", label: { en: "Additional Note" }, sort_order: "410", input_field: "textarea", value: "Game Account Additional Note" },
];

const BOTH = ["Sker Ritual", "Home - A Unique Horror Adventure"];
const OFFER = "G1793242175124IO";

// ---- fakes -------------------------------------------------------------------
const sent = [];
telegram.sendTelegram = async (text) => {
  sent.push(text);
  return true;
};
let proxyDown = false;
const USES = new Map();
outlook.checkInbox = async (email) => {
  if (proxyDown) throw new Error("connect ECONNREFUSED 127.0.0.1:18124");
  const uses = USES.get(email);
  if (!uses) return { sellable: false, sharedWith: [], status: "unknown" };
  return { sellable: true, sharedWith: uses.filter((u) => u !== "epic"), status: "live" };
};
outlook.proxyHealth = async () => ({ ok: !proxyDown, inboxes: USES.size });

// A tiny G2G: orders move preparing -> delivering on start/mark, and a
// submission lands (delivered) unless `G.swallow` says the job never finishes.
const G = { orders: new Map(), submits: [], swallow: false, offer: { actual_qty: 15, reserved_qty: 0 }, qtyWrites: [], calls: [] };
function newOrder(id, qty = 1, extra = {}) {
  const o = {
    order_item_id: id,
    order_item_status: "preparing",
    seller_sub_status: "to_deliver",
    purchased_qty: qty,
    delivered_qty: 0,
    refunded_qty: 0,
    order_inventories: [],
    ...extra,
  };
  G.orders.set(id, o);
  return {
    orderItemId: id,
    offerId: OFFER,
    title: "Sker Ritual + Home | Epic Games PC Account | Email Change Supported",
    buyerId: "buyer-" + id,
    status: "preparing",
    sellerStatus: "to_deliver",
    purchasedQty: qty,
    deliveredQty: 0,
    amount: qty,
    raw: { created_at: Date.now() },
  };
}
mp.g2gFormTemplate = async () => {
  G.calls.push("template");
  return TEMPLATE;
};
mp.g2gOrder = async (id) => {
  const o = G.orders.get(id);
  if (!o) {
    const e = new Error("G2G order failed: Data was not found: order_exist");
    e.status = 404;
    throw e;
  }
  return JSON.parse(JSON.stringify(o));
};
mp.g2gStartDeliver = async (id) => {
  G.calls.push("start:" + id);
  const o = G.orders.get(id);
  if (o.seller_sub_status === "to_deliver") o.seller_sub_status = "start_deliver";
  return {};
};
mp.g2gMarkDelivering = async (id) => {
  G.calls.push("mark:" + id);
  const o = G.orders.get(id);
  if (o.order_item_status === "preparing") {
    o.order_item_status = "delivering";
    o.seller_sub_status = "delivering";
  }
  return {};
};
mp.g2gSubmitOrderAccounts = async (id, rows) => {
  G.submits.push({ id, rows });
  const o = G.orders.get(id);
  if (!G.swallow && o) {
    for (const r of rows) o.order_inventories.push({ inventory_id: "inv-" + G.submits.length, upload_reference: r.split(",")[0] });
    if (!G.landOnly) {
      o.delivered_qty = o.order_inventories.length;
      o.seller_sub_status = "awaiting_buyer_confirmation";
    }
  }
  return { order_item_id: id, upload_requested_at: Date.now() };
};
mp.g2gGetOffer = async (id) => ({ offer_id: id, service_id: g2g.GAME_ACCOUNTS_SERVICE, brand_id: "lgc_game_33228", title: "Sker Ritual + Home", delivery_speed: "manual", ...G.offer });
mp.g2gSetQuantity = async (id, qty) => {
  G.qtyWrites.push(qty);
  G.offer.actual_qty = qty;
  return { externalId: id };
};

let mongod;
const acc = {};

async function mkAccount(label, email, games, profile, uses = ["soop", "epic"]) {
  USES.set(email, uses);
  const a = await EpicAccount.create({
    accountId: "acc-" + label,
    displayName: label,
    label,
    email: encrypt(email),
    password: encrypt("EpicPw,\"" + label),
    accountDetails: profile ? encrypt(JSON.stringify(profile)) : "",
    source: "generated",
    status: "ok",
    library: games.map((t) => ({ title: t, namespace: "ns-" + t })),
    libraryCount: games.length,
  });
  acc[label] = { id: String(a._id), email };
  return a;
}

function parseCsvRow(row) {
  assert.ok(row.endsWith("\r\n"), "a row ends with CRLF");
  const s = row.slice(0, -2);
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
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

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("epic-g2g"));
  await EpicSale.init();
  const profile = { firstName: "Mara", lastName: "Lind", dateOfBirth: "1998-03-05", country: "SE" };
  // Oldest first: "rich" owns an extra game, so the lean ones go first.
  await mkAccount("rich", "rich.a@outlook.com", [...BOTH, "Fortnite"], profile);
  await mkAccount("lean-1", "lean.1@outlook.com", BOTH, profile);
  await mkAccount("lean-2", "lean.2@outlook.com", BOTH, profile);
  await mkAccount("lean-3", "lean.3@outlook.com", BOTH, profile);
  await mkAccount("lean-4", "lean.4@outlook.com", BOTH, profile);
  await mkAccount("sker-only", "sker.only@outlook.com", ["Sker Ritual"], profile);
  await mkAccount("twitchy", "tw.x@outlook.com", BOTH, profile, ["soop", "twitch", "epic"]);
  await EpicSalesState.create({ _id: "main" });
  await g2g.linkOffer({ offerId: OFFER, games: BOTH }, "test");
});

test.after(async () => {
  g2g.stop();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ---- the row -----------------------------------------------------------------

test("CSV row: G2G's field order, csv-string quoting, CRLF", () => {
  const row = g2g.buildRow(TEMPLATE, {
    login: "a@b.com",
    password: 'p,w"1',
    email: "a@b.com",
    mailPassword: "MAILPW",
    firstName: "Ann",
    lastName: "Lee",
    country: "Sweden",
    dob: "05 Mar 1998",
    note: "line one\nline two",
  });
  assert.equal(row, 'a@b.com,"p,w""1",,,,Ann,Lee,Sweden,05 Mar 1998,a@b.com,MAILPW,"line one\nline two"\r\n');
});

test("a form with a required field we can't fill is refused before any account is spent", () => {
  const odd = [...TEMPLATE, { form_content_type: "collection", label: { en: "Phone number" }, sort_order: "500", input_field: "text", is_required: true }];
  assert.throws(() => g2g.checkTemplate(odd), /Phone number/);
  assert.throws(
    () => g2g.buildRow(TEMPLATE, { login: "a@b.com", password: "x", email: "a@b.com", mailPassword: "" }),
    /Email Password/,
  );
});

test("dates, countries, and a note whose link has no path (G2G refuses paths)", () => {
  assert.equal(g2g.formatDate("1998-03-05", "%d %b %Y"), "05 Mar 1998");
  assert.equal(g2g.formatDate("bad", "%d %b %Y"), "");
  assert.equal(g2g.countryName("SE"), "Sweden");
  assert.equal(g2g.countryName("US"), "United States");
  const note = g2g.noteText(14);
  assert.match(note, /https:\/\/shop\.example\.test /);
  assert.doesNotMatch(note, /https?:\/\/[^\s/]+\/\S/, "no URL with a path");
  assert.match(note, /Epic account emails/);
  assert.match(note, /14 days/);
});

// ---- delivering ---------------------------------------------------------------

test("an order on an offer that isn't linked is not ours", async () => {
  const r = await g2g.deliverOrder({ orderItemId: "X-1", offerId: "G0000000000000ZZ", purchasedQty: 1 });
  assert.equal(r, null);
});

test("dry run: nothing set aside, nothing sent", async () => {
  const order = newOrder("1793300000000DRY-1");
  const r = await g2g.deliverOrder(order, { dryRun: true });
  assert.match(r.skipped, /dry run/);
  assert.equal(await EpicSale.countDocuments({}), 0);
  assert.equal(G.submits.length, 0);
  G.orders.delete("1793300000000DRY-1");
});

let firstSale;
test("a paid order is delivered through the account form, with the account's own mail login", async () => {
  sent.length = 0;
  const order = newOrder("1793300000000AAAA-1");
  const r = await g2g.deliverOrder(order, { dryRun: false });
  assert.equal(r.delivered, 1, JSON.stringify(r));
  assert.ok(G.calls.includes("start:1793300000000AAAA-1") && G.calls.includes("mark:1793300000000AAAA-1"));
  assert.equal(G.submits.length, 1);
  const cols = parseCsvRow(G.submits[0].rows[0]);
  // The leanest account, never the one with an extra game.
  assert.equal(cols[0], "lean.1@outlook.com");
  assert.equal(cols[1], 'EpicPw,"lean-1');
  assert.deepEqual(cols.slice(2, 5), ["", "", ""]);
  assert.deepEqual(cols.slice(5, 9), ["Mara", "Lind", "Sweden", "05 Mar 1998"]);
  assert.equal(cols[9], "lean.1@outlook.com");
  const sale = await EpicSale.findOne({ orderId: "g2g:1793300000000AAAA-1" }).lean();
  firstSale = sale;
  assert.ok(sale.deliveredAt && sale.submittedAt);
  assert.equal(sale.market, "g2g");
  assert.equal(sale.accounts.length, 1);
  assert.equal(String(sale.accounts[0].epicAccountId), acc["lean-1"].id);
  const a = await EpicAccount.findById(acc["lean-1"].id).lean();
  assert.equal(a.sold, true);
  const s = await BuyerMailSession.findById(sale.accounts[0].sessionId).lean();
  assert.equal(s.stage, "sold");
  assert.equal(s.marketplace, "g2g");
  assert.equal(s.inboxAddress, "lean.1@outlook.com");
  assert.ok(await bcrypt.compare(cols[10], s.passwordHash), "Email Password opens THIS account's mail page");
  assert.equal(s.passwordEnc, "", "the plain password is not kept after delivery");
  const days = (new Date(s.expiresAt) - new Date(s.soldAt)) / 864e5;
  assert.ok(Math.abs(days - 14) < 0.01, "open 14 days");
  assert.ok(sent.some((t) => /delivered automatically/.test(t) && /lean-1/.test(t)));
});

test("G2G listing the same order again never sends a second account", async () => {
  sent.length = 0;
  const order = newOrder("1793300000000AAAA-1");
  // G2G still shows it waiting (stale list) although it was delivered.
  const o = G.orders.get("1793300000000AAAA-1");
  o.order_item_status = "delivering";
  const before = G.submits.length;
  const r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /already delivered/);
  assert.equal(G.submits.length, before);
  assert.equal(await EpicAccount.countDocuments({ sold: true }), 1);
});

test("a submission G2G doesn't confirm waits, is re-sent ONCE with the same row, then pages", async () => {
  sent.length = 0;
  G.swallow = true;
  const order = newOrder("1793300000000BBBB-1");
  let r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /waiting for G2G to confirm/);
  assert.equal(G.submits.filter((s) => s.id === "1793300000000BBBB-1").length, 1);
  // Next minute: still inside the wait, nothing re-sent.
  r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /waiting for G2G to accept/);
  assert.equal(G.submits.filter((s) => s.id === "1793300000000BBBB-1").length, 1);
  // 11 minutes later: one more try, identical row (same account, same mail password).
  await EpicSale.updateOne({ orderId: "g2g:1793300000000BBBB-1" }, { $set: { submittedAt: new Date(Date.now() - 11 * 60000) } });
  r = await g2g.deliverOrder(order, { dryRun: false });
  const subs = G.submits.filter((s) => s.id === "1793300000000BBBB-1");
  assert.equal(subs.length, 2);
  assert.equal(subs[1].rows[0], subs[0].rows[0]);
  // 16 minutes after the second try: no third, the owner is told once.
  await EpicSale.updateOne({ orderId: "g2g:1793300000000BBBB-1" }, { $set: { submittedAt: new Date(Date.now() - 16 * 60000) } });
  r = await g2g.deliverOrder(order, { dryRun: false });
  r = await g2g.deliverOrder(order, { dryRun: false });
  assert.equal(G.submits.filter((s) => s.id === "1793300000000BBBB-1").length, 2);
  assert.equal(sent.filter((t) => /1793300000000BBBB-1/.test(t) && /NOT delivered automatically/.test(t)).length, 1);
  // G2G finally shows it: the next look finishes the sale.
  G.swallow = false;
  const o = G.orders.get("1793300000000BBBB-1");
  o.order_inventories.push({ inventory_id: "late" });
  o.delivered_qty = 1;
  r = await g2g.deliverOrder(order, { dryRun: false });
  assert.equal(r.delivered, 1);
  const sale = await EpicSale.findOne({ orderId: "g2g:1793300000000BBBB-1" }).lean();
  assert.ok(sale.deliveredAt);
  assert.equal(sale.needsAttention, false);
});

test("the Mac mail proxy asleep: nothing set aside, the owner is told, it goes out once the proxy answers", async () => {
  sent.length = 0;
  proxyDown = true;
  const order = newOrder("1793300000000CCCC-1");
  let r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /waiting for a ready account/);
  const sale = await EpicSale.findOne({ orderId: "g2g:1793300000000CCCC-1" }).lean();
  assert.equal(sale.accounts.length, 0, "no account set aside without a confirmed mail page");
  assert.ok(sent.some((t) => /Mac mail proxy is not answering/.test(t)));
  proxyDown = false;
  r = await g2g.deliverOrder(order, { dryRun: false });
  assert.equal(r.delivered, 1, JSON.stringify(r));
});

test("an inbox used for Twitch is never handed over", async () => {
  const sale = await EpicSale.find({ market: "g2g" }).lean();
  const used = sale.flatMap((s) => s.accounts.map((a) => String(a.epicAccountId)));
  assert.ok(!used.includes(acc.twitchy.id));
});

test("a cancelled order gives its account back and closes its mail login", async () => {
  sent.length = 0;
  G.swallow = true;
  const order = newOrder("1793300000000DDDD-1");
  await g2g.deliverOrder(order, { dryRun: false });
  const sale = await EpicSale.findOne({ orderId: "g2g:1793300000000DDDD-1" }).lean();
  const accountId = String(sale.accounts[0].epicAccountId);
  assert.equal((await EpicAccount.findById(accountId).lean()).sold, true);
  G.orders.get("1793300000000DDDD-1").order_item_status = "cancelled";
  // createdAt is immutable through Mongoose: age the row in the collection.
  await EpicSale.collection.updateOne({ _id: sale._id }, { $set: { createdAt: new Date(Date.now() - 20 * 60000) } });
  await g2g.sweep();
  const after = await EpicSale.findById(sale._id).lean();
  assert.ok(after.releasedAt);
  assert.equal((await EpicAccount.findById(accountId).lean()).sold, false);
  const s = await BuyerMailSession.findById(sale.accounts[0].sessionId).lean();
  assert.equal(s.revokedReason, "refunded");
  assert.ok(sent.some((t) => /cancelled before its Epic account was delivered/.test(t)));
  G.swallow = false;
});

test("automatic delivery switched off: the owner is paged, nothing is set aside", async () => {
  sent.length = 0;
  await g2g.setLink(OFFER, { enabled: false });
  const order = newOrder("1793300000000EEEE-1");
  const r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /off/);
  assert.equal(await EpicSale.countDocuments({ orderId: "g2g:1793300000000EEEE-1" }), 0);
  assert.ok(sent.some((t) => /switched OFF/.test(t)));
  await g2g.setLink(OFFER, { enabled: true });
});

test("the delivery-proof sweep sees our delivered orders", async () => {
  const p = await g2g.proofFor("1793300000000AAAA-1");
  assert.ok(p && p.accounts === 1 && p.sentAt);
  assert.match(p.method, /account form/);
  assert.equal(await g2g.proofFor("1793300000000ZZZZ-1"), null);
});

test("delivery details for a hand delivery: same row values, a fresh mail login once delivered", async () => {
  const d = await g2g.deliveryDetails(firstSale.orderId);
  assert.equal(d.delivered, true);
  const f = Object.fromEntries(d.accounts[0].fields);
  assert.equal(f["Account ID"], "lean.1@outlook.com");
  assert.equal(f["Date of Birth"], "05 Mar 1998");
  const sale = await EpicSale.findById(firstSale._id).lean();
  const s = await BuyerMailSession.findById(sale.accounts[0].sessionId).lean();
  assert.ok(await bcrypt.compare(f["Email Password"], s.passwordHash));
  assert.equal(s.passwordEnc, "", "a delivered order keeps no plain password");
});

test("the offer's stock number follows the ready accounts, never while an order is in flight", async () => {
  // Nothing in flight now (the cancelled one was released).
  G.offer.actual_qty = 15;
  G.qtyWrites.length = 0;
  await g2g.sweep();
  // Ready and owning both games: rich + lean-4 (lean-1..3 sold, lean-4 came
  // back from the cancelled order). sker-only lacks Home; twitchy's inbox is
  // used for Twitch.
  assert.equal(G.qtyWrites.length, 1);
  assert.equal(G.qtyWrites[0], 2);
  const st = await EpicSalesState.findById("main").lean();
  assert.equal(st.g2gOffers[0].lastStock, G.qtyWrites[0]);
  // In flight: untouched.
  G.swallow = true;
  const order = newOrder("1793300000000FFFF-1");
  await g2g.deliverOrder(order, { dryRun: false });
  G.offer.actual_qty = 99;
  G.qtyWrites.length = 0;
  await g2g.sweep();
  assert.equal(G.qtyWrites.length, 0);
  G.swallow = false;
});

test("an account on the order that G2G hasn't counted is never sent again", async () => {
  sent.length = 0;
  G.landOnly = true;
  const order = newOrder("1793300000000GGGG-1");
  await g2g.deliverOrder(order, { dryRun: false });
  assert.equal(G.submits.filter((s) => s.id === "1793300000000GGGG-1").length, 1);
  await EpicSale.updateOne({ orderId: "g2g:1793300000000GGGG-1" }, { $set: { submittedAt: new Date(Date.now() - 30 * 60000) } });
  const r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /on the order/);
  assert.equal(G.submits.filter((s) => s.id === "1793300000000GGGG-1").length, 1, "no second submission");
  assert.ok(sent.some((t) => /has not marked the order delivered/.test(t)));
  G.landOnly = false;
});

test("after an unexpected error the order is held: paged once, never sent by itself", async () => {
  sent.length = 0;
  const sales = require("../utils/epicSales");
  const real = sales.stockContext;
  sales.stockContext = async () => {
    throw new Error("boom");
  };
  const order = newOrder("1793300000000HHHH-1");
  let r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /held/);
  sales.stockContext = real;
  r = await g2g.deliverOrder(order, { dryRun: false });
  assert.match(r.skipped, /held/);
  assert.equal(G.submits.filter((s) => s.id === "1793300000000HHHH-1").length, 0);
  const sale = await EpicSale.findOne({ orderId: "g2g:1793300000000HHHH-1" }).lean();
  assert.equal(sale.held, true);
  assert.equal(sent.filter((t) => /held for you/.test(t)).length, 1);
  // The owner delivers it by hand: the sweep sees G2G count it and closes the sale.
  const o = G.orders.get("1793300000000HHHH-1");
  o.delivered_qty = 1;
  await EpicSale.collection.updateOne({ _id: sale._id }, { $set: { createdAt: new Date(Date.now() - 20 * 60000) } });
  await g2g.sweep();
  const after = await EpicSale.findById(sale._id).lean();
  assert.ok(after.deliveredAt);
  assert.ok(sent.some((t) => /done by hand/.test(t)));
});

test("linking refuses an offer outside Game Accounts or with a delivery setting we don't know", async () => {
  const real = mp.g2gGetOffer;
  mp.g2gGetOffer = async (id) => ({ offer_id: id, service_id: "0765978e-3fdf-48b4-bed3-184823aa439e", delivery_speed: "manual" });
  await assert.rejects(g2g.linkOffer({ offerId: "G1793242175124XX", games: BOTH }), /Game Accounts/);
  mp.g2gGetOffer = async (id) => ({ offer_id: id, service_id: g2g.GAME_ACCOUNTS_SERVICE, delivery_speed: "carrier pigeon" });
  await assert.rejects(g2g.linkOffer({ offerId: "G1793242175124XX", games: BOTH }), /unknown delivery setting/);
  await assert.rejects(g2g.linkOffer({ offerId: "nope", games: BOTH }), /offer number/);
  mp.g2gGetOffer = real;
});
