// Fix 12 (2026-10-01): an order's account count / game / term are frozen once
// anything is provisioned against it, and the G2G / PlayerAuctions game match
// picks the most specific known name, never a name that folds to nothing, and
// sells announced launch-week games like Eldorado does.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freezeOrder } = require("../utils/farmProvisioning");
const pa = require("../utils/playerauctionsFarmService");

test("before anything is held the fresh reading is used — and recorded", () => {
  const row = { quantity: 1, accounts: [], game: "Overwatch", days: 30 };
  const fz = freezeOrder(row, { qty: 10, game: "Overwatch", days: 30 });
  assert.equal(fz.frozen, false);
  assert.equal(fz.qty, 10);
  assert.equal(row.quantity, 10, "the reading is what the order is for now");
});

test("REGRESSION: once accounts are held, a re-read pack size (offer edited / closed) cannot change the order", () => {
  const row = { quantity: 10, accounts: [{ login: "a1" }, { login: "a2" }, { login: "a3" }], game: "Overwatch", days: 30 };
  // The bulk offer closed: the fresh reading says 1 account, and no game.
  const fz = freezeOrder(row, { qty: 1, game: "", days: 0 });
  assert.equal(fz.frozen, true);
  assert.equal(fz.qty, 10, "tops up to the 10 sold, not 1");
  assert.equal(fz.game, "Overwatch");
  assert.equal(fz.days, 30);
  assert.equal(row.quantity, 10);
});

test("the most specific known game wins; a name that folds to nothing never matches", async () => {
  const known = ["Call of Duty", "Call of Duty: Warzone", "Overwatch", "原神", "Hunt: Showdown 1896", "Hunt: Showdown Classic"];
  assert.equal(await pa.canonicalGame("Call of Duty: Warzone 2", known), "Call of Duty: Warzone", "not the umbrella");
  assert.equal(await pa.canonicalGame("Call of Duty: Modern Warfare 4", known), "Call of Duty");
  assert.equal(await pa.canonicalGame("Hunt: Showdown", known), "Hunt: Showdown 1896", "the closest longer name");
  assert.equal(await pa.canonicalGame("Brand New Game Title", known), "", "a folded-to-nothing known name is no prefix of everything");
  assert.equal(await pa.canonicalGame("ÅÅÅÅÅÅ", known), "", "a title that strips to nothing matches nothing");
});

test("announced launch-week games sell on G2G / PlayerAuctions too", async () => {
  const AutoFarmTask = require("../models/AutoFarmTask");
  const CampaignDrops = require("../models/CampaignDrops");
  const realA = AutoFarmTask.distinct;
  const realC = CampaignDrops.distinct;
  AutoFarmTask.distinct = async () => ["Overwatch"];
  CampaignDrops.distinct = async () => [];
  try {
    const list = await pa.knownFarmGames();
    const { ANNOUNCED_FARM_GAMES } = require("../utils/eldoradoFarmService");
    for (const g of ANNOUNCED_FARM_GAMES) assert.ok(list.includes(g), g + " is sellable");
    assert.equal(await pa.canonicalGame("AION 2", list), "AION 2");
  } finally {
    AutoFarmTask.distinct = realA;
    CampaignDrops.distinct = realC;
  }
});
