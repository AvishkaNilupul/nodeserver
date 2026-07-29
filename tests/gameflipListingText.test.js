// A Gameflip auto-delivery listing carries ONE specific account, and that
// account almost always holds far more drops than the bundle advertises. The
// per-unit text generator used to fold every same-game extra into the item
// list, which is how a 5-item Overwatch bundle went live as "(56 Items)" over
// a cover image showing 5 — while the same set listed correctly as "(5 Items)"
// on GGSel, which builds its title from the set.
//
// The rule these tests lock in: the item COUNT and headline are the set's, so
// title, description and cover image always agree; the account's extras are
// disclosed in the bonus block instead of inflating the count.
const test = require("node:test");
const assert = require("node:assert");

const DropLog = require("../models/DropLog");
const { accountListingText } = require("../utils/gameflipFulfiller");

const OW = "Overwatch 2";

// The real 5-item set behind listing eeaca423-60c8-4df6-ad0b-b6282375cc93.
const SET = {
  items: [
    { itemKey: "owcs msc gilded 2026 icon|overwatch 2", name: "OWCS MSC Gilded 2026 Icon", game: OW, qty: 1 },
    { itemKey: "bp tier skip msc day 1|overwatch 2", name: "BP Tier Skip MSC Day 1", game: OW, qty: 1 },
    { itemKey: "msc 2026 spray|overwatch 2", name: "MSC 2026 Spray", game: OW, qty: 1 },
    { itemKey: "msc name card|overwatch 2", name: "MSC Name Card", game: OW, qty: 1 },
    { itemKey: "loot box|overwatch 2", name: "Loot Box", game: OW, qty: 1 },
  ],
};

// Stand in for the DropLog aggregation: `rows` are the account's unclaimed
// drops as the real pipeline groups them.
function withDrops(rows, fn) {
  const real = DropLog.aggregate;
  DropLog.aggregate = async () => rows;
  return fn().finally(() => {
    DropLog.aggregate = real;
  });
}
const row = (name, game, qty = 1) => ({
  _id: { key: name.toLowerCase() + "|" + game.toLowerCase(), name, game },
  qty,
});

// The account that produced the bad listing: holds the bundle plus 51 more
// Overwatch drops from every other campaign the bot farmed.
const fatAccount = () => [
  ...SET.items.map((i) => row(i.name, OW)),
  ...Array.from({ length: 51 }, (_, n) => row("Extra OW Cosmetic " + n, OW)),
];

test("the item count is the set's, not everything the account happens to hold", async () => {
  await withDrops(fatAccount(), async () => {
    const { title } = await accountListingText(SET, "acc1", "fb", "fb");
    assert.match(title, /\(5 Items\)/);
    assert.doesNotMatch(title, /56 Items/);
    // Same headline the set-built GGSel listing uses.
    assert.strictEqual(
      title,
      "Overwatch 2 Twitch Drops (5 Items) — OWCS MSC Gilded 2026 Icon + " +
        "BP Tier Skip MSC Day 1 +3 more",
    );
  });
});

test("extras are disclosed as bonus instead of inflating the advertised list", async () => {
  await withDrops(fatAccount(), async () => {
    const { description } = await accountListingText(SET, "acc1", "fb", "fb");
    const includes = description.slice(
      description.indexOf("Includes:"),
      description.indexOf("🎁"),
    );
    // Exactly the five advertised items sit above the bonus block.
    assert.strictEqual(includes.match(/^- /gm).length, 5);
    assert.match(includes, /- Loot Box \(Overwatch 2\)/);
    assert.doesNotMatch(includes, /Extra OW Cosmetic/);
    // ...and the 51 extras are still shown, just below the line.
    assert.match(description, /Bonus — this account also has these extra unclaimed drops:/);
    assert.match(description, /- Extra OW Cosmetic 0 \(Overwatch 2\)/);
  });
});

test("other games are still disclosed, after the same-game extras", async () => {
  const rows = [
    ...SET.items.map((i) => row(i.name, OW)),
    row("Zombie Skin", "Call of Duty"),
    row("Overwatch Leftover", OW),
  ];
  await withDrops(rows, async () => {
    const { title, description } = await accountListingText(SET, "acc1", "fb", "fb");
    assert.match(title, /\(5 Items\)/);
    const bonus = description.slice(description.indexOf("🎁"));
    assert.ok(
      bonus.indexOf("Overwatch Leftover") < bonus.indexOf("Zombie Skin"),
      "same-game extras should lead the bonus block",
    );
  });
});

test("a real extra copy still shows the account's higher quantity", async () => {
  const rows = [
    ...SET.items.filter((i) => i.name !== "Loot Box").map((i) => row(i.name, OW)),
    row("Loot Box", OW, 3),
  ];
  await withDrops(rows, async () => {
    const { title, description } = await accountListingText(SET, "acc1", "fb", "fb");
    // Quantity is not item count — the bundle is still five things.
    assert.match(title, /\(5 Items\)/);
    assert.match(description, /- 3× Loot Box \(Overwatch 2\)/);
  });
});

test("an unreadable account falls back to the caller's set-built text", async () => {
  await withDrops([], async () => {
    const t = await accountListingText(SET, "acc1", "set title", "set description");
    assert.deepStrictEqual(t, { title: "set title", description: "set description" });
  });
});
