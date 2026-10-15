// Code shop units (utils/codeShop/units.js, docs/code-shop/02-ENGINE.md).
//
// These are the stock rows buyers receive, so the two things under test are
// the two ways a unit costs real money:
//
// - ONE CODE, TWO UNITS. A code reaches a unit only through the status-guarded
//   in_stock -> in_unit claim, and anything that fails after the claim puts
//   back ONLY the rows carrying that attempt's unit id — never a row another
//   unit already won.
// - A WRONG CODE IN A UNIT. Every code is decrypted and checked against its
//   ledger hash (and every row against its slot) before the unit is written.
//
// Plus the way out: dissolve/pull move only `available` units, and ledger rows
// are released only when that move won.
//
// Real Mongo via mongodb-memory-server: the guarded updates are the thing under
// test, and a stub would only prove the stub. All codes are made up.
process.env.CRED_SECRET ||= "code-shop-units-test-secret";

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
const { createUnits, unitText, labelFor } = require("../utils/codeShop/units");
const { deliveryText } = require("../utils/suppliedStock");

const ObjectId = mongoose.Types.ObjectId;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopunits"));
  await Promise.all([CodeStock, CodeProduct, SuppliedAccount, SoopInventoryItem].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([CodeStock, CodeProduct, SuppliedAccount, SoopInventoryItem].map((m) => m.deleteMany({})));
});

// Events are captured, never written; the test checks no code ever reaches them.
function fakeEvents() {
  const logs = [];
  return { logs, log: async (e) => (logs.push(e), true) };
}

function unitsWith(events = fakeEvents()) {
  return { events, units: createUnits({ events, now: () => NOW }) };
}

let seq = 0;

// One stored code: an inventory row holding it encrypted, and its ledger row.
async function seedCode(slotKey, opts = {}) {
  seq += 1;
  const code = opts.code || `FAKE-${String(seq).padStart(4, "0")}-TEST-CODE`;
  const loginId = opts.loginId || "login-" + (seq % 3);
  const itemKey = "item-" + seq;
  await SoopInventoryItem.create({ loginId, key: itemKey, kind: "code", hasCode: true, codeEnc: encrypt(code) });
  const row = await CodeStock.create({
    loginId,
    itemKey,
    slotKey,
    codeHash: hashCode(code),
    codeShape: codeShape(code),
    state: opts.state || "in_stock",
    unit: opts.unit || null,
    product: opts.product || null,
    useBy: opts.useBy === undefined ? null : opts.useBy,
  });
  return { id: row._id, code, loginId, itemKey, slotKey };
}

async function activeProduct(slotKeys, opts = {}) {
  return CodeProduct.create({
    name: opts.name || "Test bundle",
    status: opts.status || "active",
    offer: opts.offer === undefined ? new ObjectId() : opts.offer,
    slots: slotKeys.map((k, i) => ({ slotKey: k, label: "Reward " + String.fromCharCode(65 + i) })),
  });
}

const lean = (id) => CodeStock.findById(id).lean();

// Nothing a unit module logs or returns may carry a code.
function assertNoCode(value, codes) {
  const s = JSON.stringify(value);
  for (const c of codes) assert.ok(!s.includes(c), "a code leaked into logs or results");
}

// ---------------------------------------------------------------- pure helpers

test("unitText: one numbered line per slot, in slot order", () => {
  const slots = [{ label: "Sun Tea Player Icon" }, { label: "Spray" }, { label: "Name Card" }];
  assert.equal(
    unitText(slots, ["AAAA-1111", "BBBB-2222", "CCCC-3333"]),
    "1) Sun Tea Player Icon = AAAA-1111\n2) Spray = BBBB-2222\n3) Name Card = CCCC-3333",
  );
  assert.equal(unitText([{ label: "Only" }], ["X"]), "1) Only = X");
  // A missing label never reaches a buyer as the word "undefined".
  assert.equal(unitText([{}], ["X"]), "1)  = X");
});

test("labelFor: cs-<last 6 of the product id>-<seq>", () => {
  assert.equal(labelFor(new ObjectId("0123456789abcdef01abcdef"), 7), "cs-abcdef-7");
  assert.equal(labelFor("0123456789abcdef01234567", 12), "cs-234567-12");
});

// ---------------------------------------------------------------- build

test("build: writes each unit with exactly its codes in slot order, and moves the rows into it", async () => {
  const { units, events } = unitsWith();
  const product = await activeProduct(["s:A", "s:B", "s:C"]);
  const u1 = [await seedCode("s:A"), await seedCode("s:B"), await seedCode("s:C")];
  const u2 = [await seedCode("s:A"), await seedCode("s:B"), await seedCode("s:C")];

  const res = await units.build(product.toObject(), [u1.map((c) => c.id), u2.map((c) => c.id)]);
  assert.equal(res.built, 2);
  assert.equal(res.failed, 0);
  assert.equal(res.unitIds.length, 2);

  const after = await CodeProduct.findById(product._id).lean();
  assert.equal(after.unitSeq, 2, "the label counter moved once per unit");

  for (const [i, codes] of [u1, u2].entries()) {
    const unit = await SuppliedAccount.findById(res.unitIds[i]);
    assert.ok(unit, "the unit was created with the pre-generated id");
    assert.equal(String(unit.offer), String(product.offer));
    assert.equal(unit.login, labelFor(product._id, i + 1));
    assert.equal(unit.status, "available");
    assert.equal(unit.conflict, "");
    assert.equal(unit.note, "code unit");
    assert.ok(unit.password.startsWith("enc:"), "the buyer text is stored encrypted");
    const expected =
      `1) Reward A = ${codes[0].code}\n2) Reward B = ${codes[1].code}\n3) Reward C = ${codes[2].code}`;
    assert.equal(decrypt(unit.password), expected);
    // What the existing fulfillers hand over with a "{password}" template.
    assert.equal(deliveryText(unit, { deliveryTemplate: "{password}" }), expected);

    for (const c of codes) {
      const row = await lean(c.id);
      assert.equal(row.state, "in_unit");
      assert.equal(String(row.unit), String(unit._id));
      assert.equal(String(row.product), String(product._id));
      assert.equal(String(row.offer), String(product.offer));
      assert.equal(row.unitStatus, "available");
      assert.deepEqual(
        row.history.map((h) => [h.from, h.to]),
        [["in_stock", "in_unit"]],
      );
    }
  }
  assertNoCode([res, events.logs], [...u1, ...u2].map((c) => c.code));
});

test("build: a lost claim writes nothing, puts back only its own rows and leaves the other unit alone", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["r:A", "r:B", "r:C"]);
  const otherUnit = new ObjectId();
  const otherProduct = new ObjectId();
  const a = await seedCode("r:A");
  const taken = await seedCode("r:B", { state: "in_unit", unit: otherUnit, product: otherProduct });
  const c = await seedCode("r:C");
  const takenBefore = await lean(taken.id);

  const res = await units.build(product, [[a.id, taken.id, c.id]]);
  assert.deepEqual({ built: res.built, failed: res.failed }, { built: 0, failed: 1 });
  assert.deepEqual(res.unitIds, []);

  assert.equal(await SuppliedAccount.countDocuments({ offer: product.offer }), 0, "no unit was written");
  assert.equal((await CodeProduct.findById(product._id).lean()).unitSeq, 0, "no label was spent");
  for (const id of [a.id, c.id]) {
    const row = await lean(id);
    assert.equal(row.state, "in_stock");
    assert.equal(row.unit, null);
    assert.equal(row.product, null);
    assert.equal(row.offer, null);
    assert.equal(row.unitStatus, "");
    assert.deepEqual(
      row.history.map((h) => [h.from, h.to]),
      [["in_stock", "in_unit"], ["in_unit", "in_stock"]],
    );
  }
  const takenAfter = await lean(taken.id);
  assert.equal(takenAfter.state, "in_unit");
  assert.equal(String(takenAfter.unit), String(otherUnit));
  assert.equal(String(takenAfter.product), String(otherProduct));
  assert.deepEqual(takenAfter.history, takenBefore.history, "the other unit's row was not touched");
});

test("build: a code that does not match its hash holds that row, writes no unit, and the rest go back", async () => {
  const { units, events } = unitsWith();
  const product = await activeProduct(["h:A", "h:B", "h:C"]);
  const a = await seedCode("h:A");
  const b = await seedCode("h:B");
  const c = await seedCode("h:C");
  // The stored code changed after ingest hashed it.
  await SoopInventoryItem.updateOne({ loginId: b.loginId, key: b.itemKey }, { $set: { codeEnc: encrypt("FAKE-CHANGED-CODE") } });
  // A second unit in the same call still gets built.
  const ok = [await seedCode("h:A"), await seedCode("h:B"), await seedCode("h:C")];

  const res = await units.build(product, [[a.id, b.id, c.id], ok.map((x) => x.id)]);
  assert.equal(res.built, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.held, 1);

  const bad = await lean(b.id);
  assert.equal(bad.state, "held");
  assert.equal(bad.problem, "stored code is missing or changed");
  assert.equal(bad.unit, null);
  for (const id of [a.id, c.id]) {
    const row = await lean(id);
    assert.equal(row.state, "in_stock");
    assert.equal(row.unit, null);
  }
  const written = await SuppliedAccount.find({ offer: product.offer });
  assert.equal(written.length, 1, "only the good unit was written");
  assert.equal(decrypt(written[0].password), unitText(product.slots, ok.map((x) => x.code)));
  assert.equal(written[0].login, labelFor(product._id, 1), "the failed unit spent no label");

  const warn = events.logs.find((e) => e.kind === "code-held");
  assert.ok(warn, "the held code is reported");
  assertNoCode([res, events.logs], ["FAKE-CHANGED-CODE", a.code, b.code, c.code, ...ok.map((x) => x.code)]);
});

test("build: a code missing from the inventory is held too", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["m:A", "m:B"]);
  const a = await seedCode("m:A");
  const b = await seedCode("m:B");
  await SoopInventoryItem.deleteOne({ loginId: a.loginId, key: a.itemKey });

  const res = await units.build(product, [[a.id, b.id]]);
  assert.deepEqual({ built: res.built, failed: res.failed, held: res.held }, { built: 0, failed: 1, held: 1 });
  assert.equal((await lean(a.id)).state, "held");
  assert.equal((await lean(b.id)).state, "in_stock");
  assert.equal(await SuppliedAccount.countDocuments({ offer: product.offer }), 0);
});

test("build: a code that is not the reward its slot names is put back, never written", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["k:A", "k:B"]);
  const a = await seedCode("k:A");
  const b = await seedCode("k:B");

  // Slot order swapped: the plan would put B's code on A's line.
  const res = await units.build(product, [[b.id, a.id]]);
  assert.deepEqual({ built: res.built, failed: res.failed }, { built: 0, failed: 1 });
  assert.equal((await lean(a.id)).state, "in_stock");
  assert.equal((await lean(b.id)).state, "in_stock");
  assert.equal(await SuppliedAccount.countDocuments({ offer: product.offer }), 0);
});

test("build: a unit row that cannot be written (label already taken) puts its rows back", async () => {
  const { units, events } = unitsWith();
  const product = await activeProduct(["d:A", "d:B"]);
  // Something already sits under the label the first unit would get.
  const squatter = await SuppliedAccount.create({
    offer: product.offer,
    login: labelFor(product._id, 1),
    password: encrypt("not a code unit"),
  });
  const first = [await seedCode("d:A"), await seedCode("d:B")];
  const second = [await seedCode("d:A"), await seedCode("d:B")];

  const res = await units.build(product, [first.map((c) => c.id), second.map((c) => c.id)]);
  assert.equal(res.built, 1);
  assert.equal(res.failed, 1);

  for (const c of first) {
    const row = await lean(c.id);
    assert.equal(row.state, "in_stock", "the failed unit's codes are back in stock");
    assert.equal(row.unit, null);
  }
  const units2 = await SuppliedAccount.find({ offer: product.offer }).sort({ login: 1 });
  assert.equal(units2.length, 2, "the squatter and the second unit");
  const squatterAfter = await SuppliedAccount.findById(squatter._id);
  assert.equal(decrypt(squatterAfter.password), "not a code unit", "the existing row was not touched");
  const built = units2.find((u) => String(u._id) !== String(squatter._id));
  assert.equal(built.login, labelFor(product._id, 2));
  assert.equal(decrypt(built.password), unitText(product.slots, second.map((c) => c.code)));
  for (const c of second) assert.equal(String((await lean(c.id)).unit), String(built._id));
  assert.ok(events.logs.some((e) => e.kind === "unit-write"));
  assertNoCode(events.logs, [...first, ...second].map((c) => c.code));
});

test("build: refuses a product that is not active or has no offer, and claims nothing", async () => {
  const { units } = unitsWith();
  const a = await seedCode("n:A");
  for (const opts of [{ status: "draft" }, { status: "paused" }, { status: "retired" }, { offer: null }]) {
    const product = await activeProduct(["n:A"], opts);
    await assert.rejects(units.build(product, [[a.id]]));
  }
  await assert.rejects(units.build(null, [[a.id]]));
  assert.equal((await lean(a.id)).state, "in_stock");
  assert.equal(await SuppliedAccount.countDocuments({}), 0);
});

test("build: a product paused after the plan gets no unit, and its codes go back", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["p:A"]);
  const stale = product.toObject(); // what the caller read while it was active
  await CodeProduct.updateOne({ _id: product._id }, { $set: { status: "paused" } });
  const a = await seedCode("p:A");
  const b = await seedCode("p:A");

  const res = await units.build(stale, [[a.id], [b.id]]);
  assert.equal(res.built, 0);
  assert.equal(res.failed, 2, "it stops, and the units it did not try count as failed");
  assert.equal((await lean(a.id)).state, "in_stock");
  assert.equal((await lean(b.id)).state, "in_stock");
  assert.equal(await SuppliedAccount.countDocuments({}), 0);
  assert.equal((await CodeProduct.findById(product._id).lean()).unitSeq, 0);
});

test("build: a plan with the wrong number of codes or a repeated code is never claimed", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["w:A", "w:B"]);
  const a = await seedCode("w:A");
  const b = await seedCode("w:B");
  const res = await units.build(product, [[a.id], [a.id, a.id], [a.id, "not-an-id"]]);
  assert.deepEqual({ built: res.built, failed: res.failed }, { built: 0, failed: 3 });
  assert.equal((await lean(a.id)).history.length, 0, "nothing was claimed");
  assert.equal((await lean(b.id)).state, "in_stock");
});

// ---------------------------------------------------------------- dissolve / pull

// Build `n` units of a one-slot product and return their ids.
async function builtUnits(units, product, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push([(await seedCode(product.slots[0].slotKey)).id]);
  const res = await units.build(product, ids);
  assert.equal(res.built, n);
  return res.unitIds;
}

test("dissolve: only available units go, and only their rows come back to stock", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["x:A"]);
  const [availableId, fedId, soldId, staleId] = await builtUnits(units, product, 4);

  // fed: in a platform vault, and the ledger knows it.
  await SuppliedAccount.updateOne({ _id: fedId }, { $set: { status: "fed", market: "ggsel" } });
  await CodeStock.updateMany({ unit: fedId }, { $set: { unitStatus: "fed", wasFed: true } });
  // sold: a buyer has it, and the ledger knows it.
  await SuppliedAccount.updateOne({ _id: soldId }, { $set: { status: "sold", market: "eldorado" } });
  await CodeStock.updateMany({ unit: soldId }, { $set: { state: "sold", unitStatus: "sold" } });
  // stale: sold a moment ago, the ledger has not caught up yet.
  await SuppliedAccount.updateOne({ _id: staleId }, { $set: { status: "sold", market: "eldorado" } });

  const res = await units.dissolve(product, { reason: "moved to another bundle" });
  assert.equal(res.dissolved, 1);

  const gone = await SuppliedAccount.findById(availableId).lean();
  assert.equal(gone.status, "removed");
  assert.equal(gone.note, "code unit — moved to another bundle");
  const freed = await CodeStock.findOne({ product: null, state: "in_stock" }).lean();
  assert.ok(freed, "the dissolved unit's code is back in stock");
  assert.equal(await CodeStock.countDocuments({ unit: availableId }), 0);

  assert.equal((await SuppliedAccount.findById(fedId).lean()).status, "fed");
  assert.equal((await CodeStock.findOne({ unit: fedId }).lean()).state, "in_unit");
  assert.equal((await SuppliedAccount.findById(soldId).lean()).status, "sold");
  assert.equal((await CodeStock.findOne({ unit: soldId }).lean()).state, "sold");
  // The stale one: the unit did not move, so its row was not released.
  assert.equal((await SuppliedAccount.findById(staleId).lean()).status, "sold");
  const staleRow = await CodeStock.findOne({ unit: staleId }).lean();
  assert.equal(staleRow.state, "in_unit");
  assert.equal(String(staleRow.product), String(product._id));
});

test("dissolve: honours the limit and leaves the rest on sale", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["l:A"]);
  const ids = await builtUnits(units, product, 3);
  const res = await units.dissolve(product._id, { reason: "fewer", limit: 1 });
  assert.equal(res.dissolved, 1);
  const statuses = (await SuppliedAccount.find({ _id: { $in: ids } }).lean()).map((u) => u.status).sort();
  assert.deepEqual(statuses, ["available", "available", "removed"]);
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 1);
  assert.equal(await CodeStock.countDocuments({ state: "in_unit" }), 2);
});

test("pull: true only when it moved an available unit; a sold one is left alone", async () => {
  const { units } = unitsWith();
  const product = await activeProduct(["q:A"]);
  const [freeId, soldId] = await builtUnits(units, product, 2);
  await SuppliedAccount.updateOne({ _id: soldId }, { $set: { status: "sold" } });

  assert.equal(await units.pull(soldId, { note: "code unit — pulled before its codes stop working" }), false);
  assert.equal((await SuppliedAccount.findById(soldId).lean()).status, "sold");

  assert.equal(await units.pull(freeId, { note: "code unit — pulled before its codes stop working" }), true);
  const pulled = await SuppliedAccount.findById(freeId).lean();
  assert.equal(pulled.status, "removed");
  assert.equal(pulled.note, "code unit — pulled before its codes stop working");
  assert.equal(await units.pull(freeId, {}), false, "a second pull does not win again");
  assert.equal(await units.pull(new ObjectId(), {}), false);
  assert.equal(await units.pull("nope", {}), false);

  // Ledger rows are the caller's job.
  assert.equal((await CodeStock.findOne({ unit: freeId }).lean()).state, "in_unit");
});

// ---------------------------------------------------------------- uncertain writes

test("build: a write that landed but reported an error counts as built; the codes stay in it", async () => {
  const events = fakeEvents();
  const landedThenThrew = {
    create: async (doc) => {
      await SuppliedAccount.create(doc);
      throw new Error("connection reset after the insert");
    },
    exists: (q) => SuppliedAccount.exists(q),
  };
  const units = createUnits({ events, now: () => NOW, models: { SuppliedAccount: landedThenThrew } });
  const product = await activeProduct(["u:A"]);
  const a = await seedCode("u:A");

  const res = await units.build(product, [[a.id]]);
  assert.equal(res.built, 1);
  const row = await lean(a.id);
  assert.equal(row.state, "in_unit", "never put back next to a unit that exists");
  assert.equal(String(row.unit), String(res.unitIds[0]));
  assert.equal(decrypt((await SuppliedAccount.findById(res.unitIds[0])).password), unitText(product.slots, [a.code]));
});

test("build: when it cannot tell whether the write landed, the codes stay on the unit id and the build stops", async () => {
  const events = fakeEvents();
  const unknown = {
    create: async () => {
      throw new Error("timed out");
    },
    exists: async () => {
      throw new Error("timed out");
    },
  };
  const units = createUnits({ events, now: () => NOW, models: { SuppliedAccount: unknown } });
  const product = await activeProduct(["v:A"]);
  const a = await seedCode("v:A");
  const b = await seedCode("v:A");

  const res = await units.build(product, [[a.id], [b.id]]);
  assert.deepEqual({ built: res.built, failed: res.failed }, { built: 0, failed: 2 });
  // Not back in stock: the reconciler decides from whether the unit exists.
  assert.equal((await lean(a.id)).state, "in_unit");
  assert.equal((await lean(b.id)).state, "in_stock", "the next unit was not tried");
});
