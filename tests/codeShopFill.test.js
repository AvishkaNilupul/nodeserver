// Code shop fill (utils/codeShop/fill.js, docs/code-shop/03-MARKETS.md).
//
// Fill turns free codes into units of every active product. What matters:
// - it ships dark: nothing is built unless autoBuildUnits is on or the owner
//   forces it;
// - bigger products are served first, nothing inside the expiry lead goes on
//   sale, and a productIds filter really filters;
// - two fills at once (the scheduler's tick and an owner's approve) can waste
//   a claim but never put one code into two units, and never a wrong code into
//   a unit.
//
// Real Mongo via mongodb-memory-server. All codes are made up.
process.env.CRED_SECRET ||= "code-shop-fill-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const { encrypt, decrypt } = require("../utils/secretBox");
const { hashCode, codeShape } = require("../utils/codeShop/slots");
const { createFill } = require("../utils/codeShop/fill");
const { unitText } = require("../utils/codeShop/units");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopfill"));
  await Promise.all([CodeStock, CodeProduct, SuppliedAccount, SoopInventoryItem].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([CodeStock, CodeProduct, SuppliedAccount, SoopInventoryItem].map((m) => m.deleteMany({})));
});

function fakeEvents() {
  const logs = [];
  return { logs, log: async (e) => (logs.push(e), true) };
}

function fakeConfig(cfg = {}) {
  return { get: async () => ({ autoBuildUnits: true, expiryLeadHours: 36, ...cfg }) };
}

function fillWith(cfg = {}, events = fakeEvents()) {
  return { events, fill: createFill({ events, config: fakeConfig(cfg), now: () => NOW }) };
}

let seq = 0;
const allCodes = new Map(); // ledger id -> code (test-side only)

async function seedCode(slotKey, opts = {}) {
  seq += 1;
  const code = `FAKE-${String(seq).padStart(5, "0")}-FILL`;
  const loginId = "login-" + (seq % 5);
  const itemKey = "item-" + seq;
  await SoopInventoryItem.create({ loginId, key: itemKey, kind: "code", hasCode: true, codeEnc: encrypt(code) });
  const row = await CodeStock.create({
    loginId,
    itemKey,
    slotKey,
    codeHash: hashCode(code),
    codeShape: codeShape(code),
    useBy: opts.useBy === undefined ? null : opts.useBy,
    earnedAt: opts.earnedAt === undefined ? null : opts.earnedAt,
  });
  allCodes.set(String(row._id), code);
  return { id: row._id, code };
}

async function seedMany(slotKey, n, opts) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await seedCode(slotKey, opts));
  return out;
}

async function product(name, slotKeys, opts = {}) {
  return CodeProduct.create({
    name,
    status: opts.status || "active",
    offer: opts.offer === undefined ? new ObjectId() : opts.offer,
    slots: slotKeys.map((k, i) => ({ slotKey: k, label: name + " reward " + (i + 1) })),
  });
}

const unitsOf = (p) => SuppliedAccount.find({ offer: p.offer }).lean();

function assertNoCode(value) {
  const s = JSON.stringify(value);
  for (const c of allCodes.values()) assert.ok(!s.includes(c), "a code leaked into logs or results");
}

// ---------------------------------------------------------------- switches

test("fill: ships dark — nothing is built while autoBuildUnits is off, unless forced", async () => {
  const { fill } = fillWith({ autoBuildUnits: false });
  const p = await product("Dark", ["d:A"]);
  await seedMany("d:A", 2);

  const skipped = await fill.run();
  assert.equal(skipped.built, 0);
  assert.equal(skipped.skipped, true);
  assert.equal(await SuppliedAccount.countDocuments({}), 0);
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 2);

  const forced = await fill.run({ force: true });
  assert.equal(forced.built, 2);
  assert.deepEqual(forced.byProduct, { [String(p._id)]: 2 });
  assert.equal((await unitsOf(p)).length, 2);
});

test("fill: only active products with an offer get units", async () => {
  const { fill } = fillWith();
  const live = await product("Live", ["o:A"]);
  const draft = await product("Draft", ["o:A"], { status: "draft" });
  const paused = await product("Paused", ["o:A"], { status: "paused" });
  const noOffer = await product("NoOffer", ["o:A"], { offer: null });
  await seedMany("o:A", 3);

  const res = await fill.run();
  assert.equal(res.built, 3);
  assert.deepEqual(res.byProduct, { [String(live._id)]: 3 });
  for (const p of [draft, paused]) assert.equal((await unitsOf(p)).length, 0);
  assert.equal(await SuppliedAccount.countDocuments({ offer: { $ne: live.offer } }), 0);
  assert.equal(noOffer.offer, null);
});

// ---------------------------------------------------------------- allocation

test("fill: two products sharing slots — the bigger one is served first", async () => {
  const { fill } = fillWith();
  // The smaller product is older, so only the size rule can put the big one first.
  const small = await product("Small", ["b:A", "b:B"]);
  const big = await product("Big", ["b:A", "b:B", "b:C"]);
  await seedMany("b:A", 3);
  await seedMany("b:B", 3);
  await seedMany("b:C", 2);

  const res = await fill.run();
  assert.equal(res.built, 3);
  assert.deepEqual(res.byProduct, { [String(big._id)]: 2, [String(small._id)]: 1 });

  const bigUnits = await unitsOf(big);
  assert.equal(bigUnits.length, 2);
  for (const u of bigUnits) assert.equal(decrypt(u.password).split("\n").length, 3);
  assert.equal((await unitsOf(small)).length, 1);
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 0);
});

test("fill: codes inside the expiry lead stay off sale", async () => {
  const { fill } = fillWith({ expiryLeadHours: 36 });
  const p = await product("Lead", ["e:A"]);
  const soon = await seedCode("e:A", { useBy: new Date(NOW + 35 * HOUR) });
  const later = await seedCode("e:A", { useBy: new Date(NOW + 37 * HOUR) });
  const never = await seedCode("e:A", { useBy: null });

  const res = await fill.run();
  assert.equal(res.built, 2);
  assert.equal((await CodeStock.findById(soon.id).lean()).state, "in_stock");
  assert.equal((await CodeStock.findById(later.id).lean()).state, "in_unit");
  assert.equal((await CodeStock.findById(never.id).lean()).state, "in_unit");
  assert.equal((await unitsOf(p)).length, 2);

  // With a 34 h lead the last one goes too.
  const shorter = fillWith({ expiryLeadHours: 34 }).fill;
  assert.equal((await shorter.run()).built, 1);
  assert.equal((await CodeStock.findById(soon.id).lean()).state, "in_unit");
});

test("fill: a productIds filter builds only those products", async () => {
  const { fill } = fillWith();
  const one = await product("One", ["f:A"]);
  const two = await product("Two", ["f:B"]);
  await seedMany("f:A", 2);
  await seedMany("f:B", 2);

  const res = await fill.run({ productIds: [String(one._id)] });
  assert.equal(res.built, 2);
  assert.deepEqual(res.byProduct, { [String(one._id)]: 2 });
  assert.equal((await unitsOf(two)).length, 0);
  assert.equal(await CodeStock.countDocuments({ slotKey: "f:B", state: "in_stock" }), 2);

  assert.equal((await fill.run({ productIds: [] })).built, 0, "an empty filter builds nothing");
});

test("fill: one event per product that got units, with no code in it", async () => {
  const { fill, events } = fillWith();
  const alpha = await product("Alpha", ["v:A"]);
  const beta = await product("Beta", ["v:B"]);
  await product("Gamma", ["v:C"]); // no stock: no event
  await seedMany("v:A", 2);
  await seedMany("v:B", 1);

  const res = await fill.run();
  assert.equal(res.built, 3);
  const fills = events.logs.filter((e) => e.kind === "fill");
  assert.deepEqual(
    fills.map((e) => [String(e.product), e.msg]).sort(),
    [
      [String(alpha._id), "Added 2 bundles to Alpha"],
      [String(beta._id), "Added 1 bundle to Beta"],
    ].sort(),
  );
  assertNoCode([res, events.logs]);
});

// ---------------------------------------------------------------- concurrency

// Every unit holds exactly its ledger rows' codes, on its slots' lines, and no
// code sits in two units.
async function assertLedgerMatchesUnits(products) {
  const bySlotProduct = new Map(products.map((p) => [String(p.offer), p]));
  const units = await SuppliedAccount.find({}).lean();
  const seen = new Map(); // codeHash -> unit id
  const labels = new Set();
  let lines = 0;
  for (const u of units) {
    const p = bySlotProduct.get(String(u.offer));
    assert.ok(p, "every unit belongs to one of the products");
    assert.ok(!labels.has(u.login), "labels are unique");
    labels.add(u.login);
    const text = decrypt(u.password);
    const rows = await CodeStock.find({ unit: u._id }).lean();
    assert.equal(rows.length, p.slots.length, "a unit holds one ledger row per slot");
    for (const r of rows) assert.equal(r.state, "in_unit");
    // Rebuild the expected text from the ledger, slot by slot.
    const bySlot = new Map(rows.map((r) => [r.slotKey, r]));
    const codes = p.slots.map((s) => {
      const r = bySlot.get(s.slotKey);
      assert.ok(r, "each slot is filled by a row of that slot");
      return allCodes.get(String(r._id));
    });
    assert.equal(text, unitText(p.slots, codes), "the unit holds exactly its rows' codes");
    for (const line of text.split("\n")) {
      lines += 1;
      const h = hashCode(line.slice(line.indexOf(" = ") + 3));
      assert.ok(!seen.has(h), "one code was put into two units");
      seen.set(h, String(u._id));
    }
  }
  // And the other way round: no row claims a unit that does not exist.
  const inUnit = await CodeStock.find({ state: "in_unit" }).lean();
  assert.equal(inUnit.length, lines);
  for (const r of inUnit) assert.equal(seen.get(r.codeHash), String(r.unit));
  assert.equal(await CodeStock.countDocuments({ state: { $nin: ["in_unit", "in_stock"] } }), 0, "nothing was held");
}

test("fill: two fills at once never put one code into two units", async () => {
  const big = await product("Big", ["c:A", "c:B", "c:C"]);
  const small = await product("Small", ["c:A", "c:B"]);
  await seedMany("c:A", 12);
  await seedMany("c:B", 12);
  await seedMany("c:C", 6);

  // Two instances (two processes) and two runs of each, all at once.
  const one = fillWith().fill;
  const two = fillWith().fill;
  const results = await Promise.all([one.run(), two.run(), one.run({ force: true }), two.run()]);
  const built = results.reduce((n, r) => n + r.built, 0);
  assert.ok(built > 0, "something was built");
  assert.equal(built, await SuppliedAccount.countDocuments({}), "every reported unit exists, once");
  await assertLedgerMatchesUnits([big, small]);

  // Lost claims were only lost, not burnt: a calm run builds the rest of the plan.
  await fillWith().fill.run();
  await assertLedgerMatchesUnits([big, small]);
  assert.equal((await unitsOf(big)).length, 6);
  assert.equal((await unitsOf(small)).length, 6);
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 0);
});

test("fill: many fills racing over a small shelf still never share a code", async () => {
  const p = await product("Race", ["z:A", "z:B"]);
  await seedMany("z:A", 5);
  await seedMany("z:B", 5);
  const fills = Array.from({ length: 6 }, () => fillWith().fill);
  await Promise.all(fills.map((f) => f.run()));
  await assertLedgerMatchesUnits([p]);
  await fillWith().fill.run();
  await assertLedgerMatchesUnits([p]);
  assert.equal((await unitsOf(p)).length, 5);
});

test("fill: codes of a farm login that was sold are never bundled", async () => {
  const SoopAccount = require("../models/SoopAccount");
  const { fill } = fillWith();
  const p = await product("SoldLogin", ["s:A"]);
  const codes = await seedMany("s:A", 5); // logins login-1 … login-0 by seq % 5
  const rows = await CodeStock.find({ _id: { $in: codes.map((c) => c.id) } }).lean();
  const soldLogin = rows[0].loginId;
  await SoopAccount.create({ loginId: soldLogin, sold: true });
  try {
    const res = await fill.run();
    assert.equal(res.built, 4);
    const left = await CodeStock.find({ _id: { $in: codes.map((c) => c.id) }, state: "in_stock" }).lean();
    assert.deepEqual(left.map((r) => r.loginId), [soldLogin]);
  } finally {
    await SoopAccount.deleteMany({});
  }
});
