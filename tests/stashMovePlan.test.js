// Moving accounts between stash sets has to survive the {setId, usernameLower}
// unique index: a username the destination already holds can't be re-parented on
// top of it. These lock in that clash-free rows just change set, that a clashing
// row folds into the destination filling blanks only, and that folding can never
// overwrite a password, token or a fresher live-check result.
const test = require("node:test");
const assert = require("node:assert");

const { planStashMove } = require("../utils/stashMovePlan");

const src = (over = {}) => ({
  _id: "s1",
  username: "Puvig",
  usernameLower: "puvig",
  clientSecret: "cs-src",
  uniqueId: "uid-src",
  twitchId: "111",
  hasPassword: true,
  password: "enc:v1:src-pw",
  email: "enc:v1:src-mail",
  lastCheckStatus: "ok",
  lastCheckAt: new Date("2026-08-01T00:00:00Z"),
  lastCheckError: "",
  dropCount: 7,
  ...over,
});

// A destination row that already holds everything — nothing may be copied onto it.
const fullDest = (over = {}) => ({
  _id: "d1",
  usernameLower: "puvig",
  clientSecret: "cs-dest",
  uniqueId: "uid-dest",
  twitchId: "999",
  hasPassword: true,
  hasEmail: true,
  lastCheckStatus: "token_invalid",
  ...over,
});

test("no clash: the row just changes set, nothing is merged", () => {
  const plan = planStashMove({ accounts: [src()], existing: [], targetSetId: "SET2" });
  assert.deepStrictEqual(plan.reparent, [{ id: "s1", set: { setId: "SET2" } }]);
  assert.strictEqual(plan.merges.length, 0);
});

test("clash: source row folds into the destination and is dropped, not re-parented", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [fullDest({ clientSecret: "", uniqueId: "", twitchId: "", hasPassword: false, hasEmail: false, lastCheckStatus: "" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(plan.reparent.length, 0, "a clashing row must never be re-parented");
  assert.strictEqual(plan.merges.length, 1);
  const m = plan.merges[0];
  assert.strictEqual(m.destId, "d1");
  assert.strictEqual(m.sourceId, "s1");
  assert.deepStrictEqual(m.set, {
    clientSecret: "cs-src",
    uniqueId: "uid-src",
    twitchId: "111",
    password: "enc:v1:src-pw",
    hasPassword: true,
    email: "enc:v1:src-mail",
    lastCheckAt: new Date("2026-08-01T00:00:00Z"),
    lastCheckStatus: "ok",
    lastCheckError: "",
    dropCount: 7,
  });
});

test("merging never clobbers anything the destination already has", () => {
  const plan = planStashMove({ accounts: [src()], existing: [fullDest()], targetSetId: "SET2" });
  assert.strictEqual(plan.merges.length, 1);
  // Empty $set: the destination is complete, so the move is a pure de-duplicate.
  assert.deepStrictEqual(plan.merges[0].set, {});
});

test("a stale live-check never replaces the destination's own result", () => {
  const plan = planStashMove({
    accounts: [src({ lastCheckStatus: "ok", dropCount: 7 })],
    existing: [fullDest({ lastCheckStatus: "token_invalid" })],
    targetSetId: "SET2",
  });
  const set = plan.merges[0].set;
  assert.ok(!("lastCheckStatus" in set));
  assert.ok(!("dropCount" in set), "drop count belongs to the check it came from");
});

test("an unchecked source row leaves the destination's check fields alone", () => {
  const plan = planStashMove({
    accounts: [src({ lastCheckStatus: "", lastCheckAt: null, dropCount: 0 })],
    existing: [fullDest({ lastCheckStatus: "" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.merges[0].set, {});
});

test("each blank on the destination is filled independently", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [fullDest({ clientSecret: "", hasEmail: false })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.merges[0].set, {
    clientSecret: "cs-src",
    email: "enc:v1:src-mail",
  });
});

test("a mixed batch splits into re-parents and merges, one entry per account", () => {
  const accounts = [
    src({ _id: "a", username: "one", usernameLower: "one" }),
    src({ _id: "b", username: "two", usernameLower: "two" }),
    src({ _id: "c", username: "three", usernameLower: "three" }),
  ];
  const plan = planStashMove({
    accounts,
    existing: [fullDest({ _id: "dTwo", usernameLower: "two" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.reparent.map((r) => r.id), ["a", "c"]);
  assert.deepStrictEqual(plan.merges.map((m) => [m.sourceId, m.destId]), [["b", "dTwo"]]);
  // Every account is accounted for exactly once — nothing silently vanishes.
  assert.strictEqual(plan.reparent.length + plan.merges.length, accounts.length);
});

test("username casing doesn't hide a clash", () => {
  const plan = planStashMove({
    accounts: [src({ username: "PUVIG", usernameLower: "PUVIG" })],
    existing: [fullDest({ usernameLower: "puvig" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(plan.merges.length, 1);
  assert.strictEqual(plan.reparent.length, 0);
});

test("empty and missing inputs are a no-op, not a crash", () => {
  assert.deepStrictEqual(planStashMove({ accounts: [], existing: [], targetSetId: "S" }), {
    reparent: [],
    merges: [],
  });
  assert.deepStrictEqual(planStashMove({ targetSetId: "S" }), { reparent: [], merges: [] });
});
