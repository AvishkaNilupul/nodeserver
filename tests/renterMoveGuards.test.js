/* global fetch */
// Guards on the renter admin paths that move or delete accounts (2026-10-01):
//   - Manual add / Quick farm of an account another renter holds used to delete
//     that account's ONLY ledger row when the token was unchanged (the write
//     had already re-pointed the row to the new renter): the account then
//     farmed with no row — never expiring, never scanned, sellable again. It
//     also took accounts off renters with live leases and paying rent-farm
//     buyers without a word, and never cleared the account from auto-farm tasks.
//   - Deleting a renter deleted the rows but left every account farming.
//   - Removing one paid rent-farm account ended the buyer's window silently,
//     and one backing a live Gameflip offer left that offer selling it.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-move-guards-test";
process.env.CRED_SECRET ||= "renter-move-guards-cred";

const world = { written: [], removed: [], stopped: [], stopFails: null, located: null, detachFails: null };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/]renterAdminRoutes\.js$/.test(from)) {
    if (request === "./botConfigRoutes") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        // Same ledger effect as the real write: upsert BY TOKEN to the new renter.
        addRenterAccountsToConfig: async (host, file, accounts, renterId) => {
          const RenterAccount = require("../models/RenterAccount");
          for (const a of accounts) {
            world.written.push(file + ":" + a.ClientSecret);
            await RenterAccount.updateOne(
              { clientSecret: a.ClientSecret },
              { $set: { renter: renterId, login: a.Login, configFile: file, host: host.id, enabled: true } },
              { upsert: true },
            );
          }
          return { added: accounts.length, total: 5 };
        },
        removeAccountFromConfig: async (host, file, who) => {
          world.removed.push(file + ":" + who.clientSecret);
          return 1;
        },
        restartConfigContainer: async () => ({ restarted: true }),
        startConfigContainer: async () => ({ started: true }),
        getConfigGames: async () => ["Rust"],
      };
    }
    if (request === "../utils/botHosts") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
        dockerPs: async () => ({}),
        listHosts: () => [{ id: "contabo", label: "contabo" }],
        // One empty, free rental stack for the Quick-farm picker.
        readdir: async () => ["config_60.json"],
        readFiles: async (h, files) =>
          Object.fromEntries(files.map((f) => [f, { ok: true, text: JSON.stringify({ TwitchSettings: { TwitchUsers: [] } }) }])),
      };
    }
    if (request === "../utils/renterBotOps") {
      const real = realLoad.call(this, request, parent, isMain);
      return {
        ...real,
        stopRenterFarming: async (r) => {
          if (world.stopFails) {
            const e = new Error(world.stopFails);
            e.unreachable = true;
            throw e;
          }
          world.stopped.push(r.username);
          return { mode: "detached", removed: 1, files: [] };
        },
        startRenterFarming: async () => ({ added: 0, skipped: [], running: true }),
        // Account removal pulls through these (every config on the host).
        locateSecrets: async () => new Map(world.located || []),
        detachFromFile: async (host, file, secrets) => {
          if (world.detachFails) {
            const e = new Error(world.detachFails);
            e.unreachable = true;
            throw e;
          }
          world.removed.push(file + ":" + secrets[0]);
          return { removed: 1, remaining: 5, games: new Map(), missing: false, stopped: false };
        },
        settleAfterDetach: async () => "restarted",
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const MarketplaceListing = require("../models/MarketplaceListing");
const AutoFarmTask = require("../models/AutoFarmTask");
const renterAdminRoutes = require("../routes/renterAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-move-guards"));
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
  Object.assign(world, { written: [], removed: [], stopped: [], stopFails: null, located: null, detachFails: null });
  require("../utils/renterAccountBusy")._reset();
  await Promise.all([
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    AutoFarmTask.deleteMany({}),
  ]);
}

function call(method, path, body) {
  const init = { method, headers: { Accept: "application/json", Cookie: cookie } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(baseUrl + path, init);
}

function mk(username, fields = {}) {
  return Renter.create({
    username, usernameLower: username.toLowerCase(), passwordHash: "x",
    botHost: "contabo", maxAccounts: 50, ...fields,
  });
}

const LIVE = { accessEnd: new Date(Date.now() + 90 * 86400000) };

test("REGRESSION: taking an account off a renter with a LIVE lease asks first", async () => {
  await reset();
  const a = await mk("newrenter", { botFile: "config_04.json", ...LIVE });
  const b = await mk("botfarm1", { botFile: "config_05.json", ...LIVE });
  await RenterAccount.create({ renter: b._id, clientSecret: "tok1", login: "acc1", host: "contabo", configFile: "config_05.json" });

  const res = await call("POST", "/renters/" + a._id + "/accounts/manual", { username: "acc1", token: "tok1" });
  const d = await res.json();
  assert.equal(res.status, 409, JSON.stringify(d));
  assert.equal(d.needsForce, true);
  assert.match(d.message, /renter botfarm1, whose lease is active/);
  assert.deepEqual(world.written, [], "nothing moved");
});

test("REGRESSION: a forced move keeps the account's ONLY ledger row (re-pointed, not deleted)", async () => {
  await reset();
  const a = await mk("newrenter", { botFile: "config_04.json", ...LIVE });
  const b = await mk("botfarm1", { botFile: "config_05.json", ...LIVE });
  await RenterAccount.create({ renter: b._id, clientSecret: "tok1", login: "acc1", host: "contabo", configFile: "config_05.json" });
  await new AutoFarmTask({ game: "Rust", status: "completed", assignedAccounts: ["acc1", "other"] }).save({ validateBeforeSave: false });

  const res = await call("POST", "/renters/" + a._id + "/accounts/manual", { username: "acc1", token: "tok1", force: true });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  const rows = await RenterAccount.find({ clientSecret: "tok1" }).lean();
  assert.equal(rows.length, 1, "the row survives");
  assert.equal(String(rows[0].renter), String(a._id), "…now the new renter's");
  assert.deepEqual(world.removed, ["config_05.json:tok1"], "pulled off the old bot");
  const task = await AutoFarmTask.findOne({}).lean();
  assert.deepEqual(task.assignedAccounts, ["other"], "out of every auto-farm task");
});

test("a paying rent-farm buyer's account is never taken without a yes", async () => {
  await reset();
  const a = await mk("newrenter", { botFile: "config_04.json", ...LIVE });
  const holder = await mk("operator-selffarm", { botFile: "config_54.json", maxAccounts: 2000 });
  await RenterAccount.create({
    renter: holder._id, clientSecret: "tokB", login: "buyer1", host: "contabo",
    configFile: "config_02.json", farmUntil: new Date(Date.now() + 200 * 86400000),
  });
  await FarmServiceOrder.create({
    orderId: "e328ee9d-x", market: "eldorado", buyerUsername: "JumpyPage", game: "Overwatch",
    days: 365, state: "delivered", accounts: [{ login: "buyer1" }],
  });
  const res = await call("POST", "/renters/" + a._id + "/accounts/manual", { username: "buyer1", token: "tokB" });
  const d = await res.json();
  assert.equal(res.status, 409);
  assert.equal(d.needsForce, true);
  assert.match(d.message, /paid farming window runs until/);
  assert.match(d.message, /eldorado e328ee9d, buyer JumpyPage/);
});

test("an account backing a LIVE Gameflip offer cannot be moved at all", async () => {
  await reset();
  const a = await mk("newrenter", { botFile: "config_04.json", ...LIVE });
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await RenterAccount.create({ renter: holder._id, clientSecret: "tokS", login: "shelf1", host: "contabo", configFile: "config_54.json" });
  const row = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-live-1", status: "active", rentFarm: true, accountLogin: "shelf1", rentFarmPoolId: "p1",
  });
  await row.save({ validateBeforeSave: false });
  const res = await call("POST", "/renters/" + a._id + "/accounts/manual", { username: "shelf1", token: "tokS", force: true });
  const d = await res.json();
  assert.equal(res.status, 409);
  assert.match(d.message, /LIVE Gameflip rent-farm offer \(gf-live-1\)/);
  assert.deepEqual(world.written, []);
});

test("REGRESSION: deleting a renter first pulls its accounts off the bots (confirmed)", async () => {
  await reset();
  const r = await mk("bulksellerhaz", { botFile: "config_22.json", ...LIVE });
  await RenterAccount.create({ renter: r._id, clientSecret: "t1", login: "a1", host: "contabo", configFile: "config_22.json" });

  let res = await call("DELETE", "/renters/" + r._id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).needsForce, true);
  assert.ok(await Renter.findById(r._id).lean(), "not deleted without a yes");

  res = await call("DELETE", "/renters/" + r._id + "?force=1");
  assert.equal(res.status, 200);
  assert.deepEqual(world.stopped, ["bulksellerhaz"], "stopped first");
  assert.equal(await Renter.findById(r._id).lean(), null);
  assert.equal(await RenterAccount.countDocuments({ renter: r._id }), 0);
});

test("a delete whose stop cannot happen deletes nothing", async () => {
  await reset();
  const r = await mk("bulksellerhaz", { botFile: "config_22.json", ...LIVE });
  await RenterAccount.create({ renter: r._id, clientSecret: "t1", login: "a1", host: "contabo", configFile: "config_22.json" });
  world.stopFails = "ssh: connect timed out";
  const res = await call("DELETE", "/renters/" + r._id + "?force=1");
  assert.equal(res.status, 502);
  assert.ok(await Renter.findById(r._id).lean());
  assert.equal(await RenterAccount.countDocuments({ renter: r._id }), 1);
});

test("a renter with no live accounts deletes as before", async () => {
  await reset();
  const r = await mk("empty", { botFile: "config_05.json" });
  const res = await call("DELETE", "/renters/" + r._id);
  assert.equal(res.status, 200);
  assert.equal(world.stopped.length, 0);
});

test("REGRESSION: removing a paid rent-farm account asks first, then closes the order's window", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const acc = await RenterAccount.create({
    renter: holder._id, clientSecret: "tokP", login: "Paid1", host: "contabo",
    configFile: "config_02.json", farmUntil: new Date(Date.now() + 30 * 86400000),
  });
  await FarmServiceOrder.create({
    orderId: "r6-30d-x", market: "eldorado", game: "Rainbow Six Siege", days: 30, state: "delivered",
    accounts: [{ login: "paid1", farmUntil: acc.farmUntil }],
  });

  let res = await call("DELETE", "/renter-accounts/" + acc._id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).needsForce, true);
  assert.ok(await RenterAccount.findById(acc._id).lean(), "not removed without a yes");

  res = await call("DELETE", "/renter-accounts/" + acc._id + "?force=1");
  assert.equal(res.status, 200);
  assert.equal(await RenterAccount.findById(acc._id).lean(), null);
  assert.deepEqual(world.removed, ["config_02.json:tokP"], "pulled off its bot");
  const o = await FarmServiceOrder.findOne({ orderId: "r6-30d-x" }).lean();
  assert.ok(new Date(o.accounts[0].farmUntil) <= new Date(), "order window closed now");
});

test("REGRESSION: a removal whose bot write fails changes NOTHING — the order window is untouched", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const until = new Date(Date.now() + 30 * 86400000);
  const acc = await RenterAccount.create({
    renter: holder._id, clientSecret: "tokF", login: "Paid2", host: "contabo", configFile: "config_02.json", farmUntil: until,
  });
  await FarmServiceOrder.create({
    orderId: "r6-30d-y", market: "eldorado", game: "Rainbow Six Siege", days: 30, state: "delivered",
    accounts: [{ login: "paid2", farmUntil: until }],
  });
  world.detachFails = "ssh: connect timed out";
  try {
    const res = await call("DELETE", "/renter-accounts/" + acc._id + "?force=1");
    assert.equal(res.status, 502);
  } finally {
    world.detachFails = null;
  }
  assert.ok(await RenterAccount.findById(acc._id).lean(), "row kept");
  const o = await FarmServiceOrder.findOne({ orderId: "r6-30d-y" }).lean();
  assert.equal(new Date(o.accounts[0].farmUntil).toISOString(), until.toISOString(), "the order still says it farms");
});

test("an account found in ANOTHER config too is pulled from every one of them", async () => {
  await reset();
  const r = await mk("rainbowsix", { botFile: "config_16.json", ...LIVE });
  const acc = await RenterAccount.create({ renter: r._id, clientSecret: "t8", login: "r8", host: "contabo", configFile: "config_16.json" });
  world.located = [["config_21.json", new Set(["t8"])]];
  const res = await call("DELETE", "/renter-accounts/" + acc._id);
  assert.equal(res.status, 200);
  assert.deepEqual(world.removed.sort(), ["config_16.json:t8", "config_21.json:t8"]);
  world.located = null;
});

test("removing an already-ENDED paid row needs no yes, and rewrites no order", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const past = new Date(Date.now() - 5 * 86400000);
  const acc = await RenterAccount.create({
    renter: holder._id, clientSecret: "tokE", login: "Ended1", host: "contabo", configFile: "", enabled: false,
    farmUntil: past, farmEndedAt: past,
  });
  await FarmServiceOrder.create({
    orderId: "ow-old", market: "eldorado", game: "Overwatch", days: 30, state: "delivered",
    accounts: [{ login: "ended1", farmUntil: past }],
  });
  const res = await call("DELETE", "/renter-accounts/" + acc._id);
  assert.equal(res.status, 200, "no prompt");
  const o = await FarmServiceOrder.findOne({ orderId: "ow-old" }).lean();
  assert.equal(new Date(o.accounts[0].farmUntil).toISOString(), past.toISOString(), "history kept");
});

test("an account backing a live Gameflip offer cannot be removed", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const acc = await RenterAccount.create({ renter: holder._id, clientSecret: "tokS", login: "shelf1", host: "contabo", configFile: "config_54.json" });
  const row = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-live-2", status: "active", rentFarm: true, accountLogin: "shelf1", rentFarmPoolId: "p1",
  });
  await row.save({ validateBeforeSave: false });
  const res = await call("DELETE", "/renter-accounts/" + acc._id + "?force=1");
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /LIVE Gameflip rent-farm offer \(gf-live-2\)/);
  assert.ok(await RenterAccount.findById(acc._id).lean());
});

test("an ordinary renter's account removes as before (no prompt)", async () => {
  await reset();
  const r = await mk("rainbowsix", { botFile: "config_16.json", ...LIVE });
  const acc = await RenterAccount.create({ renter: r._id, clientSecret: "t9", login: "r9", host: "contabo", configFile: "config_16.json" });
  const res = await call("DELETE", "/renter-accounts/" + acc._id);
  assert.equal(res.status, 200);
  assert.equal(await RenterAccount.findById(acc._id).lean(), null);
});

test("an account PARKED by the Gameflip buffer (renewal pending) cannot be moved or removed either", async () => {
  await reset();
  const a = await mk("newrenter", { botFile: "config_04.json", ...LIVE });
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const acc = await RenterAccount.create({ renter: holder._id, clientSecret: "tokP", login: "parked1", host: "contabo", configFile: "config_02.json" });
  const row = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-exp-1", status: "removed", rentFarm: true,
    accountLogin: "parked1", rentFarmPoolId: "p9", rentFarmExpiredAt: new Date(),
  });
  await row.save({ validateBeforeSave: false });
  const add = await call("POST", "/renters/" + a._id + "/accounts/manual", { username: "parked1", token: "tokP", force: true });
  assert.equal(add.status, 409);
  assert.match((await add.json()).message, /parked by the Gameflip rent-farm buffer/);
  const del = await call("DELETE", "/renter-accounts/" + acc._id + "?force=1");
  assert.equal(del.status, 409);
  assert.ok(await RenterAccount.findById(acc._id).lean());
});

test("REGRESSION: a Quick farm whose move is declined leaves the renter WITHOUT a stack", async () => {
  // Review 3 (2026-10-01): Quick farm saved an auto-assigned stack onto the
  // renter BEFORE the needsForce / buffer refusals, so one "Cancel" silently
  // took a whole stack (up to 50 slots) out of rent-farm capacity.
  await reset();
  await require("../models/RenterBotStack").create({ host: "contabo", file: "config_60.json", capacity: 50 });
  const a = await mk("quickrenter", { botFile: "", ...LIVE });
  const b = await mk("botfarm1", { botFile: "config_05.json", ...LIVE });
  await RenterAccount.create({ renter: b._id, clientSecret: "tokQ", login: "accQ", host: "contabo", configFile: "config_05.json" });
  const res = await call("POST", "/renters/" + a._id + "/accounts/manual", {
    username: "accQ", token: "tokQ", quick: true, autoAssign: true, games: ["Rust"], farmDays: 7,
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).needsForce, true);
  const after = await Renter.findById(a._id).lean();
  assert.equal(after.botFile, "", "no stack taken by a refused request");
  assert.deepEqual(world.written, []);
  await require("../models/RenterBotStack").deleteMany({});
});
