// The "missing old stuff" audit, pinned.
//
// Read against utils/autoFarmer.js processCampaign/executeTask/runOnce, the
// lane engine's decide -> execute -> list path lacked six things the legacy
// engine does for the same campaign, and carried two bugs of its own:
//
//   1. re-decided EVERY campaign EVERY cycle (5,400 rows/day on prod) where
//      legacy re-decides only on four triggers            -> lane.decisionDue
//   2. no reuse TOP-UP (fresh accounts above what the warm bots freely cover;
//      fired 17 times in 60 days on prod)                  -> execute.executeReuse
//   3. no Telegram trail for reuses, terminal skips, listings
//   4. no AutoFarmEvent trail for reuses, listings, failures
//   5. no listing.error on a throwing publish
//   6. research fetched per campaign, not per game per cycle
//   7. BUG: the cycle budget was capped at marketStockFloor (a per-campaign
//      MINIMUM read as a fleet ceiling) and at seats in FREE containers
//   8. BUG: upsertTask re-stamped a probe's stop-loss anchor on every upsert
//
// Every test here drives the real module code against an in-memory Mongo; the
// host, the container factory, the lister and the notifier are the only stubs.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const FarmJob = require("../models/FarmJob");
const FarmLane = require("../models/FarmLane");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const autoFarmer = require("../utils/autoFarmer");
const autoLister = require("../utils/autoLister");
const botFactory = require("../utils/botFactory");
const botWaker = require("../utils/botWaker");
const notify = require("../utils/farm2/notify");
const laneMod = require("../utils/farm2/lane");
const decideStep = require("../utils/farm2/steps/decide");
const executeStep = require("../utils/farm2/steps/execute");
const publishStep = require("../utils/farm2/steps/publish");
const verifyStep = require("../utils/farm2/steps/verify");
const budget = require("../utils/farm2/budget");
const farm2 = require("../utils/farm2");
const settings = require("../utils/settings");

let mem;
const sent = [];
const orig = {
  telegram: notify.telegram,
  start: botFactory.startContainer,
  registry: botWaker.readRegistry,
  executeTask: autoFarmer.executeTask,
  resolveFarmHost: autoFarmer.resolveFarmHost,
  countReadyPool: autoFarmer.countReadyPool,
  researchForGame: autoFarmer.researchForGame,
  manualFarmMap: autoFarmer.manualFarmMap,
  campaignItems: autoLister.campaignItems,
  pickDeliveryAccounts: autoLister.pickDeliveryAccounts,
  listActivatedTask: autoLister.listActivatedTask,
};

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2parity"));
  await FarmJob.init();
  await AutoFarmTask.init();
  notify.telegram = async (text) => {
    sent.push(text);
  };
  botFactory.startContainer = async () => {};
  botWaker.readRegistry = async () => ({});
});

test.after(async () => {
  Object.assign(notify, { telegram: orig.telegram });
  botFactory.startContainer = orig.start;
  botWaker.readRegistry = orig.registry;
  autoFarmer.executeTask = orig.executeTask;
  autoFarmer.resolveFarmHost = orig.resolveFarmHost;
  autoFarmer.countReadyPool = orig.countReadyPool;
  autoFarmer.researchForGame = orig.researchForGame;
  autoFarmer.manualFarmMap = orig.manualFarmMap;
  autoLister.campaignItems = orig.campaignItems;
  autoLister.pickDeliveryAccounts = orig.pickDeliveryAccounts;
  autoLister.listActivatedTask = orig.listActivatedTask;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const af = (o = {}) => ({
  ...settings.getAutoFarm(),
  probeColdStart: false,
  dryRun: false,
  minHoursLeft: 12,
  maxPerGame: 30,
  poolReserve: 20,
  platiCategoryId: "",
  forceGames: [],
  ...o,
});

/* --------------------------- 1. the candidate filter ---------------------- */

test("the lane's retryable set IS the legacy engine's", () => {
  assert.ok(autoFarmer.RETRYABLE instanceof Set, "autoFarmer exports RETRYABLE");
  assert.deepEqual([...laneMod.retryableSet()].sort(), [...autoFarmer.RETRYABLE].sort());
  assert.deepEqual([...laneMod.RETRYABLE_FALLBACK].sort(), [...autoFarmer.RETRYABLE].sort(), "the fallback copy has not drifted");
});

test("decisionDue mirrors the legacy candidate filter, trigger by trigger", () => {
  const live = { shadow: false, af: af() };
  assert.equal(laneMod.decisionDue({ existing: null, ...live }).why, "new");
  for (const d of autoFarmer.RETRYABLE) {
    assert.equal(laneMod.decisionDue({ existing: { status: "skipped", decision: d }, ...live }).why, "retryable", d);
  }
  // Terminal skips are decided ONCE, as legacy decides them.
  for (const d of ["skip_low_demand", "skip_ends_soon"]) {
    assert.equal(laneMod.decisionDue({ existing: { status: "skipped", decision: d }, ...live }).due, false, d);
  }
  // Acted-on campaigns are settled.
  for (const status of ["active", "completed", "stopped"]) {
    assert.equal(laneMod.decisionDue({ existing: { status, decision: "farm", bots: [{}] }, ...live }).due, false, status);
  }
  assert.equal(laneMod.decisionDue({ existing: { status: "active", decision: "farm", rescanRequested: true }, ...live }).why, "rescan");
  // Stranded: a plan that never executed, or a failure that owns nothing — live mode only.
  assert.equal(laneMod.decisionDue({ existing: { status: "planned", decision: "farm" }, ...live }).why, "stranded");
  assert.equal(laneMod.decisionDue({ existing: { status: "failed", decision: "farm", bots: [] }, ...live }).why, "stranded");
  assert.equal(laneMod.decisionDue({ existing: { status: "failed", decision: "farm", bots: [{ container: "x" }] }, ...live }).due, false, "a failure that owns bots is left alone");
  assert.equal(laneMod.decisionDue({ existing: { status: "planned", decision: "farm" }, shadow: false, af: af({ dryRun: true }) }).due, false, "under dry-run a plan awaits approval, as legacy leaves it");
});

test("a SHADOW lane additionally re-decides once against each fresh legacy decision — and only once", () => {
  const shadow = { shadow: true, af: af() };
  const fresh = { status: "active", decision: "reuse_existing", bots: [{}], decidedAt: hoursAgo(1) };
  assert.equal(laneMod.decisionDue({ existing: fresh, ...shadow, lastLaneDecidedAt: null }).why, "fresh legacy decision");
  assert.equal(laneMod.decisionDue({ existing: fresh, ...shadow, lastLaneDecidedAt: hoursAgo(2) }).why, "fresh legacy decision", "the lane's last decision predates legacy's");
  assert.equal(laneMod.decisionDue({ existing: fresh, ...shadow, lastLaneDecidedAt: hoursAgo(0.5) }).due, false, "already compared against this legacy decision");
  const stale = { ...fresh, decidedAt: hoursAgo(30) };
  assert.equal(laneMod.decisionDue({ existing: stale, ...shadow, lastLaneDecidedAt: null }).due, false, "beyond the comparison window a re-decision would only be discarded as stale");
  assert.equal(laneMod.decisionDue({ existing: fresh, shadow: false, af: af(), lastLaneDecidedAt: null }).due, false, "a LIVE lane has no such trigger");
});

test("END TO END: a live lane decides a terminal skip ONCE, announces it once, then leaves it settled", async () => {
  const game = "Parity Terminal Game";
  const gameKey = settings.normGameName(game);
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    FarmJob.deleteMany({ lane: game }),
    FarmLane.deleteMany({ gameKey }),
    TwitchCampaign.deleteMany({ campaignId: "pt-1" }),
    MarketResearch.deleteMany({ game }),
  ]);
  // Junk demand: the sellability gate skips it — terminal.
  await MarketResearch.create({ game, demandScore: 2, sellers: 30, scannedAt: new Date() });
  await TwitchCampaign.create({ campaignId: "pt-1", name: "Weekly", game, status: "ACTIVE", active: true, endAt: hoursFromNow(48) });
  const lane = (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();
  sent.length = 0;

  const s1 = await laneMod.runLane(lane, { cycle: null, af: af(), hostCache: new Map() });
  assert.equal(s1.decisions.length, 1);
  assert.equal(s1.decisions[0].decision, "skip_low_demand");
  assert.equal(s1.decisions[0].trigger, "new");
  assert.equal(s1.skipsRecorded, 1);
  assert.equal(s1.notified, 1, "the terminal verdict is announced");
  assert.match(sent[0], /Auto-farm SKIP \(lane\) — Parity Terminal Game/);
  assert.match(sent[0], /Effective demand/);

  const s2 = await laneMod.runLane(lane, { cycle: null, af: af(), hostCache: new Map() });
  assert.equal(s2.decisions.length, 0, "decided once, as legacy decides it");
  assert.equal(s2.settled, 1);
  assert.equal(s2.notified, 0);
  assert.equal(await FarmJob.countDocuments({ lane: game, kind: "decide" }), 1, "one decide row, not one per cycle");
});

test("END TO END: a RETRYABLE skip is re-decided every cycle but announced only on the transition", async () => {
  const game = "Parity Retry Game";
  const gameKey = settings.normGameName(game);
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    FarmJob.deleteMany({ lane: game }),
    FarmLane.deleteMany({ gameKey }),
    TwitchCampaign.deleteMany({ campaignId: "pr-1" }),
    MarketResearch.deleteMany({ game }),
  ]);
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
  await TwitchCampaign.create({ campaignId: "pr-1", name: "Weekly", game, status: "ACTIVE", active: true, endAt: hoursFromNow(48) });
  const lane = (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();
  sent.length = 0;
  // No such host → skip_host_offline, a RETRYABLE skip legacy never announces.
  const a = af({ hostId: "does-not-exist-xyz" });
  const s1 = await laneMod.runLane(lane, { cycle: null, af: a, hostCache: new Map() });
  assert.equal(s1.decisions[0].decision, "skip_host_offline");
  assert.equal(s1.notified, 0, "legacy sends nothing for a host-offline skip; neither does the lane");
  const s2 = await laneMod.runLane(lane, { cycle: null, af: a, hostCache: new Map() });
  assert.equal(s2.decisions.length, 1, "retryable — re-decided");
  assert.equal(s2.decisions[0].trigger, "retryable");
  assert.equal(sent.length, 0);
});

test("skipAnnouncement: the legacy texts, on the legacy triggers, and silence elsewhere", () => {
  const base = { game: "G", effectiveDemand: 3.7, reason: "Effective demand 3.7 (...)" };
  assert.match(laneMod.skipAnnouncement({ ...base, decision: "skip_low_demand" }, null), /Effective demand 3.7 \(items not salable\)/);
  assert.match(laneMod.skipAnnouncement({ ...base, decision: "skip_low_demand", reason: "Untested market, but within the post-failure cooldown" }, null), /cooldown/);
  assert.equal(laneMod.skipAnnouncement({ ...base, decision: "skip_low_demand" }, "skip_low_demand"), null, "a repeat is not re-announced");
  const cov = { manualFarmers: 1, archiveHolders: 31, stashHolders: 2, otherHolders: 5 };
  const covered = laneMod.skipAnnouncement({ ...base, decision: "skip_already_covered", coverage: cov, targetAccounts: 30 }, "skip_no_accounts");
  assert.match(covered, /Already covered: 31 of its own unsold accounts ≥ target 30/);
  assert.match(covered, /Not counted: 1 manual farmer/);
  assert.equal(laneMod.skipAnnouncement({ ...base, decision: "skip_already_covered", coverage: cov }, "skip_already_covered"), null);
  for (const d of ["skip_host_offline", "skip_ends_soon", "skip_no_accounts", "skip_no_capacity", "skip_reuse_only", "skip_probe_budget"]) {
    assert.equal(laneMod.skipAnnouncement({ ...base, decision: d }, null), null, d + " is silent in legacy");
  }
});

/* ------------------------------ 7. the budget ----------------------------- */

test("the cycle budget is the spendable pool — not capped by the market floor, not by free-container seats", async () => {
  autoFarmer.countReadyPool = async () => 340;
  await AutoFarmTask.deleteMany({ game: "Budget Cap Game" });
  // Every container slot in use: free containers = 0, so free-container seats = 0.
  const bots = Array.from({ length: 12 }, (_, i) => ({ host: "pi", file: `c${i}.json`, container: `bot${i}` }));
  await AutoFarmTask.create({ game: "Budget Cap Game", campaignId: "bc", decision: "farm", status: "active", bots });
  try {
    const c = await budget.computeCycleBudget(af({ poolReserve: 20, maxAutoBots: 12, accountsPerBot: 120, perMarketStock: 3, maxPerGame: 30 }));
    assert.equal(c.totalAccounts, 320, "340 ready − 20 reserve, as legacy's fairShare budget");
    assert.equal(c.totalContainers, 0);
    assert.equal(c.totalSeats, 0, "seats in free containers — a capacity input, not the account budget");
    assert.doesNotMatch(c.reason, /market stock floor/);
    // Six live lanes each get their full ask, where the floor-capped budget gave them 3 each.
    c.allocate(Array.from({ length: 6 }, (_, i) => ({ key: "l" + i, want: 30, weight: 2 })));
    for (let i = 0; i < 6; i += 1) assert.equal(c.grantFor("l" + i).accounts, 30);
  } finally {
    autoFarmer.countReadyPool = orig.countReadyPool;
    await AutoFarmTask.deleteMany({ game: "Budget Cap Game" });
  }
});

/* ------------------------- 2. the reuse top-up: decide -------------------- */

async function warmGame(game, campaignId, held, { hoursLeft = 48, demand = 90 } = {}) {
  const gameKey = settings.normGameName(game);
  await Promise.all([
    AutoFarmTask.deleteMany({ game }),
    FarmJob.deleteMany({ lane: game }),
    FarmLane.deleteMany({ gameKey }),
    TwitchCampaign.deleteMany({ campaignId }),
    MarketResearch.deleteMany({ game }),
    AutoFarmEvent.deleteMany({ game }),
  ]);
  await MarketResearch.create({ game, demandScore: demand, sellers: 8, scannedAt: new Date() });
  await TwitchCampaign.create({ campaignId, name: "Weekly", game, status: "ACTIVE", active: true, endAt: hoursFromNow(hoursLeft) });
  const prefix = gameKey.replace(/[^a-z0-9]+/g, "") + "_";
  const source = await AutoFarmTask.create({
    game,
    campaignId: "old-" + campaignId,
    decision: "farm",
    status: "completed",
    assignedAccounts: Array.from({ length: held }, (_, i) => prefix + (i + 1)),
    bots: [{ host: "local", file: "config_warm.json", container: "botwarm" }],
    createdAt: hoursAgo(20),
  });
  const cache = new Map();
  cache.set("local|config_warm.json", true); // the bot file exists — no host read
  cache.set("__farm2:host", Promise.resolve({ host: { id: "local", label: "Local" }, hostOnline: true }));
  return { gameKey, source, cache };
}

test("a reuse verdict carries the top-up it wants: alloc.target − reused, allowed only when fresh accounts can finish", async () => {
  const game = "TopUp Decide Game";
  const { cache } = await warmGame(game, "td-1", 19);
  const c = await TwitchCampaign.findOne({ campaignId: "td-1" }).lean();
  const v = await decideStep.decideCampaign({ campaign: c, lane: { game, gameKey: settings.normGameName(game), mode: "live" }, cycle: null, af: af(), shadow: false, hostCache: cache });
  assert.equal(v.decision, "reuse_existing");
  assert.equal(v.plannedAccounts, 19, "plannedAccounts stays the reused count, as legacy records it");
  assert.equal(v.allocTarget, 30, "a proven seller's full-tier target");
  assert.equal(v.topUpWanted, 11, "alloc.target − mine");
  assert.equal(v.topUpAllowed, true, "48h left ≥ minHoursLeft");
  assert.equal(v.wouldFarm, true);

  // A short campaign: reuse still wins (warm bots finish it) but no top-up —
  // fresh accounts start from zero watch-time and cannot.
  const short = await warmGame("TopUp Short Game", "td-2", 19, { hoursLeft: 6 });
  const c2 = await TwitchCampaign.findOne({ campaignId: "td-2" }).lean();
  const v2 = await decideStep.decideCampaign({ campaign: c2, lane: { game: "TopUp Short Game", gameKey: short.gameKey, mode: "live" }, cycle: null, af: af(), shadow: false, hostCache: short.cache });
  assert.equal(v2.decision, "reuse_existing");
  assert.equal(v2.topUpWanted, 11);
  assert.equal(v2.topUpAllowed, false);
  // …unless the game is forced.
  const v3 = await decideStep.decideCampaign({ campaign: c2, lane: { game: "TopUp Short Game", gameKey: short.gameKey, mode: "live" }, cycle: null, af: af({ forceGames: ["TopUp Short Game"] }), shadow: false, hostCache: short.cache });
  assert.equal(v3.topUpAllowed, true);
});

test("a campaign whose warm accounts are all spoken for is still worth executing when a top-up is possible", async () => {
  const game = "TopUp Spoken Game";
  const { source, cache } = await warmGame(game, "ts-1", 10);
  // A sibling campaign for the same game holds every warm account.
  // Older than the warm source so reusableTaskForGame (newest first) still
  // picks the source; the sibling then speaks for every one of its accounts.
  await AutoFarmTask.create({ game, campaignId: "ts-sib", decision: "reuse_existing", status: "active", assignedAccounts: source.assignedAccounts, bots: source.bots, executedAt: new Date(), createdAt: hoursAgo(30) });
  const c = await TwitchCampaign.findOne({ campaignId: "ts-1" }).lean();
  const v = await decideStep.decideCampaign({ campaign: c, lane: { game, gameKey: settings.normGameName(game), mode: "live" }, cycle: null, af: af(), shadow: false, hostCache: cache });
  assert.equal(v.decision, "reuse_existing");
  assert.equal(v.plannedAccounts, 0);
  assert.equal(v.topUpWanted, 30);
  assert.equal(v.wouldFarm, true, "legacy would restart and top up; so must the lane");
});

/* ----------------------------- 6. research memo --------------------------- */

test("research and sales are read once per game per cycle, as the legacy tick's infoMap does", async () => {
  const game = "Memo Game";
  const { cache } = await warmGame(game, "mm-1", 5);
  await TwitchCampaign.create({ campaignId: "mm-2", name: "Weekly 2", game, status: "ACTIVE", active: true, endAt: hoursFromNow(48) });
  let reads = 0;
  autoFarmer.researchForGame = async (g) => {
    reads += 1;
    return orig.researchForGame(g);
  };
  try {
    const lane = { game, gameKey: settings.normGameName(game), mode: "shadow" };
    for (const id of ["mm-1", "mm-2"]) {
      const c = await TwitchCampaign.findOne({ campaignId: id }).lean();
      await decideStep.decideCampaign({ campaign: c, lane, cycle: null, af: af(), shadow: true, hostCache: cache });
    }
    assert.equal(reads, 1, "two campaigns, one research read");
    // A fresh cycle (new cache) reads again.
    const c = await TwitchCampaign.findOne({ campaignId: "mm-1" }).lean();
    const cache2 = new Map([...cache]);
    for (const k of [...cache2.keys()]) if (String(k).startsWith("__farm2:info")) cache2.delete(k);
    await decideStep.decideCampaign({ campaign: c, lane, cycle: null, af: af(), shadow: true, hostCache: cache2 });
    assert.equal(reads, 2);
  } finally {
    autoFarmer.researchForGame = orig.researchForGame;
  }
});

/* ---------------------- 2. the reuse top-up: execute ---------------------- */

function reuseVerdict(game, campaignId, source, over = {}) {
  return {
    game,
    campaignId,
    campaignName: "Weekly",
    campaignEndAt: hoursFromNow(48),
    decision: "reuse_existing",
    reuseTaskId: source._id,
    demandScore: 90,
    hadResearch: true,
    internalSales: 0,
    reason: "recurring campaign",
    topUpAllowed: true,
    topUpWanted: 11,
    ...over,
  };
}
const host = { id: "pi", label: "Pi", transport: "ssh" };

test("executeReuse tops up through executeTask in APPEND mode with exactly the granted count", async () => {
  const game = "TopUp Exec Game";
  const { source } = await warmGame(game, "te-1", 19);
  const calls = [];
  autoFarmer.executeTask = async (task, ctx, opts) => {
    calls.push({ task, ctx, opts });
    return { accounts: 7, bots: [] };
  };
  sent.length = 0;
  try {
    const r = await executeStep.executeReuse({ verdict: reuseVerdict(game, "te-1", source), dryRun: false, af: af(), host, granted: 11 });
    assert.equal(r.accounts, 19);
    assert.equal(r.toppedUp, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.append, true, "append — never the overwrite path");
    assert.equal(calls[0].task.plannedAccounts, 11, "the ceiling is the arbiter's grant");
    assert.equal(calls[0].task.assignedAccounts.length, 19, "the reused accounts ride along so append merges, not overwrites");
    assert.equal(calls[0].ctx.host, host);
    const row = await AutoFarmTask.findOne({ game, campaignId: "te-1" }).lean();
    assert.equal(row.status, "active");
    assert.equal(row.plannedAccounts, 19, "the row's plannedAccounts is the reused count — legacy never persists the top-up there either");
    const ev = await AutoFarmEvent.find({ game }).lean();
    assert.deepEqual(ev.map((e) => e.type), ["task_started"]);
    assert.equal(ev[0].count, 19);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Auto-farm REUSE \(lane\) — TopUp Exec Game/);
    assert.match(sent[0], /Topped up with 7 fresh account/);
  } finally {
    autoFarmer.executeTask = orig.executeTask;
  }
});

test("no top-up when it is not allowed, not granted, or there is no farm host — the reuse still stands", async () => {
  const game = "TopUp Gate Game";
  const { source } = await warmGame(game, "tg-1", 5);
  let calls = 0;
  autoFarmer.executeTask = async () => {
    calls += 1;
    return { accounts: 1 };
  };
  try {
    for (const [label, args] of [
      ["not allowed", { verdict: reuseVerdict(game, "tg-1", source, { topUpAllowed: false }), granted: 11, host }],
      ["not granted", { verdict: reuseVerdict(game, "tg-1", source), granted: 0, host }],
      ["no host", { verdict: reuseVerdict(game, "tg-1", source), granted: 11, host: null }],
    ]) {
      await AutoFarmTask.deleteMany({ game, campaignId: "tg-1" });
      const r = await executeStep.executeReuse({ ...args, dryRun: false, af: af() });
      assert.equal(calls, 0, label);
      assert.equal(r.accounts, 5, label);
      assert.equal(r.toppedUp, 0, label);
      assert.equal((await AutoFarmTask.findOne({ game, campaignId: "tg-1" }).lean()).status, "active", label);
    }
  } finally {
    autoFarmer.executeTask = orig.executeTask;
  }
});

test("a top-up shortage is swallowed exactly as legacy swallows it — the reuse stands on its restarted bots", async () => {
  const game = "TopUp Short Exec Game";
  const { source } = await warmGame(game, "tse-1", 5);
  autoFarmer.executeTask = async () => {
    throw new Error("Pool below reserve floor (12 ready, reserve 20)");
  };
  try {
    const r = await executeStep.executeReuse({ verdict: reuseVerdict(game, "tse-1", source), dryRun: false, af: af(), host, granted: 11 });
    assert.equal(r.accounts, 5);
    assert.equal(r.toppedUp, 0);
    assert.match(r.topUpError, /reserve floor/);
    assert.equal((await AutoFarmTask.findOne({ game, campaignId: "tse-1" }).lean()).status, "active");
  } finally {
    autoFarmer.executeTask = orig.executeTask;
  }
});

test("nothing to reuse + a top-up: the skip row is written FIRST and becomes an active reuse only when fresh accounts land", async () => {
  const game = "TopUp Empty Game";
  const { source } = await warmGame(game, "tem-1", 10);
  await AutoFarmTask.create({ game, campaignId: "tem-sib", decision: "reuse_existing", status: "active", assignedAccounts: source.assignedAccounts, bots: source.bots, executedAt: new Date(), createdAt: hoursAgo(30) });

  // (a) the claim finds nothing: the retryable skip stands, no ACTIVE row without accounts.
  autoFarmer.executeTask = async () => {
    throw new Error("Could not claim any pool accounts");
  };
  try {
    const r = await executeStep.executeReuse({ verdict: reuseVerdict(game, "tem-1", source, { topUpWanted: 30 }), dryRun: false, af: af(), host, granted: 30 });
    assert.equal(r.accounts, 0);
    assert.equal(r.toppedUp, 0);
    const row = await AutoFarmTask.findOne({ game, campaignId: "tem-1" }).lean();
    assert.equal(row.status, "skipped");
    assert.equal(row.decision, "skip_no_accounts");
    assert.equal(await AutoFarmTask.countDocuments({ game, status: "active", "assignedAccounts.0": { $exists: false } }), 0, "the §11 predicate: never an ACTIVE row with no accounts");
  } finally {
    autoFarmer.executeTask = orig.executeTask;
  }

  // (b) fresh accounts land: executeTask (stubbed here as the real one writes)
  // promotes the row to ACTIVE with the new accounts; the lane then names it
  // the reuse it is.
  autoFarmer.executeTask = async (task) => {
    await AutoFarmTask.updateOne({ _id: task._id }, { $set: { status: "active", bots: [...task.bots, { host: "pi", file: "config_new.json", container: "botnew" }], assignedAccounts: ["fresh1", "fresh2", "fresh3"], executedAt: new Date() } });
    return { accounts: 3, bots: [] };
  };
  try {
    const r = await executeStep.executeReuse({ verdict: reuseVerdict(game, "tem-1", source, { topUpWanted: 30 }), dryRun: false, af: af(), host, granted: 30 });
    assert.equal(r.toppedUp, 3);
    const row = await AutoFarmTask.findOne({ game, campaignId: "tem-1" }).lean();
    assert.equal(row.status, "active");
    assert.equal(row.decision, "reuse_existing", "legacy's shape: a reuse that farms the event on fresh accounts");
    assert.deepEqual(row.assignedAccounts, ["fresh1", "fresh2", "fresh3"]);
    assert.equal(row.bots.length, 2, "the warm bot plus the new one");
    assert.equal(row.targetAccounts, 3);
  } finally {
    autoFarmer.executeTask = orig.executeTask;
  }
});

test("a restart that starts nothing records task_failed and throws — as legacy records it", async () => {
  const game = "Reuse Fail Game";
  const { source } = await warmGame(game, "rf-1", 5);
  botFactory.startContainer = async () => {
    throw new Error("docker: no such container");
  };
  try {
    await assert.rejects(() => executeStep.executeReuse({ verdict: reuseVerdict(game, "rf-1", source), dryRun: false, af: af(), host, granted: 0 }), /no bot could be restarted/);
    const ev = await AutoFarmEvent.find({ game }).lean();
    assert.deepEqual(ev.map((e) => e.type), ["task_failed"]);
    assert.equal((await AutoFarmTask.findOne({ game, campaignId: "rf-1" }).lean()).status, "failed");
  } finally {
    botFactory.startContainer = async () => {};
  }
});

/* ----------------------- 2. the top-up through the lane ------------------- */

test("END TO END: a live lane's reuse draws only its TOP-UP from the arbiter, and the execute job carries the grant", async () => {
  const game = "TopUp Lane Game";
  const { gameKey, cache } = await warmGame(game, "tl-1", 19);
  const lane = (await FarmLane.create({ game, gameKey, mode: "live", state: "idle" })).toObject();
  const cycle = new budget.BudgetCycle({ accounts: 8, seats: 50, containers: 5, perGameCap: 30 });
  cycle.allocate([{ key: gameKey, want: 30, weight: 2 }]);
  assert.equal(cycle.grantFor(gameKey).accounts, 8);
  const calls = [];
  autoFarmer.executeTask = async (task, ctx, opts) => {
    calls.push({ task, opts });
    return { accounts: 8 };
  };
  autoFarmer.resolveFarmHost = () => host;
  try {
    const s = await laneMod.runLane(lane, { cycle, af: af(), hostCache: cache });
    const errs = s.errors.filter((e) => !/^(monitor|audit):/.test(e));
    assert.deepEqual(errs, [], errs.join("; "));
    assert.equal(s.decisions[0].decision, "reuse_existing");
    assert.equal(s.decisions[0].topUpWanted, 11);
    const job = await FarmJob.findOne({ lane: game, kind: "execute" }).lean();
    assert.equal(job.payload.granted, 8, "min(top-up wanted 11, allowance 8) — the 19 reused accounts cost nothing");
    assert.equal(cycle.grantFor(gameKey).spentAccounts, 8);
    assert.equal(s.executed.length, 1);
    assert.equal(s.executed[0].toppedUp, 8);
    assert.equal(calls[0].task.plannedAccounts, 8);
    assert.equal(calls[0].opts.append, true);
    // Next cycle: executed → settled.
    const s2 = await laneMod.runLane(lane, { cycle, af: af(), hostCache: cache });
    assert.equal(s2.settled, 1);
    assert.equal(s2.decisions.length, 0);
    assert.equal(calls.length, 1, "no second execution");
  } finally {
    autoFarmer.executeTask = orig.executeTask;
    autoFarmer.resolveFarmHost = orig.resolveFarmHost;
  }
});

/* ------------------------ 8. the probe stop-loss anchor ------------------- */

test("upsertTask never stamps probeStartedAt — that is executeTask's, on activation, once", async () => {
  await AutoFarmTask.deleteMany({ game: "Probe Anchor Game" });
  const v = { game: "Probe Anchor Game", campaignId: "pa-1", decision: "probe", probe: true, plannedAccounts: 5, targetAccounts: 5, reason: "probe" };
  const t = await executeStep.upsertTask(v, { dryRun: true });
  assert.equal(t.probeStartedAt, null);
  await AutoFarmTask.updateOne({ _id: t._id }, { $set: { probeStartedAt: hoursAgo(50) } });
  const again = await executeStep.upsertTask(v, { dryRun: true });
  assert.equal(Math.round((Date.now() - again.probeStartedAt) / 3600000), 50, "a re-decided probe keeps its anchor");
});

/* --------------------------- 3/4/5. publishing ---------------------------- */

async function listableTask(game, campaignId) {
  await AutoFarmTask.deleteMany({ game });
  await AutoFarmEvent.deleteMany({ game });
  return AutoFarmTask.create({ game, campaignId, campaignName: "Weekly", decision: "farm", status: "active", assignedAccounts: ["a1", "a2"], bots: [{ host: "pi", file: "c.json", container: "b" }], executedAt: new Date() });
}
const liveLane = (game) => ({ game, gameKey: settings.normGameName(game), mode: "live" });

test("publishPrimary records the listed event and the Telegram line the legacy sweep records", async () => {
  const game = "Publish Event Game";
  const t = await listableTask(game, "pe-1");
  autoLister.campaignItems = async () => [{ itemKey: "k", name: "Item", qty: 1 }];
  autoLister.pickDeliveryAccounts = async () => ["a1"];
  autoLister.listActivatedTask = async () => ({ listed: { title: "Weekly bundle", price: 2.5, qty: 1, url: "https://gameflip.test/x" } });
  sent.length = 0;
  try {
    const r = await publishStep.publishPrimary({ taskId: t._id, af: af(), shadow: false, lane: liveLane(game) });
    assert.equal(r.listed.title, "Weekly bundle");
    const ev = await AutoFarmEvent.find({ game }).lean();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, "listed");
    assert.equal(ev[0].count, 1);
    assert.equal(ev[0].reason, "Weekly bundle ($2.5)");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Auto-listed \(lane\) — Publish Event Game/);
  } finally {
    autoLister.campaignItems = orig.campaignItems;
    autoLister.pickDeliveryAccounts = orig.pickDeliveryAccounts;
    autoLister.listActivatedTask = orig.listActivatedTask;
  }
});

test("a throwing publish leaves listing.error on the task — the trace the Auto-farm tab reads — and still retries", async () => {
  const game = "Publish Throw Game";
  const t = await listableTask(game, "pt-1");
  autoLister.campaignItems = async () => [{ itemKey: "k", name: "Item", qty: 1 }];
  autoLister.pickDeliveryAccounts = async () => ["a1"];
  autoLister.listActivatedTask = async () => {
    throw new Error("Gameflip 429");
  };
  try {
    await assert.rejects(() => publishStep.publishPrimary({ taskId: t._id, af: af(), shadow: false, lane: liveLane(game) }), /429/);
    const row = await AutoFarmTask.findById(t._id).lean();
    assert.equal(row.listing.error, "auto-list failed: Gameflip 429");
    assert.equal(await AutoFarmEvent.countDocuments({ game }), 0, "no listed event for a failure");
  } finally {
    autoLister.campaignItems = orig.campaignItems;
    autoLister.pickDeliveryAccounts = orig.pickDeliveryAccounts;
    autoLister.listActivatedTask = orig.listActivatedTask;
  }
});

/* --------------------------- one verification per task -------------------- */

test("the per-cycle cache resolves a campaign's items once, and the audit reuses the monitor's checks", async () => {
  const game = "Verify Once Game";
  const gameKey = settings.normGameName(game);
  await listableTask(game, "vo-1");
  await AutoFarmTask.create({ game, campaignId: "vo-2", campaignName: "Weekly 2", decision: "farm", status: "active", assignedAccounts: ["b1"], bots: [{ host: "pi", file: "d.json", container: "b2" }], executedAt: new Date() });
  await FarmLane.deleteMany({ gameKey });
  await TwitchCampaign.deleteMany({ game });
  const lane = (await FarmLane.create({ game, gameKey, mode: "shadow", state: "idle" })).toObject();
  let items = 0;
  let picks = 0;
  autoLister.campaignItems = async () => {
    items += 1;
    return [{ itemKey: "k", name: "Item", qty: 1 }];
  };
  autoLister.pickDeliveryAccounts = async (task) => {
    picks += 1;
    return task.assignedAccounts.slice(0, 1);
  };
  try {
    const s = await laneMod.runLane(lane, { cycle: null, af: af(), hostCache: new Map() });
    assert.deepEqual(s.errors, []);
    assert.equal(s.monitor.active, 2);
    assert.equal(s.audit.tasks, 2);
    assert.equal(s.audit.listable, 2);
    assert.equal(s.audit.unlistedButReady, 2);
    assert.equal(items, 2, "one item resolution per campaign, shared by monitor and audit");
    assert.equal(picks, 2, "one holdings check per task, not two");
    assert.equal(s.monitor.checks, undefined, "the Map is not serialised into the summary");
    // A transient failure is not cached.
    const cache = new Map();
    autoLister.campaignItems = async () => {
      items += 1;
      if (items === 3) throw new Error("Twitch hiccup");
      return [{ itemKey: "k", name: "Item", qty: 1 }];
    };
    const t = await AutoFarmTask.findOne({ game, campaignId: "vo-1" }).lean();
    const first = await verifyStep.verifyTask(t, { cache });
    assert.match(first.reason, /could not resolve/);
    const second = await verifyStep.verifyTask(t, { cache });
    assert.equal(second.ok, true, "retried, not poisoned");
    assert.equal(items, 4);
  } finally {
    autoLister.campaignItems = orig.campaignItems;
    autoLister.pickDeliveryAccounts = orig.pickDeliveryAccounts;
  }
});

/* --------------------------- the readiness window ------------------------- */

test("readiness scores the recent window, not 25 rows — and nothing older than the day bound", async () => {
  const gameKey = "readiness window game";
  await FarmJob.deleteMany({ laneKey: gameKey });
  await FarmLane.deleteMany({ gameKey });
  const lane = await FarmLane.create({ game: "Readiness Window Game", gameKey, mode: "shadow" });
  const row = (i, agree, ageDays) =>
    FarmJob.create({
      lane: "Readiness Window Game",
      laneKey: gameKey,
      kind: "decide",
      campaignId: "c" + i,
      status: "done",
      shadow: true,
      createdAt: new Date(Date.now() - ageDays * 864e5),
      result: { verdict: { decision: agree ? "reuse_existing" : "farm" }, diff: { agree, laneClass: agree ? "reuse" : "spend", legacyClass: "reuse", stale: false, laneDecision: "x", legacyDecision: "reuse_existing", disagreementKind: agree ? "agree" : "class_mismatch" } },
    });
  // 40 recent agreements, then a disagreement that is 20 days old.
  for (let i = 0; i < 40; i += 1) await row(i, true, 1);
  await row(99, false, 20);
  const r = await farm2.laneReadiness(lane.toObject());
  assert.equal(r.compared, 40, "the old 25-row cap would have hidden 15 of these");
  assert.equal(r.disagreements, 0, "a 20-day-old row is outside the evidence window");
  assert.equal(r.ready, true, r.blockers.join("; "));
  assert.ok(farm2.READINESS_WINDOW_ROWS >= 100);
});
