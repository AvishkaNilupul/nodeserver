// Marking an account suspended keeps it out of every FUTURE selection, but a
// listing published before that is already on sale with its credentials in it —
// a buyer pays and receives a login Twitch has deleted. Eleven live listings on
// prod (Gameflip, Plati, GGSel) were in exactly that state.
//
// These tests cover the two pure decisions behind taking them off sale: which
// listings still reference a given account, and what remedy an "account gone"
// finding offers. Both have to see `units` as well as the top-level pair, since
// that is where the quantity-fed platforms record the account behind each unit.
const test = require("node:test");
const assert = require("node:assert");

const { listingRefsAccount } = require("../utils/suspendedAccounts");
const { fixPlanFor } = require("../utils/guardianFixes");

test("matches the top-level account id and login, case-insensitively", () => {
  const row = { accountId: "acc1,acc2", accountLogin: "Alpha, Beta" };
  assert.ok(listingRefsAccount(row, "acc2", ""));
  assert.ok(listingRefsAccount(row, "", "ALPHA"));
  assert.ok(!listingRefsAccount(row, "acc3", "gamma"));
});

test("matches a quantity-fed unit, which is where Plati/GGSel record it", () => {
  const row = {
    accountId: "",
    accountLogin: "",
    units: [
      { accountId: "acc9", login: "Nine", contentId: "1" },
      { accountId: "", login: "ten", contentId: "2" },
    ],
  };
  assert.ok(listingRefsAccount(row, "acc9", ""));
  assert.ok(listingRefsAccount(row, "", "TEN"));
  assert.ok(!listingRefsAccount(row, "acc8", "eleven"));
});

test("an empty id or login never matches an empty field", () => {
  // Otherwise every listing with no account attached would look like a match
  // and get detached.
  const row = { accountId: "", accountLogin: "", units: [{}] };
  assert.ok(!listingRefsAccount(row, "", ""));
  assert.ok(!listingRefsAccount(row, null, null));
});

const gone = (over = {}) => ({
  status: "open",
  type: "account-gone",
  accountId: "acc1",
  accountLogin: "alpha",
  ...over,
});

test("a deleted account can be taken off sale on every platform", () => {
  // Unlike dead-token, which only Digiseller (with a recorded unit) and FunPay
  // can act on: the login is gone, so delisting is always a valid remedy.
  for (const marketplace of [
    "gameflip",
    "digiseller",
    "ggsel",
    "zeusx",
    "funpay",
  ]) {
    const plan = fixPlanFor(gone(), {
      _id: "l1",
      marketplace,
      externalId: "x",
      status: "active",
      units: [],
    });
    assert.ok(plan, marketplace + " should offer a fix");
    assert.strictEqual(plan.action, "retire");
  }
});

test("nothing is offered once the listing is no longer on sale", () => {
  const plan = fixPlanFor(gone(), {
    _id: "l1",
    marketplace: "gameflip",
    status: "delisted",
  });
  assert.strictEqual(plan, null);
});

test("a finding with no account attached offers nothing", () => {
  assert.strictEqual(
    fixPlanFor(gone({ accountId: "", accountLogin: "" }), {
      _id: "l1",
      marketplace: "gameflip",
      status: "active",
    }),
    null,
  );
});
