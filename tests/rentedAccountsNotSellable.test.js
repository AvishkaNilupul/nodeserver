// Accounts in a renter's bot stack are never sellable stock (utils/rentedAccounts.js).
// Found 2026-09-30: a bulk pack reserved two of renter bulkfarmall's accounts
// because their old operator records kept a password and unreserved drops.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CRED_SECRET = "rented-accounts-test-secret-0123456789abc";

const mpPath = require.resolve("../utils/marketplaces");
require.cache[mpPath] = { id: mpPath, filename: mpPath, loaded: true, exports: {} };

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt } = require("../utils/secretBox");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const RenterAccount = require("../models/RenterAccount");
const rented = require("../utils/rentedAccounts");

let mongod;
let shop;
let eldorado;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("rentedNotSellable"));
  shop = require("../routes/shopRoutes");
  eldorado = require("../utils/eldoradoFulfiller");
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function account(login, extra = {}) {
  const a = await BotAccount.create({
    clientSecret: "cs-" + login,
    login,
    credUsername: login,
    credPassword: encrypt("pw-" + login),
    hasPassword: true,
    lastScanStatus: "ok",
    ...extra,
  });
  await DropLog.create({
    account: a._id,
    benefitId: "b-" + login,
    login,
    game: "Rocket League",
    itemKey: "rl|decal",
    count: 1,
    connected: false,
    soldAt: null,
  });
  return a;
}

test("a rented account (by ClientSecret or by login) is never sellable; others are", async () => {
  const set = await DropSet.create({
    name: "RL bundle",
    items: [{ itemKey: "rl|decal", name: "Decal", game: "Rocket League", qty: 1 }],
  });
  const free = await account("freeacc1");
  const bySecret = await account("marolmxa66p");
  const byLogin = await account("marol90h1ad");
  const renter = new mongoose.Types.ObjectId();
  await RenterAccount.create({ renter, clientSecret: "cs-marolmxa66p", login: "" });
  await RenterAccount.create({ renter, clientSecret: "some-other-secret", login: "MAROL90H1AD" });
  rented.__resetCache();

  const avail = await shop.availableAccountsForSet(set.toObject());
  assert.deepEqual(avail.map((a) => String(a.accountId)), [String(free._id)]);

  // The Shop / bulk-order stock count reads the same sellable map.
  const stock = await shop.stockForSets([set.toObject()]);
  assert.equal(stock.get(String(set._id)).stock, 1);

  // The claim every Eldorado/G2G/bulk-pack reservation goes through.
  const claimed = await eldorado.claimAccountsForSet(set.toObject(), 5, { claimTag: "eldorado" });
  assert.deepEqual(claimed.map((c) => c.login), ["freeacc1"]);
  for (const a of [bySecret, byLogin]) {
    const d = await DropLog.findOne({ account: a._id }).lean();
    assert.equal(d.soldAt, null, a.login + " was never reserved");
  }

  const ids = await rented.rentedAccountIds([free._id, bySecret._id, byLogin._id]);
  assert.deepEqual([...ids].sort(), [String(bySecret._id), String(byLogin._id)].sort());
});

test("the auto-lister's delivery picker skips rented accounts", async () => {
  const autoLister = require("../utils/autoLister");
  const mk = async (login) => {
    const a = await BotAccount.create({
      clientSecret: "cs-" + login,
      login,
      credUsername: login,
      credPassword: encrypt("pw-" + login),
      hasPassword: true,
      lastScanStatus: "ok",
    });
    await DropLog.create({
      account: a._id, benefitId: "b2-" + login, login, game: "Rocket League",
      itemKey: "rl|banner", count: 1, connected: false, soldAt: null,
    });
    return a;
  };
  await mk("pickfree1");
  await mk("pickrented1");
  await RenterAccount.create({
    renter: new mongoose.Types.ObjectId(), clientSecret: "cs-pickrented1", login: "pickrented1",
  });
  rented.__resetCache();
  const task = { assignedAccounts: ["pickfree1", "pickrented1"] };
  const picked = await autoLister.pickDeliveryAccounts(task, 5, [{ itemKey: "rl|banner", qty: 1 }]);
  assert.deepEqual(picked.map((a) => a.login), ["pickfree1"]);
});

test("a failed renter read is never 'everything is sellable'", async () => {
  rented.__resetCache();
  const real = RenterAccount.find;
  RenterAccount.find = () => ({ lean: async () => { throw new Error("Mongo hiccup"); } });
  try {
    const set = await DropSet.findOne({ name: "RL bundle" }).lean();
    await assert.rejects(() => shop.availableAccountsForSet(set), /Mongo hiccup/);
  } finally {
    RenterAccount.find = real;
    rented.__resetCache();
  }
});
