// An Eldorado reserved-units row is retired "sold" the moment its last unit is
// delivered (2026-10-01).
//
// Eldorado CLOSES an offer when its quantity reaches 0, and nothing restocks a
// units row, so after the last delivery the row can never sell again — yet it
// stayed "active": counted as live stock, and flagged by the eldorado.offers
// health check as "we say active, Eldorado does not" until somebody reconciled
// it by hand (14 such offers between 09-11 and 09-27). The auto-lister retired
// them only for a task still running, on its next sweep.
//
// Runs the real deliverOrder against mongodb-memory-server with the marketplace
// faked, so no message is sent anywhere.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "eld-sold-out-test";
process.env.CRED_SECRET ||= "eld-sold-out-cred";

const world = { sent: [], delivered: [], quantity: [] };
const fakeMp = {
  async eldoradoSendOrderMessage(order, text) {
    world.sent.push({ order: order.id, text });
  },
  async eldoradoMarkDelivered(orderId) {
    world.delivered.push(orderId);
  },
  async eldoradoSetQuantity(offerId, q) {
    world.quantity.push({ offerId, q });
    return q;
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]eldoradoFulfiller\.js$/.test(parent.filename || "")) {
    if (request === "./marketplaces") return fakeMp;
  }
  return realLoad.call(this, request, parent, isMain);
};

const { encrypt } = require("../utils/secretBox");
const MarketplaceListing = require("../models/MarketplaceListing");
const BotAccount = require("../models/BotAccount");
const eld = require("../utils/eldoradoFulfiller");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.beforeEach(async () => {
  await MarketplaceListing.deleteMany({});
  await BotAccount.deleteMany({});
  world.sent = [];
  world.delivered = [];
  world.quantity = [];
});

async function unitsRow(offer, logins) {
  const units = [];
  for (const login of logins) {
    const acct = await BotAccount.create({ login, clientSecret: "cs-" + login, credPassword: encrypt("pw-" + login) });
    units.push({ accountId: String(acct._id), login, addedAt: new Date(), deliveredAt: null, orderId: "" });
  }
  return MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "eldorado",
    externalId: offer,
    title: "Brawlhalla Twitch Drops (10 Items) — Lady Vera v6 + Munin v6 +8 more",
    price: 1,
    status: "active",
    origin: "auto",
    qtyTarget: logins.length,
    units,
  });
}

const order = (id, offerId, qty = 1) => ({ id, offerId, purchaseQuantity: qty });

test("REGRESSION 2026-10-01: delivering the last unit retires the row as sold", async () => {
  await unitsRow("eld-one", ["qrimet"]);
  const r = await eld.deliverOrder(order("ord-1", "eld-one"), { dryRun: false });
  assert.strictEqual(r.delivered, 1);
  assert.deepStrictEqual(world.delivered, ["ord-1"]);
  const after = await MarketplaceListing.findOne({ externalId: "eld-one" }).lean();
  assert.strictEqual(after.status, "sold");
  assert.match(after.lastError, /sold out — every unit delivered \(last: order ord-1\)/);
  assert.strictEqual(after.units[0].orderId, "ord-1");
  assert.ok(after.units[0].deliveredAt, "the unit is stamped before the row is retired");
  assert.deepStrictEqual(world.quantity, [{ offerId: "eld-one", q: 0 }]);
});

test("a row with units left stays active, its quantity pushed down", async () => {
  await unitsRow("eld-two", ["acct-a", "acct-b"]);
  await eld.deliverOrder(order("ord-2", "eld-two"), { dryRun: false });
  const after = await MarketplaceListing.findOne({ externalId: "eld-two" }).lean();
  assert.strictEqual(after.status, "active");
  assert.strictEqual(after.units.filter((u) => !u.deliveredAt).length, 1);
  assert.deepStrictEqual(world.quantity, [{ offerId: "eld-two", q: 1 }]);
});

test("a row somebody already took off sale is not overwritten", async () => {
  // The retire is conditional on status "active": a row delisted by hand while
  // its last order was in flight keeps the owner's status.
  const row = await unitsRow("eld-delisted", ["acct-c"]);
  await MarketplaceListing.updateOne({ _id: row._id }, { $set: { status: "delisted" } });
  await eld.deliverOrder(order("ord-3", "eld-delisted"), { dryRun: false });
  const after = await MarketplaceListing.findOne({ externalId: "eld-delisted" }).lean();
  assert.strictEqual(after.status, "delisted");
});

test("a dry run changes nothing", async () => {
  await unitsRow("eld-dry", ["acct-d"]);
  const r = await eld.deliverOrder(order("ord-4", "eld-dry"), { dryRun: true });
  assert.strictEqual(r.dryRun, true);
  const after = await MarketplaceListing.findOne({ externalId: "eld-dry" }).lean();
  assert.strictEqual(after.status, "active");
  assert.deepStrictEqual(world.delivered, []);
});
