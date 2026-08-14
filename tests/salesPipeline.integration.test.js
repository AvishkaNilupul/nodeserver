// Integration tests against a real MongoDB.
//
// Everything else in tests/ covers pure functions. These cover the parts that
// only exist as aggregation pipelines and Mongoose calls — code whose mistakes
// do not show up in linting, module loading, or unit tests, and would instead
// surface as a silently wrong demand score in production.
//
// The whole point of the sale-learning rework is that "we put stock on a shelf"
// stopped counting as "somebody bought it", so the tests that matter most are
// the ones asserting which signals reach the auto-farmer's demand number.
const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SaleSignal = require("../models/SaleSignal");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const DropSet = require("../models/DropSet");

const { recordListingSale } = require("../utils/saleLearning");
const { internalSalesForGame } = require("../utils/autoFarmer");
const research = require("../utils/marketResearch");

const DAY = 86400000;
let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("research-test"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  const c = mongoose.connection.collections;
  await Promise.all(Object.values(c).map((x) => x.deleteMany({})));
});

async function makeSet(games, name) {
  return DropSet.create({
    name: name || games.join(" + "),
    coverGame: games[0],
    items: games.map((g, i) => ({
      game: g,
      itemKey: "key-" + g.toLowerCase().replace(/\s/g, "") + "-" + i,
      name: g + " item " + i,
    })),
  });
}

async function makeListing(set, over) {
  return MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: "ext-" + Math.random().toString(36).slice(2),
    price: 5,
    status: "active",
    ...over,
  });
}

// ------------------------------------------------- recordListingSale

test("a sold listing writes one signal per game in the bundle", async () => {
  const set = await makeSet(["Overwatch 2", "Rainbow Six Siege"]);
  const listing = await makeListing(set);

  const written = await recordListingSale({ listing, set, units: 1 });
  assert.equal(written, 2);

  const rows = await SaleSignal.find({}).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.gameKey).sort(),
    ["overwatch 2", "rainbow six siege"],
  );
  for (const r of rows) {
    assert.equal(r.source, "listing_sold");
    assert.equal(r.marketplace, "gameflip");
    assert.equal(r.priceUsd, 5);
  }
});

test("a bundle sale is one sale per game, not one per drop", async () => {
  // The set carries three Overwatch drops. Writing per drop is what previously
  // let a single buyer pin a game at full allocation off one purchase.
  const set = await makeSet(["Overwatch 2", "Overwatch 2", "Overwatch 2"]);
  const listing = await makeListing(set);
  await recordListingSale({ listing, set, units: 1 });
  assert.equal(await SaleSignal.countDocuments({}), 1);
});

test("selling several units records several distinct sales", async () => {
  // Quantity listings (Plati/GGSel) sell repeatedly from one row, so the unit
  // sequence is what keeps each purchase distinct.
  const set = await makeSet(["Warframe"]);
  const listing = await makeListing(set, { marketplace: "digiseller" });

  await recordListingSale({ listing, set, units: 3 });
  assert.equal(await SaleSignal.countDocuments({}), 3);

  const fresh = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(fresh.unitsSold, 3);
});

test("later sales on the same listing do not collide with earlier ones", async () => {
  const set = await makeSet(["Warframe"]);
  const listing = await makeListing(set, { marketplace: "ggsel" });

  await recordListingSale({ listing, set, units: 2 });
  // Re-read: the caller's copy is stale after the $inc, which is exactly the
  // situation the guardian is in on its next pass.
  const again = await MarketplaceListing.findById(listing._id).lean();
  await recordListingSale({ listing: again, set, units: 2 });

  assert.equal(await SaleSignal.countDocuments({}), 4);
  const fresh = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(fresh.unitsSold, 4);
});

test("replaying the same pass cannot double-count", async () => {
  // Two overlapping guardian passes must not mint the same sale twice. The
  // atomic $inc hands each pass its own unit range.
  const set = await makeSet(["Lost Ark"]);
  const listing = await makeListing(set);

  const [a, b] = await Promise.all([
    recordListingSale({ listing, set, units: 1 }),
    recordListingSale({ listing, set, units: 1 }),
  ]);
  // Both wrote, but to different unit numbers — no dedupeKey collision.
  assert.equal(a + b, 2);
  const keys = (await SaleSignal.find({}).lean()).map((r) => r.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, "dedupeKeys must be unique");
});

test("a set with no games, or zero units, writes nothing", async () => {
  const set = await makeSet(["Warframe"]);
  const listing = await makeListing(set);
  assert.equal(await recordListingSale({ listing, set, units: 0 }), 0);
  assert.equal(
    await recordListingSale({ listing, set: { items: [] }, units: 1 }),
    0,
  );
  assert.equal(await SaleSignal.countDocuments({}), 0);
});

test("a listing deleted mid-pass is skipped rather than guessed at", async () => {
  const set = await makeSet(["Warframe"]);
  const listing = await makeListing(set);
  await MarketplaceListing.deleteOne({ _id: listing._id });
  assert.equal(await recordListingSale({ listing, set, units: 1 }), 0);
  assert.equal(await SaleSignal.countDocuments({}), 0);
});

// ------------------------------------------- internalSalesForGame

async function signal(over) {
  return SaleSignal.create({
    game: "Overwatch 2",
    gameKey: "overwatch 2",
    source: "connected",
    dedupeKey: "k-" + Math.random().toString(36).slice(2),
    at: new Date(),
    ...over,
  });
}

test("stock claims are NOT counted as demand", async () => {
  // The whole reason for this rework. reserveSetOnAccount stamps
  // "drop_reserved" every time stock is claimed for a shelf; counting it made
  // farming its own evidence of demand.
  for (let i = 0; i < 8; i++) {
    await signal({ source: "drop_reserved", account: new mongoose.Types.ObjectId() });
  }
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 0, "shelf-filling must not read as sales");
});

test("connection flips collapse per account, not per drop", async () => {
  // A 50-drop account that sells is ONE sale. "connected" writes a row per
  // drop, so without collapsing, one buyer would read as fifty.
  const acct = new mongoose.Types.ObjectId();
  for (let i = 0; i < 50; i++) {
    await signal({ source: "connected", account: acct });
  }
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 1);
});

test("anonymous unit sales each count, and do not collapse together", async () => {
  // Quantity listings do not know which account the buyer got, so `account` is
  // null. Grouping those by account would fold every unit sale on every
  // listing into a single "sale" — the bug the dedupeKey fallback prevents.
  for (let i = 0; i < 4; i++) {
    await signal({ source: "listing_sold", account: null, priceUsd: 3 });
  }
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 4);
  assert.equal(s.revenue, 12);
});

test("one sale seen twice is counted once", async () => {
  // A Gameflip sale, then the buyer connects the account: a listing_sold row
  // and connected rows for the same account. That is one purchase.
  const acct = new mongoose.Types.ObjectId();
  await signal({ source: "listing_sold", account: acct, priceUsd: 9 });
  await signal({ source: "connected", account: acct });
  await signal({ source: "connected", account: acct });
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 1);
  assert.equal(s.revenue, 9, "the priced row's value survives the collapse");
});

test("sales outside the 45-day window are ignored", async () => {
  await signal({ source: "listing_sold", account: null, at: new Date(Date.now() - 60 * DAY) });
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 0);
});

test("average price ignores sales with no known price", async () => {
  // A connection flip proves a sale but names no price. Dividing by it would
  // report the game as half price rather than as partly unpriced.
  await signal({ source: "listing_sold", account: null, priceUsd: 10 });
  await signal({ source: "listing_sold", account: null, priceUsd: 20 });
  await signal({ source: "connected", account: new mongoose.Types.ObjectId() });
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 3);
  assert.equal(s.revenue, 30);
  assert.equal(s.avgPrice, 15, "averaged over the 2 priced sales, not all 3");
});

test("a game with no signals reports an empty result, not a crash", async () => {
  const s = await internalSalesForGame("Some Game Nobody Sells");
  assert.deepEqual(s, { count: 0, revenue: 0, avgPrice: 0 });
});

test("game matching is case-insensitive", async () => {
  await signal({ source: "listing_sold", account: null, priceUsd: 4 });
  const s = await internalSalesForGame("OVERWATCH 2");
  assert.equal(s.count, 1);
});

// --------------------------------------------------- research rollups

test("ownStats splits our own sales per game and per marketplace", async () => {
  await signal({ source: "listing_sold", account: null, marketplace: "zeusx", priceUsd: 7 });
  await signal({ source: "listing_sold", account: null, marketplace: "zeusx", priceUsd: 3 });
  await signal({ source: "listing_sold", account: null, marketplace: "funpay", priceUsd: 5 });
  // Shelf-filling must not appear anywhere in the rollups either.
  await signal({ source: "drop_reserved", account: new mongoose.Types.ObjectId() });

  const own = await research.ownStats();
  assert.equal(own.salesBy["overwatch 2"].sales, 3);
  assert.equal(own.salesBy["overwatch 2"].revenue, 15);

  const byMarket = own.marketBy["overwatch 2"];
  assert.equal(byMarket.zeusx.sales, 2);
  assert.equal(byMarket.zeusx.revenue, 10);
  assert.equal(byMarket.funpay.sales, 1);
});

test("the per-market rollup is how unscoutable markets stay visible", async () => {
  // ZeusX publishes no keyword search; Z2U and EpicNPC sit behind bot
  // protection. Our own sales there are the only signal that can exist.
  await signal({ source: "listing_sold", account: null, marketplace: "z2u", priceUsd: 12 });
  const own = await research.ownStats();
  assert.equal(own.marketBy["overwatch 2"].z2u.revenue, 12);
});

// ------------------------------------------------------- history

async function snapshot(gameKey, daysAgo, over) {
  return MarketResearchSnapshot.create({
    game: gameKey,
    gameKey,
    at: new Date(Date.now() - daysAgo * DAY),
    demandScore: 50,
    lifetimeSold: 100,
    ...over,
  });
}

test("the comparison snapshot is the newest one before the window", async () => {
  await snapshot("warframe", 2, { demandScore: 99, lifetimeSold: 500 }); // inside window, ignored
  await snapshot("warframe", 8, { demandScore: 40, lifetimeSold: 200 }); // the one to use
  await snapshot("warframe", 15, { demandScore: 10, lifetimeSold: 100 });

  const prior = await research.priorSnapshots();
  assert.equal(prior.warframe.demandScore, 40);
  assert.equal(prior.warframe.lifetimeSold, 200);
  assert.ok(prior.warframe.days >= 7 && prior.warframe.days <= 21);
});

test("history older than the band is not considered", async () => {
  // The band keeps the query bounded so a growing archive cannot blow the
  // Atlas 100MB blocking-sort ceiling. A game whose only history predates it
  // reports nothing rather than an ancient comparison.
  await snapshot("lost ark", 90, { demandScore: 5 });
  const prior = await research.priorSnapshots();
  assert.equal(prior["lost ark"], undefined);
});

test("a game with no history at all is simply absent", async () => {
  const prior = await research.priorSnapshots();
  assert.deepEqual(prior, {});
});

// ------------------------------------------------------ scheduling

test("never-scanned games are scanned first", async () => {
  await MarketResearch.create({
    game: "Warframe",
    scannedAt: new Date(),
    demandScore: 80,
  });
  const due = await research.dueGames(["Warframe", "Brand New Game"], {}, false);
  assert.deepEqual(due, ["Brand New Game"], "fresh game not due; new one is");
});

test("a fresh game is not rescanned, a stale one is", async () => {
  await MarketResearch.create({
    game: "Fresh",
    scannedAt: new Date(Date.now() - 1 * 3600000),
    demandScore: 80,
  });
  await MarketResearch.create({
    game: "Stale",
    scannedAt: new Date(Date.now() - 40 * 3600000),
    demandScore: 80,
  });
  const camps = {
    fresh: { active: true, endAt: new Date(Date.now() + 300 * 3600000) },
    stale: { active: true, endAt: new Date(Date.now() + 300 * 3600000) },
  };
  const due = await research.dueGames(["Fresh", "Stale"], camps, false);
  assert.deepEqual(due, ["Stale"]);
});

test("the most overdue game relative to ITS OWN budget goes first", async () => {
  // An idle game 4 days stale is less overdue than an ending-soon campaign 6
  // hours stale, because their freshness budgets differ by an order of
  // magnitude. Sorting by raw age would get this backwards.
  await MarketResearch.create({
    game: "Idle",
    scannedAt: new Date(Date.now() - 4 * 24 * 3600000),
    demandScore: 0,
  });
  await MarketResearch.create({
    game: "Urgent",
    scannedAt: new Date(Date.now() - 12 * 3600000),
    demandScore: 80,
  });
  const camps = {
    urgent: { active: true, endAt: new Date(Date.now() + 10 * 3600000) },
  };
  const due = await research.dueGames(["Idle", "Urgent"], camps, false);
  assert.equal(due[0], "Urgent", "got " + JSON.stringify(due));
});

test("a forced scan takes every game, uncapped", async () => {
  // The operator pressing "Scan now" asked for a full refresh; quietly doing a
  // subset would be a worse answer than a slow one.
  const many = Array.from({ length: 150 }, (_, i) => "Game " + i);
  const due = await research.dueGames(many, {}, true);
  assert.equal(due.length, 150);
});

// ------------------------------------------------- funpay node map

test("funpay nodes are learned from our own listings", async () => {
  // FunPay has no cross-game search, so a game is invisible there until its
  // category node is known — and every listing we publish already records one.
  const set = await makeSet(["Overwatch 2"]);
  await makeListing(set, { marketplace: "funpay", externalNode: "2430" });
  const map = await research.funpayNodeMap();
  assert.equal(map["overwatch 2"], "2430");
});

test("listings with no recorded node are ignored", async () => {
  const set = await makeSet(["Lost Ark"]);
  await makeListing(set, { marketplace: "funpay", externalNode: "" });
  const map = await research.funpayNodeMap();
  assert.equal(map["lost ark"], undefined);
});

// -------------------------------------------------- recommendation

test("trend changes the advice, and noise does not", async () => {
  const base = { demandScore: 45, campaign: { active: true }, farmedAccounts: 0 };
  assert.equal(research.recommend({ ...base, demandTrend: null }), "Start farming");
  assert.equal(research.recommend({ ...base, demandTrend: 3 }), "Start farming");
  assert.equal(
    research.recommend({ ...base, demandTrend: 20 }),
    "Start farming (rising)",
  );
  assert.equal(
    research.recommend({ ...base, demandTrend: -20 }),
    "Start farming (falling)",
  );
});

test("a low but sharply rising game is flagged rather than dismissed", async () => {
  const r = research.recommend({
    demandScore: 8,
    campaign: { active: true },
    demandTrend: 15,
  });
  assert.equal(r, "Low demand but rising — watch");
});

// ------------------------------------ stock claim vs. real purchase

// reserveSetOnAccount serves two callers that mean opposite things: a Shop or
// bulk order (a buyer paid) and a fulfiller claiming stock for a shelf (nobody
// has bought anything). It writes the training signal for both, so the flag
// that tells them apart is the single most load-bearing line in the rework.
const DropLog = require("../models/DropLog");
const { reserveSetOnAccount } = require("../utils/dropReservation");

async function stockedAccount(set) {
  const account = new mongoose.Types.ObjectId();
  for (const item of set.items) {
    await DropLog.create({
      account,
      accountModel: "BotAccount",
      itemKey: item.itemKey,
      game: item.game,
      name: item.name,
      benefitId: "b-" + item.itemKey,
      connected: false,
      soldAt: null,
    });
  }
  return account;
}

test("a fulfiller claiming stock is NOT recorded as a sale", async () => {
  const set = await makeSet(["Overwatch 2"]);
  const account = await stockedAccount(set);

  const ok = await reserveSetOnAccount(account, set, {
    soldToUsername: "digiseller",
    soldSetId: String(set._id),
  });
  assert.equal(ok, true, "the reservation itself must still work");

  const rows = await SaleSignal.find({}).lean();
  assert.equal(rows.length, 1, "the audit trail row is still written");
  assert.equal(rows[0].source, "drop_reserved");

  // And the thing that actually matters: it does not reach demand.
  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 0);
});

test("a Shop order IS recorded as a sale", async () => {
  const set = await makeSet(["Overwatch 2"]);
  const account = await stockedAccount(set);

  await reserveSetOnAccount(account, set, {
    soldToUsername: "somebuyer",
    soldSetId: String(set._id),
    realSale: true,
    marketplace: "shop",
    priceUsd: 6,
  });

  const rows = await SaleSignal.find({}).lean();
  assert.equal(rows[0].source, "listing_sold");
  assert.equal(rows[0].marketplace, "shop");

  const s = await internalSalesForGame("Overwatch 2");
  assert.equal(s.count, 1);
  assert.equal(s.revenue, 6);
});

test("a bundle order counts once per game, not once per drop", async () => {
  const set = await makeSet(["Overwatch 2", "Overwatch 2", "Warframe"]);
  const account = await stockedAccount(set);

  await reserveSetOnAccount(account, set, {
    soldToUsername: "bulk:1001",
    realSale: true,
    marketplace: "bulk",
  });

  assert.equal(await SaleSignal.countDocuments({}), 2, "two games, two rows");
  assert.equal((await internalSalesForGame("Overwatch 2")).count, 1);
  assert.equal((await internalSalesForGame("Warframe")).count, 1);
});
