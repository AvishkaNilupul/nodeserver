// The standing check that a no-claim listing still advertises things a buyer
// can actually claim.
//
// The case it is built from: the Overwatch CAH bundle was published across two
// event waves, Week 1 expired, and every backing account silently lost Week 1's
// items — including one of the two Esports Loot Boxes the listing promised. The
// listing text never changed, so it kept selling a bundle that no longer existed.
const test = require("node:test");
const assert = require("node:assert");

const audit = require("../utils/unclaimedListingAudit");

// What a live read of the sellable Overwatch accounts actually returned
// (2026-09-08): eleven accounts holding the six Finals items, four holding
// nothing claimable at all.
const FINALS = [
  "Pachimonarch Spray",
  "Battle Pass Tier Skip",
  "Purple Reign Name Card",
  "Sugar Hop Spray",
  "Boba Buddy Icon",
  "Esports Loot Box",
];
const stockOf = (n, names) =>
  Array.from({ length: n }, (_, i) => ({
    row: { login: "acct" + i },
    items: names.map((name) => ({ name })),
    unreadable: false,
  }));

const LIVE = [
  ...stockOf(11, FINALS),
  ...stockOf(4, []),
];

// What the listing said it was selling: both waves, two loot boxes.
const ADVERTISED = {
  source: "requiredDrops",
  items: [
    { name: "Pachimonarch Icon" },
    { name: "Battle Pass Tier Skip", qty: 2 },
    { name: "Crown Jewels Spray" },
    { name: "Esports Loot Box", qty: 2 },
    { name: "Pachimonarch Spray" },
    { name: "Purple Reign Name Card" },
    { name: "Sugar Hop Spray" },
    { name: "Boba Buddy Icon" },
  ],
};

test("a listing whose wave expired reads STALE, not merely out of stock", () => {
  // The distinction is the whole point: "empty" means farm more, "stale" means
  // the listing is wrong and stock is sitting right there unsold.
  const r = audit.judge({ qtyTarget: 0 }, ADVERTISED, LIVE);
  assert.strictEqual(r.verdict, "stale");
  assert.strictEqual(r.covering, 0);
  assert.strictEqual(r.stock, 11);
  assert.match(r.missing, /esports loot box/);
});

test("the suggestion is the set the stock really holds", () => {
  const r = audit.judge({ qtyTarget: 0 }, ADVERTISED, LIVE);
  assert.strictEqual(r.suggest.count, 11);
  assert.deepStrictEqual(r.suggest.items.slice().sort(), FINALS.slice().sort());
});

test("a listing matching its stock reads OK", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 0 }, honest, LIVE);
  assert.strictEqual(r.verdict, "ok");
  assert.strictEqual(r.covering, 11);
});

test("fewer covering accounts than the quantity on sale reads SHORT", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 50 }, honest, LIVE);
  assert.strictEqual(r.verdict, "short");
  assert.strictEqual(r.covering, 11);
});

test("no claimable stock at all reads EMPTY, which is a different fix", () => {
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const r = audit.judge({ qtyTarget: 0 }, honest, stockOf(5, []));
  assert.strictEqual(r.verdict, "empty");
});

test("a listing that declares nothing is UNKNOWN, never silently OK", () => {
  // Undeclared must not read as passing: nothing was checked.
  const r = audit.judge({ qtyTarget: 0 }, { source: "none", items: [] }, LIVE);
  assert.strictEqual(r.verdict, "unknown");
  assert.strictEqual(r.suggest.count, 11);
});

test("unreadable accounts are counted, never treated as empty", () => {
  // A Pi outage must not look like expired stock and pause a healthy listing.
  const honest = { source: "requiredDrops", items: FINALS.map((name) => ({ name })) };
  const stock = [...stockOf(3, FINALS), { row: null, items: [], unreadable: true }];
  const r = audit.judge({ qtyTarget: 0 }, honest, stock);
  assert.strictEqual(r.unreadable, 1);
  assert.strictEqual(r.covering, 3);
  assert.strictEqual(r.verdict, "ok");
});

test("dominantOffer groups by exact item signature, not by intersection", () => {
  // Two cohorts: an intersection would invent a bundle (the shared item alone)
  // that misrepresents both. The bigger cohort wins.
  const stock = [
    ...stockOf(6, ["A", "B", "C"]),
    ...stockOf(2, ["A", "D"]),
  ];
  const best = audit.dominantOffer(stock);
  assert.strictEqual(best.count, 6);
  assert.deepStrictEqual(best.items, ["A", "B", "C"]);
});

test("with equal stock the larger bundle wins", () => {
  const stock = [...stockOf(3, ["A", "B", "C"]), ...stockOf(3, ["A"])];
  assert.strictEqual(audit.dominantOffer(stock).items.length, 3);
});

test("repeated items become a count, so two loot boxes stay two", () => {
  const items = audit.itemsToRequired([
    "Esports Loot Box",
    "Esports Loot Box",
    "Boba Buddy Icon",
  ]);
  const lb = items.find((i) => i.name === "Esports Loot Box");
  assert.strictEqual(lb.qty, 2);
  assert.strictEqual(items.length, 2);
});

test("the game filter matches the ledger's spellings of one game", () => {
  const f = audit.gameFilter("Overwatch 2");
  assert.ok(f.test("Overwatch"));
  assert.ok(f.test("overwatch"));
  assert.ok(!f.test("Rainbow Six Siege"));
});
