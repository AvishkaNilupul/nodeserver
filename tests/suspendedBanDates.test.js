// A ban is an event with a date. Two paths used to re-date old bans every day
// and announce them again as new (measured on prod, 2026-09-25):
//   * the pool re-probe re-checked rows already confirmed gone, stamped
//     suspendedAt = now and counted them — the same ~72 accounts, daily;
//   * a bot row that flapped back to token_invalid (the drop scanner demoted it
//     on an inconclusive probe) was re-classified with a fresh suspendedAt —
//     one account, velvet36phoenix409249, "newly banned" every evening.
// These tests pin the rule: a row that already carries suspendedAt keeps it and
// is not counted as news; a pool row already suspended is not re-probed at all.
const test = require("node:test");
const assert = require("node:assert");

const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const accountState = require("../utils/twitchAccountState");
const suspended = require("../utils/suspendedAccounts");

// Thenable stand-in for a mongoose query chain (.lean/.limit/.sort).
function queryOf(rows) {
  const q = {
    lean: () => q,
    limit: () => q,
    sort: () => q,
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
  };
  return q;
}

function stub(obj, key, fn, restore) {
  const orig = obj[key];
  obj[key] = fn;
  restore.push(() => {
    obj[key] = orig;
  });
}

test("a re-confirmed bot ban keeps its date and is not counted as new", async (t) => {
  const restore = [];
  t.after(() => restore.forEach((r) => r()));
  const oldBan = new Date("2026-08-26T11:07:23Z");
  const updates = [];
  stub(BotAccount, "find", () =>
    queryOf([
      { _id: "new1", login: "freshban", suspendedAt: null },
      { _id: "old1", login: "velvet36phoenix409249", suspendedAt: oldBan },
      { _id: "alive", login: "stillhere", suspendedAt: null },
    ]),
  restore);
  stub(BotAccount, "updateMany", async (filter, update) => {
    updates.push({ ids: filter._id.$in, set: update.$set });
    return { modifiedCount: filter._id.$in.length };
  }, restore);
  stub(AvailableAccount, "updateMany", async () => ({ modifiedCount: 0 }), restore);
  stub(accountState, "probeAccounts", async (logins) =>
    new Map(logins.map((l) => [l, l === "stillhere" ? accountState.EXISTS : accountState.GONE])),
  restore);

  const r = await suspended.classifyBotAccounts();
  assert.equal(r.suspended, 1, "only the first-time ban is news");
  assert.equal(r.alive, 1);
  const fresh = updates.find((u) => u.ids.includes("new1"));
  const again = updates.find((u) => u.ids.includes("old1"));
  assert.ok(fresh.set.suspendedAt instanceof Date, "a new ban is dated now");
  assert.equal(fresh.set.lastScanStatus, "suspended");
  assert.equal(again.set.lastScanStatus, "suspended");
  assert.equal("suspendedAt" in again.set, false, "an old ban keeps its date");
  assert.equal(fresh.ids.includes("old1"), false);
});

test("the pool re-probe never re-reads a row already confirmed gone", async (t) => {
  const restore = [];
  t.after(() => restore.forEach((r) => r()));
  let seenFilter = null;
  const updates = [];
  stub(AvailableAccount, "find", (filter) => {
    seenFilter = filter;
    return queryOf([
      { _id: "p1", usernameLower: "newlygone", suspendedAt: null },
      { _id: "p2", usernameLower: "wasgonebefore", suspendedAt: new Date("2026-08-10") },
    ]);
  }, restore);
  stub(AvailableAccount, "updateMany", async (filter, update) => {
    updates.push({ ids: filter._id.$in, set: update.$set });
    return { modifiedCount: filter._id.$in.length };
  }, restore);
  stub(accountState, "probeAccounts", async (logins) =>
    new Map(logins.map((l) => [l, accountState.GONE])),
  restore);

  const r = await suspended.classifyPoolAccounts();
  assert.deepEqual(seenFilter.lastCheckStatus, { $ne: "suspended" });
  assert.equal(r.suspended, 1, "a row that already had a ban date is not news");
  const fresh = updates.find((u) => u.set && u.set.lastCheckStatus && u.ids.includes("p1"));
  const again = updates.find((u) => u.set && u.set.lastCheckStatus && u.ids.includes("p2"));
  assert.ok(fresh.set.suspendedAt instanceof Date);
  assert.equal("suspendedAt" in again.set, false);
});
