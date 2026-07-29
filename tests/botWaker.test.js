// Pure-function coverage for the wake/park helpers: container->config mapping
// and the "what does this bot farm" resolution that decides whether a live
// campaign is relevant to a stopped container. No docker, no Mongo.
const test = require("node:test");
const assert = require("node:assert");

const { fileForContainer, gamesOf, wakeTrigger } = require("../utils/botWaker");

const PARKED = "2026-07-28T14:00:00.000Z";
const games = new Set(["delta force", "fortnite"]);

test("a campaign that began after we parked the bot wakes it", () => {
  const t = wakeTrigger(games, PARKED, [
    { game: "Delta Force", name: "New Season", startAt: "2026-07-29T09:00:00.000Z" },
  ]);
  assert.ok(t);
  assert.strictEqual(t.name, "New Season");
});

test("a campaign that was already running when we parked does NOT wake it", () => {
  // This is the whole point of parking: those drops are already farmed.
  const t = wakeTrigger(games, PARKED, [
    { game: "Delta Force", name: "Old Season", startAt: "2026-07-26T09:00:00.000Z" },
  ]);
  assert.strictEqual(t, null);
});

test("a new campaign for a game the bot does not farm is ignored", () => {
  const t = wakeTrigger(games, PARKED, [
    { game: "Sea of Thieves", name: "Not Ours", startAt: "2026-07-29T09:00:00.000Z" },
  ]);
  assert.strictEqual(t, null);
});

test("game matching is case and whitespace insensitive", () => {
  const t = wakeTrigger(games, PARKED, [
    { game: "  DELTA force ", name: "Casing", startAt: "2026-07-29T09:00:00.000Z" },
  ]);
  assert.ok(t);
});

test("a live campaign with no startAt wakes rather than being assumed old", () => {
  // Missing timing on a game we farm must fail towards waking: a needless wake
  // costs RAM, a missed one costs drops that are never farmed.
  const t = wakeTrigger(games, PARKED, [
    { game: "Fortnite", name: "Undated", startAt: null },
  ]);
  assert.ok(t);
});

test("no campaigns, or none matching, yields no wake", () => {
  assert.strictEqual(wakeTrigger(games, PARKED, []), null);
  assert.strictEqual(wakeTrigger(games, PARKED, undefined), null);
  assert.strictEqual(wakeTrigger(new Set(), PARKED, [
    { game: "Delta Force", startAt: "2026-07-29T09:00:00.000Z" },
  ]), null);
});

test("container name maps back to its config file", () => {
  assert.strictEqual(fileForContainer("twitchbot"), "config.json");
  assert.strictEqual(fileForContainer("twitchbotx2"), "config_02.json");
  assert.strictEqual(fileForContainer("twitchbotx18"), "config_18.json");
  assert.strictEqual(fileForContainer("twitchbotx104"), "config_104.json");
});

test("names that are not managed bots are refused", () => {
  assert.strictEqual(fileForContainer("mongo"), null);
  assert.strictEqual(fileForContainer("twitchbotx"), null);
  assert.strictEqual(fileForContainer(""), null);
  assert.strictEqual(fileForContainer(null), null);
});

test("an empty per-account list inherits the config-level games", () => {
  const games = gamesOf({
    FavouriteGames: ["Delta Force"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: true, FavouriteGames: [] },
        { ClientSecret: "b", Enabled: true },
      ],
    },
  });
  assert.deepStrictEqual([...games], ["delta force"]);
});

test("per-account games win over the config-level list, and all are unioned", () => {
  const games = gamesOf({
    FavouriteGames: ["Fortnite"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: true, FavouriteGames: ["Rust"] },
        { ClientSecret: "b", Enabled: true, FavouriteGames: ["The Quinfall"] },
        { ClientSecret: "c", Enabled: true, FavouriteGames: [] }, // inherits
      ],
    },
  });
  assert.deepStrictEqual([...games].sort(), ["fortnite", "rust", "the quinfall"]);
});

test("disabled accounts contribute nothing — a retired account must not wake a bot", () => {
  const games = gamesOf({
    FavouriteGames: ["Fortnite"],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: false, FavouriteGames: ["Rust"] },
        { ClientSecret: "b", Enabled: false },
      ],
    },
  });
  assert.strictEqual(games.size, 0);
});

test("games are normalised so campaign matching is case/space insensitive", () => {
  const games = gamesOf({
    FavouriteGames: [],
    TwitchSettings: {
      TwitchUsers: [
        { ClientSecret: "a", Enabled: true, FavouriteGames: ["  Sea Of THIEVES  "] },
      ],
    },
  });
  assert.ok(games.has("sea of thieves"));
});

test("a config with no users yields no games rather than throwing", () => {
  assert.strictEqual(gamesOf({}).size, 0);
  assert.strictEqual(gamesOf({ TwitchSettings: {} }).size, 0);
});

// ---- the park guard ----
//
// stopFinishedBots runs the SAME wakeTrigger test before parking, against the
// oldest scan the "finished" verdict rests on. Without it a bot can be parked
// into a hole it never climbs out of: the verdict says finished, a campaign for
// one of its games is already live, and wakeTrigger will not fire for a campaign
// that started before the park — so those drops are never farmed at all.
const SCANNED = "2026-07-29T06:00:00.000Z";

test("a campaign newer than the scan blocks the park", () => {
  const blocked = wakeTrigger(games, SCANNED, [
    { game: "Delta Force", name: "Started after we last looked", startAt: "2026-07-29T08:00:00.000Z" },
  ]);
  assert.ok(blocked, "the verdict predates this campaign — do not park");
});

test("a campaign older than the scan does not block the park", () => {
  // The scan already saw whatever this campaign gave the accounts, and it
  // reported them finished. Parking is safe.
  const blocked = wakeTrigger(games, SCANNED, [
    { game: "Delta Force", name: "Already counted", startAt: "2026-07-28T08:00:00.000Z" },
  ]);
  assert.strictEqual(blocked, null);
});

test("a campaign for someone else's game never blocks the park", () => {
  const blocked = wakeTrigger(games, SCANNED, [
    { game: "Overwatch", name: "Not ours", startAt: "2026-07-29T08:00:00.000Z" },
  ]);
  assert.strictEqual(blocked, null);
});

test("no scan evidence at all blocks the park", () => {
  // oldestScanAt is null when nothing was scanned, which wakeTrigger reads as
  // epoch 0 — every live campaign then looks newer, so nothing gets parked.
  const blocked = wakeTrigger(games, null, [
    { game: "Fortnite", name: "Any", startAt: "2020-01-01T00:00:00.000Z" },
  ]);
  assert.ok(blocked);
});
