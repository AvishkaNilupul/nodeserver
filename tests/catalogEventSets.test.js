const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stampPreorderSet,
  syncHistoricalEventSets,
} = require("../utils/catalogPreorder");

test("preorder event set is stamped idempotently with public-safe fields", async () => {
  const writes = [];
  const DropSet = {
    updateOne(filter, update, options) {
      writes.push({ filter, update, options });
      return Promise.resolve({ upsertedCount: 1 });
    },
  };
  await stampPreorderSet(
    {
      _id: "task-1",
      campaignId: "campaign-1",
      game: "Rocket League",
      campaignName: "Summer Event",
      assignedAccounts: ["a", "b"],
      campaignEndAt: "2026-08-30",
    },
    {
      DropSet,
      campaignItems: async () => [
        { itemKey: "reward-1", name: "Reward", game: "Rocket League", qty: 2 },
      ],
      derivePrice: () => 4.5,
      research: {},
    },
  );
  await stampPreorderSet(
    {
      _id: "task-1",
      campaignId: "campaign-1",
      game: "Rocket League",
      campaignName: "Summer Event",
      assignedAccounts: ["a", "b"],
    },
    {
      DropSet,
      campaignItems: async () => [
        { itemKey: "reward-1", name: "Reward", game: "Rocket League", qty: 2 },
      ],
      derivePrice: () => 4.5,
      research: {},
    },
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].filter.sourceType, "autofarm_event");
  assert.equal(writes[0].filter.sourceEventKey, "autofarm:campaign-1");
  assert.equal(writes[0].update.$set.custom, false);
  assert.equal(writes[0].update.$set.catalogState, "preorder");
  assert.equal(writes[0].update.$set.expectedUnits, 2);
  assert.equal(writes[0].update.$set.farmStartedAt, undefined);
  assert.ok(writes[0].update.$setOnInsert.farmStartedAt instanceof Date);
  assert.equal(writes[0].options.upsert, true);
});

test("campaign item lookup errors are swallowed", async () => {
  let called = false;
  await assert.doesNotReject(() =>
    stampPreorderSet(
      { _id: "task-1", campaignId: "campaign-1", game: "Game" },
      {
        DropSet: {
          updateOne: () => {
            called = true;
          },
        },
        campaignItems: async () => {
          throw new Error("unavailable");
        },
        derivePrice: () => 1,
      },
    ),
  );
  assert.equal(called, false);
});

function query(rows) {
  return { lean: async () => rows };
}

test("historical marketplace event sets are mirrored without touching source rows", async () => {
  const writes = [];
  const tasks = [
    {
      _id: "task-1",
      game: "Rocket League",
      campaignId: "campaign-1",
      campaignName: "Summer Event",
      assignedAccounts: ["one", "two"],
      listing: { setId: "source-1" },
      stackListing: { setId: "" },
    },
  ];
  const source = {
    _id: "source-1",
    name: "Rocket League — Summer Event",
    note: "Marketplace source",
    custom: true,
    price: 2.5,
    items: [
      {
        itemKey: "reward|rocket league",
        name: "Reward",
        game: "Rocket League",
        qty: 1,
      },
    ],
  };
  let findCall = 0;
  const result = await syncHistoricalEventSets({
    AutoFarmTask: { find: () => query(tasks) },
    DropSet: {
      find() {
        findCall++;
        return query(findCall === 1 ? [source] : []);
      },
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
        return Promise.resolve({ upsertedCount: 1 });
      },
    },
    stockForSets: async () => new Map([["source-1", { stock: 17 }]]),
  });
  assert.equal(result.stocked, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter.sourceEventKey, "autofarm:campaign-1");
  assert.equal(writes[0].update.$set.custom, false);
  assert.equal(writes[0].update.$set.catalogState, "instock");
  assert.equal(writes[0].update.$set.expectedUnits, 2);
  assert.equal(Object.hasOwn(source, "listed"), false);
});

test("historical sync preserves a zero-stock preorder", async () => {
  const tasks = [
    {
      _id: "task-1",
      campaignId: "campaign-1",
      listing: { setId: "source-1" },
      stackListing: { setId: "" },
    },
  ];
  const source = {
    _id: "source-1",
    custom: true,
    price: 1,
    items: [{ itemKey: "reward|game" }],
  };
  const existing = {
    _id: "public-1",
    sourceEventKey: "autofarm:campaign-1",
    catalogState: "preorder",
  };
  const writes = [];
  let findCall = 0;
  await syncHistoricalEventSets({
    AutoFarmTask: { find: () => query(tasks) },
    DropSet: {
      find() {
        findCall++;
        return query(findCall === 1 ? [source] : [existing]);
      },
      updateOne(...args) {
        writes.push(args);
      },
    },
    stockForSets: async () => new Map([["source-1", { stock: 0 }]]),
  });
  assert.equal(writes.length, 0);
});

test("unreferenced auto-lister event sets receive stable source-id keys", async () => {
  const source = {
    _id: "source-orphan",
    name: "The Finals — Deep Signal",
    note: "Auto-farmed Twitch drops (DEEP SIGNAL EVENT)",
    custom: true,
    price: 1.75,
    items: [
      { itemKey: "reward|the finals", name: "Reward", game: "THE FINALS" },
    ],
  };
  const writes = [];
  let findCall = 0;
  const result = await syncHistoricalEventSets({
    AutoFarmTask: { find: () => query([]) },
    DropSet: {
      find() {
        findCall++;
        return query(findCall === 1 ? [source] : []);
      },
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
      },
    },
    stockForSets: async () => new Map([["source-orphan", { stock: 137 }]]),
  });
  assert.equal(result.stocked, 1);
  assert.equal(writes[0].filter.sourceEventKey, "autofarm:set:source-orphan");
  assert.deepEqual(writes[0].update.$set.sourceCampaignIds, []);
  assert.equal(writes[0].update.$set.autoFarmTaskId, "");
});

test("unreferenced manual custom products are not mirrored", async () => {
  const writes = [];
  let sourceFilter;
  const result = await syncHistoricalEventSets({
    AutoFarmTask: { find: () => query([]) },
    DropSet: {
      find(filter) {
        sourceFilter = filter;
        return query([]);
      },
      updateOne(...args) {
        writes.push(args);
      },
    },
    stockForSets: async () => {
      throw new Error("stock should not be read without eligible sources");
    },
  });
  assert.equal(result.candidates, 0);
  assert.equal(writes.length, 0);
  assert.equal(sourceFilter.custom, true);
  assert.equal(
    String(sourceFilter.note),
    String(/^Auto-farmed Twitch drops \(/),
  );
});

test("historical mirroring is idempotent across repeated syncs", async () => {
  const task = {
    _id: "task-1",
    campaignId: "campaign-1",
    campaignName: "Summer Event",
    listing: { setId: "source-1" },
  };
  const source = {
    _id: "source-1",
    name: "Rocket League — Summer Event",
    note: "Manual-looking note is allowed because the task owns this set",
    custom: true,
    price: 2.5,
    items: [{ itemKey: "reward|rocket league", game: "Rocket League" }],
  };
  const writes = [];
  let findCall = 0;
  const DropSet = {
    find() {
      findCall++;
      return query(findCall % 2 === 1 ? [source] : []);
    },
    updateOne(filter, update, options) {
      writes.push({ filter, update, options });
    },
  };
  const args = {
    AutoFarmTask: { find: () => query([task]) },
    DropSet,
    stockForSets: async () => new Map([["source-1", { stock: 3 }]]),
  };
  await syncHistoricalEventSets(args);
  await syncHistoricalEventSets(args);
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((row) => row.filter),
    [
      { sourceType: "autofarm_event", sourceEventKey: "autofarm:campaign-1" },
      { sourceType: "autofarm_event", sourceEventKey: "autofarm:campaign-1" },
    ],
  );
  assert.equal(
    writes.every((row) => row.options.upsert === true),
    true,
  );
});
