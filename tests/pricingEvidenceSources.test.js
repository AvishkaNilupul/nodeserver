// What utils/pricingEvidence.buildSnapshot counts as a realised sale
// (2026-10-01).
//
// Measured on prod before the fix: Gameflip's "venue" bucket held 284 prices
// for 147 sales — every multi-game bundle counted once per game it carried,
// and every sold row counted again on top of its own signals — and its
// maximum was an $8.00 "Automatic Farming 1 Year" window, which set a $16.00
// price ceiling for $1.25 drop bundles. Eldorado's bucket was the 6 rows ever
// marked "sold", all at $1.00, while 264 units had sold there at up to $2.25:
// Eldorado, PlayerAuctions and G2G fulfillers write no sale signals, so their
// sales exist only as delivered units on the listing row.
//
// Runs the real builder against mongodb-memory-server. Rows go in through the
// native driver so `updatedAt` is exactly what each case says it is.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SaleSignal = require("../models/SaleSignal");
const MarketplaceListing = require("../models/MarketplaceListing");
const evidence = require("../utils/pricingEvidence");

let mongod;
const DAY = 86400000;
const now = Date.now();
const recent = new Date(now - 2 * DAY);
const oid = () => new mongoose.Types.ObjectId();

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.beforeEach(async () => {
  await SaleSignal.collection.deleteMany({});
  await MarketplaceListing.collection.deleteMany({});
  evidence.invalidate();
});

function signal(o) {
  return {
    game: o.gameKey,
    itemKey: "",
    name: "",
    login: "",
    account: null,
    source: "listing_sold",
    bulk: false,
    at: recent,
    ...o,
  };
}
function listing(o) {
  return {
    set: oid(),
    externalId: String(oid()),
    title: "Some Game Twitch Drops (3 Items)",
    status: "active",
    rentFarm: false,
    bulkOfferId: null,
    units: [],
    updatedAt: recent,
    ...o,
  };
}
const sorted = (a) => [...(a || [])].sort((x, y) => x - y);

test("a multi-game bundle is one sale per unit at venue level, one entry per game below it", async () => {
  const id = oid();
  await SaleSignal.collection.insertMany([
    // unit 0 of a three-game bundle at $2.00
    signal({ dedupeKey: `sold:${id}:alpha:0`, gameKey: "alpha", marketplace: "gameflip", priceUsd: 2 }),
    signal({ dedupeKey: `sold:${id}:beta:0`, gameKey: "beta", marketplace: "gameflip", priceUsd: 2 }),
    signal({ dedupeKey: `sold:${id}:gamma:0`, gameKey: "gamma", marketplace: "gameflip", priceUsd: 2 }),
    // unit 1 of the same listing, one game
    signal({ dedupeKey: `sold:${id}:alpha:1`, gameKey: "alpha", marketplace: "gameflip", priceUsd: 2 }),
  ]);
  const s = await evidence.buildSnapshot();
  assert.deepEqual(s.platform.get("gameflip"), [2, 2], "two units sold, not four");
  assert.deepEqual(s.global, [2, 2]);
  assert.deepEqual(s.game.get("alpha"), [2, 2]);
  assert.deepEqual(s.game.get("beta"), [2]);
  assert.deepEqual(s.platformGame.get("gameflip|gamma"), [2]);
});

test("a sold row whose own signals were counted is not counted again", async () => {
  const row = listing({ marketplace: "gameflip", status: "sold", price: 1.5 });
  const { insertedId } = await MarketplaceListing.collection.insertOne(row);
  await SaleSignal.collection.insertOne(
    signal({ dedupeKey: `sold:${insertedId}:alpha:0`, gameKey: "alpha", marketplace: "gameflip", priceUsd: 1.5 }),
  );
  // A sold row with no signals of its own still counts.
  await MarketplaceListing.collection.insertOne(listing({ marketplace: "gameflip", status: "sold", price: 1.25 }));
  const s = await evidence.buildSnapshot();
  assert.deepEqual(sorted(s.platform.get("gameflip")), [1.25, 1.5]);
  assert.equal(s.counts.soldListings, 1);
});

test("rent-farm windows never price a drop bundle, from any source", async () => {
  await MarketplaceListing.collection.insertMany([
    // flagged rent-farm row
    listing({ marketplace: "gameflip", status: "sold", price: 8, rentFarm: true, title: "Overwatch Automatic Farming 1 Year" }),
    // unflagged, but the title says it is a farming window
    listing({ marketplace: "gameflip", status: "sold", price: 5, title: "Marvel Rivals Auto-Farm 30 Days" }),
    // a farm offer on a unit-ledger market
    listing({
      marketplace: "eldorado",
      price: 6,
      rentFarm: true,
      title: "Overwatch Automatic Farming 1 Month",
      units: [{ accountId: "a", orderId: "o-farm", deliveredAt: recent }],
    }),
    listing({ marketplace: "gameflip", status: "sold", price: 1.25 }),
  ]);
  await SaleSignal.collection.insertOne(
    signal({ dedupeKey: `sold:${oid()}:overwatch:0`, gameKey: "overwatch", marketplace: "gameflip", priceUsd: 5, name: "Overwatch Automatic Farming 3 Months" }),
  );
  const s = await evidence.buildSnapshot();
  assert.deepEqual(s.platform.get("gameflip"), [1.25]);
  assert.deepEqual(s.global, [1.25]);
  assert.equal(s.platform.get("eldorado"), undefined);
  assert.equal(s.game.get("overwatch"), undefined, "a farm signal must not anchor the game either");
  assert.equal(s.counts.farmSkipped, 2, "the unflagged farm row and the farm signal (the flagged ones never load)");
});

test("Eldorado / PlayerAuctions / G2G sales count once per delivered unit", async () => {
  const old = new Date(now - 200 * DAY);
  await MarketplaceListing.collection.insertMany([
    listing({
      marketplace: "eldorado",
      price: 1.5,
      units: [
        { accountId: "a1", orderId: "o1", deliveredAt: recent },
        { accountId: "a2", orderId: "o2", deliveredAt: recent },
        { accountId: "a3", orderId: "", deliveredAt: null }, // stock, not a sale
        { accountId: "a4", orderId: "o0", deliveredAt: old }, // sold before the window
      ],
    }),
    listing({
      marketplace: "playerauctions",
      price: 5,
      status: "sold",
      units: [{ accountId: "p1", orderId: "pa-1", deliveredAt: recent }],
    }),
    // stamped with an order but not delivered yet: not a sale
    listing({ marketplace: "g2g", price: 2, units: [{ accountId: "g1", orderId: "g2g-1", deliveredAt: null }] }),
    // a sold Eldorado row from before the unit ledger: counted once, as a row
    listing({ marketplace: "eldorado", price: 1, status: "sold" }),
    // a bulk pack's units never anchor a single price
    listing({ marketplace: "eldorado", price: 0.4, bulkOfferId: oid(), units: [{ accountId: "b1", orderId: "b-1", deliveredAt: recent }] }),
  ]);
  const s = await evidence.buildSnapshot();
  assert.deepEqual(sorted(s.platform.get("eldorado")), [1, 1.5, 1.5]);
  assert.deepEqual(s.platform.get("playerauctions"), [5], "the sold PA row is its unit, not unit + row");
  assert.equal(s.platform.get("g2g"), undefined);
  assert.equal(s.counts.deliveredUnits, 3);
  assert.equal(s.counts.soldListings, 1);
});

test("a signal the delist route wrote for a ledger row is not a second venue sale", async () => {
  const row = listing({
    marketplace: "eldorado",
    price: 2,
    status: "sold",
    units: [{ accountId: "a1", orderId: "o1", deliveredAt: recent }],
  });
  const { insertedId } = await MarketplaceListing.collection.insertOne(row);
  await SaleSignal.collection.insertOne(
    signal({ dedupeKey: `sold:${insertedId}:alpha:0`, gameKey: "alpha", marketplace: "eldorado", priceUsd: 2 }),
  );
  const s = await evidence.buildSnapshot();
  assert.deepEqual(s.platform.get("eldorado"), [2]);
  assert.deepEqual(s.global, [2]);
  // ...but its game still learns from it: units carry no game.
  assert.deepEqual(s.game.get("alpha"), [2]);
  assert.deepEqual(s.platformGame.get("eldorado|alpha"), [2]);
});

test("Shop and hand-recorded sales are one sale each, however many games", async () => {
  const acc = oid();
  const set = oid();
  const hand = oid();
  await SaleSignal.collection.insertMany([
    signal({ dedupeKey: `reserved:${acc}:${set}:alpha`, gameKey: "alpha", marketplace: "shop", priceUsd: 3 }),
    signal({ dedupeKey: `reserved:${acc}:${set}:beta`, gameKey: "beta", marketplace: "shop", priceUsd: 3 }),
    signal({ dedupeKey: `manual-sold:${hand}:alpha`, gameKey: "alpha", marketplace: "g2g", priceUsd: 2, name: "manual sale" }),
    signal({ dedupeKey: `manual-sold:${hand}:gamma`, gameKey: "gamma", marketplace: "g2g", priceUsd: 2, name: "manual sale" }),
    // bulk pack units never anchor
    signal({ dedupeKey: `sold:${oid()}:alpha:0`, gameKey: "alpha", marketplace: "gameflip", priceUsd: 0.5, bulk: true }),
  ]);
  const s = await evidence.buildSnapshot();
  assert.deepEqual(s.platform.get("shop"), [3]);
  assert.deepEqual(s.platform.get("g2g"), [2]);
  assert.deepEqual(sorted(s.global), [2, 3]);
  assert.deepEqual(sorted(s.game.get("alpha")), [2, 3]);
});

test("evidenceFor keeps its shape on the new snapshot", async () => {
  await MarketplaceListing.collection.insertOne(
    listing({ marketplace: "eldorado", price: 1.5, units: [{ accountId: "a", orderId: "o", deliveredAt: recent }] }),
  );
  const ev = await evidence.evidenceFor({ game: "alpha", marketplace: "eldorado" });
  assert.deepEqual(Object.keys(ev).sort(), ["game", "global", "marketplace", "platform", "platformGame", "researchMedian", "rivalLowest"]);
  assert.deepEqual(ev.platform, [1.5]);
  assert.equal(ev.marketplace, "eldorado");
});
