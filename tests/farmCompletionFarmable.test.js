// Verify-earned must only demand drops a bot can actually earn. With
// `farmableGames` supplied, an assigned game with no farmable campaign (none at
// all, or only a subscription-only one) is not required — before this, bots
// holding such a game stayed "not started" forever and were never parked.
const test = require("node:test");
const assert = require("node:assert");

const { classifyBotCompletion } = require("../utils/farmCompletion");

const NOW = Date.parse("2026-09-29T10:00:00Z");
const fresh = new Date(NOW - 60 * 60 * 1000);

function cfg(games) {
  return {
    FavouriteGames: games,
    TwitchSettings: {
      OnlyFavouriteGames: true,
      TwitchUsers: [{ ClientSecret: "s1", Login: "acc1", Enabled: true, FavouriteGames: [] }],
    },
  };
}
const row = {
  clientSecret: "s1",
  login: "acc1",
  inProgressCount: 0,
  inProgressGames: [],
  dropCount: 3,
  lastScanAt: fresh,
  lastScanStatus: "ok",
};
const held = (games) =>
  new Map([["acc1", { games: new Set(games), benefitIds: new Set(), itemKeys: new Set() }]]);

test("without farmableGames every assigned game is still required (unchanged)", () => {
  const v = classifyBotCompletion(cfg(["delta force", "rocket league"]), [row], {
    now: NOW,
    requireEarned: true,
    heldByLogin: held(["rocket league"]),
  });
  assert.strictEqual(v.notStarted, 1);
  assert.strictEqual(v.stoppable, false);
});

test("a game with nothing farmable is not required -> finished and stoppable", () => {
  // x20 on Contabo: Delta Force (no campaign) + Rocket League (sub-only campaign).
  const v = classifyBotCompletion(cfg(["delta force", "rocket league"]), [row], {
    now: NOW,
    requireEarned: true,
    heldByLogin: held([]),
    expectedByGame: new Map(),
    farmableGames: new Set(),
  });
  assert.strictEqual(v.finished, 1);
  assert.strictEqual(v.stoppable, true);
});

test("a farmable game the account never earned keeps it not-started", () => {
  const v = classifyBotCompletion(cfg(["warframe", "rocket league"]), [row], {
    now: NOW,
    requireEarned: true,
    heldByLogin: held([]),
    expectedByGame: new Map(),
    farmableGames: new Set(["warframe"]),
  });
  assert.strictEqual(v.notStarted, 1);
  assert.strictEqual(v.stoppable, false);
});

test("expected drops of a farmable campaign are still enforced", () => {
  const v = classifyBotCompletion(cfg(["brawlhalla"]), [row], {
    now: NOW,
    requireEarned: true,
    heldByLogin: held(["brawlhalla"]),
    expectedByGame: new Map([["brawlhalla", [{ benefitId: "b1", itemKey: "" }]]]),
    farmableGames: new Set(["brawlhalla"]),
  });
  assert.strictEqual(v.notStarted, 1);
});

test("in-progress work on an assigned game still means working", () => {
  const busy = { ...row, inProgressCount: 1, inProgressGames: ["warframe"] };
  const v = classifyBotCompletion(cfg(["warframe"]), [busy], {
    now: NOW,
    requireEarned: true,
    heldByLogin: held([]),
    farmableGames: new Set(),
  });
  assert.strictEqual(v.working, 1);
  assert.strictEqual(v.stoppable, false);
});
