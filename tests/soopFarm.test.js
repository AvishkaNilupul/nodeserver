// End-to-end tests for the SOOP farm service and worker against the in-memory
// fake SOOP (tests/helpers/soopFake.js). No network. The first five tests pin
// the defects found in v1 on 2026-10-05 so they cannot come back.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-farm-test-cred-secret";

const SoopAccount = require("../models/SoopAccount");
const SoopFarmTask = require("../models/SoopFarmTask");
const farm = require("../utils/soopFarm");
const { createFakeSoop } = require("./helpers/soopFake");

const FAST = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 300, flatPolls: 3, backoffMs: [40], readFailures: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const tickets = new Map();

async function fresh({ ttlMs = 15, timings = FAST } = {}) {
  await farm._reset({ store: { ttlMs } });
  await Promise.all([SoopAccount.deleteMany({}), SoopFarmTask.deleteMany({})]);
  world = createFakeSoop();
  tickets.clear();
  farm.setClientFactory(world.clientFor);
  farm.timings = timings;
  farm.autoInventory = false;
}

async function addAccount(id, opts = {}) {
  const cookies = world.addAccount({ id, ...opts });
  tickets.set(id, cookies[0].value);
  const [r] = await farm.importAccounts(JSON.stringify(cookies));
  assert.equal(r.ok, true, r.error);
  return id;
}

const bridgesOf = (id) => world.bridges().filter((b) => b.id === id);
const status = async (id) => (await SoopAccount.findOne({ loginId: id }).lean()).status;
const botState = async (id) => (await farm.stateView()).bots.find((b) => b.id === id);

// Advance the fake clock a minute at a time until `done()` holds.
async function watch(done, label, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    world.advance(1);
    await sleep(35);
  }
  assert.fail("never happened: " + label);
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

test("stopping a bot and starting it again at once keeps one session and one socket", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [60, 120] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { ok, bot, error } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(ok, true, error);
  await until(() => bridgesOf("acc1").length === 1, "first socket");

  const t0 = Date.now();
  await farm.stopBot(bot.id);
  assert.ok(Date.now() - t0 < 1000, "stop must not wait out a sleep");
  assert.equal(bridgesOf("acc1").length, 0, "socket closed by the stop");
  await farm.resumeBot(bot.id);
  await until(() => bridgesOf("acc1").length === 1, "socket after resume");
  await sleep(200); // many idle/poll cycles: the old worker has long since exited

  assert.equal(farm.sessions.size, 1, "the new session is still tracked");
  assert.equal(bridgesOf("acc1").length, 1, "exactly one socket for the account");
  const acc = (await farm.stateView()).accounts.find((a) => a.id === "acc1");
  assert.ok(acc.session, "the panel still sees the running session");
  assert.equal(acc.botId, bot.id);
});

test("a finished campaign closes its socket and is not reopened, listed or delisted", async () => {
  await fresh();
  const listed = world.addCampaign({ live: true, itemList: [2, 4] });
  const gone = world.addCampaign({ live: true, itemList: [3] });
  await addAccount("acc1");
  await addAccount("acc2");
  await farm.campaignsView({ force: true });
  world.delist(gone.dropsIdx); // SOOP drops it from the list mid-broadcast

  const a = await farm.createBot({ mode: "campaign", dropsIdx: listed.dropsIdx, accountIds: ["acc1"] });
  const b = await farm.createBot({ mode: "campaign", dropsIdx: gone.dropsIdx, accountIds: ["acc2"] });
  assert.equal(a.ok && b.ok, true, a.error || b.error);
  await watch(
    async () => (await botState(a.bot.id)).state === "finished" && (await botState(b.bot.id)).state === "finished",
    "both bots finished",
  );

  assert.equal(world.bridges().length, 0, "no socket left open");
  assert.equal(farm.sessions.size, 0);
  const opened = world.calls().openBridge;
  await sleep(250);
  assert.equal(world.calls().openBridge, opened, "nothing reconnects after the goal");
  const doc = await SoopAccount.findOne({ loginId: "acc1" }).lean();
  await until(async () => ((await SoopAccount.findOne({ loginId: "acc1" }).lean()).progress || {})[listed.dropsIdx], "progress saved");
  assert.ok(doc, "account still there");
  const saved = (await SoopAccount.findOne({ loginId: "acc1" }).lean()).progress[listed.dropsIdx];
  assert.equal(saved.done, true);
  assert.equal(saved.goal, 4);
});

test("a login that dies while farming is marked logged out, alerted, and revived by a re-import", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [60] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { bot } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  await until(() => bridgesOf("acc1").length === 1, "socket");

  world.logout("acc1");
  await until(async () => (await status("acc1")) === "not_logged_in", "account marked logged out");
  await until(() => farm.sessions.size === 0, "session ended");
  const state = await farm.stateView();
  assert.ok(state.alerts.some((x) => x.kind === "auth" && x.accountId === "acc1"), "auth alert raised");
  assert.equal(state.totals.dead, 1);
  await sleep(120);
  assert.equal(bridgesOf("acc1").length, 0, "no socket is burned on a dead login");

  await addAccount("acc1"); // the owner pastes a fresh cookie
  assert.equal(await status("acc1"), "ok");
  await until(() => bridgesOf("acc1").length === 1, "farming resumes in the same bot");
  assert.equal((await botState(bot.id)).active, true);
});

test("joined but not credited backs off, says so, and frees the socket", async () => {
  await fresh({ timings: { ...FAST, backoffMs: [30000] } });
  world.setEgress({ country: "US" }); // a country SOOP does not pay drops in
  const camp = world.addCampaign({ live: true, itemList: [60] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { bot } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  await until(() => bridgesOf("acc1").length === 1, "socket");
  for (let i = 0; i < 6; i++) {
    world.advance(1);
    await sleep(25);
  }
  const s = await until(() => {
    const x = farm.sessions.get("acc1");
    return x && x.view.state === "backoff" ? x : null;
  }, "back-off state");
  assert.equal(s.view.credited, false);
  assert.match(s.view.detail, /not counting minutes/);
  assert.equal(bridgesOf("acc1").length, 0, "socket released while backing off");
  const state = await farm.stateView();
  assert.ok(state.alerts.some((x) => x.kind === "not-crediting" && x.accountId === "acc1"));
  assert.ok(state.alerts.some((x) => x.kind === "country"), "uncredited country is called out");
  assert.equal(state.egress.country, "US");
  assert.equal(state.egress.credited, "no");

  const t0 = Date.now();
  await farm.stopBot(bot.id);
  assert.ok(Date.now() - t0 < 1000, "a 30 s back-off is interrupted by stop");
});

test("idle sessions share one campaign scan instead of each scanning", async () => {
  await fresh({ ttlMs: 5000 });
  const camp = world.addCampaign({ live: false, itemList: [60] });
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) await addAccount(id);
  await farm.campaignsView({ force: true });
  const before = world.calls().campaignsAll;
  await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["a1", "a2", "a3", "a4", "a5"] });
  await sleep(300); // ~15 idle loops per account
  assert.ok(world.calls().campaignsAll - before <= 1, "at most one scan inside the cache window");
  assert.equal(farm.sessions.size, 5);
  const acc = (await farm.stateView()).accounts[0];
  assert.equal(acc.session.state, "waiting");
  assert.match(acc.session.detail, /not live/);
});

test("a game bot farms each campaign of its game in turn and keeps waiting", async () => {
  await fresh();
  const first = world.addCampaign({ gameNo: "12", live: true, itemList: [2], broadIdList: ["ow1"] });
  const second = world.addCampaign({ gameNo: "12", live: false, itemList: [2], broadIdList: ["ow2"] });
  world.addCampaign({ gameNo: "18", live: true, itemList: [2], broadIdList: ["er1"] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { ok, bot, error } = await farm.createBot({ mode: "game", gameNo: "12", accountIds: ["acc1"] });
  assert.equal(ok, true, error);

  const seen = new Set();
  const note = () => world.bridges().forEach((b) => seen.add(b.channel));
  await watch(() => (note(), (farm.progress.get("acc1") || {})[first.dropsIdx]?.done), "first campaign done");
  world.setLive(second.dropsIdx, true);
  world.setOnAir("ow2", true);
  await watch(() => (note(), (farm.progress.get("acc1") || {})[second.dropsIdx]?.done), "second campaign done");
  await sleep(100);

  assert.ok(seen.has("ow1") && seen.has("ow2"));
  assert.ok(!seen.has("er1"), "another game's campaign is never joined");
  const view = await botState(bot.id);
  assert.equal(view.active, true, "a game bot does not finish on its own");
  assert.equal(view.state, "waiting");
  assert.ok(farm.sessions.has("acc1"), "still waiting for the next campaign");
  assert.equal(world.bridges().length, 0);
});

test("accounts cannot be double-booked, and sold or logged-out accounts are refused", async () => {
  await fresh();
  const camp = world.addCampaign({ live: false, itemList: [60] });
  for (const id of ["acc1", "acc2", "acc3"]) await addAccount(id);
  await farm.campaignsView({ force: true });
  const first = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(first.ok, true, first.error);

  const again = await farm.createBot({ mode: "auto", accountIds: ["acc1"] });
  assert.equal(again.ok, false);
  assert.match(again.error, /already in the bot/);

  await farm.updateAccount("acc2", { sold: true });
  const sold = await farm.createBot({ mode: "auto", accountIds: ["acc2"] });
  assert.match(sold.error, /sold/);

  world.logout("acc3");
  await farm.health.check("acc3");
  const dead = await farm.createBot({ mode: "auto", accountIds: ["acc3"] });
  assert.match(dead.error, /logged out/);

  assert.equal(farm.sessions.has("acc1"), true);
  await farm.updateAccount("acc1", { sold: true });
  assert.equal(farm.sessions.has("acc1"), false, "marking sold stops farming");
  assert.match((await farm.createBot({ mode: "campaign", accountIds: ["acc1"] })).error, /campaign/i);
  assert.match((await farm.createBot({ mode: "game", accountIds: ["acc1"] })).error, /game/i);
});

test("bots and their progress survive a process restart", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [50] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { bot } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"], name: "OW weekend" });
  await until(() => bridgesOf("acc1").length === 1, "socket");
  await watch(() => (farm.progress.get("acc1") || {})[camp.dropsIdx]?.minutes >= 3, "some minutes");

  await farm._reset({ store: { ttlMs: 15 } }); // the process dies…
  assert.equal(world.bridges().length, 0);
  farm.setClientFactory(world.clientFor);
  farm.timings = FAST;
  farm.autoInventory = false;
  await farm.start(); // …and comes back

  await until(() => bridgesOf("acc1").length === 1, "session resumed");
  const view = await botState(bot.id);
  assert.equal(view.name, "OW weekend");
  assert.equal(view.active, true);
  assert.ok((farm.progress.get("acc1") || {})[camp.dropsIdx].max >= 3, "progress reloaded");
});

test("a waiting account shows the minutes it already has, even with no saved progress", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [50], broadIdList: ["ch1"] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { bot } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  await watch(() => (farm.progress.get("acc1") || {})[camp.dropsIdx]?.minutes >= 4, "four minutes earned");
  world.setLive(camp.dropsIdx, false); // the broadcast is over for today
  world.setOnAir("ch1", false);

  await farm._reset({ store: { ttlMs: 15 } });
  await SoopAccount.updateMany({}, { $set: { progress: {} } }); // as on the first boot of v2
  farm.setClientFactory(world.clientFor);
  farm.timings = FAST;
  farm.autoInventory = false;
  await farm.start();

  const s = await until(() => {
    const x = farm.sessions.get("acc1");
    return x && x.view.state === "waiting" && x.view.dropsIdx ? x : null;
  }, "waiting on the campaign");
  assert.ok(s.view.minutes >= 4, "minutes read from SOOP at start, got " + s.view.minutes);
  assert.equal(s.view.goal, 50);
  assert.equal(world.bridges().length, 0, "no socket while nothing is live");
  const view = await botState(bot.id);
  assert.ok(view.minutes.sum >= 4, "the bot's progress bar counts them too");
});

test("the panel state never contains a stored cookie", async () => {
  await fresh();
  world.addCampaign({ live: true });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  await farm.createBot({ mode: "auto", accountIds: ["acc1"] });
  await until(() => farm.sessions.size === 1, "session");
  const body = JSON.stringify(await farm.stateView()) + JSON.stringify(await farm.campaignsView());
  assert.ok(!body.includes(tickets.get("acc1")), "AuthTicket value leaked");
  assert.ok(!body.includes("cookies"));
});
