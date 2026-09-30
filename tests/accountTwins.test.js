// One Twitch account, two BotAccount records ("twins", utils/accountTwins.js).
// Found 2026-09-30: Eldorado order c8650c3c paid for 5 accounts and was sent
// marolw93x7w twice; G2G order 1790705383264O9BE-1 paid for 2 and was sent
// maroly2pq28 twice. Every seller path listed candidates per RECORD.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CRED_SECRET = "account-twins-test-secret-0123456789abcdef";

const mpPath = require.resolve("../utils/marketplaces");
require.cache[mpPath] = { id: mpPath, filename: mpPath, loaded: true, exports: {} };

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt } = require("../utils/secretBox");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const twins = require("../utils/accountTwins");
const rented = require("../utils/rentedAccounts");

let mongod;
let shop;
let eldorado;
let autoLister;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("accountTwins"));
  shop = require("../routes/shopRoutes");
  eldorado = require("../utils/eldoradoFulfiller");
  autoLister = require("../utils/autoLister");
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const KEYS = ["rl|decal", "rl|wheel"];
let seq = 0;

async function clean() {
  await Promise.all([BotAccount.deleteMany({}), DropLog.deleteMany({}), DropSet.deleteMany({})]);
  twins.__resetCache();
  rented.__resetCache();
}

// A record for `login` holding the set's two items (free unless `drops` says
// otherwise) plus any extra rows.
async function record(login, { drops = {}, extra = [] } = {}) {
  seq += 1;
  const a = await BotAccount.create({
    clientSecret: "cs-" + login + "-" + seq,
    login,
    credUsername: login,
    credPassword: encrypt("pw-" + login),
    hasPassword: true,
    lastScanStatus: "ok",
  });
  for (const itemKey of KEYS) {
    const d = drops[itemKey] || {};
    await DropLog.create({
      account: a._id,
      benefitId: "b-" + itemKey + "-" + seq,
      login,
      game: "Rocket League",
      itemKey,
      count: 1,
      connected: !!d.connected,
      soldAt: d.soldAt || null,
      soldToUsername: d.soldAt ? "eldorado" : "",
    });
  }
  for (const e of extra) {
    await DropLog.create({
      account: a._id,
      benefitId: "x-" + e.itemKey + "-" + seq,
      login,
      game: "Other",
      itemKey: e.itemKey,
      count: 1,
      connected: !!e.connected,
      soldAt: e.soldAt || null,
    });
  }
  return a;
}

async function rlSet() {
  const s = await DropSet.create({
    name: "RL bundle " + seq,
    items: KEYS.map((k) => ({ itemKey: k, name: k, game: "Rocket League", qty: 1 })),
  });
  return s.toObject();
}

const logins = (list) => list.map((x) => x.login).sort();

test("a twin is offered and counted once", async () => {
  await clean();
  await record("solo1");
  await record("twinacc");
  await record("TwinAcc"); // the same account, a second record (login case differs)
  const set = await rlSet();

  const avail = await shop.availableAccountsForSet(set);
  assert.deepEqual(logins(avail).map((l) => l.toLowerCase()), ["solo1", "twinacc"]);
  const stock = await shop.stockForSets([set]);
  assert.equal(stock.get(String(set._id)).stock, 2);
});

test("a twin whose other record's copy is reserved, sold or claimed is not offered", async () => {
  await clean();
  await record("solo1");
  // Other record: one of the set's items already reserved for a sale.
  await record("twinsold", { drops: { "rl|decal": { soldAt: new Date() } } });
  await record("twinsold");
  // Other record: one of the set's items already claimed by a buyer.
  await record("twinconn", { drops: { "rl|wheel": { connected: true } } });
  await record("twinconn");
  const set = await rlSet();

  const avail = await shop.availableAccountsForSet(set);
  assert.deepEqual(logins(avail), ["solo1"]);
  assert.equal((await shop.stockForSets([set])).get(String(set._id)).stock, 1);
});

test("a twin whose other record sold something unrelated stays sellable", async () => {
  await clean();
  await record("twinok", { extra: [{ itemKey: "ow|spray", soldAt: new Date() }] });
  await record("twinok");
  const set = await rlSet();
  const avail = await shop.availableAccountsForSet(set);
  assert.deepEqual(logins(avail), ["twinok"]);
});

test("a claim never hands one account over twice (order c8650c3c replayed)", async () => {
  await clean();
  await record("solo1");
  const a = await record("marolw93x7w");
  const b = await record("marolw93x7w");
  await record("solo2");
  const set = await rlSet();

  const claimed = await eldorado.claimAccountsForSet(set, 5, { claimTag: "eldorado" });
  assert.deepEqual(logins(claimed), ["marolw93x7w", "solo1", "solo2"]);
  // Exactly one of the two records was reserved; the other was never touched.
  const reserved = await DropLog.countDocuments({ account: { $in: [a._id, b._id] }, soldAt: { $ne: null } });
  assert.equal(reserved, KEYS.length);
  // And the untouched twin is not for sale afterwards: its drops are gone.
  assert.deepEqual(await shop.availableAccountsForSet(set), []);
});

test("the auto-lister picks a twin once and skips a twin whose drops are gone", async () => {
  await clean();
  await record("twinacc");
  await record("twinacc");
  await record("twinsold", { drops: { "rl|decal": { soldAt: new Date() } } });
  await record("twinsold");
  await record("solo1");
  const items = KEYS.map((k) => ({ itemKey: k, qty: 1 }));
  const task = { assignedAccounts: ["twinacc", "twinsold", "solo1"] };
  const picked = await autoLister.pickDeliveryAccounts(task, 10, items);
  assert.deepEqual(logins(picked), ["solo1", "twinacc"]);
});

test("onePerLogin keeps the first (best-ranked) entry per login, case-insensitively", () => {
  const out = twins.onePerLogin([
    { login: "Alpha", id: 1 },
    { login: "beta", id: 2 },
    { login: "alpha ", id: 3 },
    { login: "", id: 4 },
    { login: "", id: 5 },
  ]);
  assert.deepEqual(out.map((x) => x.id), [1, 2, 4, 5]);
});

test("a failed twin read is never 'everything is sellable'", async () => {
  await clean();
  await record("solo1");
  const set = await rlSet();
  const real = BotAccount.aggregate;
  BotAccount.aggregate = () => {
    throw new Error("Mongo hiccup");
  };
  try {
    await assert.rejects(() => shop.availableAccountsForSet(set), /Mongo hiccup/);
  } finally {
    BotAccount.aggregate = real;
    twins.__resetCache();
  }
});
