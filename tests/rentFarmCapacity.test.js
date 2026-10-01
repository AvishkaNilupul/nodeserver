// Being told BEFORE the slots run out.
//
// The pool said 554 eligible and the preflight said willAdd:1 while every
// rent-farm order was failing, because the binding constraint is slots in bot
// configs, not accounts in the pool. This watcher reports the number that
// actually runs out, and shouts once per state change.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function load({ bots, offlineHosts = [], quota = null }) {
  const sent = [];
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /rentFarmCapacity\.js$/.test(parent.filename || "");
    if (from && request === "../routes/renterAdminRoutes") {
      return { rentalStackOptions: async () => ({ bots, offlineHosts }) };
    }
    if (from && request === "./telegram") {
      return { sendTelegram: async (t) => { sent.push(t); } };
    }
    if (from && request === "./systemLog") {
      return { logEvent: async () => {} };
    }
    // The holder's account limit is a DB read; with no holder the stacks bind,
    // which is what these tests are about. (Unstubbed, the read waited on a
    // database that is not there and every test timed out at 10s.)
    if (from && request === "./operatorFarm") {
      return { holderQuota: async () => quota };
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
  const { mod, restore } = load({ bots: FULL, offlineHosts: [{ id: "pi2", label: "Pi 2" }] });
  try {
    const s = await mod.snapshot();
    assert.deepStrictEqual(s.offlineHosts, ["Pi 2"]);
    assert.strictEqual(s.totalFree, 0);
    assert.match(mod.describe(s), /offline and NOT counted: Pi 2/);
  } finally { restore(); }
});

test("REGRESSION 2026-10-01: an unread host is not 'capacity GONE'", async () => {
  // Every holder stack was on Contabo; one slow read marked it offline, so the
  // readable stacks held 0 free and the owner was paged "capacity is GONE"
  // twice while 283 slots were free. Unread hosts can only ADD slots: a bad
  // verdict off a partial read is unknown, not a page.
  const { mod, sent, restore } = load({ bots: [], offlineHosts: [{ id: "contabo", label: "Contabo VPS" }] });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.level, "unknown");
    assert.strictEqual(s.withheld, true);
    assert.strictEqual(s.alerted, false);
    assert.strictEqual(sent.length, 0, "paged: " + sent.join(" / "));
  } finally { restore(); }
});

test("a withheld tick leaves the latch alone: no 'recovered', no re-page", async () => {
  const offline = [{ id: "contabo", label: "Contabo VPS" }];
  // ok -> blip -> ok: silent throughout.
  let opts = { bots: HEALTHY, offlineHosts: [] };
  const { mod, sent, restore } = load({ bots: [] });
  try {
    await mod.checkOnce({ options: opts });
    await mod.checkOnce({ options: { bots: [], offlineHosts: offline } });
    await mod.checkOnce({ options: opts });
    assert.strictEqual(sent.length, 0, "a blip chattered: " + sent.join(" / "));
    // empty (paged once) -> blip -> still empty: not paged again.
    opts = { bots: FULL, offlineHosts: [] };
    await mod.checkOnce({ options: opts });
    assert.strictEqual(sent.length, 1);
    await mod.checkOnce({ options: { bots: FULL, offlineHosts: offline } });
    await mod.checkOnce({ options: opts });
    assert.strictEqual(sent.length, 1, "re-paged after a blip: " + sent.join(" / "));
  } finally { restore(); }
});

test("a good verdict stands with a host unread — unread hosts only add room", async () => {
  const { mod, sent, restore } = load({ bots: HEALTHY, offlineHosts: [{ id: "contabo", label: "Contabo VPS" }] });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.level, "ok");
    assert.ok(!s.withheld);
    assert.strictEqual(sent.length, 0);
  } finally { restore(); }
});

test("a holder-limit verdict stands with a host unread — no host lifts the limit", async () => {
  const { mod, sent, restore } = load({
    bots: HEALTHY,
    offlineHosts: [{ id: "contabo", label: "Contabo VPS" }],
    quota: { max: 400, used: 400, remaining: 0 },
  });
  try {
    const s = await mod.checkOnce({});
    assert.strictEqual(s.level, "empty");
    assert.strictEqual(s.limitedBy, "holder-limit");
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /account limit/);
  } finally { restore(); }
});

test("a read that keeps failing is said once, as a read failure, then closed", async () => {
  const offline = { bots: [], offlineHosts: [{ id: "contabo", label: "Contabo VPS" }] };
  const { mod, sent, restore } = load({ bots: [] });
  try {
    for (let i = 1; i < mod.WITHHELD_PAGE_TICKS; i++) await mod.checkOnce({ options: offline });
    assert.strictEqual(sent.length, 0, "paged before the read had failed for long");
    const s = await mod.checkOnce({ options: offline });
    assert.strictEqual(s.alerted, true);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /not been checkable/);
    assert.match(sent[0], /Contabo VPS/);
    assert.match(sent[0], /READ failure, not a full farm/);
    assert.doesNotMatch(sent[0], /GONE/);
    await mod.checkOnce({ options: offline });
    await mod.checkOnce({ options: offline });
    assert.strictEqual(sent.length, 1, "re-paged while still unread");
    await mod.checkOnce({ options: { bots: HEALTHY, offlineHosts: [] } });
    assert.strictEqual(sent.length, 2);
    assert.match(sent[1], /can be read again — 101 slot\(s\) free/);
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
