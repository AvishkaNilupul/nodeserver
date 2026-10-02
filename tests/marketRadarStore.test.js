// The market radar's database half (utils/marketData/store.js) against a REAL Mongo, with the
// real captured rows. What must hold:
//   - idempotent: the same scan twice stores the same market once;
//   - a counter rise is one sale, once, even across a failure in the middle;
//   - sales are written BEFORE the counters move, so a crash can never lose a sale;
//   - the schemas accept everything the planner produces (bulkWrite does not validate);
//   - every read is projected and bounded, and the indexes (unique keys, TTLs) are really there.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MarketSale = require("../models/MarketSale");
const MarketRival = require("../models/MarketRival");
const MarketDataState = require("../models/MarketDataState");
const store = require("../utils/marketData/store");
const plan = require("../utils/marketData/plan");
const marvel = require("./fixtures/marketRadar/marvel-rivals.json");

const models = { MarketSale, MarketRival, MarketDataState };
let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("marketradarstore"));
  await Promise.all([MarketSale.init(), MarketRival.init(), MarketDataState.init()]);
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});
test.beforeEach(async () => {
  await Promise.all([MarketSale.deleteMany({}), MarketRival.deleteMany({}), MarketDataState.deleteMany({})]);
});

const H = 3600000;
const t = (h) => new Date(Date.UTC(2026, 9, 2, 0, 0, 0) + h * H);
const own0 = () => ({ gameflipOwner: "", ids: { ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } });
const jobOf = (over = {}) =>
  plan.buildJob(
    { game: "Marvel Rivals", gfSold: marvel.gfSold, gfActive: marvel.gfActive, gfActiveComplete: true, gg: marvel.gg, pl: marvel.pl, ...over },
    over.own || own0(),
    over.at || t(0),
  );
const distinct = (rows, market) => new Set(rows.map((r) => plan.idOf(market, r))).size;
const gg = (id, price, sold, over = {}) => ({ id, title: "Alpha Twitch Drops 3 items", price, url: "https://ggsel.net/en/catalog/product/x-" + id, seller: "g1", sellerName: "G", sold, rating: 4.9, ...over });
const gf = (id, price, over = {}) => ({ id, title: "Alpha Twitch Drops (3 Items) — X", price, url: "https://gameflip.com/item/" + id, seller: "s1", sellerName: "", onsale: "2026-09-30T00:00:00Z", created: "2026-09-30T00:00:00Z", updated: "2026-10-01T00:00:00Z", sellerScore: 0.9, sellerRatings: 100, ...over });

test("the first scan of a real game stores its sales and rivals; the identical scan again stores nothing new", async () => {
  const a = await store.applyJob(jobOf(), models);
  assert.strictEqual(a.salesInserted, marvel.gfSold.length);
  assert.strictEqual(await MarketSale.countDocuments({ market: "gameflip" }), marvel.gfSold.length);
  assert.strictEqual(await MarketRival.countDocuments({ market: "gameflip" }), distinct(marvel.gfActive, "gameflip"));
  assert.strictEqual(await MarketRival.countDocuments({ market: "ggsel" }), distinct(marvel.gg, "ggsel"));
  assert.strictEqual(await MarketRival.countDocuments({ market: "plati" }), distinct(marvel.pl, "plati"));
  const sales1 = await MarketSale.countDocuments({});
  const rivals1 = await MarketRival.countDocuments({});

  const b = await store.applyJob(jobOf({ at: t(1) }), models);
  assert.strictEqual(b.salesInserted, 0, "the same sold listings are not stored twice");
  assert.strictEqual(b.counterSales, 0, "unchanged counters are not sales");
  assert.strictEqual(await MarketSale.countDocuments({}), sales1);
  assert.strictEqual(await MarketRival.countDocuments({}), rivals1);
  const r = await MarketRival.findOne({ market: "ggsel" }).lean();
  assert.strictEqual(new Date(r.lastSeenAt).getTime(), t(1).getTime(), "lastSeenAt moves");
  assert.strictEqual(r.priceHistory.length, 1, "an unchanged price adds no history");
  assert.strictEqual(r.counterHistory.length, 1);
});

test("a GGSel counter rise between two scans is ONE sale of that many units, and re-running it adds nothing", async () => {
  await store.applyJob(jobOf({ gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 7), gg("11", 1, 0)] }), models);
  const rise = jobOf({ at: t(6), gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 10), gg("11", 1, 0)] });
  const out = await store.applyJob(rise, models);
  assert.strictEqual(out.counterSales, 1);
  assert.strictEqual(out.units, 3);
  const sales = await MarketSale.find({ market: "ggsel" }).lean();
  assert.strictEqual(sales.length, 1);
  assert.strictEqual(sales[0].units, 3);
  assert.strictEqual(sales[0].dedupeKey, "ggsel:10:10");
  assert.strictEqual(new Date(sales[0].prevObservedAt).getTime(), t(0).getTime());
  assert.strictEqual(new Date(sales[0].soldAt).getTime(), t(6).getTime());
  const rival = await MarketRival.findOne({ market: "ggsel", listingId: "10" }).lean();
  assert.strictEqual(rival.counter, 10);
  assert.deepStrictEqual(rival.counterHistory.map((p) => p.n), [7, 10]);
  // the same scan again, and a replay of the same job: still one sale
  await store.applyJob(jobOf({ at: t(7), gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 10), gg("11", 1, 0)] }), models);
  await store.applyJob(rise, models);
  assert.strictEqual(await MarketSale.countDocuments({ market: "ggsel" }), 1);
});

test("a failure writing the rivals cannot lose a sale or double it: sales are written first, the counter moves second", async () => {
  await store.applyJob(jobOf({ gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 7)] }), models);
  const rise = () => jobOf({ at: t(6), gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 10)] });
  const real = MarketRival.bulkWrite;
  MarketRival.bulkWrite = async () => {
    throw new Error("rival store down");
  };
  try {
    await assert.rejects(() => store.applyJob(rise(), models), /rival store down/);
  } finally {
    MarketRival.bulkWrite = real;
  }
  assert.strictEqual(await MarketSale.countDocuments({ market: "ggsel" }), 1, "the sale was recorded before the failure");
  assert.strictEqual((await MarketRival.findOne({ market: "ggsel", listingId: "10" }).lean()).counter, 7, "the baseline did NOT move");
  // the next scan finds the same rise again; the recorded sale is the baseline, so nothing is
  // counted twice, and the stored counter catches up
  await store.applyJob(rise(), models);
  assert.strictEqual(await MarketSale.countDocuments({ market: "ggsel" }), 1, "no double count");
  const doc = await MarketRival.findOne({ market: "ggsel", listingId: "10" }).lean();
  assert.strictEqual(doc.counter, 10);
  assert.strictEqual(doc.counterMax, 10);
});

test("the reviewer's case: 7 -> 10 (rival write fails) -> 11 records 4 units in all, not 7", async () => {
  await store.applyJob(jobOf({ gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 7)] }), models);
  const real = MarketRival.bulkWrite;
  MarketRival.bulkWrite = async () => {
    throw new Error("rival store down");
  };
  try {
    await assert.rejects(() => store.applyJob(jobOf({ at: t(6), gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 10)] }), models));
  } finally {
    MarketRival.bulkWrite = real;
  }
  await store.applyJob(jobOf({ at: t(12), gfSold: [], gfActive: [], pl: [], gg: [gg("10", 2.5, 11)] }), models);
  const sales = await MarketSale.find({ market: "ggsel", listingId: "10" }).sort({ counterAfter: 1 }).lean();
  assert.deepStrictEqual(sales.map((x) => [x.units, x.counterAfter]), [[3, 10], [1, 11]]);
  assert.strictEqual(sales.reduce((a, x) => a + x.units, 0), 4);
});

test("while our Gameflip owner id is unknown, Gameflip is NOT recorded (our own rows would be stored as rivals)", async () => {
  const own = { ...own0(), gameflipKnown: false };
  const out = await store.applyJob(jobOf({ own }), models);
  assert.strictEqual(out.gameflipSkipped, 1);
  assert.strictEqual(await MarketSale.countDocuments({ market: "gameflip" }), 0);
  assert.strictEqual(await MarketRival.countDocuments({ market: "gameflip" }), 0);
  assert.ok((await MarketRival.countDocuments({ market: "ggsel" })) > 0, "GGSel / Plati are recorded (their ownership is by listing id)");
});

test("a listing stored under another game is still updated when this game's page shows it — and keeps its game", async () => {
  await store.applyJob(plan.buildJob({ game: "Overwatch", gfSold: [], gfActive: [gf("shared", 2)], gfActiveComplete: true, gg: [], pl: [] }, own0(), t(0)), models);
  await store.applyJob(plan.buildJob({ game: "Overwatch 2", gfSold: [], gfActive: [gf("shared", 1.5), gf("other", 1)], gfActiveComplete: true, gg: [], pl: [] }, own0(), t(1)), models);
  const doc = await MarketRival.findOne({ listingId: "shared" }).lean();
  assert.strictEqual(new Date(doc.lastSeenAt).getTime(), t(1).getTime(), "seen again, not a dead row");
  assert.strictEqual(doc.priceUsd, 1.5);
  assert.strictEqual(doc.gameKey, "overwatch", "it stays with the game that first saw it");
  assert.strictEqual(doc.priceHistory.length, 2);
});

test("'new rival listings' counts what the database really inserted", async () => {
  const a = await store.applyJob(jobOf(), models);
  const inserted = await MarketRival.countDocuments({});
  assert.strictEqual(a.rivalsInserted, inserted);
  const b = await store.applyJob(jobOf({ at: t(1) }), models);
  assert.strictEqual(b.rivalsInserted, 0);
});

test("adopting a Gameflip owner id remembers it and corrects rows stored as rivals while it was unknown", async () => {
  // rows recorded without ownership knowledge (as an older version, or a lost owner id, could have)
  await store.applyJob(jobOf({ gg: [], pl: [], gfSold: [gf("s1", 2, { seller: "ME" })], gfActive: [gf("a1", 2, { seller: "ME" }), gf("a2", 2, { seller: "RIVAL" })] }), models);
  assert.strictEqual(await MarketSale.countDocuments({ ours: true }), 0);
  const fixed = await store.adoptGameflipOwner("ME", models);
  assert.deepStrictEqual(fixed, { fixedSales: 1, fixedRivals: 1 });
  assert.deepStrictEqual((await MarketDataState.findById("ownSellers").lean()).gameflip, ["ME"]);
  assert.strictEqual((await MarketRival.findOne({ listingId: "a2" }).lean()).ours, false, "a rival stays a rival");
  assert.deepStrictEqual(await store.adoptGameflipOwner("", models), { fixedSales: 0, fixedRivals: 0 });
});

test("Gameflip: the sold feed marks a rival we saw live as SOLD, with its time-to-sell", async () => {
  await store.applyJob(jobOf({ gfSold: [], gfActive: [gf("g1", 2), gf("g2", 2)], gg: [], pl: [], at: t(0) }), models);
  await store.applyJob(jobOf({ gfSold: [gf("g1", 2, { updated: "2026-10-02T03:00:00Z" })], gfActive: [gf("g2", 2)], gg: [], pl: [], at: t(4) }), models);
  const g1 = await MarketRival.findOne({ market: "gameflip", listingId: "g1" }).lean();
  assert.strictEqual(g1.outcome, "sold");
  assert.strictEqual(new Date(g1.goneAt).toISOString(), "2026-10-02T03:00:00.000Z");
  const g2 = await MarketRival.findOne({ market: "gameflip", listingId: "g2" }).lean();
  assert.strictEqual(g2.outcome, "");
  assert.strictEqual(g2.goneAt, null);
  const sale = await MarketSale.findOne({ dedupeKey: "gf:g1" }).lean();
  assert.strictEqual(sale.ttsHours, 51);
});

test("Gameflip: gone only after two COMPLETE scans without the listing, never on an incomplete page", async () => {
  await store.applyJob(jobOf({ gfSold: [], gfActive: [gf("g1", 2), gf("g2", 2)], gg: [], pl: [], at: t(0) }), models);
  const only2 = (at, complete) => jobOf({ gfSold: [], gfActive: [gf("g2", 2)], gfActiveComplete: complete, gg: [], pl: [], at });
  await store.applyJob(only2(t(1), false), models);
  assert.strictEqual((await MarketRival.findOne({ listingId: "g1" }).lean()).missed, 0, "a full page proves nothing");
  await store.applyJob(only2(t(2), true), models);
  let g1 = await MarketRival.findOne({ listingId: "g1" }).lean();
  assert.strictEqual(g1.missed, 1);
  assert.strictEqual(g1.goneAt, null);
  await store.applyJob(only2(t(3), true), models);
  g1 = await MarketRival.findOne({ listingId: "g1" }).lean();
  assert.strictEqual(g1.missed, 2);
  assert.strictEqual(new Date(g1.goneAt).getTime(), t(3).getTime());
  assert.strictEqual(g1.outcome, "", "gone is not sold");
  // and it comes back: cleared
  await store.applyJob(jobOf({ gfSold: [], gfActive: [gf("g1", 2), gf("g2", 2)], gg: [], pl: [], at: t(4) }), models);
  g1 = await MarketRival.findOne({ listingId: "g1" }).lean();
  assert.strictEqual(g1.goneAt, null);
  assert.strictEqual(g1.missed, 0);
});

test("interleaved complete scans of two games never mark each other's rivals gone", async () => {
  const a = (at) => jobOf({ game: "Marvel Rivals", gfSold: [], gfActive: [gf("m1", 2)], gg: [], pl: [], at });
  const b = (at) => plan.buildJob({ game: "Rocket League", gfSold: [], gfActive: [gf("r1", 2)], gfActiveComplete: true, gg: [], pl: [] }, own0(), at);
  for (let h = 0; h < 4; h++) {
    await store.applyJob(a(t(2 * h)), models);
    await store.applyJob(b(t(2 * h + 1)), models);
  }
  const docs = await MarketRival.find({ market: "gameflip" }).lean();
  assert.deepStrictEqual(docs.map((d) => [d.listingId, d.missed, d.goneAt]).sort(), [["m1", 0, null], ["r1", 0, null]]);
});

test("our seller id is learned from our own listings, persisted, and flags our OTHER offers next time", async () => {
  const own = own0();
  own.ids.ggsel.add("500");
  const first = await store.applyJob(jobOf({ own, gfSold: [], gfActive: [], pl: [], gg: [gg("500", 1, 0, { seller: "OURS" }), gg("501", 1, 0, { seller: "OURS" }), gg("502", 1, 0, { seller: "RIVAL" })] }), models);
  assert.deepStrictEqual(first.learned, { ggsel: ["OURS"] });
  assert.deepStrictEqual((await MarketDataState.findById("ownSellers").lean()).ggsel, ["OURS"]);
  let flags = Object.fromEntries((await MarketRival.find({ market: "ggsel" }).lean()).map((r) => [r.listingId, r.ours]));
  assert.deepStrictEqual(flags, { 500: true, 501: false, 502: false }, "501 is only recognised once the seller is known");
  own.sellers.ggsel.add("OURS");
  await store.applyJob(jobOf({ own, at: t(1), gfSold: [], gfActive: [], pl: [], gg: [gg("500", 1, 0, { seller: "OURS" }), gg("501", 1, 0, { seller: "OURS" }), gg("502", 1, 0, { seller: "RIVAL" })] }), models);
  flags = Object.fromEntries((await MarketRival.find({ market: "ggsel" }).lean()).map((r) => [r.listingId, r.ours]));
  assert.deepStrictEqual(flags, { 500: true, 501: true, 502: false });
  // learning twice does not duplicate the id
  await store.applyJob(jobOf({ own, at: t(2), gfSold: [], gfActive: [], pl: [], gg: [gg("500", 1, 0, { seller: "OURS" })] }), models);
  assert.deepStrictEqual((await MarketDataState.findById("ownSellers").lean()).ggsel, ["OURS"]);
});

test("everything the planner produces is accepted by the schemas (bulkWrite skips validation, so this is checked here)", () => {
  const j = jobOf();
  const sales = plan.planSold(j);
  const rp = ["gameflip", "ggsel", "plati"].map((m) => plan.planRivals(m, j));
  const counter = plan.planRivals("ggsel", j, new Map(marvel.gg.map((r) => [plan.idOf("ggsel", r), { listingId: plan.idOf("ggsel", r), priceUsd: r.price, counter: Math.max(0, (r.sold || 0) - 2), lastSeenAt: t(-6), missed: 0 }])));
  assert.ok(counter.sales.length > 0, "the fixture yields counter sales to validate");
  for (const s of [...sales, ...counter.sales]) {
    const err = new MarketSale(s).validateSync();
    assert.ok(!err, "MarketSale invalid: " + (err && err.message) + " " + JSON.stringify(s).slice(0, 120));
  }
  for (const p of rp) {
    for (const op of p.ops) {
      const doc = op.updateOne.update.$setOnInsert;
      if (!doc) continue;
      const err = new MarketRival(doc).validateSync();
      assert.ok(!err, "MarketRival invalid: " + (err && err.message));
    }
  }
});

test("a duplicate-key race is tolerated, any other write error is not", async () => {
  const dup = new Error("E11000 duplicate key");
  dup.code = 11000;
  assert.ok(store.onlyDuplicates(dup));
  const batch = new Error("bulk");
  batch.writeErrors = [{ code: 11000 }, { code: 11000 }];
  assert.ok(store.onlyDuplicates(batch));
  const mixed = new Error("bulk");
  mixed.writeErrors = [{ code: 11000 }, { code: 121 }];
  assert.ok(!store.onlyDuplicates(mixed));
  assert.ok(!store.onlyDuplicates(new Error("network")));
  const real = MarketSale.bulkWrite;
  MarketSale.bulkWrite = async () => {
    throw batch;
  };
  try {
    await store.applyJob(jobOf({ gfActive: [], gg: [], pl: [] }), models);
  } finally {
    MarketSale.bulkWrite = real;
  }
  MarketSale.bulkWrite = async () => {
    throw mixed;
  };
  try {
    await assert.rejects(() => store.applyJob(jobOf({ gfActive: [], gg: [], pl: [] }), models), /bulk/);
  } finally {
    MarketSale.bulkWrite = real;
  }
});

test("every read is projected and the existing-state reads are bounded", async () => {
  const seen = [];
  const wrap = (Model, name) => {
    const real = Model.find;
    Model.find = function (filter, projection) {
      const q = real.apply(this, arguments);
      seen.push({ name, filter, projection, q });
      return q;
    };
    return () => (Model.find = real);
  };
  const undo = [wrap(MarketSale, "sale"), wrap(MarketRival, "rival")];
  try {
    await store.applyJob(jobOf(), models);
  } finally {
    undo.forEach((u) => u());
  }
  assert.ok(seen.length >= 3, "the job read existing state");
  for (const s of seen) {
    assert.ok(s.projection && Object.keys(s.projection).length, s.name + " read is projected");
    if (s.name === "rival") assert.ok(s.q.options.limit > 0 && s.q.options.limit <= store.MAX_EXISTING, "rival read is bounded");
    assert.strictEqual(s.q.options.skip, undefined, "never skip()");
  }
  // The CODE (comments stripped: the header names the rule it keeps) never asks for disk or skips.
  for (const f of ["../utils/marketData/store.js", "../utils/marketData/index.js", "../utils/marketData/plan.js"]) {
    const code = require("fs").readFileSync(require.resolve(f), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/allowDiskUse/.test(code), f + ": no allowDiskUse");
    assert.ok(!/\.skip\(/.test(code), f + ": no skip()");
  }
});

test("the indexes are real: unique keys stop a duplicate, and the TTLs bound the collections", async () => {
  const sIdx = await MarketSale.collection.indexes();
  const rIdx = await MarketRival.collection.indexes();
  const find = (idx, key) => idx.find((i) => JSON.stringify(i.key) === JSON.stringify(key));
  assert.ok(find(sIdx, { dedupeKey: 1 }).unique, "sale dedupeKey is unique");
  assert.strictEqual(find(sIdx, { soldAt: 1 }).expireAfterSeconds, 400 * 86400);
  assert.ok(find(rIdx, { market: 1, listingId: 1 }).unique, "rival (market, listingId) is unique");
  assert.strictEqual(find(rIdx, { lastSeenAt: 1 }).expireAfterSeconds, 150 * 86400);
  assert.ok(find(rIdx, { gameKey: 1, market: 1, lastSeenAt: -1 }), "the per-game read has its index");
  await MarketSale.create(plan.planSold(jobOf({ gfActive: [], gg: [], pl: [] }))[0]);
  await assert.rejects(() => MarketSale.create(plan.planSold(jobOf({ gfActive: [], gg: [], pl: [] }))[0]), /duplicate key|E11000/);
});
