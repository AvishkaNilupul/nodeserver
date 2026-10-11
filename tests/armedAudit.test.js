// utils/armedAudit (2026-10-11): accounts an active farm counts as deployed
// that no bot is farming — the check that would have said, within the hour,
// that 13 of the SPAM probe's 15 accounts were switched off on 2026-10-09.
//
// The REAL audit, re-arm planner (utils/reuseRearm) and host layer, against an
// in-memory Mongo and a farm host that is a temp directory. Stubbed: the one
// shell command that reads the no-claim tree (there is no no-claim host here),
// the rollback snapshot the re-arm saves on the app server's own disk, and the
// bot reload.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const RenterAccount = require("../models/RenterAccount");
const hosts = require("../utils/botHosts");
const farmControl = require("../utils/farmControl");
const noclaimFleet = require("../utils/noclaimFleet");
const settings = require("../utils/settings");
const armedAudit = require("../utils/armedAudit");
const systemHealth = require("../utils/systemHealth");

let mem;
let tmpDir;
const HOST = { id: "audithost", label: "Audit host", transport: "local", runtime: "docker", dir: "" };
const orig = {
  resolveHost: hosts.resolveHost,
  sh: noclaimFleet.sh,
  saveSnapshot: hosts.saveSnapshot,
  restartIfRunning: farmControl.restartIfRunning,
  getAutoFarm: settings.getAutoFarm,
};
let noclaim;
let noclaimDown;
let running;
let reloaded;
let snapshots;

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("armedaudit"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "armed-audit-"));
  HOST.dir = tmpDir;
  hosts.resolveHost = (id) => (String(id) === HOST.id ? HOST : orig.resolveHost(id));
  hosts.saveSnapshot = async (hostId, file, text) => {
    snapshots.push(hostId + "/" + file + ": " + JSON.parse(text).TwitchSettings.TwitchUsers.length + " entries");
  };
  // What `cat` of every no-claim bot config prints (utils/reuseRearm.noclaimSecrets).
  noclaimFleet.sh = async () => {
    if (noclaimDown) return "__CFG__\n{ not json";
    return "__CFG__\n" + JSON.stringify({ TwitchSettings: { TwitchUsers: [...noclaim].map((s) => ({ ClientSecret: s })) } });
  };
  farmControl.restartIfRunning = async (host, container) => {
    if (!running.has(container)) return { restarted: false, state: "exited" };
    reloaded.push(container);
    return { restarted: true, state: "running" };
  };
  settings.getAutoFarm = () => ({ ...orig.getAutoFarm.call(settings), reuseRearm: true });
});

test.beforeEach(async () => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
  await Promise.all([AutoFarmTask, AvailableAccount, BotAccount, DropLog, RenterAccount].map((m) => m.deleteMany({})));
  noclaim = new Set();
  noclaimDown = false;
  running = new Set(["twitchbotx24", "twitchbotx53"]);
  reloaded = [];
  snapshots = [];
});

test.after(async () => {
  hosts.resolveHost = orig.resolveHost;
  noclaimFleet.sh = orig.sh;
  hosts.saveSnapshot = orig.saveSnapshot;
  farmControl.restartIfRunning = orig.restartIfRunning;
  settings.getAutoFarm = orig.getAutoFarm;
  await mongoose.disconnect();
  if (mem) await mem.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* -------------------------------- fixtures -------------------------------- */

const user = (login, games, enabled = true) => ({
  ClientSecret: "secret-" + login,
  Login: login,
  Id: "id-" + login,
  Enabled: enabled,
  FavouriteGames: games,
});
const names = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + (i + 1));
function writeConfig(file, users) {
  fs.writeFileSync(path.join(tmpDir, file), JSON.stringify({ TwitchSettings: { TwitchUsers: users } }, null, 2));
}
const readConfig = (file) => JSON.parse(fs.readFileSync(path.join(tmpDir, file), "utf8")).TwitchSettings.TwitchUsers;

async function poolRows(logins, note, extra = {}) {
  for (const u of logins) {
    await AvailableAccount.create({
      username: u,
      usernameLower: u.toLowerCase(),
      password: "p",
      clientSecret: "secret-" + u,
      status: "claimed",
      claimedAt: new Date(),
      claimedNote: note,
      lastCheckStatus: "ok",
      lastCheckAt: new Date(),
      ...extra,
    });
  }
}
const bot24 = { host: HOST.id, file: "config_24.json", container: "twitchbotx24" };
const bot53 = { host: HOST.id, file: "config_53.json", container: "twitchbotx53" };
function task(game, accounts, bots, extra = {}) {
  return AutoFarmTask.create({
    game,
    campaignId: game.toLowerCase().replace(/\W+/g, "-") + "-1",
    campaignName: game + " Launch",
    campaignEndAt: hoursFromNow(64),
    decision: "probe",
    status: "active",
    assignedAccounts: accounts,
    plannedAccounts: accounts.length,
    targetAccounts: accounts.length,
    bots,
    executedAt: new Date(),
    ...extra,
  });
}

// SPAM as it stood on 2026-10-09 03:40Z: two accounts farming in config_53,
// eight left switched off in config_24 and five in config_53, the task and the
// pool rows saying fifteen deployed. Alien: Isolation beside it, whole.
async function spamAsItWas() {
  const on = names("spamOn", 2);
  const off24 = names("spamOff", 8);
  const off53 = names("spamGone", 5);
  const alien = names("alien", 15);
  writeConfig("config_24.json", [...off24.map((l) => user(l, [], false)), user("tenant1", ["Tenant Game"])]);
  writeConfig("config_53.json", [
    ...on.map((l) => user(l, ["SPAM"])),
    ...off53.map((l) => user(l, [], false)),
    ...alien.map((l) => user(l, ["Alien: Isolation"])),
  ]);
  await poolRows([...on, ...off24, ...off53], "auto-farm: SPAM (e86f8fd3)");
  await poolRows(alien, "auto-farm: Alien: Isolation (ef371a6b)");
  const spam = await task("SPAM", [...on, ...off24, ...off53], [bot24, bot53]);
  await task("Alien: Isolation", alien, [bot53]);
  return { on, off24, off53, alien, spam };
}

/* --------------------------------- audit ---------------------------------- */

test("2026-10-09 as it stood: 13 of SPAM's 15 are reported, Alien: Isolation is whole", async () => {
  const f = await spamAsItWas();
  const r = await armedAudit.audit();
  assert.equal(r.tasks, 2);
  assert.equal(r.accounts, 30);
  assert.equal(r.armed, 17);
  assert.deepEqual(r.blind, []);
  assert.equal(r.stranded.length, 1);
  const s = r.stranded[0];
  assert.equal(s.game, "SPAM");
  assert.equal(s.assigned, 15);
  assert.deepEqual(s.off.slice().sort(), [...f.off24, ...f.off53].map((l) => l.toLowerCase()).sort());
  assert.deepEqual(s.missing, []);
  assert.deepEqual(s.bots.map((b) => b.container), ["twitchbotx24", "twitchbotx53"]);
  // Reading is all it did.
  assert.equal(readConfig("config_24.json").filter((u) => u.Enabled !== false).length, 1);
});

test("an account in NONE of the farm's bots is reported as missing", async () => {
  // What became of SPAM's five fresh entries in config_24 when that write was
  // lost, had they not also had an old entry elsewhere.
  writeConfig("config_24.json", [user("a1", ["Game"]), user("tenant1", ["Tenant Game"])]);
  await poolRows(["a1", "a2", "a3"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2", "a3"], [bot24]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.stranded.map((s) => [s.game, s.off, s.missing.slice().sort()]), [["Game", [], ["a2", "a3"]]]);
});

test("an account that is switched on but without the farm's game counts as off", async () => {
  writeConfig("config_24.json", [user("a1", ["Game"]), user("a2", ["Another Game"])]);
  await poolRows(["a1", "a2"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2"], [bot24]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.stranded.map((s) => s.off), [["a2"]]);
});

test("accounts that are off ON PURPOSE are not reported — every reason the re-arm respects", async () => {
  const logins = ["ok", "sold", "soldDrop", "connected", "unclaimed", "noclaim", "renter", "dead", "poolBack", "otherClaim", "handSold", "gone"];
  writeConfig("config_24.json", [
    user("ok", ["Game"]),
    ...logins.filter((l) => !["ok", "gone"].includes(l)).map((l) => user(l, [], false)),
  ]);
  await poolRows(["ok", "sold", "soldDrop", "connected", "noclaim", "renter", "dead"], "auto-farm: Game (c1)");
  await poolRows(["unclaimed"], "auto-farm: Game (c1)", { unclaimedDropCount: 2 });
  await poolRows(["poolBack"], "recycled after Game", { status: "available", claimedAt: null });
  await poolRows(["otherClaim"], "noclaim-farm:Overwatch");
  await poolRows(["handSold"], "auto-farm: Game (c1)", { manualSold: true });
  await poolRows(["gone"], "spent — manual no-claim listing"); // in no bot, and not the farm's any more
  await BotAccount.create({ clientSecret: "secret-sold", login: "sold", soldAt: new Date(), soldToUsername: "a_buyer" });
  await BotAccount.create({ clientSecret: "secret-dead", login: "dead", lastScanStatus: "token_invalid" });
  const drop = (login, extra) =>
    DropLog.create({ account: new mongoose.Types.ObjectId(), benefitId: "benefit-" + login, login, game: "Game", name: "Skin", ...extra });
  await drop("soldDrop", { soldAt: new Date(), soldToUsername: "a_buyer" });
  await drop("connected", { connected: true });
  noclaim = new Set(["secret-noclaim"]);
  await RenterAccount.create({ login: "renter", enabled: true, renterId: new mongoose.Types.ObjectId(), clientSecret: "secret-renter" }).catch(async () => {
    // Whatever else the schema requires, the audit reads only login + enabled.
    await RenterAccount.collection.insertOne({ login: "renter", enabled: true });
  });
  await task("Game", logins, [bot24]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.stranded, [], "none of them is stranded");
  assert.equal(r.accounts, logins.length);
  assert.equal(r.armed, 1);
});

test("switched on in ANOTHER bot: farming the game there it is armed; on other games only it is reported", async () => {
  // b1 left the farm's bot and farms the game in a bot the task does not list
  // (the task is merely behind). b2 is switched on in that other bot on
  // another game only — what a heal that takes an account from the bot it had
  // just been placed in leaves behind. b3 is the same, but sold: off on purpose.
  writeConfig("config_24.json", [user("a1", ["Game"]), user("b2", [], false)]);
  writeConfig("config_53.json", [user("b1", ["Game"]), user("b2", ["Another Game"]), user("b3", ["Another Game"])]);
  await poolRows(["a1", "b1", "b2", "b3"], "auto-farm: Game (c1)");
  await BotAccount.create({ clientSecret: "secret-b3", login: "b3", soldAt: new Date(), soldToUsername: "a_buyer" });
  await task("Game", ["a1", "b1", "b2", "b3"], [bot24]);
  const r = await armedAudit.audit();
  assert.equal(r.armed, 2, "a1 in the farm's bot, b1 in the other one");
  assert.deepEqual(r.stranded.map((s) => [s.off, s.missing, s.elsewhere]), [[[], [], ["b2"]]]);
  // Nothing for the re-arm to do: switching b2 on in the farm's bot would put it in two.
  assert.deepEqual(await armedAudit.rearm(r), { rearmed: 0, tasks: [] });
});

test("switched on with no game list of its own, an account farms what its bot's config lists", async () => {
  fs.writeFileSync(
    path.join(tmpDir, "config_24.json"),
    JSON.stringify({ FavouriteGames: ["Game"], TwitchSettings: { TwitchUsers: [user("a1", []), user("a2", ["Another Game"])] } }),
  );
  await poolRows(["a1", "a2"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2"], [bot24]);
  const r = await armedAudit.audit();
  assert.equal(r.armed, 1, "a1 inherits Game");
  assert.deepEqual(r.stranded.map((s) => s.off), [["a2"]], "a2 has a list of its own, without it");
});

test("a bot the task still names whose config is gone from the host does not stop the farm being judged", async () => {
  writeConfig("config_24.json", [user("a1", ["Game"]), user("a2", [], false)]);
  await poolRows(["a1", "a2", "a3"], "auto-farm: Game (c1)");
  // twitchbotx60 was retired; its config was renamed away.
  await task("Game", ["a1", "a2", "a3"], [bot24, { host: HOST.id, file: "config_60.json", container: "twitchbotx60" }]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.blind, []);
  assert.equal(r.tasks, 1);
  assert.deepEqual(r.stranded.map((s) => [s.off, s.missing, s.bots.map((b) => b.container)]), [[["a2"], ["a3"], ["twitchbotx24"]]]);
});

test("a null where an entry was is not an account, in the farm's bot or any other", async () => {
  fs.writeFileSync(
    path.join(tmpDir, "config_24.json"),
    JSON.stringify({ TwitchSettings: { TwitchUsers: [null, user("a1", ["Game"]), null] } }),
  );
  fs.writeFileSync(path.join(tmpDir, "config_53.json"), JSON.stringify({ TwitchSettings: { TwitchUsers: [null] } }));
  await poolRows(["a1"], "auto-farm: Game (c1)");
  await task("Game", ["a1"], [bot24]);
  const r = await armedAudit.audit();
  assert.deepEqual([r.tasks, r.armed, r.stranded, r.blind], [1, 1, [], []]);
});

test("a farm whose campaign is over, and an old task of a no-claim game, are not judged", async () => {
  writeConfig("config_24.json", [user("e1", [], false), user("n1", [], false)]);
  await poolRows(["e1"], "auto-farm: Ended Game (c1)");
  await poolRows(["n1"], "auto-farm: Overwatch (c2)");
  await task("Ended Game", ["e1"], [bot24], { campaignEndAt: new Date(Date.now() - 60000) });
  const noClaimGame = (settings.getNoClaimGames ? settings.getNoClaimGames() : [])[0];
  if (noClaimGame) await task(noClaimGame, ["n1"], [bot24]);
  const r = await armedAudit.audit();
  assert.equal(r.tasks, 0);
  assert.deepEqual(r.stranded, []);
});

test("a farm with a bot that cannot be read is NOT judged, and says so", async () => {
  writeConfig("config_24.json", [user("a1", [], false)]);
  fs.writeFileSync(path.join(tmpDir, "config_53.json"), "{ not json");
  await poolRows(["a1", "a2"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2"], [bot24, bot53]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.stranded, [], "a2 may be in the config that could not be read");
  assert.equal(r.tasks, 0);
  assert.equal(r.blind.length, 1);
  assert.match(r.blind[0], /Game: audithost\/config_53\.json could not be read/);
});

test("with another config on the host unreadable, 'missing' is not claimed — 'off' still is", async () => {
  writeConfig("config_24.json", [user("a1", [], false)]);
  fs.writeFileSync(path.join(tmpDir, "config_53.json"), "{ not json"); // not one of this farm's bots
  await poolRows(["a1", "a2"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2"], [bot24]);
  const r = await armedAudit.audit();
  assert.deepEqual(r.stranded.map((s) => [s.off, s.missing]), [[["a1"], []]]);
  assert.match(r.blind[0], /accounts in none of its bots were not judged/);
});

test("when the no-claim tree cannot be read nothing is reported at all", async () => {
  await spamAsItWas();
  noclaimDown = true;
  await assert.rejects(armedAudit.audit(), /no-claim config did not parse/);
});

/* --------------------------------- rearm ---------------------------------- */

test("rearm switches the 'off' accounts back on, reloads only bots that are running, and leaves 'missing' alone", async () => {
  const f = await spamAsItWas();
  writeConfig("config_24.json", readConfig("config_24.json").filter((u) => u.Login !== "spamOff8")); // one is in no bot
  running = new Set(["twitchbotx53"]); // twitchbotx24 is parked
  const before = await armedAudit.audit();
  assert.deepEqual([before.stranded[0].off.length, before.stranded[0].missing], [12, ["spamoff8"]]);

  const said = [];
  const r = await armedAudit.rearm(before, { progress: (m) => said.push(m) });
  assert.equal(r.rearmed, 12);
  assert.deepEqual(reloaded, ["twitchbotx53"], "the parked bot is left parked; it reads its config when it next starts");
  assert.deepEqual(r.tasks, [{ game: "SPAM", rearmed: 12, skipped: {}, restarted: ["twitchbotx53"] }], "and it says which bots it reloaded");
  const users = new Map([...readConfig("config_24.json"), ...readConfig("config_53.json")].map((u) => [u.Login, u]));
  for (const l of [...f.off24.slice(0, 7), ...f.off53]) {
    assert.equal(users.get(l).Enabled, true, l);
    assert.deepEqual(users.get(l).FavouriteGames, ["SPAM"]);
  }
  assert.equal(users.has("spamOff8"), false, "the missing account was not put back by the re-arm");
  assert.equal(users.get("tenant1").Enabled, true);
  assert.deepEqual(users.get("tenant1").FavouriteGames, ["Tenant Game"], "nobody else's entry changed");
  assert.deepEqual(said, ["Re-armed 12 stranded account(s) for SPAM."]);
  assert.deepEqual(snapshots.slice().sort(), ["audithost/config_24.json: 8 entries", "audithost/config_53.json: 22 entries"], "each file was saved as it was before the change");

  const after = await armedAudit.audit();
  assert.deepEqual(after.stranded.map((s) => [s.off, s.missing]), [[[], ["spamoff8"]]]);
});

test("rearm does not touch a farm whose stranded accounts are all in no bot", async () => {
  writeConfig("config_24.json", [user("a1", ["Game"])]);
  await poolRows(["a1", "a2"], "auto-farm: Game (c1)");
  await task("Game", ["a1", "a2"], [bot24]);
  const found = await armedAudit.audit();
  assert.deepEqual(found.stranded.map((s) => [s.off, s.missing]), [[[], ["a2"]]]);
  const r = await armedAudit.rearm(found);
  assert.deepEqual(r, { rearmed: 0, tasks: [] }, "putting an account back into a bot is a placement, not a re-arm");
  assert.deepEqual(snapshots, []);
  assert.deepEqual(reloaded, []);
});

test("rearm does nothing when the engine's re-arm switch is off", async () => {
  await spamAsItWas();
  settings.getAutoFarm = () => ({ ...orig.getAutoFarm.call(settings), reuseRearm: false });
  try {
    const r = await armedAudit.rearm(await armedAudit.audit());
    assert.equal(r.rearmed, 0);
    assert.deepEqual(reloaded, []);
    assert.equal(readConfig("config_24.json").filter((u) => u.Enabled !== false).length, 1);
  } finally {
    settings.getAutoFarm = () => ({ ...orig.getAutoFarm.call(settings), reuseRearm: true });
  }
});

/* ---------------------------- the health check ---------------------------- */

async function check(audit) {
  const out = await systemHealth.runAll({ only: ["fleet.armed"], deps: { armedAudit: { audit } } });
  return out.checks.find((c) => c.id === "fleet.armed");
}
const found = (stranded, extra = {}) => async () => ({
  tasks: 2,
  accounts: 30,
  armed: 30 - stranded.reduce((n, s) => n + s.off.length + s.missing.length + s.elsewhere.length, 0),
  stranded,
  blind: [],
  ...extra,
});
const row = (game, assigned, off, missing = 0, elsewhere = 0) => ({
  taskId: "t-" + game,
  game,
  campaignName: game + " Launch",
  decision: "probe",
  assigned,
  off: names("o", off),
  missing: names("m", missing),
  elsewhere: names("e", elsewhere),
  bots: [bot24, bot53],
});

test("health board: the real audit of 2026-10-09 reads FAIL and names SPAM 13 of 15", async () => {
  await spamAsItWas();
  const c = await check(armedAudit.audit);
  assert.equal(c.status, "fail");
  assert.equal(c.measured, 13);
  assert.equal(c.summary, "13 account(s) are counted as farming but no bot farms them (SPAM 13 of 15)");
  assert.deepEqual(c.items, [
    { game: "SPAM", campaign: "SPAM Launch", stranded: "13 of 15", switchedOff: 13, inNoBot: 0, inAnotherBot: 0, bots: "twitchbotx24, twitchbotx53" },
  ]);
});

test("health board: ok, warn, fail and unknown", async () => {
  const ok = await check(found([]));
  assert.equal(ok.status, "ok");
  assert.equal(ok.measured, 0);
  assert.equal(ok.summary, "every account a farm counts is farming or is off for a known reason (2 farms, 30 accounts, 30 switched on)");

  // One or two stray accounts of a big farm: a warning.
  assert.equal((await check(found([row("Marvel Rivals", 57, 1), row("RavenQuest", 19, 1)]))).status, "warn");
  // Three in one farm, or a fifth of one: the farm is not farming what the engine thinks.
  assert.equal((await check(found([row("Big", 60, 3)]))).status, "fail");
  assert.equal((await check(found([row("Small", 5, 1)]))).status, "fail");
  assert.equal((await check(found([row("Mixed", 60, 1, 1, 1)]))).status, "fail", "off, in no bot and in another bot count together");
  assert.equal((await check(found([row("Away", 60, 0, 0, 2)]))).measured, 2);

  const blind = await check(found([], { tasks: 0, accounts: 0, blind: ["audithost: ssh timed out"] }));
  assert.equal(blind.status, "unknown");
  assert.match(blind.summary, /not judged: 1 farm\(s\) or host\(s\) could not be read/);
  // Something found is reported even when part of the fleet could not be read.
  assert.equal((await check(found([row("Big", 60, 3)], { blind: ["x"] }))).status, "fail");

  const down = await check(async () => { throw new Error("a no-claim config did not parse"); });
  assert.equal(down.status, "unknown");
  assert.match(down.summary, /Check could not run: a no-claim config did not parse/);

  const many = await check(found([row("A", 15, 13), row("B", 20, 5), row("C", 30, 4), row("D", 40, 3)]));
  assert.equal(many.summary, "25 account(s) are counted as farming but no bot farms them (A 13 of 15, B 5 of 20, C 4 of 30, +1 more)");
});
