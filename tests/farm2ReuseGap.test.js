// The reuse account gap: a campaign's own row is never a competitor for its
// own reuse.
//
// Production, 2026-09-05. Every negative account delta on a reuse-vs-reuse
// shadow row had the same cause. Legacy decided campaign C at time T while C
// had no active/planned row, reused warm task R, and wrote C's row ACTIVE with
// the accounts it took from R. The shadow lane decided C later, picked R too,
// and computed "spoken for" over every OTHER active/planned task — which by
// then included C's own legacy row, holding the very accounts legacy had
// assigned to C. So the lane subtracted, from C, the accounts legacy gave C:
//
//   EVE Online      source held 19, own row overlapped 12 -> lane 7,  legacy 19
//   Black Desert    source held 40, own row overlapped 40 -> lane 0,  legacy 40
//
// Legacy never meets this because it only decides a campaign that has no
// active/planned row. The lane re-decides everything every cycle, and in
// shadow decides campaigns legacy has already acted on, so it has to state the
// rule explicitly. These tests pin it, in both steps that count.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const laneMod = require("../utils/farm2/lane");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2reusegap"));
  await FarmJob.init();
  await AutoFarmTask.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
const accounts = (game, n) =>
  Array.from({ length: n }, (_, i) => `${game.toLowerCase().replace(/[^a-z0-9]+/g, "")}_${i + 1}`);
const BOT = { host: "local", file: "config_9.json", container: "bot9" };

// Legacy's row for the campaign being decided: ACTIVE, executed, holding
// `overlap` of the source's accounts, with the source's bots copied onto it
// exactly as legacy's reuse record does (bots reused + shared).
async function ownRow(game, campaignId, source, overlap, createdAt) {
  return AutoFarmTask.create({
    game,
    campaignId,
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: source.assignedAccounts.slice(0, overlap),
    plannedAccounts: overlap,
    bots: [{ ...BOT, reused: true, shared: true }],
    executedAt: createdAt,
    decidedAt: createdAt,
    createdAt,
  });
}

// The warm source task R: completed, with bots, and `held` accounts.
async function source(game, held, createdAt) {
  return AutoFarmTask.create({
    game,
    campaignId: "source",
    decision: "farm",
    status: "completed",
    assignedAccounts: accounts(game, held),
    bots: [BOT],
    createdAt,
  });
}

const hostCache = () => new Map([["local|config_9.json", true]]);

/* ------------------------------ the decide step --------------------------- */

for (const { name, held, overlap } of [
  { name: "EVE Online", held: 19, overlap: 12 },
  { name: "Black Desert", held: 40, overlap: 40 },
]) {
  test(`P2, ${name}: source held ${held}, own row overlaps ${overlap} — the lane sees ${held}, as legacy recorded`, async () => {
    const game = `${name} Gap`;
    await AutoFarmTask.deleteMany({ game });
    // The own row is OLDER than the source (a campaign skipped for a while
    // before it was farmed), so createdAt: -1 picks the source — the
    // configuration production showed in every negative row.
    const R = await source(game, held, hoursAgo(2));
    const L = await ownRow(game, "c1", R, overlap, hoursAgo(30));

    const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache(), campaignId: "c1" });
    assert.ok(r, "the warm task is reusable");
    assert.equal(String(r.taskId), String(R._id), "the source is the pick, as on prod");
    assert.equal(r.accounts.length, held, `all ${held} are free FOR THIS CAMPAIGN — ${overlap} of them are its own`);
    assert.ok(r.ownRow, "the own row is reported, not silently dropped");
    assert.equal(String(r.ownRow.taskId), String(L._id));
    assert.equal(r.ownRow.overlap, overlap);
    assert.equal(r.ownRow.status, "active");
  });
}

test("a SIBLING campaign's active row is still spoken for — only the campaign's own row is exempt", async () => {
  const game = "Sibling Gap Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await source(game, 19, hoursAgo(2));
  await ownRow(game, "c1", R, 12, hoursAgo(30));
  // Older than R so the source stays the pick: reusableTaskForGame takes the
  // newest task with bots, and a newer sibling row would itself be chosen —
  // the shared pick rule, not what this test is about.
  await AutoFarmTask.create({
    game,
    campaignId: "c2",
    decision: "reuse_existing",
    status: "active",
    assignedAccounts: R.assignedAccounts.slice(16, 19),
    bots: [{ ...BOT, reused: true, shared: true }],
    executedAt: new Date(),
    createdAt: hoursAgo(20),
  });
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache(), campaignId: "c1" });
  assert.equal(r.accounts.length, 16, "19 held, 3 on a sibling's live task — 16 free; the own row's 12 are not subtracted");
  assert.equal(r.ownRow.overlap, 12);
});

test("without a campaignId nothing is exempt — a caller with no campaign context sees the fleet-wide set", async () => {
  const game = "No Context Gap Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await source(game, 19, hoursAgo(2));
  await ownRow(game, "c1", R, 12, hoursAgo(30));
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache() });
  assert.equal(r.accounts.length, 7, "the pre-fix number: every other live task counts");
  assert.equal(r.ownRow, null);
});

test("the own row is matched on (game, campaignId) — the same campaign id under another game is a competitor", async () => {
  const game = "Cross Game Gap";
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmTask.deleteMany({ game: "Some Other Game" });
  const R = await source(game, 10, hoursAgo(2));
  // An active row for a DIFFERENT game that happens to hold four of R's
  // accounts (recycled across games) under the same campaign id string.
  await AutoFarmTask.create({
    game: "Some Other Game",
    campaignId: "c1",
    decision: "farm",
    status: "active",
    assignedAccounts: R.assignedAccounts.slice(0, 4),
    executedAt: new Date(),
  });
  const r = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache(), campaignId: "c1" });
  assert.equal(r.accounts.length, 6, "another game's row is another task, whatever its campaign id");
  assert.equal(r.ownRow, null);
});

test("decideCampaign passes the campaign through, and the verdict names the own row it exempted", async () => {
  const game = "Verdict Gap Game";
  await AutoFarmTask.deleteMany({ game });
  await MarketResearch.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  const R = await source(game, 19, hoursAgo(2));
  const L = await ownRow(game, "c1", R, 12, hoursAgo(30));
  const v = await decideStep.decideCampaign({
    campaign: { game, campaignId: "c1", name: "Weekly", endAt: hoursFromNow(48) },
    lane: { game, gameKey: settings.normGameName(game), mode: "shadow" },
    cycle: null,
    af: { ...settings.getAutoFarm(), probeColdStart: false, dryRun: false, minHoursLeft: 12, maxPerGame: 30 },
    shadow: true,
    hostCache: hostCache(),
    ctx: { host: { id: "local", label: "Local" }, hostOnline: true },
  });
  assert.equal(v.decision, "reuse_existing");
  assert.equal(v.plannedAccounts, 19, "legacy's number");
  assert.equal(String(v.reuseTaskId), String(R._id));
  assert.equal(String(v.reuseOwnRow.taskId), String(L._id));
  assert.equal(v.reuseOwnRow.overlap, 12);
});

/* ----------------------------- the execute step --------------------------- */

test("executeReuse's recompute exempts the own row too — decide and execute count the same set", async () => {
  const game = "Execute Gap Game";
  await AutoFarmTask.deleteMany({ game });
  const R = await source(game, 19, hoursAgo(2));
  await ownRow(game, "c1", R, 12, hoursAgo(30));
  // Dry-run: the recompute runs, nothing is restarted, the count is returned.
  const r = await executeStep.executeReuse({
    verdict: { game, campaignId: "c1", decision: "reuse_existing", reuseTaskId: R._id, reason: "recurring" },
    dryRun: true,
  });
  assert.equal(r.wouldReuseAccounts, 19);
  const decided = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache(), campaignId: "c1" });
  assert.equal(decided.accounts.length, r.wouldReuseAccounts);
});

/* ------------------------------- the live lane ---------------------------- */

test("LIVE: an already-executed campaign is SETTLED — not re-decided, nothing executed, the row untouched", async () => {
  // The claim this pins has moved one step earlier. Exempting the own row
  // changed what a re-decision REPORTS (pinned above, through decideCampaign);
  // the lane runner now never re-decides an executed campaign at all — the
  // candidate filter treats an active row as settled, exactly as the legacy
  // tick does. No decide job, no execute job, the own row untouched.
  const game = "Live Redecide Gap Game";
  const gameKey = settings.normGameName(game);
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    FarmJob.deleteMany({ lane: game }),
    FarmLane.deleteMany({ gameKey }),
    TwitchCampaign.deleteMany({ campaignId: "live-c1" }),
    MarketResearch.deleteMany({ game }),
  ]);
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  await TwitchCampaign.create({ campaignId: "live-c1", name: "Weekly", game, status: "ACTIVE", active: true, endAt: hoursFromNow(48) });
  const R = await source(game, 19, hoursAgo(2));
  // The lane's OWN earlier execution of this campaign: active, executed, all 19.
  const L = await ownRow(game, "live-c1", R, 19, hoursAgo(1));
  const lane = (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();

  const cache = hostCache();
  cache.set("__farm2:host", Promise.resolve({ host: { id: "local", label: "Local" }, hostOnline: true }));
  const af = { ...settings.getAutoFarm(), probeColdStart: false, dryRun: false, minHoursLeft: 12, maxPerGame: 30, platiCategoryId: "" };
  const summary = await laneMod.runLane(lane, { cycle: null, af, hostCache: cache });

  const decideErrors = summary.errors.filter((e) => !/^(monitor|audit):/.test(e));
  assert.deepEqual(decideErrors, [], decideErrors.join("; "));
  assert.equal(summary.campaigns, 1);
  assert.equal(summary.settled, 1, "the executed campaign is settled, as legacy treats it");
  assert.equal(summary.decisions.length, 0, "no re-decision");
  assert.equal(summary.executed.length, 0);
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "decide" }), 0, "no decide job was written");
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "execute" }), 0, "no execute job was queued");

  // Deciding it directly still reports the truthful count — the own row is
  // not a competitor for its own reuse.
  const direct = await decideStep.reuseCandidate(game, { cycle: null, hostCache: hostCache(), campaignId: "live-c1" });
  assert.equal(direct.accounts.length, 19, "before: 0 — its own 19 accounts counted against it");

  const row = await AutoFarmTask.findById(L._id).lean();
  assert.equal(row.status, "active");
  assert.equal(row.assignedAccounts.length, 19, "the own row is untouched");
});
