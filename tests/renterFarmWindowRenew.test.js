/* global fetch */
// "Farm days" on a window that already ENDED used to report "Farms until …"
// while the account sat in no config at all — the lapse sweep had pulled it and
// blanked configFile, and the route only re-armed farmUntil. From 2026-10-28
// (the first 30-day windows) every renewal or make-good went through that path.
// It now puts the account back on a bot first, and keeps the rent-farm order's
// copy of the window in step.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-farm-renew-test";
process.env.CRED_SECRET ||= "renter-farm-renew-cred";

const world = {
  placed: [], started: [], restarted: [], located: new Map(), running: {},
  stack: { host: "contabo", file: "config_54.json" },
  files: ["config_54.json", "config_05.json", "config_06.json"], // readdir of every host
  startFails: false, psFails: false, locateCalls: [],
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/]renterAdminRoutes\.js$/.test(from)) {
    if (request === "./botConfigRoutes") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        addRenterAccountsToConfig: async (host, file, accounts, renterId, opts = {}) => {
          world.placed.push({ host: host.id, file, accounts, renterId: String(renterId), opts });
          const RenterAccount = require("../models/RenterAccount");
          for (const a of accounts) {
            await RenterAccount.updateOne(
              { clientSecret: a.ClientSecret },
              {
                $set: {
                  configFile: file, host: host.id, enabled: true,
                  ...("farmUntil" in opts ? { farmUntil: opts.farmUntil, farmEndedAt: null } : {}),
                },
              },
            );
          }
          return { added: accounts.length, total: 10 };
        },
        startConfigContainer: async (host, file) => {
          if (world.startFails) throw new Error("compose: service failed to start");
          world.started.push(host.id + "/" + file);
          return { started: true };
        },
        restartConfigContainer: async (host, file) => {
          if (world.startFails) throw new Error("docker: restart timed out");
          world.restarted.push(host.id + "/" + file);
          return { restarted: true };
        },
      };
    }
    if (request === "../utils/renterBotOps") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        locateSecrets: async (host) => {
          world.locateCalls.push(host.id);
          return world.located instanceof Map && world.located.host
            ? (world.located.host === host.id ? world.located : new Map())
            : world.located;
        },
      };
    }
    if (request === "../utils/botHosts") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
        readdir: async () => world.files.slice(),
        dockerPs: async () => {
          if (world.psFails) throw new Error("ssh: timed out");
          return world.running;
        },
      };
    }
    if (request === "../utils/operatorFarm") {
      return { ensureStackWithRoom: async (renter) => ({ renter, stack: world.stack, moved: false }) };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SystemEvent = require("../models/SystemEvent");
const PendingReload = require("../models/PendingReload");
const renterAdminRoutes = require("../routes/renterAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-farm-renew"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(renterAdminRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  Module._load = realLoad;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  Object.assign(world, {
    placed: [], started: [], restarted: [], located: new Map(), running: {},
    startFails: false, psFails: false, locateCalls: [],
  });
  require("../utils/renterAccountBusy")._reset();
  await Promise.all([
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
    SystemEvent.deleteMany({}),
    PendingReload.deleteMany({}),
  ]);
}

function farm(id, body) {
  return fetch(baseUrl + "/renter-accounts/" + id + "/farm", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function holder() {
  return Renter.create({
    username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x",
    botHost: "contabo", botFile: "config_54.json", maxAccounts: 2000,
  });
}

test("extending a LIVE window also moves the order's copy, and is logged", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-mirs", login: "Mirsv80l", host: "contabo",
    configFile: "config_06.json", farmUntil: new Date(Date.now() + 5 * 86400000),
  });
  await FarmServiceOrder.create({
    orderId: "a86efe89", market: "eldorado", game: "Overwatch", days: 365, state: "delivered",
    accounts: [{ login: "mirsv80l", farmUntil: acc.farmUntil }],
  });

  const res = await farm(acc._id, { days: 30 });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.placed, false);
  assert.equal(d.ordersUpdated, 1);
  const o = await FarmServiceOrder.findOne({ orderId: "a86efe89" }).lean();
  assert.equal(new Date(o.accounts[0].farmUntil).toISOString(), new Date(d.farmUntil).toISOString());
  assert.equal(world.placed.length, 0, "a live window is not re-placed");
  // The route logs without awaiting (an audit write must never fail the
  // request), so poll for it rather than guess a delay — a fixed 30 ms was
  // flaky under the full suite's load.
  let ev = null;
  for (let i = 0; i < 100 && !ev; i++) {
    ev = await SystemEvent.findOne({ action: "farm_window_set", subject: "Mirsv80l" }).lean();
    if (!ev) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(ev, "farm_window_set logged");
});

test("REGRESSION: renewing an ENDED rent-farm window puts the account back on a bot, pinned to its game", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-old", login: "oldbuyer", host: "contabo",
    configFile: "", enabled: false, farmUntil: new Date(Date.now() - 86400000), farmEndedAt: new Date(),
  });
  await FarmServiceOrder.create({
    orderId: "r6-30d", market: "eldorado", game: "Rainbow Six Siege", days: 30, state: "delivered",
    accounts: [{ login: "oldbuyer" }],
  });
  world.running = { twitchbotx54: { state: "running" } };

  const res = await farm(acc._id, { days: 30 });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.placed, true);
  assert.equal(d.stack, "contabo/config_54.json");
  assert.equal(world.placed.length, 1);
  assert.deepEqual(world.placed[0].accounts[0].FavouriteGames, ["Rainbow Six Siege"]);
  assert.equal(world.placed[0].accounts[0].ClientSecret, "cs-old");
  assert.deepEqual(world.restarted, ["contabo/config_54.json"], "a running stack is reloaded");
  const row = await RenterAccount.findById(acc._id).lean();
  assert.equal(row.farmEndedAt, null);
  assert.equal(row.enabled, true);
  assert.equal(row.configFile, "config_54.json");
  assert.ok(row.farmUntil > new Date(Date.now() + 29 * 86400000));
});

test("a stopped target stack is STARTED after the account is placed", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-x", login: "x1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  await FarmServiceOrder.create({
    orderId: "ow-7d", market: "eldorado", game: "Overwatch", days: 7, state: "delivered",
    accounts: [{ login: "x1" }],
  });
  world.running = { twitchbotx54: { state: "exited" } };
  const res = await farm(acc._id, { days: 7 });
  assert.equal(res.status, 200);
  assert.deepEqual(world.started, ["contabo/config_54.json"]);
});

test("an ended window of a renter whose lease is over is refused — nothing changes", async () => {
  await reset();
  const r = await Renter.create({
    username: "wasd", usernameLower: "wasd", passwordHash: "x", botHost: "contabo",
    botFile: "config_03.json", accessEnd: new Date(Date.now() - 86400000),
  });
  const acc = await RenterAccount.create({
    renter: r._id, clientSecret: "cs-w", login: "w1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date("2026-09-01"),
  });
  const res = await farm(acc._id, { days: 14 });
  const d = await res.json();
  assert.equal(res.status, 409, JSON.stringify(d));
  assert.match(d.message, /extend the lease first/);
  const row = await RenterAccount.findById(acc._id).lean();
  assert.ok(row.farmEndedAt, "still ended");
  assert.equal(world.placed.length, 0);
});

test("an ended window whose account is already back in a config is just re-pointed", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-back", login: "back1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  world.located = new Map([["config_05.json", new Set(["cs-back"])]]);
  const res = await farm(acc._id, { days: 10 });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.placed, false);
  assert.equal(d.stack, "contabo/config_05.json");
  assert.equal(world.placed.length, 0);
  const row = await RenterAccount.findById(acc._id).lean();
  assert.equal(row.configFile, "config_05.json");
  assert.equal(row.farmEndedAt, null);
});

// ---------------------------------------------------------------------------
// Round 3 (second review)
// ---------------------------------------------------------------------------
async function order(login, game, createdAt) {
  return FarmServiceOrder.create({
    orderId: "o-" + login + "-" + game.replace(/\s+/g, ""), market: "eldorado", game, days: 30,
    state: "delivered", accounts: [{ login }], ...(createdAt ? { createdAt } : {}),
  });
}

test("REGRESSION: Farm days on a STUCK row (pull failed, account on no bot) puts it back instead of answering 'Farms until' over nothing", async () => {
  await reset();
  const h = await holder();
  // The sweep pulled it out of config_05, then that bot's reload failed.
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-stuck", login: "stuck1", host: "contabo",
    configFile: "config_05.json", farmUntil: new Date(Date.now() - 3600e3), expiryAttempts: 3,
  });
  await order("stuck1", "Overwatch");
  world.running = { twitchbotx5: { state: "running" } };
  const res = await farm(acc._id, { days: 30 });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.placed, true);
  assert.equal(d.stack, "contabo/config_05.json", "back into the file it is recorded in (its bot owes a reload anyway)");
  assert.deepEqual(world.restarted, ["contabo/config_05.json"]);
  const row = await RenterAccount.findById(acc._id).lean();
  assert.equal(row.expiryAttempts, 0);
  assert.ok(row.farmUntil > new Date(Date.now() + 29 * 86400000));
  assert.equal(await PendingReload.countDocuments({}), 0, "reloaded, nothing owed");
});

test("a stuck row whose account is still in a config is only re-pointed (never a second copy)", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-still", login: "still1", host: "contabo",
    configFile: "config_05.json", farmUntil: new Date(Date.now() - 3600e3), expiryAttempts: 1,
  });
  world.located = new Map([["config_06.json", new Set(["cs-still"])]]);
  const d = await (await farm(acc._id, { days: 10 })).json();
  assert.equal(d.placed, false);
  assert.equal(d.stack, "contabo/config_06.json");
  assert.equal(world.placed.length, 0);
});

test("REGRESSION: a bot that cannot be (re)started after the account was written is reported — the window IS set", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-f", login: "f1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  await order("f1", "Rainbow Six Siege");
  world.running = { twitchbotx54: { state: "running" } };
  world.startFails = true;
  const res = await farm(acc._id, { days: 30 });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.placed, true);
  assert.match(d.startError, /restart timed out/);
  const row = await RenterAccount.findById(acc._id).lean();
  assert.equal(row.farmEndedAt, null, "not a ghost: visible to the sweep, the quotas and the scanner");
  assert.equal(row.configFile, "config_54.json");
  assert.ok(row.farmUntil > new Date(Date.now() + 29 * 86400000));
  assert.ok(await PendingReload.findOne({ file: "config_54.json" }).lean(), "the reload stays owed for the sweeper");
});

test("an unreadable container state leaves the reload owed (compose up would not reload a running bot)", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-u", login: "u1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  await order("u1", "Overwatch");
  world.psFails = true;
  const d = await (await farm(acc._id, { days: 5 })).json();
  assert.equal(d.placed, true);
  assert.ok(await PendingReload.findOne({ file: "config_54.json" }).lean());
});

test("the buyer's LATEST order decides the game", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-l", login: "l1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  await order("l1", "Overwatch", new Date("2026-08-01"));
  await order("l1", "Rainbow Six Siege", new Date("2026-09-20"));
  await farm(acc._id, { days: 30 });
  assert.deepEqual(world.placed[0].accounts[0].FavouriteGames, ["Rainbow Six Siege"]);
});

test("a buyer's account with NO known game is refused — nothing written", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-n", login: "n1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  const res = await farm(acc._id, { days: 30 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /No game is known/);
  assert.equal(world.placed.length, 0);
  assert.ok((await RenterAccount.findById(acc._id).lean()).farmEndedAt, "still ended");
});

test("a buyer's ended window cannot be made open-ended (it would farm forever)", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-o", login: "o1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  await order("o1", "Overwatch");
  const res = await farm(acc._id, { days: 0 });
  assert.equal(res.status, 400);
  assert.equal(world.placed.length, 0);
});

test("a direct renter whose farming is STOPPED: an ended window is refused (Start first)", async () => {
  await reset();
  const r = await Renter.create({
    username: "escapefrom", usernameLower: "escapefrom", passwordHash: "x", botHost: "contabo",
    botFile: "config_04.json", botStoppedAt: new Date(), botStopReason: "operator",
  });
  const acc = await RenterAccount.create({
    renter: r._id, clientSecret: "cs-e", login: "e1", host: "contabo",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  const res = await farm(acc._id, { days: 7 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /farming is stopped/);
  assert.equal(world.placed.length, 0);
});

test("a row the lapse sweep is working on answers 409 busy — nothing changes", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-b", login: "b1", host: "contabo",
    configFile: "config_05.json", farmUntil: new Date(Date.now() - 1000),
  });
  const release = require("../utils/renterAccountBusy").tryAcquire([acc._id]);
  try {
    const res = await farm(acc._id, { days: 10 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).busy, true);
  } finally {
    release();
  }
  const row = await RenterAccount.findById(acc._id).lean();
  assert.ok(row.farmUntil < new Date(), "untouched");
});

test("the account is looked for on the host its row last named BEFORE the holder is moved anywhere", async () => {
  await reset();
  const h = await holder();
  const acc = await RenterAccount.create({
    renter: h._id, clientSecret: "cs-pi", login: "pi1", host: "pi",
    configFile: "", enabled: false, farmEndedAt: new Date(),
  });
  const found = new Map([["config_31.json", new Set(["cs-pi"])]]);
  found.host = "pi";
  world.located = found;
  const d = await (await farm(acc._id, { days: 10 })).json();
  assert.equal(d.placed, false);
  assert.equal(d.stack, "pi/config_31.json");
  assert.equal(world.locateCalls[0], "pi");
});
