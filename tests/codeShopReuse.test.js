// Code shop — a farm login is used again and again (owner, 2026-10-16: "we are
// not selling the accounts, we are selling codes ... the accts can be used again
// and again, only thing we need to be careful is track the codes").
//
// One path through the real modules, ingest -> fill -> sale -> reconcile, twice:
// - selling a bundle never marks its farm logins sold: they stay farmable;
// - the same login's codes from a later campaign are ingested as new ledger
//   rows and go into NEW bundles;
// - every code is in at most one bundle, a sold code never comes back to stock,
//   and the Logins view counts each login's codes over its whole life.
//
// Real Mongo via mongodb-memory-server. Codes, logins and campaigns are made up
// (the repository is public).
process.env.CRED_SECRET ||= "codeshop-reuse-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const SoopCampaign = require("../models/SoopCampaign");
const SoopAccount = require("../models/SoopAccount");
const SoopActivity = require("../models/SoopActivity");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { canFarm } = require("../utils/soop/farmViews");
const { createIngest } = require("../utils/codeShop/ingest");
const { createFill } = require("../utils/codeShop/fill");
const { createReconcile } = require("../utils/codeShop/reconcile");
const { createViews } = require("../utils/codeShop/views");

const DAY = 24 * 3600 * 1000;
const ALL = [
  CodeStock, CodeProduct, AccountOffer, SuppliedAccount, MarketplaceListing,
  SoopInventoryItem, SoopCampaign, SoopAccount, SoopActivity,
];

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopreuse"));
  // The duplicate guards are unique indexes: build them.
  await Promise.all(ALL.map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

function fakeEvents() {
  const logs = [];
  return {
    logs,
    log: async (e) => (logs.push(e), true),
    stamp: async () => true,
    has: async () => false,
    recent: async () => [],
  };
}

const config = {
  get: async () => ({
    autoBuildUnits: true,
    expiryLeadHours: 36,
    markets: { eldorado: true },
    games: { 12: { sell: true, marketGame: "Overwatch", displayName: "Overwatch 2" } },
  }),
};

const ALL_CODES = new Set();
let codeSeq = 0;
function newCode() {
  codeSeq += 1;
  const code = `RU${String(codeSeq).padStart(2, "0")}-QWER-TYUIO-PASD-FGHJ`;
  ALL_CODES.add(code);
  return code;
}

const RAW_A = "가을 드롭스 1주차";
const RAW_B = "가을 드롭스 2주차";

// One stored reward code as the farm's inventory reader leaves it.
let keySeq = 0;
async function earn(loginId, dropsName, nameRaw, name) {
  keySeq += 1;
  const key = "reuse-inv-" + keySeq;
  const useExpDate = "2027-02-28 23:59:00";
  await SoopInventoryItem.create({
    loginId,
    key,
    division: "acquired",
    kind: "code",
    hasCode: true,
    codeEnc: secretBox.encrypt(newCode()),
    gameNo: "12",
    gameName: "Overwatch 2",
    name,
    nameRaw,
    sentAt: new Date(Date.now() - DAY),
    expiresAt: slots.parseKst(useExpDate),
    used: true,
    raw: { itemCodeIdx: "idx-" + key, itemName: nameRaw, useExpDate },
    claim: { kind: "code", message: "", description: "", gameTitle: "", dropsName },
  });
  return key;
}

async function activeProduct(name, slotKeys) {
  const offer = await AccountOffer.create({ title: name, game: "Overwatch", status: "active", priceUsd: 2.49 });
  const product = await CodeProduct.create({
    name,
    gameNo: "12",
    status: "active",
    origin: "auto",
    offer: offer._id,
    slots: slotKeys.map((k, i) => ({ slotKey: k, label: `${name} reward ${i + 1}` })),
    pricing: { mode: "fixed", priceUsd: 2.49 },
  });
  return { offer, product };
}

// What a market sale leaves on a unit: the fulfiller marks it sold and delivered.
async function sell(unitId, orderId) {
  const at = new Date(Date.now() - 60 * 1000);
  await SuppliedAccount.updateOne(
    { _id: unitId, status: "available" },
    { $set: { status: "sold", market: "eldorado", orderId, soldAt: at, deliveredAt: at } },
  );
}

const slotKeysOf = async (groupSuffix) =>
  [...new Set((await CodeStock.find({ groupKey: "12:" + groupSuffix }, { slotKey: 1 }).lean()).map((r) => r.slotKey))].sort();

// Every code inside every unit, read back from the units themselves (test side only).
async function codesInUnits() {
  const out = [];
  for (const u of await SuppliedAccount.find({}).lean()) {
    for (const line of secretBox.decrypt(u.password).split("\n")) {
      const m = /=\s*(\S+)\s*$/.exec(line);
      if (m) out.push({ unit: String(u._id), code: m[1] });
    }
  }
  return out;
}

test("a farm login keeps farming after its codes sell, and its later codes fill new bundles", async () => {
  const events = fakeEvents();
  const deps = { secret: secretBox, events, config, now: () => Date.now() };
  const ingest = createIngest(deps);
  const fill = createFill(deps);
  const reconcile = createReconcile(deps);
  const views = createViews(deps);

  await SoopAccount.create([
    { loginId: "reuse-login-1", status: "ok" },
    { loginId: "reuse-login-2", status: "ok" },
  ]);
  await SoopCampaign.create([
    { dropsIdx: "7001", title: "Autumn Drops Week 1", titleRaw: RAW_A, gameNo: "12", startDate: new Date(Date.now() - 9 * DAY), endDate: new Date(Date.now() - 2 * DAY) },
    { dropsIdx: "7002", title: "Autumn Drops Week 2", titleRaw: RAW_B, gameNo: "12", startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + 9 * DAY) },
  ]);

  // ---- campaign 1: both logins earn the same two rewards
  for (const login of ["reuse-login-1", "reuse-login-2"]) {
    await earn(login, RAW_A, "해 스프레이", "Sun Spray");
    await earn(login, RAW_A, "달 아이콘", "Moon Icon");
  }
  await ingest.run();
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 4);
  const slotsA = await slotKeysOf("7001");
  assert.equal(slotsA.length, 2, "the same reward from two logins shares one slot");

  const shopA = await activeProduct("Week 1 bundle", slotsA);
  const built1 = await fill.run();
  assert.equal(built1.built, 2, "two logins x one set = two bundles");
  const unitsA = await SuppliedAccount.find({ offer: shopA.offer._id }).lean();
  assert.equal(unitsA.length, 2);

  // ---- the first sale
  await sell(unitsA[0]._id, "order-1");
  const rec1 = await reconcile.run();
  assert.equal(rec1.sold, 2, "both codes of the sold bundle are sold");

  // Selling codes never touches the logins: both stay farmable.
  for (const a of await SoopAccount.find({}).lean()) {
    assert.equal(a.sold, false, `${a.loginId} must not be marked sold by a code sale`);
    assert.ok(canFarm(a), `${a.loginId} must stay farmable`);
  }

  // ---- campaign 2: login 1 earns new rewards, and login 2 the same ones
  for (const login of ["reuse-login-1", "reuse-login-2"]) {
    await earn(login, RAW_B, "바나나 고양이 스프레이", "Banana Cat Spray");
    await earn(login, RAW_B, "가을 명함", "Autumn Name Card");
  }
  await ingest.run();
  const slotsB = await slotKeysOf("7002");
  assert.equal(slotsB.length, 2);
  assert.equal(await CodeStock.countDocuments({ groupKey: "12:7002", state: "in_stock" }), 4, "the later codes are new rows, in stock");

  const shopB = await activeProduct("Week 2 bundle", slotsB);
  const built2 = await fill.run();
  assert.equal(built2.built, 2, "the same logins fill two new bundles");
  assert.equal(await SuppliedAccount.countDocuments({ offer: shopB.offer._id }), 2);

  // The first campaign's sold codes never came back, and its unsold bundle is still whole.
  assert.equal(await CodeStock.countDocuments({ groupKey: "12:7001", state: "sold" }), 2);
  assert.equal(await CodeStock.countDocuments({ groupKey: "12:7001", state: "in_unit" }), 2);

  // ---- a second sale, from the second campaign
  const unitsB = await SuppliedAccount.find({ offer: shopB.offer._id }).sort({ _id: 1 }).lean();
  await sell(unitsB[0]._id, "order-2");
  await reconcile.run();
  assert.equal(await CodeStock.countDocuments({ state: "sold" }), 4);

  // ---- tracking: every code in at most one bundle, ledger and units agree
  const inUnits = await codesInUnits();
  assert.equal(inUnits.length, 8, "4 bundles x 2 codes");
  assert.equal(new Set(inUnits.map((x) => x.code)).size, 8, "no code is in two bundles");
  for (const x of inUnits) assert.ok(ALL_CODES.has(x.code));
  const rows = await CodeStock.find({}).lean();
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((r) => r.codeHash)).size, 8);
  for (const r of rows) {
    assert.ok(r.unit, "every code points at its bundle");
    const inThatUnit = inUnits.filter((x) => x.unit === String(r.unit)).map((x) => slots.hashCode(x.code));
    assert.ok(inThatUnit.includes(r.codeHash), "the ledger row's bundle really holds its code");
  }

  // A run with nothing new changes nothing, and nothing sold goes back to stock.
  await ingest.run();
  await fill.run();
  await reconcile.run();
  assert.equal(await CodeStock.countDocuments({}), 8);
  assert.equal(await CodeStock.countDocuments({ state: "sold" }), 4);
  assert.equal(await SuppliedAccount.countDocuments({}), 4);

  // The Logins view tracks each login over its whole life: 2 campaigns x 2 codes.
  const { logins } = await views.logins();
  const byId = Object.fromEntries(logins.map((l) => [l.loginId, l]));
  for (const id of ["reuse-login-1", "reuse-login-2"]) {
    assert.equal(byId[id].codes, 4, `${id} earned 4 codes in all`);
    assert.equal(byId[id].sold + byId[id].onSale + byId[id].inStock, 4);
  }
  assert.equal(byId["reuse-login-1"].sold + byId["reuse-login-2"].sold, 4);

  // Still nobody marked sold, and nothing above logged a code.
  assert.equal(await SoopAccount.countDocuments({ sold: true }), 0);
  const logged = JSON.stringify(events.logs);
  for (const c of ALL_CODES) assert.ok(!logged.includes(c), "a code leaked into the event log");
});
