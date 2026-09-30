// renterExpiry sweep changes (2026-10-01):
//   - a SUSPENDED renter whose stop failed (host offline at suspend time) is
//     retried by the sweep instead of being forgotten with botStoppedAt null;
//   - the rent-farm holder is never swept as a renter, whatever its lease says;
//   - a lapsed account window reloads its bot ONLY if that bot is running
//     (`docker restart` starts a stopped container — how a stopped, expired
//     renter used to come back to life).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const calls = { stop: [], restartIfRunning: [], removed: [], telegram: [], events: [] };
const fakeOps = {
  stopRenterFarming: async (renter, host) => {
    calls.stop.push(renter.username);
    return {
      mode: "detached",
      removed: 2,
      files: [{ host: host.id, file: renter.botFile, removed: 2, remaining: 40, action: "restarted" }],
    };
  },
  restartIfRunning: async (host, file) => {
    calls.restartIfRunning.push(host.id + "/" + file);
    return false;
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]renterExpiry\.js$/.test(parent.filename || "")) {
    if (request === "./renterBotOps") return fakeOps;
    if (request === "./telegram") return { sendTelegram: async (m) => calls.telegram.push(m) };
    if (request === "./systemLog") return { logEvent: (e) => calls.events.push(e) };
    if (request === "./botHosts") {
      return { resolveHost: (v) => ({ id: v || "local", label: v === "contabo" ? "Contabo VPS" : "Local" }) };
    }
    if (request === "../routes/botConfigRoutes") {
      return {
        removeAccountFromConfig: async (host, file, who) => {
          calls.removed.push(host.id + "/" + file + ":" + who.login);
          return 1;
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const renterExpiry = require("../utils/renterExpiry");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-expiry-sweep"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  for (const k of Object.keys(calls)) calls[k] = [];
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
}

function mk(username, fields) {
  return Renter.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: "x",
    botHost: "contabo",
    ...fields,
  });
}

test("a suspended renter whose stop never happened is stopped by the sweep", async () => {
  await reset();
  const r = await mk("susp", { botFile: "config_05.json", status: "suspended", botStoppedAt: null });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["susp"]);
  const after = await Renter.findById(r._id).lean();
  assert.ok(after.botStoppedAt, "stamped once done");
  assert.match(calls.telegram.join("\n"), /Renter suspended: susp — 2 account\(s\) pulled off config_05\.json on Contabo VPS\. Other accounts on config_05\.json keep farming\./);
  assert.equal(calls.events[0].action, "suspend_stop_retried");
  // Idempotent: the next sweep leaves it alone.
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["susp"]);
});

test("an expired lease is reported as a lease end", async () => {
  await reset();
  await mk("jhonkwiall", { botFile: "config_03.json", accessEnd: new Date(Date.now() - 60000) });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["jhonkwiall"]);
  assert.match(calls.telegram.join("\n"), /^⏰ Renter lease ended: jhonkwiall — /m);
  assert.equal(calls.events[0].action, "lease_ended");
});

test("REGRESSION: the rent-farm holder is never swept as a renter", async () => {
  await reset();
  await mk("operator-selffarm", { botFile: "config_54.json", accessEnd: new Date(Date.now() - 60000) });
  await mk("operator-selffarm-2", { botFile: "config_55.json", status: "active" });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, []);
});

test("an active renter with a live lease, or one already stopped, is not touched", async () => {
  await reset();
  await mk("live", { botFile: "config_05.json", accessEnd: new Date(Date.now() + 86400000) });
  await mk("done", { botFile: "config_04.json", accessEnd: new Date(Date.now() - 86400000), botStoppedAt: new Date() });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, []);
});

test("REGRESSION: a lapsed account window reloads its bot only through restartIfRunning", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await RenterAccount.create({
    renter: holder._id,
    clientSecret: "cs1",
    login: "buyer1",
    host: "contabo",
    configFile: "config_02.json",
    farmUntil: new Date(Date.now() - 1000),
  });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.removed, ["contabo/config_02.json:buyer1"]);
  assert.deepEqual(calls.restartIfRunning, ["contabo/config_02.json"]);
  const row = await RenterAccount.findOne({ clientSecret: "cs1" }).lean();
  assert.ok(row.farmEndedAt);
});

test("describeStop says which bot was emptied and stopped", () => {
  const s = renterExpiry.describeStop(
    { removed: 1, files: [{ file: "config_22.json", removed: 1, remaining: 0, action: "stopped" }] },
    { id: "local", label: "Local" },
  );
  assert.equal(s, "1 account(s) pulled off config_22.json on Local. Now empty and stopped: config_22.json.");
});
