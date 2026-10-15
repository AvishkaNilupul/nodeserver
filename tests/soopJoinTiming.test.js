// SOOP farm: join on time (docs/code-shop/04-OPS.md, "Farm changes" 2).
// From two minutes before a campaign's start to ten minutes after it the
// watcher looks every 30 s, and a held campaign cools down for 60 s instead of
// 3 min. Outside that window nothing changes. Harness of tests/soopFarm.test.js;
// in-memory fake SOOP, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-join-timing-test-cred-secret";

const SoopAccount = require("../models/SoopAccount");
const SoopFarmTask = require("../models/SoopFarmTask");
const farm = require("../utils/soopFarm");
const { createFakeSoop } = require("./helpers/soopFake");

// FAST of tests/soopFarm.test.js without the cool-down overrides: the real
// 180 s / 60 s defaults are what is under test here.
const FAST = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 300, flatPolls: 3, backoffMs: [40], readFailures: 3, primePaceMs: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60000;
// SOOP's Korea-time "YYYY-MM-DD HH:mm:ss" for an instant.
const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19);

async function until(fn, label, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail("timed out waiting for: " + label);
    await sleep(10);
  }
}

let mongod;
let world;

async function fresh({ ttlMs = 15, timings = FAST } = {}) {
  await farm._reset({ store: { ttlMs } });
  await Promise.all([SoopAccount.deleteMany({}), SoopFarmTask.deleteMany({})]);
  world = createFakeSoop();
  farm.setClientFactory(world.clientFor);
  farm.timings = timings;
  farm.autoInventory = false;
}

async function addAccount(id) {
  const [r] = await farm.importAccounts(JSON.stringify(world.addAccount({ id })));
  assert.equal(r.ok, true, r.error);
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await farm._reset();
  await mongoose.disconnect();
  await mongod.stop();
});

// ---- _cadence ---------------------------------------------------------------

test("_cadence: every 30 s from 2 min before a start to 10 min after it", () => {
  const now = Date.parse("2026-10-20T10:00:00Z");
  const at = (offset, end = 7 * 24 * 60 * MIN) => ({ startAt: new Date(now + offset), endAt: new Date(now + end) });
  for (const [offset, why] of [
    [2 * MIN, "two minutes before the start (edge)"],
    [90000, "ninety seconds before"],
    [1000, "a second before"],
    [0, "at the start"],
    [-5 * MIN, "five minutes after"],
    [-10 * MIN, "ten minutes after (edge)"],
  ]) {
    assert.equal(farm._cadence([at(offset)], now), 30000, why);
  }
  // The same campaign as a Date, an ISO string or a number of ms.
  assert.equal(farm._cadence([{ startAt: new Date(now - MIN).toISOString() }], now), 30000);
  assert.equal(farm._cadence([{ startAt: now - MIN }], now), 30000);
  // One candidate in its window is enough, whatever the others say.
  assert.equal(farm._cadence([at(3 * 3600e3), at(-86400e3), at(MIN)], now), 30000);
});

test("_cadence: outside the start window the old values stand", () => {
  const now = Date.parse("2026-10-20T10:00:00Z");
  const at = (offset, end = 7 * 24 * 60 * MIN) => ({ startAt: new Date(now + offset), endAt: new Date(now + end) });
  assert.equal(farm._cadence([], now), 600000, "nothing at all: idle");
  assert.equal(farm._cadence([at(2 * MIN + 1000)], now), 60000, "just over two minutes to go: soon");
  assert.equal(farm._cadence([at(14 * MIN)], now), 60000, "within 15 minutes: soon");
  assert.equal(farm._cadence([at(16 * MIN)], now), 600000, "more than 15 minutes away: idle");
  assert.equal(farm._cadence([at(-10 * MIN - 1000)], now), 120000, "just past the ten minutes: inside its window");
  assert.equal(farm._cadence([at(-86400e3)], now), 120000, "started yesterday: inside its window");
  assert.equal(farm._cadence([{ startAt: null, endAt: new Date(now + MIN) }], now), 120000, "no start known");
  assert.equal(farm._cadence([at(-5 * MIN, -MIN)], now), 600000, "an ended campaign does not count, even near its start");
  assert.equal(farm._cadence([at(-86400e3), at(10 * MIN)], now), 60000, "the most urgent of the old values");
});

test("the watcher's next look is 30 s away while a candidate is in its start window, and as before otherwise", async () => {
  await fresh();
  await addAccount("acc1");
  // Inside its window, but not live yet: the bot sleeps and looks again soon.
  world.addCampaign({ live: false, itemList: [60], startDate: kst(Date.now() - MIN) });
  await farm.campaignsView({ force: true });
  const made = await farm.createBot({ mode: "auto", accountIds: ["acc1"] });
  assert.equal(made.ok, true, made.error);
  assert.equal(farm.sessions.size, 0);
  let gap = farm.nextWatchAt - Date.now();
  assert.ok(gap > 25000 && gap <= 30000, `next look in ${gap} ms`);

  await fresh();
  await addAccount("acc1");
  world.addCampaign({ live: false, itemList: [60] }); // started a day ago
  await farm.campaignsView({ force: true });
  assert.equal((await farm.createBot({ mode: "auto", accountIds: ["acc1"] })).ok, true);
  gap = farm.nextWatchAt - Date.now();
  assert.ok(gap > 115000 && gap <= 120000, `next look in ${gap} ms`);
});

// ---- _parked ------------------------------------------------------------------

// One campaign per start offset, all live and remembered by the store, and a
// session-shaped object parked on each: the cool-down it was given.
async function coolDowns(offsets, { live = true } = {}) {
  await addAccount("reader");
  const camps = offsets.map((o) => world.addCampaign({ live, itemList: [60], startDate: kst(Date.now() + o) }));
  await farm.campaignsView({ force: true });
  return camps.map((c, i) => {
    const id = "p" + i;
    farm._parked({ id, botId: "b", view: { dropsIdx: c.dropsIdx, title: c.title, goal: 60 } }, "no channel is on air");
    const z = farm.sleep.get(id);
    return z.coolUntil - z.at.getTime();
  });
}

const near = (got, want, why) => assert.ok(got >= want && got <= want + 50, `${why}: cool-down ${got} ms, want ${want}`);

test("_parked: a held campaign in its start window cools down 60 s; outside it still 180 s", async () => {
  await fresh();
  const [justStarted, aboutToStart, nineIn, elevenIn, threeAway, yesterday] = await coolDowns([
    -MIN, 90000, -9 * MIN, -11 * MIN, 3 * MIN, -86400e3,
  ]);
  near(justStarted, 60000, "started a minute ago");
  near(aboutToStart, 60000, "starts in ninety seconds");
  near(nineIn, 60000, "nine minutes in");
  near(elevenIn, 180000, "eleven minutes in");
  near(threeAway, 180000, "three minutes before the start");
  near(yesterday, 180000, "started yesterday");
});

test("_parked: a campaign that is not held gets no cool-down, in the window or not", async () => {
  await fresh();
  const [inWindow, outside] = await coolDowns([-MIN, -86400e3], { live: false });
  assert.equal(inWindow, 0);
  assert.equal(outside, 0);
});

test("_parked: timings.parkCooldownStartMs and parkCooldownMs override each side of the window", async () => {
  await fresh({ timings: { ...FAST, parkCooldownStartMs: 5000, parkCooldownMs: 7000 } });
  const [inWindow, outside] = await coolDowns([-MIN, -86400e3]);
  near(inWindow, 5000, "in the window");
  near(outside, 7000, "outside it");
});

// ---- end to end ----------------------------------------------------------------

// The case the change is for: the campaign has just started, SOOP lists it live,
// but no channel is on air yet. The session parks, and the cool-down decides
// when the watcher may try again.
async function parkOnQuietStart(startOffset) {
  const camp = world.addCampaign({ live: true, itemList: [60], broadIdList: ["quiet"], startDate: kst(Date.now() + startOffset) });
  world.setOnAir("quiet", false);
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const made = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(made.ok, true, made.error);
  const z = await until(() => {
    const x = farm.sleep.get("acc1");
    return !farm.sessions.has("acc1") && x && x.coolUntil > 0 ? x : null;
  }, "asleep with a cool-down");
  assert.match(z.detail, /no channel is on air/);
  return z.coolUntil - z.at.getTime();
}

test("end to end: a session that parks a minute after the start may retry after 60 s", async () => {
  await fresh();
  near(await parkOnQuietStart(-MIN), 60000, "a minute after the start");
});

test("end to end: the same park on a campaign that started yesterday still waits 180 s", async () => {
  await fresh();
  near(await parkOnQuietStart(-86400e3), 180000, "a day after the start");
});

// ---- one wake at a time --------------------------------------------------------

// The timer ticks every 30 s; a wake behind a slow campaign list (SOOP read
// through the Pi) can take longer. Call this once the accounts, campaigns and
// bots are in place: the next list read waits for release(), the next look is
// due, and every wake is logged with how many ran at once.
function slowNextWake() {
  const proto = Object.getPrototypeOf(farm);
  let release;
  const gate = new Promise((r) => (release = r));
  let slow = true;
  farm.farmable = async function () {
    if (slow) {
      slow = false;
      await gate;
    }
    return proto.farmable.call(this);
  };
  const log = [];
  let running = 0;
  let most = 0;
  farm._wake = async function (active) {
    running++;
    most = Math.max(most, running);
    log.push("start " + active.length);
    try {
      return await proto._wake.call(this, active);
    } finally {
      running--;
      log.push("end");
    }
  };
  farm.nextWatchAt = 0;
  return {
    release,
    log,
    most: () => most,
    restore() {
      delete farm.farmable;
      delete farm._wake;
    },
  };
}

// An auto bot on a campaign that started a day ago and is not live: each wake
// reads the list and puts acc1 back to sleep.
async function sleepingBot() {
  await addAccount("acc1");
  world.addCampaign({ live: false, itemList: [60] });
  await farm.campaignsView({ force: true });
  const made = await farm.createBot({ mode: "auto", accountIds: ["acc1"] });
  assert.equal(made.ok, true, made.error);
  return made.bot;
}

test("a tick that finds a slow wake still running wakes nothing itself; the running wake sets the next look", async () => {
  await fresh();
  await sleepingBot();
  const w = slowNextWake();
  try {
    let firstDone = false;
    const first = farm._reconcile().then(() => (firstDone = true));
    await until(() => w.log.length === 1, "the first wake started");
    await farm._reconcile(); // the next tick, while the first wake waits on the list
    assert.equal(firstDone, false, "the first wake is still running");
    assert.deepEqual(w.log, ["start 1"], "the tick started no wake of its own");

    w.release();
    await first;
    assert.deepEqual(w.log, ["start 1", "end"], "one wake in all");
    assert.equal(w.most(), 1);
    assert.equal(farm.waking, null);
    // nextWatchAt as before: set by the wake that ran, and a tick before it wakes nothing.
    assert.ok(farm.nextWatchAt > Date.now() + 60000, `next look in ${farm.nextWatchAt - Date.now()} ms`);
    await farm._reconcile();
    assert.deepEqual(w.log, ["start 1", "end"], "not due yet");
  } finally {
    w.release();
    w.restore();
  }
});

test("a forced reconcile during a slow wake waits for it, then wakes once more", async () => {
  await fresh();
  await sleepingBot();
  const w = slowNextWake();
  try {
    const first = farm._reconcile();
    await until(() => w.log.length === 1, "the first wake started");
    let forcedDone = false;
    const forced = farm._reconcile({ force: true }).then(() => (forcedDone = true));
    await sleep(60);
    assert.deepEqual(w.log, ["start 1"], "no second wake beside the first");
    assert.equal(forcedDone, false, "the forced call is waiting");

    w.release();
    await Promise.all([first, forced]);
    assert.deepEqual(w.log, ["start 1", "end", "start 1", "end"], "its own wake, after the first had ended");
    assert.equal(w.most(), 1);
    assert.equal(farm.waking, null);
  } finally {
    w.release();
    w.restore();
  }
});

test("a bot created during a slow wake is woken by the wake that follows it, never beside it", async () => {
  await fresh();
  await sleepingBot();
  await addAccount("acc2");
  const camp = world.addCampaign({ live: true, itemList: [60, 120] });
  await farm.campaignsView({ force: true });
  const w = slowNextWake();
  try {
    const first = farm._reconcile();
    await until(() => w.log.length === 1, "the first wake started");
    // createBot ends in a forced reconcile: the same wait, then a wake that sees the new bot.
    let made = null;
    const creating = farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc2"] }).then((r) => (made = r));
    await sleep(60);
    assert.equal(made, null, "createBot waits for the running wake");
    assert.equal(farm.sessions.has("acc2"), false);
    assert.deepEqual(w.log, ["start 1"]);

    w.release();
    await Promise.all([first, creating]);
    assert.equal(made.ok, true, made.error);
    assert.deepEqual(w.log, ["start 1", "end", "start 2", "end"], "the second wake had both bots");
    assert.equal(w.most(), 1);
    assert.equal(farm.sessions.has("acc2"), true, "acc2 joined on the wake after");
  } finally {
    w.release();
    w.restore();
  }
});
