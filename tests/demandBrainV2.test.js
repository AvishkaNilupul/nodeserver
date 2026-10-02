// The farm brain, model v2 (docs/LIVE-FIXES-1003.md §A8, docs/DEMAND-BRAIN-PLAN.md): the
// intermittent-demand estimators sba and tsb (hand-checked on known series), the no-claim feeder's
// burst-guarded rule v2g, cold probes for new drops, one admission rule for both scorers, the
// heartbeat's cold-probe clause and the health hook — including the fixes of the 2026-10-03 review
// (each test named "review N" fails on the bytes before that fix). The loader's side (the probe-history
// read, the two feeder snapshots) is in tests/demandBrainInputs.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
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

// Production's auto-farm settings for what the brain reads (2026-10-02): cold-start probing on (its
// budget held 109 of 117 games that day), 30-day probe window, 90-day re-probe cooldown.
const AF = { probeColdStart: true, probeMaxDays: 30, probeCooldownDays: 90, probeMaxSellers: 1, probeMaxGames: 8, demandBrain: { enabled: true } };
const CFG = M.readConfig(AF);
// The engine's shelf floor once §A3 counts only open markets (Gameflip + GGSel): 2 × 3 × 2.
const FLOOR = 12;
const SIZING = { coverageDays: 28, safetyStock: 6, maxPerGame: 250 };
const radar = (o) => ({ perWeek: 10, units: 20, rivalSellers: 3, rivalsLive: 9, realised: { median: 2 }, ...o });

// Series A, 13 weeks oldest first: 4 sold in week 4, 2 in week 13.
const A = [0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 2];

// A deterministic pseudo-random stream, so a failing case is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

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

test("review 1 — sba by hand: Croston with the Syntetos–Boylan correction, never timed from the window's start", () => {
  assert.equal(M.SBA_ALPHA, 0.15);
  // Series A. Selling weeks 4 (size 4) and 13 (size 2). Start: size 4, interval = the first GAP, 9.
  // The second selling week updates both: size 4 + 0.15 × (2 − 4) = 3.7; interval 9 + 0.15 × (9 − 9) = 9.
  //   SBA = (1 − 0.15 / 2) × 3.7 / 9 = 0.925 × 0.41111 = 0.38028 → 0.38
  approx(M.sbaRate(A), (0.925 * 3.7) / 9, "series A");
  assert.equal(M.estimate("sba", weeksOf(A), NOW).total, 0.38);
  // Sales of 2 in weeks 2, 5 and 8: size stays 2; first gap 3, later gaps 3 → interval 3.
  //   SBA = 0.925 × 2 / 3 = 0.61667 → 0.62
  const E = [0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 0];
  approx(M.sbaRate(E), (0.925 * 2) / 3, "series E");
  assert.equal(M.estimate("sba", weeksOf(E), NOW).total, 0.62);
  // Croston's blind spot: silent weeks after the last sale change nothing.
  assert.equal(M.sbaRate(E), M.sbaRate(E.slice(0, 8)));
  // A steady seller (1 every week): size 1, interval 1 → 0.925 — SBA's correction shaves 7.5% off.
  approx(M.sbaRate(new Array(13).fill(1)), 0.925, "steady");
  // One selling week (3 in week 5): the gap before it is unknown, so it is one sale in 13 weeks:
  //   0.925 × 3 / 13 = 0.21346 — not 0.925 × 3 / 5, which counted the weeks since the window opened.
  approx(M.sbaRate([0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]), (0.925 * 3) / 13, "one selling week");
  assert.equal(M.sbaRate(new Array(13).fill(0)), 0);
});

test("review 1 — sba does not rise with silence: the reviewer's cases, week by week, until the sale leaves the window", () => {
  // One week in which the game sold 6, then nothing: 0.925 × 6 / 13 = 0.43 every week, then 0.
  // (Before the fix: 0.43, 0.46, 0.50 … 2.78, 5.55 — the interval shrank as the window slid.)
  const lone = [];
  for (let w = 0; w <= 13; w++) {
    const entries = Array.from({ length: 6 }, (_, i) => ({ t: NOW - (w * 7 + 1) * DAY - i * 3600000, m: "eldorado" }));
    lone.push(M.estimate("sba", entries, NOW).total);
  }
  assert.deepEqual(lone, [0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0.43, 0]);
  // Two consecutive weeks of 2 sales: one week apart → 0.925 × 2 / 1 = 1.85 while both are in the
  // window, 0.925 × 2 / 13 = 0.14 once the older one has left, then 0. (Before: 0.18 rising to 1.85.)
  const two = [];
  for (let w = 0; w <= 13; w++) {
    const entries = [0, 1].flatMap((k) => [1, 2].map((d) => ({ t: NOW - ((w + k) * 7 + d) * DAY, m: "eldorado" })));
    two.push(M.estimate("sba", entries, NOW).total);
  }
  assert.deepEqual(two, [1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 0.14, 0]);
  for (const list of [lone, two]) for (let i = 1; i < list.length; i++) assert.ok(list[i] <= list[i - 1], "non-increasing: " + list.join(" "));
});

test("review 1 — sliding the window changes sba only when a sale enters or leaves it (2,000 random histories)", () => {
  const rand = rng(1003);
  for (let n = 0; n < 2000; n++) {
    const y = Array.from({ length: 13 + 6 }, () => (rand() < 0.3 ? 1 + Math.floor(rand() * 5) : 0));
    for (let i = 0; i + 13 < y.length; i++) {
      if (y[i] !== 0 || y[i + 13] !== 0) continue; // the week leaving or the week entering sold: may move
      assert.equal(M.sbaRate(y.slice(i + 1, i + 14)), M.sbaRate(y.slice(i, i + 13)), "case " + n + " @" + i + ": " + y.join(","));
    }
  }
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
  assert.equal(r.shelf, 0.38);
  assert.equal(r.other, Math.round(M.sbaRate([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]) * 100) / 100);
  assert.equal(r.total, Math.round(M.sbaRate(M.weeklyCounts(shelf.concat(other), NOW)) * 100) / 100);
  const est = M.allEstimates(weeksOf(A), NOW);
  assert.equal(est.sba, 0.38);
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

/* ------------------------ review 2: one admission rule ------------------------ */

// The reviewer's dead game: one 6-account week 60–65 days before NOW, nothing since.
const DEAD = Array.from({ length: 6 }, (_, i) => ({ t: NOW - (60 + i) * DAY, m: "eldorado" }));

test("review 2 — the backtest scores every week any estimator forecast a sale for, not only avg45's 45 days", () => {
  const bt = M.backtest({ games: [{ key: "dead", farm: "claim", entries: DEAD }], now: NOW, weeks: 6 });
  // Weeks 2 and 1 back: the sale is 46–58 days before them — outside 45 days, inside sba/tsb's 91.
  for (const k of [2, 1]) {
    const T = NOW - k * WEEK;
    assert.equal(M.actualIn(DEAD, T - 45 * DAY, T), 0);
    assert.ok(M.allEstimates(DEAD, T).sba > 0, "sba forecasts a sale " + k + " weeks back");
  }
  assert.equal(bt.scores.claim.sba.n, 6, "all six weeks, the two false alarms included (it used to be 4)");
  for (const id of M.ESTIMATORS) assert.equal(bt.scores.claim[id].n, 6, id + ": every estimator on the same rows");
  assert.equal(bt.scores.claim.sba.actual, 0);
  assert.ok(bt.scores.claim.sba.bias > 0, "the false alarms are counted against it");
  // a game with no sale inside any estimator's look-back is never scored
  const gone = [{ t: NOW - 200 * DAY, m: "eldorado" }];
  assert.deepEqual(M.backtest({ games: [{ key: "gone", farm: "claim", entries: gone }], now: NOW, weeks: 6 }).scores, {});
});

test("review 2 — the backtest and the forward test admit and score the same game-weeks identically", () => {
  const bt = M.backtest({ games: [{ key: "dead", farm: "noclaim", entries: DEAD }], now: NOW, weeks: 6 });
  // the same six forecasts, logged as the runner logs them, scored a week later
  const samples = [];
  for (let k = 6; k >= 1; k--) {
    const T = NOW - k * WEEK;
    samples.push({ at: new Date(T), rows: [{ f: "noclaim", k: "dead", old: { c: "fleet", t: 0 }, est: M.allEstimates(DEAD, T) }] });
  }
  const fw = M.forwardScores({ samples, entriesFor: () => DEAD, now: NOW });
  assert.equal(fw.runsScored, 6);
  assert.deepEqual(fw.scores.noclaim, bt.scores.noclaim);
});

test("review 2 — a missing forecast scores as 0; an estimator a row was logged without is 'not enough history yet', never ranked", () => {
  const T1 = NOW - 20 * DAY;
  const T2 = NOW - 10 * DAY;
  const entries = [{ t: T1 + DAY, m: "eldorado" }, { t: T2 + DAY, m: "eldorado" }];
  const samples = [
    // a model v1 row: no sba yet, and avg30 logged as null
    { at: new Date(T1), rows: [{ f: "noclaim", k: "x", old: { c: "fleet" }, est: { avg45: 5, avg30: null, max30_14: 3 } }] },
    // a v2 row: sba logged, and it happens to be exact
    { at: new Date(T2), rows: [{ f: "noclaim", k: "x", old: { c: "fleet" }, est: { avg45: 5, avg30: 2, max30_14: 3, sba: 1 } }] },
  ];
  const fw = M.forwardScores({ samples, entriesFor: () => entries, now: NOW });
  const s = fw.scores.noclaim;
  assert.equal(s.avg30.n, 2, "null is a forecast of 0, scored on the same rows as the rest");
  assert.equal(s.avg30.forecast, 2);
  assert.equal(s.avg30.partial, undefined);
  assert.equal(s.sba.n, 1);
  assert.equal(s.sba.rmse, 0, "exact on the one row it has…");
  assert.equal(s.sba.partial, true, "…but not scored on every row: not enough history yet");
  assert.equal(s.tsb.n, 0);
  assert.equal(s.tsb.partial, true);
  // avg30 misses by 1 then 1 (rmse 1), max30_14 by 2 twice, avg45 by 4 twice; sba's 0 does not count
  assert.equal(fw.best.noclaim.id, "avg30", "ranked only among estimators scored on the same rows");
  assert.equal(M.bestOf({ claim: { a: { n: 3, rmse: 0.1, bias: 0, partial: true }, b: { n: 3, rmse: 1, bias: 0 } } }).claim.id, "b");
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
  // Other markets keep the in-stock rule over ALL other-market selling days; shelf markets their raw rate.
  const mixed = burst.concat([{ t: NOW - 2 * DAY, m: "eldorado" }, { t: NOW - 5 * DAY, m: "eldorado" }, { t: NOW - DAY, m: "gameflip" }]);
  // shelf: max(1 × 7 / 30, 1 × 7 / 14) = 0.5 in both
  // v2:  other = 42 sales on 3 selling days: max(42 × 7 / 15, 42 × 7 / 7) = 42 → total 42.5
  // v2g: other = max(min(19.6, steady 2 × 7 / 15 + burst 40 × 7 / 30), min(42, steady 2 × 7 / 7 + burst 40 × 7 / 14))
  //            = max(10.27, 22) = 22 → total 22.5
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

// The reviewer's guard_raises.js case A (2026-10-03): 48 Eldorado sales on 16 days, plus one hand sale
// on each of 10 other days. Dropping the hand-sale days from the steady sales' denominator read it
// 15.6 → 23.5 a week with the guard ON.
function reviewCaseA(now) {
  const day = (d, k = 0) => now - d * DAY - 3600000 - k * 60000;
  const steadyDays = [1, 3, 5, 7, 9, 10, 12, 13, 16, 18, 20, 22, 24, 26, 27, 29];
  const handDays = [2, 4, 6, 8, 11, 15, 17, 19, 21, 23];
  return steadyDays.flatMap((d) => [0, 1, 2].map((k) => ({ t: day(d, k), m: "eldorado" }))).concat(handDays.map((d) => ({ t: day(d), m: "manual" })));
}

test("review 8 — the guard only ever lowers a rate: the reviewer's case A, and guarded ≤ unguarded on 2,000 random histories", () => {
  const caseA = reviewCaseA(NOW);
  assert.equal(M.estimate("v2", caseA, NOW).other, 15.6);
  assert.equal(M.estimate("v2g", caseA, NOW).other, 15.4, "was 23.5: the hand-sale days now stay selling days");
  const FD = require("../utils/farmDemand");
  const rand = rng(8);
  const markets = ["gameflip", "eldorado", "g2g", "playerauctions", "manual", "manual", "unknown"];
  for (let i = 0; i < 2000; i++) {
    const e = [];
    const n = Math.floor(rand() * 80);
    for (let k = 0; k < n; k++) {
      const lump = rand() < 0.4;
      const x = { t: NOW - (lump ? [1.5, 4.5, 12.5, 25.5][Math.floor(rand() * 4)] : rand() * 32) * DAY, m: markets[Math.floor(rand() * markets.length)], p: 1 };
      if (rand() < 0.2) x.pack = true;
      e.push(x);
    }
    for (const ctx of [{}, { demandRates: FD.demandRates }]) {
      const off = M.estimate("v2", e, NOW, ctx);
      const on = M.estimate("v2g", e, NOW, ctx);
      assert.ok(on.other <= off.other && on.total <= off.total, "case " + i + (ctx.demandRates ? " (farmDemand)" : " (copy)") + ": " + JSON.stringify({ on, off }));
    }
  }
});

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

// A snapshot row as the feeder computes it: its target IS shelfAwareTarget of its own rates.
function snapOf(shelfPerWeek, otherPerWeek) {
  const policy = { coverageDays: 28, safetyStock: 6, min: 0, max: 600 };
  const perWeek = Math.round((shelfPerWeek + otherPerWeek) * 10) / 10;
  const target = farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek, otherPerWeek, ...policy }).target;
  return { key: "rainbow six", label: "Rainbow Six", target, onHand: 50, sales: { perWeek, shelfPerWeek, otherPerWeek }, stock: { listed: 50, held: 0, inFlight: 0 }, policy };
}

test("review 4 — v2 and v2g both come from the feeder's own snapshot, same evidence, same window: v2g − v2 is the guard alone", () => {
  // Evidence the brain re-derives quite differently (its longer read dates some sales earlier):
  // neither v2 nor v2g is taken from it.
  const e = [];
  for (let d = 0.5; d < 30; d += 1.5) e.push({ t: NOW - d * DAY, m: "eldorado" });
  const v2Row = snapOf(4.2, 23.4); // guard off
  const v2gRow = snapOf(4.2, 17.1); // guard on
  // guard off (today): the live snapshot is v2, the other one v2g
  const off = M.noclaimVerdict({ snapRow: v2Row, altRow: v2gRow, entries: e, now: NOW, cfg: CFG });
  assert.equal(off.est.v2, 27.6);
  assert.equal(off.est.v2g, 21.3, "the feeder's guarded snapshot, not a re-derivation (" + M.estimate("v2g", e, NOW).total + ")");
  assert.equal(off.br.t, v2Row.target, "the default no-claim estimator still mirrors the feeder");
  assert.equal(off.br.b, "feeder");
  // the owner's guard on: the live snapshot IS v2g; the other one is v2
  const on = M.noclaimVerdict({ snapRow: v2gRow, altRow: v2Row, entries: e, now: NOW, cfg: CFG, guardLive: true });
  assert.deepEqual([on.est.v2, on.est.v2g], [27.6, 21.3]);
  assert.equal(on.br.t, v2Row.target, "estimator v2 = the unguarded snapshot");
  assert.equal(on.br.b, "own");
  assert.match(on.br.why.join(" "), /the feeder's own rule, burst guard off/);
  // choosing v2g while the guard is off: the guarded snapshot's own rates
  const cfgG = M.readConfig({ ...AF, demandBrain: { estimatorNoclaim: "v2g" } });
  const g = M.noclaimVerdict({ snapRow: v2Row, altRow: v2gRow, entries: e, now: NOW, cfg: cfgG });
  assert.equal(g.br.t, v2gRow.target);
  // the other snapshot unreadable: v2g logs null (scored as 0, never re-derived), and choosing it is a mirror
  const lost = M.noclaimVerdict({ snapRow: v2Row, altRow: null, entries: e, now: NOW, cfg: cfgG });
  assert.equal(lost.est.v2g, null);
  assert.equal(lost.br.b, "mirror");
  assert.equal(lost.br.t, v2Row.target);
  // buildRun threads both rows and the switch
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, burstGuardLive: true, noclaim: [{ snapRow: v2gRow, altRow: v2Row, entries: e, spans: [], radarRows: [], keywords: ["rainbow six"], live: true }] });
  assert.deepEqual([run.rows[0].est.v2, run.rows[0].est.v2g], [27.6, 21.3]);
});

/* ------------------------------- cold probes ------------------------------- */

test("review 5 — cold probe size: half the engine's own shelf floor, owner-settable, 0 = off", () => {
  assert.equal(CFG.coldProbeSize, null, "unset: taken from the engine's floor each run");
  assert.equal(M.coldProbeSizeFor(CFG, 12), 6, "Gameflip + GGSel: 2 × 3 × 2 / 2");
  assert.equal(M.coldProbeSizeFor(CFG, 18), 9, "the floor with Plati counted");
  assert.equal(M.coldProbeSizeFor(CFG, 0), 0, "a floor that could not be read: no cold probes");
  assert.equal(M.coldProbeSizeFor(M.readConfig({ demandBrain: { coldProbeSize: 10 } }), 12), 10, "the owner's number wins");
  assert.equal(M.coldProbeSizeFor(M.readConfig({ demandBrain: { coldProbeSize: 0 } }), 12), 0);
  assert.equal(M.readConfig({ demandBrain: { coldProbeSize: "x" } }).coldProbeSize, null);
  assert.equal(M.readConfig({ demandBrain: { coldProbeSize: 9999 } }).coldProbeSize, 250);
  assert.equal(M.probeCooldownDaysOf(AF), 90);
  assert.equal(M.probeCooldownDaysOf({}), 0);
  assert.equal(M.probeCooldownDaysOf({ probeCooldownDays: -5 }), 0);
  assert.deepEqual([CFG.probeColdStart, CFG.probeMaxDays], [true, 30]);
  assert.deepEqual([M.readConfig({}).probeColdStart, M.readConfig({}).probeMaxDays], [false, 30], "the engine's own defaults");
  // end to end: a run sizes its cold probes from the floor it was handed
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, engine: { floor: 18, maxPerGame: 30, probes: 0 }, claim: [newDrop("n")] });
  assert.equal(run.rows[0].br.t, 9);
});

// A live game with no sale of ours, checked against the probe history.
const fresh = (o = {}) => M.claimVerdict({ own: 0, market: null, value: 0, cfg: CFG, sizing: SIZING, probeSize: 15, floor: FLOOR, evidence: {}, live: true, dud: false, rivals: { n: 0, from: "research" }, ...o });
const listedFor = (days) => ({ listed135: true, firstListedAt: NOW - days * DAY, listedDays: days });

test("v2 cold probe: a live campaign, no sale of ours, not a dud → probe of 6 (was 'unknown')", () => {
  const v = fresh();
  assert.equal(v.c, "probe");
  assert.equal(v.b, "cold");
  assert.equal(v.t, 6, "no shelf floor on a probe");
  assert.equal(v.td, 0, "no demand number behind it");
  assert.equal(v.w, 0);
  assert.equal(v.dud, null);
  assert.match(v.why.join(" "), /a new drop in an untested market \(0 rival sellers\) → cold probe of 6/);
  assert.equal(fresh({ gameCap: 4 }).t, 4, "the owner's per-game cap still wins");
  assert.match(fresh({ gameCap: 4 }).why.join(" "), /your cap/);
  assert.equal(fresh({ cfg: M.readConfig({ ...AF, demandBrain: { coldProbeSize: 9 } }) }).t, 9);
  assert.equal(fresh({ sizing: { ...SIZING, maxPerGame: 5 } }).t, 5);
  // a value known from rivals' sold prices does not screen a cold probe (there is no forecast to price)
  assert.equal(fresh({ value: 0.05 }).c, "probe");
});

test("review 3 — listings do not disqualify: the engine's own probe, listed 2 days ago and unsold, stays a cold probe", () => {
  const v = fresh({ evidence: listedFor(2) });
  assert.equal(v.c, "probe", "it used to be a brain-skip");
  assert.equal(v.b, "cold");
  assert.match(v.why.join(" "), /listed since 2026-10-08 \(2 days\), inside the probe window/);
  // listed for exactly the probe window is still inside it
  assert.equal(fresh({ evidence: listedFor(30) }).c, "probe");
});

test("review 3 — listed longer than the engine's probe window and never sold: dud-like, a skip with its reason", () => {
  const v = fresh({ evidence: listedFor(40) });
  assert.equal(v.c, "skip");
  assert.equal(v.dud, "listed");
  assert.match(v.why.join(" "), /listed since 2026-08-31 \(40 days\), longer than the 30-day probe window, and never sold: dud-like/);
  // the engine's probeMaxDays is the window
  assert.equal(fresh({ evidence: listedFor(40), cfg: M.readConfig({ ...AF, probeMaxDays: 45 }) }).c, "probe");
});

test("v2 cold probe: a known dud (a probe ended with 0 sales inside the cooldown) → skip", () => {
  const v = fresh({ dud: { at: NOW - 12 * DAY, days: 90 } });
  assert.equal(v.c, "skip");
  assert.equal(v.dud, "probe");
  assert.equal(v.t, 0);
  assert.match(v.why.join(" "), /ended with 0 sales on 2026-09-28, inside the auto-farm's 90-day re-probe cooldown/);
  assert.match(v.why.join(" "), /known dud/);
});

test("review 3 — the known-dud cooldown counts only while the engine's probeColdStart is on (as its probe gate)", () => {
  const off = M.readConfig({ ...AF, probeColdStart: false });
  const v = fresh({ cfg: off, dud: { at: NOW - 12 * DAY, days: 90 } });
  assert.equal(v.c, "probe", "the engine would probe it too");
  assert.equal(v.dud, null);
  assert.equal(fresh({ cfg: off, dud: null }).c, "probe", "no history needed when the cooldown does not apply");
  assert.equal(fresh({ dud: null }).c, "unknown", "switched on and unreadable: a possible dud is not probed");
  assert.match(fresh({ dud: null }).why.join(" "), /not readable/);
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

test("review 3 — eligibility is 'no own sale in 135 days': an unproven rival market does not stop a cold probe; a sale of ours does", () => {
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: 0, units: 0 }), [], NOW) }).b, "cold", "a watched market with no sales yet");
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: 0.5, units: 2 }), [], NOW) }).b, "cold", "rivals below proof");
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: null, ratePartial: true }), [], NOW) }).b, "cold");
  // a sale of ours inside 135 days and nothing recent: the estimator's own skip, not a new drop
  const sold = fresh({ evidence: { sold135: true, ...listedFor(60) } });
  assert.equal(sold.c, "skip");
  assert.equal(sold.dud, null);
});

test("v2 cold probe never fires without a live campaign or a size", () => {
  assert.equal(fresh({ live: false }).c, "unknown", "no live campaign: no decision is being made (v1)");
  assert.equal(fresh({ live: false, evidence: listedFor(5) }).c, "skip", "v1's skip for a listed game no campaign decides");
  const zero = fresh({ cfg: M.readConfig({ ...AF, demandBrain: { coldProbeSize: 0 } }) });
  assert.equal(zero.c, "unknown", "switched off: model v1's answer");
  assert.match(zero.why.join(" "), /Cold probes are off/);
  const noFloor = fresh({ floor: 0 });
  assert.equal(noFloor.c, "unknown");
  assert.match(noFloor.why.join(" "), /shelf floor could not be read/);
});

/* ------------------------------ run + summary ------------------------------ */

// The engine's research for a market nobody sells yet (its untested-market gate passes).
const UNTESTED = { ds: 0, sellers: 0, at: new Date(NOW - DAY) };

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
    probing: 0,
    campaignStartAt: null,
    // the engine's own research: an untested market (no rival seller)
    old: { alloc: { cap: 30, target: 15, probe: true, effective: 0 }, sales: { count: 0 }, research: UNTESTED },
    ...o,
  };
}

const PACK_CLAIM = [
  newDrop("new a"), // today probes 15
  newDrop("new b", { old: { alloc: { skip: true, probeBlocked: true, effective: 0 }, sales: { count: 0 }, research: UNTESTED } }), // today: probe held by the budget
  newDrop("dud c", { dud: { at: NOW - 10 * DAY, days: 90 } }),
  newDrop("unread d", { dud: null }),
  newDrop("closed e", { live: false, dud: null }),
];

test("v2 run: cold probes are logged against today's verdict and counted apart", () => {
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, probeSize: 15, engine: { floor: FLOOR, maxPerGame: 30, probes: 0 }, claim: PACK_CLAIM });
  const by = Object.fromEntries(run.rows.map((r) => [r.k, r]));
  assert.deepEqual([by["new a"].br.c, by["new a"].br.t, by["new a"].br.b], ["probe", 6, "cold"]);
  assert.equal(by["new a"].d, "brain-less", "today probes 15, the brain 6");
  assert.equal(by["new b"].d, "brain-farm", "today holds the probe (budget), the brain probes");
  assert.equal(by["dud c"].br.c, "skip");
  assert.equal(by["dud c"].br.dud, "probe");
  assert.equal(by["dud c"].d, "brain-skip");
  assert.equal(by["unread d"].br.c, "unknown");
  assert.equal(by["closed e"].br.c, "unknown");
  assert.equal("dud" in by["new a"].br, false, "the reason is only written where there is one");
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

test("review 3 — the reviewer's three new-drop cases, end to end", () => {
  const recurring = newDrop("recurring", { entries: [50, 52, 55, 58, 60].map((d) => ({ t: NOW - d * DAY, m: "gameflip" })), spans: [[NOW - 65 * DAY, NOW - 48 * DAY]] });
  // the engine's own probe of it is in flight
  const inFlight = newDrop("in flight", { spans: [[NOW - 2 * DAY, NOW]], probing: 1 });
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, probeSize: 15, engine: { floor: FLOOR, maxPerGame: 30, probes: 1 }, claim: [newDrop("brand new"), recurring, inFlight] });
  const by = Object.fromEntries(run.rows.map((r) => [r.k, r.br]));
  assert.deepEqual([by["brand new"].c, by["brand new"].t], ["probe", 6]);
  assert.deepEqual([by["in flight"].c, by["in flight"].t, by["in flight"].b], ["probe", 6, "cold"], "was a skip");
  assert.equal(by.recurring.c, "skip", "it sold 50–60 days ago: the claim estimator (avg45, 0 a week) decides, not the cold rule");
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
    engine: { floor: FLOOR, maxPerGame: 30, probes: 0 },
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
  assert.equal(m.runs[0].cfg.coldProbeSize, 6, "the size this run used: half the floor");
  assert.equal(m.runs[0].cfg.probeCooldownDays, 90);
  assert.equal(m.runs[0].cfg.probeColdStart, true);
  assert.equal(m.runs[0].cfg.noclaimBurstGuard, false);
  const hb = lines.find((l) => /^demandBrain: run 1 /.test(l));
  assert.ok(hb, lines.join("\n"));
  assert.match(hb, /\(model v2, avg45\)/);
  assert.match(hb, / \| cold probes 2 \(old asks 15\), held: 0 tested market, 0 market unknown, 0 budget full, 1 duds \| /);
  const a = m.rows.find((x) => x.k === "new a");
  assert.equal(a.br.b, "cold", "the row keeps what made it a cold probe");
  assert.equal(m.rows.find((x) => x.k === "dud c").br.dud, "probe");
  for (const id of ["sba", "tsb", "v2g"]) assert.equal(typeof a.est[id], "number", id);
});

test("v2 runner: an older summary without the cold counts still makes a heartbeat", () => {
  const blank = Object.fromEntries(M.DIFFS.map((d) => [d, 0]));
  const doc = { v: 1, ms: 10, cfg: { estimatorClaim: "avg45" }, summary: { claim: { games: 0, live: 0, byDiffLive: blank, oldTargetLive: 0, brainTargetLive: 0, comparedLive: 0 } } };
  assert.match(B.heartbeat(doc, [], true), /cold probes 0 \(old asks 0\)/);
});

test("loopStatus (health hook): synchronous, never throws, the live switch and the last run that computed", async () => {
  B._setHooks({ settings: () => ({ getAutoFarm: () => ({ demandBrain: { enabled: false } }) }) });
  assert.deepEqual(B.loopStatus(), { lastRunAt: null, intervalMin: 60, enabled: false, since: null });
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
  assert.deepEqual(B.loopStatus(), { lastRunAt: null, intervalMin: 30, enabled: true, since: null }, "a failed run is not a run");
  fail = false;
  assert.equal((await B.runOnce()).ok, true);
  const ls = B.loopStatus();
  assert.ok(ls.lastRunAt instanceof Date);
  assert.equal(ls.lastRunAt, B.status().lastRunAt);
  B._setHooks({ settings: () => ({ getAutoFarm: () => { throw new Error("torn file"); } }) });
  assert.doesNotThrow(() => B.loopStatus());
  assert.deepEqual(B.loopStatus(), { lastRunAt: ls.lastRunAt, intervalMin: 60, enabled: false, since: null }, "unreadable settings read as off");
});

test("loopStatus `since`: when the loop last began waiting to run — its start, or its last tick that found the switch off", async () => {
  let on = false;
  const m = fakeModels();
  B._setHooks({ settings: () => ({ getAutoFarm: () => ({ ...AF, demandBrain: { enabled: on } }) }), load: async ({ now }) => pack(now), Run: m.Run, Row: m.Row, log: () => {}, logErr: () => {} });
  assert.equal(B.loopStatus().since, null, "not started");
  const t0 = Date.now();
  B.start();
  const started = B.loopStatus().since;
  assert.ok(started instanceof Date && started.getTime() >= t0);
  await new Promise((r) => setTimeout(r, 5));
  await B._tick(); // switched off: the wait starts again here
  const offTick = B.loopStatus().since;
  assert.ok(offTick.getTime() > started.getTime(), "an off tick moves it");
  on = true;
  await new Promise((r) => setTimeout(r, 5));
  await B._tick(); // switched on: it runs, and `since` stays where the wait began
  assert.equal(B.loopStatus().since, offTick);
  assert.ok(B.loopStatus().lastRunAt.getTime() >= offTick.getTime(), "the run came after it");
  B.stop();
  assert.equal(B.loopStatus().since, null, "stopped");
});

/* ------------------ the engine's two cold-start gates (staging, 2026-10-03) ------------------ */

test("gate 1 — rival sellers are counted as the engine counts them: its research, else the radar, else unknown", () => {
  const at = new Date(NOW - DAY);
  assert.deepEqual(M.rivalSellersOf({ ds: 2, sellers: 3, at }, { rivalSellers: 0 }), { n: 3, from: "research" }, "the engine's own read wins");
  assert.deepEqual(M.rivalSellersOf({ ds: 0, sellers: 0, at: null }, { rivalSellers: 1 }), { n: 1, from: "radar" }, "research with no scan is no research (demandAllocation)");
  assert.deepEqual(M.rivalSellersOf(null, { rivalSellers: 4 }), { n: 4, from: "radar" });
  assert.equal(M.rivalSellersOf(null, { perWeek: 2 }), null, "a radar row without a seller count");
  assert.equal(M.rivalSellersOf(null, { rivalSellers: "" }), null);
  assert.equal(M.rivalSellersOf(null, null), null);
  assert.deepEqual([CFG.probeMaxSellers, CFG.probeMaxGames], [1, 8], "production's settings");
  assert.deepEqual([M.readConfig({}).probeMaxSellers, M.readConfig({}).probeMaxGames], [0, 0], "the engine's own fallbacks (Number(x || 0))");
});

test("gate 1 — a cold probe only for an UNTESTED market; rivals listing it without proof is a skip; no count is unknown", () => {
  assert.equal(fresh({ rivals: { n: 0, from: "research" } }).c, "probe");
  const one = fresh({ rivals: { n: 1, from: "radar" } });
  assert.deepEqual([one.c, one.b], ["probe", "cold"], "at the limit is still untested");
  assert.match(one.why.join(" "), /untested market \(1 rival seller\) → cold probe of 6/);
  const tested = fresh({ rivals: { n: 2, from: "research" } });
  assert.deepEqual([tested.c, tested.t, tested.held], ["skip", 0, "tested"]);
  assert.match(tested.why.join(" "), /rivals list it but it does not sell: 2 rival sellers \(the engine's market research\), over the untested-market limit of 1/);
  assert.match(fresh({ rivals: { n: 7, from: "radar" } }).why.join(" "), /7 rival sellers \(the market radar\)/);
  // a watched market below proof, with sellers: a skip, never a cold probe
  const watched = fresh({ market: M.marketView(radar({ perWeek: 0.5, units: 2, rivalSellers: 6 }), [], NOW), rivals: M.rivalSellersOf(null, radar({ rivalSellers: 6 })) });
  assert.deepEqual([watched.c, watched.held], ["skip", "tested"]);
  const nobody = fresh({ rivals: null });
  assert.deepEqual([nobody.c, nobody.held], ["unknown", "unknown"]);
  assert.match(nobody.why.join(" "), /how many rivals list it is unknown/);
  // rival PROOF is not this gate's business: it still upgrades to the market-led probe
  assert.equal(fresh({ market: M.marketView(radar({ perWeek: 40, units: 60 }), [], NOW), rivals: { n: 9, from: "radar" } }).b, "market");
});

test("gate 2 — the probe budget: probeMaxGames at once, the engine's own probes included, oldest campaign first", () => {
  // ten untested new drops, d1 the newest campaign and d10 the oldest; the engine runs five probes,
  // two of them on d3 and d7 (those ARE the brain's probes there: no new slot)
  const claim = [];
  for (let i = 1; i <= 10; i++) claim.push(newDrop("d" + i, { campaignStartAt: NOW - i * DAY, probing: i === 3 || i === 7 ? 1 : 0 }));
  const run = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, probeSize: 15, engine: { floor: FLOOR, maxPerGame: 30, probes: 5 }, claim });
  const cold = run.rows.filter((r) => r.br.b === "cold").map((r) => r.k).sort();
  assert.deepEqual(cold, ["d10", "d3", "d7", "d8", "d9"], "the two in flight, then the three oldest campaigns (8 − 5 = 3 slots)");
  const held = run.rows.filter((r) => r.br.held === "budget");
  assert.deepEqual(held.map((r) => r.k).sort(), ["d1", "d2", "d4", "d5", "d6"]);
  for (const r of held) {
    assert.deepEqual([r.br.c, r.br.t, r.br.b], ["skip", 0, "none"]);
    assert.match(r.why[0], /^Probe budget full \(8 active\): at most 8 probes at once, oldest campaigns first/);
  }
  assert.deepEqual([run.summary.claim.coldProbes, run.summary.claim.coldHeldBudget], [5, 5]);
  // an unknown start waits behind every known one
  const order = M.buildRun({
    now: NOW,
    cfg: CFG,
    sizing: SIZING,
    engine: { floor: FLOOR, maxPerGame: 30, probes: 7 },
    claim: [newDrop("no start", { campaignStartAt: null }), newDrop("newest", { campaignStartAt: NOW - DAY })],
  });
  assert.deepEqual(order.rows.map((r) => [r.k, r.br.c]), [["no start", "skip"], ["newest", "probe"]]);
  // an unreadable task count holds every NEW probe; one already in flight stays
  const blind = M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, engine: { floor: FLOOR, maxPerGame: 30, probes: null }, claim: [newDrop("in flight", { probing: 1 }), newDrop("new")] });
  assert.deepEqual(blind.rows.map((r) => [r.k, r.br.c, r.br.held || null]), [["in flight", "probe", null], ["new", "skip", "budget"]]);
  assert.match(blind.rows[1].why[0], /Probe budget unknown/);
});

// The 2026-10-03 staging run on production data, reshaped as a fixture: 94 live games, 40 of them
// sold in the last 45 days; of the 54 with no sale of ours, 6 untested markets (the engine probing 2
// of them), 44 markets rivals list (2–12 sellers, no proof) and 4 nobody counted. The engine has 6
// probes in flight (4 more on games that have sold). Today's logic probes the 10 untested/uncounted
// games (15 each = 150) and skips the 44. On the bytes before the two gates this read "cold probes 54
// (old asks 150)", coldTarget 324, brain-farm 44 — the staging summary.
function stagingShapedRun() {
  const research = (sellers, ds = 1) => ({ ds, sellers, at: new Date(NOW - DAY) });
  const started = (i) => NOW - (10 + i) * DAY;
  const games = [];
  for (let i = 0; i < 40; i++) {
    games.push(
      newDrop("sold " + i, {
        entries: [3, 9, 15, 21].map((d) => ({ t: NOW - (d + (i % 5)) * DAY, m: "gameflip" })),
        campaignStartAt: started(i),
        probing: i < 4 ? 1 : 0,
        old: { alloc: { cap: 30, target: 30, effective: 40 }, sales: { count: 4 }, research: research(9, 40) },
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    games.push(newDrop("untested " + i, { campaignStartAt: started(40 + i), probing: i < 2 ? 1 : 0, old: { alloc: { cap: 30, target: 15, probe: true, effective: 0 }, sales: { count: 0 }, research: research(i % 2) } }));
  }
  for (let i = 0; i < 44; i++) {
    games.push(newDrop("tested " + i, { campaignStartAt: started(46 + i), old: { alloc: { skip: true, demand: 3, effective: 3 }, sales: { count: 0 }, research: research(2 + (i % 11), 3) } }));
  }
  for (let i = 0; i < 4; i++) {
    games.push(newDrop("uncounted " + i, { campaignStartAt: started(90 + i), old: { alloc: { cap: 30, target: 15, probe: true, effective: 0 }, sales: { count: 0 } } }));
  }
  return M.buildRun({ now: NOW, cfg: CFG, sizing: SIZING, probeSize: 15, engine: { floor: FLOOR, maxPerGame: 30, probes: 6 }, claim: games });
}

test("gates 1 + 2 on a run shaped like the staging run: 4 cold probes (old asks 60), not 54 (old asks 150)", () => {
  const run = stagingShapedRun();
  const s = run.summary.claim;
  assert.equal(s.live, 94);
  assert.deepEqual(
    { coldProbes: s.coldProbes, oldTargetCold: s.oldTargetCold, coldTarget: s.coldTarget, tested: s.coldHeldTested, unknown: s.coldHeldUnknown, budget: s.coldHeldBudget, duds: s.coldDuds },
    { coldProbes: 4, oldTargetCold: 60, coldTarget: 24, tested: 44, unknown: 4, budget: 2, duds: 0 },
  );
  // which four: the two the engine is already probing, then the two oldest campaigns
  assert.deepEqual(run.rows.filter((r) => r.br.b === "cold").map((r) => r.k).sort(), ["untested 0", "untested 1", "untested 4", "untested 5"]);
  assert.equal(s.byDiffLive["brain-farm"], 0, "it was 44: every tested market");
  assert.equal(s.byDiffLive["agree-skip"], 44);
  const blank = Object.fromEntries(M.DIFFS.map((d) => [d, 0]));
  const hb = B.heartbeat({ v: 2, ms: 1000, cfg: { estimatorClaim: "avg45" }, summary: { ...run.summary, claim: { ...s, byDiffLive: { ...blank, ...s.byDiffLive } } } }, run.rows, true);
  assert.match(hb, / \| cold probes 4 \(old asks 60\), held: 44 tested market, 4 market unknown, 2 budget full, 0 duds \| /);
});

/* ------------------------------ review 7: labels ------------------------------ */

test("review 7 — the page labels the new estimators, and names the cold basis exactly as the plan doc does", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "price-tracker.html"), "utf8");
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "DEMAND-BRAIN-PLAN.md"), "utf8");
  assert.match(page, /v2g: "no-claim feeder rule, hand\/pack sales at raw rate"/);
  assert.match(page, /sba: "[^"]+"/);
  assert.match(page, /tsb: "[^"]+"/);
  const cold = page.match(/b\.b === "cold" \? "([^"]+)"/);
  assert.ok(cold, "the page names the cold basis");
  assert.ok(doc.includes('"' + cold[1] + '"'), "the plan doc uses the same words: " + cold[1]);
  assert.match(page, /not enough history yet/);
});
