// scripts/g2g-retire-offers.js — takes a G2G bundle offer off the shelf and
// hands back the accounts it held. The mistakes that cost money here: handing
// back an account a buyer already has, retiring an offer with an order on it,
// and leaving reserved accounts behind an offer that no longer exists.
const test = require("node:test");
const assert = require("node:assert/strict");

const { unitState, planRow, retire, CLAIM_TAG } = require("../scripts/g2g-retire-offers");

const free = (id) => ({ accountId: id, login: "l" + id, orderId: "", messagedAt: null, deliveredAt: null });
const sent = (id) => ({ accountId: id, login: "l" + id, orderId: "o" + id, messagedAt: new Date(), deliveredAt: null });
const taken = (id) => ({ accountId: id, login: "l" + id, orderId: "o" + id, messagedAt: null, deliveredAt: null });
const row = (fields) => ({ marketplace: "g2g", externalId: "G1", status: "active", origin: "auto", title: "Marvel Rivals Twitch Drops (3 Items)", set: "S1", units: [], ...fields });

test("a unit is free until an order takes it, and the buyer's once the message has gone", () => {
  assert.equal(unitState(free("a")), "free");
  assert.equal(unitState(taken("a")), "mid");
  assert.equal(unitState(sent("a")), "sold");
  // G2G units are never stamped deliveredAt (the confirm is the owner's), so
  // the message is what marks a sale; a stamped delivery counts too.
  assert.equal(unitState({ accountId: "a", orderId: "", deliveredAt: new Date() }), "sold");
  assert.equal(unitState(null), "none");
});

test("the reservation tag released is G2G's own", () => {
  assert.equal(CLAIM_TAG, "g2g");
});

test("a share row is retired and names the accounts it holds free", () => {
  const p = planRow(row({ units: [free("a"), free("b"), { ...free(""), accountId: "" }] }));
  assert.deepEqual([p.action, p.free, p.sold, p.why], ["retire", ["a", "b"], 0, ""]);
});

test("an archive row holds nothing and is retired as it is", () => {
  const p = planRow(row({ autoClaimSet: true, units: [] }));
  assert.deepEqual([p.action, p.free], ["retire", []]);
});

test("what it must not touch is left alone, with the reason", () => {
  const why = (r, opts) => planRow(r, opts).action + ": " + planRow(r, opts).why;
  assert.equal(why(null), "skip: no listing row for this offer");
  assert.equal(why(row({ marketplace: "eldorado" })), "skip: not a G2G row");
  assert.equal(why(row({ status: "delisted" })), "skip: row is already delisted");
  assert.match(why(row({ noclaimStock: true })), /^skip: a no-claim listing/);
  assert.match(why(row({ accountOffer: "OFFER" })), /^skip: an account listing/);
  assert.match(why(row({ bulkOfferId: "B1" })), /^skip: a bulk pack/);
  assert.equal(why(row({ units: [free("a"), taken("b")] })), "skip: an order is mid hand-over on it");
  assert.equal(why(row({ units: [free("a")] }), { pendingOfferIds: new Set(["G1"]) }), "skip: G2G lists a paid order for it");
});

test("an offer that has sold keeps its place unless told otherwise", () => {
  const r = row({ units: [free("a"), sent("b")] });
  assert.match(planRow(r).why, /^it has sold 1 — kept for its place in the ranking/);
  const p = planRow(r, { allowSold: true });
  assert.deepEqual([p.action, p.free, p.sold], ["retire", ["a"], 1]);
});

/* ---------------------------------- the run ------------------------------- */

function fakeIo({ rows, statusAfterDelist = () => "delisted", closeOk = () => true, failDelist = () => false }) {
  const io = { calls: [], lines: [], slept: [] };
  io.delist = async (id) => {
    if (failDelist(id)) throw new Error("G2G update offer failed (HTTP 500)");
    io.calls.push("delist " + id);
  };
  io.status = async (id) => statusAfterDelist(id);
  io.closeRow = async (id) => {
    io.calls.push("close " + id);
    return closeOk(id);
  };
  io.freshRow = async (id) => rows[id];
  io.release = async (ids, setId) => io.calls.push("release " + ids.join("+") + " of " + setId);
  io.pullUnits = async (id, ids) => io.calls.push("pull " + ids.join("+") + " from " + id);
  io.sleep = async (ms) => io.slept.push(ms);
  io.log = (l) => io.lines.push(l);
  return io;
}
const plans = (rows) => Object.values(rows).map((r) => planRow(r));

test("delist, read back, close the row, and only then hand the free accounts back", async () => {
  const rows = { G1: row({ units: [free("a"), free("b")] }), G2: row({ externalId: "G2", autoClaimSet: true }) };
  const io = fakeIo({ rows });
  const out = await retire(plans(rows), io, { gapMs: 5 });
  assert.deepEqual(io.calls, ["delist G1", "close G1", "release a+b of S1", "pull a+b from G1", "delist G2", "close G2"]);
  assert.deepEqual([out.done.length, out.released, out.failed.length], [2, 2, 0]);
  assert.deepEqual(io.slept, [5]);
});

test("a sale that landed after the plan keeps its account: the units are read again", async () => {
  const planned = { G1: row({ units: [free("a"), free("b")] }) };
  const now = { G1: row({ units: [sent("a"), free("b")] }) };
  const io = fakeIo({ rows: now });
  const out = await retire(plans(planned), io, { gapMs: 5 });
  assert.deepEqual(io.calls, ["delist G1", "close G1", "release b of S1", "pull b from G1"]);
  assert.equal(out.released, 1);
});

test("G2G's lists trail a delist by a few seconds: the status is asked again before giving up", async () => {
  const rows = { G1: row({ units: [free("a")] }) };
  let reads = 0;
  const io = fakeIo({ rows, statusAfterDelist: () => (++reads < 3 ? "unreadable (404)" : "delisted") });
  const out = await retire(plans(rows), io, { gapMs: 5, statusTries: 4, statusWaitMs: 7 });
  assert.equal(reads, 3);
  assert.deepEqual(io.slept, [7, 7]);
  assert.deepEqual(io.calls, ["delist G1", "close G1", "release a of S1", "pull a from G1"]);
  assert.equal(out.done.length, 1);
});

test("an offer G2G still shows on sale is not closed and nothing is handed back", async () => {
  const rows = { G1: row({ units: [free("a")] }) };
  const io = fakeIo({ rows, statusAfterDelist: () => "live" });
  const out = await retire(plans(rows), io, { gapMs: 5, statusTries: 2, statusWaitMs: 1 });
  assert.deepEqual(io.calls, ["delist G1"]);
  assert.match(out.failed[0].error, /still shows it "live"/);
  assert.equal(out.released, 0);
});

test("a row that stopped being active in between is left as it is", async () => {
  const rows = { G1: row({ units: [free("a")] }) };
  const io = fakeIo({ rows, closeOk: () => false });
  const out = await retire(plans(rows), io, { gapMs: 5 });
  assert.deepEqual(io.calls, ["delist G1", "close G1"]);
  assert.match(out.failed[0].error, /no longer active/);
});

test("three failures in a row stop the run", async () => {
  const rows = Object.fromEntries(["G1", "G2", "G3", "G4"].map((id) => [id, row({ externalId: id })]));
  const io = fakeIo({ rows, failDelist: () => true });
  const out = await retire(plans(rows), io, { gapMs: 5 });
  assert.equal(out.failed.length, 3);
  assert.match(out.stopped, /3 failures/);
});

test("rows that are not to be retired are never sent", async () => {
  const rows = { G1: row({ noclaimStock: true }), G2: row({ externalId: "G2", units: [sent("x")] }) };
  const io = fakeIo({ rows });
  const out = await retire(plans(rows), io, { gapMs: 5 });
  assert.deepEqual([io.calls.length, out.done.length], [0, 0]);
});
