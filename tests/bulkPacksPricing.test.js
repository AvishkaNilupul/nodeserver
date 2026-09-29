// Pure-function coverage for utils/bulkPacks/pricing.js — no Mongo connection,
// no network, no settings file (docs/bulk-packs/API-UI.md "Tests" A2,
// MODULES.md §pricing.js):
//   1. round2 / roundQuarter — half-up on the decimal value, NaN -> 0, no -0.
//   2. unitPrice — tier discount off the anchor, per-market floors, 0 = "no
//      price" (never "free"), discount clamped to the settings' 0..60.
//   3. packPrice — Gameflip whole-pack price on the $0.25 grid, $0.75 floor.
//   4. farmUnitPrice — the owner's farm price table, then unitPrice.
//   5. pickAnchor — our lowest live single of the set on that market (never a
//      bulk row), else set.price, else none; lifted to set.minPriceUsd.
//   6. tierQuote — one quote per tier; packPrice only on Gameflip.
// Run: node --test tests/bulkPacksPricing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const pricing = require("../utils/bulkPacks/pricing");
const { MARKET_FLOORS } = require("../utils/bulkPacks/config");

const {
  round2,
  roundQuarter,
  effectiveDiscount,
  unitPrice,
  packPrice,
  farmUnitPrice,
  pickAnchor,
  tierQuote,
} = pricing;

// The shipped defaults (CONTRACT §6): the tiers and the farm price table.
const TIERS = [
  { minQty: 5, discountPct: 5 },
  { minQty: 10, discountPct: 10 },
];
const FARM_PRICES = {
  eldorado: { 120: 3, 180: 4, 365: 7 },
  g2g: { 120: 3, 180: 4, 365: 7 },
};

const hasAtMost2dp = (x) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-9;
const onQuarterGrid = (x) => Math.abs(x * 4 - Math.round(x * 4)) < 1e-9;

// ---------------------------------------------------------------------------
// rounding
// ---------------------------------------------------------------------------

test("round2: half-up on the decimal value, not on the binary noise", () => {
  assert.equal(round2(1.005), 1.01); // 1.005 * 100 === 100.49999999999999
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(1.1875), 1.19); // 1.25 * 0.95
  assert.equal(round2(1.125), 1.13); // 1.25 * 0.90
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(6.65), 6.65);
  assert.equal(round2(7), 7);
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2("1.234"), 1.23, "a numeric string is a number");
  assert.equal(round2(-1.005), -1.01, "symmetric: half away from zero");
});

test("round2: NaN and non-numbers are 0, and never -0", () => {
  for (const bad of [NaN, undefined, null, "", "  ", "abc", Infinity, -Infinity, {}, [], true]) {
    assert.equal(round2(bad), 0, "round2(" + String(bad) + ")");
  }
  assert.ok(Object.is(round2(-0.001), 0), "-0.001 rounds to +0, not -0");
  assert.ok(Object.is(round2(-0), 0));
});

test("roundQuarter: nearest $0.25 as a 2-dp number; NaN -> 0", () => {
  assert.equal(roundQuarter(5.9375), 6); // 5 * 1.25 * 0.95
  assert.equal(roundQuarter(5.87), 5.75);
  assert.equal(roundQuarter(5.875), 6, "exact half rounds up");
  assert.equal(roundQuarter(1.125), 1.25);
  assert.equal(roundQuarter(11.25), 11.25);
  assert.equal(roundQuarter(0.1), 0);
  assert.equal(roundQuarter("2.3"), 2.25);
  for (const bad of [NaN, undefined, null, "x", Infinity]) {
    assert.equal(roundQuarter(bad), 0);
  }
  for (let x = 0; x < 40; x += 0.37) {
    const q = roundQuarter(x);
    assert.ok(onQuarterGrid(q) && hasAtMost2dp(q), "roundQuarter(" + x + ") = " + q);
    assert.ok(Math.abs(q - x) <= 0.125 + 1e-9, "nearest quarter of " + x);
  }
});

test("effectiveDiscount: absent/invalid/negative -> 0, capped at the settings' 60", () => {
  assert.equal(effectiveDiscount(5), 5);
  assert.equal(effectiveDiscount(7.5), 7.5);
  assert.equal(effectiveDiscount("10"), 10);
  assert.equal(effectiveDiscount(60), 60);
  assert.equal(effectiveDiscount(90), 60);
  assert.equal(effectiveDiscount(100), 60);
  for (const bad of [undefined, null, NaN, "x", -5, 0, true]) {
    assert.equal(effectiveDiscount(bad), 0, "effectiveDiscount(" + String(bad) + ")");
  }
  assert.equal(pricing.MAX_DISCOUNT_PCT, 60);
});

// ---------------------------------------------------------------------------
// unitPrice
// ---------------------------------------------------------------------------

test("unitPrice: the tier discount comes off the single-account anchor", () => {
  // The Send-dialog example in API-UI.md: $1.25 single, 5% off -> $1.19.
  assert.equal(unitPrice({ anchor: 1.25, discountPct: 5, market: "eldorado" }), 1.19);
  assert.equal(unitPrice({ anchor: 1.25, discountPct: 10, market: "eldorado" }), 1.13);
  assert.equal(unitPrice({ anchor: 1.25, discountPct: 0, market: "eldorado" }), 1.25);
  assert.equal(unitPrice({ anchor: 1.25, market: "eldorado" }), 1.25, "no discount given");
  assert.equal(unitPrice({ anchor: 2.4, discountPct: 10, market: "g2g" }), 2.16);
  assert.equal(unitPrice({ anchor: 1.5, discountPct: 5, market: "gameflip" }), 1.43);
  assert.equal(unitPrice({ anchor: "1.25", discountPct: "5", market: "eldorado" }), 1.19);
});

test("unitPrice: never below the market floor", () => {
  assert.equal(unitPrice({ anchor: 0.4, market: "eldorado" }), 0.5);
  assert.equal(unitPrice({ anchor: 0.52, discountPct: 10, market: "eldorado" }), 0.5);
  assert.equal(unitPrice({ anchor: 1.05, discountPct: 10, market: "g2g" }), 1);
  assert.equal(unitPrice({ anchor: 0.7, market: "gameflip" }), 0.75);
  for (const [market, floor] of Object.entries(MARKET_FLOORS)) {
    assert.equal(unitPrice({ anchor: 0.01, discountPct: 60, market }), floor, market);
  }
  // Property: every price is >= the floor and has at most 2 decimals.
  for (const market of Object.keys(MARKET_FLOORS)) {
    for (let anchor = 0.05; anchor < 25; anchor += 0.73) {
      for (let d = 0; d <= 60; d += 7.5) {
        const p = unitPrice({ anchor, discountPct: d, market });
        assert.ok(p >= MARKET_FLOORS[market], market + " " + anchor + " " + d + " -> " + p);
        assert.ok(hasAtMost2dp(p), "2 dp: " + p);
        assert.ok(p <= Math.max(MARKET_FLOORS[market], anchor + 0.005), "a discount never raises the price");
      }
    }
  }
});

test("unitPrice: no usable anchor is 0 (no price), never the floor", () => {
  for (const anchor of [0, -1, NaN, undefined, null, "", "abc", Infinity, true, {}]) {
    assert.equal(unitPrice({ anchor, discountPct: 5, market: "eldorado" }), 0, "anchor " + String(anchor));
  }
  assert.equal(unitPrice(), 0);
  assert.equal(unitPrice({}), 0);
});

test("unitPrice: a market with no floor is not priced (blocked, unsupported, prototype keys)", () => {
  for (const market of ["ggsel", "plati", "digiseller", "playerauctions", "zeusx", "Eldorado", "", undefined, "__proto__", "constructor", "toString"]) {
    assert.equal(unitPrice({ anchor: 5, discountPct: 5, market }), 0, "market " + String(market));
  }
});

test("unitPrice: a garbled or out-of-range discount errs HIGH, never to the floor", () => {
  // 100% (or NaN) off must not sell a $10 bundle at the $0.50 floor.
  assert.equal(unitPrice({ anchor: 10, discountPct: 100, market: "eldorado" }), 4);
  assert.equal(unitPrice({ anchor: 10, discountPct: 250, market: "eldorado" }), 4);
  assert.equal(unitPrice({ anchor: 10, discountPct: NaN, market: "eldorado" }), 10);
  assert.equal(unitPrice({ anchor: 10, discountPct: "x", market: "eldorado" }), 10);
  assert.equal(unitPrice({ anchor: 10, discountPct: -20, market: "eldorado" }), 10, "no markup");
});

// ---------------------------------------------------------------------------
// packPrice (Gameflip)
// ---------------------------------------------------------------------------

test("packPrice: size x anchor x (1 - d), on the $0.25 grid", () => {
  assert.equal(packPrice({ anchor: 1.25, discountPct: 5, size: 5 }), 6); // 5.9375
  assert.equal(packPrice({ anchor: 1.25, discountPct: 10, size: 10 }), 11.25);
  assert.equal(packPrice({ anchor: 2, discountPct: 5, size: 5 }), 9.5);
  assert.equal(packPrice({ anchor: 0.99, discountPct: 10, size: 5 }), 4.5); // 4.455
  assert.equal(packPrice({ anchor: 1.25, discountPct: 5, size: "5" }), 6, "numeric string size");
  for (let anchor = 0.1; anchor < 12; anchor += 0.61) {
    for (const size of [2, 5, 10, 25]) {
      const p = packPrice({ anchor, discountPct: 10, size });
      assert.ok(onQuarterGrid(p), "quarter grid: " + p);
      assert.ok(p >= MARKET_FLOORS.gameflip, "floor: " + p);
    }
  }
});

test("packPrice: $0.75 floor; 0 for an unusable anchor or size", () => {
  assert.equal(packPrice({ anchor: 0.1, discountPct: 10, size: 2 }), 0.75);
  assert.equal(MARKET_FLOORS.gameflip, 0.75);
  for (const size of [0, -5, 2.5, NaN, undefined, null, "x", ""]) {
    assert.equal(packPrice({ anchor: 1.25, discountPct: 5, size }), 0, "size " + String(size));
  }
  for (const anchor of [0, -1, NaN, undefined, "x", Infinity]) {
    assert.equal(packPrice({ anchor, discountPct: 5, size: 5 }), 0, "anchor " + String(anchor));
  }
  assert.equal(packPrice(), 0);
  // The discount guard applies here too.
  assert.equal(packPrice({ anchor: 2, discountPct: 100, size: 5 }), 4); // 60% max
});

// ---------------------------------------------------------------------------
// farmUnitPrice
// ---------------------------------------------------------------------------

test("farmUnitPrice: reads the owner's farm table, then prices like a unit", () => {
  // The Farming-packs example in API-UI.md: 1 year at $7, 5% off -> $6.65.
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "eldorado", days: 365, discountPct: 5 }), 6.65);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "eldorado", days: 120, discountPct: 5 }), 2.85);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "eldorado", days: 180, discountPct: 10 }), 3.6);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "g2g", days: 120, discountPct: 10 }), 2.7);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "g2g", days: "365", discountPct: 5 }), 6.65);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "g2g", days: " 180 ", discountPct: 0 }), 4);
  assert.equal(
    farmUnitPrice({ farmPrices: { g2g: { 120: 1 } }, market: "g2g", days: 120, discountPct: 10 }),
    1,
    "G2G's $1 floor",
  );
});

test("farmUnitPrice: a missing market, duration or price is 0", () => {
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "eldorado", days: 90, discountPct: 5 }), 0);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "gameflip", days: 120, discountPct: 5 }), 0);
  assert.equal(farmUnitPrice({ farmPrices: FARM_PRICES, market: "ggsel", days: 120, discountPct: 5 }), 0);
  assert.equal(farmUnitPrice({ farmPrices: null, market: "eldorado", days: 120 }), 0);
  assert.equal(farmUnitPrice({ market: "eldorado", days: 120 }), 0);
  assert.equal(farmUnitPrice(), 0);
  for (const price of [0, -3, "x", null, true]) {
    assert.equal(
      farmUnitPrice({ farmPrices: { eldorado: { 120: price } }, market: "eldorado", days: 120 }),
      0,
      "price " + String(price),
    );
  }
  assert.equal(
    farmUnitPrice({ farmPrices: FARM_PRICES, market: "__proto__", days: 120 }),
    0,
    "prototype keys are not a market",
  );
});

// ---------------------------------------------------------------------------
// pickAnchor
// ---------------------------------------------------------------------------

const oid = () => new mongoose.Types.ObjectId();

function row(fields) {
  return {
    _id: oid(),
    marketplace: "eldorado",
    status: "active",
    bulkOfferId: null,
    price: 1,
    ...fields,
  };
}

test("pickAnchor: our LOWEST live single of this set on this market", () => {
  const set = { _id: oid(), price: 2, minPriceUsd: 0 };
  const other = { _id: oid() };
  const cheapest = row({ set: String(set._id), price: 1.25 }); // hex string id
  const rows = [
    row({ set: set._id, price: 1.5 }), // ObjectId id
    cheapest,
    row({ set: set._id, price: 0.5, bulkOfferId: oid() }), // a bulk row: already discounted
    row({ set: set._id, price: 0.9, marketplace: "g2g" }), // another market
    row({ set: set._id, price: 0.6, status: "delisted" }),
    row({ set: set._id, price: 0.6, status: "sold" }),
    row({ set: other._id, price: 0.7 }), // another set
    row({ set: set._id, price: 0 }),
    row({ set: set._id, price: -1 }),
    row({ set: set._id, price: "abc" }),
    row({ set: null, price: 0.2 }),
    null,
    "junk",
  ];
  assert.deepEqual(pickAnchor({ rows, set, market: "eldorado" }), {
    anchor: 1.25,
    basis: "listing",
    listingId: String(cheapest._id),
  });
  // Same rows, G2G: only the G2G row qualifies.
  const g2g = pickAnchor({ rows, set, market: "g2g" });
  assert.equal(g2g.anchor, 0.9);
  assert.equal(g2g.basis, "listing");
});

test("pickAnchor: a tie keeps the first row; a populated set matches too", () => {
  const set = { _id: oid(), price: 5 };
  const a = row({ set: set._id, price: 1.25 });
  const b = row({ set: set._id, price: 1.25 });
  assert.equal(pickAnchor({ rows: [a, b], set, market: "eldorado" }).listingId, String(a._id));
  const populated = row({ set: { _id: set._id, name: "Rust — Winter" }, price: 0.99 });
  assert.equal(pickAnchor({ rows: [a, populated], set, market: "eldorado" }).anchor, 0.99);
});

test("pickAnchor: no live single -> the set's own price, basis 'set'", () => {
  const set = { _id: oid(), price: 2 };
  const onlyBulk = [row({ set: set._id, price: 1, bulkOfferId: oid() })];
  assert.deepEqual(pickAnchor({ rows: onlyBulk, set, market: "eldorado" }), {
    anchor: 2,
    basis: "set",
    listingId: "",
  });
  assert.deepEqual(pickAnchor({ rows: [], set, market: "eldorado" }).basis, "set");
  assert.deepEqual(pickAnchor({ rows: undefined, set, market: "eldorado" }).anchor, 2);
});

test("pickAnchor: nothing to anchor on -> {0, 'none', ''}", () => {
  const none = { anchor: 0, basis: "none", listingId: "" };
  assert.deepEqual(pickAnchor({ rows: [], set: { _id: oid(), price: 0 }, market: "eldorado" }), none);
  assert.deepEqual(pickAnchor({ rows: [], set: { _id: oid() }, market: "eldorado" }), none);
  assert.deepEqual(pickAnchor({ rows: [row({ price: 1 })], set: null, market: "eldorado" }), none);
  assert.deepEqual(pickAnchor(), none);
  // minPriceUsd never invents an anchor on its own.
  assert.deepEqual(
    pickAnchor({ rows: [], set: { _id: oid(), price: 0, minPriceUsd: 3 }, market: "eldorado" }),
    none,
  );
});

test("pickAnchor: a set without an _id never matches rows that have no set", () => {
  // String(undefined) === String(undefined): without a guard every set-less
  // row would "belong" to an id-less set.
  const set = { price: 3 };
  const rows = [row({ price: 1 }), row({ set: undefined, price: 0.5 })];
  delete rows[0].set;
  assert.deepEqual(pickAnchor({ rows, set, market: "eldorado" }), {
    anchor: 3,
    basis: "set",
    listingId: "",
  });
});

test("pickAnchor: the anchor is lifted to set.minPriceUsd, keeping its basis", () => {
  const set = { _id: oid(), price: 1, minPriceUsd: 1.6 };
  const r = row({ set: set._id, price: 1.25 });
  assert.deepEqual(pickAnchor({ rows: [r], set, market: "eldorado" }), {
    anchor: 1.6,
    basis: "listing",
    listingId: String(r._id),
  });
  assert.deepEqual(pickAnchor({ rows: [], set, market: "eldorado" }), {
    anchor: 1.6,
    basis: "set",
    listingId: "",
  });
  // A floor below the anchor changes nothing.
  const low = { _id: set._id, price: 1, minPriceUsd: 0.8 };
  assert.equal(pickAnchor({ rows: [r], set: low, market: "eldorado" }).anchor, 1.25);
});

// ---------------------------------------------------------------------------
// tierQuote
// ---------------------------------------------------------------------------

test("tierQuote: one quote per tier; packPrice only on gameflip", () => {
  assert.deepEqual(tierQuote({ anchor: 1.25, market: "eldorado", tiers: TIERS }), [
    { minQty: 5, discountPct: 5, unitPrice: 1.19, packPrice: 0 },
    { minQty: 10, discountPct: 10, unitPrice: 1.13, packPrice: 0 },
  ]);
  assert.deepEqual(tierQuote({ anchor: 1.25, market: "gameflip", tiers: TIERS }), [
    { minQty: 5, discountPct: 5, unitPrice: 1.19, packPrice: 6 },
    { minQty: 10, discountPct: 10, unitPrice: 1.13, packPrice: 11.25 },
  ]);
  assert.deepEqual(
    tierQuote({ anchor: 1.05, market: "g2g", tiers: TIERS }).map((q) => q.unitPrice),
    [1, 1],
    "G2G's $1 floor",
  );
});

test("tierQuote: no anchor quotes 0; junk tiers are skipped; discount is the effective one", () => {
  assert.deepEqual(
    tierQuote({ anchor: 0, market: "gameflip", tiers: TIERS }).map((q) => [q.unitPrice, q.packPrice]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.deepEqual(tierQuote({ anchor: 1, market: "eldorado", tiers: null }), []);
  assert.deepEqual(tierQuote({ anchor: 1, market: "eldorado" }), []);
  assert.deepEqual(tierQuote(), []);
  const q = tierQuote({
    anchor: 10,
    market: "eldorado",
    tiers: [null, { minQty: 0, discountPct: 5 }, { minQty: 2.5 }, { minQty: "x" }, { minQty: 20, discountPct: 90 }, { minQty: "3" }],
  });
  assert.deepEqual(q, [
    { minQty: 20, discountPct: 60, unitPrice: 4, packPrice: 0 },
    { minQty: 3, discountPct: 0, unitPrice: 10, packPrice: 0 },
  ]);
});

test("the module is pure: __setDeps / __resetDeps exist and change nothing", () => {
  assert.equal(typeof pricing.__setDeps, "function");
  assert.equal(typeof pricing.__resetDeps, "function");
  pricing.__setDeps({ anything: true });
  assert.equal(unitPrice({ anchor: 1.25, discountPct: 5, market: "eldorado" }), 1.19);
  pricing.__resetDeps();
});
