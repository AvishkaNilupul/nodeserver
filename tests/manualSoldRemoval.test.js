// The manual-sold tick used to be memory only: it flipped a flag and left the
// account sitting on every listing that still offered it, until the periodic
// auto-list pass happened to sweep. In that window the marketplace could hand
// the same login to a second buyer. removeManualSoldOwner is the reactive twin
// of that sweep, called by the no-claim / web-token ticks and the Drop
// Archive's mark-sold so the delist happens at tick time.
//
// Mongo/marketplace-free: the models and the marketplace client are stubbed at
// require time, so this exercises the real control flow in
// utils/unclaimedAutoList.js.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Minimal Mongoose-model stand-ins: find() returns a canned list, updateOne
// records the write, exists() answers the "any listed ledger left?" probe.
function fakeModel(rows = []) {
  const calls = { find: [], updateOne: [], exists: [] };
  return {
    calls,
    rows,
    find(q) {
      calls.find.push(q);
      const chain = {
        lean: async () => rows,
        sort: () => chain,
        limit: () => chain,
      };
      return chain;
    },
    async findOne() {
      return null;
    },
    updateOne(q, u) {
      calls.updateOne.push({ q, u });
      return { catch: () => Promise.resolve({ matchedCount: 1 }) };
    },
    async exists(q) {
      calls.exists.push(q);
      return false;
    },
  };
}

function loadEngine({ ledgers = [], listingRows = [] } = {}) {
  const Unclaimed = fakeModel(ledgers);
  const Pool = fakeModel([]);
  const Web = fakeModel([]);
  const Listing = fakeModel(listingRows);
  const events = [];

  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Unclaimed],
    [require.resolve("../models/AvailableAccount"), Pool],
    [require.resolve("../models/WebBotAccount"), Web],
    [require.resolve("../models/MarketplaceListing"), Listing],
    [require.resolve("../utils/systemLog"), { logEvent: (e) => events.push(e), actorFromReq: () => "test" }],
  ]);

  const enginePath = require.resolve("../utils/unclaimedAutoList");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  delete require.cache[enginePath];
  let engine;
  try {
    engine = require("../utils/unclaimedAutoList");
  } finally {
    Module._load = origLoad;
    delete require.cache[enginePath];
  }
  return { engine, Unclaimed, Pool, Web, Listing, events };
}

test("removeManualSoldOwner: no owner id does nothing at all", async () => {
  const { engine, Unclaimed } = loadEngine();
  const out = await engine.removeManualSoldOwner({});
  assert.deepStrictEqual(out, { ledgers: 0, removed: 0, errors: [] });
  assert.strictEqual(Unclaimed.calls.find.length, 0, "must not query without an owner");
});

test("removeManualSoldOwner: only LISTED ledgers of that owner are touched", async () => {
  const { engine, Unclaimed } = loadEngine({ ledgers: [] });
  await engine.removeManualSoldOwner({ poolAccountId: "pool1" });
  assert.strictEqual(Unclaimed.calls.find.length, 1);
  const q = Unclaimed.calls.find[0];
  assert.strictEqual(q.status, "listed");
  assert.deepStrictEqual(q.$or, [{ poolAccountId: "pool1" }]);
});

test("removeManualSoldOwner: a webbot owner queries by its own id", async () => {
  const { engine, Unclaimed } = loadEngine({ ledgers: [] });
  await engine.removeManualSoldOwner({ webBotAccountId: "web9" });
  assert.deepStrictEqual(Unclaimed.calls.find[0].$or, [{ webBotAccountId: "web9" }]);
});

test("removeManualSoldOwner: each ledger is parked removed, never sold or released", async () => {
  const ledgers = [
    { _id: "L1", login: "alpha", source: "noclaim", poolAccountId: "pool1", game: "Rainbow Six Siege" },
    { _id: "L2", login: "beta", source: "noclaim", poolAccountId: "pool1", game: "Rainbow Six Siege" },
  ];
  const { engine, Unclaimed, events } = loadEngine({ ledgers });
  const out = await engine.removeManualSoldOwner({ poolAccountId: "pool1" });
  assert.strictEqual(out.ledgers, 2);
  assert.strictEqual(out.removed, 2);
  assert.deepStrictEqual(out.errors, []);

  const parks = Unclaimed.calls.updateOne.filter((w) => w.u.$set && w.u.$set.status);
  assert.strictEqual(parks.length, 2);
  for (const p of parks) {
    assert.strictEqual(p.u.$set.status, "removed");
    assert.strictEqual(p.q.status, "listed", "park must be a guarded transition");
    assert.match(p.u.$set.note, /manual sold/i);
  }
  const logged = events.filter((e) => e.action === "manual_sold_removed");
  assert.strictEqual(logged.length, 2);
});

test("removeManualSoldOwner: one ledger blowing up does not abandon the rest", async () => {
  const ledgers = [
    { _id: "L1", login: "alpha", source: "noclaim", poolAccountId: "pool1" },
    { _id: "L2", login: "beta", source: "noclaim", poolAccountId: "pool1" },
  ];
  const { engine, Listing } = loadEngine({ ledgers });
  // rowsForLogin reads MarketplaceListing; make the FIRST read throw.
  let n = 0;
  Listing.find = () => ({
    lean: async () => {
      n++;
      if (n === 1) throw new Error("atlas hiccup");
      return [];
    },
  });
  const out = await engine.removeManualSoldOwner({ poolAccountId: "pool1" });
  assert.strictEqual(out.ledgers, 2);
  assert.strictEqual(out.removed, 1, "the healthy ledger still comes off");
  assert.deepStrictEqual(out.errors, ["atlas hiccup"]);
});
