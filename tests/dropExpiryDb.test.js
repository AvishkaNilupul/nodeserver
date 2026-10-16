// Expired Twitch drops must never be sold (utils/dropReservation.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET = process.env.CRED_SECRET || "test-secret-for-drop-expiry";
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const BotAccount = require("../models/BotAccount");
const dr = require("../utils/dropReservation");

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);
let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("dropexpiry"));
});
test.after(async () => {
  await mongoose.disconnect();
  await mem.stop();
});
test.beforeEach(async () => {
  await DropLog.deleteMany({});
  await DropSet.deleteMany({});
  await BotAccount.deleteMany({});
  dr._resetSellableAgeCache();
});

let n = 0;
let seq = 0;
async function account(drops) {
  n += 1;
  const acc = await BotAccount.create({ clientSecret: "s" + n, login: "acc" + n });
  for (const d of drops) {
    await DropLog.create({
      account: acc._id,
      accountModel: "BotAccount",
      login: acc.login,
      benefitId: "b" + n + d.k + ":" + (seq += 1),
      itemKey: d.k,
      name: d.name || d.k,
      game: "Game",
      awardedAt: d.age == null ? null : ago(d.age),
      ...(d.name ? { name: d.name } : {}),
      ...(d.setId ? { soldSetId: String(d.setId) } : {}),
      connected: !!d.connected,
      soldAt: d.reserved ? new Date() : null,
    });
  }
  return acc;
}
const SET_ITEMS = [{ itemKey: "a|game" }, { itemKey: "b|game" }];

test("a claim refuses an account whose set drops expired on Twitch", async () => {
  const set = await DropSet.create({ name: "S", items: SET_ITEMS });
  const fresh = await account([{ k: "a|game", age: 20 }, { k: "b|game", age: 20 }]);
  const old = await account([{ k: "a|game", age: 20 }, { k: "b|game", age: 178 }]);
  assert.equal(await dr.reserveSetOnAccount(old._id, set), false);
  // the failed claim left nothing reserved behind
  assert.equal(await DropLog.countDocuments({ account: old._id, soldAt: { $ne: null } }), 0);
  assert.equal(await dr.reserveSetOnAccount(fresh._id, set), true);
});

test("sellable stock counts only unexpired drops", async () => {
  await account([{ k: "a|game", age: 10 }, { k: "a|game", age: 200 }, { k: "a|game", age: null }]);
  const rows = await DropLog.find({ itemKey: "a|game", ...dr.AVAILABLE_DROP }).lean();
  assert.equal(rows.length, 2); // fresh + undated, never the 200-day one
});

test("expiredUnitAccounts flags only units whose drops expired", async () => {
  const set = { items: SET_ITEMS };
  const good = await account([
    { k: "a|game", age: 30, reserved: true },
    { k: "b|game", age: 30, reserved: true },
  ]);
  const expired = await account([
    { k: "a|game", age: 30, reserved: true },
    { k: "b|game", age: 181, reserved: true },
  ]);
  const redeemed = await account([
    { k: "a|game", age: 30, connected: true },
    { k: "b|game", age: 30 },
  ]);
  const missing = await account([{ k: "a|game", age: 30 }]);
  const undated = await account([
    { k: "a|game", age: null, reserved: true },
    { k: "b|game", age: 30, reserved: true },
  ]);
  const stale = await dr.expiredUnitAccounts(
    [good._id, expired._id, redeemed._id, missing._id, undated._id].map(String),
    set,
  );
  // redeemed-only or missing items are not proof of expiry: not judged here
  assert.deepEqual([...stale], [String(expired._id)]);
});

test("expiredUnitAccounts ignores bad ids and empty sets", async () => {
  assert.equal((await dr.expiredUnitAccounts(["", "nope"], { items: SET_ITEMS })).size, 0);
  assert.equal((await dr.expiredUnitAccounts([String(new mongoose.Types.ObjectId())], { items: [] })).size, 0);
});

test("G2G counts and hands over only units whose drops are still live", async () => {
  const g2g = require("../utils/g2gFulfiller");
  const set = await DropSet.create({ name: "S", items: SET_ITEMS });
  const good = await account([
    { k: "a|game", age: 30, reserved: true },
    { k: "b|game", age: 30, reserved: true },
  ]);
  const expired = await account([
    { k: "a|game", age: 190, reserved: true },
    { k: "b|game", age: 190, reserved: true },
  ]);
  const row = {
    marketplace: "g2g",
    set: set._id,
    units: [
      { accountId: String(expired._id), login: expired.login },
      { accountId: String(good._id), login: good.login },
      { accountId: "x", login: "sold", orderId: "o1", deliveredAt: new Date() },
    ],
  };
  assert.equal(await g2g.realStockFor(row, new Set()), 1);
  const pick = await g2g.pickStock(row, { orderItemId: "o2" }, { dryRun: true });
  assert.equal(pick.picked.length, 1);
  assert.equal(pick.picked[0].accountId, String(good._id));
  // two wanted, one good: never fills the gap with the expired unit
  const short = await g2g.pickStock(row, { orderItemId: "o3", purchased_qty: 2, quantity: 2 }, { dryRun: true });
  assert.ok(!short || !(short.picked || []).some((u) => u.accountId === String(expired._id)));
});

test("a reserved unit whose drop was renamed Expired is caught", async () => {
  const set = await DropSet.create({ name: "NBA", items: [{ itemKey: "nba 2k27 x nike ja 4|nba" }] });
  const unit = await account([
    { k: "nike ja expired|nba", name: "Nike Ja Expired", age: 14, reserved: true, setId: set._id },
  ]);
  const fine = await account([{ k: "nba 2k27 x nike ja 4|nba", age: 14, reserved: true, setId: set._id }]);
  const out = await dr.expiredUnitAccounts([String(unit._id), String(fine._id)], set);
  assert.deepEqual([...out], [String(unit._id)]);
  // and the archive tallies agree
  const rows = await DropLog.aggregate([
    { $match: { account: unit._id } },
    { $project: { ok: dr.notExpiredExpr() } },
  ]);
  assert.equal(rows[0].ok, false);
});

test("a fresh copy reserved for ANOTHER set never vouches for an expired unit", async () => {
  const set = await DropSet.create({ name: "S", items: [{ itemKey: "a|game" }] });
  const other = new mongoose.Types.ObjectId();
  const acc = await account([
    { k: "a|game", age: 190, reserved: true, setId: set._id },
    { k: "a|game", age: 5, reserved: true, setId: other },
  ]);
  const out = await dr.expiredUnitAccounts([String(acc._id)], set);
  assert.deepEqual([...out], [String(acc._id)]);
  // but an unreserved fresh copy of the same item can still ship with it
  const acc2 = await account([
    { k: "a|game", age: 190, reserved: true, setId: set._id },
    { k: "a|game", age: 5 },
  ]);
  assert.equal((await dr.expiredUnitAccounts([String(acc2._id)], set)).size, 0);
});

test("liveUnits drops expired units and leaves set-less rows alone", async () => {
  const set = await DropSet.create({ name: "S", items: [{ itemKey: "a|game" }] });
  const good = await account([{ k: "a|game", age: 5, reserved: true, setId: set._id }]);
  const bad = await account([{ k: "a|game", age: 190, reserved: true, setId: set._id }]);
  const units = [{ accountId: String(bad._id) }, { accountId: String(good._id) }];
  assert.deepEqual((await dr.liveUnits(units, set._id)).map((u) => u.accountId), [String(good._id)]);
  assert.equal((await dr.liveUnits(units, null)).length, 2);
});

test("PlayerAuctions advertises only live units", async () => {
  const pa = require("../utils/playerauctionsFulfiller");
  if (typeof pa.stockFor !== "function") return; // not exported on this line
  const set = await DropSet.create({ name: "S", items: [{ itemKey: "a|game" }] });
  const good = await account([{ k: "a|game", age: 5, reserved: true, setId: set._id }]);
  const bad = await account([{ k: "a|game", age: 190, reserved: true, setId: set._id }]);
  const row = { set: set._id, units: [{ accountId: String(bad._id) }, { accountId: String(good._id) }] };
  assert.equal(await pa.stockFor(row), 1);
});

test("Eldorado pages a paid order short of good reserved units", () => {
  const eld = require("../utils/eldoradoFulfiller");
  assert.equal(eld.alertsOperator("not enough reserved stock (0 of 1) — restock"), true);
});
