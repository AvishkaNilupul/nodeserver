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

const world = { placed: [], started: [], restarted: [], located: new Map(), running: {}, stack: { host: "contabo", file: "config_54.json" } };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/]renterAdminRoutes\.js$/.test(from)) {
    if (request === "./botConfigRoutes") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        addRenterAccountsToConfig: async (host, file, accounts, renterId) => {
          world.placed.push({ host: host.id, file, accounts, renterId: String(renterId) });
          const RenterAccount = require("../models/RenterAccount");
          for (const a of accounts) {
            await RenterAccount.updateOne(
              { clientSecret: a.ClientSecret },
              { $set: { configFile: file, host: host.id, enabled: true } },
            );
          }
          return { added: accounts.length, total: 10 };
        },
        startConfigContainer: async (host, file) => { world.started.push(host.id + "/" + file); return { started: true }; },
        restartConfigContainer: async (host, file) => { world.restarted.push(host.id + "/" + file); return { restarted: true }; },
      };
    }
    if (request === "../utils/renterBotOps") {
      const real = realLoad.call(this, request, parent, isMain);
      return { ...real, locateSecrets: async () => world.located };
    }
    if (request === "../utils/botHosts") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
        dockerPs: async () => world.running,
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
  Object.assign(world, { placed: [], started: [], restarted: [], located: new Map(), running: {} });
  await Promise.all([
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
    SystemEvent.deleteMany({}),
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
