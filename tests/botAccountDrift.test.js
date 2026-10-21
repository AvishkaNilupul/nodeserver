// BotAccount.enabled must follow the bot configs (utils/botAccountMirror).
//
// On prod 2026-10-21, 823 rows on the four shared auto bots said enabled while
// their config said off: completeEndedTasks and farmControl.stopFarmingGame
// switched accounts off in the config and never told BotAccount, and "Sync from
// bots" — the only thing that caught it up — recorded whichever copy of a token
// it read LAST. These pin the mirror on both config writers, the sync's choice
// of copy, and the reconcile script's prediction of what the retro-reaper will
// release once stale flags are corrected.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

delete process.env.TG_TOKEN; // no Telegram from the engine under test

const { mirrorDisabled, chooseHome } = require("../utils/botAccountMirror");
const { syncPlacement } = require("../routes/dropArchiveRoutes");
const autoFarmer = require("../utils/autoFarmer");
const farmControl = require("../utils/farmControl");
const hosts = require("../utils/botHosts");
const { summarizeRelease } = require("../scripts/reconcile-host-ledger");
const BotAccount = require("../models/BotAccount");
const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");

// --- mirrorDisabled ---------------------------------------------------------

function fakeModel(modifiedCount = 0) {
  const calls = [];
  return {
    calls,
    async updateMany(filter, update) {
      calls.push({ filter, update });
      return { modifiedCount };
    },
  };
}

test("mirrorDisabled switches off only rows that still point at that config", async () => {
  const M = fakeModel(2);
  const n = await mirrorDisabled("contabo", "config_42.json", [" s1 ", "s2", "s1", ""], { BotAccount: M });
  assert.equal(n, 2);
  assert.equal(M.calls.length, 1);
  assert.deepEqual(M.calls[0].filter, {
    host: "contabo",
    configFile: "config_42.json",
    clientSecret: { $in: ["s1", "s2"] },
    enabled: true,
  });
  assert.deepEqual(M.calls[0].update, { $set: { enabled: false } });
});

test("mirrorDisabled writes nothing without a host, a file or a token", async () => {
  const M = fakeModel(5);
  assert.equal(await mirrorDisabled("contabo", "config_42.json", [], { BotAccount: M }), 0);
  assert.equal(await mirrorDisabled("", "config_42.json", ["s1"], { BotAccount: M }), 0);
  assert.equal(await mirrorDisabled("contabo", "", ["s1"], { BotAccount: M }), 0);
  assert.equal(M.calls.length, 0);
});

// --- chooseHome / syncPlacement --------------------------------------------

const hit = (file, enabled, extra = {}) => ({ host: "contabo", file, enabled, renter: false, ...extra });

test("an enabled copy wins whatever order the configs were read in", () => {
  const live = hit("config_24.json", true);
  const residue = hit("config_44.json", false);
  assert.equal(chooseHome([live, residue]).home, live);
  assert.equal(chooseHome([residue, live]).home, live);
});

test("two enabled copies are a conflict, never a guess", () => {
  const r = chooseHome([hit("config_24.json", true), hit("config_42.json", true)]);
  assert.equal(r.conflict, true);
  assert.equal(r.hits.length, 2);
});

test("with no enabled copy an operator config decides over a renter stack", () => {
  const renter = hit("config_02.json", false, { renter: true });
  const op = hit("config_42.json", false);
  assert.equal(chooseHome([renter, op]).home, op);
  assert.equal(chooseHome([]).home, undefined);
});

test("sync: the retired copy read last no longer overwrites the live one (the bug)", () => {
  // config_24 sorts before config_44, so the old file-by-file upsert recorded
  // the DISABLED config_44 copy and the account looked retired while farming.
  const r = syncPlacement([hit("config_24.json", true), hit("config_44.json", false)], "twitchbotx44");
  assert.equal(r.write.file, "config_24.json");
  assert.equal(r.write.enabled, true);
});

test("sync: a renter stack is never written as an operator placement — it is cleared", () => {
  const r = syncPlacement([hit("config_02.json", true, { renter: true }), hit("config_42.json", false)], "twitchbotx42");
  assert.deepEqual(r, { clear: true });
});

test("sync: a disabled copy never overwrites a no-claim placement", () => {
  const held = [hit("config_42.json", false)];
  assert.deepEqual(syncPlacement(held, "noclaim-bot-47"), { skip: "noclaim" });
  // ...but it still records a retirement over an ordinary auto bot.
  assert.equal(syncPlacement(held, "twitchbotx42").write.enabled, false);
});

test("sync: two enabled copies are left alone", () => {
  assert.deepEqual(
    syncPlacement([hit("config_24.json", true), hit("config_42.json", true)], ""),
    { skip: "conflict" },
  );
});

// --- retroRecycleLogins ----------------------------------------------------

test("the retro-reaper keeps unrecyclable, active and enabled logins (any case)", () => {
  const back = autoFarmer.retroRecycleLogins(["Alice", "bob", "Carol", "dave"], {
    unrecyclable: new Set(["alice"]),
    activeAssigned: new Set(["bob"]),
    enabled: new Set(["carol"]),
  });
  assert.deepEqual(back, ["dave"]);
});

test("correcting a stale enabled flag is what lets the reaper release it", () => {
  const sets = { unrecyclable: new Set(), activeAssigned: new Set() };
  assert.deepEqual(autoFarmer.retroRecycleLogins(["eve"], { ...sets, enabled: new Set(["eve"]) }), []);
  assert.deepEqual(autoFarmer.retroRecycleLogins(["eve"], { ...sets, enabled: new Set() }), ["eve"]);
});

// --- summarizeRelease (reconcile-host-ledger's prediction) -----------------

test("prediction: only newly released rows count, and only ready+sellable is at risk", () => {
  const id = (n) => new mongoose.Types.ObjectId(n.padStart(24, "0"));
  const row = (n, login, extra = {}) => ({ _id: id(n), usernameLower: login, claimedNote: "auto-farm: X", ...extra });
  const r = summarizeRelease({
    releasedNow: [row("1", "already")],
    releasedAfter: [
      row("1", "already"),
      row("2", "plain"),
      row("3", "stock", {}),
      row("4", "held", { unclaimedDropCount: 3 }),
      row("5", "gone"),
    ],
    readyIds: [id("2"), id("3"), id("1")],
    holdings: [
      { loginLower: "stock", sellableCount: 4, inConfig: true },
      { loginLower: "held", sellableCount: 3, inConfig: true },
      { loginLower: "gone", sellableCount: 9, inConfig: false },
    ],
  });
  assert.equal(r.releasedNow, 1);
  assert.equal(r.releasedAfter, 5);
  assert.deepEqual(r.released.map((x) => x.login), ["plain", "stock", "held", "gone"]);
  // "held" has unclaimed drops: readyPoolQuery refuses it, the pool check holds it.
  assert.deepEqual(r.atRisk.map((x) => x.login), ["stock"]);
  assert.equal(r.released.find((x) => x.login === "held").unclaimed, true);
  assert.equal(r.released.find((x) => x.login === "gone").sellable, false);
});

// --- the two config writers, against a real database -----------------------

let mem;
const files = new Map(); // "host/file" -> text, the fake bot host
const saved = {};

function cfgText(users) {
  return JSON.stringify({ FavouriteGames: ["Warframe"], TwitchSettings: { TwitchUsers: users } }, null, 2);
}
const user = (login, games, extra = {}) => ({
  Login: login,
  ClientSecret: "s-" + login,
  Enabled: true,
  FavouriteGames: games,
  ...extra,
});

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("botaccountdrift"));
  for (const k of ["resolveHost", "readFile", "writeFileAtomic", "saveSnapshot", "dockerContainer"]) saved[k] = hosts[k];
  saved.restartIfRunning = farmControl.restartIfRunning;
  hosts.resolveHost = (id) => ({ id: String(id || "local"), transport: "ssh", dir: "/fake" });
  hosts.readFile = async (h, f) => {
    const t = files.get(h.id + "/" + f);
    if (t == null) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    return t;
  };
  hosts.writeFileAtomic = async (h, f, text) => {
    files.set(h.id + "/" + f, text);
  };
  hosts.saveSnapshot = async () => {};
  hosts.dockerContainer = async () => ({});
  farmControl.restartIfRunning = async () => ({ restarted: false, state: "exited" });
});

test.after(async () => {
  Object.assign(hosts, {
    resolveHost: saved.resolveHost,
    readFile: saved.readFile,
    writeFileAtomic: saved.writeFileAtomic,
    saveSnapshot: saved.saveSnapshot,
    dockerContainer: saved.dockerContainer,
  });
  farmControl.restartIfRunning = saved.restartIfRunning;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function reset() {
  files.clear();
  await Promise.all([BotAccount.deleteMany({}), AutoFarmTask.deleteMany({}), TwitchCampaign.deleteMany({})]);
}

test("completeEndedTasks mirrors the accounts it switches off in a shared bot", async () => {
  await reset();
  const bot = { host: "contabo", file: "config_42.json", container: "twitchbotx42" };
  files.set(
    "contabo/config_42.json",
    cfgText([
      user("alice", ["Brawlhalla"]), // only the ended game: switched off
      user("bob", ["Brawlhalla"]), // switched off here, but deployed elsewhere since
      user("dave", ["Brawlhalla", "Marvel Rivals"]), // keeps a co-tenant game: stays on
    ]),
  );
  await TwitchCampaign.create([
    { campaignId: "c-ended", game: "Brawlhalla", status: "EXPIRED", endAt: new Date(Date.now() - 3600e3) },
    { campaignId: "c-live", game: "Marvel Rivals", status: "ACTIVE", endAt: new Date(Date.now() + 86400e3) },
  ]);
  await AutoFarmTask.create([
    { game: "Brawlhalla", campaignId: "c-ended", decision: "farm", status: "active", bots: [bot], assignedAccounts: ["alice", "bob", "dave"] },
    { game: "Marvel Rivals", campaignId: "c-live", decision: "farm", status: "active", bots: [bot], assignedAccounts: ["dave"] },
  ]);
  await BotAccount.create([
    { clientSecret: "s-alice", login: "alice", host: "contabo", configFile: "config_42.json", container: "twitchbotx42", enabled: true },
    { clientSecret: "s-bob", login: "bob", host: "contabo", configFile: "config_24.json", container: "twitchbotx24", enabled: true },
    { clientSecret: "s-dave", login: "dave", host: "contabo", configFile: "config_42.json", container: "twitchbotx42", enabled: true },
  ]);

  const completed = await autoFarmer.completeEndedTasks();
  assert.equal(completed, 1);

  const cfg = JSON.parse(files.get("contabo/config_42.json")).TwitchSettings.TwitchUsers;
  const by = (l) => cfg.find((u) => u.Login === l);
  assert.equal(by("alice").Enabled, false);
  assert.equal(by("bob").Enabled, false);
  assert.equal(by("dave").Enabled, true);

  const rows = new Map((await BotAccount.find({}).lean()).map((r) => [r.login, r]));
  assert.equal(rows.get("alice").enabled, false, "the config says off, so must the mirror");
  assert.equal(rows.get("bob").enabled, true, "a row naming another config is that config's to decide");
  assert.equal(rows.get("dave").enabled, true, "still farming a co-tenant game");
});

test("stopFarmingGame mirrors a sold account it switches off", async () => {
  await reset();
  farmControl._resetForTests();
  files.set("contabo/config_42.json", cfgText([user("xavier", ["Brawlhalla"]), user("yuri", ["Brawlhalla", "REMATCH"])]));
  const [x, y] = await BotAccount.create([
    { clientSecret: "s-xavier", login: "xavier", host: "contabo", configFile: "config_42.json", container: "", enabled: true },
    { clientSecret: "s-yuri", login: "yuri", host: "contabo", configFile: "config_42.json", container: "", enabled: true },
  ]);
  const rx = await farmControl.stopFarmingGame(x.toObject(), "Brawlhalla");
  const ry = await farmControl.stopFarmingGame(y.toObject(), "Brawlhalla");
  assert.equal(rx.changed, true);
  assert.equal(ry.changed, true);
  assert.equal((await BotAccount.findById(x._id).lean()).enabled, false);
  assert.equal((await BotAccount.findById(y._id).lean()).enabled, true, "REMATCH left: still farming");
});

test("Sync from bots records the live copy, clears renter-held rows, spares no-claim rows", async () => {
  await reset();
  const RenterBotStack = require("../models/RenterBotStack");
  const { runSync } = require("../routes/dropArchiveRoutes");
  await RenterBotStack.deleteMany({});
  await RenterBotStack.create({ host: "contabo", file: "config_02.json", capacity: 50 });
  // config_24 < config_44 in the walk, so the OLD sync recorded the config_44
  // copies (read last) for "live" and "nc".
  files.set("contabo/config_24.json", cfgText([user("live", ["Brawlhalla"])]));
  files.set(
    "contabo/config_44.json",
    cfgText([user("live", [], { Enabled: false }), user("nc", [], { Enabled: false }), user("gone", ["REMATCH"])]),
  );
  files.set("contabo/config_02.json", cfgText([user("rented", ["Fortnite"])]));
  files.set("contabo/config_42.json", cfgText([user("rented", [], { Enabled: false })]));
  await BotAccount.create([
    { clientSecret: "s-live", login: "live", host: "contabo", configFile: "config_44.json", container: "twitchbotx44", enabled: true },
    { clientSecret: "s-nc", login: "nc", host: "contabo", configFile: "", container: "noclaim-bot-47", enabled: true },
    { clientSecret: "s-rented", login: "rented", host: "contabo", configFile: "config_42.json", container: "twitchbotx42", enabled: true },
  ]);
  const saveList = hosts.listHosts;
  const saveReaddir = hosts.readdir;
  hosts.listHosts = () => [{ id: "contabo", label: "Contabo", transport: "ssh", dir: "/fake" }];
  hosts.readdir = async () => ["config_02.json", "config_24.json", "config_42.json", "config_44.json", "config_44.json.bak"];
  let r;
  try {
    r = await runSync();
  } finally {
    hosts.listHosts = saveList;
    hosts.readdir = saveReaddir;
  }
  const rows = new Map((await BotAccount.find({}).lean()).map((x) => [x.login, x]));
  assert.equal(rows.get("live").configFile, "config_24.json");
  assert.equal(rows.get("live").enabled, true);
  assert.equal(rows.get("nc").container, "noclaim-bot-47", "a disabled operator copy says nothing about the no-claim bot");
  assert.equal(rows.get("nc").enabled, true);
  assert.equal(rows.get("rented").configFile, "", "renting needs the operator placement empty");
  assert.equal(rows.get("rented").enabled, false);
  assert.equal(rows.get("gone").configFile, "config_44.json", "a new account is still recorded");
  assert.equal(rows.get("gone").enabled, true);
  assert.deepEqual(r.leftAlone, { conflict: 0, noclaim: 1 });
  assert.equal(r.renterCleared, 1);
  assert.equal(r.filesRead, 4);
});

test("reconcile read-back: a row with no soldAt field is not a mismatch", () => {
  const { readBackMismatch } = require("../scripts/reconcile-host-ledger");
  const to = { host: "local", configFile: "", container: "", enabled: false };
  const row = { host: "local", configFile: "", container: "", enabled: false };
  assert.equal(readBackMismatch({ ...row }, to), false, "soldAt absent");
  assert.equal(readBackMismatch({ ...row, soldAt: null }, to), false, "soldAt null");
  assert.equal(readBackMismatch({ ...row, soldAt: new Date() }, to), true, "sold since — report it");
  assert.equal(readBackMismatch({ ...row, enabled: true }, to), true);
  assert.equal(readBackMismatch({ ...row, container: "twitchbotx9" }, to), true);
  // a retire write names no host: any host reads back fine
  assert.equal(readBackMismatch({ ...row, host: "pi" }, { configFile: "", container: "", enabled: false }), false);
});
