// Bulk packs — review round 1, the hooks in EXISTING files owned by X4
// (docs/bulk-packs/FIXES-1.md "Fulfillers + router + page" and "Existing-system
// items from review 3"): L5, R3-1, R3-3, R3-4, R3-5, R3-8 and the page; and
// docs/bulk-packs/FIXES-2.md V3 (the Eldorado keep-alive side).
//
// Each test reproduces the reviewed scenario and asserts the FIXED outcome,
// next to an ordinary (non-bulk) control that must behave exactly as before.
// Fixtures go in through Model.collection.insertOne, so they behave the same
// whether or not a schema declares a field yet. Memory Mongo only; the
// marketplace client, Telegram, the farm-order routers and the no-claim stock
// count are replaced BEFORE the modules under test load, and every other
// marketplace call is a tripwire that throws — nothing reaches the network or
// writes utils/settings.json.
process.env.CRED_SECRET ||= "bulk-packs-hooks2-secret-0123456789abcdef";
process.env.TG_TOKEN = "";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.resolve(__dirname, "..");

// ------------------------------------------------------ fakes (load first) --

const world = {
  calls: [], // [name, ...args] for every faked marketplace call
  mpHits: [], // tripwire hits
  telegram: [],
  af: {},
  eld: new Map(), // Eldorado offer id -> { id, offerState, quantity, expireDate, offerTitle }
  eldOrders: [],
  g2gOrders: [],
  nc: new Map(), // externalId -> no-claim share (noclaimStock.stockForListing)
  gfSold: new Set(),
  gfLive: new Set(),
  onEldDelist: null,
  // Runs inside eldoradoRelist, BEFORE it applies; return false to leave the
  // offer as it is (a relist that has not landed yet).
  onEldRelist: null,
};
const count = (name, id) =>
  world.calls.filter((c) => c[0] === name && (id === undefined || c[1] === id)).length;

// Settings first: both fulfillers destructure getAutoFarm at require time.
const settings = require("../utils/settings");
const realGetAutoFarm = settings.getAutoFarm;
settings.getAutoFarm = (...args) => ({ ...realGetAutoFarm(...args), ...world.af });

const mp = require("../utils/marketplaces");
for (const [name, fn] of Object.entries(mp)) {
  if (typeof fn !== "function") continue;
  mp[name] = () => {
    world.mpHits.push(name);
    throw new Error("network tripwire: marketplaces." + name);
  };
}
const rec = (name, fn) => async (...args) => {
  world.calls.push([name, ...args]);
  return fn ? fn(...args) : undefined;
};
const later = (days) =>
  new Date(Date.now() + days * 86400e3).toISOString().replace("Z", ""); // Eldorado sends no zone
mp.keyStatus = () => ({ eldorado: { configured: true } });
mp.eldoradoEnsureFreshSession = async () => {};
mp.eldoradoPaidOrders = async () => world.eldOrders;
mp.eldoradoOffer = rec("eldoradoOffer", (id) => {
  const o = world.eld.get(String(id));
  return o ? { ...o } : null;
});
mp.eldoradoDelist = rec("eldoradoDelist", async (id) => {
  const o = world.eld.get(String(id));
  if (o) o.offerState = "Paused";
  if (world.onEldDelist) await world.onEldDelist(String(id));
});
mp.eldoradoRelist = rec("eldoradoRelist", async (id) => {
  const o = world.eld.get(String(id));
  if (world.onEldRelist && (await world.onEldRelist(String(id))) === false) return;
  if (o) {
    o.offerState = "Active";
    o.expireDate = later(21);
  }
});
mp.eldoradoSetQuantity = rec("eldoradoSetQuantity", (id, n) => {
  const o = world.eld.get(String(id));
  if (o) o.quantity = n;
  return n;
});
mp.eldoradoSendOrderMessage = rec("eldoradoSendOrderMessage");
mp.eldoradoMarkDelivered = rec("eldoradoMarkDelivered");
mp.eldoradoMyListings = async () => ({
  totalPages: 1,
  results: [...world.eld.values()].map((o) => ({ ...o })),
});
mp.g2gDelist = rec("g2gDelist");
mp.g2gRelist = rec("g2gRelist");
mp.g2gSetQuantity = rec("g2gSetQuantity");
mp.g2gStartDeliver = rec("g2gStartDeliver");
mp.g2gMarkDelivering = rec("g2gMarkDelivering");
mp.g2gSetDeliveredQty = rec("g2gSetDeliveredQty");
mp.g2gOrderCounts = async () => ({ preparing: world.g2gOrders.length, delivering: 0 });
mp.g2gPendingOrders = async () => world.g2gOrders;
mp.gameflipListingIdsByStatus = async (status) =>
  status === "sold" ? world.gfSold : world.gfLive;
mp.gameflipOwnerId = async () => "our-seller";

// gameflipFulfiller destructures sendTelegram at require time.
const telegram = require("../utils/telegram");
for (const [name, fn] of Object.entries(telegram)) {
  if (typeof fn !== "function") continue;
  telegram[name] = async (msg) => {
    world.telegram.push(String(msg));
    return true;
  };
}

// Required lazily by syncBundleStock / realStockFor at call time.
const noclaimStock = require("../utils/noclaimStock");
noclaimStock.stockForListing = async (row) => {
  const n = world.nc.get(String(row.externalId));
  return n === undefined ? 0 : n;
};

// The paid-order ticks ask the farm services first; these orders are bundles.
require("../utils/eldoradoFarmService").deliverFarmOrder = async () => null;
require("../utils/g2gFarmService").deliverFarmOrder = async () => null;
require("../utils/operatorFarm").previewFreshAccounts = async () => ({ eligibleTotal: 500 });

// ------------------------------------------------------ modules under test --

const MarketplaceListing = require("../models/MarketplaceListing");
const BulkOffer = require("../models/BulkOffer");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const SaleSignal = require("../models/SaleSignal");
const eldorado = require("../utils/eldoradoFulfiller");
const g2g = require("../utils/g2gFulfiller");
const gameflip = require("../utils/gameflipFulfiller");
const { recordListingSale } = require("../utils/saleLearning");
const health = require("../utils/systemHealth");

// ---------------------------------------------------------------- helpers --

const oid = () => new mongoose.Types.ObjectId();

async function insertRow(doc) {
  const _id = oid();
  const now = new Date();
  await MarketplaceListing.collection.insertOne({
    _id,
    title: "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)",
    price: 1.19,
    status: "active",
    origin: "manual",
    units: [],
    createdAt: now,
    updatedAt: now,
    ...doc,
  });
  return _id;
}

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
    slotKey: "hooks2|" + String(_id),
    reserved: [],
    externalId: "",
    lastError: "",
    history: [],
    createdAt: now,
    updatedAt: now,
    ...doc,
  });
  return _id;
}

const unit = (accountId, login, extra = {}) => ({
  contentId: "",
  accountId: String(accountId),
  login,
  addedAt: new Date(),
  deliveredAt: null,
  orderId: "",
  messagedAt: null,
  ...extra,
});

const rowBy = (externalId) => MarketplaceListing.collection.findOne({ externalId });

// ------------------------------------------------------------------ setup --

let mongod;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulkPacksHooks2"));
  await Promise.all([
    MarketplaceListing.init(),
    BulkOffer.init(),
    DropLog.init(),
    SaleSignal.init(),
  ]);
});

after(async () => {
  settings.getAutoFarm = realGetAutoFarm;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  world.calls.length = 0;
  world.mpHits.length = 0;
  world.telegram.length = 0;
  world.af = {};
  world.eld.clear();
  world.eldOrders = [];
  world.g2gOrders = [];
  world.nc.clear();
  world.gfSold = new Set();
  world.gfLive = new Set();
  world.onEldDelist = null;
  world.onEldRelist = null;
  await Promise.all([
    MarketplaceListing.collection.deleteMany({}),
    BulkOffer.collection.deleteMany({}),
    BotAccount.collection.deleteMany({}),
    DropLog.collection.deleteMany({}),
    DropSet.collection.deleteMany({}),
    SaleSignal.collection.deleteMany({}),
  ]);
});

// ------------------------------------------------------------- L5 eldorado --

test("L5 eldorado: a bulk row short of free units — or with none left — is a paging error; ordinary rows unchanged", async () => {
  const offer = await insertOffer({});
  const five = [1, 2, 3, 4, 5].map((i) => unit(oid(), "short" + i));
  await insertRow({ marketplace: "eldorado", externalId: "eld-bulk-short", bulkOfferId: offer, bulkPackSize: 5, units: five });
  // The reviewers' repro (F-E), in packs (PACKS-2): 2 packs of 5 paid, 5 accounts left.
  const r = await eldorado.deliverOrder(
    { id: "l5-e1", offerId: "eld-bulk-short", purchaseQuantity: 2 },
    { dryRun: false },
  );
  assert.match(String(r.error), /^bulk pack short: not enough reserved stock \(5 of 10\)/);
  assert.equal(eldorado.alertsOperator(r.error), true, "a short bulk pack pages the owner");

  // Every unit pulled (a withdraw with no sales): still a paid order short of stock.
  await insertRow({ marketplace: "eldorado", externalId: "eld-bulk-empty", bulkOfferId: offer, bulkPackSize: 5, units: [] });
  const z = await eldorado.deliverOrder(
    { id: "l5-e2", offerId: "eld-bulk-empty", purchaseQuantity: 1 },
    { dryRun: false },
  );
  assert.equal(z.skipped, undefined, "never the silent manual-delivery skip");
  assert.match(String(z.error), /^bulk pack short: not enough reserved stock \(0 of 5\)/);
  assert.equal(eldorado.alertsOperator(z.error), true);

  // Controls: an ordinary reserved-units row and a hand-filled row, as before.
  await insertRow({ marketplace: "eldorado", externalId: "eld-single-short", origin: "auto", units: [unit(oid(), "solo1")] });
  const c = await eldorado.deliverOrder(
    { id: "l5-e3", offerId: "eld-single-short", purchaseQuantity: 2 },
    { dryRun: false },
  );
  assert.match(String(c.error), /^not enough reserved stock \(1 of 2\)/);
  assert.equal(eldorado.alertsOperator(c.error), false);
  await insertRow({ marketplace: "eldorado", externalId: "eld-service", units: [] });
  const s = await eldorado.deliverOrder(
    { id: "l5-e4", offerId: "eld-service", purchaseQuantity: 1 },
    { dryRun: false },
  );
  assert.match(String(s.skipped), /^manual-delivery listing/);
  assert.equal(eldorado.alertsOperator(s.skipped), false);

  assert.equal(count("eldoradoSendOrderMessage") + count("eldoradoMarkDelivered"), 0);
  assert.deepEqual(world.mpHits, []);
});

test("L5 eldorado: the paid-order tick pages the owner once for a short bulk pack", async () => {
  world.af = { eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false };
  await insertRow({
    marketplace: "eldorado",
    externalId: "eld-bulk-tick",
    bulkOfferId: await insertOffer({}),
    units: [unit(oid(), "tick1"), unit(oid(), "tick2")],
  });
  world.eldOrders = [
    {
      id: "l5-e5",
      offerId: "eld-bulk-tick",
      purchaseQuantity: 5,
      orderOfferDetails: { offerTitle: "Rust bundle — BULK 5+ accounts" },
      buyerName: "buyer-e5",
    },
  ];
  const res = await eldorado.deliverPaidOrders();
  assert.match(String(res.results[0].error), /^bulk pack short/);
  const pages = () => world.telegram.filter((m) => m.includes("l5-e5"));
  assert.equal(pages().length, 1);
  assert.match(pages()[0], /PAID and the bot cannot ship it/);
  assert.match(pages()[0], /bulk pack short/);
  await eldorado.deliverPaidOrders();
  assert.equal(pages().length, 1, "one page per order, not one per tick");
  assert.equal(count("eldoradoSendOrderMessage"), 0);
});

// ------------------------------------------------------------------ L5 g2g --

test("L5 g2g: a bulk row with too few free units is an alerting error, not the silent manual-delivery skip", async () => {
  await insertRow({ marketplace: "g2g", externalId: "g2g-bulk-short", bulkOfferId: oid(), bulkPackSize: 5, units: [unit(oid(), "g1")] });
  const r = await g2g.deliverOrder(
    { orderItemId: "l5-g1", offerId: "g2g-bulk-short", purchasedQty: 1 },
    { dryRun: false },
  );
  assert.equal(r.skipped, undefined);
  assert.match(String(r.error), /^bulk pack short: not enough reserved stock \(1 of 5\)/);

  await insertRow({ marketplace: "g2g", externalId: "g2g-bulk-empty", bulkOfferId: oid(), bulkPackSize: 5, units: [] });
  const z = await g2g.deliverOrder(
    { orderItemId: "l5-g2", offerId: "g2g-bulk-empty", purchasedQty: 1 },
    { dryRun: false },
  );
  assert.match(String(z.error), /^bulk pack short: not enough reserved stock \(0 of 5\)/);

  // Control: an ordinary hand-filled row keeps its quiet skip.
  await insertRow({ marketplace: "g2g", externalId: "g2g-service", units: [] });
  const c = await g2g.deliverOrder(
    { orderItemId: "l5-g3", offerId: "g2g-service", purchasedQty: 1 },
    { dryRun: false },
  );
  assert.match(String(c.skipped), /^manual-delivery listing/);
  assert.equal(c.error, undefined);
  assert.equal(g2g.alertsOperator(c.skipped), false);
  assert.equal(count("g2gStartDeliver") + count("g2gMarkDelivering") + count("g2gSetDeliveredQty"), 0);
  assert.deepEqual(world.mpHits, []);
});

test("L5 g2g: the pending-orders tick pages for a short bulk pack and stays quiet for a hand-filled row", async () => {
  world.af = { g2gAutoDeliver: true, g2gDeliverDryRun: false };
  await insertRow({ marketplace: "g2g", externalId: "g2g-bulk-tick", bulkOfferId: oid(), units: [unit(oid(), "gt1")] });
  await insertRow({ marketplace: "g2g", externalId: "g2g-service-tick", units: [] });
  world.g2gOrders = [
    { orderItemId: "l5-g4", offerId: "g2g-bulk-tick", purchasedQty: 5, buyerId: "b4", currency: "USD", amount: 5, title: "bulk" },
    { orderItemId: "l5-g5", offerId: "g2g-service-tick", purchasedQty: 1, buyerId: "b5", currency: "USD", amount: 3, title: "service" },
  ];
  const res = await g2g.deliverPendingOrders();
  assert.equal(res.checked, 2);
  const bulkPages = world.telegram.filter((m) => m.includes("l5-g4"));
  assert.equal(bulkPages.length, 1);
  assert.match(bulkPages[0], /PAID and the bot cannot ship it/);
  assert.match(bulkPages[0], /bulk pack short/);
  assert.equal(world.telegram.filter((m) => m.includes("l5-g5")).length, 0);
});

// ----------------------------------------------------------------- R3-5 g2g --

test("R3-5 g2g: an unreadable password on a bulk row releases nothing tag-wide and pages; an ordinary row still releases", async () => {
  const accId = oid();
  await BotAccount.collection.insertOne({
    _id: accId,
    clientSecret: "cs-r35",
    login: "nopw1",
    credUsername: "nopw1",
    hasPassword: false,
  });
  const bulkSet = oid();
  const soldSet = oid();
  const reserved = async () => {
    await DropLog.collection.deleteMany({ account: accId });
    await DropLog.collection.insertMany([
      // This offer's reservation, and ANOTHER set's drops already SOLD on g2g
      // from the same account — the ones a tag-wide release would free.
      { account: accId, benefitId: "b-bulk", login: "nopw1", game: "Rust", soldAt: new Date(), soldToUsername: "g2g", soldSetId: String(bulkSet) },
      { account: accId, benefitId: "b-sold", login: "nopw1", game: "Dota 2", soldAt: new Date(Date.now() - 86400e3), soldToUsername: "g2g", soldSetId: String(soldSet) },
    ]);
  };
  await reserved();
  const accId2 = oid();
  await BotAccount.collection.insertOne({
    _id: accId2,
    clientSecret: "cs-r35b",
    login: "nopw2",
    credUsername: "nopw2",
    hasPassword: false,
  });
  await insertRow({
    marketplace: "g2g",
    externalId: "g2g-bulk-nopw",
    bulkOfferId: oid(),
    bulkPackSize: 2,
    set: bulkSet,
    units: [unit(accId, "nopw1"), unit(accId2, "nopw2")],
  });
  const r = await g2g.deliverOrder(
    { orderItemId: "r35-1", offerId: "g2g-bulk-nopw", purchasedQty: 1 },
    { dryRun: false },
  );
  assert.match(String(r.error), /^bulk pack: 2 of 2 account\(s\) had no readable password/);
  let logs = await DropLog.collection.find({ account: accId }).toArray();
  assert.equal(logs.length, 2);
  for (const l of logs) {
    assert.ok(l.soldAt, "reservation " + l.benefitId + " kept");
    assert.equal(l.soldToUsername, "g2g");
  }
  const row = await rowBy("g2g-bulk-nopw");
  assert.equal(row.units.length, 2, "the units stay for the bulk loop's health check");
  assert.equal(row.units[0].orderId, "");
  assert.equal(count("g2gStartDeliver") + count("g2gMarkDelivering"), 0);

  // The tick pages it (any error does on G2G).
  world.af = { g2gAutoDeliver: true, g2gDeliverDryRun: false };
  world.g2gOrders = [{ orderItemId: "r35-2", offerId: "g2g-bulk-nopw", purchasedQty: 1, buyerId: "b", currency: "USD", amount: 1, title: "t" }];
  await g2g.deliverPendingOrders();
  assert.equal(world.telegram.filter((m) => m.includes("r35-2") && /no readable password/.test(m)).length, 1);
  logs = await DropLog.collection.find({ account: accId, soldAt: { $ne: null } }).toArray();
  assert.equal(logs.length, 2, "still nothing released after the tick");

  // Control: an ordinary row takes the old path — the tag-wide release frees
  // BOTH sets, which is exactly why a bulk row must never reach it.
  await insertRow({ marketplace: "g2g", externalId: "g2g-single-nopw", origin: "auto", units: [unit(accId, "nopw1")] });
  const c = await g2g.deliverOrder(
    { orderItemId: "r35-3", offerId: "g2g-single-nopw", purchasedQty: 1 },
    { dryRun: false },
  );
  assert.match(String(c.error), /released, not shipped/);
  logs = await DropLog.collection.find({ account: accId, soldAt: { $ne: null } }).toArray();
  assert.equal(logs.length, 0);
  assert.deepEqual(world.mpHits, []);
});

// ---------------------------------------------------------- R3-3 eldorado --

test("R3-3 eldorado syncBundleStock: a no-claim bulk row below its minimum pauses, resumes at the minimum, never over an owner pause", async () => {
  const live = await insertOffer({ source: "noclaim", minQty: 5, externalId: "eld-nc-bulk" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-nc-bulk", noclaimStock: true, set: oid(), bulkOfferId: live });
  const ownerPaused = await insertOffer({ source: "noclaim", minQty: 5, state: "paused", externalId: "eld-nc-owner" });
  await insertRow({ marketplace: "eldorado", externalId: "eld-nc-owner", noclaimStock: true, set: oid(), bulkOfferId: ownerPaused, autoPaused: true });
  await insertRow({ marketplace: "eldorado", externalId: "eld-nc-single", noclaimStock: true, set: oid() });
  world.eld.set("eld-nc-bulk", { id: "eld-nc-bulk", offerState: "Active", quantity: 8 });
  world.eld.set("eld-nc-owner", { id: "eld-nc-owner", offerState: "Paused", quantity: 2 });
  world.eld.set("eld-nc-single", { id: "eld-nc-single", offerState: "Active", quantity: 8 });
  world.nc.set("eld-nc-bulk", 3);
  world.nc.set("eld-nc-owner", 6);
  world.nc.set("eld-nc-single", 3);

  await eldorado.syncBundleStock({ dryRun: false });
  assert.equal(count("eldoradoDelist", "eld-nc-bulk"), 1, "3 < min 5: nothing can be bought, so it pauses");
  let r = await rowBy("eld-nc-bulk");
  assert.equal(r.autoPaused, true);
  assert.equal(r.lastError, "paused: no claimable stock");
  assert.equal(count("eldoradoRelist", "eld-nc-owner"), 0, "an owner-paused bulk offer is never resumed");
  assert.equal(count("eldoradoDelist", "eld-nc-single"), 0, "an ordinary no-claim row: unchanged");
  assert.deepEqual(world.calls.find((c) => c[0] === "eldoradoSetQuantity" && c[1] === "eld-nc-single"), ["eldoradoSetQuantity", "eld-nc-single", 3]);

  // Back at the minimum: the stock sync resumes its own pause.
  world.calls.length = 0;
  world.nc.set("eld-nc-bulk", 5);
  await eldorado.syncBundleStock({ dryRun: false });
  assert.equal(count("eldoradoRelist", "eld-nc-bulk"), 1);
  assert.deepEqual(world.calls.find((c) => c[0] === "eldoradoSetQuantity" && c[1] === "eld-nc-bulk"), ["eldoradoSetQuantity", "eld-nc-bulk", 5]);
  r = await rowBy("eld-nc-bulk");
  assert.equal(r.autoPaused, false);
  assert.equal(count("eldoradoRelist", "eld-nc-owner"), 0);

  // A BulkOffer read that fails changes nothing for the bulk rows this pass.
  world.calls.length = 0;
  world.nc.set("eld-nc-bulk", 1);
  const realFindById = BulkOffer.findById;
  BulkOffer.findById = () => {
    throw new Error("Mongo hiccup");
  };
  try {
    await eldorado.syncBundleStock({ dryRun: false });
  } finally {
    BulkOffer.findById = realFindById;
  }
  assert.equal(world.calls.filter((c) => c[1] === "eld-nc-bulk" || c[1] === "eld-nc-owner").length, 0);
  assert.equal(count("eldoradoOffer", "eld-nc-single"), 1, "the ordinary row is still synced");
  assert.deepEqual(world.mpHits, []);
});

// --------------------------------------------------------------- R3-3 g2g --

test("R3-3 g2g syncStock: a no-claim bulk row below its minimum is delisted, relisted at the minimum, never over an owner pause", async () => {
  world.af = { g2gAutoDeliver: true, g2gSyncStock: true, g2gDeliverDryRun: false };
  const live = await insertOffer({ source: "noclaim", market: "g2g", minQty: 5, externalId: "g2g-nc-bulk" });
  await insertRow({ marketplace: "g2g", externalId: "g2g-nc-bulk", noclaimStock: true, set: oid(), bulkOfferId: live });
  const ownerPaused = await insertOffer({ source: "noclaim", market: "g2g", minQty: 5, state: "paused", externalId: "g2g-nc-owner" });
  await insertRow({ marketplace: "g2g", externalId: "g2g-nc-owner", noclaimStock: true, set: oid(), bulkOfferId: ownerPaused, autoPaused: true });
  await insertRow({ marketplace: "g2g", externalId: "g2g-nc-single", noclaimStock: true, set: oid() });
  world.nc.set("g2g-nc-bulk", 3);
  world.nc.set("g2g-nc-owner", 6);
  world.nc.set("g2g-nc-single", 3);

  let res = await g2g.syncStock();
  assert.equal(res.checked, 3);
  assert.equal(count("g2gDelist", "g2g-nc-bulk"), 1);
  assert.equal(count("g2gSetQuantity", "g2g-nc-bulk"), 0);
  assert.equal((await rowBy("g2g-nc-bulk")).autoPaused, true);
  assert.equal(count("g2gSetQuantity", "g2g-nc-owner"), 1);
  assert.equal(count("g2gRelist", "g2g-nc-owner"), 0, "an owner-paused bulk offer is never relisted");
  assert.equal((await rowBy("g2g-nc-owner")).autoPaused, true);
  assert.equal(count("g2gDelist", "g2g-nc-single"), 0);
  assert.deepEqual(world.calls.find((c) => c[0] === "g2gSetQuantity" && c[1] === "g2g-nc-single"), ["g2gSetQuantity", "g2g-nc-single", 3]);

  world.calls.length = 0;
  world.nc.set("g2g-nc-bulk", 5);
  res = await g2g.syncStock();
  assert.deepEqual(world.calls.find((c) => c[0] === "g2gSetQuantity" && c[1] === "g2g-nc-bulk"), ["g2gSetQuantity", "g2g-nc-bulk", 5]);
  assert.equal(count("g2gRelist", "g2g-nc-bulk"), 1);
  assert.equal((await rowBy("g2g-nc-bulk")).autoPaused, false);

  // The dry run reports what the live pass would write: 0 below the minimum.
  world.af = { g2gAutoDeliver: true, g2gSyncStock: true, g2gDeliverDryRun: true };
  world.nc.set("g2g-nc-bulk", 4);
  res = await g2g.syncStock();
  assert.deepEqual(res.changes.find((c) => c.offer === "g2g-nc-bulk"), { offer: "g2g-nc-bulk", wouldSet: 0 });
  assert.deepEqual(res.changes.find((c) => c.offer === "g2g-nc-single"), { offer: "g2g-nc-single", wouldSet: 3 });
  assert.deepEqual(world.mpHits, []);
});

// ------------------------------------------------------ R3-4 eldorado keep-alive --

test("R3-4 eldorado keep-alive: a bulk offer that is not live is never resumed; a live one renews; others as before", async () => {
  const active = (id) => ({ id, offerState: "Active", quantity: 5, expireDate: later(2), offerTitle: "offer " + id });

  // By the BulkOffer's own externalId (a farm offer has no listing row).
  await insertOffer({ kind: "farming", source: "farm", externalId: "ka-paused", state: "paused" });
  world.eld.set("ka-paused", active("ka-paused"));
  let r = await eldorado.renewOffer("ka-paused");
  assert.match(String(r.skipped), /bulk offer is paused/);
  assert.equal(count("eldoradoDelist", "ka-paused") + count("eldoradoRelist", "ka-paused"), 0);

  // By the listing row's bulkOfferId (this offer doc carries no externalId).
  const soldOut = await insertOffer({ state: "sold_out", open: false });
  await insertRow({ marketplace: "eldorado", externalId: "ka-row", bulkOfferId: soldOut });
  world.eld.set("ka-row", active("ka-row"));
  r = await eldorado.renewOffer("ka-row");
  assert.match(String(r.skipped), /bulk offer is sold_out/);
  assert.equal(count("eldoradoDelist", "ka-row") + count("eldoradoRelist", "ka-row"), 0);

  // A live bulk offer is renewed like any other.
  await insertOffer({ externalId: "ka-live" });
  world.eld.set("ka-live", active("ka-live"));
  r = await eldorado.renewOffer("ka-live");
  assert.equal(r.ok, true);
  assert.equal(count("eldoradoDelist", "ka-live"), 1);
  assert.equal(count("eldoradoRelist", "ka-live"), 1);

  // It stops being live while the renewal has it paused: left paused.
  const turning = await insertOffer({ externalId: "ka-turn" });
  world.eld.set("ka-turn", active("ka-turn"));
  world.onEldDelist = async (id) => {
    if (id === "ka-turn") {
      await BulkOffer.collection.updateOne({ _id: turning }, { $set: { state: "sold_out", open: false } });
    }
  };
  r = await eldorado.renewOffer("ka-turn");
  assert.match(String(r.skipped), /turned sold_out meanwhile/);
  assert.equal(count("eldoradoRelist", "ka-turn"), 0);
  assert.equal(world.eld.get("ka-turn").offerState, "Paused");
  world.onEldDelist = null;

  // Control: an offer with no bulk pack behind it renews exactly as before.
  await insertRow({ marketplace: "eldorado", externalId: "ka-plain", origin: "auto" });
  world.eld.set("ka-plain", active("ka-plain"));
  r = await eldorado.renewOffer("ka-plain");
  assert.equal(r.ok, true);
  assert.equal(count("eldoradoRelist", "ka-plain"), 1);
  assert.deepEqual(world.mpHits, []);
});

test("R3-4 eldorado keep-alive pass: a held bulk offer is reported skipped (no page), never paused and resumed", async () => {
  await insertOffer({ state: "error", open: false, externalId: "ka-held", lastError: "publish outcome unknown — may be live on eldorado (ka-held)" });
  await insertRow({ marketplace: "eldorado", externalId: "ka-held", bulkOfferId: oid() });
  world.eld.set("ka-held", { id: "ka-held", offerState: "Active", expireDate: later(1), offerTitle: "held" });
  const out = await eldorado.renewExpiringOffers({});
  assert.equal(out.due, 1);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.failed.length, 0);
  assert.equal(count("eldoradoDelist") + count("eldoradoRelist"), 0);
  await eldorado.reportKeepAlive(out);
  assert.equal(world.telegram.length, 0, "a skip is not a failure");
});

// ------------------------------------------------ FIXES-2 V3 keep-alive side --

// The owner's (or the bulk loop's) pause landing while the renewal's relist is
// in flight: on an offer the keep-alive has just paused, markets.pause is a
// no-op on Eldorado, so only the bulk state changes — and then the relist puts
// the offer back on sale.
function turnWhileRelisting(externalId, filter, patch) {
  world.onEldRelist = async (id) => {
    if (id === externalId) await BulkOffer.collection.updateOne(filter, { $set: patch });
  };
}
const renewable = (id, extra = {}) => ({
  id,
  offerState: "Active",
  quantity: 5,
  expireDate: later(2),
  offerTitle: "offer " + id,
  ...extra,
});

test("V3 keep-alive: a bulk offer that stops being live as the renewal relists it is paused again at once; live bulk and plain offers renew as before", async () => {
  // A dropset pack, found through its listing row.
  const pack = await insertOffer({ externalId: "v3-pack" });
  await insertRow({ marketplace: "eldorado", externalId: "v3-pack", bulkOfferId: pack });
  world.eld.set("v3-pack", renewable("v3-pack"));
  turnWhileRelisting("v3-pack", { _id: pack }, { state: "paused" });
  let r = await eldorado.renewOffer("v3-pack");
  assert.equal(r.skipped, "bulk offer turned paused while it was renewed — paused it again");
  assert.equal(r.ok, undefined, "not reported as a renewal");
  assert.equal(count("eldoradoRelist", "v3-pack"), 1);
  assert.equal(count("eldoradoDelist", "v3-pack"), 2, "paused again right after the relist");
  assert.equal(world.eld.get("v3-pack").offerState, "Paused");

  // A farm offer (found by its own externalId) withdrawn meanwhile. A closed
  // farm offer is outside the bulk loop's pass: nothing else would take it down.
  const farmOffer = await insertOffer({ kind: "farming", source: "farm", externalId: "v3-farm" });
  world.eld.set("v3-farm", renewable("v3-farm"));
  turnWhileRelisting("v3-farm", { _id: farmOffer }, { state: "withdrawn", open: false, closedAt: new Date() });
  r = await eldorado.renewOffer("v3-farm");
  assert.equal(r.skipped, "bulk offer turned withdrawn while it was renewed — paused it again");
  assert.equal(count("eldoradoDelist", "v3-farm"), 2);
  assert.equal(world.eld.get("v3-farm").offerState, "Paused");

  // Controls: a bulk offer that stays live renews with one pause and one
  // resume, and so does an offer with no bulk pack behind it.
  world.onEldRelist = null;
  await insertOffer({ externalId: "v3-live" });
  world.eld.set("v3-live", renewable("v3-live"));
  r = await eldorado.renewOffer("v3-live");
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined);
  assert.equal(count("eldoradoDelist", "v3-live"), 1);
  assert.equal(count("eldoradoRelist", "v3-live"), 1);
  assert.equal(world.eld.get("v3-live").offerState, "Active");

  await insertRow({ marketplace: "eldorado", externalId: "v3-plain", origin: "auto" });
  world.eld.set("v3-plain", renewable("v3-plain"));
  r = await eldorado.renewOffer("v3-plain");
  assert.equal(r.ok, true);
  assert.equal(r.state, "Active");
  assert.equal(count("eldoradoOffer", "v3-plain"), 2, "read before and after, as before");
  assert.equal(count("eldoradoDelist", "v3-plain"), 1);
  assert.equal(count("eldoradoRelist", "v3-plain"), 1);
  assert.equal(world.eld.get("v3-plain").offerState, "Active");
  assert.equal(world.telegram.length, 0);
  assert.deepEqual(world.mpHits, []);
});

test("V3 keep-alive: a relist that lands late is taken back when the bulk offer turned meanwhile", async () => {
  const pack = await insertOffer({ externalId: "v3-late" });
  world.eld.set("v3-late", renewable("v3-late"));
  let relists = 0;
  world.onEldRelist = async (id) => {
    if (id !== "v3-late" || ++relists > 1) return true;
    // Eldorado takes the resume but still reads Paused; it lands a moment
    // later — and meanwhile the loop pauses the pack (a no-op on Eldorado).
    setTimeout(() => {
      const o = world.eld.get("v3-late");
      o.offerState = "Active";
      o.expireDate = later(21);
    }, 300);
    await BulkOffer.collection.updateOne({ _id: pack }, { $set: { state: "paused", autoPaused: true } });
    return false;
  };
  const r = await eldorado.renewOffer("v3-late");
  assert.equal(r.skipped, "bulk offer turned paused while it was renewed — paused it again");
  assert.equal(count("eldoradoRelist", "v3-late"), 1, "never relisted a second time");
  assert.equal(count("eldoradoDelist", "v3-late"), 2);
  assert.equal(world.eld.get("v3-late").offerState, "Paused");
});

test("V3 keep-alive pass: a re-pause that fails pages the owner once and is reported as a skip, never as a renewal to resume by hand", async () => {
  const farmOffer = await insertOffer({ kind: "farming", source: "farm", externalId: "v3-fail" });
  world.eld.set("v3-fail", renewable("v3-fail", { expireDate: later(1), offerTitle: "Rust farming bulk" }));
  turnWhileRelisting("v3-fail", { _id: farmOffer }, { state: "paused" });
  const realDelist = mp.eldoradoDelist;
  let delists = 0;
  mp.eldoradoDelist = async (id) => {
    if (String(id) === "v3-fail" && ++delists === 2) {
      world.calls.push(["eldoradoDelist", id]);
      throw new Error("Eldorado delist failed (HTTP 503)");
    }
    return realDelist(id);
  };
  let out;
  try {
    out = await eldorado.renewExpiringOffers({});
  } finally {
    mp.eldoradoDelist = realDelist;
  }
  assert.equal(out.due, 1);
  assert.equal(out.renewed.length, 0);
  assert.equal(out.failed.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(
    out.skipped[0].skipped,
    "bulk offer turned paused while it was renewed — could NOT pause it again (Eldorado delist failed (HTTP 503))",
  );
  assert.equal(count("eldoradoDelist", "v3-fail"), 2);
  assert.equal(world.eld.get("v3-fail").offerState, "Active", "still on sale — why the owner is paged");
  const pages = world.telegram.filter((m) => m.includes("v3-fail"));
  assert.equal(pages.length, 1);
  assert.match(pages[0], /Rust farming bulk/);
  assert.match(pages[0], /could NOT pause it again/);
  assert.match(pages[0], /Pause it there by hand/);
  await eldorado.reportKeepAlive(out);
  assert.equal(world.telegram.length, 1, "the pass report adds no 'resume them on Eldorado' page");
  assert.deepEqual(world.mpHits, []);
});

// ------------------------------------------------------ R3-1 sale learning --

test("R3-1 recordListingSale: accountIds give each unit its account, so a pack unit its buyer connects is ONE sale", async () => {
  const { internalSalesForGame } = require("../utils/autoFarmer");
  const connect = async (game, account, login) =>
    SaleSignal.create({
      game,
      gameKey: game.toLowerCase(),
      login,
      account,
      source: "connected",
      dedupeKey: "connected:" + account + ":" + login,
      at: new Date(),
    });

  const rustSet = { _id: oid(), items: [{ game: "Rust" }] };
  const accs = [oid(), oid(), oid()];
  const rustRow = await insertRow({ marketplace: "gameflip", externalId: "gf-pack-r31", status: "sold", bulkOfferId: oid(), set: rustSet._id, unitsSold: 0 });
  const written = await recordListingSale({
    listing: await MarketplaceListing.collection.findOne({ _id: rustRow }),
    set: rustSet,
    units: 3,
    priceUsd: 1.5,
    bulk: true,
    logins: ["p1", "p2", "p3"],
    accountIds: accs.map(String),
  });
  assert.equal(written, 3);
  const sigs = await SaleSignal.find({ source: "listing_sold" }).lean();
  assert.deepEqual(
    sigs.map((s) => [s.login, String(s.account)]).sort(),
    [["p1", String(accs[0])], ["p2", String(accs[1])], ["p3", String(accs[2])]],
  );
  for (let i = 0; i < 3; i++) await connect("Rust", accs[i], "p" + (i + 1));
  assert.equal((await internalSalesForGame("Rust")).count, 3, "3 accounts sold once each, not 6");

  // What the fix prevents: the same pack WITHOUT accountIds reads as 2N.
  const dotaSet = { _id: oid(), items: [{ game: "Dota 2" }] };
  const dAccs = [oid(), oid()];
  const dotaRow = await insertRow({ marketplace: "gameflip", externalId: "gf-pack-old", status: "sold", bulkOfferId: oid(), set: dotaSet._id, unitsSold: 0 });
  await recordListingSale({
    listing: await MarketplaceListing.collection.findOne({ _id: dotaRow }),
    set: dotaSet,
    units: 2,
    priceUsd: 1,
    bulk: true,
    logins: ["d1", "d2"],
  });
  for (let i = 0; i < 2; i++) await connect("Dota 2", dAccs[i], "d" + (i + 1));
  assert.equal((await internalSalesForGame("Dota 2")).count, 4);

  // An unusable id never costs the signal; an ordinary call is unchanged.
  const badSet = { _id: oid(), items: [{ game: "Apex" }] };
  const badRow = await insertRow({ marketplace: "gameflip", externalId: "gf-pack-bad", status: "sold", bulkOfferId: oid(), set: badSet._id, unitsSold: 0 });
  assert.equal(
    await recordListingSale({
      listing: await MarketplaceListing.collection.findOne({ _id: badRow }),
      set: badSet,
      units: 2,
      bulk: true,
      logins: ["x1", "x2"],
      accountIds: ["not-an-id", ""],
    }),
    2,
  );
  const bad = await SaleSignal.find({ gameKey: "apex" }).lean();
  assert.deepEqual(bad.map((s) => s.account), [null, null]);
  const soloAcc = oid();
  const soloRow = await insertRow({ marketplace: "gameflip", externalId: "gf-solo", status: "sold", origin: "auto", accountId: String(soloAcc), accountLogin: "solo", unitsSold: 0 });
  const soloSet = { _id: oid(), items: [{ game: "Valorant" }] };
  await recordListingSale({ listing: await MarketplaceListing.collection.findOne({ _id: soloRow }), set: soloSet, units: 1, priceUsd: 2 });
  const solo = await SaleSignal.findOne({ gameKey: "valorant" }).lean();
  assert.equal(String(solo.account), String(soloAcc));
  assert.equal(solo.login, "solo");
  assert.equal(solo.bulk, false);
});

test("R3-1 gameflip: a sold pack's sale signals carry each unit's own account and login", async () => {
  const set = await DropSet.create({ name: "R31 set", items: [{ itemKey: "r31|x", name: "R31 item", game: "Rust", qty: 1 }], price: 3 });
  const accs = [oid(), oid()];
  await insertRow({
    marketplace: "gameflip",
    externalId: "gf-pack-sync",
    title: "Rust Twitch Drops bundle — PACK OF 2 ACCOUNTS",
    bulkOfferId: oid(),
    set: set._id,
    autoDeliver: true,
    qtyRemaining: 0,
    price: 4,
    accountLogin: "q1, q2",
    unitsSold: 0,
    units: [unit(accs[0], "q1"), unit(accs[1], "q2")],
  });
  world.gfSold = new Set(["gf-pack-sync"]);
  const res = await gameflip.syncOnce();
  assert.equal(res.sold, 1);
  const sigs = await SaleSignal.find({ source: "listing_sold" }).lean();
  assert.deepEqual(
    sigs.map((s) => [s.login, String(s.account), s.bulk, s.priceUsd]).sort(),
    [["q1", String(accs[0]), true, 2], ["q2", String(accs[1]), true, 2]],
  );
  assert.equal((await rowBy("gf-pack-sync")).status, "sold");
  assert.deepEqual(world.mpHits, []);
});

// --------------------------------------------------------- R3-8 health --

test("R3-8 health: the price-ceiling checks skip bulk rows; ordinary rows are still judged", async () => {
  await insertRow({ marketplace: "gameflip", externalId: "gf-pack-hl", title: "Rust — PACK OF 5 ACCOUNTS", bulkOfferId: oid(), price: 9.5 });
  await insertRow({ marketplace: "gameflip", externalId: "gf-single-hl", title: "Rust Twitch Drops (6 Items)", origin: "auto", price: 9.5 });
  let run = await health.runAll({ only: ["listings.overpriced"], deps: { MarketplaceListing } });
  assert.equal(run.checks[0].status, "fail");
  assert.deepEqual(run.checks[0].items.map((i) => i.externalId), ["gf-single-hl"]);

  run = await health.runAll({
    only: ["listings.venuePrice"],
    deps: {
      MarketplaceListing,
      pricingEvidence: {
        async snapshot() {
          return { platform: new Map([["gameflip", [4.5, 4, 3, 2, 1]]]) };
        },
      },
    },
  });
  assert.equal(run.checks[0].status, "warn");
  assert.deepEqual(run.checks[0].items.map((i) => i.externalId), ["gf-single-hl"]);
});

test("R3-8 health: 'we say active, Eldorado does not' skips bulk rows, which still count as tracked offers", async () => {
  await insertRow({ marketplace: "eldorado", externalId: "eld-bulk-paused", bulkOfferId: oid() });
  await insertRow({ marketplace: "eldorado", externalId: "eld-bulk-live", bulkOfferId: oid() });
  await insertRow({ marketplace: "eldorado", externalId: "eld-single-paused", origin: "auto", title: "Rust Twitch Drops (6 Items)" });
  world.eld.set("eld-bulk-paused", { id: "eld-bulk-paused", offerState: "Paused", offerTitle: "Rust — BULK 5+ accounts" });
  world.eld.set("eld-bulk-live", { id: "eld-bulk-live", offerState: "Active", offerTitle: "Rust — BULK 10+ accounts" });
  world.eld.set("eld-single-paused", { id: "eld-single-paused", offerState: "Paused", offerTitle: "Rust Twitch Drops (6 Items)" });
  const run = await health.runAll({
    only: ["eldorado.offers"],
    deps: {
      MarketplaceListing,
      marketplaces: mp,
      eldoradoFarmService: { parseFarmOrder: async () => null },
      settings: { getAutoFarm: () => ({}) },
    },
  });
  const c = run.checks[0];
  assert.equal(c.status, "fail");
  assert.deepEqual(
    c.items.map((i) => [i.kind, i.offer]),
    [["we say active, Eldorado does not", "eld-single-paused"]],
  );
});

// ---------------------------------------------------------------- page --

test("page: attention shows beside lastError; a closed offer still holding accounts offers a typed-RELEASE release", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/bulk-packs.html"), "utf8");
  const inline = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\bsrc=/.test(m[1] || ""))
    .map((m) => m[2]);
  assert.ok(inline.length >= 1);
  for (const code of inline) new vm.Script(code); // every inline script parses
  const js = inline.join("\n");
  // attention: in the offer row (next to lastError) and in the details pane.
  assert.match(js, /o\.attention \? '<div class="t-att">'[\s\S]{0,120}\(o\.lastError \? '<div class="t-err">'/);
  assert.match(js, /if \(o\.attention\) h \+= '<div class="note warn"/);
  // Release held accounts: only for a closed offer holding on_offer entries,
  // behind the typed word, calling the route with it.
  assert.match(js, /function holdsAccounts\(o\)[\s\S]{0,300}toInt\(o\.freeCount\) > 0[\s\S]{0,200}u\.state === "on_offer"/);
  assert.match(js, /actBtn\("release-held", id, "Release held accounts…"/);
  assert.match(js, /case "release-held": openReleaseHeld\(id\)/);
  assert.match(js, /"\/release-held", "POST", \{ confirm: typed \}/);
  assert.match(js, /typed !== "RELEASE"/);
  assert.ok(js.includes("Only after you checked the marketplace: the offer is NOT live."));
});
