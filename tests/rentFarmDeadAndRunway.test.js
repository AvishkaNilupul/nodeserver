// Two alarms the rent-farm capacity watcher never raised (2026-10-01):
//   - a rental stack that HOLDS accounts but whose container is stopped, or
//     whose config is missing/unreadable (every buyer on it farms nothing, and
//     a plain `docker stop` is treated as intentional by the host watchdog);
//   - runway in DAYS: "10 slots left" was ~1 day of notice at ~10 sales/day,
//     and the pristine pool had no push at all until an order failed.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const sent = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]rentFarmCapacity\.js$/.test(parent.filename || "")) {
    if (request === "./telegram") return { sendTelegram: async (m) => { sent.push(m); } };
    if (request === "./systemLog") return { logEvent: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
};
const cap = require("../utils/rentFarmCapacity");
test.after(() => { Module._load = realLoad; });

let clock = 1_700_000_000_000;
function setup(over = {}) {
  sent.length = 0;
  cap._reset();
  cap.__setDeps({ now: () => clock, ...over });
}

const BOTS = (states) => ({
  bots: [
    { host: "contabo", file: "config_03.json", physical: 49, accounts: 49, running: states.x3 },
    { host: "contabo", file: "config_55.json", physical: 0, accounts: 0, running: false },
  ],
  offlineHosts: [],
});

test("REGRESSION: a stack holding accounts with its container stopped pages — once, then every 6 h, and recovers", async () => {
  let states = { x3: false };
  setup({
    rentalStackOptions: async () => BOTS(states),
    listStacks: async () => [{ host: "contabo", file: "config_03.json" }, { host: "contabo", file: "config_55.json" }],
  });
  let r = await cap.deadStacksCheck();
  assert.deepEqual(r.paged, ["contabo/config_03.json"], "an EMPTY stopped stack is fine (it starts on first delivery)");
  assert.match(sent[0], /contabo\/config_03\.json \(49 accounts\) — its container is NOT running/);
  clock += 30 * 60000;
  r = await cap.deadStacksCheck();
  assert.equal(sent.length, 1, "no page every 30 minutes");
  clock += 6 * 3600000;
  await cap.deadStacksCheck();
  assert.equal(sent.length, 2, "reminded after 6 h");
  states = { x3: true };
  await cap.deadStacksCheck();
  assert.match(sent[2], /contabo\/config_03\.json is farming again/);
});

test("a registered stack whose config is missing pages; an offline host's stacks do not", async () => {
  setup({
    rentalStackOptions: async () => ({ bots: [], offlineHosts: [{ id: "pi" }] }),
    listStacks: async () => [{ host: "contabo", file: "config_40.json" }, { host: "pi", file: "config_31.json" }],
  });
  const r = await cap.deadStacksCheck();
  assert.deepEqual(r.paged, ["contabo/config_40.json"]);
  assert.match(sent[0], /config file is missing or unreadable/);
});

test("runwayLevel draws the lines at 10 and 4 days", () => {
  assert.equal(cap.runwayLevel(null), "ok");
  assert.equal(cap.runwayLevel(30), "ok");
  assert.equal(cap.runwayLevel(9.9), "warn");
  assert.equal(cap.runwayLevel(3.5), "critical");
});

test("REGRESSION: slots and pool runway are paged in days, once per level, daily while critical", async () => {
  let free = 90;
  let eligible = 200;
  setup({
    holderId: async () => "h1",
    // 70 new windows in 7 days, none ended: 10/day taken, 10/day net.
    countRows: async (q) => (q.createdAt ? 70 : 0),
    snapshot: async () => ({ totalFree: free }),
    gatherPoolEligibility: async () => ({ eligible: new Array(eligible).fill({}) }),
  });
  let out = await cap.runwayCheck();
  assert.equal(out.slotDays, 9, "90 slots / 10 a day");
  assert.equal(out.poolDays, 20);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /rental stack slots run out in about 9 day\(s\) \(90 free, ~10\/day net\)/);
  // Same level next tick: quiet.
  await cap.runwayCheck();
  assert.equal(sent.length, 1);
  // Pool drops to 3 days: critical page; then daily reminders only.
  eligible = 30;
  await cap.runwayCheck();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /🛑 Rent-farm pristine pool accounts run out in about 3 day\(s\)/);
  clock += 12 * 3600000;
  await cap.runwayCheck();
  assert.equal(sent.length, 2, "not every tick");
  clock += 13 * 3600000;
  await cap.runwayCheck();
  assert.equal(sent.length, 3, "daily reminder while critical");
  // Restocked: one all-clear.
  eligible = 500;
  free = 400;
  await cap.runwayCheck();
  assert.ok(sent.some((m) => /pristine pool accounts runway is healthy again/.test(m)));
  assert.ok(sent.some((m) => /rental stack slots runway is healthy again/.test(m)));
});

test("no sales in 7 days means no runway alarm", async () => {
  setup({
    holderId: async () => "h1",
    countRows: async () => 0,
    snapshot: async () => ({ totalFree: 3 }),
    gatherPoolEligibility: async () => ({ eligible: [] }),
  });
  const out = await cap.runwayCheck();
  assert.equal(out.slotDays, null);
  assert.equal(sent.length, 0);
});
