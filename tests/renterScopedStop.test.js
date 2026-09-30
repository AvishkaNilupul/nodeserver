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
  readdir: async (h) => Object.keys(world.fs[h.id]),
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
        f in world.fs[h.id]
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

test("an unreadable config fails the stop instead of letting a secret survive in it", async () => {
  await reset();
  const r = await mkRenter("jhonkwiall", { botFile: "config_03.json" });
  await mkAccount(r, "jhonacct", { configFile: "config_03.json" });
  putConfig("contabo", "config_03.json", [user("jhonacct")]);
  world.fs.contabo["config_07.json"] = "{ not json";

  await assert.rejects(ops.stopRenterFarming(r, HOST), /Unparseable config contabo\/config_07\.json/);
});

test("ledger rows on an UNKNOWN host fail the stop (it cannot be verified)", async () => {
  await reset();
  const r = await mkRenter("ghost", { botFile: "config_03.json" });
  await mkAccount(r, "g1", { configFile: "config_09.json", host: "phone" });
  putConfig("contabo", "config_03.json", [user("other")]);
  await assert.rejects(ops.stopRenterFarming(r, HOST), /unknown bot host\(s\) phone/);
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
