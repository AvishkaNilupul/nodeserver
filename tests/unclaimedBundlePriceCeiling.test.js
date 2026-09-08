// The bundle pricer had floors and no ceiling.
//
// On 2026-09-08 the unclaimed auto-lister published
//   "Rainbow Six Siege Twitch Drops (4 Items) — 3× Esports Pack 26 stage 2"  $11.75
// in a business whose highest realised sale, across 217 sales and every
// marketplace, is $4.50.
//
// The arithmetic: `pickAnchor` took `gameflip.avgSoldPrice` = $8.08 — an average
// over RIVAL Gameflip rows for "Rainbow Six Siege Twitch Drops", which include
// "SI 2026 Doc Bundle Code | 5 Items" at $9.99 and a 15-item Dokkaebi bundle at
// $29.99. Those are redeem CODES, a different product from a farmed account.
// $8.08 passed the old MAX_ANCHOR_USD of $10, the 4-item multiplier
// (1 + 0.15×3 = 1.45) took it to $11.71, and round25 made it $11.75.
//
// Two things were wrong and both are fixed here: the anchor cap was set from
// what rivals ask rather than what we are paid, and there was no final ceiling.
const test = require("node:test");
const assert = require("node:assert");

const bundles = require("../utils/unclaimedBundles");
const settings = require("../utils/settings");

const PRICING = settings.getUnclaimedPricing();

// The exact live case.
const R6_ITEMS = [
  { name: "Esports Pack 26 stage 2", qty: 3 },
  { name: "SMELLS LIKE BURNING", qty: 1 },
];
const RIVAL_CODE_RESEARCH = {
  markets: { gameflip: { soldRecent: 5, avgSoldPrice: 8.08 } },
};

test("REGRESSION: the $11.75 Rainbow Six bundle is priced from evidence", () => {
  // TWO guards now bind, in order. The $8.08 rival-code anchor is capped to
  // MAX_ANCHOR_USD $2.50 (an anchor is a base price for ONE account, and every
  // median we actually sell at is $0.75-$1.28), then the 4-item multiplier
  // 1 + 0.15x3 = 1.45 gives $3.63 -> $3.75 on the $0.25 grid. The $4.50 ceiling
  // sits above that as the last line of defence.
  const out = bundles.bundlePrice({
    research: RIVAL_CODE_RESEARCH,
    game: "Rainbow Six Siege",
    items: R6_ITEMS,
    pricing: PRICING,
  });
  assert.strictEqual(out.anchor, 2.5, "the polluted $8.08 anchor must be capped");
  assert.strictEqual(out.price, 3.75, "priced at $" + out.price + ", was $11.75");
  assert.ok(out.price <= 4.5);
});

test("the anchor cap is not itself the ceiling", () => {
  // Setting MAX_ANCHOR_USD to the $4.50 all-time max turned the cap into a
  // TARGET: every game with a polluted rival average anchored at the ceiling and
  // was then multiplied. Measured 2026-09-08, that would have raised Marvel
  // Rivals from $0.75 to $4.50. The anchor bound must sit well below the ceiling.
  const out = bundles.bundlePrice({
    research: { markets: { gameflip: { soldRecent: 5, avgSoldPrice: 999 } } },
    game: "Marvel Rivals",
    items: [{ name: "one", qty: 1 }],
    pricing: PRICING,
  });
  assert.ok(out.anchor < 4.5, "anchor cap $" + out.anchor + " must be below the ceiling");
  assert.ok(out.price < 4.5, "a 1-item bundle must not land at the ceiling");
});

test("no anchor, however absurd, can produce a price above the ceiling", () => {
  // A troll listing, a premium code bundle, a currency mix-up — the ceiling is
  // the last line and does not care why the anchor is wrong.
  for (const avgSoldPrice of [8.08, 29.99, 500, 100000]) {
    const out = bundles.bundlePrice({
      research: { markets: { gameflip: { soldRecent: 5, avgSoldPrice } } },
      game: "Rainbow Six Siege",
      items: R6_ITEMS,
      pricing: PRICING,
    });
    assert.ok(out.price <= 4.5, "anchor $" + avgSoldPrice + " produced $" + out.price);
  }
});

test("a price a set REALLY sold at still wins — evidence beats the ceiling", () => {
  // soldFloorUsd is the highest this exact set actually fetched. If a buyer paid
  // $6, $6 is real and the ceiling must not argue with it.
  const out = bundles.bundlePrice({
    research: RIVAL_CODE_RESEARCH,
    game: "Rainbow Six Siege",
    items: R6_ITEMS,
    pricing: PRICING,
    soldFloorUsd: 6,
  });
  assert.ok(out.price >= 6, "a proven $6 sale was clamped to $" + out.price);
});

test("ordinary bundles are untouched by the ceiling", () => {
  // The fix must not flatten normal pricing: a $1.25-anchored bundle should come
  // out where it always did.
  const out = bundles.bundlePrice({
    research: { markets: { gameflip: { soldRecent: 5, avgSoldPrice: 1.25 } } },
    game: "Overwatch",
    items: [{ name: "Battle Pass Tier Skip", qty: 1 }, { name: "Boba Buddy Icon", qty: 1 }],
    pricing: PRICING,
  });
  assert.ok(out.price > 0 && out.price < 4.5);
  assert.strictEqual(out.ceilingHit, false);
});

test("the floor still applies underneath the ceiling", () => {
  const out = bundles.bundlePrice({
    research: { markets: {} },
    game: "Overwatch",
    items: [{ name: "One Thing", qty: 1 }],
    pricing: { ...PRICING, floorUsd: 2 },
  });
  assert.ok(out.price >= 2, "floor breached: $" + out.price);
  assert.ok(out.price <= 4.5);
});

test("the ceiling is configurable and defaults to the measured maximum", () => {
  assert.strictEqual(
    settings.UNCLAIMED_PRICING_DEFAULTS.ceilingUsd,
    4.5,
    "the default must stay pinned to the measured all-time realised max",
  );
  const tight = bundles.bundlePrice({
    research: RIVAL_CODE_RESEARCH,
    game: "Rainbow Six Siege",
    items: R6_ITEMS,
    pricing: { ...PRICING, ceilingUsd: 2 },
  });
  assert.ok(tight.price <= 2, "a tightened ceiling was ignored: $" + tight.price);
});
