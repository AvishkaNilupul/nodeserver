const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeAccountScope,
  normalizeAccountScopeIds,
  stockForSetFromHoldings,
} = require("../routes/shopRoutes");

const items = [
  { itemKey: "skin|game", qty: 1 },
  { itemKey: "spray|game", qty: 2 },
];

const holdings = [
  {
    accountId: "111111111111111111111111",
    login: "EventOne",
    counts: new Map([
      ["skin|game", 1],
      ["spray|game", 2],
    ]),
  },
  {
    accountId: "222222222222222222222222",
    login: "OtherStock",
    counts: new Map([
      ["skin|game", 4],
      ["spray|game", 4],
    ]),
  },
  {
    accountId: "333333333333333333333333",
    login: "Incomplete",
    counts: new Map([
      ["skin|game", 1],
      ["spray|game", 1],
    ]),
  },
];

test("event-scoped stock counts only assigned farming accounts", () => {
  const result = stockForSetFromHoldings(
    { items, accountScopeLogins: ["eventone"] },
    holdings,
  );
  assert.equal(result.stock, 1);
});

test("unscoped sets preserve archive-wide stock behavior", () => {
  const result = stockForSetFromHoldings({ items }, holdings);
  assert.equal(result.stock, 2);
});

test("id scope takes precedence when duplicate logins exist", () => {
  const duplicateLoginHoldings = holdings.map((row) => ({
    ...row,
    login: "same-login",
  }));
  const result = stockForSetFromHoldings(
    {
      items,
      accountScopeLogins: ["same-login"],
      accountScopeIds: ["111111111111111111111111"],
    },
    duplicateLoginHoldings,
  );
  assert.equal(result.stock, 1);
});

test("account scope normalization is case-insensitive and deduplicated", () => {
  assert.deepEqual(normalizeAccountScope([" EventOne ", "eventone", "Two"]), [
    "eventone",
    "two",
  ]);
});

test("account id scope keeps only valid unique ObjectIds", () => {
  assert.deepEqual(
    normalizeAccountScopeIds([
      "111111111111111111111111",
      "111111111111111111111111",
      "not-an-id",
    ]),
    ["111111111111111111111111"],
  );
});
