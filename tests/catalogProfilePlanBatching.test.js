const test = require("node:test");
const assert = require("node:assert/strict");

const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const {
  buildCatalogProfilePlan,
  rollUpAccountRows,
  CATALOG_PLAN_GAME_BATCH,
} = require("../utils/catalogProfiles");

test("rollUpAccountRows folds first-stage rows into per-(game, account) rows", () => {
  const into = new Map();
  rollUpAccountRows(
    [
      { _id: { game: "A", account: "a1", itemKey: "x" }, count: 2 },
      { _id: { game: "A", account: "a1", itemKey: "y" }, count: 1 },
      { _id: { game: "B", account: "a1", itemKey: "x" }, count: 5 },
    ],
    into,
  );
  // A second batch accumulates into the same map.
  rollUpAccountRows([{ _id: { game: "A", account: "a2", itemKey: "x" }, count: 3 }], into);
  const rows = [...into.values()];
  assert.equal(rows.length, 3);
  const a1 = rows.find((r) => r._id.game === "A" && r._id.account === "a1");
  assert.deepEqual(a1.items, [
    { itemKey: "x", count: 2 },
    { itemKey: "y", count: 1 },
  ]);
  assert.equal(a1.totalRewards, 3);
  assert.equal(rows.find((r) => r._id.game === "B").totalRewards, 5);
});

// An in-memory DropLog that answers exactly the two pipeline shapes the plan
// builder sends, and records every pipeline so the test can inspect them.
function fakeDropLog(docs) {
  const pipelines = [];
  const matches = (d, m) =>
    (!m.game || !m.game.$in || m.game.$in.includes(d.game)) &&
    d.connected !== true &&
    d.soldAt == null &&
    d.itemKey !== "";
  return {
    pipelines,
    aggregate: async (pipeline) => {
      pipelines.push(pipeline);
      const m = pipeline[0].$match;
      const rows = docs.filter((d) => matches(d, m));
      const g = pipeline[1].$group;
      const groups = new Map();
      if (g._id.account) {
        for (const d of rows) {
          const k = [d.game, d.account, d.itemKey].join("|");
          const cur = groups.get(k) || { _id: { game: d.game, account: d.account, itemKey: d.itemKey }, count: 0 };
          cur.count += d.count;
          groups.set(k, cur);
        }
      } else {
        for (const d of rows) {
          const k = [d.game, d.itemKey].join("|");
          if (!groups.has(k)) groups.set(k, { _id: { game: d.game, itemKey: d.itemKey }, name: d.name, image: "", campaigns: [] });
        }
      }
      return [...groups.values()];
    },
    distinct: async () => [...new Set(docs.map((d) => d.game))],
  };
}

test("buildCatalogProfilePlan batches games and never $pushes per account", async (t) => {
  // 14 games (> one batch) with three identical accounts each, so every game
  // yields exactly one profile at minStock 2.
  const games = Array.from({ length: CATALOG_PLAN_GAME_BATCH + 2 }, (_, i) => "Game " + i);
  const docs = [];
  for (const game of games) {
    for (const account of ["acc1", "acc2", "acc3"]) {
      docs.push({ game, account: game + ":" + account, itemKey: "item|" + game, name: "Item", count: 1 });
      docs.push({ game, account: game + ":" + account, itemKey: "other|" + game, name: "Other", count: 2 });
    }
  }
  const fake = fakeDropLog(docs);
  const origAggregate = DropLog.aggregate;
  const origDistinct = DropLog.distinct;
  const origFind = BotAccount.find;
  DropLog.aggregate = fake.aggregate;
  DropLog.distinct = fake.distinct;
  BotAccount.find = (query) => ({
    lean: async () =>
      query._id.$in.map((id) => ({ _id: id, login: "login-" + id, credPassword: "enc", lastScanStatus: "ok" })),
  });
  t.after(() => {
    DropLog.aggregate = origAggregate;
    DropLog.distinct = origDistinct;
    BotAccount.find = origFind;
  });

  const plan = await buildCatalogProfilePlan({ games, minStock: 2 });

  const stageCalls = fake.pipelines.filter((p) => p[1].$group._id.account);
  assert.equal(stageCalls.length, 2, "14 games at 12 per batch = 2 aggregations");
  for (const p of stageCalls) {
    assert.ok(p[0].$match.game.$in.length <= CATALOG_PLAN_GAME_BATCH);
    assert.equal(p.length, 2, "numeric first stage only");
  }
  assert.ok(
    !JSON.stringify(fake.pipelines).includes("$push"),
    "no pipeline may $push per account — that is the stage that blew the Atlas limit",
  );
  assert.equal(plan.length, games.length, "one profile per game");
  for (const profile of plan) {
    assert.equal(profile.stock, 3);
    assert.equal(profile.items.length, 2);
    assert.equal(profile.totalRewards, 3);
  }
});
