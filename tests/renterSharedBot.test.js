// Shared renter bots: several renters can live on one config file (one
// container = less RAM), so every config write must be scoped to ONE renter's
// accounts. These cover the pure config transforms that scoping rests on.
const test = require("node:test");
const assert = require("node:assert");
const {
  removeUsersBySecret,
  addUsersDedupe,
  setUsersGamesBySecret,
} = require("../utils/renterBotOps");

function cfg(users) {
  return { TwitchSettings: { TwitchUsers: users } };
}
function u(secret, games) {
  return { ClientSecret: secret, Login: secret + "-login", FavouriteGames: games || [] };
}

test("removing one renter's accounts leaves the other renter's untouched", () => {
  const data = cfg([u("a1"), u("a2"), u("b1")]);
  const removed = removeUsersBySecret(data, ["a1", "a2"]);
  assert.equal(removed, 2);
  assert.deepEqual(
    data.TwitchSettings.TwitchUsers.map((x) => x.ClientSecret),
    ["b1"],
  );
});

test("removing with no matches is a no-op", () => {
  const data = cfg([u("b1")]);
  assert.equal(removeUsersBySecret(data, ["a1"]), 0);
  assert.equal(data.TwitchSettings.TwitchUsers.length, 1);
});

test("re-adding accounts never duplicates one already in the config", () => {
  const data = cfg([u("a1"), u("b1")]);
  const added = addUsersDedupe(data, [u("a1"), u("a2")]);
  assert.equal(added, 1);
  assert.deepEqual(
    data.TwitchSettings.TwitchUsers.map((x) => x.ClientSecret),
    ["a1", "b1", "a2"],
  );
});

test("adding to a config with no TwitchUsers section creates it", () => {
  const data = {};
  assert.equal(addUsersDedupe(data, [u("a1")]), 1);
  assert.equal(data.TwitchSettings.TwitchUsers.length, 1);
});

test("a games change is armed on the renter's accounts only", () => {
  const data = cfg([u("a1", ["Old"]), u("b1", ["Rust"])]);
  const updated = setUsersGamesBySecret(data, ["a1"], ["VALORANT"]);
  assert.equal(updated, 1);
  assert.deepEqual(data.TwitchSettings.TwitchUsers[0].FavouriteGames, ["VALORANT"]);
  // The other renter's games are never overwritten.
  assert.deepEqual(data.TwitchSettings.TwitchUsers[1].FavouriteGames, ["Rust"]);
  // Favourites are honoured once a list is armed.
  assert.equal(data.TwitchSettings.OnlyFavouriteGames, true);
});

test("an empty games list clears without flipping OnlyFavouriteGames on", () => {
  const data = cfg([u("a1", ["Old"])]);
  setUsersGamesBySecret(data, ["a1"], []);
  assert.deepEqual(data.TwitchSettings.TwitchUsers[0].FavouriteGames, []);
  assert.notEqual(data.TwitchSettings.OnlyFavouriteGames, true);
});
