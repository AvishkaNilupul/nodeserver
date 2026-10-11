// Two writers of one bot config at the same moment: nothing either wrote is
// lost, and no account is left in two bots or in none.
//
// On 2026-10-09 01:11Z the lane engine started the Alien: Isolation and SPAM
// probes in the same second. SPAM's write of config_24 was overwritten by the
// single-home heal that followed Alien's write of config_53, and 13 of SPAM's
// 15 accounts sat switched off for 2.5 hours while the task counted them as
// deployed. Nothing in the engine could have noticed.
//
// These tests run the REAL utils/botHosts (a farm host that is a temp
// directory), utils/dupeGuard, utils/fileLock, utils/botFactory and
// utils/botConsolidator against an in-memory Mongo. The only things stubbed are
// the edges that would touch docker, and the no-claim check inside
// writeFileAtomic — replaced by a pause, because that check (an SSH read of the
// no-claim tree, seconds long in production) is what holds the gap between a
// writer's read and its write open. Without the pause every race here would
// need the luck it had in production.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");
const botConsolidator = require("../utils/botConsolidator");
const fleetIntegrity = require("../utils/fleetIntegrity");
const guard = require("../utils/dupeGuard");
const { withFileLock } = require("../utils/fileLock");

let mem;
let tmpDir;
const HOST = { id: "racehost", label: "Race host", transport: "local", runtime: "docker", dir: "" };
const orig = {
  resolveHost: hosts.resolveHost,
  guardManagedWrite: fleetIntegrity.guardManagedWrite,
  dockerContainer: hosts.dockerContainer,
  composeUp: hosts.composeUp,
  stopContainer: botFactory.stopContainer,
};
// ms the "no-claim check" takes before a write of `file` lands.
let pauseFor = () => 0;
let docker;
let onStop = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + " did not finish in " + ms + "ms")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("configrace"));
  // Indexes built now, so no test's timing hangs on the first write to Mongo.
  await Promise.all(
    ["BotAccount", "AvailableAccount", "PendingReload", "AutoFarmTask", "SystemEvent"].map((m) =>
      require("../models/" + m).init(),
    ),
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-race-"));
  HOST.dir = tmpDir;
  hosts.resolveHost = (id) => (String(id) === HOST.id ? HOST : orig.resolveHost(id));
  fleetIntegrity.guardManagedWrite = async (host, file, text) => {
    const ms = pauseFor(file);
    if (ms) await sleep(ms);
    return text;
  };
  hosts.dockerContainer = async (host, action, container) => {
    docker.push(action + " " + container);
  };
  hosts.composeUp = async (host, container) => {
    docker.push("up " + container);
  };
  botFactory.stopContainer = async (host, container) => {
    docker.push("stop " + container);
    if (onStop) await onStop(container);
  };
});

test.beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
  guard._resetForTests();
  pauseFor = () => 0;
  docker = [];
  onStop = null;
});

test.after(async () => {
  hosts.resolveHost = orig.resolveHost;
  fleetIntegrity.guardManagedWrite = orig.guardManagedWrite;
  hosts.dockerContainer = orig.dockerContainer;
  hosts.composeUp = orig.composeUp;
  botFactory.stopContainer = orig.stopContainer;
  await mongoose.disconnect();
  if (mem) await mem.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* -------------------------------- fixtures -------------------------------- */

const user = (login, games, enabled = true) => ({
  ClientSecret: "secret-" + login,
  UniqueId: "uid-" + login,
  Login: login,
  Id: "id-" + login,
  Enabled: enabled,
  FavouriteGames: games,
});
// What the pool hands a placement (models/AvailableAccount shape).
const pool = (login) => ({ username: login, clientSecret: "secret-" + login, uniqueId: "uid-" + login, twitchId: "id-" + login });
const names = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + (i + 1));

function writeConfig(file, users, extra = {}) {
  fs.writeFileSync(path.join(tmpDir, file), JSON.stringify({ ...extra, TwitchSettings: { TwitchUsers: users } }, null, 2));
}
const readConfig = (file) => JSON.parse(fs.readFileSync(path.join(tmpDir, file), "utf8")).TwitchSettings.TwitchUsers;
const configs = () => fs.readdirSync(tmpDir).filter((f) => /^config(_\d+)?\.json$/.test(f)).sort();
// login -> [files it is switched on in]
function homes() {
  const map = new Map();
  for (const f of configs()) {
    for (const u of readConfig(f)) {
      if (u.Enabled === false) continue;
      map.set(u.Login, (map.get(u.Login) || []).concat(f));
    }
  }
  return map;
}
function assertFarming(logins, file, game, why) {
  const where = homes();
  const users = new Map(readConfig(file).map((u) => [u.Login, u]));
  for (const l of logins) {
    assert.deepEqual(where.get(l) || [], [file], why + ": " + l + " is switched on in " + file + " and nowhere else");
    assert.ok((users.get(l).FavouriteGames || []).includes(game), why + ": " + l + " farms " + game);
  }
}
function assertOneHomeEach() {
  for (const [login, files] of homes()) assert.equal(files.length, 1, login + " is switched on in " + files.join(" and "));
}

/* ------------------------- 1. one config, two writers ---------------------- */

test("two farms placed into ONE config at the same moment both land", async () => {
  writeConfig("config_24.json", [user("old1", ["Other"])]);
  pauseFor = () => 25;
  await within(
    Promise.all([
      botFactory.addAccountsToBot(HOST, "config_24.json", names("a", 3).map(pool), "Game A"),
      botFactory.addAccountsToBot(HOST, "config_24.json", names("b", 3).map(pool), "Game B"),
    ]),
    3000,
    "the two placements",
  );
  assertFarming(names("a", 3), "config_24.json", "Game A", "first placement");
  assertFarming(names("b", 3), "config_24.json", "Game B", "second placement");
  assertFarming(["old1"], "config_24.json", "Other", "the account already there");
});

test("a placement and another writer's locked edit of the same config both land", async () => {
  // The other writer is any of the flows that already took the file lock — a
  // sale switching an account off, a renter change, a re-arm.
  writeConfig("config_24.json", [user("sold1", ["Other"]), user("old1", ["Other"])]);
  pauseFor = () => 25;
  const sale = withFileLock(HOST, "config_24.json", async () => {
    const prev = await hosts.readFile(HOST, "config_24.json");
    const data = JSON.parse(prev);
    data.TwitchSettings.TwitchUsers.find((u) => u.Login === "sold1").Enabled = false;
    await hosts.writeFileAtomic(HOST, "config_24.json", JSON.stringify(data, null, 2), { prev });
  });
  const placed = botFactory.addAccountsToBot(HOST, "config_24.json", names("a", 3).map(pool), "Game A");
  await within(Promise.all([sale, placed]), 3000, "the sale and the placement");
  assertFarming(names("a", 3), "config_24.json", "Game A", "the placement");
  assert.equal(readConfig("config_24.json").find((u) => u.Login === "sold1").Enabled, false, "the sold account stays switched off");
});

test("an account already switched on in two configs, both written at once by unrelated farms, stays in one", async () => {
  // No claim covers the duplicate (it predates this process). Each write owns
  // it by the old rule, and each heal stripped the other's copy.
  writeConfig("config_20.json", [user("dup", ["Old"]), user("p", ["Other"])]);
  writeConfig("config_21.json", [user("dup", ["Old"]), user("q", ["Other"])]);
  for (const pause of [() => 0, (f) => (f === "config_20.json" ? 20 : 0), (f) => (f === "config_21.json" ? 20 : 0)]) {
    writeConfig("config_20.json", [user("dup", ["Old"]), user("p", ["Other"])]);
    writeConfig("config_21.json", [user("dup", ["Old"]), user("q", ["Other"])]);
    guard._resetForTests();
    pauseFor = pause;
    await within(
      Promise.all([
        botFactory.addAccountsToBot(HOST, "config_20.json", [pool("n20")], "Game A"),
        botFactory.addAccountsToBot(HOST, "config_21.json", [pool("n21")], "Game B"),
      ]),
      3000,
      "the two placements",
    );
    assert.equal((homes().get("dup") || []).length, 1, "dup is switched on in exactly one config");
    assertFarming(["n20"], "config_20.json", "Game A", "first farm");
    assertFarming(["n21"], "config_21.json", "Game B", "second farm");
  }
});

test("a writer with no lock of its own cannot write an account back while it is being moved away", async () => {
  // The raw config save and the purge routes read a config, hold it a while,
  // and write it back without the file's lock. The look at what the file held
  // and the write itself are one locked step inside writeFileAtomic, so the
  // heal that strips a moved account from this file runs before the two or
  // after them — never in between, where the account was written back as
  // one "that was already here" and nothing removed it again.
  writeConfig("config_24.json", [user("x", ["Old"]), user("keep", ["Other"])]);
  writeConfig("config_53.json", [user("t53", ["Other"])]);
  const stale = fs.readFileSync(path.join(tmpDir, "config_24.json"), "utf8"); // read now, written later
  // The stale write's own file write is the slow part: the move and its heal
  // arrive while it is under way.
  const fsp = require("node:fs/promises");
  const realWrite = fsp.writeFile;
  let slowed = 0;
  fsp.writeFile = async (file, ...rest) => {
    if (String(file).includes("config_24.json.tmp-") && !slowed++) await sleep(40);
    return realWrite(file, ...rest);
  };
  try {
    const save = hosts.writeFileAtomic(HOST, "config_24.json", stale);
    await sleep(10);
    const move = botFactory.addAccountsToBot(HOST, "config_53.json", [pool("x")], "New Game");
    await within(Promise.all([save, move]), 5000, "the save and the move");
  } finally {
    fsp.writeFile = realWrite;
  }
  assert.equal(slowed > 0, true, "the save really was mid-write when the move came");
  assertFarming(["x"], "config_53.json", "New Game", "the moved account");
  assertFarming(["keep"], "config_24.json", "Other", "the rest of the saved config");
  assertOneHomeEach();
});

/* --------------------------- 2. the incident itself ------------------------ */

// config_24 holds twelve accounts that are about to MOVE (still switched on
// there from an ended probe), eight retired entries of accounts SPAM is about
// to reuse, and co-tenants. config_53 holds retired entries of the rest.
function incidentFixture() {
  const movers = names("m", 12);
  const alienOnly = names("al", 3);
  const spamIn24 = names("s", 8); // retired entries in config_24 -> merged there
  const spamFresh = names("sf", 5); // retired entries only in config_53 -> added to config_24
  const spamIn53 = names("st", 2); // retired entries in config_53 -> merged there
  const tenants = names("c", 3);
  writeConfig("config_24.json", [
    ...movers.map((l) => user(l, ["Old Probe"])),
    ...spamIn24.map((l) => user(l, [], false)),
    ...tenants.map((l) => user(l, ["Tenant Game"])),
  ]);
  writeConfig("config_53.json", [
    ...movers.slice(0, 5).map((l) => user(l, [], false)),
    ...alienOnly.map((l) => user(l, [], false)),
    ...spamFresh.map((l) => user(l, [], false)),
    ...spamIn53.map((l) => user(l, [], false)),
    user("t53", ["Tenant Game"]),
  ]);
  return { movers, alienOnly, spamIn24, spamFresh, spamIn53, tenants };
}

async function placeBoth(f) {
  const alien = botFactory.addAccountsToBot(HOST, "config_53.json", [...f.movers, ...f.alienOnly].map(pool), "Alien: Isolation");
  const spam = (async () => {
    const first = await botFactory.addAccountsToBot(HOST, "config_24.json", [...f.spamIn24, ...f.spamFresh].map(pool), "SPAM");
    const second = await botFactory.addAccountsToBot(HOST, "config_53.json", f.spamIn53.map(pool), "SPAM");
    return [first, second];
  })();
  return within(Promise.all([alien, spam]), 5000, "the two probes' placements");
}

function assertBothProbesFarm(f) {
  assertFarming([...f.spamIn24, ...f.spamFresh], "config_24.json", "SPAM", "SPAM");
  assertFarming(f.spamIn53, "config_53.json", "SPAM", "SPAM");
  assertFarming([...f.movers, ...f.alienOnly], "config_53.json", "Alien: Isolation", "Alien: Isolation");
  assertFarming(f.tenants, "config_24.json", "Tenant Game", "co-tenant");
  assertFarming(["t53"], "config_53.json", "Tenant Game", "co-tenant");
  assertOneHomeEach();
}

for (const [label, pause] of [
  // What happened: config_24's write is the slow one, so the heal that follows
  // the write of config_53 reads config_24 before SPAM's write and writes after.
  ["config_24 slow to write (2026-10-09)", (f) => (f === "config_24.json" ? 40 : 5)],
  // The mirror: SPAM's write lands first and its heal meets Alien's move.
  ["config_53 slow to write", (f) => (f === "config_53.json" ? 40 : 5)],
  ["both the same", () => 15],
  ["no pause at all", () => 0],
]) {
  test("REGRESSION 2026-10-09: two probes placed in the same second both end up farming — " + label, async () => {
    const f = incidentFixture();
    pauseFor = pause;
    const [alien, [spam24, spam53]] = await placeBoth(f);
    assert.equal(alien.added + alien.merged, 15);
    assert.deepEqual([spam24.added, spam24.merged], [5, 8], "what the engine logged that night: added 5, merged 8");
    assert.deepEqual([spam53.added, spam53.merged], [0, 2]);
    assertBothProbesFarm(f);
  });
}

/* ------------------------ 3. many writers, any order ----------------------- */

// A small fixed-seed generator: the same interleavings on every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("any mix of farms placed at once — moving accounts between configs — leaves every one farming where it was placed", async () => {
  const rand = rng(20261009);
  const files = ["config_24.json", "config_42.json", "config_44.json", "config_53.json"];
  const everyone = names("p", 48);
  // Where each account is expected to farm, and which game it must list.
  const expected = new Map();
  for (const f of files) writeConfig(f, []);
  everyone.forEach((l, i) => {
    const f = files[i % files.length];
    const cur = readConfig(f);
    cur.push(user(l, ["Start"]));
    writeConfig(f, cur);
    expected.set(l, { file: f, game: "Start" });
  });
  pauseFor = () => Math.floor(rand() * 12);
  for (let round = 0; round < 30; round++) {
    // Three farms per round, each taking its own accounts (the pool never
    // hands one account to two farms) into a config of its choice — often the
    // one another farm of the round is moving accounts OUT of.
    const shuffled = everyone.slice().sort(() => rand() - 0.5);
    const jobs = [];
    for (let j = 0; j < 3; j++) {
      const mine = shuffled.slice(j * 5, j * 5 + 2 + Math.floor(rand() * 4));
      const file = files[Math.floor(rand() * files.length)];
      const game = "Round " + round + " farm " + j;
      for (const l of mine) expected.set(l, { file, game });
      jobs.push(async () => {
        await sleep(Math.floor(rand() * 4));
        await botFactory.addAccountsToBot(HOST, file, mine.map(pool), game);
      });
    }
    await within(Promise.all(jobs.map((run) => run())), 5000, "round " + round);
    const where = homes();
    for (const [login, want] of expected) {
      assert.deepEqual(where.get(login) || [], [want.file], "round " + round + ": " + login + " is switched on in " + want.file + " only");
      const u = readConfig(want.file).find((x) => x.Login === login);
      assert.ok(u.FavouriteGames.includes(want.game), "round " + round + ": " + login + " farms " + want.game);
    }
  }
});

/* ------------------------------ 4. new bots -------------------------------- */

const COMPOSE = "services:\n  twitchbot:\n    image: twitchbot-farm:latest\n    container_name: twitchbot\n";

test("two bots created at the same moment get two slots, two configs and two compose services", async () => {
  writeConfig("config.json", [user("tpl", ["Template"], false)]);
  writeConfig("config_07.json", [user("x7", ["Other"])]);
  fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), COMPOSE);
  pauseFor = () => 20;
  const [one, two] = await within(
    Promise.all([
      botFactory.createBot(HOST, names("a", 3).map(pool), "Game A"),
      botFactory.createBot(HOST, names("b", 3).map(pool), "Game B"),
    ]),
    5000,
    "the two bots",
  );
  assert.notEqual(one.file, two.file, "each got its own slot");
  assert.deepEqual([one.file, two.file].sort(), ["config_08.json", "config_09.json"]);
  assertFarming(names("a", 3), one.file, "Game A", "first bot");
  assertFarming(names("b", 3), two.file, "Game B", "second bot");
  const compose = fs.readFileSync(path.join(tmpDir, "docker-compose.yml"), "utf8");
  assert.match(compose, /container_name: twitchbotx8\b/);
  assert.match(compose, /container_name: twitchbotx9\b/);
  assert.match(compose, /container_name: twitchbot\b/, "and the service that was there stays");
  assert.deepEqual(docker.filter((d) => d.startsWith("up ")).sort(), ["up twitchbotx8", "up twitchbotx9"]);
});

test("a bot created while another is deleted: neither compose edit is lost", async () => {
  writeConfig("config.json", [user("tpl", ["Template"], false)]);
  writeConfig("config_07.json", [user("x7", ["Other"])]);
  fs.writeFileSync(
    path.join(tmpDir, "docker-compose.yml"),
    COMPOSE + "  twitchbotx7:\n    image: twitchbot-farm:latest\n    container_name: twitchbotx7\n",
  );
  // Whichever edit reaches its compose write first holds it back until the
  // other has READ the file too — or for 300 ms when the other never comes,
  // which is what the provision lock makes of it.
  const real = { read: hosts.composeRead, write: hosts.composeWrite };
  let reads = 0;
  let sawSecondRead;
  const secondRead = new Promise((r) => { sawSecondRead = r; });
  let firstWrite = true;
  hosts.composeRead = async (...args) => {
    const text = await real.read(...args);
    if (++reads === 2) sawSecondRead();
    return text;
  };
  hosts.composeWrite = async (...args) => {
    if (firstWrite) {
      firstWrite = false;
      await Promise.race([secondRead, sleep(300)]);
    }
    return real.write(...args);
  };
  try {
    await within(
      Promise.all([
        botFactory.createBot(HOST, names("a", 2).map(pool), "Game A"),
        botFactory.deleteBot(HOST, "config_07.json", "twitchbotx7"),
      ]),
      5000,
      "the create and the delete",
    );
  } finally {
    hosts.composeRead = real.read;
    hosts.composeWrite = real.write;
  }
  const compose = fs.readFileSync(path.join(tmpDir, "docker-compose.yml"), "utf8");
  assert.match(compose, /container_name: twitchbotx8\b/, "the new bot's service is there");
  assert.doesNotMatch(compose, /container_name: twitchbotx7\b/, "the deleted bot's service is gone");
  assert.deepEqual(configs(), ["config.json", "config_08.json"]);
});

test("a config deleted while an edit of it is mid-cycle is not written back into existence", async () => {
  writeConfig("config_70.json", [user("x1", ["Game"])]);
  pauseFor = () => 30;
  const edit = botFactory.addAccountsToBot(HOST, "config_70.json", [pool("late")], "Game");
  await sleep(5); // the edit has read the file and is waiting to write it
  await within(Promise.all([edit, botFactory.deleteBot(HOST, "config_70.json", "twitchbotx70")]), 5000, "the edit and the delete");
  assert.deepEqual(configs(), [], "no config_70.json came back");
  assert.equal(fs.readdirSync(tmpDir).filter((f) => f.startsWith("config_70.json.done-")).length, 1, "it was renamed away once, whole");
});

/* ------------------------------ 5. the repack ------------------------------ */

async function repackFixture() {
  // twitchbotx81 is the fuller container and stays; twitchbotx82 is drained
  // into it and retired.
  writeConfig("config_81.json", names("t", 3).map((l) => user(l, ["Target Game"])));
  writeConfig("config_82.json", [user("d1", ["Donor Game"]), user("d2", ["Donor Game"]), user("d3", ["Donor Game"])]);
  await AutoFarmTask.deleteMany({});
  await AutoFarmTask.create({
    game: "Target Game",
    campaignId: "repack-1",
    decision: "farm",
    status: "active",
    assignedAccounts: [...names("t", 3), "d1", "d2", "d3"],
    bots: [
      { host: HOST.id, file: "config_81.json", container: "twitchbotx81" },
      { host: HOST.id, file: "config_82.json", container: "twitchbotx82" },
    ],
  });
}

test("the repack writes each target from what it holds NOW: a farm placed there since the plan stays", async () => {
  await repackFixture();
  // While the donor is being stopped (seconds, in production) another writer
  // puts an account into the target.
  onStop = async () => {
    await botFactory.addAccountsToBot(HOST, "config_81.json", [pool("late")], "Late Game");
  };
  const r = await within(botConsolidator.consolidate(HOST.id, { capacity: 10 }), 5000, "the repack");
  assert.equal(r.movedAccounts, 3);
  assertFarming(["late"], "config_81.json", "Late Game", "the account placed mid-repack");
  assertFarming(names("t", 3), "config_81.json", "Target Game", "the target's own");
  assertFarming(["d1", "d2", "d3"], "config_81.json", "Donor Game", "the moved accounts");
  assert.deepEqual(configs(), ["config_81.json"], "the donor is retired");
});

test("the repack waits for a placement that is mid-write on its target — neither write is lost", async () => {
  await repackFixture();
  pauseFor = (f) => (f === "config_81.json" ? 40 : 0);
  let placing;
  onStop = async () => {
    // Not awaited: the placement has read the target and is still waiting to
    // write it when the repack gets there.
    placing = botFactory.addAccountsToBot(HOST, "config_81.json", [pool("late")], "Late Game");
    await sleep(5);
  };
  await within(botConsolidator.consolidate(HOST.id, { capacity: 10 }), 5000, "the repack");
  await within(placing, 5000, "the placement");
  assertFarming(["late"], "config_81.json", "Late Game", "the account placed mid-repack");
  assertFarming(["d1", "d2", "d3"], "config_81.json", "Donor Game", "the moved accounts");
  assertFarming(names("t", 3), "config_81.json", "Target Game", "the target's own");
});

test("the repack keeps an account live when it also has a retired entry in another container of the same repack", async () => {
  // x farms in twitchbotx82 and has an old, switched-off entry in twitchbotx83.
  // Both are drained into twitchbotx81. Looked up by token alone, the entry
  // moved was whichever container was read last — the retired one — and x was
  // switched on nowhere once both donors were renamed away.
  for (const order of [["82", "83"], ["83", "82"]]) {
    for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
    guard._resetForTests();
    writeConfig("config_81.json", names("t", 4).map((l) => user(l, ["Target Game"])));
    writeConfig("config_82.json", [user("x", ["Live Game"]), user("d2", ["Donor Game"])]);
    writeConfig("config_83.json", [user("x", [], false), user("d3", ["Donor Game"])]);
    await AutoFarmTask.deleteMany({});
    await AutoFarmTask.create({
      game: "Target Game",
      campaignId: "repack-2",
      decision: "farm",
      status: "active",
      assignedAccounts: [...names("t", 4), "x", "d2", "d3"],
      bots: ["81", ...order].map((n) => ({ host: HOST.id, file: "config_" + n + ".json", container: "twitchbotx" + n })),
    });
    await within(botConsolidator.consolidate(HOST.id, { capacity: 10 }), 5000, "the repack");
    assert.deepEqual(configs(), ["config_81.json"], "both donors are retired (" + order.join(", ") + ")");
    assertFarming(["x"], "config_81.json", "Live Game", "gathered " + order.join(" then "));
    assert.equal(readConfig("config_81.json").filter((u) => u.Login === "x").length, 1, "one entry of it");
    assertFarming(["d2", "d3"], "config_81.json", "Donor Game", "the others");
  }
});

test("the repack lets a live account replace its own retired entry in the target", async () => {
  // The target holds an old switched-off entry of d1; the donor holds d1 live.
  // Dropped as a duplicate, d1 was switched on nowhere after the donor went.
  // An entry that is switched ON in the target is still the one that stays.
  await repackFixture();
  writeConfig("config_81.json", [
    ...names("t", 3).map((l) => user(l, ["Target Game"])),
    user("d1", [], false),
    user("d2", ["Already Here"]),
  ]);
  await within(botConsolidator.consolidate(HOST.id, { capacity: 10 }), 5000, "the repack");
  const target = readConfig("config_81.json");
  assertFarming(["d1"], "config_81.json", "Donor Game", "the account with a retired entry in the target");
  assert.equal(target.filter((u) => u.Login === "d1").length, 1, "one entry of it, the live one");
  assert.deepEqual(target.find((u) => u.Login === "d2").FavouriteGames, ["Already Here"], "a live entry already in the target stays as it is");
  assert.equal(target.filter((u) => u.Login === "d2").length, 1);
  assertFarming(["d3"], "config_81.json", "Donor Game", "the plain move");
});

test("the repack moves each account as its donor holds it NOW: one switched off since the plan moves switched off, one that left is not moved", async () => {
  await repackFixture();
  onStop = async () => {
    // d1 is sold and switched off; d2 is taken out of the donor altogether.
    await withFileLock(HOST, "config_82.json", async () => {
      const prev = await hosts.readFile(HOST, "config_82.json");
      const data = JSON.parse(prev);
      data.TwitchSettings.TwitchUsers = data.TwitchSettings.TwitchUsers.filter((u) => u.Login !== "d2");
      data.TwitchSettings.TwitchUsers.find((u) => u.Login === "d1").Enabled = false;
      await hosts.writeFileAtomic(HOST, "config_82.json", JSON.stringify(data, null, 2), { prev });
    });
  };
  const r = await within(botConsolidator.consolidate(HOST.id, { capacity: 10 }), 5000, "the repack");
  const target = new Map(readConfig("config_81.json").map((u) => [u.Login, u]));
  assert.equal(target.get("d1").Enabled, false, "the sold account was NOT switched back on by the move");
  assert.equal(target.has("d2"), false, "the account that had left the donor was not brought back");
  assert.equal(target.get("d3").Enabled, true);
  assert.equal(r.movedAccounts, 2);
});
