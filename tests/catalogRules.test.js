const test = require("node:test");
const assert = require("node:assert/strict");

const {
  categoryFor,
  publicPriceFor,
  publicPriceTiers,
  clampPublicPrice,
  inquiryQuantity,
  PUBLIC_PRICE_MIN_USD,
  PUBLIC_PRICE_MAX_USD,
} = require("../routes/catalogRoutes");

// The owner's clamp for farmed bundles (docs/CATALOG-V2-CONTRACT.md §0): every
// default-opts price lands inside [MIN, MAX]. The in-band fixtures below assume
// that band contains $1.01–$2.99; this guard makes a band change fail loudly
// instead of as puzzling arithmetic.
test("public price band is the owner's $1.01–$2.99 clamp", () => {
  assert.equal(PUBLIC_PRICE_MIN_USD, 1.01);
  assert.equal(PUBLIC_PRICE_MAX_USD, 2.99);
  assert.ok(PUBLIC_PRICE_MIN_USD < PUBLIC_PRICE_MAX_USD);
  assert.equal(clampPublicPrice(2.349), 2.35);
  assert.equal(clampPublicPrice(100), PUBLIC_PRICE_MAX_USD);
  assert.equal(clampPublicPrice(0.5), PUBLIC_PRICE_MIN_USD);
  assert.equal(clampPublicPrice(0), PUBLIC_PRICE_MIN_USD);
  assert.equal(clampPublicPrice(-1), PUBLIC_PRICE_MIN_USD);
  assert.equal(clampPublicPrice("nope"), PUBLIC_PRICE_MIN_USD);
});

test("catalog category uses the dominant game and deterministic tie breaking", () => {
  assert.equal(
    categoryFor({
      items: [
        { game: "Warframe" },
        { game: "Warframe" },
        { game: "Destiny 2" },
      ],
    }),
    "Warframe",
  );
  assert.equal(
    categoryFor({ items: [{ game: "Warframe" }, { game: "Destiny 2" }] }),
    "Destiny 2",
  );
});

test("catalog category falls back when set items have no game", () => {
  assert.equal(categoryFor({ items: [{ name: "Unknown" }] }), "Other");
});

test("public price honors an explicit override, rounded to cents and clamped", () => {
  assert.equal(
    publicPriceFor({ publicPrice: 2.349, price: 20, bulkDiscountPct: 50 }),
    2.35,
  );
  assert.equal(
    publicPriceFor({ publicPrice: 12.345, price: 20, bulkDiscountPct: 50 }),
    PUBLIC_PRICE_MAX_USD,
  );
  assert.equal(
    publicPriceFor({ publicPrice: 0.3, price: 2.5 }),
    PUBLIC_PRICE_MIN_USD,
  );
});

test("public price applies bulk discount without crossing the floor, inside the clamp", () => {
  assert.equal(
    publicPriceFor({ price: 2.5, bulkDiscountPct: 25, minPriceUsd: 2.2 }),
    2.2,
  );
  assert.equal(publicPriceFor({ price: 2.5, bulkDiscountPct: 25 }), 1.88);
  // A floor above the band still clamps: the owner's cap wins for bundles.
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 25, minPriceUsd: 16 }),
    PUBLIC_PRICE_MAX_USD,
  );
});

test("public price falls back to observed market median when retail is absent", () => {
  assert.equal(publicPriceFor({ price: 0, bulkDiscountPct: 10 }, 2.5), 2.25);
  assert.equal(
    publicPriceFor({ price: 0, bulkDiscountPct: 10 }, 18),
    PUBLIC_PRICE_MAX_USD,
  );
  assert.equal(publicPriceFor({ price: 0 }), PUBLIC_PRICE_MIN_USD);
  assert.equal(publicPriceFor({ price: 0 }, 0), PUBLIC_PRICE_MIN_USD);
});

test("public price clamps malformed discount values to the supported range", () => {
  assert.equal(publicPriceFor({ price: 2.9, bulkDiscountPct: 100 }), 1.16);
  assert.equal(publicPriceFor({ price: 2.5, bulkDiscountPct: -20 }), 2.5);
  assert.equal(publicPriceFor({ price: 2.5, bulkDiscountPct: "abc" }), 2.3);
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 100 }),
    PUBLIC_PRICE_MAX_USD,
  );
});

test("public price clamps both ends of the band for bundles", () => {
  assert.equal(publicPriceFor({ price: 50 }), PUBLIC_PRICE_MAX_USD);
  assert.equal(publicPriceFor({ price: 0.5 }), PUBLIC_PRICE_MIN_USD);
  assert.equal(
    publicPriceFor({ price: 2.99, bulkDiscountPct: 0 }),
    PUBLIC_PRICE_MAX_USD,
  );
  assert.equal(
    publicPriceFor({ price: 1.01, bulkDiscountPct: 0 }),
    PUBLIC_PRICE_MIN_USD,
  );
  for (const set of [
    { price: 0.01 },
    { price: 1.5 },
    { price: 2.5, bulkDiscountPct: 60 },
    { price: 999, minPriceUsd: 500 },
    { publicPrice: 400 },
  ]) {
    const price = publicPriceFor(set);
    assert.ok(
      price >= PUBLIC_PRICE_MIN_USD,
      `${JSON.stringify(set)} → ${price}`,
    );
    assert.ok(
      price <= PUBLIC_PRICE_MAX_USD,
      `${JSON.stringify(set)} → ${price}`,
    );
  }
});

// --- §7.1: opts.clamp / opts.floor / opts.retail --------------------------------

test("public price with default opts is byte-identical to the two-argument form", () => {
  const sets = [
    { price: 2.5, bulkDiscountPct: 25, minPriceUsd: 2.2 },
    { price: 20, bulkDiscountPct: 25, minPriceUsd: 16 },
    { publicPrice: 2.349, price: 20 },
    { price: 0, bulkDiscountPct: 10 },
    { price: 0.5 },
  ];
  for (const set of sets) {
    assert.equal(publicPriceFor(set, 2.5, {}), publicPriceFor(set, 2.5));
    assert.equal(
      publicPriceFor(set, 2.5, { clamp: true }),
      publicPriceFor(set, 2.5),
    );
    assert.equal(
      publicPriceFor(set, 2.5, { floor: 0 }),
      publicPriceFor(set, 2.5),
    );
    assert.deepEqual(
      publicPriceTiers(set, 2.5, {}),
      publicPriceTiers(set, 2.5),
    );
    assert.deepEqual(
      publicPriceTiers(set, 2.5, { clamp: true, floor: 0 }),
      publicPriceTiers(set, 2.5),
    );
  }
});

test("public price with clamp:false skips the band and rounds to cents", () => {
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 25 }, 0, { clamp: false }),
    15,
  );
  assert.equal(
    publicPriceFor({ price: 33.333, bulkDiscountPct: 0 }, 0, { clamp: false }),
    33.33,
  );
  assert.equal(
    publicPriceFor({ price: 12.345, bulkDiscountPct: 0 }, 0, { clamp: false }),
    12.35,
  );
  assert.equal(
    publicPriceFor({ publicPrice: 12.345, price: 20 }, 0, { clamp: false }),
    12.35,
  );
  assert.equal(
    publicPriceFor({ price: 0, bulkDiscountPct: 10 }, 18, { clamp: false }),
    16.2,
  );
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 100 }, 0, { clamp: false }),
    8,
  );
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 25, minPriceUsd: 16 }, 0, {
      clamp: false,
    }),
    16,
  );
});

test("public price with clamp:false still never drops below $0.25", () => {
  assert.equal(publicPriceFor({ price: 0.1 }, 0, { clamp: false }), 0.25);
  assert.equal(publicPriceFor({ price: 0 }, 0, { clamp: false }), 0.25);
  assert.equal(
    publicPriceFor({ price: 0.5, bulkDiscountPct: 60 }, 0, { clamp: false }),
    0.25,
  );
  assert.equal(
    publicPriceFor({ price: 0.5, bulkDiscountPct: 0 }, 0, { clamp: false }),
    0.5,
  );
});

test("public price opts.floor is an extra floor on top of the set's own", () => {
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 50 }, 0, {
      clamp: false,
      floor: 12,
    }),
    12,
  );
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 50, minPriceUsd: 11 }, 0, {
      clamp: false,
      floor: 12,
    }),
    12,
  );
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 50, minPriceUsd: 15 }, 0, {
      clamp: false,
      floor: 12,
    }),
    15,
  );
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 50 }, 0, {
      clamp: false,
      floor: 3,
    }),
    10,
  );
  assert.equal(
    publicPriceFor({ price: 0.1 }, 0, { clamp: false, floor: 0.1 }),
    0.25,
  );
  // The floor is applied inside the band when the clamp stays on.
  assert.equal(
    publicPriceFor({ price: 2.5, bulkDiscountPct: 50 }, 0, { floor: 2 }),
    2,
  );
  assert.equal(
    publicPriceFor({ price: 2.5, bulkDiscountPct: 50 }, 0, { floor: 12 }),
    PUBLIC_PRICE_MAX_USD,
  );
});

test("public price opts.retail overrides the set price and the market median", () => {
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 10 }, 18, {
      clamp: false,
      retail: 30,
    }),
    27,
  );
  assert.equal(
    publicPriceFor({ price: 0, bulkDiscountPct: 10 }, 18, {
      clamp: false,
      retail: 30,
    }),
    27,
  );
  assert.equal(
    publicPriceFor({ price: 2, bulkDiscountPct: 0 }, 0, { retail: 2.5 }),
    2.5,
  );
  assert.equal(
    publicPriceFor({ price: 2, bulkDiscountPct: 0 }, 0, { retail: 9 }),
    PUBLIC_PRICE_MAX_USD,
  );
  // An explicit publicPrice override still beats opts.retail.
  assert.equal(
    publicPriceFor({ publicPrice: 12.5, price: 20 }, 0, {
      clamp: false,
      retail: 30,
    }),
    12.5,
  );
});

test("public price tiers pass opts through to every tier", () => {
  assert.deepEqual(
    publicPriceTiers({ price: 20, bulkDiscountPct: 8, bulkMinQty: 5 }, 0, {
      clamp: false,
    }),
    [
      { quantity: 5, price: 18.4 },
      { quantity: 50, price: 17.4 },
      { quantity: 100, price: 16.4 },
    ],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 20, bulkDiscountPct: 50, bulkMinQty: 5 }, 0, {
      clamp: false,
      floor: 9.5,
    }).map((tier) => tier.price),
    [10, 9.5, 9.5],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 20, bulkDiscountPct: 10, bulkMinQty: 10 }, 0, {
      clamp: false,
      retail: 30,
    }),
    [
      { quantity: 10, price: 27 },
      { quantity: 50, price: 25.5 },
      { quantity: 100, price: 24 },
    ],
  );
  assert.deepEqual(
    publicPriceTiers({ publicPrice: 12.5, price: 20, bulkMinQty: 5 }, 0, {
      clamp: false,
    }).map((tier) => tier.price),
    [12.5, 12.5, 12.5],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 20, bulkDiscountPct: 8, bulkMinQty: 5 }).map(
      (tier) => tier.price,
    ),
    [PUBLIC_PRICE_MAX_USD, PUBLIC_PRICE_MAX_USD, PUBLIC_PRICE_MAX_USD],
  );
});

test("public price tiers are monotonic: quantities rise, prices never rise", () => {
  const cases = [
    [{ price: 2.9, bulkDiscountPct: 8, bulkMinQty: 5 }],
    [{ price: 2.9, bulkDiscountPct: 8, bulkMinQty: 5 }, 0, {}],
    [{ price: 50, bulkDiscountPct: 8, bulkMinQty: 5 }],
    [{ price: 0.5, bulkDiscountPct: 60, bulkMinQty: 1 }],
    [{ price: 2.5, bulkDiscountPct: 55, minPriceUsd: 1.2, bulkMinQty: 20 }],
    [{ publicPrice: 2.349, price: 20, bulkMinQty: 100 }],
    [{ price: 0, bulkDiscountPct: 10, bulkMinQty: 5 }, 2.5],
    [{ price: 20, bulkDiscountPct: 8, bulkMinQty: 5 }, 0, { clamp: false }],
    [
      { price: 20, bulkDiscountPct: 50, bulkMinQty: 5 },
      0,
      { clamp: false, floor: 9.5 },
    ],
    [
      { price: 20, bulkDiscountPct: 50, bulkMinQty: 5 },
      0,
      { clamp: false, floor: 12 },
    ],
    [
      { price: 20, bulkDiscountPct: 10, bulkMinQty: 10 },
      0,
      { clamp: false, retail: 30 },
    ],
    [{ publicPrice: 12.5, price: 20, bulkMinQty: 5 }, 0, { clamp: false }],
    [{ price: 0.1, bulkDiscountPct: 60, bulkMinQty: 1 }, 0, { clamp: false }],
    [
      { price: 20, bulkDiscountPct: 100, bulkMinQty: 1000 },
      0,
      { clamp: false },
    ],
  ];
  for (const args of cases) {
    const tiers = publicPriceTiers(...args);
    const label = JSON.stringify(args);
    assert.ok(tiers.length >= 1, label);
    assert.equal(
      tiers[0].quantity,
      Math.max(1, Math.min(1000, args[0].bulkMinQty || 5)),
      label,
    );
    for (let i = 0; i < tiers.length; i++) {
      assert.ok(
        Number.isInteger(tiers[i].quantity) && tiers[i].quantity >= 1,
        label,
      );
      assert.ok(
        Number.isFinite(tiers[i].price) && tiers[i].price >= 0.25,
        label,
      );
      assert.equal(
        tiers[i].price,
        Math.round(tiers[i].price * 100) / 100,
        label,
      );
      if (i === 0) continue;
      assert.ok(
        tiers[i].quantity > tiers[i - 1].quantity,
        `${label}: quantity ladder`,
      );
      assert.ok(
        tiers[i].price <= tiers[i - 1].price,
        `${label}: tier ${i} ${tiers[i].price} > tier ${i - 1} ${tiers[i - 1].price}`,
      );
    }
    // Tier 0 is always the single-unit public price with the same opts.
    assert.equal(tiers[0].price, publicPriceFor(...args), label);
  }
  // Quantity ladder: minQty, max(5×minQty, 50), max(10×minQty, 100).
  assert.deepEqual(
    publicPriceTiers({ price: 2.5, bulkMinQty: 5 }).map((t) => t.quantity),
    [5, 50, 100],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 2.5, bulkMinQty: 20 }).map((t) => t.quantity),
    [20, 100, 200],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 2.5, bulkMinQty: 1000 }).map((t) => t.quantity),
    [1000, 5000, 10000],
  );
  assert.deepEqual(
    publicPriceTiers({ price: 2.5 }).map((t) => t.quantity),
    [5, 50, 100],
  );
});

test("quote quantity accepts only whole values in the public order range", () => {
  assert.equal(inquiryQuantity(25), 25);
  assert.equal(inquiryQuantity("5"), 5);
  assert.equal(inquiryQuantity(undefined), 0);
  assert.equal(inquiryQuantity(2.5), 0);
  assert.equal(inquiryQuantity(1001), 0);
});
