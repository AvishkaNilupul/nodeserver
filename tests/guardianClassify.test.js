const test = require("node:test");
const assert = require("node:assert");
const {
  classifyUnit,
  nothingToFeedReason,
} = require("../utils/marketplaceGuardian");

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

// "Nothing to feed" when the drops were genuinely never farmed reads
// differently from the same message when 15 accounts hold them but are all
// suspended — only the first is fixed by farming more.
test("no holders at all keeps the plain nothing-to-feed wording", () => {
  assert.equal(
    nothingToFeedReason({
      holders: 0,
      suspended: 0,
      noPassword: 0,
      deleted: 0,
    }),
    "",
  );
});

test("holders blocked by suspension are named as such", () => {
  assert.equal(
    nothingToFeedReason({
      holders: 15,
      suspended: 10,
      noPassword: 2,
      deleted: 3,
    }),
    "15 account(s) hold this bundle but none can be delivered: " +
      "10 suspended or dead-token, 2 with no stored password, 3 deleted",
  );
});

test("only the causes that apply are listed", () => {
  assert.equal(
    nothingToFeedReason({
      holders: 5,
      suspended: 5,
      noPassword: 0,
      deleted: 0,
    }),
    "5 account(s) hold this bundle but none can be delivered: " +
      "5 suspended or dead-token",
  );
});

test("holders excluded for none of the known reasons are short on copies", () => {
  assert.equal(
    nothingToFeedReason({
      holders: 4,
      suspended: 1,
      noPassword: 0,
      deleted: 0,
    }),
    "4 account(s) hold this bundle but none can be delivered: " +
      "1 suspended or dead-token, 3 short of the copies the set asks for",
  );
});
