// The listing brain's scorer (utils/listingBrain/model/score.js, docs/LISTING-BRAIN-PLAN.md §5) and its
// offline script (scripts/listing-brain-backtest.js): calibration math by hand, the model beating its
// baseline on the planted elasticity market, discrimination, the farm brain's admission and "missing is
// not zero" rules, forward scoring only after the horizon, missing listings, sold-or-expired on the
// planted ending wave, the decision review, the script's tables, determinism, and the large-fixture time.
// Synthetic data only (scripts/listing-brain-fixture.js); no Mongo, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const M = require("../utils/listingBrain/model");
const S = require("../utils/listingBrain/model/score");
const F = require("../scripts/listing-brain-fixture");
const script = require("../scripts/listing-brain-backtest");

const DAY = 86400000;
const SMALL = path.join(__dirname, "fixtures", "listingBrain", "small.json");
const small = F.generate({ seed: 1 });
const cfg = M.readConfig({ listingBrain: small.af.listingBrain });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tolerance ${tol})`);

// One backtest of the small fixture, shared by the tests that only read it (~0.3 s).
const BT = S.backtest(small, { cfg });

// What the runner logs per daily sample: the run's forecasts and its rows' scoring fields.
const slim = (r) => ({ k: r.k, g: r.g, f: r.f, m: r.m, live: r.live, pc: r.pc, sc: r.sc, old: r.old, br: r.br, pol: r.pol, pf: r.pf });
function sampleAt(bundle, at) {
  const ev = M.buildEvidence(bundle, { cfg, cut: at, synthDemand: true });
  const run = M.buildRun(S.viewAt(bundle, at, ev), { cfg });
  return { at, fc: run.fc, rows: run.rows.map(slim) };
}

/* ------------------------------------------------------------ the façade */

test("façade: model.js carries every scorer export (and none of them shadows a model export)", () => {
  for (const k of Object.keys(S)) assert.equal(M[k], S[k], "model." + k);
  for (const k of ["calibration", "backtest", "backtestAsync", "forwardScores", "decisionReview", "bestOf", "truthSold", "placementTruth", "agreement", "soldOrExpired", "discrimination"]) {
    assert.equal(typeof S[k], "function", k);
  }
  for (const k of ["buildRun", "fitHazard", "buildEvidence", "PLACE_POLICIES"]) assert.ok(M[k], "model." + k + " still there");
});

test("purity: the scorer reads no clock, no randomness, no settings, no database", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "listingBrain", "model", "score.js"), "utf8");
  for (const bad of ["Date.now", "Math.random", "require(\"../../settings", "require(\"../../../models", "mongoose", "setTimeout", "process.env"]) {
    assert.ok(!src.includes(bad), "score.js must not use " + bad);
  }
});

/* ---------------------------------------------------------- calibration */

test("calibration: Brier, baseline Brier, skill and the 10 reliability bins, by hand", () => {
  const pairs = [
    { p: 0.8, y: 1, pb: 0.5 },
    { p: 0.2, y: 0, pb: 0.5 },
    { p: 0.6, y: 0, pb: 0.5 },
    { p: 0.95, y: 1, pb: 0.5 },
    { p: 0.05, y: 0, pb: 0.5 },
  ];
  const c = S.calibration(pairs);
  // brain: (0.04 + 0.04 + 0.36 + 0.0025 + 0.0025) / 5 = 0.089; baseline: 0.25 everywhere
  assert.equal(c.n, 5);
  near(c.brier, 0.089, 1e-4, "Brier");
  near(c.brierBase, 0.25, 1e-4, "baseline Brier");
  near(c.skill, 1 - 0.089 / 0.25, 1e-3, "skill = 1 − Brier ÷ baseline");
  assert.equal(c.sold, 2);
  assert.equal(c.verdict, "beats the baseline");
  assert.equal(c.reliability.length, 10);
  assert.deepEqual(
    c.reliability.map((b) => b.n),
    [1, 0, 1, 0, 0, 0, 1, 0, 1, 1],
  );
  assert.deepEqual(c.reliability[8], { lo: 0.8, hi: 0.9, n: 1, meanP: 0.8, rate: 1 });
  assert.deepEqual(c.reliability[3], { lo: 0.3, hi: 0.4, n: 0, meanP: null, rate: null }, "an empty bin is null, not 0");
  // p = 1 falls in the top bin, never an 11th
  assert.equal(S.calibration([{ p: 1, y: 1, pb: 0.5 }]).reliability[9].n, 1);
});

test("calibration: pairs missing either chance are left out of BOTH scores; nothing scored is null, not 0", () => {
  const c = S.calibration([{ p: 0.9, y: 1, pb: 0.5 }, { p: 0.1, y: 1, pb: null }, { p: null, y: 0, pb: 0.4 }]);
  assert.equal(c.n, 1);
  near(c.brier, 0.01, 1e-9, "Brier on the one complete pair");
  near(c.brierBase, 0.25, 1e-9, "baseline on the same pair");
  const empty = S.calibration([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.brier, null);
  assert.equal(empty.brierBase, null);
  assert.equal(empty.skill, null);
  assert.equal(empty.verdict, "not enough history yet");
  // a perfect baseline (Brier 0) leaves skill undefined, never −∞
  assert.equal(S.calibration([{ p: 0.5, y: 1, pb: 1 }]).skill, null);
  // a brain worse than the baseline says so plainly
  assert.match(S.calibration([{ p: 0.9, y: 0, pb: 0.5 }]).verdict, /does not beat the baseline/);
});

test("calibration on the fixture: the model BEATS the baseline on the planted elasticity market (claim Gameflip)", () => {
  const gf = BT.calibration.claim.byMarket.gameflip;
  assert.ok(gf.n >= 150, `${gf.n} Gameflip claim listings scored`);
  assert.ok(gf.brier < gf.brierBase, `Brier ${gf.brier} under the baseline's ${gf.brierBase}`);
  // measured 0.240 on seed 1 (0.118–0.253 over seeds 1–5): a real margin, not a rounding win
  assert.ok(gf.skill >= 0.1, `skill ${gf.skill}`);
  assert.ok(BT.calibration.claim.skill > 0, "and the claim farm as a whole");
  assert.match(BT.note, /must beat the baseline/);
  assert.match(BT.cannotShow, /different price would have sold/);
});

/* -------------------------------------------------------- discrimination */

test("discrimination by hand, and on the fixture: rows the brain would lower sell less than rows it would hold", () => {
  const d = S.discrimination([
    { f: "claim", a: "hold", y: 1 },
    { f: "claim", a: "hold", y: 0 },
    { f: "claim", a: "lower", y: 0 },
    { f: "claim", a: "ladder", y: 1 },
    { f: "noclaim", a: "abstained", y: 1 },
  ]);
  assert.deepEqual(d.claim.hold, { n: 2, sold: 1, rate: 0.5 });
  assert.deepEqual(d.claim.lower, { n: 1, sold: 0, rate: 0 });
  assert.deepEqual(d.claim.raise, { n: 0, sold: 0, rate: null }, "nothing scored is null");
  assert.equal(d.claim.n, 3, "a ladder is counted apart from the four actions");
  assert.equal(d.noclaim.n, 0, "an abstention is not a hold");
  assert.equal(d.noclaim.abstained.n, 1);
  // On the fixture (seed 1: lower 19 % of 140, hold 53 % of 96). The direction held on every seed 1–5
  // of the small fixture (lower 18–26 %, hold 39–55 %) and on the large one (26 % vs 45 %).
  const c = BT.discrimination.claim;
  assert.ok(c.lower.n >= 50 && c.hold.n >= 50, `lower ${c.lower.n}, hold ${c.hold.n}`);
  assert.ok(c.lower.rate < c.hold.rate, `lower sells ${c.lower.rate} < hold ${c.hold.rate}`);
  for (const seed of [2, 3]) {
    const x = S.backtest(F.generate({ seed }), { cfg, weeks: 4 }).discrimination.claim;
    assert.ok(x.lower.rate < x.hold.rate, `seed ${seed}: lower ${x.lower.rate} < hold ${x.hold.rate}`);
  }
});

/* ------------------------------------------------------------- placement */

test("placement admission: a cell-week is scored only when it sold or some policy forecast > 0 at two decimals", () => {
  const by = {};
  assert.equal(S.admitRow(by, "claim", { flat: 0, share30: 0, instock: 0, newsvendor: 0 }, 0), false, "all zero: not admitted");
  assert.equal(S.admitRow(by, "claim", { flat: 0.004, share30: 0, instock: 0, newsvendor: 0 }, 0), false, "0.004 rounds to 0.00");
  assert.equal(S.admitRow(by, "claim", { flat: 0.006, share30: 0, instock: 0, newsvendor: 0 }, 0), true, "0.006 rounds to 0.01");
  assert.equal(S.admitRow(by, "claim", { flat: 0, share30: 0, instock: 0, newsvendor: 0 }, 2), true, "it sold");
  assert.equal(by.claim.rows, 2);
  const out = S.finishPlacement(by);
  assert.equal(out.claim.rows, 2);
  assert.equal(out.claim.flat.n, 2);
  // flat: errors +0.006 and −2 → bias −0.997, RMSE √((0.006² + 4) / 2)
  near(out.claim.flat.bias, (0.006 - 2) / 2, 1e-3, "bias");
  near(out.claim.flat.rmse, Math.sqrt((0.006 * 0.006 + 4) / 2), 1e-3, "rmse");
  assert.equal(out.noclaim.rows, 0);
  assert.equal(out.noclaim.flat.rmse, null, "nothing admitted: null, not 0");
  assert.equal(out.noclaim.best, null);
});

test("placement: a policy with no number on an admitted row is MISSING (not 0), partial, and never ranked", () => {
  const by = {};
  // newsvendor would win on the rows it has (perfect), but it has no number on the second row
  S.admitRow(by, "claim", { flat: 1, share30: 2, instock: 3, newsvendor: 1 }, 1);
  S.admitRow(by, "claim", { flat: 2, share30: 1, instock: 3, newsvendor: null }, 3);
  const out = S.finishPlacement(by);
  assert.equal(out.claim.newsvendor.n, 1, "scored only where it has a number");
  assert.equal(out.claim.newsvendor.partial, true);
  assert.deepEqual(out.claim.partial, ["newsvendor"]);
  assert.equal(out.claim.newsvendor.rmse, 0, "its one row was perfect…");
  assert.notEqual(out.claim.best, "newsvendor", "…and it is still not ranked");
  // flat: misses 0 and 1 → RMSE 0.707; share30: 1 and 2 → 1.581; instock: 2 and 0 → 1.414
  assert.equal(out.claim.best, "flat");
  // had the missing number been read as 0 the newsvendor would have scored on 2 rows with a miss of 3
  assert.equal(out.claim.newsvendor.actual, 1);
});

test("bestOf: only among policies scored on the very same rows (fewer rows = not ranked, even unflagged)", () => {
  const scores = {
    claim: {
      flat: { n: 10, rmse: 1.2, mae: 1, bias: 0.3 },
      share30: { n: 10, rmse: 0.9, mae: 0.7, bias: -0.4 },
      instock: { n: 6, rmse: 0.2, mae: 0.1, bias: 0 },
      newsvendor: { n: 10, rmse: 0.9, mae: 0.6, bias: 0.1 },
    },
    noclaim: { flat: { n: 3, rmse: 0.5, bias: 0, partial: true } },
  };
  const best = S.bestOf(scores);
  assert.equal(best.claim.id, "newsvendor", "instock is better on fewer rows: not ranked; a tie on RMSE goes to the smaller |bias|");
  assert.equal(best.noclaim, undefined, "a partial policy alone is never the best");
  assert.deepEqual(S.bestOf({}), {});
});

test("placement forecasts: an empty shelf forecasts exactly 0; no shelf number, or an abstention, is missing", () => {
  const row = (o) => Object.assign({ k: "g", f: "claim", m: "g2g", pf: { flat: null, share30: null, instock: null, newsvendor: null }, old: { sh: 0 }, br: { sh: 0, rg: "balanced" } }, o);
  // a market the brain's policies do not shelve (closed / unknown): its logged shelf is 0 → E[min(D, 0)] = 0
  for (const p of M.PLACE_POLICIES) assert.equal(S.forecastFor(row({}), p), 0, p);
  assert.equal(S.forecastFor(row({ pf: { flat: 0.42 } }), "flat"), 0.42, "a logged number is used as is");
  assert.equal(S.forecastFor(row({ br: { sh: null, rg: "balanced" } }), "newsvendor"), null, "a managed cell: no shelf number");
  assert.equal(S.forecastFor(row({ old: { sh: null } }), "flat"), null, "no old-side split for the game");
  for (const p of M.PLACE_POLICIES) assert.equal(S.forecastFor(row({ br: { sh: 0, rg: "unknown" } }), p), null, "abstained: " + p);
});

test("placement on the fixture: every policy scored on the same cell-weeks; ZeusX cells never scored", () => {
  for (const f of ["claim", "noclaim"]) {
    const p = BT.placement[f];
    assert.ok(p.rows > 0, f + " rows");
    for (const id of M.PLACE_POLICIES) assert.ok(p[id].n <= p.rows, f + " " + id);
    if (!p.partial.length) assert.ok(M.PLACE_POLICIES.includes(p.best), f + " best " + p.best);
    for (const id of p.partial) assert.notEqual(p.best, id);
  }
  assert.ok(BT.placement.claim.unmeasured.cells > 0, "ZeusX cell-weeks counted apart");
  assert.equal(BT.placement.claim.unmeasured.units, 0, "ZeusX records no sale for an auto row");
  // the admitted units plus the ones not admitted account for every system-made unit sold in the weeks
  for (const f of ["claim", "noclaim"]) {
    const p = BT.placement[f];
    assert.equal(p.units + p.unforecast.units + p.unmeasured.units + p.outside, p.unitsAll, f + " units accounted for");
  }
});

/* ------------------------------------------------------------- agreement */

test("agreement: near = within 10 % of the policy's price; net per listing-day = Σ net ÷ Σ days; labelled correlation", () => {
  const a = S.agreement([
    { m: "gameflip", ask: 2.15, pol: { curve: 2, old: 3 }, net: 1.8, days: 3 },
    { m: "gameflip", ask: 2.5, pol: { curve: 2, old: 2.5 }, net: 0, days: 7 },
    { m: "gameflip", ask: 2.2, pol: { curve: 2, old: null }, net: 0.9, days: 2 },
  ]);
  assert.deepEqual(a.gameflip.curve.near, { n: 2, net: 2.7, days: 5, netPerDay: 0.54 });
  assert.deepEqual(a.gameflip.curve.far, { n: 1, net: 0, days: 7, netPerDay: 0 });
  assert.deepEqual(a.gameflip.old.near, { n: 1, net: 0, days: 7, netPerDay: 0 });
  assert.equal(a.gameflip.old.far.n, 1, "a policy with no price is not counted for that listing");
  assert.equal(a.gameflip.tracker, undefined);
  assert.match(BT.agreementNote, /^Correlation, not cause/);
  assert.ok(Object.keys(BT.agreement).length > 0);
  assert.equal(BT.agreement.zeusx, undefined, "ZeusX records no sale: never compared");
});

/* ------------------------------------------------------------ the truth */

test("truth: a listing's sale inside the window; a sold single-unit row without a sale record; absent = null", () => {
  const b = {
    now: 100 * DAY,
    fees: {},
    listings: [
      { id: "a", g: "g", f: "claim", m: "gameflip", o: "auto", kind: "single", st: "sold", c: 0, u: 50 * DAY, p: 2 },
      { id: "b", g: "g", f: "claim", m: "gameflip", o: "auto", kind: "single", st: "sold", c: 0, u: 60 * DAY, p: 2 },
      { id: "c", g: "g", f: "claim", m: "ggsel", o: "auto", kind: "single", st: "active", c: 0, u: 60 * DAY, p: 2 },
      { id: "h", g: "g", f: "claim", m: "ggsel", o: "manual", kind: "single", st: "active", c: 0, u: 60 * DAY, p: 2 },
    ],
    sales: [
      { lid: "a", g: "g", f: "claim", m: "gameflip", t: 50 * DAY, p: 2 },
      { lid: "c", g: "g", f: "claim", m: "ggsel", t: 41 * DAY, p: 0 },
      { lid: "c", g: "g", f: "claim", m: "ggsel", t: 45 * DAY, p: 1.5 },
      { lid: "h", g: "g", f: "claim", m: "ggsel", t: 45 * DAY, p: 9 },
    ],
  };
  const ix = S.indexBundle(b);
  assert.equal(S.truthSold(ix, "a", 45 * DAY, 52 * DAY), 1);
  assert.equal(S.truthSold(ix, "a", 51 * DAY, 58 * DAY), 0);
  assert.equal(S.truthSold(ix, "b", 55 * DAY, 62 * DAY), 1, "marked sold, no sale record: sold at its last write");
  assert.equal(S.truthSold(ix, "zzz", 0, 100 * DAY), null, "absent from the bundle: missing, not unsold");
  // placement truth counts system-made rows only (the hand-made $9 sale is not a policy's shelf)
  const t = S.placementTruth(ix, "g", "claim", "ggsel", 40 * DAY, 47 * DAY);
  assert.equal(t.units, 2);
  // the unpriced unit is valued at its listing's ask (lifted to the market's floor)
  near(t.net, M.util.netOf(Math.max(2, M.util.floorFor("ggsel")), "ggsel", {}) + M.util.netOf(1.5, "ggsel", {}), 0.011, "net");
});

/* --------------------------------------------------------------- forward */

test("forward: a forecast is scored only once its horizon has passed (no-claim 2 days, claim 7)", () => {
  const T = small.now - 3 * DAY;
  const s = sampleAt(small, T);
  const claim = s.fc.filter((x) => x.f === "claim").length;
  const nc = s.fc.filter((x) => x.f === "noclaim" && x.h <= 3).length;
  assert.ok(claim > 0 && nc > 0, `${claim} claim, ${nc} no-claim forecasts`);
  const fw = S.forwardScores({ samples: [s], bundle: small, cfg, now: small.now });
  assert.equal(fw.counts.waiting, s.fc.length - nc, "every claim forecast still waits");
  assert.equal(fw.counts.scored + fw.counts.missing, nc);
  assert.equal(fw.calibration.claim.n, 0);
  assert.equal(fw.placement.claim.rows, 0, "the week is not over: no placement scored");
  // a week later everything is due
  const later = S.forwardScores({ samples: [s], bundle: small, cfg, now: T + 7 * DAY });
  assert.equal(later.counts.waiting, 0);
  assert.ok(later.calibration.claim.n > 0);
  assert.ok(later.placement.claim.rows > 0);
  // a sample whose earliest horizon is still ahead is "waiting"
  const fresh = S.forwardScores({ samples: [sampleAt(small, small.now - 0.5 * DAY)], bundle: small, cfg, now: small.now });
  assert.equal(fresh.runsWaiting, 1);
  assert.equal(fresh.runsScored, 0);
  assert.equal(fresh.calibration.claim.n, 0);
});

test("forward: a listing absent from the bundle is skipped and counted missing — never scored as unsold", () => {
  const T = small.now - 10 * DAY;
  const ix = S.indexBundle(small);
  const L = small.listings.find((x) => x.m === "gameflip" && x.f === "claim" && x.o === "auto" && x.c < T - DAY && S.truthSold(ix, x.id, T, T + 7 * DAY) === 0 && x.st === "active");
  assert.ok(L, "an unsold live Gameflip row");
  const fc = (l) => ({ l, k: L.g, f: "claim", m: "gameflip", x: 1, b: 1, p: 0.3, a: "hold", ask: 2, h: 7 });
  const fw = S.forwardScores({ samples: [{ at: T, fc: [fc(L.id), fc("not-in-the-bundle")], rows: [] }], bundle: small, cfg, now: small.now });
  assert.equal(fw.missing, 1);
  assert.equal(fw.counts.missing, 1);
  assert.equal(fw.counts.scored, 1);
  assert.equal(fw.calibration.claim.n, 1, "only the listing the bundle knows");
  assert.equal(fw.calibration.claim.sold, 0, "and it did not sell");
  assert.equal(fw.discrimination.claim.hold.n, 1);
});

test("discrimination: a live row of a game the brain abstained on (regime unknown) is not counted as a hold", () => {
  const T = small.now - 10 * DAY;
  const L = small.listings.find((x) => x.m === "gameflip" && x.f === "claim" && x.o === "auto" && x.c < T - DAY && x.st === "active");
  const fc = { l: L.id, k: L.g, f: "claim", m: "gameflip", x: 1, b: 1, p: 0.3, a: "hold", ask: 2, h: 7 };
  const row = (rg) => ({ k: L.g, g: L.g, f: "claim", m: "gameflip", pc: "no-evidence", sc: "unknown", old: {}, br: { rg }, pol: {}, pf: {} });
  const known = S.forwardScores({ samples: [{ at: T, fc: [fc], rows: [row("balanced")] }], bundle: small, cfg, now: small.now });
  assert.equal(known.discrimination.claim.hold.n, 1);
  const unknown = S.forwardScores({ samples: [{ at: T, fc: [fc], rows: [row("unknown")] }], bundle: small, cfg, now: small.now });
  assert.equal(unknown.discrimination.claim.hold.n, 0, "an abstention is not advice");
  assert.equal(unknown.discrimination.claim.abstained.n, 1);
  assert.equal(unknown.calibration.claim.n, 1, "its sell chance is still scored: the curve does not depend on the regime");
});

test("forward over daily samples: the same tables as the backtest, one sample per UTC day, baseline fitted before any of them", () => {
  const samples = [];
  for (let d = 12; d >= 1; d--) samples.push(sampleAt(small, small.now - d * DAY));
  samples.push(Object.assign({}, samples[0], { at: samples[0].at + 3600000 })); // a second sample the same day
  const fw = S.forwardScores({ samples, bundle: small, cfg, now: small.now });
  assert.equal(fw.samples, 12, "the duplicate day is ignored");
  assert.equal(fw.runsScored + fw.runsWaiting, 12);
  assert.equal(fw.baselineAt, samples[0].at, "the baseline's market rates come from the oldest scored sample's moment");
  for (const k of ["calibration", "discrimination", "placement", "agreement", "soldOrExpired"]) assert.ok(fw[k], k);
  assert.ok(fw.calibration.claim.n > 0 && fw.placement.claim.rows > 0);
  const none = S.forwardScores({ samples: [], bundle: small, cfg, now: small.now });
  assert.equal(none.runsScored, 0);
  assert.equal(none.calibration.claim.n, 0);
  assert.equal(none.calibration.claim.brier, null);
  assert.equal(none.placement.claim.best, null);
});

/* -------------------------------------------------------- sold or expired */

test("sold or expired, by hand: k units of one wave share a queue — E[min(Poisson(h·rows·d), k)] ÷ k each", () => {
  const flat = (h) => ({ h, buckets: Array.from({ length: 6 }, () => ({ h, evid: true, tiers: [{ h }, { h }, { h }] })) });
  const hz = { horizon: 2, markets: { gameflip: flat(0.5) } };
  const T = 10 * DAY;
  const exp = T + 2 * DAY;
  const u = (o) => Object.assign({ g: "w", m: "gameflip", bk: "w|ev|1", lids: [], l: T - DAY, s: null, x: exp + 3600000 }, o);
  const units = [u({ lids: ["row1"], s: T + DAY, x: null }), u({}), u({}), u({}), u({ g: "v", x: null }), u({ g: "past" }), u({ g: "open" }), u({ g: "undated" })];
  const expiryOf = (x) => (x.g === "past" ? T - DAY : x.g === "open" ? 30 * DAY : x.g === "undated" ? null : exp);
  const t = S.newTables();
  S.scoreUnits(t, { units, expiryOf, fc: [{ l: "row1", k: "w", f: "noclaim", m: "gameflip", x: 1 }], hz, tierOf: () => 0, T, now: 20 * DAY });
  const r = S.soldOrExpired(t.soe, t.soeSkip);
  // mu = 0.5/day × 1 row × 2 days = 1; E[min(D, 4)] = 4 − e^−1 (1 + 2 + 2.5 + 8/3)
  const e4 = 4 - Math.exp(-1) * (1 + 2 + 2.5 + 8 / 3);
  assert.equal(r.n, 4);
  near(r.expected, e4 / 4, 1e-3, "expected share");
  assert.equal(r.actual, 0.25);
  near(r.brier, ((e4 / 4 - 1) ** 2 + 3 * (e4 / 4) ** 2) / 4, 1e-3, "Brier per unit");
  assert.deepEqual(t.soeSkip, { undated: 1, past: 1, open: 1, unresolved: 1, noEstimate: 0 });
  // two live rows of the same offer sell twice as fast
  const t2 = S.newTables();
  S.scoreUnits(t2, { units: units.slice(0, 4).map((x, i) => (i === 1 ? Object.assign({}, x, { lids: ["row2"] }) : x)), expiryOf, fc: [{ l: "row1", f: "noclaim", m: "gameflip", x: 1 }, { l: "row2", f: "noclaim", m: "gameflip", x: 1 }], hz, tierOf: () => 0, T, now: 20 * DAY });
  near(S.soldOrExpired(t2.soe).expected, M.util.expectedSold(2, 4) / 4, 1e-3, "rate × 2 rows");
});

test("sold or expired sees the planted ending wave coming (omega saga, Ember League Week 4: 16 units, most expire)", () => {
  const planted = F.PLANTED.N.ended;
  const wave = small.noclaim.waves.find((w) => w.g === planted.game && w.wave === planted.wave);
  assert.ok(wave, "the planted wave");
  // One day before the wave ends (~2 days before its stock expires): the model expects few to sell.
  // Measured: expected 13.7 % vs 15.4 % really sold (13 units) on seed 1; large bundle 19.1 % vs 15.4 %.
  const close = S.backtest(small, { cfg, cuts: [wave.endAt - DAY] }).soldOrExpired.byGame[planted.game];
  assert.ok(close && close.n >= 8, `${close && close.n} units scored`);
  assert.ok(close.expected <= 0.35, `expected ${close.expected}: well below 1`);
  near(close.expected, close.actual, 0.1, "expected vs actual share sold before expiry");
  assert.ok(close.expired > close.sold, "expired units outnumber sold ones (PLANTED.N.ended)");
  // Five days out it still expects most to sell: the expected share falls as the expiry nears.
  const far = S.backtest(small, { cfg, cuts: [wave.endAt - 5 * DAY] }).soldOrExpired.byGame[planted.game];
  assert.ok(far.expected > close.expected + 0.3, `far ${far.expected} vs close ${close.expected}`);
  // the weekly backtest reports the table too, with every skipped unit accounted for
  const se = BT.soldOrExpired;
  assert.ok(se.n > 0);
  for (const k of ["past", "open", "unresolved", "undated", "noEstimate"]) assert.ok(Number.isInteger(se.skipped[k]), k);
});

/* -------------------------------------------------------- decision review */

test("decision review: samples a week old only, one entry per cell from its newest such sample, largest $ at stake first", () => {
  const now = 100 * DAY;
  const bundle = {
    now,
    fees: {},
    listings: [{ id: "L1", g: "alpha", f: "claim", m: "gameflip", o: "auto", kind: "single", st: "active", c: 0, p: 3 }],
    sales: [
      { lid: "L1", g: "alpha", f: "claim", m: "gameflip", t: 93 * DAY, p: 3 },
      { lid: "L1", g: "alpha", f: "claim", m: "gameflip", t: 95 * DAY, p: 3 },
      { lid: "L1", g: "alpha", f: "claim", m: "gameflip", t: 99.5 * DAY, p: 3 },
    ],
  };
  const row = (k, m, pc, sc, old, br) => ({ k, g: k, f: "claim", m, pc, sc, old, br });
  const r1 = row("alpha", "gameflip", "brain-lower", "agree", { a: 3, n: 2, sh: 2 }, { p: 2, sh: 2 }); // $1 × 2 = $2
  const r2 = row("beta", "ggsel", "agree", "brain-more", { a: 1.5, n: 1, sh: 1 }, { p: 1.5, sh: 4 }); // 3 × $1.5 = $4.5
  const r3 = row("gamma", "eldorado", "brain-higher", "brain-add", { a: 1, n: 10, sh: 0 }, { p: 1.2, sh: 2 }); // 0.2 × 10 + 2 × 1.2 = $4.4
  const r4 = row("delta", "gameflip", "agree", "agree", { a: 2, n: 1, sh: 1 }, { p: 2, sh: 1 });
  const big = row("alpha", "gameflip", "brain-lower", "agree", { a: 9, n: 9, sh: 2 }, { p: 1, sh: 2 });
  const samples = [
    { at: now - 9 * DAY, rows: [big] }, // older than the newest week-old sample of the same cell: ignored
    { at: now - 7.5 * DAY, rows: [r1, r2, r3, r4, { k: "alpha", f: "claim", m: "all", pc: "", sc: "" }] },
    { at: now - 3 * DAY, rows: [row("zeta", "gameflip", "brain-lower", "agree", { a: 50, n: 50 }, { p: 1 })] }, // not a week old
  ];
  const rv = S.decisionReview({ samples, bundle, now });
  assert.deepEqual(
    rv.map((x) => x.k),
    ["beta", "gamma", "alpha"],
  );
  assert.deepEqual(
    rv.map((x) => x.gap.usd),
    [4.5, 4.4, 2],
  );
  const alpha = rv[2];
  assert.equal(alpha.at, now - 7.5 * DAY, "its newest week-old sample");
  assert.deepEqual(alpha.next, { units: 2, net: alpha.next.net, days: 7 }, "two sales in the 7 days after, the third falls later");
  near(alpha.next.net, 2 * M.util.netOf(3, "gameflip", {}), 0.011, "net after the fee");
  assert.deepEqual(alpha.old, { a: 3, np: null, n: 2, sh: 2 });
  assert.equal(S.decisionReview({ samples, bundle, now, limit: 1 }).length, 1);
  assert.deepEqual(S.decisionReview({ samples: [], bundle, now }), []);
});

/* ----------------------------------------------------------- the tables */

test("every table carries n; nothing scored reads null, never 0", () => {
  for (const f of ["claim", "noclaim"]) {
    const c = BT.calibration[f];
    assert.ok(Number.isInteger(c.n), "calibration n");
    for (const b of c.reliability) assert.ok(Number.isInteger(b.n), "bin n");
    for (const x of Object.values(c.byMarket)) assert.ok(Number.isInteger(x.n), "by-market n");
    const d = BT.discrimination[f];
    assert.ok(Number.isInteger(d.n));
    for (const a of S.SCORED_ACTIONS) {
      assert.ok(Number.isInteger(d[a].n), "discrimination n");
      if (!d[a].n) assert.equal(d[a].rate, null);
    }
    const p = BT.placement[f];
    assert.ok(Number.isInteger(p.n) && p.n === p.rows);
    for (const id of M.PLACE_POLICIES) assert.ok(Number.isInteger(p[id].n), "placement n");
  }
  for (const m of Object.keys(BT.agreement)) for (const x of Object.values(BT.agreement[m])) assert.ok(Number.isInteger(x.near.n) && Number.isInteger(x.far.n));
  assert.ok(Number.isInteger(BT.soldOrExpired.n));
  assert.equal(BT.weeks.length, 6);
  // no week at all: every table empty, every figure null
  const zero = S.backtest(small, { cfg, weeks: 0 });
  assert.equal(zero.calibration.claim.n, 0);
  assert.equal(zero.calibration.claim.skill, null);
  assert.equal(zero.placement.claim.flat.rmse, null);
  assert.equal(zero.placement.claim.best, null);
  assert.equal(zero.discrimination.claim.hold.rate, null);
  assert.equal(zero.soldOrExpired, null, "no unit was ever live at a forecast");
});

/* ------------------------------------------------------------ the script */

test("script: runs on tests/fixtures/listingBrain/small.json and prints every table", () => {
  let out = "";
  let err = "";
  const code = script.main([SMALL], { write: (s) => (out += s), error: (s) => (err += s) });
  assert.equal(code, 0, err);
  for (const h of Object.values(script.HEADERS)) assert.ok(out.includes(h), "header: " + h);
  for (const p of M.PLACE_POLICIES) assert.ok(out.includes(p), "placement policy " + p);
  assert.match(out, /✓ best|not enough history yet/);
  assert.match(out, /Correlation, not cause/);
  assert.match(out, /must beat the baseline/);
  assert.match(out, /different price would have sold/);
  // the top disagreements: at most 15 rows, each a price or shelf disagreement
  const block = out.split("== " + script.HEADERS.disagreements + " ==")[1].split("\n== ")[0];
  const lines = block.split("\n").filter((l) => /^\S.*\s(claim|noclaim)\s/.test(l));
  assert.ok(lines.length > 0 && lines.length <= 15, `${lines.length} disagreement rows`);
  for (const l of lines) assert.match(l, /brain-lower|brain-higher|brain-more|brain-fewer|brain-add|brain-drop/);
});

test("script: --json, --weeks, usage errors; nothing runs on require", () => {
  let out = "";
  assert.equal(script.main([SMALL, "--json", "--weeks", "2"], { write: (s) => (out += s), error: () => {} }), 0);
  const j = JSON.parse(out);
  assert.equal(j.backtest.weeks.length, 2);
  assert.ok(j.summary && j.backtest.calibration && Array.isArray(j.disagreements));
  let err = "";
  assert.equal(script.main([], { write: () => {}, error: (s) => (err += s) }), 2);
  assert.match(err, /usage/);
  assert.equal(script.main([SMALL, "--weeks", "0"], { write: () => {}, error: () => {} }), 2);
  assert.equal(script.main(["/nonexistent/bundle.json"], { write: () => {}, error: () => {} }), 1);
  assert.deepEqual(script.parseArgs(["b.json", "--weeks=3"]), { file: "b.json", weeks: 3, json: false, help: false });
  const r = spawnSync(process.execPath, ["-e", 'require("./scripts/listing-brain-backtest")'], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: Object.assign({}, process.env, { CRED_SECRET: "x" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "requiring the script prints nothing");
  assert.ok(/\n/.test(script.table(["a", "b"], [["x", 1]])));
});

test("script: spawned as a program on the small fixture", () => {
  const r = spawnSync(process.execPath, ["scripts/listing-brain-backtest.js", SMALL, "--weeks", "1"], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: Object.assign({}, process.env, { CRED_SECRET: "x" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(script.HEADERS.calibration));
});

/* ------------------------------------------------------- determinism, speed */

test("determinism: the same bundle gives the same scores (sync and async alike)", async () => {
  const again = S.backtest(F.generate({ seed: 1 }), { cfg });
  assert.equal(JSON.stringify(again), JSON.stringify(BT));
  const async1 = await S.backtestAsync(small, { cfg });
  assert.equal(JSON.stringify(async1), JSON.stringify(BT));
  const samples = [sampleAt(small, small.now - 9 * DAY), sampleAt(small, small.now - 8 * DAY)];
  const a = S.forwardScores({ samples, bundle: small, cfg, now: small.now });
  const b = S.forwardScores({ samples: samples.slice().reverse(), bundle: small, cfg, now: small.now });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "sample order does not matter");
  assert.equal(JSON.stringify(S.decisionReview({ samples, bundle: small, now: small.now })), JSON.stringify(S.decisionReview({ samples, bundle: small, now: small.now })));
});

test("speed: the 6-week backtest of the LARGE fixture in under 15 s, never holding the event loop > 500 ms", async (t) => {
  const large = F.generate({ seed: 1, large: true });
  // Measured in the build sandbox: ~1.9 s for 6 weeks (each week = one evidence read to synthesise demand +
  // one full model run at the cut), longest synchronous stretch ~36 ms between yields.
  let last = Date.now();
  let max = 0;
  let ticks = 0;
  let on = true;
  const ping = () => {
    const n = Date.now();
    max = Math.max(max, n - last);
    last = n;
    ticks++;
    if (on) setImmediate(ping);
  };
  setImmediate(ping);
  const t0 = Date.now();
  const bt = await S.backtestAsync(large, {});
  const ms = Date.now() - t0;
  on = false;
  t.diagnostic(`large backtest ${ms} ms, longest synchronous stretch ${max} ms over ${ticks} yields`);
  assert.equal(bt.weeks.length, 6);
  assert.ok(bt.calibration.claim.n > 1000, `${bt.calibration.claim.n} claim forecasts scored`);
  assert.ok(ms < 15000, `${ms} ms`);
  assert.ok(max < 500, `longest synchronous stretch ${max} ms`);
  assert.ok(ticks > 6 * 3, "it yields inside each week, not only between weeks");
});

/* ------------------------------------------------------------ the runner */

test("runner: accuracy() scores the backtest, the logged daily samples and the review end to end", async () => {
  const B = require("../utils/listingBrain");
  const runs = [];
  const rows = [];
  for (let d = 10; d >= 1; d--) {
    const s = sampleAt(small, small.now - d * DAY);
    const _id = "run" + d;
    runs.push({ _id, at: new Date(s.at), day: new Date(s.at).toISOString().slice(0, 10), fcN: s.fc.length, fc: s.fc });
    for (const r of s.rows) rows.push(Object.assign({ run: _id }, r));
  }
  const chain = (value) => {
    const q = { sort: () => q, limit: () => q, lean: async () => value() };
    return q;
  };
  B._reset();
  B._setHooks({
    load: async () => small,
    now: () => small.now,
    settings: () => ({ getAutoFarm: () => ({ listingBrain: {} }) }),
    log: () => {},
    logErr: () => {},
    Run: () => ({
      find: () => chain(() => runs.map((r) => ({ _id: r._id, at: r.at, day: r.day }))),
      findOne: (q) => chain(() => runs.find((r) => r._id === q._id) || null),
    }),
    Row: () => ({ find: (q) => chain(() => rows.filter((r) => r.run === q.run)) }),
  });
  try {
    const a = await B.accuracy({ force: true });
    assert.equal(a.samples, 10);
    assert.equal(a.backtest.weeks.length, 6);
    assert.ok(a.backtest.calibration.claim.n > 0);
    assert.equal(a.forward.samples, 10);
    assert.ok(a.forward.runsScored > 0);
    assert.ok(a.forward.calibration.claim.n > 0, "the 7-day forecasts of samples a week old are scored");
    assert.ok(Array.isArray(a.review) && a.review.length > 0, "disagreements a week old, with what sold next");
    for (const r of a.review) assert.ok(r.at <= small.now - 7 * DAY && Number.isInteger(r.next.units));
  } finally {
    B._reset();
  }
});
