// Code shop activity log and alert stamps (utils/codeShop/events.js,
// docs/code-shop/01-DATA.md).
//
// - log() is called from inside sale, expiry and publish paths: a failed write
//   must never turn into a failed step, so it never throws or rejects.
// - stamp() is the "already told the owner" guard for Telegram alerts: of any
//   number of concurrent calls with one key exactly one may win, and a database
//   error is not allowed to pass for either answer.
//
// Real Mongo via mongodb-memory-server (the unique partial index IS the stamp).
// The model is a local copy of the contract's shape under its own name, so this
// file never loads (or races) models/CodeShopEvent.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { createEvents } = require("../utils/codeShop/events");

const schema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
    level: { type: String, enum: ["info", "warn", "error"], default: "info" },
    kind: { type: String, default: "" },
    product: { type: mongoose.Schema.Types.ObjectId, default: null },
    msg: { type: String, default: "", maxlength: 500 },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    stampKey: { type: String },
  },
  { collection: "test_codeshopevents" },
);
schema.index({ stampKey: 1 }, { unique: true, partialFilterExpression: { stampKey: { $type: "string", $gt: "" } } });
const TestEvent = mongoose.models.TestCodeShopEvent || mongoose.model("TestCodeShopEvent", schema);

let mem;
let clock = Date.parse("2026-10-15T00:00:00Z");
const now = () => clock;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopevents"));
  await TestEvent.init(); // the stamp test needs the unique index built
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await TestEvent.deleteMany({});
});

const fresh = () => createEvents({ model: TestEvent, now });

// --- log -----------------------------------------------------------------------

test("log() writes one row with the contract's fields", async (t) => {
  t.mock.method(console, "log", () => {});
  const events = fresh();
  const product = new mongoose.Types.ObjectId();
  const saved = await events.log({ level: "warn", kind: "fill", product, msg: "3 new codes in stock", data: { added: 3 } });
  assert.equal(saved, true);

  const rows = await TestEvent.find().lean();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.at.getTime(), clock);
  assert.equal(r.level, "warn");
  assert.equal(r.kind, "fill");
  assert.equal(String(r.product), String(product));
  assert.equal(r.msg, "3 new codes in stock");
  assert.deepEqual(r.data, { added: 3 });
  assert.equal(r.stampKey, undefined);
});

test("log() defaults: info, no product, no data; long text cut to 500; unknown level is info", async () => {
  const events = fresh();
  await events.log({ kind: "x", msg: "a".repeat(800) });
  await events.log({ level: "loud", kind: "y", msg: "hello" });
  const rows = await TestEvent.find().sort({ kind: 1 }).lean();
  assert.equal(rows[0].level, "info");
  assert.equal(rows[0].product, null);
  assert.equal(rows[0].data, null);
  assert.equal(rows[0].msg.length, 500);
  assert.equal(rows[1].level, "info");
});

test("log() echoes warn and error to the console, not info", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  const events = fresh();
  await events.log({ kind: "a", msg: "quiet" });
  await events.log({ level: "warn", kind: "b", msg: "watch this" });
  await events.log({ level: "error", kind: "c", msg: "broke" });
  assert.deepEqual(lines, ["[code-shop] watch this", "[code-shop] broke"]);
});

test("log() never throws: a write error goes to console.error", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});

  const syncThrow = createEvents({ model: { create() { throw new Error("db down"); } }, now });
  assert.equal(await syncThrow.log({ level: "error", kind: "k", msg: "m" }), false);

  const rejects = createEvents({ model: { create: () => Promise.reject(new Error("db down")) }, now });
  assert.equal(await rejects.log({ kind: "k", msg: "m" }), false);

  // A value the model refuses (not an ObjectId) is the same: logged, not thrown.
  assert.equal(await fresh().log({ kind: "k", product: "not-an-id", msg: "m" }), false);

  // Called with nothing at all.
  assert.equal(await syncThrow.log(), false);
  assert.equal(await fresh().log(), true);

  assert.equal(errors.mock.callCount(), 4);
  assert.match(errors.mock.calls[0].arguments[0], /^\[code-shop\] event not saved \(k\): db down/);
});

// --- recent --------------------------------------------------------------------

async function seed(events) {
  const p1 = new mongoose.Types.ObjectId();
  const p2 = new mongoose.Types.ObjectId();
  const rows = [
    { kind: "fill", product: p1, msg: "one" },
    { kind: "publish", product: p2, msg: "two", level: "warn" },
    { kind: "fill", product: p2, msg: "three" },
    { kind: "expiry", msg: "four", level: "error" },
  ];
  for (const r of rows) {
    clock += 1000;
    await events.log(r);
  }
  return { p1, p2 };
}

test("recent() is newest first and lean", async (t) => {
  t.mock.method(console, "log", () => {});
  const events = fresh();
  await seed(events);
  const rows = await events.recent();
  assert.deepEqual(rows.map((r) => r.msg), ["four", "three", "two", "one"]);
  assert.ok(!(rows[0] instanceof mongoose.Document));
  assert.equal(typeof rows[0].save, "undefined");
});

test("recent() filters by kind, product and level, and honours limit", async (t) => {
  t.mock.method(console, "log", () => {});
  const events = fresh();
  const { p1, p2 } = await seed(events);

  assert.deepEqual((await events.recent({ kind: "fill" })).map((r) => r.msg), ["three", "one"]);
  assert.deepEqual((await events.recent({ kind: ["fill", "expiry"] })).map((r) => r.msg), ["four", "three", "one"]);
  assert.deepEqual((await events.recent({ product: p2 })).map((r) => r.msg), ["three", "two"]);
  assert.deepEqual((await events.recent({ product: String(p1) })).map((r) => r.msg), ["one"]);
  assert.deepEqual((await events.recent({ level: "warn" })).map((r) => r.msg), ["two"]);
  assert.deepEqual((await events.recent({ kind: "fill", product: p2 })).map((r) => r.msg), ["three"]);
  assert.deepEqual((await events.recent({ limit: 2 })).map((r) => r.msg), ["four", "three"]);
  assert.equal((await events.recent({ limit: "abc" })).length, 4, "a bad limit falls back to 100");
  assert.equal((await events.recent({ limit: -5 })).length, 1, "limit is at least 1");

  // Query-string shapes: an id that cannot match, and an operator object.
  assert.deepEqual(await events.recent({ product: "nope" }), []);
  assert.deepEqual(await events.recent({ product: { $ne: null } }), []);
  assert.deepEqual(await events.recent({ kind: { $ne: "x" } }), []);
});

// --- stamp / has ---------------------------------------------------------------

test("stamp() is true the first time and false after; has() follows", async () => {
  const events = fresh();
  assert.equal(await events.has("claim-due:login-1|key-1"), false);
  assert.equal(await events.stamp("claim-due:login-1|key-1"), true);
  assert.equal(await events.has("claim-due:login-1|key-1"), true);
  assert.equal(await events.stamp("claim-due:login-1|key-1"), false);
  assert.equal(await events.stamp("claim-due:login-1|key-1", { kind: "other", msg: "again" }), false);

  assert.equal(await events.stamp("claim-due:login-1|key-2", { kind: "claim-due", msg: "told" }), true);
  const row = await TestEvent.findOne({ stampKey: "claim-due:login-1|key-2" }).lean();
  assert.equal(row.kind, "claim-due");
  assert.equal(row.msg, "told");
  assert.equal(row.level, "info");
  assert.equal(row.at.getTime(), clock);

  const first = await TestEvent.findOne({ stampKey: "claim-due:login-1|key-1" }).lean();
  assert.equal(first.kind, "stamp");
  assert.equal(await TestEvent.countDocuments({ stampKey: "claim-due:login-1|key-1" }), 1);
});

test("stamp(): of many concurrent calls with one key exactly one wins", async () => {
  const events = fresh();
  const other = fresh();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? events : other).stamp("draft:abc")),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await TestEvent.countDocuments({ stampKey: "draft:abc" }), 1);
});

test("stamp(): a bad key throws; a database error other than a duplicate is thrown", async () => {
  const events = fresh();
  await assert.rejects(events.stamp(""), TypeError);
  await assert.rejects(events.stamp(null), TypeError);
  await assert.rejects(events.stamp({ $gt: "" }), TypeError);
  assert.equal(await events.stamp(42), true);
  assert.equal(await events.has(42), true);

  const down = createEvents({ model: { create: () => Promise.reject(Object.assign(new Error("db down"), { code: 6 })) }, now });
  await assert.rejects(down.stamp("vault-expiry:u1"), /db down/);

  const dup = createEvents({ model: { create: () => Promise.reject(Object.assign(new Error("E11000"), { code: 11000 })) }, now });
  assert.equal(await dup.stamp("vault-expiry:u1"), false);
});

test("has(): log rows and empty keys are never stamps", async () => {
  const events = fresh();
  await events.log({ kind: "stamp", msg: "not a stamp" });
  assert.equal(await events.has(""), false);
  assert.equal(await events.has(null), false);
  assert.equal(await events.has(undefined), false);
  assert.equal(await events.has({ $exists: true }), false);
  assert.equal(await events.has("x"), false);
});

test("log rows (no stampKey) never collide with each other on the stamp index", async () => {
  const events = fresh();
  for (let i = 0; i < 3; i += 1) assert.equal(await events.log({ kind: "k", msg: "m" + i }), true);
  assert.equal(await TestEvent.countDocuments(), 3);
});

test("createEvents() without a model loads nothing until first use", () => {
  assert.doesNotThrow(() => createEvents());
});
