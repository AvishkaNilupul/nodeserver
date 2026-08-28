// Coverage for the read-only auto-farm allocation forecast (utils/allocationForecast.js).
// Two layers, no Mongo / no network:
//
//   A. PURE ENGINE COMPOSITION — the forecast's demand math must equal the
//      engine's. We feed the SAME exported helpers the tick uses
//      (autoFarmer.demandAllocation / marketStockFloor) into wantedFor and
//      assert the clamp result, so "what the forecast predicts" tracks "what
//      the engine will do" by construction. Also unitPriceFor precedence,
//      summariseDetails, and the bottleneck classifier.
//
//   B. getAllocationForecast INTEGRATION — every DB read on autoFarmer + the
//      four models is monkeypatched, and fetchCampaignDetails is mocked via a
//      require.cache stub installed before the module loads. Asserts the
//      LIVE-vs-SCHEDULED split, the headline numbers (demandTarget / projected
//      / poolSplit / estRevenue) sourced from the persisted task for LIVE and
//      recomputed for SCHEDULED, the live-enrichment ETA path with persistence,
//      the DB-fallback and token-rotation paths, and BOTH fail-soft paths
//      (no token / fetch throws → row still returns with DB-only fields).
//
// node --test runs each test file in its own process, so the global
// monkeypatching below cannot leak into sibling test files.
const test = require("node:test");
const assert = require("node:assert");

// --- install the fetchCampaignDetails mock BEFORE allocationForecast loads ----
// allocationForecast destructures fetchCampaignDetails at require time, so the
// only way to intercept it is to seed require.cache with a stub module. The stub
// delegates to S.fetch (set per test) so each case controls the live call.
let S = {};
const twitchPath = require.resolve("../utils/twitchInventory");
require.cache[twitchPath] = {
  id: twitchPath,
  filename: twitchPath,
  loaded: true,
  exports: { fetchCampaignDetails: (tok, id) => S.fetch(tok, id) },
};

// Real engine + real models (statics patched below) + the module under test.
const autoFarmer = require("../utils/autoFarmer");
const settings = require("../utils/settings");
const TwitchCampaign = require("../models/TwitchCampaign");
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const {
  getAllocationForecast,
  clearCache,
  summariseDetails,
  wantedFor,
  unitPriceFor,
  bottleneckFrom,
} = require("../utils/allocationForecast");

const lc = (s) => String(s || "").toLowerCase();

// ============================================================================
// A. Pure engine composition
// ============================================================================

// A plain af so cap/floor are deterministic and independent of settings.json.
const AF = {
  maxPerGame: 30,
  accountsPerBot: 10,
  poolReserve: 20,
  probeSize: 5,
  perMarketStock: 3,
  maxAutoBots: 20,
  platiCategoryId: null,
};

test("wantedFor: FULL tier (own sales, no market data) → cap, floor not binding", () => {
  // pf(18)=2, salesBoost=18*ln(6)*2≈64.5 ≥ DEMAND_FULL(40) → full.
  // cap=min(30+floor(5*2), 60)=40, target=cap=40. Floor ≤ maxPerGame(30) < 40,
  // so wanted collapses to the target regardless of marketplace config.
  const sales = { count: 5, revenue: 90, avgPrice: 18 };
  const alloc = autoFarmer.demandAllocation(null, AF, sales);
  assert.equal(alloc.target, 40, "cap raised by own sales");
  assert.ok(!alloc.skip && !alloc.probe);
  assert.equal(wantedFor(alloc, AF), 40);
});

test("wantedFor: SKIP tier → 0 wanted", () => {
  // d = market 5 + no sales = 5 < DEMAND_HALF(15) → skip.
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 5, scannedAt: new Date() },
    AF,
    { count: 0 },
  );
  assert.equal(alloc.skip, true);
  assert.equal(wantedFor(alloc, AF), 0);
});

test("wantedFor: PROBE tier forces floor to 0 → min(probeSize, cap)", () => {
  // No research, no sales → probe batch. Floor is deliberately ignored for a
  // probe (we are market-testing, not stocking), so wanted = probeSize.
  const alloc = autoFarmer.demandAllocation(null, AF, { count: 0 });
  assert.equal(alloc.probe, true);
  assert.equal(alloc.target, 5);
  assert.equal(wantedFor(alloc, AF), 5);
});

// Cold-start probing: a researched game scoring below the demand floor is a
// probe (not a skip) ONLY when its low score comes from an untested market
// (≈0 rival sellers) AND the feature is on AND the caller allows it.
const AF_COLD = { ...AF, probeColdStart: true, probeMaxSellers: 1 };

test("cold-start: low demand + 0 sellers + feature on → probe", () => {
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 4, sellers: 0, scannedAt: new Date() },
    AF_COLD,
    { count: 0 },
    { probeAllowed: true },
  );
  assert.equal(alloc.probe, true);
  assert.equal(alloc.coldStart, true);
  assert.equal(alloc.target, 5); // min(probeSize, cap)
});

test("cold-start: low demand but real sellers → still skip (proven dud)", () => {
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 4, sellers: 9, scannedAt: new Date() },
    AF_COLD,
    { count: 0 },
    { probeAllowed: true },
  );
  assert.equal(alloc.skip, true);
  assert.ok(!alloc.probe);
  assert.ok(!alloc.probeBlocked);
});

test("cold-start: feature OFF → untested game still skips (unchanged behaviour)", () => {
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 4, sellers: 0, scannedAt: new Date() },
    AF, // probeColdStart absent
    { count: 0 },
    { probeAllowed: true },
  );
  assert.equal(alloc.skip, true);
  assert.ok(!alloc.probe);
});

test("cold-start: candidate blocked by budget/cooldown → probeBlocked skip", () => {
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 4, sellers: 0, scannedAt: new Date() },
    AF_COLD,
    { count: 0 },
    { probeAllowed: false },
  );
  assert.equal(alloc.skip, true);
  assert.equal(alloc.probeBlocked, true);
});

test("cold-start: no-research probe honours probeAllowed=false → probeBlocked", () => {
  const alloc = autoFarmer.demandAllocation(null, AF_COLD, { count: 0 }, {
    probeAllowed: false,
  });
  assert.equal(alloc.skip, true);
  assert.equal(alloc.probeBlocked, true);
});

test("wantedFor: HALF tier composes target with the REAL marketStockFloor", () => {
  // d = market 20 → half tier, target = ceil(cap/2) = 15. The engine's request
  // builder is min(max(target, floor), cap); assert wantedFor reproduces it
  // using the SAME marketStockFloor the tick uses (deterministic within run).
  const alloc = autoFarmer.demandAllocation(
    { demandScore: 20, scannedAt: new Date() },
    AF,
    { count: 0 },
  );
  assert.equal(alloc.target, 15);
  const floor = autoFarmer.marketStockFloor(AF);
  const expected = Math.min(Math.max(15, floor), 30);
  assert.equal(wantedFor(alloc, AF), expected);
});

test("unitPriceFor: own realised avg > DropSet price > market observed > 0", () => {
  assert.equal(unitPriceFor("g", { avgPrice: 12 }, { observedRevenue: 5 }, 9), 12);
  assert.equal(unitPriceFor("g", { avgPrice: 0 }, { observedRevenue: 5 }, 9), 9);
  assert.equal(unitPriceFor("g", { avgPrice: 0 }, { observedRevenue: 5 }, 0), 5);
  assert.equal(unitPriceFor("g", null, null, 0), 0);
  assert.equal(unitPriceFor("g", { avgPrice: 0 }, null, undefined), 0);
});

test("summariseDetails: requiredMinutesWatched = max threshold, count = #drops", () => {
  assert.deepEqual(
    summariseDetails({
      timeBasedDrops: [
        { requiredMinutesWatched: 60 },
        { requiredMinutesWatched: 120 },
        { requiredMinutesWatched: 90 },
      ],
    }),
    { requiredMinutesWatched: 120, dropItemCount: 3 },
  );
  assert.deepEqual(summariseDetails({}), {
    requiredMinutesWatched: 0,
    dropItemCount: 0,
  });
  assert.deepEqual(summariseDetails(null), {
    requiredMinutesWatched: 0,
    dropItemCount: 0,
  });
});

test("bottleneckFrom: pool > seats > demand > healthy precedence", () => {
  assert.equal(
    bottleneckFrom({ skip_no_accounts: 1, skip_no_capacity: 1 }, true).key,
    "pool",
    "pool beats seats when both present",
  );
  assert.equal(
    bottleneckFrom({ skip_no_accounts: 0, skip_no_capacity: 2 }, true).key,
    "seats",
  );
  assert.equal(
    bottleneckFrom({ skip_no_accounts: 0, skip_no_capacity: 0 }, false).key,
    "demand",
    "no wanted demand → idle",
  );
  assert.equal(
    bottleneckFrom({ skip_no_accounts: 0, skip_no_capacity: 0 }, true).key,
    "healthy",
  );
});

// ============================================================================
// B. getAllocationForecast integration
// ============================================================================

// Patch every DB-touching seam once; each patched fn reads the current S so a
// test only has to set S. demandAllocation / marketStockFloor / mapWithConcurrency
// stay REAL (they are pure) so the recompute path is genuinely exercised.
const orig = {
  countReadyPool: autoFarmer.countReadyPool,
  internalSalesForGame: autoFarmer.internalSalesForGame,
  researchForGame: autoFarmer.researchForGame,
  ownedAccounts: autoFarmer.ownedAccounts,
  archiveHoldersByGame: autoFarmer.archiveHoldersByGame,
  getAutoFarm: settings.getAutoFarm,
  tcFind: TwitchCampaign.find,
  tcUpdate: TwitchCampaign.updateOne,
  atFind: AutoFarmTask.find,
  baFind: BotAccount.find,
  dsFind: DropSet.find,
};

// Minimal chainable Query stub: every real query in the module ends in .lean().
function q(rows) {
  const p = {
    sort: () => p,
    limit: () => p,
    lean: async () => rows,
  };
  return p;
}

test.before(() => {
  autoFarmer.countReadyPool = async () => S.ready;
  autoFarmer.internalSalesForGame = async (g) =>
    S.sales[lc(g)] || { count: 0, revenue: 0, avgPrice: 0 };
  autoFarmer.researchForGame = async (g) => S.research[lc(g)] || null;
  autoFarmer.ownedAccounts = async () => new Set();
  autoFarmer.archiveHoldersByGame = async () => {
    const m = new Map();
    for (const [k, v] of Object.entries(S.holders)) m.set(k, { holders: v });
    return m;
  };
  settings.getAutoFarm = () => S.af;
  // The live query carries status:"ACTIVE"; the scheduled query does not.
  TwitchCampaign.find = (filter) =>
    q(filter && filter.status === "ACTIVE" ? S.liveCamps : S.schedCamps);
  TwitchCampaign.updateOne = (filter, update) => {
    S.updates.push({ campaignId: filter.campaignId, set: update.$set });
    return { catch: () => {} };
  };
  AutoFarmTask.find = () => q(S.tasks);
  BotAccount.find = () => q(S.tokens.map((t) => ({ clientSecret: t })));
  DropSet.find = () => q(S.dropSets);
});

test.after(() => {
  autoFarmer.countReadyPool = orig.countReadyPool;
  autoFarmer.internalSalesForGame = orig.internalSalesForGame;
  autoFarmer.researchForGame = orig.researchForGame;
  autoFarmer.ownedAccounts = orig.ownedAccounts;
  autoFarmer.archiveHoldersByGame = orig.archiveHoldersByGame;
  settings.getAutoFarm = orig.getAutoFarm;
  TwitchCampaign.find = orig.tcFind;
  TwitchCampaign.updateOne = orig.tcUpdate;
  AutoFarmTask.find = orig.atFind;
  BotAccount.find = orig.baFind;
  DropSet.find = orig.dsFind;
});

const HOUR = 3600000;
const DAY = 86400000;

// Base fixture: one LIVE campaign (Rocket League) with a persisted engine
// decision + persisted drop facts, and one SCHEDULED campaign (Fortnite) that
// needs live enrichment. Each test clones this and overrides.
function baseS() {
  const now = Date.now();
  return {
    af: { ...AF },
    ready: 100, // spendable = 100 - 20 = 80
    sales: {
      "rocket league": { count: 3, revenue: 36, avgPrice: 12 },
      fortnite: { count: 0, revenue: 0, avgPrice: 0 },
    },
    research: {
      fortnite: { demandScore: 50, observedRevenue: 8, scannedAt: new Date() },
    },
    holders: { fortnite: 10 },
    liveCamps: [
      {
        campaignId: "live1",
        game: "Rocket League",
        name: "RLCS",
        startAt: new Date(now - HOUR),
        endAt: new Date(now + 7 * DAY),
        requiredMinutesWatched: 90, // already persisted → DB-fallback, no fetch
        dropItemCount: 1,
      },
    ],
    schedCamps: [
      {
        campaignId: "sched1",
        game: "Fortnite",
        name: "Winterfest",
        startAt: new Date(now + 2 * DAY),
        endAt: new Date(now + 9 * DAY),
        requiredMinutesWatched: null, // needs a live fetch
        dropItemCount: null,
      },
    ],
    tasks: [
      {
        campaignId: "live1",
        game: "Rocket League",
        campaignName: "RLCS",
        campaignEndAt: new Date(now + 7 * DAY),
        decision: "farm",
        reason: "Farming.",
        demandScore: 55,
        coverage: { archiveHolders: 6 },
        plannedAccounts: 12,
        targetAccounts: 20,
        assignedAccounts: ["a", "b", "c", "d"],
        status: "active",
        dryRun: false,
      },
    ],
    tokens: ["tok1"],
    dropSets: [
      { game: "Fortnite", publicPrice: 5, price: 4, minPriceUsd: 3 },
      { game: "Rocket League", publicPrice: 9, price: 8, minPriceUsd: 7 },
    ],
    updates: [],
    fetchCalls: [],
    fetch: async (tok, id) => {
      S.fetchCalls.push([tok, id]);
      if (id === "sched1")
        return {
          id,
          timeBasedDrops: [
            { requiredMinutesWatched: 120 },
            { requiredMinutesWatched: 180 },
            { requiredMinutesWatched: 240 },
          ],
        };
      throw new Error("unexpected fetch for " + id);
    },
  };
}

const ev = (f, id) => f.events.find((e) => e.campaignId === id);

test("getAllocationForecast: LIVE reads the task, SCHEDULED recomputes; split + summary + persistence", async () => {
  S = baseS();
  clearCache();
  const f = await getAllocationForecast({ windowDays: 14 });

  // --- split ---
  assert.equal(f.summary.liveCount, 1);
  assert.equal(f.summary.scheduledCount, 1);
  assert.equal(f.events.length, 2);

  // --- LIVE row: surfaced verbatim from the engine's persisted decision ---
  const live = ev(f, "live1");
  assert.equal(live.state, "LIVE");
  assert.equal(live.decision, "farm");
  assert.equal(live.demandTarget, 20, "targetAccounts");
  assert.equal(live.projected, 12, "plannedAccounts");
  assert.deepEqual(live.poolSplit, {
    covered: 6, // coverage.archiveHolders
    farmingNow: 4, // assignedAccounts.length
    freshToPool: 8, // max(0, 12 - 4)
  });
  assert.equal(live.unitPrice, 12, "own realised avg wins");
  assert.equal(live.estRevenue, 144, "12 * 12");
  // live1 had persisted drop facts → DB fallback, NOT a live fetch.
  assert.equal(live.requiredMinutesWatched, 90);
  assert.equal(live.dropItemCount, 1);
  assert.equal(live.detailsSource, "db");

  // --- SCHEDULED row: recomputed standalone demand target ---
  const sched = ev(f, "sched1");
  assert.equal(sched.state, "SCHEDULED");
  assert.equal(sched.decision, "farm");
  // Fortnite: research demand 50 ≥ 40 → target = cap = 30. Covered 10 → uncovered 20.
  assert.equal(sched.demandTarget, 30);
  assert.equal(sched.projected, 20);
  assert.deepEqual(sched.poolSplit, {
    covered: 10,
    farmingNow: 0,
    freshToPool: 20,
  });
  assert.equal(sched.unitPrice, 5, "DropSet publicPrice (no own sales)");
  assert.equal(sched.estRevenue, 100, "20 * 5");
  // sched1 lacked drop facts → one live fetch, summarised + persisted.
  assert.equal(sched.requiredMinutesWatched, 240);
  assert.equal(sched.dropItemCount, 3);
  assert.equal(sched.detailsSource, "live");

  // --- enrichment discipline: exactly one fetch (sched1), one persist ---
  assert.equal(S.fetchCalls.length, 1);
  assert.deepEqual(S.fetchCalls[0], ["tok1", "sched1"]);
  assert.equal(S.updates.length, 1);
  assert.equal(S.updates[0].campaignId, "sched1");
  assert.equal(S.updates[0].set.requiredMinutesWatched, 240);
  assert.equal(S.updates[0].set.dropItemCount, 3);

  // --- summary ---
  assert.equal(f.summary.spendable, 80);
  assert.equal(f.summary.globalSeatCap, 200); // 20 * 10
  assert.equal(f.summary.deployedInAuto, 4);
  assert.equal(f.summary.freeSeats, 196);
  // Totals are over the LIVE set only (scheduled are future estimates).
  assert.equal(f.summary.totalWanted, 20);
  assert.equal(f.summary.totalProjected, 12);
  assert.equal(f.summary.totalCovered, 6);
  assert.equal(f.summary.totalRevenue, 144);
  assert.equal(f.summary.bottleneck.key, "healthy");
  assert.equal(f.summary.liveTokenOk, true);
});

test("getAllocationForecast: fail-soft with NO token → rows still return, DB facts kept, live fetch skipped", async () => {
  S = baseS();
  S.tokens = []; // borrowTokens returns nothing
  clearCache();
  const f = await getAllocationForecast({ windowDays: 14 });

  assert.equal(f.summary.liveTokenOk, false);
  assert.equal(f.events.length, 2, "both rows still present");

  // live1's persisted facts don't need a token.
  const live = ev(f, "live1");
  assert.equal(live.requiredMinutesWatched, 90);
  assert.equal(live.detailsSource, "db");

  // sched1 had no persisted facts and there's no token → DB-only, null facts.
  const sched = ev(f, "sched1");
  assert.equal(sched.requiredMinutesWatched, null);
  assert.equal(sched.dropItemCount, null);
  assert.equal(sched.detailsSource, null);
  // Its recomputed allocation is unaffected by the missing ETA.
  assert.equal(sched.projected, 20);

  assert.equal(S.fetchCalls.length, 0, "no live call attempted");
  assert.equal(S.updates.length, 0, "nothing persisted");
});

test("getAllocationForecast: fail-soft when fetchCampaignDetails throws → row still returns DB-only", async () => {
  S = baseS();
  S.fetch = async (tok, id) => {
    S.fetchCalls.push([tok, id]);
    throw new Error("boom");
  };
  clearCache();
  const f = await getAllocationForecast({ windowDays: 14 });

  const sched = ev(f, "sched1");
  assert.equal(sched.requiredMinutesWatched, null, "fetch failed → null");
  assert.equal(sched.detailsSource, null);
  assert.equal(sched.projected, 20, "row still fully computed");
  assert.equal(S.fetchCalls.length, 1, "the throwing fetch was attempted");
  assert.equal(S.updates.length, 0, "no persist on failure");
});

test("getAllocationForecast: a dead token rotates to a healthy one", async () => {
  S = baseS();
  S.tokens = ["dead", "good"];
  S.fetch = async (tok, id) => {
    S.fetchCalls.push([tok, id]);
    if (tok === "dead") {
      const e = new Error("no valid token");
      e.code = "token_invalid";
      throw e;
    }
    return { id, timeBasedDrops: [{ requiredMinutesWatched: 75 }] };
  };
  clearCache();
  const f = await getAllocationForecast({ windowDays: 14 });

  const sched = ev(f, "sched1");
  assert.equal(sched.requiredMinutesWatched, 75, "resolved via the good token");
  assert.equal(sched.dropItemCount, 1);
  assert.equal(sched.detailsSource, "live");
  // First attempt dead, second good — both within one resolveDetails call.
  assert.deepEqual(S.fetchCalls, [
    ["dead", "sched1"],
    ["good", "sched1"],
  ]);
  assert.equal(S.updates.length, 1);
  assert.equal(S.updates[0].set.requiredMinutesWatched, 75);
});
