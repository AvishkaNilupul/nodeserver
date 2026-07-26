// Unit tests for the auto-lister's pure logic: house-style titles and
// descriptions, market-research pricing, and post-event bundle stacking.
const test = require("node:test");
const assert = require("node:assert");
const {
  buildTitle,
  buildDescription,
  derivePrice,
  stackItems,
  stackedPrice,
  computeSplit,
} = require("../utils/autoLister");

const items = [
  { itemKey: "a|g", name: "Heidel Chest", game: "Black Desert", qty: 1 },
  { itemKey: "b|g", name: "Shiny Golden Seal", game: "Black Desert", qty: 1 },
  { itemKey: "c|g", name: "Cron Stone x100", game: "Black Desert", qty: 1 },
];

test("title follows house style with item names and count", () => {
  const t = buildTitle({
    game: "Black Desert",
    items,
    campaignName: "Heidel Ball",
  });
  assert.ok(t.startsWith("Black Desert Twitch Drops (3 Items)"));
  assert.ok(t.includes("Heidel Chest + Shiny Golden Seal"));
  assert.ok(t.includes("+1 more"));
  assert.ok(t.length <= 120);
});

test("post-event title leads with EVENT ENDED", () => {
  const t = buildTitle({
    game: "Rust",
    items: items.slice(0, 1),
    postEvent: true,
  });
  assert.ok(t.startsWith("[EVENT ENDED] Rust Twitch Drops (1 Item)"));
});

test("title never exceeds Gameflip's 120-char limit", () => {
  const long = Array.from({ length: 8 }, (_, i) => ({
    itemKey: "k" + i,
    name: "An Extremely Long Legendary Item Name Number " + i,
    game: "Some Very Long Game Name Here",
  }));
  const t = buildTitle({ game: "Some Very Long Game Name Here", items: long });
  assert.ok(t.length <= 120);
});

test("description lists every item and the house sections", () => {
  const d = buildDescription({
    game: "Black Desert",
    items,
    campaignName: "Heidel Ball",
  });
  for (const i of items) assert.ok(d.includes(i.name));
  assert.ok(d.includes("Includes:"));
  assert.ok(d.includes("check the item list carefully"));
  assert.ok(d.includes("within the first hour"));
  assert.ok(!d.includes("unobtainable"));
  assert.ok(!d.includes("EVENT IS OVER"));
});

test("post-event description leads with scarcity and drops the countdown", () => {
  const d = buildDescription({
    game: "Rust",
    items,
    campaignName: "Twitch Rivals",
    postEvent: true,
  });
  assert.ok(d.startsWith("THE Twitch Rivals DROP EVENT IS OVER"));
  assert.ok(d.includes("no longer be earned"));
  assert.ok(d.includes("still redeem"));
  assert.ok(!d.includes("unobtainable"));
});

test("price anchors on sold prices and undercuts live competition", () => {
  const research = {
    markets: {
      gameflip: { soldRecent: 5, avgSoldPrice: 4.0, lowest: 3.0 },
      ggsel: { lowest: 5.0 },
      plati: { lowest: 6.0 },
    },
  };
  // Undercut the $3.00 live Gameflip rival by 5% -> 2.85 -> $2.75, which is
  // still under the $4.00 buyers actually paid.
  assert.strictEqual(derivePrice(research), 2.75);
});

// The bug this guards: GGSel and Plati are ruble-denominated marketplaces. On
// prod, ggsel.lowest was $0.38 and plati.lowest $1.28 (Plati's ~100 RUB floor)
// while the cheapest live GAMEFLIP rival for the same game was $1.20. Taking
// Math.min across all three let a ruble floor price a USD listing, undercut it,
// and hit Gameflip's $0.75 clamp — so Rocket League, with 20 verified sales
// averaging $7.93, was listed at $0.75.
test("a cheap ruble-market floor never drags down a Gameflip price", () => {
  const rocketLeague = {
    markets: {
      gameflip: { soldRecent: 20, avgSoldPrice: 7.93, lowest: 1.2 },
      ggsel: { lowest: 0.38 },
      plati: { lowest: 1.28 },
    },
  };
  assert.strictEqual(derivePrice(rocketLeague), 1.25);
});

// A thin sample can be a multi-account bundle rather than our single-account
// product: Hunt: Showdown shows $28.20 over 5 sales while its cheapest live
// listing is $0.75. The anchor must not run away with that.
test("a thin or outlier sold-price sample never inflates the price", () => {
  const thin = {
    markets: { gameflip: { soldRecent: 2, avgSoldPrice: 50, lowest: 2.0 } },
  };
  // 2 sales is below MIN_SOLD_SAMPLES, so the anchor is ignored entirely and
  // the live rival prices it.
  assert.strictEqual(derivePrice(thin), 2.0);

  const outlier = {
    markets: { gameflip: { soldRecent: 5, avgSoldPrice: 28.2, lowest: 0.75 } },
  };
  // Enough samples, but the live rival is cheaper, so we still undercut it.
  assert.strictEqual(derivePrice(outlier), 0.75);

  const noRival = {
    markets: { gameflip: { soldRecent: 5, avgSoldPrice: 28.2, lowest: 0 } },
  };
  // No competition at all: the anchor stands, but capped at MAX_ANCHOR_USD.
  assert.strictEqual(derivePrice(noRival), 10);
});

test("price falls back to cheapest competitor when nothing sold", () => {
  const research = {
    markets: { plati: { lowest: 2.0 }, ggsel: { lowest: 4.0 } },
  };
  assert.strictEqual(derivePrice(research), 2.0);
});

test("unknown market probes at $1 and floor is $0.75", () => {
  assert.strictEqual(derivePrice(null), 1.0);
  const cheap = { markets: { gameflip: { avgSoldPrice: 0.3, lowest: 0.2 } } };
  assert.strictEqual(derivePrice(cheap), 0.75);
});

test("post-event multiplier applies the scarcity markup", () => {
  const research = {
    markets: { gameflip: { avgSoldPrice: 2.0, lowest: 2.0 } },
  };
  assert.ok(
    derivePrice(research, { postEventMultiplier: 1.5 }) > derivePrice(research),
  );
});

test("stacking unions items across sets without duplicates", () => {
  const sets = [
    { items: [items[0], items[1]] },
    { items: [items[1], items[2]] },
  ];
  const merged = stackItems(sets);
  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(merged.map((i) => i.itemKey).sort(), [
    "a|g",
    "b|g",
    "c|g",
  ]);
});

test("stacked price sums campaign prices and applies +50%", () => {
  assert.strictEqual(stackedPrice([2.0, 3.0]), 7.5);
  assert.strictEqual(stackedPrice([0, 0]), 1.5);
});

test("hold-back split lists half now (rounded up), holds the rest", () => {
  assert.deepStrictEqual(computeSplit(6), { listNow: 3, holdBack: 3 });
  assert.deepStrictEqual(computeSplit(5), { listNow: 3, holdBack: 2 });
  assert.deepStrictEqual(computeSplit(3), { listNow: 2, holdBack: 1 });
  assert.deepStrictEqual(computeSplit(2), { listNow: 1, holdBack: 1 });
});

test("hold-back split never holds when there is only one account", () => {
  assert.deepStrictEqual(computeSplit(1), { listNow: 1, holdBack: 0 });
  assert.deepStrictEqual(computeSplit(0), { listNow: 0, holdBack: 0 });
});
