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

const FAST = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 300, flatPolls: 3, backoffMs: [40], readFailures: 3, primePaceMs: 1, parkCooldownMs: 60 };
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

test("a bot with nothing live sleeps — no sessions, no sockets, no polling — and wakes when its campaign goes live", async () => {
  await fresh();
  const camp = world.addCampaign({ live: false, itemList: [60], broadIdList: ["ow1"] });
  const ids = ["a1", "a2", "a3", "a4", "a5"];
  for (const id of ids) await addAccount(id);
  await farm.campaignsView({ force: true });
  const { bot } = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ids });
  await sleep(120);

  assert.equal(farm.sessions.size, 0, "nothing runs for a sleeping bot");
  assert.equal(world.bridges().length, 0);
  assert.equal(farm.clients.size, 0, "nothing is held in memory for its accounts");
  let state = await farm.stateView();
  assert.equal(state.totals.sleeping, 5);
  assert.equal(state.accounts[0].session.state, "sleeping");
  assert.match(state.accounts[0].session.detail, /not live/);
  assert.equal(state.accounts[0].session.goal, 60);
  assert.equal((await botState(bot.id)).state, "sleeping");

  const before = world.calls();
  await sleep(300); // v1 would have polled SOOP ~15 times per account in this window
  const after = world.calls();
  assert.equal(after.campaignsAll, before.campaignsAll, "a sleeping bot does not poll the campaign list");
  assert.equal(after.liveInfo, before.liveInfo);
  assert.equal(after.openBridge, 0);

  world.setLive(camp.dropsIdx, true); // the broadcast starts
  world.setOnAir("ow1", true);
  await farm._reconcile({ force: true }); // the watcher's next look
  await until(() => world.bridges().length === 5, "all five accounts woke and joined");
  state = await farm.stateView();
  assert.equal(state.totals.sleeping, 0);
  await until(async () => (await botState(bot.id)).state === "running", "bot shown as running");
});

test("live but no channel on air: the account sleeps and is not restarted during the cool-down", async () => {
  await fresh({ timings: { ...FAST, parkCooldownMs: 60000 } });
  const camp = world.addCampaign({ live: true, itemList: [60], broadIdList: ["quiet"] });
  world.setOnAir("quiet", false);
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  await until(() => !farm.sessions.has("acc1") && farm.sleep.has("acc1") && farm.sleep.get("acc1").coolUntil > Date.now(), "asleep with a cool-down");
  const acc = (await farm.stateView()).accounts[0];
  assert.equal(acc.session.state, "sleeping");
  assert.match(acc.session.detail, /no channel is on air/);

  const probes = world.calls().liveInfo;
  for (let i = 0; i < 3; i++) await farm._reconcile({ force: true });
  await sleep(80);
  assert.equal(farm.sessions.has("acc1"), false, "not woken again while cooling down");
  assert.equal(world.calls().liveInfo, probes, "and SOOP is not probed again");

  farm.sleep.get("acc1").coolUntil = 0; // the cool-down passes and a streamer comes online
  require("../utils/soopWorker").channelMemo.clear(); // (the "nobody is live" note lasts 90 s)
  world.setOnAir("quiet", true);
  await farm._reconcile({ force: true });
  await until(() => bridgesOf("acc1").length === 1, "woken and farming");
});

test("a game bot farms each campaign of its game in turn, then sleeps until the next one", async () => {
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
  await until(() => !farm.sessions.has("acc1"), "asleep after the first campaign");
  world.setLive(second.dropsIdx, true);
  world.setOnAir("ow2", true);
  await sleep(30); // let the 15 ms campaign cache of this test expire
  await farm._reconcile({ force: true });
  await watch(() => (note(), (farm.progress.get("acc1") || {})[second.dropsIdx]?.done), "second campaign done");
  await sleep(100);

  assert.ok(seen.has("ow1") && seen.has("ow2"));
  assert.ok(!seen.has("er1"), "another game's campaign is never joined");
  const view = await botState(bot.id);
  assert.equal(view.active, true, "a game bot does not finish on its own");
  await until(() => !farm.sessions.has("acc1"), "asleep again once everything is farmed");
  assert.equal((await botState(bot.id)).state, "sleeping");
  assert.equal(world.bridges().length, 0);
  const opened = world.calls().openBridge;
  await farm._reconcile({ force: true }); // both campaigns are still live, but farmed
  await sleep(100);
  assert.equal(farm.sessions.has("acc1"), false, "a finished account is not woken for campaigns it has farmed");
  assert.equal(world.calls().openBridge, opened);
  assert.match((await farm.stateView()).accounts[0].session.detail, /everything is farmed/i);
});

test("an everything bot farms other games but drops them for the priority game the moment it goes live", async () => {
  await fresh();
  const er = world.addCampaign({ gameNo: "18", live: true, itemList: [500], broadIdList: ["er1"] });
  const ow = world.addCampaign({ gameNo: "12", live: false, itemList: [3], broadIdList: ["ow1"] });
  await addAccount("acc1");
  await farm.campaignsView({ force: true });
  const { ok, bot, error } = await farm.createBot({ mode: "auto", priorityGameNo: "12", codesOnly: true, accountIds: ["acc1"] });
  assert.equal(ok, true, error);
  assert.equal(bot.priorityGameNo, "12");
  const on = () => world.bridges().filter((b) => b.id === "acc1").map((b) => b.channel).join(",");

  await until(() => on() === "er1", "farming the other game meanwhile");
  await watch(() => (farm.progress.get("acc1") || {})[er.dropsIdx]?.minutes >= 2, "earning on it");

  // The priority campaign is listed live but nobody is streaming: stay put.
  world.setLive(ow.dropsIdx, true);
  const opened = world.calls().openBridge;
  for (let i = 0; i < 6; i++) { world.advance(1); await sleep(35); }
  assert.equal(on(), "er1");
  assert.equal(world.calls().openBridge, opened, "no reconnect churn while the priority game has no stream");

  require("../utils/soopWorker").channelMemo.clear(); // (the "nobody is live" note lasts 90 s)
  world.setOnAir("ow1", true); // the Overwatch broadcast starts
  await watch(() => on() === "ow1", "switched to the priority game");
  assert.equal(world.bridges().length, 1, "one socket: it left the other game first");
  assert.match(farm.activity.recent({ limit: 30 }).map((e) => e.msg).join(" | "), /left .* for .* — the priority game went live/);

  await watch(() => (farm.progress.get("acc1") || {})[ow.dropsIdx]?.done, "priority campaign farmed");
  await watch(() => on() === "er1", "back to the other game afterwards");
  assert.equal((await botState(bot.id)).priorityGameName, "Overwatch");
});

test("an everything bot still farms a campaign SOOP dropped from its list, but only inside its window", async () => {
  await fresh();
  const kstStr = (ms) => new Date(ms + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
  const gone = world.addCampaign({ gameNo: "200", live: false, itemList: [2], broadIdList: ["df1"] });
  const over = world.addCampaign({ gameNo: "200", live: false, itemList: [2], broadIdList: ["old1"], endDate: kstStr(Date.now() - 3600e3) });
  await addAccount("acc1");
  await farm.campaignsView({ force: true }); // both are remembered while still listed
  world.delist(gone.dropsIdx); // SOOP drops them from the list before the broadcast
  world.delist(over.dropsIdx);
  await farm.createBot({ mode: "auto", codesOnly: true, accountIds: ["acc1"] });
  await sleep(150);
  assert.equal(world.bridges().length, 0, "nothing on air yet");

  world.setLive(gone.dropsIdx, true); // the broadcast starts; the campaign stays delisted
  world.setOnAir("df1", true);
  world.setOnAir("old1", true);
  require("../utils/soopWorker").channelMemo.clear();
  farm.sleep.forEach((z) => { z.coolUntil = 0; });
  await sleep(30);
  await farm._reconcile({ force: true });
  await watch(() => (farm.progress.get("acc1") || {})[gone.dropsIdx]?.done, "the delisted campaign was farmed");
  await sleep(120);
  assert.ok(!world.bridges().some((b) => b.channel === "old1"), "a delisted campaign past its end is never tried");
  assert.equal(world.calls().openBridge, 1);
});

test("accounts cannot be double-booked, and sold or logged-out accounts are refused", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [60] });
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

test("a sleeping account shows the minutes it already has, even with no saved progress", async () => {
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
  const readsBefore = world.calls().missions;
  await farm.start();

  const acc = await until(async () => {
    const x = (await farm.stateView()).accounts[0];
    return x.session && x.session.state === "sleeping" && x.session.minutes >= 4 ? x : null;
  }, "asleep, showing the minutes read from SOOP");
  assert.equal(acc.session.goal, 50);
  assert.equal(farm.sessions.size, 0, "no session while nothing is live");
  assert.equal(world.bridges().length, 0, "and no socket");
  await sleep(150);
  assert.ok(world.calls().missions - readsBefore <= 2, "one progress read at start, not a poll");
  const view = await botState(bot.id);
  assert.ok(view.minutes.sum >= 4, "the bot's progress bar counts them too");
});

test("claiming a reward stores its code encrypted, survives a sync, and is refused when it must be", async () => {
  await fresh();
  await addAccount("acc1");
  const SoopInventoryItem = require("../models/SoopInventoryItem");
  await SoopInventoryItem.deleteMany({});
  world.addInventory("acc1", { itemName: "Sun Tea Icon", claimCode: "OW-CODE-12345" });
  world.addInventory("acc1", { itemName: "Shell Credit", itemType: "4", ingameGiveYn: "Y", acctConn: false });
  world.addInventory("acc1", { itemName: "Old Spray", claimCode: "OLD-1" }, "expired");
  world.addInventory("acc1", { itemName: "Claimed By Hand", claimCode: "HAND-777" }, "acquired");
  await farm.inventory.syncAccount("acc1");
  const byName = async () => Object.fromEntries((await farm.inventory.forAccount("acc1")).map((i) => [i.name, i]));
  let items = await byName();
  assert.equal(items["Sun Tea Icon"].division, "available");
  assert.equal(items["Sun Tea Icon"].hasCode, false, "an unclaimed reward has no code yet");

  // Looking must never claim: reveal on an unclaimed reward does not call SOOP.
  assert.equal(await farm.inventory.reveal(items["Sun Tea Icon"].id), null);
  assert.equal(world.calls().useInfo, 0);

  // Refusals are decided before SOOP is asked.
  assert.match((await farm.inventory.claim(items["Shell Credit"].id)).error, /link the game account/i);
  assert.match((await farm.inventory.claim(items["Old Spray"].id)).error, /expired/i);
  assert.match((await farm.inventory.claim(items["Claimed By Hand"].id)).error, /already claimed/i);
  assert.match((await farm.inventory.claim("000000000000000000000000")).error, /unknown/i);
  assert.equal(world.calls().useInfo, 0, "nothing was claimed by a refused request");

  const out = await farm.inventory.claim(items["Sun Tea Icon"].id);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.kind, "code");
  assert.equal(out.result.code, "OW-CODE-12345");
  assert.match(out.result.description, /Redeem at example\.test\nwithin 30 days/, "instructions kept as plain text");
  assert.equal(world.calls().useInfo, 1);

  await farm.inventory.syncAccount("acc1"); // a later sync must not wipe the code
  items = await byName();
  assert.equal(items["Sun Tea Icon"].division, "acquired");
  assert.equal(items["Sun Tea Icon"].hasCode, true);
  assert.equal(items["Sun Tea Icon"].claim.kind, "code");
  const stored = await SoopInventoryItem.findById(items["Sun Tea Icon"].id).lean();
  assert.match(stored.codeEnc, /^enc:v1:/);
  const everything = JSON.stringify(await farm.inventory.forAccount("acc1")) + JSON.stringify(stored) + (await farm.inventory.csv());
  assert.ok(!everything.includes("OW-CODE-12345"), "the code is nowhere in clear text");
  assert.equal((await farm.inventory.reveal(items["Sun Tea Icon"].id)).code, "OW-CODE-12345");
  assert.equal(world.calls().useInfo, 1, "a stored code is shown without asking SOOP again");

  // A reward claimed by hand on SOOP: its code is read back once, then kept.
  assert.equal((await farm.inventory.reveal(items["Claimed By Hand"].id)).code, "HAND-777");
  assert.equal((await farm.inventory.reveal(items["Claimed By Hand"].id)).code, "HAND-777");
  assert.equal(world.calls().useInfo, 2);
  const log = farm.activity.recent({ limit: 50 }).map((e) => e.msg).join(" | ");
  assert.match(log, /Claimed "Sun Tea Icon" on acc1/);
  assert.ok(!log.includes("OW-CODE-12345"), "the activity log never holds a code");
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
