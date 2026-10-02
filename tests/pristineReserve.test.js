// The pristine reserve (utils/pristineReserve.js): pool accounts the farms must
// leave for paid rent-farm orders.
//
// Rent-farm buyers can only be handed a pristine account, and consumption is
// permanent; the farms drew from the same pool with no floor that counted
// pristine rows (09-21: "No eligible pristine pool accounts"). These pin the
// shared contract every farm claimer codes against (docs/LIVE-FIXES-1003.md §2):
// the rule, the 60-s shared count, the burst spend-down, and the fail-safe
// direction when the count cannot be read.
//
// No database: the pool model and settings are stubbed at require time.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const CONTRACT_CONDITIONS = {
  lastCheckStatus: "ok",
  hasPassword: true,
  dropCount: { $not: { $gt: 0 } },
  unclaimedDropCount: { $not: { $gt: 0 } },
};

const READY = {
  status: "available",
  clientSecret: { $gt: "" },
  lastCheckStatus: { $in: ["", "ok"] },
  manualSold: { $ne: true },
  unclaimedDropCount: { $not: { $gt: 0 } },
};

function load({ count = async () => 0, af = { pristineReserve: 150 } } = {}) {
  const calls = { count: [] };
  const Pool = {
    countDocuments(q) {
      calls.count.push(q);
      return count(q, calls.count.length);
    },
  };
  const settings = { getAutoFarm: () => (typeof af === "function" ? af() : af) };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /pristineReserve\.js$/.test(parent.filename || "");
    if (from && request === "../models/AvailableAccount") return Pool;
    if (from && request === "./settings") return settings;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/pristineReserve");
    delete require.cache[p];
    const mod = require("../utils/pristineReserve");
    delete require.cache[p];
    mod._resetForTests();
    return { mod, calls };
  } finally {
    Module._load = realLoad;
  }
}

// Run fn with Date.now() moved forward by `ms`.
async function later(ms, fn) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const PRISTINE_DOC = { lastCheckStatus: "ok", hasPassword: true, dropCount: 0, unclaimedDropCount: 0 };

test("PRISTINE_CONDITIONS is exactly the contract rule", () => {
  const { mod } = load();
  assert.deepEqual(mod.PRISTINE_CONDITIONS, CONTRACT_CONDITIONS);
});

test("isPristine applies the same rule to a fetched doc", () => {
  const { mod } = load();
  assert.equal(mod.isPristine(PRISTINE_DOC), true);
  // Absent counts read as 0, like the $not:{$gt:0} query.
  assert.equal(mod.isPristine({ lastCheckStatus: "ok", hasPassword: true }), true);
  // Status / manualSold are not re-checked: noteClaimed gets the just-claimed doc.
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, status: "claimed", manualSold: true }), true);
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, lastCheckStatus: "" }), false, "unchecked");
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, lastCheckStatus: "token_invalid" }), false);
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, hasPassword: false }), false);
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, hasPassword: undefined }), false);
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, dropCount: 1 }), false);
  assert.equal(mod.isPristine({ ...PRISTINE_DOC, unclaimedDropCount: 2 }), false);
  assert.equal(mod.isPristine(null), false);
  assert.equal(mod.isPristine(undefined), false);
});

test("farmGuard counts READY ∧ pristine rows and derives headroom / protect", async () => {
  const { mod, calls } = load({ count: async () => 400 });
  const g = await mod.farmGuard();
  assert.deepEqual(g, { reserve: 150, pristine: 400, headroom: 250, protect: 150 });
  assert.equal(calls.count.length, 1);
  assert.deepEqual(calls.count[0], { $and: [READY, CONTRACT_CONDITIONS] });
});

test("below the reserve every pristine row is protected", async () => {
  const { mod } = load({ count: async () => 90 });
  assert.deepEqual(await mod.farmGuard(), { reserve: 150, pristine: 90, headroom: -60, protect: 90 });
  assert.deepEqual(await mod.farmClaimFilter(), { $nor: [CONTRACT_CONDITIONS] });
});

test("the count is cached 60 s and shared by concurrent callers", async () => {
  let resolveCount;
  const { mod, calls } = load({
    count: () => new Promise((r) => { resolveCount = r; }),
  });
  const a = mod.farmGuard();
  const b = mod.farmClaimFilter();
  await new Promise((r) => setImmediate(r));
  resolveCount(500);
  assert.equal((await a).pristine, 500);
  assert.deepEqual(await b, {});
  assert.equal(calls.count.length, 1, "two concurrent callers, one count");

  await mod.farmGuard();
  assert.equal(calls.count.length, 1, "still fresh: no recount");
  await later(61 * 1000, async () => {
    const p = mod.farmGuard();
    await new Promise((r) => setImmediate(r));
    resolveCount(480);
    assert.equal((await p).pristine, 480);
  });
  assert.equal(calls.count.length, 2, "stale after 60 s: counted again");
});

test("reserve 0 switches it off without reading the pool", async () => {
  const { mod, calls } = load({ count: async () => 3, af: { pristineReserve: 0 } });
  assert.deepEqual(await mod.farmGuard(), { reserve: 0, pristine: null, headroom: Infinity, protect: 0 });
  assert.deepEqual(await mod.farmClaimFilter(), {});
  assert.equal(calls.count.length, 0);
});

test("a missing or nonsense reserve setting reads as off", async () => {
  for (const v of [undefined, null, "", "abc", -5]) {
    const { mod, calls } = load({ count: async () => 3, af: { pristineReserve: v } });
    assert.equal((await mod.farmGuard()).protect, 0, String(v));
    assert.deepEqual(await mod.farmClaimFilter(), {}, String(v));
    assert.equal(calls.count.length, 0, String(v));
  }
});

test("FAIL SAFE: a count error answers 'at the reserve' and is retried next call", async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    let fail = true;
    const { mod, calls } = load({
      count: async () => {
        if (fail) throw new Error("connection reset");
        return 900;
      },
    });
    assert.deepEqual(await mod.farmGuard(), { reserve: 150, pristine: null, headroom: 0, protect: 150 });
    assert.deepEqual(await mod.farmClaimFilter(), { $nor: [CONTRACT_CONDITIONS] });
    assert.equal(calls.count.length, 2, "a failure is not cached");
    assert.equal(errors.length, 1, "logged once a minute, not once per claim");
    fail = false;
    assert.deepEqual(await mod.farmGuard(), { reserve: 150, pristine: 900, headroom: 750, protect: 150 });
  } finally {
    console.error = realError;
  }
});

test("a count that is not a number fails safe too", async () => {
  const realError = console.error;
  console.error = () => {};
  try {
    const { mod } = load({ count: () => undefined });
    assert.deepEqual(await mod.farmGuard(), { reserve: 150, pristine: null, headroom: 0, protect: 150 });
  } finally {
    console.error = realError;
  }
});

test("farmClaimFilter: {} while headroom > 0, the $nor filter at the reserve", async () => {
  const at = load({ count: async () => 150 });
  assert.deepEqual(await at.mod.farmClaimFilter(), { $nor: [CONTRACT_CONDITIONS] }, "headroom 0");
  const above = load({ count: async () => 151 });
  assert.deepEqual(await above.mod.farmClaimFilter(), {}, "headroom 1");
});

test("noteClaimed spends the cached count down, so a burst stops AT the reserve", async () => {
  const { mod, calls } = load({ count: async () => 152 });
  assert.deepEqual(await mod.farmClaimFilter(), {});
  mod.noteClaimed(PRISTINE_DOC);
  assert.deepEqual(await mod.farmClaimFilter(), {}, "151: one more may go");
  mod.noteClaimed({ ...PRISTINE_DOC, status: "claimed" });
  assert.deepEqual(await mod.farmClaimFilter(), { $nor: [CONTRACT_CONDITIONS] }, "150: at the reserve");
  assert.equal(calls.count.length, 1, "no recount needed to see it");
  // A non-pristine claim does not touch the count.
  mod.noteClaimed({ ...PRISTINE_DOC, dropCount: 4 });
  mod.noteClaimed({ _id: "x" });
  mod.noteClaimed(null);
  assert.equal((await mod.farmGuard()).pristine, 150);
});

test("a pristine claim reported while the count runs is taken off its result", async () => {
  let resolveCount;
  const { mod } = load({ count: () => new Promise((r) => { resolveCount = r; }) });
  const g = mod.farmGuard();
  await new Promise((r) => setImmediate(r));
  mod.noteClaimed(PRISTINE_DOC);
  resolveCount(200);
  assert.equal((await g).pristine, 199);
});

test("the filter is a fresh object: Mongoose casting it in place cannot corrupt the rule", async () => {
  const { mod } = load({ count: async () => 10 });
  const f1 = await mod.farmClaimFilter();
  f1.$nor[0].dropCount.$not.$gt = 99;
  f1.$nor[0].lastCheckStatus = "error";
  assert.deepEqual(await mod.farmClaimFilter(), { $nor: [CONTRACT_CONDITIONS] });
  assert.deepEqual(mod.PRISTINE_CONDITIONS, CONTRACT_CONDITIONS);
  assert.equal(Object.isFrozen(mod.PRISTINE_CONDITIONS), false, "Mongoose writes into query objects");
});
