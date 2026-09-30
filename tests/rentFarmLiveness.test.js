// A stack with free slots is not the same thing as a stack that can farm.
//
// 2026-09-20: `provisionEmptyConfig` registered four new rent-farm stacks on
// contabo and `setStackCapacity` advertised 100 slots each — but nothing ever
// created or started their containers. The picker saw 400 free slots, routed 13
// paid orders into one of them, and every one of those buyers farmed nothing for
// 30 hours. Nothing alerted: `rentFarmCapacity` watches free slots, and the
// renter scanner stamps `lastScanStatus: "ok"` from the server by token, so
// every dial read fine. The only tell was `dropCount: 0` on every account.
//
// 2026-09-21: the same trap was still armed — contabo/config_03..06 each still
// advertised capacity 100 with their containers Exited(143), while all 26 live
// buyers sat in the one running stack.
//
// These tests pin the fix: liveness is a property of a stack row, only an
// explicit `false` disqualifies, and an unreachable host is NEVER mistaken for
// a dead one (that would take every rent-farm offer off sale when the Pi
// blinks, which is a worse failure than the one being fixed).
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const { chooseAvailableStack } = require("../utils/renterBotStacks");

// ---------------------------------------------------------------- the picker

test("a stopped stack is never chosen, however much room it has", () => {
  const picked = chooseAvailableStack([
    { host: "contabo", file: "config_03.json", capacity: 100, accounts: 0, remaining: 100, running: false },
    { host: "contabo", file: "config_02.json", capacity: 100, accounts: 26, remaining: 74, running: true },
  ]);
  assert.strictEqual(picked.file, "config_02.json");
});

test("every stack stopped means NO stack, not the emptiest corpse", () => {
  // OCCUPIED stopped stacks: these hold real buyers who are not farming, and
  // must never take another order. (An EMPTY stopped stack is a different
  // thing — merely un-started — and is covered by its own test below.)
  const picked = chooseAvailableStack([
    { host: "contabo", file: "config_03.json", capacity: 100, accounts: 12, remaining: 88, running: false },
    { host: "contabo", file: "config_04.json", capacity: 100, accounts: 4, remaining: 96, running: false },
  ]);
  assert.strictEqual(picked, null);
});

test("running:null is UNKNOWN, not dead — an unreachable host stays eligible", () => {
  // dockerPs failed for this host. Refusing it would take offers off sale for a
  // network hiccup; that is the failure mode this fix must not introduce.
  const picked = chooseAvailableStack([
    { host: "pi", file: "config_31.json", capacity: 50, accounts: 10, remaining: 40, running: null },
  ]);
  assert.ok(picked, "an unreadable host must not be treated as a stopped stack");
  assert.strictEqual(picked.file, "config_31.json");
});

test("rows with no liveness field at all are still eligible (backward compatible)", () => {
  const picked = chooseAvailableStack([
    { host: "pi", file: "config_15.json", capacity: 10, accounts: 1, remaining: 9 },
  ]);
  assert.strictEqual(picked.file, "config_15.json");
});

test("among LIVE stacks the fullest-first packing is unchanged", () => {
  const picked = chooseAvailableStack([
    { host: "pi", file: "config_15.json", capacity: 10, accounts: 1, remaining: 9, running: true },
    { host: "pi", file: "config_30.json", capacity: 10, accounts: 7, remaining: 3, running: true },
    { host: "contabo", file: "config_03.json", capacity: 100, accounts: 9, remaining: 91, running: false },
  ]);
  assert.strictEqual(picked.file, "config_30.json", "fullest live stack first");
});

// ------------------------------------------------- the holder's own stack

function load({ bots, offlineHosts = [] } = {}) {
  const calls = { logged: [] };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /operatorFarm\.js$/.test(parent.filename || "");
    if (from && request === "../routes/renterAdminRoutes") {
      return {
        rentalStackOptions: async () => ({ bots, offlineHosts }),
        // The REAL picker, so these tests pin the contract rather than a stub.
        chooseStackWithRoom: (list, needed) =>
          chooseAvailableStack(
            (list || []).filter(
              (b) => Number(b.remaining) >= Math.max(1, Number(needed) || 1),
            ),
          ),
        gatherPoolEligibility: async () => ({ candidates: [], eligible: [] }),
        availableRentalStack: async () => null,
      };
    }
    if (from && request === "./systemLog") {
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

test("REGRESSION: the holder is moved OFF a stopped stack that still has room", async () => {
  // This is the 2026-09-20 shape exactly: the holder is parked on a dead stack
  // with 74 free slots, so the old "room? then stay" rule kept sending every
  // paid buyer to a container nobody was running.
  const { mod, restore } = load({
    bots: [
      { host: "contabo", file: "config_03.json", capacity: 100, accounts: 26, remaining: 74, running: false },
      { host: "contabo", file: "config_02.json", capacity: 100, accounts: 12, remaining: 88, running: true },
    ],
  });
  try {
    const renter = fakeRenter("contabo", "config_03.json");
    const out = await mod.ensureStackWithRoom(renter, 1);
    assert.strictEqual(out.moved, true, "the holder must follow the free space");
    assert.strictEqual(out.stack.file, "config_02.json");
    assert.strictEqual(renter.botFile, "config_02.json");
    assert.strictEqual(renter.saved, 1);
  } finally { restore(); }
});

test("a LIVE holder stack with room is still left exactly where it is", async () => {
  const { mod, restore } = load({
    bots: [
      { host: "contabo", file: "config_02.json", capacity: 100, accounts: 26, remaining: 74, running: true },
      { host: "pi", file: "config_15.json", capacity: 10, accounts: 1, remaining: 9, running: true },
    ],
  });
  try {
    const renter = fakeRenter("contabo", "config_02.json");
    const out = await mod.ensureStackWithRoom(renter, 1);
    assert.strictEqual(out.moved, false);
    assert.strictEqual(renter.saved, 0, "no pointless write");
  } finally { restore(); }
});

test("an UNREACHABLE holder stack does not stampede the holder elsewhere", async () => {
  // running:null — the host could not be asked this tick. Moving on that would
  // shuffle live buyers between hosts every time an SSH read times out.
  const { mod, restore } = load({
    bots: [
      { host: "pi", file: "config_31.json", capacity: 50, accounts: 10, remaining: 40, running: null },
      { host: "contabo", file: "config_02.json", capacity: 100, accounts: 26, remaining: 74, running: true },
    ],
  });
  try {
    const renter = fakeRenter("pi", "config_31.json");
    const out = await mod.ensureStackWithRoom(renter, 1);
    assert.strictEqual(out.moved, false);
    assert.strictEqual(renter.botFile, "config_31.json");
  } finally { restore(); }
});

test("when only DEAD stacks have room the order fails, naming the real reason", async () => {
  const { mod, restore } = load({
    bots: [
      { host: "contabo", file: "config_03.json", capacity: 100, accounts: 5, remaining: 95, running: false },
    ],
  });
  try {
    const renter = fakeRenter("contabo", "config_03.json");
    await assert.rejects(
      () => mod.ensureStackWithRoom(renter, 1),
      (e) => {
        assert.strictEqual(e.code, "no_stack_room");
        assert.strictEqual(e.status, 409);
        assert.match(e.message, /STOPPED/,
          "the operator must be told the container is stopped, not that it is full");
        return true;
      },
    );
    // Crucially: it FAILS rather than quietly delivering to a dead container.
    assert.strictEqual(renter.saved, 0);
  } finally { restore(); }
});

// ------------------------------------------------------ the capacity alarm

function loadCapacity({ bots, offlineHosts = [] }) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /rentFarmCapacity\.js$/.test(parent.filename || "");
    if (from && request === "../routes/renterAdminRoutes") {
      return { rentalStackOptions: async () => ({ bots, offlineHosts }) };
    }
    if (from && request === "./telegram") return { sendTelegram: async () => {} };
    if (from && request === "./systemLog") return { logEvent: async () => {} };
    // No holder: the stacks bind (a real holderQuota read waits on a database
    // that is not there and times the test out).
    if (from && request === "./operatorFarm") return { holderQuota: async () => null };
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/rentFarmCapacity");
    delete require.cache[p];
    const mod = require("../utils/rentFarmCapacity");
    delete require.cache[p];
    mod._reset();
    return { mod, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

test("REGRESSION: dead stacks do not pad the free-slot count", async () => {
  // The live prod shape on 2026-09-21: four stopped stacks offering 400 slots
  // next to one running stack with 74. The alarm used to answer 474 and "ok".
  const { mod, restore } = loadCapacity({
    bots: [
      { host: "contabo", file: "config_02.json", capacity: 100, accounts: 26, remaining: 74, running: true },
      { host: "contabo", file: "config_03.json", capacity: 100, accounts: 25, remaining: 75, running: false },
      { host: "contabo", file: "config_04.json", capacity: 100, accounts: 25, remaining: 75, running: false },
      { host: "contabo", file: "config_05.json", capacity: 100, accounts: 25, remaining: 75, running: false },
      { host: "contabo", file: "config_06.json", capacity: 100, accounts: 25, remaining: 75, running: false },
    ],
  });
  try {
    const s = await mod.snapshot();
    assert.strictEqual(s.totalFree, 74, "only slots that can actually farm");
    assert.strictEqual(s.deadFree, 300, "and the dead ones are REPORTED, not dropped");
    assert.deepStrictEqual(s.deadStacks, [
      "contabo/config_03.json",
      "contabo/config_04.json",
      "contabo/config_05.json",
      "contabo/config_06.json",
    ]);
    const text = mod.describe(s);
    assert.match(text, /STOPPED/, "the operator must see WHY the slots vanished");
    assert.match(text, /300 further slot\(s\)/);
  } finally { restore(); }
});

test("unknown liveness still counts — the alarm must not cry wolf on a slow host", async () => {
  const { mod, restore } = loadCapacity({
    bots: [
      { host: "pi", file: "config_31.json", capacity: 50, accounts: 10, remaining: 40, running: null },
    ],
  });
  try {
    const s = await mod.snapshot();
    assert.strictEqual(s.totalFree, 40);
    assert.strictEqual(s.deadFree, 0);
  } finally { restore(); }
});

// ---------------------------------------------- the empty-stack exception

test("an EMPTY stopped stack is still eligible — otherwise capacity can never grow", () => {
  // provisionEmptyConfig deliberately creates a stack with no container, and
  // startConfigContainer refuses an empty config (an accountless bot spins in a
  // login-retry loop). If "stopped" disqualified it, a fresh stack could never
  // be chosen and never be started, so once every running stack filled, orders
  // would fail with no_stack_room and there would be no way to add capacity.
  const picked = chooseAvailableStack([
    { host: "contabo", file: "config_07.json", capacity: 50, accounts: 0, remaining: 50, running: false },
  ]);
  assert.ok(picked, "a brand-new empty stack must be usable");
  assert.strictEqual(picked.file, "config_07.json");
});

test("a stopped stack that HOLDS accounts is still refused — that is the real trap", () => {
  // 2026-09-20: 13 paid orders went into a registered stack whose container was
  // never started. The tell was that it already held buyers and was not running.
  const picked = chooseAvailableStack([
    { host: "contabo", file: "config_03.json", capacity: 50, accounts: 26, remaining: 24, running: false },
  ]);
  assert.strictEqual(picked, null);
});

test("a RUNNING stack is preferred over an empty stopped one", () => {
  const picked = chooseAvailableStack([
    { host: "contabo", file: "config_07.json", capacity: 50, accounts: 0, remaining: 50, running: false },
    { host: "contabo", file: "config_04.json", capacity: 50, accounts: 40, remaining: 10, running: true },
  ]);
  assert.strictEqual(picked.file, "config_04.json", "fullest-first still puts the live stack first");
});
