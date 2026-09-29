// Bulk packs (docs/bulk-packs/CONTRACT.md): a sold Gameflip pack is N accounts
// at the per-account price, one login each, flagged `bulk` so the discounted
// price never anchors single listings — while demand still counts N units.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SaleSignal = require("../models/SaleSignal");
const MarketplaceListing = require("../models/MarketplaceListing");
const { recordListingSale } = require("../utils/saleLearning");
const pricingEvidence = require("../utils/pricingEvidence");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulkPacksSaleSignal"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.beforeEach(async () => {
  await Promise.all([
    SaleSignal.deleteMany({}),
    MarketplaceListing.collection.deleteMany({}),
  ]);
});

const set = {
  _id: new mongoose.Types.ObjectId(),
  items: [{ game: "Rust" }],
};

async function row(extra) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    set: set._id,
    marketplace: "gameflip",
    externalId: "gf-" + Math.random().toString(36).slice(2),
    title: "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS",
    price: 11.25,
    status: "sold",
    origin: "manual",
    unitsSold: 0,
    ...extra,
  };
  await MarketplaceListing.collection.insertOne(doc);
  return doc;
}

test("a bulk pack sale writes N bulk units, one login each, at the per-account price", async () => {
  const logins = ["aa1", "bb2", "cc3", "dd4", "ee5"];
  const r = await row({
    bulkOfferId: new mongoose.Types.ObjectId(),
    accountLogin: logins.join(", "),
  });
  const written = await recordListingSale({
    listing: r,
    set,
    units: 5,
    priceUsd: 2.25,
    bulk: true,
    logins,
  });
  assert.equal(written, 5);
  const rows = await SaleSignal.find({}).sort({ dedupeKey: 1 }).lean();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((x) => x.login).sort(), logins);
  for (const x of rows) {
    assert.equal(x.bulk, true);
    assert.equal(x.priceUsd, 2.25);
    assert.equal(x.source, "listing_sold");
  }
});

test("an ordinary sale is unchanged: joined accountLogin, bulk false", async () => {
  const r = await row({ accountLogin: "solo1", price: 1.25 });
  await recordListingSale({ listing: r, set, units: 1, priceUsd: 1.25 });
  const rows = await SaleSignal.find({}).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login, "solo1");
  assert.equal(rows[0].bulk, false);
});

test("price evidence ignores bulk units but keeps ordinary sales", async () => {
  const bulkRow = await row({ bulkOfferId: new mongoose.Types.ObjectId() });
  await recordListingSale({
    listing: bulkRow,
    set,
    units: 3,
    priceUsd: 0.5,
    bulk: true,
    logins: ["x1", "x2", "x3"],
  });
  const single = await row({ accountLogin: "s1", price: 1.5 });
  await recordListingSale({ listing: single, set, units: 1, priceUsd: 1.5 });
  const snap = await pricingEvidence.buildSnapshot();
  const all = JSON.stringify(snap);
  // The 0.5 bulk unit price must appear nowhere in the evidence.
  assert.ok(!/(^|[^0-9.])0\.5([^0-9]|$)/.test(all), "bulk price leaked: " + all);
  assert.ok(all.includes("1.5"), "ordinary sale missing: " + all);
});
