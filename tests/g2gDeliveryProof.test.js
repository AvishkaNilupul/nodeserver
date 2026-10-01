// G2G delivery proofs (2026-10-01). G2G holds an order's income until a proof
// image is uploaded (order item: require_delivery_proof_to_credit_income), for
// orders awaiting the buyer AND completed ones. The fulfiller's proof sweep
// uploads one — the delivery card, never the credential — for every fully
// delivered order whose credential OUR chat send handed over, exactly once.
//
// Real g2gFulfiller + MarketplaceListing / FarmServiceOrder on
// mongodb-memory-server; the G2G API, settings and Telegram are faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const world = {
  af: { g2gAutoDeliver: true, g2gDeliverDryRun: false },
  orders: [], // normalized list rows
  items: {}, // orderItemId -> order item payload
  uploads: [],
  uploadFails: null,
  pages: [],
};

const fakeMp = {
  g2gOrders: async ({ page, status }) => (page === 1 ? world.orders.filter((o) => o.raw.order_item_status === status) : []),
  g2gOrder: async (id) => world.items[id] || {},
  g2gUploadDeliveryProof: async (id, png) => {
    if (world.uploadFails) throw new Error(world.uploadFails);
    world.uploads.push({ id, bytes: png.length });
    if (world.items[id]) world.items[id].total_uploaded_proofs = (world.items[id].total_uploaded_proofs || 0) + 1;
    return { key: "k-" + id, results: ["k-" + id] };
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]g2gFulfiller\.js$/.test(parent.filename || "")) {
    if (request === "./marketplaces") return fakeMp;
    if (request === "./settings") return { getAutoFarm: () => world.af, getAccountListingSettings: () => ({}) };
    if (request === "./telegram") return { sendTelegram: async (m) => { world.pages.push(m); } };
    if (request === "./systemLog") return { logEvent: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
};

const MarketplaceListing = require("../models/MarketplaceListing");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const ful = require("../utils/g2gFulfiller");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("g2g-delivery-proof"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const DELIVERED_AT = 1790833296410;
function order(id, { status = "delivering", purchased = 2, delivered = 2 } = {}) {
  return {
    orderItemId: id,
    title: "Halo Infinite Twitch Drops (22 Items)",
    purchasedQty: purchased,
    deliveredQty: delivered,
    raw: { order_item_status: status },
  };
}
function item({ proofs = 0, required = true } = {}) {
  return {
    offer_title: "Halo Infinite Twitch Drops (22 Items) — Acid Punch",
    require_delivery_proof: required,
    require_delivery_proof_to_credit_income: required,
    total_uploaded_proofs: proofs,
    order_delivered_at: DELIVERED_AT,
  };
}
async function listingWith(orderId, { messaged = true, delivered = false } = {}) {
  const row = new MarketplaceListing({
    marketplace: "g2g",
    set: new mongoose.Types.ObjectId(),
    externalId: "offer-" + orderId,
    title: "Halo Infinite Twitch Drops (22 Items)",
    status: "active",
    units: [
      { login: "acct1", accountId: "a1", orderId, messagedAt: messaged ? new Date("2026-10-01T01:19:38Z") : null, deliveredAt: delivered ? new Date() : null },
      { login: "acct2", accountId: "a2", orderId, messagedAt: messaged ? new Date("2026-10-01T01:19:38Z") : null, deliveredAt: null },
    ],
  });
  await row.save();
  return row;
}
async function reset() {
  Object.assign(world, { af: { g2gAutoDeliver: true, g2gDeliverDryRun: false }, orders: [], items: {}, uploads: [], uploadFails: null, pages: [] });
  ful._resetProofState();
  await Promise.all([MarketplaceListing.deleteMany({}), FarmServiceOrder.deleteMany({})]);
}

test("a delivered order our chat send handed over gets ONE proof, and its units are stamped delivered", async () => {
  await reset();
  world.orders = [order("O-1")];
  world.items["O-1"] = item();
  const row = await listingWith("O-1");
  const r1 = await ful.sweepDeliveryProofs();
  assert.equal(r1.uploaded, 1, JSON.stringify(r1));
  assert.equal(world.uploads.length, 1);
  assert.ok(world.uploads[0].bytes > 1000, "a real PNG");
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.ok(after.units.every((u) => u.deliveredAt), "units stamped");
  assert.equal(new Date(after.units[1].deliveredAt).getTime(), DELIVERED_AT, "with G2G's own delivery time");
  // Next pass: nothing more.
  await ful.sweepDeliveryProofs();
  assert.equal(world.uploads.length, 1, "exactly once");
});

test("completed orders count too; an order we did not send, one with a proof, or one not fully delivered is left alone", async () => {
  await reset();
  world.orders = [
    order("DONE-1", { status: "completed" }),
    order("NOT-OURS", { status: "completed" }),
    order("HAS-PROOF"),
    order("PARTIAL", { purchased: 2, delivered: 1 }),
  ];
  world.items = { "DONE-1": item(), "NOT-OURS": item(), "HAS-PROOF": item({ proofs: 1 }), PARTIAL: item() };
  await listingWith("DONE-1");
  await listingWith("HAS-PROOF");
  await listingWith("PARTIAL");
  const r = await ful.sweepDeliveryProofs();
  assert.deepEqual(world.uploads.map((u) => u.id), ["DONE-1"]);
  assert.equal(r.notOurs, 1);
  assert.equal(r.already, 1);
});

test("a units row that was never messaged is not ours to attest; a rent-farm order we sent is", async () => {
  await reset();
  world.orders = [order("UNSENT"), order("FARM-1", { purchased: 1, delivered: 1 })];
  world.items = { UNSENT: item(), "FARM-1": item() };
  await listingWith("UNSENT", { messaged: false });
  await FarmServiceOrder.create({ orderId: "g2g:FARM-1", market: "g2g", game: "Rust", days: 30, state: "delivered", messageSentAt: new Date(), accounts: [{ login: "f1" }] });
  await ful.sweepDeliveryProofs();
  assert.deepEqual(world.uploads.map((u) => u.id), ["FARM-1"]);
});

test("a failed upload backs off and pages once after three tries; dry run uploads nothing", async () => {
  await reset();
  world.orders = [order("F-1")];
  world.items["F-1"] = item();
  await listingWith("F-1");
  world.uploadFails = "G2G proof upload failed (HTTP 403): AccessDenied";
  let now = Date.UTC(2026, 9, 1, 6, 0);
  await ful.sweepDeliveryProofs({ now });
  await ful.sweepDeliveryProofs({ now: now + 60000 });
  assert.equal(world.pages.length, 0, "not retried inside its back-off, no page yet");
  now += 31 * 60000;
  await ful.sweepDeliveryProofs({ now });
  now += 61 * 60000;
  await ful.sweepDeliveryProofs({ now });
  assert.equal(world.pages.length, 1, "paged after the third failure");
  assert.match(world.pages[0], /delivery proof could not be uploaded/);
  now += 5 * 3600000;
  await ful.sweepDeliveryProofs({ now });
  assert.equal(world.pages.length, 1, "paged once");

  await reset();
  world.af.g2gDeliverDryRun = true;
  world.orders = [order("D-1")];
  world.items["D-1"] = item();
  await listingWith("D-1");
  const r = await ful.sweepDeliveryProofs();
  assert.equal(r.wouldUpload, 1);
  assert.equal(world.uploads.length, 0);
});
