// The demand/competition scores decide whether the auto-farmer spends accounts
// on a game at all, against fixed tiers (40 = proven seller, 15 = moderate).
// They were an unbounded sum of logs that ran to ~300 on a normal game, so
// every game with any market presence cleared both tiers and the sellability
// gate was very nearly a no-op. These lock in that the replacement stays on the
// 0-100 scale the tiers are written for, and that competition counts rivals
// rather than rows.
const test = require("node:test");
const assert = require("node:assert");

const { sat, competitionOf, medianPrice } = require("../utils/marketResearch");

// ------------------------------------------------------------- saturation

test("the half-way point scores 0.5 and nothing ever exceeds 1", () => {
  assert.equal(sat(6, 6), 0.5);
  assert.ok(sat(1e9, 6) < 1);
  assert.ok(sat(1e9, 6) > 0.99);
});

test("no evidence scores zero, and junk input cannot go negative", () => {
  assert.equal(sat(0, 6), 0);
  assert.equal(sat(-50, 6), 0);
  assert.equal(sat(NaN, 6), 0);
  assert.equal(sat(undefined, 6), 0);
});

// ------------------------------------------------------------ competition

test("one seller papering the page is one competitor, not twenty", () => {
  // Measured live: a search for Escape from Tarkov returned 20 Gameflip rows
  // that were 3 products from a single seller. Counting rows scored that as a
  // saturated market and pushed the game's opportunity down, when in fact it
  // was one rival worth undercutting.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ seller: "owner-1", title: "Tarkov Drops " + (i % 3) });
  }
  const c = competitionOf({ gameflip: rows });
  assert.equal(c.sellers, 1);
  assert.equal(c.offers, 3);
});

test("the same seller id on two marketplaces is two competitors", () => {
  // Seller ids are only unique within a marketplace, so they must be
  // namespaced or unrelated sellers would cancel each other out.
  const c = competitionOf({
    gameflip: [{ seller: "42", title: "a" }],
    ggsel: [{ seller: "42", title: "b" }],
  });
  assert.equal(c.sellers, 2);
});

test("a market exposing no seller id falls back to the title", () => {
  // Worst case that counts distinct products rather than sellers — an
  // over-count of rivals, never the reverse, so it cannot flatter a market.
  const c = competitionOf({
    g2g: [{ title: "Bundle A" }, { title: "Bundle A" }, { title: "Bundle B" }],
  });
  assert.equal(c.sellers, 2);
});

test("empty markets contribute nothing", () => {
  assert.deepEqual(competitionOf({ gameflip: [], ggsel: [] }), {
    sellers: 0,
    offers: 0,
  });
});

// ------------------------------------------------------------------ price

test("the median ignores a junk listing and a mega-bundle", () => {
  const rows = [
    { price: 0.01 },
    { price: 1.2 },
    { price: 1.5 },
    { price: 2.0 },
    { price: 240 },
  ];
  assert.equal(medianPrice(rows), 1.5);
});

test("rows with no usable price are skipped, not counted as free", () => {
  assert.equal(medianPrice([{ price: 0 }, { price: -3 }, { price: 4 }]), 4);
  assert.equal(medianPrice([]), 0);
});

// -------------------------------------------------- the tiers discriminate

// Rebuilds the score the way scanGame does, so the calibration itself is under
// test rather than just its parts.
function demandOf({ soldRecent, revenue, lifetime, price }) {
  return (
    100 *
    (0.4 * sat(soldRecent, 6) +
      0.3 * sat(revenue, 40) +
      0.2 * sat(lifetime, 150) +
      0.1 * sat(price, 3))
  );
}

const DEMAND_FULL = 40; // utils/autoFarmer.js
const DEMAND_HALF = 15;

test("a proven seller clears the full-allocation tier", () => {
  // Escape from Tarkov, from the live scan: 20 recent Gameflip sales around
  // $1, ~2800 lifetime sales across GGSel and Plati.
  const d = demandOf({
    soldRecent: 20,
    revenue: 20,
    lifetime: 2815,
    price: 1,
  });
  assert.ok(d >= DEMAND_FULL, "expected >= 40, got " + d.toFixed(1));
  assert.ok(d <= 100);
});

test("a high-price game beats a high-volume cheap one", () => {
  // The whole point of putting money in the score. Five sales at $18 is better
  // business than twenty at $0.30 for the same farming cost, and the old
  // count-driven score ranked it the other way round.
  const premium = demandOf({
    soldRecent: 5,
    revenue: 90,
    lifetime: 400,
    price: 18,
  });
  const cheap = demandOf({
    soldRecent: 20,
    revenue: 6,
    lifetime: 400,
    price: 0.3,
  });
  assert.ok(
    premium > cheap,
    "premium " + premium.toFixed(1) + " should beat cheap " + cheap.toFixed(1),
  );
});

test("a near-dead game now falls below the moderate tier", () => {
  // This is the regression that mattered: under the old formula a game with
  // three lifetime sales and nothing else scored 20 — over the 15 line — and
  // was handed half of a full allocation.
  const d = demandOf({ soldRecent: 0, revenue: 0, lifetime: 3, price: 0.5 });
  assert.ok(d < DEMAND_HALF, "expected < 15, got " + d.toFixed(1));
});

test("nothing anywhere scores zero", () => {
  assert.equal(demandOf({ soldRecent: 0, revenue: 0, lifetime: 0, price: 0 }), 0);
});
