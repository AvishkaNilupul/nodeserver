const test = require("node:test");
const assert = require("node:assert/strict");

const {
  categoryFor,
  publicPriceFor,
  inquiryQuantity,
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

test("quote quantity accepts only whole values in the public order range", () => {
  assert.equal(inquiryQuantity(25), 25);
  assert.equal(inquiryQuantity("5"), 5);
  assert.equal(inquiryQuantity(undefined), 0);
  assert.equal(inquiryQuantity(2.5), 0);
  assert.equal(inquiryQuantity(1001), 0);
});
