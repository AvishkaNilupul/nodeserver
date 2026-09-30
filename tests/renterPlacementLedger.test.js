// The ledger side of putting an account into a rental stack
// (botConfigRoutes.addRenterAccountsToConfig → upsertRenterAccounts), and the
// capacity it enforces (2026-10-01, second review):
//   - an ENDED row written into a config again comes back LIVE — before, it
//     kept farmEndedAt and farmed invisibly to the lapse sweep, every quota and
//     the scanner (a "ghost");
//   - a row changing renter starts a fresh window (the old owner's — or a
//     buyer's — term is not the new renter's);
//   - a stack MOVE of a live row keeps its window (scripts/move-renter-*.js);
//   - slots held for another renter's stopped accounts count as used.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const files = {}; // file -> JSON text (one fake host)
const fakeHosts = {
  resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
  listHosts: () => [{ id: "contabo", label: "contabo" }],
  readFile: async (h, f) => {
    if (!(f in files)) {
      const e = new Error("ENOENT " + f);
      e.code = "ENOENT";
      throw e;
    }
    return files[f];
  },
  writeFileAtomic: async (h, f, text) => {
    files[f] = text;
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/]botConfigRoutes\.js$/.test(from) && request === "../utils/botHosts") return fakeHosts;
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const RenterBotStack = require("../models/RenterBotStack");
const { addRenterAccountsToConfig } = require("../routes/botConfigRoutes");

const HOST = { id: "contabo", label: "contabo" };
let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-placement-ledger"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  for (const k of Object.keys(files)) delete files[k];
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({}), RenterBotStack.deleteMany({})]);
}
function put(file, secrets) {
  files[file] = JSON.stringify({
    TwitchSettings: { OnlyFavouriteGames: true, TwitchUsers: secrets.map((s) => ({ ClientSecret: s, Login: s })) },
  });
}
function mk(username, fields = {}) {
  return Renter.create({ username, usernameLower: username.toLowerCase(), passwordHash: "x", botHost: "contabo", ...fields });
}
const entry = (s) => ({ ClientSecret: s, Login: s, UniqueId: "", Id: "", Enabled: true, FavouriteGames: ["Rust"] });

test("REGRESSION: an ENDED row written into a config again comes back live (no ghost)", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_04.json", capacity: 50 });
  put("config_04.json", []);
  const r = await mk("escapefrom", { botFile: "config_04.json" });
  await RenterAccount.create({
    renter: r._id, clientSecret: "e1", login: "e1", host: "contabo", configFile: "", enabled: false,
    farmUntil: new Date(Date.now() - 86400000), farmEndedAt: new Date(), expiryAttempts: 2, expiryOwedFiles: ["config_09.json"],
  });
  await addRenterAccountsToConfig(HOST, "config_04.json", [entry("e1")], r._id);
  const row = await RenterAccount.findOne({ clientSecret: "e1" }).lean();
  assert.equal(row.farmEndedAt, null);
  assert.equal(row.farmUntil, null, "a lapsed window would be pulled again on the next sweep");
  assert.equal(row.enabled, true);
  assert.equal(row.configFile, "config_04.json");
  assert.equal(row.expiryAttempts, 0);
  assert.equal(row.expiryOwedFiles, undefined);
});

test("a stack MOVE of a live row (same renter) keeps its window", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_55.json", capacity: 50 });
  put("config_55.json", []);
  const holder = await mk("operator-selffarm", { botFile: "config_55.json", maxAccounts: 2000 });
  const until = new Date(Date.now() + 200 * 86400000);
  await RenterAccount.create({ renter: holder._id, clientSecret: "b1", login: "b1", host: "contabo", configFile: "config_03.json", farmUntil: until });
  await addRenterAccountsToConfig(HOST, "config_55.json", [entry("b1")], holder._id);
  const row = await RenterAccount.findOne({ clientSecret: "b1" }).lean();
  assert.equal(new Date(row.farmUntil).toISOString(), until.toISOString());
  assert.equal(row.configFile, "config_55.json");
});

test("REGRESSION: a row changing renter does not inherit the old owner's window", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_04.json", capacity: 50 });
  put("config_04.json", []);
  const holder = await mk("operator-selffarm", { botFile: "config_55.json", maxAccounts: 2000 });
  const r = await mk("newrenter", { botFile: "config_04.json" });
  await RenterAccount.create({
    renter: holder._id, clientSecret: "b2", login: "b2", host: "contabo", configFile: "config_03.json",
    farmUntil: new Date(Date.now() + 20 * 86400000),
  });
  await addRenterAccountsToConfig(HOST, "config_04.json", [entry("b2")], r._id);
  const row = await RenterAccount.findOne({ clientSecret: "b2" }).lean();
  assert.equal(String(row.renter), String(r._id));
  assert.equal(row.farmUntil, null, "the buyer's end date is not the new renter's");
});

test("a window passed with the placement is written with it", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_54.json", capacity: 50 });
  put("config_54.json", []);
  const holder = await mk("operator-selffarm", { botFile: "config_54.json", maxAccounts: 2000 });
  await RenterAccount.create({ renter: holder._id, clientSecret: "b3", login: "b3", host: "contabo", configFile: "", enabled: false, farmEndedAt: new Date() });
  const until = new Date(Date.now() + 30 * 86400000);
  await addRenterAccountsToConfig(HOST, "config_54.json", [entry("b3")], holder._id, { farmUntil: until });
  const row = await RenterAccount.findOne({ clientSecret: "b3" }).lean();
  assert.equal(new Date(row.farmUntil).toISOString(), until.toISOString());
  assert.equal(row.farmEndedAt, null);
});

test("REGRESSION: slots held for another renter's STOPPED accounts count as used", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_16.json", capacity: 3 });
  put("config_16.json", ["x1"]); // one account physically in it
  const stopped = await mk("botfarm1", { botFile: "config_16.json", botStoppedAt: new Date(), botStopReason: "renter", accessEnd: new Date(Date.now() + 9e9) });
  await RenterAccount.create({ renter: stopped._id, clientSecret: "s1", login: "s1", host: "contabo", configFile: "config_16.json" });
  await RenterAccount.create({ renter: stopped._id, clientSecret: "s2", login: "s2", host: "contabo", configFile: "config_16.json" });
  const other = await mk("newrenter", { botFile: "config_16.json" });
  // 1 physical + 2 reserved = 3/3: no room for anyone else…
  await assert.rejects(
    addRenterAccountsToConfig(HOST, "config_16.json", [entry("n1")], other._id),
    (e) => e.code === "rental_stack_full",
  );
  // …but the stopped renter itself can come back.
  const out = await addRenterAccountsToConfig(HOST, "config_16.json", [entry("s1"), entry("s2")], stopped._id);
  assert.equal(out.added, 2);
});

test("a BLOCKED renter's missing accounts reserve nothing", async () => {
  await reset();
  await RenterBotStack.create({ host: "contabo", file: "config_16.json", capacity: 2 });
  put("config_16.json", ["x1"]);
  const expired = await mk("wasd", { botFile: "config_16.json", accessEnd: new Date(Date.now() - 86400000) });
  await RenterAccount.create({ renter: expired._id, clientSecret: "w1", login: "w1", host: "contabo", configFile: "config_16.json" });
  const other = await mk("newrenter", { botFile: "config_16.json" });
  const out = await addRenterAccountsToConfig(HOST, "config_16.json", [entry("n1")], other._id);
  assert.equal(out.added, 1);
});
