// The auto-lister must not open a second Eldorado offer for a title already on
// sale there: Eldorado bans duplicate offers, and 11 copies were live on
// 2026-10-17 because two drop sets with the same items render the same title.
const test = require("node:test");
const assert = require("node:assert");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const {
  eldoradoTitleKey,
  eldoradoSameTitleOnSale,
  publishEldoradoShare,
} = require("../utils/autoLister");

function stubActiveRows(rows) {
  const orig = MarketplaceListing.find;
  const seen = [];
  MarketplaceListing.find = (q) => {
    seen.push(q);
    return { lean: async () => rows };
  };
  return { seen, restore: () => (MarketplaceListing.find = orig) };
}

test("title key ignores case, spacing and punctuation", () => {
  assert.strictEqual(
    eldoradoTitleKey("War Robots: Frontiers Twitch Drops (9 Items) — 3,000 Credits"),
    eldoradoTitleKey("war robots frontiers twitch drops (9 items) - 3000 credits"),
  );
  assert.notStrictEqual(eldoradoTitleKey("Ravenpacks + Infusion"), eldoradoTitleKey("Ravenpacks + Infusions"));
  assert.strictEqual(eldoradoTitleKey(""), "");
});

test("finds the active Eldorado row with the same title", async () => {
  const s = stubActiveRows([
    { externalId: "a", title: "Albion Online Twitch Drops (1 Item) — Other Chest" },
    { externalId: "b", title: "Albion Online Twitch Drops (1 Item) — Dragonfire Chest" },
  ]);
  try {
    const hit = await eldoradoSameTitleOnSale("albion online twitch drops (1 item) - dragonfire chest");
    assert.strictEqual(hit.externalId, "b");
    assert.deepStrictEqual(s.seen[0], { marketplace: "eldorado", status: "active" });
    assert.strictEqual(await eldoradoSameTitleOnSale("Albion Online Twitch Drops (1 Item) — New Chest"), null);
  } finally {
    s.restore();
  }
});

test("publish refuses a duplicate title before reserving or publishing", async () => {
  const s = stubActiveRows([{ externalId: "live-1", title: "Brawlhalla Twitch Drops (1 Item) — Skin" }]);
  const origPublish = mp.eldoradoPublish;
  let published = false;
  mp.eldoradoPublish = async () => {
    published = true;
    return { id: "x" };
  };
  try {
    await assert.rejects(
      publishEldoradoShare({
        set: { _id: "s1" },
        title: "Brawlhalla Twitch Drops (1 Item) — Skin",
        description: "",
        price: 1,
        img: "",
        // An account object the reservation would touch if the guard were late.
        accounts: [{ accountId: "acc1", login: "l1" }],
        game: "Brawlhalla",
      }),
      /same title already on sale on Eldorado \(offer live-1\)/,
    );
    assert.strictEqual(published, false);
  } finally {
    mp.eldoradoPublish = origPublish;
    s.restore();
  }
});
