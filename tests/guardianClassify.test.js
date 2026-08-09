const test = require("node:test");
const assert = require("node:assert");
const { classifyUnit } = require("../utils/marketplaceGuardian");

// Build the itemKey -> DropLog map classifyUnit takes. Each spec is
// { key, by, connected }: `by` is the claim tag holding the drop (null = free,
// undefined key = the account never farmed it).
function logs(specs) {
  const m = new Map();
  for (const s of specs) {
    m.set(s.key, {
      itemKey: s.key,
      name: s.name || s.key,
      soldAt: s.by === null || s.by === undefined ? null : new Date(),
      soldToUsername: s.by || "",
      connected: !!s.connected,
    });
  }
  return m;
}

test("a unit holding the whole set under its own tag raises nothing", () => {
  const keys = ["a", "b"];
  const r = classifyUnit(
    keys,
    logs([
      { key: "a", by: "ggsel" },
      { key: "b", by: "ggsel" },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation, null);
  assert.equal(r.redeemed, null);
});

test("drops reserved by another platform are a conflict", () => {
  const r = classifyUnit(
    ["a", "b"],
    logs([
      { key: "a", by: "gameflip" },
      { key: "b", by: "gameflip" },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation.kind, "conflict");
  assert.equal(r.reservation.otherTag, "gameflip");
});

// The set-edit case: the 13 false highs. Every attached unit held exactly the
// keys the set had when it was reserved, and adding items made them all look
// under-reserved.
test("a set that gained drops after reservation is partial, not a conflict", () => {
  const r = classifyUnit(
    ["a", "b", "c"],
    logs([
      { key: "a", by: "zeusx" },
      { key: "b", by: null },
      { key: "c", by: null },
    ]),
    "zeusx",
  );
  assert.equal(r.reservation.kind, "partial");
  assert.equal(r.reservation.held, 1);
  assert.equal(r.reservation.total, 3);
  assert.equal(r.reservation.absent, 0);
  assert.equal(r.reservation.otherTag, "");
});

test("partial counts drops the account never farmed separately", () => {
  const r = classifyUnit(
    ["a", "b", "c"],
    logs([
      { key: "a", by: "zeusx" },
      { key: "b", by: null },
    ]),
    "zeusx",
  );
  assert.equal(r.reservation.kind, "partial");
  assert.equal(r.reservation.held, 1);
  assert.equal(r.reservation.absent, 1);
});

test("a unit holding none of the set reads as released, not partial", () => {
  const r = classifyUnit(
    ["a", "b"],
    logs([
      { key: "a", by: null },
      { key: "b", by: null },
    ]),
    "funpay",
  );
  assert.equal(r.reservation.kind, "released");
  assert.equal(r.reservation.held, 0);
});

test("a conflict outranks a partial shortfall", () => {
  const r = classifyUnit(
    ["a", "b", "c"],
    logs([
      { key: "a", by: "funpay" },
      { key: "b", by: null },
      { key: "c", by: "digiseller" },
    ]),
    "funpay",
  );
  assert.equal(r.reservation.kind, "conflict");
  assert.equal(r.reservation.otherTag, "digiseller");
});

// The 11 false highs: FunPay/ZeusX completed sales. Ownership, not the
// marketplace name, is what says the buyer redeemed it.
test("drops redeemed while still reserved to this listing are a delivered sale", () => {
  const r = classifyUnit(
    ["a", "b"],
    logs([
      { key: "a", by: "funpay", connected: true },
      { key: "b", by: "funpay", connected: true },
    ]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, true);
  assert.equal(r.reservation, null);
});

test("drops redeemed under another tag are a burned unit", () => {
  const r = classifyUnit(
    ["a"],
    logs([{ key: "a", by: "ggsel", connected: true }]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, false);
});

test("drops redeemed while reserved by nobody are a burned unit", () => {
  const r = classifyUnit(
    ["a"],
    logs([{ key: "a", by: null, connected: true }]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, false);
});

test("one drop redeemed outside the listing burns the whole unit", () => {
  const r = classifyUnit(
    ["a", "b"],
    logs([
      { key: "a", by: "funpay", connected: true },
      { key: "b", by: "gameflip", connected: true },
    ]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, false);
});

test("redeemed item names are de-duplicated for the message", () => {
  const r = classifyUnit(
    ["a", "b"],
    logs([
      { key: "a", by: "funpay", connected: true, name: "chest" },
      { key: "b", by: "funpay", connected: true, name: "chest" },
    ]),
    "funpay",
  );
  assert.deepEqual(r.redeemed.items, ["chest"]);
});

test("unredeemed drops raise no redeemed finding", () => {
  const r = classifyUnit(["a"], logs([{ key: "a", by: "ggsel" }]), "ggsel");
  assert.equal(r.redeemed, null);
});
