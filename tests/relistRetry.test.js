// The Gameflip relist chain retries a failed successor publish on every watcher
// tick. That is right for the transient failures it was written for (a 429 from
// Gameflip's limiter, a timeout) and wrong for the one that never clears: a
// chain that still owes units when no unsold account holds the whole bundle any
// more. On prod that produced 2,830 identical "Out of stock" errors from a
// single row, and because the retry lane is capped at a handful of rows, five
// such chains would have parked at the head of it and starved every genuinely
// transient retry behind them.
//
// These tests lock in the backoff that separates the two: minutes for the first
// failures (a 429 clears fast) growing to a hard ceiling, so an unfulfillable
// chain settles into a couple of attempts a day and is escalated to the owner
// instead of quietly filling the log.
const test = require("node:test");
const assert = require("node:assert");

const {
  relistRetryDelayMs,
  isOutOfStockError,
  RELIST_RETRY_MAX_MS,
} = require("../utils/gameflipFulfiller");

const MIN = 60 * 1000;

test("backoff starts in minutes and doubles per consecutive failure", () => {
  assert.strictEqual(relistRetryDelayMs(1), 5 * MIN);
  assert.strictEqual(relistRetryDelayMs(2), 10 * MIN);
  assert.strictEqual(relistRetryDelayMs(3), 20 * MIN);
  assert.strictEqual(relistRetryDelayMs(4), 40 * MIN);
});

test("backoff is capped, so a dead chain still gets a couple of tries a day", () => {
  assert.strictEqual(relistRetryDelayMs(99), RELIST_RETRY_MAX_MS);
  assert.ok(relistRetryDelayMs(99) <= 12 * 60 * MIN);
  // Monotonic up to the ceiling — no attempt count ever waits less than the one
  // before it, which is what makes the retry lane fair.
  for (let n = 1; n < 40; n++) {
    assert.ok(relistRetryDelayMs(n + 1) >= relistRetryDelayMs(n));
  }
});

test("a missing or zero attempt count is treated as the first failure", () => {
  assert.strictEqual(relistRetryDelayMs(0), 5 * MIN);
  assert.strictEqual(relistRetryDelayMs(undefined), 5 * MIN);
  assert.strictEqual(relistRetryDelayMs(null), 5 * MIN);
});

test("only the out-of-stock failure is escalated to the owner", () => {
  assert.ok(
    isOutOfStockError(
      "Out of stock — no unsold account holds this whole bundle, so there is nothing to auto-deliver",
    ),
  );
  // Transient failures fix themselves; waking the owner for them is noise.
  assert.ok(!isOutOfStockError("Gameflip create: Too many attempts"));
  assert.ok(!isOutOfStockError("the drop set no longer exists"));
  assert.ok(!isOutOfStockError(""));
  assert.ok(!isOutOfStockError(undefined));
});
