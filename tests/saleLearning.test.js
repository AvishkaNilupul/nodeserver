// Plati and GGSel never announce a sale — they just report a smaller stock
// pile than we left there. unitsSoldSince turns that difference into a sale
// count, and it is the only evidence of demand those two markets ever give, so
// the arithmetic has to be right in both directions: never miss a real sale,
// and never invent one out of a failed feed or a first-ever reading.
const test = require("node:test");
const assert = require("node:assert");

const { unitsSoldSince, gamesForSet } = require("../utils/saleLearning");

// ------------------------------------------------------- stock arithmetic

test("stock dropping below what we left is that many sales", () => {
  assert.equal(unitsSoldSince(5, 2), 3);
  assert.equal(unitsSoldSince(1, 0), 1);
});

test("untouched stock is no sales", () => {
  assert.equal(unitsSoldSince(5, 5), 0);
});

test("the first ever reading reports nothing", () => {
  // lastStock is null until a pass has recorded one. Treating "unknown" as
  // zero would make the whole pile read as sold the first time the new code
  // runs — every live quantity listing firing a burst of fake demand at once.
  assert.equal(unitsSoldSince(null, 4), 0);
  assert.equal(unitsSoldSince(undefined, 4), 0);
});

test("an unreadable stock count reports nothing", () => {
  // The platform refusing the read must not look like the pile emptying.
  assert.equal(unitsSoldSince(5, null), 0);
});

test("stock going UP is not negative sales", () => {
  // Happens when a feed fails after the platform quietly accepted part of the
  // batch: we record the pre-feed level, then find MORE there next pass. It
  // must clamp to zero, never subtract from the game's demand.
  assert.equal(unitsSoldSince(2, 6), 0);
});

test("a restock does not erase the sales that preceded it", () => {
  // The guardian records the topped-up level (what it found + what it fed), so
  // the next pass measures from there. Left at the pre-feed level, every
  // successful restock would swallow that many real sales.
  const found = 1;
  const fed = 4;
  const baseline = found + fed; // 5, what the platform now holds
  assert.equal(unitsSoldSince(baseline, 3), 2);
});

// ------------------------------------------------------------ set → games

test("a bundle reports each game once, not once per drop", () => {
  // A 50-item Overwatch bundle is ONE sale of Overwatch. Counting per drop is
  // what previously let a single buyer pin a game at full allocation.
  const set = {
    items: [
      { game: "Overwatch 2", itemKey: "a" },
      { game: "Overwatch 2", itemKey: "b" },
      { game: "Overwatch 2", itemKey: "c" },
      { game: "Rainbow Six Siege", itemKey: "d" },
    ],
  };
  assert.deepEqual(gamesForSet(set), ["Overwatch 2", "Rainbow Six Siege"]);
});

test("items with no game are ignored, and a junk set yields nothing", () => {
  assert.deepEqual(gamesForSet({ items: [{ game: "" }, { itemKey: "x" }] }), []);
  assert.deepEqual(gamesForSet(null), []);
  assert.deepEqual(gamesForSet({}), []);
});
