// The farm brain, model v2 (docs/LIVE-FIXES-1003.md §A8, docs/DEMAND-BRAIN-PLAN.md): the
// intermittent-demand estimators sba and tsb (hand-checked on known series), the no-claim feeder's
// burst-guarded rule v2g, cold probes for new drops, the heartbeat's cold-probe clause and the health
// hook. The loader's probe-history read is in tests/demandBrainInputs.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../utils/demandBrain/model");
const B = require("../utils/demandBrain");
const farmSizing = require("../utils/farmSizing");

const DAY = 86400000;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const approx = (a, b, what, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, what + ": " + a + " vs " + b);

test.beforeEach(() => B._reset());
test.after(() => B._reset());

// Entries putting counts[i] sales in week i of a counts.length-week window ending at NOW (oldest
// first), each in the middle of its week.
function weeksOf(counts, market = "gameflip") {
  const out = [];
  const n = counts.length;
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) out.push({ t: NOW - (n - 1 - i) * WEEK - 3.5 * DAY, m: market });
  });
  return out;
}

// Production's auto-farm settings for what the brain reads (2026-10-02): Plati blocked, GGSel on.
const AF = { perMarketStock: 3, platiEnabled: false, ggselEnabled: true, probeCooldownDays: 90, demandBrain: { enabled: true } };
const CFG = M.readConfig(AF);
const SIZING = { coverageDays: 28, safetyStock: 6, maxPerGame: 250 };
const radar = (o) => ({ perWeek: 10, units: 20, rivalSellers: 3, rivalsLive: 9, realised: { median: 2 }, ...o });

// Series A, 13 weeks oldest first: 4 sold in week 4, 2 in week 13.
const A = [0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 2];

/* ------------------------------ weekly counts ------------------------------ */

test("v2 weekly counts: 13 weeks, oldest first, the same (now − days, now] window as every average", () => {
  assert.equal(M.INTERMITTENT_WEEKS, 13);
  const e = [{ t: NOW }, { t: NOW - WEEK + 1 }, { t: NOW - WEEK }, { t: NOW - 13 * WEEK + 1 }, { t: NOW - 13 * WEEK }, { t: NOW + 1 }];
  const y = M.weeklyCounts(e, NOW);
  assert.deepEqual(y, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
  assert.equal(y.reduce((a, v) => a + v, 0), M.countIn(e, NOW, 91), "the weeks hold exactly what countIn counts");
  assert.deepEqual(M.weeklyCounts(weeksOf(A), NOW), A);
});

test("v2 the 13-week series fits inside the evidence even under the oldest backtest week", () => {
  assert.ok(M.INTERMITTENT_WEEKS * 7 + B.BACKTEST_WEEKS * 7 <= M.HISTORY_DAYS, "13 × 7 + 6 × 7 = 133 ≤ 135");
});

/* ----------------------------------- SBA ----------------------------------- */

test("v2 sba: Croston with the Syntetos–Boylan correction, by hand", () => {
  assert.equal(M.SBA_ALPHA, 0.15);
  // Series A. First selling week is week 4: size 4, interval 4 (counted from the window's start).
  // Next selling week is week 13, 9 weeks later:
  //   size     = 4 + 0.15 × (2 − 4) = 3.7
  //   interval = 4 + 0.15 × (9 − 4) = 4.75
  //   SBA      = (1 − 0.15 / 2) × 3.7 / 4.75 = 0.925 × 0.778947 = 0.720526 → 0.72
  approx(M.sbaRate(A), (0.925 * 3.7) / 4.75, "series A");
  assert.equal(M.estimate("sba", weeksOf(A), NOW).total, 0.72);
  // Sales of 2 in weeks 2, 5 and 8: size stays 2; intervals 2, 3, 3:
  //   interval = 2 → 2 + 0.15 × (3 − 2) = 2.15 → 2.15 + 0.15 × (3 − 2.15) = 2.2775
  //   SBA      = 0.925 × 2 / 2.2775 = 0.812294 → 0.81
  const E = [0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 0];
  approx(M.sbaRate(E), (0.925 * 2) / 2.2775, "series E");
  assert.equal(M.estimate("sba", weeksOf(E), NOW).total, 0.81);
  // Croston's blind spot: silent weeks after the last sale change nothing.
  assert.equal(M.sbaRate(E), M.sbaRate(E.slice(0, 8)));
  // A steady seller (1 every week): size 1, interval 1 → 0.925 — SBA's correction shaves 7.5% off.
  approx(M.sbaRate(new Array(13).fill(1)), 0.925, "steady");
  // No sale at all: 0. One sale of 3 in week 5: 0.925 × 3 / 5 = 0.555.
  assert.equal(M.sbaRate(new Array(13).fill(0)), 0);
  approx(M.sbaRate([0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]), (0.925 * 3) / 5, "one sale");
});

/* ----------------------------------- TSB ----------------------------------- */

test("v2 tsb: Teunter–Syntetos–Babai, by hand", () => {
  assert.equal(M.TSB_ALPHA, 0.15);
  assert.equal(M.TSB_BETA, 0.15);
  // Series A. Start: chance 2/13 (2 of the 13 weeks sold), size (4 + 2) / 2 = 3. Then week by week:
  //   weeks 1–3, no sale:  chance × 0.85³               = 0.153846 × 0.614125 = 0.094481
  //   week 4, sold 4:      chance 0.85 × 0.094481 + 0.15 = 0.230309;  size 3 + 0.15 × (4 − 3) = 3.15
  //   weeks 5–12, no sale: chance × 0.85⁸               = 0.230309 × 0.272491 = 0.062757
  //   week 13, sold 2:     chance 0.85 × 0.062757 + 0.15 = 0.203344;  size 3.15 + 0.15 × (2 − 3.15) = 2.9775
  //   TSB = 0.203344 × 2.9775 = 0.605455 → 0.61
  const c4 = 0.85 * ((2 / 13) * 0.85 ** 3) + 0.15;
  const c13 = 0.85 * (c4 * 0.85 ** 8) + 0.15;
  approx(M.tsbRate(A), c13 * 2.9775, "series A");
  approx(c13, 0.203344, "chance after week 13", 1e-6);
  assert.equal(M.estimate("tsb", weeksOf(A), NOW).total, 0.61);
  // A steady seller: chance 1, size 1, every update keeps them → exactly 1.
  approx(M.tsbRate(new Array(13).fill(1)), 1, "steady");
  assert.equal(M.tsbRate(new Array(13).fill(0)), 0);
});

test("v2 tsb fades a game that stopped selling; sba does not (why both are scored)", () => {
  // 3 a week for the first 4 weeks, then 9 silent weeks.
  const C = [3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // SBA: size 3, interval 1 → 0.925 × 3 = 2.775, whatever followed.
  approx(M.sbaRate(C), 0.925 * 3, "sba");
  // TSB: chance 4/13 → four selling weeks (× 0.85 + 0.15 each) → nine silent weeks (× 0.85⁹); size 3.
  let ch = 4 / 13;
  for (let i = 0; i < 4; i++) ch = 0.85 * ch + 0.15;
  approx(M.tsbRate(C), ch * 0.85 ** 9 * 3, "tsb");
  assert.ok(M.tsbRate(C) < 0.5 && M.sbaRate(C) > 2.7);
});

/* ------------------------- sba / tsb as estimators ------------------------- */

test("v2 sba and tsb are estimators like the others: logged per row, split shelf/other, backtested, forward-scored", () => {
  for (const id of ["sba", "tsb", "v2g"]) assert.ok(M.ESTIMATORS.includes(id), id);
  assert.equal(M.DEFAULTS.estimatorClaim, "avg45", "the defaults are untouched: the test week decides");
  assert.equal(M.DEFAULTS.estimatorNoclaim, "v2");
  assert.equal(M.readConfig({ demandBrain: { estimatorClaim: "tsb" } }).estimatorClaim, "tsb", "selectable live");
  // shelf and other are forecast apart, the total on the whole series
  const shelf = weeksOf(A, "gameflip");
  const other = weeksOf([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], "eldorado");
  const r = M.estimate("sba", shelf.concat(other), NOW);
  assert.equal(r.shelf, 0.72);
  assert.equal(r.other, Math.round(M.sbaRate([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]) * 100) / 100);
  assert.equal(r.total, Math.round(M.sbaRate(M.weeklyCounts(shelf.concat(other), NOW)) * 100) / 100);
  const est = M.allEstimates(weeksOf(A), NOW);
  assert.equal(est.sba, 0.72);
  assert.equal(est.tsb, 0.61);
  // backtest: same game-weeks for every estimator
  const steady = [];
  for (let d = 0.5; d < 130; d += 2) steady.push({ t: NOW - d * DAY, m: "gameflip" });
  const bt = M.backtest({ games: [{ key: "s", farm: "claim", entries: steady }], now: NOW, weeks: 6 });
  for (const id of ["sba", "tsb", "v2g"]) assert.equal(bt.scores.claim[id].n, bt.scores.claim.avg45.n, id);
  // forward: a logged row's sba/tsb are scored once their week is over
  const T = NOW - 8 * DAY;
  const fw = M.forwardScores({
    samples: [{ at: new Date(T), rows: [{ f: "claim", k: "a", old: { c: "farm", w: 1 }, est: { sba: 2, tsb: 1 } }] }],
    entriesFor: () => [{ t: T + DAY, m: "gameflip" }],
    now: NOW,
  });
  assert.deepEqual(fw.scores.claim.sba, { n: 1, mae: 1, rmse: 1, bias: 1, forecast: 2, actual: 1 });
  assert.equal(fw.scores.claim.tsb.mae, 0);
});

/* ----------------------------------- v2g ----------------------------------- */

test("v2g: the feeder's own demandRates with the burst guard ON; v2 pins it OFF; each once per forecast", () => {
  const calls = [];
  const demandRates = (units, opts) => {
    calls.push({ units, opts });
    return opts.burstGuard ? { shelfPerWeek: 1, otherPerWeek: 2 } : { shelfPerWeek: 1, otherPerWeek: 9 };
  };
  const e = [{ t: NOW - DAY, m: "manual" }, { t: NOW - 2 * DAY, m: "gameflip" }, { t: NOW - 40 * DAY, m: "manual" }];
  const est = M.allEstimates(e, NOW, { demandRates });
  assert.equal(est.v2, 10);
  assert.equal(est.v2g, 3, "the guarded numbers, beside v2");
  assert.deepEqual(calls.map((c) => c.opts), [
    { days: 30, shortDays: 14, now: NOW, burstGuard: false },
    { days: 30, shortDays: 14, now: NOW, burstGuard: true },
  ]);
  assert.ok(calls.every((c) => c.units.length === 2), "the 30-day window only");
  // A bulk-pack unit reaches the feeder's guard with its flag (its market alone cannot say "pack").
  calls.length = 0;
  const r = M.v2Rates([{ t: NOW - DAY, m: "eldorado", p: 2, pack: true }, { t: NOW - 2 * DAY, m: "eldorado", p: 2 }], NOW, demandRates, { burstGuard: true });
  assert.deepEqual(calls[0].units, [{ firstAt: new Date(NOW - DAY), market: "eldorado", pack: true }, { firstAt: new Date(NOW - 2 * DAY), market: "eldorado" }]);
  assert.deepEqual(r, { shelf: 1, other: 2, total: 3, source: "farmDemand" });
});

test("v2g, the brain's fallback copy: a one-day hand sale of 40 reads as 20 a week, not 40", () => {
  const burst = Array.from({ length: 40 }, () => ({ t: NOW - 3 * DAY, m: "manual" }));
  // v2: one selling day → in-stock 14-day rate 40 × 7 / max(1, 7) = 40 (30-day: 40 × 7 / 15 = 18.7)
  assert.equal(M.estimate("v2", burst, NOW).total, 40);
  // v2g: a burst counts raw in each window: max(40 × 7 / 30, 40 × 7 / 14) = max(9.33, 20) = 20
  assert.equal(M.estimate("v2g", burst, NOW).total, 20);
  // Other markets keep the in-stock rule and shelf markets their raw rate, in both.
  const mixed = burst.concat([{ t: NOW - 2 * DAY, m: "eldorado" }, { t: NOW - 5 * DAY, m: "eldorado" }, { t: NOW - DAY, m: "gameflip" }]);
  // shelf: max(1 × 7 / 30, 1 × 7 / 14) = 0.5 in both
  // v2:  other = 42 sales on 3 selling days: max(42 × 7 / 15, 42 × 7 / 7) = 42 → total 42.5
  // v2g: other = max(steady 2 × 7 / 15 + burst 40 × 7 / 30, steady 2 × 7 / 7 + burst 40 × 7 / 14)
  //            = max(0.93 + 9.33, 2 + 20) = 22 → total 22.5
  assert.deepEqual(M.estimate("v2", mixed, NOW), { shelf: 0.5, other: 42, total: 42.5 });
  assert.deepEqual(M.estimate("v2g", mixed, NOW), { shelf: 0.5, other: 22, total: 22.5 });
  // Without a burst sale the guard changes nothing.
  const plain = mixed.filter((x) => x.m !== "manual");
  assert.deepEqual(M.estimate("v2g", plain, NOW), M.estimate("v2", plain, NOW));
});

test("v2g: a bulk-pack unit is guarded exactly like a hand sale, whatever market it sold on", () => {
  const pack = Array.from({ length: 40 }, () => ({ t: NOW - 3 * DAY, m: "eldorado", p: 1, pack: true }));
  assert.equal(M.estimate("v2", pack, NOW).total, 40, "unguarded, the lump is a week's demand");
  assert.equal(M.estimate("v2g", pack, NOW).total, 20);
  assert.equal(M.isBurstSale({ market: "eldorado", pack: true }), true);
  assert.equal(M.isBurstSale({ market: "Manual" }), true);
  assert.equal(M.isBurstSale({ market: "eldorado", pack: "yes" }), false, "only an explicit true");
  // the same lump without the flag is an ordinary Eldorado day
  assert.equal(M.estimate("v2g", pack.map(({ t, m, p }) => ({ t, m, p })), NOW).total, 40);
});

// A deterministic pseudo-random stream, so a failing case is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("v2 and v2g: the brain's fallback copy equals the feeder's own demandRates on 400 random histories", () => {
  // The real utils/farmDemand (A4, 2026-10-03), guard pinned both ways as the brain always pins it.
  const FD = require("../utils/farmDemand");
  assert.deepEqual([...FD.BURST_MARKETS], [...M.BURST_MARKETS]);
  const rand = rng(20261003);
  const markets = ["gameflip", "ggsel", "digiseller", "eldorado", "g2g", "playerauctions", "manual", "unknown"];
  for (let i = 0; i < 400; i++) {
    const n = Math.floor(rand() * 60);
    const e = [];
    for (let k = 0; k < n; k++) {
      // lumps: a third of the sales land on one of three days
      const t = rand() < 0.33 ? NOW - [2.5, 9.5, 20.5][Math.floor(rand() * 3)] * DAY : NOW - rand() * 40 * DAY;
      const x = { t, m: markets[Math.floor(rand() * markets.length)], p: 1 };
      if (rand() < 0.15) x.pack = true;
      e.push(x);
    }
    for (const id of ["v2", "v2g"]) {
      const mine = M.estimate(id, e, NOW);
      const theirs = M.estimate(id, e, NOW, { demandRates: FD.demandRates });
      assert.deepEqual(mine, theirs, id + ", case " + i);
    }
  }
});

// A snapshot row whose target IS shelfAwareTarget of its own rates, as the feeder computes it.
function realSnap() {
  const sales = { perWeek: 27.6, shelfPerWeek: 4.2, otherPerWeek: 23.4 };
  const policy = { coverageDays: 28, safetyStock: 6, min: 0, max: 600 };
  const target = farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: 4.2, otherPerWeek: 23.4, ...policy }).target;
  return { key: "rainbow six", label: "Rainbow Six", target, onHand: 50, sales, stock: { listed: 50, held: 0, inFlight: 0 }, policy };
}

test("v2g on the no-claim farm: the snapshot is logged under the rule the feeder runs live", () => {
  // Eldorado about every day and a lump of 20 hand sales on one day.
  const e = [];
  for (let d = 0.5; d < 30; d += 1.5) e.push({ t: NOW - d * DAY, m: "eldorado" });
  for (let i = 0; i < 20; i++) e.push({ t: NOW - 2.2 * DAY, m: "manual" });
  e.sort((a, b) => a.t - b.t);
  const s = realSnap();
  // guard off (today): v2 is the snapshot's own rate, v2g re-derived from the evidence
  const off = M.noclaimVerdict({ snapRow: s, entries: e, now: NOW, cfg: CFG });
  assert.equal(off.est.v2, 27.6);
  assert.equal(off.est.v2g, M.estimate("v2g", e, NOW).total);
  assert.ok(off.est.v2g < M.estimate("v2", e, NOW).total, "the guard lowers a hand-sale lump");
  assert.equal(off.br.t, s.target, "the default no-claim estimator still mirrors the feeder");
  // guard on: the snapshot IS v2g, and v2 is the one re-derived
  const on = M.noclaimVerdict({ snapRow: s, entries: e, now: NOW, cfg: CFG, guardLive: true });
  assert.equal(on.est.v2g, 27.6);
  assert.equal(on.est.v2, M.estimate("v2", e, NOW).total);
  assert.equal(on.br.b, "own", "v2 is no longer the feeder's live rule");
  const mirror = M.noclaimVerdict({ snapRow: s, entries: e, now: NOW, cfg: M.readConfig({ ...AF, demandBrain: { estimatorNoclaim: "v2g" } }), guardLive: true });
  assert.equal(mirror.br.b, "feeder");
  assert.equal(mirror.br.t, s.target);
  // guard off and v2g chosen: computed from the evidence
  const chosen = M.noclaimVerdict({ snapRow: s, entries: e, now: NOW, cfg: M.readConfig({ ...AF, demandBrain: { estimatorNoclaim: "v2g" } }) });
  const r = M.estimate("v2g", e, NOW);
  assert.equal(chosen.br.b, "own");
  assert.equal(chosen.br.t, farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: r.shelf, otherPerWeek: r.other, coverageDays: 28, safetyStock: 6, min: 0, max: 600 }).target);
  // buildRun threads the switch through
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, burstGuardLive: true, noclaim: [{ snapRow: s, entries: e, spans: [], radarRows: [], keywords: ["rainbow six"], live: true }] });
  assert.equal(run.rows[0].est.v2g, 27.6);
});

/* ------------------------------- cold probes ------------------------------- */

test("v2 cold probe size: perMarketStock × open shelf markets (3 × 2 = 6 with Plati blocked), owner-settable, 0 = off", () => {
  assert.equal(M.openShelfMarkets(AF), 2, "Gameflip + GGSel");
  assert.equal(CFG.coldProbeSize, 6);
  assert.equal(M.readConfig({ ...AF, platiEnabled: true }).coldProbeSize, 9);
  assert.equal(M.readConfig({ ...AF, ggselEnabled: false }).coldProbeSize, 3);
  assert.equal(M.readConfig({ ...AF, perMarketStock: 4 }).coldProbeSize, 8);
  assert.equal(M.readConfig({ ...AF, perMarketStock: "junk" }).coldProbeSize, 6, "the engine's own fallback of 3");
  assert.equal(M.readConfig({ ...AF, demandBrain: { coldProbeSize: 10 } }).coldProbeSize, 10);
  assert.equal(M.readConfig({ ...AF, demandBrain: { coldProbeSize: 0 } }).coldProbeSize, 0);
  assert.equal(M.readConfig({ ...AF, demandBrain: { coldProbeSize: "x" } }).coldProbeSize, 6);
  assert.equal(M.readConfig({ ...AF, demandBrain: { coldProbeSize: 9999 } }).coldProbeSize, 250);
  assert.equal(M.probeCooldownDaysOf(AF), 90);
  assert.equal(M.probeCooldownDaysOf({}), 0);
  assert.equal(M.probeCooldownDaysOf({ probeCooldownDays: -5 }), 0);
});

// A live game with no evidence of ours at all, checked against the probe history.
const fresh = (o = {}) => M.claimVerdict({ own: 0, market: null, value: 0, cfg: CFG, sizing: SIZING, probeSize: 15, floor: 12, evidence: {}, live: true, dud: false, ...o });

test("v2 cold probe: a live campaign, no sale or listing of ours, not a dud → probe of 6 (was 'unknown')", () => {
  const v = fresh();
  assert.equal(v.c, "probe");
  assert.equal(v.b, "cold");
  assert.equal(v.t, 6, "no shelf floor on a probe");
  assert.equal(v.td, 0, "no demand number behind it");
  assert.equal(v.w, 0);
  assert.equal(v.dud, false);
  assert.match(v.why.join(" "), /new drop → cold probe of 6/);
  assert.equal(fresh({ gameCap: 4 }).t, 4, "the owner's per-game cap still wins");
  assert.match(fresh({ gameCap: 4 }).why.join(" "), /your cap/);
  assert.equal(fresh({ cfg: M.readConfig({ ...AF, demandBrain: { coldProbeSize: 9 } }) }).t, 9);
  assert.equal(fresh({ sizing: { ...SIZING, maxPerGame: 5 } }).t, 5);
  // a value known from rivals' sold prices does not screen a cold probe (there is no forecast to price)
  assert.equal(fresh({ value: 0.05 }).c, "probe");
});

test("v2 cold probe: a known dud (a probe ended with 0 sales inside the cooldown) → skip", () => {
  const v = fresh({ dud: { at: NOW - 12 * DAY, days: 90 } });
  assert.equal(v.c, "skip");
  assert.equal(v.dud, true);
  assert.equal(v.t, 0);
  assert.match(v.why.join(" "), /ended with 0 sales on 2026-09-28, inside the auto-farm's 90-day re-probe cooldown/);
  assert.match(v.why.join(" "), /known dud/);
});

test("v2 cold probe: rival evidence still upgrades to the existing market-led probe — even over a dud", () => {
  const mv = M.marketView(radar({ perWeek: 40, units: 60 }), [], NOW);
  const v = fresh({ market: mv });
  assert.equal(v.c, "probe");
  assert.equal(v.b, "market");
  assert.equal(v.t, 15, "min(cover 38, probeSize 15), not the cold 6");
  const d = fresh({ market: mv, dud: { at: NOW - 12 * DAY, days: 90 } });
  assert.equal(d.c, "probe");
  assert.equal(d.b, "market");
  assert.match(d.why.join(" "), /ended with 0 sales/, "said, not hidden");
});

test("v2 cold probe never fires without all of its conditions", () => {
  assert.equal(fresh({ live: false }).c, "unknown", "no live campaign: no decision is being made");
  assert.equal(fresh({ dud: null }).c, "unknown", "probe history unread: a possible dud is not probed");
  assert.match(fresh({ dud: null }).why.join(" "), /not readable/);
  assert.equal(fresh({ cfg: M.readConfig({ ...AF, demandBrain: { coldProbeSize: 0 } }) }).c, "unknown", "switched off");
  assert.equal(fresh({ evidence: { listed135: true } }).c, "skip", "listed and never sold: model v1's skip");
  assert.equal(fresh({ evidence: { sold135: true } }).c, "skip", "sold long ago, nothing recent: v1's skip");
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: 0, units: 0 }), [], NOW) }).c, "skip", "a watched market that sells nothing");
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: 0.5, units: 2 }), [], NOW) }).c, "skip", "an unproven market");
  // a market watched under two days has no rate yet: no evidence, so the cold rule applies
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: null, ratePartial: true }), [], NOW) }).b, "cold");
});

/* ------------------------------ run + summary ------------------------------ */

function newDrop(key, o = {}) {
  return {
    key,
    label: key.toUpperCase(),
    live: true,
    hoursLeft: 100,
    reuseOnly: false,
    entries: [],
    spans: [],
    radar: null,
    value: 0,
    valueBasis: "",
    gameCap: 0,
    stock: null,
    act: null,
    dud: false,
    old: { alloc: { cap: 30, target: 15, probe: true, effective: 0 }, sales: { count: 0 } },
    ...o,
  };
}

const PACK_CLAIM = [
  newDrop("new a"), // today probes 15
  newDrop("new b", { old: { alloc: { skip: true, probeBlocked: true, effective: 0 }, sales: { count: 0 } } }), // today: probe held by the budget
  newDrop("dud c", { dud: { at: NOW - 10 * DAY, days: 90 } }),
  newDrop("unread d", { dud: null }),
  newDrop("closed e", { live: false, dud: null }),
];

test("v2 run: cold probes are logged against today's verdict and counted apart", () => {
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, probeSize: 15, engine: { floor: 12, maxPerGame: 30 }, claim: PACK_CLAIM });
  const by = Object.fromEntries(run.rows.map((r) => [r.k, r]));
  assert.deepEqual([by["new a"].br.c, by["new a"].br.t, by["new a"].br.b], ["probe", 6, "cold"]);
  assert.equal(by["new a"].d, "brain-less", "today probes 15, the brain 6");
  assert.equal(by["new b"].d, "brain-farm", "today holds the probe (budget), the brain probes");
  assert.equal(by["dud c"].br.c, "skip");
  assert.equal(by["dud c"].br.dud, true);
  assert.equal(by["dud c"].d, "brain-skip");
  assert.equal(by["unread d"].br.c, "unknown");
  assert.equal(by["closed e"].br.c, "unknown");
  assert.equal("dud" in by["new a"].br, false, "the flag is only written where it is true");
  const s = run.summary.claim;
  assert.equal(s.coldProbes, 2);
  assert.equal(s.coldTarget, 12);
  assert.equal(s.oldTargetCold, 15, "15 on new a, nothing on new b");
  assert.equal(s.coldDuds, 1);
  assert.equal(s.unknownLive, 1, "only the unread one");
  assert.equal(s.comparedLive, 3, "cold probes and the dud are verdicts: compared");
  assert.equal(s.brainTargetLive, 12);
  assert.equal(s.oldTargetLive, 30);
});

function fakeModels() {
  const runs = [];
  const rows = [];
  return {
    runs,
    rows,
    Run: () => ({
      create: async (doc) => {
        const saved = { ...JSON.parse(JSON.stringify(doc)), _id: "run" + (runs.length + 1) };
        runs.push(saved);
        return saved;
      },
    }),
    Row: () => ({
      insertMany: async (list) => {
        rows.push(...JSON.parse(JSON.stringify(list)));
        return list;
      },
    }),
  };
}

function pack(now) {
  return {
    now,
    sizing: SIZING,
    probeSize: 15,
    probeCooldownDays: 90,
    engine: { floor: 12, maxPerGame: 30 },
    claim: PACK_CLAIM,
    noclaim: [],
    demandRates: null,
    burstGuardLive: false,
    notes: [],
    evidence: null,
    counts: {},
  };
}

test("v2 runner: model v2 logged, the heartbeat says 'cold probes N (old asks M)', the cold rows persist", async () => {
  const m = fakeModels();
  const lines = [];
  B._setHooks({ settings: () => ({ getAutoFarm: () => AF }), load: async ({ now }) => pack(now), Run: m.Run, Row: m.Row, log: (...a) => lines.push(a.join(" ")), logErr: () => {} });
  const r = await B.runOnce();
  assert.equal(r.ok, true);
  assert.equal(M.MODEL_VERSION, 2);
  assert.equal(m.runs[0].v, 2);
  assert.equal(m.runs[0].cfg.coldProbeSize, 6);
  assert.equal(m.runs[0].cfg.probeCooldownDays, 90);
  assert.equal(m.runs[0].cfg.noclaimBurstGuard, false);
  const hb = lines.find((l) => /^demandBrain: run 1 /.test(l));
  assert.ok(hb, lines.join("\n"));
  assert.match(hb, /\(model v2, avg45\)/);
  assert.match(hb, / \| cold probes 2 \(old asks 15\) \| /);
  const a = m.rows.find((x) => x.k === "new a");
  assert.equal(a.br.b, "cold", "the row keeps what made it a cold probe");
  assert.equal(m.rows.find((x) => x.k === "dud c").br.dud, true);
  for (const id of ["sba", "tsb", "v2g"]) assert.equal(typeof a.est[id], "number", id);
});

test("v2 runner: an older summary without the cold counts still makes a heartbeat", () => {
  const blank = Object.fromEntries(M.DIFFS.map((d) => [d, 0]));
  const doc = { v: 1, ms: 10, cfg: { estimatorClaim: "avg45" }, summary: { claim: { games: 0, live: 0, byDiffLive: blank, oldTargetLive: 0, brainTargetLive: 0, comparedLive: 0 } } };
  assert.match(B.heartbeat(doc, [], true), /cold probes 0 \(old asks 0\)/);
});

test("loopStatus (health hook): synchronous, never throws, the live switch and the last run that computed", async () => {
  B._setHooks({ settings: () => ({ getAutoFarm: () => ({ demandBrain: { enabled: false } }) }) });
  assert.deepEqual(B.loopStatus(), { lastRunAt: null, intervalMin: 60, enabled: false });
  const m = fakeModels();
  let fail = true;
  B._setHooks({
    settings: () => ({ getAutoFarm: () => ({ ...AF, demandBrain: { enabled: true, intervalMin: 30 } }) }),
    load: async ({ now }) => {
      if (fail) throw new Error("db down");
      return pack(now);
    },
    Run: m.Run,
    Row: m.Row,
    log: () => {},
    logErr: () => {},
  });
  assert.match((await B.runOnce()).error, /db down/);
  assert.deepEqual(B.loopStatus(), { lastRunAt: null, intervalMin: 30, enabled: true }, "a failed run is not a run");
  fail = false;
  assert.equal((await B.runOnce()).ok, true);
  const ls = B.loopStatus();
  assert.ok(ls.lastRunAt instanceof Date);
  assert.equal(ls.lastRunAt, B.status().lastRunAt);
  B._setHooks({ settings: () => ({ getAutoFarm: () => { throw new Error("torn file"); } }) });
  assert.doesNotThrow(() => B.loopStatus());
  assert.deepEqual(B.loopStatus(), { lastRunAt: ls.lastRunAt, intervalMin: 60, enabled: false }, "unreadable settings read as off");
});
