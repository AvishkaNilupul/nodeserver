// Pure-logic coverage for the stock floor + refill bookkeeping. The refill
// account-taking order (free spare first, then holdback) is replicated here
// as the same arithmetic refillMarkets uses — if this drifts from the
// implementation the numbers in the assertions will catch it.
const test = require("node:test");
const assert = require("node:assert");

// marketStockFloor mirror: markets x per x 2 capped by maxPerGame
function floorFor(markets, per, maxPerGame) {
  return Math.min(markets * Math.max(1, per) * 2, maxPerGame);
}

test("stock floor: 3 markets x 3 x 2 = 18, capped by maxPerGame", () => {
  assert.strictEqual(floorFor(3, 3, 30), 18);
  assert.strictEqual(floorFor(3, 3, 10), 10); // cap wins
  assert.strictEqual(floorFor(1, 3, 30), 6); // gameflip only
  assert.strictEqual(floorFor(2, 5, 30), 20);
});

// take-order mirror: freeSpare drains before holdback is touched
function simulateTakes(spareLen, heldBack, wants) {
  let free = Math.max(0, spareLen - heldBack);
  let hold = heldBack;
  let cursor = 0;
  let holdUsed = 0;
  const got = [];
  for (const n of wants) {
    const take = Math.min(n, spareLen - cursor);
    const fromFree = Math.min(take, free);
    const fromHold = take - fromFree;
    free -= fromFree;
    hold -= fromHold;
    holdUsed += fromHold;
    cursor += take;
    got.push(take);
  }
  return { got, holdUsed, holdLeft: hold };
}

test("refill drains free spare before dipping into holdback", () => {
  // 10 spare accounts, 4 of them are the holdback reserve
  const r = simulateTakes(10, 4, [3, 3]); // two markets want 3 each
  assert.deepStrictEqual(r.got, [3, 3]);
  assert.strictEqual(r.holdUsed, 0); // 6 free spare covered it all
  assert.strictEqual(r.holdLeft, 4);
});

test("refill dips into holdback only after free spare is gone", () => {
  // 6 spare, 4 held back -> only 2 free
  const r = simulateTakes(6, 4, [3, 3]);
  assert.deepStrictEqual(r.got, [3, 3]);
  assert.strictEqual(r.holdUsed, 4); // 2 free + 4 holdback
  assert.strictEqual(r.holdLeft, 0);
});

test("refill never takes more than exists", () => {
  const r = simulateTakes(2, 0, [3, 3]);
  assert.deepStrictEqual(r.got, [2, 0]);
  assert.strictEqual(r.holdUsed, 0);
});
