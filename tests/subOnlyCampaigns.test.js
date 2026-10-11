// Subscriber-only campaigns: never probed or farmed, and a probe already
// sitting on one is ended early.
//
// A time-based drop with requiredSubs > 0 goes only to a paying subscriber —
// no amount of watching earns it, and the bots drop it from their own list.
// On 2026-10-08 six of production's eight probe slots (90 pool accounts) had
// sat on such campaigns for up to nine days, each with a public pre-order
// page, while six other games waited in the probe queue.
//
// These tests run the REAL decide step, lane runner, legacy processCampaign
// and completeEndedTasks against an in-memory Mongo and a farm host that is a
// temp directory. The only stubs are the edges that would touch the world:
// the container restart, the container factory and Telegram.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const AvailableAccount = require("../models/AvailableAccount");
const CampaignDrops = require("../models/CampaignDrops");
const DropSet = require("../models/DropSet");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const MarketResearch = require("../models/MarketResearch");
const PoolUsageEvent = require("../models/PoolUsageEvent");
const TwitchCampaign = require("../models/TwitchCampaign");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");
const farmControl = require("../utils/farmControl");
const autoFarmer = require("../utils/autoFarmer");
const farmability = require("../utils/campaignFarmability");
const classes = require("../utils/farm2/decisionClasses");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const laneMod = require("../utils/farm2/lane");
const notify = require("../utils/farm2/notify");
const replay = require("../utils/farm2/replay");
const settings = require("../utils/settings");

let mem;
let tmpDir;
const HOST = { id: "tmp", label: "Tmp host", transport: "local", runtime: "docker", dir: "" };
const orig = {
  resolveHost: hosts.resolveHost,
  restartIfRunning: farmControl.restartIfRunning,
  stopContainer: botFactory.stopContainer,
  deleteBot: botFactory.deleteBot,
  telegram: notify.telegram,
  getAutoFarm: settings.getAutoFarm,
};
let restarted;
let stopped;
let sent;
// Flipped by a test to make the temp host look unreachable.
let hostDown = false;

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

function af(overrides = {}) {
  return {
    ...orig.getAutoFarm.call(settings),
    enabled: true,
    dryRun: false,
    hostId: "tmp",
    probeColdStart: true,
    probeSize: 15,
    probeMaxSellers: 1,
    probeMaxGames: 8,
    probeMaxDays: 30,
    probeCooldownDays: 90,
    minHoursLeft: 12,
    maxPerGame: 30,
    platiCategoryId: "",
    deleteFinishedBots: true,
    ...overrides,
  };
}

// No test.before for the connection: the first test below has to run while the
// database is NOT connected.
async function db() {
  if (mongoose.connection.readyState === 1) return;
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("subonly"));
  await AutoFarmTask.init();
  await AvailableAccount.init();
  await CampaignDrops.init();
  await FarmJob.init();
}

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-only-"));
  HOST.dir = tmpDir;
  hosts.resolveHost = (id) => {
    if (String(id) !== "tmp") return orig.resolveHost(id);
    return hostDown ? { ...HOST, dir: path.join(tmpDir, "no-such-dir") } : HOST;
  };
  farmControl.restartIfRunning = async (host, container) => {
    restarted.push(container);
    return { restarted: true, state: "running" };
  };
  botFactory.stopContainer = async (host, container) => {
    stopped.push(container);
  };
  botFactory.deleteBot = async () => {};
  notify.telegram = async (t) => {
    sent.push(t);
  };
  settings.getAutoFarm = () => af();
});

test.beforeEach(() => {
  restarted = [];
  stopped = [];
  sent = [];
  hostDown = false;
});

test.after(async () => {
  hosts.resolveHost = orig.resolveHost;
  farmControl.restartIfRunning = orig.restartIfRunning;
  botFactory.stopContainer = orig.stopContainer;
  botFactory.deleteBot = orig.deleteBot;
  notify.telegram = orig.telegram;
  settings.getAutoFarm = orig.getAutoFarm;
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  if (mem) await mem.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* -------------------------------- fixtures -------------------------------- */

const sub = (n = 1) => ({ name: "Badge", itemKey: "badge|g", requiredMinutesWatched: 0, requiredSubs: n });
const watch = (m = 60) => ({ name: "Skin", itemKey: "skin|g", requiredMinutesWatched: m, requiredSubs: 0 });

async function campaign(game, campaignId, { drops = null, watchVersion = 1, endAt = hoursFromNow(96), status = "ACTIVE", name = "Launch" } = {}) {
  await TwitchCampaign.deleteMany({ campaignId });
  await TwitchCampaign.create({ campaignId, name, game, status, active: status === "ACTIVE", endAt });
  await CampaignDrops.deleteMany({ campaignId });
  if (drops) await CampaignDrops.create({ campaignId, game, name, drops, watchVersion, fetchedAt: new Date() });
}

// An untested market: no demand, no rival sellers — a cold-start probe candidate.
async function untested(game) {
  await MarketResearch.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 0, sellers: 0, scannedAt: new Date() });
}

async function liveLane(game) {
  const gameKey = settings.normGameName(game);
  await FarmLane.deleteMany({ gameKey });
  return (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();
}

const user = (login, games, enabled = true) => ({
  Login: login,
  Id: "id-" + login,
  ClientSecret: "secret-" + login,
  Enabled: enabled,
  FavouriteGames: games,
});

function writeConfig(file, users) {
  fs.writeFileSync(
    path.join(tmpDir, file),
    JSON.stringify({ TwitchSettings: { TwitchUsers: users } }, null, 2),
  );
}
const readConfig = (file) =>
  JSON.parse(fs.readFileSync(path.join(tmpDir, file), "utf8")).TwitchSettings.TwitchUsers;

async function poolRows(logins, note) {
  for (const u of logins) {
    await AvailableAccount.deleteMany({ usernameLower: u });
    await AvailableAccount.create({
      username: u,
      usernameLower: u,
      password: "p",
      clientSecret: "secret-" + u,
      status: "claimed",
      claimedAt: new Date(),
      claimedNote: note,
      lastCheckStatus: "ok",
      lastCheckAt: new Date(),
    });
  }
}

async function probeTask(game, campaignId, { accounts, bots, decision = "probe", campaignName = "Launch" }) {
  await AutoFarmTask.deleteMany({ game, campaignId });
  return AutoFarmTask.create({
    game,
    campaignId,
    campaignName,
    decision,
    status: "active",
    assignedAccounts: accounts,
    plannedAccounts: accounts.length,
    targetAccounts: accounts.length,
    bots,
    executedAt: new Date(),
    probeStartedAt: decision === "probe" ? new Date() : null,
  });
}

async function preorder(game, campaignId) {
  await DropSet.deleteMany({ sourceEventKey: "autofarm:" + campaignId });
  return DropSet.create({
    name: game + " — Launch",
    items: [{ itemKey: "badge|g", name: "Badge", game, qty: 1 }],
    sourceType: "autofarm_event",
    sourceEventKey: "autofarm:" + campaignId,
    listed: true,
    publicCatalog: true,
    catalogState: "preorder",
    price: 1,
  });
}

const bot44 = { host: "tmp", file: "config_44.json", container: "twitchbotx44" };

/* ------------------------------ 1. the rule ------------------------------- */

test("with no database connection the question answers 'not proven' at once", async () => {
  assert.notEqual(mongoose.connection.readyState, 1);
  const started = Date.now();
  assert.equal(await farmability.campaignSubOnly("any-campaign"), false);
  assert.ok(Date.now() - started < 1000, "it must not wait on Mongoose's command buffer");
});

test("only a manifest that records subscriptions, has drops, and has none watchable is proven", () => {
  const m = (drops, watchVersion = 1) => ({ campaignId: "c", watchVersion, drops });
  assert.equal(farmability.manifestSubOnly(m([sub()])), true);
  assert.equal(farmability.manifestSubOnly(m([sub(1), sub(2), sub(5)])), true);
  assert.equal(farmability.manifestSubOnly(m([watch(60), sub()])), false, "one watchable drop is enough to farm");
  assert.equal(farmability.manifestSubOnly(m([watch(30)])), false);
  assert.equal(farmability.manifestSubOnly(m([])), false, "an empty drop list proves nothing about subscriptions");
  assert.equal(farmability.manifestSubOnly(m([sub()], 0)), false, "saved before requiredSubs was recorded");
  assert.equal(
    farmability.manifestSubOnly(m([{ name: "x", requiredMinutesWatched: null, requiredSubs: null }])),
    false,
    "a drop with no recorded subscription count is watchable until proven otherwise",
  );
  assert.equal(farmability.manifestSubOnly(null), false);
  assert.equal(farmability.manifestSubOnly(undefined), false);
  // The park rules' own answer is untouched by the new one.
  assert.equal(farmability.manifestFarmable(m([sub()])), false);
  assert.equal(farmability.manifestFarmable(m([watch(), sub()])), true);
  assert.equal(farmability.manifestFarmable(null), true);
});

test("one campaign is read from its stored manifest; anything unreadable is 'not proven'", async () => {
  await db();
  await campaign("Rule Game", "rule-sub", { drops: [sub()] });
  await campaign("Rule Game", "rule-mixed", { drops: [watch(), sub()] });
  await campaign("Rule Game", "rule-old", { drops: [sub()], watchVersion: 0 });
  await campaign("Rule Game", "rule-none");
  assert.equal(await farmability.campaignSubOnly("rule-sub"), true);
  assert.equal(await farmability.campaignSubOnly("rule-mixed"), false);
  assert.equal(await farmability.campaignSubOnly("rule-old"), false);
  assert.equal(await farmability.campaignSubOnly("rule-none"), false, "no manifest yet");
  assert.equal(await farmability.campaignSubOnly(""), false);
  assert.equal(await farmability.campaignSubOnly(null), false);

  const real = CampaignDrops.findOne;
  CampaignDrops.findOne = () => {
    throw new Error("read failed");
  };
  try {
    assert.equal(await farmability.campaignSubOnly("rule-sub"), false, "a failed read never blocks a farm");
  } finally {
    CampaignDrops.findOne = real;
  }
});

/* ----------------------------- 2. the vocabulary --------------------------- */

test("skip_sub_only is a skip both engines can record, settled before the demand stage", () => {
  assert.ok(AutoFarmTask.schema.path("decision").enumValues.includes("skip_sub_only"));
  assert.equal(classes.actionClass("skip_sub_only"), "skip");
  assert.ok(classes.LEGACY_DECISIONS.includes("skip_sub_only"));
  assert.ok(classes.LANE_DECISIONS.includes("skip_sub_only"));
  assert.deepEqual(classes.LEGACY_ONLY_DECISIONS, []);
  assert.equal(classes.isPreDemandDecision("skip_sub_only"), true);
  assert.equal(classes.isPreDemandDecision("skip_low_demand"), false);
  assert.equal(classes.isDemandStageDecision("skip_sub_only"), false);
  assert.equal(classes.DOWNSTREAM_DECISIONS.includes("skip_sub_only"), false, "it never passed the demand stage");
  assert.equal(classes.recordsInternalSales("skip_sub_only"), false);
  assert.equal(classes.recordsTargetAccounts("skip_sub_only"), false);
  assert.equal(classes.recordsEffectiveDemand("skip_sub_only"), false);
  // Terminal, like skip_low_demand: decided once, not rewritten every cycle.
  assert.equal(autoFarmer.RETRYABLE.has("skip_sub_only"), false);
  assert.equal(laneMod.retryableSet().has("skip_sub_only"), false);
});

test("the Auto-farm page labels the new decision in both of its chip maps", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "bots.html"), "utf8");
  assert.match(html, /skip_sub_only: \["SKIP · subscribers only", "off"\]/);
  assert.match(html, /skip_sub_only: \["off", "SUBS ONLY"\]/);
});

test("the row a lane writes for it carries decision, status and reason — and no measurement that was never taken", () => {
  const verdict = {
    game: "G",
    campaignId: "c",
    campaignName: "Badge",
    campaignEndAt: hoursFromNow(48),
    decision: "skip_sub_only",
    wouldFarm: false,
    plannedAccounts: 0,
    targetAccounts: 0,
    demandScore: null,
    hadResearch: false,
    internalSales: 0,
    effectiveDemand: null,
    reason: farmability.SUB_ONLY_REASON,
  };
  const f = executeStep.legacySkipFields(verdict, af());
  assert.equal(f.decision, "skip_sub_only");
  assert.equal(f.status, "skipped");
  assert.equal(f.reason, farmability.SUB_ONLY_REASON);
  assert.equal(f.rescanRequested, false);
  for (const k of ["demandScore", "hadResearch", "internalSales", "decisionInputs", "coverage", "plannedAccounts", "targetAccounts"]) {
    assert.equal(k in f, false, k + " is not written");
  }
});

test("it is announced once, on the transition, naming the campaign", () => {
  const v = { game: "Persona 5 Royal", campaignName: "Morgana Badge", decision: "skip_sub_only" };
  const text = laneMod.skipAnnouncement(v, null);
  assert.match(text, /Auto-farm SKIP \(lane\) — Persona 5 Royal/);
  assert.match(text, /Subscribers-only drops \(Morgana Badge\)/);
  assert.match(text, /No accounts spent/);
  assert.match(laneMod.skipAnnouncement(v, "skip_probe_budget"), /Subscribers-only/, "a re-labelled queue row is announced");
  assert.equal(laneMod.skipAnnouncement(v, "skip_sub_only"), null, "a repeat is not");
});

test("replay does not score a row the demand stage never saw", async () => {
  await db();
  const out = await replay.replayDecision(
    { game: "G", campaignId: "c", decision: "skip_sub_only", decidedAt: new Date(), demandScore: 0, internalSales: 0 },
    { af: af() },
  );
  assert.equal(out.verdict, "unreplayable");
  assert.deepEqual(out.gaps, ["settled_before_demand_stage"]);
  assert.equal(out.legacyDecision, "skip_sub_only");
  const s = replay.summarise([out], {});
  assert.equal(s.scored, 0);
  assert.equal(s.unreplayable, 1);
  assert.equal(s.gapCounts.settled_before_demand_stage, 1);
});

/* --------------------------- 3. the decision gate -------------------------- */

test("LANE: a proven subscriber-only campaign is settled before any market read", async () => {
  await db();
  const game = "Gate Sub Game";
  await untested(game);
  await campaign(game, "gate-sub", { drops: [sub()], name: "Morgana Badge" });
  const l = await liveLane(game);

  // Any market or sales read on this path is a failure of the gate's order.
  const b = autoFarmer;
  const keep = { fresh: b.freshResearchForGame, ro: b.researchForGame, sales: b.internalSalesForGame };
  b.freshResearchForGame = b.researchForGame = b.internalSalesForGame = async () => {
    throw new Error("the demand stage must not run for a subscriber-only campaign");
  };
  let v;
  try {
    v = await decideStep.decideCampaign({
      campaign: await TwitchCampaign.findOne({ campaignId: "gate-sub" }).lean(),
      lane: l,
      cycle: null,
      af: af(),
      shadow: false,
      hostCache: new Map(),
    });
  } finally {
    b.freshResearchForGame = keep.fresh;
    b.researchForGame = keep.ro;
    b.internalSalesForGame = keep.sales;
  }
  assert.equal(v.decision, "skip_sub_only");
  assert.equal(v.wouldFarm, false);
  assert.equal(v.plannedAccounts, 0);
  assert.equal(v.reason, farmability.SUB_ONLY_REASON);
  assert.equal(v.campaignName, "Morgana Badge");
  assert.equal(v.demandScore, null);
  assert.equal(v.hadResearch, false);
  assert.equal("decisionInputs" in v, false);
  assert.ok(v.hoursLeft > 90 && v.hoursLeft <= 96);
});

test("LANE: mixed, unrecorded and manifest-less campaigns go on to the old stages unchanged", async () => {
  await db();
  for (const [id, opts] of [
    ["gate-mixed", { drops: [watch(60), sub()] }],
    ["gate-old", { drops: [sub()], watchVersion: 0 }],
    ["gate-nomani", {}],
    ["gate-empty", { drops: [] }],
  ]) {
    const game = "Gate Pass " + id;
    await untested(game);
    await campaign(game, id, opts);
    const l = await liveLane(game);
    const v = await decideStep.decideCampaign({
      campaign: await TwitchCampaign.findOne({ campaignId: id }).lean(),
      lane: l,
      cycle: null,
      af: af(),
      shadow: false,
      hostCache: new Map(),
      // Stop at the host gate: reaching it proves the campaign passed both the
      // farmability gate and the sellability stage as a probe candidate.
      ctx: { hostOnline: false, host: null },
    });
    assert.equal(v.decision, "skip_host_offline", id + " was decided by the stages below");
    assert.equal(v.decisionInputs.version, 1, id + " carries the sellability snapshot as before");
  }
});

test("LANE end to end: no row but a skip, no account, no pre-order page; decided once and announced once", async () => {
  await db();
  const game = "E2E Sub Only Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  await untested(game);
  await campaign(game, "e2e-sub", { drops: [sub()], name: "Teddie Badge" });
  await poolRows(["e2e_fresh_1", "e2e_fresh_2"], "");
  await AvailableAccount.updateMany({ usernameLower: /^e2e_fresh_/ }, { $set: { status: "available", claimedAt: null } });
  const l = await liveLane(game);

  const summary = await laneMod.runLane(l, { cycle: null, af: af(), hostCache: new Map() });
  assert.deepEqual(summary.errors, [], summary.errors.join("; "));
  assert.equal(summary.decisions.length, 1);
  assert.equal(summary.decisions[0].decision, "skip_sub_only");
  assert.equal(summary.skipsRecorded, 1);
  assert.equal(summary.executed.length, 0);
  assert.equal(summary.notified, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Subscribers-only drops \(Teddie Badge\)/);

  const row = await AutoFarmTask.findOne({ game, campaignId: "e2e-sub" }).lean();
  assert.equal(row.decision, "skip_sub_only");
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, farmability.SUB_ONLY_REASON);
  assert.equal(row.demandScore, null, "schema default: nothing was measured");
  assert.equal(row.hadResearch, false);
  assert.equal(row.decisionInputs, null);
  assert.deepEqual(row.assignedAccounts, []);
  assert.deepEqual(row.bots, []);
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: /^e2e_fresh_/, status: "available" }), 2, "no pool account was claimed");
  assert.equal(await DropSet.countDocuments({ sourceEventKey: "autofarm:e2e-sub" }), 0, "no pre-order page was stamped");
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "execute" }), 0);

  // The next cycle leaves it alone: terminal, like a low-demand skip.
  sent.length = 0;
  const again = await FarmLane.findById(l._id).lean();
  const s2 = await laneMod.runLane(again, { cycle: null, af: af(), hostCache: new Map() });
  assert.equal(s2.settled, 1);
  assert.equal(s2.decisions.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "decide" }), 1);
});

test("LANE end to end: a campaign waiting in the probe queue is re-labelled the next time it is decided", async () => {
  await db();
  // Production, 2026-10-08: PERSONA3 RELOAD "Koromaru Badge" and DayZ "DayZ
  // Badlands" were both skip_probe_budget — next in line for a slot they
  // could never use.
  const game = "E2E Queued Badge Game";
  await AutoFarmTask.deleteMany({ game });
  await FarmJob.deleteMany({ lane: game });
  await untested(game);
  await campaign(game, "e2e-queued", { drops: [sub()], name: "Koromaru Badge" });
  await AutoFarmTask.create({
    game,
    campaignId: "e2e-queued",
    campaignName: "Koromaru Badge",
    decision: "skip_probe_budget",
    status: "skipped",
    reason: "Untested market — 8 probes already running (budget full); queued.",
    demandScore: 2.5,
    hadResearch: true,
    internalSales: 0,
    decidedAt: new Date(Date.now() - 600000),
  });
  const l = await liveLane(game);
  const summary = await laneMod.runLane(l, { cycle: null, af: af(), hostCache: new Map() });
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.decisions[0].decision, "skip_sub_only");
  assert.equal(summary.decisions[0].trigger, "retryable");
  assert.equal(await AutoFarmTask.countDocuments({ game, campaignId: "e2e-queued" }), 1);
  const row = await AutoFarmTask.findOne({ game, campaignId: "e2e-queued" }).lean();
  assert.equal(row.decision, "skip_sub_only");
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, farmability.SUB_ONLY_REASON);
  assert.equal(row.demandScore, 2.5, "the earlier measurement stays; this decision took none");
  assert.equal(sent.length, 1);
});

test("LANE: a subscriber-only campaign takes no probe slot, so the queue behind it is not held up", async () => {
  await db();
  await AutoFarmTask.deleteMany({ decision: "probe" });
  const a = af({ probeMaxGames: 1 });
  const badge = "Budget Badge Game";
  const real = "Budget Real Game";
  await untested(badge);
  await untested(real);
  await campaign(badge, "budget-badge", { drops: [sub()] });
  await campaign(real, "budget-real", { drops: [watch(120)] });
  const decide = async (game, id) =>
    decideStep.decideCampaign({
      campaign: await TwitchCampaign.findOne({ campaignId: id }).lean(),
      lane: await liveLane(game),
      cycle: null,
      af: a,
      shadow: false,
      hostCache: new Map(),
      ctx: { hostOnline: false, host: null },
    });
  assert.equal((await decide(badge, "budget-badge")).decision, "skip_sub_only");
  assert.equal((await decide(real, "budget-real")).decision, "skip_host_offline", "the one slot is still free for a real probe");
});

test("LEGACY: processCampaign records the same skip with the same words, and announces it once", async () => {
  await db();
  const game = "Legacy Sub Game";
  await AutoFarmTask.deleteMany({ game });
  await untested(game);
  await campaign(game, "legacy-sub", { drops: [sub()], name: "Nahobeeho Badge" });
  const c = await TwitchCampaign.findOne({ campaignId: "legacy-sub" }).lean();
  const ctx = { af: af(), host: HOST, hostOnline: true, budgetMap: new Map(), priorTasks: new Map() };

  const out = await autoFarmer.processCampaign(c, ctx);
  assert.deepEqual(out, { decision: "skip_sub_only" });
  const row = await AutoFarmTask.findOne({ game, campaignId: "legacy-sub" }).lean();
  assert.equal(row.decision, "skip_sub_only");
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, farmability.SUB_ONLY_REASON);
  assert.equal(row.campaignName, "Nahobeeho Badge");
  assert.equal(row.demandScore, null);
  assert.equal(row.hadResearch, false);
  assert.equal(row.decisionInputs, null);
  assert.equal(row.rescanRequested, false);
  assert.deepEqual(row.assignedAccounts, []);

  // The lane writes the same row for the same campaign.
  const laneFields = executeStep.legacySkipFields(
    await decideStep.decideCampaign({ campaign: c, lane: await liveLane(game), cycle: null, af: af(), shadow: false, hostCache: new Map() }),
    af(),
  );
  for (const k of ["decision", "status", "reason", "campaignName", "rescanRequested"]) {
    assert.deepEqual(laneFields[k], row[k], "both engines agree on " + k);
  }
});

test("LEGACY: a mixed campaign is decided by the stages below, as before", async () => {
  await db();
  const game = "Legacy Mixed Game";
  await AutoFarmTask.deleteMany({ game });
  await untested(game);
  await campaign(game, "legacy-mixed", { drops: [watch(60), sub()] });
  const c = await TwitchCampaign.findOne({ campaignId: "legacy-mixed" }).lean();
  const out = await autoFarmer.processCampaign(c, {
    af: af(),
    host: HOST,
    hostOnline: false,
    budgetMap: new Map(),
    priorTasks: new Map(),
  });
  assert.equal(out.decision, "skip_host_offline");
});

/* ----------------------- 4. ending a probe that got in --------------------- */

// One shared bot, as production's are: the probe's accounts beside a co-tenant
// task's, plus one account both tasks hold.
async function sharedBotFixture(tag, { probeDrops = [sub()], decision = "probe" } = {}) {
  const game = "Stuck " + tag;
  const other = "Cotenant " + tag;
  const probeOnly = ["p1", "p2", "p3"].map((x) => tag + "_" + x);
  const both = tag + "_both";
  const cotenant = [tag + "_c1", tag + "_c2"];
  await campaign(game, tag + "-probe", { drops: probeDrops, name: "Morgana Badge" });
  await campaign(other, tag + "-other", { drops: [watch(60)] });
  writeConfig("config_44.json", [
    ...probeOnly.map((u) => user(u, [game])),
    user(both, [game, other]),
    ...cotenant.map((u) => user(u, [other])),
  ]);
  await poolRows([...probeOnly, both], "auto-farm: " + game);
  await poolRows(cotenant, "auto-farm: " + other);
  const task = await probeTask(game, tag + "-probe", { accounts: [...probeOnly, both], bots: [bot44], decision, campaignName: "Morgana Badge" });
  const otherTask = await probeTask(other, tag + "-other", { accounts: [both, ...cotenant], bots: [bot44], decision: "farm" });
  const set = await preorder(game, tag + "-probe");
  return { game, other, probeOnly, both, cotenant, task, otherTask, set };
}

async function clearTasks() {
  await AutoFarmTask.deleteMany({});
  await AutoFarmEvent.deleteMany({});
  await PoolUsageEvent.deleteMany({});
}

test("a probe on a subscriber-only campaign is ended early: accounts trimmed and recycled, slot freed, pre-order page down", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("early");
  assert.equal((await decideStep.probeGate("Some Other Game", af({ probeMaxGames: 1 }))).probeBudgetBlocked, true, "the stuck probe holds the only slot");

  const completed = await autoFarmer.completeEndedTasks();
  assert.equal(completed, 1);

  const t = await AutoFarmTask.findById(f.task._id).lean();
  assert.equal(t.status, "completed");
  assert.ok(t.completedAt);
  assert.equal(t.probeOutcome, "", "no cooldown: the market was never tested");
  assert.equal((await AutoFarmTask.findById(f.otherTask._id).lean()).status, "active", "the co-tenant task is untouched");

  // The shared config: this probe's game is gone from its accounts and nothing else moved.
  const users = new Map(readConfig("config_44.json").map((u) => [u.Login, u]));
  for (const u of f.probeOnly) {
    assert.deepEqual(users.get(u).FavouriteGames, [], u + " no longer farms the probe game");
    assert.equal(users.get(u).Enabled, false, u + " is switched off, not left to inherit the bot's games");
  }
  assert.deepEqual(users.get(f.both).FavouriteGames, [f.other], "the shared account keeps its other game");
  assert.equal(users.get(f.both).Enabled, true);
  for (const u of f.cotenant) {
    assert.deepEqual(users.get(u).FavouriteGames, [f.other]);
    assert.equal(users.get(u).Enabled, true);
  }
  assert.deepEqual(restarted, ["twitchbotx44"], "one reload of the shared bot");
  assert.deepEqual(stopped, [], "a shared bot is never stopped");

  // The pool: only accounts that left the bot come back, and without game affinity.
  const note = "recycled — subscribers-only drops, nothing farmed (" + f.game + ")";
  for (const u of f.probeOnly) {
    const row = await AvailableAccount.findOne({ usernameLower: u }).lean();
    assert.equal(row.status, "available", u);
    assert.equal(row.claimedNote, note);
    assert.equal(row.claimedAt, null);
    assert.equal(new RegExp("^recycled after ").test(row.claimedNote), false, "not the game-affinity note");
  }
  for (const u of [f.both, ...f.cotenant]) {
    assert.equal((await AvailableAccount.findOne({ usernameLower: u }).lean()).status, "claimed", u + " is still farming");
  }
  assert.equal(await PoolUsageEvent.countDocuments({ event: "recycled", note }), 3);

  // The trail.
  const done = await AutoFarmEvent.findOne({ type: "task_completed", taskId: f.task._id }).lean();
  assert.equal(done.reason, "probe ended early — subscribers-only drops, nothing to farm");
  assert.equal(done.count, 4);
  assert.equal((await AutoFarmEvent.findOne({ type: "recycled", taskId: f.task._id }).lean()).count, 3);

  // The storefront.
  const set = await DropSet.findById(f.set._id).lean();
  assert.equal(set.listed, false);
  assert.equal(set.catalogState, "soldout");

  // The slot.
  const gate = await decideStep.probeGate("Some Other Game", af({ probeMaxGames: 1 }));
  assert.equal(gate.probeAllowed, true);
  assert.equal(gate.probeBudgetBlocked, false);
  // And the game itself owes no cooldown.
  assert.equal((await decideStep.probeGate(f.game, af())).probeAllowed, true);

  // A second pass finds nothing left to do.
  restarted.length = 0;
  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  assert.deepEqual(restarted, []);
});

test("probes that CAN earn something are left alone: mixed drops, an unrecorded manifest, no manifest", async () => {
  await db();
  for (const [tag, probeDrops, watchVersion] of [
    ["mixed", [watch(60), sub()], 1],
    ["unrec", [sub()], 0],
    ["nomani", null, 1],
  ]) {
    await clearTasks();
    const f = await sharedBotFixture(tag, { probeDrops: probeDrops || [sub()] });
    if (!probeDrops) await CampaignDrops.deleteMany({ campaignId: tag + "-probe" });
    else await CampaignDrops.updateOne({ campaignId: tag + "-probe" }, { $set: { watchVersion } });
    const before = fs.readFileSync(path.join(tmpDir, "config_44.json"), "utf8");
    assert.equal(await autoFarmer.completeEndedTasks(), 0, tag);
    assert.equal((await AutoFarmTask.findById(f.task._id).lean()).status, "active", tag);
    assert.equal(fs.readFileSync(path.join(tmpDir, "config_44.json"), "utf8"), before, tag + ": config untouched");
    assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: f.probeOnly }, status: "claimed" }), 3, tag);
    assert.equal((await DropSet.findById(f.set._id).lean()).catalogState, "preorder", tag);
    assert.deepEqual(restarted, [], tag);
  }
});

test("only probes are ended early: a farm task on a subscriber-only campaign keeps running", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("farmrow", { decision: "farm" });
  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  assert.equal((await AutoFarmTask.findById(f.task._id).lean()).status, "active");
  assert.deepEqual(restarted, []);
});

test("a config that cannot be read defers the whole early end: nothing recycled, nothing marked, retried next tick", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("unread");
  const good = fs.readFileSync(path.join(tmpDir, "config_44.json"), "utf8");
  fs.writeFileSync(path.join(tmpDir, "config_44.json"), "{ not json");

  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  const t = await AutoFarmTask.findById(f.task._id).lean();
  assert.equal(t.status, "active", "still a live task");
  assert.equal(t.completedAt, null);
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: f.probeOnly }, status: "claimed" }), 3, "accounts a bot may still run are not handed back");
  assert.equal((await DropSet.findById(f.set._id).lean()).catalogState, "preorder");
  assert.equal(await AutoFarmEvent.countDocuments({ type: "task_completed" }), 0);
  assert.deepEqual(restarted, []);

  // The config comes back; the next tick finishes the job.
  fs.writeFileSync(path.join(tmpDir, "config_44.json"), good);
  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  assert.equal((await AutoFarmTask.findById(f.task._id).lean()).status, "completed");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: f.probeOnly }, status: "available" }), 3);
});

test("an unreachable farm host defers it too, before anything is touched", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("offline");
  hostDown = true;
  const started = Date.now();
  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  hostDown = false;
  assert.equal((await AutoFarmTask.findById(f.task._id).lean()).status, "active");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: f.probeOnly }, status: "claimed" }), 3);
  assert.deepEqual(restarted, []);
  assert.ok(Date.now() - started < 20000);
  assert.equal(await autoFarmer.completeEndedTasks(), 1, "and it goes through once the host answers");
});

test("an early end interrupted after its first bot repeats cleanly: trimmed accounts are found trimmed", async () => {
  await db();
  await clearTasks();
  const game = "Stuck twobots";
  const a = ["two_a1", "two_a2"];
  const b = ["two_b1"];
  await campaign(game, "two-probe", { drops: [sub()] });
  await campaign("Cotenant twobots", "two-other", { drops: [watch(60)] });
  writeConfig("config_44.json", [...a.map((u) => user(u, [game])), user("two_c1", ["Cotenant twobots"])]);
  writeConfig("config_60.json", [...b.map((u) => user(u, [game])), user("two_c2", ["Cotenant twobots"])]);
  await poolRows([...a, ...b], "auto-farm: " + game);
  const bot60 = { host: "tmp", file: "config_60.json", container: "twitchbotx60" };
  const task = await probeTask(game, "two-probe", { accounts: [...a, ...b], bots: [bot44, bot60] });
  await probeTask("Cotenant twobots", "two-other", { accounts: ["two_c1", "two_c2"], bots: [bot44, bot60], decision: "farm" });

  const good60 = fs.readFileSync(path.join(tmpDir, "config_60.json"), "utf8");
  fs.writeFileSync(path.join(tmpDir, "config_60.json"), "{ not json");
  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  assert.deepEqual(restarted, ["twitchbotx44"], "the first bot was rewritten");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: [...a, ...b] }, status: "claimed" }), 3, "but nothing is recycled until every bot is done");
  assert.equal((await AutoFarmTask.findById(task._id).lean()).status, "active");

  fs.writeFileSync(path.join(tmpDir, "config_60.json"), good60);
  restarted.length = 0;
  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  assert.deepEqual(restarted, ["twitchbotx60"], "the already-trimmed bot is not reloaded again");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: [...a, ...b] }, status: "available" }), 3);
  for (const u of readConfig("config_44.json").filter((x) => a.includes(x.Login))) assert.equal(u.Enabled, false);
  for (const u of readConfig("config_60.json").filter((x) => b.includes(x.Login))) assert.equal(u.Enabled, false);
});

test("a probe whose bot is its own is stopped, and its accounts all come back", async () => {
  await db();
  await clearTasks();
  const game = "Stuck dedicated";
  const accounts = ["ded_1", "ded_2"];
  await campaign(game, "ded-probe", { drops: [sub(2)] });
  writeConfig("config_71.json", accounts.map((u) => user(u, [game])));
  await poolRows(accounts, "auto-farm backfill: " + game);
  const task = await probeTask(game, "ded-probe", { accounts, bots: [{ host: "tmp", file: "config_71.json", container: "twitchbotx71" }] });
  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  assert.deepEqual(stopped, ["twitchbotx71"]);
  assert.deepEqual(restarted, []);
  assert.equal((await AutoFarmTask.findById(task._id).lean()).status, "completed");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: accounts }, status: "available" }), 2);
});

test("an unreachable host defers a probe with its own bot as well: a stop that cannot be confirmed recycles nothing", async () => {
  await db();
  await clearTasks();
  // Stopping a dedicated bot swallows its errors ("the container may already
  // be gone"), so on a host that is not answering only the reachability check
  // stands between a still-running bot and its accounts going back to the pool.
  const game = "Stuck dedicated offline";
  const accounts = ["dedoff_1", "dedoff_2"];
  await campaign(game, "dedoff-probe", { drops: [sub()] });
  writeConfig("config_72.json", accounts.map((u) => user(u, [game])));
  await poolRows(accounts, "auto-farm: " + game);
  const task = await probeTask(game, "dedoff-probe", { accounts, bots: [{ host: "tmp", file: "config_72.json", container: "twitchbotx72" }] });
  hostDown = true;
  assert.equal(await autoFarmer.completeEndedTasks(), 0);
  hostDown = false;
  assert.deepEqual(stopped, [], "the bot was not touched");
  assert.equal((await AutoFarmTask.findById(task._id).lean()).status, "active");
  assert.equal(await AvailableAccount.countDocuments({ usernameLower: { $in: accounts }, status: "claimed" }), 2);
  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  assert.deepEqual(stopped, ["twitchbotx72"]);
});

test("switched off (autoFarm.subOnlyGuard: false), both engines decide as before and no probe is ended early", async () => {
  await db();
  await clearTasks();
  assert.equal(farmability.guardOn({}), true, "on unless switched off");
  assert.equal(farmability.guardOn(undefined), true);
  assert.equal(farmability.guardOn({ subOnlyGuard: true }), true);
  assert.equal(farmability.guardOn({ subOnlyGuard: false }), false);
  const off = af({ subOnlyGuard: false });

  // The lane's decide step.
  const game = "Switch Off Game";
  await untested(game);
  await campaign(game, "switch-sub", { drops: [sub()] });
  const c = await TwitchCampaign.findOne({ campaignId: "switch-sub" }).lean();
  const v = await decideStep.decideCampaign({
    campaign: c,
    lane: await liveLane(game),
    cycle: null,
    af: off,
    shadow: false,
    hostCache: new Map(),
    ctx: { hostOnline: false, host: null },
  });
  assert.equal(v.decision, "skip_host_offline", "decided by the old stages, as a probe candidate");

  // The legacy engine.
  await AutoFarmTask.deleteMany({ game });
  const out = await autoFarmer.processCampaign(c, { af: off, host: HOST, hostOnline: false, budgetMap: new Map(), priorTasks: new Map() });
  assert.equal(out.decision, "skip_host_offline");

  // The early end reads the live setting.
  await clearTasks();
  const f = await sharedBotFixture("switch");
  settings.getAutoFarm = () => off;
  try {
    assert.equal(await autoFarmer.completeEndedTasks(), 0);
    assert.equal((await AutoFarmTask.findById(f.task._id).lean()).status, "active");
    assert.deepEqual(restarted, []);
  } finally {
    settings.getAutoFarm = () => af();
  }
  assert.equal(await autoFarmer.completeEndedTasks(), 1, "and back on, it is ended");
});

test("the ordinary campaign end is unchanged: cooldown stamp, game-affinity note, pre-order left to the catalog sweep", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("ended", { probeDrops: [watch(60)] });
  await TwitchCampaign.updateOne({ campaignId: "ended-probe" }, { $set: { endAt: new Date(Date.now() - 60000) } });

  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  const t = await AutoFarmTask.findById(f.task._id).lean();
  assert.equal(t.status, "completed");
  assert.equal(t.probeOutcome, "expired", "a probe that ran its course with 0 sales still owes the cooldown");
  for (const u of f.probeOnly) {
    const row = await AvailableAccount.findOne({ usernameLower: u }).lean();
    assert.equal(row.status, "available");
    assert.equal(row.claimedNote, "recycled after " + f.game);
  }
  assert.equal((await AutoFarmEvent.findOne({ type: "task_completed", taskId: f.task._id }).lean()).reason, "probe ended — 0 sales");
  const set = await DropSet.findById(f.set._id).lean();
  assert.equal(set.listed, true, "untouched here");
  assert.equal(set.catalogState, "preorder");
});

test("a subscriber-only campaign that has ENDED takes the ordinary path, not the early one", async () => {
  await db();
  await clearTasks();
  const f = await sharedBotFixture("endedsub");
  await TwitchCampaign.updateOne({ campaignId: "endedsub-probe" }, { $set: { status: "EXPIRED", active: false } });
  assert.equal(await autoFarmer.completeEndedTasks(), 1);
  assert.equal((await AutoFarmEvent.findOne({ type: "task_completed", taskId: f.task._id }).lean()).reason, "probe ended — 0 sales");
  assert.equal((await AvailableAccount.findOne({ usernameLower: f.probeOnly[0] }).lean()).claimedNote, "recycled after " + f.game);
});
