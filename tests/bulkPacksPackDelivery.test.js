// Bulk packs v2 — one listing = one pack (docs/bulk-packs/PACKS-2.md §1-§2),
// the DELIVERY side (owner P1). The REAL Eldorado and G2G fulfillers and the
// REAL rent-farm services run over an in-memory Mongo:
//
//   - a bulk row's unit is a pack of N accounts: an order hands over exactly
//     units × N accounts (1 and 2 packs), refuses — nothing sent — and pages
//     when short, and never hands over one account more;
//   - G2G is only ever told UNITS (a pack of 5 delivered is delivered_qty 1),
//     the resume paths included;
//   - both stock syncs advertise whole packs, and 0 packs is the existing
//     autoPaused pause;
//   - a farm order on a bulk farming offer provisions units × N, and an
//     ordinary farm order stays × 1;
//   - next to every bulk case, an ordinary row behaves exactly as before.
//
// Faked, installed before anything loads: the marketplace connector
// (utils/marketplaces — every call recorded; a call to anything not listed here
// is a tripwire that throws), Telegram, G2G chat, the rent-farm provisioner
// (utils/operatorFarm) and the no-claim claim layer (utils/noclaimStock).
// Settings are an in-memory object. Nothing reaches the network or
// utils/settings.json.
process.env.CRED_SECRET = "bulk-packs-pack-delivery-secret-0123456789abcdef";
process.env.TG_TOKEN = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ------------------------------------------------------- the fake world --

const world = {
  af: {},
  calls: [], // [name, ...args] for every faked marketplace call
  tripwire: [], // marketplace calls nobody expected
  telegram: [],
  chat: [], // { buyerId, message }
  chatFail: null, // Error to throw from the next chat send
  g2gConfirmFail: "", // message to throw from the next g2gSetDeliveredQty
  eld: new Map(), // Eldorado offer id -> { id, offerState, quantity }
  eldOrders: [],
  g2gOrders: [],
  ncFree: 0, // free no-claim accounts the fake claim layer can hand out
  ncClaims: [], // { want, opts }
  ncSold: [], // markSold calls
  ncStock: new Map(), // externalId -> no-claim share (stockForListing)
  provisions: [], // farmFreshAccounts calls
  previews: [], // previewFreshAccounts counts
};
const calls = (name, id) =>
  world.calls.filter((c) => c[0] === name && (id === undefined || c[1] === String(id)));

function installFake(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const knownMp = {
  keyStatus: () => ({ eldorado: { configured: true } }),
  async eldoradoEnsureFreshSession() {},
  async eldoradoPaidOrders() {
    return world.eldOrders;
  },
  async eldoradoSendOrderMessage(order, msg) {
    world.calls.push(["eldoradoSendOrderMessage", String(order.id), String(msg)]);
  },
  async eldoradoMarkDelivered(id) {
    world.calls.push(["eldoradoMarkDelivered", String(id)]);
  },
  async eldoradoSetQuantity(id, n) {
    world.calls.push(["eldoradoSetQuantity", String(id), n]);
    const o = world.eld.get(String(id));
    if (o) o.quantity = n;
    return n;
  },
  async eldoradoOffer(id) {
    world.calls.push(["eldoradoOffer", String(id)]);
    const o = world.eld.get(String(id));
    return o ? { ...o } : null;
  },
  async eldoradoDelist(id) {
    world.calls.push(["eldoradoDelist", String(id)]);
    const o = world.eld.get(String(id));
    if (o) o.offerState = "Paused";
  },
  async eldoradoRelist(id) {
    world.calls.push(["eldoradoRelist", String(id)]);
    const o = world.eld.get(String(id));
    if (o) o.offerState = "Active";
  },
  async g2gOrderCounts() {
    return { preparing: world.g2gOrders.length, delivering: 0 };
  },
  async g2gPendingOrders() {
    return world.g2gOrders;
  },
  async g2gStartDeliver(id) {
    world.calls.push(["g2gStartDeliver", String(id)]);
  },
  async g2gMarkDelivering(id) {
    world.calls.push(["g2gMarkDelivering", String(id)]);
  },
  async g2gSetDeliveredQty(id, n) {
    world.calls.push(["g2gSetDeliveredQty", String(id), n]);
    if (world.g2gConfirmFail) {
      const m = world.g2gConfirmFail;
      world.g2gConfirmFail = "";
      throw new Error(m);
    }
    return {};
  },
  async g2gSetQuantity(id, n) {
    world.calls.push(["g2gSetQuantity", String(id), n]);
  },
  async g2gDelist(id) {
    world.calls.push(["g2gDelist", String(id)]);
  },
  async g2gRelist(id) {
    world.calls.push(["g2gRelist", String(id)]);
  },
};
installFake(
  "../utils/marketplaces",
  new Proxy(knownMp, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && /^[a-z]/.test(k) && k !== "then") {
        return async () => {
          world.tripwire.push(k);
          throw new Error("network tripwire: marketplaces." + k);
        };
      }
      return undefined;
    },
  }),
);

installFake("../utils/telegram", {
  async sendTelegram(msg) {
    world.telegram.push(String(msg));
    return true;
  },
  async sendToChat() {
    return true;
  },
  async sendToChatIds() {
    return true;
  },
  async sendTelegramToSeller() {
    return true;
  },
  getSuperChatIds: () => [],
  async getMe() {
    return {};
  },
});

installFake("../utils/g2gChat", {
  canSend: () => true,
  sdkAvailable: () => true,
  ensureWebSocket: () => true,
  async sendToBuyer(buyerId, message) {
    world.chat.push({ buyerId: String(buyerId), message: String(message) });
    if (world.chatFail) {
      const e = world.chatFail;
      world.chatFail = null;
      throw e;
    }
    return { ok: true };
  },
});

let poolSeq = 0;
installFake("../utils/operatorFarm", {
  async previewFreshAccounts({ count = 1 } = {}) {
    world.previews.push(count);
    return { eligibleTotal: 500, willAdd: count };
  },
  async farmFreshAccounts({ game, days, count, actor }) {
    world.provisions.push({ game, days, count, actor });
    const AvailableAccount = require("../models/AvailableAccount");
    const { encrypt } = require("../utils/secretBox");
    const added = [];
    for (let i = 0; i < count; i++) {
      const username = "pool" + String(++poolSeq).padStart(3, "0");
      const _id = new (require("mongoose").Types.ObjectId)();
      await AvailableAccount.collection.insertOne({
        _id,
        username,
        usernameLower: username,
        password: encrypt("pw-" + username),
      });
      added.push({ login: username, poolId: String(_id) });
    }
    return { added, farmUntil: new Date(Date.now() + days * 86400e3), skipped: [] };
  },
});

// The one claim layer, as the fulfillers see it: `want` accounts or fewer,
// the same accounts again for the same order (its resume anchor).
installFake("../utils/noclaimStock", {
  deliveryEnabled: () => true,
  async claimForSet(set, want, opts = {}) {
    world.ncClaims.push({ want, opts: { ...opts } });
    const n = Math.min(want, world.ncFree);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const tag = String(opts.market) + "_" + String(opts.orderId) + "_" + i;
      out.push({ ledgerId: "L-" + tag, login: "nc_" + tag, password: "pw-nc-" + tag });
    }
    return out;
  },
  async markSold(ids, opts) {
    world.ncSold.push({ ids: [...ids], ...opts });
    return ids.length;
  },
  async stockForListing(row) {
    const n = world.ncStock.get(String(row.externalId));
    return n === undefined ? undefined : n;
  },
});

// Settings last among the fakes: both fulfillers destructure getAutoFarm and
// getAccountListingSettings at require time.
const settings = require("../utils/settings");
settings.getAutoFarm = () => world.af;
settings.getAccountListingSettings = () => ({ enabled: false, autoDeliver: false });

// ------------------------------------------------------ modules under test --

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt } = require("../utils/secretBox");
const MarketplaceListing = require("../models/MarketplaceListing");
const BulkOffer = require("../models/BulkOffer");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const AvailableAccount = require("../models/AvailableAccount");
const CampaignDrops = require("../models/CampaignDrops");
const { packSizeOf } = require("../utils/bulkPacks/packMath");
const eldorado = require("../utils/eldoradoFulfiller");
const g2g = require("../utils/g2gFulfiller");
const eldFarm = require("../utils/eldoradoFarmService");
const g2gFarm = require("../utils/g2gFarmService");

// ---------------------------------------------------------------- helpers --

const oid = () => new mongoose.Types.ObjectId();

async function insertOffer(doc) {
  const _id = oid();
  const now = new Date();
  await BulkOffer.collection.insertOne({
    _id,
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    minQty: 5,
    state: "live",
    open: true,
    slotKey: "packDelivery|" + String(_id),
    reserved: [],
    externalId: "",
    lastError: "",
    attention: "",
    history: [],
    createdAt: now,
    updatedAt: now,
    ...doc,
  });
  return _id;
}

// A listing row. Every real one carries its DropSet (the schema requires it
// unless the row is by-game or an account listing), so fixtures do too.
async function insertRow(doc) {
  const _id = oid();
  const now = new Date();
  // A pack title only on a real pack row: production never has one elsewhere,
  // and packMath.packMismatch refuses an order whose title promises a pack
  // the row does not record.
  const n = doc && doc.bulkOfferId ? Number(doc.bulkPackSize) || 0 : 0;
  await MarketplaceListing.collection.insertOne({
    _id,
    set: oid(),
    title: n >= 2 ? "Rust Twitch Drops bundle — PACK OF " + n + " ACCOUNTS" : "Rust Twitch Drops bundle",
    price: 4,
    status: "active",
    origin: "manual",
    units: [],
    createdAt: now,
    updatedAt: now,
    ...doc,
  });
  return _id;
}

// `count` archive accounts with readable passwords, as reserved units.
async function seedUnits(prefix, count) {
  const units = [];
  for (let i = 1; i <= count; i++) {
    const login = prefix + String(i).padStart(2, "0");
    const _id = oid();
    await BotAccount.collection.insertOne({
      _id,
      clientSecret: "cs-" + login,
      login,
      credUsername: login,
      credPassword: encrypt("pw-" + login),
      hasPassword: true,
    });
    units.push({
      contentId: "",
      accountId: String(_id),
      login,
      addedAt: new Date(),
      deliveredAt: null,
      orderId: "",
      messagedAt: null,
    });
  }
  return units;
}

// A bulk dropset pack row of N accounts per unit, backed by `count` units.
async function packRow({ market, externalId, prefix, count, n = 5, extra = {} }) {
  const bulkOfferId = await insertOffer({ market, minQty: n, externalId });
  const units = await seedUnits(prefix, count);
  await insertRow({ marketplace: market, externalId, bulkOfferId, bulkPackSize: n, units, ...extra });
  return { bulkOfferId, units };
}

async function noclaimSet() {
  const _id = oid();
  await DropSet.collection.insertOne({
    _id,
    name: "Overwatch no-claim bundle",
    stockSource: "noclaim",
    items: [{ name: "Sun Tea Icon", game: "Overwatch", qty: 1 }],
    price: 1,
  });
  return _id;
}

const rowBy = (externalId) => MarketplaceListing.collection.findOne({ externalId });
const logins = (msg) => [...String(msg).matchAll(/Username: (\S+)/g)].map((m) => m[1]);
const stamped = (row, orderId) => (row.units || []).filter((u) => u.orderId === orderId);
const free = (row) => (row.units || []).filter((u) => !u.orderId && !u.deliveredAt);

function eldOrder(id, offerId, qty, extra = {}) {
  return {
    id,
    offerId,
    purchaseQuantity: qty,
    orderOfferDetails: { offerTitle: "Rust bundle — PACK OF 5 ACCOUNTS" },
    buyerName: "buyer-" + id,
    ...extra,
  };
}

function g2gOrder(id, offerId, qty, extra = {}) {
  return {
    orderItemId: id,
    offerId,
    purchasedQty: qty,
    deliveredQty: 0,
    buyerId: "buyer-" + id,
    currency: "USD",
    amount: 4 * qty,
    title: "Rust bundle — PACK OF 5 ACCOUNTS",
    ...extra,
  };
}

// ------------------------------------------------------------------ setup --

let mongod;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulkPacksPackDelivery"));
  await Promise.all([
    MarketplaceListing.init(),
    BulkOffer.init(),
    FarmServiceOrder.init(),
    AvailableAccount.init(),
  ]);
  // The farm services only provision a game the farm knows.
  await CampaignDrops.collection.insertOne({ game: "Rust" });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  world.af = {};
  world.calls.length = 0;
  world.tripwire.length = 0;
  world.telegram.length = 0;
  world.chat.length = 0;
  world.chatFail = null;
  world.g2gConfirmFail = "";
  world.eld.clear();
  world.eldOrders = [];
  world.g2gOrders = [];
  world.ncFree = 0;
  world.ncClaims.length = 0;
  world.ncSold.length = 0;
  world.ncStock.clear();
  world.provisions.length = 0;
  world.previews.length = 0;
  await Promise.all([
    MarketplaceListing.collection.deleteMany({}),
    BulkOffer.collection.deleteMany({}),
    BotAccount.collection.deleteMany({}),
    DropSet.collection.deleteMany({}),
    FarmServiceOrder.collection.deleteMany({}),
    AvailableAccount.collection.deleteMany({}),
  ]);
});

// ------------------------------------------------------------------ model --

test("model: bulkPackSize is a Number defaulting to 0, and only a row with a bulk offer reads as a pack", async () => {
  const path = MarketplaceListing.schema.path("bulkPackSize");
  assert.ok(path, "the field is declared");
  assert.equal(path.instance, "Number");
  const plain = new MarketplaceListing({ marketplace: "eldorado", externalId: "x", title: "t" });
  assert.equal(plain.bulkPackSize, 0);
  assert.equal(packSizeOf(plain), 1);

  const bulkOfferId = oid();
  const made = await MarketplaceListing.create({
    set: oid(),
    marketplace: "g2g",
    externalId: "model-pack",
    title: "Rust — PACK OF 5 ACCOUNTS",
    bulkOfferId,
    bulkPackSize: 5,
  });
  const hydrated = await MarketplaceListing.findById(made._id);
  assert.equal(hydrated.bulkPackSize, 5);
  assert.equal(packSizeOf(hydrated), 5);
  assert.equal(packSizeOf(await MarketplaceListing.findById(made._id).lean()), 5);

  // A stray pack size on a row that is not a bulk offer's is still × 1.
  const stray = await MarketplaceListing.create({
    set: oid(),
    marketplace: "g2g",
    externalId: "model-stray",
    title: "t",
    bulkPackSize: 5,
  });
  assert.equal(packSizeOf(await MarketplaceListing.findById(stray._id)), 1);
});

// ---------------------------------------------------- eldorado, dropset --

test("eldorado pack: 1 pack = 5 accounts in one message; 2 packs = exactly 10, never the 11th; quantity = whole packs left", async () => {
  const { units } = await packRow({ market: "eldorado", externalId: "eld-pack", prefix: "ep", count: 16 });

  const one = await eldorado.deliverOrder(eldOrder("eo-1", "eld-pack", 1), { dryRun: false });
  assert.equal(one.delivered, 5, JSON.stringify(one));
  let sends = calls("eldoradoSendOrderMessage", "eo-1");
  assert.equal(sends.length, 1, "one message for the whole pack");
  const first = sends[0][2];
  for (let i = 1; i <= 5; i++) assert.match(first, new RegExp("=== ACCOUNT " + i + " of 5 ==="));
  assert.doesNotMatch(first, /ACCOUNT 6 of/);
  assert.deepEqual(logins(first), units.slice(0, 5).map((u) => u.login));
  for (const l of logins(first)) assert.match(first, new RegExp("Password: pw-" + l + "\\n"));
  assert.equal(calls("eldoradoMarkDelivered", "eo-1").length, 1);
  let row = await rowBy("eld-pack");
  assert.equal(stamped(row, "eo-1").length, 5);
  assert.ok(stamped(row, "eo-1").every((u) => u.deliveredAt));
  // 11 accounts left = 2 whole packs (a partial pack can never sell).
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-pack").pop(), ["eldoradoSetQuantity", "eld-pack", 2]);

  const two = await eldorado.deliverOrder(eldOrder("eo-2", "eld-pack", 2), { dryRun: false });
  assert.equal(two.delivered, 10, JSON.stringify(two));
  sends = calls("eldoradoSendOrderMessage", "eo-2");
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /=== ACCOUNT 10 of 10 ===/);
  assert.doesNotMatch(sends[0][2], /ACCOUNT 11 of/);
  assert.equal(logins(sends[0][2]).length, 10);
  row = await rowBy("eld-pack");
  assert.equal(stamped(row, "eo-2").length, 10, "exactly the two packs' accounts");
  assert.equal(free(row).length, 1, "the 16th account is never handed over");
  const handed = new Set([...logins(first), ...logins(sends[0][2])]);
  assert.equal(handed.size, 15, "no account went out twice");
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-pack").pop(), ["eldoradoSetQuantity", "eld-pack", 0]);

  // A retry of a delivered order sends nothing.
  const again = await eldorado.deliverOrder(eldOrder("eo-2", "eld-pack", 2), { dryRun: false });
  assert.equal(again.skipped, "already delivered");
  assert.equal(calls("eldoradoSendOrderMessage", "eo-2").length, 1);

  // Dry run: counts accounts, sends nothing.
  await packRow({ market: "eldorado", externalId: "eld-pack-dry", prefix: "ed", count: 10 });
  const dry = await eldorado.deliverOrder(eldOrder("eo-dry", "eld-pack-dry", 2), { dryRun: true });
  assert.match(dry.wouldSend, /^10 account\(s\)/);
  assert.equal(calls("eldoradoSendOrderMessage", "eo-dry").length, 0);
  assert.deepEqual(world.tripwire, []);
});

test("eldorado pack: short of the order's packs refuses with nothing sent, and the tick pages once", async () => {
  await packRow({ market: "eldorado", externalId: "eld-short", prefix: "es", count: 7 });
  const r = await eldorado.deliverOrder(eldOrder("eo-s1", "eld-short", 2), { dryRun: false });
  assert.match(String(r.error), /^bulk pack short: not enough reserved stock \(7 of 10\)/);
  assert.equal(eldorado.alertsOperator(r.error), true);
  assert.equal(world.calls.filter((c) => c[0] !== "eldoradoOffer").length, 0, "nothing sent, nothing marked");
  assert.equal(stamped(await rowBy("eld-short"), "eo-s1").length, 0);

  // One pack still fits: the short order above never blocks the next one.
  const ok = await eldorado.deliverOrder(eldOrder("eo-s2", "eld-short", 1), { dryRun: false });
  assert.equal(ok.delivered, 5);
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-short").pop(), ["eldoradoSetQuantity", "eld-short", 0]);

  // Through the paid-order tick: a page, once per order.
  world.af = { eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false };
  world.eldOrders = [eldOrder("eo-s3", "eld-short", 1)];
  const res = await eldorado.deliverPaidOrders();
  assert.match(String(res.results[0].error), /^bulk pack short: not enough reserved stock \(2 of 5\)/);
  const pages = () => world.telegram.filter((m) => m.includes("eo-s3"));
  assert.equal(pages().length, 1);
  assert.match(pages()[0], /PAID and the bot cannot ship it/);
  await eldorado.deliverPaidOrders();
  assert.equal(pages().length, 1, "one page per order, not one per tick");
  assert.equal(calls("eldoradoSendOrderMessage", "eo-s3").length, 0);
  assert.deepEqual(world.tripwire, []);
});

// --------------------------------------------------- eldorado, no-claim --

test("eldorado no-claim pack: the claim is asked for units × N, all of them ship, short pages; sale booked per account", async () => {
  const set = await noclaimSet();
  const bulkOfferId = await insertOffer({ source: "noclaim", minQty: 5, externalId: "eld-nc-pack" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-nc-pack", noclaimStock: true, set, bulkOfferId, bulkPackSize: 5, price: 4 });
  world.ncFree = 12;

  const r = await eldorado.deliverOrder(
    eldOrder("eo-nc1", "eld-nc-pack", 2, { totalPrice: { amount: 8, currency: "USD" } }),
    { dryRun: false },
  );
  assert.equal(r.delivered, 10, JSON.stringify(r));
  assert.equal(world.ncClaims.at(-1).want, 10, "2 packs of 5");
  assert.equal(world.ncClaims.at(-1).opts.mode, "sold");
  const msg = calls("eldoradoSendOrderMessage", "eo-nc1")[0][2];
  assert.match(msg, /=== ACCOUNT 10 of 10 ===/);
  assert.equal(logins(msg).length, 10);
  assert.equal(stamped(await rowBy("eld-nc-pack"), "eo-nc1").length, 10);
  // $8 for 10 accounts: each ledger row books $0.80, never the pack's $8/2.
  assert.equal(world.ncSold.at(-1).ids.length, 10);
  assert.equal(world.ncSold.at(-1).priceUsd, 0.8);

  // No order total: the row's price is ONE pack's, spread over its 5.
  const r2 = await eldorado.deliverOrder(eldOrder("eo-nc2", "eld-nc-pack", 1), { dryRun: false });
  assert.equal(r2.delivered, 5);
  assert.equal(world.ncClaims.at(-1).want, 5);
  assert.equal(world.ncSold.at(-1).priceUsd, 0.8);

  // Short: 7 free for 2 packs → refused, nothing sent, pages.
  world.ncFree = 7;
  const s = await eldorado.deliverOrder(eldOrder("eo-nc3", "eld-nc-pack", 2), { dryRun: false });
  assert.match(String(s.error), /^bulk pack short: only 7 of 10 account\(s\) could be claimed/);
  assert.equal(eldorado.alertsOperator(s.error), true);
  assert.equal(calls("eldoradoSendOrderMessage", "eo-nc3").length, 0);

  // Control: an ordinary no-claim row asks for exactly what was bought.
  const set2 = await noclaimSet();
  await insertRow({ marketplace: "eldorado", externalId: "eld-nc-single", noclaimStock: true, set: set2, price: 3 });
  world.ncFree = 12;
  const c = await eldorado.deliverOrder(
    eldOrder("eo-nc4", "eld-nc-single", 2, { totalPrice: 5 }),
    { dryRun: false },
  );
  assert.equal(c.delivered, 2);
  assert.equal(world.ncClaims.at(-1).want, 2);
  assert.equal(world.ncSold.at(-1).priceUsd, 2.5);
  world.ncFree = 1;
  const cs = await eldorado.deliverOrder(eldOrder("eo-nc5", "eld-nc-single", 2), { dryRun: false });
  assert.match(String(cs.error), /^only 1 of 2 account\(s\) could be claimed/);
  assert.deepEqual(world.tripwire, []);
});

// --------------------------------------------------- eldorado, controls --

test("eldorado ordinary rows are unchanged: × 1 on a units row and on a stray pack size; a size-less bulk row is refused", async () => {
  // An ordinary reserved-units row.
  const plain = await seedUnits("op", 3);
  await insertRow({ marketplace: "eldorado", externalId: "eld-plain", origin: "auto", units: plain });
  const r = await eldorado.deliverOrder(eldOrder("eo-p1", "eld-plain", 2), { dryRun: false });
  assert.equal(r.delivered, 2);
  const msg = calls("eldoradoSendOrderMessage", "eo-p1")[0][2];
  assert.match(msg, /=== ACCOUNT 2 of 2 ===/);
  assert.equal(logins(msg).length, 2);
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-plain").pop(), ["eldoradoSetQuantity", "eld-plain", 1]);
  const s = await eldorado.deliverOrder(eldOrder("eo-p2", "eld-plain", 2), { dryRun: false });
  assert.match(String(s.error), /^not enough reserved stock \(1 of 2\)/);
  assert.equal(eldorado.alertsOperator(s.error), false, "an ordinary row pages exactly as before");
  const one = await eldorado.deliverOrder(eldOrder("eo-p3", "eld-plain", 1), { dryRun: false });
  assert.equal(one.delivered, 1);
  assert.doesNotMatch(calls("eldoradoSendOrderMessage", "eo-p3")[0][2], /=== ACCOUNT/, "a single account keeps its full card");

  // A pack size on a row no bulk offer owns is not a pack.
  const stray = await seedUnits("os", 3);
  await insertRow({ marketplace: "eldorado", externalId: "eld-stray", origin: "auto", bulkPackSize: 5, units: stray });
  const st = await eldorado.deliverOrder(eldOrder("eo-p4", "eld-stray", 2), { dryRun: false });
  assert.equal(st.delivered, 2);
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-stray").pop(), ["eldoradoSetQuantity", "eld-stray", 1]);

  // A bulk row with no pack size (no v1 row ever existed): refused and paged,
  // never delivered as single accounts (guard — see the no-pack-size test).
  const v1 = await seedUnits("ov", 6);
  await insertRow({ marketplace: "eldorado", externalId: "eld-v1", bulkOfferId: await insertOffer({}), units: v1 });
  const v = await eldorado.deliverOrder(eldOrder("eo-p5", "eld-v1", 5), { dryRun: false });
  assert.match(String(v.error), /bulk pack short: .*no pack size/);
  assert.equal(calls("eldoradoSendOrderMessage", "eo-p5").length, 0);
  assert.deepEqual(world.tripwire, []);
});

// --------------------------------------------------------- g2g, dropset --

test("g2g pack: 1 pack = 5 accounts and delivered_qty 1; 2 packs = exactly 10 and delivered_qty 2, never the 11th", async () => {
  const { units } = await packRow({ market: "g2g", externalId: "g2g-pack", prefix: "gp", count: 16 });

  const one = await g2g.deliverOrder(g2gOrder("go-1", "g2g-pack", 1), { dryRun: false });
  assert.equal(one.delivered, 1, "G2G counts the pack, not its accounts: " + JSON.stringify(one));
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-1"), [["g2gSetDeliveredQty", "go-1", 1]]);
  assert.equal(world.chat.length, 1, "one message for the whole pack");
  const first = world.chat[0].message;
  assert.match(first, /^Order go-1\n/);
  for (let i = 1; i <= 5; i++) assert.match(first, new RegExp("=== ACCOUNT " + i + " of 5 ==="));
  assert.doesNotMatch(first, /ACCOUNT 6 of/);
  assert.deepEqual(logins(first), units.slice(0, 5).map((u) => u.login));
  let row = await rowBy("g2g-pack");
  assert.equal(stamped(row, "go-1").length, 5);
  assert.ok(stamped(row, "go-1").every((u) => u.messagedAt && u.deliveredAt));

  const two = await g2g.deliverOrder(g2gOrder("go-2", "g2g-pack", 2), { dryRun: false });
  assert.equal(two.delivered, 2);
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-2"), [["g2gSetDeliveredQty", "go-2", 2]]);
  const second = world.chat[1].message;
  assert.match(second, /=== ACCOUNT 10 of 10 ===/);
  assert.doesNotMatch(second, /ACCOUNT 11 of/);
  assert.equal(logins(second).length, 10);
  row = await rowBy("g2g-pack");
  assert.equal(stamped(row, "go-2").length, 10, "exactly the two packs' accounts");
  assert.equal(free(row).length, 1, "the 16th account is never handed over");
  assert.equal(new Set([...logins(first), ...logins(second)]).size, 15);

  // Dry run: counts accounts, sends and confirms nothing.
  await packRow({ market: "g2g", externalId: "g2g-pack-dry", prefix: "gd", count: 10 });
  const dry = await g2g.deliverOrder(g2gOrder("go-dry", "g2g-pack-dry", 2), { dryRun: true });
  assert.match(dry.wouldSend, /^10 account\(s\)/);
  assert.equal(calls("g2gSetDeliveredQty", "go-dry").length, 0);
  assert.equal(world.chat.length, 2);
  assert.deepEqual(world.tripwire, []);
});

test("g2g pack: short of the order's packs refuses with nothing sent, and the tick pages", async () => {
  await packRow({ market: "g2g", externalId: "g2g-short", prefix: "gs", count: 7 });
  const r = await g2g.deliverOrder(g2gOrder("go-s1", "g2g-short", 2), { dryRun: false });
  assert.match(String(r.error), /^bulk pack short: not enough reserved stock \(7 of 10\)/);
  assert.equal(world.chat.length, 0);
  assert.equal(world.calls.length, 0, "no G2G call of any kind");
  assert.equal(stamped(await rowBy("g2g-short"), "go-s1").length, 0, "nothing reserved to it");

  world.af = { g2gAutoDeliver: true, g2gDeliverDryRun: false };
  world.g2gOrders = [g2gOrder("go-s2", "g2g-short", 2)];
  const res = await g2g.deliverPendingOrders();
  assert.equal(res.checked, 1);
  const pages = world.telegram.filter((m) => m.includes("go-s2"));
  assert.equal(pages.length, 1);
  assert.match(pages[0], /PAID and the bot cannot ship it/);
  assert.match(pages[0], /bulk pack short/);
  assert.equal(calls("g2gSetDeliveredQty").length, 0);
  assert.deepEqual(world.tripwire, []);
});

test("g2g resume paths report UNITS: a failed send retries the SAME accounts, a refused count re-confirms, a hand-confirmed order closes", async () => {
  await packRow({ market: "g2g", externalId: "g2g-resume", prefix: "gr", count: 20 });

  // (a) The first send fails: the pack stays reserved to the order, nothing is confirmed.
  world.chatFail = new Error("SendBird 503");
  const a1 = await g2g.deliverOrder(g2gOrder("go-r1", "g2g-resume", 1), { dryRun: false });
  assert.match(String(a1.error), /^chat send failed/);
  assert.equal(calls("g2gSetDeliveredQty", "go-r1").length, 0);
  let row = await rowBy("g2g-resume");
  assert.equal(stamped(row, "go-r1").length, 5);
  const tried = logins(world.chat[0].message);
  // The retry re-sends those five — no fresh account — and tells G2G 1, not 5.
  const a2 = await g2g.deliverOrder(g2gOrder("go-r1", "g2g-resume", 1), { dryRun: false });
  assert.equal(a2.delivered, 1, JSON.stringify(a2));
  assert.equal(a2.source, "retry-send");
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-r1"), [["g2gSetDeliveredQty", "go-r1", 1]]);
  assert.deepEqual(logins(world.chat[1].message), tried);
  row = await rowBy("g2g-resume");
  assert.equal(stamped(row, "go-r1").length, 5);
  assert.equal(free(row).length, 15);

  // (b) Sent, but G2G refused the count: re-confirmed as 2 packs, never 10, never re-sent.
  world.g2gConfirmFail = "G2G delivered qty failed (HTTP 500)";
  const b1 = await g2g.deliverOrder(g2gOrder("go-r2", "g2g-resume", 2), { dryRun: false });
  assert.equal(b1.awaitingConfirm, true, JSON.stringify(b1));
  assert.equal(b1.sent, 2);
  const chatsBefore = world.chat.length;
  const b2 = await g2g.deliverOrder(g2gOrder("go-r2", "g2g-resume", 2), { dryRun: false });
  assert.equal(b2.delivered, 2);
  assert.equal(b2.source, "confirm-only");
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-r2").map((c) => c[2]), [2, 2]);
  assert.equal(world.chat.length, chatsBefore, "the confirm never re-sends credentials");
  assert.equal(stamped(await rowBy("g2g-resume"), "go-r2").length, 10);

  // (c) Handed to the operator (no chat), then confirmed by hand on G2G.
  const offline = new Error("no SDK");
  offline.__g2gChatUnavailable = true;
  world.chatFail = offline;
  const c1 = await g2g.deliverOrder(g2gOrder("go-r3", "g2g-resume", 1), { dryRun: false });
  assert.equal(c1.pending, 1);
  assert.equal(calls("g2gSetDeliveredQty", "go-r3").length, 0);
  const c2 = await g2g.deliverOrder(
    g2gOrder("go-r3", "g2g-resume", 1, { deliveredQty: 1 }),
    { dryRun: false },
  );
  assert.equal(c2.source, "confirmed-on-g2g");
  assert.equal(c2.delivered, 1, "5 accounts are 1 pack");
  row = await rowBy("g2g-resume");
  assert.equal(stamped(row, "go-r3").length, 5);
  assert.ok(stamped(row, "go-r3").every((u) => u.deliveredAt));
  assert.equal(free(row).length, 0);
  assert.deepEqual(world.tripwire, []);
});

test("g2g resume guard: fewer accounts under the order id than its packs is never re-sent or confirmed", async () => {
  const units = await seedUnits("gg", 5);
  for (const u of units.slice(0, 3)) {
    u.orderId = "go-g1";
    u.messagedAt = new Date();
  }
  await insertRow({
    marketplace: "g2g",
    externalId: "g2g-guard",
    bulkOfferId: await insertOffer({ market: "g2g" }),
    bulkPackSize: 5,
    units,
  });
  const r = await g2g.deliverOrder(g2gOrder("go-g1", "g2g-guard", 1), { dryRun: false });
  assert.match(String(r.error), /^bulk pack short: only 3 of 5 account\(s\) are reserved for this order/);
  assert.equal(world.chat.length, 0);
  assert.equal(calls("g2gSetDeliveredQty").length, 0);
  const row = await rowBy("g2g-guard");
  assert.equal(stamped(row, "go-g1").filter((u) => u.deliveredAt).length, 0);
});

// -------------------------------------------------------- g2g, no-claim --

test("g2g no-claim pack: the claim is asked for units × N, delivered_qty is packs, sale booked per account; short pages", async () => {
  const set = await noclaimSet();
  const bulkOfferId = await insertOffer({ market: "g2g", source: "noclaim", externalId: "g2g-nc-pack" });
  await insertRow({ marketplace: "g2g", externalId: "g2g-nc-pack", noclaimStock: true, set, bulkOfferId, bulkPackSize: 5, price: 4 });
  world.ncFree = 12;

  const r = await g2g.deliverOrder(g2gOrder("go-nc1", "g2g-nc-pack", 2), { dryRun: false });
  assert.equal(r.delivered, 2, JSON.stringify(r));
  assert.equal(world.ncClaims.at(-1).want, 10);
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-nc1"), [["g2gSetDeliveredQty", "go-nc1", 2]]);
  assert.match(world.chat.at(-1).message, /=== ACCOUNT 10 of 10 ===/);
  assert.equal(logins(world.chat.at(-1).message).length, 10);
  // $8 for 2 packs of 5: $0.80 an account.
  assert.equal(world.ncSold.at(-1).ids.length, 10);
  assert.equal(world.ncSold.at(-1).priceUsd, 0.8);

  // Not in dollars: the row's price is one pack's, spread over its 5.
  const r2 = await g2g.deliverOrder(g2gOrder("go-nc2", "g2g-nc-pack", 1, { currency: "EUR" }), { dryRun: false });
  assert.equal(r2.delivered, 1);
  assert.equal(world.ncSold.at(-1).priceUsd, 0.8);

  world.ncFree = 12;
  const s = await g2g.deliverOrder(g2gOrder("go-nc3", "g2g-nc-pack", 3), { dryRun: false });
  assert.match(String(s.error), /^bulk pack short: only 12 of 15 no-claim account\(s\) claimed/);
  assert.equal(calls("g2gSetDeliveredQty", "go-nc3").length, 0);

  // Control: an ordinary no-claim row, exactly as before.
  const set2 = await noclaimSet();
  await insertRow({ marketplace: "g2g", externalId: "g2g-nc-single", noclaimStock: true, set: set2, price: 3 });
  const c = await g2g.deliverOrder(g2gOrder("go-nc4", "g2g-nc-single", 2, { amount: 5 }), { dryRun: false });
  assert.equal(c.delivered, 2);
  assert.equal(world.ncClaims.at(-1).want, 2);
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-nc4"), [["g2gSetDeliveredQty", "go-nc4", 2]]);
  assert.equal(world.ncSold.at(-1).priceUsd, 2.5);
  world.ncFree = 1;
  const cs = await g2g.deliverOrder(g2gOrder("go-nc5", "g2g-nc-single", 2), { dryRun: false });
  assert.equal(cs.error, "only 1 of 2 no-claim account(s) claimed — no free no-claim account holds all 1 advertised item(s)");
  assert.deepEqual(world.tripwire, []);
});

test("g2g ordinary rows are unchanged: × 1 on a units row; a size-less bulk row is refused", async () => {
  const plain = await seedUnits("gq", 3);
  await insertRow({ marketplace: "g2g", externalId: "g2g-plain", origin: "auto", units: plain });
  const r = await g2g.deliverOrder(g2gOrder("go-p1", "g2g-plain", 2), { dryRun: false });
  assert.equal(r.delivered, 2);
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-p1"), [["g2gSetDeliveredQty", "go-p1", 2]]);
  assert.equal(logins(world.chat.at(-1).message).length, 2);
  const s = await g2g.deliverOrder(g2gOrder("go-p2", "g2g-plain", 2), { dryRun: false });
  assert.match(String(s.skipped), /^manual-delivery listing/, "an ordinary short row keeps its old outcome");

  const v1 = await seedUnits("gv", 6);
  await insertRow({ marketplace: "g2g", externalId: "g2g-v1", bulkOfferId: await insertOffer({ market: "g2g" }), units: v1 });
  const v = await g2g.deliverOrder(g2gOrder("go-p3", "g2g-v1", 5), { dryRun: false });
  assert.match(String(v.error), /bulk pack short: .*no pack size/);
  assert.deepEqual(calls("g2gSetDeliveredQty", "go-p3"), []);
  assert.deepEqual(world.tripwire, []);
});

// ------------------------------------------------------------ stock syncs --

test("eldorado syncBundleStock: a pack row advertises whole packs, 0 packs pauses, a pack back resumes; ordinary and v1 rows unchanged", async () => {
  const live = await insertOffer({ source: "noclaim", externalId: "eld-sync-pack" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-sync-pack", noclaimStock: true, set: oid(), bulkOfferId: live, bulkPackSize: 5 });
  await insertRow({ marketplace: "eldorado", externalId: "eld-sync-single", noclaimStock: true, set: oid() });
  const v1 = await insertOffer({ source: "noclaim", externalId: "eld-sync-v1" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-sync-v1", noclaimStock: true, set: oid(), bulkOfferId: v1 });
  const owner = await insertOffer({ source: "noclaim", state: "paused", externalId: "eld-sync-owner" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-sync-owner", noclaimStock: true, set: oid(), bulkOfferId: owner, bulkPackSize: 5, autoPaused: true });
  for (const id of ["eld-sync-pack", "eld-sync-single", "eld-sync-v1"]) {
    world.eld.set(id, { id, offerState: "Active", quantity: 8 });
  }
  world.eld.set("eld-sync-owner", { id: "eld-sync-owner", offerState: "Paused", quantity: 1 });
  world.ncStock.set("eld-sync-pack", 12);
  world.ncStock.set("eld-sync-single", 3);
  world.ncStock.set("eld-sync-v1", 7);
  world.ncStock.set("eld-sync-owner", 10);

  await eldorado.syncBundleStock({ dryRun: false });
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-sync-pack"), [["eldoradoSetQuantity", "eld-sync-pack", 2]], "12 accounts = 2 packs");
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-sync-single"), [["eldoradoSetQuantity", "eld-sync-single", 3]]);
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-sync-v1"), [], "a bulk row with no pack size is never advertised");
  assert.equal(calls("eldoradoDelist", "eld-sync-v1").length, 1, "…it is paused (delivery refuses it too)");
  assert.equal(calls("eldoradoRelist", "eld-sync-owner").length, 0, "an owner-paused pack is never resumed");

  // 4 accounts cannot fill a pack of 5: paused, like an empty shelf.
  world.calls.length = 0;
  world.ncStock.set("eld-sync-pack", 4);
  await eldorado.syncBundleStock({ dryRun: false });
  assert.equal(calls("eldoradoDelist", "eld-sync-pack").length, 1);
  assert.equal(calls("eldoradoSetQuantity", "eld-sync-pack").length, 0);
  let r = await rowBy("eld-sync-pack");
  assert.equal(r.autoPaused, true);
  assert.equal(r.lastError, "paused: no claimable stock");

  // Packs back: its own pause is resumed at the whole packs (15 accounts = 3).
  world.calls.length = 0;
  world.ncStock.set("eld-sync-pack", 15);
  await eldorado.syncBundleStock({ dryRun: false });
  assert.equal(calls("eldoradoRelist", "eld-sync-pack").length, 1);
  assert.deepEqual(calls("eldoradoSetQuantity", "eld-sync-pack"), [["eldoradoSetQuantity", "eld-sync-pack", 3]]);
  r = await rowBy("eld-sync-pack");
  assert.equal(r.autoPaused, false);
  assert.equal(calls("eldoradoRelist", "eld-sync-owner").length, 0);
  assert.deepEqual(world.tripwire, []);
});

test("g2g syncStock: a pack row advertises whole packs, 0 packs delists, a pack back relists; ordinary and v1 rows unchanged", async () => {
  world.af = { g2gAutoDeliver: true, g2gSyncStock: true, g2gDeliverDryRun: false };
  const live = await insertOffer({ market: "g2g", source: "noclaim", externalId: "g2g-sync-pack" });
  await insertRow({ marketplace: "g2g", externalId: "g2g-sync-pack", noclaimStock: true, set: oid(), bulkOfferId: live, bulkPackSize: 5 });
  await insertRow({ marketplace: "g2g", externalId: "g2g-sync-single", noclaimStock: true, set: oid() });
  const v1 = await insertOffer({ market: "g2g", source: "noclaim", externalId: "g2g-sync-v1" });
  await insertRow({ marketplace: "g2g", externalId: "g2g-sync-v1", noclaimStock: true, set: oid(), bulkOfferId: v1 });
  world.ncStock.set("g2g-sync-pack", 12);
  world.ncStock.set("g2g-sync-single", 3);
  world.ncStock.set("g2g-sync-v1", 7);

  let res = await g2g.syncStock();
  assert.equal(res.checked, 3);
  assert.deepEqual(calls("g2gSetQuantity", "g2g-sync-pack"), [["g2gSetQuantity", "g2g-sync-pack", 2]], "12 accounts = 2 packs");
  assert.deepEqual(calls("g2gSetQuantity", "g2g-sync-single"), [["g2gSetQuantity", "g2g-sync-single", 3]]);
  assert.deepEqual(calls("g2gSetQuantity", "g2g-sync-v1"), [], "a bulk row with no pack size is never advertised");
  assert.equal(calls("g2gDelist", "g2g-sync-v1").length, 1, "…it is taken off sale (delivery refuses it too)");

  world.calls.length = 0;
  world.ncStock.set("g2g-sync-pack", 4);
  await g2g.syncStock();
  assert.equal(calls("g2gDelist", "g2g-sync-pack").length, 1);
  assert.equal(calls("g2gSetQuantity", "g2g-sync-pack").length, 0);
  assert.equal((await rowBy("g2g-sync-pack")).autoPaused, true);

  world.calls.length = 0;
  world.ncStock.set("g2g-sync-pack", 10);
  await g2g.syncStock();
  assert.deepEqual(calls("g2gSetQuantity", "g2g-sync-pack"), [["g2gSetQuantity", "g2g-sync-pack", 2]]);
  assert.equal(calls("g2gRelist", "g2g-sync-pack").length, 1);
  assert.equal((await rowBy("g2g-sync-pack")).autoPaused, false);

  // The rehearsal reports the packs the live pass would write.
  world.af = { g2gAutoDeliver: true, g2gSyncStock: true, g2gDeliverDryRun: true };
  world.ncStock.set("g2g-sync-pack", 14);
  res = await g2g.syncStock();
  assert.deepEqual(res.changes.find((c) => c.offer === "g2g-sync-pack"), { offer: "g2g-sync-pack", wouldSet: 2 });
  assert.deepEqual(res.changes.find((c) => c.offer === "g2g-sync-single"), { offer: "g2g-sync-single", wouldSet: 3 });
  assert.deepEqual(world.tripwire, []);
});

// ---------------------------------------------------------- farm services --

const FARM_PACK_TITLE = "Rust Twitch Drops Automatic Farming 120 Days — PACK OF 5 ACCOUNTS";
const FARM_TITLE = "Rust Twitch Drops Automatic Farming 120 Days";

function eldFarmOrder(id, offerId, qty, title = FARM_PACK_TITLE) {
  return {
    id,
    offerId,
    purchaseQuantity: qty,
    orderOfferDetails: { offerTitle: title },
    buyerUsername: "farm-buyer",
  };
}

function g2gFarmOrder(id, offerId, qty, title = FARM_PACK_TITLE) {
  return {
    orderItemId: id,
    offerId,
    purchasedQty: qty,
    deliveredQty: 0,
    buyerId: "farm-buyer",
    currency: "USD",
    amount: 7 * qty,
    title,
  };
}

test("eldorado farm: a bulk farming offer provisions units × N and records units + pack size; an ordinary order stays × 1", async () => {
  const bulkId = await insertOffer({ kind: "farming", source: "farm", game: "Rust", days: 120, minQty: 5, externalId: "eld-farm-pack" });

  const r = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-1", "eld-farm-pack", 2), { dryRun: false });
  assert.equal(r.delivered, 10, JSON.stringify(r));
  assert.deepEqual(world.provisions.map((p) => p.count), [10], "2 packs of 5 accounts");
  assert.equal(world.provisions[0].game, "Rust");
  assert.equal(world.provisions[0].days, 120);
  const msg = calls("eldoradoSendOrderMessage", "ef-1")[0][2];
  assert.match(msg, /=== ACCOUNT 10 of 10 ===/);
  assert.doesNotMatch(msg, /ACCOUNT 11 of/);
  assert.equal(logins(msg).length, 10);
  assert.equal(calls("eldoradoMarkDelivered", "ef-1").length, 1);
  const row = await FarmServiceOrder.findOne({ orderId: "ef-1" }).lean();
  assert.equal(row.state, "delivered");
  assert.equal(row.quantity, 10, "the row's quantity is the accounts provisioned");
  assert.equal(row.accounts.length, 10);
  assert.equal(row.note, "bulk pack order: 2 pack(s) of 5 accounts = 10 accounts (bulk offer " + String(bulkId) + ")");

  // A retry of the delivered order provisions nothing more.
  const again = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-1", "eld-farm-pack", 2), { dryRun: false });
  assert.equal(again.skipped, "already delivered");
  assert.equal(world.provisions.length, 1);

  // An ordinary farming offer: exactly what was bought, no note.
  const o = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-2", "eld-farm-single", 1, FARM_TITLE), { dryRun: false });
  assert.equal(o.delivered, 1);
  assert.equal(world.provisions.at(-1).count, 1);
  const orow = await FarmServiceOrder.findOne({ orderId: "ef-2" }).lean();
  assert.equal(orow.quantity, 1);
  assert.equal(orow.note, undefined);
  assert.doesNotMatch(calls("eldoradoSendOrderMessage", "ef-2")[0][2], /=== ACCOUNT/);
  const o2 = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-3", "eld-farm-single", 2, FARM_TITLE), { dryRun: false });
  assert.equal(o2.delivered, 2);
  assert.equal(world.provisions.at(-1).count, 2);

  // Dry run: the preview counts accounts.
  const dry = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-dry", "eld-farm-pack", 2), { dryRun: true });
  assert.match(dry.wouldProvision, /^10x Rust for 120 days/);
  assert.equal(world.previews.at(-1), 10);
  assert.equal(await FarmServiceOrder.countDocuments({ orderId: "ef-dry" }), 0);
  assert.deepEqual(world.tripwire, []);
});

test("eldorado farm edges: no offer id or another market's bulk offer is × 1; a failed bulk read provisions nothing", async () => {
  // A bulk farm offer still being sent carries no offer id yet; the same id
  // on the other market is not this offer.
  await insertOffer({ kind: "farming", source: "farm", state: "sending", externalId: "", minQty: 5 });
  await insertOffer({ kind: "farming", source: "farm", market: "g2g", externalId: "shared-id", minQty: 5 });
  const a = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-e1", "", 1, FARM_TITLE), { dryRun: false });
  assert.equal(a.delivered, 1);
  const b = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-e2", "shared-id", 1, FARM_TITLE), { dryRun: false });
  assert.equal(b.delivered, 1);
  assert.deepEqual(world.provisions.map((p) => p.count), [1, 1]);

  // A closed bulk offer's order is still owed its packs.
  await insertOffer({ kind: "farming", source: "farm", state: "withdrawn", open: false, externalId: "eld-farm-closed", minQty: 10 });
  const c = await eldFarm.deliverFarmOrder(
    eldFarmOrder("ef-e3", "eld-farm-closed", 1, "Rust Twitch Drops Automatic Farming 120 Days — PACK OF 10 ACCOUNTS"),
    { dryRun: false },
  );
  assert.equal(c.delivered, 10);

  // The bulk read fails: nothing provisioned, no row claimed, retried next tick.
  const realFindOne = BulkOffer.findOne;
  BulkOffer.findOne = () => ({
    lean: async () => {
      throw new Error("Mongo hiccup");
    },
  });
  let d;
  try {
    d = await eldFarm.deliverFarmOrder(
      eldFarmOrder("ef-e4", "eld-farm-closed", 1, "Rust Twitch Drops Automatic Farming 120 Days — PACK OF 10 ACCOUNTS"),
      { dryRun: false },
    );
  } finally {
    BulkOffer.findOne = realFindOne;
  }
  assert.match(String(d.error), /could not read the bulk offer .*Mongo hiccup.*nothing provisioned/);
  assert.equal(world.provisions.length, 3);
  assert.equal(await FarmServiceOrder.countDocuments({ orderId: "ef-e4" }), 0);
  assert.equal(calls("eldoradoSendOrderMessage", "ef-e4").length, 0);
  assert.deepEqual(world.tripwire, []);
});

test("g2g farm: provisions units × N and tells G2G the UNITS; an ordinary order stays × 1; a refused count reports units", async () => {
  const bulkId = await insertOffer({ kind: "farming", source: "farm", market: "g2g", game: "Rust", days: 120, minQty: 5, externalId: "g2g-farm-pack" });

  const r = await g2gFarm.deliverFarmOrder(g2gFarmOrder("gf-1", "g2g-farm-pack", 2), { dryRun: false });
  assert.equal(r.delivered, 2, "G2G counts packs: " + JSON.stringify(r));
  assert.deepEqual(world.provisions.map((p) => p.count), [10]);
  assert.deepEqual(calls("g2gSetDeliveredQty", "gf-1"), [["g2gSetDeliveredQty", "gf-1", 2]]);
  assert.equal(logins(world.chat.at(-1).message).length, 10);
  const row = await FarmServiceOrder.findOne({ orderId: "g2g:gf-1" }).lean();
  assert.equal(row.state, "delivered");
  assert.equal(row.quantity, 10);
  assert.equal(row.accounts.length, 10);
  assert.equal(row.note, "bulk pack order: 2 pack(s) of 5 accounts = 10 accounts (bulk offer " + String(bulkId) + ")");

  // An ordinary farming offer: exactly as before.
  const o = await g2gFarm.deliverFarmOrder(g2gFarmOrder("gf-2", "g2g-farm-single", 1, FARM_TITLE), { dryRun: false });
  assert.equal(o.delivered, 1);
  assert.equal(world.provisions.at(-1).count, 1);
  assert.deepEqual(calls("g2gSetDeliveredQty", "gf-2"), [["g2gSetDeliveredQty", "gf-2", 1]]);
  const orow = await FarmServiceOrder.findOne({ orderId: "g2g:gf-2" }).lean();
  assert.equal(orow.quantity, 1);
  assert.equal(orow.note, undefined);

  // Sent, but G2G refused the count: "sent 1 pack", the row stays sent.
  world.g2gConfirmFail = "G2G delivered qty failed (HTTP 500)";
  const s = await g2gFarm.deliverFarmOrder(g2gFarmOrder("gf-3", "g2g-farm-pack", 1), { dryRun: false });
  assert.equal(s.awaitingConfirm, true);
  assert.equal(s.sent, 1);
  assert.equal(world.provisions.at(-1).count, 5);
  assert.deepEqual(calls("g2gSetDeliveredQty", "gf-3"), [["g2gSetDeliveredQty", "gf-3", 1]]);
  const srow = await FarmServiceOrder.findOne({ orderId: "g2g:gf-3" }).lean();
  assert.equal(srow.state, "sent");
  assert.equal(srow.quantity, 5);

  // Dry run counts accounts.
  const dry = await g2gFarm.deliverFarmOrder(g2gFarmOrder("gf-dry", "g2g-farm-pack", 3), { dryRun: true });
  assert.match(dry.wouldSend, /^15x Rust for 120 days/);
  assert.equal(world.previews.at(-1), 15);
  assert.deepEqual(world.tripwire, []);
});

// Guard (docs/bulk-packs/PACKS-2.md §1): a bulk row that lost its pack size must
// never be delivered as single accounts — the buyer paid for a whole pack.
test("a bulk row without a pack size refuses the order, pages, and sends nothing", async () => {
  const bulkOfferId = await insertOffer({ market: "eldorado", minQty: 5, externalId: "eld-nosize" });
  const units = await seedUnits("nsz", 10);
  await insertRow({ marketplace: "eldorado", externalId: "eld-nosize", bulkOfferId, units });
  const before = world.calls.length;
  const r = await eldorado.deliverOrder(eldOrder("o-nosize", "eld-nosize", 1), { dryRun: false });
  assert.match(String(r.error), /bulk pack short: .*no pack size/);
  assert.equal(eldorado.alertsOperator(r.error), true, "the owner is paged");
  assert.equal(
    world.calls.slice(before).filter((c) => /SendOrderMessage|MarkDelivered/.test(c[0])).length,
    0,
    "nothing was sent",
  );
  assert.equal(stamped(await rowBy("eld-nosize"), "o-nosize").length, 0, "no unit spent");

  const gOffer = await insertOffer({ market: "g2g", minQty: 5, externalId: "g2g-nosize" });
  const gUnits = await seedUnits("gnsz", 10);
  await insertRow({ marketplace: "g2g", externalId: "g2g-nosize", bulkOfferId: gOffer, units: gUnits });
  const g = await g2g.deliverOrder(g2gOrder("g-nosize", "g2g-nosize", 1), { dryRun: false });
  assert.match(String(g.error), /bulk pack short: .*no pack size/);
  assert.equal(stamped(await rowBy("g2g-nosize"), "g-nosize").length, 0, "no unit spent");
});

// Review round (pack math, finding 1): a farming pack whose publish outcome was
// unknown has no offer id on its BulkOffer. If it is live anyway, its orders
// carry the pack title but match no bulk offer — they must be REFUSED (paged),
// never provisioned x1.
test("farm: a PACK OF N title with no matching bulk offer provisions nothing on Eldorado or G2G", async () => {
  const before = world.provisions.length;
  const e = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-orphan", "eld-farm-unknown", 1), { dryRun: false });
  assert.ok(e.error || e.skipped, JSON.stringify(e));
  assert.match(String(e.error || e.skipped), /PACK OF 5 ACCOUNTS but no bulk offer matches/);
  const erow = await FarmServiceOrder.findOne({ orderId: "ef-orphan" }).lean();
  assert.ok(erow && erow.state !== "delivered", "recorded as a refused paid order, not delivered");
  const g = await g2gFarm.deliverFarmOrder(g2gFarmOrder("gf-orphan", "g2g-farm-unknown", 1), { dryRun: false });
  assert.match(String(g.error || g.skipped), /PACK OF 5 ACCOUNTS but no bulk offer matches/);
  // A pack title whose bulk offer is a different size is refused too.
  await insertOffer({ kind: "farming", source: "farm", market: "eldorado", minQty: 10, externalId: "eld-farm-mismatch" });
  const m = await eldFarm.deliverFarmOrder(eldFarmOrder("ef-mismatch", "eld-farm-mismatch", 1), { dryRun: false });
  assert.match(String(m.error || m.skipped), /PACK OF 5 ACCOUNTS but its bulk offer is a pack of 10/);
  assert.equal(world.provisions.length, before, "nothing provisioned");
  assert.equal(calls("eldoradoSendOrderMessage", "ef-orphan").length, 0);
});

// Review round (finding 2): an ordinary-looking row that carries a pack title
// (a pack row whose link was lost) is refused at delivery and paused by the sync.
test("a row whose title promises a pack it does not record is refused and paused", async () => {
  const units = await seedUnits("ttl", 10);
  await insertRow({
    marketplace: "eldorado",
    externalId: "eld-title-only",
    noclaimStock: false,
    title: "Overwatch Twitch Drops — PACK OF 5 ACCOUNTS",
    units,
  });
  const r = await eldorado.deliverOrder(eldOrder("o-title-only", "eld-title-only", 1), { dryRun: false });
  assert.match(String(r.error), /bulk pack short: the title promises PACK OF 5 ACCOUNTS but the listing records no pack/);
  assert.equal(eldorado.alertsOperator(r.error), true);
  assert.equal(calls("eldoradoSendOrderMessage", "o-title-only").length, 0);
  assert.equal(stamped(await rowBy("eld-title-only"), "o-title-only").length, 0);
});
