// A live listing row with NO DropSet must never cost the guardian its pass.
//
// runChecks built its DropSet id list from `String(r.set)` over every active
// autoDeliver row. The Gameflip rent-farm buffer rows (utils/gameflipFarmService
// createBufferedRow: rentFarm:true, autoDeliver:true, no set) turned that into
// the string "undefined", Mongoose refused to cast it, and the CastError escaped
// runOnce's try/finally. Everything after the lookup was skipped on EVERY pass:
// claim-mismatch, redeemed-drops and orphaned-reservation checks,
// autoResolveStale, auto-heal, lastRun and the Telegram digest — with a single
// "marketplace guardian error: Cast to ObjectId failed …" log line per pass as
// the only trace.
//
// The DropSet stub casts each filter through the REAL model (Query#cast, no
// database needed), so it refuses exactly what production Mongoose refused.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Loaded before the stub loader goes in, so the stub can borrow its casting.
const RealDropSet = require("../models/DropSet");

// ---------------------------------------------------------------- harness --

const SET_ID = "64b000000000000000000001";

// An ordinary archive-backed Gameflip row whose account holds its drop FREE —
// a released reservation, i.e. a claim-mismatch finding. The checks only reach
// it after the DropSet lookup, so its finding is the proof the pass got there.
const ARCHIVE_ROW = {
  _id: "listing-archive-1",
  marketplace: "gameflip",
  externalId: "gf-archive-1",
  set: SET_ID,
  status: "active",
  autoDeliver: true,
  accountId: "acc-1",
  accountLogin: "farmed1",
  qtyTarget: 0,
};

// A Gameflip rent-farm buffer row, shaped as createBufferedRow writes it.
function rentFarmRow(n, login) {
  return {
    _id: "listing-rentfarm-" + n,
    marketplace: "gameflip",
    externalId: "gf-rentfarm-" + n,
    status: "active",
    autoDeliver: true,
    origin: "manual",
    qtyRemaining: 0,
    accountLogin: login,
    rentFarm: true,
    rentFarmGame: "Rust",
    rentFarmDays: 180,
    rentFarmPoolId: "pool-" + n,
  };
}

// A set-less row that is NOT rent-farm (the no-claim auto-lister's Eldorado
// shape: stock picked by game, no DropSet). Guards the lookup itself, not just
// the one row kind that happened to trip it first.
const UNCLAIMED_ROW = {
  _id: "listing-unclaimed-1",
  marketplace: "eldorado",
  externalId: "eld-1",
  status: "active",
  autoDeliver: true,
  unclaimedGame: "Overwatch 2",
  qtyTarget: 0,
};

function loadGuardian(rows) {
  const world = {
    setLookups: [],
    upserts: [],
    sweeps: [],
    healed: 0,
    telegrams: [],
  };

  const fakeFinding = {
    async findOneAndUpdate(query, update) {
      world.upserts.push({
        dedupeKey: query.dedupeKey,
        type: update.$set && update.$set.type,
        listing: update.$set && update.$set.listing,
        severity: update.$set && update.$set.severity,
      });
      return { lastErrorObject: { upserted: true }, value: null };
    },
    async updateMany(query) {
      world.sweeps.push(query);
      return { modifiedCount: 0 };
    },
    async updateOne() {
      return { modifiedCount: 0 };
    },
    async countDocuments() {
      return 0;
    },
  };

  const fakeListing = {
    find() {
      const r = { lean: async () => rows };
      r.limit = () => r;
      return r;
    },
  };

  const fakeDropSet = {
    find(filter) {
      // Throws the production CastError for any id Mongoose cannot cast.
      RealDropSet.find(filter).cast();
      const ids = filter._id.$in.map(String);
      world.setLookups.push(ids);
      return {
        lean: async () =>
          ids.includes(SET_ID)
            ? [{ _id: SET_ID, name: "Rust set", items: [{ itemKey: "k1" }] }]
            : [],
      };
    },
    findById() {
      return { lean: async () => null };
    },
  };

  const fakeDropLog = {
    find() {
      return {
        lean: async () => [
          {
            account: "acc-1",
            itemKey: "k1",
            soldAt: null,
            soldToUsername: "",
            connected: false,
            name: "Rust skin",
          },
        ],
      };
    },
    async distinct() {
      return [];
    },
  };

  const fakeBotAccount = {
    find() {
      return {
        lean: async () => [
          { _id: "acc-1", login: "farmed1", lastScanStatus: "" },
        ],
      };
    },
  };

  const stubs = new Map([
    [require.resolve("../models/AuditFinding"), fakeFinding],
    [require.resolve("../models/MarketplaceListing"), fakeListing],
    [require.resolve("../models/DropSet"), fakeDropSet],
    [require.resolve("../models/DropLog"), fakeDropLog],
    [require.resolve("../models/BotAccount"), fakeBotAccount],
    [require.resolve("../utils/marketplaces"), {}],
    [
      require.resolve("../utils/telegram"),
      {
        sendTelegram: async (text) => {
          world.telegrams.push(text);
        },
      },
    ],
    [
      require.resolve("../utils/guardianAutoHeal"),
      {
        healOpenFindings: async () => {
          world.healed++;
          return null;
        },
      },
    ],
  ]);

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    } catch {
      /* fall through to the real loader */
    }
    return origLoad.apply(this, arguments);
  };

  const guardianPath = require.resolve("../utils/marketplaceGuardian");
  delete require.cache[guardianPath];
  const guardian = require(guardianPath);
  // Kept installed for the whole run: runOnce requires the auto-healer lazily.
  const restore = () => {
    Module._load = origLoad;
    delete require.cache[guardianPath];
  };
  return { guardian, world, restore };
}

// ------------------------------------------------------------------ tests --

test("a rent-farm buffer row no longer aborts the pass", async () => {
  const rows = [ARCHIVE_ROW, rentFarmRow(1, "poolacct1")];
  const { guardian, world, restore } = loadGuardian(rows);
  let run;
  try {
    run = await guardian.runOnce();
  } finally {
    restore();
  }

  assert.deepStrictEqual(
    world.setLookups,
    [[SET_ID]],
    "only real set ids reach the DropSet lookup",
  );
  const claim = world.upserts.find((u) => u.type === "claim-mismatch");
  assert.ok(claim, "the checks after the lookup ran again");
  assert.strictEqual(claim.listing, ARCHIVE_ROW._id);
  assert.ok(
    world.sweeps.some((q) => q.dedupeKey && Array.isArray(q.dedupeKey.$nin)),
    "autoResolveStale ran",
  );
  assert.strictEqual(world.healed, 1, "auto-heal ran");
  assert.ok(run && run.listingsChecked === rows.length, "lastRun was recorded");
});

test("any other set-less row cannot fail the DropSet lookup either", async () => {
  const rows = [ARCHIVE_ROW, UNCLAIMED_ROW];
  const { guardian, world, restore } = loadGuardian(rows);
  try {
    await guardian.runOnce();
  } finally {
    restore();
  }

  assert.deepStrictEqual(world.setLookups, [[SET_ID]]);
  assert.ok(
    world.upserts.some((u) => u.type === "claim-mismatch"),
    "the set-bearing row was still checked",
  );
  assert.strictEqual(world.healed, 1);
});

test("rent-farm rows raise nothing the healer could act on", async () => {
  // The same pool login behind two buffered offers. The rent-farm service owns
  // that invariant (one rentFarmPoolId per offer); the guardian's dedupe fix
  // would try to "refill" a rent-farm offer from a DropSet it does not have.
  const rows = [rentFarmRow(1, "poolacct1"), rentFarmRow(2, "poolacct1")];
  const { guardian, world, restore } = loadGuardian(rows);
  try {
    await guardian.runOnce();
  } finally {
    restore();
  }

  assert.deepStrictEqual(world.upserts, [], "no finding of any kind");
  assert.deepStrictEqual(
    world.setLookups,
    [],
    "no rows with a set, so no DropSet lookup at all",
  );
  assert.strictEqual(world.healed, 1, "the rest of the pass still ran");
});
