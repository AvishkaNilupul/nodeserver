// Code shop after-sale (utils/codeShop/afterSale.js, docs/code-shop/04-OPS.md).
//
// replace() is the only call that hands a plaintext code out of the server, so
// most of this file is about the ways it could cost real money:
//
// - ONE CODE, TWO BUYERS. A replacement must come from a row the call itself
//   moved in_stock -> sold; two calls at once (for different codes, or for the
//   same one) must never hand out the same code, or two codes for one.
// - A WRONG CODE. The code is checked against the ledger hash; a mismatch puts
//   the candidate back in stock and returns nothing.
// - A CODE ABOUT TO DIE. Candidates inside the expiry lead are never used.
// - A CODE IN A LOG. Events carry labels and shapes only.
//
// Real Mongo via mongodb-memory-server: the guarded updates are the thing under
// test. All codes are made up.
process.env.CRED_SECRET ||= "code-shop-after-sale-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const { encrypt } = require("../utils/secretBox");
const { hashCode, codeShape } = require("../utils/codeShop/slots");
const { createAfterSale, slotIndexes } = require("../utils/codeShop/afterSale");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopaftersale"));
  await Promise.all([CodeStock, CodeProduct, SoopInventoryItem].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([CodeStock, CodeProduct, SoopInventoryItem].map((m) => m.deleteMany({})));
});

// Every code this file makes, so any output can be checked for a leak.
const ALL_CODES = [];

function fakeEvents() {
  const logs = [];
  return { logs, log: async (e) => (logs.push(e), true) };
}

function fakeConfig(value = { expiryLeadHours: 36 }) {
  return { get: async () => value };
}

function afterSaleWith(opts = {}) {
  const events = opts.events || fakeEvents();
  const svc = createAfterSale({ events, config: opts.config || fakeConfig(), now: () => opts.now || NOW });
  return { events, svc };
}

function assertNoCode(value) {
  const s = JSON.stringify(value);
  for (const c of ALL_CODES) assert.ok(!s.includes(c), "a code leaked into an event or a view");
}

let seq = 0;

async function product(slotKeys, opts = {}) {
  return CodeProduct.create({
    name: opts.name || "Test bundle",
    status: "active",
    gameNo: "12",
    offer: new ObjectId(),
    slots: slotKeys.map((k, i) => ({ slotKey: k, label: "Reward " + String.fromCharCode(65 + i) })),
  });
}

// One ledger row with its inventory row (holding the code encrypted).
async function seedRow(slotKey, opts = {}) {
  seq += 1;
  const code = opts.code || `FAKE-${String(seq).padStart(4, "0")}-AFTR-SALE`;
  ALL_CODES.push(code);
  const loginId = opts.loginId || "login-" + (seq % 4);
  const itemKey = "item-" + seq;
  await SoopInventoryItem.create({
    loginId,
    key: itemKey,
    kind: "code",
    hasCode: true,
    codeEnc: encrypt(opts.storedCode || code),
  });
  const row = await CodeStock.create({
    loginId,
    itemKey,
    gameNo: opts.gameNo || "12",
    slotKey,
    nameRaw: opts.nameRaw || "name-of-" + slotKey,
    name: opts.name || "Name of " + slotKey,
    codeHash: opts.codeHash === undefined ? hashCode(code) : opts.codeHash,
    codeShape: codeShape(code),
    state: opts.state || "in_stock",
    unit: opts.unit || null,
    product: opts.product || null,
    unitStatus: opts.unit ? opts.unitStatus || "sold" : "",
    soldAt: opts.soldAt || null,
    market: opts.market || "",
    orderId: opts.orderId || "",
    saleUsd: opts.saleUsd || 0,
    useBy: opts.useBy === undefined ? new Date(NOW + 10 * DAY) : opts.useBy,
    earnedAt: opts.earnedAt || new Date(NOW - DAY),
    history: opts.unit ? [{ at: opts.inUnitAt || new Date(NOW - 2 * DAY), from: "in_stock", to: "in_unit", why: "claimed" }] : [],
  });
  return { id: row._id, code, slotKey };
}

// A sold unit of `prod`: one row per slot. `order` lets a test insert the rows
// out of slot order (the slot must come from the product, not insertion).
async function soldUnit(prod, opts = {}) {
  const unit = new ObjectId();
  const keys = prod.slots.map((s) => s.slotKey);
  const order = opts.order || keys.map((_, i) => i);
  const rows = [];
  for (const i of order) {
    rows[i] = await seedRow(keys[i], {
      unit,
      product: prod._id,
      state: opts.state || "sold",
      unitStatus: opts.unitStatus,
      soldAt: opts.soldAt || new Date(NOW - HOUR),
      market: opts.market === undefined ? "eldorado" : opts.market,
      orderId: opts.orderId || "order-" + seq,
      saleUsd: opts.saleUsd === undefined ? 0.5 : opts.saleUsd,
    });
  }
  return { unit, rows };
}

const lean = (id) => CodeStock.findById(id).lean();

async function rejects(promise, status, re) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, "status of: " + err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

// ------------------------------------------------------------------- sold()

test("sold: one entry per sold unit, newest first, codes in the product's slot order", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["g:A", "g:B"], { name: "Pair" });
  const older = await soldUnit(p, { soldAt: new Date(NOW - 3 * HOUR), orderId: "order-old", saleUsd: 0.75 });
  // Rows inserted B then A: the slot must still follow the product.
  const newer = await soldUnit(p, { soldAt: new Date(NOW - HOUR), orderId: "order-new", order: [1, 0], market: "ggsel" });
  // An unsold unit (still on sale) is not listed.
  await soldUnit(p, { state: "in_unit", unitStatus: "available", market: "", orderId: "x", saleUsd: 0 });

  const list = await svc.sold();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.unitId), [String(newer.unit), String(older.unit)]);

  const e = list[0];
  assert.equal(e.product, String(p._id));
  assert.equal(e.productName, "Pair");
  assert.equal(e.market, "ggsel");
  assert.equal(e.orderId, "order-new");
  assert.equal(e.usd, 1);
  assert.equal(new Date(e.soldAt).getTime(), NOW - HOUR);
  assert.deepEqual(
    e.codes.map((c) => [c.slot, c.label, c.state]),
    [
      [0, "Reward A", "sold"],
      [1, "Reward B", "sold"],
    ],
  );
  assert.equal(e.codes[0].codeShape, codeShape(newer.rows[0].code));
  assert.equal(e.codes[0].after.status, "");
  assert.equal(list[1].usd, 1.5);
  assertNoCode(list);
});

test("sold: limit and product filter; a dead code is still listed", async () => {
  const { svc } = afterSaleWith();
  const p1 = await product(["a:1"], { name: "One" });
  const p2 = await product(["b:1"], { name: "Two" });
  const u1 = await soldUnit(p1, { soldAt: new Date(NOW - 5 * HOUR) });
  const u2 = await soldUnit(p2, { soldAt: new Date(NOW - 2 * HOUR), state: "dead" });

  const newest = await svc.sold({ limit: 1 });
  assert.deepEqual(newest.map((e) => e.unitId), [String(u2.unit)]);
  assert.equal(newest[0].codes[0].state, "dead");

  const one = await svc.sold({ productId: String(p1._id) });
  assert.deepEqual(one.map((e) => e.unitId), [String(u1.unit)]);
  assert.deepEqual(await svc.sold({ productId: "not-an-id" }), []);
});

test("sold: a product that is gone falls back to the order the codes went into the unit", async () => {
  const { svc } = afterSaleWith();
  const unit = new ObjectId();
  const gone = new ObjectId();
  // Inserted second-first; the stored history says which went in first.
  await seedRow("x:2", { unit, product: gone, state: "sold", soldAt: new Date(NOW), inUnitAt: new Date(NOW - 2 * HOUR), name: "Second" });
  await seedRow("x:1", { unit, product: gone, state: "sold", soldAt: new Date(NOW), inUnitAt: new Date(NOW - 3 * HOUR), name: "First" });

  const [e] = await svc.sold();
  assert.equal(e.productName, "");
  assert.deepEqual(e.codes.map((c) => [c.slot, c.label]), [
    [0, "First"],
    [1, "Second"],
  ]);
  // report/replace address the same slots.
  const r = await svc.report(String(unit), { slot: 1, status: "dead" });
  assert.equal(r.label, "Second");
});

test("slotIndexes: product order first, unknown rows after it in stored order", () => {
  const a = { _id: "a1", slotKey: "k:2", history: [{ to: "in_unit", at: new Date(5) }] };
  const b = { _id: "b1", slotKey: "k:9", history: [{ to: "in_unit", at: new Date(3) }] };
  const c = { _id: "c1", slotKey: "k:1", history: [] };
  const d = { _id: "d1", slotKey: "", history: [{ to: "in_unit", at: new Date(1) }] };
  const idx = slotIndexes({ slots: [{ slotKey: "k:1" }, { slotKey: "k:2" }] }, [a, b, c, d]);
  assert.equal(idx.get("c1"), 0);
  assert.equal(idx.get("a1"), 1);
  assert.equal(idx.get("d1"), 2);
  assert.equal(idx.get("b1"), 3);
});

// ------------------------------------------------------------------- report()

test("report: dead and back to ok, with note, actor and history", async () => {
  const { svc, events } = afterSaleWith();
  const p = await product(["r:A", "r:B"]);
  const u = await soldUnit(p);

  const dead = await svc.report(String(u.unit), { slot: 1, status: "dead", note: "buyer says already used", actor: "owner" });
  assert.equal(dead.slot, 1);
  assert.equal(dead.label, "Reward B");
  assert.equal(dead.state, "dead");
  assert.equal(dead.after.status, "dead");
  assert.equal(dead.after.note, "buyer says already used");
  assert.equal(dead.after.by, "owner");
  assert.equal(new Date(dead.after.at).getTime(), NOW);

  let row = await lean(u.rows[1].id);
  assert.equal(row.state, "dead");
  assert.equal(row.after.status, "dead");
  assert.deepEqual(row.history.slice(-1).map((h) => [h.from, h.to]), [["sold", "dead"]]);
  assert.equal((await lean(u.rows[0].id)).state, "sold", "the other code of the bundle is untouched");

  const ok = await svc.report(String(u.unit), { slot: "1", status: "ok", actor: "owner" });
  assert.equal(ok.state, "sold");
  assert.equal(ok.after.status, "ok");
  row = await lean(u.rows[1].id);
  assert.equal(row.state, "sold");
  assert.equal(row.after.status, "ok");
  assert.deepEqual(row.history.slice(-1).map((h) => [h.from, h.to]), [["dead", "sold"]]);
  assert.equal(events.logs.filter((e) => e.kind === "after-report").length, 2);
  assertNoCode(events.logs);
});

test("report: refuses a code that is not sold, a bad status, a bad slot and a bad id", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["n:A"]);
  const onSale = await soldUnit(p, { state: "in_unit", unitStatus: "available" });
  await rejects(svc.report(String(onSale.unit), { slot: 0, status: "dead" }), 409, /sold/);
  assert.equal((await lean(onSale.rows[0].id)).state, "in_unit");

  const u = await soldUnit(p);
  await rejects(svc.report(String(u.unit), { slot: 0, status: "broken" }), 400);
  await rejects(svc.report(String(u.unit), { slot: 3, status: "dead" }), 404);
  await rejects(svc.report(String(u.unit), { slot: -1, status: "dead" }), 400);
  await rejects(svc.report(String(u.unit), { status: "dead" }), 400);
  await rejects(svc.report("nope", { slot: 0, status: "dead" }), 400);
  await rejects(svc.report(String(new ObjectId()), { slot: 0, status: "dead" }), 404);
});

// ------------------------------------------------------------------- replace()

test("replace: hands out a checked code from stock, marks both rows, logs no code", async () => {
  const { svc, events } = afterSaleWith();
  const p = await product(["h:A", "h:B"]);
  const u = await soldUnit(p, { orderId: "order-77" });
  await svc.report(String(u.unit), { slot: 0, status: "dead", note: "used", actor: "owner" });
  const cand = await seedRow("h:A");

  const res = await svc.replace(String(u.unit), { slot: 0, actor: "owner" });
  assert.deepEqual(Object.keys(res).sort(), ["code", "codeShape", "label"]);
  assert.equal(res.label, "Reward A");
  assert.equal(res.codeShape, codeShape(cand.code));
  // The code is exactly what the candidate's inventory row holds.
  assert.equal(res.code, cand.code);
  assert.equal(hashCode(res.code), (await lean(cand.id)).codeHash);

  const c = await lean(cand.id);
  assert.equal(c.state, "sold");
  assert.equal(c.market, "replacement");
  assert.equal(new Date(c.soldAt).getTime(), NOW);
  assert.equal(c.after.status, "replacement");
  assert.equal(String(c.after.ref), String(u.rows[0].id));
  assert.equal(c.after.by, "owner");
  assert.equal(c.unit, null, "a replacement is never part of a unit");

  const o = await lean(u.rows[0].id);
  assert.equal(o.state, "dead", "the original keeps its state");
  assert.equal(o.after.status, "replaced");
  assert.equal(String(o.after.ref), String(cand.id));
  assert.equal(o.after.note, "used", "the report's note is kept");

  const ev = events.logs.find((e) => e.kind === "after-replace");
  assert.ok(ev, "the replacement is logged");
  assert.match(ev.msg, /Reward A/);
  assert.ok(ev.msg.includes(codeShape(cand.code)));
  assertNoCode(events.logs);

  // Listed once more: as a replacement answering for the original's order.
  const list = await svc.sold();
  const repl = list.find((e) => e.market === "replacement");
  assert.ok(repl);
  assert.equal(repl.unitId, null);
  assert.equal(repl.orderId, "order-77");
  assert.equal(repl.product, String(p._id));
  assert.equal(repl.codes[0].label, "Reward A");
  assert.equal(repl.codes[0].after.status, "replacement");
  const orig = list.find((e) => e.unitId === String(u.unit));
  assert.equal(orig.codes[0].after.status, "replaced");
  assertNoCode(list);
  const filtered = await svc.sold({ productId: String(p._id) });
  assert.equal(filtered.length, 2, "the product filter keeps the replacement of its code");
});

test("replace: a code already replaced is refused, and cannot be re-reported", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["d:A"]);
  const u = await soldUnit(p);
  await seedRow("d:A");
  const spare = await seedRow("d:A");
  await svc.replace(String(u.unit), { slot: 0 });

  await rejects(svc.replace(String(u.unit), { slot: 0 }), 409, /already/);
  await rejects(svc.report(String(u.unit), { slot: 0, status: "ok" }), 409, /already/);
  await rejects(svc.report(String(u.unit), { slot: 0, status: "dead" }), 409, /already/);
  assert.equal((await lean(spare.id)).state, "in_stock", "no second code left stock");
});

test("replace: refuses a code that is not sold", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["q:A"]);
  const u = await soldUnit(p, { state: "in_unit", unitStatus: "available" });
  const cand = await seedRow("q:A");
  await rejects(svc.replace(String(u.unit), { slot: 0 }), 409);
  assert.equal((await lean(cand.id)).state, "in_stock");
});

test("replace: the same slot wins over a same-name code, and the name match is the fallback", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["s:A"]);
  const u1 = await soldUnit(p);
  const u2 = await soldUnit(p);
  // Same game and reward name, another campaign's slot, sooner use-by.
  const sameName = await seedRow("other:A", { nameRaw: "name-of-s:A", useBy: new Date(NOW + 3 * DAY) });
  const sameSlot = await seedRow("s:A", { useBy: new Date(NOW + 9 * DAY) });
  // Different game, same name: never a candidate.
  const otherGame = await seedRow("z:A", { gameNo: "200", nameRaw: "name-of-s:A", useBy: new Date(NOW + 2 * DAY) });

  assert.equal((await svc.replace(String(u1.unit), { slot: 0 })).code, sameSlot.code);
  assert.equal((await svc.replace(String(u2.unit), { slot: 0 })).code, sameName.code);
  assert.equal((await lean(otherGame.id)).state, "in_stock");
});

test("replace: oldest use-by first, undated codes last, codes inside the lead skipped", async () => {
  const { svc } = afterSaleWith({ config: fakeConfig({ expiryLeadHours: 36 }) });
  const p = await product(["o:A"]);
  const units = [];
  for (let i = 0; i < 3; i++) units.push(await soldUnit(p));
  const undated = await seedRow("o:A", { useBy: null });
  const late = await seedRow("o:A", { useBy: new Date(NOW + 20 * DAY) });
  const insideLead = await seedRow("o:A", { useBy: new Date(NOW + 30 * HOUR) });
  const early = await seedRow("o:A", { useBy: new Date(NOW + 2 * DAY) });

  const got = [];
  for (const u of units) got.push((await svc.replace(String(u.unit), { slot: 0 })).code);
  assert.deepEqual(got, [early.code, late.code, undated.code]);
  assert.equal((await lean(insideLead.id)).state, "in_stock", "a code inside the lead is never handed out");

  // Only the lead-time code is left: no replacement.
  const last = await soldUnit(p);
  await rejects(svc.replace(String(last.unit), { slot: 0 }), 409, /No usable/);
  assert.equal((await lean(insideLead.id)).state, "in_stock");
});

test("replace: no candidate in stock is an error and changes nothing", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["e:A"]);
  const u = await soldUnit(p);
  // Not in stock, so not candidates.
  await seedRow("e:A", { state: "held" });
  await seedRow("e:A", { state: "expiring" });
  // A row without a hash cannot be checked.
  await seedRow("e:A", { codeHash: "" });
  await rejects(svc.replace(String(u.unit), { slot: 0 }), 409, /No usable/);
  const o = await lean(u.rows[0].id);
  assert.equal(o.after.status, "");
  assert.equal(await CodeStock.countDocuments({ market: "replacement" }), 0);
});

test("replace: a code that fails its hash check goes back to stock and nothing is returned", async () => {
  const { svc, events } = afterSaleWith();
  const p = await product(["m:A"]);
  const u = await soldUnit(p);
  const bad = await seedRow("m:A", { storedCode: "FAKE-9999-NOT-THE-SAME" });
  ALL_CODES.push("FAKE-9999-NOT-THE-SAME");

  await rejects(svc.replace(String(u.unit), { slot: 0 }), 500);
  const b = await lean(bad.id);
  assert.equal(b.state, "in_stock");
  assert.equal(b.market, "");
  assert.equal(b.soldAt, null);
  assert.equal(b.after.status, "");
  assert.equal(b.after.ref, null);
  assert.deepEqual(b.history.slice(-2).map((h) => [h.from, h.to]), [
    ["in_stock", "sold"],
    ["sold", "in_stock"],
  ]);
  assert.equal((await lean(u.rows[0].id)).after.status, "", "the original is not marked replaced");
  assert.ok(events.logs.some((e) => e.level === "warn" && e.kind === "after-replace"));
  assertNoCode(events.logs);

  // A good code behind the bad one is handed out instead.
  const good = await seedRow("m:A", { useBy: new Date(NOW + 30 * DAY) });
  assert.equal((await svc.replace(String(u.unit), { slot: 0 })).code, good.code);
  assert.equal((await lean(bad.id)).state, "in_stock");
});

test("replace: concurrent calls for different codes never hand out the same code", async () => {
  const { svc, events } = afterSaleWith();
  const p = await product(["c:A"]);
  const units = [];
  for (let i = 0; i < 5; i++) units.push(await soldUnit(p));
  const cands = [];
  for (let i = 0; i < 3; i++) cands.push(await seedRow("c:A", { useBy: new Date(NOW + (5 + i) * DAY) }));

  const results = await Promise.allSettled(units.map((u) => svc.replace(String(u.unit), { slot: 0 })));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value.code);
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 3);
  assert.equal(failed.length, 2);
  assert.equal(new Set(ok).size, 3, "every handed-out code is different");
  assert.deepEqual([...ok].sort(), cands.map((c) => c.code).sort());
  for (const f of failed) assert.equal(f.reason.status, 409);

  // Each candidate points at exactly one original, which points back at it.
  for (const c of cands) {
    const row = await lean(c.id);
    assert.equal(row.state, "sold");
    const orig = await lean(row.after.ref);
    assert.equal(orig.after.status, "replaced");
    assert.equal(String(orig.after.ref), String(c.id));
  }
  assert.equal(await CodeStock.countDocuments({ "after.status": "replaced" }), 3);
  assertNoCode(events.logs);
});

test("replace: concurrent calls for the SAME code hand out one code; the other candidate stays in stock", async () => {
  const { svc } = afterSaleWith();
  const p = await product(["t:A"]);
  const u = await soldUnit(p);
  const a = await seedRow("t:A", { useBy: new Date(NOW + 4 * DAY) });
  const b = await seedRow("t:A", { useBy: new Date(NOW + 5 * DAY) });

  const results = await Promise.allSettled([0, 1, 2].map(() => svc.replace(String(u.unit), { slot: 0 })));
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1, "one replacement for one code");
  for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.status, 409);

  const rows = [await lean(a.id), await lean(b.id)];
  const handed = rows.filter((r) => r.state === "sold");
  assert.equal(handed.length, 1);
  assert.equal(rows.filter((r) => r.state === "in_stock").length, 1, "the loser's candidate went back");
  assert.equal(ok[0].value.code, handed[0]._id.equals(a.id) ? a.code : b.code);
  const o = await lean(u.rows[0].id);
  assert.equal(String(o.after.ref), String(handed[0]._id));
});

test("replace: two calls that both checked a code race on the original; the loser's code goes back unreturned", async () => {
  // Hold every "mark the original replaced" write until both calls reach it,
  // so both have claimed and checked a candidate before either one wins.
  let waiting = [];
  const Held = new Proxy(CodeStock, {
    get(target, prop) {
      if (prop === "updateOne") {
        return async (filter, update) => {
          if (filter && filter["after.status"] && filter["after.status"].$ne === "replaced") {
            await new Promise((resolve) => {
              waiting.push(resolve);
              if (waiting.length === 2) waiting.forEach((r) => r());
            });
          }
          return target.updateOne(filter, update);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const events = fakeEvents();
  const svc = createAfterSale({ events, config: fakeConfig(), now: () => NOW, models: { CodeStock: Held } });
  const p = await product(["w:A"]);
  const u = await soldUnit(p);
  const a = await seedRow("w:A", { useBy: new Date(NOW + 4 * DAY) });
  const b = await seedRow("w:A", { useBy: new Date(NOW + 5 * DAY) });

  const results = await Promise.allSettled([svc.replace(String(u.unit), { slot: 0 }), svc.replace(String(u.unit), { slot: 0 })]);
  assert.equal(waiting.length, 2, "both calls reached the mark with a checked code");
  const ok = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.status, 409);
  assert.ok(!("code" in lost[0].reason), "the loser returns no code");

  const rows = [await lean(a.id), await lean(b.id)];
  const handed = rows.find((r) => r.state === "sold");
  const back = rows.find((r) => r.state === "in_stock");
  assert.ok(handed && back);
  assert.equal(ok[0].value.code, handed._id.equals(a.id) ? a.code : b.code);
  assert.equal(back.after.status, "");
  assert.equal(back.market, "");
  assert.equal(String((await lean(u.rows[0].id)).after.ref), String(handed._id));
  assertNoCode(events.logs);
  assertNoCode(lost[0].reason.message);
});
