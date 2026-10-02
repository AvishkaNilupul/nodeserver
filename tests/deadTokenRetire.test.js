// utils/deadTokenRetire.js — retiring SOLD accounts whose Twitch token died
// from the bot configs they still occupy (2026-10-01).
//
// Six of the seven "unhealthy" Contabo accounts that day had been sold; the
// buyer securing an account kills our token for good, so the config entry only
// made its bot retry a dead login. These tests pin the narrow rules: dead for
// real (old transition + a later scan), sold for real (never a marketplace tag
// alone, never "connected"), and hands off renters, resellers, renter stacks,
// the no-claim fleet and unsold accounts — plus "restart only a RUNNING bot".
//
// The pure decision is tested directly; the pass runs against
// mongodb-memory-server with the hosts, config writes, audit log and Telegram
// faked, so nothing outside the test is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const retire = require("../utils/deadTokenRetire");
// The pass restarts through the real farmControl.restartIfRunning; only the
// host shell under it (botHosts.runShell / restoreRestartPolicy) is faked.
const hostsMod = require("../utils/botHosts");
const farmControl = require("../utils/farmControl");
const realHostFns = { runShell: hostsMod.runShell, restoreRestartPolicy: hostsMod.restoreRestartPolicy };
test.after(() => Object.assign(hostsMod, realHostFns));

const H = 3600000;
const NOW = Date.parse("2026-10-01T08:00:00Z");

test("decide: only a re-confirmed, old enough, sold dead token is retired", () => {
  const base = { lastScanStatus: "token_invalid", configFile: "config_44.json", container: "twitchbotx44", lastScanAt: new Date(NOW - 2 * H) };
  const old = { at: NOW - 72 * H, action: "token_invalid" };
  const d = (o) => retire.decide({ now: NOW, minDeadMs: 48 * H, lastEvent: old, sold: ["manual ×9"], ...o, acc: { ...base, ...(o && o.acc) } });

  assert.equal(d({}).verdict, "retire");
  assert.equal(d({ sold: [] }).verdict, "surface", "unsold dead accounts are left for re-auth");
  assert.equal(d({ acc: { lastScanStatus: "error" } }).verdict, "skip", "error is the scanner's transient verdict");
  assert.equal(d({ acc: { lastScanStatus: "ok" } }).verdict, "skip");
  assert.equal(d({ acc: { configFile: "" } }).verdict, "skip");
  assert.equal(d({ acc: { container: "noclaim-bot-10" } }).verdict, "skip");
  assert.equal(d({ acc: { resellerId: "r1" } }).verdict, "skip");
  assert.equal(d({ rented: true }).verdict, "skip");
  assert.equal(d({ renterStack: true }).verdict, "skip");
  assert.equal(d({ lastEvent: { at: NOW - 72 * H, action: "recovered" } }).verdict, "skip", "an inconsistent trail waits");
  assert.equal(d({ lastEvent: { at: NOW - 10 * H, action: "token_invalid" } }).verdict, "skip", "not dead long enough");
  assert.equal(
    d({ acc: { lastScanAt: new Date(NOW - 72 * H + 10 * 60000) } }).verdict,
    "skip",
    "the only scan is the one that saw it die — wait for a later one",
  );
  // No transition inside the 90-day audit window: it died before the window.
  assert.equal(d({ lastEvent: null }).verdict, "retire");
  assert.equal(d({ lastEvent: null, acc: { lastScanAt: null } }).verdict, "skip", "never scanned");
});

test("clampHours keeps the wait between a day and a month", () => {
  assert.equal(retire.clampHours(undefined), retire.DEFAULT_HOURS);
  assert.equal(retire.clampHours(1), 24);
  assert.equal(retire.clampHours(99999), 720);
  assert.equal(retire.clampHours(72), 72);
});

test("ships OFF and only runs from a live tick", () => {
  const settingsSrc = fs.readFileSync(path.join(__dirname, "..", "utils", "settings.js"), "utf8");
  assert.match(settingsSrc, /retireSoldDeadTokens: false,/);
  const farmerSrc = fs.readFileSync(path.join(__dirname, "..", "utils", "autoFarmer.js"), "utf8");
  assert.match(farmerSrc, /if \(!af\.dryRun && af\.retireSoldDeadTokens === true\) \{\s*try \{\s*await deadTokenRetire\.retireSoldDeadTokens\(/);
});

/* ------------------------------ the full pass ----------------------------- */

let mongod;
let models;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  models = {
    BotAccount: require("../models/BotAccount"),
    DropLog: require("../models/DropLog"),
    MarketplaceListing: require("../models/MarketplaceListing"),
    SystemEvent: require("../models/SystemEvent"),
    RenterBotStack: require("../models/RenterBotStack"),
    RenterAccount: require("../models/RenterAccount"),
    AutoFarmTask: require("../models/AutoFarmTask"),
  };
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const oid = () => new mongoose.Types.ObjectId();

async function seed() {
  for (const m of Object.values(models)) await m.collection.deleteMany({});
  require("../utils/rentedAccounts").__resetCache();
  const acc = {};
  const mk = async (login, o = {}) => {
    const _id = oid();
    acc[login] = _id;
    await models.BotAccount.collection.insertOne({
      _id,
      login,
      clientSecret: "secret-" + login,
      host: "contabo",
      configFile: "config_44.json",
      container: "twitchbotx44",
      enabled: true,
      lastScanStatus: "token_invalid",
      lastScanAt: new Date(NOW - 2 * H),
      ...o,
    });
    if (o.noEvent !== true) {
      await models.SystemEvent.collection.insertOne({
        at: new Date(NOW - (o.deadHours || 72) * H),
        category: "accounts",
        action: o.lastAction || "token_invalid",
        subjectId: _id,
        subject: login,
      });
    }
    return _id;
  };
  await mk("handsold");
  await mk("gfsold");
  await mk("eldelivered", { configFile: "config_42.json", container: "twitchbotx42" });
  await mk("listedonly");
  await mk("connectedonly");
  await mk("rentedout");
  await mk("freshdead", { deadHours: 2 });
  await mk("recovered", { lastAction: "recovered" });
  await mk("noclaim", { container: "noclaim-bot-10" });
  await mk("stacked", { configFile: "config_02.json", container: "twitchbotx2" });
  await mk("tasked", { noEvent: true });
  await mk("healthy", { lastScanStatus: "ok" });

  await models.DropLog.collection.insertMany([
    { account: acc.handsold, benefitId: "b1", itemKey: "k1", game: "Rust", soldAt: new Date(NOW - 30 * 24 * H), soldToUsername: "manual" },
    { account: acc.listedonly, benefitId: "b2", itemKey: "k2", game: "Rust", soldAt: new Date(NOW - 5 * 24 * H), soldToUsername: "gameflip" },
    { account: acc.connectedonly, benefitId: "b3", itemKey: "k3", game: "Halo", soldAt: null, connected: true },
    { account: acc.tasked, benefitId: "b4", itemKey: "k4", game: "Rust", soldAt: new Date(NOW - 9 * 24 * H), soldToUsername: "shopbuyer" },
    { account: acc.stacked, benefitId: "b5", itemKey: "k5", game: "Rust", soldAt: new Date(NOW - 9 * 24 * H), soldToUsername: "manual" },
    { account: acc.rentedout, benefitId: "b6", itemKey: "k6", game: "Rust", soldAt: new Date(NOW - 9 * 24 * H), soldToUsername: "manual" },
    { account: acc.noclaim, benefitId: "b7", itemKey: "k7", game: "Overwatch", soldAt: new Date(NOW - 9 * 24 * H), soldToUsername: "manual" },
  ]);
  await models.MarketplaceListing.collection.insertMany([
    { marketplace: "gameflip", externalId: "gf-1", status: "sold", accountId: String(acc.gfsold), price: 1.5, units: [] },
    // listed, not sold: a live offer naming the account proves nothing
    { marketplace: "gameflip", externalId: "gf-2", status: "active", accountId: String(acc.listedonly), price: 1.5, units: [] },
    {
      marketplace: "eldorado",
      externalId: "el-1",
      status: "active",
      price: 1,
      units: [
        { accountId: String(acc.eldelivered), login: "eldelivered", deliveredAt: new Date(NOW - 8 * 24 * H), orderId: "o-1" },
        { accountId: String(oid()), login: "other", deliveredAt: null, orderId: "" },
      ],
    },
  ]);
  await models.RenterAccount.collection.insertOne({ login: "rentedout", clientSecret: "renter-copy-secret" });
  await models.RenterBotStack.collection.insertOne({ host: "contabo", file: "config_02.json", capacity: 50, enabled: true });
  await models.AutoFarmTask.collection.insertOne({ game: "Rust", campaignId: "c1", status: "active", assignedAccounts: ["tasked", "someoneelse"] });
  return acc;
}

// One docker state behind every path a pass could take — `docker ps` +
// restartConfigContainer (the two-call version, before 2026-10-03) and the
// one-command check-and-restart (farmControl.restartIfRunning over
// botHosts.runShell). x44 runs; x42 is parked. `parkAfterFirstTrip` lands the
// auto-farm tick's park on that container right after the first docker round
// trip — between a `docker ps` and a separate restart. `emptied` = configs the
// retirement leaves with no accounts; `shellError` fails the check.
function fakes({ parkAfterFirstTrip = null, emptied = [], shellError = null } = {}) {
  const calls = { removed: [], restarted: [], events: [], telegrams: [], policy: [], restartedStopped: 0 };
  const docker = { twitchbotx44: "running", twitchbotx42: "exited" };
  const containerOf = (file) => "twitchbotx" + Number(String(file).replace(/\D/g, ""));
  const fileOf = (c) => "config_" + String(c).replace(/\D/g, "") + ".json";
  let trips = 0;
  const trip = () => {
    trips++;
    if (trips === 1 && parkAfterFirstTrip && docker[parkAfterFirstTrip] === "running") {
      docker[parkAfterFirstTrip] = "exited";
    }
  };
  hostsMod.runShell = async (_h, script) => {
    if (shellError) {
      trip();
      throw shellError;
    }
    const c = /docker restart '([^']+)'/.exec(script)[1];
    let stdout = "STATE " + (docker[c] || "missing") + "\n";
    if (docker[c] === "running") {
      calls.restarted.push("contabo/" + fileOf(c));
      stdout = "RESTARTED\n";
    }
    trip();
    return { stdout, stderr: "" };
  };
  hostsMod.restoreRestartPolicy = async (_h, c) => {
    calls.policy.push(c);
  };
  const deps = {
    ...models,
    hosts: {
      resolveHost: (id) => ({ id, transport: "ssh" }),
      dockerPs: async () => {
        const snap = {};
        for (const [c, s] of Object.entries(docker)) snap[c] = { state: s, status: s === "running" ? "Up 2 hours" : "Exited (143)" };
        trip();
        return snap;
      },
      stopIfNoAccounts: async (_h, file, c) => {
        let stopped = false;
        if (emptied.includes(file) && docker[c] === "running") {
          docker[c] = "exited";
          stopped = true;
        }
        trip();
        return { stopped };
      },
    },
    restartIfRunning: farmControl.restartIfRunning,
    rentedAccounts: require("../utils/rentedAccounts"),
    logEvent: async (e) => calls.events.push(e),
    sendTelegram: async (m) => calls.telegrams.push(m),
    configOps: () => ({
      removeAccountFromConfig: async (host, file, who) => {
        calls.removed.push(host.id + "/" + file + "/" + who.login);
        return 1;
      },
      // `docker restart` (+ policy restore) — STARTS a stopped container.
      restartConfigContainer: async (host, file) => {
        const c = containerOf(file);
        if (docker[c] !== "running") calls.restartedStopped++;
        docker[c] = "running";
        calls.restarted.push(host.id + "/" + file);
        trip();
        return { restarted: true };
      },
    }),
  };
  return { deps, calls, docker };
}

test("plan sorts every account into retire / surface / skip, read-only", async () => {
  await seed();
  const { deps, calls } = fakes();
  const p = await retire.plan({ hours: 48, now: NOW, deps });
  const names = (list) => list.map((e) => e.login).sort();
  assert.deepEqual(names(p.retire), ["eldelivered", "gfsold", "handsold", "tasked"]);
  assert.deepEqual(names(p.surface), ["connectedonly", "listedonly"], "a marketplace tag or a 'connected' drop is not a sale");
  assert.deepEqual(names(p.skipped), ["freshdead", "noclaim", "recovered", "rentedout", "stacked"]);
  assert.equal(calls.removed.length + calls.restarted.length + calls.events.length, 0);
  const why = Object.fromEntries(p.skipped.map((e) => [e.login, e.reason]));
  assert.match(why.rentedout, /rented/);
  assert.match(why.stacked, /renter stack/);
  assert.match(why.noclaim, /no-claim/);
});

test("dry run writes nothing", async () => {
  const acc = await seed();
  const { deps, calls } = fakes();
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, dryRun: true, deps });
  assert.equal(r.retire.length, 4);
  assert.equal(r.retired.length, 0);
  assert.equal(calls.removed.length, 0);
  const row = await models.BotAccount.findById(acc.handsold).lean();
  assert.equal(row.configFile, "config_44.json");
});

test("the pass retires sold dead accounts, restarts only running bots, releases tasks", async () => {
  const acc = await seed();
  const { deps, calls } = fakes();
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });

  assert.deepEqual(calls.removed.sort(), [
    "contabo/config_42.json/eldelivered",
    "contabo/config_44.json/gfsold",
    "contabo/config_44.json/handsold",
    "contabo/config_44.json/tasked",
  ]);
  assert.deepEqual(calls.restarted, ["contabo/config_44.json"], "x42 is parked (exited) and must stay parked; x44 restarts once");
  assert.equal(r.configs, 2);
  for (const login of ["handsold", "gfsold", "eldelivered", "tasked"]) {
    const row = await models.BotAccount.findById(acc[login]).lean();
    assert.equal(row.configFile, "", login);
    assert.equal(row.container, "", login);
    assert.equal(row.enabled, false, login);
    assert.equal(row.lastScanStatus, "token_invalid", "the row and its verdict are kept");
  }
  for (const login of ["listedonly", "connectedonly", "rentedout", "freshdead", "recovered", "noclaim", "stacked", "healthy"]) {
    const row = await models.BotAccount.findById(acc[login]).lean();
    assert.notEqual(row.configFile, "", login + " must be untouched");
  }
  const task = await models.AutoFarmTask.findOne({ campaignId: "c1" }).lean();
  assert.deepEqual(task.assignedAccounts, ["someoneelse"]);
  assert.equal(await models.DropLog.countDocuments({}), 7, "drops are kept");
  assert.equal(calls.events.length, 4);
  assert.ok(calls.events.every((e) => e.category === "accounts" && e.action === "retired_dead_token"));
  assert.equal(calls.telegrams.length, 1);
  assert.match(calls.telegrams[0], /4 sold account/);
});

test("a token that recovered after the plan is left alone", async () => {
  const acc = await seed();
  const { deps, calls } = fakes();
  const ops = deps.configOps();
  deps.configOps = () => ({
    ...ops,
    removeAccountFromConfig: async (host, file, who) => {
      if (who.login === "handsold") throw new Error("should not be called");
      return ops.removeAccountFromConfig(host, file, who);
    },
  });
  // Between plan and act the scanner sees handsold's token work again.
  const M = models.BotAccount;
  deps.BotAccount = {
    find: (...a) => M.find(...a),
    updateOne: (...a) => M.updateOne(...a),
    findById: (id, proj) => {
      if (String(id) === String(acc.handsold)) {
        return { lean: async () => ({ ...(await M.findById(id, proj).lean()), lastScanStatus: "ok" }) };
      }
      return M.findById(id, proj);
    },
  };
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
  assert.equal(r.retired.some((e) => e.login === "handsold"), false);
  assert.equal(calls.removed.some((c) => c.endsWith("/handsold")), false);
  const row = await models.BotAccount.findById(acc.handsold).lean();
  assert.equal(row.configFile, "config_44.json");
});

/* -------------- the restart: one command, never over a park -------------- */
// 2026-10-03: the pass read `docker ps`, then restarted the running bots in a
// second call; a park landing between the two was undone, because `docker
// restart` STARTS a stopped container. It now goes through
// farmControl.restartIfRunning (check and restart in one shell command, under
// the container's lock).

test("a park landing between the check and the restart is never undone", async () => {
  await seed();
  const { deps, calls, docker } = fakes({ parkAfterFirstTrip: "twitchbotx44" });
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
  assert.equal(r.retired.length, 4);
  assert.equal(calls.restartedStopped, 0, "a just-parked (stopped) bot was restarted");
  assert.equal(docker.twitchbotx44, "exited", "the park holds");
  assert.deepEqual(r.restarted, []);
});

test("report.restarted lists only containers really restarted; their policy is restored", async () => {
  await seed();
  const { deps, calls } = fakes();
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
  assert.deepEqual(r.restarted, ["twitchbotx44"], "x42 is parked, so it is not in the list");
  assert.deepEqual(calls.policy, ["twitchbotx44"]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stopped, []);
});

test("a failed check is a report error, never a restart", async () => {
  await seed();
  const { deps, calls } = fakes({ shellError: new Error("ssh: connect timed out") });
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
  assert.equal(r.retired.length, 4, "the retirement itself still lands");
  assert.equal(r.configs, 2);
  assert.deepEqual(r.restarted, []);
  assert.deepEqual(calls.policy, []);
  assert.ok(r.errors.includes("contabo/config_44.json restart: ssh: connect timed out"), r.errors.join(" | "));
});

test("a config the retirement empties is stopped, never restarted", async () => {
  // A bot with no accounts spins in a login-retry loop (botHosts.stopIfNoAccounts).
  await seed();
  const { deps, calls, docker } = fakes({ emptied: ["config_44.json"] });
  const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
  assert.deepEqual(r.stopped, ["twitchbotx44"]);
  assert.deepEqual(r.restarted, []);
  assert.deepEqual(calls.restarted, []);
  assert.equal(docker.twitchbotx44, "exited");
});

test("TWITCHBOT_ALLOW_RESTART=0 still turns the restart off", async () => {
  const saved = process.env.TWITCHBOT_ALLOW_RESTART;
  process.env.TWITCHBOT_ALLOW_RESTART = "0";
  try {
    await seed();
    const { deps, calls } = fakes();
    const r = await retire.retireSoldDeadTokens({ hours: 48, now: NOW, deps });
    assert.equal(r.retired.length, 4);
    assert.equal(r.configs, 2);
    assert.deepEqual(r.restarted, []);
    assert.deepEqual(calls.restarted, []);
  } finally {
    if (saved === undefined) delete process.env.TWITCHBOT_ALLOW_RESTART;
    else process.env.TWITCHBOT_ALLOW_RESTART = saved;
  }
});
