// Coverage for the auto-healer's two judgement calls, both pure so they can be
// checked without a database or a marketplace:
//   pickDuplicateLoser — which listing KEEPS a double-listed account. Getting
//     this backwards would delist the listing that actually reserved the
//     account and leave the incidental one selling it.
//   healEligibility    — whether a finding may be healed at all. The gates
//     (type, age, attempt budget) are what stop the healer from touching a
//     buyer's reservation or hammering a marketplace that is down.
const test = require("node:test");
const assert = require("node:assert");

const { pickDuplicateLoser } = require("../utils/guardianFixes");
const { healEligibility, MAX_ATTEMPTS } = require("../utils/guardianAutoHeal");

const L = (over = {}) => ({
  _id: "a",
  marketplace: "ggsel",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  units: [],
  ...over,
});

test("the listing that reserved the account keeps it", () => {
  const a = L({ _id: "a", createdAt: "2026-05-01T00:00:00Z" });
  const b = L({ _id: "b", createdAt: "2026-01-01T00:00:00Z" });
  // b is older, but a holds the reservation — a must win anyway.
  const { keep, losers } = pickDuplicateLoser([a, b], { reservedListingId: "a" });
  assert.strictEqual(String(keep._id), "a");
  assert.deepStrictEqual(losers.map((l) => String(l._id)), ["b"]);
});

test("a delivered unit outranks age when nothing is reserved", () => {
  const a = L({ _id: "a", createdAt: "2026-05-01T00:00:00Z", units: [{ contentId: "1" }] });
  const b = L({ _id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const { keep } = pickDuplicateLoser([a, b], {});
  assert.strictEqual(String(keep._id), "a");
});

test("with no other signal the oldest listing keeps the account", () => {
  const a = L({ _id: "a", createdAt: "2026-05-01T00:00:00Z" });
  const b = L({ _id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const { keep, losers } = pickDuplicateLoser([a, b], {});
  assert.strictEqual(String(keep._id), "b");
  assert.strictEqual(losers.length, 1);
});

test("delisted listings are not duplicates and are never touched", () => {
  const a = L({ _id: "a" });
  const b = L({ _id: "b", status: "delisted" });
  const { losers } = pickDuplicateLoser([a, b], {});
  assert.strictEqual(losers.length, 0);
});

test("ordering is deterministic when everything ties", () => {
  const a = L({ _id: "a" });
  const b = L({ _id: "b" });
  const first = pickDuplicateLoser([a, b], {});
  const second = pickDuplicateLoser([b, a], {});
  assert.strictEqual(String(first.keep._id), String(second.keep._id));
});

// ---------------------------------------------------------------- eligibility
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const f = (over = {}) => ({
  status: "open",
  type: "account-gone",
  detectedAt: OLD,
  healAttempts: 0,
  ...over,
});

test("a settled healable finding is eligible", () => {
  assert.strictEqual(healEligibility(f()).ok, true);
});

test("orphaned-reservation is never auto-healed", () => {
  // Those reservations belong to real buyers — releasing one would put a
  // paid-for account back on sale.
  assert.strictEqual(healEligibility(f({ type: "orphaned-reservation" })).ok, false);
});

test("a finding younger than one pass is left alone", () => {
  const fresh = f({ detectedAt: new Date().toISOString() });
  assert.strictEqual(healEligibility(fresh).ok, false);
});

test("a finding stops being retried once its attempts are spent", () => {
  assert.strictEqual(healEligibility(f({ healAttempts: MAX_ATTEMPTS })).ok, false);
});

test("only open findings are healed", () => {
  assert.strictEqual(healEligibility(f({ status: "needs-human" })).ok, false);
  assert.strictEqual(healEligibility(f({ status: "resolved" })).ok, false);
});
