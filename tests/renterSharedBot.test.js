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
const { gamesForUser } = require("../utils/farmCompletion");

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

// ---------------------------------------------------------------------------
// Phase 0 regression tests — see the renting hardening plan.
//
// A minimal in-memory fake of the botHosts file transport. readFile and
// writeFileAtomic each yield a microtask, so two overlapping read→mutate→write
// cycles on the SAME (host, file) can interleave — exactly the lost-update
// window writeFileAtomic's final-rename atomicity does NOT close. This lets the
// race run under `node --test` with no prod and no SSH.
// ---------------------------------------------------------------------------
function fakeStore(initial) {
  const files = { ...initial };
  return {
    files,
    async readFile(_host, file) {
      await Promise.resolve(); // yield: another RMW cycle may run here
      return files[file];
    },
    async writeFileAtomic(_host, file, text) {
      await Promise.resolve(); // yield: widen the interleave window
      files[file] = text;
    },
  };
}

// One read→mutate→write cycle that adds a single account by secret. `wrap`
// lets a caller run the body bare (no serialization) or inside a lock.
async function rmwAddAccount(store, host, file, secret, wrap) {
  await wrap(async () => {
    const data = JSON.parse(await store.readFile(host, file));
    data.TwitchSettings.TwitchUsers.push({ ClientSecret: secret });
    await Promise.resolve(); // extra yield between read and write
    await store.writeFileAtomic(host, file, JSON.stringify(data));
  });
}

const noWrap = (fn) => fn();

test("the fake transport actually reproduces the lost-update race (control)", async () => {
  // Sanity check that the harness is real: with NO serialization, two
  // overlapping RMW cycles lose one writer's change. If this ever stops losing,
  // the locked test below proves nothing.
  const store = fakeStore({
    "config_30.json": JSON.stringify({ TwitchSettings: { TwitchUsers: [] } }),
  });
  const host = { id: "test-host" };
  await Promise.all([
    rmwAddAccount(store, host, "config_30.json", "a1", noWrap),
    rmwAddAccount(store, host, "config_30.json", "b1", noWrap),
  ]);
  const users = JSON.parse(store.files["config_30.json"]).TwitchSettings.TwitchUsers;
  assert.ok(users.length < 2, "unserialized RMW should lose an update");
});

test("per-(host,file) lock: concurrent RMW on one config never loses an update", async () => {
  // RED until Phase 1 lands utils/fileLock.js. Required lazily so its absence
  // fails only THIS test, leaving the 6 pure-transform tests above green.
  const { withFileLock } = require("../utils/fileLock");
  const store = fakeStore({
    "config_30.json": JSON.stringify({ TwitchSettings: { TwitchUsers: [] } }),
  });
  const host = { id: "test-host" };
  const lock = (fn) => withFileLock(host, "config_30.json", fn);
  await Promise.all([
    rmwAddAccount(store, host, "config_30.json", "a1", lock),
    rmwAddAccount(store, host, "config_30.json", "b1", lock),
  ]);
  const secrets = JSON.parse(store.files["config_30.json"])
    .TwitchSettings.TwitchUsers.map((x) => x.ClientSecret)
    .sort();
  assert.deepEqual(secrets, ["a1", "b1"], "both writers' accounts must survive");
});

test("writes to DIFFERENT files are not serialized behind one lock", async () => {
  // RED until Phase 1. The lock is keyed per (host,file): two different files
  // must be able to hold the lock at the same time, or one slow write on
  // config_30 would stall every other config in the fleet.
  const { withFileLock } = require("../utils/fileLock");
  const host = { id: "test-host" };
  let inA = false;
  let overlapped = false;
  async function hold(file) {
    await withFileLock(host, file, async () => {
      if (file === "config_30.json") {
        inA = true;
        await Promise.resolve();
        await Promise.resolve();
        inA = false;
      } else {
        // If this runs while A still holds config_30's lock, they overlapped.
        if (inA) overlapped = true;
      }
    });
  }
  await Promise.all([hold("config_30.json"), hold("config_31.json")]);
  assert.ok(overlapped, "different files must not serialize behind one another");
});

test("arming a shared bot's games never starves a co-tenant with empty favourites", () => {
  // RED until Phase 2. Shared config: renter A (a1) arms games; co-tenant B
  // (b1) has empty per-account favourites AND the config-ROOT FavouriteGames is
  // also empty. A's arming flips OnlyFavouriteGames on globally, so B — which
  // was farming everything in wander mode — would now farm NOTHING (nothing to
  // inherit at farmCompletion.js:51). The fix must leave B a non-empty effective
  // game list. B with NON-empty favourites (see test at line ~51) is untouched.
  const data = {
    FavouriteGames: [],
    TwitchSettings: { TwitchUsers: [u("a1", []), u("b1", [])] },
  };
  setUsersGamesBySecret(data, ["a1"], ["VALORANT"]);
  assert.equal(data.TwitchSettings.OnlyFavouriteGames, true);
  const bGames = gamesForUser(
    data.TwitchSettings.TwitchUsers[1],
    data.FavouriteGames,
  );
  assert.ok(bGames.length > 0, "co-tenant B must not be starved to zero games");
});
