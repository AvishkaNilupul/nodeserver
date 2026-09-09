// The shared pricing engine (utils/pricing.js).
//
// The case that forced this module into existence is pinned first: a catalog
// profile for World of Tanks carrying 40 rewards was priced at $227.86 by a
// LINEAR `catalogRate * rewards` in routes/catalogRoutes.js, in a business
// whose highest realised sale on record is $4.50.
const test = require("node:test");
const assert = require("node:assert");

const {
  DEFAULTS,
  MARKETPLACE_FLOORS,
  bundleMultiplier,
  floorForMarketplace,
  median,
  priceBand,
  priceListing,
  resolveAnchor,
  shouldReprice,
} = require("../utils/pricing");

// Real prod evidence, 2026-09-08: every priced Gameflip sale bucket.
const GAMEFLIP_SALES = [0.75, 0.75, 1, 1.25, 1.25, 1.25, 1.5, 1.75, 2.75];

/* --------------------------- the regression case ------------------------- */

test("REGRESSION: a 40-item bundle can never be priced at $227", () => {
  const out = priceListing({
    evidence: { platformGame: GAMEFLIP_SALES },
    itemCount: 40,
  });
  assert.ok(out.price < 10, "40-item bundle priced at $" + out.price);
  // Against a $2.75 observed max the ceiling is $5.50, and the sqrt curve on a
  // $1.25 median ($1.25 x 1.937) lands well under it.
  assert.equal(out.price, 2.42);
});

test("REGRESSION: linear scaling is gone — 40 items is not 40x one item", () => {
  const one = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: 1 });
  const forty = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: 40 });
  const ratio = forty.price / one.price;
  assert.ok(ratio > 1, "a fat bundle must be worth more than a single");
  assert.ok(ratio <= DEFAULTS.bundleCapMult, "ratio " + ratio + " exceeded the cap");
});

test("REGRESSION: even absurd evidence cannot escape the absolute backstop", () => {
  // A corrupt/poisoned evidence row is the failure mode the backstop exists for.
  const out = priceListing({
    evidence: { platformGame: [5000, 5000, 5000] },
    itemCount: 40,
  });
  assert.equal(out.price, DEFAULTS.maxAbsoluteUsd);
  assert.equal(out.clamped, "absolute");
});

/* ---------------------------- bundle multiplier -------------------------- */

test("bundle multiplier is 1x for a single item", () => {
  assert.equal(bundleMultiplier(1), 1);
  assert.equal(bundleMultiplier(0), 1);
  assert.equal(bundleMultiplier(-5), 1);
});

test("bundle multiplier grows sub-linearly and is capped", () => {
  const at5 = bundleMultiplier(5);
  const at10 = bundleMultiplier(10);
  const at40 = bundleMultiplier(40);
  assert.ok(at5 < at10 && at10 < at40, "must be monotonic");
  // Sub-linear: doubling items must NOT double the multiplier's excess.
  assert.ok(at10 - 1 < 2 * (at5 - 1), "growth is not sub-linear");
  assert.ok(at40 <= DEFAULTS.bundleCapMult);
});

test("bundle multiplier honours the cap exactly", () => {
  const capped = bundleMultiplier(100000, { bundleCapMult: 1.5 });
  assert.equal(capped, 1.5);
});

/* -------------------------------- anchoring ------------------------------ */

test("the anchor ladder prefers this platform + this game", () => {
  const out = resolveAnchor({
    platformGame: [2, 2, 2],
    game: [9, 9, 9],
    platform: [7, 7, 7],
    global: [5, 5, 5],
  });
  assert.equal(out.basis, "platformGame");
  assert.equal(out.anchor, 2);
});

test("a game-specific RIVAL outranks cross-game own-sales aggregates", () => {
  // The ordering bug this pins: `global` is never empty, so putting it above
  // the rival signal meant the rival could never be reached and every unproven
  // game collapsed onto one business-wide number (League of Legends fell from
  // $4.75 to $1.63). A rival's asking price for THIS game beats a realised sale
  // of a DIFFERENT game.
  const out = resolveAnchor({
    platform: [1.6, 1.6, 1.6],
    global: [1.6, 1.6, 1.6],
    rivalLowest: 5,
  });
  assert.equal(out.basis, "rival");
  assert.equal(out.anchor, 4.75);
});

test("but own sales for THIS game still outrank the rival", () => {
  const out = resolveAnchor({
    game: [2, 2, 2],
    rivalLowest: 50,
  });
  assert.equal(out.basis, "game");
  assert.equal(out.anchor, 2);
});

test("cross-game aggregates are still used when nothing game-specific exists", () => {
  const out = resolveAnchor({ platform: [3, 3, 3], global: [1, 1, 1] });
  assert.equal(out.basis, "platform");
  assert.equal(out.anchor, 3);
});

test("a bucket too thin to trust is skipped, not blended", () => {
  // One lucky $28 bundle sale must not set the price for the whole game.
  const out = resolveAnchor({
    platformGame: [28.2],
    game: [1.25, 1.25, 1.25, 1.5],
  });
  assert.equal(out.basis, "game");
  assert.equal(out.anchor, 1.25);
});

test("with no own sales it undercuts the live rival", () => {
  const out = resolveAnchor({ rivalLowest: 2 });
  assert.equal(out.basis, "rival");
  assert.equal(out.anchor, 1.9); // 5% undercut
});

test("with no evidence at all it reports none rather than guessing", () => {
  const out = resolveAnchor({});
  assert.equal(out.basis, "none");
  assert.equal(out.anchor, 0);
});

test("a no-evidence listing holds at the floor", () => {
  const out = priceListing({ evidence: {} });
  assert.equal(out.price, DEFAULTS.floorUsd);
  assert.equal(out.basis, "none");
});

/* --------------------------------- the band ------------------------------ */

test("the ceiling is derived from the highest realised sale", () => {
  const band = priceBand({ platformGame: [1, 2, 4] });
  assert.equal(band.observedMax, 4);
  assert.equal(band.ceiling, 8); // headroom 2x
});

test("the ceiling rises as real evidence arrives", () => {
  const before = priceBand({ platformGame: [1, 2, 3] }).ceiling;
  const after = priceBand({ platformGame: [1, 2, 3, 6] }).ceiling;
  assert.ok(after > before, "ceiling must widen with real sales");
});

test("with no realised sale anywhere the backstop is the ceiling", () => {
  const band = priceBand({});
  assert.equal(band.ceiling, DEFAULTS.maxAbsoluteUsd);
  assert.equal(band.ceilingSource, "absolute");
});

test("the band names which constraint is binding", () => {
  // Evidence well under the backstop: the market is the constraint.
  assert.equal(priceBand({ platformGame: [1, 2, 4] }).ceilingSource, "evidence");
  // Evidence implying a ceiling above the backstop: the safety net is, and
  // that is a signal the inputs are wrong rather than a pricing decision.
  assert.equal(priceBand({ platformGame: [5000] }).ceilingSource, "absolute");
});

test("the ceiling clamp is reported so an operator can see why", () => {
  const out = priceListing({
    evidence: { platformGame: [1, 1, 1] },
    itemCount: 40,
    opts: { bundleCapMult: 100, bundleStepPct: 500 },
  });
  assert.equal(out.clamped, "ceiling");
  assert.equal(out.price, 2); // observed max 1 x headroom 2
});

/* ------------------------------- sold floor ------------------------------ */

test("a set never prices below what it actually sold at", () => {
  const out = priceListing({
    evidence: { platformGame: GAMEFLIP_SALES },
    itemCount: 1,
    soldFloorUsd: 3,
  });
  assert.equal(out.price, 3);
  assert.equal(out.clamped, "sold-floor");
});

test("the sold floor may exceed the evidence ceiling — a real sale outranks a model", () => {
  const out = priceListing({
    evidence: { platformGame: [1, 1, 1] }, // ceiling $2
    soldFloorUsd: 8,
  });
  assert.equal(out.price, 8);
});

test("but the sold floor still yields to the absolute backstop", () => {
  const out = priceListing({
    evidence: { platformGame: [1, 1, 1] },
    soldFloorUsd: 9999,
  });
  assert.equal(out.price, DEFAULTS.maxAbsoluteUsd);
  assert.equal(out.clamped, "absolute");
});

/* ------------------------------- full event ------------------------------ */

test("a complete event bundle earns its premium", () => {
  const partial = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: 5 });
  const full = priceListing({
    evidence: { platformGame: GAMEFLIP_SALES },
    itemCount: 5,
    fullEvent: true,
  });
  assert.ok(full.price > partial.price);
  assert.equal(full.fullEvent, true);
});

/* -------------------------------- reprice -------------------------------- */

test("small drift does not trigger a reprice", () => {
  assert.equal(shouldReprice(1.25, 1.3, 20), false);
});

test("large drift does", () => {
  assert.equal(shouldReprice(1.25, 2.5, 20), true);
  assert.equal(shouldReprice(2.5, 1.25, 20), true);
});

test("a missing price never triggers a reprice", () => {
  assert.equal(shouldReprice(0, 5, 20), false);
  assert.equal(shouldReprice(5, 0, 20), false);
});

/* --------------------------------- median -------------------------------- */

test("median ignores zero and negative rows", () => {
  assert.equal(median([0, -1, 2, 4, 6]), 4);
  assert.equal(median([]), 0);
});

test("median averages the middle pair on an even count", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

/* ------------------------- calibration guardrails ------------------------ */

// Prod's realised sales show a FLAT median across bundle size (~$1.25 whether
// the account holds 1 drop or 58; r = 0.327) with only the upper tail rising
// to $4.50. These pin the curve inside that envelope so a future "bundles
// should be worth more" tweak cannot quietly reintroduce linear scaling.
test("a big bundle stays inside the realised price envelope", () => {
  const out = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: 58 });
  // Above the $1.25 median that 25+ item bundles actually clear...
  assert.ok(out.price > 1.25, "big bundles should earn some premium");
  // ...and under the $4.50 maximum any bundle has ever fetched.
  assert.ok(out.price <= 4.5, "priced at $" + out.price + ", above anything ever sold");
});

test("no bundle size can push price above the observed maximum band", () => {
  for (const n of [1, 5, 20, 58, 500, 5000]) {
    const out = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: n });
    assert.ok(out.price <= 5.5, "n=" + n + " priced $" + out.price);
  }
});

/* --------------------------- marketplace floors -------------------------- */

// These duplicate the connector constants so pricing.js can stay free of
// utils/marketplaces.js. This test is what makes the duplication safe: if a
// platform changes its minimum and only the connector is updated, this fails.
test("marketplace floors match the connector constants exactly", () => {
  const mp = require("../utils/marketplaces");
  assert.equal(MARKETPLACE_FLOORS.digiseller, mp.DS_MIN_PRICE_USD);
  assert.equal(MARKETPLACE_FLOORS.playerauctions, mp.PA_MIN_PRICE);
  assert.equal(MARKETPLACE_FLOORS.eldorado, mp.ELD_MIN_PRICE);
  assert.equal(MARKETPLACE_FLOORS.g2g, mp.G2G_MIN_PRICE);
});

// ZX_MIN_PRICE is used inside utils/marketplaces.js but not exported, and that
// module is shared with other work in flight -- so rather than add an export,
// read the declaration. Drift is still caught; the file is left alone.
test("the ZeusX floor matches its declaration in the connector", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils", "marketplaces.js"),
    "utf8",
  );
  const match = src.match(/const\s+ZX_MIN_PRICE\s*=\s*([\d.]+)/);
  assert.ok(match, "ZX_MIN_PRICE declaration not found — did it get renamed?");
  assert.equal(MARKETPLACE_FLOORS.zeusx, Number(match[1]));
});

test("an unknown marketplace falls back to the global floor", () => {
  assert.equal(floorForMarketplace("funpay"), DEFAULTS.floorUsd);
  assert.equal(floorForMarketplace(""), DEFAULTS.floorUsd);
});

test("PlayerAuctions never prices below its $5 platform minimum", () => {
  // The whole realised distribution tops out at $4.50, so without the floor
  // every PA listing would be repriced to ~$1.25 and rejected by PA.
  const out = priceListing({
    evidence: { platformGame: GAMEFLIP_SALES },
    itemCount: 1,
    marketplace: "playerauctions",
  });
  assert.equal(out.price, 5);
  assert.equal(out.marketFloor, 5);
});

test("Digiseller never prices below the floor that once blocked the account", () => {
  const out = priceListing({
    evidence: { platformGame: [0.75, 0.75, 0.75] },
    marketplace: "digiseller",
  });
  assert.ok(out.price >= 1.28, "priced at $" + out.price + ", under the Plati floor");
});

test("a platform floor above the evidence ceiling still yields a legal price", () => {
  // PA floor $5 vs a $2 evidence ceiling: the floor must win, not collapse.
  const out = priceListing({
    evidence: { platformGame: [1, 1, 1] },
    marketplace: "playerauctions",
  });
  assert.ok(out.price >= 5, "floor lost to the ceiling: $" + out.price);
});

test("Gameflip's floor leaves normal prices untouched", () => {
  const out = priceListing({
    evidence: { platformGame: GAMEFLIP_SALES },
    marketplace: "gameflip",
  });
  assert.equal(out.price, 1.25);
});

/* ---------------------- every price is explainable ----------------------- */

test("every result carries the basis and reason behind it", () => {
  const out = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: 3 });
  assert.ok(out.reason.length > 0);
  assert.equal(out.basis, "platformGame");
  assert.equal(out.samples, GAMEFLIP_SALES.length);
});

test("prices are always whole cents", () => {
  for (const n of [1, 2, 3, 7, 13, 40]) {
    const out = priceListing({ evidence: { platformGame: GAMEFLIP_SALES }, itemCount: n });
    assert.equal(out.price, Math.round(out.price * 100) / 100, "not cents at n=" + n);
  }
});

/* --------------------- the self-undercut ratchet -------------------------- */

// utils/pricingEvidence.js must never hand `gf.lowest` to the engine as a
// rival: that field is the cheapest live Gameflip listing INCLUDING OUR OWN.
// Anchoring on it undercuts ourselves by undercutPct on every run — a ratchet
// straight to the floor, and precisely how every unclaimed row ended up pinned
// at $0.75 (the cheapest listing for the game WAS our own $0.75 row).
test("REGRESSION: our own listing can never become the rival anchor", () => {
  const evidence = require("../utils/pricingEvidence");
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils", "pricingEvidence.js"),
    "utf8",
  );
  // The dangerous fallback is `gf.lowest` being used when lowestOther is 0.
  const rivalBlock = src.slice(src.indexOf("const rivalLowest"), src.indexOf("return {", src.indexOf("const rivalLowest")));
  assert.ok(
    !/gf\.lowest\b(?!Other)/.test(rivalBlock),
    "pricingEvidence fell back to gf.lowest — that is our own price",
  );
  assert.ok(typeof evidence.evidenceFor === "function");
});

test("with no competitor the price does NOT ratchet downward", () => {
  // "We are the only seller" is an absence of competition, not a competitor
  // priced at whatever we charge today. With no rival and no own sales, the
  // research median stands in; repeated runs must be stable.
  const first = priceListing({ evidence: { researchMedian: 2 } });
  const second = priceListing({ evidence: { researchMedian: 2 } });
  assert.equal(first.price, second.price, "price moved without new evidence");
  assert.equal(first.basis, "research");
});
