// Moving accounts between stash sets has to survive the {setId, usernameLower}
// unique index: a username the destination already holds can't be re-parented on
// top of it. These lock in the three outcomes — a clash-free row just changes
// set, a row whose twin is emptier folds into it (filling blanks only), and a row
// whose twin holds DIFFERENT credentials is left strictly alone, because a Twitch
// login isn't a unique identity and dropping it could destroy the only copy of a
// password or token.
const test = require("node:test");
const assert = require("node:assert");

const { planStashMove, conflictingFields } = require("../utils/stashMovePlan");

const src = (over = {}) => ({
  _id: "s1",
  username: "Puvig",
  usernameLower: "puvig",
  clientSecret: "cs-1",
  uniqueId: "uid-1",
  twitchId: "111",
  hasPassword: true,
  password: "enc:v1:AAA", // ciphertext…
  passwordPlain: "pw-1", // …and what it decrypts to
  email: "enc:v1:BBB",
  emailPlain: "me@example.com",
  lastCheckStatus: "ok",
  lastCheckAt: new Date("2026-08-01T00:00:00Z"),
  lastCheckError: "",
  dropCount: 7,
  ...over,
});

// The destination already has a row for this username, but holds nothing.
const emptyDest = (over = {}) => ({
  _id: "d1",
  usernameLower: "puvig",
  clientSecret: "",
  uniqueId: "",
  twitchId: "",
  hasPassword: false,
  passwordPlain: "",
  email: "",
  emailPlain: "",
  lastCheckStatus: "",
  ...over,
});

// The destination's row is the SAME account: same credentials throughout. Note
// the ciphertext differs from the source's — encryption uses a random IV, so
// only the plaintext can prove they match.
const twinDest = (over = {}) => ({
  ...emptyDest(),
  clientSecret: "cs-1",
  uniqueId: "uid-1",
  twitchId: "111",
  hasPassword: true,
  password: "enc:v1:ZZZ",
  passwordPlain: "pw-1",
  email: "enc:v1:YYY",
  emailPlain: "me@example.com",
  // Already live-checked, so tests about credential fields aren't also asserting
  // on the check-result carry-over; the tests that want that override it.
  lastCheckStatus: "ok",
  ...over,
});

test("no clash: the row just changes set, nothing else happens", () => {
  const plan = planStashMove({ accounts: [src()], existing: [], targetSetId: "SET2" });
  assert.deepStrictEqual(plan.reparent, [{ id: "s1", set: { setId: "SET2" } }]);
  assert.strictEqual(plan.merges.length, 0);
  assert.strictEqual(plan.conflicts.length, 0);
});

test("clash with an emptier twin: it folds in and the source row is dropped", () => {
  const plan = planStashMove({ accounts: [src()], existing: [emptyDest()], targetSetId: "SET2" });
  assert.strictEqual(plan.reparent.length, 0, "a clashing row must never be re-parented");
  assert.strictEqual(plan.conflicts.length, 0);
  assert.strictEqual(plan.merges.length, 1);
  const m = plan.merges[0];
  assert.strictEqual(m.destId, "d1");
  assert.strictEqual(m.sourceId, "s1");
  assert.deepStrictEqual(m.set, {
    clientSecret: "cs-1",
    uniqueId: "uid-1",
    twitchId: "111",
    password: "enc:v1:AAA", // the stored ciphertext, not the plaintext
    hasPassword: true,
    email: "enc:v1:BBB",
    lastCheckAt: new Date("2026-08-01T00:00:00Z"),
    lastCheckStatus: "ok",
    lastCheckError: "",
    dropCount: 7,
  });
});

test("a true duplicate merges to a no-op write, not a conflict", () => {
  const plan = planStashMove({ accounts: [src()], existing: [twinDest()], targetSetId: "SET2" });
  assert.strictEqual(plan.conflicts.length, 0, "matching plaintext is the same account");
  assert.strictEqual(plan.merges.length, 1);
  assert.deepStrictEqual(plan.merges[0].set, {}, "nothing to copy: it's a pure de-duplicate");
});

test("only the destination's blanks are filled, each independently", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [twinDest({ clientSecret: "", emailPlain: "", email: "" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(plan.conflicts.length, 0);
  assert.deepStrictEqual(plan.merges[0].set, { clientSecret: "cs-1", email: "enc:v1:BBB" });
});

// --- the credential-loss guard ------------------------------------------------

test("a different password is a conflict: neither row is touched", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [twinDest({ passwordPlain: "a-different-password" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(plan.merges.length, 0, "no merge means no delete of the source row");
  assert.strictEqual(plan.reparent.length, 0);
  assert.deepStrictEqual(plan.conflicts, [
    { sourceId: "s1", destId: "d1", username: "Puvig", fields: ["password"] },
  ]);
});

test("a different token, uniqueId or twitch id is a conflict too", () => {
  for (const [field, value] of [
    ["clientSecret", "cs-OTHER"],
    ["uniqueId", "uid-OTHER"],
    ["twitchId", "222"],
  ]) {
    const plan = planStashMove({
      accounts: [src()],
      existing: [twinDest({ [field]: value })],
      targetSetId: "SET2",
    });
    assert.deepStrictEqual(plan.conflicts.map((c) => c.fields), [[field]], field);
    assert.strictEqual(plan.merges.length, 0, field + " must not merge");
  }
});

test("a different email is a conflict", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [twinDest({ emailPlain: "someone-else@example.com" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.conflicts[0].fields, ["email"]);
});

test("every disagreeing field is reported, so the operator sees the whole picture", () => {
  const plan = planStashMove({
    accounts: [src()],
    existing: [twinDest({ clientSecret: "cs-OTHER", twitchId: "222", passwordPlain: "other" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.conflicts[0].fields, ["clientSecret", "twitchId", "password"]);
});

test("a password that no longer decrypts counts as a disagreement, not a discard", () => {
  // Key rotation: hasPassword is still true but the plaintext is unrecoverable.
  // Treating that as "equal" would delete the source row and lose the real one.
  const plan = planStashMove({
    accounts: [src()],
    existing: [twinDest({ hasPassword: true, passwordPlain: "" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.conflicts[0].fields, ["password"]);
  assert.strictEqual(plan.merges.length, 0);
});

test("one side being empty is a blank to fill, never a conflict", () => {
  assert.deepStrictEqual(conflictingFields(src(), emptyDest()), []);
  // …and the reverse: the source has nothing the destination lacks.
  const bare = src({
    clientSecret: "",
    uniqueId: "",
    twitchId: "",
    hasPassword: false,
    passwordPlain: "",
    email: "",
    emailPlain: "",
  });
  assert.deepStrictEqual(conflictingFields(bare, twinDest()), []);
});

// --- live-check bookkeeping ---------------------------------------------------

test("a live-check result carries over only onto a never-checked row", () => {
  const fresh = planStashMove({
    accounts: [src({ lastCheckStatus: "ok", dropCount: 7 })],
    existing: [twinDest({ lastCheckStatus: "" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(fresh.merges[0].set.lastCheckStatus, "ok");
  assert.strictEqual(fresh.merges[0].set.dropCount, 7);

  const stale = planStashMove({
    accounts: [src({ lastCheckStatus: "ok", dropCount: 7 })],
    existing: [twinDest({ lastCheckStatus: "token_invalid" })],
    targetSetId: "SET2",
  });
  assert.ok(!("lastCheckStatus" in stale.merges[0].set), "a staler answer must not win");
  assert.ok(!("dropCount" in stale.merges[0].set), "drop count belongs to its own check");
});

test("an unchecked source row leaves the destination's check fields alone", () => {
  const plan = planStashMove({
    accounts: [src({ lastCheckStatus: "", lastCheckAt: null, dropCount: 0 })],
    existing: [twinDest({ lastCheckStatus: "" })],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.merges[0].set, {});
});

// --- batches ------------------------------------------------------------------

test("a mixed batch splits three ways and accounts for every row exactly once", () => {
  const accounts = [
    src({ _id: "a", username: "one", usernameLower: "one" }),
    src({ _id: "b", username: "two", usernameLower: "two" }),
    src({ _id: "c", username: "three", usernameLower: "three" }),
    src({ _id: "d", username: "four", usernameLower: "four" }),
  ];
  const plan = planStashMove({
    accounts,
    existing: [
      twinDest({ _id: "dTwo", usernameLower: "two" }), // safe de-dupe
      twinDest({ _id: "dFour", usernameLower: "four", passwordPlain: "different" }), // conflict
    ],
    targetSetId: "SET2",
  });
  assert.deepStrictEqual(plan.reparent.map((r) => r.id), ["a", "c"]);
  assert.deepStrictEqual(plan.merges.map((m) => m.sourceId), ["b"]);
  assert.deepStrictEqual(plan.conflicts.map((c) => c.sourceId), ["d"]);
  assert.strictEqual(
    plan.reparent.length + plan.merges.length + plan.conflicts.length,
    accounts.length,
    "nothing may silently vanish",
  );
});

test("username casing doesn't hide a clash", () => {
  const plan = planStashMove({
    accounts: [src({ username: "PUVIG", usernameLower: "PUVIG" })],
    existing: [twinDest({ usernameLower: "puvig" })],
    targetSetId: "SET2",
  });
  assert.strictEqual(plan.merges.length, 1);
  assert.strictEqual(plan.reparent.length, 0);
});

test("empty and missing inputs are a no-op, not a crash", () => {
  assert.deepStrictEqual(planStashMove({ accounts: [], existing: [], targetSetId: "S" }), {
    reparent: [],
    merges: [],
    conflicts: [],
  });
  assert.deepStrictEqual(planStashMove({ targetSetId: "S" }), {
    reparent: [],
    merges: [],
    conflicts: [],
  });
});
