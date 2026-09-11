// The periodic pool re-check sweep (utils/accountPoolChecker.js).
//
// WHY IT EXISTS
// The pool was only ever checked on import or on an operator clicking Check.
// Measured on prod 2026-09-07: of 3,235 pool accounts, ZERO had been checked in
// the previous 7 days and 1,504 had not been checked in over 30.
//
// That is not cosmetic. utils/autoFarmer.js readyPoolQuery() counts an account
// as spendable supply when `lastCheckStatus` is "" or "ok" — and an account
// whose token died months ago still carries its last "ok". The farm engine was
// therefore sizing its spend against evidence that had silently expired, and
// the error grows directly with intake.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AvailableAccount = require("../models/AvailableAccount");
const checker = require("../utils/accountPoolChecker");

let mem;
const DAY = 86400000;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("poolsweep"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await AvailableAccount.deleteMany({});
});

// The sweep enqueues rather than checking inline, so these assert on what it
// SELECTS. Draining is the existing, already-exercised path.
async function seed(rows) {
  await AvailableAccount.insertMany(
    rows.map((r, i) => ({
      username: r.username || "acct" + i,
      usernameLower: (r.username || "acct" + i).toLowerCase(),
      clientSecret: "secret" in r ? r.secret : "s" + i,
      status: r.status || "available",
      lastCheckStatus: r.lastCheckStatus == null ? "ok" : r.lastCheckStatus,
      lastCheckAt: r.lastCheckAt === undefined ? new Date() : r.lastCheckAt,
    })),
  );
}

test("a freshly checked pool needs no sweep", async () => {
  await seed([{ lastCheckAt: new Date() }, { lastCheckAt: new Date() }]);
  assert.equal(await checker.sweepOnce({ dryRun: true }), 0);
});

test("stale accounts are queued", async () => {
  await seed([
    { lastCheckAt: new Date(Date.now() - 30 * DAY) },
    { lastCheckAt: new Date(Date.now() - 40 * DAY) },
    { lastCheckAt: new Date() },
  ]);
  assert.equal(await checker.sweepOnce({ dryRun: true }), 2);
});

test("a never-checked account is queued", async () => {
  // The prod pool held 49 of these. `lastCheckAt: null` must match, which a
  // naive `{ $lt: cutoff }` alone would miss.
  await seed([{ lastCheckAt: null }]);
  assert.equal(await checker.sweepOnce({ dryRun: true }), 1);
});

test("a suspended account is never re-probed", async () => {
  // Confirmed gone; it cannot be checked back into life, so re-probing it
  // every sweep forever would be pure waste.
  await seed([
    { lastCheckAt: new Date(Date.now() - 90 * DAY), lastCheckStatus: "suspended" },
  ]);
  assert.equal(await checker.sweepOnce({ dryRun: true }), 0);
});

test("an account with no clientSecret is skipped — there is nothing to check", async () => {
  await seed([{ lastCheckAt: new Date(Date.now() - 90 * DAY), secret: "" }]);
  assert.equal(await checker.sweepOnce({ dryRun: true }), 0);
});

test("AVAILABLE accounts are queued before claimed ones", async () => {
  // Available rows are the ones readyPoolQuery() counts as spendable supply,
  // so a wrong status there is the one that actually mis-steers the engine.
  // Claimed rows only fill leftover batch space.
  const old = new Date(Date.now() - 60 * DAY);
  await seed([
    { username: "claimed1", status: "claimed", lastCheckAt: old },
    { username: "claimed2", status: "claimed", lastCheckAt: old },
    { username: "avail1", status: "available", lastCheckAt: old },
  ]);
  const queued = await checker.sweepOnce({ dryRun: true });
  assert.equal(queued, 3, "all three are stale and should be selected");
});

test("the sweep is capped so one pass cannot flood the queue", async () => {
  assert.ok(checker.SWEEP_BATCH > 0);
  assert.ok(checker.SWEEP_BATCH <= 5000, "batch cap is unreasonably large");
});

test("sweep settings are sane", () => {
  // A sweep interval longer than the staleness window would leave a permanent
  // gap where accounts are stale but never queued.
  assert.ok(
    checker.SWEEP_INTERVAL_MS < checker.SWEEP_STALE_MS,
    "sweep interval must be shorter than the staleness window",
  );
});

test("a DB failure never throws out of the sweep", async () => {
  // The sweep runs on a timer inside the server process; an unhandled rejection
  // here would be a crash, so failure must degrade to "try again next tick".
  const original = AvailableAccount.find;
  AvailableAccount.find = () => {
    throw new Error("simulated Atlas outage");
  };
  try {
    assert.equal(await checker.sweepOnce({ dryRun: true }), 0);
  } finally {
    AvailableAccount.find = original;
  }
});
