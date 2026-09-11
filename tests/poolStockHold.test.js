// The hold lifecycle in utils/poolStock.js against a real (in-memory) Mongo:
// the status guards are the whole safety story, so they are exercised for real
// rather than trusted.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AvailableAccount = require("../models/AvailableAccount");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const poolStock = require("../utils/poolStock");
const checker = require("../utils/accountPoolChecker");
const { recordPoolUsage } = require("../utils/poolUsageLog");

let mem;
const OW6 = { claimed: 0, unclaimed: 6, claimedGames: [], unclaimedGames: ["Overwatch"] };

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("poolstockhold"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await AvailableAccount.deleteMany({});
  await PoolUsageEvent.deleteMany({});
});

async function acct(fields) {
  const u = fields.username || "a" + Math.random().toString(36).slice(2, 8);
  return AvailableAccount.create({ username: u, usernameLower: u.toLowerCase(), ...fields });
}

test("an available account with stock is held, with the stock note and a 'held' event", async () => {
  const a = await acct({ status: "available" });
  assert.equal(await poolStock.holdForStock(a._id, OW6), true);
  const after = await AvailableAccount.findById(a._id).lean();
  assert.equal(after.status, "claimed");
  assert.ok(poolStock.isStockNote(after.claimedNote));
  assert.match(after.claimedNote, /6 drop\(s\) \(Overwatch\)/);
  assert.equal(after.usageHistory.at(-1).event, "held");
  // The enum accepts it: a later save must not throw (the 172-account bug).
  const doc = await AvailableAccount.findById(a._id);
  doc.lastCheckStatus = "ok";
  await doc.save();
});

test("a hold never overwrites another claim, and never touches a hand-sold account", async () => {
  const rented = await acct({ status: "claimed", claimedNote: "rented to operator-selffarm" });
  const sold = await acct({ status: "available", manualSold: true });
  assert.equal(await poolStock.holdForStock(rented._id, OW6), false);
  assert.equal(await poolStock.holdForStock(sold._id, OW6), false);
  assert.equal((await AvailableAccount.findById(rented._id).lean()).claimedNote, "rented to operator-selffarm");
  assert.equal((await AvailableAccount.findById(sold._id).lean()).status, "available");
  // No stock, no hold.
  const empty = await acct({ status: "available" });
  assert.equal(await poolStock.holdForStock(empty._id, { ...OW6, unclaimed: 0 }), false);
});

test("expired stock releases the hold; nothing else can be released by it", async () => {
  const held = await acct({ status: "available" });
  await poolStock.holdForStock(held._id, OW6);
  const other = await acct({ status: "claimed", claimedNote: "noclaim-farm:Overwatch" });
  assert.equal(await poolStock.releaseHold(held._id), true);
  assert.equal(await poolStock.releaseHold(other._id), false, "only stock holds are released");
  const back = await AvailableAccount.findById(held._id).lean();
  assert.equal(back.status, "available");
  assert.equal(back.claimedNote, "");
  assert.equal(back.usageHistory.at(-1).event, "released");
  assert.equal((await AvailableAccount.findById(other._id).lean()).status, "claimed");
});

test("claimed stock keeps the account OUT of the pool, flagged — never released", async () => {
  const held = await acct({ status: "available" });
  await poolStock.holdForStock(held._id, OW6);
  assert.equal(await poolStock.markStockClaimed(held._id), true);
  const after = await AvailableAccount.findById(held._id).lean();
  assert.equal(after.status, "claimed");
  assert.equal(after.claimedNote, poolStock.CLAIMED_STOCK_NOTE);
  // Once flagged it is no longer a stock hold, so an expiry can't free it.
  assert.equal(poolStock.isStockNote(after.claimedNote), false);
  assert.equal(await poolStock.releaseHold(held._id), false);
});

test("heldStockOutcome: vanished = expired, claimed-count up = claimed, stock left = still held", () => {
  const h = (claimed, unclaimed) => ({ claimed, unclaimed, claimedGames: [], unclaimedGames: [] });
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: 0, holdings: h(0, 6) }), "still-held");
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: 0, holdings: h(0, 0) }), "expired");
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: 1, holdings: h(1, 0) }), "expired");
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: 0, holdings: h(6, 0) }), "claimed");
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: undefined, holdings: h(2, 0) }), "claimed");
  assert.equal(poolStock.heldStockOutcome({ prevClaimed: 0, holdings: null }), "still-held");
});

test("a release logged outside the server never triggers live re-checks", async () => {
  // The re-check hook is inside recordPoolUsage and only enqueues once the
  // checker service has been started — which a test (or a script) never does.
  const a = await acct({ status: "available", clientSecret: "tok" });
  const before = checker.status().total;
  await recordPoolUsage(a._id, { event: "released", actor: "auto-farm" });
  assert.equal(checker.status().total, before);
  assert.equal(checker.status().running, false);
});
