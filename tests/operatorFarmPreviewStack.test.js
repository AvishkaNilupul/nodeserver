// operatorFarm.previewFreshAccounts must see the stacks the way provisioning
// does.
//
// 2026-09-30: the holder's stack (contabo/config_06.json) was full, and the next
// ones (config_54..57) had just been provisioned — empty, no container yet. The
// real path was fine: chooseAvailableStack accepts a stopped EMPTY stack and
// farmFreshAccounts starts its container after the first write. The preview
// zeroed the room of ANY stopped stack and answered `willAdd: 0,
// blockedBy: "stack-stopped"` — so every rent-farm dry run, the Gameflip buffer
// status and the coworker all reported the farm as blocked while it was not.
//
// These tests pin the preview to the SAME rule, and check it against the real
// ensureStackWithRoom rather than against a restatement of the rule.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const { chooseAvailableStack } = require("../utils/renterBotStacks");

// The real renterAdminRoutes export, verbatim in behaviour.
const chooseStackWithRoom = (bots, needed) =>
  chooseAvailableStack(
    (Array.isArray(bots) ? bots : []).filter(
      (b) => Number(b.remaining) >= Math.max(1, Math.floor(Number(needed) || 1)),
    ),
  );

// The live shape of rentalStackOptions() on 2026-09-30.
const LIVE_0930 = [
  { host: "contabo", file: "config_06.json", capacity: 50, accounts: 50, remaining: 0, running: true },
  { host: "contabo", file: "config_05.json", capacity: 50, accounts: 50, remaining: 0, running: true },
  { host: "contabo", file: "config_54.json", capacity: 50, accounts: 0, remaining: 50, running: false },
  { host: "contabo", file: "config_55.json", capacity: 50, accounts: 0, remaining: 50, running: false },
  { host: "local", file: "config_22.json", capacity: 10, accounts: 1, remaining: 9, running: true },
];

function load({ bots = LIVE_0930, holder, used = 0, eligible = 3 } = {}) {
  const logged = [];
  const pool = Array.from({ length: eligible }, (_, i) => ({
    username: "pristine" + i,
    lastCheckStatus: "ok",
    dropCount: 0,
  }));
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /operatorFarm\.js$/.test(parent.filename || "");
    if (from && request === "../routes/renterAdminRoutes") {
      return {
        rentalStackOptions: async () => ({ bots, offlineHosts: [] }),
        chooseStackWithRoom,
        gatherPoolEligibility: async () => ({ candidates: pool, eligible: pool }),
        availableRentalStack: async () => null,
      };
    }
    if (from && request === "../models/Renter") {
      return { findOne: async () => holder };
    }
    if (from && request === "../models/RenterAccount") {
      return { countDocuments: async () => used };
    }
    if (from && request === "./systemLog") {
      return { logEvent: (e) => logged.push(e) };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/operatorFarm");
    delete require.cache[p];
    const mod = require("../utils/operatorFarm");
    delete require.cache[p];
    return { mod, logged, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

function holderOn(host, file) {
  return {
    _id: "h1",
    botHost: host,
    botFile: file,
    maxAccounts: 2000,
    saved: 0,
    async save() { this.saved += 1; },
  };
}

// Where the REAL provisioning path would put the next account.
async function realTarget(mod, host, file) {
  const out = await mod.ensureStackWithRoom(holderOn(host, file), 1, "test");
  return out.stack.host + "/" + out.stack.file;
}

test("REGRESSION 2026-09-30: a full holder stack + a brand-new empty stack is NOT blocked", async () => {
  const { mod, restore } = load({ holder: holderOn("contabo", "config_06.json"), used: 258 });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.willAdd, 1, "the real path provisions here; the preview said 0");
    assert.strictEqual(p.blockedBy, null);
    assert.strictEqual(p.stackFile, "config_54.json");
    assert.strictEqual(p.stackRoom, 50);
    assert.strictEqual(p.stackNotStarted, true, "say WHY it is stopped: it starts on first delivery");
    assert.strictEqual(
      p.stackHost + "/" + p.stackFile,
      await realTarget(mod, "contabo", "config_06.json"),
      "the preview must name the stack the real provisioning path moves to",
    );
  } finally { restore(); }
});

test("a stopped stack that already HOLDS accounts is still worth nothing", async () => {
  // The 2026-09-20 trap — buyers in a config no container reads. Unchanged.
  const bots = [
    { host: "contabo", file: "config_02.json", capacity: 50, accounts: 14, remaining: 36, running: false },
  ];
  const { mod, restore } = load({ bots, holder: holderOn("contabo", "config_02.json") });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.willAdd, 0);
    assert.strictEqual(p.stackRoom, 0);
    assert.strictEqual(p.blockedBy, "stack-stopped");
    assert.strictEqual(p.stackNotStarted, false);
    await assert.rejects(
      () => mod.ensureStackWithRoom(holderOn("contabo", "config_02.json"), 1, "test"),
      (e) => e.code === "no_stack_room",
      "and the real path refuses it too — the two agree",
    );
  } finally { restore(); }
});

test("a holder already parked on an empty, not-yet-started stack stays there", async () => {
  const { mod, restore } = load({ holder: holderOn("contabo", "config_55.json") });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.stackFile, "config_55.json");
    assert.strictEqual(p.willAdd, 1);
    const out = await mod.ensureStackWithRoom(holderOn("contabo", "config_55.json"), 1, "test");
    assert.strictEqual(out.moved, false, "the real path keeps it there as well");
  } finally { restore(); }
});

test("a running stack with room reads exactly as before", async () => {
  const bots = [
    { host: "contabo", file: "config_04.json", capacity: 50, accounts: 46, remaining: 4, running: true },
  ];
  const { mod, restore } = load({ bots, holder: holderOn("contabo", "config_04.json") });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.willAdd, 1);
    assert.strictEqual(p.stackRoom, 4);
    assert.strictEqual(p.stackNotStarted, false);
    assert.strictEqual(p.blockedBy, null);
  } finally { restore(); }
});

test("an empty stopped stack never masks the real blocker", async () => {
  // Room is fine here; the pool is not. Blaming the stack would send the
  // diagnosis the wrong way, exactly as blaming the pool once did.
  const { mod, restore } = load({ holder: holderOn("contabo", "config_06.json"), eligible: 0 });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.willAdd, 0);
    assert.strictEqual(p.blockedBy, "no-eligible-accounts");
  } finally { restore(); }
});

test("an unreadable running state (null) still counts, as chooseAvailableStack counts it", async () => {
  const bots = [
    { host: "pi", file: "config_31.json", capacity: 50, accounts: 20, remaining: 30, running: null },
  ];
  const { mod, restore } = load({ bots, holder: holderOn("pi", "config_31.json") });
  try {
    const p = await mod.previewFreshAccounts({ count: 1 });
    assert.strictEqual(p.willAdd, 1);
    assert.strictEqual(p.stackRunning, null);
  } finally { restore(); }
});
