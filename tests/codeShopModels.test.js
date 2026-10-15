// The code shop's four models (docs/code-shop/01-DATA.md). What matters here
// is the shape every other code-shop module builds on, and the three indexes
// that keep a code from being sold twice or an alert from being sent twice:
//
// - unique { loginId, itemKey }: one ledger row per stored code;
// - unique codeHash, but only for a real hash: rows whose code was not read
//   yet carry "" and must not collide;
// - unique stampKey, but only for a real stamp: plain log rows carry "".
//
// Plus the markets validator: Gameflip and Plati/Digiseller are blocked, so a
// product naming them must not even save.
//
// Real Mongo via mongodb-memory-server: partial unique indexes are enforced by
// the server, and a stub would only prove the stub. All values are made up.
process.env.CRED_SECRET ||= "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const CodeShopConfig = require("../models/CodeShopConfig");
const CodeShopEvent = require("../models/CodeShopEvent");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopmodels"));
  // Index tests below need the indexes built, not just declared.
  await Promise.all(
    [CodeStock, CodeProduct, CodeShopConfig, CodeShopEvent].map((m) =>
      m.init(),
    ),
  );
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

let seq = 0;
const nextKey = () => "item-" + ++seq;

async function rejectsDuplicate(promise) {
  await assert.rejects(promise, (err) => {
    assert.equal(
      err.code,
      11000,
      "expected a duplicate key error, got " + err.message,
    );
    return true;
  });
}

async function rejectsValidation(promise, path) {
  await assert.rejects(promise, (err) => {
    assert.equal(
      err.name,
      "ValidationError",
      "expected a ValidationError, got " + err.message,
    );
    assert.ok(
      err.errors[path],
      "expected an error on " +
        path +
        ", got " +
        Object.keys(err.errors).join(","),
    );
    return true;
  });
}

async function indexByKey(Model, key) {
  const indexes = await Model.collection.indexes();
  return indexes.find((ix) => JSON.stringify(ix.key) === JSON.stringify(key));
}

// ── CodeStock ───────────────────────────────────────────────────────────────

test("CodeStock: collection name and every default", async () => {
  assert.equal(CodeStock.collection.collectionName, "codestocks");
  const row = await CodeStock.create({
    loginId: "login-a",
    itemKey: nextKey(),
  });
  const doc = await CodeStock.findById(row._id).lean();

  assert.equal(doc.itemId, null);
  for (const f of [
    "gameNo",
    "gameName",
    "groupKey",
    "campaignIdx",
    "campaignTitle",
    "slotKey",
    "nameRaw",
    "name",
    "image",
    "codeHash",
    "codeShape",
    "unitStatus",
    "market",
    "orderId",
    "problem",
  ]) {
    assert.equal(doc[f], "", f);
  }
  for (const f of [
    "campaignEndAt",
    "earnedAt",
    "useBy",
    "unit",
    "product",
    "offer",
    "pulledAt",
    "soldAt",
  ]) {
    assert.equal(doc[f], null, f);
  }
  assert.equal(doc.state, "in_stock");
  assert.equal(doc.wasFed, false);
  assert.equal(doc.saleUsd, 0);
  assert.equal(doc.after.status, "");
  assert.deepEqual(doc.history, []);
  assert.ok(doc.createdAt instanceof Date, "timestamps on");
  assert.ok(doc.updatedAt instanceof Date, "timestamps on");
});

test("CodeStock: loginId and itemKey are required", async () => {
  await rejectsValidation(CodeStock.create({ itemKey: nextKey() }), "loginId");
  await rejectsValidation(CodeStock.create({ loginId: "login-a" }), "itemKey");
});

test("CodeStock: every listed state saves, anything else is refused", async () => {
  for (const state of [
    "in_stock",
    "in_unit",
    "sold",
    "expiring",
    "expired",
    "held",
    "dead",
  ]) {
    const row = await CodeStock.create({
      loginId: "login-states",
      itemKey: nextKey(),
      state,
    });
    assert.equal(row.state, state);
  }
  await rejectsValidation(
    CodeStock.create({
      loginId: "login-a",
      itemKey: nextKey(),
      state: "available",
    }),
    "state",
  );
  await rejectsValidation(
    CodeStock.create({ loginId: "login-a", itemKey: nextKey(), state: "" }),
    "state",
  );
});

test("CodeStock: after.status takes the after-sale values only", async () => {
  for (const status of ["", "ok", "dead", "replaced", "replacement"]) {
    await CodeStock.create({
      loginId: "login-after",
      itemKey: nextKey(),
      after: { status },
    });
  }
  await rejectsValidation(
    CodeStock.create({
      loginId: "login-a",
      itemKey: nextKey(),
      after: { status: "refunded" },
    }),
    "after.status",
  );
});

test("CodeStock: { loginId, itemKey } is unique", async () => {
  const itemKey = nextKey();
  await CodeStock.create({ loginId: "login-u1", itemKey });
  await rejectsDuplicate(CodeStock.create({ loginId: "login-u1", itemKey }));
  // The same key on another login is another code.
  await CodeStock.create({ loginId: "login-u2", itemKey });
  assert.equal(await CodeStock.countDocuments({ itemKey }), 2);
});

test("CodeStock: codeHash is unique only when it is a non-empty string", async () => {
  // Several rows whose code was not read yet: "" (the default), explicit "", null.
  await CodeStock.create({ loginId: "login-h", itemKey: nextKey() });
  await CodeStock.create({ loginId: "login-h", itemKey: nextKey() });
  await CodeStock.create({
    loginId: "login-h",
    itemKey: nextKey(),
    codeHash: "",
  });
  await CodeStock.create({
    loginId: "login-h",
    itemKey: nextKey(),
    codeHash: null,
  });
  await CodeStock.create({
    loginId: "login-h",
    itemKey: nextKey(),
    codeHash: null,
  });

  const hash = "a".repeat(64);
  await CodeStock.create({
    loginId: "login-h",
    itemKey: nextKey(),
    codeHash: hash,
  });
  // The same code stored under another login or key must not get a second row.
  await rejectsDuplicate(
    CodeStock.create({
      loginId: "login-h2",
      itemKey: nextKey(),
      codeHash: hash,
    }),
  );
  await CodeStock.create({
    loginId: "login-h",
    itemKey: nextKey(),
    codeHash: "b".repeat(64),
  });

  const ix = await indexByKey(CodeStock, { codeHash: 1 });
  assert.ok(ix, "codeHash index exists");
  assert.equal(ix.unique, true);
  assert.deepEqual(ix.partialFilterExpression, {
    codeHash: { $type: "string", $gt: "" },
  });
});

test("CodeStock: history entries are { at, from, to, why } and keep the last 20", async () => {
  const row = await CodeStock.create({
    loginId: "login-hist",
    itemKey: nextKey(),
  });
  const base = Date.parse("2026-01-01T00:00:00Z");
  const entries = Array.from({ length: 25 }, (_, i) => ({
    at: new Date(base + i * 1000),
    from: "in_stock",
    to: "in_unit",
    why: "step " + i,
  }));
  // The writers' shape: $push with $slice: -20.
  for (const e of entries) {
    await CodeStock.updateOne(
      { _id: row._id },
      { $push: { history: { $each: [e], $slice: -20 } } },
    );
  }
  const doc = await CodeStock.findById(row._id).lean();
  assert.equal(doc.history.length, 20);
  assert.equal(doc.history[0].why, "step 5");
  assert.equal(doc.history[19].why, "step 24");
  for (const h of doc.history) {
    assert.deepEqual(Object.keys(h).sort(), ["at", "from", "to", "why"]);
    assert.ok(h.at instanceof Date);
  }

  // A pushed entry without `at` still gets a time; missing strings become "".
  await CodeStock.updateOne(
    { _id: row._id },
    { $push: { history: { $each: [{ to: "held" }], $slice: -20 } } },
  );
  const last = (await CodeStock.findById(row._id).lean()).history.at(-1);
  assert.ok(last.at instanceof Date);
  assert.equal(last.from, "");
  assert.equal(last.to, "held");
  assert.equal(last.why, "");
});

test("CodeStock: the listed indexes exist", async () => {
  const unique = await indexByKey(CodeStock, { loginId: 1, itemKey: 1 });
  assert.ok(unique && unique.unique, "unique { loginId, itemKey }");
  for (const key of [
    { state: 1, slotKey: 1 },
    { product: 1, state: 1 },
    { unit: 1 },
    { loginId: 1 },
    { gameNo: 1 },
    { groupKey: 1 },
    { slotKey: 1 },
    { state: 1 },
    { product: 1 },
  ]) {
    assert.ok(await indexByKey(CodeStock, key), "index " + JSON.stringify(key));
  }
});

// ── CodeProduct ─────────────────────────────────────────────────────────────

test("CodeProduct: collection name and every default", async () => {
  assert.equal(CodeProduct.collection.collectionName, "codeproducts");
  const created = await CodeProduct.create({});
  const doc = await CodeProduct.findById(created._id).lean();

  for (const f of [
    "name",
    "gameNo",
    "gameName",
    "marketGame",
    "slotSetHash",
    "approvedBy",
    "note",
  ]) {
    assert.equal(doc[f], "", f);
  }
  assert.deepEqual(doc.groupKeys, []);
  assert.deepEqual(doc.slots, []);
  assert.equal(doc.status, "draft");
  assert.equal(doc.origin, "auto");
  assert.equal(doc.kind, "full");
  assert.equal(doc.edited, false);
  assert.equal(doc.stale, false);
  assert.equal(doc.offer, null);
  assert.equal(doc.unitSeq, 0);
  assert.deepEqual(doc.texts, {
    title: "",
    description: "",
    deliveryTemplate: "",
    coverTitle: "",
    coverServiceText: "",
    coverBullets: [],
  });
  assert.equal(doc.pricing.mode, "fixed");
  assert.equal(doc.pricing.priceUsd, 1);
  assert.equal(doc.pricing.floorUsd, 0.5);
  assert.equal(doc.pricing.clearance, false);
  assert.equal(doc.pricing.followCompetitors, false);
  assert.deepEqual(doc.markets, ["eldorado"]);
  assert.equal(doc.ggsel.vaultSize, 5);
  assert.equal(doc.publish.lastError, "");
  assert.deepEqual(doc.competitors.offers, []);
  assert.deepEqual(doc.competitors.queries, []);
  assert.equal(doc.competitors.lowestSameSetUsd, null);
  assert.equal(doc.useBy, null);
  assert.equal(doc.proposed.units, 0);
  assert.equal(doc.approvedAt, null);
  assert.equal(doc.retiredAt, null);
  assert.ok(doc.createdAt instanceof Date, "timestamps on");
});

test("CodeProduct: status, origin, kind and pricing.mode refuse unknown values", async () => {
  for (const status of ["draft", "active", "paused", "retired"])
    await CodeProduct.create({ status });
  for (const origin of ["auto", "adopted", "manual"])
    await CodeProduct.create({ origin });
  for (const kind of ["full", "leftover", "custom"])
    await CodeProduct.create({ kind });
  for (const mode of ["fixed", "auto"])
    await CodeProduct.create({ pricing: { mode } });

  await rejectsValidation(CodeProduct.create({ status: "live" }), "status");
  await rejectsValidation(CodeProduct.create({ origin: "planner" }), "origin");
  await rejectsValidation(CodeProduct.create({ kind: "bundle" }), "kind");
  await rejectsValidation(
    CodeProduct.create({ pricing: { mode: "smart" } }),
    "pricing.mode",
  );
});

test("CodeProduct: markets may only name eldorado and ggsel", async () => {
  await CodeProduct.create({ markets: ["eldorado"] });
  await CodeProduct.create({ markets: ["ggsel"] });
  await CodeProduct.create({ markets: ["eldorado", "ggsel"] });
  await CodeProduct.create({ markets: [] });

  for (const markets of [
    ["gameflip"],
    ["digiseller"],
    ["plati"],
    ["eldorado", "gameflip"],
    ["Eldorado"],
    ["g2g"],
  ]) {
    await rejectsValidation(CodeProduct.create({ markets }), "markets");
  }

  // A later push onto a saved product is checked too.
  const p = await CodeProduct.create({});
  p.markets.push("digiseller");
  await rejectsValidation(p.save(), "markets");

  // And an update that asks for validators.
  await assert.rejects(
    CodeProduct.updateOne(
      { _id: p._id },
      { $set: { markets: ["gameflip"] } },
      { runValidators: true },
    ),
    /markets/,
  );
  assert.deepEqual((await CodeProduct.findById(p._id).lean()).markets, [
    "eldorado",
  ]);
});

test("CodeProduct: slots and competitor offers keep their shape without sub-ids", async () => {
  const created = await CodeProduct.create({
    slots: [
      {
        slotKey: "s1",
        label: "Test Icon",
        image: "https://example.test/a.png",
        nameRaw: "raw a",
        campaignTitle: "Camp",
      },
      { slotKey: "s2", label: "Test Spray" },
    ],
    competitors: {
      scannedAt: new Date("2026-01-02T00:00:00Z"),
      queries: ["test query"],
      lowestSameSetUsd: 0.75,
      offers: [
        {
          id: "x1",
          title: "Other seller",
          priceUsd: 0.8,
          qty: 3,
          score: 0.9,
          sameSet: true,
          matchedIn: "description",
          form: "account",
        },
      ],
    },
    proposed: { units: 4, at: new Date("2026-01-02T00:00:00Z") },
  });
  const doc = await CodeProduct.findById(created._id).lean();
  assert.deepEqual(doc.slots[0], {
    slotKey: "s1",
    label: "Test Icon",
    image: "https://example.test/a.png",
    nameRaw: "raw a",
    campaignTitle: "Camp",
  });
  assert.deepEqual(doc.slots[1], {
    slotKey: "s2",
    label: "Test Spray",
    image: "",
    nameRaw: "",
    campaignTitle: "",
  });
  assert.deepEqual(doc.competitors.offers[0], {
    id: "x1",
    title: "Other seller",
    priceUsd: 0.8,
    qty: 3,
    score: 0.9,
    sameSet: true,
    matchedIn: "description",
    form: "account",
  });
  assert.equal(doc.competitors.lowestSameSetUsd, 0.75);
  assert.equal(doc.proposed.units, 4);
});

test("CodeProduct: unitSeq moves with $inc", async () => {
  const p = await CodeProduct.create({});
  const a = await CodeProduct.findOneAndUpdate(
    { _id: p._id },
    { $inc: { unitSeq: 1 } },
    { returnDocument: "after" },
  );
  const b = await CodeProduct.findOneAndUpdate(
    { _id: p._id },
    { $inc: { unitSeq: 1 } },
    { returnDocument: "after" },
  );
  assert.equal(a.unitSeq, 1);
  assert.equal(b.unitSeq, 2);
});

test("CodeProduct: the listed indexes exist", async () => {
  for (const key of [{ gameNo: 1 }, { slotSetHash: 1 }, { status: 1 }]) {
    assert.ok(
      await indexByKey(CodeProduct, key),
      "index " + JSON.stringify(key),
    );
  }
});

// ── CodeShopConfig ──────────────────────────────────────────────────────────

test("CodeShopConfig: one document, key main, empty data kept as {}", async () => {
  assert.equal(CodeShopConfig.collection.collectionName, "codeshopconfigs");
  const created = await CodeShopConfig.create({});
  const doc = await CodeShopConfig.findById(created._id).lean();
  assert.equal(doc.key, "main");
  assert.deepEqual(doc.data, {});
  assert.equal(doc.updatedBy, "");
  assert.equal(doc.updatedAt, null);

  await rejectsDuplicate(
    CodeShopConfig.create({ key: "main", data: { autoPublish: true } }),
  );

  // Mixed data round-trips as written.
  await CodeShopConfig.updateOne(
    { key: "main" },
    {
      $set: {
        data: { markets: { ggsel: true }, games: { 12: { sell: false } } },
        updatedBy: "tester",
        updatedAt: new Date(),
      },
    },
  );
  const after = await CodeShopConfig.findOne({ key: "main" }).lean();
  assert.deepEqual(after.data, {
    markets: { ggsel: true },
    games: { 12: { sell: false } },
  });
  assert.equal(after.updatedBy, "tester");

  const ix = await indexByKey(CodeShopConfig, { key: 1 });
  assert.ok(ix && ix.unique, "unique key");
});

// ── CodeShopEvent ───────────────────────────────────────────────────────────

test("CodeShopEvent: defaults, level enum and the 500-char message cap", async () => {
  assert.equal(CodeShopEvent.collection.collectionName, "codeshopevents");
  const before = Date.now();
  const created = await CodeShopEvent.create({ kind: "test" });
  const doc = await CodeShopEvent.findById(created._id).lean();
  assert.ok(doc.at instanceof Date && doc.at.getTime() >= before - 1000);
  assert.equal(doc.level, "info");
  assert.equal(doc.kind, "test");
  assert.equal(doc.product, null);
  assert.equal(doc.msg, "");
  assert.equal(doc.data, null);
  assert.equal(doc.stampKey, "");

  for (const level of ["info", "warn", "error"])
    await CodeShopEvent.create({ level, kind: "test" });
  await rejectsValidation(
    CodeShopEvent.create({ level: "debug", kind: "test" }),
    "level",
  );

  const long = await CodeShopEvent.create({
    kind: "test",
    msg: "m".repeat(800),
  });
  assert.equal((await CodeShopEvent.findById(long._id).lean()).msg.length, 500);
  const short = await CodeShopEvent.create({ kind: "test", msg: "fine" });
  assert.equal(short.msg, "fine");
});

test("CodeShopEvent: rows expire 30 days after `at`", async () => {
  const ix = await indexByKey(CodeShopEvent, { at: 1 });
  assert.ok(ix, "index on at");
  assert.equal(ix.expireAfterSeconds, 30 * 24 * 60 * 60);
});

test("CodeShopEvent: stampKey is unique only when it is a non-empty string", async () => {
  // Plain log rows: default "", explicit "", null — any number of them.
  await CodeShopEvent.create({ kind: "log" });
  await CodeShopEvent.create({ kind: "log" });
  await CodeShopEvent.create({ kind: "log", stampKey: "" });
  await CodeShopEvent.create({ kind: "log", stampKey: null });
  await CodeShopEvent.create({ kind: "log", stampKey: null });

  await CodeShopEvent.create({ kind: "stamp", stampKey: "claim-alert:test-1" });
  await rejectsDuplicate(
    CodeShopEvent.create({ kind: "stamp", stampKey: "claim-alert:test-1" }),
  );
  await CodeShopEvent.create({ kind: "stamp", stampKey: "claim-alert:test-2" });
  assert.equal(
    await CodeShopEvent.countDocuments({ stampKey: "claim-alert:test-1" }),
    1,
  );

  const ix = await indexByKey(CodeShopEvent, { stampKey: 1 });
  assert.ok(ix, "stampKey index exists");
  assert.equal(ix.unique, true);
  assert.deepEqual(ix.partialFilterExpression, {
    stampKey: { $type: "string", $gt: "" },
  });
});
