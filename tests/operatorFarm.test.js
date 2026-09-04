// Input-guard coverage for the operator self-farm service
// (utils/operatorFarm.js). Every one of these rejections happens BEFORE the
// service touches the database, the pool or a host — which is exactly why they
// are unit-testable with no DB connection, and why they matter: an autonomous
// coworker calling this with a confused argument must be stopped at the door,
// not halfway through claiming pool accounts.
const test = require("node:test");
const assert = require("node:assert");

const { farmFreshAccounts } = require("../utils/operatorFarm");

async function rejects(args, re) {
  await assert.rejects(() => farmFreshAccounts(args), (e) => {
    assert.match(e.message, re);
    assert.strictEqual(e.status, 400, "input errors must be 400, not a 500");
    return true;
  });
}

test("refuses a missing or blank game", async () => {
  await rejects({ days: 30, count: 1 }, /game is required/i);
  await rejects({ game: "   ", days: 30, count: 1 }, /game is required/i);
});

test("refuses a non-positive or unparseable window", async () => {
  for (const days of [0, -5, NaN, "abc", null, undefined]) {
    await rejects({ game: "Apex Legends", days, count: 1 }, /positive farming window/i);
  }
});

test("refuses a non-positive count", async () => {
  for (const count of [0, -1, "abc"]) {
    await rejects({ game: "Apex Legends", days: 30, count }, /count must be a positive/i);
  }
});

test("a sub-day window floors to zero and is rejected, not silently run", async () => {
  // Days are floored. A window under a day (0.4d, or "12 hours" upstream) must
  // floor to 0 and be REFUSED — never quietly become a 0-day lease that expires
  // the instant it is created.
  for (const days of [0.4, 0.99]) {
    await rejects({ game: "Apex Legends", days, count: 1 }, /positive farming window/i);
  }
});

test("guards run before any DB/pool/host work", async () => {
  // No mongoose connection exists in this test process. If a guard leaked, the
  // call would hang or throw a connection error instead of a clean 400 — so a
  // fast, well-typed 400 is itself the assertion that nothing was touched.
  const t0 = Date.now();
  await rejects({ game: "", days: 0, count: 0 }, /game is required/i);
  assert.ok(Date.now() - t0 < 1000, "must fail fast, without I/O");
});
