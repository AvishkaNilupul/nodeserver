// Why a rent-farm order that provisioned 1 of 3 leaked pristine accounts.
//
// All three farm services did this on EVERY attempt:
//
//   const res = await operatorFarm.farmFreshAccounts({ count: qty });
//   row.accounts = (res.added || []).map(...);        // OVERWRITE
//
// and after a shortfall left `provisionedAt` null with the comment "the next
// tick tops it up". It did not top up. The next tick asked for the FULL quantity
// again and replaced row.accounts wholesale, so every account the previous
// attempt had already pinned to a bot fell off the order — still deployed, still
// holding a rental stack slot, still farming, `farmUntil` already stamped on its
// RenterAccount, and now unreachable because nothing records which order owns it.
//
// The pool is ~100 bought accounts. A 3-account order that manages 1, then 1,
// then 1 across three ticks ends up owning ONE and leaking TWO — and the branch
// this happens in is the ORDINARY one, the transient Pi write failure that took
// down order 4b20765f.
//
// These tests run the real logic. The bug was arithmetic, so it is tested as
// arithmetic — no source-text matching, which is exactly what failed to catch
// the G2G credential bug (tests/g2gCredentialShape.test.js).
const test = require("node:test");
const assert = require("node:assert");

const {
  heldAccounts,
  stillNeeded,
  mergeProvisioned,
} = require("../utils/farmProvisioning");

const acct = (login, farmUntil = null) => ({
  login,
  poolId: "pool-" + login,
  farmUntil,
});

/* ------------------------- the leak, step by step ------------------------ */

test("REGRESSION: three partial ticks accumulate to three accounts, not one", () => {
  // The exact failure, replayed. A 3-account order; each tick the farm can only
  // place one. The old code ended holding one account and leaking two.
  const row = { accounts: [] };
  const windows = [new Date("2026-01-01"), new Date("2026-01-02"), new Date("2026-01-03")];
  const batches = [[acct("first")], [acct("second")], [acct("third")]];

  for (let i = 0; i < 3; i += 1) {
    const need = stillNeeded(row, 3);
    assert.strictEqual(need, 3 - i, "tick " + (i + 1) + " must ask for only what is missing");
    row.accounts = mergeProvisioned(row.accounts, batches[i], windows[i]);
  }

  assert.strictEqual(row.accounts.length, 3);
  assert.deepStrictEqual(
    row.accounts.map((a) => a.login),
    ["first", "second", "third"],
    "every account the order ever placed must still be on it",
  );
  assert.strictEqual(stillNeeded(row, 3), 0, "the order is now complete");
});

test("the second tick asks the farm for the REMAINDER, never the whole order", () => {
  // Asking for `qty` again is what made the farm claim fresh pristine accounts
  // it did not need — the leak's actual source.
  const row = { accounts: [acct("already")] };
  assert.strictEqual(stillNeeded(row, 3), 2);
  assert.strictEqual(stillNeeded(row, 1), 0, "a satisfied order asks for nothing");
});

test("a completed order never asks for more, even if qty is smaller than it holds", () => {
  // Never negative: farmFreshAccounts reads a negative count as "give me some",
  // which would provision on an order that is already whole.
  const row = { accounts: [acct("a"), acct("b"), acct("c")] };
  assert.strictEqual(stillNeeded(row, 2), 0);
  assert.strictEqual(stillNeeded(row, 0), 0);
  assert.strictEqual(stillNeeded(row, -5), 0);
});

/* ---------------------------- the merge rules ---------------------------- */

test("a login already on the order is never counted twice", () => {
  // Counting a repeat as a second account would make a SHORT order look
  // complete and leave the buyer a unit down — the failure mode we are least
  // able to detect afterwards.
  const row = { accounts: [acct("dupe")] };
  const merged = mergeProvisioned(row.accounts, [acct("dupe"), acct("real")], new Date());
  assert.deepStrictEqual(merged.map((a) => a.login), ["dupe", "real"]);
  assert.strictEqual(stillNeeded({ accounts: merged }, 3), 1, "still one short, and it knows");
});

test("logins are matched case-insensitively", () => {
  // 684 of prod's logins carry capitals; a case-sensitive compare would let the
  // same account be counted twice.
  const merged = mergeProvisioned([acct("MixedCase")], [acct("mixedcase")], new Date());
  assert.strictEqual(merged.length, 1);
});

test("each batch keeps the farm window it was actually given", () => {
  // operatorFarm computes `now + days` inside EACH farmFreshAccounts call and
  // stamps that on the RenterAccount it claims, so a top-up genuinely has a
  // later window. Recomputing one value for everybody would desynchronise the
  // row from what renterExpiry will act on.
  const first = new Date("2026-03-01T00:00:00Z");
  const second = new Date("2026-03-05T00:00:00Z");
  let accounts = mergeProvisioned([], [acct("early")], first);
  accounts = mergeProvisioned(accounts, [acct("late")], second);
  assert.strictEqual(accounts[0].farmUntil.toISOString(), first.toISOString());
  assert.strictEqual(accounts[1].farmUntil.toISOString(), second.toISOString());
});

test("an existing account's window is never rewritten by a later batch", () => {
  const original = new Date("2026-03-01T00:00:00Z");
  const merged = mergeProvisioned([acct("held", original)], [acct("new")], new Date("2027-01-01"));
  assert.strictEqual(merged[0].farmUntil.toISOString(), original.toISOString());
});

/* ------------------------------ robustness ------------------------------ */

test("junk entries never inflate the count", () => {
  // A row read back from Mongo can carry a half-written entry. Counting one as
  // an account would under-provision a paid order.
  const row = { accounts: [acct("real"), { login: "" }, { login: "   " }, null, {}] };
  assert.strictEqual(heldAccounts(row).length, 1);
  assert.strictEqual(stillNeeded(row, 2), 1);
});

test("a missing or empty row is simply an order that holds nothing", () => {
  for (const row of [null, undefined, {}, { accounts: null }, { accounts: [] }]) {
    assert.strictEqual(heldAccounts(row).length, 0);
    assert.strictEqual(stillNeeded(row, 2), 2);
  }
});

test("an empty provisioning result leaves the order exactly as it was", () => {
  // The transient-failure case: the farm returned nothing. The order must keep
  // what it already holds rather than being emptied.
  const held = [acct("keepme", new Date("2026-05-05"))];
  for (const added of [[], null, undefined]) {
    const merged = mergeProvisioned(held, added, new Date());
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].login, "keepme");
    assert.strictEqual(merged[0].farmUntil.toISOString(), new Date("2026-05-05").toISOString());
  }
});

test("reading a row never spreads a Mongoose sub-document", () => {
  // The G2G bug in a different file: `{ ...subdoc }` drops every schema path.
  // Here the equivalent hazard is real, because row.accounts IS a sub-document
  // array when the row comes back from Mongo. Prove the getters are read.
  const mongoose = require("mongoose");
  const sub = new mongoose.Schema({ login: String, poolId: String, farmUntil: Date });
  const Row = mongoose.model(
    "FarmProvisioningTestRow",
    new mongoose.Schema({ accounts: [sub] }),
  );
  const doc = new Row({ accounts: [{ login: "fromdb", poolId: "p1" }] });
  assert.strictEqual({ ...doc.accounts[0] }.login, undefined, "the hazard is real");
  assert.strictEqual(heldAccounts(doc)[0].login, "fromdb", "but we read it correctly");
  assert.strictEqual(stillNeeded(doc, 2), 1);
});
