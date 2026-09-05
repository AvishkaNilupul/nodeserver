// Coverage for the lane engine's budget arbiter (utils/farm2/budget.js).
//
// This is the one genuinely new piece of engineering in utils/farm2/*: the
// legacy engine is safe against over-spending only because it does everything
// serially in one pass, and running lanes concurrently removes that accidental
// guarantee. The invariant these tests protect is:
//
//   the sum of all lane grants can never exceed the cycle budget
//
// If that breaks, concurrent lanes drain the account pool past its reserve or
// blow through the container cap — which would make the new engine strictly
// worse than the mess it replaces.
const test = require("node:test");
const assert = require("node:assert");

const { BudgetCycle } = require("../utils/farm2/budget");

function cycle(opts = {}) {
  return new BudgetCycle({
    accounts: 30,
    seats: 40,
    containers: 2,
    perGameCap: 18,
    ...opts,
  });
}

function totalGranted(c) {
  return Object.values(c.summary().grants).reduce((s, g) => s + g.accounts, 0);
}

test("grants never exceed the cycle account budget", () => {
  const c = cycle({ accounts: 30 });
  c.allocate([
    { key: "a", want: 18, weight: 2 },
    { key: "b", want: 18, weight: 1 },
    { key: "c", want: 18, weight: 1 },
  ]);
  // Three lanes each wanting 18 is 54 against a budget of 30.
  assert.ok(totalGranted(c) <= 30, "sum of grants must fit the budget");
});

test("no lane is granted more than it asked for", () => {
  const c = cycle({ accounts: 100 });
  c.allocate([
    { key: "a", want: 4, weight: 1 },
    { key: "b", want: 2, weight: 1 },
  ]);
  assert.strictEqual(c.grantFor("a").accounts, 4);
  assert.strictEqual(c.grantFor("b").accounts, 2);
  assert.strictEqual(totalGranted(c), 6, "a surplus budget is not force-fed to lanes");
});

test("the per-game cap clamps a lane that asks for more", () => {
  const c = cycle({ accounts: 100, perGameCap: 5 });
  c.allocate([{ key: "a", want: 50, weight: 1 }]);
  assert.strictEqual(c.grantFor("a").accounts, 5);
});

test("a zero budget grants nothing to anyone", () => {
  const c = cycle({ accounts: 0, seats: 0 });
  c.allocate([
    { key: "a", want: 18, weight: 1 },
    { key: "b", want: 18, weight: 1 },
  ]);
  assert.strictEqual(totalGranted(c), 0);
  assert.strictEqual(c.remainingAccounts("a"), 0);
});

test("spending is capped at the grant and cannot go negative", () => {
  const c = cycle({ accounts: 10 });
  c.allocate([{ key: "a", want: 10, weight: 1 }]);
  assert.strictEqual(c.spendAccounts("a", 4), 4);
  assert.strictEqual(c.remainingAccounts("a"), 6);
  // Asking for more than remains yields only what is left — the overspend is
  // refused rather than silently allowed.
  assert.strictEqual(c.spendAccounts("a", 99), 6);
  assert.strictEqual(c.remainingAccounts("a"), 0);
  assert.strictEqual(c.spendAccounts("a", 5), 0);
});

test("a lane with no allocation draws ON DEMAND from the unallocated remainder — never beyond it", () => {
  // The legacy tick fair-shares among the campaigns that need accounts THIS
  // tick, not among every game it knows. Pre-allocating equal shares to every
  // live lane diluted a real fresh farm to a few accounts once every game had a
  // lane; so an unallocated remainder is drawn on demand, and the sum of all
  // draws can still never exceed the budget.
  const c = cycle({ accounts: 20 });
  c.allocate([{ key: "a", want: 5, weight: 1 }]);
  assert.strictEqual(c.unallocated, 15);
  assert.strictEqual(totalGranted(c) + c.unallocated, 20, "allocations + remainder is the budget");
  assert.strictEqual(c.remainingAccounts("not-a-lane"), 15);
  assert.strictEqual(c.spendAccounts("not-a-lane", 10), 10);
  assert.strictEqual(c.unallocated, 5);
  assert.strictEqual(c.spendAccounts("other-lane", 10), 5, "only what is left");
  assert.strictEqual(c.spendAccounts("third", 1), 0);
  // a's own allocation is untouched by the others' draws
  assert.strictEqual(c.remainingAccounts("a"), 5);
  assert.strictEqual(c.spendAccounts("a", 5), 5);
  const spent = [...c.grants.values()].reduce((s, g) => s + g.spentAccounts, 0);
  assert.strictEqual(spent, 20, "total spent never exceeds the budget");
});

test("on-demand draws respect the per-game cap", () => {
  const c = new BudgetCycle({ accounts: 100, seats: 100, containers: 10, perGameCap: 30 });
  assert.strictEqual(c.remainingAccounts("x"), 30);
  assert.strictEqual(c.spendAccounts("x", 50), 30);
  assert.strictEqual(c.remainingAccounts("x"), 0);
  assert.strictEqual(c.unallocated, 70);
});

test("seats are proportional to accounts and a zero-account lane gets none", () => {
  const c = cycle({ accounts: 10, seats: 20 });
  c.allocate([
    { key: "a", want: 10, weight: 1 },
    { key: "b", want: 0, weight: 1 },
  ]);
  assert.strictEqual(c.grantFor("b").accounts, 0);
  assert.strictEqual(c.grantFor("b").seats, 0, "no accounts means no containers needed");
  assert.ok(c.grantFor("a").seats <= 20);
});

test("host semaphore bounds concurrent SSH work", async () => {
  const c = cycle({ hostConcurrency: 2 });
  let inFlight = 0;
  let peak = 0;
  const task = () =>
    c.withHost(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed 2`);
  assert.strictEqual(inFlight, 0, "every slot is released");
});

test("the host semaphore releases even when the task throws", async () => {
  const c = cycle({ hostConcurrency: 1 });
  await assert.rejects(() => c.withHost(async () => { throw new Error("boom"); }));
  // If the slot leaked, this second call would hang forever rather than resolve.
  const ok = await c.withHost(async () => "recovered");
  assert.strictEqual(ok, "recovered");
});
