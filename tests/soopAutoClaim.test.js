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
const { SoopError } = require("../utils/soop/errors");
const { createActivityLog } = require("../utils/soop/activity");
const { createInventoryService } = require("../utils/soop/inventory");
const { createAutoClaimer } = require("../utils/soop/autoClaim");
const { alertsView } = require("../utils/soop/farmViews");
const { createFakeSoop } = require("./helpers/soopFake");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RETRY_MS = 30 * MIN; // before a refused claim is tried again
const OWED_MS = 5.5 * HOUR; // before an owed code is asked for again
const UNANSWERED_MS = 5 * MIN; // before a reward whose claim got no answer is tried again
const PENDING = "2차지급예정"; // what SOOP answers when it has run out of codes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SOOP's dates are Korea wall-clock strings.
const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 19).replace("T", " ");

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

const noAlerts = { egress: {}, accounts: [], sessions: new Map(), scan: null, inventoryTotals: null };

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
  const checks = [];
  const waits = [];
  // What the farm's health check answers: does the drops site take this login?
  const checkLogin = async (id) => {
    checks.push(id);
    const c = await getClient(id);
    if (!(await c.privateInfo()).loggedIn) return { dropsOk: false };
    try {
      await c.missions();
      return { dropsOk: true };
    } catch {
      return { dropsOk: false };
    }
  };
  const make = (more = {}) =>
    createAutoClaimer({
      inventory,
      activity,
      checkLogin,
      paceMs: 0,
      checkPaceMs: 0,
      now,
      sleep: async (ms) => {
        waits.push(ms);
        clock.t += ms;
      },
      ...opts,
      ...more,
    });
  async function add(id, fields = {}) {
    cookies.set(id, world.addAccount({ id }));
    await SoopAccount.create({ loginId: id, status: "ok", ...fields });
    return id;
  }
  const rows = async (id) => Object.fromEntries((await SoopInventoryItem.find({ loginId: id }).lean()).map((r) => [r.name, r]));
  const said = () => JSON.stringify(activity.recent({ limit: 500 }));
  return { clock, world, inventory, claimer: make(), make, activity, checks, waits, add, rows, wrap, said };
}

// ------------------------------------------------------------ what is claimed

test("a code reward is claimed and stored; everything else is left exactly as it was", async () => {
  const { world, claimer, add, rows, inventory } = setup();
  await add("acc1");
  world.addInventory("acc1", { itemName: "Code One", claimCode: "KEY-ONE-1111" });
  world.addInventory("acc1", { itemName: "Form Prize", itemType: "2", claimCode: "https://form.example/abc" });
  world.addInventory("acc1", { itemName: "In-game Coins", itemType: "4", ingameGiveYn: "Y", acctConn: false });
  world.addInventory("acc1", { itemName: "Code Needing A Link", ingameGiveYn: "Y", acctConn: false, claimCode: "NEVER-1" });
  // A game account IS linked, so SOOP asks for no link — and a claim would send it there.
  world.addInventory("acc1", { itemName: "Code For A Linked Game", ingameGiveYn: "Y", acctConn: true, claimCode: "NEVER-4" });
  world.addInventory("acc1", { itemName: "Ran Out", claimCode: "NEVER-2", expDate: "2020-01-01 00:00:00" });
  world.addInventory("acc1", { itemName: "Expired", claimCode: "NEVER-3" }, "expired");

  const out = await claimer.account("acc1");
  assert.deepEqual(
    { claimed: out.claimed, read: out.read, failed: out.failed, pending: out.pending, skipped: out.skipped, synced: out.synced, added: out.added },
    { claimed: 1, read: 0, failed: 0, pending: 0, skipped: null, synced: true, added: 7 },
  );
  assert.equal(world.calls().useInfo, 1, "exactly one reward was asked for");

  const r = await rows("acc1");
  assert.equal(r["Code One"].division, "acquired");
  assert.equal(r["Code One"].hasCode, true);
  assert.match(r["Code One"].codeEnc, /^enc:v1:/);
  assert.equal(await inventory.revealCode(String(r["Code One"]._id)), "KEY-ONE-1111");
  for (const name of ["Form Prize", "In-game Coins", "Code Needing A Link", "Code For A Linked Game", "Ran Out"]) {
    assert.equal(r[name].division, "available", name + " stays unclaimed");
    assert.equal(r[name].hasCode, false, name + " has no code");
  }
  assert.equal(r["Expired"].division, "expired");

  // A second look asks SOOP for nothing.
  const again = await claimer.account("acc1");
  assert.deepEqual({ claimed: again.claimed, added: again.added }, { claimed: 0, added: 0 });
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
  assert.equal((await claimer.account("refused1", { force: true })).skipped, "login");
  assert.equal((await claimer.account("ghost")).skipped, "unknown");
  const sum = await claimer.sweep();
  assert.equal(sum.accounts, 0, "the sweep does not even look at them");
  assert.equal(JSON.stringify(world.calls()), before, "SOOP was not called at all");
  assert.equal(await SoopInventoryItem.countDocuments({ division: "available" }), 5);

  // The panel is told what is stuck, where, and how long it has.
  const w = await claimer.waiting();
  assert.deepEqual({ rewards: w.stuck.rewards, logins: w.stuck.logins }, { rewards: 3, logins: ["dead1", "refused1"] }, "not a sold account's rewards, and not one that has already run out");
  assert.equal(w.stuck.soonest.getTime(), soon.getTime());
  assert.deepEqual({ failed: w.failed.rewards, overdue: w.overdue.rewards }, { failed: 0, overdue: 0 });
  const alerts = alertsView({ ...noAlerts, claims: w, now: clock.t });
  assert.equal(alerts.length, 1);
  assert.deepEqual({ kind: alerts[0].kind, level: alerts[0].level }, { kind: "claim", level: "warn" });
  assert.match(alerts[0].msg, /^3 code reward\(s\) are waiting on 2 login\(s\) that cannot claim them \(dead1, refused1\) — re-import their cookies; the first runs out in 30 hours\.$/);
});

test("an account marked sold in the middle of a run is not claimed on any further", async () => {
  const s = setup({ paceMs: 5 });
  await s.add("acc1");
  for (const n of [1, 2, 3, 4]) s.world.addInventory("acc1", { itemName: "Code " + n, claimCode: "SOLD-MID-" + n });
  s.world.addInventory("acc1", { itemName: "By Hand", claimCode: "SOLD-MID-HAND" }, "acquired");
  let pauses = 0;
  const claimer = s.make({
    sleep: async (ms) => {
      s.clock.t += ms;
      if (++pauses === 1) await SoopAccount.updateOne({ loginId: "acc1" }, { $set: { sold: true } }); // sold while it waits to make the second claim
    },
  });
  const out = await claimer.account("acc1");
  assert.equal(out.claimed, 1, "the claim that follows the wait is not made: the account is no longer ours");
  assert.equal(s.world.calls().useInfo, 1, "and nothing is read back on it either");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", division: "available" }), 3);

  // The same while it is reading codes back.
  await SoopAccount.updateOne({ loginId: "acc1" }, { $set: { sold: false } });
  for (const n of [2, 3]) s.world.addInventory("acc1", { itemName: "By Hand " + n, claimCode: "SOLD-MID-HAND-" + n }, "acquired");
  await s.inventory.syncAccount("acc1");
  await SoopInventoryItem.updateMany({ loginId: "acc1", division: "available" }, { $set: { expiresAt: new Date(s.clock.t - HOUR) } }); // nothing left to claim
  pauses = 0;
  s.clock.t += HOUR;
  const again = await claimer.account("acc1", { sync: false });
  assert.deepEqual({ claimed: again.claimed, read: again.read }, { claimed: 0, read: 1 }, "one code read back, then the account was sold");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", division: "acquired", hasCode: { $ne: true } }), 2);
});

test("switched off, SOOP is asked for nothing; switched off mid-run, the next call is not made", async () => {
  let on = false;
  const s = setup({ enabled: () => on, paceMs: 5 });
  await s.add("acc1");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "Code " + n, claimCode: "SWITCH-" + n });
  await s.inventory.syncAccount("acc1");
  const before = JSON.stringify(s.world.calls());

  assert.equal((await s.claimer.account("acc1")).skipped, "off");
  assert.equal((await s.claimer.sweep()).stopped, "off");
  assert.equal(s.claimer.status().enabled, false);
  assert.equal(JSON.stringify(s.world.calls()), before, "off means not one call");

  // On again — and off during the first pause, which is before the second claim.
  on = true;
  const claimer = s.make({ sleep: async (ms) => { s.clock.t += ms; on = false; } });
  const out = await claimer.account("acc1");
  assert.equal(out.claimed, 1, "off stops the call that was about to be made");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", division: "available" }), 2);
});

test("a switch that cannot be read counts as on", async () => {
  const s = setup({ enabled: () => { throw new Error("settings file unreadable"); } });
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Code", claimCode: "STILL-CLAIMED-1" });
  assert.equal((await s.claimer.account("acc1")).claimed, 1);
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
  const [a, a2, b] = await Promise.all([s.claimer.account("acc1"), s.claimer.account("acc1"), s.claimer.account("acc2")]);
  assert.equal(a, a2, "a run that has not started yet is not queued twice");
  assert.equal(a.claimed + b.claimed, 5);
  assert.equal(s.world.calls().useInfo, 5, "each reward asked for once");
  assert.deepEqual(s.waits, [7000, 7000, 7000, 7000], "a full pace between every two claims, across accounts");

  const at = async (id) => (await SoopInventoryItem.find({ loginId: id }).lean()).map((r) => r.claimedAt.getTime());
  assert.ok(Math.max(...(await at("acc1"))) < Math.min(...(await at("acc2"))), "acc1 was finished before acc2 was started");
  assert.equal(s.claimer.status().running, false);
  assert.equal(s.claimer.status().claimed, 5);
});

test("a run that has started does not swallow the next request for the same account", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "First", claimCode: "QUEUE-1" });
  let release;
  let hold = new Promise((r) => (release = r));
  s.wrap.set("acc1", (c) => ({
    ...c,
    inventoryCounts: async () => {
      if (hold) await hold;
      return c.inventoryCounts();
    },
  }));
  const first = s.claimer.account("acc1"); // starts, and waits on SOOP
  await sleep(30);
  assert.equal(s.claimer.status().running, true);
  // A reward lands while that run is busy: asking again must queue a run of its own.
  s.world.addInventory("acc1", { itemName: "Second", claimCode: "QUEUE-2" });
  const second = s.claimer.account("acc1");
  assert.notEqual(first, second);
  hold = null;
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.claimed + b.claimed, 2);
  await s.claimer.idle();
  assert.equal(s.claimer.status().running, false);
});

// ------------------------------------------------------- when SOOP says no

test("a reward SOOP has no code for yet is claimed once, left alone, and its code read back later", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "Out Of Stock", claimCode: PENDING });

  const first = await s.claimer.account("acc1");
  assert.deepEqual({ claimed: first.claimed, pending: first.pending, failed: first.failed }, { claimed: 0, pending: 1, failed: 0 });
  let row = (await s.rows("acc1"))["Out Of Stock"];
  assert.equal(row.division, "acquired", "the reward is claimed: SOOP owes the code");
  assert.equal(row.hasCode, false);
  assert.equal(row.codeEnc, "", "the placeholder is never stored as a code");
  assert.equal(row.claim.kind, "pending");
  assert.deepEqual({ kind: row.auto.kind, tries: row.auto.tries }, { kind: "pending", tries: 1 });
  assert.equal(s.world.calls().useInfo, 1);

  // Not hammered: nothing more until the wait has passed.
  s.clock.t += OWED_MS - 1000;
  await s.claimer.account("acc1");
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, 1);

  // Still nothing after the wait; then SOOP delivers.
  s.clock.t += 2000;
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  assert.equal(s.world.calls().useInfo, 2);
  s.world.setClaimCode("acc1", raw.itemCodeIdx, "LATE-CODE-777");
  s.clock.t += OWED_MS + 1000;
  const later = await s.claimer.account("acc1");
  assert.equal(later.read, 1);
  row = (await s.rows("acc1"))["Out Of Stock"];
  assert.equal(row.hasCode, true);
  assert.equal(row.auto, null);
  assert.equal(await s.inventory.revealCode(String(row._id)), "LATE-CODE-777");
});

test("an owed code is asked for after the reward's own date has passed, and not for ever", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "One-Day Reward", claimCode: PENDING, expDate: kst(s.clock.t + DAY) });
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  assert.equal(s.world.calls().useInfo, 1);

  // Two days on: the date on the row has passed. SOOP can still deliver, so it is still asked.
  s.clock.t += 2 * DAY;
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  assert.equal(s.world.calls().useInfo, 2, "asked although the reward's date is behind us");
  s.world.setClaimCode("acc1", raw.itemCodeIdx, "DELIVERED-LATE-9");
  s.clock.t += OWED_MS + 1000;
  assert.equal((await s.claimer.account("acc1")).read, 1);

  // One that never arrives is given up on a month after the claim.
  s.world.addInventory("acc1", { itemName: "Never Delivered", claimCode: PENDING });
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  const asked = s.world.calls().useInfo;
  s.clock.t += 31 * DAY;
  await s.claimer.account("acc1");
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, asked, "no call after thirty days");
});

test("a claim that comes back with no code at all is an owed code: asked for again, not forgotten", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "Answered Empty", noCode: true });
  const out = await s.claimer.account("acc1");
  assert.deepEqual({ claimed: out.claimed, failed: out.failed, pending: out.pending }, { claimed: 0, failed: 0, pending: 1 });
  let row = (await s.rows("acc1"))["Answered Empty"];
  assert.equal(row.division, "acquired");
  assert.equal(row.hasCode, false);
  assert.deepEqual({ kind: row.auto.kind, tries: row.auto.tries, error: row.auto.error }, { kind: "pending", tries: 1, error: "SOOP gave no code for this reward" });
  assert.match(s.said(), /SOOP has no code yet for 1 reward on acc1/);

  await s.claimer.account("acc1");
  assert.equal(s.world.calls().useInfo, 1, "not asked again before the wait has passed");
  s.clock.t += OWED_MS + 1000;
  assert.equal((await s.claimer.account("acc1")).pending, 1, "asked again, still nothing");
  assert.equal(s.world.calls().useInfo, 2);
  s.world.setClaimCode("acc1", raw.itemCodeIdx, "CAME-AFTER-ALL-1");
  s.clock.t += OWED_MS + 1000;
  assert.equal((await s.claimer.account("acc1")).read, 1);
  row = (await s.rows("acc1"))["Answered Empty"];
  assert.equal(row.auto, null);
  assert.equal(await s.inventory.revealCode(String(row._id)), "CAME-AFTER-ALL-1");
});

test("an owed code stays owed when one call for it gets no answer", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "Answered Empty", noCode: true });
  assert.equal((await s.claimer.account("acc1")).pending, 1);
  // The next time it is asked for, the tunnel is down: nothing was learned about it.
  s.clock.t += OWED_MS + 1000;
  s.world.setEgress({ down: true });
  assert.equal((await s.claimer.account("acc1", { sync: false })).error, "egress");
  let row = (await s.rows("acc1"))["Answered Empty"];
  assert.deepEqual({ kind: row.auto.kind, tries: row.auto.tries, hasCode: row.hasCode }, { kind: "unanswered", tries: 2, hasCode: false });

  // SOOP delivers. The code is asked for again — a few minutes on, not at once and not never.
  s.world.setEgress({ down: false });
  s.world.setClaimCode("acc1", raw.itemCodeIdx, "NOT-FORGOTTEN-1");
  assert.equal((await s.claimer.account("acc1")).read, 0, "not before its wait has passed");
  s.clock.t += UNANSWERED_MS + 1000;
  assert.equal((await s.claimer.sweep()).read, 1);
  row = (await s.rows("acc1"))["Answered Empty"];
  assert.equal(row.auto, null);
  assert.equal(await s.inventory.revealCode(String(row._id)), "NOT-FORGOTTEN-1");
});

test("a reward SOOP reissues is claimed as its new item, in the same run", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Reissued", claimCode: "RENEWED-CODE-5", renewFlag: "Y" });
  const out = await s.claimer.account("acc1");
  assert.equal(out.claimed, 1);
  assert.equal(s.world.calls().useInfo, 2, "the old item once, the new item once");
  const all = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.equal(all.length, 1, "the withdrawn item is gone from the stored copy");
  assert.equal(all[0].division, "acquired");
  assert.equal(await s.inventory.revealCode(String(all[0]._id)), "RENEWED-CODE-5");
});

test("a claim SOOP refuses is recorded on the reward; two in a row leave the rest for later", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "Refused " + n, claimCode: "REF-" + n });
  s.world.addInventory("acc2", { itemName: "Fine", claimCode: "FINE-1" });
  s.world.refuseClaims("acc1");

  const sum = await s.claimer.sweep();
  assert.deepEqual({ accounts: sum.accounts, claimed: sum.claimed, failed: sum.failed, stopped: sum.stopped }, { accounts: 2, claimed: 1, failed: 2, stopped: null }, "one account's refusals do not stop the next");
  assert.equal(s.world.calls().useInfo, 3, "two refusals on acc1, then acc2's claim: the third reward was not asked for");
  let r = await s.rows("acc1");
  assert.deepEqual({ kind: r["Refused 1"].auto.kind, tries: r["Refused 1"].auto.tries, error: r["Refused 1"].auto.error }, { kind: "failed", tries: 1, error: "Rewards cannot be handed out right now." });
  assert.equal(r["Refused 3"].auto, null, "nothing is recorded against a reward that was not asked for");
  assert.equal(r["Refused 1"].division, "available");
  const w = await s.claimer.waiting();
  assert.deepEqual({ stuck: w.stuck.rewards, failed: w.failed.rewards, error: w.failed.error }, { stuck: 0, failed: 2, error: "Rewards cannot be handed out right now." });
  const alerts = alertsView({ ...noAlerts, claims: w, now: s.clock.t });
  assert.equal(alerts[0].kind, "claim-failed");
  assert.match(alerts[0].msg, /^2 code reward\(s\) could not be claimed automatically \(Rewards cannot be handed out right now\.\)/);
  assert.match(s.said(), /2 rewards on acc1 could not be claimed automatically/);

  // At once again: only the reward that was not asked for is; the two refused ones wait.
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, 4);
  await s.claimer.sweep();
  assert.equal(s.world.calls().useInfo, 4, "not asked again before the wait has passed");

  s.world.refuseClaims("acc1", false);
  s.clock.t += RETRY_MS + 1000;
  assert.equal((await s.claimer.sweep()).claimed, 3);
  r = await s.rows("acc1");
  assert.equal(r["Refused 1"].auto, null, "the refusal is forgotten once the code is in");
  assert.equal((await s.claimer.waiting()).failed.rewards, 0);
});

test("a fresh login is a fresh start: what was refused before is tried at once", async () => {
  const s = setup();
  await s.add("acc1");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Refused " + n, claimCode: "FRESH-" + n });
  s.world.refuseClaims("acc1");
  assert.equal((await s.claimer.account("acc1")).failed, 2);
  s.world.refuseClaims("acc1", false);
  assert.equal((await s.claimer.account("acc1")).claimed, 0, "an ordinary run waits");
  assert.equal((await s.claimer.account("acc1", { force: true })).claimed, 2, "the run after a cookie import does not");
});

test("a forced run asks a refused reward once, and still claims the one SOOP reissued", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Refused", claimCode: "NEVER-1", refuseOnClaim: true });
  s.world.addInventory("acc1", { itemName: "Reissued", claimCode: "FORCED-RENEW-1", renewFlag: "Y" });
  const out = await s.claimer.account("acc1", { force: true });
  assert.deepEqual({ claimed: out.claimed, failed: out.failed }, { claimed: 1, failed: 1 });
  assert.equal((await s.rows("acc1"))["Refused"].auto.tries, 1, "not asked a second time in the round after the reissue");
});

test("a claim that gets no readable answer blames nobody: the reward goes to the back of the line and the sweep goes on", async () => {
  const s = setup();
  for (const id of ["acc1", "acc2"]) {
    await s.add(id);
    for (const n of [1, 2]) s.world.addInventory(id, { itemName: "Code " + n, claimCode: `PAGE-${id}-${n}` });
  }
  s.world.refuseClaims("acc1", true, "HTTP"); // an error page instead of an answer
  const sum = await s.claimer.sweep();
  assert.deepEqual(
    { accounts: sum.accounts, unread: sum.unread, claimed: sum.claimed, failed: sum.failed, stopped: sum.stopped },
    { accounts: 2, unread: 1, claimed: 2, failed: 0, stopped: null },
    "one login without an answer is skipped; the next one is still worked on",
  );
  assert.equal(s.world.calls().useInfo, 3, "one unanswered call on acc1 was enough for this run");
  let r = await s.rows("acc1");
  assert.deepEqual({ kind: r["Code 1"].auto.kind, tries: r["Code 1"].auto.tries }, { kind: "unanswered", tries: 1 });
  assert.equal(r["Code 2"].auto, null, "the reward that was not asked for carries nothing");
  assert.equal((await s.claimer.waiting()).failed.rewards, 0, "one unanswered call is not worth an alert");
  assert.ok(!s.said().includes("Bad Gateway"), "the page's text is not repeated");
  assert.match(s.said(), /1 login got no answer from SOOP/);

  // A minute later SOOP is fine: the reward that was never asked for is claimed at once...
  s.world.refuseClaims("acc1", false);
  s.clock.t += MIN;
  assert.equal((await s.claimer.sweep()).claimed, 1);
  // ...and the one that went unanswered a few minutes after, not hours.
  s.clock.t += UNANSWERED_MS;
  assert.equal((await s.claimer.sweep()).claimed, 1);
  r = await s.rows("acc1");
  assert.equal(r["Code 1"].auto, null);
  assert.equal(await SoopInventoryItem.countDocuments({ hasCode: true }), 4);
});

test("one reward that never gets an answer does not stand in front of the others, and is reported once it repeats", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2");
  s.world.addInventory("acc1", { itemName: "Never Answered", claimCode: "POISON-1", httpOnClaim: true });
  s.world.addInventory("acc2", { itemName: "Fine", claimCode: "FINE-2" });
  const first = await s.claimer.sweep();
  assert.deepEqual({ accounts: first.accounts, unread: first.unread, claimed: first.claimed, stopped: first.stopped }, { accounts: 2, unread: 1, claimed: 1, stopped: null }, "the login behind it is still read");

  // A new code lands on the same account: it is claimed BEFORE the odd one is tried again.
  s.world.addInventory("acc1", { itemName: "New Code", claimCode: "AFTER-POISON-1" });
  s.clock.t += UNANSWERED_MS + 1000;
  const second = await s.claimer.account("acc1");
  assert.deepEqual({ claimed: second.claimed, error: second.error }, { claimed: 1, error: "egress" }, "what it did before it was stopped is still reported");
  const r = await s.rows("acc1");
  assert.equal(r["New Code"].hasCode, true);
  assert.equal(r["Never Answered"].auto.tries, 2);
  assert.equal((await s.claimer.waiting()).failed.rewards, 0);

  s.clock.t += UNANSWERED_MS + 1000;
  await s.claimer.account("acc1");
  const w = await s.claimer.waiting();
  assert.deepEqual({ failed: w.failed.rewards, error: w.failed.error }, { failed: 1, error: "SOOP sent a reply that could not be read — try again in a moment" }, "three times without an answer is the reward's business after all");
});

test("two rewards SOOP keeps refusing do not keep a newer one from being claimed", async () => {
  const s = setup();
  await s.add("acc1");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Always Refused " + n, claimCode: "NEVER-" + n, refuseOnClaim: true });
  assert.equal((await s.claimer.account("acc1")).failed, 2);
  for (let round = 0; round < 3; round++) {
    s.clock.t += RETRY_MS + 1000; // both are due again, and both will be refused again
    s.world.addInventory("acc1", { itemName: "Newer " + round, claimCode: "NEWER-" + round });
    const out = await s.claimer.account("acc1");
    assert.equal(out.claimed, 1, "the newer reward is asked for first, whatever the old ones do");
  }
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", hasCode: true }), 3);
  assert.equal((await s.rows("acc1"))["Always Refused 1"].auto.tries, 4);
});

test("a refusal trips the breaker for claims only: codes are still read back in that run", async () => {
  const s = setup();
  await s.add("acc1");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "Refused " + n, claimCode: "NEVER-" + n, refuseOnClaim: true });
  s.world.addInventory("acc1", { itemName: "By Hand", claimCode: "HAND-AFTER-BREAKER" }, "acquired");
  const out = await s.claimer.account("acc1");
  assert.deepEqual({ failed: out.failed, read: out.read }, { failed: 2, read: 1 });
});

test("a login SOOP refuses while claiming stops that account only, and is checked once", async () => {
  const s = setup();
  await s.add("acc1");
  await s.add("acc2");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Unreachable " + n, claimCode: "AUTH-" + n });
  s.world.addInventory("acc2", { itemName: "Reachable", claimCode: "OK-1" });
  await s.inventory.syncAccount("acc1");
  s.world.rejectDrops("acc1");

  const [a, b] = await Promise.all([s.claimer.account("acc1", { sync: false }), s.claimer.account("acc2")]);
  assert.equal(a.error, "auth");
  assert.equal(a.claimed, 0);
  assert.equal(b.claimed, 1, "the queue went on to the next account");
  assert.deepEqual(s.checks, ["acc1"], "the login was checked, once");
  assert.equal(s.world.calls().useInfo, 2, "acc1 was asked once, not once per reward");
  const r = await s.rows("acc1");
  assert.equal(r["Unreachable 1"].auto, null, "a dead login is not the reward's failure");
  assert.match(s.said(), /SOOP refused acc1 while its rewards were being claimed/);

  // The same when it is the inventory read that is refused.
  s.checks.length = 0;
  assert.equal((await s.claimer.account("acc1")).error, "auth");
  await sleep(20);
  assert.deepEqual(s.checks, ["acc1"]);
});

test("\"log in\" for one reward on a login that works is that reward's refusal, not the login's", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Odd 1", claimCode: "ODD-1", authOnClaim: true });
  s.world.addInventory("acc1", { itemName: "Good 1", claimCode: "GOOD-1" });
  s.world.addInventory("acc1", { itemName: "Odd 2", claimCode: "ODD-2", authOnClaim: true });
  s.world.addInventory("acc1", { itemName: "Good 2", claimCode: "GOOD-2" });

  const out = await s.claimer.account("acc1");
  assert.deepEqual({ claimed: out.claimed, failed: out.failed, error: out.error }, { claimed: 2, failed: 2, error: undefined }, "the rewards behind the odd one are not blocked by it");
  assert.deepEqual(s.checks, ["acc1"], "the login was checked once, and it works");
  const r = await s.rows("acc1");
  assert.deepEqual({ kind: r["Odd 1"].auto.kind, error: r["Odd 1"].auto.error }, { kind: "failed", error: 'SOOP answered "log in" for this reward although the login works' });
  assert.equal(r["Good 2"].hasCode, true);
  assert.equal((await s.claimer.waiting()).failed.rewards, 2, "and the panel says two are being refused");
});

// Five (or more) logins with one code each; `dead` holds the ones whose
// inventory gets no answer, `tries` counts the reads that were attempted.
async function tunnelFarm(s, n) {
  const ids = Array.from({ length: n }, (_, i) => "acc" + (i + 1));
  const dead = new Set();
  const tries = {};
  for (const id of ids) {
    await s.add(id);
    s.world.addInventory(id, { itemName: "Tunnel " + id, claimCode: "TUN-" + id });
    tries[id] = 0;
    s.wrap.set(id, (c) => ({
      ...c,
      inventoryCounts: async () => {
        tries[id] += 1;
        if (dead.has(id)) throw new SoopError("SOOP did not answer", { code: "TIMEOUT" });
        return c.inventoryCounts();
      },
    }));
  }
  const shape = (r) => ({ accounts: r.accounts, unread: r.unread, claimed: r.claimed, stopped: r.stopped });
  return { ids, dead, tries, shape };
}

test("a dead tunnel ends the run at the second silent login; the pass goes on with the rest, then looks at those two once more", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 5);
  // acc1 answers; then the tunnel goes: acc2 and acc3 get nothing.
  dead.add("acc2").add("acc3").add("acc4").add("acc5");
  const cut = await s.claimer.sweep();
  assert.deepEqual(shape(cut), { accounts: 3, unread: 2, claimed: 1, stopped: "egress" }, "two silent logins running: it does not try the rest through a dead tunnel");
  assert.deepEqual(s.checks, [], "a tunnel failure is never read as a dead login");
  assert.equal(await SoopInventoryItem.countDocuments({ auto: { $ne: null } }), 0);
  assert.ok(!s.said().includes("Inventory sync failed"), "the sweep says it once, in its own line");
  assert.match(s.said(), /2 logins got no answer from SOOP — it goes on shortly with what is left/);
  assert.equal(s.claimer.status().lastSweepAt, null, "a run that was cut short is not \"every login checked\"");

  // The tunnel is back. The pass goes on behind those two: acc1 is not read a second time...
  dead.clear();
  const rest = await s.claimer.sweep();
  assert.deepEqual(shape(rest), { accounts: 2, unread: 0, claimed: 2, stopped: "egress" }, "acc4 and acc5 — and the two that got no answer are still owed a look");
  // ...and the two that got no answer are looked at once more, in a run of their own.
  assert.equal(s.claimer.status().lastSweepAt, null, "nor is one that still owes two logins a look");
  const again = await s.claimer.sweep();
  assert.deepEqual(shape(again), { accounts: 2, unread: 0, claimed: 2, stopped: null });
  assert.equal(s.claimer.status().lastSweepAt.getTime(), s.clock.t, "the pass is over: now it is");
  assert.deepEqual(tries, { acc1: 1, acc2: 2, acc3: 2, acc4: 1, acc5: 1 }, "nobody read twice for nothing, nobody missed");
  assert.equal(s.claimer.status().lastSweep.claimed, 2);
  // And the sweep after that is a whole pass again.
  assert.equal((await s.claimer.sweep()).accounts, 5);
});

test("one silent login does not stop a pass: it is looked at once more, gets one round of its own, and is then left for the next pass", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 3);
  dead.add("acc2");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 3, unread: 1, claimed: 2, stopped: "egress" }, "the others are read; acc2 is owed one more look");
  // Silent on the second look as well, while the others answered: a round of its own, two looks...
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, claimed: 0, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, claimed: 0, stopped: "egress" });
  // ...and then the pass is over: it is not asked every ten minutes for ever.
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, claimed: 0, stopped: null });
  assert.deepEqual(tries, { acc1: 1, acc2: 4, acc3: 1 });
  // The next pass is a whole one again; by then acc2 answers.
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 3, unread: 0, claimed: 1, stopped: null });
});

test("silent logins that are not neighbours are not the tunnel: the run goes through, and each gets its second look", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 5);
  dead.add("acc2").add("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 5, unread: 2, claimed: 3, stopped: "egress" });
  dead.delete("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 1, claimed: 1, stopped: "egress" }, "acc2 and acc4 once more; acc4 answers now, acc2 is owed its own round");
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: null });
  assert.deepEqual(tries, { acc1: 1, acc2: 3, acc3: 1, acc4: 2, acc5: 1 });
});

test("two logins that never answer do not hold the others up: every pass reads everyone else, and asks those two four times at most", async () => {
  const s = setup();
  const { ids, dead, tries, shape } = await tunnelFarm(s, 6);
  await s.claimer.sweep();
  dead.add("acc3").add("acc4");
  for (let pass = 0; pass < 3; pass++) {
    for (const id of ids) tries[id] = 0;
    // A code lands in front of the two, and one behind them.
    s.world.addInventory("acc1", { itemName: "Front " + pass, claimCode: "FRONT-" + pass });
    s.world.addInventory("acc6", { itemName: "Behind " + pass, claimCode: "BEHIND-" + pass });
    const runs = [];
    do runs.push(await s.claimer.sweep());
    while (runs[runs.length - 1].stopped === "egress" && runs.length < 10);
    assert.deepEqual(
      runs.map(shape),
      [
        { accounts: 4, unread: 2, claimed: 1, stopped: "egress" },
        { accounts: 2, unread: 0, claimed: 1, stopped: "egress" },
        { accounts: 2, unread: 2, claimed: 0, stopped: "egress" },
        { accounts: 2, unread: 2, claimed: 0, stopped: "egress" },
        { accounts: 2, unread: 2, claimed: 0, stopped: null },
      ],
      "up to the two, then the rest, the two once more, a round of their own — and then the pass is over: no coming back every ten minutes",
    );
    assert.deepEqual(tries, { acc1: 1, acc2: 1, acc3: 4, acc4: 4, acc5: 1, acc6: 1 });
    s.clock.t += 3 * HOUR;
  }
});

test("one reward that never gets an answer, on login after login, does not end a pass: every login is still read", async () => {
  const s = setup();
  const ids = ["acc1", "acc2", "acc3", "acc4", "acc5"];
  for (const id of ids) {
    await s.add(id);
    s.world.addInventory(id, { itemName: "Never Answered", claimCode: "POISON-" + id, httpOnClaim: true });
  }
  const first = await s.claimer.sweep();
  assert.deepEqual(
    { accounts: first.accounts, unread: first.unread, stopped: first.stopped },
    { accounts: 5, unread: 5, stopped: null },
    "each inventory was read: one call left unanswered is that reward's trouble, not the tunnel's",
  );
  for (let pass = 0; pass < 3; pass++) {
    s.clock.t += 3 * HOUR;
    s.world.addInventory("acc5", { itemName: "Late " + pass, claimCode: "LATE-" + pass }); // on the last login
    const c0 = s.world.calls().inventoryCounts;
    const sum = await s.claimer.sweep();
    assert.deepEqual({ accounts: sum.accounts, claimed: sum.claimed, stopped: sum.stopped }, { accounts: 5, claimed: 1, stopped: null });
    assert.equal(s.world.calls().inventoryCounts - c0, 5);
  }
});

test("what is left of a pass is its logins, not a place in a list: one sold meanwhile is left out, the others are neither missed nor read twice", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 6);
  dead.add("acc3").add("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 4, unread: 2, claimed: 2, stopped: "egress" });
  // Before the next run acc3 is sold, and the tunnel is back.
  await SoopAccount.updateOne({ loginId: "acc3" }, { $set: { sold: true } });
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 0, claimed: 2, stopped: "egress" }, "acc5 and acc6");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: null }, "acc4 once more; acc3 is no longer ours to read");
  assert.deepEqual(tries, { acc1: 1, acc2: 1, acc3: 1, acc4: 2, acc5: 1, acc6: 1 });
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc3", hasCode: true }), 0, "nothing was claimed on the sold account");
});

test("when every login a run left behind is gone, the next run is a new pass over whoever is there", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 3);
  dead.add("acc2").add("acc3");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 3, unread: 2, claimed: 1, stopped: "egress" }, "acc1 is read; the other two are owed a second look");
  await SoopAccount.updateMany({ loginId: { $in: ["acc2", "acc3"] } }, { $set: { sold: true } });
  s.world.addInventory("acc1", { itemName: "Since Then", claimCode: "SINCE-THEN-1" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: null }, "nothing of the old pass was left: acc1, read before, is read again");
  assert.equal(tries.acc1, 2);
});

test("a tunnel that comes back late: the logins asked twice in vain get a round of their own, not a wait for the next pass", async () => {
  const s = setup();
  const { ids, dead, tries, shape } = await tunnelFarm(s, 6);
  for (const id of ids) dead.add(id);
  // The first look, two logins a run, and nobody answers...
  for (let i = 0; i < 3; i++) assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" });
  // ...the second look begins: acc1 and acc2 have now been asked twice.
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" });
  // The tunnel is back. The rest of the second look answers...
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 4, unread: 0, claimed: 4, stopped: "egress" }, "acc3 to acc6 — and the pass is not over");
  // ...and the two it came back too late for are read in the next run.
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 0, claimed: 2, stopped: null });
  assert.deepEqual(tries, { acc1: 3, acc2: 3, acc3: 2, acc4: 2, acc5: 2, acc6: 2 });
  assert.equal(await SoopInventoryItem.countDocuments({ hasCode: true }), 6);
});

test("a login sold before its own round is not looked at again", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 4);
  dead.add("acc2").add("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 4, unread: 2, claimed: 2, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" }, "silent on the second look too: a round of their own is owed");
  await SoopAccount.updateOne({ loginId: "acc2" }, { $set: { sold: true } });
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: null }, "acc4 alone");
  assert.equal(tries.acc2, 2);
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc2", hasCode: true }), 0);
});

test("what a pass still owes is checked against the logins at every run, whichever list they are on", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 5);
  for (const id of ["acc1", "acc2", "acc3", "acc4"]) dead.add(id);
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: "egress" }, "acc5 answers; four are owed a second look");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" }, "acc1 and acc2 silent twice; acc3 and acc4 still to do");
  // Sold before the next run: the two still to do, and one of the two silent twice.
  await SoopAccount.updateMany({ loginId: { $in: ["acc1", "acc3", "acc4"] } }, { $set: { sold: true } });
  dead.clear();
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 0, claimed: 1, stopped: null }, "acc2's own round, and nobody else's");
  assert.deepEqual(tries, { acc1: 2, acc2: 3, acc3: 1, acc4: 1, acc5: 1 });
});

test("switched off, what was left of a pass is forgotten: the sweep after switching on again is a whole one", async () => {
  let on = true;
  const s = setup({ enabled: () => on });
  const { dead, shape } = await tunnelFarm(s, 6);
  dead.add("acc3").add("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 4, unread: 2, claimed: 2, stopped: "egress" });
  // Off before the run that would have gone on, and that run finds it off.
  on = false;
  assert.equal((await s.claimer.sweep()).stopped, "off");
  // On again, some time later: not the four logins that were left, but everyone.
  on = true;
  dead.clear();
  s.world.addInventory("acc1", { itemName: "Meanwhile", claimCode: "MEANWHILE-1" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 6, unread: 0, claimed: 5, stopped: null });
});

test("switched off while a login waits its turn, a sweep stops there and forgets its pass", async () => {
  let on = true;
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 6);
  // Off during the third pause between two logins: the one before acc5, in the second run.
  let pauses = 0;
  const claimer = s.make({
    enabled: () => on,
    checkPaceMs: 2500,
    sleep: async (ms) => {
      s.clock.t += ms;
      if (ms === 2500 && ++pauses === 3) on = false;
    },
  });
  dead.add("acc1").add("acc2");
  assert.deepEqual(shape(await claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" }, "a pass with four logins still to do, and two owed a second look");
  dead.clear();
  assert.deepEqual(shape(await claimer.sweep()), { accounts: 2, unread: 0, claimed: 2, stopped: "off" }, "acc3 and acc4; off before acc5");
  assert.equal(tries.acc5, 0, "the login whose turn it was is not read");
  on = true;
  assert.deepEqual(shape(await claimer.sweep()), { accounts: 6, unread: 0, claimed: 4, stopped: null }, "a whole pass: neither the pass from before nor what this run had left");
});

test("the round of their own is the last one: whoever is still silent after it waits for the next pass", async () => {
  const s = setup();
  const { dead, tries, shape } = await tunnelFarm(s, 4);
  dead.add("acc2").add("acc4");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 4, unread: 2, claimed: 2, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, claimed: 0, stopped: "egress" }, "the second look: both silent again");
  // Their own round: acc2 answers now, acc4 does not — on either look.
  dead.delete("acc2");
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 1, claimed: 1, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, claimed: 0, stopped: null }, "and that was it: no further round because somebody answered in this one");
  assert.deepEqual(tries, { acc1: 1, acc2: 3, acc3: 1, acc4: 4 });
});

test("nobody answering at all is the tunnel: the pass is still to do, also for a farm of one login", async () => {
  const s = setup();
  for (const id of ["acc1", "acc2", "acc3"]) {
    await s.add(id);
    s.world.addInventory(id, { itemName: "Code " + id, claimCode: "SKIP-" + id });
  }
  const shape = (r) => ({ accounts: r.accounts, unread: r.unread, stopped: r.stopped });
  // The tunnel dies between a read and a claim: the reward only loses its place in line.
  await s.inventory.syncAccount("acc2");
  s.world.setEgress({ down: true });
  assert.equal((await s.claimer.account("acc2", { sync: false })).error, "egress");
  assert.equal((await s.rows("acc2"))["Code acc2"].auto.kind, "unanswered");
  // Everything down. The first look stops at two, goes on to the third...
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, stopped: "egress" });
  // ...the second look does the same...
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, stopped: "egress" });
  // ...and a pass in which nobody answered is not over: the next run starts it again.
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, stopped: "egress" });
  assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 2, unread: 2, stopped: "egress" });

  // A farm of one login never has two running: it is asked, asked once more, and the pass begins again.
  await SoopAccount.deleteMany({ loginId: { $in: ["acc1", "acc3"] } });
  for (let i = 0; i < 4; i++) assert.deepEqual(shape(await s.claimer.sweep()), { accounts: 1, unread: 1, stopped: "egress" });

  s.world.setEgress({ down: false });
  s.clock.t += UNANSWERED_MS + 1000;
  const back = await s.claimer.sweep();
  assert.deepEqual({ claimed: back.claimed, stopped: back.stopped }, { claimed: 1, stopped: null });
});

// ------------------------------------------------------------------ the sweep

test("the sweep reads every login's inventory, paced, and claims what it did not know of", async () => {
  const s = setup({ checkPaceMs: 2500 });
  for (const id of ["acc1", "acc2", "acc3"]) await s.add(id);
  s.world.addInventory("acc3", { itemName: "Known", claimCode: "KNOWN-1" }, "acquired");
  // acc2 holds one reward that is not a code: it is never claimed, only counted.
  const coins = s.world.addInventory("acc2", { itemName: "Coins", itemType: "4", ingameGiveYn: "Y", acctConn: false });
  await s.claimer.sweep();
  s.waits.length = 0;
  s.world.addInventory("acc1", { itemName: "New", claimCode: "NEW-1" }); // SOOP has it, the stored copy does not
  // On acc2 the coins run out as a code lands: SOOP's own counter of unclaimed rewards does not move.
  s.world.removeInventory("acc2", coins.itemCodeIdx);
  s.world.addInventory("acc2", { itemName: "Coins", itemType: "4", ingameGiveYn: "Y", itemCodeIdx: coins.itemCodeIdx }, "expired");
  s.world.addInventory("acc2", { itemName: "Landed Unseen", claimCode: "UNSEEN-1" });
  const c0 = s.world.calls();

  const sum = await s.claimer.sweep();
  const c1 = s.world.calls();
  assert.deepEqual({ accounts: sum.accounts, claimed: sum.claimed, read: sum.read, added: sum.added }, { accounts: 3, claimed: 2, read: 0, added: 2 });
  assert.equal(c1.inventoryCounts - c0.inventoryCounts, 3, "each login read once");
  assert.equal(c1.inventory - c0.inventory, 9, "three lists a login, and no second read after a claim");
  assert.equal(c1.useInfo - c0.useInfo, 2);
  assert.deepEqual(s.waits, [2500, 2500], "a pause between two logins");

  // Nothing changed since: three reads, no claim — and not a word in the activity log.
  const synced = () => s.activity.recent({ limit: 500 }).filter((e) => /^Inventory synced/.test(e.msg)).length;
  const said = synced();
  assert.ok(said >= 2, "a read that found something new says so");
  const quiet = await s.claimer.sweep();
  assert.deepEqual({ claimed: quiet.claimed, added: quiet.added }, { claimed: 0, added: 0 });
  assert.equal(s.world.calls().useInfo - c1.useInfo, 0);
  assert.equal(synced(), said, "a scheduled read that found nothing is not logged");
  await s.inventory.syncAccount("acc1");
  assert.equal(synced(), said + 1, "a read someone asked for always is");
});

test("a reward claimed by hand on SOOP has its code read back and stored — paced, and not when switched off", async () => {
  let on = true;
  const s = setup({ paceMs: 7000, enabled: () => on });
  await s.add("acc1");
  for (const n of [1, 2, 3]) s.world.addInventory("acc1", { itemName: "By Hand " + n, claimCode: "HAND-CODE-" + n }, "acquired");
  const sum = await s.claimer.sweep();
  assert.deepEqual({ claimed: sum.claimed, read: sum.read }, { claimed: 0, read: 3 });
  assert.deepEqual(s.waits, [7000, 7000], "a full pace between two reads");
  const row = (await s.rows("acc1"))["By Hand 1"];
  assert.equal(row.hasCode, true);
  assert.equal(await s.inventory.revealCode(String(row._id)), "HAND-CODE-1");
  assert.match(s.said(), /Read back the code of 3 claimed rewards on acc1/);

  // Switched off while it waits to read the second one: that read is not made.
  for (const n of [4, 5, 6]) s.world.addInventory("acc1", { itemName: "By Hand " + n, claimCode: "HAND-CODE-" + n }, "acquired");
  s.clock.t += HOUR;
  const claimer = s.make({ sleep: async (ms) => { s.clock.t += ms; on = false; } });
  assert.equal((await claimer.account("acc1")).read, 1);
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", hasCode: true }), 4);

  // Off before a run starts: nothing is read back.
  const asked = s.world.calls().useInfo;
  assert.equal((await claimer.account("acc1")).skipped, "off");
  assert.equal(s.world.calls().useInfo, asked);
});

test("\"log in\" for one code being read back, on a login that works, does not stop the others", async () => {
  const s = setup();
  await s.add("acc1");
  s.world.addInventory("acc1", { itemName: "Odd", claimCode: "ODD-READ-1", authOnClaim: true }, "acquired");
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "By Hand " + n, claimCode: "READ-BACK-" + n }, "acquired");
  const out = await s.claimer.account("acc1");
  assert.deepEqual({ read: out.read, pending: out.pending, error: out.error }, { read: 2, pending: 1, error: undefined });
  assert.deepEqual(s.checks, ["acc1"]);
  const odd = (await s.rows("acc1"))["Odd"];
  assert.deepEqual({ kind: odd.auto.kind, error: odd.auto.error }, { kind: "pending", error: 'SOOP answered "log in" for this reward although the login works' });
  assert.ok(!s.said().includes("waits until its cookie is re-imported"), "nothing tells the owner to re-import a login that works");
});

test("a code first seen long ago and claimed elsewhere since is still read back; one with nothing to ask SOOP with is reported", async () => {
  const s = setup();
  await s.add("acc1");
  const raw = s.world.addInventory("acc1", { itemName: "Old Row", claimCode: "OLD-ROW-CODE-1" }, "acquired");
  const longAgo = new Date(s.clock.t - 40 * DAY);
  // Stored forty days ago as unclaimed, claimed by hand yesterday.
  await SoopInventoryItem.collection.insertOne({
    loginId: "acc1", key: raw.itemCodeIdx, division: "acquired", kind: "code", name: "Old Row", hasCode: false, codeEnc: "",
    raw: { itemCodeIdx: raw.itemCodeIdx }, claimedAt: null, receivedAt: new Date(s.clock.t - DAY), createdAt: longAgo, updatedAt: longAgo,
  });
  assert.equal((await s.claimer.account("acc1", { sync: false })).read, 1);

  await SoopInventoryItem.create({ loginId: "acc1", key: "no-id-1", division: "available", kind: "code", name: "No Id", raw: {} });
  assert.equal((await s.claimer.account("acc1", { sync: false })).claimed, 0);
  const w = await s.claimer.waiting();
  assert.deepEqual({ failed: w.failed.rewards, error: w.failed.error }, { failed: 1, error: "the reward has no SOOP item id" });
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
  s.clock.t += 1000; // the read finishes after the claim: only its START is before it
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
  const run = s.claimer.account("acc1", { sync: false }).then((o) => ((done = true), o));
  await sleep(40);
  assert.equal(done, false, "the claimer is waiting for the sync to finish, though it reads nothing itself");
  assert.equal(s.world.calls().useInfo, 1);
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
  assert.equal((await s.claimer.account("acc1")).claimed, 1);

  s.world.removeInventory("acc1", kept.itemCodeIdx);
  s.world.removeInventory("acc1", gone.itemCodeIdx);
  s.clock.t += HOUR;
  await s.inventory.syncAccount("acc1");
  let r = await s.rows("acc1");
  assert.deepEqual(Object.keys(r), ["Has A Code"], "the row without a code is deleted as before");
  assert.equal(r["Has A Code"].goneAt.getTime(), s.clock.t);
  assert.equal(await s.inventory.revealCode(String(r["Has A Code"]._id)), "KEEP-ME-1");

  // The first day it went missing is kept.
  const gone1 = r["Has A Code"].goneAt.getTime();
  s.clock.t += HOUR;
  await s.claimer.sweep();
  assert.equal((await s.rows("acc1"))["Has A Code"].goneAt.getTime(), gone1);
  assert.equal(s.world.calls().useInfo, 1, "and it is not claimed or read again");

  // Listed again — with something else in its code field: an ordinary row again, the code untouched.
  s.world.addInventory("acc1", { itemName: "Has A Code", itemCodeIdx: kept.itemCodeIdx, itemCode: "KEEP-****" }, "acquired");
  s.clock.t += HOUR;
  await s.inventory.syncAccount("acc1");
  r = await s.rows("acc1");
  assert.equal(r["Has A Code"].goneAt, null);
  assert.equal(await s.inventory.revealCode(String(r["Has A Code"]._id)), "KEEP-ME-1", "a list row never replaces a code we hold");
});

// --------------------------------------------------------- what the panel is told

test("the panel hears about codes left unclaimed for hours on a login that works", async () => {
  let on = false;
  const s = setup({ enabled: () => on });
  await s.add("acc1");
  await s.add("dead1", { status: "not_logged_in" });
  for (const n of [1, 2]) s.world.addInventory("acc1", { itemName: "Waiting " + n, claimCode: "OVERDUE-" + n });
  // Not ours to claim, so never something to warn about.
  s.world.addInventory("acc1", { itemName: "Needs A Link", ingameGiveYn: "Y", acctConn: false, claimCode: "NEVER-5" });
  await s.inventory.syncAccount("acc1");
  const stuck = s.world.addInventory("dead1", { itemName: "Stuck", claimCode: "STUCK-9" });
  await SoopInventoryItem.create({ loginId: "dead1", key: stuck.itemCodeIdx, division: "available", kind: "code", name: "Stuck", raw: { itemCodeIdx: stuck.itemCodeIdx } });

  // Rows are stamped with the real time they were first stored, so the claimer's clock runs from now.
  s.clock.t = Date.now() + HOUR;
  assert.equal((await s.claimer.waiting()).overdue.rewards, 0, "an hour is not yet worth a word");
  s.clock.t = Date.now() + 5 * HOUR;
  let w = await s.claimer.waiting();
  assert.deepEqual({ enabled: w.enabled, overdue: w.overdue.rewards, stuck: w.stuck.rewards }, { enabled: false, overdue: 2, stuck: 1 });
  let alerts = alertsView({ ...noAlerts, claims: w, now: s.clock.t });
  assert.deepEqual(alerts.map((a) => a.kind), ["claim", "claim-failed"]);
  assert.equal(new Set(alerts.map((a) => a.id)).size, 2, "each alert has an id of its own");
  assert.match(alerts[1].msg, /^Automatic claiming is switched off: 2 code reward\(s\) are unclaimed/);

  on = true;
  w = await s.claimer.waiting();
  alerts = alertsView({ ...noAlerts, claims: w, now: s.clock.t });
  assert.match(alerts[1].msg, /^2 code reward\(s\) have been unclaimed for hours on logins that work/);

  // A refused one and an overdue one at the same time: two alerts, two ids.
  s.world.refuseClaims("acc1");
  await s.claimer.account("acc1");
  await SoopInventoryItem.updateOne({ loginId: "acc1", name: "Waiting 2" }, { $set: { auto: null } });
  w = await s.claimer.waiting();
  alerts = alertsView({ ...noAlerts, claims: w, now: s.clock.t });
  assert.deepEqual(alerts.map((a) => a.kind), ["claim", "claim-failed", "claim-failed"]);
  assert.equal(new Set(alerts.map((a) => a.id)).size, 3);
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

  const results = [await s.claimer.sweep(), await s.claimer.account("acc1"), await s.claimer.account("acc2")];
  const waiting = await s.claimer.waiting();
  const alerts = alertsView({ ...noAlerts, claims: waiting, now: s.clock.t });
  const everything = JSON.stringify([results, waiting, alerts, s.claimer.status(), await s.inventory.forAccount("acc1")]) + s.said();
  for (const c of codes) assert.ok(!everything.includes(c), "a reward code leaked: " + c.slice(0, 9));
  assert.ok(!everything.includes("enc:v1:"), "ciphertext leaked");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", hasCode: true }), 3, "and yet all three codes are stored");
});

// ----------------------------------------------------------- inside the farm

const FAST = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 300, flatPolls: 3, backoffMs: [40], readFailures: 3, primePaceMs: 1, parkCooldownMs: 60, inventoryAfterStepMs: 25, inventoryRetryMs: 60 };
let world;
const tickets = new Map();

async function freshFarm({ rewards = true, timings = {}, claim = {} } = {}) {
  await farm._reset({ store: { ttlMs: 15 }, autoClaim: { paceMs: 0, checkPaceMs: 0, ...claim } });
  world = createFakeSoop({ rewards });
  tickets.clear();
  farm.setClientFactory(world.clientFor);
  farm.timings = { ...FAST, ...timings };
  farm.autoInventory = true;
}

// Imports the login and waits out the look at its inventory that follows.
async function importAccount(id) {
  if (!tickets.has(id)) tickets.set(id, world.addAccount({ id }));
  const [r] = await farm.importAccounts(JSON.stringify(tickets.get(id)));
  assert.equal(r.ok, true, r.error);
  await farm.autoClaim.idle();
  return id;
}

async function startBot(itemList, more = {}) {
  const camp = world.addCampaign({ live: true, itemList, ...more });
  await farm.campaignsView({ force: true });
  const { ok, error } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(ok, true, error);
  return camp;
}

// Moves the fake world a minute at a time until `done()`.
async function advanceUntil(done, label, max = 80) {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    world.advance(1);
    await sleep(40);
  }
  assert.fail("never happened: " + label);
}

const coded = (id) => SoopInventoryItem.countDocuments({ loginId: id, hasCode: true });
const reads = () => world.calls().inventoryCounts;

test("farm: each reward is claimed as soon as its step is reached, with nobody asking", async () => {
  await freshFarm();
  await importAccount("acc1");
  await startBot([2, 4]);
  await advanceUntil(async () => (await coded("acc1")) === 2, "both steps' codes stored");
  assert.equal(world.calls().useInfo, 2, "each claimed exactly once");
  const rows = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.ok(rows.every((r) => r.division === "acquired" && /^enc:v1:/.test(r.codeEnc)));
  const state = await farm.stateView();
  assert.equal(state.autoClaim.enabled, true);
  assert.equal(state.autoClaim.claimed, 2);
  assert.ok(state.autoClaim.lastClaimAt);
  assert.deepEqual({ waiting: state.autoClaim.waiting, failing: state.autoClaim.failing, overdue: state.autoClaim.overdue }, { waiting: 0, failing: 0, overdue: 0 });
  const body = JSON.stringify(state) + JSON.stringify(farm.activity.recent({ limit: 500 }));
  assert.ok(!/CODE-acc1-/.test(body), "the state and the log never hold a code");
});

test("farm: a reward SOOP hands out late is still found — it looks again, and then stops looking", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  const c0 = reads();
  await startBot([2]);
  await advanceUntil(() => reads() > c0, "the step was followed by a read");
  assert.equal(await coded("acc1"), 0, "nothing there yet");
  world.addInventory("acc1", { itemName: "Late Reward", claimCode: "LATE-FARM-1" }); // SOOP hands it out now
  await until(async () => (await coded("acc1")) === 1, "the second look claims it");

  // A step whose reward never shows up is looked for three times in all, no more.
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  const base = reads();
  await startBot([2]);
  await advanceUntil(() => reads() > base, "the step was followed by a read");
  await until(() => reads() - base === 3, "the first read and two more looks");
  await sleep(300);
  assert.equal(reads() - base, 3, "and no fourth");
});

test("farm: a step whose reward is not a code costs one read, not three", async () => {
  await freshFarm({ rewards: true });
  await importAccount("acc1");
  const base = reads();
  await startBot([{ giveTerm: 2, itemType: "4", itemName: "In-game Coins" }], { ingameGiveYn: "Y" });
  await advanceUntil(() => reads() > base, "the step was followed by a read");
  await sleep(300);
  assert.equal(reads() - base, 1, "the reward was there: nothing to look for again");
  assert.equal(world.calls().useInfo, 0, "and it is not a code, so it is not claimed");
});

test("farm: a read that fails after a step is tried again", async () => {
  await freshFarm();
  let failNext = false;
  farm.setClientFactory((cookies, o) => {
    const c = world.clientFor(cookies, o);
    return {
      ...c,
      inventoryCounts: async () => {
        if (failNext) {
          failNext = false;
          throw new SoopError("SOOP did not answer", { code: "TIMEOUT" });
        }
        return c.inventoryCounts();
      },
    };
  });
  await importAccount("acc1");
  failNext = true; // the read after the step is the next one
  await startBot([2]);
  await advanceUntil(async () => (await coded("acc1")) === 1, "claimed on the look after the failed read");
  assert.equal(failNext, false, "the first read did fail");
});

test("farm: a step that arrives while it waits to look again starts the looking over", async () => {
  await freshFarm({ rewards: false, timings: { inventoryRetryMs: 100000 } }); // the second look would come far too late
  await importAccount("acc1");
  const base = reads();
  await startBot([2, 40]);
  await advanceUntil(() => reads() > base, "the first step was read");
  await until(() => farm.invTimers.get("acc1") && farm.invTimers.get("acc1").attempt === 1, "a second look is booked");
  // Nothing was there, so a second look is booked — a long way off. The second step must not wait for it.
  world.addInventory("acc1", { itemName: "Second Step", claimCode: "RESTART-1" });
  await advanceUntil(async () => (await coded("acc1")) === 1, "the second step was read and claimed on its own first look", 150);
  assert.ok(reads() - base >= 2);
});

test("farm: switched off, a step is still followed by the plain read, and nothing is claimed", async () => {
  await freshFarm();
  farm.autoClaimEnabled = () => false;
  await importAccount("acc1");
  const base = reads();
  await startBot([2]);
  await advanceUntil(() => reads() > base, "the step was followed by a read");
  await until(() => SoopInventoryItem.countDocuments({ loginId: "acc1", division: "available" }), "the reward is in the stored copy");
  await sleep(300);
  assert.equal(reads() - base, 1, "one read, as before there was a claimer: no looking again");
  assert.equal(world.calls().useInfo, 0);
  assert.equal(await coded("acc1"), 0);
  const state = await farm.stateView();
  assert.equal(state.autoClaim.enabled, false);
});

test("farm: switched off, the reads after a step come one account at a time and leave the panel's own Sync as it was", async () => {
  await freshFarm();
  farm.autoClaimEnabled = () => false;
  let busy = 0;
  let most = 0;
  farm.setClientFactory((cookies, o) => {
    const c = world.clientFor(cookies, o);
    return {
      ...c,
      inventoryCounts: async () => {
        most = Math.max(most, ++busy);
        await sleep(30);
        busy -= 1;
        return c.inventoryCounts();
      },
    };
  });
  await importAccount("acc1");
  await importAccount("acc2");
  // The Sync somebody last pressed, as the panel shows it.
  farm.inventory.syncMany(["acc1"]);
  await until(() => !farm.inventory.status().running, "that Sync has finished");
  const shown = farm.inventory.status();
  assert.deepEqual({ done: shown.done, total: shown.total }, { done: 1, total: 1 });
  most = 0;
  const base = reads();

  const camp = world.addCampaign({ live: true, itemList: [2] });
  await farm.campaignsView({ force: true });
  const { ok, error } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1", "acc2"] });
  assert.equal(ok, true, error);
  await advanceUntil(() => reads() >= base + 2, "both accounts were read after their step");
  await sleep(200);
  assert.equal(reads() - base, 2, "one read each");
  assert.equal(most, 1, "never two inventories read at once");
  assert.deepEqual(farm.inventory.status(), shown, "the panel's progress and its list of failures are untouched");
  assert.equal(world.calls().useInfo, 0);
});

test("farm: when every look after a step gets no answer, the process log says so once", async () => {
  await freshFarm();
  let down = false;
  farm.setClientFactory((cookies, o) => {
    const c = world.clientFor(cookies, o);
    return {
      ...c,
      inventoryCounts: async () => {
        if (down) throw new SoopError("SOOP did not answer", { code: "TIMEOUT" });
        return c.inventoryCounts();
      },
    };
  });
  await importAccount("acc1");
  down = true;
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await startBot([2]);
    await advanceUntil(() => lines.some((l) => /no look at its rewards/.test(l)), "the last look said it had not seen the rewards");
    await sleep(250);
  } finally {
    console.log = real;
  }
  const told = lines.filter((l) => /no look at its rewards/.test(l));
  assert.deepEqual(told, ["[soop] acc1: no look at its rewards after a step (egress) - left to the next sweep"]);
});

test("farm: a last look that did read the inventory says nothing, whatever became of one reward's call", async () => {
  // No wait before a reward that got no answer is asked again: every look asks.
  await freshFarm({ claim: { unansweredMs: 0 } });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Never Answered", claimCode: "POISON-FARM-1", httpOnClaim: true });
  const base = reads();
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await startBot([2]);
    await advanceUntil(() => reads() >= base + 3, "all three looks were taken");
    await sleep(250);
  } finally {
    console.log = real;
  }
  assert.equal(await coded("acc1"), 1, "the step's code was claimed");
  assert.equal((await SoopInventoryItem.findOne({ loginId: "acc1", name: "Never Answered" }).lean()).auto.tries, 3, "and every look did end on the call that gets no answer");
  assert.deepEqual(lines.filter((l) => /no look at its rewards/.test(l)), []);
});

test("farm: re-importing the cookie of a login whose rewards were stuck claims them at once", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Stuck One", claimCode: "STUCK-FARM-1" });
  world.addInventory("acc1", { itemName: "Stuck Two", claimCode: "STUCK-FARM-2" });
  await farm.inventory.syncAccount("acc1");
  // The last attempt before the login died was refused: on a fresh login that does not count.
  await SoopInventoryItem.updateMany({ loginId: "acc1" }, { $set: { auto: { kind: "failed", tries: 1, at: new Date(), error: "Rewards cannot be handed out right now." } } });
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
  assert.equal(await coded("acc1"), 2, "both stuck rewards were claimed by the import's own run");
  assert.equal(world.calls().useInfo, 2);
  farm.claimView = { at: 0, value: null };
  state = await farm.stateView();
  assert.equal(state.alerts.filter((a) => /^claim/.test(a.kind)).length, 0);
  assert.equal(state.autoClaim.waiting, 0);
});

test("farm: a login SOOP refuses while claiming is checked at once, so the panel says so", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Out Of Reach", claimCode: "REFUSED-FARM-1" });
  world.rejectDrops("acc1");
  assert.equal((await farm.autoClaim.account("acc1")).error, "auth");
  await until(async () => (await SoopAccount.findOne({ loginId: "acc1" }).lean()).status === "drops_rejected", "the login check ran");
});

test("farm: deleting an account keeps the rows that hold a code", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Sellable", claimCode: "KEEP-FARM-1" });
  world.addInventory("acc1", { itemName: "Just A Form", itemType: "2" });
  assert.equal((await farm.autoClaim.account("acc1")).claimed, 1);
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 2);

  assert.equal(await farm.deleteAccounts(["acc1"]), 1);
  const left = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.deepEqual(left.map((r) => r.name), ["Sellable"]);
  assert.equal(await farm.inventory.revealCode(String(left[0]._id)), "KEEP-FARM-1", "the code can still be read with the account gone");
});

test("farm: with automatic inventory off (tests, a side script) an import claims nothing", async () => {
  await freshFarm({ rewards: false });
  farm.autoInventory = false;
  tickets.set("acc1", world.addAccount({ id: "acc1" }));
  world.addInventory("acc1", { itemName: "Untouched", claimCode: "UNTOUCHED-1" });
  await importAccount("acc1");
  await sleep(120);
  assert.equal(world.calls().useInfo, 0);
  assert.equal(world.calls().inventory, 0);
});

test("farm: a sweep runs shortly after start, and one the tunnel cut short runs again soon", async () => {
  // The interval is far away: whatever sweeps here is the one after start, or its re-run.
  await freshFarm({ rewards: false, timings: { claimSweepBootMs: 40, claimSweepMs: 600000, claimSweepRetryMs: 50 } });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Found By The Sweep", claimCode: "SWEEP-FARM-1" });
  world.setEgress({ down: true });
  await farm.start();
  await until(() => (farm.autoClaim.status().lastSweep || {}).stopped === "egress", "the sweep after start ran and was cut short", 2000);
  assert.equal(await coded("acc1"), 0);
  world.setEgress({ down: false });
  await until(async () => (await coded("acc1")) === 1, "it ran again without waiting for the interval", 2000);
});

test("farm: a sweep that failed outright is run again soon as well", async () => {
  await freshFarm({ rewards: false, timings: { claimSweepBootMs: 40, claimSweepMs: 600000, claimSweepRetryMs: 50 } });
  await importAccount("acc1");
  world.addInventory("acc1", { itemName: "Found On The Second Try", claimCode: "SWEEP-FARM-3" });
  const real = farm.autoClaim.sweep;
  let calls = 0;
  farm.autoClaim.sweep = async () =>
    ++calls === 1 ? { accounts: 0, unread: 0, claimed: 0, read: 0, failed: 0, pending: 0, added: 0, stopped: "error" } : real();
  await farm.start();
  await until(async () => (await coded("acc1")) === 1, "the sweep was run again after it failed", 2000);
  assert.ok(calls >= 2);
});

test("farm: the sweep comes round again on its interval", async () => {
  // The sweep after start is far away: whatever sweeps here is the interval.
  await freshFarm({ rewards: false, timings: { claimSweepBootMs: 600000, claimSweepMs: 120 } });
  await importAccount("acc1");
  await farm.start();
  world.addInventory("acc1", { itemName: "Found By The Sweep", claimCode: "SWEEP-FARM-1" });
  await until(async () => (await coded("acc1")) === 1, "the first interval sweep", 3000);
  world.addInventory("acc1", { itemName: "Found Later", claimCode: "SWEEP-FARM-2" });
  await until(async () => (await coded("acc1")) === 2, "the next one", 3000);
});

test("farm: the panel's state survives the look at unclaimed codes failing", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  farm.autoClaim.waiting = async () => {
    throw new Error("database is away");
  };
  farm.claimView = { at: 0, value: null };
  const state = await farm.stateView();
  assert.deepEqual({ waiting: state.autoClaim.waiting, failing: state.autoClaim.failing, overdue: state.autoClaim.overdue }, { waiting: 0, failing: 0, overdue: 0 });
  assert.equal(state.alerts.filter((a) => /^claim/.test(a.kind)).length, 0);
});

test("farm: the look at unclaimed codes is refreshed after a minute, not on every poll", async () => {
  await freshFarm({ rewards: false });
  await importAccount("acc1");
  let asked = 0;
  const real = farm.autoClaim.waiting;
  farm.autoClaim.waiting = async () => {
    asked += 1;
    return real();
  };
  let t = Date.now();
  farm.setClock({ now: () => t });
  farm.claimView = { at: 0, value: null };
  await farm.stateView();
  await farm.stateView();
  await farm.stateView();
  assert.equal(asked, 1, "three polls, one look");
  t += 61 * 1000;
  await farm.stateView();
  assert.equal(asked, 2, "and a fresh one a minute later");
  await farm._claimSweep();
  await farm.stateView();
  assert.equal(asked, 3, "and right after a sweep, which is when it changes");
});

// ------------------------------------------------------------------ the switch

test("the switch: off by the settings file or the environment, on when unset or unreadable", () => {
  const read = farm.autoClaimSwitch;
  const settingsPath = require.resolve("../utils/settings");
  const had = require.cache[settingsPath];
  const envBefore = process.env.SOOP_AUTO_CLAIM;
  let value;
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: {
      getAutoFarm: () => {
        if (value === "THROW") throw new Error("settings.json is unreadable");
        return value === "MISSING" ? {} : { soopAutoClaim: value };
      },
    },
  };
  try {
    delete process.env.SOOP_AUTO_CLAIM;
    for (const [v, want] of [
      [false, false], [0, false], ["0", false], ["false", false], ["off", false], ["OFF", false], [" no ", false],
      [true, true], [1, true], ["1", true], ["on", true], [null, true], [undefined, true], ["MISSING", true], ["THROW", true], ["maybe", true], [{}, true],
    ]) {
      value = v;
      read.forget();
      assert.equal(read(), want, `soopAutoClaim = ${JSON.stringify(v)} must read ${want ? "on" : "off"}`);
    }
    // Read from the file at most every thirty seconds.
    value = true;
    read.forget();
    assert.equal(read(), true);
    value = false;
    assert.equal(read(), true, "the answer is kept for a moment");
    read.forget();
    assert.equal(read(), false);
    // The environment wins, and is not remembered.
    value = true;
    read.forget();
    for (const env of ["0", "false", "off"]) {
      process.env.SOOP_AUTO_CLAIM = env;
      assert.equal(read(), false, `SOOP_AUTO_CLAIM=${env}`);
    }
    process.env.SOOP_AUTO_CLAIM = "1";
    assert.equal(read(), true);
  } finally {
    if (envBefore === undefined) delete process.env.SOOP_AUTO_CLAIM;
    else process.env.SOOP_AUTO_CLAIM = envBefore;
    if (had) require.cache[settingsPath] = had;
    else delete require.cache[settingsPath];
    read.forget();
  }
});
