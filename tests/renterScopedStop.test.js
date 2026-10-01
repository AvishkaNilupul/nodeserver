// A renter's stop / lease end / suspend / games change may only ever touch THAT
// renter's accounts (2026-10-01).
//
// "Is anyone else on this bot?" used to be answered from which renters were
// ASSIGNED to the config file. The rent-farm holder (operator-selffarm) leaves
// its paid buyers behind in every stack it fills and then points itself at the
// next one — so on 2026-09-30 renter jhonkwiall looked "alone" on
// contabo/config_03 while 49 paying buyers shared the file, and its lease end
// (2026-10-13) would have `docker stop`-ped every one of them. A games change
// from its portal would have re-pinned all 49 to its game.
//
// These tests run the real renterBotOps against mongodb-memory-server and a fake
// bot host that records every file write and docker verb.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// ---------------------------------------------------------------------------
// Fake bot host + botConfigRoutes, injected for renterBotOps (and the
// fleetIntegrity module it takes CONFIG_RE from).
// ---------------------------------------------------------------------------
const world = {
  fs: { local: {}, contabo: {} },
  ps: { local: {}, contabo: {} },
  ops: [],
  psFails: false,
  unreadable: new Set(), // "host/file": listed by readdir, unreadable in the batch read
  telegram: [],
};

function containerForFile(file) {
  const m = String(file).match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  return file === "config.json" ? "twitchbot" : null;
}

const fakeHosts = {
  listHosts: () => [
    { id: "local", label: "Local" },
    { id: "contabo", label: "Contabo VPS" },
  ],
  resolveHost: (v) => {
    const id = v || "local";
    return id === "local" || id === "contabo" ? { id, label: id } : null;
  },
  readdir: async (h) => [
    ...Object.keys(world.fs[h.id]),
    ...[...world.unreadable].filter((k) => k.startsWith(h.id + "/")).map((k) => k.slice(h.id.length + 1)),
  ],
  readFile: async (h, f) => {
    if (!(f in world.fs[h.id])) {
      const e = new Error("No such file " + f);
      e.code = "ENOENT";
      throw e;
    }
    return world.fs[h.id][f];
  },
  readFiles: async (h, files) =>
    Object.fromEntries(
      files.map((f) => [
        f,
        f in world.fs[h.id] && !world.unreadable.has(h.id + "/" + f)
          ? { ok: true, text: world.fs[h.id][f] }
          : { ok: false, error: "Not found" },
      ]),
    ),
  writeFileAtomic: async (h, f, text) => {
    world.fs[h.id][f] = text;
    world.ops.push(["write", h.id, f]);
  },
  dockerPs: async (h) => {
    if (world.psFails) throw new Error("ssh: connect timed out");
    return JSON.parse(JSON.stringify(world.ps[h.id]));
  },
  dockerContainer: async (h, action, c) => {
    world.ops.push([action, h.id, c]);
    if (!world.ps[h.id][c]) throw new Error("Error response from daemon: No such container: " + c);
    if (action === "stop") world.ps[h.id][c].state = "exited";
    if (action === "start" || action === "restart") world.ps[h.id][c].state = "running";
  },
  setRestartPolicy: async (h, c, p) => {
    world.ops.push(["policy", h.id, c, p]);
  },
  restoreRestartPolicy: async (h, c) => {
    world.ops.push(["policy", h.id, c, "always"]);
  },
};

const fakeCfg = {
  containerForFile,
  validFile: (f) => typeof f === "string" && /^config(_[A-Za-z0-9-]+)?\.json$/.test(f),
  parseGamesList: (v) =>
    Array.isArray(v)
      ? v.map((g) => String(g).trim()).filter(Boolean)
      : typeof v === "string"
        ? v.split(",").map((g) => g.trim()).filter(Boolean)
        : [],
  restartConfigContainer: async (h, f) => {
    const c = containerForFile(f);
    world.ops.push(["restart", h.id, c]);
    if (world.ps[h.id][c]) world.ps[h.id][c].state = "running";
    return { restarted: true, container: c };
  },
  // Present so the PRE-FIX code can run against this fake too (the regression
  // tests must fail on behaviour, not on a missing stub).
  stopConfigContainer: async (h, f) => {
    const c = containerForFile(f);
    world.ops.push(["stop", h.id, c]);
    if (world.ps[h.id][c]) world.ps[h.id][c].state = "exited";
    return { stopped: true, container: c };
  },
  setConfigGames: async (h, f, games) => {
    const list = fakeCfg.parseGamesList(games);
    const data = JSON.parse(world.fs[h.id][f]);
    data.FavouriteGames = list;
    data.TwitchSettings.OnlyFavouriteGames = list.length > 0;
    for (const u of data.TwitchSettings.TwitchUsers) u.FavouriteGames = list.slice();
    world.fs[h.id][f] = JSON.stringify(data);
    world.ops.push(["write", h.id, f]);
    return list;
  },
  startConfigContainer: async (h, f) => {
    const c = containerForFile(f);
    const data = JSON.parse(world.fs[h.id][f]);
    if (!data.TwitchSettings.TwitchUsers.length) {
      const e = new Error("no accounts");
      e.code = "no_accounts";
      throw e;
    }
    world.ops.push(["start", h.id, c]);
    world.ps[h.id][c] = { state: "running" };
    return { started: true, container: c };
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/utils[\\/](renterBotOps|fleetIntegrity)\.js$/.test(from)) {
    if (request === "./botHosts") return fakeHosts;
    if (request === "../routes/botConfigRoutes") return fakeCfg;
    if (request === "./telegram") return { sendTelegram: async (m) => { world.telegram.push(m); } };
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const RenterBotStack = require("../models/RenterBotStack");
const PendingReload = require("../models/PendingReload");
const ops = require("../utils/renterBotOps");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-scoped-stop"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function reset() {
  world.fs = { local: {}, contabo: {} };
  world.ps = { local: {}, contabo: {} };
  world.ops = [];
  world.psFails = false;
  world.unreadable = new Set();
  world.telegram = [];
  await Promise.all([
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
    RenterBotStack.deleteMany({}),
    PendingReload.deleteMany({}),
  ]);
}

function user(secret, games = []) {
  return { ClientSecret: secret, Login: secret, UniqueId: "", Id: "", Enabled: true, FavouriteGames: games };
}

function putConfig(host, file, users, extra = {}) {
  world.fs[host][file] = JSON.stringify({
    FavouriteGames: [],
    ...extra,
    TwitchSettings: { OnlyFavouriteGames: true, TwitchUsers: users },
  });
}

function readConfig(host, file) {
  return JSON.parse(world.fs[host][file]);
}

function secretsIn(host, file) {
  return readConfig(host, file).TwitchSettings.TwitchUsers.map((u) => u.ClientSecret);
}

let seq = 0;
async function mkRenter(username, fields = {}) {
  seq++;
  return Renter.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: "x",
    botHost: "contabo",
    ...fields,
  });
}

async function mkAccount(renter, secret, fields = {}) {
  return RenterAccount.create({
    renter: renter._id,
    clientSecret: secret,
    login: secret,
    host: "contabo",
    enabled: true,
    ...fields,
  });
}

const HOST = { id: "contabo", label: "contabo" };
const docker = () => world.ops.filter((o) => o[0] !== "write");

// ---------------------------------------------------------------------------
// The 2026-10-13 incident, reproduced from the live contabo/config_03 shape.
// ---------------------------------------------------------------------------
test("REGRESSION: a direct renter's lease end on a stack full of rent-farm buyers pulls ONLY its account", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json", maxAccounts: 2000 });
  const wasd = await mkRenter("wasd", { botFile: "config_03.json", accessEnd: new Date("2026-08-19"), botStoppedAt: new Date("2026-08-19") });
  const jhon = await mkRenter("jhonkwiall", { botFile: "config_03.json", accessEnd: new Date("2026-10-13") });
  const buyers = [];
  for (let i = 0; i < 49; i++) {
    buyers.push("buyer" + i);
    await mkAccount(holder, "buyer" + i, { configFile: "config_03.json", farmUntil: new Date("2027-01-20") });
  }
  await mkAccount(wasd, "wasdacct", { configFile: "config_03.json" });
  await mkAccount(jhon, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [...buyers.map((b) => user(b, ["Overwatch"])), user("wasdacct"), user("jhonacct", ["Rust"])]);
  world.ps.contabo.twitchbotx3 = { state: "running" };

  const out = await ops.stopRenterFarming(jhon, HOST);

  assert.equal(out.mode, "detached");
  assert.equal(out.removed, 1);
  const left = secretsIn("contabo", "config_03.json");
  assert.equal(left.length, 50, "49 buyers + wasd stay in the file");
  assert.ok(!left.includes("jhonacct"));
  for (const b of buyers) assert.ok(left.includes(b), b + " was pulled");
  // The container keeps running for the buyers: reloaded, never stopped.
  assert.deepEqual(docker(), [["restart", "contabo", "twitchbotx3"]]);
  assert.equal(world.ps.contabo.twitchbotx3.state, "running");
  // The pulled account's own games are remembered for a later start.
  const row = await RenterAccount.findOne({ clientSecret: "jhonacct" }).lean();
  assert.deepEqual(row.favouriteGames, ["Rust"]);
});

test("REGRESSION: a renter's games change on a shared stack never re-games the buyers", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const jhon = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(holder, "buyer2", { configFile: "config_03.json" });
  await mkAccount(jhon, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1", ["Overwatch"]), user("buyer2", ["Escape from Tarkov"]), user("jhonacct", ["Apex Legends"])], { FavouriteGames: ["Warframe"] });

  const out = await ops.applyRenterGames(jhon, HOST, "Rust, Rocket League");

  assert.equal(out.scope, "own-accounts");
  const cfg = readConfig("contabo", "config_03.json");
  const bySecret = Object.fromEntries(cfg.TwitchSettings.TwitchUsers.map((u) => [u.ClientSecret, u.FavouriteGames]));
  assert.deepEqual(bySecret.buyer1, ["Overwatch"]);
  assert.deepEqual(bySecret.buyer2, ["Escape from Tarkov"]);
  assert.deepEqual(bySecret.jhonacct, ["Rust", "Rocket League"]);
  assert.deepEqual(cfg.FavouriteGames, ["Warframe"], "the root list is not the renter's to change");
});

test("a renter alone in its file still gets the whole-config games write", async () => {
  await reset();
  const r = await mkRenter("rainbowsix", { botFile: "config_16.json", botHost: "local" });
  await mkAccount(r, "r6a", { configFile: "config_16.json", host: "local" });
  await mkAccount(r, "r6b", { configFile: "config_16.json", host: "local" });
  putConfig("local", "config_16.json", [user("r6a", ["x"]), user("r6b")], { FavouriteGames: ["old"] });

  const out = await ops.applyRenterGames(r, { id: "local", label: "local" }, ["Rainbow Six Siege"]);

  assert.equal(out.scope, "config");
  const cfg = readConfig("local", "config_16.json");
  assert.deepEqual(cfg.FavouriteGames, ["Rainbow Six Siege"]);
  assert.equal(cfg.TwitchSettings.OnlyFavouriteGames, true);
  for (const u of cfg.TwitchSettings.TwitchUsers) assert.deepEqual(u.FavouriteGames, ["Rainbow Six Siege"]);
});

test("a renter truly alone: the file is emptied and the container stopped with its restart policy cleared", async () => {
  await reset();
  const r = await mkRenter("bulksellerhaz", { botFile: "config_22.json", botHost: "local", accessEnd: new Date("2026-10-12") });
  await mkAccount(r, "bsh1", { configFile: "config_22.json", host: "local" });
  putConfig("local", "config_22.json", [user("bsh1", ["Overwatch"])]);
  world.ps.local.twitchbotx22 = { state: "running" };

  const out = await ops.stopRenterFarming(r, { id: "local", label: "local" });

  assert.equal(out.mode, "stopped");
  assert.equal(out.removed, 1);
  assert.deepEqual(secretsIn("local", "config_22.json"), [], "entries are removed, not left for a restart to revive");
  assert.deepEqual(docker(), [
    ["policy", "local", "twitchbotx22", "no"],
    ["stop", "local", "twitchbotx22"],
  ]);
});

test("a stopped shared bot is left stopped — pulling one renter never STARTS it", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("marol4jcuts", { botFile: "config_04.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_04.json" });
  await mkAccount(r, "m1", { configFile: "config_04.json" });
  putConfig("contabo", "config_04.json", [user("buyer1"), user("m1")]);
  world.ps.contabo.twitchbotx4 = { state: "exited" };

  const out = await ops.stopRenterFarming(r, HOST);

  assert.equal(out.removed, 1);
  assert.deepEqual(docker(), [], "no restart / start of a stopped container");
  assert.equal(world.ps.contabo.twitchbotx4.state, "exited");
  assert.deepEqual(out.files.map((f) => f.action), ["left-stopped"]);
});

test("a retry after a failed reload still reloads (the reload was recorded as owed)", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  // First attempt: the account comes out, then the reload cannot happen.
  world.psFails = true;
  await assert.rejects(ops.stopRenterFarming(r, HOST));
  assert.ok(await PendingReload.findOne({ host: "contabo", file: "config_03.json" }).lean(), "owed reload recorded");
  // The retry removes nothing — but the owed reload still happens, once.
  world.psFails = false;
  world.ops = [];
  const out = await ops.stopRenterFarming(r, HOST);
  assert.equal(out.removed, 0);
  assert.deepEqual(docker(), [["restart", "contabo", "twitchbotx3"]]);
  assert.equal(await PendingReload.countDocuments({}), 0, "cleared once done");
});

test("REGRESSION: a repeated stop that removes nothing and owes nothing restarts NOTHING", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  await ops.stopRenterFarming(r, HOST);
  world.ops = [];
  await ops.stopRenterFarming(r, HOST);
  await ops.stopRenterFarming(r, HOST);
  assert.deepEqual(docker(), [], "the 49-buyer bot is not restarted by repeated Stop presses");
});

test("an unreadable container state after pulling accounts throws (the sweep retries) and starts nothing", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.psFails = true;

  await assert.rejects(ops.stopRenterFarming(r, HOST), (e) => e.unreachable === true);
  assert.deepEqual(docker(), []);
});

test("a stale ledger pointer: the renter's account found in ANOTHER config is pulled from there too", async () => {
  await reset();
  const r = await mkRenter("wasd", { botFile: "config_15.json", accessEnd: new Date("2026-08-19") });
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  // The ledger still says config_15 (a moved stack); the account really sits in config_03.
  await mkAccount(r, "wasdacct", { configFile: "config_15.json" });
  putConfig("contabo", "config_15.json", [user("other")]);
  putConfig("contabo", "config_03.json", [user("buyer1"), user("wasdacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.ps.contabo.twitchbotx15 = { state: "running" };

  const out = await ops.stopRenterFarming(r, HOST);

  assert.equal(out.removed, 1);
  assert.deepEqual(secretsIn("contabo", "config_03.json"), ["buyer1"]);
  assert.deepEqual(secretsIn("contabo", "config_15.json"), ["other"]);
  const restarted = docker().filter((o) => o[0] === "restart").map((o) => o[2]).sort();
  // Only the file the account was really in reloads; the stale pointer's file
  // (another tenant's bot) had nothing removed and owes nothing.
  assert.deepEqual(restarted, ["twitchbotx3"]);
});

test("a missing config file is reported, not fatal (the dangling-slot case)", async () => {
  await reset();
  const r = await mkRenter("ghost", { botFile: "config_40.json" });
  await mkAccount(r, "g1", { configFile: "config_40.json" });

  const out = await ops.stopRenterFarming(r, HOST);

  assert.equal(out.removed, 0);
  assert.deepEqual(out.files, [{ host: "contabo", file: "config_40.json", missing: true }]);
});

// ---------------------------------------------------------------------------
// Start: only the renter's own bot, within capacity, own games restored.
// ---------------------------------------------------------------------------
test("REGRESSION: start never copies accounts that live in other stacks into the renter's bot", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await RenterBotStack.create({ host: "contabo", file: "config_54.json", capacity: 50 });
  for (let i = 0; i < 5; i++) await mkAccount(holder, "b02_" + i, { configFile: "config_02.json" });
  await mkAccount(holder, "b54_0", { configFile: "config_54.json" });
  await mkAccount(holder, "b54_1", { configFile: "config_54.json" });
  putConfig("contabo", "config_54.json", [user("b54_0")]);
  world.ps.contabo.twitchbotx54 = { state: "running" };

  const out = await ops.startRenterFarming(holder, HOST);

  assert.equal(out.added, 1, "only the missing config_54 account is put back");
  assert.deepEqual(secretsIn("contabo", "config_54.json").sort(), ["b54_0", "b54_1"]);
  const others = await RenterAccount.find({ clientSecret: /^b02_/ }).lean();
  for (const a of others) assert.equal(a.configFile, "config_02.json", a.clientSecret + " was repointed");
});

test("start never overfills a rental stack: it puts back what fits and reports the rest", async () => {
  await reset();
  const r = await mkRenter("bulkfarm2", { botFile: "config_21.json", botHost: "local" });
  await RenterBotStack.create({ host: "local", file: "config_21.json", capacity: 2 });
  await mkAccount(r, "a1", { configFile: "config_21.json", host: "local" });
  await mkAccount(r, "a2", { configFile: "config_21.json", host: "local" });
  putConfig("local", "config_21.json", [user("someone-else")]);
  world.ps.local.twitchbotx21 = { state: "running" };

  const out = await ops.startRenterFarming(r, { id: "local", label: "local" });

  assert.equal(out.added, 1);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /config_21\.json is full/);
  assert.equal(secretsIn("local", "config_21.json").length, 2, "capacity respected");
});

test("start with NO room at all fails loudly and writes nothing", async () => {
  await reset();
  const r = await mkRenter("bulkfarm2", { botFile: "config_21.json", botHost: "local" });
  await RenterBotStack.create({ host: "local", file: "config_21.json", capacity: 1 });
  await mkAccount(r, "a1", { configFile: "config_21.json", host: "local" });
  putConfig("local", "config_21.json", [user("someone-else")]);

  await assert.rejects(
    ops.startRenterFarming(r, { id: "local", label: "local" }),
    (e) => e.code === "rental_stack_full",
  );
  assert.deepEqual(secretsIn("local", "config_21.json"), ["someone-else"]);
});

test("stop then start puts each account back with its own games", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await RenterBotStack.create({ host: "contabo", file: "config_04.json", capacity: 50 });
  await mkAccount(holder, "buyer1", { configFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  await mkAccount(r, "e2", { configFile: "config_04.json" });
  putConfig("contabo", "config_04.json", [user("buyer1", ["Overwatch"]), user("e1", ["Escape from Tarkov"]), user("e2", ["Escape from Tarkov: Arena"])]);
  world.ps.contabo.twitchbotx4 = { state: "running" };

  await ops.stopRenterFarming(r, HOST);
  assert.deepEqual(secretsIn("contabo", "config_04.json"), ["buyer1"]);
  const fresh = await Renter.findById(r._id);
  await ops.startRenterFarming(fresh, HOST);

  const byS = Object.fromEntries(readConfig("contabo", "config_04.json").TwitchSettings.TwitchUsers.map((u) => [u.ClientSecret, u.FavouriteGames]));
  assert.deepEqual(byS.buyer1, ["Overwatch"]);
  assert.deepEqual(byS.e1, ["Escape from Tarkov"]);
  assert.deepEqual(byS.e2, ["Escape from Tarkov: Arena"]);
});

test("otherSharers counts renters whose accounts sit in the file, not just those assigned to it", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const jhon = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(jhon, "jhonacct", { configFile: "config_03.json" });

  const names = (await ops.otherSharers(jhon)).map((r) => r.username);
  assert.deepEqual(names, ["operator-selffarm"]);
});

// ---------------------------------------------------------------------------
// Follow-ups from the 2026-10-01 adversarial review of the first version.
// ---------------------------------------------------------------------------
test("start puts an account back into the file its ledger row names, not the renter's home", async () => {
  await reset();
  const r = await mkRenter("bulkfarm2", { botFile: "config_21.json", botHost: "local" });
  await mkAccount(r, "home1", { configFile: "config_21.json", host: "local" });
  await mkAccount(r, "moved1", { configFile: "config_16.json", host: "local" }); // move-renter-accounts
  putConfig("local", "config_21.json", [user("x")]);
  putConfig("local", "config_16.json", [user("y")]);
  world.ps.local.twitchbotx21 = { state: "running" };
  world.ps.local.twitchbotx16 = { state: "running" };

  const out = await ops.startRenterFarming(r, { id: "local", label: "local" });

  assert.equal(out.added, 2);
  assert.ok(secretsIn("local", "config_21.json").includes("home1"));
  assert.ok(secretsIn("local", "config_16.json").includes("moved1"), "back in its own file");
  assert.ok(!secretsIn("local", "config_21.json").includes("moved1"));
});

test("start never adds an account that already farms in another config — it re-points the row", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  putConfig("contabo", "config_04.json", [user("z")]);
  putConfig("contabo", "config_05.json", [user("e1")]); // really farming here
  world.ps.contabo.twitchbotx4 = { state: "running" };

  const out = await ops.startRenterFarming(r, HOST);

  assert.equal(out.added, 0);
  assert.deepEqual(secretsIn("contabo", "config_04.json"), ["z"], "no second copy");
  assert.equal((await RenterAccount.findOne({ clientSecret: "e1" }).lean()).configFile, "config_05.json");
});

test("REGRESSION: a start for the rent-farm holder never restores accounts from other stacks", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await mkAccount(holder, "stray", { configFile: "" }); // unplaced holder row
  await mkAccount(holder, "lost", { configFile: "config_31.json" }); // file gone
  await mkAccount(holder, "own", { configFile: "config_54.json" });
  putConfig("contabo", "config_54.json", [user("own")]);
  world.ps.contabo.twitchbotx54 = { state: "running" };

  const out = await ops.startRenterFarming(holder, HOST);

  assert.equal(out.added, 0);
  assert.deepEqual(secretsIn("contabo", "config_54.json"), ["own"]);
});

test("an unreadable RENTAL STACK fails the stop instead of letting a secret survive in it", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  await RenterBotStack.create({ host: "contabo", file: "config_07.json", capacity: 50 });
  world.fs.contabo["config_07.json"] = "{ not json";

  await assert.rejects(ops.stopRenterFarming(r, HOST), /Could not read contabo\/config_07\.json/);
});

test("a stack the batched read reports 'Not found' although it is listed is UNREADABLE, not absent", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  await RenterBotStack.create({ host: "contabo", file: "config_08.json", capacity: 50 });
  world.unreadable.add("contabo/config_08.json"); // e.g. permission denied on the remote

  await assert.rejects(ops.stopRenterFarming(r, HOST), /Could not read contabo\/config_08\.json: Not found/);
});

test("a file the LEDGER names that cannot be read fails the stop", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  await mkAccount(r, "moved", { configFile: "config_12.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  world.fs.contabo["config_12.json"] = "{ truncated";

  await assert.rejects(ops.stopRenterFarming(r, HOST), /Could not read contabo\/config_12\.json/);
});

test("REGRESSION: one corrupt OPERATOR config (no stack, not in the ledger) does not block every renter's stop on the host", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.fs.contabo["config_07.json"] = "{ not json";

  const out = await ops.stopRenterFarming(r, HOST);

  assert.equal(out.removed, 1);
  assert.deepEqual(secretsIn("contabo", "config_03.json"), []);
});

test("REGRESSION: ledger rows on an UNKNOWN host no longer block the pull on the known one — it still fails, afterwards", async () => {
  await reset();
  const r = await mkRenter("ghost", { botFile: "config_03.json" });
  await mkAccount(r, "g0", { configFile: "config_03.json" });
  await mkAccount(r, "g1", { configFile: "config_09.json", host: "phone" });
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("g0")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };

  await assert.rejects(ops.stopRenterFarming(r, HOST), (e) => {
    assert.match(e.message, /unknown bot host 'phone'/);
    assert.equal(e.partial.removed, 1, "the known host was still done");
    return true;
  });
  assert.deepEqual(secretsIn("contabo", "config_03.json"), ["buyer1"], "g0 pulled before the throw");
  assert.ok(world.ops.some((o) => o[0] === "restart" && o[2] === "twitchbotx3"), "and its bot reloaded");
});

test("an account in a config no bot reads (a backup name) neither fails the stop nor is edited", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  putConfig("contabo", "config_old-copy.json", [user("jhonacct")]); // scanned (CONFIG_RE), no container maps it
  world.ps.contabo.twitchbotx3 = { state: "running" };
  const real = fakeCfg.validFile;
  fakeCfg.validFile = (f) => typeof f === "string" && /^config(_\d{1,3})?\.json$/.test(f); // prod FILE_RE
  try {
    const out = await ops.stopRenterFarming(r, HOST);
    assert.equal(out.removed, 1);
  } finally {
    fakeCfg.validFile = real;
  }
  assert.deepEqual(secretsIn("contabo", "config_03.json"), []);
  assert.deepEqual(secretsIn("contabo", "config_old-copy.json"), ["jhonacct"], "left alone");
});

test("an unreadable stack does not stop the READABLE files on the host being pulled", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  await RenterBotStack.create({ host: "contabo", file: "config_07.json", capacity: 50 });
  world.unreadable.add("contabo/config_07.json");

  await assert.rejects(ops.stopRenterFarming(r, HOST), /config_07/);
  assert.deepEqual(secretsIn("contabo", "config_03.json"), []);
});

test("with container restarts disabled a reload is NOT reported as done", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  const real = fakeCfg.restartConfigContainer;
  fakeCfg.restartConfigContainer = async () => ({ restarted: false });
  try {
    await assert.rejects(ops.stopRenterFarming(r, HOST), (e) => e.code === "disabled");
  } finally {
    fakeCfg.restartConfigContainer = real;
  }
  assert.ok(await PendingReload.findOne({ file: "config_03.json" }).lean(), "still owed");
});

test("a stop FORGETS a saved games list when the account had none", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json", favouriteGames: ["Old Game"] });
  putConfig("contabo", "config_04.json", [user("buyer1", ["Overwatch"]), user("e1", [])]);
  world.ps.contabo.twitchbotx4 = { state: "running" };

  await ops.stopRenterFarming(r, HOST);

  const row = await RenterAccount.findOne({ clientSecret: "e1" }).lean();
  assert.equal(row.favouriteGames, undefined, "no stale list left to come back");
});

test("a games change forgets per-account games saved by an earlier stop", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json", favouriteGames: ["Old Game"] });
  putConfig("contabo", "config_04.json", [user("other", ["Overwatch"])]); // renter stopped
  await ops.applyRenterGames(r, HOST, ["New Game"]);
  const row = await RenterAccount.findOne({ clientSecret: "e1" }).lean();
  assert.equal(row.favouriteGames, undefined);
});

test("REGRESSION: arming games never pins a blank co-tenant once the global switch is already on", () => {
  const data = {
    FavouriteGames: [],
    TwitchSettings: {
      OnlyFavouriteGames: true,
      TwitchUsers: [user("mine", ["x"]), user("blank", [])],
    },
  };
  ops.setUsersGamesBySecret(data, ["mine"], ["Rust"]);
  const blank = data.TwitchSettings.TwitchUsers.find((u) => u.ClientSecret === "blank");
  assert.deepEqual(blank.FavouriteGames, [], "not re-gamed");
  // With the switch OFF (wander mode) the old protection still applies.
  const off = {
    FavouriteGames: [],
    TwitchSettings: { OnlyFavouriteGames: false, TwitchUsers: [user("mine"), user("blank", [])] },
  };
  ops.setUsersGamesBySecret(off, ["mine"], ["Rust"]);
  assert.deepEqual(off.TwitchSettings.TwitchUsers[1].FavouriteGames, ["Rust"]);
});

// ---------------------------------------------------------------------------
// Round 3 (second review): owed reloads are retried by a sweeper, not only
// when something happens to touch the same file again.
// ---------------------------------------------------------------------------
test("REGRESSION: an owed reload is retried by the sweeper even when nothing touches the file again", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("jhonacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.psFails = true;
  await assert.rejects(ops.stopRenterFarming(r, HOST));
  world.psFails = false;
  world.ops = [];

  let out = await ops.sweepPendingReloads({ notify: false });
  assert.equal(out.settled, 0, "a fresh entry is left to the operation still settling it");
  out = await ops.sweepPendingReloads({ minAgeMs: 0, notify: false });
  assert.equal(out.settled, 1);
  assert.deepEqual(docker(), [["restart", "contabo", "twitchbotx3"]]);
  assert.equal(await PendingReload.countDocuments({}), 0);
});

test("an owed reload whose file is now EMPTY stops the running bot for good instead of restarting it", async () => {
  await reset();
  putConfig("contabo", "config_09.json", []);
  world.ps.contabo.twitchbotx9 = { state: "running" };
  await PendingReload.create({ host: "contabo", file: "config_09.json", since: new Date(Date.now() - 600000), reason: "accounts removed" });
  const out = await ops.sweepPendingReloads({ notify: false });
  assert.equal(out.settled, 1);
  assert.deepEqual(docker(), [["policy", "contabo", "twitchbotx9", "no"], ["stop", "contabo", "twitchbotx9"]]);
});

test("restartIfRunning never restarts a bot whose file is empty — it stops it for good", async () => {
  await reset();
  putConfig("contabo", "config_05.json", []);
  world.ps.contabo.twitchbotx5 = { state: "running" };
  assert.equal(await ops.restartIfRunning(HOST, "config_05.json"), false);
  assert.deepEqual(docker(), [["policy", "contabo", "twitchbotx5", "no"], ["stop", "contabo", "twitchbotx5"]]);
});

test("REGRESSION: a restart-policy clear that fails is recorded and retried (a reboot must not start an empty bot)", async () => {
  await reset();
  const r = await mkRenter("bulksellerhaz", { botFile: "config_22.json", botHost: "local" });
  await mkAccount(r, "bsh1", { configFile: "config_22.json", host: "local" });
  putConfig("local", "config_22.json", [user("bsh1")]);
  world.ps.local.twitchbotx22 = { state: "running" };
  const realPolicy = fakeHosts.setRestartPolicy;
  fakeHosts.setRestartPolicy = async () => {
    throw new Error("ssh: broken pipe");
  };
  try {
    const out = await ops.stopRenterFarming(r, { id: "local", label: "local" });
    assert.equal(out.mode, "stopped", "the accounts are out and the bot is stopped");
  } finally {
    fakeHosts.setRestartPolicy = realPolicy;
  }
  const owed = await PendingReload.findOne({ host: "local", file: "config_22.json" }).lean();
  assert.ok(owed, "the failed policy clear is owed");
  assert.match(owed.reason, /restart-policy/);
  await PendingReload.updateOne({ _id: owed._id }, { $set: { since: new Date(Date.now() - 600000) } });
  world.ops = [];
  const swept = await ops.sweepPendingReloads({ notify: false });
  assert.equal(swept.settled, 1);
  assert.deepEqual(docker()[0], ["policy", "local", "twitchbotx22", "no"]);
  assert.equal(await PendingReload.countDocuments({}), 0);
});

test("an owed reload that keeps failing pages after 30 minutes, then not again for hours", async () => {
  await reset();
  putConfig("contabo", "config_03.json", [user("a")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.psFails = true;
  await PendingReload.create({ host: "contabo", file: "config_03.json", since: new Date(Date.now() - 10 * 60000), reason: "accounts removed" });
  let out = await ops.sweepPendingReloads();
  assert.equal(out.failed, 1);
  assert.equal(out.paged, 0, "not before 30 min");
  await PendingReload.updateOne({}, { $set: { since: new Date(Date.now() - 31 * 60000) } });
  out = await ops.sweepPendingReloads();
  assert.equal(out.paged, 1);
  assert.match(world.telegram.join("\n"), /contabo\/config_03\.json still has to reload/);
  out = await ops.sweepPendingReloads();
  assert.equal(out.paged, 0, "not again within 6 h");
  const row = await PendingReload.findOne({}).lean();
  assert.equal(row.attempts, 3);
  assert.match(row.lastError, /host unreachable/, "one read per host, not a retry cycle per row");
});

test("an owed reload on an unknown host is kept (and pages), never dropped", async () => {
  await reset();
  await PendingReload.create({ host: "phone", file: "config_03.json", since: new Date(Date.now() - 31 * 60000) });
  const out = await ops.sweepPendingReloads();
  assert.equal(out.failed, 1);
  assert.equal(out.paged, 1);
  assert.equal(await PendingReload.countDocuments({}), 1);
});

test("REGRESSION: a stop that failed on a file found only by scanning re-checks it next time (reported done only once it reloaded)", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("wasd", { botFile: "config_15.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  await mkAccount(r, "wasdacct", { configFile: "config_15.json" }); // stale pointer
  putConfig("contabo", "config_15.json", [user("other")]);
  putConfig("contabo", "config_03.json", [user("buyer1"), user("wasdacct")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.ps.contabo.twitchbotx15 = { state: "running" };
  const realRestart = fakeCfg.restartConfigContainer;
  fakeCfg.restartConfigContainer = async (h, f) => {
    if (f === "config_03.json") throw new Error("docker: timeout");
    return realRestart(h, f);
  };
  try {
    await assert.rejects(ops.stopRenterFarming(r, HOST), /docker: timeout/);
    let fresh = await Renter.findById(r._id).lean();
    assert.deepEqual(fresh.stopOwedFiles, ["contabo/config_03.json"]);
    // Retry: wasdacct is no longer IN config_03 — but its bot still has it loaded.
    await assert.rejects(ops.stopRenterFarming(fresh, HOST), /docker: timeout/);
  } finally {
    fakeCfg.restartConfigContainer = realRestart;
  }
  const out = await ops.stopRenterFarming(await Renter.findById(r._id).lean(), HOST);
  assert.ok(out.files.some((f) => f.file === "config_03.json" && f.action === "restarted"), JSON.stringify(out.files));
  assert.equal((await Renter.findById(r._id).lean()).stopOwedFiles, undefined, "cleared once done");
});

test("REGRESSION: start never puts back a window that already lapsed (that is renewal's job)", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "live1", { configFile: "config_04.json" });
  await mkAccount(r, "lapsed1", { configFile: "config_04.json", farmUntil: new Date(Date.now() - 60000) });
  putConfig("contabo", "config_04.json", [user("other")]);
  world.ps.contabo.twitchbotx4 = { state: "running" };
  const out = await ops.startRenterFarming(r, HOST);
  assert.equal(out.added, 1);
  assert.deepEqual(secretsIn("contabo", "config_04.json").sort(), ["live1", "other"]);
});

test("REGRESSION: a start whose own bot is EMPTY (accounts moved) reloads the file it restored into and succeeds", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json", botStoppedAt: new Date(), botStopReason: "lease" });
  await mkAccount(r, "e1", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", []);
  putConfig("contabo", "config_06.json", [user("buyer")]);
  world.ps.contabo.twitchbotx6 = { state: "running" };

  const out = await ops.startRenterFarming(r, HOST);

  assert.equal(out.added, 1);
  assert.equal(out.homeEmpty, true);
  assert.deepEqual(secretsIn("contabo", "config_06.json").sort(), ["buyer", "e1"]);
  assert.deepEqual(docker(), [["restart", "contabo", "twitchbotx6"]], "reloaded; the empty home is not started");
  assert.equal(await PendingReload.countDocuments({}), 0);
  const after = await Renter.findById(r._id).lean();
  assert.equal(after.botStoppedAt, null, "farming again: the lease-end sweep must see this renter");
});

test("REGRESSION: a start whose own-bot start FAILS still reloads the other files, and leaves the renter visible to the lease sweep", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json", botStoppedAt: new Date(), botStopReason: "operator" });
  await mkAccount(r, "home1", { configFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", []);
  putConfig("contabo", "config_06.json", [user("buyer")]);
  world.ps.contabo.twitchbotx6 = { state: "running" };
  const realStart = fakeCfg.startConfigContainer;
  fakeCfg.startConfigContainer = async () => {
    throw new Error("compose: service twitchbotx4 failed");
  };
  try {
    await assert.rejects(ops.startRenterFarming(r, HOST), /compose/);
  } finally {
    fakeCfg.startConfigContainer = realStart;
  }
  assert.ok(docker().some((o) => o[0] === "restart" && o[2] === "twitchbotx6"), "config_06 reloaded first");
  assert.ok(await PendingReload.findOne({ file: "config_04.json" }).lean(), "the own bot's reload stays owed");
  assert.equal((await Renter.findById(r._id).lean()).botStoppedAt, null);
});

test("a start that cannot read the own bot's state leaves its reload owed (compose up does not reload a running bot)", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  putConfig("contabo", "config_04.json", [user("x")]);
  world.ps.contabo.twitchbotx4 = { state: "running" };
  world.psFails = true;
  await ops.startRenterFarming(r, HOST);
  assert.ok(await PendingReload.findOne({ file: "config_04.json" }).lean());
});

test("a games change reaches every file the renter's accounts are recorded in on the host", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  await mkAccount(r, "e2", { configFile: "config_06.json" });
  await mkAccount(holder, "buyer", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", [user("e1", ["Old"])]);
  putConfig("contabo", "config_06.json", [user("buyer", ["Overwatch"]), user("e2", ["Old"])]);

  world.ps.contabo.twitchbotx6 = { state: "running" };

  const out = await ops.applyRenterGames(r, HOST, ["Rust"]);

  const six = readConfig("contabo", "config_06.json").TwitchSettings.TwitchUsers;
  assert.deepEqual(six.find((u) => u.ClientSecret === "e2").FavouriteGames, ["Rust"]);
  assert.deepEqual(six.find((u) => u.ClientSecret === "buyer").FavouriteGames, ["Overwatch"], "a buyer is never re-gamed");
  assert.deepEqual(out.otherFiles, ["config_06.json"]);
  assert.ok(docker().some((o) => o[0] === "restart" && o[2] === "twitchbotx6"), "that bot reloads to apply it");
  assert.equal(await PendingReload.countDocuments({}), 0);
});

test("a games change never writes the whole-config list into a file that is not the renter's own bot", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  await mkAccount(r, "e2", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", [user("e1", ["Old"])]);
  putConfig("contabo", "config_06.json", [user("e2", ["Old"])], { FavouriteGames: ["Keep"] }); // only e2 in it
  await ops.applyRenterGames(r, HOST, ["Rust"]);
  assert.deepEqual(readConfig("contabo", "config_06.json").FavouriteGames, ["Keep"], "root list untouched");
  assert.deepEqual(readConfig("contabo", "config_04.json").FavouriteGames, ["Rust"], "own bot: whole config");
});

// ---------------------------------------------------------------------------
// Review 4 (round 3 at cc6edb3)
// ---------------------------------------------------------------------------
test("REGRESSION: a Start whose own bot is empty STARTS the stopped file that holds only their accounts (else 'running' over nothing)", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", []);
  putConfig("contabo", "config_06.json", []); // their own Stop emptied it and stopped it
  world.ps.contabo.twitchbotx6 = { state: "exited" };
  const out = await ops.startRenterFarming(r, HOST);
  assert.equal(out.added, 1);
  assert.equal(out.running, true);
  assert.equal(world.ps.contabo.twitchbotx6.state, "running", "started, not left stopped");
});

test("a SHARED stopped bot is left stopped — and the start says their accounts there are not farming", async () => {
  await reset();
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(holder, "buyer", { configFile: "config_06.json" });
  await mkAccount(r, "e1", { configFile: "config_06.json" });
  putConfig("contabo", "config_04.json", []);
  putConfig("contabo", "config_06.json", [user("buyer")]);
  world.ps.contabo.twitchbotx6 = { state: "exited" }; // someone else stopped it
  const out = await ops.startRenterFarming(r, HOST);
  assert.equal(out.running, false);
  assert.equal(world.ps.contabo.twitchbotx6.state, "exited", "not ours to start");
  assert.ok(out.skipped.some((x) => /config_06\.json is stopped and also holds others/.test(x.reason)), JSON.stringify(out.skipped));
});

test("REGRESSION: a start first reloads the bot a failed stop left the account LOADED in — and refuses if it cannot (no double farming)", async () => {
  await reset();
  const r = await mkRenter("wasd", { botFile: "config_15.json" });
  await mkAccount(r, "wasdacct", { configFile: "config_15.json" });
  putConfig("contabo", "config_15.json", [user("other")]);
  putConfig("contabo", "config_03.json", [user("buyer1")]); // pulled from here; its reload failed
  world.ps.contabo.twitchbotx3 = { state: "running" };
  world.ps.contabo.twitchbotx15 = { state: "running" };
  await Renter.updateOne({ _id: r._id }, { $set: { stopOwedFiles: ["contabo/config_03.json"] } });
  await PendingReload.create({ host: "contabo", file: "config_03.json", since: new Date(), reason: "accounts removed", markedAt: new Date() });
  const realRestart = fakeCfg.restartConfigContainer;
  fakeCfg.restartConfigContainer = async (h, f) => {
    if (f === "config_03.json") throw new Error("docker: timeout");
    return realRestart(h, f);
  };
  try {
    await assert.rejects(ops.startRenterFarming(r, HOST), (e) => e.code === "reload_pending");
  } finally {
    fakeCfg.restartConfigContainer = realRestart;
  }
  assert.deepEqual(secretsIn("contabo", "config_15.json"), ["other"], "not placed while config_03 may still run it");
  // The reload can happen now: done first, then the account goes back.
  world.ops = [];
  const out = await ops.startRenterFarming(await Renter.findById(r._id), HOST);
  assert.equal(out.added, 1);
  const i03 = world.ops.findIndex((o) => o[0] === "restart" && o[2] === "twitchbotx3");
  const iw = world.ops.findIndex((o) => o[0] === "write" && o[2] === "config_15.json");
  assert.ok(i03 > -1 && iw > -1 && i03 < iw, "config_03 reloaded BEFORE the account was written back: " + JSON.stringify(world.ops));
  assert.equal((await Renter.findById(r._id).lean()).stopOwedFiles, undefined);
});

test("REGRESSION: a stop against an OFFLINE host still says so (unreachable → 502), not a plain failure", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  const realReaddir = fakeHosts.readdir;
  fakeHosts.readdir = async () => {
    throw Object.assign(new Error("ssh: connect to host contabo port 22: timed out"), { unreachable: true });
  };
  try {
    await assert.rejects(ops.stopRenterFarming(r, HOST), (e) => e.unreachable === true);
  } finally {
    fakeHosts.readdir = realReaddir;
  }
});

test("REGRESSION: a reload that began before another operation marked the file does not wipe that mark", async () => {
  await reset();
  const began = new Date(Date.now() - 5000);
  await PendingReload.create({ host: "contabo", file: "config_03.json", since: new Date(), reason: "accounts removed", markedAt: new Date() });
  await ops.clearReloadOwed(HOST, "config_03.json", { before: began });
  assert.equal(await PendingReload.countDocuments({}), 1, "a later mark survives");
  await ops.clearReloadOwed(HOST, "config_03.json", { before: new Date(Date.now() + 1000) });
  assert.equal(await PendingReload.countDocuments({}), 0);
});

test("REGRESSION: a start that fails on a LATER file has already cleared the stop stamp (the lease sweep still sees the renter)", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json", botStoppedAt: new Date(), botStopReason: "operator" });
  await mkAccount(r, "a1", { configFile: "config_04.json" });
  await mkAccount(r, "b1", { configFile: "config_07.json" });
  putConfig("contabo", "config_04.json", []);
  putConfig("contabo", "config_07.json", [user("x")]);
  const realWrite = fakeHosts.writeFileAtomic;
  fakeHosts.writeFileAtomic = async (h, f, text) => {
    if (f === "config_07.json") throw new Error("disk full");
    return realWrite(h, f, text);
  };
  try {
    await assert.rejects(ops.startRenterFarming(r, HOST), /disk full/);
  } finally {
    fakeHosts.writeFileAtomic = realWrite;
  }
  assert.deepEqual(secretsIn("contabo", "config_04.json"), ["a1"]);
  assert.equal((await Renter.findById(r._id).lean()).botStoppedAt, null);
});

test("REGRESSION: placement reads the host STRICTLY — an unreadable operator config refuses the start (the account could be in it)", async () => {
  await reset();
  const r = await mkRenter("escapefrom", { botFile: "config_04.json" });
  await mkAccount(r, "e1", { configFile: "config_04.json" });
  putConfig("contabo", "config_04.json", []);
  world.fs.contabo["config_40.json"] = "{ corrupt";
  await assert.rejects(ops.startRenterFarming(r, HOST), /Could not read contabo\/config_40\.json/);
  assert.deepEqual(secretsIn("contabo", "config_04.json"), [], "nothing placed on a guess");
});

test("REGRESSION: a lease-end stop whose own host is UNKNOWN still pulls accounts on known hosts, then fails (retried, paged)", async () => {
  await reset();
  const r = await mkRenter("ghost2", { botFile: "config_09.json", botHost: "phone" });
  await mkAccount(r, "g0", { configFile: "config_03.json", host: "contabo" });
  const holder = await mkRenter("operator-selffarm", { botFile: "config_54.json" });
  await mkAccount(holder, "buyer1", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("buyer1"), user("g0")]);
  world.ps.contabo.twitchbotx3 = { state: "running" };
  await assert.rejects(ops.stopRenterFarming(r, null), /own bot host 'phone' is unknown/);
  assert.deepEqual(secretsIn("contabo", "config_03.json"), ["buyer1"], "the known host was pulled");
});

// ---------------------------------------------------------------------------
// Review 2026-10-01 (seventh pass)
// ---------------------------------------------------------------------------
test("REGRESSION: a STOPPED renter with no accounts can be started — the stop is cleared, nothing is started", async () => {
  await reset();
  const r = await mkRenter("emptyone", { botFile: "config_09.json", botStoppedAt: new Date(), botStopReason: "operator" });
  putConfig("contabo", "config_09.json", []);
  const out = await ops.startRenterFarming(r, HOST);
  assert.equal(out.nothingToPlace, true);
  assert.equal(out.added, 0);
  const fresh = await Renter.findById(r._id).lean();
  assert.equal(fresh.botStoppedAt, null, "farming is no longer stopped — accounts can be added again");
  assert.deepEqual(docker(), [], "no empty bot was started");
});

test("REGRESSION: the owed-reload sweeper settles a 'restart-policy' row whose container no longer exists", async () => {
  await reset();
  putConfig("contabo", "config_31.json", []);
  await PendingReload.create({ host: "contabo", file: "config_31.json", since: new Date(Date.now() - 3600000), reason: "restart-policy", markedAt: new Date(Date.now() - 3600000) });
  const realPolicy = fakeHosts.setRestartPolicy;
  fakeHosts.setRestartPolicy = async () => { throw new Error("Error response from daemon: No such container: twitchbotx31"); };
  try {
    const out = await ops.sweepPendingReloads({ minAgeMs: 0, notify: true });
    assert.equal(out.settled, 1, JSON.stringify(out));
  } finally {
    fakeHosts.setRestartPolicy = realPolicy;
  }
  assert.equal(await PendingReload.countDocuments({}), 0);
  assert.equal(world.telegram.length, 0, "no page every 6 h forever");
});

test("REGRESSION: a reload owed on a host this server no longer knows does not block the renter forever", async () => {
  await reset();
  const r = await mkRenter("movedaway", { botFile: "config_09.json", stopOwedFiles: ["phone/config_14.json"] });
  putConfig("contabo", "config_09.json", [user("tok-ma")]);
  await mkAccount(r, "tok-ma", { configFile: "config_09.json" });
  world.ps.contabo.twitchbotx9 = { state: "running" };
  await ops.startRenterFarming(r, HOST); // no reload_pending refusal
  const fresh = await Renter.findById(r._id).lean();
  assert.deepEqual(fresh.stopOwedFiles || [], [], "the entry is dropped");
  assert.equal(world.telegram.filter((m) => /no longer knows/.test(m)).length, 1, "said once");
  // A later stop does not fail over it either.
  const s = await ops.stopRenterFarming(await Renter.findById(r._id), HOST);
  assert.ok(s.removed >= 1);
});

test("REGRESSION: an unparseable file NO bot reads (a backup) never blocks a placement", async () => {
  await reset();
  const r = await mkRenter("placer", { botFile: "config_09.json" });
  putConfig("contabo", "config_09.json", [user("someone-else")]);
  world.fs.contabo["config_03-backup.json"] = "{ not json";
  await mkAccount(r, "tok-pl", { configFile: "config_09.json" });
  world.ps.contabo.twitchbotx9 = { state: "running" };
  // The real rule (routes/botConfigRoutes FILE_RE): a backup name is no bot's config.
  const realValid = fakeCfg.validFile;
  fakeCfg.validFile = (f) => typeof f === "string" && /^config(_\d{1,3})?\.json$/.test(f);
  let out;
  try {
    out = await ops.startRenterFarming(r, HOST);
  } finally {
    fakeCfg.validFile = realValid;
  }
  assert.equal(out.added, 1, JSON.stringify(out));
  assert.ok(secretsIn("contabo", "config_09.json").includes("tok-pl"));
});

test("REGRESSION (review 8): Start on a stopped renter whose live accounts sit on ANOTHER host keeps the stop and says so", async () => {
  await reset();
  const r = await mkRenter("splitone", { botFile: "config_09.json", botStoppedAt: new Date(), botStopReason: "operator" });
  putConfig("contabo", "config_09.json", []);
  await mkAccount(r, "tok-elsewhere", { host: "local", configFile: "config_02.json" });
  await assert.rejects(ops.startRenterFarming(r, HOST), (e) => e.code === "no_accounts");
  const fresh = await Renter.findById(r._id).lean();
  assert.ok(fresh.botStoppedAt, "the stop stays — their accounts were not put back");
});
