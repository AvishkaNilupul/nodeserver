const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const pricing = require("../utils/bulkPacks/pricing");

const reviewedPacks = [
  { anchor: 0.23, discountPct: 5, expected: 1.09 },
  { anchor: 0.74, discountPct: 5, expected: 3.51 },
  { anchor: 0.49, discountPct: 5, expected: 2.32 },
  { anchor: 0.29, discountPct: 5, expected: 1.37 },
  { anchor: 0.23, discountPct: 20, expected: 0.92 },
];

test("Rocket League default pack quotes match all five reviewed whole-pack prices", () => {
  for (const { anchor, discountPct, expected } of reviewedPacks) {
    const options = {
      anchor,
      discountPct,
      size: 5,
      market: "eldorado",
      game: "Rocket League",
    };
    assert.equal(pricing.packPriceFor(options), expected);
    assert(expected <= anchor * 5 * (1 - discountPct / 100) + 1e-9);
    const [quote] = pricing.tierQuote({
      ...options,
      tiers: [{ minQty: 5, discountPct }],
    });
    assert.equal(quote.packPrice, expected);
    assert.equal(
      quote.unitPrice,
      pricing.perAccountPrice({ packPrice: expected, size: 5 }),
    );
  }
});

test("Rocket League cent rounding keeps exact cents and the pack floor", () => {
  assert.equal(
    pricing.packPriceFor({
      anchor: 0.3,
      discountPct: 0,
      size: 5,
      market: "eldorado",
      game: " rocket league ",
    }),
    1.5,
  );
  assert.equal(
    pricing.packPriceFor({
      anchor: 0.23,
      discountPct: 60,
      size: 2,
      market: "eldorado",
      game: "Rocket League",
    }),
    0.5,
  );
});

test("other games, markets, farming and custom pack maths retain their prices", () => {
  assert.equal(
    pricing.packPriceFor({
      anchor: 0.74,
      discountPct: 5,
      size: 5,
      market: "eldorado",
      game: "Rust",
    }),
    3.52,
  );
  assert.equal(
    pricing.packPriceFor({
      anchor: 0.74,
      discountPct: 5,
      size: 5,
      market: "g2g",
      game: "Rocket League",
    }),
    3.52,
  );
  assert.equal(
    pricing.packPriceFor({
      anchor: 0.74,
      discountPct: 5,
      size: 5,
      market: "gameflip",
      game: "Rocket League",
    }),
    3.5,
  );
  assert.equal(
    pricing.farmPackPrice({
      farmPrices: { eldorado: { 30: 0.74 } },
      market: "eldorado",
      days: 30,
      discountPct: 5,
      size: 5,
    }),
    3.52,
  );
  assert.equal(pricing.customPackPrice({ unitPrice: 0.703, size: 5 }), 3.52);
});

function connector(game = "Rocket League") {
  const calls = [];
  const fixture = {
    id: "test-offer",
    offerTitle: "Test bundle",
    description: "Test contents",
    tradeEnvironmentValues: [
      { id: game === "Rocket League" ? "9" : "11", name: "Game", value: game },
    ],
    quantity: 19,
    minQuantity: 1,
    pricePerUnit: { amount: 1, currency: "USD" },
    mainOfferImage: { largeImage: "testLarge.jpg" },
    volumeDiscounts: [],
  };
  const fakeAxios = async (cfg) => {
    calls.push(cfg);
    const url = String(cfg.url);
    if (url.includes("/api/library/"))
      return {
        data: { tradeEnvironments: [fixture.tradeEnvironmentValues[0]] },
        headers: {},
      };
    if (url.endsWith("/api/files/me/Offer"))
      return {
        data: {
          localPaths: ["testSmall.jpg", "testLarge.jpg", "testOriginal.jpg"],
        },
        headers: {},
      };
    if (url.endsWith("/private"))
      return { data: { offer: fixture }, headers: {} };
    if (url.endsWith("/me/offers/item"))
      return { data: { id: "created-test-offer" }, headers: {} };
    return { data: {}, headers: {} };
  };
  const store = {
    marketplaces: { eldorado: { cookie: "test-session=value" } },
  };
  const mpPath = require.resolve("../utils/marketplaces");
  const settingsPath = require.resolve("../utils/settings");
  const secretPath = require.resolve("../utils/secretBox");
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === mpPath) {
      if (request === "axios") return fakeAxios;
      if (request === "fs")
        return {
          ...require("node:fs"),
          createReadStream: () => Buffer.from("test image"),
        };
      if (Module._resolveFilename(request, parent, isMain) === settingsPath)
        return {
          loadSettings: () => store,
          saveSettings: async () => assert.fail("Unexpected settings write"),
        };
      if (Module._resolveFilename(request, parent, isMain) === secretPath)
        return { encrypt: (x) => x, decrypt: (x) => x };
    }
    return original.apply(this, arguments);
  };
  let mp;
  delete require.cache[mpPath];
  try {
    mp = require(mpPath);
  } finally {
    Module._load = original;
    delete require.cache[mpPath];
  }
  return { mp, calls };
}

test("Eldorado publishes reviewed Rocket League single prices without a $0.50 uplift", async () => {
  for (const price of [0.23, 0.29, 0.49, 1.49, 1.59]) {
    const { mp, calls } = connector();
    await mp.eldoradoPublish({
      game: "Rocket League",
      title: "Test bundle",
      description: "Test contents",
      priceUsd: price,
      quantity: 19,
      coverImagePath: __filename,
    });
    const request = calls.find((c) => c.url.endsWith("/me/offers/item"));
    assert.equal(request.data.details.pricing.pricePerUnit.amount, price);
    assert.equal(request.data.details.pricing.pricePerUnit.currency, "USD");
    assert.equal(request.data.details.pricing.quantity, 19);
  }
});

test("Eldorado preserves its existing publish floor for other games", async () => {
  const { mp, calls } = connector("Other");
  await mp.eldoradoPublish({
    game: "Rust",
    title: "Test bundle",
    priceUsd: 0.29,
    coverImagePath: __filename,
  });
  assert.equal(
    calls.find((c) => c.url.endsWith("/me/offers/item")).data.details.pricing
      .pricePerUnit.amount,
    0.5,
  );
});

test("Eldorado offer edits preserve Rocket League low prices and stock", async () => {
  const { mp, calls } = connector();
  await mp.eldoradoUpdateOffer("test-offer", { priceUsd: 0.23 });
  const request = calls.find((c) => c.url.endsWith("/details"));
  assert.equal(request.data.details.pricing.pricePerUnit.amount, 0.23);
  assert.equal(request.data.details.pricing.quantity, 19);
});

test("Eldorado repricing checks the actual offer game before using a low price", async () => {
  for (const [game, expected] of [
    ["Rocket League", 0.29],
    ["Other", 0.5],
  ]) {
    const { mp, calls } = connector(game);
    await mp.eldoradoReprice("test-offer", 0.29);
    assert(calls.some((c) => c.url.endsWith("/private")));
    assert.equal(
      calls.find((c) => c.url.endsWith("/price")).data.amount,
      expected,
    );
  }
});

test("Eldorado regular repricing needs no additional game read", async () => {
  const { mp, calls } = connector();
  await mp.eldoradoReprice("test-offer", 1.59);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.amount, 1.59);
});
