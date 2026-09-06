const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stampPreorderSet,
  syncActivePreorders,
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

test("active tasks missing a mirror are backfilled as preorders", async () => {
  const writes = [];
  const task = {
    _id: "task-1",
    game: "Sea of Thieves",
    campaignId: "campaign-1",
    campaignName: "Season 20 Drops 3",
    assignedAccounts: ["one", "two"],
  };
  const result = await syncActivePreorders({
    AutoFarmTask: { find: () => query([task]) },
    DropSet: {
      find: () => query([]),
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
      },
    },
    campaignItems: async () => [
      { itemKey: "reward-1", name: "Reward", game: "Sea of Thieves", qty: 1 },
    ],
    derivePrice: () => 2.5,
    researchForGame: async () => ({}),
  });
  assert.equal(result.stamped, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter.sourceEventKey, "autofarm:campaign-1");
  assert.equal(writes[0].update.$set.catalogState, "preorder");
  assert.equal(writes[0].update.$set.expectedUnits, 2);
  assert.equal(writes[0].options.upsert, true);
});

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

// ---------------------------------------------------------------------------
// Catalog v2 additions (docs/CATALOG-V2-CONTRACT.md §4): duplicate-signature
// folding in the historical sync, the shared in-flight preorder run, and the
// requiredWatchMinutes stamp + backfill.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

// Chainable fake query: limit()/sort()/select()/lean() return the query and
// both `await q` and q.exec() resolve the rows. limit(n) really truncates, so
// a fillLimit is observable whichever way the implementation applies it.
function chain(rows) {
  let out = Array.isArray(rows) ? rows.slice() : rows;
  const q = {
    limit(n) {
      const size = Number(n);
      if (Array.isArray(out) && Number.isFinite(size) && size >= 0) {
        out = out.slice(0, size);
      }
      return q;
    },
    sort: () => q,
    select: () => q,
    lean: () => q,
    exec: () => Promise.resolve(out),
    then: (resolve, reject) => Promise.resolve(out).then(resolve, reject),
  };
  return q;
}

async function runHistoricalSync({
  tasks = [],
  sources = [],
  mirrors = [],
  stocks = {},
  apply = true,
} = {}) {
  const writes = [];
  const result = await syncHistoricalEventSets({
    AutoFarmTask: { find: () => chain(tasks) },
    DropSet: {
      find(filter) {
        // The mirror lookup is keyed by sourceEventKey; anything else is the
        // source scan (task-referenced sets + auto-farmed custom products).
        return chain(filter && filter.sourceEventKey ? mirrors : sources);
      },
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
        return Promise.resolve({ upsertedCount: 1 });
      },
    },
    stockForSets: async (sets) =>
      new Map(
        sets.map((set) => [
          String(set._id),
          { stock: stocks[String(set._id)] || 0 },
        ]),
      ),
    apply,
  });
  return { result, writes };
}

function upsertKeys(writes) {
  return writes
    .filter((row) => row.options && row.options.upsert === true)
    .map((row) => row.filter.sourceEventKey);
}

function retirements(writes) {
  return writes
    .filter((row) => row.filter && row.filter._id != null)
    .map((row) => [String(row.filter._id), row.update.$set])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const AUTO_FARMED_NOTE = "Auto-farmed Twitch drops (SUMMER EVENT)";

function rocketLeagueItems(game = "Rocket League") {
  return [
    { itemKey: "skin|rocket league", name: "Skin", game, qty: 1 },
    { itemKey: "emote|rocket league", name: "Emote", game, qty: 2 },
  ];
}

test("historical sync folds duplicate-signature candidates: publishes one, retires the listed mirrors of the rest, reports deduped", async () => {
  const tasks = [
    {
      _id: "task-1",
      game: "Rocket League",
      campaignId: "campaign-1",
      campaignName: "Summer Event",
      assignedAccounts: ["one", "two"],
      status: "completed",
      listing: { setId: "source-event" },
      stackListing: { setId: "" },
    },
  ];
  const sources = [
    {
      _id: "source-event",
      name: "Rocket League — Summer Event",
      note: "Marketplace source",
      custom: true,
      price: 2.5,
      items: rocketLeagueItems("Rocket League"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      // Same signature: reversed item order, string qty, lowercased game.
      _id: "source-orphan-a",
      name: "Rocket League — Summer Event",
      note: AUTO_FARMED_NOTE,
      custom: true,
      price: 2.5,
      items: [
        {
          itemKey: "emote|rocket league",
          name: "Emote",
          game: "rocket league",
          qty: "2",
        },
        {
          itemKey: "skin|rocket league",
          name: "Skin",
          game: "rocket league",
          qty: 1,
        },
      ],
      updatedAt: new Date("2026-09-05T00:00:00.000Z"),
    },
    {
      // Same signature: a keyless item is ignored by the signature.
      _id: "source-orphan-b",
      name: "Rocket League — Summer Event",
      note: AUTO_FARMED_NOTE,
      custom: true,
      price: 2.5,
      items: [
        ...rocketLeagueItems("ROCKET LEAGUE"),
        { name: "Bonus", game: "ROCKET LEAGUE" },
      ],
      updatedAt: new Date("2026-09-03T00:00:00.000Z"),
    },
  ];
  const mirrors = [
    {
      _id: "mirror-a",
      sourceType: "autofarm_event",
      sourceEventKey: "autofarm:set:source-orphan-a",
      catalogState: "instock",
      listed: true,
    },
    {
      _id: "mirror-b",
      sourceType: "autofarm_event",
      sourceEventKey: "autofarm:set:source-orphan-b",
      catalogState: "instock",
      listed: true,
    },
  ];
  const { result, writes } = await runHistoricalSync({
    tasks,
    sources,
    mirrors,
    // The event mirror wins by kind rank even though an orphan holds more stock.
    stocks: { "source-event": 5, "source-orphan-a": 140, "source-orphan-b": 9 },
  });
  assert.equal(result.deduped, 2);
  assert.equal(result.published, 1);
  assert.deepEqual(upsertKeys(writes), ["autofarm:campaign-1"]);
  const published = writes.find((row) => row.options && row.options.upsert);
  assert.equal(published.update.$set.listed, true);
  assert.equal(published.update.$set.catalogState, "instock");
  assert.equal(published.update.$set.expectedUnits, 2);
  assert.deepEqual(retirements(writes), [
    ["mirror-a", { listed: false }],
    ["mirror-b", { listed: false }],
  ]);
  assert.equal(writes.length, 3);
  assert.equal(
    sources.every((source) => !Object.hasOwn(source, "listed")),
    true,
  );
});

test("historical fold ranks stack over orphan, then higher stock, then the newer source", async () => {
  // (a) A task-owned stack set beats a richer auto-farmed orphan.
  let run = await runHistoricalSync({
    tasks: [
      {
        _id: "task-9",
        game: "Rocket League",
        campaignId: "campaign-9",
        campaignName: "Stacked Event",
        assignedAccounts: [],
        status: "completed",
        listing: { setId: "" },
        stackListing: { setId: "source-stack" },
      },
    ],
    sources: [
      {
        _id: "source-stack",
        name: "Rocket League — stack",
        note: "Stack source",
        custom: true,
        price: 3,
        items: rocketLeagueItems(),
      },
      {
        _id: "source-orphan-rich",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
    ],
    mirrors: [
      {
        _id: "mirror-rich",
        sourceEventKey: "autofarm:set:source-orphan-rich",
        listed: true,
      },
    ],
    stocks: { "source-stack": 2, "source-orphan-rich": 99 },
  });
  assert.equal(run.result.deduped, 1);
  assert.equal(run.result.published, 1);
  assert.deepEqual(upsertKeys(run.writes), ["autofarm-stack:task-9"]);
  assert.deepEqual(retirements(run.writes), [
    ["mirror-rich", { listed: false }],
  ]);

  // (b) Among orphans the higher stock survives.
  run = await runHistoricalSync({
    sources: [
      {
        _id: "source-orphan-small",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
        updatedAt: new Date("2026-09-06T00:00:00.000Z"),
      },
      {
        _id: "source-orphan-big",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ],
    mirrors: [
      {
        _id: "mirror-small",
        sourceEventKey: "autofarm:set:source-orphan-small",
        listed: true,
      },
      {
        _id: "mirror-big",
        sourceEventKey: "autofarm:set:source-orphan-big",
        listed: true,
      },
    ],
    stocks: { "source-orphan-small": 3, "source-orphan-big": 9 },
  });
  assert.equal(run.result.deduped, 1);
  assert.deepEqual(upsertKeys(run.writes), ["autofarm:set:source-orphan-big"]);
  assert.deepEqual(retirements(run.writes), [
    ["mirror-small", { listed: false }],
  ]);

  // (c) Equal rank and stock: the newer source wins.
  run = await runHistoricalSync({
    sources: [
      {
        _id: "source-orphan-old",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
      {
        _id: "source-orphan-new",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
        updatedAt: new Date("2026-09-05T00:00:00.000Z"),
      },
    ],
    mirrors: [
      {
        _id: "mirror-old",
        sourceEventKey: "autofarm:set:source-orphan-old",
        listed: true,
      },
      {
        _id: "mirror-new",
        sourceEventKey: "autofarm:set:source-orphan-new",
        listed: true,
      },
    ],
    stocks: { "source-orphan-old": 5, "source-orphan-new": 5 },
  });
  assert.equal(run.result.deduped, 1);
  assert.deepEqual(upsertKeys(run.writes), ["autofarm:set:source-orphan-new"]);
  assert.deepEqual(retirements(run.writes), [
    ["mirror-old", { listed: false }],
  ]);
});

test("historical fold is scoped by the first item's game", async () => {
  // Identical signature under a different first-item game: two separate groups.
  const run = await runHistoricalSync({
    sources: [
      {
        _id: "source-rl",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems("Rocket League"),
      },
      {
        _id: "source-wf",
        name: "Warframe — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems("Warframe"),
      },
    ],
    stocks: { "source-rl": 4, "source-wf": 4 },
  });
  assert.equal(run.result.deduped, 0);
  assert.equal(run.result.published, 2);
  assert.deepEqual(upsertKeys(run.writes).sort(), [
    "autofarm:set:source-rl",
    "autofarm:set:source-wf",
  ]);
  assert.deepEqual(retirements(run.writes), []);
});

test("historical fold never publishes a folded candidate and counts only retired mirrors as deduped", async () => {
  // A folded candidate without a listed mirror gets no write at all — and is
  // still never published, whatever its stock.
  const run = await runHistoricalSync({
    sources: [
      {
        _id: "source-keep",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
      {
        _id: "source-drop-unlisted",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
      {
        _id: "source-drop-unmirrored",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
    ],
    mirrors: [
      {
        _id: "mirror-unlisted",
        sourceEventKey: "autofarm:set:source-drop-unlisted",
        listed: false,
      },
    ],
    stocks: {
      "source-keep": 30,
      "source-drop-unlisted": 20,
      "source-drop-unmirrored": 10,
    },
  });
  assert.equal(run.result.published, 1);
  assert.deepEqual(upsertKeys(run.writes), ["autofarm:set:source-keep"]);
  assert.deepEqual(retirements(run.writes), []);
  assert.equal(run.writes.length, 1);
  // deduped counts the listed mirrors actually retired (§4), so none here.
  assert.equal(run.result.deduped, 0);
});

test("historical fold dry run reports deduped without writing", async () => {
  const { result, writes } = await runHistoricalSync({
    apply: false,
    sources: [
      {
        _id: "source-a",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
      {
        _id: "source-b",
        name: "Rocket League — Summer Event",
        note: AUTO_FARMED_NOTE,
        custom: true,
        price: 2.5,
        items: rocketLeagueItems(),
      },
    ],
    mirrors: [
      {
        _id: "mirror-a",
        sourceEventKey: "autofarm:set:source-a",
        listed: true,
      },
      {
        _id: "mirror-b",
        sourceEventKey: "autofarm:set:source-b",
        listed: true,
      },
    ],
    stocks: { "source-a": 8, "source-b": 2 },
  });
  assert.equal(result.deduped, 1);
  assert.equal(writes.length, 0);
});

test("stampPreorderSet records the campaign's top-tier watch minutes", async () => {
  const writes = [];
  const DropSet = {
    updateOne(filter, update, options) {
      writes.push({ filter, update, options });
      return Promise.resolve({ upsertedCount: 1 });
    },
  };
  const task = {
    _id: "task-1",
    campaignId: "campaign-1",
    game: "Rocket League",
    campaignName: "Summer Event",
    assignedAccounts: ["a"],
  };
  await stampPreorderSet(task, {
    DropSet,
    campaignItems: async () => [
      {
        itemKey: "r1",
        name: "Tier 1",
        game: "Rocket League",
        requiredMinutes: 15,
      },
      {
        itemKey: "r2",
        name: "Tier 2",
        game: "Rocket League",
        requiredMinutes: 120,
      },
      {
        itemKey: "r3",
        name: "Tier 3",
        game: "Rocket League",
        requiredMinutes: 45,
      },
    ],
    derivePrice: () => 1,
    research: {},
  });
  await stampPreorderSet(task, {
    DropSet,
    campaignItems: async () => [
      { itemKey: "r1", name: "Tier 1", game: "Rocket League" },
    ],
    derivePrice: () => 1,
    research: {},
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].update.$set.requiredWatchMinutes, 120);
  assert.equal(writes[1].update.$set.requiredWatchMinutes, 0);
});

test("concurrent syncActivePreorders calls share one run and stamp requiredWatchMinutes", async () => {
  let taskFinds = 0;
  let itemLookups = 0;
  const writes = [];
  const task = {
    _id: "task-1",
    game: "Sea of Thieves",
    campaignId: "campaign-1",
    campaignName: "Season 20 Drops 3",
    assignedAccounts: ["one", "two"],
  };
  const opts = {
    AutoFarmTask: {
      find() {
        taskFinds++;
        return chain([task]);
      },
    },
    DropSet: {
      find: () => chain([]),
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
        return Promise.resolve({ upsertedCount: 1 });
      },
    },
    campaignItems: async () => {
      itemLookups++;
      return [
        {
          itemKey: "reward-1",
          name: "Tier 1",
          game: "Sea of Thieves",
          qty: 1,
          requiredMinutes: 60,
        },
        {
          itemKey: "reward-2",
          name: "Tier 2",
          game: "Sea of Thieves",
          qty: 1,
          requiredMinutes: 240,
        },
        {
          itemKey: "reward-3",
          name: "No minutes",
          game: "Sea of Thieves",
          qty: 1,
        },
      ];
    },
    derivePrice: () => 2.5,
    researchForGame: async () => ({}),
  };
  const first = syncActivePreorders(opts);
  const second = syncActivePreorders(opts);
  assert.equal(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(taskFinds, 1);
  assert.equal(itemLookups, 1);
  assert.equal(a.candidates, 1);
  assert.equal(a.stamped, 1);
  const stamps = writes.filter((row) => row.options && row.options.upsert);
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].filter.sourceEventKey, "autofarm:campaign-1");
  assert.equal(stamps[0].update.$set.catalogState, "preorder");
  assert.equal(stamps[0].update.$set.expectedUnits, 2);
  assert.equal(stamps[0].update.$set.requiredWatchMinutes, 240);
  assert.equal(writes.length, 1);
  // Once the shared run settles, the next call starts a fresh one.
  const third = syncActivePreorders(opts);
  assert.notEqual(third, first);
  await third;
  assert.equal(taskFinds, 2);
});

test("preorder sync backfills requiredWatchMinutes for recent preorders and marks unknown campaigns -1", async () => {
  const now = new Date("2026-09-07T00:00:00.000Z");
  const finds = [];
  const writes = [];
  const lookups = [];
  const fillRows = [
    {
      _id: "public-2",
      sourceEventKey: "autofarm:campaign-2",
      sourceEventName: "Older Event",
      items: [{ itemKey: "reward|sea of thieves", game: "Sea of Thieves" }],
      farmStartedAt: new Date(now.getTime() - 2 * DAY_MS),
    },
    {
      _id: "public-3",
      sourceEventKey: "autofarm:campaign-3",
      sourceEventName: "Unknown Event",
      items: [],
      farmStartedAt: new Date(now.getTime() - DAY_MS),
    },
    {
      _id: "public-4",
      sourceEventKey: "autofarm:campaign-4",
      sourceEventName: "Beyond the fill limit",
      items: [{ itemKey: "x", game: "Sea of Thieves" }],
      farmStartedAt: now,
    },
  ];
  const result = await syncActivePreorders({
    AutoFarmTask: { find: () => chain([]) },
    DropSet: {
      find(filter) {
        finds.push(filter);
        return chain(
          filter && filter.catalogState === "preorder" ? fillRows : [],
        );
      },
      updateOne(filter, update, options) {
        writes.push({ filter, update, options });
        return Promise.resolve({ modifiedCount: 1 });
      },
    },
    campaignItems: async (campaignId, game, name) => {
      lookups.push([campaignId, game, name]);
      if (campaignId === "campaign-2") {
        return [
          { itemKey: "a", requiredMinutes: 30 },
          { itemKey: "b", requiredMinutes: 90 },
          { itemKey: "c" },
        ];
      }
      if (campaignId === "campaign-3") throw new Error("unavailable");
      return [{ itemKey: "d", requiredMinutes: 999 }];
    },
    derivePrice: () => 1,
    researchForGame: async () => ({}),
    now,
    fillLimit: 2,
  });
  assert.deepEqual(result, { candidates: 0, stamped: 0, filled: 2 });
  const fillFilter = finds.find(
    (filter) => filter && filter.catalogState === "preorder",
  );
  assert.ok(fillFilter, "requiredWatchMinutes fill query was issued");
  assert.equal(fillFilter.sourceType, "autofarm_event");
  assert.equal(fillFilter.listed, true);
  assert.equal(String(fillFilter.sourceEventKey), String(/^autofarm:(?!set:)/));
  assert.equal(
    new Date(fillFilter.farmStartedAt.$gte).getTime(),
    now.getTime() - 14 * DAY_MS,
  );
  assert.deepEqual(fillFilter.$or, [
    { requiredWatchMinutes: { $exists: false } },
    { requiredWatchMinutes: 0 },
  ]);
  assert.deepEqual(lookups, [
    ["campaign-2", "Sea of Thieves", "Older Event"],
    ["campaign-3", "", "Unknown Event"],
  ]);
  assert.deepEqual(
    writes.map((row) => [
      String(row.filter._id),
      row.update.$set.requiredWatchMinutes,
    ]),
    [
      ["public-2", 90],
      ["public-3", -1],
    ],
  );
  assert.equal(
    writes.every((row) => !row.options || !row.options.upsert),
    true,
  );
});

test("preorder sync skips the requiredWatchMinutes backfill when disabled or dry-running", async () => {
  for (const extra of [{ fillRequiredMinutes: false }, { apply: false }]) {
    const label = JSON.stringify(extra);
    const finds = [];
    const writes = [];
    const result = await syncActivePreorders({
      AutoFarmTask: { find: () => chain([]) },
      DropSet: {
        find(filter) {
          finds.push(filter);
          return chain(
            filter && filter.catalogState === "preorder"
              ? [
                  {
                    _id: "public-9",
                    sourceEventKey: "autofarm:campaign-9",
                    items: [],
                  },
                ]
              : [],
          );
        },
        updateOne(...args) {
          writes.push(args);
        },
      },
      campaignItems: async () => [{ itemKey: "a", requiredMinutes: 120 }],
      derivePrice: () => 1,
      researchForGame: async () => ({}),
      ...extra,
    });
    assert.equal(result.filled, 0, label);
    assert.equal(writes.length, 0, label);
    assert.equal(
      finds.some((filter) => filter && filter.catalogState === "preorder"),
      false,
      label,
    );
  }
});
