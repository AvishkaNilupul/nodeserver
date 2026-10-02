// The farm brain's loader (utils/demandBrain/inputs.js): what it reads, what it calls, and what it
// must never call. Every dependency is a recording fake; the price tracker's union (games.soldUnion)
// is the real one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const I = require("../utils/demandBrain/inputs");
const M = require("../utils/demandBrain/model");
const G = require("../utils/priceTracker/games");
const { normGame } = require("../utils/priceTracker/setIdentity");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 10, 12);

function query(rows, calls, name) {
  return (filter, projection) => {
    const call = { name, filter, projection, limit: null };
    calls.push(call);
    const q = {
      limit(n) {
        call.limit = n;
        return q;
      },
      lean: async () => rows,
    };
    return q;
  };
}

// A ledger sale as utils/priceTracker/ledger.js produces it.
const sale = (o) => ({ gameKey: "game a", game: "Game A", at: new Date(NOW - 5 * DAY), market: "gameflip", priced: true, priceUsd: 2, login: "", account: "", logins: [], key: "k" + Math.random(), source: "signal", ...o });
// A grouped connection row as connectedHistory's $group returns it.
const conn = (g, l, daysAgo, a = null) => ({ _id: { g, l, a, k: "" }, at: new Date(NOW - daysAgo * DAY) });

function world(over = {}) {
  const calls = [];
  const engine = { research: [], sales: [], alloc: [], gate: [], inFlight: 0, maxInFlight: 0 };
  const settingsAf = {
    noClaimGames: ["overwatch", "rainbow six"],
    reuseOnlyGames: ["world of tanks"],
    probeSize: 12,
    maxPerGame: 30,
    gameAccountCaps: { "game b": 7 },
    ...(over.af || {}),
  };
  const ledger = {
    sales: [
      sale({ gameKey: "game a", login: "a1", at: new Date(NOW - 2 * DAY), market: "gameflip" }),
      sale({ gameKey: "game a", login: "a2", at: new Date(NOW - 5 * DAY), market: "eldorado" }),
      sale({ gameKey: "game b", login: "b1", at: new Date(NOW - 10 * DAY), market: "ggsel" }),
      sale({ gameKey: "overwatch 2", game: "Overwatch 2", login: "o1", at: new Date(NOW - DAY), market: "eldorado" }),
      sale({ gameKey: "old game", game: "Old Game", login: "x1", at: new Date(NOW - 100 * DAY) }),
    ],
    demandOnly: [],
  };
  const deps = {
    settings: {
      getAutoFarm: () => settingsAf,
      getFarmSizing: (af) => ({ coverageDays: 28, safetyStock: 6, maxPerGame: 250, gameCaps: af.gameAccountCaps || {} }),
      gameAccountCapFor: (game, af) => {
        const caps = af.gameAccountCaps || {};
        for (const [k, v] of Object.entries(caps)) if (String(game).toLowerCase().includes(k)) return v;
        return 0;
      },
      normGameName: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      isNoClaimGame: () => {
        throw new Error("the loader must not call settings.isNoClaimGame (one file read per call)");
      },
      isReuseOnlyGame: () => {
        throw new Error("the loader must not call settings.isReuseOnlyGame (one file read per call)");
      },
    },
    games: G,
    priceTracker: {
      getReport: async () =>
        over.report === undefined
          ? {
              ledger,
              truncated: false,
              prepared: {
                rows: [
                  { id: { gameKey: "game a" }, l: { status: "active", createdAt: new Date(NOW - 20 * DAY) } },
                  { id: { gameKey: "overwatch 2" }, l: { status: "active", createdAt: new Date(NOW - 20 * DAY) } },
                ],
              },
              games: [
                { key: "game a", game: "Game A", price: { valuePerAccount: 1.7 }, farm: { onHand: 3, inFlight: 1, engine: { decision: "reuse_existing", decidedAt: new Date(NOW - DAY), target: 30 } } },
                { key: "game b", game: "Game B", price: { valuePerAccount: 0 }, farm: { onHand: 0, inFlight: 0, engine: null } },
              ],
            }
          : over.report,
    },
    SaleSignal: {
      aggregate: async (pipeline) => {
        calls.push({ name: "connected", pipeline });
        return over.connected || [conn("game a", "a1", 1), conn("game c", "c1", 60), conn("game c", "c2", 3)];
      },
    },
    marketReport: {
      getReport: async () => {
        if (over.radarFails) throw new Error("radar db down");
        return {
          games: [
            { key: "game b", game: "Game B", perWeek: 4, units: 8, rivalSellers: 3, realised: { median: 2 } },
            { key: "market only", game: "Market Only", perWeek: 12, units: 30, rivalSellers: 4, realised: { median: 3 } },
            { key: "unrated", game: "Unrated", perWeek: null, units: 3, rivalSellers: 1, realised: { median: 1 } },
            { key: "overwatch 2", game: "Overwatch 2", perWeek: 9, units: 30, rivalSellers: 5, realised: { median: 4 } },
          ],
          feed: [
            { gameKey: "game b", soldAt: new Date(NOW - DAY), units: 2, ours: false, title: "a long title", seller: "x" },
            { gameKey: "game b", soldAt: new Date(NOW - DAY), units: 5, ours: true },
            { gameKey: "game b", soldAt: new Date(NOW - DAY), units: 9, ours: false, kind: "farm" },
          ],
        };
      },
    },
    TwitchCampaign: {
      find: query(
        over.campaigns || [
          { game: "Game C", endAt: new Date(NOW + 30 * 3600000) },
          { game: "Game C", endAt: new Date(NOW + 90 * 3600000) },
          { game: "Game A", endAt: null },
          { game: "Overwatch 2", endAt: new Date(NOW + DAY) },
          { game: "World of Tanks", endAt: new Date(NOW + DAY) },
          { game: "", endAt: null },
        ],
        calls,
        "campaigns",
      ),
    },
    probeGate: async (game, af) => {
      engine.gate.push({ game, af });
      if (game === over.probeHeldFor) return { probeAllowed: false, probeBudgetBlocked: true };
      return { probeAllowed: true, probeBudgetBlocked: false };
    },
    autoFarmer: {
      researchForGame: async (g) => {
        engine.research.push(g);
        engine.inFlight++;
        engine.maxInFlight = Math.max(engine.maxInFlight, engine.inFlight);
        await new Promise((r) => setImmediate(r));
        engine.inFlight--;
        if (g === "Game C" && over.engineFailsFor === "Game C") throw new Error("research read failed");
        return { demandScore: 12, sellers: 2, scannedAt: new Date(NOW - DAY) };
      },
      internalSalesForGame: async (g) => {
        engine.sales.push(g);
        return { count: 3, revenue: 6, avgPrice: 2 };
      },
      demandAllocation: (research, af, sales, opts) => {
        engine.alloc.push({ research, af, sales, opts });
        return { cap: 30, target: 15, effective: 18 };
      },
      marketStockFloor: (af) => {
        if (over.floorFails) throw new Error("keys unreadable");
        assert.equal(af, settingsAf, "the floor reads the live auto-farm settings");
        return 18;
      },
      freshResearchForGame: async () => {
        throw new Error("freshResearchForGame re-scans a marketplace and must never be called");
      },
    },
    farmDemand: over.farmDemand || {
      unclaimedDemandSnapshot: async ({ days }) => {
        calls.push({ name: "snapshot", days });
        return [{ key: "overwatch", label: "Overwatch", target: 250, onHand: 60, sales: { perWeek: 60 }, stock: { listed: 50, inFlight: 0 }, policy: {} }];
      },
      saleEvidenceByBucket: async ({ days }) => {
        calls.push({ name: "evidence", days });
        return { units: new Map([["overwatch", new Map([["x", { firstAt: new Date(NOW - DAY), market: "Eldorado", priceUsd: 4 }], ["y", { firstAt: null }]])]]) };
      },
      demandRates: () => ({ shelfPerWeek: 1, otherPerWeek: 2 }),
      plan: () => {
        throw new Error("never the allocator");
      },
    },
    normGame,
  };
  return { deps, calls, engine };
}

/* --------------------------------- evidence --------------------------------- */

test("connection history: the whole 135-day window, grouped in the database, bounded", async () => {
  const { deps, calls } = world();
  const ch = await I.connectedHistory(deps, NOW);
  const p = calls.find((c) => c.name === "connected").pipeline;
  assert.equal(p[0].$match.source, "connected");
  assert.equal(p[0].$match.at.$gte.getTime(), NOW - M.HISTORY_DAYS * DAY, "not the report's 45 days");
  assert.deepEqual(Object.keys(p[1].$group._id), ["g", "l", "a", "k"]);
  assert.deepEqual(p[1].$group.at, { $min: "$at" }, "each sold account dated by its first flip");
  assert.equal(p[2].$limit, I.CONNECTED_GROUP_CAP);
  assert.equal(JSON.stringify(p).includes("allowDiskUse"), false);
  assert.deepEqual(ch.rows[0], { gameKey: "game a", login: "a1", account: null, at: new Date(NOW - DAY), dedupeKey: "" });
  assert.equal(ch.truncated, false);
});

test("sale log: a sale only a connection flip proves, 60 days old, is in the history (the report's 45 days would miss it)", async () => {
  const { deps } = world();
  const p = await I.load({ now: NOW, deps });
  const c = p.evidence.claim.get("game c");
  assert.deepEqual(c.map((e) => Math.round((NOW - e.t) / DAY)), [60, 3]);
  assert.ok(c.every((e) => e.m === "unknown"), "a connection flip names no market");
  // a ledger sale and the buyer's later connection of the same account: one sale, dated by the sale
  const a = p.evidence.claim.get("game a");
  assert.equal(a.length, 2, "a1 sold 2 days ago and connected 1 day ago is ONE sale; a2 is the other");
  assert.equal(Math.round((NOW - a[1].t) / DAY), 2);
});

test("sale log: dated by the EARLIEST evidence in the window — flips 46 and 44 days ago are a 46-day-old sale", () => {
  const log = I.saleLogFrom(G, {
    sales: [],
    connected: [
      { gameKey: "game z", login: "z1", account: null, at: new Date(NOW - 46 * DAY), dedupeKey: "" },
      { gameKey: "game z", login: "z1", account: null, at: new Date(NOW - 44 * DAY), dedupeKey: "" },
      { gameKey: "game z", login: "", account: null, at: new Date(NOW - 10 * DAY), dedupeKey: "anon-1" },
      { gameKey: "game z", login: "", account: null, at: new Date(NOW - 9 * DAY), dedupeKey: "anon-2" },
    ],
    now: NOW,
    days: M.HISTORY_DAYS,
  });
  const z = log.get("game z");
  assert.deepEqual(z.map((e) => Math.round((NOW - e.t) / DAY)), [46, 10, 9], "two anonymous flips stay two sales");
});

/* --------------------------------- the farms --------------------------------- */

test("candidates: live campaigns, our sales in 45 days and rated markets; never a no-claim game", async () => {
  const { deps } = world();
  const p = await I.load({ now: NOW, deps });
  const keys = p.claim.map((g) => g.key);
  assert.deepEqual(keys.slice(0, 3).sort(), ["game a", "game c", "world of tanks"], "live campaigns first");
  assert.ok(keys.includes("game b"), "sold in 45 days");
  assert.ok(keys.includes("market only"), "a rated market");
  assert.ok(!keys.includes("unrated"), "an unrated market is not a candidate by itself");
  assert.ok(!keys.includes("old game"), "a sale 100 days ago does not make a candidate");
  assert.ok(!keys.some((k) => k.includes("overwatch")), "no-claim games belong to the no-claim farm");
  assert.equal(p.counts.claimGames, keys.length);
});

test("the engine's own functions, called exactly as its decide step calls them — probe gate included", async () => {
  const { deps, engine } = world({ probeHeldFor: "Game C" });
  const p = await I.load({ now: NOW, deps });
  const c = p.claim.find((g) => g.key === "game c");
  assert.equal(c.label, "Game C", "the campaign's own label");
  assert.equal(c.live, true);
  assert.ok(Math.abs(c.hoursLeft - 90) < 1e-6, "the longest-running campaign");
  assert.ok(engine.research.includes("Game C") && engine.sales.includes("Game C"));
  assert.ok(engine.gate.some((x) => x.game === "Game C"), "the probe gate is asked, with the label");
  for (const a of engine.alloc) {
    assert.ok(a.opts.game, "with the game, so caps and coverage apply");
    assert.equal(a.af, deps.settings.getAutoFarm(), "with the live auto-farm settings");
    assert.equal(a.opts.probeAllowed, a.opts.game !== "Game C", "the gate's answer, not a hard-coded true");
  }
  assert.deepEqual(c.old.gate, { probeAllowed: false, budgetBlocked: true });
  assert.ok(engine.maxInFlight <= I.ENGINE_CONCURRENCY, "at most " + I.ENGINE_CONCURRENCY + " lookups at once, saw " + engine.maxInFlight);
  assert.deepEqual(c.old.alloc, { cap: 30, target: 15, effective: 18 });
  assert.deepEqual(p.engine, { floor: 18, maxPerGame: 30 });
});

test("the shelf floor degrades to 0 with a note when it cannot be read", async () => {
  const { deps } = world({ floorFails: true });
  const p = await I.load({ now: NOW, deps });
  assert.equal(p.engine.floor, 0);
  assert.ok(p.notes.some((n) => /shelf floor/.test(n)));
});

test("one game's failed lookup is that game's error, not the run's", async () => {
  const { deps } = world({ engineFailsFor: "Game C" });
  const p = await I.load({ now: NOW, deps });
  assert.match(p.claim.find((g) => g.key === "game c").old.error, /research read failed/);
  assert.ok(p.claim.find((g) => g.key === "game a").old.alloc);
});

test("value per account: our own net price, else rivals' sold price less the market's cut", async () => {
  const { deps } = world();
  const p = await I.load({ now: NOW, deps });
  const a = p.claim.find((g) => g.key === "game a");
  assert.equal(a.value, 1.7);
  assert.equal(a.valueBasis, "our sales");
  const b = p.claim.find((g) => g.key === "game b");
  assert.equal(b.value, Math.round(2 * (1 - M.RIVAL_FEE_SHARE) * 100) / 100);
  assert.equal(b.valueBasis, "rivals' sold price");
  assert.equal(b.gameCap, 7);
  assert.equal(p.claim.find((g) => g.key === "world of tanks").reuseOnly, true);
  assert.deepEqual(a.stock, { onHand: 3, inFlight: 1 });
  assert.equal(a.act.d, "reuse_existing");
  assert.equal(p.sizing.coverageDays, 28);
  assert.equal(p.probeSize, 12);
});

test("no-claim: the feeder's snapshot and evidence, live bucket detection, never plan()", async () => {
  const { deps, calls } = world();
  const p = await I.load({ now: NOW, deps });
  assert.equal(p.noclaim.length, 1);
  const n = p.noclaim[0];
  assert.equal(n.snapRow.target, 250);
  assert.deepEqual(n.entries, [{ t: NOW - DAY, m: "eldorado", p: 4 }], "undated units are dropped; markets lowercased");
  assert.equal(n.live, true, "an Overwatch 2 campaign is live");
  assert.equal(n.spans.length, 1, "the bucket's listing spans");
  assert.deepEqual(n.keywords, ["overwatch", "rainbow six"]);
  assert.equal(typeof p.demandRates, "function");
  assert.deepEqual(calls.filter((c) => c.name === "snapshot").map((c) => c.days), [30]);
  assert.deepEqual(calls.filter((c) => c.name === "evidence").map((c) => c.days), [M.HISTORY_DAYS]);
});

test("a no-claim failure is the no-claim half's failure only: the claim rows still come back", async () => {
  const boom = { unclaimedDemandSnapshot: async () => { throw new Error("feeder read failed"); } };
  const { deps } = world({ farmDemand: boom });
  const p = await I.load({ now: NOW, deps });
  assert.deepEqual(p.noclaim, []);
  assert.ok(p.claim.length > 0);
  assert.ok(p.notes.some((x) => /snapshot failed this run \(feeder read failed\)/.test(x)));
  const evFails = {
    unclaimedDemandSnapshot: async () => [{ key: "overwatch", label: "Overwatch", target: 9, sales: {}, stock: {} }],
    saleEvidenceByBucket: async () => {
      throw new Error("evidence read failed");
    },
  };
  const p2 = await I.load({ now: NOW, deps: world({ farmDemand: evFails }).deps });
  assert.equal(p2.noclaim[0].entries, null);
  assert.ok(p2.notes.some((x) => /evidence failed this run/.test(x)));
});

test("degrades with a note, never a crash: no ledger, radar down, an old farmDemand", async () => {
  const { deps } = world({ report: { prepared: { rows: [] }, games: [] }, radarFails: true, farmDemand: { unclaimedDemandSnapshot: async () => [{ key: "overwatch", target: 5, sales: {}, stock: {} }] } });
  const p = await I.load({ now: NOW, deps });
  assert.ok(p.notes.some((n) => /no sale ledger/.test(n)));
  assert.ok(p.notes.some((n) => /radar unreadable/i.test(n)));
  assert.ok(p.notes.some((n) => /only its own rule is logged/.test(n)));
  assert.equal(p.noclaim[0].entries, null);
  assert.equal(p.demandRates, null);
});

test("the campaign read is the lane engine's filter, projected and limited", async () => {
  const { deps, calls } = world();
  await I.load({ now: NOW, deps });
  const c = calls.find((x) => x.name === "campaigns");
  assert.equal(c.filter.active, true);
  assert.equal(c.filter.status, "ACTIVE");
  assert.deepEqual(c.filter.$or[0], { endAt: null });
  assert.ok(c.filter.$or[1].endAt.$gt instanceof Date);
  assert.deepEqual(c.projection, { game: 1, endAt: 1 });
  assert.ok(c.limit > 0);
});

test("the candidate list is capped, live games kept first", async () => {
  const many = [];
  for (let i = 0; i < I.MAX_CLAIM_GAMES + 20; i++) many.push({ game: "Live " + i, endAt: null });
  const { deps } = world({ campaigns: many });
  const p = await I.load({ now: NOW, deps });
  assert.equal(p.claim.length, I.MAX_CLAIM_GAMES);
  assert.ok(p.claim.every((g) => g.live));
  assert.ok(p.notes.some((n) => /candidate games/.test(n)));
});

test("the scorer keeps only rivals' drop sales from the radar feed, three fields each, and which games it watches", async () => {
  const { deps } = world();
  const p = await I.load({ now: NOW, deps });
  assert.deepEqual(p.evidence.feed, [{ g: "game b", t: NOW - DAY, u: 2 }]);
  assert.ok(p.evidence.radarKeys.has("unrated") && !p.evidence.radarKeys.has("game a"));
});

test("loadEvidence: only what the scorer needs, and no engine call", async () => {
  const { deps, engine } = world();
  const ev = await I.loadEvidence({ now: NOW, deps });
  assert.equal(ev.claim.get("game a").length, 2);
  assert.equal(ev.claim.get("game c").length, 2, "with the 135-day connection history");
  assert.ok(ev.spans.get("game a"));
  assert.deepEqual(ev.noclaimKeys, ["overwatch", "rainbow six"]);
  assert.equal(ev.noclaim.get("overwatch").length, 1);
  assert.equal(ev.feed.length, 1);
  assert.ok(ev.radarKeys instanceof Set);
  assert.equal(typeof ev.demandRates, "function");
  assert.equal(engine.research.length + engine.sales.length + engine.alloc.length + engine.gate.length, 0);
});

test("game rules mirror settings.isNoClaimGame (substring) and isReuseOnlyGame (exact)", () => {
  const S = { normGameName: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() };
  const r = I.gameRules(S, { noClaimGames: ["Overwatch", "rainbow six"], reuseOnlyGames: ["ufl", "World of Tanks"] });
  assert.equal(r.isNoClaim("Overwatch 2"), true);
  assert.equal(r.isNoClaim("Tom Clancy's Rainbow Six Siege"), true);
  assert.equal(r.isNoClaim("Rocket League"), false);
  assert.equal(r.isNoClaim(""), false);
  assert.equal(r.isReuseOnly("UFL"), true);
  assert.equal(r.isReuseOnly("UFL 2"), false, "exact, so a short label cannot match by substring");
  assert.equal(r.isReuseOnly("world of tanks"), true);
});

/* ------------------------------- source rules ------------------------------- */

const SRC = (f) => fs.readFileSync(path.join(__dirname, "..", "utils", "demandBrain", f), "utf8").replace(/\/\/.*$/gm, "");

test("the brain's model and loader never write, never call a marketplace, a host or a re-scan", () => {
  for (const f of ["model.js", "inputs.js"]) {
    const src = SRC(f);
    for (const bad of [/\.save\(/, /\.create\(/, /updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate/, /insertMany|insertOne|deleteOne|deleteMany|bulkWrite|replaceOne/, /require\([^)]*marketplaces[^)]*\)/, /axios|fetch\(/, /child_process|\bssh\b|botHosts|noclaimFleet/, /freshResearchForGame\(/, /setAutoFarm|saveSettings/, /unclaimedAllocator/, /allowDiskUse/]) {
      assert.ok(!bad.test(src), f + " matches " + bad);
    }
  }
});

test("the runner's only writes are its own log: one run document and its rows", () => {
  const src = SRC("index.js");
  assert.equal((src.match(/\.create\(/g) || []).length, 1);
  assert.equal((src.match(/\.insertMany\(/g) || []).length, 1);
  assert.match(src, /hooks\.Run\(\)\.create\(doc\)/);
  assert.match(src, /hooks\.Row\(\)\.insertMany\(/);
  for (const bad of [/\.save\(/, /updateOne|updateMany|findOneAndUpdate/, /insertOne|deleteOne|deleteMany|bulkWrite/, /require\([^)]*marketplaces[^)]*\)/, /setAutoFarm|saveSettings/, /allowDiskUse/]) {
    assert.ok(!bad.test(src), "index.js matches " + bad);
  }
});
