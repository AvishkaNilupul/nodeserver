// Bulk packs — the proposal engine (utils/bulkPacks/proposals.js,
// docs/bulk-packs/MODULES.md §proposals.js, API-UI.md Tests A7).
//
// Real DropSet / BulkOffer / MarketplaceListing models on an in-memory Mongo;
// the sibling modules (pricing, stock, farmCapacity, markets) and the shop's
// stockForSets are FAKES that follow the frozen contract, so these tests pin
// proposals.js alone. The real config.js supplies slotKey / isMarketAllowed /
// the delivery gate, with its settings dependency faked — nothing here reads
// the real utils/settings.json (a tripwire below fails the run if it does).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const DropSet = require("../models/DropSet");
const BulkOffer = require("../models/BulkOffer");
const MarketplaceListing = require("../models/MarketplaceListing");
const config = require("../utils/bulkPacks/config");
const proposals = require("../utils/bulkPacks/proposals");

const CACHE_MS = 5 * 60 * 1000;
const REAL_SETTINGS_FILE = path.join(__dirname, "..", "utils", "settings.json");

// ---------------------------------------------------------------------------
// The world the fakes read from (reset by seed()).
// ---------------------------------------------------------------------------
const world = {};
function resetWorld() {
  Object.assign(world, {
    bp: {
      enabled: true,
      markets: ["eldorado", "g2g", "gameflip"],
      tiers: [
        { minQty: 5, discountPct: 5 },
        { minQty: 10, discountPct: 10 },
      ],
      reserveSingles: 5,
      unitsPerOffer: 20,
      farmPrices: {
        eldorado: { 120: 3, 180: 4, 365: 7 },
        g2g: { 120: 3, 180: 4, 365: 7 },
      },
      farmDurations: [120, 180, 365],
      farmReserveSlots: 20,
      farmReservePristine: 20,
      farmMaxQty: 20,
      loopMinutes: 5,
      farmSyncMinutes: 15,
    },
    af: {
      eldoradoAutoDeliver: true,
      eldoradoDeliverDryRun: false,
      g2gAutoDeliver: true,
      g2gDeliverDryRun: false,
    },
    noclaimShop: { enabled: true, autoDeliver: true },
    upper: {},
    free: {},
    noclaim: {},
    noclaimThrows: new Set(),
    capacity: {
      bestStackRoom: 8,
      totalFree: 60,
      pristine: 80,
      at: null,
      error: "",
    },
    demand: [],
    hold: null,
    clock: 1_700_000_000_000,
    calls: {
      stockForSets: [],
      dropsetFreeCounts: [],
      noclaimCounts: [],
      read: [],
      demand: [],
      shareFor: [],
      packPriceFor: [],
      getAutoFarm: 0,
    },
  });
}
resetWorld();

// ---------------------------------------------------------------------------
// Fakes (contract shapes, MODULES.md)
// ---------------------------------------------------------------------------
const fakeSettings = {
  getBulkPacks: () => world.bp,
  getAutoFarm: () => {
    world.calls.getAutoFarm += 1;
    return world.af;
  },
  getNoclaimShopSettings: () => world.noclaimShop,
  // The shipped noClaimGames keywords, matched as a substring.
  isNoClaimGame: (g) =>
    /overwatch|rainbow six|call of duty/i.test(String(g || "")),
};

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
const roundQuarter = (x) => Math.round(x * 4) / 4;

// PACKS-2 §3 pricing.packPriceFor({anchor, discountPct, size, market}): the
// WHOLE pack — size × anchor less the discount (0..60%), Gameflip on the $0.25
// grid, Eldorado/G2G to the cent, never below the market floor (per LISTING).
// utils/bulkPacks/pricing.js gains it in the same change (owner P2): once it
// exports it the real function runs here, else the contract's formula below.
const realPricing = require("../utils/bulkPacks/pricing");
function contractPackPriceFor({ anchor, discountPct, size, market } = {}) {
  const a = Number(anchor);
  const n = Number(size);
  if (!(a > 0) || !Number.isInteger(n) || n < 1) return 0;
  if (!Object.prototype.hasOwnProperty.call(config.MARKET_FLOORS, market))
    return 0;
  const d = Math.min(60, Math.max(0, Number(discountPct) || 0));
  const raw = n * a * (1 - d / 100);
  return Math.max(
    config.MARKET_FLOORS[market],
    market === "gameflip" ? roundQuarter(raw) : round2(raw),
  );
}
const packPriceFor =
  typeof realPricing.packPriceFor === "function"
    ? realPricing.packPriceFor
    : contractPackPriceFor;

const fakePricing = {
  // MODULES §pricing.pickAnchor
  pickAnchor({ rows, set, market }) {
    const cands = (rows || []).filter(
      (r) =>
        r.marketplace === market &&
        r.status === "active" &&
        !r.bulkOfferId &&
        String(r.set) === String(set._id) &&
        r.price > 0,
    );
    let anchor = 0;
    let basis = "none";
    let listingId = "";
    if (cands.length) {
      const low = cands.reduce((a, b) => (b.price < a.price ? b : a));
      anchor = low.price;
      basis = "listing";
      listingId = String(low._id);
    } else if (Number(set.price) > 0) {
      anchor = Number(set.price);
      basis = "set";
    }
    if (anchor > 0) anchor = Math.max(anchor, Number(set.minPriceUsd) || 0);
    return { anchor, basis, listingId };
  },
  // MODULES §pricing.tierQuote (packPrice only for gameflip)
  tierQuote({ anchor, market, tiers }) {
    return tiers.map((t) => ({
      minQty: t.minQty,
      discountPct: t.discountPct,
      unitPrice:
        anchor > 0
          ? Math.max(
              config.MARKET_FLOORS[market],
              round2(anchor * (1 - t.discountPct / 100)),
            )
          : 0,
      packPrice:
        market === "gameflip" && anchor > 0
          ? Math.max(
              0.75,
              roundQuarter(t.minQty * anchor * (1 - t.discountPct / 100)),
            )
          : 0,
    }));
  },
  farmUnitPrice({ farmPrices, market, days, discountPct }) {
    const anchor = Number(farmPrices?.[market]?.[String(days)]);
    return anchor > 0
      ? Math.max(
          config.MARKET_FLOORS[market],
          round2(anchor * (1 - discountPct / 100)),
        )
      : 0;
  },
  packPriceFor(args) {
    world.calls.packPriceFor.push({ ...args });
    return packPriceFor(args);
  },
};

const fakeStock = {
  async dropsetFreeCounts(sets, opts = {}) {
    world.calls.dropsetFreeCounts.push({
      names: sets.map((s) => s.name),
      limit: opts.limit,
    });
    return new Map(sets.map((s) => [String(s._id), world.free[s.name] ?? 0]));
  },
  async noclaimCounts(set) {
    world.calls.noclaimCounts.push(set.name);
    if (world.noclaimThrows.has(set.name))
      throw new Error("holdings snapshot unavailable");
    return (
      world.noclaim[set.name] || { free: 0, share: { eldorado: 0, g2g: 0 } }
    );
  },
};

const fakeShopRoutes = {
  async stockForSets(sets) {
    world.calls.stockForSets.push(sets.map((s) => s.name));
    if (world.hold) await world.hold;
    return new Map(
      sets.map((s) => [
        String(s._id),
        { stock: world.upper[s.name] ?? 0, topItems: [] },
      ]),
    );
  },
};

// The auto-lister's set -> game rule (cover game, else the first item's game).
const fakeMarkets = {
  gameOfSet: (set) =>
    set.coverGame || (set.items && set.items[0] && set.items[0].game) || "",
};

const fakeFarmCapacity = {
  async read(opts = {}) {
    world.calls.read.push(opts);
    return { ...world.capacity };
  },
  // MODULES §farmCapacity.advertisable
  advertisable(cap, bp) {
    return cap.error
      ? 0
      : Math.max(
          0,
          Math.floor(
            Math.min(
              bp.farmMaxQty,
              cap.bestStackRoom,
              cap.totalFree - bp.farmReserveSlots,
              cap.pristine - bp.farmReservePristine,
            ),
          ),
        );
  },
  async demand(opts) {
    world.calls.demand.push(opts);
    return world.demand.map((d) => ({
      ...d,
      markets: { ...(d.markets || {}) },
    }));
  },
  // FIXES-1 S1 farmCapacity.shareFor: an equal split of `available`,
  // floor(available / n) each and the remainder one apiece to the
  // lowest-sorting ids; selfId always counts as a sharer.
  shareFor(selfId, ids, available) {
    world.calls.shareFor.push([String(selfId), [...ids], available]);
    const list = [...new Set([...ids.map(String), String(selfId)])].sort();
    const n = list.length;
    const rank = list.indexOf(String(selfId));
    return Math.floor(available / n) + (rank < available % n ? 1 : 0);
  },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let mongod;
const realReadFileSync = fs.readFileSync;
// settings.loadSettings() swallows read errors, so a throw alone would pass
// unnoticed: the tripwire counts, and the last test asserts the count is 0.
let settingsFileReads = 0;
// proposals.js logs a skipped set with console.warn: captured, not printed.
const realWarn = console.warn;
const warnings = [];

test.before(async () => {
  console.warn = (...args) => warnings.push(args.join(" "));
  // Tripwire: the real settings store must never be read by these tests.
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === "string" && path.resolve(file) === REAL_SETTINGS_FILE) {
      settingsFileReads += 1;
      throw new Error("test touched the real utils/settings.json");
    }
    return realReadFileSync.call(this, file, ...rest);
  };
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-proposals-test"));
  config.__setDeps({ settings: fakeSettings });
  proposals.__setDeps({
    settings: fakeSettings,
    pricing: fakePricing,
    stock: fakeStock,
    shopRoutes: fakeShopRoutes,
    markets: fakeMarkets,
    farmCapacity: fakeFarmCapacity,
    now: () => world.clock,
  });
});

test.after(async () => {
  proposals.__resetDeps();
  config.__resetDeps();
  fs.readFileSync = realReadFileSync;
  console.warn = realWarn;
  await mongoose.disconnect();
  await mongod.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const item = (name, game, image = "", qty = 1) => ({
  itemKey: (name + "|" + game).toLowerCase(),
  name,
  game,
  image,
  qty,
});

function offerDoc({
  source,
  market,
  set,
  game = "",
  days = 0,
  minQty,
  state = "live",
}) {
  const kind = config.KIND_OF_SOURCE[source];
  return {
    kind,
    source,
    market,
    set: set ? set._id : null,
    setName: set ? set.name : "",
    game,
    days,
    minQty,
    state,
    slotKey: config.slotKey({
      kind,
      source,
      setId: set ? String(set._id) : "",
      game,
      days,
      market,
      minQty,
    }),
  };
}

// Sets are created one by one, so _id order = creation order and the newest
// set is the last one made.
async function seed() {
  resetWorld();
  proposals.invalidate();
  await Promise.all([
    DropSet.deleteMany({}),
    BulkOffer.deleteMany({}),
    MarketplaceListing.collection.deleteMany({}),
  ]);
  const S = {};
  const mk = async (key, doc) => {
    S[key] = await DropSet.create(doc);
    return S[key];
  };
  // H is the OLDEST set: little stock, but an open (paused) offer on it.
  await mk("H", {
    name: "Fortnite live bundle",
    items: [item("Glider", "Fortnite")],
    price: 2,
  });
  await mk("A", {
    name: "Rust bundle",
    items: [
      item("AK skin", "Rust", "https://img/ak.png"),
      item("Door", "Rust", "", 2),
    ],
    price: 3,
  });
  await mk("B", {
    name: "Apex bundle",
    items: [item("Charm", "Apex Legends", "https://img/charm.png")],
    price: 2,
  });
  await mk("C", {
    name: "Small Rust bundle",
    items: [item("Hat", "Rust")],
    price: 1,
  });
  // Claimed drops of no-claim games: never a dropset proposal.
  await mk("D", {
    name: "Overwatch claimed",
    items: [item("Spray", "Overwatch 2")],
    price: 5,
  });
  await mk("D2", {
    name: "Mixed bundle",
    items: [item("Axe", "Rust"), item("Camo", "Call of Duty: Warzone")],
    price: 5,
  });
  // No-claim sets (stockSource "noclaim").
  await mk("E", {
    name: "OW no-claim",
    stockSource: "noclaim",
    coverGame: "Overwatch 2",
    items: [item("Legendary skin", "Overwatch 2", "https://img/ow.png")],
    price: 4,
  });
  await mk("E2", {
    name: "R6 no-claim",
    stockSource: "noclaim",
    items: [item("Charm", "Rainbow Six Siege")],
    price: 4,
  });
  // Never candidates at all.
  await mk("F", {
    name: "Custom promo",
    custom: true,
    items: [item("Promo", "Rust")],
    price: 9,
  });
  await mk("G", { name: "Empty set", items: [], price: 9 });

  Object.assign(world.upper, {
    "Fortnite live bundle": 2,
    "Rust bundle": 20,
    "Apex bundle": 30,
    "Small Rust bundle": 6,
    "Overwatch claimed": 50,
    "Mixed bundle": 50,
    "Custom promo": 50,
    "Empty set": 50,
  });
  Object.assign(world.free, {
    "Fortnite live bundle": 1,
    "Rust bundle": 12,
    "Apex bundle": 25,
    "Small Rust bundle": 6,
  });
  world.noclaim["OW no-claim"] = { free: 9, share: { eldorado: 6, g2g: 3 } };
  world.noclaimThrows.add("R6 no-claim");

  const row = (set, marketplace, price, extra = {}) => ({
    set: set._id,
    marketplace,
    externalId: "x-" + Math.random().toString(36).slice(2),
    title: set.name,
    price,
    status: "active",
    origin: "auto",
    bulkOfferId: null,
    ...extra,
  });
  await MarketplaceListing.collection.insertMany([
    row(S.A, "eldorado", 2.0),
    row(S.A, "eldorado", 2.5),
    // A bulk row, a sold row and a delisted row are never price anchors.
    row(S.A, "eldorado", 1.0, {
      origin: "manual",
      bulkOfferId: new mongoose.Types.ObjectId(),
    }),
    row(S.A, "eldorado", 0.5, { status: "sold" }),
    row(S.A, "g2g", 1.2, { status: "delisted" }),
    row(S.B, "g2g", 1.6),
    row(S.E, "eldorado", 3.0, { origin: "manual", noclaimStock: true }),
  ]);

  const O = {};
  O.liveA = await BulkOffer.create(
    offerDoc({ source: "dropset", market: "eldorado", set: S.A, minQty: 5 }),
  );
  O.closedA = await BulkOffer.create(
    offerDoc({
      source: "dropset",
      market: "g2g",
      set: S.A,
      minQty: 5,
      state: "sold_out",
    }),
  );
  O.liveH = await BulkOffer.create(
    offerDoc({
      source: "dropset",
      market: "eldorado",
      set: S.H,
      minQty: 10,
      state: "paused",
    }),
  );
  O.liveFarm = await BulkOffer.create(
    offerDoc({
      source: "farm",
      market: "g2g",
      game: "Rust",
      days: 180,
      minQty: 10,
    }),
  );
  O.liveFarmOld = await BulkOffer.create(
    offerDoc({
      source: "farm",
      market: "eldorado",
      game: "Valorant",
      days: 365,
      minQty: 5,
    }),
  );

  world.demand = [
    {
      game: "Rust",
      days: 180,
      orders: 9,
      accounts: 40,
      markets: { eldorado: 6, g2g: 3 },
    },
    // 90 days is not a configured farming term.
    {
      game: "Apex Legends",
      days: 90,
      orders: 20,
      accounts: 20,
      markets: { eldorado: 20 },
    },
    {
      game: "Fortnite",
      days: 365,
      orders: 4,
      accounts: 8,
      markets: { g2g: 4 },
    },
  ];
  return { S, O };
}

const byName = (res, name) => res.items.find((i) => i.set.name === name);
const marketOf = (it, market) => it.markets.find((m) => m.market === market);
const tierOf = (it, market, minQty) =>
  marketOf(it, market).tiers.find((t) => t.minQty === minQty);
const sorted = (a) => [...a].sort();
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// accountProposals
// ---------------------------------------------------------------------------

test("tier fit rules: dropset surplus over the singles reserve, no-claim market share", async () => {
  const { S } = await seed();
  const res = await proposals.accountProposals();
  assert.ok(res.at instanceof Date);

  // Apex: 25 free, 5 kept for singles -> surplus 20: every tier fits
  // everywhere — 4 packs of 5, or 2 packs of 10 (PACKS-2 §4).
  const B = byName(res, "Apex bundle");
  assert.equal(B.source, "dropset");
  assert.deepEqual([B.free, B.reserve, B.surplus], [25, 5, 20]);
  assert.deepEqual(
    B.markets.map((m) => m.market),
    ["eldorado", "g2g", "gameflip"],
  );
  for (const m of B.markets) {
    assert.ok(
      m.tiers.every((t) => t.fits),
      m.market,
    );
    assert.deepEqual(
      m.tiers.map((t) => [t.minQty, t.packsAvailable]),
      [
        [5, 4],
        [10, 2],
      ],
      m.market,
    );
  }

  // Rust: 12 free -> surplus 7: one pack of 5 fits (the 2 extra accounts
  // make no pack), a pack of 10 does not.
  const A = byName(res, "Rust bundle");
  assert.deepEqual([A.free, A.reserve, A.surplus], [12, 5, 7]);
  for (const m of A.markets) {
    const five = m.tiers.find((t) => t.minQty === 5);
    const ten = m.tiers.find((t) => t.minQty === 10);
    assert.deepEqual([five.fits, five.packsAvailable], [true, 1], m.market);
    assert.deepEqual([ten.fits, ten.packsAvailable], [false, 0], m.market);
  }

  // No-claim: surplus = free (no singles reserve), a pack fits by the
  // market's share of the shelf, and Gameflip is not a no-claim market.
  const E = byName(res, "OW no-claim");
  assert.equal(E.source, "noclaim");
  assert.deepEqual([E.free, E.reserve, E.surplus], [9, 0, 9]);
  assert.deepEqual(
    E.markets.map((m) => m.market),
    ["eldorado", "g2g"],
  );
  assert.equal(tierOf(E, "eldorado", 5).fits, true); // share 6
  assert.equal(tierOf(E, "eldorado", 5).packsAvailable, 1);
  assert.equal(tierOf(E, "eldorado", 10).fits, false);
  assert.equal(tierOf(E, "eldorado", 10).packsAvailable, 0);
  assert.equal(tierOf(E, "g2g", 5).fits, false); // share 3
  assert.equal(tierOf(E, "g2g", 5).packsAvailable, 0);
  assert.equal(E.set.game, "Overwatch 2");

  // Small Rust: upper bound 6 - 5 reserve can never fit a 5+ tier, so it is
  // not even counted precisely, and it is not proposed.
  assert.equal(byName(res, "Small Rust bundle"), undefined);
  const counted = world.calls.dropsetFreeCounts;
  assert.equal(counted.length, 1);
  assert.ok(!counted[0].names.includes("Small Rust bundle"));
  assert.deepEqual(
    sorted(counted[0].names),
    sorted(["Rust bundle", "Fortnite live bundle", "Apex bundle"]),
  );
  assert.equal(counted[0].limit, 3);

  // Sorted by surplus, most first (a live offer with no surplus sorts last).
  assert.deepEqual(
    res.items.map((i) => i.set.name),
    ["Apex bundle", "OW no-claim", "Rust bundle", "Fortnite live bundle"],
  );

  // The contract's item shape, exactly.
  assert.deepEqual(Object.keys(A).sort(), [
    "free",
    "markets",
    "reserve",
    "set",
    "source",
    "surplus",
  ]);
  assert.deepEqual(A.set, {
    id: String(S.A._id),
    name: "Rust bundle",
    game: "Rust",
    items: [
      { name: "AK skin", image: "https://img/ak.png", qty: 1 },
      { name: "Door", image: "", qty: 2 },
    ],
    image: "https://img/ak.png",
  });
  const m = marketOf(A, "eldorado");
  assert.deepEqual(Object.keys(m).sort(), [
    "anchor",
    "basis",
    "gate",
    "market",
    "tiers",
  ]);
  assert.deepEqual(Object.keys(m.gate).sort(), ["ok", "reason"]);
  assert.deepEqual(Object.keys(m.tiers[0]).sort(), [
    "discountPct",
    "fits",
    "liveOfferId",
    "minQty",
    "packPrice",
    "packsAvailable",
    "priced",
    "unitPrice",
  ]);
});

test("PACKS-2 §4 prices: every market lists ONE pack at its pack price (packPriceFor) with the per-account equivalent; the anchor is the lowest active non-bulk row, else the set price", async () => {
  await seed();
  const res = await proposals.accountProposals();
  const A = byName(res, "Rust bundle");
  const quote = (m) =>
    m.tiers.map((t) => [t.minQty, t.discountPct, t.packPrice, t.unitPrice]);
  // Eldorado: rows at 2.0 and 2.5; the 1.0 bulk row and the 0.5 sold row are
  // ignored. Pack of 5 at 5% off: 5 × 2 × 0.95 = $9.50 ($1.90 each).
  const el = marketOf(A, "eldorado");
  assert.equal(el.anchor, 2);
  assert.equal(el.basis, "listing");
  assert.deepEqual(quote(el), [
    [5, 5, 9.5, 1.9],
    [10, 10, 18, 1.8],
  ]);
  // G2G: only a delisted row -> the set's own price, priced per pack too.
  const g2g = marketOf(A, "g2g");
  assert.equal(g2g.anchor, 3);
  assert.equal(g2g.basis, "set");
  assert.deepEqual(quote(g2g), [
    [5, 5, 14.25, 2.85],
    [10, 10, 27, 2.7],
  ]);
  // Gameflip: one listing = one pack of exactly minQty accounts, on the
  // $0.25 grid.
  const gf = marketOf(A, "gameflip");
  assert.deepEqual(quote(gf), [
    [5, 5, 14.25, 2.85],
    [10, 10, 27, 2.7],
  ]);
  for (const m of A.markets)
    assert.ok(
      m.tiers.every((t) => t.priced),
      m.market,
    );
  // Every price came from packPriceFor, with the tier as the pack size.
  assert.ok(
    world.calls.packPriceFor.some(
      (c) =>
        c.market === "g2g" &&
        c.size === 10 &&
        c.anchor === 3 &&
        c.discountPct === 10,
    ),
  );
  // Apex G2G has its own listing row.
  const B = byName(res, "Apex bundle");
  assert.equal(marketOf(B, "g2g").anchor, 1.6);
  assert.equal(marketOf(B, "g2g").basis, "listing");
  assert.deepEqual(quote(marketOf(B, "g2g")), [
    [5, 5, 7.6, 1.52],
    [10, 10, 14.4, 1.44],
  ]);
  assert.equal(marketOf(B, "eldorado").basis, "set");
  // Gameflip rounds the whole pack to a quarter: 5 × 2 × 0.95 = 9.50.
  assert.deepEqual(quote(marketOf(B, "gameflip"))[0], [5, 5, 9.5, 1.9]);
});

test("PACKS-2 §4 G2G's $1 floor is per PACK: a cheap bundle keeps its discount (the old per-account floor ate it)", async () => {
  await seed();
  const cheap = await DropSet.create({
    name: "Cheap Rust bundle",
    items: [item("Twig", "Rust")],
    price: 0.8,
  });
  const tiny = await DropSet.create({
    name: "Tiny Rust bundle",
    items: [item("Pebble", "Rust")],
    price: 0.15,
  });
  for (const s of [cheap, tiny]) {
    world.upper[s.name] = 30;
    world.free[s.name] = 30;
  }
  proposals.invalidate();
  const res = await proposals.accountProposals({ refresh: true });
  // $0.80 single: per account $0.76 / $0.72 — below G2G's $1, which used to
  // clamp both tiers to $1.00 each (no discount at all). Per pack it is
  // $3.80 / $7.20, well above the $1 listing floor.
  const g2g = marketOf(byName(res, "Cheap Rust bundle"), "g2g");
  assert.deepEqual(
    g2g.tiers.map((t) => [t.minQty, t.packPrice, t.unitPrice, t.fits]),
    [
      [5, 3.8, 0.76, true],
      [10, 7.2, 0.72, true],
    ],
  );
  // $0.15 single: a pack of 5 at 5% off is $0.71 — lifted to the $1 floor
  // of the LISTING ($0.20 each), never to $1 per account.
  const low = marketOf(byName(res, "Tiny Rust bundle"), "g2g");
  assert.deepEqual(low.tiers[0].packPrice, 1);
  assert.deepEqual(low.tiers[0].unitPrice, 0.2);
  // 10 × 0.15 × 0.9 = 1.35: above the floor, priced as is.
  assert.deepEqual(low.tiers[1].packPrice, 1.35);
  // Eldorado's floor is $0.50 per listing: 5 × 0.15 × 0.95 = 0.7125 -> $0.71.
  const el = marketOf(byName(res, "Tiny Rust bundle"), "eldorado");
  assert.deepEqual(el.tiers[0].packPrice, 0.71);
  // Gameflip: 0.7125 on the quarter grid is $0.75 — its own floor.
  const gf = marketOf(byName(res, "Tiny Rust bundle"), "gameflip");
  assert.deepEqual(gf.tiers[0].packPrice, 0.75);
});

test("proposals refuse to guess without pricing.packPriceFor (PACKS-2 §3)", async () => {
  await seed();
  const { packPriceFor: _drop, ...noPack } = fakePricing;
  proposals.__setDeps({ pricing: noPack });
  try {
    await assert.rejects(proposals.accountProposals(), /packPriceFor/);
    await assert.rejects(proposals.farmProposals(), /packPriceFor/);
    assert.equal(world.calls.stockForSets.length, 0, "failed before any read");
  } finally {
    proposals.__setDeps({ pricing: fakePricing });
  }
  assert.ok((await proposals.accountProposals()).items.length > 0);
});

test("liveOfferId: the OPEN offer on that exact slot only", async () => {
  const { O } = await seed();
  const res = await proposals.accountProposals();
  const A = byName(res, "Rust bundle");
  assert.equal(tierOf(A, "eldorado", 5).liveOfferId, String(O.liveA._id));
  assert.equal(tierOf(A, "eldorado", 10).liveOfferId, null);
  // The g2g 5+ offer on the same set is closed (sold_out): not live.
  assert.equal(tierOf(A, "g2g", 5).liveOfferId, null);
  assert.equal(tierOf(A, "gameflip", 5).liveOfferId, null);
  // Fortnite: 1 free, nothing fits — kept only because its paused 10+ offer
  // is open, and counted precisely although its upper bound is tiny.
  const H = byName(res, "Fortnite live bundle");
  assert.ok(H, "a set with a live offer stays listed");
  assert.equal(H.surplus, -4);
  assert.ok(H.markets.every((m) => m.tiers.every((t) => !t.fits)));
  assert.equal(tierOf(H, "eldorado", 10).liveOfferId, String(O.liveH._id));
  // A farming offer never shows up on an account proposal.
  const all = res.items.flatMap((i) =>
    i.markets.flatMap((m) => m.tiers.map((t) => t.liveOfferId)),
  );
  assert.ok(!all.includes(String(O.liveFarm._id)));
});

test("blocked and unsupported markets never appear, whatever bp.markets holds", async () => {
  await seed();
  world.bp.markets = [
    "ggsel",
    "eldorado",
    "plati",
    "digiseller",
    "zeusx",
    "playerauctions",
    "GGSel",
  ];
  const res = await proposals.accountProposals();
  assert.ok(res.items.length > 0);
  for (const it of res.items) {
    assert.deepEqual(
      it.markets.map((m) => m.market),
      ["eldorado"],
      it.set.name,
    );
  }
  const text = JSON.stringify(res).toLowerCase();
  for (const bad of [
    "ggsel",
    "plati",
    "digiseller",
    "zeusx",
    "playerauctions",
  ]) {
    assert.ok(!text.includes('"market":"' + bad + '"'), bad);
  }
  const farm = await proposals.farmProposals();
  for (const it of farm.items)
    assert.deepEqual(
      it.markets.map((m) => m.market),
      ["eldorado"],
    );

  // Gameflip is never a no-claim market, even when it is the only one on.
  proposals.invalidate();
  world.bp.markets = ["gameflip"];
  const gfOnly = await proposals.accountProposals();
  assert.equal(byName(gfOnly, "OW no-claim"), undefined);
  for (const it of gfOnly.items)
    assert.deepEqual(
      it.markets.map((m) => m.market),
      ["gameflip"],
    );
  proposals.invalidate();
  const gfFarm = await proposals.farmProposals();
  for (const it of gfFarm.items) assert.deepEqual(it.markets, []);

  // No market switched on: nothing can fit, nothing is proposed.
  proposals.invalidate();
  world.bp.markets = [];
  assert.deepEqual((await proposals.accountProposals()).items, []);
});

test("no-claim games are never dropset proposals; no-claim sets are", async () => {
  await seed();
  const res = await proposals.accountProposals();
  // Neither the claimed Overwatch set nor the set with ONE Call of Duty item
  // is even read for archive stock.
  assert.equal(world.calls.stockForSets.length, 1);
  const read = world.calls.stockForSets[0];
  assert.ok(!read.includes("Overwatch claimed"));
  assert.ok(!read.includes("Mixed bundle"));
  assert.equal(byName(res, "Overwatch claimed"), undefined);
  assert.equal(byName(res, "Mixed bundle"), undefined);
  // Custom sets and sets without items are never candidates either.
  assert.ok(!read.includes("Custom promo"));
  assert.ok(!read.includes("Empty set"));
  assert.deepEqual(
    sorted(read),
    sorted([
      "Small Rust bundle",
      "Apex bundle",
      "Rust bundle",
      "Fortnite live bundle",
    ]),
  );
  // The no-claim Overwatch set is proposed as a no-claim pack.
  assert.equal(byName(res, "OW no-claim").source, "noclaim");
  for (const it of res.items) {
    if (it.source === "dropset")
      assert.ok(!fakeSettings.isNoClaimGame(it.set.game), it.set.name);
  }
});

test("a failed no-claim stock read hides that set only", async () => {
  const { S } = await seed();
  warnings.length = 0;
  const res = await proposals.accountProposals();
  assert.ok(world.calls.noclaimCounts.includes("R6 no-claim"));
  assert.ok(
    warnings.some(
      (w) =>
        w.includes(String(S.E2._id)) &&
        w.includes("holdings snapshot unavailable"),
    ),
  );
  assert.equal(byName(res, "R6 no-claim"), undefined);
  assert.ok(byName(res, "OW no-claim"));
  assert.ok(byName(res, "Apex bundle"));
});

test("gates are reported per market and never change the stock fit", async () => {
  await seed();
  world.af.g2gDeliverDryRun = true;
  world.noclaimShop.enabled = false;
  const res = await proposals.accountProposals();
  const B = byName(res, "Apex bundle");
  assert.deepEqual(marketOf(B, "eldorado").gate, { ok: true, reason: "" });
  assert.deepEqual(marketOf(B, "gameflip").gate, { ok: true, reason: "" });
  const g2g = marketOf(B, "g2g");
  assert.equal(g2g.gate.ok, false);
  assert.match(g2g.gate.reason, /dry-run/i);
  assert.ok(g2g.tiers.every((t) => t.fits));
  const E = byName(res, "OW no-claim");
  assert.equal(marketOf(E, "eldorado").gate.ok, false);
  assert.match(marketOf(E, "eldorado").gate.reason, /No-claim Shop/);
  assert.equal(tierOf(E, "eldorado", 5).fits, true);
  // Read once per (market, source) pair, not once per set:
  // 3 dropset markets + 2 no-claim markets.
  assert.equal(world.calls.getAutoFarm, 5);
});

test("limit bounds the precise stock reads; live sets outside the newest 600 are still read", async () => {
  const { S, O } = await seed();
  const one = await proposals.accountProposals({ limit: 1 });
  // One live set (the fullest) + the top other set; one no-claim set (newest).
  assert.deepEqual(world.calls.dropsetFreeCounts[0].names, [
    "Rust bundle",
    "Apex bundle",
  ]);
  assert.deepEqual(world.calls.noclaimCounts, ["R6 no-claim"]);
  assert.deepEqual(
    one.items.map((i) => i.set.name),
    ["Apex bundle", "Rust bundle"],
  );

  // A junk limit is the default (40): everything is counted again.
  const def = await proposals.accountProposals({ limit: "junk" });
  assert.equal(def.items.length, 4);

  // 600 newer sets push A (live) and H (live) out of the newest-600 read:
  // they are fetched by id, the other old sets are not read at all.
  await DropSet.insertMany(
    Array.from({ length: 600 }, (_, i) => ({
      name: "Filler " + String(i).padStart(3, "0"),
      items: [item("Filler", "Rust")],
      price: 1,
    })),
  );
  proposals.invalidate();
  world.calls.stockForSets = [];
  world.calls.noclaimCounts = [];
  const res = await proposals.accountProposals();
  const read = world.calls.stockForSets[0];
  assert.equal(read.length, 602);
  assert.ok(
    read.includes("Rust bundle") && read.includes("Fortnite live bundle"),
  );
  assert.ok(
    !read.includes("Apex bundle") && !read.includes("Small Rust bundle"),
  );
  assert.equal(
    tierOf(byName(res, "Rust bundle"), "eldorado", 5).liveOfferId,
    String(O.liveA._id),
  );
  assert.ok(byName(res, "Fortnite live bundle"));
  // The old no-claim sets have no open offer: outside the window, not read.
  assert.equal(byName(res, "OW no-claim"), undefined);
  assert.ok(!world.calls.noclaimCounts.includes(S.E.name));
});

test("cache: 5 minutes, refresh bypasses, invalidate clears, per-limit, shared in-flight", async () => {
  const { S } = await seed();
  const reads = () => world.calls.stockForSets.length;
  const r1 = await proposals.accountProposals();
  assert.equal(reads(), 1);
  assert.equal(await proposals.accountProposals(), r1);
  world.clock += CACHE_MS - 1;
  assert.equal(await proposals.accountProposals(), r1);
  assert.equal(reads(), 1);
  world.clock += 1;
  const r2 = await proposals.accountProposals();
  assert.notEqual(r2, r1);
  assert.equal(reads(), 2);
  assert.ok(r2.at > r1.at);

  const r3 = await proposals.accountProposals({ refresh: true });
  assert.notEqual(r3, r2);
  assert.equal(reads(), 3);

  // A new offer is invisible until invalidate() — which is why send.js calls it.
  const fresh = await BulkOffer.create(
    offerDoc({ source: "dropset", market: "eldorado", set: S.B, minQty: 5 }),
  );
  assert.equal(
    tierOf(
      byName(await proposals.accountProposals(), "Apex bundle"),
      "eldorado",
      5,
    ).liveOfferId,
    null,
  );
  proposals.invalidate();
  const r4 = await proposals.accountProposals();
  assert.equal(reads(), 4);
  assert.equal(
    tierOf(byName(r4, "Apex bundle"), "eldorado", 5).liveOfferId,
    String(fresh._id),
  );

  // Another limit is another cache entry.
  await proposals.accountProposals({ limit: 10 });
  await proposals.accountProposals({ limit: 10 });
  assert.equal(reads(), 5);

  // Concurrent callers share one build.
  proposals.invalidate();
  const [x, y] = await Promise.all([
    proposals.accountProposals(),
    proposals.accountProposals(),
  ]);
  assert.equal(x, y);
  assert.equal(reads(), 6);

  // A build that was running when invalidate() came is answered but not kept.
  proposals.invalidate();
  let release;
  world.hold = new Promise((r) => (release = r));
  const pending = proposals.accountProposals();
  while (reads() < 7) await tick();
  proposals.invalidate();
  world.hold = null;
  release();
  const stale = await pending;
  const next = await proposals.accountProposals();
  assert.notEqual(next, stale);
  assert.equal(reads(), 8);

  // A failed build is never cached.
  proposals.invalidate();
  const real = fakeShopRoutes.stockForSets;
  fakeShopRoutes.stockForSets = async () => {
    throw new Error("DropLog aggregation failed");
  };
  await assert.rejects(
    proposals.accountProposals(),
    /DropLog aggregation failed/,
  );
  fakeShopRoutes.stockForSets = real;
  assert.ok((await proposals.accountProposals()).items.length > 0);
});

// ---------------------------------------------------------------------------
// farmProposals
// ---------------------------------------------------------------------------

test("farm: demand on the configured terms, farm-table prices, capacity fit, liveOfferId", async () => {
  const { O } = await seed();
  const res = await proposals.farmProposals();
  assert.ok(res.at instanceof Date);
  assert.deepEqual(world.calls.demand, [{ days: 60 }]);
  // The capacity read is farmCapacity's own cached read (never forced here).
  assert.equal(world.calls.read.length, 1);
  assert.ok(!world.calls.read[0].force);
  assert.equal(res.capacity.bestStackRoom, 8);
  // min(maxQty 20, best stack 8, 60-20 slots, 80-20 pristine)
  assert.equal(res.advertisable, 8);

  // Apex@90 is not a configured term; Valorant@365 has a live offer but no demand.
  assert.deepEqual(
    res.items.map((i) => i.game + "@" + i.days),
    ["Rust@180", "Fortnite@365", "Valorant@365"],
  );
  const rust = res.items[0];
  assert.deepEqual(Object.keys(rust).sort(), [
    "accounts",
    "days",
    "demandByMarket",
    "game",
    "markets",
    "orders",
    "source",
  ]);
  assert.equal(rust.source, "farm");
  assert.deepEqual([rust.orders, rust.accounts], [9, 40]);
  assert.deepEqual(rust.demandByMarket, { eldorado: 6, g2g: 3 });
  assert.deepEqual(
    rust.markets.map((m) => m.market),
    ["eldorado", "g2g"],
  );
  const el = rust.markets[0];
  assert.equal(el.anchor, 4);
  assert.equal(el.basis, "farm-table");
  assert.deepEqual(el.gate, { ok: true, reason: "" });
  // PACKS-2 §4: a pack of N at the farm-table price less the discount
  // (5 × $4 × 0.95 = $19.00, $3.80 each). The room is a NEW offer's share:
  // two farm offers are open, so it gets 8 / 3 = 2 accounts — not one pack.
  assert.equal(res.share, 2);
  assert.equal(res.sharers, 3);
  const farmQuote = (m) =>
    m.tiers.map((t) => [
      t.minQty,
      t.discountPct,
      t.packPrice,
      t.unitPrice,
      t.fits,
      t.packsAvailable,
      t.liveOfferId,
    ]);
  assert.deepEqual(farmQuote(el), [
    [5, 5, 19, 3.8, false, 0, null],
    [10, 10, 36, 3.6, false, 0, null],
  ]);
  const shared = world.calls.shareFor[0];
  assert.deepEqual(
    shared[1].slice(0, 2),
    [String(O.liveFarm._id), String(O.liveFarmOld._id)].sort(),
  );
  assert.equal(shared[1].length, 3, "the open farm offers + the new one");
  assert.equal(shared[2], 8);
  assert.equal(rust.markets[1].tiers[1].liveOfferId, String(O.liveFarm._id));
  const valorant = res.items[2];
  assert.deepEqual([valorant.orders, valorant.accounts], [0, 0]);
  assert.equal(
    valorant.markets[0].tiers[0].liveOfferId,
    String(O.liveFarmOld._id),
  );
  assert.equal(valorant.markets[0].anchor, 7);
  assert.deepEqual(
    [
      valorant.markets[0].tiers[0].packPrice,
      valorant.markets[0].tiers[0].unitPrice,
    ],
    [33.25, 6.65],
  );

  // More capacity: min(20 max, 30 room, 60-20 slots, 80-20 pristine) = 20
  // advertisable, a new offer's share 20 / 3 = 6 -> one pack of 5 fits, a
  // pack of 10 does not.
  proposals.invalidate();
  world.capacity.bestStackRoom = 30;
  const more = await proposals.farmProposals();
  assert.equal(more.advertisable, 20);
  assert.equal(more.share, 6);
  assert.deepEqual(farmQuote(more.items[0].markets[0]), [
    [5, 5, 19, 3.8, true, 1, null],
    [10, 10, 36, 3.6, false, 0, null],
  ]);

  // A term with no farm-table price proposes no price, and nothing fits.
  proposals.invalidate();
  world.bp.farmDurations = [120, 180, 365, 90];
  const withApex = await proposals.farmProposals();
  const apex = withApex.items.find((i) => i.game === "Apex Legends");
  assert.equal(withApex.items[0], apex, "most orders first");
  assert.equal(apex.markets[0].anchor, 0);
  assert.ok(
    apex.markets[0].tiers.every(
      (t) => t.unitPrice === 0 && t.packPrice === 0 && !t.priced && !t.fits,
    ),
  );
});

test("PACKS-2 §4 farm: with no other farm offer open a new one gets the whole advertisable capacity, in whole packs", async () => {
  await seed();
  await BulkOffer.updateMany(
    { kind: "farming" },
    { $set: { state: "withdrawn", open: false } },
  );
  world.capacity.bestStackRoom = 17; // advertisable = min(20, 17, 40, 60) = 17
  const res = await proposals.farmProposals();
  assert.equal(res.advertisable, 17);
  assert.equal(res.share, 17);
  assert.equal(res.sharers, 1);
  const rust = res.items.find((i) => i.game === "Rust");
  for (const m of rust.markets) {
    assert.deepEqual(
      m.tiers.map((t) => [t.minQty, t.fits, t.packsAvailable, t.liveOfferId]),
      [
        [5, true, 3, null], // 17 accounts = 3 packs of 5 (2 left over)
        [10, true, 1, null], // = 1 pack of 10
      ],
      m.market,
    );
  }
});

test("farm: top 30 by orders, live slots appended, gates, no capacity -> nothing fits", async () => {
  await seed();
  world.demand = Array.from({ length: 35 }, (_, i) => ({
    game: "Game " + (i + 1),
    days: 120,
    orders: 35 - i,
    accounts: 35 - i,
    markets: {},
  }));
  world.capacity = {
    bestStackRoom: 0,
    totalFree: 0,
    pristine: 0,
    at: null,
    error: "hosts unreachable",
  };
  world.af.eldoradoAutoDeliver = false;
  const res = await proposals.farmProposals();
  const keys = res.items.map((i) => i.game + "@" + i.days);
  assert.equal(keys.length, 32);
  assert.deepEqual(
    keys.slice(0, 30),
    Array.from({ length: 30 }, (_, i) => "Game " + (i + 1) + "@120"),
  );
  assert.deepEqual(keys.slice(30), ["Rust@180", "Valorant@365"]);
  assert.equal(res.advertisable, 0);
  assert.equal(res.capacity.error, "hosts unreachable");
  for (const it of res.items) {
    for (const m of it.markets) {
      assert.ok(m.tiers.every((t) => !t.fits));
      if (m.market === "eldorado") {
        assert.equal(m.gate.ok, false);
        assert.match(m.gate.reason, /auto-delivery is off/);
      }
    }
  }
});

test("farm cache: 5 minutes, refresh and invalidate rebuild", async () => {
  await seed();
  const reads = () => world.calls.demand.length;
  const f1 = await proposals.farmProposals();
  assert.equal(await proposals.farmProposals(), f1);
  assert.equal(reads(), 1);
  await proposals.farmProposals({ refresh: true });
  assert.equal(reads(), 2);
  proposals.invalidate();
  await proposals.farmProposals();
  assert.equal(reads(), 3);
  world.clock += CACHE_MS;
  await proposals.farmProposals();
  assert.equal(reads(), 4);
  // The account and farm caches are separate.
  await proposals.accountProposals();
  assert.equal(reads(), 4);
});

test("the real utils/settings.json was never read", () => {
  assert.equal(settingsFileReads, 0);
});

// Integration fix (2026-09-30): a tier send.js would refuse for want of a price
// must not be offered as a fitting button.
test("a tier with no price reference is marked unpriced and never fits", async () => {
  await seed();
  const set = await DropSet.create({
    name: "Unpriced Rust bundle",
    items: [item("Crate", "Rust")],
    price: 0,
  });
  world.upper["Unpriced Rust bundle"] = 50;
  world.free["Unpriced Rust bundle"] = 50;
  proposals.invalidate();
  const res = await proposals.accountProposals({ refresh: true });
  const it = res.items.find((x) => x.set && x.set.id === String(set._id));
  // Nothing fits and nothing is live, so the set is not proposed at all …
  if (!it) return;
  // … or, if it is listed for another reason, every tier is unpriced.
  for (const m of it.markets) {
    for (const t of m.tiers) {
      assert.equal(t.priced, false);
      assert.equal(t.fits, false);
    }
  }
});
