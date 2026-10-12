// Automatic claiming of code rewards (docs/SOOP-FARM-CONTRACT.md §18), against
// the in-memory fake SOOP and the real models on an in-memory MongoDB. No network.
//
// What these exist to prevent:
//  1. A LOST CODE. A reward left unclaimed on a login that then stops working is
//     out of reach, and some rewards last a day. Whatever can be claimed is.
//  2. A CLAIM THAT SHOULD NOT HAPPEN. Claiming cannot be undone: never on a
//     sold account, never a link / form / in-game reward, never while switched off.
//  3. A CODE LEAK. The claimer handles codes and may not say one anywhere.
//  4. A STAMPEDE. One call to SOOP at a time, paced, whatever queues up.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-auto-claim-test-cred-secret";

const SoopAccount = require("../models/SoopAccount");
const SoopFarmTask = require("../models/SoopFarmTask");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const farm = require("../utils/soopFarm");
const { createActivityLog } = require("../utils/soop/activity");
const { createInventoryService } = require("../utils/soop/inventory");
const { createAutoClaimer } = require("../utils/soop/autoClaim");
const { alertsView } = require("../utils/soop/farmViews");
const { createFakeSoop } = require("./helpers/soopFake");

const HOUR = 3600 * 1000;
const RETRY_MS = 6 * HOUR;
const PENDING = "2차지급예정"; // what SOOP answers when it has run out of codes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail("timed out waiting for: " + label);
    await sleep(10);
  }
}

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([SoopAccount.init(), SoopInventoryItem.init()]);
});

test.after(async () => {
  await farm._reset();
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await farm._reset();
  await Promise.all([SoopAccount.deleteMany({}), SoopInventoryItem.deleteMany({}), SoopFarmTask.deleteMany({})]);
});

// A claimer on its own: the fake SOOP, the real inventory service, a clock the
// test moves by hand. `opts` go to createAutoClaimer.
function setup(opts = {}) {
  const clock = { t: Date.parse("2026-10-13T00:00:00Z") };
  const now = () => clock.t;
  const world = createFakeSoop({ now });
  const cookies = new Map();
  const clients = new Map();
  const wrap = new Map(); // id -> (client) => client, to slow one down
  const getClient = async (id) => {
    if (!clients.has(id)) {
      const c = world.clientFor(cookies.get(id), { id });
      clients.set(id, wrap.has(id) ? wrap.get(id)(c) : c);
    }
    return clients.get(id);
  };
  const activity = createActivityLog({ model: { insertMany: async () => [] }, flushMs: 60000, now });
  const inventory = createInventoryService({ getClient, activity, paceMs: 1, now });
  const auth = [];
  const waits = [];
  const claimer = createAutoClaimer({
    inventory,
    getClient,
    activity,
    onAuth: (id) => auth.push(id),
    paceMs: 0,
    checkPaceMs: 0,
    now,
    sleep: async (ms) => {
      waits.push(ms);
      clock.t += ms;
    },
    ...opts,
  });
  async function add(id, fields = {}) {
    cookies.set(id, world.addAccount({ id }));
    await SoopAccount.create({ loginId: id, status: "ok", ...fields });
    return id;
  }
  const rows = async (id) => Object.fromEntries((await SoopInventoryItem.find({ loginId: id }).lean()).map((r) => [r.name, r]));
  const said = () => JSON.stringify(activity.recent({ limit: 500 }));
  return { clock, world, inventory, claimer, activity, auth, waits, add, rows, wrap, said };
}

// ------------------------------------------------------------ what is claimed

test("a code reward is claimed and stored; everything else is left exactly as it was", async () => {
  const { world, claimer, add, rows, inventory } = setup();
  await add("acc1");
  world.addInventory("acc1", { itemName: "Code One", claimCode: "KEY-ONE-1111" });
  world.addInventory("acc1", { itemName: "Form Prize", itemType: "2", claimCode: "https://form.example/abc" });
  world.addInventory("acc1", { itemName: "In-game Coins", itemType: "4", ingameGiveYn: "Y", acctConn: false });
  world.addInventory("acc1", { itemName: "Code Needing A Link", ingameGiveYn: "Y", acctConn: false, claimCode: "NEVER-1" });
  world.addInventory("acc1", { itemName: "Ran Out", claimCode: "NEVER-2", expDate: "2020-01-01 00:00:00" });
  world.addInventory("acc1", { itemName: "Expired", claimCode: "NEVER-3" }, "expired");

  const out = await claimer.account("acc1", { sync: true });
  assert.deepEqual(
    { claimed: out.claimed, read: out.read, failed: out.failed, pending: out.pending, skipped: out.skipped, synced: out.synced },
    { claimed: 1, read: 0, failed: 0, pending: 0, skipped: null, synced: true },
  );
  assert.equal(world.calls().useInfo, 1, "exactly one reward was asked for");

  const r = await rows("acc1");
  assert.equal(r["Code One"].division, "acquired");
  assert.equal(r["Code One"].hasCode, true);
  assert.match(r["Code One"].codeEnc, /^enc:v1:/);
  assert.equal(await inventory.revealCode(String(r["Code One"]._id)), "KEY-ONE-1111");
  for (const name of ["Form Prize", "In-game Coins", "Code Needing A Link", "Ran Out"]) {
    assert.equal(r[name].division, "available", name + " stays unclaimed");
    assert.equal(r[name].hasCode, false, name + " has no code");
  }
  assert.equal(r["Expired"].division, "expired");

  // A second look asks SOOP for nothing.
  const again = await claimer.account("acc1");
  assert.equal(again.claimed, 0);
  assert.equal(world.calls().useInfo, 1);
});

test("nothing is claimed on a sold account, a logged-out one, or one the drops site refuses", async () => {
  const { world, claimer, add, clock } = setup();
  await add("sold1", { sold: true });
  await add("dead1", { status: "not_logged_in" });
  await add("refused1", { status: "drops_rejected" });
  const soon = new Date(clock.t + 30 * HOUR);
  const later = new Date(clock.t + 300 * HOUR);
  const past = new Date(clock.t - HOUR); // ran out an hour ago: nothing left to save
  for (const [id, exp] of [["sold1", soon], ["dead1", later], ["dead1", past], ["refused1", soon], ["refused1", later]]) {
    const raw = world.addInventory(id, { itemName: "Stuck Code " + exp.getTime(), claimCode: "STUCK-" + id });
    await SoopInventoryItem.create({
      loginId: id, key: raw.itemCodeIdx, division: "available", kind: "code", name: raw.itemName, expiresAt: exp, raw: { itemCodeIdx: raw.itemCodeIdx },
    });
  }
  const before = JSON.stringify(world.calls());

  assert.equal((await claimer.account("sold1")).skipped, "sold");
  assert.equal((await claimer.account("dead1")).skipped, "login");
  assert.equal((await claimer.account("refused1", { sync: true })).skipped, "login");
  assert.equal((await claimer.account("ghost")).skipped, "unknown");
  const sum = await claimer.sweep();
  assert.equal(sum.accounts, 0, "the sweep does not even look at them");
  assert.equal(JSON.stringify(world.calls()), before, "SOOP was not called at all");
  assert.equal(await SoopInventoryItem.countDocuments({ division: "available" }), 5);

  // The panel is told what is stuck, where, and how long it has.
  const w = await claimer.waiting();
  assert.deepEqual({ rewards: w.stuck.rewards, logins: w.stuck.logins }, { rewards: 3, logins: ["dead1", "refused1"] }, "not a sold account's rewards, and not one that has already run out");
  assert.equal(w.stuck.soonest.getTime(), soon.getTime());
  assert.equal(w.failed.rewards, 0);
  const alerts = alertsView({ egress: {}, accounts: [], sessions: new Map(), scan: null, inventoryTotals: null, claims: w, now: clock.t });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "claim");
  assert.equal(alerts[0].level, "warn");
  assert.match(alerts[0].msg, /^3 code reward\(s\) are waiting on 2 login\(s\) that cannot claim them \(dead1, refused1\) — re-import their cookies; the first runs out in 30 hours\.$/);
});

test("switched off, SOOP is asked for nothing; switched off mid-run, it stops within one call", async () => {
  let on = false;
  const s = setup({ enabled: () => on, paceMs: 5 });
  await s.add("acc1");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "Code " + n, claimCode: "SWITCH-" + n });
  await s.inventory.syncAccount("acc1");
  const before = JSON.stringify(s.world.calls());

  assert.equal((await s.claimer.account("acc1", { sync: true })).skipped, "off");
  assert.equal((await s.claimer.sweep()).stopped, "off");
  assert.equal(s.claimer.status().enabled, false);
  assert.equal(JSON.stringify(s.world.calls()), before, "off means not one call");

  // On again — and off at the first pause, which is before the second claim.
  on = true;
  const real = s.waits.length;
  const claimer = createAutoClaimer({
    inventory: s.inventory, getClient: async () => { throw new Error("not needed"); }, enabled: () => on, paceMs: 5, now: () => s.clock.t,
    sleep: async (ms) => { s.clock.t += ms; on = false; },
  });
  const out = await claimer.account("acc1");
  assert.equal(out.claimed, 2, "the call already decided on is made, the next is not");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", division: "available" }), 1);
  assert.equal(s.waits.length, real);
});

test("a switch that cannot be read counts as on", async () => {
  const s = setup({ enabled: () => { throw new Error("settings file unreadable"); } });
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Code", claimCode: "STILL-CLAIMED-1" });
  assert.equal((await s.claimer.account("acc1", { sync: true })).claimed, 1);
  assert.equal(s.claimer.status().enabled, true);
});

// ------------------------------------------------------------------- pacing

test("one account at a time and one call to SOOP per pace, however much queues up", async () => {
  const s = setup({ paceMs: 7000 });
  await s.add("acc1");
  await s.add("acc2");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "A" + n, claimCode: "PACE-A" + n });
  for (const n of [1, 2]) s.world.addInventory("acc2", { itemName: "B" + n, claimCode: "PACE-B" + n });

  // Everything asked at once, the same account twice.
  const [a, a2, b] = await Promise.all([
    s.claimer.account("acc1", { sync: true }),
    s.claimer.account("acc1", { sync: true }),
    s.claimer.account("acc2", { sync: true }),
  ]);
  assert.equal(a, a2, "a run that has not started yet is not queued twice");
  assert.equal(a.claimed + b.claimed, 5);
  assert.equal(s.world.calls().useInfo, 5, "each reward asked for once");
  assert.deepEqual(s.waits, [7000, 7000, 7000, 7000], "a full pace between every two claims, across accounts");

  const at = async (id) => (await SoopInventoryItem.find({ loginId: id }).lean()).map((r) => r.claimedAt.getTime());
  assert.ok(Math.max(...(await at("acc1"))) < Math.min(...(await at("acc2"))), "acc1 was finished before acc2 was started");
  assert.equal(s.claimer.status().running, false);
  assert.equal(s.claimer.status().claimed, 5);
});

// ------------------------------------------------------- when SOOP says no

test("a reward SOOP has no code for yet is claimed once, left alone, and its code read back later", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "Out Of Stock", claimCode: PENDING });

  const first = await s.claimer.account("acc1", { sync: true });
  assert.deepEqual({ claimed: first.claimed, pending: first.pending, failed: first.failed }, { claimed: 0, pending: 1, failed: 0 });
  let row = (await s.rows("acc1"))["Out Of Stock"];
  assert.equal(row.division, "acquired", "the reward is claimed: SOOP owes the code");
  assert.equal(row.hasCode, false);
  assert.equal(row.codeEnc, "", "the placeholder is never stored as a code");
  assert.equal(row.claim.kind, "pending");
  assert.equal(row.auto.tries, 1);
  assert.equal(s.world.calls().useInfo, 1);

  // Not hammered: nothing more until the retry time has passed.
  s.clock.t += RETRY_MS - 1000;
  await s.claimer.account("acc1");
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, 1);

  // Still nothing at the retry time; then SOOP delivers.
  s.clock.t += 2000;
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  assert.equal(s.world.calls().useInfo, 2);
  s.world.setClaimCode("acc1", raw.itemCodeIdx, "LATE-CODE-777");
  s.clock.t += RETRY_MS + 1000;
  const later = await s.claimer.account("acc1");
  assert.equal(later.read, 1);
  row = (await s.rows("acc1"))["Out Of Stock"];
  assert.equal(row.hasCode, true);
  assert.equal(row.auto, null);
  assert.equal(await s.inventory.revealCode(String(row._id)), "LATE-CODE-777");
});

test("a reward SOOP reissues is claimed as its new item, in the same run", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Reissued", claimCode: "RENEWED-CODE-5", renewFlag: "Y" });
  const out = await s.claimer.account("acc1", { sync: true });
  assert.equal(out.claimed, 1);
  assert.equal(s.world.calls().useInfo, 2, "the old item once, the new item once");
  const all = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.equal(all.length, 1, "the withdrawn item is gone from the stored copy");
  assert.equal(all[0].division, "acquired");
  assert.equal(await s.inventory.revealCode(String(all[0]._id)), "RENEWED-CODE-5");
});

test("a claim SOOP refuses is recorded on the reward and tried again only after the retry time", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Refused " + n, claimCode: "REF-" + n });
  s.world.addInventory("acc2", { itemName: "Fine", claimCode: "FINE-1" });
  s.world.refuseClaims("acc1");

  const sum = await s.claimer.sweep();
  assert.deepEqual({ accounts: sum.accounts, claimed: sum.claimed, failed: sum.failed, stopped: sum.stopped }, { accounts: 2, claimed: 1, failed: 2, stopped: null }, "one account's refusals do not stop the next");
  let r = await s.rows("acc1");
  assert.equal(r["Refused 1"].division, "available");
  assert.deepEqual({ tries: r["Refused 1"].auto.tries, error: r["Refused 1"].auto.error }, { tries: 1, error: "Rewards cannot be handed out right now." });
  const w = await s.claimer.waiting();
  assert.deepEqual({ stuck: w.stuck.rewards, failed: w.failed.rewards, error: w.failed.error }, { stuck: 0, failed: 2, error: "Rewards cannot be handed out right now." });
  const alerts = alertsView({ egress: {}, accounts: [], sessions: new Map(), scan: null, inventoryTotals: null, claims: w, now: s.clock.t });
  assert.match(alerts[0].msg, /^2 code reward\(s\) could not be claimed automatically \(Rewards cannot be handed out right now\.\)/);
  assert.match(s.said(), /2 rewards on acc1 could not be claimed automatically/);

  const asked = s.world.calls().useInfo;
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, asked, "not asked again before the retry time");

  s.world.refuseClaims("acc1", false);
  s.clock.t += RETRY_MS + 1000;
  assert.equal((await s.claimer.sweep()).claimed, 2);
  r = await s.rows("acc1");
  assert.equal(r["Refused 1"].auto, null, "the failure is forgotten once the code is in");
  assert.equal((await s.claimer.waiting()).failed.rewards, 0);
});

test("a login SOOP refuses while claiming stops that account only, and is handed to the health check once", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Unreachable " + n, claimCode: "AUTH-" + n });
  s.world.addInventory("acc2", { itemName: "Reachable", claimCode: "OK-1" });
  await s.inventory.syncAccount("acc1");
  s.world.rejectDrops("acc1");

  const [a, b] = await Promise.all([s.claimer.account("acc1"), s.claimer.account("acc2", { sync: true })]);
  assert.equal(a.error, "auth");
  assert.equal(a.claimed, 0);
  assert.equal(b.claimed, 1, "the queue went on to the next account");
  assert.deepEqual(s.auth, ["acc1"]);
  assert.equal(s.world.calls().useInfo, 2, "acc1 was asked once, not once per reward");
  const r = await s.rows("acc1");
  assert.equal(r["Unreachable 1"].auto, null, "a dead login is not the reward's failure");
  assert.match(s.said(), /SOOP refused acc1 while its rewards were being claimed/);
});

test("a dead tunnel marks nothing and stops the sweep; the next sweep claims", async () => {
  const s = setup();
  for (const id of ["acc1", "acc2", "acc3"]) {
    await s.add(id);
    s.world.addInventory(id, { itemName: "Tunnel " + id, claimCode: "TUN-" + id });
  }
  s.world.setEgress({ down: true });
  const down = await s.claimer.sweep();
  assert.equal(down.accounts, 1, "it does not try the other logins through a dead tunnel");
  assert.match(down.stopped, /Could not reach SOOP/);
  assert.equal(await SoopInventoryItem.countDocuments({}), 0);
  assert.deepEqual(s.auth, [], "a tunnel failure is never read as a dead login");

  s.world.setEgress({ down: false });
  const up = await s.claimer.sweep();
  assert.deepEqual({ accounts: up.accounts, synced: up.synced, claimed: up.claimed, stopped: up.stopped }, { accounts: 3, synced: 3, claimed: 3, stopped: null });
  assert.equal(s.claimer.status().lastSweep.claimed, 3);
});

// ------------------------------------------------------------------ the sweep

test("the sweep costs one small call per login and reads an inventory only when it changed", async () => {
  const s = setup();
  for (const id of ["acc1", "acc2", "acc3"]) await s.add(id);
  s.world.addInventory("acc3", { itemName: "Known", claimCode: "KNOWN-1" }, "acquired");
  await s.inventory.syncAccount("acc3");
  await s.claimer.account("acc3"); // reads the hand-claimed code back
  s.world.addInventory("acc1", { itemName: "New", claimCode: "NEW-1" }); // SOOP has it, the stored copy does not
  const c0 = s.world.calls();

  const sum = await s.claimer.sweep();
  const c1 = s.world.calls();
  assert.deepEqual({ accounts: sum.accounts, synced: sum.synced, claimed: sum.claimed, read: sum.read }, { accounts: 3, synced: 1, claimed: 1, read: 0 });
  assert.equal(c1.inventoryCounts - c0.inventoryCounts, 3 + 2, "one check per login, plus the two syncs of acc1 (before and after the claim)");
  assert.equal(c1.inventory - c0.inventory, 6, "three lists, twice, for acc1 only");
  assert.equal(c1.useInfo - c0.useInfo, 1);

  // Nothing changed since: three checks, and that is all.
  const quiet = await s.claimer.sweep();
  const c2 = s.world.calls();
  assert.deepEqual({ synced: quiet.synced, claimed: quiet.claimed }, { synced: 0, claimed: 0 });
  assert.equal(c2.inventoryCounts - c1.inventoryCounts, 3);
  assert.equal(c2.inventory - c1.inventory, 0);
  assert.equal(c2.useInfo - c1.useInfo, 0);
});

test("a reward claimed by hand on SOOP has its code read back and stored", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "By Hand", claimCode: "HAND-CODE-42" }, "acquired");
  const sum = await s.claimer.sweep();
  assert.deepEqual({ synced: sum.synced, claimed: sum.claimed, read: sum.read }, { synced: 1, claimed: 0, read: 1 });
  const row = (await s.rows("acc1"))["By Hand"];
  assert.equal(row.hasCode, true);
  assert.equal(await s.inventory.revealCode(String(row._id)), "HAND-CODE-42");
  assert.match(s.said(), /Read back the code of 1 claimed reward on acc1/);
});

// ------------------------------------------------- what a sync may not undo

test("a claim made while a sync is reading is not undone by that sync", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Raced", claimCode: "RACE-CODE-1" });
  let hold = null;
  s.wrap.set("acc1", (c) => ({
    ...c,
    // The last of the three lists: by now "unclaimed" and "claimed" are both read.
    inventory: async (division) => {
      const out = await c.inventory(division);
      if (division === "expired" && hold) await hold;
      return out;
    },
  }));
  await s.inventory.syncAccount("acc1");
  const id = String((await s.rows("acc1"))["Raced"]._id);

  let release;
  hold = new Promise((r) => (release = r));
  s.clock.t += 1000;
  const slow = s.inventory.syncAccount("acc1"); // has read the reward as unclaimed
  await sleep(30);
  s.clock.t += 1000;
  const claimed = await s.inventory.claim(id, { sync: false });
  assert.equal(claimed.result.kind, "code");
  hold = null;
  release();
  await slow;

  const row = (await s.rows("acc1"))["Raced"];
  assert.equal(row.division, "acquired", "the stale read did not put it back to unclaimed");
  assert.equal(row.hasCode, true);
  // And a claimer that starts in the middle of a sync waits for it.
  s.world.addInventory("acc1", { itemName: "Second", claimCode: "RACE-CODE-2" });
  hold = new Promise((r) => (release = r));
  s.clock.t += 1000;
  const reading = s.inventory.syncAccount("acc1");
  let done = false;
  const run = s.claimer.account("acc1").then((o) => ((done = true), o));
  await sleep(40);
  assert.equal(done, false, "the claimer is waiting for the sync to finish");
  hold = null;
  release();
  await reading;
  assert.equal((await run).claimed, 1);
});

test("a row holding a code survives SOOP no longer listing it; a row without one does not", async () => {
  const s = setup();
  await s.add("acc1");
  const kept = s.world.addInventory("acc1", { itemName: "Has A Code", claimCode: "KEEP-ME-1" });
  const gone = s.world.addInventory("acc1", { itemName: "Form Only", itemType: "2" });
  assert.equal((await s.claimer.account("acc1", { sync: true })).claimed, 1);

  s.world.removeInventory("acc1", kept.itemCodeIdx);
  s.world.removeInventory("acc1", gone.itemCodeIdx);
  s.clock.t += HOUR;
  await s.inventory.syncAccount("acc1");
  let r = await s.rows("acc1");
  assert.deepEqual(Object.keys(r), ["Has A Code"], "the row without a code is deleted as before");
  assert.equal(r["Has A Code"].goneAt.getTime(), s.clock.t);
  assert.equal(await s.inventory.revealCode(String(r["Has A Code"]._id)), "KEEP-ME-1");

  // The first day it went missing is kept, and it does not make every sweep re-read the account.
  const gone1 = r["Has A Code"].goneAt.getTime();
  s.clock.t += HOUR;
  await s.inventory.syncAccount("acc1");
  assert.equal((await s.rows("acc1"))["Has A Code"].goneAt.getTime(), gone1);
  const lists = s.world.calls().inventory;
  await s.claimer.sweep();
  assert.equal(s.world.calls().inventory, lists, "a row SOOP dropped is not counted against SOOP's counters");

  // Listed again: it is an ordinary row again.
  s.world.addInventory("acc1", { itemName: "Has A Code", itemCodeIdx: kept.itemCodeIdx, claimCode: "KEEP-ME-1" }, "acquired");
  s.clock.t += HOUR;
  await s.inventory.syncAccount("acc1");
  r = await s.rows("acc1");
  assert.equal(r["Has A Code"].goneAt, null);
  assert.equal(r["Has A Code"].hasCode, true);
});

// ------------------------------------------------------------------- secrets

test("no code is ever said: not in the log, the status, the alerts or a result", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2", { status: "not_logged_in" });
  const codes = ["LEAK-AAAA-1111", "LEAK-BBBB-2222", "LEAK-CCCC-3333", "LEAK-DDDD-4444"];
  s.world.addInventory("acc1", { itemName: "One", claimCode: codes[0] });
  s.world.addInventory("acc1", { itemName: "Two", claimCode: codes[1], renewFlag: "Y" });
  s.world.addInventory("acc1", { itemName: "Three", claimCode: codes[2] }, "acquired");
  const stuck = s.world.addInventory("acc2", { itemName: "Four", claimCode: codes[3] });
  await SoopInventoryItem.create({ loginId: "acc2", key: stuck.itemCodeIdx, division: "available", kind: "code", name: "Four", raw: { itemCodeIdx: stuck.itemCodeIdx } });

  const results = [await s.claimer.sweep(), await s.claimer.account("acc1", { sync: true }), await s.claimer.account("acc2")];
  const waiting = await s.claimer.waiting();
  const alerts = alertsView({ egress: {}, accounts: [], sessions: new Map(), scan: null, inventoryTotals: null, claims: waiting, now: s.clock.t });
  const everything = JSON.stringify([results, waiting, alerts, s.claimer.status(), await s.inventory.forAccount("acc1")]) + s.said();
  for (const c of codes) assert.ok(!everything.includes(c), "a reward code leaked: " + c.slice(0, 9));
  assert.ok(!everything.includes("enc:v1:"), "ciphertext leaked");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", hasCode: true }), 3, "and yet all three codes are stored");
});

// ----------------------------------------------------------- inside the farm

const FAST = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 300, flatPolls: 3, backoffMs: [40], readFailures: 3, primePaceMs: 1, parkCooldownMs: 60, inventoryAfterStepMs: 25, inventoryRetryMs: 40 };
let world;
const tickets = new Map();

async function freshFarm({ rewards = true } = {}) {
  await farm._reset({ store: { ttlMs: 15 }, autoClaim: { paceMs: 0, checkPaceMs: 0 } });
  world = createFakeSoop({ rewards });
  tickets.clear();
  farm.setClientFactory(world.clientFor);
  farm.timings = FAST;
  farm.autoInventory = true;
}

async function importAccount(id) {
  if (!tickets.has(id)) tickets.set(id, world.addAccount({ id }));
  const [r] = await farm.importAccounts(JSON.stringify(tickets.get(id)));
  assert.equal(r.ok, true, r.error);
  return id;
}

const coded = (id) => SoopInventoryItem.countDocuments({ loginId: id, hasCode: true });

test("farm: each reward is claimed as soon as its step is reached, with nobody asking", async () => {
  await freshFarm();
  const camp = world.addCampaign({ live: true, itemList: [2, 4] });
  await importAccount("acc1");
  await farm.campaignsView({ force: true });
  const { ok, error } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(ok, true, error);

  for (let i = 0; i < 60 && (await coded("acc1")) < 2; i++) {
    world.advance(1);
    await sleep(40);
  }
  assert.equal(await coded("acc1"), 2, "both steps' codes are stored");
  assert.equal(world.calls().useInfo, 2, "each claimed exactly once");
  const rows = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.ok(rows.every((r) => r.division === "acquired" && /^enc:v1:/.test(r.codeEnc)));
  const state = await farm.stateView();
  assert.equal(state.autoClaim.enabled, true);
  assert.equal(state.autoClaim.claimed, 2);
  assert.ok(state.autoClaim.lastClaimAt);
  const body = JSON.stringify(state) + JSON.stringify(farm.activity.recent({ limit: 500 }));
  assert.ok(!/CODE-acc1-/.test(body), "the state and the log never hold a code");
});

test("farm: a reward SOOP hands out late is still found — the sync looks again, and then stops looking", async () => {
  await freshFarm({ rewards: false });
  const camp = world.addCampaign({ live: true, itemList: [2] });
  await importAccount("acc1");
  await farm.campaignsView({ force: true });
  await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  const counts = () => world.calls().inventoryCounts;
  const c0 = counts();
  for (let i = 0; i < 60 && counts() === c0; i++) {
    world.advance(1);
    await sleep(40);
  }
  assert.ok(counts() > c0, "the step was followed by a sync");
  assert.equal(await coded("acc1"), 0, "nothing there yet");
  world.addInventory("acc1", { itemName: "Late Reward", claimCode: "LATE-FARM-1" }); // SOOP hands it out now
  await until(async () => (await coded("acc1")) === 1, "the second look claims it");

  // A step whose reward never shows up is looked for three times in all, no more.
  await freshFarm({ rewards: false });
  const other = world.addCampaign({ live: true, itemList: [2] });
  await importAccount("acc2");
  await farm.campaignsView({ force: true });
  await farm.createBot({ mode: "campaign", dropsIdx: other.dropsIdx, accountIds: ["acc2"] });
  const base = counts();
  for (let i = 0; i < 60 && counts() === base; i++) {
    world.advance(1);
    await sleep(40);
  }
  await sleep(400);
  assert.equal(counts() - base, 3, "the first sync and two more looks");
});

test("farm: re-importing the cookie of a login whose rewards were stuck claims them at once", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  await sleep(50);
  world.addInventory("acc1", { itemName: "Stuck One", claimCode: "STUCK-FARM-1" });
  world.addInventory("acc1", { itemName: "Stuck Two", claimCode: "STUCK-FARM-2" });
  await farm.inventory.syncAccount("acc1");
  world.rejectDrops("acc1");
  await farm.health.check("acc1");
  assert.equal((await SoopAccount.findOne({ loginId: "acc1" }).lean()).status, "drops_rejected");
  assert.equal((await farm.autoClaim.account("acc1")).skipped, "login");

  // The alert says what is at stake while it is stuck.
  farm.claimView = { at: 0, value: null };
  let state = await farm.stateView();
  const alert = state.alerts.find((a) => a.kind === "claim");
  assert.match(alert.msg, /^2 code reward\(s\) are waiting on 1 login\(s\) that cannot claim them \(acc1\)/);
  assert.equal(state.autoClaim.waiting, 2);

  world.rejectDrops("acc1", false);
  await importAccount("acc1"); // the owner signs it in again and imports the export
  await until(async () => (await coded("acc1")) === 2, "both stuck rewards claimed after the import");
  assert.equal(world.calls().useInfo, 2);
  farm.claimView = { at: 0, value: null };
  state = await farm.stateView();
  assert.equal(state.alerts.filter((a) => a.kind === "claim").length, 0);
  assert.equal(state.autoClaim.waiting, 0);
});

test("farm: deleting an account keeps the rows that hold a code", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Sellable", claimCode: "KEEP-FARM-1" });
  world.addInventory("acc1", { itemName: "Just A Form", itemType: "2" });
  assert.equal((await farm.autoClaim.account("acc1", { sync: true })).claimed, 1);
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 2);

  assert.equal(await farm.deleteAccounts(["acc1"]), 1);
  const left = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.deepEqual(left.map((r) => r.name), ["Sellable"]);
  assert.equal(await farm.inventory.revealCode(String(left[0]._id)), "KEEP-FARM-1", "the code can still be read with the account gone");
});

test("farm: with automatic inventory off (tests, a side script) an import claims nothing", async () => {
  await freshFarm({ rewards: false });
  farm.autoInventory = false;
  world.addAccount({ id: "acc1" });
  tickets.set("acc1", world.addAccount({ id: "acc1" }));
  world.addInventory("acc1", { itemName: "Untouched", claimCode: "UNTOUCHED-1" });
  await importAccount("acc1");
  await sleep(120);
  assert.equal(world.calls().useInfo, 0);
  assert.equal(world.calls().inventory, 0);
});
