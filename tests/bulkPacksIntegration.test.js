// Bulk packs end to end (docs/bulk-packs/CONTRACT.md): the REAL modules wired
// together — config, pricing, copy, stock, markets, send, loop, the real
// reservation layer, the real Eldorado delivery path and the real
// listingDetach choke point — over an in-memory Mongo. Only the marketplace
// connector (utils/marketplaces.js), the cover image builder and the settings
// source are faked. Nothing touches the network or utils/settings.json.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.CRED_SECRET = "bulk-packs-integration-test-secret-0123456789";
process.env.TG_TOKEN = "";

// ---- fake marketplace connector, installed before anything requires it ----
const calls = [];
let seq = 0;
const known = {
  G2G_MIN_PRICE: 1,
  G2G_ITEMS_SERVICE: "svc-items",
  async eldoradoPublish(a) {
    calls.push(["eldoradoPublish", a]);
    seq++;
    return { externalId: "eld-" + seq, id: "eld-" + seq, url: "https://eldorado.test/o/" + seq };
  },
  async eldoradoSetQuantity(id, n) {
    calls.push(["eldoradoSetQuantity", id, n]);
  },
  async eldoradoDelist(id) {
    calls.push(["eldoradoDelist", id]);
  },
  async eldoradoRelist(id) {
    calls.push(["eldoradoRelist", id]);
  },
  async eldoradoOffer(id) {
    calls.push(["eldoradoOffer", id]);
    return { id, offerState: "Active", quantity: 10 };
  },
  async eldoradoOrderChatReady() {
    return true;
  },
  async eldoradoSendOrderMessage(order, msg) {
    calls.push(["eldoradoSendOrderMessage", order.id, msg]);
  },
  async eldoradoMarkDelivered(orderId) {
    calls.push(["eldoradoMarkDelivered", orderId]);
  },
  async gameflipPublish(a) {
    calls.push(["gameflipPublish", a]);
    seq++;
    return { externalId: "gf-" + seq, url: "https://gameflip.test/l/" + seq };
  },
  async gameflipDelist(id) {
    calls.push(["gameflipDelist", id]);
  },
};
const fakeMp = new Proxy(known, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === "string" && /^[a-z]/.test(k)) {
      return async (...args) => {
        calls.push(["?" + k, ...args]);
        return null;
      };
    }
    return undefined;
  },
});
const mpPath = require.resolve("../utils/marketplaces");
require.cache[mpPath] = { id: mpPath, filename: mpPath, loaded: true, exports: fakeMp };

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const realSettings = require("../utils/settings");
const { encrypt } = require("../utils/secretBox");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const BulkOffer = require("../models/BulkOffer");
const RenterAccount = require("../models/RenterAccount");
const config = require("../utils/bulkPacks/config");
const markets = require("../utils/bulkPacks/markets");
const send = require("../utils/bulkPacks/send");
const loop = require("../utils/bulkPacks/loop");
const proposals = require("../utils/bulkPacks/proposals");
const eldoradoFulfiller = require("../utils/eldoradoFulfiller");
const { detachAccountFromListing } = require("../utils/listingDetach");

const AF = {
  bulkPacksEnabled: true,
  bulkPacksMarkets: ["eldorado", "g2g", "gameflip"],
  bulkPackTiers: [
    { minQty: 5, discountPct: 5 },
    { minQty: 10, discountPct: 10 },
  ],
  bulkPackReserveSingles: 0,
  bulkPackUnitsPerOffer: 20,
  eldoradoAutoDeliver: true,
  eldoradoDeliverDryRun: false,
  g2gAutoDeliver: true,
  g2gDeliverDryRun: false,
  platiEnabled: false,
  ggselEnabled: false,
};
const fakeSettings = {
  ...realSettings,
  getAutoFarm: () => AF,
  getBulkPacks: (afIn) => realSettings.getBulkPacks(afIn || AF),
  getNoclaimShopSettings: () => ({ enabled: true, autoDeliver: true }),
};
function tmpCover() {
  const p = path.join(os.tmpdir(), "bulk-cover-" + process.pid + "-" + ++seq + ".png");
  fs.writeFileSync(p, "png");
  return p;
}

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulkPacksIntegration"));
  await Promise.all([BulkOffer.init(), MarketplaceListing.init(), DropLog.init()]);
  config.__setDeps({ settings: fakeSettings });
  send.__setDeps({ settings: fakeSettings });
  loop.__setDeps({ settings: fakeSettings });
  proposals.__setDeps({ settings: fakeSettings });
  markets.__setDeps({
    settings: fakeSettings,
    setImage: {
      buildSetGridImage: async () => tmpCover(),
      buildPromoCoverImage: async () => tmpCover(),
    },
  });
});
test.after(async () => {
  for (const m of [config, send, loop, proposals, markets]) m.__resetDeps();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const T0 = Date.now();
const at = (min) => new Date(T0 + min * 60e3);

async function seedSet({ name, itemKey, game, accounts, prefix, market, price }) {
  const set = await DropSet.create({
    name,
    items: [{ itemKey, name: name + " item", game, qty: 1 }],
    price: 3,
  });
  const ids = [];
  for (let i = 1; i <= accounts; i++) {
    const login = prefix + String(i).padStart(2, "0");
    const acc = await BotAccount.create({
      clientSecret: "secret-" + login,
      login,
      credUsername: login,
      credPassword: encrypt("pw-" + login),
      hasPassword: true,
      lastScanStatus: "ok",
    });
    ids.push(String(acc._id));
    await DropLog.create({
      account: acc._id,
      benefitId: "b-" + login,
      login,
      game,
      itemKey,
      count: 1,
      connected: false,
      soldAt: null,
    });
  }
  // The single listing whose price anchors the bulk tiers.
  await MarketplaceListing.create({
    set: set._id,
    marketplace: market,
    externalId: "single-" + name,
    title: name + " single",
    price,
    status: "active",
    origin: "auto",
  });
  return { set, ids };
}

async function reservationOf(accountId) {
  const d = await DropLog.findOne({ account: accountId }).lean();
  return d ? { soldAt: d.soldAt, tag: d.soldToUsername, setId: d.soldSetId } : null;
}

test("eldorado dropset pack: send → real delivery of a pack → sold out → leftovers released, sold ones kept", async () => {
  const { set, ids } = await seedSet({
    name: "Rust bundle",
    itemKey: "rust|ak",
    game: "Rust",
    accounts: 20,
    prefix: "rust",
    market: "eldorado",
    price: 2,
  });

  const r = await send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market: "eldorado",
    minQty: 5,
    units: 10,
    actor: "test",
  });
  assert.equal(r.success, true, r.message);
  const pub = calls.find((c) => c[0] === "eldoradoPublish")[1];
  // PACKS-2: one unit = one pack of 5; quantity counts PACKS.
  assert.equal(pub.quantity, 2);
  assert.equal(pub.minQuantity, 1);
  assert.equal(pub.priceUsd, 9.5); // 5 × $2 single × 0.95
  assert.match(pub.title, /PACK OF 5 ACCOUNTS/);
  assert.doesNotMatch(pub.title, /Automatic\s+Farming/i);

  const offer = await BulkOffer.findById(r.offer._id || r.offer.id).lean();
  assert.equal(offer.state, "live");
  const row = await MarketplaceListing.findOne({ bulkOfferId: offer._id }).lean();
  assert.equal(row.origin, "manual");
  assert.equal(row.bulkPackSize, 5);
  assert.equal(row.units.length, 10);
  for (const u of row.units) {
    const res = await reservationOf(u.accountId);
    assert.ok(res.soldAt, "unit reserved");
    assert.equal(res.tag, "eldorado");
    assert.equal(res.setId, String(set._id));
  }

  // A real paid order for ONE pack through the REAL Eldorado delivery path.
  const del = await eldoradoFulfiller.deliverOrder(
    { id: "order-1", offerId: row.externalId, purchaseQuantity: 1 },
    { dryRun: false },
  );
  assert.ok(!del.error, JSON.stringify(del));
  const msg = calls.find((c) => c[0] === "eldoradoSendOrderMessage");
  assert.ok(msg && /ACCOUNT 5 of 5/.test(msg[2]), "five accounts in one message");
  assert.ok(!/ACCOUNT 6 of/.test(msg[2]), "never more than the pack");
  let fresh = await MarketplaceListing.findById(row._id).lean();
  assert.equal(fresh.units.filter((u) => u.orderId === "order-1").length, 5);
  assert.ok(
    calls.some((c) => c[0] === "eldoradoSetQuantity" && c[1] === row.externalId && c[2] === 1),
    "one pack left on sale",
  );

  // One of the 5 left loses its password: 4 good accounts cannot make a pack.
  const broken = fresh.units.find((u) => !u.orderId);
  await BotAccount.updateOne({ _id: broken.accountId }, { $set: { credPassword: "" } });
  await loop.runOnce({ now: at(1) });
  let o = await BulkOffer.findById(offer._id).lean();
  assert.equal(o.state, "sold_out");
  assert.equal(o.open, false);
  assert.equal(o.unitsDelivered, 5);
  assert.equal(o.ordersCount, 1);
  assert.ok(calls.some((c) => c[0] === "eldoradoDelist" && c[1] === row.externalId));
  assert.equal(o.reserved.filter((e) => e.state === "retiring").length, 5);

  // Pass 2 (after the 15-minute grace, FIXES-1 L2): the 5 leftovers go back to stock.
  await loop.runOnce({ now: at(17) });
  o = await BulkOffer.findById(offer._id).lean();
  const delivered = o.reserved.filter((e) => e.state === "delivered");
  const released = o.reserved.filter((e) => e.state === "released");
  assert.equal(delivered.length, 5);
  assert.equal(released.length, 5);
  for (const e of delivered) assert.ok((await reservationOf(e.accountId)).soldAt, "sold stays reserved");
  for (const e of released) assert.equal((await reservationOf(e.accountId)).soldAt, null, "leftover released");
  assert.equal(ids.length, 20);
});

test("owner hand-sale of a pack account: the market drops to whole packs first, the account stays reserved", async () => {
  const set = await DropSet.findOne({ name: "Rust bundle" }).lean();
  const r = await send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market: "eldorado",
    minQty: 5,
    units: 10,
    actor: "test",
  });
  assert.equal(r.success, true, r.message);
  const offerId = r.offer._id || r.offer.id;
  const row = await MarketplaceListing.findOne({ bulkOfferId: offerId });
  assert.equal(row.units.length, 10);
  const victim = row.units[0];

  const out = await detachAccountFromListing(
    row.toObject(),
    { _id: victim.accountId, login: victim.login },
    { reason: "sold manually" },
  );
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.units.length, 9);
  assert.ok(
    calls.some((c) => c[0] === "eldoradoSetQuantity" && c[1] === row.externalId && c[2] === 1),
    "9 accounts left = 1 whole pack on sale",
  );

  // Past the 15-minute grace (FIXES-1 L2) since the take-out.
  await loop.runOnce({ now: at(35) });
  const o = await BulkOffer.findById(offerId).lean();
  const e = o.reserved.find((x) => String(x.accountId) === String(victim.accountId));
  assert.equal(e.state, "released");
  assert.equal(e.keepReserved, true);
  assert.match(e.reason, /kept reserved/);
  const res = await reservationOf(victim.accountId);
  assert.ok(res.soldAt, "the hand-sold account is still reserved, never back on sale");
  assert.equal(o.state, "live");
});

test("gameflip pack: one listing holds all 5 accounts; a sale finalises the offer", async () => {
  const { set } = await seedSet({
    name: "Apex bundle",
    itemKey: "apex|charm",
    game: "Apex Legends",
    accounts: 10,
    prefix: "apex",
    market: "gameflip",
    price: 1.25,
  });
  const r = await send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market: "gameflip",
    minQty: 5,
    actor: "test",
  });
  assert.equal(r.success, true, r.message);
  const pub = calls.filter((c) => c[0] === "gameflipPublish").pop()[1];
  assert.equal(pub.priceUsd, 6); // 5 × $1.25 × 0.95 = 5.94 → $6.00 (quarter)
  for (let i = 1; i <= 5; i++) assert.match(pub.autoDeliverCode, new RegExp("ACCOUNT " + i + " of 5"));
  assert.equal(pub.autoDeliverCode.split(markets.PACK_SEPARATOR).length, 5);

  const offerId = r.offer._id || r.offer.id;
  const row = await MarketplaceListing.findOne({ bulkOfferId: offerId }).lean();
  assert.equal(row.qtyRemaining, 0);
  assert.equal(row.units.length, 5);
  // What gameflipFulfiller.syncOnce does when Gameflip reports the sale.
  await MarketplaceListing.updateOne({ _id: row._id }, { $set: { status: "sold" } });
  await loop.runOnce({ now: at(40) });
  const o = await BulkOffer.findById(offerId).lean();
  assert.equal(o.state, "sold");
  assert.equal(o.reserved.filter((e) => e.state === "delivered").length, 5);
  assert.equal(o.revenueUsd, 6);
});

test("rented-out member: the gameflip pack is withdrawn, the others released, the rented one kept", async () => {
  const set = await DropSet.findOne({ name: "Apex bundle" }).lean();
  const r = await send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market: "gameflip",
    minQty: 5,
    actor: "test",
  });
  assert.equal(r.success, true, r.message);
  const offerId = r.offer._id || r.offer.id;
  const row = await MarketplaceListing.findOne({ bulkOfferId: offerId }).lean();
  const rentedUnit = row.units[2];
  const acc = await BotAccount.findById(rentedUnit.accountId).lean();
  await RenterAccount.create({
    renter: new mongoose.Types.ObjectId(),
    clientSecret: acc.clientSecret,
    login: acc.login,
  });

  await loop.runOnce({ now: at(45) });
  let o = await BulkOffer.findById(offerId).lean();
  assert.equal(o.state, "withdrawn");
  assert.ok(calls.some((c) => c[0] === "gameflipDelist" && c[1] === row.externalId));
  assert.equal((await MarketplaceListing.findById(row._id).lean()).status, "delisted");

  await loop.runOnce({ now: at(61) }); // past the 15-minute grace (FIXES-1 L2)
  o = await BulkOffer.findById(offerId).lean();
  for (const e of o.reserved) {
    const res = await reservationOf(e.accountId);
    if (String(e.accountId) === String(rentedUnit.accountId)) {
      assert.equal(e.keepReserved, true);
      assert.ok(res.soldAt, "rented account stays reserved");
    } else {
      assert.equal(e.state, "released");
      assert.equal(res.soldAt, null, "other members back in stock");
    }
  }
});

test("switched off: nothing can be sent", async () => {
  AF.bulkPacksEnabled = false;
  try {
    const set = await DropSet.findOne({ name: "Rust bundle" }).lean();
    const r = await send.sendOffer({
      source: "dropset",
      setId: String(set._id),
      market: "eldorado",
      minQty: 5,
      actor: "test",
    });
    assert.equal(r.success, false);
    assert.equal(r.status, 409);
  } finally {
    AF.bulkPacksEnabled = true;
  }
});
