const test = require("node:test");
const assert = require("node:assert");

const {
  buildItems,
  buildGames,
  buildOverview,
} = require("../utils/archiveSnapshot");

// Counter rows are keyed by (itemKey, game) — the shape aggregateCounters
// returns. Account rows carry p:1 for pool accounts, p:0 for deployed ones.
function counter(k, g, over) {
  return {
    _id: { k, g },
    drops: 0,
    totalCount: 0,
    claimed: 0,
    connect: 0,
    connected: 0,
    poolDrops: 0,
    poolCount: 0,
    ...over,
  };
}

test("by-item rows carry the counters, metadata and per-account min/max", () => {
  const counters = [
    counter("cape|ow2", "Overwatch 2", {
      drops: 3,
      totalCount: 7,
      connect: 2,
      connected: 1,
    }),
  ];
  const accounts = [
    {
      _id: { k: "cape|ow2", p: 0 },
      accounts: 2,
      minPerAcct: 3,
      maxPerAcct: 4,
    },
  ];
  const meta = new Map([
    [
      "cape|ow2",
      {
        name: "Cape",
        game: "Overwatch 2",
        imageLocal: "/drop-images/a.png",
        imageURL: "https://cdn/a.png",
        campaign: "Launch",
      },
    ],
  ]);
  const [item] = buildItems(counters, accounts, meta);
  assert.equal(item.itemKey, "cape|ow2");
  assert.equal(item.name, "Cape");
  assert.equal(item.totalCount, 7);
  assert.equal(item.accounts, 2);
  assert.equal(item.connect, 2);
  assert.equal(item.connected, 1);
  assert.equal(item.minPerAcct, 3);
  assert.equal(item.maxPerAcct, 4);
  // The locally cached copy wins over the live Twitch URL, which is still
  // returned separately.
  assert.equal(item.image, "/drop-images/a.png");
  assert.equal(item.imageURL, "https://cdn/a.png");
});

test("an item held only in the pool reports null min/max, not zero", () => {
  const counters = [
    counter("skin|r6", "Rainbow Six", { poolDrops: 2, poolCount: 5 }),
  ];
  const accounts = [{ _id: { k: "skin|r6", p: 1 }, accounts: 2 }];
  const [item] = buildItems(counters, accounts, new Map());
  assert.equal(item.accounts, 0);
  assert.equal(item.poolAccounts, 2);
  assert.equal(item.poolCount, 5);
  assert.equal(item.minPerAcct, null);
  assert.equal(item.maxPerAcct, null);
});

test("items sort by account count, then total held", () => {
  const counters = [
    counter("a|g", "G", { drops: 1, totalCount: 1 }),
    counter("b|g", "G", { drops: 1, totalCount: 9 }),
    counter("c|g", "G", { drops: 1, totalCount: 5 }),
  ];
  const accounts = [
    { _id: { k: "a|g", p: 0 }, accounts: 5, minPerAcct: 1, maxPerAcct: 1 },
    { _id: { k: "b|g", p: 0 }, accounts: 2, minPerAcct: 1, maxPerAcct: 1 },
    { _id: { k: "c|g", p: 0 }, accounts: 2, minPerAcct: 1, maxPerAcct: 1 },
  ];
  const keys = buildItems(counters, accounts, new Map()).map((i) => i.itemKey);
  assert.deepEqual(keys, ["a|g", "b|g", "c|g"]);
});

test("one item key spanning two spellings of a game collapses to one row", () => {
  const counters = [
    counter("cape|ow2", "Overwatch 2", { drops: 1, totalCount: 2 }),
    counter("cape|ow2", "overwatch 2", { drops: 1, totalCount: 3 }),
  ];
  const items = buildItems(counters, [], new Map());
  assert.equal(items.length, 1);
  assert.equal(items[0].totalCount, 5);
});

test("by-game counts distinct items per game, pool separately", () => {
  const counters = [
    counter("cape|ow2", "Overwatch 2", { drops: 3, totalCount: 7 }),
    counter("spray|ow2", "Overwatch 2", { poolDrops: 1, poolCount: 1 }),
    counter("charm|r6", "Rainbow Six", { drops: 1, totalCount: 1 }),
  ];
  const items = buildItems(counters, [], new Map());
  const games = buildGames(items, [
    { _id: { g: "Overwatch 2", p: 0 }, accounts: 4 },
    { _id: { g: "Overwatch 2", p: 1 }, accounts: 1 },
    { _id: { g: "Rainbow Six", p: 0 }, accounts: 2 },
  ]);
  const ow = games.find((g) => g.game === "Overwatch 2");
  assert.equal(ow.items, 1, "the pool-only item is not a deployed item");
  assert.equal(ow.poolItems, 1);
  assert.equal(ow.accounts, 4);
  assert.equal(ow.poolAccounts, 1);
  assert.equal(ow.totalCount, 7);
  // Sorted by total held, descending.
  assert.equal(games[0].game, "Overwatch 2");
});

test("rewards with no game keep their own by-game bucket", () => {
  const items = buildItems(
    [counter("mystery|", "", { drops: 2, totalCount: 2 })],
    [],
    new Map(),
  );
  const games = buildGames(items, []);
  assert.equal(games.length, 1);
  assert.equal(games[0].game, "");
  assert.equal(games[0].drops, 2);
});

test("overview totals ignore pool rows and blank game names", () => {
  const counters = [
    counter("cape|ow2", "Overwatch 2", { drops: 3, totalCount: 7 }),
    counter("mystery|", "", { drops: 1, totalCount: 1 }),
    counter("spray|r6", "Rainbow Six", { poolDrops: 2, poolCount: 4 }),
  ];
  const items = buildItems(counters, [], new Map());
  const overview = buildOverview(items, 3840);
  assert.equal(overview.accounts, 3840);
  assert.equal(overview.totalDrops, 4);
  assert.equal(overview.totalItemsHeld, 8);
  assert.equal(overview.items, 2, "the pool-only item is not held");
  assert.equal(overview.games, 1, "the blank game is not a game");
  assert.equal(overview.poolDrops, 2);
  assert.equal(overview.poolItems, 1);
});
