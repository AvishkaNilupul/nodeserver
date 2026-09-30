/* global fetch */
// Route-level follow-ups from the 2026-10-01 adversarial review of the scoped
// renter stop (renterBotOps rework):
//   - the renter's page reports THEIR farming, not the shared container's —
//     otherwise after a Stop it said "Running" and hid the Start button;
//   - a lease renewal resumes farming only when the LEASE END stopped it, and
//     unsuspend no longer pretends farming resumed;
//   - "Restart" never starts a bot whose config is empty (login-retry loop);
//   - the holder can never log into the renter portal;
//   - stack pickers keep rent-farm buyers and direct renters apart, and a
//     stopped active renter keeps its slots.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-fix1-routes-test";
process.env.CRED_SECRET ||= "renter-fix1-routes-cred";

const world = {
  started: [],
  stopped: [],
  configCount: 5,
  restarted: [],
  ps: { twitchbotx3: { state: "running" }, twitchbotx5: { state: "running" }, twitchbotx54: { state: "running" }, twitchbotx22: { state: "exited" } },
  files: {},
};

const fakeHosts = (real) => ({
  ...real,
  resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
  dockerPs: async () => JSON.parse(JSON.stringify(world.ps)),
  readdir: async () => Object.keys(world.files),
  readFiles: async (h, files) =>
    Object.fromEntries(files.map((f) => [f, world.files[f] ? { ok: true, text: world.files[f] } : { ok: false, error: "Not found" }])),
});

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/](renterAdminRoutes|renterRoutes)\.js$/.test(from)) {
    if (request === "../utils/renterBotOps") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        startRenterFarming: async (r) => { world.started.push(r.username); return { added: 1, skipped: [], running: true }; },
        stopRenterFarming: async (r) => { world.stopped.push(r.username); return { mode: "detached", removed: 1, files: [] }; },
      };
    }
    if (request === "../utils/botHosts") return fakeHosts(realLoad.call(this, request, parent, isMain));
    if (request === "./botConfigRoutes") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        countConfigAccounts: async () => world.configCount,
        restartConfigContainer: async (h, f) => { world.restarted.push(f); return { restarted: true }; },
        getConfigGames: async () => [],
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const RenterBotStack = require("../models/RenterBotStack");
const { createRenter } = require("../utils/renters");
const renterAdminRoutes = require("../routes/renterAdminRoutes");
const renterRoutes = require("../routes/renterRoutes");
const renterAuthRoutes = require("../routes/renterAuthRoutes");

let mongod;
let server;
let baseUrl;
let admin;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-fix1-routes"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/admin", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.get("/test/renter/:id", (req, res) => {
    req.session.renter = { id: req.params.id, username: "x", at: Date.now() };
    res.json({ success: true });
  });
  app.use(renterAuthRoutes);
  app.use(renterRoutes);
  app.use(renterAdminRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  admin = (await fetch(baseUrl + "/test/admin")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  Module._load = realLoad;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  Object.assign(world, { started: [], stopped: [], restarted: [], configCount: 5, files: {} });
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({}), RenterBotStack.deleteMany({})]);
}

function call(method, path, body, cookie = admin) {
  const init = { method, headers: { Accept: "application/json", Cookie: cookie } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(baseUrl + path, init);
}

function mk(username, fields = {}) {
  return Renter.create({ username, usernameLower: username.toLowerCase(), passwordHash: "x", botHost: "contabo", ...fields });
}

test("REGRESSION: 'Restart' refuses a bot whose config is empty", async () => {
  await reset();
  const r = await mk("bulksellerhaz", { botFile: "config_22.json" });
  world.configCount = 0;
  const res = await call("POST", "/renters/" + r._id + "/bot/restart");
  assert.equal(res.status, 400);
  assert.deepEqual(world.restarted, []);
  world.configCount = 3;
  const ok = await call("POST", "/renters/" + r._id + "/bot/restart");
  assert.equal(ok.status, 200);
  assert.deepEqual(world.restarted, ["config_22.json"]);
});

test("operator Stop / Start record why the farming stopped", async () => {
  await reset();
  const r = await mk("escapefrom", { botFile: "config_04.json" });
  await call("POST", "/renters/" + r._id + "/bot/stop");
  let row = await Renter.findById(r._id).lean();
  assert.ok(row.botStoppedAt);
  assert.equal(row.botStopReason, "operator");
  await call("POST", "/renters/" + r._id + "/bot/start");
  row = await Renter.findById(r._id).lean();
  assert.equal(row.botStoppedAt, null);
  assert.equal(row.botStopReason, "");
});

test("REGRESSION: renewing a lease that the LEASE END stopped resumes farming", async () => {
  await reset();
  const r = await mk("jhonkwiall", {
    botFile: "config_03.json",
    accessEnd: new Date(Date.now() - 86400000),
    botStoppedAt: new Date(),
    botStopReason: "lease",
  });
  const res = await call("PUT", "/renters/" + r._id, { accessEnd: "2027-01-31" });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.farmingResumed, true);
  assert.deepEqual(world.started, ["jhonkwiall"]);
  const row = await Renter.findById(r._id).lean();
  assert.equal(row.botStoppedAt, null);
});

test("a lease renewal leaves a stop the renter CHOSE in place", async () => {
  await reset();
  const r = await mk("botfarm1", {
    botFile: "config_05.json",
    accessEnd: new Date(Date.now() + 86400000),
    botStoppedAt: new Date(),
    botStopReason: "renter",
  });
  const res = await call("PUT", "/renters/" + r._id, { accessEnd: "2029-01-01" });
  const d = await res.json();
  assert.equal(d.farmingResumed, null);
  assert.deepEqual(world.started, []);
  assert.ok((await Renter.findById(r._id).lean()).botStoppedAt, "still stopped — Start ends it");
});

test("unsuspend restores access but keeps a completed stop (the page then offers Start)", async () => {
  await reset();
  const r = await mk("susp", { botFile: "config_05.json", status: "suspended", botStoppedAt: new Date(), botStopReason: "suspend" });
  const res = await call("POST", "/renters/" + r._id + "/unsuspend");
  assert.equal(res.status, 200);
  const row = await Renter.findById(r._id).lean();
  assert.equal(row.status, "active");
  assert.ok(row.botStoppedAt);
});

test("REGRESSION: the renter's page says 'not running' after their Stop, even though the shared container runs", async () => {
  await reset();
  const r = await mk("jhonkwiall", { botFile: "config_03.json", accessEnd: new Date(Date.now() + 9e9) });
  const cookie = (await fetch(baseUrl + "/test/renter/" + r._id)).headers.get("set-cookie").split(";")[0];
  let me = await (await call("GET", "/renter/me", undefined, cookie)).json();
  assert.equal(me.me.bot.running, true);
  await Renter.updateOne({ _id: r._id }, { $set: { botStoppedAt: new Date(), botStopReason: "renter" } });
  me = await (await call("GET", "/renter/me", undefined, cookie)).json();
  assert.equal(me.me.bot.running, false, "their farming is stopped — show Start");
});

test("REGRESSION: the rent-farm holder can never log into the renter portal", async () => {
  await reset();
  await createRenter({ username: "operator-selffarm", password: "correct-horse-battery", maxAccounts: 10 });
  const res = await fetch(baseUrl + "/renter-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: "operator-selffarm", password: "correct-horse-battery" }),
  });
  assert.equal(res.status, 401);
  // And an existing session for it is refused on every call.
  const h = await Renter.findOne({ usernameLower: "operator-selffarm" }).lean();
  const cookie = (await fetch(baseUrl + "/test/renter/" + h._id)).headers.get("set-cookie").split(";")[0];
  const stop = await call("POST", "/renter/bot/stop", {}, cookie);
  assert.equal(stop.status, 403);
  assert.deepEqual(world.stopped, []);
});

test("stack pickers keep buyers and direct renters apart; a stopped renter keeps its slots", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json", maxAccounts: 2000 });
  const jhon = await mk("jhonkwiall", { botFile: "config_03.json", accessEnd: new Date(Date.now() + 9e9) });
  const gone = await mk("wasd", { botFile: "config_22.json", accessEnd: new Date(Date.now() - 9e9) });
  for (const f of ["config_03.json", "config_54.json", "config_55.json", "config_22.json"]) {
    await RenterBotStack.create({ host: "contabo", file: f, capacity: 3 });
  }
  const cfg = (secrets) => JSON.stringify({ TwitchSettings: { TwitchUsers: secrets.map((s) => ({ ClientSecret: s })) } });
  world.files = {
    "config_03.json": cfg(["b1"]), // jhonkwiall stopped: his 2 accounts are out
    "config_54.json": cfg(["b2"]),
    "config_55.json": cfg([]),
    "config_22.json": cfg([]),
  };
  world.ps = { twitchbotx3: { state: "running" }, twitchbotx54: { state: "running" }, twitchbotx55: { state: "exited" }, twitchbotx22: { state: "exited" } };
  await RenterAccount.create({ renter: holder._id, clientSecret: "b1", login: "b1", host: "contabo", configFile: "config_03.json" });
  await RenterAccount.create({ renter: holder._id, clientSecret: "b2", login: "b2", host: "contabo", configFile: "config_54.json" });
  await RenterAccount.create({ renter: jhon._id, clientSecret: "j1", login: "j1", host: "contabo", configFile: "config_03.json" });
  await RenterAccount.create({ renter: jhon._id, clientSecret: "j2", login: "j2", host: "contabo", configFile: "config_03.json" });
  await RenterAccount.create({ renter: gone._id, clientSecret: "w1", login: "w1", host: "contabo", configFile: "config_22.json" });

  const { bots } = await renterAdminRoutes.rentalStackOptions();
  const by = Object.fromEntries(bots.map((b) => [b.file, b]));
  assert.equal(by["config_03.json"].reserved, 2, "jhonkwiall's stopped accounts keep their slots");
  assert.equal(by["config_03.json"].remaining, 0);
  assert.equal(by["config_22.json"].reserved, 0, "an expired renter reserves nothing");
  assert.deepEqual(by["config_03.json"].directAssigned, ["jhonkwiall"]);
  assert.equal(by["config_54.json"].holderRows, 1);

  // Holder: never a direct renter's bot.
  const forHolder = renterAdminRoutes.chooseStackWithRoom(bots, 1);
  assert.ok(forHolder && !["config_03.json", "config_22.json"].includes(forHolder.file), JSON.stringify(forHolder));
  // Direct renter (Quick farm auto-assign): never a stack holding buyers.
  const forRenter = await renterAdminRoutes.availableRentalStack();
  assert.ok(forRenter, "a stack is offered");
  assert.ok(!["config_54.json", "config_03.json"].includes(forRenter.file), JSON.stringify(forRenter));
});
