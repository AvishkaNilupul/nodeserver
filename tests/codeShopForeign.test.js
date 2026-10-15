// Code shop foreign-stock guard (utils/codeShop/foreign.js): a code the ledger
// holds as free stock may already be on sale in a stock row the shop does not
// own (a hand-made listing that was never adopted). Left alone, fill could
// bundle it again and it would sell twice.
//
// What must hold:
// - every stock row on sale / in a vault / sold that is not one of our units
//   is read, whatever its format (a bare code, "N) Label = CODE" lines, a code
//   in `extra`), and a free ledger row whose code is in it is held, naming
//   that stock row;
// - our own units and removed rows are never read as foreign;
// - a code that is in one of OUR units and also in a foreign row is a
//   conflict: one error event and one Telegram line per pair, once, and
//   nothing changes;
// - an unchanged row is decrypted once per process; a changed one again;
// - the guard never writes a SuppliedAccount, and never outputs a code.
//
// Real Mongo via mongodb-memory-server. Codes, logins and offers are made up.
process.env.CRED_SECRET ||= "codeshop-foreign-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { createForeignGuard, foreignProblem } = require("../utils/codeShop/foreign");

const BSON = mongoose.mongo.BSON;
const NOW = Date.parse("2026-10-15T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ALL = [CodeStock, CodeProduct, AccountOffer, SuppliedAccount];

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopforeign"));
  await Promise.all(ALL.map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
});

// ── fixtures ────────────────────────────────────────────────────────────────

const ALL_CODES = new Set();
let codeSeq = 0;
function newCode() {
  codeSeq += 1;
  const code = `FG${String(codeSeq).padStart(2, "0")}-ZXCV-BNMLK-JHGF-DSAQ`;
  ALL_CODES.add(code);
  return code;
}

function fakeEvents() {
  const logs = [];
  const stamps = new Set();
  return {
    logs,
    stamps,
    async log(e) {
      logs.push(e);
      return true;
    },
    async stamp(key) {
      if (stamps.has(key)) return false;
      stamps.add(key);
      return true;
    },
    async has(key) {
      return stamps.has(key);
    },
  };
}

function fakeTelegram({ fail = 0 } = {}) {
  const sent = [];
  let failures = fail;
  return {
    sent,
    async send(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("telegram is down");
      }
      sent.push(message);
    },
  };
}

// secretBox, counting decrypt calls.
function countingSecret() {
  const s = {
    calls: 0,
    encrypt: secretBox.encrypt,
    decrypt(v) {
      s.calls += 1;
      return secretBox.decrypt(v);
    },
  };
  return s;
}

function makeGuard(extra = {}) {
  const events = fakeEvents();
  const telegram = fakeTelegram();
  const secret = countingSecret();
  const guard = createForeignGuard({ secret, now: () => NOW, events, telegram, ...extra });
  return { guard, events, telegram: extra.telegram || telegram, secret };
}

let rowSeq = 0;
async function ledgerRow(code, fields = {}) {
  rowSeq += 1;
  return CodeStock.create({
    loginId: "farm-" + rowSeq,
    itemKey: "item-" + rowSeq,
    gameNo: "12",
    slotKey: "12:1001:abc:1",
    codeHash: slots.hashCode(code),
    codeShape: slots.codeShape(code),
    state: "in_stock",
    useBy: new Date(NOW + 30 * DAY),
    ...fields,
  });
}

async function offerOf(title = "Hand-made code listing") {
  return AccountOffer.create({ title, game: "Overwatch", status: "active", priceUsd: 3 });
}

let unitSeq = 0;
async function stockRow(offer, password, fields = {}) {
  unitSeq += 1;
  return SuppliedAccount.create({
    offer: offer._id,
    login: "owkey-" + unitSeq,
    password: password === "" ? "" : secretBox.encrypt(password),
    status: "available",
    ...fields,
  });
}

const rowOf = (code) => CodeStock.findOne({ codeHash: slots.hashCode(code) }).lean();

async function unitBytes() {
  const docs = await mongoose.connection.db.collection("suppliedaccounts").find({}).sort({ _id: 1 }).toArray();
  return docs.map((d) => BSON.serialize(d).toString("base64"));
}

function assertNoCode(...values) {
  for (const v of values) {
    const json = JSON.stringify(v);
    for (const code of ALL_CODES) {
      assert.ok(!json.includes(code), "a plaintext code leaked");
      assert.ok(!json.includes(code.replace(/-/g, "")), "a plaintext code leaked (no dashes)");
    }
    assert.ok(!json.includes("BNMLK"), "part of a plaintext code leaked");
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

test("both formats: a bare code, code lines, and codes in `extra` are held, naming their stock row", async () => {
  const bare = newCode();
  const line1 = newCode();
  const line2 = newCode();
  const inExtra = newCode();
  const plainExtra = newCode();
  const listed1 = newCode();
  const listed2 = newCode();
  const free = newCode();
  for (const c of [bare, line1, line2, inExtra, plainExtra, listed1, listed2, free]) await ledgerRow(c);

  const first = await offerOf("First listing");
  const s1 = await stockRow(first, `  ${bare}  `);
  const later = await offerOf("Later listing");
  const s2 = await stockRow(later, `1) Sun Tea Player Icon = ${line1}\n2) Refreshing Spray = ${line2}`, { status: "sold", deliveredAt: new Date(NOW - DAY) });
  const s3 = await stockRow(later, "", { extra: secretBox.encrypt(`Code: ${inExtra}`), status: "fed" });
  const s4 = await stockRow(later, "not a code", { extra: `recovery|${plainExtra}` });
  const s5 = await stockRow(later, `Keys: ${listed1}, ${listed2} ;`);
  const before = await unitBytes();

  const { guard, events, telegram } = makeGuard();
  const res = await guard.run();

  assert.deepEqual(res, { scanned: 5, decrypted: 5, held: 7, conflicts: 0 });
  const want = [
    [bare, s1],
    [line1, s2],
    [line2, s2],
    [inExtra, s3],
    [plainExtra, s4],
    [listed1, s5],
    [listed2, s5],
  ];
  for (const [code, s] of want) {
    const row = await rowOf(code);
    assert.equal(row.state, "held");
    assert.equal(row.problem, `in a stock row of another listing (${String(s._id)})`);
    assert.equal(row.problem, foreignProblem(s._id));
    const h = row.history.at(-1);
    assert.deepEqual({ from: h.from, to: h.to, why: h.why }, { from: "in_stock", to: "held", why: row.problem });
  }
  assert.equal((await rowOf(free)).state, "in_stock", "a code in no stock row stays free");
  assert.deepEqual(await unitBytes(), before, "the guard never writes a stock row");
  assert.equal(telegram.sent.length, 0);
  assert.equal(events.logs.filter((e) => e.kind === "foreign-stock").length, 1);
  assertNoCode(res, events.logs);
});

test("our units and removed rows are not foreign; in_stock and expiring rows are held, other states left alone", async () => {
  const offer = await offerOf();
  // One of our units: its ledger rows point at it.
  const ourCode = newCode();
  const strayInOurs = newCode();
  const ours = await stockRow(offer, `1) Reward = ${ourCode}\n2) Reward = ${strayInOurs}`);
  await ledgerRow(ourCode, { state: "in_unit", unit: ours._id, unitStatus: "available" });
  await ledgerRow(strayInOurs);
  // A removed hand-made row.
  const removedCode = newCode();
  await ledgerRow(removedCode);
  await stockRow(offer, removedCode, { status: "removed" });
  // A foreign row with codes in every ledger state.
  const codes = { in_stock: newCode(), expiring: newCode(), expired: newCode(), held: newCode(), dead: newCode() };
  for (const [state, code] of Object.entries(codes)) {
    await ledgerRow(code, { state, problem: state === "held" ? "same code as another stored code" : "" });
  }
  const foreign = await stockRow(offer, Object.values(codes).join("\n"));

  const { guard, events } = makeGuard();
  const res = await guard.run();
  assert.deepEqual(res, { scanned: 1, decrypted: 1, held: 2, conflicts: 0 });

  assert.equal((await rowOf(ourCode)).state, "in_unit");
  assert.equal((await rowOf(strayInOurs)).state, "in_stock", "our own unit is never read as foreign");
  assert.equal((await rowOf(removedCode)).state, "in_stock", "a removed row is not on sale");
  for (const state of ["in_stock", "expiring"]) {
    const row = await rowOf(codes[state]);
    assert.equal(row.state, "held", state);
    assert.equal(row.problem, foreignProblem(foreign._id));
    assert.equal(row.history.at(-1).from, state);
  }
  assert.equal((await rowOf(codes.expired)).state, "expired");
  const held = await rowOf(codes.held);
  assert.equal(held.problem, "same code as another stored code", "an already-held row keeps its reason");
  assert.equal((await rowOf(codes.dead)).state, "dead");
  assertNoCode(res, events.logs);
});

test("a code in two foreign rows is held for the older row", async () => {
  const code = newCode();
  await ledgerRow(code);
  const offer = await offerOf();
  const older = await stockRow(offer, code);
  await stockRow(offer, `1) Reward = ${code}`);
  const { guard } = makeGuard();
  const res = await guard.run();
  assert.equal(res.held, 1);
  assert.equal((await rowOf(code)).problem, foreignProblem(older._id));
});

test("conflict: a code in one of our units AND in a foreign row is reported once per pair, nothing changes", async () => {
  const offer = await offerOf("Shop offer");
  const product = await CodeProduct.create({ name: "Overwatch Sun Tea bundle", status: "active", offer: offer._id });
  const ourUnit = await stockRow(offer, "ours");
  const soldUnit = await stockRow(offer, "ours, sold", { status: "sold" });
  const onSale = newCode();
  const sold = newCode();
  const r1 = await ledgerRow(onSale, { state: "in_unit", unit: ourUnit._id, product: product._id, unitStatus: "available" });
  const r2 = await ledgerRow(sold, { state: "sold", unit: soldUnit._id, product: product._id, unitStatus: "sold" });
  const handMade = await offerOf("Hand-made listing");
  const foreign = await stockRow(handMade, `1) Sun Tea = ${onSale}\n2) Spray = ${sold}`);
  const before = await CodeStock.find({}).sort({ _id: 1 }).lean();
  const unitsBefore = await unitBytes();

  const telegram = fakeTelegram({ fail: 1 });
  const { guard, events } = makeGuard({ telegram });

  // Telegram down: nothing is stamped, so the next run tells again.
  const down = await guard.run();
  assert.equal(down.conflicts, 2);
  assert.equal(telegram.sent.length, 0);
  assert.equal(events.stamps.size, 0);
  assert.equal(events.logs.filter((e) => e.kind === "foreign-conflict").length, 1, "one 'alert failed' error");

  const res = await guard.run();
  assert.deepEqual(res, { scanned: 1, decrypted: 0, held: 0, conflicts: 2 });
  assert.equal(telegram.sent.length, 1, "one Telegram message");
  const lines = telegram.sent[0].split("\n");
  assert.equal(lines.length, 2, "one line per pair");
  assert.ok(lines.every((l) => l.includes(String(foreign._id)) && l.includes("Overwatch Sun Tea bundle") && l.includes("Hand-made listing")));
  assert.deepEqual([...events.stamps].sort(), [`foreign-conflict:${foreign._id}:${r1._id}`, `foreign-conflict:${foreign._id}:${r2._id}`].sort());
  const errors = events.logs.filter((e) => e.kind === "foreign-conflict" && e.level === "error" && e.data && e.data.ledger);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => String(e.product) === String(product._id)));

  const again = await guard.run();
  assert.equal(again.conflicts, 2);
  assert.equal(telegram.sent.length, 1, "deduped: no second message");
  assert.equal(events.logs.filter((e) => e.kind === "foreign-conflict" && e.data && e.data.ledger).length, 2);

  assert.deepEqual(await CodeStock.find({}).sort({ _id: 1 }).lean(), before, "a conflict changes no ledger row");
  assert.deepEqual(await unitBytes(), unitsBefore, "and no stock row");
  assertNoCode(down, res, again, events.logs, telegram.sent);
});

test("cache: an unchanged row is decrypted once; a changed row is read again", async () => {
  const a = newCode();
  const b = newCode();
  const later = newCode();
  for (const c of [a, b, later]) await ledgerRow(c);
  const offer = await offerOf();
  const s1 = await stockRow(offer, a);
  const s2 = await stockRow(offer, `1) Reward = ${b}`);
  const { guard, secret } = makeGuard();

  const first = await guard.run();
  assert.equal(first.decrypted, 2);
  assert.equal(first.held, 2);
  const calls = secret.calls;
  assert.ok(calls > 0);

  const second = await guard.run();
  assert.deepEqual(second, { scanned: 2, decrypted: 0, held: 0, conflicts: 0 });
  assert.equal(secret.calls, calls, "no decrypt for an unchanged row");

  // The owner edits one row: a new code goes in.
  await SuppliedAccount.collection.updateOne(
    { _id: s2._id },
    { $set: { password: secretBox.encrypt(`1) Reward = ${b}\n2) Reward = ${later}`), updatedAt: new Date(Date.now() + 60000) } },
  );
  const third = await guard.run();
  assert.equal(third.decrypted, 1, "only the changed row");
  assert.equal(third.held, 1);
  assert.equal((await rowOf(later)).problem, foreignProblem(s2._id));
  assert.equal((await rowOf(a)).problem, foreignProblem(s1._id));
  assertNoCode(first, second, third);
});

test("a row that becomes one of our units, or leaves sale, drops out of the scan", async () => {
  const code = newCode();
  await ledgerRow(code);
  const offer = await offerOf();
  const s = await stockRow(offer, "nothing here");
  const { guard } = makeGuard();
  assert.equal((await guard.run()).scanned, 1);
  await SuppliedAccount.updateOne({ _id: s._id }, { $set: { status: "removed" } });
  assert.equal((await guard.run()).scanned, 0);
  await SuppliedAccount.updateOne({ _id: s._id }, { $set: { status: "available" } });
  await ledgerRow(newCode(), { state: "in_unit", unit: s._id });
  assert.equal((await guard.run()).scanned, 0);
});
