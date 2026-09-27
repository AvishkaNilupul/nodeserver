// A recurring campaign's next wave must survive the previous wave ending.
//
// 2026-09-25/26, production: RavenQuest "September 05", SMITE 2 "Sept Wk 4" and
// Active Matter "Week II" were each reused onto the previous wave's accounts a
// few minutes BEFORE that wave's campaign ended. completeEndedTasks then took
// the game off every account of the ended task — the same accounts — and
// disabled the ones left with no game, so the new waves sat switched off from
// their first hour (18/18, 14/14 and 18/42 accounts). The rule pinned here: an
// account another ACTIVE task for the same game still farms keeps the game,
// stays enabled and is not recycled; the ended task's other accounts are
// cleaned up exactly as before.
//
// The real completeEndedTasks runs against an in-memory Mongo. Its host touches
// (read/write the bot config, restart the container) are stubbed on the shared
// botHosts module, which autoFarmer reads at call time.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const AvailableAccount = require("../models/AvailableAccount");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");
const autoFarmer = require("../utils/autoFarmer");

let mem;
const orig = {};
let written = null;
const actions = [];

const config = () => ({
  TwitchSettings: {
    TwitchUsers: [
      { Login: "wave_a", ClientSecret: "s1", Enabled: true, FavouriteGames: ["RavenQuest"] },
      { Login: "wave_b", ClientSecret: "s2", Enabled: true, FavouriteGames: ["RavenQuest"] },
      { Login: "old_only", ClientSecret: "s3", Enabled: true, FavouriteGames: ["RavenQuest"] },
      { Login: "cotenant", ClientSecret: "s4", Enabled: true, FavouriteGames: ["SMITE 2"] },
    ],
  },
});

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("completeendedsamegame"));
  for (const k of ["resolveHost", "readFile", "writeFileAtomic", "dockerContainer"]) orig[k] = hosts[k];
  orig.stopContainer = botFactory.stopContainer;
  orig.deleteBot = botFactory.deleteBot;
  hosts.resolveHost = (id) => ({ id, transport: "ssh" });
  hosts.readFile = async () => JSON.stringify(config());
  hosts.writeFileAtomic = async (_h, _f, text) => {
    written = JSON.parse(text);
  };
  hosts.dockerContainer = async (_h, action, container) => {
    actions.push(action + ":" + container);
  };
  // The bot is shared with the next wave, so it must never be stopped/deleted.
  botFactory.stopContainer = async () => {
    throw new Error("a shared bot must not be stopped");
  };
  botFactory.deleteBot = async () => {
    throw new Error("a shared bot must not be deleted");
  };
});

test.after(async () => {
  for (const [k, v] of Object.entries(orig)) {
    if (k === "stopContainer" || k === "deleteBot") botFactory[k] = v;
    else hosts[k] = v;
  }
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test("an ending wave leaves the next wave's accounts armed, enabled and claimed", async () => {
  const bot = { host: "contabo", file: "config_42.json", container: "twitchbotx42" };
  await TwitchCampaign.create([
    { campaignId: "wave4", game: "RavenQuest", status: "ACTIVE", endAt: new Date(Date.now() - 3600e3) },
    { campaignId: "wave5", game: "RavenQuest", status: "ACTIVE", endAt: new Date(Date.now() + 5 * 86400e3) },
  ]);
  await AutoFarmTask.create([
    {
      game: "RavenQuest",
      campaignId: "wave4",
      status: "active",
      decision: "reuse_existing",
      assignedAccounts: ["wave_a", "wave_b", "old_only"],
      bots: [bot],
    },
    {
      // Same game, different spelling and login case — still the same game.
      game: " ravenquest",
      campaignId: "wave5",
      status: "active",
      decision: "reuse_existing",
      assignedAccounts: ["WAVE_A", "wave_b"],
      bots: [bot],
    },
  ]);
  await AvailableAccount.create(
    ["wave_a", "wave_b", "old_only"].map((u) => ({
      username: u,
      usernameLower: u,
      status: "claimed",
      claimedNote: "auto-farm: RavenQuest",
    })),
  );

  const completed = await autoFarmer.completeEndedTasks();
  assert.equal(completed, 1, "only the ended wave completes");

  assert.ok(written, "the shared bot's config was rewritten for the account that did end");
  const users = new Map(written.TwitchSettings.TwitchUsers.map((u) => [u.Login, u]));
  for (const login of ["wave_a", "wave_b"]) {
    assert.deepEqual(users.get(login).FavouriteGames, ["RavenQuest"], login + " keeps the game");
    assert.equal(users.get(login).Enabled, true, login + " stays enabled");
  }
  assert.deepEqual(users.get("old_only").FavouriteGames, [], "the ended wave's own account is cleaned");
  assert.equal(users.get("old_only").Enabled, false);
  assert.deepEqual(users.get("cotenant").FavouriteGames, ["SMITE 2"], "co-tenants untouched");
  assert.deepEqual(actions, ["restart:twitchbotx42"]);

  const pool = new Map(
    (await AvailableAccount.find({}, { usernameLower: 1, status: 1 }).lean()).map((r) => [r.usernameLower, r.status]),
  );
  assert.equal(pool.get("wave_a"), "claimed", "the next wave's account is not recycled");
  assert.equal(pool.get("wave_b"), "claimed");
  assert.equal(pool.get("old_only"), "available", "the ended wave's own account is recycled as before");

  const next = await AutoFarmTask.findOne({ campaignId: "wave5" }).lean();
  assert.equal(next.status, "active");
});
