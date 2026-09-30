// A rent-farm window can be sold for a game whose first campaign the drop
// scanner has not recorded yet.
//
// 2026-09-30: AION 2 opened global early access with NC's "War for Atreia"
// Twitch drops event, but no campaign had reached our scanner, so
// parseFarmOrder refused "AION 2 Twitch Drops Automatic Farming …" titles — an
// order would have sat failed while the buyer waited. The announced list makes
// the game known for rent-farm parsing without inventing campaign data that
// the auto-farmer and the drops archive also read.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function load(db) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /eldoradoFarmService\.js$/.test(parent.filename || "");
    if (from && request === "../models/AutoFarmTask") {
      return { distinct: async () => db.tasks() };
    }
    if (from && request === "../models/CampaignDrops") {
      return { distinct: async () => db.campaigns() };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/eldoradoFarmService");
    delete require.cache[p];
    const mod = require("../utils/eldoradoFarmService");
    delete require.cache[p];
    return { mod, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

const liveDb = () => ({ tasks: () => ["Rust", "Overwatch"], campaigns: () => ["Warframe", "Rust"] });
const order = (title) => ({ orderOfferDetails: { offerTitle: title } });

test("AION 2 is a known farm game before any campaign is recorded", async () => {
  const { mod, restore } = load(liveDb());
  try {
    const games = await mod.knownFarmGames();
    assert.deepStrictEqual(games, ["Rust", "Overwatch", "Warframe", "AION 2"]);
  } finally { restore(); }
});

test("REGRESSION 2026-09-30: an AION 2 rent-farm title parses to its game and term", async () => {
  const { mod, restore } = load(liveDb());
  try {
    const p = await mod.parseFarmOrder(order("AION 2 Twitch Drops Automatic Farming 30 Days"));
    assert.strictEqual(p.game, "AION 2", "the pin must be Twitch's own spelling");
    assert.strictEqual(p.days, 30);
    const y = await mod.parseFarmOrder(order("Aion 2 Twitch Drops Automatic Farming 1 Year"));
    assert.strictEqual(y.game, "AION 2", "a buyer-facing casing still resolves to the canonical name");
    assert.strictEqual(y.days, 365);
  } finally { restore(); }
});

test("a game neither seen nor announced is still refused", async () => {
  const { mod, restore } = load(liveDb());
  try {
    const p = await mod.parseFarmOrder(order("Made Up Game Twitch Drops Automatic Farming 180 Days"));
    assert.strictEqual(p.game, "");
  } finally { restore(); }
});

test("once the scanner has seen it, the announced name is not duplicated", async () => {
  const { mod, restore } = load({ tasks: () => ["Rust"], campaigns: () => ["AION 2"] });
  try {
    const games = await mod.knownFarmGames();
    assert.strictEqual(games.filter((g) => g.toLowerCase() === "aion 2").length, 1);
  } finally { restore(); }
});

test("a failed read is never cached as 'only the announced games'", async () => {
  // An empty read is a failed read. Caching ["AION 2"] alone would refuse every
  // other rent-farm order for half an hour.
  let healthy = false;
  const { mod, restore } = load({
    tasks: () => (healthy ? ["Overwatch"] : []),
    campaigns: () => (healthy ? ["Rust"] : []),
  });
  try {
    assert.deepStrictEqual(await mod.knownFarmGames(), ["AION 2"]);
    healthy = true;
    const games = await mod.knownFarmGames();
    assert.ok(games.includes("Overwatch") && games.includes("Rust"), "the next read must reach the DB");
  } finally { restore(); }
});
