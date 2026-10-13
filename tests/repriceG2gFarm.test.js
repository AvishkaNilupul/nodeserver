// scripts/reprice-g2g-farm.js — moves the price (and tops up the stock) of the
// rent-farm offers on G2G. Which offers it may touch comes from the shared
// plan (tests/repriceEldoradoFarm.test.js); these cover what is G2G's own: the
// offer statuses, the stock top-up, and what counts as "done".
const test = require("node:test");
const assert = require("node:assert/strict");

const { toPlanOffer, planG2g, applyG2g } = require("../scripts/reprice-g2g-farm");
const { parseLadder, gameList } = require("../scripts/reprice-eldorado-farm");
const farmService = require("../utils/g2gFarmService");
const pa = require("../utils/playerauctionsFarmService");

const farm = { FARM_TITLE: farmService.FARM_TITLE, termToDays: pa.termToDays };
const T = (game, term) => game + " Twitch Drops Automatic Farming " + term;
const offer = (offerId, title, unitPrice, extra = {}) => ({ offerId, title, status: "live", currency: "USD", unitPrice, actualQty: 5, ...extra });
const NEW = parseLadder("120:3.99,180:4.99,365:8.99");
const OLD = parseLadder("120:3,180:4,365:7");
const plan = (offers, opts = {}) => planG2g(offers, { ladder: NEW, ...opts }, farm);
const brief = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.action + (r.why ? ": " + r.why : "") + (r.stockTo !== null ? " [stock " + r.stockFrom + "->" + r.stockTo + "]" : "")]));

test("a G2G offer reads as on sale, delisted, or something to leave alone", () => {
  assert.deepEqual(toPlanOffer(offer("G1", "t", 3)), { id: "G1", offerTitle: "t", offerState: "Active", pricePerUnit: { amount: 3, currency: "USD" } });
  assert.equal(toPlanOffer(offer("G1", "t", 3, { status: "delisted" })).offerState, "Paused");
  assert.equal(toPlanOffer(offer("G1", "t", 3, { status: "draft" })).offerState, "draft");
  assert.equal(toPlanOffer({}).offerState, "unknown");
});

test("each term goes to its price; a delisted offer too, so a relist brings no old price back", () => {
  const rows = plan([offer("a", T("Rust", "120 Days"), 3), offer("b", T("Rust", "1 Year"), 7, { status: "delisted" }), offer("c", "Rust Twitch Drops (3 Items)", 1)]);
  assert.deepEqual(rows.map((r) => [r.id, r.days, r.from, r.to, r.action]), [
    ["a", 120, 3, 3.99, "reprice"],
    ["b", 365, 7, 8.99, "reprice"],
  ]);
});

test("a draft, a price in another currency and a price nobody expected are left alone", () => {
  const rows = plan(
    [
      offer("a", T("Rust", "120 Days"), 3, { status: "draft" }),
      offer("b", T("Rust", "180 Days"), 400, { currency: "JPY" }),
      offer("c", T("Rust", "1 Year"), 6.5),
      offer("d", T("Rust", "120 Days"), 3),
    ],
    { expect: OLD, stock: 20 },
  );
  assert.deepEqual(brief(rows), {
    a: "skip: offer is draft",
    b: "skip: current price could not be read",
    c: "skip: unexpected price $6.50 (expected $7.00)",
    d: "reprice [stock 5->20]",
  });
});

test("the stock is topped up, never lowered, and an offer at the right price still gets it", () => {
  const rows = plan(
    [
      offer("a", T("Rust", "120 Days"), 3, { actualQty: 3 }),
      offer("b", T("Rust", "180 Days"), 4.99, { actualQty: 4 }),
      offer("c", T("Rust", "1 Year"), 8.99, { actualQty: 20 }),
      offer("d", T("Apex Legends", "1 Year"), 8.99, { actualQty: 50 }),
      offer("e", T("Apex Legends", "120 Days"), 3, { actualQty: undefined }),
    ],
    { stock: 20 },
  );
  assert.deepEqual(brief(rows), {
    d: "already",
    e: "reprice",
    a: "reprice [stock 3->20]",
    b: "stock [stock 4->20]",
    c: "already",
  });
});

test("without --stock no quantity is touched", () => {
  const rows = plan([offer("a", T("Rust", "120 Days"), 3, { actualQty: 1 }), offer("b", T("Rust", "180 Days"), 4.99, { actualQty: 1 })]);
  assert.deepEqual(brief(rows), { a: "reprice", b: "already" });
});

test("a game left out keeps its price AND its stock", () => {
  const rows = plan([offer("a", T("Albion Online", "120 Days"), 3, { actualQty: 1 }), offer("b", T("Rust", "120 Days"), 3)], { except: gameList("albion online"), stock: 20 });
  assert.deepEqual(brief(rows), { a: "skip: game left out on purpose", b: "reprice [stock 5->20]" });
});

test("--limit counts the offers it would change, whatever the change", () => {
  const rows = plan(
    [offer("a", T("Rust", "120 Days"), 3.99, { actualQty: 20 }), offer("b", T("Rust", "180 Days"), 4.99, { actualQty: 2 }), offer("c", T("Rust", "1 Year"), 7), offer("d", T("Warframe", "1 Year"), 7)],
    { stock: 20, limit: 2 },
  );
  assert.deepEqual(brief(rows), { a: "already", b: "stock [stock 2->20]", c: "reprice [stock 5->20]", d: "skip: over the --limit" });
});

/* --------------------------------- the run -------------------------------- */

function fakeIo({ state = {}, onUpdate = null, onRead = null } = {}) {
  const io = { calls: [], slept: [], lines: [], state: JSON.parse(JSON.stringify(state)) };
  io.update = async (id, fields) => {
    io.calls.push("update " + id + " " + JSON.stringify(fields));
    if (onUpdate) return onUpdate(id, fields, io);
    if (fields.unitPrice != null) io.state[id].unit_price = fields.unitPrice;
    if (fields.stock != null) io.state[id].actual_qty = fields.stock;
  };
  io.read = async (id) => {
    io.calls.push("read " + id);
    if (onRead) return onRead(id, io);
    return { offer_currency: "USD", ...io.state[id] };
  };
  io.sleep = async (ms) => io.slept.push(ms);
  io.log = (line) => io.lines.push(line);
  return io;
}
const FAST = { gapMs: 5, settleMs: 1 };
const three = () =>
  plan([offer("a", T("Rust", "120 Days"), 3, { actualQty: 3 }), offer("b", T("Rust", "180 Days"), 4.99, { actualQty: 4 }), offer("c", T("Rust", "1 Year"), 7, { actualQty: 20 })], { stock: 20 });
const live = () => ({ a: { unit_price: 3, actual_qty: 3 }, b: { unit_price: 4.99, actual_qty: 4 }, c: { unit_price: 7, actual_qty: 20 } });
const httpError = (status, message) => Object.assign(new Error(message || "HTTP " + status), { status });

test("one write per offer carrying only what changes, then the read-back", async () => {
  const io = fakeIo({ state: live() });
  const out = await applyG2g(three(), io, FAST);
  assert.deepEqual(io.calls, [
    'update a {"unitPrice":3.99,"stock":20}',
    "read a",
    'update b {"stock":20}',
    "read b",
    'update c {"unitPrice":8.99}',
    "read c",
  ]);
  assert.deepEqual(out.done.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual([out.failed.length, out.stopped, out.left], [0, "", 0]);
  assert.deepEqual(io.slept, [1, 5, 1, 5, 1]);
});

test("a write G2G answers 200 to and does not show is not counted", async () => {
  // price kept on b... here: a's price lands, its stock does not; c's price does not
  const io = fakeIo({
    state: live(),
    onUpdate: (id, fields, io) => {
      if (id === "a") io.state.a.unit_price = fields.unitPrice;
      if (id === "b") io.state.b.actual_qty = fields.stock;
    },
  });
  const out = await applyG2g(three(), io, FAST);
  assert.deepEqual(out.done.map((r) => r.id), ["b"]);
  assert.deepEqual(out.failed.map((f) => f.id + ": " + f.error), [
    "a: sent, not confirmed: G2G still shows a stock of 3 after the write",
    "c: sent, not confirmed: G2G still shows $7.00 after the write",
  ]);
});

test("a read-back in another currency is not taken as agreement", async () => {
  const io = fakeIo({ state: live(), onRead: (id, io) => ({ offer_currency: "EUR", ...io.state[id] }) });
  const out = await applyG2g(three().slice(0, 1), io, FAST);
  assert.equal(out.done.length, 0);
  assert.match(out.failed[0].error, /could not be read back/);
});

test("a refused write is reported as not sent, and three in a row stop the run", async () => {
  const rows = plan(["a", "b", "c", "d", "e"].map((id) => offer(id, T("Game " + id, "120 Days"), 3)));
  const io = fakeIo({ onUpdate: () => { throw httpError(400, "G2G update offer failed (HTTP 400): no"); } });
  const out = await applyG2g(rows, io, FAST);
  assert.deepEqual(io.calls.filter((c) => c.startsWith("read")), []);
  assert.equal(out.failed[0].error, "G2G update offer failed (HTTP 400): no");
  assert.match(out.stopped, /3 failures in a row/);
  assert.deepEqual([out.failed.length, out.left], [3, 2]);
});

test("a quota answer stops the run at once", async () => {
  const io = fakeIo({ state: live(), onUpdate: () => { throw httpError(429, "G2G update offer failed (HTTP 429)"); } });
  const out = await applyG2g(three(), io, FAST);
  assert.deepEqual(io.calls, ['update a {"unitPrice":3.99,"stock":20}']);
  assert.match(out.stopped, /quota/);
  assert.equal(out.left, 2);
});

test("rows that need nothing are never sent", async () => {
  const rows = plan([offer("a", T("Rust", "120 Days"), 3.99, { actualQty: 20 }), offer("b", T("Albion Online", "1 Year"), 7)], { except: gameList("Albion Online"), stock: 20 });
  const io = fakeIo({});
  const out = await applyG2g(rows, io, FAST);
  assert.deepEqual([io.calls.length, out.done.length], [0, 0]);
});
