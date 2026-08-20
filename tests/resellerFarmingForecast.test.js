const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateForecast } = require("../utils/resellerFarmingForecast");

function account(id, login, progress, extra = {}) {
  return {
    _id: id,
    clientSecret: "secret-" + id,
    login,
    farmingProgress: progress,
    farmingSnapshotAt: new Date(),
    ...extra,
  };
}

function progress(name, game, percent, extra = {}) {
  return {
    name,
    game,
    campaign: "Current campaign",
    current: percent,
    required: 100,
    percent,
    connected: false,
    scannedAt: new Date(),
    ...extra,
  };
}

function runtime(entries, available = true) {
  return {
    available,
    checkedAt: new Date(),
    configsSeen: 2,
    index: new Map(
      entries.map(([token, games, wildcard = false]) => [
        token,
        { active: true, games: new Set(games.map((g) => g.toLowerCase())), wildcard },
      ]),
    ),
  };
}

test("ranks high-progress items first and counts duplicate rewards once per account", () => {
  const forecast = aggregateForecast({
    accounts: [
      account("a", "one", [progress("Rare Skin", "Valorant", 92), progress("Rare Skin", "Valorant", 92)]),
      account("b", "two", [progress("Rare Skin", "Valorant", 82), progress("Spray", "Valorant", 45)]),
    ],
    runtime: runtime([
      ["secret-a", ["valorant"]],
      ["secret-b", ["valorant"]],
    ]),
    available: [{ name: "Rare Skin", game: "Valorant", accounts: 3, units: 4 }],
  });

  assert.equal(forecast.items[0].name, "Rare Skin");
  assert.equal(forecast.items[0].farmingAccounts, 2);
  assert.equal(forecast.items[0].averagePercent, 87);
  assert.equal(forecast.items[0].availableNow.accounts, 3);
  assert.equal(forecast.games[0].availableNow, 3);
  assert.equal(forecast.summary.availableNow, 3);
  assert.equal(forecast.summary.readySoon, 1);
});

test("only counts games the running bot is configured to farm", () => {
  const forecast = aggregateForecast({
    accounts: [
      account("a", "one", [progress("Wrong Game Item", "Wrong Game", 99), progress("Right Item", "Right Game", 60)]),
    ],
    runtime: runtime([["secret-a", ["right game"]]]),
  });

  assert.deepEqual(forecast.items.map((item) => item.name), ["Right Item"]);
  assert.equal(forecast.games[0].game, "Right Game");
});

test("does not count connected progress and marks stale evidence low confidence", () => {
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const forecast = aggregateForecast({
    accounts: [
      account("a", "one", [
        progress("Already redeemed", "Valorant", 100, { connected: true, scannedAt: stale }),
        progress("Stale item", "Valorant", 80, { scannedAt: stale }),
      ], { farmingSnapshotAt: stale }),
    ],
    runtime: runtime([["secret-a", ["valorant"]]]),
  });

  assert.deepEqual(forecast.items.map((item) => item.name), ["Stale item"]);
  assert.equal(forecast.items[0].confidence, "low");
  assert.equal(forecast.freshness.stale, true);
});

test("uses estimated auto-task evidence only when fleet runtime is unavailable", () => {
  const forecast = aggregateForecast({
    accounts: [account("a", "one", [progress("Estimated Item", "Valorant", 70)])],
    runtime: runtime([], false),
    fallback: new Map([["one", { active: false, games: new Set(["valorant"]), wildcard: false }]]),
  });

  assert.equal(forecast.items[0].confidence, "estimated");
  assert.equal(forecast.summary.estimatedAccounts, 1);
});

test("does not fabricate a forecast for an account absent from active runtime", () => {
  const forecast = aggregateForecast({
    accounts: [account("a", "one", [progress("Hidden Item", "Valorant", 95)])],
    runtime: runtime([]),
  });

  assert.equal(forecast.items.length, 0);
  assert.equal(forecast.summary.activeAccounts, 0);
});

test("keeps a game-level farming signal while item snapshots warm up", () => {
  const forecast = aggregateForecast({
    accounts: [
      account("a", "one", [], { inProgressGames: ["Valorant"] }),
    ],
    runtime: runtime([["secret-a", ["valorant"]]]),
    available: [{ name: "Ready reward", game: "Valorant", accounts: 2, units: 3 }],
  });

  assert.equal(forecast.items.length, 0);
  assert.equal(forecast.games[0].game, "Valorant");
  assert.equal(forecast.games[0].farmingAccounts, 1);
  assert.equal(forecast.games[0].itemSnapshotReady, false);
  assert.equal(forecast.games[0].availableNow, 2);
  assert.equal(forecast.summary.availableNow, 2);
});

test("uses exact unique available-account rollups when supplied", () => {
  const forecast = aggregateForecast({
    accounts: [account("a", "one", [], { inProgressGames: ["Valorant"] })],
    runtime: runtime([["secret-a", ["valorant"]]]),
    available: {
      accounts: 7,
      games: [{ game: "Valorant", accounts: 4 }],
      items: [
        { name: "Skin", game: "Valorant", accounts: 4, units: 20 },
        { name: "Spray", game: "Valorant", accounts: 3, units: 30 },
      ],
    },
  });

  assert.equal(forecast.summary.availableNow, 7);
  assert.equal(forecast.games[0].availableNow, 4);
});

test("game confidence keeps the least trustworthy account evidence", () => {
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const forecast = aggregateForecast({
    accounts: [
      account("fresh", "fresh", [progress("Fresh item", "Valorant", 80)]),
      account("stale", "stale", [progress("Stale item", "Valorant", 80, { scannedAt: stale })], {
        farmingSnapshotAt: stale,
      }),
    ],
    runtime: runtime([
      ["secret-fresh", ["valorant"]],
      ["secret-stale", ["valorant"]],
    ]),
  });

  assert.equal(forecast.games[0].confidence, "low");
});
