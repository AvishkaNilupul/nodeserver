// MAIN-ENGINE MODE: the lane engine as THE engine.
//
//   * every game with a live, claimable campaign gets a live lane, created by
//     the supervisor itself; existing lanes keep their modes; no-claim games
//     are never touched
//   * a PAUSED live lane releases its game — ownership.isOwned is false for it,
//     so the legacy engine covers the game instead of nobody
//   * the lane runner reports the pause transition, and the supervisor alerts
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmLane = require("../models/FarmLane");
const FarmJob = require("../models/FarmJob");
const TwitchCampaign = require("../models/TwitchCampaign");
const supervisor = require("../utils/farm2/supervisor");
const ownership = require("../utils/farm2/ownership");
const laneMod = require("../utils/farm2/lane");
const notify = require("../utils/farm2/notify");
const settings = require("../utils/settings");

let mem;
const sent = [];
const origGet = settings.getAutoFarm;
const origTg = notify.telegram;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2main"));
  await FarmJob.init();
  await FarmLane.init();
  notify.telegram = async (t) => {
    sent.push(t);
  };
});

test.after(async () => {
  settings.getAutoFarm = origGet;
  notify.telegram = origTg;
  ownership.setEngineRunning(false);
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
async function campaign(game, campaignId, over = {}) {
  await TwitchCampaign.create({ campaignId, name: "Weekly", game, status: "ACTIVE", active: true, endAt: hoursFromNow(48), ...over });
}

test("ensureLanesForLiveGames creates a LIVE lane per live game, once, never for no-claim games or existing lanes", async () => {
  await FarmLane.deleteMany({});
  await TwitchCampaign.deleteMany({});
  const noClaim = settings.getNoClaimGames ? settings.getNoClaimGames()[0] : null;
  await campaign("Main Game A", "ma-1");
  await campaign("Main Game A", "ma-2"); // two campaigns, one lane
  await campaign("Main Game B", "mb-1");
  await campaign("Ended Game", "me-1", { endAt: new Date(Date.now() - 3600000) });
  await campaign("Inactive Game", "mi-1", { active: false });
  if (noClaim) await campaign(noClaim, "mn-1");
  await FarmLane.create({ game: "Main Game B", gameKey: settings.normGameName("Main Game B"), mode: "shadow" });

  const created = await supervisor.ensureLanesForLiveGames({ audit: false });
  assert.deepEqual(created, ["Main Game A"]);
  const lanes = await FarmLane.find({}).sort({ game: 1 }).lean();
  assert.deepEqual(lanes.map((l) => [l.game, l.mode]), [["Main Game A", "live"], ["Main Game B", "shadow"]], "B keeps its shadow mode; ended/inactive/no-claim get nothing");
  assert.equal(lanes[0].note, "auto-created: main engine");
  assert.deepEqual(await supervisor.ensureLanesForLiveGames({ audit: false }), [], "idempotent");
});

test("the supervisor auto-creates lanes only when farm2Main is on", async () => {
  await FarmLane.deleteMany({});
  await TwitchCampaign.deleteMany({});
  await campaign("Main Game C", "mc-1");
  settings.getAutoFarm = () => ({ ...origGet.call(settings), farm2Enabled: true, farm2Main: false, hostId: "" });
  let s = await supervisor.runCycle({ force: true });
  assert.equal(s.lanes, 0);
  assert.equal(await FarmLane.countDocuments({}), 0, "trial mode: no lane appears by itself");
  settings.getAutoFarm = () => ({ ...origGet.call(settings), farm2Enabled: true, farm2Main: true, hostId: "" });
  s = await supervisor.runCycle({ force: true });
  assert.deepEqual(s.autoCreated, ["Main Game C"]);
  assert.equal(s.main, true);
  assert.equal((await FarmLane.findOne({ game: "Main Game C" }).lean()).mode, "live");
  settings.getAutoFarm = origGet;
});

test("a PAUSED live lane owns nothing — the legacy engine covers its game", async () => {
  await FarmLane.deleteMany({});
  settings.getAutoFarm = () => ({ ...origGet.call(settings), farm2Enabled: true });
  ownership.setEngineRunning(true);
  await FarmLane.create({ game: "Owned Game", gameKey: settings.normGameName("Owned Game"), mode: "live", state: "idle" });
  await FarmLane.create({ game: "Paused Game", gameKey: settings.normGameName("Paused Game"), mode: "live", state: "paused", consecutiveFailures: 8 });
  ownership.invalidate();
  assert.equal(await ownership.isOwnedAsync("Owned Game"), true);
  assert.equal(await ownership.isOwnedAsync("Paused Game"), false, "a paused lane releases its game");
  await FarmLane.updateOne({ game: "Paused Game" }, { $set: { state: "idle", consecutiveFailures: 0 } });
  ownership.invalidate();
  assert.equal(await ownership.isOwnedAsync("Paused Game"), true, "re-armed: owned again");
  settings.getAutoFarm = origGet;
  ownership.setEngineRunning(false);
});

test("the pause transition is reported once by the lane and alerted by the supervisor", async () => {
  await FarmLane.deleteMany({});
  await TwitchCampaign.deleteMany({});
  await FarmJob.deleteMany({});
  const lane = await FarmLane.create({ game: "Failing Game", gameKey: settings.normGameName("Failing Game"), mode: "live", state: "idle", consecutiveFailures: laneMod.PAUSE_AFTER_FAILURES - 1, nextRunAt: new Date() });
  // Make the campaign lookup throw so the run fails at the outer boundary.
  const TC = require("../models/TwitchCampaign");
  const origFind = TC.find;
  TC.find = () => { throw new Error("db down"); };
  settings.getAutoFarm = () => ({ ...origGet.call(settings), farm2Enabled: true, farm2Main: false, hostId: "" });
  sent.length = 0;
  try {
    const s = await supervisor.runCycle({ force: true });
    assert.deepEqual(s.paused, ["Failing Game"]);
    const row = await FarmLane.findById(lane._id).lean();
    assert.equal(row.state, "paused");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /lane PAUSED — Failing Game/);
    assert.match(sent[0], /db down/);
    // A second cycle on the already-paused lane does not re-alert (it is not even dispatched).
    const s2 = await supervisor.runCycle({ force: true });
    assert.deepEqual(s2.paused || [], []);
    assert.equal(sent.length, 1);
  } finally {
    TC.find = origFind;
    settings.getAutoFarm = origGet;
  }
});
