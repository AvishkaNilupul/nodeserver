// The farm brain's pure model (utils/demandBrain/model.js, docs/DEMAND-BRAIN-PLAN.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../utils/demandBrain/model");
const farmSizing = require("../utils/farmSizing");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const at = (daysAgo, m = "gameflip") => ({ t: NOW - daysAgo * DAY, m });
const CFG = M.readConfig({ demandBrain: { enabled: true } });
const SIZING = { coverageDays: 28, safetyStock: 6, maxPerGame: 250 };

// The no-claim feeder v2's rate rule, copied VERBATIM from production's utils/farmDemand.js
// (119faace, feat/noclaim-feeder-v2) so the brain's fallback can be held to it exactly.
function refDemandRates(units, { days = 30, shortDays = 14, now = Date.now() } = {}) {
  const DAY_MS = 86400000;
  const SHELF_MARKETS = new Set(["gameflip", "ggsel", "digiseller"]);
  const lower = (s) => String(s || "").trim().toLowerCase();
  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const sizing = farmSizing;
  const shortW = Math.max(1, Math.min(shortDays, days));
  const shortSince = now - shortW * DAY_MS;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  let shelf = 0;
  let shelfShort = 0;
  let other = 0;
  let otherShort = 0;
  const otherDays = new Set();
  const otherDaysShort = new Set();
  for (const u of units || []) {
    const t = u && u.firstAt ? new Date(u.firstAt).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const recent = t >= shortSince;
    if (SHELF_MARKETS.has(lower(u.market))) {
      shelf++;
      if (recent) shelfShort++;
    } else {
      other++;
      otherDays.add(dayOf(t));
      if (recent) {
        otherShort++;
        otherDaysShort.add(dayOf(t));
      }
    }
  }
  const shelfPerWeek = Math.max(sizing.salesPerWeek(shelf, days), sizing.salesPerWeek(shelfShort, shortW));
  const otherPerWeek = Math.max(
    sizing.inStockRate({ count: other, sellingDays: otherDays.size, windowDays: days }),
    sizing.inStockRate({ count: otherShort, sellingDays: otherDaysShort.size, windowDays: shortW }),
  );
  return { shelfPerWeek: round1(shelfPerWeek), otherPerWeek: round1(otherPerWeek), sellingDays: otherDays.size, shelfSales: shelf, otherSales: other };
}

// A deterministic pseudo-random stream, so a failing case is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ---------------------------------- config ---------------------------------- */

test("config: off by default; only an explicit on turns it on; numbers clamped; bad values default", () => {
  const d = M.readConfig({});
  assert.equal(d.enabled, false);
  assert.equal(d.estimatorClaim, "avg45", "the backtest winner on production data");
  assert.equal(d.estimatorNoclaim, "v2", "the no-claim brain starts as a mirror of the feeder");
  for (const v of [true, 1, "true", "on", " YES ", "enabled"]) assert.equal(M.readConfig({ demandBrain: { enabled: v } }).enabled, true, String(v));
  for (const v of [false, 0, 2, "false", "off", "", null, undefined, {}, [], "yes please"]) assert.equal(M.readConfig({ demandBrain: { enabled: v } }).enabled, false, String(v));
  const c = M.readConfig({ demandBrain: { intervalMin: 1, captureShare: 7, minRate: -3, estimatorClaim: "nope", estimatorNoclaim: "avg30", minWeeklyUsd: null } });
  assert.equal(c.intervalMin, M.MIN_INTERVAL_MIN);
  assert.equal(c.captureShare, 1);
  assert.equal(c.minRate, 0);
  assert.equal(c.estimatorClaim, "avg45", "an unknown estimator falls back to the default");
  assert.equal(c.estimatorNoclaim, "avg30");
  assert.equal(c.minWeeklyUsd, M.DEFAULTS.minWeeklyUsd, "null is not zero");
  assert.equal(M.readConfig({ demandBrain: "on" }).enabled, false, "a non-object block is ignored");
});

/* ------------------------------ listing history ------------------------------ */

test("listing spans: active runs to now, closed rows end at their last write, error rows were never live", () => {
  const rows = [
    { id: { gameKey: "a" }, l: { status: "active", createdAt: new Date(NOW - 10 * DAY) } },
    { id: { gameKey: "a" }, l: { status: "sold", createdAt: new Date(NOW - 40 * DAY), updatedAt: new Date(NOW - 35 * DAY) } },
    { id: { gameKey: "a" }, l: { status: "error", createdAt: new Date(NOW - 5 * DAY), updatedAt: new Date(NOW) } },
    { id: { gameKey: "b" }, l: { status: "delisted", createdAt: new Date(NOW - 3 * DAY), updatedAt: new Date(NOW - 4 * DAY) } }, // ends before it starts
    { id: { gameKey: "c" }, l: { status: "removed", createdAt: null, updatedAt: new Date(NOW) } },
    { id: {}, l: { status: "active", createdAt: new Date(NOW - DAY) } },
  ];
  const s = M.listingSpans(rows, NOW);
  assert.deepEqual([...s.keys()], ["a"]);
  assert.deepEqual(s.get("a"), [
    [NOW - 10 * DAY, NOW],
    [NOW - 40 * DAY, NOW - 35 * DAY],
  ]);
});

test("covered days merge overlaps and clip to the window", () => {
  const spans = [
    [NOW - 20 * DAY, NOW - 10 * DAY],
    [NOW - 15 * DAY, NOW - 5 * DAY],
    [NOW - 40 * DAY, NOW - 31 * DAY],
  ];
  assert.equal(M.coveredDays(spans, NOW - 30 * DAY, NOW), 15);
  assert.equal(M.coveredDays(spans, NOW - 35 * DAY, NOW), 19);
  assert.equal(M.coveredDays([], NOW - 30 * DAY, NOW), 0);
  assert.equal(M.coveredDays(spans, NOW, NOW - DAY), 0);
});

/* -------------------------------- estimators -------------------------------- */

test("averages count only sales dated inside the window and never after `now`", () => {
  const e = [at(1), at(10), at(20), at(29.9), at(31), at(44), at(50), at(-2)];
  assert.equal(M.countIn(e, NOW, 30), 4);
  const r = M.allEstimates(e, NOW);
  assert.equal(r.avg30, Math.round(((4 * 7) / 30) * 100) / 100);
  assert.equal(r.avg45, Math.round(((6 * 7) / 45) * 100) / 100);
  // 14-day window holds 2 sales: 1/wk; 30-day 4: 0.93/wk
  assert.equal(r.max30_14, 1);
});

test("listed: corrects for days with nothing listed, capped at 2x; no history falls back to max30_14", () => {
  const e = [at(2), at(3), at(4), at(5), at(6), at(7)];
  const base = M.estimate("max30_14", e, NOW).total;
  assert.equal(M.estimate("listed", e, NOW, { spans: [] }).total, base);
  // listed the whole time: no correction
  assert.equal(M.estimate("listed", e, NOW, { spans: [[NOW - 60 * DAY, NOW]] }).total, base);
  // listed only the last 8 days: 30-day window is floored at 15 days, 14-day at 7
  const short = M.estimate("listed", e, NOW, { spans: [[NOW - 8 * DAY, NOW]] }).total;
  assert.equal(short, Math.round(Math.max((6 * 7) / 15, (6 * 7) / 8) * 100) / 100);
  assert.ok(short <= 2 * Math.max((6 * 7) / 30, (6 * 7) / 14) + 1e-9, "never more than double");
});

test("v2: the brain's copy equals production's demandRates on 400 random sale histories", () => {
  const rand = rng(20261002);
  const markets = ["gameflip", "ggsel", "digiseller", "eldorado", "g2g", "playerauctions", "unknown", "GameFlip"];
  for (let i = 0; i < 400; i++) {
    const n = Math.floor(rand() * 60);
    const e = [];
    for (let k = 0; k < n; k++) e.push({ t: NOW - rand() * 40 * DAY, m: markets[Math.floor(rand() * markets.length)] });
    const mine = M.v2Rates(e, NOW, null);
    const units = e.filter((x) => x.t >= NOW - 30 * DAY && x.t <= NOW).map((x) => ({ firstAt: new Date(x.t), market: x.m }));
    const ref = refDemandRates(units, { days: 30, shortDays: 14, now: NOW });
    assert.equal(mine.shelf, ref.shelfPerWeek, "shelf, case " + i);
    assert.equal(mine.other, ref.otherPerWeek, "other, case " + i);
    assert.equal(mine.total, Math.round((ref.shelfPerWeek + ref.otherPerWeek) * 10) / 10, "total, case " + i);
    assert.equal(mine.source, "brain");
  }
});

test("v2: production's own demandRates is called when it is handed in", () => {
  const calls = [];
  const fake = (units, opts) => {
    calls.push({ units, opts });
    return { shelfPerWeek: 1.24, otherPerWeek: 3.36 };
  };
  const r = M.v2Rates([at(1), at(40)], NOW, fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].units.length, 1, "only the 30-day window is handed over");
  assert.ok(calls[0].units[0].firstAt instanceof Date);
  assert.deepEqual(calls[0].opts, { days: 30, shortDays: 14, now: NOW });
  assert.deepEqual(r, { shelf: 1.2, other: 3.4, total: 4.6, source: "farmDemand" });
});

test("estimate splits shelf from other markets", () => {
  const e = [at(1, "gameflip"), at(2, "ggsel"), at(3, "eldorado"), at(4, "unknown")];
  const r = M.estimate("avg30", e, NOW);
  assert.equal(r.shelf, Math.round(((2 * 7) / 30) * 100) / 100);
  assert.equal(r.other, Math.round(((2 * 7) / 30) * 100) / 100);
  assert.equal(r.total, Math.round(((4 * 7) / 30) * 100) / 100);
  assert.deepEqual(M.estimate("bogus", e, NOW), { shelf: 0, other: 0, total: 0 });
});

/* ------------------------------- claim verdict ------------------------------- */

const radar = (o) => ({ perWeek: 10, units: 20, rivalSellers: 3, rivalsLive: 9, realised: { median: 2 }, ...o });

test("market view: our own share is measured on the three watched markets only", () => {
  const e = [at(1, "gameflip"), at(2, "ggsel"), at(3, "digiseller"), at(4, "eldorado"), at(5, "eldorado")];
  const v = M.marketView(radar(), e, NOW);
  assert.equal(v.ourWatched, Math.round(Math.max((3 * 7) / 30, (3 * 7) / 14) * 100) / 100);
  assert.equal(v.rivalPerWeek, 10);
  assert.equal(M.marketView(null, e, NOW), null);
  assert.equal(M.marketView(radar({ perWeek: null }), e, NOW).rivalPerWeek, null);
});

test("claim verdict: no evidence at all is 'unknown', not a skip", () => {
  const v = M.claimVerdict({ own: 0, market: null, cfg: CFG, sizing: SIZING, evidence: { sold135: false, listed135: false } });
  assert.equal(v.c, "unknown");
  assert.equal(v.t, 0);
  assert.equal(v.b, "none");
});

test("claim verdict: listed but never sold, or a watched market with no sales, is a skip", () => {
  assert.equal(M.claimVerdict({ own: 0, cfg: CFG, sizing: SIZING, evidence: { listed135: true } }).c, "skip");
  const mv = M.marketView(radar({ perWeek: 0, units: 0 }), [], NOW);
  assert.equal(M.claimVerdict({ own: 0, market: mv, cfg: CFG, sizing: SIZING, evidence: {} }).c, "skip");
});

test("claim verdict: our own sales size the target with the engine's own cover arithmetic", () => {
  const v = M.claimVerdict({ own: 3.5, value: 2, cfg: CFG, sizing: SIZING, evidence: { sold135: true } });
  assert.equal(v.c, "farm");
  assert.equal(v.b, "own");
  assert.equal(v.t, farmSizing.coverageTarget({ salesPerWeek: 3.5, coverageDays: 28, safetyStock: 6, max: 250 }));
  assert.equal(v.t, 20);
  assert.equal(v.u, 7);
});

test("claim verdict: thresholds — too few sales, or too little money, is a skip", () => {
  assert.equal(M.claimVerdict({ own: 0.2, cfg: CFG, sizing: SIZING, evidence: { sold135: true } }).c, "skip");
  assert.equal(M.DEFAULTS.minWeeklyUsd, 0.25);
  const cheap = M.claimVerdict({ own: 1, value: 0.2, cfg: CFG, sizing: SIZING, evidence: { sold135: true } });
  assert.equal(cheap.c, "skip");
  assert.match(cheap.why.join(" "), /under \$0\.25/);
  assert.equal(M.claimVerdict({ own: 0.7, value: 0.95, cfg: CFG, sizing: SIZING, evidence: { sold135: true } }).c, "farm", "a small steady seller is farmed");
  // value unknown: the money check is not applied
  assert.equal(M.claimVerdict({ own: 1, value: 0, cfg: CFG, sizing: SIZING, evidence: { sold135: true } }).c, "farm");
});

test("claim verdict: a proven market we do not sell in is a PROBE, never more than the probe size", () => {
  const mv = M.marketView(radar({ perWeek: 40, units: 60 }), [], NOW);
  const v = M.claimVerdict({ own: 0, market: mv, value: 1.5, cfg: CFG, sizing: SIZING, probeSize: 15, evidence: {} });
  assert.equal(v.c, "probe");
  assert.equal(v.b, "market");
  assert.equal(v.mp, 8);
  assert.equal(v.t, 15, "cover would be 38; the probe size caps it");
  assert.equal(v.sh, 0);
});

test("claim verdict: an unproven market (too slow, too few units) adds nothing", () => {
  for (const r of [radar({ perWeek: 0.5, units: 10 }), radar({ perWeek: 5, units: 2 })]) {
    const v = M.claimVerdict({ own: 0, market: M.marketView(r, [], NOW), cfg: CFG, sizing: SIZING, evidence: {} });
    assert.equal(v.mp, 0);
    assert.equal(v.c, "skip");
    assert.equal(v.proof, false);
  }
});

test("claim verdict: market-led when our share is small; our sales win when they are bigger", () => {
  const e = [at(1, "gameflip")];
  const big = M.claimVerdict({ own: 1, market: M.marketView(radar({ perWeek: 50, units: 80 }), e, NOW), value: 2, cfg: CFG, sizing: SIZING, evidence: { sold135: true } });
  assert.equal(big.c, "farm");
  assert.equal(big.b, "market");
  assert.ok(big.w > 1);
  const small = M.claimVerdict({ own: 6, market: M.marketView(radar({ perWeek: 5, units: 9 }), e, NOW), value: 2, cfg: CFG, sizing: SIZING, evidence: { sold135: true } });
  assert.equal(small.b, "own");
  assert.equal(small.w, 6);
});

test("claim verdict: the owner's per-game cap is a ceiling", () => {
  const v = M.claimVerdict({ own: 20, cfg: CFG, sizing: SIZING, gameCap: 30, evidence: { sold135: true } });
  assert.equal(v.t, 30);
  assert.match(v.why.join(" "), /your cap/);
  assert.equal(M.claimVerdict({ own: 1, cfg: CFG, sizing: SIZING, gameCap: 30, evidence: { sold135: true } }).t, 10);
});

/* ------------------------------ old vs brain -------------------------------- */

test("old verdict: demandAllocation's skip / probe / full / half, sized as the decide step sizes it", () => {
  assert.deepEqual(M.oldClaim({ skip: true, demand: 4.2, effective: 4.2 }, { count: 9 }), { c: "skip", t: 0, w: 1.4, n: 9, ds: 4.2, ra: null, pb: false });
  assert.equal(M.oldClaim({ skip: true, probeBlocked: true, effective: 1 }, { count: 0 }).pb, true, "a probe held by budget or cooldown");
  const probe = M.oldClaim({ cap: 30, target: 15, probe: true, effective: 3 }, { count: 0 }, { floor: 18, maxPerGame: 30 });
  assert.equal(probe.c, "probe");
  assert.equal(probe.t, 15, "a probe gets no shelf floor (decide.js: floor = alloc.probe ? 0 : ...)");
  // half allocation under the floor: decide.js asks min(max(target, floor), cap)
  assert.equal(M.oldClaim({ cap: 30, target: 15, effective: 20 }, { count: 3 }, { floor: 18, maxPerGame: 30 }).t, 18);
  assert.equal(M.oldClaim({ cap: 0, target: 15, effective: 20 }, { count: 3 }, { floor: 40, maxPerGame: 30 }).t, 30, "never above the cap (or maxPerGame when the cap is 0)");
  const f = M.oldClaim({ cap: 60, target: 60, effective: 55 }, { count: 30 }, { floor: 18, maxPerGame: 30, researchAt: new Date(NOW - 3 * DAY), now: NOW });
  assert.equal(f.c, "farm");
  assert.equal(f.t, 60);
  assert.equal(f.ra, 3, "research age in days");
  assert.equal(f.w, Math.round(((30 * 7) / 45) * 100) / 100);
  assert.equal(M.oldClaim(null, null).c, "error");
  assert.equal(M.oldClaim({ error: "boom" }, null).e, "boom");
});

test("brain verdict: the engine's shelf floor applies to a farm, never to a probe; your cap still wins", () => {
  const small = M.claimVerdict({ own: 1, value: 2, cfg: CFG, sizing: SIZING, floor: 18, evidence: { sold135: true } });
  assert.equal(small.c, "farm");
  assert.equal(small.td, 10, "demand alone: ceil(1 x 4) + 6");
  assert.equal(small.t, 18, "raised to the floor");
  assert.match(small.why.join(" "), /shelf floor makes it 18/);
  const big = M.claimVerdict({ own: 6, value: 2, cfg: CFG, sizing: SIZING, floor: 18, evidence: { sold135: true } });
  assert.equal(big.t, big.td, "a bigger demand target is not touched");
  const mv = M.marketView(radar({ perWeek: 40, units: 60 }), [], NOW);
  assert.equal(M.claimVerdict({ own: 0, market: mv, value: 1.5, cfg: CFG, sizing: SIZING, probeSize: 15, floor: 18, evidence: {} }).t, 15);
  assert.equal(M.claimVerdict({ own: 1, cfg: CFG, sizing: SIZING, floor: 18, gameCap: 12, evidence: { sold135: true } }).t, 12);
});

test("diff classes, including the tolerance edges", () => {
  const farm = (t) => ({ c: "farm", t });
  assert.equal(M.diffClass(farm(30), farm(33)), "agree");
  assert.equal(M.diffClass(farm(30), farm(36)), "agree", "20% of 30 = 6");
  assert.equal(M.diffClass(farm(30), farm(37)), "brain-more");
  assert.equal(M.diffClass(farm(30), farm(23)), "brain-less");
  assert.equal(M.diffClass(farm(5), farm(8)), "agree", "at least 3 accounts");
  assert.equal(M.diffClass({ c: "skip", t: 0 }, { c: "skip", t: 0 }), "agree-skip");
  assert.equal(M.diffClass({ c: "skip", t: 0 }, { c: "probe", t: 15 }), "brain-farm");
  assert.equal(M.diffClass({ c: "probe", t: 15 }, { c: "skip", t: 0 }), "brain-skip");
  assert.equal(M.diffClass({ c: "error", t: 0 }, farm(3)), "old-error");
  assert.equal(M.diffClass(farm(3), { c: "unknown", t: 0 }), "brain-unknown");
  assert.equal(M.fleetDiff(250, 250), "agree");
  assert.equal(M.fleetDiff(158, 120), "brain-less");
});

/* --------------------------------- no-claim --------------------------------- */

const snap = (o = {}) => ({
  key: "rainbow six",
  label: "Rainbow Six",
  target: 158,
  onHand: 50,
  sales: { perWeek: 27.6, shelfPerWeek: 4.2, otherPerWeek: 23.4 },
  stock: { listed: 50, held: 0, inFlight: 0 },
  policy: { coverageDays: 28, safetyStock: 6, min: 0, max: 600 },
  ...o,
});

// A snapshot row whose target IS shelfAwareTarget of its own rates, as the feeder computes it.
function realSnap() {
  const sales = { perWeek: 27.6, shelfPerWeek: 4.2, otherPerWeek: 23.4 };
  const target = farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 4.2, otherPerWeek: 23.4, coverageDays: 28, safetyStock: 6, min: 0, max: 600 }).target;
  return snap({ sales, target });
}

test("no-claim v2: the brain uses the feeder's OWN rates, so its target is the feeder's whatever the evidence says", () => {
  const s = realSnap();
  // evidence that, re-derived, would give a very different rate (an older look-back dates differently)
  const e = [];
  for (let d = 0.5; d < 30; d += 3) e.push(at(d, "ggsel"));
  const v = M.noclaimVerdict({ snapRow: s, entries: e, now: NOW, cfg: CFG });
  assert.equal(v.br.t, s.target);
  assert.equal(v.old.t, s.target);
  assert.equal(v.br.b, "feeder");
  assert.equal(v.br.sh, 4.2);
  assert.equal(v.est.v2, 27.6, "the logged v2 forecast is the feeder's own weekly rate");
  assert.equal(typeof v.est.avg30, "number", "the other estimators run on the evidence");
  // and with no evidence at all, still the feeder's number — not a mirror
  const nv = M.noclaimVerdict({ snapRow: s, entries: null, now: NOW, cfg: CFG });
  assert.equal(nv.br.t, s.target);
  assert.equal(nv.br.b, "feeder");
});

test("no-claim, another estimator: computed from the evidence; unreadable evidence is a 'mirror', not an agreement", () => {
  const cfg = M.readConfig({ demandBrain: { estimatorNoclaim: "avg30" } });
  const e = [];
  for (let d = 0.5; d < 30; d += 1.1) e.push(at(d, d < 10 ? "ggsel" : "eldorado"));
  const v = M.noclaimVerdict({ snapRow: realSnap(), entries: e, now: NOW, cfg });
  const r = M.estimate("avg30", e, NOW);
  assert.equal(v.br.t, farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: r.shelf, otherPerWeek: r.other, coverageDays: 28, safetyStock: 6, min: 0, max: 600 }).target);
  const m = M.noclaimVerdict({ snapRow: realSnap(), entries: null, now: NOW, cfg });
  assert.equal(m.br.b, "mirror");
  assert.equal(m.est, null);
  const run = M.buildRun({ now: NOW, cfg, sizing: SIZING, noclaim: [{ snapRow: realSnap(), entries: null, spans: [], radarRows: [], keywords: ["rainbow six"], live: true }] });
  assert.equal(run.rows[0].d, "mirror");
  assert.equal(run.summary.noclaim.byDiff.mirror, 1);
  assert.equal(run.summary.noclaim.byDiff.agree, 0);
});

test("bucket market sums every game in the bucket", () => {
  const rows = [
    { key: "tom clancy s rainbow six siege", perWeek: 3, units: 9, rivalSellers: 2 },
    { key: "rainbow six mobile", perWeek: null, units: 1, rivalSellers: 1 },
    { key: "overwatch 2", perWeek: 9, units: 30, rivalSellers: 5 },
  ];
  assert.deepEqual(M.bucketMarket(rows, "rainbow six"), { rivalPerWeek: 3, rivalUnits: 10, rivalSellers: 3 });
  assert.equal(M.bucketMarket(rows, "call of duty"), null);
});

test("buckets: the LONGEST keyword wins (farmDemand.bucketFor), so overlapping keywords never double-count", () => {
  const kw = ["call of duty", "call of duty warzone", "overwatch"];
  assert.equal(M.bucketOfKey("call of duty warzone 2", kw), "call of duty warzone");
  assert.equal(M.bucketOfKey("call of duty black ops 7", kw), "call of duty");
  assert.equal(M.bucketOfKey("rocket league", kw), "");
  const rows = [
    { key: "call of duty warzone 2", perWeek: 5, units: 10, rivalSellers: 2 },
    { key: "call of duty black ops 7", perWeek: 1, units: 3, rivalSellers: 1 },
  ];
  assert.equal(M.bucketMarket(rows, "call of duty", kw).rivalUnits, 3, "the warzone game belongs to its own bucket");
  assert.equal(M.bucketMarket(rows, "call of duty warzone", kw).rivalUnits, 10);
});

/* ---------------------------------- a run ---------------------------------- */

function claimGame(o = {}) {
  return {
    key: "game a",
    label: "Game A",
    live: true,
    hoursLeft: 50,
    reuseOnly: false,
    entries: [at(1), at(3), at(6), at(9), at(12), at(20)],
    spans: [[NOW - 60 * DAY, NOW]],
    radar: radar({ perWeek: 4, units: 8 }),
    value: 2,
    valueBasis: "our sales",
    gameCap: 0,
    stock: { onHand: 4, inFlight: 2 },
    act: { d: "farm", at: new Date(NOW - DAY), t: 30 },
    old: { alloc: { cap: 30, target: 15, effective: 20 }, sales: { count: 12 } },
    ...o,
  };
}

// Every number anywhere in a value must be finite. (JSON.stringify cannot be used for this: it
// writes NaN and Infinity as null.)
function assertFinite(v, path = "row") {
  if (typeof v === "number") return assert.ok(Number.isFinite(v), path + " = " + v);
  if (v && typeof v === "object" && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) assertFinite(x, path + "." + k);
}

test("the finiteness check really catches NaN and Infinity", () => {
  assert.throws(() => assertFinite({ a: { b: [1, NaN] } }), /a\.b\.1 = NaN/);
  assert.throws(() => assertFinite({ t: Infinity }), /Infinity/);
  assertFinite({ a: null, b: "x", c: [1, 2], d: new Date() });
});

test("buildRun: one row per game and bucket, every number finite, reasons kept, summary adds up", () => {
  const run = M.buildRun({
    now: NOW,
    cfg: CFG,
    sizing: SIZING,
    probeSize: 15,
    engine: { floor: 18, maxPerGame: 30 },
    claim: [
      claimGame(),
      claimGame({ key: "game b", label: "Game B", live: false, entries: [], spans: [], radar: null, old: { alloc: { skip: true, effective: 2 }, sales: { count: 0 } } }),
      claimGame({ key: "game c", label: "Game C", entries: [], spans: [], radar: radar({ perWeek: 30, units: 50 }), old: { alloc: { skip: true, effective: 5 }, sales: { count: 0 } } }),
      claimGame({ key: "game d", label: "Game D", old: { error: "db down" } }),
      claimGame({ key: "game e", label: "Game E", value: NaN, radar: radar({ perWeek: NaN, units: undefined, realised: null }), stock: { onHand: undefined, inFlight: "x" }, old: { alloc: { cap: NaN, target: "15" }, sales: { count: NaN } } }),
    ],
    noclaim: [{ snapRow: realSnap(), entries: [at(1, "eldorado"), at(2, "ggsel")], spans: [], radarRows: [], keywords: ["rainbow six"], live: true }],
  });
  assert.equal(run.rows.length, 6);
  for (const r of run.rows) assertFinite(r, r.k);
  assertFinite(run.summary, "summary");
  const [a, b, c, d, , nc] = run.rows;
  assert.equal(a.f, "claim");
  assert.equal(a.br.c, "farm");
  assert.ok(Array.isArray(a.why) && a.why.length);
  assert.equal(b.br.c, "unknown");
  assert.equal(b.d, "brain-unknown");
  assert.equal(c.br.c, "probe");
  assert.equal(c.d, "brain-farm");
  assert.equal(d.old.c, "error");
  assert.equal(d.old.e, "db down");
  assert.equal(d.d, "old-error");
  assert.equal(nc.f, "noclaim");
  assert.equal(nc.old.t, realSnap().target);
  assert.equal(nc.d, "agree", "the feeder's own rule: the brain's number is the feeder's");
  assert.equal(a.old.t, 18, "today: half allocation 15 raised to the shelf floor 18");
  assert.ok(a.br.t >= 18, "brain: the same floor");
  const s = run.summary;
  assert.equal(s.claim.games, 5);
  assert.equal(s.claim.live, 4);
  assert.equal(s.claim.byDiffLive["brain-farm"], 1);
  // live: A (today farms 18), C (today skips), D (errored), E — totals compare A, C and E
  assert.equal(s.claim.comparedLive, 3);
  assert.equal(s.claim.oldTargetLive, 18 + run.rows[4].old.t, "a skip asks for nothing; an errored verdict is not compared");
  assert.equal(s.claim.brainTargetLive, a.br.t + c.br.t + run.rows[4].br.t);
  assert.equal(s.claim.unknownLive, 0);
  assert.equal(s.noclaim.buckets, 1);
  assert.equal(s.noclaim.oldTarget, realSnap().target);
  assert.deepEqual(a.stk, { on: 4, fl: 2 });
  assert.equal(a.act.d, "farm");
  for (const id of M.ESTIMATORS) assert.equal(typeof a.est[id], "number", id);
});

/* --------------------------------- scoring --------------------------------- */

test("backtest: a steady seller is forecast well, a one-off burst misleads the short window", () => {
  const steady = [];
  for (let d = 0.5; d < 130; d += 1) steady.push(at(d));
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(at(50 + i * 0.1));
  const bt = M.backtest({ games: [{ key: "s", farm: "claim", entries: steady }, { key: "b", farm: "claim", entries: burst }, { key: "dead", farm: "claim", entries: [] }], now: NOW, weeks: 6 });
  assert.equal(bt.weeks.length, 6);
  const sc = bt.scores.claim;
  for (const id of M.ESTIMATORS) assert.ok(sc[id].n >= 6, id);
  assert.ok(sc.avg30.mae <= sc.max30_14.mae + 1e-9, "the burst decays out of the 30-day average more slowly than the 14-day spike");
  assert.ok(bt.best.claim && M.ESTIMATORS.includes(bt.best.claim.id));
  assert.ok(bt.weeks.every((w) => w.games <= 2), "a game with no sale before or during a week is not scored");
});

test("backtest: weeks the game was listed all week are scored apart (claim farm only)", () => {
  const e = [];
  for (let d = 0.5; d < 120; d += 2) e.push(at(d));
  const listedAll = [[NOW - 200 * DAY, NOW]];
  const listedNever = [];
  const bt = M.backtest({
    games: [
      { key: "s", farm: "claim", entries: e, spans: listedAll },
      { key: "n", farm: "claim", entries: e, spans: listedNever },
      { key: "nc", farm: "noclaim", entries: e, spans: listedAll },
    ],
    now: NOW,
    weeks: 3,
  });
  assert.equal(bt.scores.claim.avg30.n, 6, "both claim games, three weeks");
  assert.equal(bt.scoresInStock.claim.avg30.n, 3, "only the listed one");
  assert.equal(bt.scoresInStock.noclaim, undefined, "never the no-claim farm");
  assert.ok(bt.weeks.every((w) => w.inStock === 1));
  assert.ok(bt.bestInStock.claim);
  // half-listed week: 3 days listed of 7 is not in stock
  const half = M.backtest({ games: [{ key: "h", farm: "claim", entries: e, spans: [[NOW - 7 * DAY, NOW - 4 * DAY]] }], now: NOW, weeks: 1 });
  assert.equal(Object.keys(half.scoresInStock).length, 0);
});

test("forward scores: only runs whose week is over; the engine's own reading is scored beside the estimators", () => {
  const T = NOW - 9 * DAY;
  const entries = [{ t: T + DAY, m: "gameflip" }, { t: T + 2 * DAY, m: "gameflip" }, { t: T + 8 * DAY, m: "gameflip" }];
  const samples = [
    { at: new Date(T), rows: [{ f: "claim", k: "a", old: { c: "farm", w: 5 }, est: { avg30: 2, max30_14: 3 } }, { f: "claim", k: "z", old: { c: "error", w: 9 }, est: { avg30: 0 } }] },
    { at: new Date(NOW - 2 * DAY), rows: [{ f: "claim", k: "a", old: { c: "farm", w: 5 }, est: { avg30: 2 } }] },
  ];
  const fw = M.forwardScores({ samples, entriesFor: (f, k) => (k === "a" ? entries : []), now: NOW });
  assert.equal(fw.runsScored, 1);
  assert.equal(fw.runsWaiting, 1);
  assert.deepEqual(fw.scores.claim.engine, { n: 1, mae: 3, rmse: 3, bias: 3, forecast: 5, actual: 2 });
  assert.equal(fw.scores.claim.avg30.mae, 0);
  assert.equal(fw.best.claim.id, "avg30");
  assert.equal(fw.scores.claim.engine.n, 1, "an errored old verdict is not scored, and an all-zero row is skipped");
  // in-stock split: only rows whose game was listed all week
  const fw2 = M.forwardScores({ samples, entriesFor: (f, k) => (k === "a" ? entries : []), spansFor: () => [[T - DAY, NOW]], now: NOW });
  assert.equal(fw2.scoresInStock.claim.avg30.n, 1);
  const fw3 = M.forwardScores({ samples, entriesFor: (f, k) => (k === "a" ? entries : []), spansFor: () => null, now: NOW });
  assert.deepEqual(fw3.scoresInStock, {});
});

test("decision review: live claim disagreements a week old, with what happened next", () => {
  const T = NOW - 8 * DAY;
  const samples = [
    {
      at: new Date(T),
      rows: [
        { f: "claim", k: "a", g: "A", live: true, d: "brain-farm", old: { c: "skip", t: 0 }, br: { c: "probe", t: 15, b: "market" } },
        { f: "claim", k: "b", g: "B", live: false, d: "brain-farm", old: { c: "skip", t: 0 }, br: { c: "probe", t: 15, b: "market" } },
        { f: "claim", k: "c", g: "C", live: true, d: "agree", old: { c: "farm", t: 10 }, br: { c: "farm", t: 11 } },
        { f: "noclaim", k: "rainbow six", g: "R6", live: true, d: "brain-more", old: { c: "fleet", t: 1 }, br: { c: "fleet", t: 9 } },
      ],
    },
  ];
  const out = M.decisionReview({ samples, entriesFor: () => [{ t: T + DAY }, { t: T + 9 * DAY }], rivalUnitsFor: () => 7, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "a");
  assert.equal(out[0].ourSales7, 1);
  assert.equal(out[0].rivalUnits7, 7);
});

test("summary: a game the brain has no evidence for is counted apart, never as a zero", () => {
  const rows = [
    { f: "claim", live: true, d: "brain-unknown", old: { c: "farm", t: 30 }, br: { c: "unknown", t: 0 } },
    { f: "claim", live: true, d: "brain-less", old: { c: "farm", t: 30 }, br: { c: "farm", t: 10 } },
    { f: "claim", live: false, d: "brain-farm", old: { c: "skip", t: 0 }, br: { c: "probe", t: 15 } },
  ];
  const s = M.summarize(rows).claim;
  assert.deepEqual(
    { live: s.live, comparedLive: s.comparedLive, unknownLive: s.unknownLive, oldTargetLive: s.oldTargetLive, brainTargetLive: s.brainTargetLive, oldTargetUnknownLive: s.oldTargetUnknownLive },
    { live: 2, comparedLive: 1, unknownLive: 1, oldTargetLive: 30, brainTargetLive: 10, oldTargetUnknownLive: 30 },
  );
  assert.equal(s.byDiff["brain-farm"], 1);
});

test("best estimator: lowest RMSE, ties broken by the smaller bias", () => {
  const b = M.bestOf({ claim: { a: { n: 3, rmse: 1, mae: 1, bias: 0.9 }, b: { n: 3, rmse: 1, mae: 1, bias: -0.2 }, c: { n: 0, rmse: null, mae: null, bias: null } } });
  assert.equal(b.claim.id, "b");
});

test("best estimator is not fooled by forecasting zero for small sellers (RMSE, not MAE)", () => {
  // Ten game-weeks of a game that sells 0.3 a week on average: mostly 0, sometimes 1.
  const games = [];
  const weeks = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const entries = [];
  weeks.forEach((n, i) => {
    for (let k = 0; k < n; k++) entries.push({ t: NOW - (70 - i * 7) * DAY + DAY, m: "gameflip" });
  });
  games.push({ key: "small", farm: "claim", entries });
  // score two hand-made forecasters on the same truth: always 0 vs the true mean 0.3
  const zero = { n: 0, absErr: 0, sqErr: 0, err: 0 };
  const mean = { n: 0, absErr: 0, sqErr: 0, err: 0 };
  for (const a of weeks) {
    for (const [s, f] of [[zero, 0], [mean, 0.3]]) {
      s.n++;
      s.absErr += Math.abs(f - a);
      s.sqErr += (f - a) ** 2;
      s.err += f - a;
    }
  }
  const fin = (s) => ({ n: s.n, mae: s.absErr / s.n, rmse: Math.sqrt(s.sqErr / s.n), bias: s.err / s.n });
  assert.ok(fin(zero).mae < fin(mean).mae, "MAE prefers forecasting zero");
  assert.equal(M.bestOf({ claim: { zero: fin(zero), mean: fin(mean) } }).claim.id, "mean", "RMSE prefers the mean");
  assert.ok(M.backtest({ games, now: NOW, weeks: 6 }).scores.claim.avg45.rmse != null, "the backtest reports RMSE");
});
