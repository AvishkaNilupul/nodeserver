const test = require("node:test");
const assert = require("node:assert");
const {
  classifyUnit,
  summarizeDrops,
  nothingToFeedReason,
} = require("../utils/marketplaceGuardian");

// Build the DropLog rows for one account. Each spec is { key, by, connected }:
// `by` is the claim tag holding that copy (null = free, a key absent from the
// list = the account never farmed it). Several specs may share a key, which is
// how an account holding multiple copies of a drop is expressed.
function logs(specs) {
  return specs.map((s) => ({
    itemKey: s.key,
    name: s.name || s.key,
    soldAt: s.by === null || s.by === undefined ? null : new Date(),
    soldToUsername: s.by || "",
    soldSetId: s.forSet || "",
    connected: !!s.connected,
  }));
}

function classify(keys, rows, tag) {
  return classifyUnit(keys, summarizeDrops(rows, tag));
}

test("a unit holding the whole set under its own tag raises nothing", () => {
  const keys = ["a", "b"];
  const r = classify(
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
  const r = classify(
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
  const r = classify(
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
  const r = classify(
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
  const r = classify(
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
  const r = classify(
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
  const r = classify(
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
  const r = classify(
    ["a"],
    logs([{ key: "a", by: "ggsel", connected: true }]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, false);
});

test("drops redeemed while reserved by nobody are a burned unit", () => {
  const r = classify(
    ["a"],
    logs([{ key: "a", by: null, connected: true }]),
    "funpay",
  );
  assert.equal(r.redeemed.delivered, false);
});

test("one drop redeemed outside the listing burns the whole unit", () => {
  const r = classify(
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
  const r = classify(
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
  const r = classify(["a"], logs([{ key: "a", by: "ggsel" }]), "ggsel");
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

// An account can hold several copies of the same drop; reserving a unit marks
// only the copies it needs. Picking an arbitrary copy per item made properly
// reserved units look released, which is what turned one guardian pass into
// ~90 phantom "could be sold again elsewhere" alarms.
test("a reserved copy beats a spare free copy of the same drop", () => {
  const r = classify(
    ["a"],
    logs([
      { key: "a", by: "ggsel" },
      { key: "a", by: null },
      { key: "a", by: null },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation, null);
});

test("a spare free copy does not mask another platform's claim", () => {
  const r = classify(
    ["a"],
    logs([
      { key: "a", by: null },
      { key: "a", by: "digiseller" },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation.kind, "conflict");
  assert.equal(r.reservation.otherTag, "digiseller");
});

test("our own reserved copy outranks another platform's copy", () => {
  const r = classify(
    ["a"],
    logs([
      { key: "a", by: "digiseller" },
      { key: "a", by: "ggsel" },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation, null);
});

test("one redeemed copy still reports the unit as redeemed", () => {
  const r = classify(
    ["a"],
    logs([
      { key: "a", by: "ggsel", connected: true, name: "Cape" },
      { key: "a", by: "ggsel" },
    ]),
    "ggsel",
  );
  assert.deepEqual(r.redeemed.items, ["Cape"]);
  assert.equal(r.redeemed.delivered, true);
});

test("a copy redeemed under someone else's tag still burns the unit", () => {
  const r = classify(
    ["a"],
    logs([
      { key: "a", by: "ggsel" },
      { key: "a", by: "digiseller", connected: true, name: "Cape" },
    ]),
    "ggsel",
  );
  assert.equal(r.redeemed.delivered, false);
});

// A conflict says "another listing holds these drops", but WHICH one decides
// what the owner does about it: a rival claim on the SAME set is two listings
// double-selling one unit, while a claim from a DIFFERENT set means this set
// was edited to include drops the account had already committed elsewhere.
// Live prod's two remaining conflicts are both the second kind, and reporting
// them without naming the product left nothing to act on.
test("a conflict carries the set that actually holds the drops", () => {
  const r = classify(
    ["gw4", "charity"],
    logs([
      { key: "gw4", by: "ggsel", forSet: "setA" },
      { key: "charity", by: "digiseller", forSet: "setB" },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation.kind, "conflict");
  assert.equal(r.reservation.otherTag, "digiseller");
  assert.equal(r.reservation.otherSet, "setB");
  assert.equal(r.reservation.held, 1);
  assert.equal(r.reservation.total, 2);
});

test("the reported clash is the one that names a rival, not the first gap", () => {
  // "a" is merely unreserved; the actionable fact is that "b" is held by ggsel.
  const r = classify(
    ["a", "b"],
    logs([
      { key: "a", by: null },
      { key: "b", by: "ggsel", forSet: "setB" },
    ]),
    "gameflip",
  );
  assert.equal(r.reservation.kind, "conflict");
  assert.equal(r.reservation.otherTag, "ggsel");
  assert.equal(r.reservation.otherSet, "setB");
});

test("a unit with no rival claim reports no rival set", () => {
  const r = classify(
    ["a", "b"],
    logs([
      { key: "a", by: "ggsel", forSet: "setA" },
      { key: "b", by: null },
    ]),
    "ggsel",
  );
  assert.equal(r.reservation.kind, "partial");
  assert.equal(r.reservation.otherSet, "");
});
