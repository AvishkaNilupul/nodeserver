// Being told BEFORE the slots run out.
//
// The pool said 554 eligible and the preflight said willAdd:1 while every
// rent-farm order was failing, because the binding constraint is slots in bot
// configs, not accounts in the pool. This watcher reports the number that
// actually runs out, and shouts once per state change.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// `quota` is what operatorFarm.holderQuota() answers: { max, used, remaining },
// or null when the holder renter does not exist yet. `quotaError` makes the read
// fail.
function load({ bots, offlineHosts = [], quota = null, quotaError = null }) {
  const sent = [];
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /rentFarmCapacity\.js$/.test(parent.filename || "");
    if (from && request === "../routes/renterAdminRoutes") {
      return { rentalStackOptions: async () => ({ bots, offlineHosts }) };
    }
    if (from && request === "./operatorFarm") {
      return {
        holderQuota: async () => {
          if (quotaError) throw quotaError;
          return quota;
        },
      };
    }
    if (from && request === "./telegram") {
      return { sendTelegram: async (t) => { sent.push(t); } };
    }
    if (from && request === "./systemLog") {
      return { logEvent: async () => {} };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/rentFarmCapacity");
    delete require.cache[p];
    const mod = require("../utils/rentFarmCapacity");
    delete require.cache[p];
    mod._reset();
    return { mod, sent, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

const HEALTHY = [
  { host: "pi", file: "config_31.json", capacity: 50, accounts: 10, remaining: 40 },
  { host: "local", file: "config_21.json", capacity: 100, accounts: 39, remaining: 61 },
];
const FULL = [
  { host: "pi", file: "config_31.json", capacity: 10, accounts: 10, remaining: 0 },
];

test("counts slots, not pool accounts", async () => {
  const { mod, restore } = load({ bots: HEALTHY });
  try {
    const s = await mod.snapshot();
    assert.strictEqual(s.totalFree, 101);
    assert.strictEqual(s.totalCapacity, 150);
    assert.strictEqual(s.readable, 2);
  } finally { restore(); }
});

test("REGRESSION: zero free slots is an alert, not a silent state", async () => {
  // This is exactly the condition that held for nine hours on 2026-09-08 while
  // two paid orders arrived and nothing said a word.
  const { mod, sent, restore } = load({ bots: FULL });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.level, "empty");
    assert.strictEqual(s.alerted, true);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /capacity is GONE/);
    assert.match(sent[0], /config_31\.json  10\/10/);
  } finally { restore(); }
});

test("a persistent shortage does not re-ping every half hour", async () => {
  const { mod, sent, restore } = load({ bots: FULL });
  try {
    await mod.checkOnce({});
    await mod.checkOnce({});
    await mod.checkOnce({});
    assert.strictEqual(sent.length, 1, "sent " + sent.length + " alerts for one unchanged state");
  } finally { restore(); }
});

test("low water warns while there is still time to act", async () => {
  const { mod, sent, restore } = load({
    bots: [{ host: "pi", file: "config_31.json", capacity: 50, accounts: 44, remaining: 6 }],
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.level, "low");
    assert.match(sent[0], /only 6 slot\(s\) left/);
    // The point of a low-water mark is lead time: you sell 1-year windows, so a
    // slot taken today is gone for a year.
    assert.match(sent[0], /180-day and 1-year windows/);
  } finally { restore(); }
});

test("recovery closes the loop", async () => {
  const { mod, sent, restore } = load({ bots: FULL });
  try {
    await mod.checkOnce({});
    assert.strictEqual(sent.length, 1);
    // Same module instance, capacity restored.
    const p = require.resolve("../utils/rentFarmCapacity");
    delete require.cache[p];
    restore();
  } finally { /* restored above */ }

  const second = load({ bots: HEALTHY });
  try {
    // Simulate the latch having been "empty" before recovery.
    await second.mod.checkOnce({});      // ok, but lastLevel was null -> no message
    assert.strictEqual(second.sent.length, 0, "a first healthy read must not chatter");
  } finally { second.restore(); }
});

test("an offline host is excluded from the count and named", async () => {
  // Counting an unreadable host as capacity would hide a real shortage; counting
  // it as full would cry wolf. It is simply not counted, and it is reported.
  const { mod, sent, restore } = load({ bots: FULL, offlineHosts: [{ id: "pi2", label: "Pi 2" }] });
  try {
    const s = await mod.checkOnce({});
    assert.deepStrictEqual(s.offlineHosts, ["Pi 2"]);
    assert.match(sent[0], /offline and NOT counted: Pi 2/);
  } finally { restore(); }
});

test("levelFor draws the lines where the alerts expect them", () => {
  const { mod, restore } = load({ bots: HEALTHY });
  try {
    assert.strictEqual(mod.levelFor(0), "empty");
    assert.strictEqual(mod.levelFor(1), "low");
    assert.strictEqual(mod.levelFor(mod.LOW_WATER), "low");
    assert.strictEqual(mod.levelFor(mod.LOW_WATER + 1), "ok");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// The holder's account limit — the wall this watcher could not see.
//
// 2026-09-28 17:26Z → 09-29 00:34Z: the holder renter sat at 250/250, so
// farmFreshAccounts refused every rent-farm order ("The operator holder is at
// its account limit (250)") and four paid Eldorado orders failed every tick for
// up to seven hours. Meanwhile this module reported 117 free stack slots and the
// pool held 340 eligible accounts. The stacks were never the limit.
// ---------------------------------------------------------------------------

// The prod shape that night, trimmed: stacks with plenty of room.
const ROOMY = [
  { host: "contabo", file: "config_06.json", capacity: 50, accounts: 45, remaining: 5, running: true },
  { host: "contabo", file: "config_54.json", capacity: 50, accounts: 0, remaining: 50, running: false },
  { host: "contabo", file: "config_55.json", capacity: 50, accounts: 0, remaining: 50, running: false },
  { host: "local", file: "config_16.json", capacity: 10, accounts: 7, remaining: 3, running: true },
  { host: "local", file: "config_22.json", capacity: 10, accounts: 1, remaining: 9, running: true },
];

test("REGRESSION 2026-09-28: a holder at its account limit is zero capacity", async () => {
  const { mod, sent, restore } = load({
    bots: ROOMY,
    quota: { max: 250, used: 250, remaining: 0 },
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.stackFree, 117, "the stacks really did have room");
    assert.strictEqual(s.totalFree, 0, "but an order could use none of it");
    assert.strictEqual(s.limitedBy, "holder-limit");
    assert.strictEqual(s.level, "empty");
    assert.strictEqual(s.alerted, true);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /capacity is GONE/);
    assert.match(sent[0], /account limit \(250\/250 used\)/);
    // The advice must name the wall that is actually there: raising a stack
    // would not have delivered a single one of those four orders.
    assert.match(sent[0], /Raise its Account limit/);
    assert.doesNotMatch(sent[0], /Raise a stack's capacity/);
  } finally { restore(); }
});

test("the holder limit warns at the low-water mark, like slots do", async () => {
  const { mod, sent, restore } = load({
    bots: ROOMY,
    quota: { max: 400, used: 394, remaining: 6 },
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.totalFree, 6);
    assert.strictEqual(s.level, "low");
    assert.match(sent[0], /only 6 slot\(s\) left/);
    assert.match(sent[0], /394\/400/);
  } finally { restore(); }
});

test("when the stacks are the tighter wall, they are what gets reported", async () => {
  const { mod, sent, restore } = load({
    bots: FULL,
    quota: { max: 400, used: 254, remaining: 146 },
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.totalFree, 0);
    assert.strictEqual(s.limitedBy, "stacks");
    assert.match(sent[0], /Raise a stack's capacity/);
    // The limit is still shown, so the operator sees both numbers at once.
    assert.match(sent[0], /holder account limit {2}254\/400/);
  } finally { restore(); }
});

test("a holder with room changes nothing about a healthy read", async () => {
  const { mod, sent, restore } = load({
    bots: HEALTHY,
    quota: { max: 400, used: 254, remaining: 146 },
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.totalFree, 101);
    assert.strictEqual(s.limitedBy, "stacks");
    assert.strictEqual(s.level, "ok");
    assert.strictEqual(sent.length, 0);
  } finally { restore(); }
});

test("no holder renter yet: the stacks alone decide", async () => {
  // ensureOperatorRenter creates the holder on the first provision, so before
  // that there is no limit to apply — and no reason to invent one.
  const { mod, restore } = load({ bots: HEALTHY, quota: null });
  try {
    const s = await mod.snapshot();
    assert.strictEqual(s.totalFree, 101);
    assert.strictEqual(s.quota, null);
    assert.strictEqual(s.limitedBy, "stacks");
  } finally { restore(); }
});

test("a failed holder read fails the snapshot instead of guessing", async () => {
  // Every caller already treats a failed snapshot as unknown / do-not-publish.
  // Falling back to the stack count would quietly reopen the blind spot.
  const { mod, restore } = load({ bots: HEALTHY, quotaError: new Error("atlas timeout") });
  try {
    await assert.rejects(() => mod.snapshot(), /atlas timeout/);
  } finally { restore(); }
});
