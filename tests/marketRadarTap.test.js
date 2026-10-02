// The market radar's runtime contract (utils/marketData/index.js): it runs INSIDE the live
// research scanner, so it must be harmless there.
//   - off by default (ships dark): with the switch off a tap does nothing but read settings;
//   - tap() never throws and never blocks: it queues and returns;
//   - the queue is bounded and keeps the NEWEST jobs;
//   - five consecutive failures pause it (circuit breaker) and the log is not flooded;
//   - switching it off drops whatever is still queued;
//   - with the switch on, a real scan's rows land in a real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// settings stub: the radar reads autoFarm.marketData through utils/settings.getAutoFarm()
const world = { autoFarm: {}, settingsThrow: false };
const settingsPath = require.resolve("../utils/settings");
const stub = new Module(settingsPath);
stub.exports = {
  getAutoFarm: () => {
    if (world.settingsThrow) throw new Error("settings unreadable");
    return world.autoFarm;
  },
};
stub.loaded = true;
require.cache[settingsPath] = stub;

const radar = require("../utils/marketData");
const MarketSale = require("../models/MarketSale");
const MarketRival = require("../models/MarketRival");
const MarketDataState = require("../models/MarketDataState");
const marvel = require("./fixtures/marketRadar/marvel-rivals.json");

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("marketradartap"));
  await Promise.all([MarketSale.init(), MarketRival.init(), MarketDataState.init()]);
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});
test.beforeEach(async () => {
  radar._reset();
  world.autoFarm = {};
  world.settingsThrow = false;
  await Promise.all([MarketSale.deleteMany({}), MarketRival.deleteMany({}), MarketDataState.deleteMany({})]);
});

const ON = { marketData: { enabled: true } };
const input = (game = "Marvel Rivals", over = {}) => ({ game, at: new Date("2026-10-02T00:00:00Z"), ownGf: "OUR-GF-OWNER", gfSold: marvel.gfSold, gfActive: marvel.gfActive, gfActiveComplete: true, gg: marvel.gg, pl: marvel.pl, ...over });
const tick = () => new Promise((r) => setImmediate(r));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting; status " + JSON.stringify(radar.status()));
    await tick();
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
// A stand-in database: records what it is asked, can be gated or made to fail.
function fakeModels({ gate = null, fail = false, onRivalFind = null } = {}) {
  return {
    MarketplaceListing: {
      find: () => ({
        limit: () => ({
          lean: async () => {
            if (gate) await gate.promise;
            if (fail) throw new Error("database down");
            return [];
          },
        }),
      }),
    },
    MarketDataState: { findById: () => ({ lean: async () => null }), updateOne: async () => ({}) },
    MarketSale: { find: () => ({ lean: async () => [] }), aggregate: async () => [], bulkWrite: async () => ({ upsertedCount: 0 }), updateMany: async () => ({ modifiedCount: 0 }) },
    MarketRival: {
      find: (filter) => {
        if (onRivalFind) onRivalFind(filter);
        return { limit: () => ({ lean: async () => [] }) };
      },
      bulkWrite: async () => ({ upsertedCount: 0, modifiedCount: 0 }),
      updateMany: async () => ({ modifiedCount: 0 }),
    },
  };
}

test("OFF by default: a tap does nothing, touches no database, and says so in the status", async () => {
  let touched = 0;
  const deps = { models: () => (touched++, fakeModels()) };
  assert.strictEqual(radar.tap(input(), deps), false);
  await tick();
  await tick();
  assert.strictEqual(touched, 0);
  const s = radar.status();
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.skippedOff, 1);
  assert.strictEqual(s.queued, 0);
  assert.strictEqual(await MarketRival.countDocuments({}), 0);
});

test("only an explicit 'on' turns it on", () => {
  for (const v of [true, 1, "true", " On ", "YES", "enabled", "1"]) assert.strictEqual(radar.isOnValue(v), true, JSON.stringify(v));
  for (const v of [false, 0, 2, "false", "off", "no", "", null, undefined, {}, [], "garbage"]) assert.strictEqual(radar.isOnValue(v), false, JSON.stringify(v));
  world.autoFarm = { marketData: true };
  assert.strictEqual(radar.isEnabled(), false, "the switch lives at marketData.enabled");
  world.autoFarm = { marketData: { enabled: "on" } };
  assert.strictEqual(radar.isEnabled(), true);
  world.settingsThrow = true;
  assert.strictEqual(radar.isEnabled(), false, "unreadable settings = off");
});

test("ON: a real scan's rows land in a real database, in the background", async () => {
  world.autoFarm = ON;
  assert.strictEqual(radar.tap(input()), true);
  assert.strictEqual(radar.status().queued + (radar.status().running ? 1 : 0) >= 1, true, "queued, not done inline");
  await until(() => radar.status().jobsDone === 1);
  const s = radar.status();
  assert.strictEqual(s.jobsFailed, 0);
  assert.strictEqual(s.totals.salesInserted >= marvel.gfSold.length, true);
  assert.strictEqual(s.totals.gameflipSkipped, 0);
  assert.strictEqual(await MarketSale.countDocuments({ market: "gameflip" }), marvel.gfSold.length);
  assert.ok((await MarketRival.countDocuments({})) > 20);
  assert.ok(s.lastJobAt instanceof Date);
});

test("with no Gameflip owner id EVER known, Gameflip is skipped and the rest is recorded", async () => {
  world.autoFarm = ON;
  radar.tap(input("Marvel Rivals", { ownGf: "" }));
  await until(() => radar.status().jobsDone === 1);
  const s = radar.status();
  assert.strictEqual(s.totals.gameflipSkipped, 1);
  assert.strictEqual(await MarketSale.countDocuments({ market: "gameflip" }), 0);
  assert.ok((await MarketRival.countDocuments({ market: "ggsel" })) > 0);
});

test("a Gameflip owner id is remembered: a later pass where the scanner could not get it still knows our rows", async () => {
  world.autoFarm = ON;
  // pass 1: the scanner knows our owner id (the fixture's first seller stands in for us)
  radar.tap(input("Marvel Rivals", { ownGf: "ga-seller-1", gfSold: [], gfActive: [], gg: [], pl: [] }));
  await until(() => radar.status().jobsDone === 1);
  assert.deepStrictEqual((await MarketDataState.findById("ownSellers").lean()).gameflip, ["ga-seller-1"]);
  // pass 2 in a NEW process (cache gone), Gameflip throttled: the scanner passes ""
  radar._reset();
  radar.tap(input("Marvel Rivals", { ownGf: "" }));
  await until(() => radar.status().jobsDone === 1);
  assert.strictEqual(radar.status().totals.gameflipSkipped, 0, "recorded: the owner id was remembered");
  const ours = await MarketRival.find({ market: "gameflip", seller: "ga-seller-1" }).lean();
  assert.ok(ours.length > 0 && ours.every((r) => r.ours === true), "our rows are ours, not rivals");
  assert.ok((await MarketSale.countDocuments({ market: "gameflip", seller: "ga-seller-1", ours: false })) === 0);
});

test("tap() never throws, whatever it is handed, and junk lists are simply empty", async () => {
  world.autoFarm = ON;
  const deps = { models: () => fakeModels() };
  for (const bad of [null, undefined, {}, { game: "" }, 42, "x"]) assert.strictEqual(radar.tap(bad, deps), false);
  assert.strictEqual(radar.tap({ game: "X", gfSold: "not a list", gfActive: 5, gg: { a: 1 }, pl: null }, deps), true);
  await until(() => radar.status().jobsDone === 1);
  assert.strictEqual(radar.status().jobsFailed, 0);
  world.settingsThrow = true;
  assert.strictEqual(radar.tap(input(), deps), false, "unreadable settings: off, no throw");
});

test("the scanner's rows are never modified", async () => {
  world.autoFarm = ON;
  const freeze = (rows) => Object.freeze(rows.map((r) => Object.freeze({ ...r })));
  const frozen = input("Marvel Rivals", { gfSold: freeze(marvel.gfSold), gfActive: freeze(marvel.gfActive), gg: freeze(marvel.gg), pl: freeze(marvel.pl) });
  radar.tap(frozen);
  await until(() => radar.status().jobsDone === 1);
  assert.strictEqual(radar.status().jobsFailed, 0, "nothing tried to write into a frozen row");
});

test("the queue is bounded and keeps the NEWEST scans", async () => {
  world.autoFarm = ON;
  const gate = deferred();
  const order = [];
  const deps = { models: () => fakeModels({ gate, onRivalFind: (f) => f.gameKey && order.push(f.gameKey) }) };
  const n = radar.MAX_QUEUE + 10;
  for (let i = 0; i < n; i++) assert.strictEqual(radar.tap(input("Game " + i, { gg: [], pl: [] }), deps), true);
  let s = radar.status();
  assert.strictEqual(s.accepted, n);
  assert.strictEqual(s.droppedFull, 10);
  assert.strictEqual(s.queued, radar.MAX_QUEUE);
  gate.resolve();
  await until(() => radar.status().jobsDone === radar.MAX_QUEUE);
  assert.strictEqual(order[0], "game 10", "the ten oldest were the ones dropped");
  assert.strictEqual(order[order.length - 1], "game " + (n - 1));
});

test("five consecutive failures open the breaker: it pauses, skips, warns once, and resumes after the pause", async () => {
  world.autoFarm = ON;
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const deps = { models: () => fakeModels({ fail: true }) };
    for (let i = 0; i < 7; i++) radar.tap(input("G" + i), deps);
    await until(() => !radar.status().running && radar.status().queued === 0);
    const s = radar.status();
    assert.strictEqual(s.jobsFailed, radar.BREAKER_FAILS);
    assert.strictEqual(s.breakerOpens, 1);
    assert.strictEqual(s.paused, true);
    assert.ok(s.pausedForMs > radar.BREAKER_PAUSE_MS - 5000);
    assert.strictEqual(s.skippedPaused, 2, "the queued rest were skipped, not attempted");
    assert.match(s.lastError, /database down/);
    assert.strictEqual(warns.length, 1, "one warning, not one per failure");
    assert.strictEqual(radar.tap(input("G9"), deps), false, "paused: new scans are not queued");
    // the pause ends
    radar._state.pausedUntil = 0;
    assert.strictEqual(radar.tap(input("G10"), { models: () => fakeModels() }), true);
    await until(() => radar.status().jobsDone === 1);
  } finally {
    console.warn = realWarn;
  }
});

test("switching it OFF drops what is still queued (no writes after the owner said stop)", async () => {
  world.autoFarm = ON;
  const gate = deferred();
  const deps = { models: () => fakeModels({ gate }) };
  for (let i = 0; i < 5; i++) radar.tap(input("G" + i), deps);
  await until(() => radar.status().running);
  await tick();
  world.autoFarm = {}; // the owner switches it off while job 1 is in flight
  gate.resolve();
  await until(() => !radar.status().running);
  const s = radar.status();
  assert.strictEqual(s.jobsDone, 1, "the job already in flight finishes");
  assert.strictEqual(s.skippedOff, 4, "the other four are dropped");
  assert.strictEqual(s.queued, 0);
});

test("the status carries everything the page needs and nothing else", () => {
  const s = radar.status();
  assert.deepStrictEqual(Object.keys(s).sort(), ["accepted", "breakerOpens", "droppedFull", "enabled", "jobsDone", "jobsFailed", "lastError", "lastErrorAt", "lastJobAt", "paused", "pausedForMs", "queued", "running", "skippedOff", "skippedPaused", "totals"].sort());
  assert.deepStrictEqual(Object.keys(s.totals).sort(), ["counterSales", "dips", "gameflipSkipped", "goneMarked", "jumps", "rivalsInserted", "rivalsUpdated", "salesInserted", "soldLinked", "units"].sort());
});
