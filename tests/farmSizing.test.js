// The coverage sizing model (utils/farmSizing.js) — the arithmetic both farming
// systems now size themselves with.
//
// WHY THIS EXISTS
//
// The auto-farmer's ceiling was `min(maxPerGame + 2*sales, maxPerGame*2)`: a
// FLAT cap. Measured on prod 2026-09-08, Overwatch sold 202 units in 30 days and
// Rocket League 83, and the formula gave both of them exactly what it gave a
// game that sold 15 — because at maxPerGame 30 the clamp saturates at 60 from
// the 15th sale onward. The no-claim farm had no formula at all.
//
// These tests pin the replacement's properties, not its exact outputs, so the
// constants stay tunable while the guarantees do not move.
const test = require("node:test");
const assert = require("node:assert/strict");

const sizing = require("../utils/farmSizing");

// ---------------------------------------------------------------------------
// salesPerWeek
// ---------------------------------------------------------------------------

test("a sale count is rescaled from its own window, not assumed to be weekly", () => {
  // 45 is the auto-farmer's SALES_WINDOW_DAYS, so a count from
  // internalSalesForGame can be handed straight over without conversion.
  assert.equal(sizing.salesPerWeek(45, 45), 7);
  assert.equal(sizing.salesPerWeek(30, 30), 7);
  // Prod's real Overwatch number: 202 sales in 30 days.
  assert.ok(Math.abs(sizing.salesPerWeek(202, 30) - 47.1) < 0.1);
});

test("a zero-length window cannot produce Infinity", () => {
  // Guarding this matters more than it looks: the result feeds a coverage target
  // that feeds an account claim, so an Infinity here would drain the pool into
  // one game.
  assert.equal(Number.isFinite(sizing.salesPerWeek(10, 0)), true);
  assert.equal(Number.isFinite(sizing.salesPerWeek(10, -5)), true);
  assert.equal(sizing.salesPerWeek(-3, 30), 0);
});

// ---------------------------------------------------------------------------
// coverageTarget
// ---------------------------------------------------------------------------

test("the target is the sell rate times the cover, plus the safety buffer", () => {
  // 10/week for 4 weeks = 40, + 6 safety.
  assert.equal(
    sizing.coverageTarget({ salesPerWeek: 10, coverageDays: 28, safetyStock: 6 }),
    46,
  );
  // Halving the cover halves the stock.
  assert.equal(
    sizing.coverageTarget({ salesPerWeek: 10, coverageDays: 14, safetyStock: 6 }),
    26,
  );
});

test("a game that has never sold gets NOTHING — not even the safety stock", () => {
  // Safety stock exists to stop a PROVEN seller rounding down to a useless
  // number. Handing it to games with no evidence would spend the pool on every
  // game in the catalogue at once, which is the exact failure the phantom-demand
  // fix was about.
  assert.equal(sizing.coverageTarget({ salesPerWeek: 0, safetyStock: 6 }), 0);
  assert.equal(sizing.coverageTarget({}), 0);
});

test("min raises a target and max caps it, and max never wins over min", () => {
  assert.equal(sizing.coverageTarget({ salesPerWeek: 1, coverageDays: 7, min: 30 }), 30);
  assert.equal(sizing.coverageTarget({ salesPerWeek: 100, coverageDays: 28, max: 50 }), 50);
  // A contradictory pair (max below min) must not produce a target below the
  // floor the caller guaranteed.
  assert.equal(
    sizing.coverageTarget({ salesPerWeek: 100, coverageDays: 28, min: 40, max: 10 }),
    40,
  );
});

test("the hard maximum is absolute, whatever the caller passes", () => {
  // The blast-radius guard: a corrupted sales count, or two games' labels
  // colliding into one bucket, must not be able to ask for the whole pool.
  const huge = sizing.coverageTarget({
    salesPerWeek: 100000,
    coverageDays: 365,
    max: 999999,
  });
  assert.equal(huge, sizing.HARD_MAX_ACCOUNTS);
});

test("scaling is monotonic — selling more never asks for less", () => {
  let prev = -1;
  for (const rate of [0, 1, 5, 12, 35, 47, 90]) {
    const t = sizing.coverageTarget({ salesPerWeek: rate, coverageDays: 28, safetyStock: 6 });
    assert.ok(t >= prev, `rate ${rate} gave ${t}, below the previous ${prev}`);
    prev = t;
  }
});

test("the model separates Overwatch from a mid-tier seller — the old cap did not", () => {
  // The whole point. Under `min(30 + 2*sales, 60)` both of these were 60.
  const overwatch = sizing.coverageTarget({
    salesPerWeek: sizing.salesPerWeek(202, 30),
    coverageDays: 28,
    safetyStock: 6,
  });
  const midTier = sizing.coverageTarget({
    salesPerWeek: sizing.salesPerWeek(15, 30),
    coverageDays: 28,
    safetyStock: 6,
  });
  assert.ok(overwatch > midTier * 3, `${overwatch} vs ${midTier}`);
});

// ---------------------------------------------------------------------------
// stockGap
// ---------------------------------------------------------------------------

test("stock already on the way counts, so a restock does not order the gap twice", () => {
  // The oscillation this prevents: every cycle sees the same shortfall because
  // the accounts the LAST cycle claimed are still farming and not yet sellable.
  const first = sizing.stockGap({ target: 100, onHand: 20, inFlight: 0 });
  assert.equal(first.need, 80);
  const second = sizing.stockGap({ target: 100, onHand: 20, inFlight: 80 });
  assert.equal(second.need, 0);
});

test("being over target reports spare, never a negative need", () => {
  const g = sizing.stockGap({ target: 40, onHand: 350 });
  assert.equal(g.need, 0);
  assert.equal(g.spare, 310);
});

// ---------------------------------------------------------------------------
// daysOfCover
// ---------------------------------------------------------------------------

test("days of cover distinguishes 'about to run out' from 'not moving'", () => {
  // Rainbow Six's real shape: sells fast, empties fast.
  assert.equal(sizing.daysOfCover({ onHand: 7, salesPerWeek: 7 }), 7);
  // No stock is 0 days, whatever the rate.
  assert.equal(sizing.daysOfCover({ onHand: 0, salesPerWeek: 35 }), 0);
  // Stock that sells nothing is not "running out" — it is dead, and reporting a
  // small number here would rank it as urgent.
  assert.equal(sizing.daysOfCover({ onHand: 50, salesPerWeek: 0 }), Infinity);
});

// ---------------------------------------------------------------------------
// weightedSplit
// ---------------------------------------------------------------------------

test("a scarce budget goes to the game whose shortfall is worth more", () => {
  const out = sizing.weightedSplit(
    [
      { key: "rich", need: 20, weight: sizing.revenueWeight({ salesPerWeek: 10, avgPrice: 4 }) },
      { key: "cheap", need: 40, weight: sizing.revenueWeight({ salesPerWeek: 10, avgPrice: 0.75 }) },
    ],
    20,
  );
  assert.ok(out.get("rich") > out.get("cheap"), `${out.get("rich")} vs ${out.get("cheap")}`);
  assert.equal(out.get("rich") + out.get("cheap") <= 20, true);
});

test("the split never grants more than a game asked for, or more than the budget", () => {
  const out = sizing.weightedSplit(
    [
      { key: "a", need: 3, weight: 100 },
      { key: "b", need: 5, weight: 1 },
    ],
    1000,
  );
  assert.equal(out.get("a"), 3);
  assert.equal(out.get("b"), 5);

  const tight = sizing.weightedSplit(
    [
      { key: "a", need: 50, weight: 1 },
      { key: "b", need: 50, weight: 1 },
    ],
    10,
  );
  assert.equal(tight.get("a") + tight.get("b"), 10);
});

test("a budget smaller than the number of claimants terminates instead of spinning", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ key: "g" + i, need: 10, weight: 1 }));
  const out = sizing.weightedSplit(many, 3);
  const total = [...out.values()].reduce((s, n) => s + n, 0);
  assert.ok(total <= 3, `granted ${total} of a 3 budget`);
});

test("a zero budget grants nothing and still returns every key", () => {
  const out = sizing.weightedSplit([{ key: "a", need: 5, weight: 1 }], 0);
  assert.equal(out.get("a"), 0);
  assert.equal(out.size, 1);
});

test("a game with no sales still competes rather than being weighted to zero", () => {
  // revenueWeight floors at 0.01 instead of 0: several sale paths prove a sale
  // without naming a price (a connection flip), so a zero weight would starve a
  // real seller purely because its evidence is priceless rather than free.
  assert.ok(sizing.revenueWeight({ salesPerWeek: 10, avgPrice: 0 }) > 0);
  assert.ok(
    sizing.revenueWeight({ salesPerWeek: 10, avgPrice: 4 }) >
      sizing.revenueWeight({ salesPerWeek: 10, avgPrice: 0 }),
  );
});
