// The G2G rent-farm catalogue: which terms a game is sold for, at what price,
// under which G2G category, and that every title can be read back by the
// service that fills the order (scripts/g2g-farm-listings.js,
// utils/g2gFarmShelves.js). A title the farm cannot read is a paid order
// nobody delivers; a wrong shelf is an offer no buyer finds.
const test = require("node:test");
const assert = require("node:assert/strict");

const { FARM_SHELVES, farmShelfForBrand } = require("../utils/g2gFarmShelves");
const { brandForGame } = require("../utils/g2gGames");
const { TIERS, SHORT_TERM_GAMES, tiersFor, title, description, planFor } = require("../scripts/g2g-farm-listings");
const farm = require("../utils/g2gFarmService");
const pa = require("../utils/playerauctionsFarmService");

const days = (list) => list.map((t) => t.days);

/* ------------------------------- the shelves ------------------------------ */

test("every shelf belongs to a game the farm can list on G2G, under that game's own brand", () => {
  const brands = Object.keys(FARM_SHELVES);
  assert.ok(brands.length >= 14);
  for (const brandId of brands) {
    const s = FARM_SHELVES[brandId];
    const brand = brandForGame(s.game);
    assert.ok(brand, s.game + " has no listable G2G brand");
    assert.equal(brand.brandId, brandId, s.game);
  }
});

test("a shelf is complete: a product id, and every field as an id pair with its label", () => {
  for (const [brandId, s] of Object.entries(FARM_SHELVES)) {
    assert.match(s.relationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, brandId);
    assert.ok(Array.isArray(s.fields), brandId);
    for (const f of s.fields) {
      for (const k of ["collection", "dataset", "label", "value"]) assert.ok(f[k] && typeof f[k] === "string", brandId + " " + k);
    }
    assert.equal(new Set(s.fields.map((f) => f.collection)).size, s.fields.length, brandId + ": a field twice");
  }
});

test("the shape handed to the publisher is G2G's own: id pairs, and the fields in order as the tree", () => {
  const rust = farmShelfForBrand("lgc_game_24849");
  assert.deepEqual(rust, {
    relationId: "b1c87f64-2ae9-46bd-bffa-b1a69df749be",
    attributes: [
      { collection_id: "lgc_24849_platform", dataset_id: "lgc_24849_platform_45117", value: "PC" },
      { collection_id: "dd656b0a", dataset_id: "2f7855bf", value: "Twitch Drops" },
    ],
    collectionTree: ["lgc_24849_platform", "dd656b0a"],
    text: "Platform: PC · Item Type: Twitch Drops",
  });
  // a game that asks for no field still has its product id
  const hunt = farmShelfForBrand(brandForGame("Hunt: Showdown 1896").brandId);
  assert.deepEqual([hunt.attributes, hunt.collectionTree, hunt.text], [[], [], "no category field"]);
  assert.ok(hunt.relationId);
});

test("a game with no hand-checked shelf has none, and a caller cannot edit the table", () => {
  assert.equal(farmShelfForBrand("lgc_game_0"), null);
  assert.equal(farmShelfForBrand(""), null);
  assert.equal(farmShelfForBrand(null), null);
  const a = farmShelfForBrand("lgc_game_24849");
  a.attributes[0].value = "Xbox";
  a.collectionTree.push("x");
  assert.equal(farmShelfForBrand("lgc_game_24849").attributes[0].value, "PC");
  assert.equal(farmShelfForBrand("lgc_game_24849").collectionTree.length, 2);
});

test("a farming window is never filed under a bundle's shelf", () => {
  // Rocket League also carries a bundle of ours under Wheels / Crimson / Import;
  // the window goes to the plain shelf its Twitch Drops buyers use.
  assert.equal(farmShelfForBrand(brandForGame("Rocket League").brandId).text, "Item Type: Others · Platform: PC · Colors: Default · Rarity: Default");
  assert.equal(farmShelfForBrand(brandForGame("Brawlhalla").brandId).text, "Platform: PC · Item Type: Others");
  assert.equal(farmShelfForBrand(brandForGame("Escape from Tarkov").brandId).text, "Server: [PC] PvP - Permanent · Item Type: Bundles");
});

/* -------------------------------- the terms ------------------------------- */

test("the ladder: five terms, each with its price", () => {
  assert.deepEqual(TIERS.map((t) => [t.days, t.label, t.price]), [
    [30, "30 Days", 2.49],
    [120, "120 Days", 3.99],
    [180, "180 Days", 4.99],
    [365, "1 Year", 8.99],
    [730, "2 Years", 13.99],
  ]);
  // G2G refuses an order under one dollar; no term may fall under it
  assert.ok(TIERS.every((t) => t.price >= 1));
});

test("30 days is sold only where the game's campaigns come close together", () => {
  assert.deepEqual(days(tiersFor("Marvel Rivals")), [30, 120, 180, 365, 730]);
  assert.deepEqual(days(tiersFor("  warframe ")), [30, 120, 180, 365, 730]);
  for (const g of ["Rocket League", "Rust", "Escape from Tarkov", "Sea of Thieves", "Path of Exile 2", "Hunt: Showdown 1896"])
    assert.deepEqual(days(tiersFor(g)), [120, 180, 365, 730], g);
});

test("a game nobody checked gets the longer terms only", () => {
  assert.deepEqual(days(tiersFor("Some New Game")), [120, 180, 365, 730]);
  assert.deepEqual(days(tiersFor("")), [120, 180, 365, 730]);
  assert.deepEqual(days(tiersFor(null)), [120, 180, 365, 730]);
});

test("every game sold for 30 days has a shelf, so it is filed where it should be", () => {
  const shelved = new Set(Object.values(FARM_SHELVES).map((s) => s.game.toLowerCase()));
  for (const g of SHORT_TERM_GAMES) assert.ok(shelved.has(g), g);
});

/* -------------------------- the title is the contract --------------------- */

test("every title is read back by the service that fills the order: same game, same term", () => {
  for (const s of Object.values(FARM_SHELVES)) {
    for (const t of TIERS) {
      const ti = title(s.game, t);
      assert.ok(farm.FARM_TITLE.test(ti), ti);
      assert.equal(pa.termToDays(ti), t.days, ti);
      assert.equal(ti.split(/\s+Twitch\s+Drops\b/i)[0].trim(), s.game, ti);
      assert.ok(ti.length <= 128, "G2G cuts a title at 128 characters: " + ti);
    }
  }
});

test("the description promises the same term the title sells", () => {
  for (const t of TIERS) {
    const d = description("Rust", t);
    assert.match(d, new RegExp("\\[" + t.days + " days\\]"));
    assert.match(d, /for the game Rust/);
  }
});

/* --------------------------------- the plan ------------------------------- */

test("one offer per game per term it may be sold for; a title already on the account is skipped", () => {
  const resolved = [
    { game: "Rust", brand: { brandId: "b1" }, shape: {} },
    { game: "Warframe", brand: { brandId: "b2" }, shape: {} },
  ];
  const existing = new Set(["rust twitch drops automatic farming 1 year", "warframe twitch drops automatic farming 30 days"]);
  const plan = planFor(resolved, existing);
  assert.deepEqual(plan.map((p) => p.title.replace(" Twitch Drops Automatic Farming", "") + (p.skip ? " (skip)" : "") + " $" + p.tier.price), [
    "Rust 120 Days $3.99",
    "Rust 180 Days $4.99",
    "Rust 1 Year (skip) $8.99",
    "Rust 2 Years $13.99",
    "Warframe 30 Days (skip) $2.49",
    "Warframe 120 Days $3.99",
    "Warframe 180 Days $4.99",
    "Warframe 1 Year $8.99",
    "Warframe 2 Years $13.99",
  ]);
  assert.equal(plan[0].brand.brandId, "b1");
});
