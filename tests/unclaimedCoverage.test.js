// The gate that decides whether an account may be handed to a buyer of a
// no-claim-backed listing.
//
// Written from a real failure: Eldorado order 99d443eb (2026-09-07) advertised
// the Overwatch CAH 2026 bundle as 10 items across two waves — TWO Esports Loot
// Boxes among them — and was filled with an account holding 7 of them and ONE
// loot box, because the claimer matched on GAME and nothing else. Every case
// below is that bug in miniature.
const test = require("node:test");
const assert = require("node:assert");

const cov = require("../utils/unclaimedCoverage");

const ROW_7 = {
  login: "snsh739vkng",
  drops: [
    { name: "Pachimonarch Icon" },
    { name: "Battle Pass Tier Skip" },
    { name: "Crown Jewels Spray" },
    { name: "Esports Loot Box" },
    { name: "Pachimonarch Spray" },
    { name: "Battle Pass Tier Skip" },
    { name: "Purple Reign Name Card" },
  ],
};

// What the offer actually promised: both waves, so the repeated items are
// repeated in the requirement too.
const ADVERTISED = [
  { name: "Pachimonarch Icon" },
  { name: "Battle Pass Tier Skip", qty: 2 },
  { name: "Crown Jewels Spray" },
  { name: "Esports Loot Box", qty: 2 },
  { name: "Pachimonarch Spray" },
  { name: "Purple Reign Name Card" },
  { name: "Sugar Hop Spray" },
  { name: "Boba Buddy Icon" },
];

test("the account that shipped on order 99d443eb does NOT cover the listing", () => {
  assert.strictEqual(cov.coversRequired(ROW_7, ADVERTISED), false);
  const missing = cov.missingItems(ROW_7, ADVERTISED);
  const names = missing.map((m) => m.name).sort();
  assert.deepStrictEqual(names, [
    "boba buddy icon",
    "esports loot box",
    "sugar hop spray",
  ]);
  // The loot box is the one a set-membership check would have passed: the
  // account HAS one, the buyer paid for two.
  const lb = missing.find((m) => m.name === "esports loot box");
  assert.deepStrictEqual({ need: lb.need, have: lb.have }, { need: 2, have: 1 });
});

test("counts are the point — one copy does not satisfy a promise of two", () => {
  const one = { drops: [{ name: "Esports Loot Box" }] };
  const two = { drops: [{ name: "Esports Loot Box" }, { name: "Esports Loot Box" }] };
  const req = [{ name: "Esports Loot Box", qty: 2 }];
  assert.strictEqual(cov.coversRequired(one, req), false);
  assert.strictEqual(cov.coversRequired(two, req), true);
});

test("the same name listed once per wave means two copies", () => {
  // This is how a two-week event reads when typed out, and it must not collapse
  // into a single requirement.
  const req = cov.requiredCounts([
    { name: "Battle Pass Tier Skip" },
    { name: "Battle Pass Tier Skip" },
  ]);
  assert.strictEqual(req.get("battle pass tier skip"), 2);
});

test("names compare on case and spacing, not exact bytes", () => {
  const row = { drops: [{ name: "  esports   LOOT box " }] };
  assert.strictEqual(cov.coversRequired(row, ["Esports Loot Box"]), true);
});

test("a listing that declares nothing keeps its pre-gate behaviour", () => {
  // The gate is opt-in per listing: an undeclared row must not suddenly refuse
  // every account and take a live offer to zero stock.
  assert.strictEqual(cov.listingRequirements({}).size, 0);
  assert.strictEqual(cov.coversRequired(ROW_7, []), true);
  const { covering, short } = cov.partitionByCoverage([ROW_7, {}], []);
  assert.strictEqual(covering.length, 2);
  assert.strictEqual(short.length, 0);
});

test("partitionByCoverage splits stock into deliverable and not", () => {
  const full = {
    drops: ADVERTISED.flatMap((i) =>
      Array.from({ length: i.qty || 1 }, () => ({ name: i.name })),
    ),
  };
  const { covering, short } = cov.partitionByCoverage([ROW_7, full], ADVERTISED);
  assert.deepStrictEqual(covering, [full]);
  assert.deepStrictEqual(short, [ROW_7]);
});

test("the shortfall names what the stock is missing, worst first", () => {
  const summary = cov.shortfallSummary([ROW_7, ROW_7], ADVERTISED);
  assert.match(summary, /esports loot box \(missing on 2\)/);
});

test("a row with no drops recorded covers nothing", () => {
  assert.strictEqual(cov.coversRequired({ drops: [] }, ADVERTISED), false);
  assert.strictEqual(cov.coversRequired({}, ["Anything"]), false);
});

// --- the ledger is only half the picture ---------------------------------
// Measured on prod 2026-09-07: all 15 sellable Overwatch ledger rows listed 3-6
// drops while DropLog held 7-39 for the same login. A gate reading the ledger
// alone would have refused every one of them, so "held" is the union.

test("held items are the union of the ledger and DropLog, not either alone", () => {
  const ledger = cov.heldCounts({ drops: [{ name: "Crown Jewels Spray" }] });
  const logs = cov.countLogNames([
    { name: "Esports Loot Box" },
    { name: "Boba Buddy Icon" },
  ]);
  const held = cov.mergeMax(ledger, logs);
  assert.deepStrictEqual(
    cov.shortOf(held, cov.requiredCounts(["Crown Jewels Spray", "Esports Loot Box"])),
    [],
  );
});

test("the union takes the larger count per name, never the sum", () => {
  // The same drop is usually recorded in BOTH sources. Adding them would invent
  // a second copy and wave through exactly the shortfall this gate exists for.
  const ledger = cov.heldCounts({ drops: [{ name: "Esports Loot Box" }] });
  const logs = cov.countLogNames([{ name: "Esports Loot Box" }]);
  const held = cov.mergeMax(ledger, logs);
  assert.strictEqual(held.get("esports loot box"), 1);
  const missing = cov.shortOf(held, cov.requiredCounts([{ name: "Esports Loot Box", qty: 2 }]));
  assert.deepStrictEqual(missing, [{ name: "esports loot box", need: 2, have: 1 }]);
});

test("two DropLog rows of one name are two copies", () => {
  // DropLog is unique on (account, benefitId), so a repeated name is a second
  // grant — which is what makes a two-loot-box bundle checkable at all.
  const held = cov.countLogNames([
    { name: "Esports Loot Box" },
    { name: "Esports Loot Box" },
  ]);
  assert.deepStrictEqual(
    cov.shortOf(held, cov.requiredCounts([{ name: "Esports Loot Box", qty: 2 }])),
    [],
  );
});

test("similarly-named loot boxes are different items and do not substitute", () => {
  // The account on order 99d443eb held "Esports Lootbox OWWC 1/2", "Esports Loot
  // Box 41", "Esports Loot Box OWG4" — none of which is the CAH wave-2 box the
  // listing promised.
  const held = cov.countLogNames([
    { name: "Esports Loot Box" },
    { name: "Esports Loot Box 41" },
    { name: "Esports Lootbox OWWC 1" },
    { name: "Esports Loot Box OWG4" },
  ]);
  const missing = cov.shortOf(held, cov.requiredCounts([{ name: "Esports Loot Box", qty: 2 }]));
  assert.deepStrictEqual(missing, [{ name: "esports loot box", need: 2, have: 1 }]);
});

test("the shortfall message is built from real verdicts", () => {
  const summary = cov.summarizeMissing([
    [{ name: "esports loot box", need: 2, have: 1 }, { name: "boba buddy icon", need: 1, have: 0 }],
    [{ name: "esports loot box", need: 2, have: 1 }],
  ]);
  assert.match(summary, /^esports loot box \(missing on 2\)/);
  assert.match(summary, /boba buddy icon \(missing on 1\)/);
});
