// A suspended account and an expired token look identical from Twitch's auth
// response — both get a 401 — and the system used to file both as
// "token_invalid". That single conflation is what starved auto-listing on prod:
// 583 accounts Twitch had deleted stayed assigned to active tasks (the dead-token
// reaper keeps token_invalid accounts on purpose, because a re-auth would recover
// their farmed drops), every task therefore read as at-target, backfill added
// nobody, and no live account was left holding a full bundle to list — while
// 1,471 healthy accounts sat unclaimed in the pool.
//
// The two rules these tests pin down are the ones that make the fix safe:
//   1. Only a clean 200 with an explicitly null user proves absence. Anything
//      else — a rate limit, a 5xx, a GQL error, a network failure — is UNKNOWN
//      and must never look like a suspension, because a purge follows this
//      verdict.
//   2. Even a proven suspension is not automatically deletable: a row that was
//      sold or is attached to a marketplace listing is the only evidence behind
//      a refund or dispute, so it is kept and merely marked.
const test = require("node:test");
const assert = require("node:assert");

const accountState = require("../utils/twitchAccountState");
const { purgePlanFor } = require("../utils/suspendedAccounts");

const { EXISTS, GONE, UNKNOWN, classifyUserProbe } = accountState;

test("a 200 with an explicitly null user is the only proof of absence", () => {
  assert.equal(classifyUserProbe(200, { data: { user: null } }), GONE);
  assert.equal(
    classifyUserProbe(200, { data: { user: { id: "1", login: "a" } } }),
    EXISTS,
  );
});

test("nothing transient is ever mistaken for a suspension", () => {
  // Rate limits and outages are exactly what a healthy account hits too.
  assert.equal(classifyUserProbe(429, { data: { user: null } }), UNKNOWN);
  assert.equal(classifyUserProbe(503, {}), UNKNOWN);
  assert.equal(classifyUserProbe(401, { data: { user: null } }), UNKNOWN);
  // A GQL-level error means the query never really answered the question.
  assert.equal(
    classifyUserProbe(200, {
      data: { user: null },
      errors: [{ message: "PersistedQueryNotFound" }],
    }),
    UNKNOWN,
  );
  // Missing/garbled payloads answer nothing either.
  assert.equal(classifyUserProbe(200, null), UNKNOWN);
  assert.equal(classifyUserProbe(200, { data: {} }), UNKNOWN);
  assert.equal(classifyUserProbe(200, "not json"), UNKNOWN);
});

test("an undefined user is not a null user", () => {
  // `"user" in data` is deliberate: a response whose shape changed must read as
  // UNKNOWN rather than silently condemning every account in the sweep.
  assert.equal(classifyUserProbe(200, { data: { other: 1 } }), UNKNOWN);
});

test("only a confirmed-suspended row is ever a delete candidate", () => {
  const refs = new Set();
  assert.equal(
    purgePlanFor({ _id: "1", lastScanStatus: "suspended" }, refs).action,
    "delete",
  );
  for (const status of ["ok", "token_invalid", "error", "pending"]) {
    assert.equal(
      purgePlanFor({ _id: "1", lastScanStatus: status }, refs).action,
      "keep",
      status + " must never be deletable",
    );
  }
  assert.equal(purgePlanFor(null, refs).action, "keep");
});

test("sale and listing evidence outlives the account", () => {
  const gone = { _id: "1", login: "Buyer1", lastScanStatus: "suspended" };
  assert.equal(
    purgePlanFor({ ...gone, soldAt: new Date() }, new Set()).action,
    "keep",
  );
  assert.equal(
    purgePlanFor({ ...gone, soldPurchaseId: "p1" }, new Set()).action,
    "keep",
  );
  assert.equal(
    purgePlanFor({ ...gone, soldBulkOrderId: "b1" }, new Set()).action,
    "keep",
  );
  // Referenced by id...
  assert.equal(purgePlanFor(gone, new Set(["1"])).action, "keep");
  // ...or by login, which is how a manually-fed listing tracks its accounts.
  // Prod stores 684 logins with capitals, so the match has to be case-folded.
  assert.equal(purgePlanFor(gone, new Set(["buyer1"])).action, "keep");
});
