// `hadResearch` on the sellability-skip path is the truth, not a constant.
//
// utils/autoFarmer.js recorded `hadResearch: true` on skip_low_demand /
// skip_probe_budget even when `research` was null, while every other record()
// call in processCampaign writes `!!research`. Found while building the replay
// harness (FARM2-VERIFICATION §5.1); fixed here as one token in its own commit.
//
// Driven through the real processCampaign on the sellability branch, which
// returns before the host gate and so needs no host. Reaching the skip WITH
// research null requires probeAllowed to be false — an unscanned game would
// otherwise probe — so the fixture puts the game inside the post-failure probe
// cooldown, exactly as the engine's own gate would.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const autoFarmer = require("../utils/autoFarmer");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2hadresearch"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

function ctxFor({ campaignId, research, sales, hostOnline = false, af = {} }) {
  return {
    af: {
      ...settings.getAutoFarm(),
      dryRun: true,
      probeColdStart: false,
      probeCooldownDays: 90,
      probeMaxGames: 8,
      maxPerGame: 30,
      platiCategoryId: "",
      ...af,
    },
    host: null,
    hostOnline,
    budgetMap: new Map(),
    infoMap: new Map([[campaignId, { research, sales }]]),
    priorTasks: new Map(),
  };
}

test("skip_low_demand with NO research records hadResearch false — it used to record true", async () => {
  const game = "No Research Skip Game";
  await AutoFarmTask.deleteMany({ game });
  // An expired probe inside the cooldown makes the probe gate refuse, so an
  // unscanned game skips instead of probing — the only way to reach the
  // sellability skip with research null.
  await AutoFarmTask.create({
    game,
    campaignId: "expired-probe",
    decision: "probe",
    status: "completed",
    probeOutcome: "expired",
    completedAt: hoursAgo(24),
  });
  const c = { game, campaignId: "nr1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    ctxFor({
      campaignId: "nr1",
      research: null,
      sales: { count: 0, revenue: 0, avgPrice: 0 },
      af: { probeColdStart: true },
    }),
  );
  assert.equal(r.decision, "skip_low_demand");
  const row = await AutoFarmTask.findOne({ game, campaignId: "nr1" }).lean();
  assert.equal(row.decision, "skip_low_demand");
  assert.match(row.reason, /cooldown/, "fixture sanity: the probe gate refused, so this is the cooldown skip");
  assert.equal(row.hadResearch, false, "no research document existed, and the row now says so");
  // The recorded snapshot (commit 5) agrees, as it always did.
  assert.equal(row.decisionInputs.research, null);
});

test("skip_low_demand WITH research still records hadResearch true", async () => {
  const game = "Researched Skip Game";
  await AutoFarmTask.deleteMany({ game });
  const c = { game, campaignId: "rs1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    ctxFor({
      campaignId: "rs1",
      research: { demandScore: 3, sellers: 20, scannedAt: hoursAgo(1) },
      sales: { count: 0, revenue: 0, avgPrice: 0 },
    }),
  );
  assert.equal(r.decision, "skip_low_demand");
  const row = await AutoFarmTask.findOne({ game, campaignId: "rs1" }).lean();
  assert.equal(row.hadResearch, true);
  assert.equal(row.decisionInputs.research.demandScore, 3);
});

test("the other paths were already truthful — the skip now matches them", async () => {
  // Control: an unscanned game that passes sellability (probing allowed) and
  // stops at the host gate has always recorded hadResearch false there.
  const game = "No Research Offline Game";
  await AutoFarmTask.deleteMany({ game });
  const c = { game, campaignId: "no1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    ctxFor({
      campaignId: "no1",
      research: null,
      sales: { count: 0, revenue: 0, avgPrice: 0 },
      hostOnline: false,
    }),
  );
  assert.equal(r.decision, "skip_host_offline");
  const row = await AutoFarmTask.findOne({ game, campaignId: "no1" }).lean();
  assert.equal(row.hadResearch, false);
});
