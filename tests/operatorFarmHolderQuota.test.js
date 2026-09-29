// operatorFarm.holderQuota() — the holder's account limit, as the capacity
// watcher reads it.
//
// It must count EXACTLY what farmFreshAccounts refuses on: RenterAccount rows
// owned by the holder, against Renter.maxAccounts. On 2026-09-28 that limit
// (250/250) blocked every rent-farm order for seven hours while every capacity
// dial read fine, because nothing outside farmFreshAccounts looked at it.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function load({ holder, used }) {
  const calls = {};
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /operatorFarm\.js$/.test(parent.filename || "");
    if (from && request === "../models/Renter") {
      return {
        findOne: (q) => {
          calls.findOne = q;
          return { select: () => ({ lean: async () => holder }) };
        },
      };
    }
    if (from && request === "../models/RenterAccount") {
      return {
        countDocuments: async (q) => {
          calls.count = q;
          return used;
        },
      };
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

test("the 2026-09-28 shape: 250 of 250 used leaves nothing", async () => {
  const { mod, calls, restore } = load({ holder: { _id: "h1", maxAccounts: 250 }, used: 250 });
  try {
    assert.deepStrictEqual(await mod.holderQuota(), { max: 250, used: 250, remaining: 0 });
    // Looks up the one reserved holder, and counts its rows the way
    // farmFreshAccounts does.
    assert.deepStrictEqual(calls.findOne, { usernameLower: mod.OPERATOR_USERNAME });
    assert.deepStrictEqual(calls.count, { renter: "h1" });
  } finally { restore(); }
});

test("room left is max minus used", async () => {
  const { mod, restore } = load({ holder: { _id: "h1", maxAccounts: 400 }, used: 254 });
  try {
    assert.deepStrictEqual(await mod.holderQuota(), { max: 400, used: 254, remaining: 146 });
  } finally { restore(); }
});

test("over the limit never reports negative room", async () => {
  // A limit lowered below current use (or rows added by another path) must
  // read as full, not as a negative number some caller then adds up.
  const { mod, restore } = load({ holder: { _id: "h1", maxAccounts: 200 }, used: 254 });
  try {
    assert.deepStrictEqual(await mod.holderQuota(), { max: 200, used: 254, remaining: 0 });
  } finally { restore(); }
});

test("an unset limit is a zero limit, as farmFreshAccounts treats it", async () => {
  const { mod, restore } = load({ holder: { _id: "h1" }, used: 0 });
  try {
    assert.deepStrictEqual(await mod.holderQuota(), { max: 0, used: 0, remaining: 0 });
  } finally { restore(); }
});

test("no holder renter yet reads as null, not as zero", async () => {
  const { mod, calls, restore } = load({ holder: null, used: 0 });
  try {
    assert.strictEqual(await mod.holderQuota(), null);
    assert.strictEqual(calls.count, undefined, "nothing to count without a holder");
  } finally { restore(); }
});
