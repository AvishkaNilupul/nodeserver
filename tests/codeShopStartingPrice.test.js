const test = require("node:test");
const assert = require("node:assert/strict");
const { startingPriceUsd } = require("../utils/codeShop/startingPrice");
const slots = (...labels) => labels.map((label) => ({ label }));

test("Overwatch skin rewards take the premium tier over boxes", () => {
  assert.equal(startingPriceUsd("12", slots("OWCS Home Sombra Skin", "Esports Loot Box #1 (Event 30 Oct 2026)")), 1.99);
  assert.equal(startingPriceUsd(12, slots("OWCS Away Sombra Skin")), 1.99);
});

test("multi-code box bundles get the middle tier; a single box stays $1", () => {
  assert.equal(startingPriceUsd("12", slots("Autumn Vibes Name Card", "Banana Cat Icon", "Esports Loot Box")), 1.49);
  assert.equal(startingPriceUsd("12", slots("Epic Lootbox", "Prost Spray")), 1.49);
  assert.equal(startingPriceUsd("12", slots("Epic Loot Box")), 1);
});

test("sprays/icons, unknown labels and other games do not inherit the premium", () => {
  assert.equal(startingPriceUsd("12", slots("Prost Spray", "Skal Spray")), 1);
  assert.equal(startingPriceUsd("12", slots("Skin Player Icon", "Loot Box Spray")), 1);
  assert.equal(startingPriceUsd("12", [{ label: "", campaignTitle: "Legendary Skin", nameRaw: "Skin" }]), 1);
  assert.equal(startingPriceUsd("12", null), 1);
  assert.equal(startingPriceUsd("200", slots("Operator Skin", "Loot Box")), 1);
  assert.equal(startingPriceUsd("930003", slots("Tank Skin", "Loot Box")), 1);
});
