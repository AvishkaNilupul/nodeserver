// Coverage for the six downstream gates in utils/farm2/steps/decide.js.
//
// Until these existed the lane engine implemented only the sellability stage
// and reuse-first. On any campaign the legacy engine settled with the host,
// time, coverage, pool-floor, capacity or reuse-only gate, a live lane would
// have carried on and spent fresh accounts. The gap went unobserved because the
// shadow comparison that should have surfaced it was itself broken — zero
// comparable pairs, zero chances to notice.
//
// Each test drives decideCampaign to exactly one gate and asserts the SAME
// decision the legacy engine records there, in the same order. The decision
// context (host, stash, coverage) is passed in as legacy's ctx shape so no test
// touches a host.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const MarketResearch = require("../models/MarketResearch");
const FarmJob = require("../models/FarmJob");
const decideStep = require("../utils/farm2/steps/decide");
const classes = require("../utils/farm2/decisionClasses");
const { BudgetCycle } = require("../utils/farm2/budget");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2gates"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

// Cold-start probing OFF so the probe gate is inert; everything else default.
function af(overrides = {}) {
  return {
    ...settings.getAutoFarm(),
    probeColdStart: false,
    minHoursLeft: 12,
    maxPerGame: 30,
    accountsPerBot: 10,
    maxAutoBots: 20,
    poolReserve: 20,
    platiCategoryId: "",
    forceGames: [],
    ...overrides,
  };
}

// A proven seller: full-tier allocation, so the decision reaches the gates
// downstream of sellability.
async function provenSeller(game) {
  await MarketResearch.deleteMany({ game });
  await AutoFarmTask.deleteMany({ game });
  await MarketResearch.create({ game, demandScore: 90, sellers: 8, scannedAt: new Date() });
}

const online = { host: { id: "pi", label: "Pi" }, hostOnline: true };
const noCoverage = () => ({
  farmMap: { map: new Map(), wildcard: new Set(), logins: new Set() },
  owned: new Set(),
  archiveHolders: new Map(),
});

// A cycle with plenty of everything, granted to one lane.
function richCycle(laneKey, { accounts = 30, containers = 3 } = {}) {
  const c = new BudgetCycle({ accounts, seats: containers * 10, containers, perGameCap: 30 });
  c.allocate([{ key: laneKey, want: 30, weight: 1 }]);
  return c;
}

function laneFor(game) {
  return { game, gameKey: game.toLowerCase(), mode: "shadow" };
}

async function decide(game, { campaign = {}, ctx, cycle, afOverrides } = {}) {
  return decideStep.decideCampaign({
    campaign: { game, campaignId: "c1", name: "Weekly", endAt: hoursFromNow(48), ...campaign },
    lane: laneFor(game),
    cycle,
    af: af(afOverrides),
    shadow: true,
    hostCache: new Map(),
    ctx,
  });
}

/* ------------------------------ vocabulary -------------------------------- */

test("the lane can now emit every decision the legacy engine can", () => {
  assert.deepEqual(
    classes.LEGACY_ONLY_DECISIONS,
    [],
    "no legacy decision is outside the lane's vocabulary: " +
      classes.LEGACY_ONLY_DECISIONS.join(", "),
  );
  const enumValues = AutoFarmTask.schema.path("decision").enumValues;
  for (const d of enumValues) {
    assert.ok(classes.LANE_DECISIONS.includes(d), `lane cannot emit ${d}`);
  }
});

/* -------------------------------- host gate ------------------------------- */

test("an offline farm host is skip_host_offline, before reuse is even considered", async () => {
  const game = "Host Down Game";
  await provenSeller(game);
  // A warm bot exists — but the host it lives on cannot be reached, so reuse
  // must not win here. Legacy checks the host first for the same reason.
  await AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "completed",
    assignedAccounts: ["a1"],
    bots: [{ host: "pi", file: "config_1.json", container: "bot1" }],
  });
  const v = await decide(game, { ctx: { host: { id: "pi", label: "Pi" }, hostOnline: false, ...noCoverage() } });
  assert.equal(v.decision, "skip_host_offline");
  assert.equal(v.wouldFarm, false);
  assert.match(v.reason, /unreachable/);
});

test("no configured farm host resolves to OFFLINE, not unknown — exactly as legacy does", async () => {
  // hostId pointing at nothing makes resolveFarmHost return null, which the
  // legacy tick treats as hostOnline=false and records skip_host_offline.
  const game = "No Host Game";
  await provenSeller(game);
  const v = await decide(game, { afOverrides: { hostId: "does-not-exist-xyz" } });
  assert.equal(v.decision, "skip_host_offline");
  assert.match(v.reason, /Farm host \?/);
});

/* -------------------------------- time gate ------------------------------- */

test("a campaign ending inside the floor with no warm bots is skip_ends_soon", async () => {
  const game = "Short Game";
  await provenSeller(game);
  const v = await decide(game, {
    campaign: { endAt: hoursFromNow(3) },
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("short game"),
  });
  assert.equal(v.decision, "skip_ends_soon");
  assert.equal(v.plannedAccounts, 0);
  assert.match(v.reason, /ends in 3h/);
});

test("a FORCED game bypasses the time gate — and only the time gate", async () => {
  const game = "Short Forced Game";
  await provenSeller(game);
  const v = await decide(game, {
    campaign: { endAt: hoursFromNow(3) },
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("short forced game"),
    afOverrides: { forceGames: ["short-forced-game"] }, // format-insensitive match
  });
  assert.equal(v.decision, "farm", v.reason);
});

test("reuse wins over the time gate, as it does in the legacy engine", async () => {
  // Warm bots carry watch time and can finish a short drop; the 12h floor
  // gates the FRESH-account path only. hostCache pre-seeded so the bot-file
  // existence check is a cache hit rather than a host read.
  const game = "Short Reuse Game";
  await provenSeller(game);
  await AutoFarmTask.create({
    game,
    campaignId: "old",
    decision: "farm",
    status: "completed",
    assignedAccounts: ["a1", "a2"],
    bots: [{ host: "local", file: "config_9.json", container: "bot9" }],
  });
  const hostCache = new Map([["local|config_9.json", true]]);
  const v = await decideStep.decideCampaign({
    campaign: { game, campaignId: "c1", endAt: hoursFromNow(3) },
    lane: laneFor(game),
    cycle: richCycle("short reuse game"),
    af: af(),
    shadow: true,
    hostCache,
    ctx: { ...online, ...noCoverage() },
  });
  assert.equal(v.decision, "reuse_existing");
  assert.equal(v.plannedAccounts, 2);
});

/* ------------------------------ coverage gate ----------------------------- */

test("demand already covered by the system's OWN unsold holders is skip_already_covered", async () => {
  const game = "Covered Game";
  await provenSeller(game);
  const ctx = { ...online, ...noCoverage() };
  ctx.archiveHolders.set(game.toLowerCase(), { holders: 100, stashed: 5, other: 7 });
  const v = await decide(game, { ctx, cycle: richCycle("covered game") });
  assert.equal(v.decision, "skip_already_covered");
  assert.equal(v.targetAccounts, 30, "the tier target is still recorded");
  assert.deepEqual(v.coverage, { manualFarmers: 0, archiveHolders: 100, stashHolders: 5, otherHolders: 7 });
});

test("stashed and unowned holders are recorded but NOT credited as coverage", async () => {
  // The wildcard bug in reverse: crediting stock the auto-lister cannot deliver
  // blocked nine live campaigns on prod. Only `holders` counts.
  const game = "Uncredited Game";
  await provenSeller(game);
  const ctx = { ...online, ...noCoverage() };
  ctx.archiveHolders.set(game.toLowerCase(), { holders: 0, stashed: 200, other: 300 });
  const v = await decide(game, { ctx, cycle: richCycle("uncredited game") });
  assert.equal(v.decision, "farm", "500 uncreditable holders cover nothing");
  assert.equal(v.coverage.stashHolders, 200);
  assert.equal(v.coverage.otherHolders, 300);
});

test("partial coverage reduces the plan to the uncovered remainder", async () => {
  const game = "Partly Covered Game";
  await provenSeller(game);
  const ctx = { ...online, ...noCoverage() };
  ctx.archiveHolders.set(game.toLowerCase(), { holders: 22, stashed: 0, other: 0 });
  const v = await decide(game, { ctx, cycle: richCycle("partly covered game") });
  assert.equal(v.decision, "farm");
  assert.equal(v.targetAccounts, 30);
  assert.equal(v.plannedAccounts, 8, "30 wanted - 22 covered");
});

/* ------------------------------- pool floor ------------------------------- */

test("a zero account grant is skip_no_accounts, not 'farm 0 accounts'", async () => {
  // The old lane fell through to decision "farm" with plannedAccounts 0 here,
  // which compared as `spend` against a legacy `skip` — a phantom disagreement.
  const game = "Dry Pool Game";
  await provenSeller(game);
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("dry pool game", { accounts: 0 }),
  });
  assert.equal(v.decision, "skip_no_accounts");
  assert.equal(v.plannedAccounts, 0);
  assert.equal(v.targetAccounts, 30);
  assert.match(v.reason, /reserve floor/);
});

test("a lane with no grant at all is also skip_no_accounts", async () => {
  const game = "Ungranted Game";
  await provenSeller(game);
  const cycle = new BudgetCycle({ accounts: 30, seats: 30, containers: 3, perGameCap: 30 });
  // allocate() never called for this lane → remainingAccounts is 0.
  const v = await decide(game, { ctx: { ...online, ...noCoverage() }, cycle });
  assert.equal(v.decision, "skip_no_accounts");
});

/* ------------------------------ capacity gate ----------------------------- */

test("no free container and no free seat is skip_no_capacity, keeping the intended plan", async () => {
  const game = "Full Host Game";
  await provenSeller(game);
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    // Accounts to spend, but zero free containers; with no active auto tasks
    // there are no running bots to have spare seats either.
    cycle: richCycle("full host game", { accounts: 30, containers: 0 }),
  });
  assert.equal(v.decision, "skip_no_capacity");
  assert.equal(v.plannedAccounts, 30, "the legacy row keeps the plan on a capacity skip");
  assert.equal(v.targetAccounts, 30);
  assert.match(v.reason, /no running bot has a free seat/);
});

test("the plan is trimmed to free seats", async () => {
  const game = "Tight Host Game";
  await provenSeller(game);
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    // One free container of 10 seats, but 30 accounts granted.
    cycle: richCycle("tight host game", { accounts: 30, containers: 1 }),
  });
  assert.equal(v.decision, "farm");
  assert.equal(v.plannedAccounts, 10, "one container holds accountsPerBot");
  assert.equal(v.targetAccounts, 30);
  assert.equal(v.budgetLimited, true);
  assert.match(v.reason, /trimmed to 10 of 30/);
});

/* ------------------------------- reuse-only ------------------------------- */

test("a reuse-only game with none of its own recycled accounts free is skip_reuse_only", async () => {
  const game = "World of Tanks"; // in the default reuseOnlyGames list
  await provenSeller(game);
  await AvailableAccount.deleteMany({});
  assert.equal(settings.isReuseOnlyGame(game), true, "fixture sanity: WoT is reuse-only");
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("world of tanks"),
  });
  assert.equal(v.decision, "skip_reuse_only");
  assert.match(v.reason, /Reuse-only game/);
});

test("a reuse-only game WITH a recycled account of its own proceeds to farm", async () => {
  const game = "World of Tanks";
  await provenSeller(game);
  await AvailableAccount.deleteMany({});
  await AvailableAccount.create({
    username: "wot_recycled_1",
    usernameLower: "wot_recycled_1",
    status: "available",
    clientSecret: "secret",
    lastCheckStatus: "ok",
    claimedNote: "recycled after World of Tanks",
    soldGames: [],
  });
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("world of tanks"),
  });
  assert.equal(v.decision, "farm", v.reason);
  assert.equal(v.reuseOnly, true);
});

test("a recycled account that already SOLD this game does not count", async () => {
  // Mirrors the soldGames term of claimPoolAccounts' recycled pass: an account
  // that sold this game once cannot be re-farmed on it.
  const game = "World of Tanks";
  await provenSeller(game);
  await AvailableAccount.deleteMany({});
  const { normGame } = require("../utils/gameLabel");
  await AvailableAccount.create({
    username: "wot_sold_1",
    usernameLower: "wot_sold_1",
    status: "available",
    clientSecret: "secret",
    lastCheckStatus: "ok",
    claimedNote: "recycled after World of Tanks",
    soldGames: [normGame(game)],
  });
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("world of tanks"),
  });
  assert.equal(v.decision, "skip_reuse_only");
});

test("a NON-reuse-only game never consults the recycled pool", async () => {
  const game = "Ordinary Game";
  await provenSeller(game);
  await AvailableAccount.deleteMany({});
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("ordinary game"),
  });
  assert.equal(v.decision, "farm");
  assert.equal(v.reuseOnly, false);
});

/* ------------------------------ the happy path ---------------------------- */

test("every gate passed: farm with the legacy row's numbers", async () => {
  const game = "Happy Game";
  await provenSeller(game);
  const v = await decide(game, {
    ctx: { ...online, ...noCoverage() },
    cycle: richCycle("happy game", { accounts: 30, containers: 3 }),
  });
  assert.equal(v.decision, "farm");
  assert.equal(v.wouldFarm, true);
  assert.equal(v.plannedAccounts, 30);
  assert.equal(v.targetAccounts, 30, "targetAccounts is `wanted`, floor included");
  assert.equal(v.budgetLimited, false);
  assert.deepEqual(v.coverage, { manualFarmers: 0, archiveHolders: 0, stashHolders: 0, otherHolders: 0 });
  assert.equal(typeof v.hoursLeft, "number");
});

test("gates fire in the legacy order: coverage before pool floor before capacity", async () => {
  // Same campaign, three failing conditions at once. The FIRST gate in legacy
  // order must be the one reported, or a shadow lane and the legacy engine
  // would record different decisions for identical inputs.
  const game = "Everything Wrong Game";
  await provenSeller(game);
  const ctx = { ...online, ...noCoverage() };
  ctx.archiveHolders.set(game.toLowerCase(), { holders: 100, stashed: 0, other: 0 });
  const v = await decide(game, {
    ctx,
    cycle: richCycle("everything wrong game", { accounts: 0, containers: 0 }),
  });
  assert.equal(v.decision, "skip_already_covered", "coverage is checked first");
});

/* -------------------------------- shadow safety --------------------------- */

test("every gate's context is read-only: nothing is written to AutoFarmTask or the pool", async () => {
  const game = "Read Only Game";
  await provenSeller(game);
  await AvailableAccount.deleteMany({});
  const tasksBefore = await AutoFarmTask.countDocuments({});
  const poolBefore = await AvailableAccount.countDocuments({});
  await decide(game, { ctx: { ...online, ...noCoverage() }, cycle: richCycle("read only game") });
  await decide("World of Tanks", { ctx: { ...online, ...noCoverage() }, cycle: richCycle("world of tanks") });
  assert.equal(await AutoFarmTask.countDocuments({}), tasksBefore, "no task row written");
  assert.equal(await AvailableAccount.countDocuments({}), poolBefore, "no pool row touched");
  assert.equal(await AvailableAccount.countDocuments({ status: "claimed" }), 0, "nothing claimed");
});

/* ------------------------------- memoisation ------------------------------ */

test("per-cycle reads are shared through the hostCache, one in-flight promise per key", async () => {
  // Two lanes in one cycle asking for the same thing must not both pay for it.
  const game = "Shared Cache Game";
  await provenSeller(game);
  const hostCache = new Map();
  const ctx = { ...online, farmMap: noCoverage().farmMap, owned: new Set() }; // archiveHolders NOT supplied
  const args = (id) => ({
    campaign: { game, campaignId: id, endAt: hoursFromNow(48) },
    lane: laneFor(game),
    cycle: richCycle("shared cache game"),
    af: af(),
    shadow: true,
    hostCache,
    ctx,
  });
  await Promise.all([decideStep.decideCampaign(args("c1")), decideStep.decideCampaign(args("c2"))]);
  const archKeys = [...hostCache.keys()].filter((k) => k.startsWith("__farm2:arch|"));
  assert.equal(archKeys.length, 1, "one archive-coverage read for the game, shared by both campaigns");
});
