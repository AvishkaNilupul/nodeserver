// SOOP farm: new logins join a bot by themselves (docs/code-shop/04-OPS.md,
// "Farm changes" 1), and the account view's cookie-renewal fields (item 3).
// Driven against the in-memory fake SOOP (tests/helpers/soopFake.js) with the
// harness of tests/soopFarm.test.js. No network.
/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-autojoin-test-cred-secret";
delete process.env.SOOP_PROXY_URL; // the transport is only described, never used

const SoopAccount = require("../models/SoopAccount");
const SoopFarmTask = require("../models/SoopFarmTask");
const farm = require("../utils/soopFarm");
const views = require("../utils/soop/farmViews");
const soopRoutes = require("../routes/soopRoutes");
const { sleep: workerSleep } = require("../utils/soopWorker");
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

async function fresh({ ttlMs = 15, timings = FAST } = {}) {
  await farm._reset({ store: { ttlMs } });
  await Promise.all([SoopAccount.deleteMany({}), SoopFarmTask.deleteMany({})]);
  world = createFakeSoop();
  farm.setClientFactory(world.clientFor);
  farm.timings = timings;
  farm.autoInventory = false;
}

// One import call for one or more new logins; every one must be accepted.
async function importIds(...ids) {
  const text = ids.map((id) => JSON.stringify(world.addAccount({ id }))).join("\n");
  const results = await farm.importAccounts(text);
  assert.deepEqual(results.map((r) => [r.id, r.ok]), ids.map((id) => [id, true]), JSON.stringify(results));
  return results;
}

// A login that already exists, imported again (a fresh cookie for it).
async function reimport(id) {
  return farm.importAccounts(JSON.stringify(world.addAccount({ id })));
}

const docOf = async (botId) => SoopFarmTask.findById(botId).lean();
const joinRows = (botId) => farm.activity.recent({ botId }).filter((e) => /automatically/.test(e.msg));
const inAnyBot = (id) => [...farm.bots.values()].some((b) => b.accountIds.includes(id));

async function makeBot(opts) {
  const r = await farm.createBot({ mode: "auto", ...opts });
  assert.equal(r.ok, true, r.error);
  return r.bot;
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // A paste of several logins is paced 1.5 s apart; not here (as in soopRoutes.test.js).
  farm.setClock({ sleep: (ms, signal) => workerSleep(Math.min(ms, 25), signal) });
});

test.after(async () => {
  await farm._reset();
  await mongoose.disconnect();
  await mongod.stop();
});

test("autoJoin is off unless asked for, is stored on create, and the bot view carries it", async () => {
  await fresh();
  await importIds("a1", "a2");
  const plain = await makeBot({ accountIds: ["a1"] });
  assert.equal(plain.autoJoin, false);
  assert.equal((await docOf(plain.id)).autoJoin, false);

  const joiner = await makeBot({ accountIds: ["a2"], autoJoin: true });
  assert.equal(joiner.autoJoin, true);
  assert.equal((await docOf(joiner.id)).autoJoin, true);
  const state = await farm.stateView();
  assert.equal(state.bots.find((b) => b.id === joiner.id).autoJoin, true);
  assert.equal(state.bots.find((b) => b.id === plain.id).autoJoin, false);

  // A restart reads it back.
  await farm._loadBots();
  assert.equal(farm.bots.get(joiner.id).autoJoin, true);
  assert.equal(farm.bots.get(plain.id).autoJoin, false);
});

test("updateBot({ autoJoin }) persists it and restarts no session", async () => {
  await fresh();
  const camp = world.addCampaign({ live: true, itemList: [60, 120] });
  await importIds("acc1");
  await farm.campaignsView({ force: true });
  const made = await farm.createBot({ mode: "campaign", dropsIdx: camp.dropsIdx, accountIds: ["acc1"] });
  assert.equal(made.ok, true, made.error);
  await until(() => world.bridges().filter((b) => b.id === "acc1").length === 1, "acc1 farming");
  const session = farm.sessions.get("acc1");
  // Every stop and start of a session goes through these two.
  const proto = Object.getPrototypeOf(farm);
  const calls = [];
  farm._stopSession = function (id) {
    calls.push("stop " + id);
    return proto._stopSession.call(this, id);
  };
  farm._startSession = function (id, bot) {
    calls.push("start " + id);
    return proto._startSession.call(this, id, bot);
  };
  try {
    const on = await farm.updateBot(made.bot.id, { autoJoin: true });
    assert.equal(on.ok, true, on.error);
    assert.equal(on.bot.autoJoin, true);
    assert.equal((await docOf(made.bot.id)).autoJoin, true);
    await sleep(120);
    assert.equal(farm.sessions.get("acc1"), session, "the same session runs on");
    assert.equal(session.ctrl.signal.aborted, false, "and it was never stopped");

    const off = await farm.updateBot(made.bot.id, { autoJoin: false });
    assert.equal(off.bot.autoJoin, false);
    assert.equal((await docOf(made.bot.id)).autoJoin, false);
    assert.equal(farm.sessions.get("acc1"), session);
    assert.equal(session.ctrl.signal.aborted, false);
    assert.deepEqual(calls, [], "no session was stopped or started");
  } finally {
    delete farm._stopSession;
    delete farm._startSession;
  }
  assert.equal(farm.sessions.get("acc1"), session);

  // Anything that is not a boolean leaves it alone.
  const same = await farm.updateBot(made.bot.id, { autoJoin: "yes" });
  assert.equal(same.bot.autoJoin, false);
});

test("a new login joins the oldest active autoJoin bot; logins already in a bot, and logins not imported, stay put", async () => {
  await fresh();
  await importIds("a1", "a2", "loose");
  const older = await makeBot({ name: "Older", accountIds: ["a1"], autoJoin: true });
  const newer = await makeBot({ name: "Newer", accountIds: ["a2"], autoJoin: true });
  assert.ok(new Date(older.createdAt) <= new Date(newer.createdAt));

  // One paste: a brand-new login, plus a fresh cookie for a login of "Newer".
  const results = await farm.importAccounts(
    [JSON.stringify(world.addAccount({ id: "n1" })), JSON.stringify(world.addAccount({ id: "a2" }))].join("\n"),
  );
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [["n1", true], ["a2", true]]);

  assert.deepEqual((await docOf(older.id)).accountIds, ["a1", "n1"]);
  assert.deepEqual((await docOf(newer.id)).accountIds, ["a2"], "a2 stays in its own bot");
  assert.deepEqual(farm.bots.get(older.id).accountIds, ["a1", "n1"]);
  assert.equal(inAnyBot("loose"), false, "a login that was not in this import is not touched");
  const rows = joinRows(older.id);
  assert.equal(rows.length, 1, "one activity row");
  assert.match(rows[0].msg, /1 new login\(s\) joined the bot "Older" automatically: n1/);
  assert.equal(joinRows(newer.id).length, 0);
  const acc = (await farm.stateView()).accounts.find((a) => a.id === "n1");
  assert.equal(acc.botId, older.id, "the panel shows it in the bot");

  // Oldest by when the bot was made, not by the order bots happen to be held in.
  farm.bots.get(newer.id).createdAt = new Date(Date.now() - 86400e3);
  await importIds("n2");
  assert.deepEqual((await docOf(newer.id)).accountIds, ["a2", "n2"]);
  assert.deepEqual((await docOf(older.id)).accountIds, ["a1", "n1"]);

  // Re-importing a login that is already in the bot changes nothing.
  await reimport("n1");
  assert.deepEqual((await docOf(older.id)).accountIds, ["a1", "n1"]);
  assert.equal(joinRows(older.id).length, 1, "no second row");
});

test("stopped bots and bots without autoJoin are passed over", async () => {
  await fresh();
  await importIds("p1", "s1", "j1");
  const plain = await makeBot({ name: "Plain", accountIds: ["p1"] }); // oldest, but not asking
  const stopped = await makeBot({ name: "Stopped", accountIds: ["s1"], autoJoin: true });
  await farm.stopBot(stopped.id);
  const joiner = await makeBot({ name: "Joiner", accountIds: ["j1"], autoJoin: true }); // newest

  await importIds("n1", "n2");
  assert.deepEqual((await docOf(joiner.id)).accountIds, ["j1", "n1", "n2"]);
  assert.deepEqual((await docOf(plain.id)).accountIds, ["p1"]);
  assert.deepEqual((await docOf(stopped.id)).accountIds, ["s1"]);
  const rows = joinRows(joiner.id);
  assert.equal(rows.length, 1, "one row for the whole import");
  assert.match(rows[0].msg, /2 new login\(s\) joined the bot "Joiner" automatically: n1, n2/);

  // A login held by a stopped bot is still that bot's: it does not move.
  await reimport("s1");
  assert.deepEqual((await docOf(stopped.id)).accountIds, ["s1"]);
  assert.deepEqual((await docOf(joiner.id)).accountIds, ["j1", "n1", "n2"]);
});

test("with no active autoJoin bot an import adds nobody anywhere", async () => {
  await fresh();
  await importIds("p1", "s1");
  const plain = await makeBot({ accountIds: ["p1"] });
  const stopped = await makeBot({ accountIds: ["s1"], autoJoin: true });
  await farm.stopBot(stopped.id);
  const botRows = () => farm.activity.recent().filter((e) => e.kind === "bot").length;
  const before = botRows();

  await importIds("n1");
  assert.equal(inAnyBot("n1"), false);
  assert.deepEqual((await docOf(plain.id)).accountIds, ["p1"]);
  assert.deepEqual((await docOf(stopped.id)).accountIds, ["s1"]);
  assert.equal(farm.activity.recent().filter((e) => /automatically/.test(e.msg)).length, 0);
  assert.equal(botRows(), before, "no bot row at all");
});

test("a sold login is left out, and a refusal or a crash never fails the import", async () => {
  await fresh();
  await importIds("j1", "old");
  const joiner = await makeBot({ name: "Joiner", accountIds: ["j1"], autoJoin: true });

  // A sold login in no bot, re-imported: it cannot farm, so it does not join.
  await farm.updateAccount("old", { sold: true });
  const again = await reimport("old");
  assert.equal(again[0].ok, true);
  assert.equal(inAnyBot("old"), false);
  assert.equal(joinRows(joiner.id).length, 0);

  // updateBot refuses: one warning row, the import is still a success.
  farm.updateBot = async () => ({ ok: false, error: "refused for the test" });
  try {
    await importIds("n1");
  } finally {
    delete farm.updateBot;
  }
  assert.equal(inAnyBot("n1"), false);
  const warned = farm.activity.recent({ botId: joiner.id, level: "warn" });
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /n1 could not join the bot "Joiner" automatically: refused for the test/);

  // updateBot throws: still a success.
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  farm.updateBot = async () => {
    throw new Error("boom");
  };
  try {
    await importIds("n2");
  } finally {
    delete farm.updateBot;
    console.error = realError;
  }
  assert.equal(inAnyBot("n2"), false);
  assert.ok(logged.some((l) => /auto-join after import failed: boom/.test(l)));

  // And with updateBot back, the next import joins as usual.
  await importIds("n3");
  assert.deepEqual((await docOf(joiner.id)).accountIds, ["j1", "n3"]);
});

test("accountView carries the cookie-renewal fields, and the state view reads them from the account row", async () => {
  const at = new Date("2026-10-14T03:00:00Z");
  const full = views.accountView({ loginId: "x", status: "ok", twitchLogin: "tw_user", renewedAt: at, renewError: "oauth: denied" }, {});
  assert.equal(full.twitchLogin, "tw_user");
  assert.equal(full.renewedAt, at);
  assert.equal(full.renewError, "oauth: denied");
  const blank = views.accountView({ loginId: "y", status: "ok" }, {});
  assert.equal(blank.twitchLogin, "");
  assert.equal(blank.renewedAt, null);
  assert.equal(blank.renewError, null);

  await fresh();
  await importIds("acc1", "acc2");
  assert.equal(await farm.setTwitchLogin("acc1", "  TwUser "), "twuser");
  await SoopAccount.updateOne({ loginId: "acc1" }, { $set: { renewedAt: at, renewError: "no TwitchWebCookie for twuser" } });
  farm.accountsCache = null;
  const state = await farm.stateView();
  const a1 = state.accounts.find((a) => a.id === "acc1");
  assert.equal(a1.twitchLogin, "twuser");
  assert.equal(new Date(a1.renewedAt).toISOString(), at.toISOString());
  assert.equal(a1.renewError, "no TwitchWebCookie for twuser");
  const a2 = state.accounts.find((a) => a.id === "acc2");
  assert.deepEqual([a2.twitchLogin, a2.renewedAt, a2.renewError], ["", null, null]);
  assert.ok(!JSON.stringify(state).includes("fake-ticket-"), "no cookie in the state");
});

test("the bot routes pass autoJoin through, and refuse a value that is not a boolean", async () => {
  await fresh();
  await importIds("r1", "r2");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { id: "a1", username: "root-admin", role: "superadmin" } };
    next();
  });
  app.use(soopRoutes);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/soop`;
  const post = async (path, body) => {
    const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  try {
    const made = await post("/bots/create", { mode: "auto", accountIds: ["r1"], autoJoin: true });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(made.json.bot.autoJoin, true);
    const id = made.json.bot.id;
    assert.equal((await docOf(id)).autoJoin, true);

    const plain = await post("/bots/create", { mode: "auto", accountIds: ["r2"] });
    assert.equal(plain.status, 200, JSON.stringify(plain.json));
    assert.equal(plain.json.bot.autoJoin, false, "absent = off");

    const off = await post("/bots/update", { id, autoJoin: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.bot.autoJoin, false);
    assert.equal((await docOf(id)).autoJoin, false);

    for (const [path, body] of [
      ["/bots/create", { mode: "auto", accountIds: ["r1"], autoJoin: "yes" }],
      ["/bots/update", { id, autoJoin: 1 }],
    ]) {
      const r = await post(path, body);
      assert.equal(r.status, 400, path);
      assert.match(r.json.message, /autoJoin must be true or false/);
    }
    assert.equal((await docOf(id)).autoJoin, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
