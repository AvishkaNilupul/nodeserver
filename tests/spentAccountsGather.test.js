const test = require("node:test");
const assert = require("node:assert/strict");

const spentAccounts = require("../routes/spentAccountsRoutes");

// The list page used to pull every pool row, every bot row and the whole drop
// archive on each load. These two properties are what make the narrowed gather
// both fast and correct, so they are worth pinning.
test("the archive rollup only ever returns logins with a real delivery", () => {
  const full = spentAccounts.dropRollupPipeline(null);
  const last = full[full.length - 1];
  assert.deepEqual(last, { $match: { delivered: { $gt: 0 } } });
  // Safe only because a sold-but-undelivered drop is by definition delivered:
  // soldUnconnected counts realSale drops, and realSale implies delivered. If
  // that ever stops holding, this gate would start hiding the guard that keeps
  // a sold-awaiting-delivery account out of the farmer's hands.
  const rollup = full.find((stage) => stage.$group && stage.$group._id === "$_id.login");
  assert.deepEqual(rollup.$group.soldUnconnected.$sum.$cond[0].$and[1], "$realSale");
});

test("the rollup scans the whole archive only when no logins are scoped", () => {
  assert.ok(!spentAccounts.dropRollupPipeline(null)[0].$match);
  const scoped = spentAccounts.dropRollupPipeline(["a", "B"]);
  assert.deepEqual(scoped[0], { $match: { login: { $in: ["a", "B"] } } });
  assert.equal(scoped.length, spentAccounts.dropRollupPipeline(null).length + 1);
});

test("matchRow resolves a recycle body by login or id, and skips pool-less rows", () => {
  const rows = [
    { username: "BotOnly", _pool: null },
    { username: "Spent1", _pool: { _id: "abc123", usernameLower: "spent1" } },
  ];
  assert.equal(spentAccounts.matchRow(rows, { login: "SPENT1" }).username, "Spent1");
  assert.equal(spentAccounts.matchRow(rows, { login: " spent1 " }).username, "Spent1");
  assert.equal(spentAccounts.matchRow(rows, { id: "abc123" }).username, "Spent1");
  assert.equal(spentAccounts.matchRow(rows, { login: "BotOnly" }), null);
  assert.equal(spentAccounts.matchRow(rows, {}), null);
});

test("publicRow never leaks the internal pool row or facts", () => {
  const safe = spentAccounts.publicRow({
    username: "Spent1",
    recyclable: true,
    _pool: { clientSecret: "secret" },
    _facts: { farmSpent: true },
    botId: "bot1",
  });
  assert.deepEqual(safe, { username: "Spent1", recyclable: true });
});
