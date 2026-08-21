const test = require("node:test");
const assert = require("node:assert/strict");

const {
  categoryFor,
  publicPriceFor,
  publicPriceTiers,
  inquiryQuantity,
  publicListing,
} = require("../routes/catalogRoutes");

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

test("catalog category groups case-insensitively and keeps dominant casing", () => {
  assert.equal(
    categoryFor({
      items: [
        { game: "Dark and Darker" },
        { game: "dark and darker" },
        { game: "Dark and Darker" },
      ],
    }),
    "Dark and Darker",
  );
});

test("public listing omits account scope and credential-like fields", () => {
  const listing = publicListing(
    {
      _id: "507f1f77bcf86cd799439011",
      name: "Public bundle",
      items: [{ name: "Reward", game: "Game", qty: 1 }],
      accountScopeLogins: ["secret-login"],
      accountScopeIds: ["secret-id"],
      login: "private-login",
      password: "private-password",
      host: "private-host",
      configFile: "config_private.json",
      sourceEventName: "Event",
      catalogState: "preorder",
      expectedUnits: 2,
    },
    0,
  );
  assert.equal(Object.hasOwn(listing, "accountScopeLogins"), false);
  assert.equal(Object.hasOwn(listing, "accountScopeIds"), false);
  assert.equal(JSON.stringify(listing).includes("secret-login"), false);
  assert.equal(JSON.stringify(listing).includes("private-login"), false);
  assert.equal(JSON.stringify(listing).includes("private-password"), false);
  assert.equal(JSON.stringify(listing).includes("private-host"), false);
  assert.equal(JSON.stringify(listing).includes("config_private.json"), false);
});

test("public price honors an explicit override", () => {
  assert.equal(
    publicPriceFor({ publicPrice: 12.345, price: 20, bulkDiscountPct: 50 }),
    12.35,
  );
});

test("public price applies bulk discount without crossing the floor", () => {
  assert.equal(
    publicPriceFor({ price: 20, bulkDiscountPct: 25, minPriceUsd: 16 }),
    16,
  );
});

test("public price falls back to observed market median when retail is absent", () => {
  assert.equal(publicPriceFor({ price: 0, bulkDiscountPct: 10 }, 18), 16.2);
});

test("public price clamps malformed discount values to the supported range", () => {
  assert.equal(publicPriceFor({ price: 20, bulkDiscountPct: 100 }), 8);
  assert.equal(publicPriceFor({ price: 20, bulkDiscountPct: -20 }), 20);
});

test("public price tiers respect floors and explicit overrides", () => {
  assert.deepEqual(
    publicPriceTiers({
      price: 20,
      bulkMinQty: 10,
      bulkDiscountPct: 10,
      minPriceUsd: 17,
    }),
    [
      { quantity: 10, price: 18 },
      { quantity: 50, price: 17 },
      { quantity: 100, price: 17 },
    ],
  );
  assert.equal(
    publicPriceTiers({ price: 20, publicPrice: 12, bulkMinQty: 10 })[2].price,
    12,
  );
});

test("quote quantity accepts only whole values in the public order range", () => {
  assert.equal(inquiryQuantity(25), 25);
  assert.equal(inquiryQuantity("5"), 5);
  assert.equal(inquiryQuantity(undefined), 0);
  assert.equal(inquiryQuantity(2.5), 0);
  assert.equal(inquiryQuantity(1001), 0);
});
