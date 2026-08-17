const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeAccountScope,
  stockForSetFromHoldings,
} = require("../routes/shopRoutes");

const items = [
  { itemKey: "skin|game", qty: 1 },
  { itemKey: "spray|game", qty: 2 },
];

const holdings = [
  {
    login: "EventOne",
    counts: new Map([
      ["skin|game", 1],
      ["spray|game", 2],
    ]),
  },
  {
    login: "OtherStock",
    counts: new Map([
      ["skin|game", 4],
      ["spray|game", 4],
    ]),
  },
  {
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

test("account scope normalization is case-insensitive and deduplicated", () => {
  assert.deepEqual(normalizeAccountScope([" EventOne ", "eventone", "Two"]), [
    "eventone",
    "two",
  ]);
});
