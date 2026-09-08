// The holder renter must follow the free space.
//
// Eldorado order e69b19d3 (Black Desert "Automatic Farming 1 Year") was retried
// 25 times and then cancelled by the buyer. Every attempt died at the very last
// step — the config write inside movePoolAccountToRenter — with
//   "Rental stack capacity exceeded (10/10 accounts used)."
// while six other rental stacks held 137 free slots.
//
// The cause was not capacity. It was that a stack is chosen ONCE, when the
// holder's `botFile` is first empty, and was then never re-examined. The holder
// had been pinned to config_31.json since it had room, and stayed pinned long
// after the 09-08 06:08 sale took its tenth and last slot.
//
// Raising the capacity 10 -> 50 only moves that wall to sale 41. These tests pin
// the actual fix: re-check on EVERY provision, move to a stack with room, and
// never again report "fine" from a preflight that cannot see the real limit.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// The real shape rentalStackOptions() returns, from prod 2026-09-09.
const STACKS = [
  { host: "pi", file: "config_31.json", capacity: 10, accounts: 10, remaining: 0 },
  { host: "pi", file: "config_15.json", capacity: 10, accounts: 1, remaining: 9 },
  { host: "pi", file: "config_30.json", capacity: 10, accounts: 3, remaining: 7 },
  { host: "pi", file: "config_35.json", capacity: 10, accounts: 2, remaining: 8 },
  { host: "local", file: "config_21.json", capacity: 100, accounts: 39, remaining: 61 },
];

// Load operatorFarm with the renter-admin router stubbed. The real
// chooseStackWithRoom is reproduced here so the test pins the CONTRACT the
// module depends on, not a hand-waved stub.
function load({ bots = STACKS, offlineHosts = [] } = {}) {
  const calls = { saved: [], logged: [] };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const fromOperatorFarm = parent && /operatorFarm\.js$/.test(parent.filename || "");
    if (fromOperatorFarm && request === "../routes/renterAdminRoutes") {
      return {
        rentalStackOptions: async () => ({ bots, offlineHosts }),
        chooseStackWithRoom: (list, needed) =>
          (list || [])
            .filter((b) => Number(b.remaining) >= Math.max(1, Number(needed) || 1))
            // Prefer remote hosts, then the fullest stack — the real ordering.
            .sort((a, b) => {
              const al = a.host === "local" ? 1 : 0;
              const bl = b.host === "local" ? 1 : 0;
              if (al !== bl) return al - bl;
              return b.accounts - a.accounts;
            })[0] || null,
        gatherPoolEligibility: async () => ({ candidates: [], eligible: [] }),
        availableRentalStack: async () => null,
      };
    }
    if (fromOperatorFarm && request === "./systemLog") {
      return { logEvent: (e) => calls.logged.push(e) };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/operatorFarm");
    delete require.cache[p];
    const mod = require("../utils/operatorFarm");
    delete require.cache[p];
    return { mod, calls, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

function fakeRenter(host, file) {
  return {
    botHost: host,
    botFile: file,
    botStoppedAt: new Date(),
    saved: 0,
    async save() { this.saved += 1; },
  };
}

test("REGRESSION: a full stack moves the holder instead of failing the order", async () => {
  const { mod, calls, restore } = load();
  try {
    const renter = fakeRenter("pi", "config_31.json"); // the full one
    const out = await mod.ensureStackWithRoom(renter, 1, "test");
    assert.strictEqual(out.moved, true, "the holder should have been moved off a full stack");
    assert.notStrictEqual(renter.botFile, "config_31.json");
    assert.ok(Number(out.stack.remaining) >= 1);
    assert.strictEqual(renter.saved, 1, "the move must be persisted");
    assert.ok(
      calls.logged.some((e) => e.action === "operator_stack_moved"),
      "a silent move is how this went unnoticed for a day — it must be logged",
    );
  } finally { restore(); }
});

test("a stack with room is left exactly where it is", async () => {
  const { mod, restore } = load();
  try {
    const renter = fakeRenter("pi", "config_30.json"); // 3/10
    const out = await mod.ensureStackWithRoom(renter, 1, "test");
    assert.strictEqual(out.moved, false);
    assert.strictEqual(renter.botFile, "config_30.json");
    assert.strictEqual(renter.saved, 0, "no needless write, no needless bot restart");
  } finally { restore(); }
});

test("room is checked for the WHOLE order, not just one account", async () => {
  // A qty-2 order (they happen — 2026-09-06 was qty 2) must not settle on a
  // stack with one slot and fail halfway, stranding a claimed account.
  const { mod, restore } = load({
    bots: [
      { host: "pi", file: "config_31.json", capacity: 10, accounts: 10, remaining: 0 },
      { host: "pi", file: "config_15.json", capacity: 10, accounts: 9, remaining: 1 },
      { host: "pi", file: "config_30.json", capacity: 10, accounts: 5, remaining: 5 },
    ],
  });
  try {
    const renter = fakeRenter("pi", "config_31.json");
    const out = await mod.ensureStackWithRoom(renter, 3, "test");
    assert.ok(Number(out.stack.remaining) >= 3, "chose a stack with only " + out.stack.remaining);
    assert.strictEqual(out.stack.file, "config_30.json");
  } finally { restore(); }
});

test("when NOTHING has room the error names the real constraint", async () => {
  // The old message blamed the account pool — "only 0 of 1 pristine pool
  // accounts could be provisioned" — while 554 accounts sat eligible. That sent
  // the diagnosis in exactly the wrong direction.
  const { mod, restore } = load({
    bots: [{ host: "pi", file: "config_31.json", capacity: 10, accounts: 10, remaining: 0 }],
  });
  try {
    const renter = fakeRenter("pi", "config_31.json");
    await assert.rejects(
      () => mod.ensureStackWithRoom(renter, 1, "test"),
      (e) => {
        assert.strictEqual(e.code, "no_stack_room");
        assert.strictEqual(e.status, 409);
        assert.match(e.message, /config_31\.json is full \(10\/10\)/);
        assert.doesNotMatch(e.message, /pristine pool/, "must not blame the pool");
        return true;
      },
    );
    assert.strictEqual(renter.saved, 0);
  } finally { restore(); }
});

test("an offline host is reported, not silently treated as full", async () => {
  // A Pi that blinked must not read as "no capacity" — that would take rent-farm
  // offers off sale for a network hiccup.
  const { mod, restore } = load({
    bots: [{ host: "pi", file: "config_31.json", capacity: 10, accounts: 10, remaining: 0 }],
    offlineHosts: [{ id: "pi2", label: "Pi 2" }],
  });
  try {
    await assert.rejects(
      () => mod.ensureStackWithRoom(fakeRenter("pi", "config_31.json"), 1, "test"),
      (e) => {
        assert.match(e.message, /offline and therefore unusable: Pi 2/);
        assert.deepStrictEqual(e.offlineHosts, ["pi2"]);
        return true;
      },
    );
  } finally { restore(); }
});

test("a holder whose stack cannot be read still finds one that can", async () => {
  // botFile pointing at a config that no longer exists (the dangling-slot
  // failure) must not be fatal while other stacks are fine.
  const { mod, restore } = load();
  try {
    const renter = fakeRenter("pi", "config_deleted.json");
    const out = await mod.ensureStackWithRoom(renter, 1, "test");
    assert.strictEqual(out.moved, true);
    assert.ok(Number(out.stack.remaining) >= 1);
  } finally { restore(); }
});
