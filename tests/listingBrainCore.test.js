// The listing brain's pure model core (utils/listingBrain/model.js + model/*.js,
// docs/LISTING-BRAIN-PLAN.md §3–§4.8). Small hand-built bundles, synthetic names only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../utils/listingBrain/model");
const U = require("../utils/listingBrain/model/util");
const E = require("../utils/listingBrain/model/evidence");
const RF = require("../utils/listingBrain/model/ref");
const H = require("../utils/listingBrain/model/hazard");
const P = require("../utils/listingBrain/model/price");
const PL = require("../utils/listingBrain/model/place");

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const G = "alpha quest";
const CK = "s:aaa111";
const BK = G + "|1";

let seq = 0;
const nid = (p) => p + String(++seq).padStart(6, "0");

/** A bundle listing (plan §2.1 L), a system-made claim Gameflip row unless told otherwise. */
function L(o = {}) {
  return Object.assign(
    { id: nid("l"), g: G, gl: "Alpha Quest", m: "gameflip", o: "auto", f: "claim", kind: "single", script: false, ck: CK, bk: BK, ex: true, n: 1, p: 1.5, vmin: null, smin: null, st: "active", c: NOW - 5 * DAY, u: NOW - DAY, units: [], qty: 1, qr: 0, rb: null, pack: null },
    o,
  );
}
/** A unit sale (plan §2.1 S). */
function S(o = {}) {
  return Object.assign({ lid: "", g: G, m: "gameflip", o: "auto", f: "claim", ck: CK, bk: BK, ex: true, n: 1, p: 1.5, t: NOW - 3 * DAY, grp: nid("o"), basis: "reported", src: "unit" }, o);
}
/** A fresh farm-brain row. */
function DR(o = {}) {
  return Object.assign({ k: G, f: "claim", at: NOW - HOUR, live: true, hl: 48, c: "farm", w: 3, t: 20, on: 12, fl: 0, a30: 3, a45: 3 }, o);
}
function bundle(o = {}) {
  const b = {
    kind: "listing-brain-bundle",
    v: 1,
    now: NOW,
    af: {
      listingBrain: {},
      perMarketStock: 3,
      takes: { gameflip: true, digiseller: false, ggsel: true, zeusx: true, eldorado: true, playerauctions: true, g2g: true },
      mapped: {},
      noClaimGames: [],
      noclaimAutoSize: false,
      capDefault: 70,
      caps: {},
    },
    sizing: { coverageDays: 28, safetyStock: 6, maxPerGame: 250 },
    fees: {},
    pricing: { floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: {}, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25 },
    bulk: { markets: [], tiers: [], reserveSingles: 0 },
    listings: [],
    sales: [],
    demandOnly: [],
    bulkPrices: [],
    radar: { at: NOW, games: [], feed: [] },
    demand: [],
    noclaim: { units: [], waves: [] },
    old: { games: {}, offers: {} },
    notes: [],
    counts: {},
  };
  for (const [k, v] of Object.entries(o)) {
    if (k === "af") b.af = Object.assign(b.af, v);
    else b[k] = v;
  }
  return b;
}
const CFG = (over = {}) => Object.assign(U.readConfig({}), over);
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const TAKES = { gameflip: true, digiseller: false, ggsel: true, zeusx: true, eldorado: true, playerauctions: true, g2g: true };
const near = (got, want, msg = "", tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol, msg + " got " + got + ", want " + want);

/**
 * A market with a measured curve: `nSold` rows of the exact offer that sold after `sellDays` at
 * `soldP` (and so set ref ≈ soldP, exact-here), plus `nLive` live rows asking `liveP` for `liveAge` days.
 */
function curve({ m = "gameflip", g = G, ck = CK, bk = BK, f = "claim", o = "auto", nSold = 10, soldP = 1.5, sellDays = 2, nLive = 5, liveP = 2.5, liveAge = 20 } = {}) {
  const listings = [];
  const sales = [];
  for (let i = 0; i < nSold; i++) {
    const c = NOW - (30 + i) * DAY;
    // a quantity row that sold out and was closed: its last write is when it ended
    const single = m === "gameflip" || m === "zeusx";
    const row = L({ m, g, ck, bk, f, o, p: soldP, st: single ? "sold" : "delisted", c, u: single ? NOW - DAY : c + sellDays * DAY });
    listings.push(row);
    sales.push(S({ lid: row.id, m, g, ck, bk, f, o, p: soldP, t: c + sellDays * DAY }));
  }
  for (let i = 0; i < nLive; i++) listings.push(L({ m, g, ck, bk, f, o, p: liveP, st: "active", c: NOW - liveAge * DAY }));
  return { listings, sales };
}
function ctxOf(b, cfg = CFG(), prior = new Map()) {
  const ev = E.buildEvidence(b, { cfg, cut: b.now });
  const hz = { claim: H.fitHazard(ev, "claim"), noclaim: H.fitHazard(ev, "noclaim") };
  return { ev, hz, prior };
}

/* ----------------------------------- util ----------------------------------- */

test("pava gives the closest non-increasing fit, weighted, and keeps nulls", () => {
  assert.deepEqual(U.pava([1, 3, 2, 0.5], [1, 1, 1, 1]), [2, 2, 2, 0.5]);
  const w = U.pava([1, 3], [3, 1]);
  assert.ok(Math.abs(w[0] - 1.5) < 1e-12 && Math.abs(w[1] - 1.5) < 1e-12);
  const n = U.pava([2, null, 3, 1], [1, 1, 1, 1]);
  assert.equal(n[1], null);
  assert.equal(n[0], 2.5);
  assert.equal(n[2], 2.5);
  assert.equal(n[3], 1);
  const already = [5, 4, 4, 1];
  assert.deepEqual(U.pava(already, [1, 1, 1, 1]), already);
});

test("poissonTail: P(D ≥ k) values, edges, and the incremental tailer agree", () => {
  assert.equal(U.poissonTail(2, 0), 1);
  assert.equal(U.poissonTail(0, 1), 0);
  assert.ok(Math.abs(U.poissonTail(1, 1) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(U.poissonTail(2, 3) - (1 - Math.exp(-2) * (1 + 2 + 2))) < 1e-12);
  // a mean far past e^−745 underflow still gives the right middle of the distribution
  const big = U.poissonTail(900, 900);
  assert.ok(big > 0.45 && big < 0.56, String(big));
  const t = U.poissonTailer(3.7);
  for (let k = 1; k <= 12; k++) assert.ok(Math.abs(t.next() - U.poissonTail(3.7, k)) < 1e-9);
  // E[min(D, 2)] for mu = 1: P(D≥1) + P(D≥2)
  assert.ok(Math.abs(U.expectedSold(1, 2) - (1 - Math.exp(-1) + 1 - 2 * Math.exp(-1))) < 1e-12);
});

test("buckets, tiers and the $0.05 grid", () => {
  assert.equal(U.bucketOf(0.8), 0);
  assert.equal(U.bucketOf(0.81), 1);
  assert.equal(U.bucketOf(1.0), 1);
  assert.equal(U.bucketOf(1.2), 2);
  assert.equal(U.bucketOf(1.5), 3);
  assert.equal(U.bucketOf(2.0), 4);
  assert.equal(U.bucketOf(2.01), 5);
  assert.equal(U.tierOf(0.5, [1, 5]), 0);
  assert.equal(U.tierOf(1, [1, 5]), 1);
  assert.equal(U.tierOf(4.99, [1, 5]), 1);
  assert.equal(U.tierOf(5, [1, 5]), 2);
  assert.equal(U.snap05(1.23), 1.25);
  assert.equal(U.snap05(0.01), 0.05);
  assert.equal(U.snap05(0), 0);
  assert.deepEqual(U.parseCellKey(U.cellKey("alpha quest", "claim", "ggsel")), { g: "alpha quest", f: "claim", m: "ggsel" });
});

test("readConfig: defaults, clamps, typos read as the default, only an explicit on turns it on", () => {
  const d = M.readConfig({});
  assert.equal(d.enabled, false);
  assert.equal(d.horizonDaysNoclaim, 2);
  assert.equal(d.cooldownH, 72);
  assert.equal(d.fcCap, 5000);
  assert.equal(d.intervalMin, 180);
  assert.deepEqual(d.tierEdges, [1, 5]);
  assert.equal(d.explore, true);
  const c = M.readConfig({ listingBrain: { enabled: "yes", intervalMin: 5, maxStepPct: 500, shrinkK: "abc", tierEdges: [5, 1], explore: "off", policyPrice: "nonsense", minP7Scarce: 2 } });
  assert.equal(c.enabled, true);
  assert.equal(c.intervalMin, 30);
  assert.equal(c.maxStepPct, 100);
  assert.equal(c.shrinkK, 30);
  assert.deepEqual(c.tierEdges, [1, 5]);
  assert.equal(c.explore, false);
  assert.equal(c.policyPrice, "curve");
  assert.equal(c.minP7Scarce, 0.99);
  assert.equal(M.readConfig({ listingBrain: { enabled: "true " } }).enabled, true);
  assert.equal(M.readConfig({ listingBrain: { enabled: "on please" } }).enabled, false);
  assert.ok(Object.isFrozen(M.DEFAULTS));
});

/* --------------------------------- evidence --------------------------------- */

test("kind of row: plan §3 order — claim-at-sale is checked before origin", () => {
  assert.equal(E.rowKindOf({ kind: "farm", o: "auto" }), "farm");
  assert.equal(E.rowKindOf({ kind: "single", o: "auto", pack: 5 }), "bulk");
  assert.equal(E.rowKindOf({ kind: "lot", o: "auto" }), "lot");
  assert.equal(E.rowKindOf({ kind: "account", o: "auto" }), "account");
  assert.equal(E.rowKindOf({ kind: "cas", o: "auto", script: true }), "cas");
  assert.equal(E.rowKindOf({ kind: "single", o: "auto" }), "system");
  assert.equal(E.rowKindOf({ kind: "single", o: "unclaimed" }), "system");
  assert.equal(E.rowKindOf({ kind: "single", o: "manual" }), "hand");
  assert.equal(E.rowKindOf({ kind: "single" }), "hand", "an unmarked row fails closed");
  assert.equal(E.rowKindOf({ kind: "something-new", o: "auto" }), "hand");
  const ev = E.buildEvidence(bundle({ listings: [L({ kind: "farm" }), L({ kind: "cas", o: "auto", script: true, m: "g2g" }), L({ o: "manual" }), L()] }), { cfg: CFG(), cut: NOW });
  assert.equal(ev.rows.length, 3, "rent-farm rows are not even loaded");
  assert.deepEqual(
    ev.rows.map((r) => r.advisable),
    [false, false, true],
  );
});

test("exposure: Gameflip is capped 30 days after createdAt and an expired row is not live", () => {
  const row = L({ c: NOW - 40 * DAY, u: NOW - DAY, st: "active" });
  const ev = E.buildEvidence(bundle({ listings: [row] }), { cfg: CFG(), cut: NOW });
  const R = ev.byId.get(row.id);
  assert.equal(R.activeAtCut, false);
  assert.ok(Math.abs(R.expo.days - 30) < 1e-9, String(R.expo.days));
  assert.equal(R.expo.units, 0);
});

test("exposure: a sold row ends at its sale, never at updatedAt", () => {
  const row = L({ c: NOW - 10 * DAY, u: NOW - DAY, st: "sold" });
  const sale = S({ lid: row.id, t: NOW - 8 * DAY });
  const ev = E.buildEvidence(bundle({ listings: [row], sales: [sale] }), { cfg: CFG(), cut: NOW });
  const R = ev.byId.get(row.id);
  assert.ok(Math.abs(R.expo.days - 2) < 1e-9);
  assert.equal(R.expo.units, 1);
  assert.equal(R.activeAtCut, false);
});

test("exposure: live rows count their exposure; a rebundle splits it; Eldorado dies at 21 days unsold", () => {
  const live = L({ m: "ggsel", c: NOW - 5 * DAY, qty: 3 });
  const rb = L({ m: "ggsel", c: NOW - 20 * DAY, rb: NOW - 10 * DAY, qty: 3 });
  const eld = L({ m: "eldorado", c: NOW - 50 * DAY, st: "delisted", u: NOW - 2 * DAY });
  const sales = [S({ lid: rb.id, m: "ggsel", t: NOW - 15 * DAY }), S({ lid: rb.id, m: "ggsel", t: NOW - 5 * DAY })];
  const ev = E.buildEvidence(bundle({ listings: [live, rb, eld], sales }), { cfg: CFG(), cut: NOW });
  const a = ev.byId.get(live.id);
  assert.equal(a.activeAtCut, true);
  assert.ok(Math.abs(a.expo.days - 5) < 1e-9);
  const b = ev.byId.get(rb.id);
  assert.ok(Math.abs(b.expo.days - 10) < 1e-9, "the part before rebundledAt is dropped");
  assert.equal(b.expo.units, 1, "only the sale after the rebundle counts for the offer");
  const c = ev.byId.get(eld.id);
  assert.ok(Math.abs(c.expo.days - 21) < 1e-9, String(c.expo.days));
  assert.equal(c.expo.endApprox, true);
  // the sale before the rebundle is no evidence for the new contents, but still an order on the market
  assert.equal((ev.idx.byMCk.get("claim|ggsel|" + CK) || []).length, 1);
  assert.equal((ev.idx.byM.get("claim|ggsel") || []).length, 2);
});

test("orders: one per buyer order, never a hand/shop sale, never above $25", () => {
  const sales = [
    S({ grp: "A", p: 1.2, t: NOW - 3 * DAY }),
    S({ grp: "A", p: 1.2, t: NOW - 3 * DAY + 1000 }),
    S({ grp: "B", p: 1.4, src: "hand" }),
    S({ grp: "C", p: 1.4, src: "shop" }),
    S({ grp: "D", p: 99 }),
    S({ grp: "E", p: 0 }),
    S({ grp: "F", p: 1.6, t: NOW - 400 * DAY }),
    S({ grp: "G", p: 1.8 }),
  ];
  const ev = E.buildEvidence(bundle({ sales }), { cfg: CFG(), cut: NOW });
  assert.deepEqual(ev.orders.map((o) => o.p).sort(), [1.2, 1.8]);
  assert.equal(ev.salesBefore.length, sales.length, "every unit is still demand");
});

test("orders: a rent-farm row's sales count as nothing; a pack's sales are demand, never a price", () => {
  const farm = L({ kind: "farm", o: "manual", p: 12 });
  const pack = L({ kind: "bulk", pack: 5, m: "eldorado", p: 6 });
  const sales = [S({ lid: farm.id, p: 12 }), S({ lid: farm.id, p: 12 }), S({ lid: pack.id, m: "eldorado", p: 6 }), S({ p: 1.5 })];
  const ev = E.buildEvidence(bundle({ listings: [farm, pack], sales }), { cfg: CFG(), cut: NOW });
  assert.deepEqual(ev.orders.map((o) => o.p), [1.5]);
  assert.equal(ev.salesBefore.length, 2, "the pack unit is still demand; the rent-farm windows are not");
  assert.ok(!ev.rows.some((r) => r.id === farm.id));
});

test("ladders: an exact offer at two prices with a hand-made rung — not when all rows are auto", () => {
  const b1 = bundle({ listings: [L({ m: "eldorado", p: 1 }), L({ m: "eldorado", p: 2, o: "manual" })] });
  assert.ok(E.buildEvidence(b1, { cfg: CFG(), cut: NOW }).ladders.has("eldorado|" + CK));
  const b2 = bundle({ listings: [L({ m: "eldorado", p: 1 }), L({ m: "eldorado", p: 2 })] });
  assert.equal(E.buildEvidence(b2, { cfg: CFG(), cut: NOW }).ladders.size, 0);
});

/* ----------------------------------- ref ------------------------------------ */

test("ref cascade: exact here is high; on a listing-now market medium at best", () => {
  const sales = [];
  for (let i = 0; i < 4; i++) sales.push(S({ p: 1 + i * 0.1 }), S({ m: "eldorado", p: 2 }));
  const { ev } = ctxOf(bundle({ sales }));
  const gf = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(gf.basis, "exact-here");
  assert.equal(gf.conf, "high");
  assert.equal(gf.ref, 1.15);
  assert.equal(gf.n, 4);
  const el = RF.refFor(ev, { g: G, m: "eldorado", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(el.basis, "exact-here");
  assert.equal(el.conf, "medium");
  assert.equal(RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 }), gf, "memoised per offer");
});

test("ref cascade: band here is low under 8 orders, medium from 8", () => {
  const mk = (n) => Array.from({ length: n }, () => S({ ck: "s:other", p: 1.3 }));
  const low = RF.refFor(ctxOf(bundle({ sales: mk(3) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(low.basis, "band-here");
  assert.equal(low.conf, "low");
  const med = RF.refFor(ctxOf(bundle({ sales: mk(8) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(med.conf, "medium");
});

test("ref cascade: translated is medium from two markets, low from one, never from a blocked one", () => {
  // the translator's venue-median fallback needs ≥ 10 orders a side
  const filler = [];
  for (const m of ["gameflip", "ggsel", "eldorado", "digiseller"]) for (let i = 0; i < 12; i++) filler.push(S({ m, g: "beta", ck: "s:b" + i, bk: "beta|1", p: 1.5 }));
  const two = bundle({ sales: filler.concat([S({ m: "ggsel", p: 1.4 }), S({ m: "ggsel", p: 1.4 }), S({ m: "eldorado", p: 1.6 })]) });
  const r2 = RF.refFor(ctxOf(two).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r2.basis, "translated");
  assert.equal(r2.conf, "medium");
  assert.equal(r2.n, 3);
  const one = bundle({ sales: filler.concat([S({ m: "ggsel", p: 1.4 }), S({ m: "ggsel", p: 1.4 }), S({ m: "ggsel", p: 1.4 })]) });
  const r1 = RF.refFor(ctxOf(one).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r1.basis, "translated");
  assert.equal(r1.conf, "low");
  // Digiseller is history only: its sale of these exact items never prices Gameflip
  const blocked = bundle({ sales: filler.concat([S({ m: "digiseller", p: 1.4 }), S({ m: "digiseller", p: 1.4, grp: "x2" })]) });
  const rb = RF.refFor(ctxOf(blocked).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.notEqual(rb.basis, "translated");
});

test("ref cascade: rivals (Gameflip/GGSel only, same radar band) then venue; both capped at the market p75", () => {
  const feed = [1, 1.2, 1.4, 9].map((p, i) => ({ g: G, m: "gameflip", p, u: 1, n: 1, t: NOW - (i + 1) * DAY }));
  const venue = [];
  for (let i = 0; i < 12; i++) venue.push(S({ g: "beta", ck: "s:v" + i, bk: "beta|1", p: 1 + i * 0.1 }));
  const b = bundle({ sales: venue, radar: { at: NOW, games: [], feed } });
  const { ev } = ctxOf(b);
  const r = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r.basis, "rivals");
  assert.equal(r.conf, "low");
  assert.equal(r.ref, 1.3);
  const big = RF.refFor(ev, { g: G, m: "gameflip", ck: "s:big", bk: G + "|31+", ex: true, n: 40 });
  assert.equal(big.basis, "venue", "a 40-item offer never borrows the 1-item rivals' median");
  assert.equal(big.conf, "none");
  // a venue anchor above the p75 is cut to it
  const hi = [];
  for (let i = 0; i < 12; i++) hi.push(S({ g: "beta", ck: "s:h" + i, bk: "beta|1", m: "ggsel", p: i < 9 ? 1 : 10 }));
  const r2 = RF.refFor(ctxOf(bundle({ sales: hi })).ev, { g: "gamma", m: "ggsel", ck: null, bk: "gamma|1", ex: false, n: 1 });
  assert.equal(r2.basis, "venue");
  assert.ok(r2.ref <= RF.marketP75(ctxOf(bundle({ sales: hi })).ev, "ggsel"));
  // the ceiling is the market's highest order
  assert.equal(r.ceiling, 2.1);
});

test("C10 one or two orders elsewhere are no estimate: a translation needs ≥ 3 source orders in total", () => {
  const filler = [];
  for (const m of ["gameflip", "ggsel", "eldorado"]) for (let i = 0; i < 12; i++) filler.push(S({ m, g: "beta", ck: "s:b" + i, bk: "beta|1", p: 1.5 }));
  for (const extra of [[S({ m: "ggsel", p: 1.4 })], [S({ m: "ggsel", p: 1.4 }), S({ m: "eldorado", p: 1.6 })]]) {
    const r = RF.refFor(ctxOf(bundle({ sales: filler.concat(extra) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
    assert.notEqual(r.basis, "translated", extra.length + " order(s)");
  }
  // the band's translation too: 2 per market, and 3 in all
  const band = [S({ m: "ggsel", ck: "s:x1", p: 1.4 }), S({ m: "ggsel", ck: "s:x2", p: 1.4 })];
  assert.notEqual(RF.refFor(ctxOf(bundle({ sales: filler.concat(band) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 }).basis, "translated");
  band.push(S({ m: "ggsel", ck: "s:x3", p: 1.4 }));
  // three band orders on ggsel: band-here there, translated here
  assert.equal(RF.refFor(ctxOf(bundle({ sales: filler.concat(band) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 }).basis, "translated");
});

test("H11 a translated anchor is capped by what buyers paid for THIS game here, else 1.5× its source median", () => {
  const filler = [];
  for (const m of ["gameflip", "ggsel", "eldorado"]) for (let i = 0; i < 12; i++) filler.push(S({ m, g: "beta", ck: "s:c" + i, bk: "beta|1", p: 1 }));
  const exactElsewhere = [S({ m: "eldorado", p: 4 }), S({ m: "eldorado", p: 4 }), S({ m: "ggsel", p: 4 })];
  // three orders of this game here (another size band): their p75 caps the anchor
  const game = [1, 1, 1.2].map((p) => S({ m: "gameflip", ck: "s:other", bk: G + "|2-3", n: 2, p }));
  const r = RF.refFor(ctxOf(bundle({ sales: filler.concat(exactElsewhere, game) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r.basis, "translated");
  assert.equal(r.capped, true);
  assert.equal(r.ref, 1.2);
  assert.ok(r.why.some((w) => /this game's orders here/.test(w)));
  // with no order of this game here the market-wide p75 ($1, another game's level) no longer binds: 1.5 × the source median does
  const free = RF.refFor(ctxOf(bundle({ sales: filler.concat(exactElsewhere) })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(free.basis, "translated");
  assert.equal(free.capped, false);
  assert.equal(free.ref, 4);
  assert.ok(free.ref > RF.marketP75(ctxOf(bundle({ sales: filler.concat(exactElsewhere) })).ev, "gameflip"));
});

test("H5 the two farms never share a price: a no-claim order never makes a claim offer's reference", () => {
  const nc = [1, 1.1, 1.2].map((p) => S({ f: "noclaim", o: "unclaimed", p }));
  const ev = ctxOf(bundle({ sales: nc })).ev;
  assert.equal(RF.refFor(ev, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 }).ref, null, "not even through the venue median");
  const own = RF.refFor(ev, { g: G, f: "noclaim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(own.basis, "exact-here");
  assert.equal(own.ref, 1.1);
  assert.equal(RF.marketMax(ev, "gameflip", "claim"), null);
  assert.equal(RF.marketMax(ev, "gameflip", "noclaim"), 1.2);
});

test("H15 p25 from fewer than 3 orders is never above the reference", () => {
  // two dear band orders here (no estimate of their own), a translated reference far below them
  const filler = [];
  for (const m of ["gameflip", "ggsel"]) for (let i = 0; i < 12; i++) filler.push(S({ m, g: "beta", ck: "s:c" + i, bk: "beta|1", p: 1 }));
  const sales = filler.concat([S({ m: "ggsel", p: 1 }), S({ m: "ggsel", p: 1 }), S({ m: "ggsel", p: 1 }), S({ m: "gameflip", ck: "s:d1", p: 3 }), S({ m: "gameflip", ck: "s:d2", p: 3 })]);
  const r = RF.refFor(ctxOf(bundle({ sales })).ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r.basis, "translated");
  assert.ok(r.p25 <= r.ref, r.p25 + " vs " + r.ref);
});

/* ---------------------------------- hazard ---------------------------------- */

test("hazard: under minSales a market has no estimate at all; every bucket is unpickable", () => {
  // a reference price from five orders with no row, and only two sold rows behind the curve
  const c = curve({ nSold: 2, nLive: 3 });
  const refOrders = Array.from({ length: 5 }, () => S({ p: 1.5, t: NOW - 60 * DAY }));
  const { hz } = ctxOf(bundle({ listings: c.listings, sales: c.sales.concat(refOrders) }));
  assert.equal(hz.claim.markets.gameflip.S, 2);
  assert.ok(hz.claim.markets.gameflip.D > 0);
  assert.equal(hz.claim.markets.gameflip.h, null);
  assert.equal(H.hazardAt(hz.claim, "gameflip", 0, 1), null);
  assert.equal(H.evidenced(hz.claim, "gameflip", 1), false);
});

test("hazard: shrunk, non-increasing in price, interpolated log-linearly and flat beyond the ends", () => {
  // cheap offers that sold slowly, dear offers that sold fast: raw hazard RISES with price — PAVA pools it.
  // One row per offer (each its own items), all priced against one band reference of $1.20.
  const listings = [];
  const sales = [];
  const refOrders = [1.2, 1.2, 1.2].map((p) => S({ ck: "s:refonly", p, t: NOW - 150 * DAY }));
  for (let i = 0; i < 6; i++) {
    const r = L({ ck: "s:cheap" + i, p: 1.0, st: "sold", c: NOW - 40 * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, ck: r.ck, p: 1.0, t: NOW - 20 * DAY }));
  }
  for (let i = 0; i < 6; i++) {
    const r = L({ ck: "s:dear" + i, p: 1.4, st: "sold", c: NOW - 40 * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, ck: r.ck, p: 1.4, t: NOW - 39 * DAY }));
  }
  const { hz } = ctxOf(bundle({ listings, sales: sales.concat(refOrders) }));
  const mk = hz.claim.markets.gameflip;
  assert.equal(mk.S, 12);
  const ev = mk.buckets.map((b, i) => [b, i]).filter(([b]) => b.evid);
  assert.equal(ev.length, 2, "two evidenced buckets");
  const [[lo], [hi]] = ev;
  assert.ok(hi.hRaw > lo.hRaw, "the raw curve violates monotonicity in this data");
  assert.ok(hi.h <= lo.h + 1e-12, "pooled curve is non-increasing");
  for (let t = 0; t < 3; t++) assert.ok(hi.tiers[t].h <= lo.tiers[t].h + 1e-12);
  // H4: an empty bucket has no hazard at all (it used to sit at the market's rate and lift the curve)
  for (const b of mk.buckets) if (!b.evid) assert.equal(b.h, null);
  // the curve's nodes sit where the exposure did (the asks' x), not at bucket centres
  assert.ok(Math.abs(lo.x - 1.0 / 1.2) < 1e-3 && Math.abs(hi.x - 1.4 / 1.2) < 1e-3);
  // interpolation between nodes is between its neighbours; flat beyond the ends
  const a = H.hazardAt(hz.claim, "gameflip", null, lo.x);
  const b = H.hazardAt(hz.claim, "gameflip", null, hi.x);
  const mid = H.hazardAt(hz.claim, "gameflip", null, (lo.x + hi.x) / 2);
  assert.ok(mid <= a + 1e-12 && mid >= b - 1e-12);
  assert.equal(H.hazardAt(hz.claim, "gameflip", null, 0.1), a);
  assert.equal(H.hazardAt(hz.claim, "gameflip", null, 9), b);
  const h = H.hazardAt(hz.claim, "gameflip", 0, 1);
  assert.ok(Math.abs(H.pH(hz.claim, "gameflip", 0, 1, 7) - (1 - Math.exp(-7 * h))) < 1e-12);
  // H4: no price above the highest evidenced node is ever a candidate
  assert.equal(H.evidenced(hz.claim, "gameflip", hi.x), true);
  assert.equal(H.evidenced(hz.claim, "gameflip", hi.x + 0.05), false);
  assert.equal(H.evidenced(hz.claim, "gameflip", 0.2), true, "below the lowest node the curve is flat");
});

test("hazard: ZeusX never enters a fit; hand-made rows only when they are the same items as a system row", () => {
  const z = curve({ m: "zeusx" });
  const hand = curve({ o: "manual", ck: "s:handonly", bk: G + "|2-3" });
  const { hz } = ctxOf(bundle({ listings: z.listings.concat(hand.listings), sales: z.sales.concat(hand.sales) }));
  assert.equal(hz.claim.markets.zeusx, undefined);
  assert.equal(hz.claim.markets.gameflip, undefined, "hand-made rows of items no system row sells stay out of the curve");
});

/* ---------------------------------- price ----------------------------------- */

function regimeOf(dr, extra = {}) {
  const b = bundle(Object.assign({ demand: [DR(dr)] }, extra));
  const ev = E.buildEvidence(b, { cfg: CFG(), cut: NOW });
  return P.gameState(ev, G, dr.f || "claim");
}

test("regime table: scarce, balanced, overstock (cover, skip, fading), unknown (missing or stale)", () => {
  assert.equal(regimeOf({ w: 4, on: 2 }).regime, "scarce");
  assert.equal(regimeOf({ w: 4, on: 12 }).regime, "balanced");
  assert.equal(regimeOf({ w: 1, on: 12 }).regime, "overstock");
  assert.equal(regimeOf({ w: 4, on: 12, c: "skip" }).regime, "overstock");
  assert.equal(regimeOf({ w: 4, on: 12, a30: 1, a45: 4 }).regime, "overstock");
  assert.equal(regimeOf({ w: 0, on: 5 }).regime, "overstock");
  assert.equal(regimeOf({ w: 4, on: 12, at: NOW - 7 * HOUR }).regime, "unknown", "older than maxDemandAgeH");
  const ev = E.buildEvidence(bundle(), { cfg: CFG(), cut: NOW });
  const gs = P.gameState(ev, G, "claim");
  assert.equal(gs.unknown, true);
  assert.match(gs.why, /farm-brain/);
  // an ended campaign with the rivals gone reads scarce (claim)
  const waves = [{ g: G, ev: "Ev", wave: "Week 1", startAt: NOW - 20 * DAY, endAt: NOW - 2 * DAY }];
  const games = [{ key: G, rivalSellers: 1 }];
  assert.equal(regimeOf({ w: 4, on: 12, live: false }, { noclaim: { units: [], waves }, radar: { at: NOW, games, feed: [] } }).regime, "scarce");
  games[0].rivalSellers = 3;
  assert.equal(regimeOf({ w: 4, on: 12, live: false }, { noclaim: { units: [], waves }, radar: { at: NOW, games, feed: [] } }).regime, "balanced");
});

test("regime precedence: an ended campaign with the rivals gone outranks fading; perishing stock outranks all", () => {
  const waves = [{ g: G, ev: "Ev", wave: "Week 1", startAt: NOW - 20 * DAY, endAt: NOW - 2 * DAY }];
  const games = [{ key: G, rivalSellers: 0 }];
  const gs = regimeOf({ w: 4, on: 12, live: false, a30: 0.5, a45: 2 }, { noclaim: { units: [], waves }, radar: { at: NOW, games, feed: [] } });
  assert.equal(gs.regime, "scarce");
  assert.ok(gs.regimeWhy.some((w) => /Outranked: Fading/.test(w)));
  // cover far over target still wins over an ended campaign
  assert.equal(regimeOf({ w: 1, on: 40, live: false }, { noclaim: { units: [], waves }, radar: { at: NOW, games, feed: [] } }).regime, "overstock");
  // no-claim: a thin shelf of perishing stock is overstock, not scarce
  const live = [{ g: G, ev: "Ev", wave: "Week 2", startAt: NOW - 5 * DAY, endAt: NOW + 10 * HOUR }];
  assert.equal(regimeOf({ f: "noclaim", w: 9, on: 1 }, { noclaim: { units: [], waves: live } }).regime, "overstock");
});

test("no-claim: stock close to expiry is overstock and its horizon is cut to the time left", () => {
  const waves = [{ g: G, ev: "Ev", wave: "Week 1", startAt: NOW - 10 * DAY, endAt: NOW + 20 * HOUR }];
  const units = [{ g: G, m: "gameflip", st: "listed", l: NOW - 2 * DAY, s: null, p: 0, sm: null, x: null, lids: [], bk: "", camps: ["Ev Week 1"] }];
  const gs = regimeOf({ f: "noclaim", w: 4, on: 2 }, { noclaim: { units, waves } });
  assert.equal(gs.regime, "overstock", "sells now or expires (beats a thin shelf)");
  assert.ok(gs.perishDays < 1 && gs.perishDays > 0.8);
  const ev = E.buildEvidence(bundle({ demand: [DR({ f: "noclaim" })], noclaim: { units, waves } }), { cfg: CFG(), cut: NOW });
  assert.ok(Math.abs(P.horizonFor(ev, "noclaim", P.gameState(ev, G, "noclaim")) - 20 / 24) < 1e-9);
  // the claim window is learned from expired units: expiredAt − wave end
  const old = [{ g: G, ev: "Old", wave: "Week 1", startAt: NOW - 60 * DAY, endAt: NOW - 40 * DAY }];
  const exp = [3, 5, 7].map((d) => ({ g: G, m: "gameflip", st: "expired", l: NOW - 50 * DAY, s: null, p: 0, x: NOW - (40 - d) * DAY, lids: [], camps: ["Old Week 1"] }));
  const ev2 = E.buildEvidence(bundle({ noclaim: { units: exp, waves: old } }), { cfg: CFG(), cut: NOW });
  assert.equal(ev2.noclaim.claimWindowByGame.get(G), 5);
});

test("candidates: ref grid, floor, p25 and ask; snapped, inside [floor, ceiling]", () => {
  const c = P.candidates({ ref: 1.5, ceiling: 2.5, p25: 1.12 }, 0.75, [1.12, 1.83]);
  assert.ok(c.every((p) => p >= 0.75 && p <= 2.5));
  assert.ok(c.includes(0.75) && c.includes(1.5) && c.includes(1.1) && c.includes(1.85));
  assert.ok(!c.includes(3), "2.0 × ref is above the ceiling");
  assert.deepEqual(c, c.slice().sort((a, b) => a - b));
  assert.deepEqual(P.candidates({ ref: null }, 0.75), []);
  // a floor off the grid stays the floor (Digiseller's $1.28), nothing under it
  assert.ok(P.candidates({ ref: 1.3, ceiling: 3 }, 1.28).every((p) => p >= 1.28));
});

/** One live claim Gameflip row priced against a curve; returns its offer verdict. */
function verdictFor({ curveOpts = {}, live = {}, dr = {}, cfg = CFG(), prior = new Map(), extraSales = [], extraListings = [], m = "gameflip", base } = {}) {
  const c = curve(Object.assign({ m }, curveOpts));
  const row = L(Object.assign({ m, p: 1.5, c: NOW - 2 * DAY }, live));
  const b = bundle({ listings: c.listings.concat([row], extraListings), sales: c.sales.concat(extraSales), demand: [DR(dr)] });
  const ctx = ctxOf(b, cfg, prior);
  const R = ctx.ev.byId.get(row.id);
  const v = P.priceOffer(ctx, { g: G, f: "claim", m, ck: CK, bk: BK, ex: true, n: 1, band: "1", live: [R], base, ladder: ctx.ev.ladders.has(m + "|" + CK) });
  return { v, ctx, R, row };
}

test("price: the gate order is confidence → raise rule → step → GGSel raise-only → floor last", () => {
  // a raise past every gate: no orders at the higher price (raise rule), then the step limit
  const { v } = verdictFor({ curveOpts: { soldP: 3, liveP: 3, nLive: 0, sellDays: 0.2 }, live: { p: 1.0 }, dr: { w: 4, on: 12 } });
  assert.equal(v.conf, "high");
  assert.ok(v.raw > 1.35, String(v.raw));
  const order = ["confidence", "raise-rule", "step", "ggsel-raise-only", "floor"];
  const seen = v.gates.filter((g) => order.includes(g));
  assert.deepEqual(seen, seen.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  // the ten $3 orders are evidence at the raise, so the raise rule passes and the step limit binds
  assert.ok(v.gates.includes("step"), v.gates.join(","));
  assert.equal(v.p, U.floor05(1.0 * 1.35));
  assert.equal(v.live[0].a, "raise");
});

test("price: a raise needs orders here at or above it — else it is cut back to the base, with a test unit", () => {
  // ref 1.50 from ten fast sales; five dearer rows (x = 1.5) also sold fast, but UNPRICED: the curve
  // says the higher price sells, yet no buyer order stands at or above it on this market
  const build = (pricedDear) => {
    const listings = [];
    const sales = [];
    for (let i = 0; i < 10; i++) {
      const r = L({ p: 1.5, st: "sold", c: NOW - (30 + i) * DAY });
      listings.push(r);
      sales.push(S({ lid: r.id, p: 1.5, t: r.c + DAY }));
    }
    for (let i = 0; i < 5; i++) {
      const r = L({ p: 2.25, st: "sold", c: NOW - (20 + i) * DAY });
      listings.push(r);
      sales.push(S({ lid: r.id, p: i < pricedDear ? 2.25 : 0, t: r.c + DAY }));
    }
    // another game's $3 order lifts the market's ceiling (its highest order) without being evidence
    // for this game's band
    sales.push(S({ g: "other", ck: "s:other", bk: "other|1", p: 3 }));
    const row = L({ p: 1.5, c: NOW - 0.5 * DAY });
    listings.push(row);
    const ctx = ctxOf(bundle({ listings, sales, demand: [DR({ w: 4, on: 12 })] }));
    const R = ctx.ev.byId.get(row.id);
    return P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: [R] });
  };
  const cut = build(0);
  assert.equal(cut.conf, "high");
  assert.ok(cut.raw > 1.5, "the curve wants more than the ask");
  assert.ok(cut.gates.includes("raise-rule"));
  assert.equal(cut.p, 1.5, "cut back to the base");
  assert.equal(cut.live[0].a, "test", "worth one test unit, not the row's whole stock");
  assert.ok(cut.live[0].p > 1.5 && cut.live[0].p <= U.floor05(1.5 * 1.35));
  // two priced orders at the dearer price are the evidence a raise needs; the step limit still binds
  const ok = build(2);
  assert.ok(!ok.gates.includes("raise-rule"), ok.gates.join(","));
  assert.ok(ok.gates.includes("step"));
  assert.equal(ok.p, U.floor05(1.5 * 1.35));
  assert.equal(ok.live[0].a, "raise");
});

/** A curve with evidence at x ≈ 1.0 (fast) and x ≈ 1.5 (slower, priced), ceiling lifted to $3. */
function slopeCtx(dr, { dear = 4, dearDays = 3 } = {}) {
  const listings = [];
  const sales = [];
  for (let i = 0; i < 10; i++) {
    const r = L({ p: 1.5, st: "sold", c: NOW - (30 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 1.5, t: r.c + DAY }));
  }
  for (let i = 0; i < dear; i++) {
    const r = L({ p: 2.25, st: "sold", c: NOW - (20 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 2.25, t: r.c + dearDays * DAY }));
  }
  sales.push(S({ g: "other", ck: "s:other", bk: "other|1", p: 3 }));
  return ctxOf(bundle({ listings, sales, demand: [DR(dr)] }));
}

test("price: a thin bucket is never picked, however well it scores", () => {
  const ctx = slopeCtx({ w: 4, on: 12 }, { dear: 0 });
  const v = P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: null });
  const best = v.cands.reduce((a, c) => (c.value !== null && (!a || c.value > a.value) ? c : a), null);
  assert.equal(best.evid, false, "the best-scoring candidate sits in a thin bucket");
  assert.ok(best.p > v.raw);
  assert.ok(v.cands.find((c) => c.p === v.raw).evid);
});

test("price: each regime picks by its own rule (balanced max value, overstock fastest ≥ p25, scarce highest with pH ≥ min)", () => {
  const pick = (dr) => {
    const ctx = slopeCtx(dr);
    return P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: null });
  };
  const bal = pick({ w: 4, on: 12 });
  assert.equal(bal.regime, "balanced");
  const ev = bal.cands.filter((c) => c.evid);
  assert.ok(ev.length >= 2);
  const maxV = Math.max(...ev.map((c) => c.value));
  assert.equal(bal.raw, Math.max(...ev.filter((c) => c.value === maxV).map((c) => c.p)));
  const over = pick({ w: 1, on: 12 });
  assert.equal(over.regime, "overstock");
  const lb = 1.5; // the p25 of the orders behind exact-here
  const okO = over.cands.filter((c) => c.evid && c.p >= lb - 1e-9);
  const maxPH = Math.max(...okO.map((c) => c.pH));
  assert.equal(over.raw, Math.max(...okO.filter((c) => c.pH === maxPH).map((c) => c.p)));
  assert.ok(over.raw < bal.raw, "overstock sells faster than balanced here");
  const sc = pick({ w: 4, on: 1 });
  assert.equal(sc.regime, "scarce");
  const okS = sc.cands.filter((c) => c.evid && c.pH >= CFG().minP7Scarce);
  assert.equal(sc.raw, Math.max(...okS.map((c) => c.p)));
});

test("price: the venue median never raises a price", () => {
  const venue = [];
  for (let i = 0; i < 12; i++) venue.push(S({ g: "beta", ck: "s:v" + i, bk: "beta|1", p: 3 }));
  const ev = E.buildEvidence(bundle({ sales: venue, demand: [DR({ g: "gamma", k: "gamma" })] }), { cfg: CFG(), cut: NOW });
  const v = { k: "gamma", f: "claim", m: "gameflip", ck: null, bk: "gamma|1", conf: "medium", basis: "venue", cands: [], ref: 3 };
  const c = P.gateChain({ ev, hz: {} }, v, { raw: 3, base: 1, floor: 0.75 });
  assert.equal(c.p, 1);
  assert.ok(c.gates.includes("raise-rule"));
});

test("price: GGSel is raise-only, and the floor (with the row's own minimum) is applied last", () => {
  const ev = E.buildEvidence(bundle(), { cfg: CFG(), cut: NOW });
  const v = { k: G, f: "claim", m: "ggsel", ck: CK, bk: BK, conf: "high", basis: "exact-here", cands: [], ref: 1 };
  const c = P.gateChain({ ev, hz: {} }, v, { raw: 0.6, base: 1.2, floor: 0.75 });
  assert.equal(c.p, 1.2);
  assert.deepEqual(c.gates, ["step", "ggsel-raise-only"], "in the plan's order");
  const c1 = P.gateChain({ ev, hz: {} }, v, { raw: 1.0, base: 1.2, floor: 0.75 });
  assert.deepEqual([c1.p, c1.gates], [1.2, ["ggsel-raise-only"]]);
  const v2 = Object.assign({}, v, { m: "gameflip" });
  const c2 = P.gateChain({ ev, hz: {} }, v2, { raw: 0.6, base: 0.9, floor: 0.95 });
  assert.equal(c2.p, 0.95);
  assert.equal(c2.gates[c2.gates.length - 1], "floor");
  // step limit down: 35 % below 2.00 is 1.30
  const c3 = P.gateChain({ ev, hz: {} }, v2, { raw: 0.8, base: 2, floor: 0.75 });
  assert.equal(c3.p, 1.3);
  assert.ok(c3.gates.includes("step"));
});

test("price: below medium confidence the price is logged but every action is hold", () => {
  // our offer: three orders of its band here (band-here, low); the curve comes from another band
  const sales = Array.from({ length: 3 }, () => S({ ck: "s:other", p: 1 }));
  const c = curve({ ck: "s:other2", bk: G + "|2-3", soldP: 1 });
  const row = L({ p: 3, c: NOW - 2 * DAY });
  const b = bundle({ listings: c.listings.concat([row]), sales: c.sales.concat(sales), demand: [DR()] });
  const ctx = ctxOf(b);
  const R = ctx.ev.byId.get(row.id);
  const v = P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: [R] });
  assert.equal(CONF_OK(v.conf), false, v.conf);
  if (v.p !== null) assert.ok(v.p > 0, "the price is still logged");
  assert.equal(v.live[0].a, "hold");
  assert.ok(v.gates.includes("confidence"));
});
const CONF_OK = (c) => U.CONF_RANK[c] >= U.CONF_RANK.medium;

test("live action: a stale row comes down one rung (rule 5's missing half); on GGSel it holds", () => {
  // fast sales at ref → expected days to sale ≈ 1; a row asking ref, listed 20 days, is stale
  const { v } = verdictFor({ curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY } });
  assert.equal(v.live[0].stale, true);
  assert.equal(v.live[0].a, "lower");
  assert.ok(v.live[0].p < 1.5);
  assert.ok(v.gates.includes("stale"));
  const g = verdictFor({ m: "ggsel", curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY, qty: 2 } });
  assert.equal(g.v.live[0].stale, true);
  assert.equal(g.v.live[0].a, "hold");
  assert.ok(g.v.live[0].gates.includes("ggsel-raise-only"));
});

test("live action: cool-down holds a different move advised within cooldownH; the same move repeats", () => {
  const opts = { curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY } };
  const first = verdictFor(opts);
  assert.equal(first.v.live[0].a, "lower");
  const id = first.row.id;
  seq -= 0; // ids differ per call: rebuild with a prior keyed on the new row
  const again = (prior) => {
    const out = verdictFor(Object.assign({}, opts, { prior: new Map() }));
    out.ctx.prior = prior(out.row.id);
    return P.finishOffer(out.ctx, P.priceOffer(out.ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: [out.R], defer: true }));
  };
  const flipped = again((rid) => new Map([[rid, { a: "raise", at: NOW - 10 * HOUR }]]));
  assert.equal(flipped.live[0].a, "hold");
  assert.ok(flipped.live[0].gates.includes("cool-down"));
  const same = again((rid) => new Map([[rid, { a: "lower", at: NOW - 10 * HOUR }]]));
  assert.equal(same.live[0].a, "lower");
  const past = again((rid) => new Map([[rid, { a: "raise", at: NOW - 100 * HOUR }]]));
  assert.equal(past.live[0].a, "lower");
  assert.ok(id);
});

test("live action: a deliberate ladder is reported, never corrected", () => {
  const { v } = verdictFor({ curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY }, extraListings: [L({ p: 4, o: "manual", c: NOW - 3 * DAY })] });
  assert.equal(v.ladder, true);
  assert.equal(v.live[0].a, "ladder");
});

/* ------------------------------ review batch 2 ------------------------------ */

test("C4 two system-made no-claim rows of one offer at two prices are drift to advise, not a ladder", () => {
  const ladders = (listings) => E.buildEvidence(bundle({ listings }), { cfg: CFG(), cut: NOW }).ladders;
  const nc = (o) => L(Object.assign({ f: "noclaim", o: "unclaimed" }, o));
  assert.equal(ladders([nc({ p: 1 }), nc({ p: 2 })]).size, 0, "unclaimed rows are system-made");
  assert.ok(ladders([nc({ p: 1 }), nc({ p: 2, o: "manual" })]).has("gameflip|" + CK), "a hand-made rung makes it a ladder");
  // a claim-at-sale row is an owner's rung, whatever its origin (the G2G operator-script rows are "auto")
  assert.ok(ladders([L({ m: "g2g", p: 1 }), L({ m: "g2g", kind: "cas", o: "auto", script: true, p: 2 })]).has("g2g|" + CK));
});

test("S2 guard 1: a switched-off GGSel's sales never reach the translator", () => {
  const sales = [];
  for (const m of ["gameflip", "ggsel"]) for (let i = 0; i < 12; i++) sales.push(S({ m, g: "beta", ck: "s:b" + i, bk: "beta|1", p: m === "ggsel" ? 3 : 1 }));
  const off = E.buildEvidence(bundle({ sales, af: { takes: Object.assign({}, TAKES, { ggsel: false }) } }), { cfg: CFG(), cut: NOW });
  assert.equal(off.markets.ggsel.blocked, true);
  assert.equal(off.tr.translate(1, "ggsel", "gameflip").price, 0, "no level for GGSel: nothing to translate from");
  const on = E.buildEvidence(bundle({ sales }), { cfg: CFG(), cut: NOW });
  assert.ok(on.tr.translate(1, "ggsel", "gameflip").price > 0, "with the switch on its level exists");
});

test("S2 guard 2: refFor never translates FROM a blocked market, whatever the translator would say", () => {
  const sales = [1, 1, 1].map((p) => S({ m: "ggsel", p: 3 + p }));
  const ev = E.buildEvidence(bundle({ sales, af: { takes: Object.assign({}, TAKES, { ggsel: false }) } }), { cfg: CFG(), cut: NOW });
  ev.ratio = () => ({ ratio: 1, basis: "a translator that does not refuse", n: 3 });
  const r = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.notEqual(r.basis, "translated");
});

test("M4a a blocked market's sales are never 'sold elsewhere' for the stock-out door of the raise rule", () => {
  // two Gameflip rows sold out fast a month ago: the shelf stood empty most of 30 days
  const rows = [L({ c: NOW - 29 * DAY, st: "sold" }), L({ c: NOW - 27 * DAY, st: "sold" })];
  const own = rows.map((r) => S({ lid: r.id, t: r.c + DAY }));
  const at = (m) => {
    const ev = E.buildEvidence(bundle({ listings: rows, sales: own.concat([1, 2, 3].map((i) => S({ m, ck: "s:o" + i, t: NOW - i * DAY }))) }), { cfg: CFG(), cut: NOW });
    return P.stockoutsOf(ev, G, "claim", "gameflip");
  };
  assert.equal(at("digiseller").ok, false, "Digiseller is history only");
  assert.equal(at("digiseller").elsewhere, 0);
  assert.equal(at("ggsel").ok, true, "a real market's sales do open the door");
});

test("M4b a blocked market's sales never set a game's demand tier", () => {
  const sales = Array.from({ length: 10 }, (_, i) => S({ m: "digiseller", t: NOW - (i + 1) * DAY }));
  const ev = E.buildEvidence(bundle({ sales }), { cfg: CFG(), cut: NOW });
  assert.equal(H.defaultTierFor(ev, "claim")(G), 0);
  const ev2 = E.buildEvidence(bundle({ sales: sales.map((x) => Object.assign({}, x, { m: "ggsel" })) }), { cfg: CFG(), cut: NOW });
  assert.equal(H.defaultTierFor(ev2, "claim")(G), 1, "the same sales on GGSel do");
});

test("H3 on Gameflip an offer is exposed at its LOWEST live ask; a dear row's wait behind a cheaper one is not its price", () => {
  // the offer's cheap row (x 1.0) and dear row (x 2.0) are both up for 10 days; the cheap one sells; then the
  // dear one stands alone for 10 days
  const cheap = L({ p: 1, c: NOW - 20 * DAY, st: "sold" });
  const dear = L({ p: 2, c: NOW - 20 * DAY });
  const anchors = [1, 1, 1].map((p) => S({ p, t: NOW - 150 * DAY }));
  const b = bundle({ listings: [cheap, dear], sales: anchors.concat([S({ lid: cheap.id, p: 1, t: NOW - 10 * DAY })]), demand: [DR()] });
  const ev = E.buildEvidence(b, { cfg: CFG({ shrinkK: 0, minSales: 1 }), cut: NOW });
  const mk = H.fitHazard(ev, "claim").markets.gameflip;
  assert.equal(mk.buckets[1].S, 1);
  near(mk.buckets[1].D, 10, "the 10 days the cheap row was the offer's price");
  near(mk.buckets[4].D, 10, "only the 10 days the dear row stood alone — not its 20 days");
  // a row's own chance follows its rank behind the offer's cheaper rows
  assert.equal(H.rankOf(2, [1, 2]), 2);
  assert.equal(H.rankOf(1, [1, 2]), 1);
  assert.equal(H.rankOf(1, [1, 1]), 1, "two at one price share the first buyer");
  assert.equal(H.rankOf(1, [1, 1, 1]), 2);
});

test("H3 a row ranked k-th on Gameflip needs k buyers: its sell chance is P(Poisson(h(x_min)·H) ≥ k)", () => {
  const c = curve({ soldP: 1.5, sellDays: 2, nLive: 0 });
  const r1 = L({ p: 1.5, c: NOW - 2 * DAY });
  const r2 = L({ p: 2.0, c: NOW - 2 * DAY });
  const run = M.buildRun(bundle({ listings: c.listings.concat([r1, r2]), sales: c.sales, demand: [DR()] }));
  const f1 = run.fc.find((f) => f.l === r1.id);
  const f2 = run.fc.find((f) => f.l === r2.id);
  const hz = run.ctx.hz.claim;
  const o = run.offers.find((x) => x.m === "gameflip" && x.live.length === 2);
  const h = H.hazardAt(hz, "gameflip", o.tier, 1.5 / o.ref);
  near(f1.p, U.round3(1 - Math.exp(-h * f1.h)), "the cheapest row: one buyer");
  near(f2.p, U.round3(U.poissonTail(h * f2.h, 2)), "the dearer row: the second buyer");
  assert.ok(f2.p < f1.p);
});

test("H4 no price above the highest evidenced node is ever picked", () => {
  // one-row offers asking 0.9-1.1 × the band's reference: the curve says nothing about dearer prices
  const listings = [];
  const sales = [];
  for (let i = 0; i < 30; i++) {
    const x = 0.9 + (0.2 * i) / 29;
    const r = L({ ck: "s:o" + i, p: U.snap05(2 * x), c: NOW - (60 - i) * DAY, st: "sold" });
    listings.push(r);
    sales.push(S({ lid: r.id, ck: r.ck, p: r.p, t: r.c + 3 * DAY }));
  }
  const refs = [2, 2, 2, 2, 2].map((p) => S({ ck: "s:ref", p, t: NOW - 150 * DAY }));
  const ctx = ctxOf(bundle({ listings, sales: sales.concat(refs), demand: [DR({ w: 4, on: 2 })] }));
  const v = P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: "s:new", bk: BK, ex: true, n: 1, band: "1", live: null, base: 2 });
  const top = H.maxEvidencedX(ctx.hz.claim, "gameflip");
  assert.ok(top !== null && top < 1.2, String(top));
  assert.ok(v.raw / v.ref <= top + 1e-9, v.raw + " / " + v.ref + " over " + top);
  assert.ok(v.cands.every((c) => !c.evid || c.x <= top + 1e-9));
});

test("H9 an unsold Eldorado offer is dead 21 days after creation, and a row's chance runs only over its remaining life", () => {
  const old = L({ m: "eldorado", c: NOW - 25 * DAY, qty: 2 });
  const ev = E.buildEvidence(bundle({ listings: [old] }), { cfg: CFG(), cut: NOW });
  assert.equal(ev.byId.get(old.id).activeAtCut, false, "past its 21 days with no sale");
  // a Gameflip row 29.5 days old has half a day before it expires
  const c = curve({ soldP: 1.5, sellDays: 2, nLive: 0 });
  const r = L({ p: 1.5, c: NOW - 29.5 * DAY });
  const run = M.buildRun(bundle({ listings: c.listings.concat([r]), sales: c.sales, demand: [DR()] }));
  const f = run.fc.find((x) => x.l === r.id);
  near(f.h, 0.5, "judged over the half day it has left");
  assert.equal(E.daysLeftOf({ m: "ggsel", c: NOW - 99 * DAY }, NOW), Infinity);
});

test("H12 on quantity and order-unit markets the curve counts ORDERS: one 3-unit order is one sale", () => {
  const r = L({ m: "eldorado", c: NOW - 10 * DAY, qty: 5 });
  const order = [0, 1, 2].map(() => S({ lid: r.id, m: "eldorado", grp: "one-order", t: NOW - 5 * DAY }));
  const ev = E.buildEvidence(bundle({ listings: [r], sales: order }), { cfg: CFG(), cut: NOW });
  assert.equal(ev.byId.get(r.id).expo.units, 1);
});

test("H14 a row rebundled AFTER the cut is no offer evidence and no advice at that cut (today's contents leak)", () => {
  const r = L({ c: NOW - 30 * DAY, rb: NOW - 5 * DAY });
  const ev = E.buildEvidence(bundle({ listings: [r] }), { cfg: CFG(), cut: NOW - 10 * DAY });
  const R = ev.byId.get(r.id);
  assert.equal(R.offerEv, false);
  assert.equal(R.advisable, false);
  assert.equal(H.fitRow(ev, R, "claim"), false);
  const now = E.buildEvidence(bundle({ listings: [r] }), { cfg: CFG(), cut: NOW }).byId.get(r.id);
  assert.equal(now.offerEv, true, "at now the rebundle is history");
});

test("H17 a unit added before its row existed is no exposure of the row", () => {
  const r = L({ m: "ggsel", c: NOW - 5 * DAY, qty: 2, units: [{ a: NOW - 20 * DAY, d: null }, { a: NOW - 4 * DAY, d: null }] });
  const ev = E.buildEvidence(bundle({ listings: [r] }), { cfg: CFG(), cut: NOW });
  near(ev.byId.get(r.id).expo.days, 5);
});

test("H18 a zero-hazard node is floored, so the curve between it and its neighbour never collapses", () => {
  // shrinkK 0: an evidenced bucket that never sold has hazard 0
  const listings = [];
  const sales = [];
  for (let i = 0; i < 6; i++) {
    const r = L({ ck: "s:f" + i, p: 1, c: NOW - (40 + i) * DAY, st: "sold" });
    listings.push(r);
    sales.push(S({ lid: r.id, ck: r.ck, p: 1, t: r.c + DAY }));
  }
  for (let i = 0; i < 4; i++) listings.push(L({ ck: "s:s" + i, p: 2, c: NOW - 25 * DAY }));
  const refs = [1, 1, 1].map((p) => S({ ck: "s:r", p, t: NOW - 150 * DAY }));
  const ctx = ctxOf(bundle({ listings, sales: sales.concat(refs) }), CFG({ shrinkK: 0, minBucketDays: 20 }));
  const mk = ctx.hz.claim.markets.gameflip;
  assert.equal(mk.buckets[4].h, 0);
  const mid = H.hazardAt(ctx.hz.claim, "gameflip", null, 1.5);
  assert.ok(mid >= Math.sqrt(1 * H.NODE_FLOOR_SHARE * mk.h) * 0.5, String(mid));
});

test("M1 a stale row's rung never goes further than one step from its ask", () => {
  // quick sales at the reference make a 20-day-old row stale; with a 5 % step limit the next rung (−10 %) is
  // out of reach this move: hold, never a jump
  const opts = { curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY } };
  const wide = verdictFor(opts);
  assert.equal(wide.v.live[0].a, "lower");
  assert.ok(wide.v.live[0].p >= U.ceil05(1.5 * 0.65) - 1e-9);
  const narrow = verdictFor(Object.assign({}, opts, { cfg: CFG({ maxStepPct: 5 }) }));
  assert.equal(narrow.v.live[0].stale, true);
  assert.notEqual(narrow.v.live[0].a, "lower", "no rung inside 5 % of $1.50");
  assert.ok(narrow.v.live[0].why.some((w) => /no lower rung inside the step limit/.test(w)));
});

test("M1 a stale no-claim row never comes down under its 30-day sold floor", () => {
  const nc = (o) => L(Object.assign({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1" }, o));
  const listings = [];
  const sales = [];
  for (let i = 0; i < 6; i++) {
    const r = nc({ p: 2, st: "sold", c: NOW - (5 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 2, t: r.c + 0.2 * DAY }));
  }
  const live = nc({ p: 2, c: NOW - 3 * DAY });
  const run = M.buildRun(bundle({ listings: listings.concat([live]), sales, demand: [DR({ k: "beta", f: "noclaim", w: 5, on: 4 })] }));
  const lr = run.offers.find((o) => o.f === "noclaim" && o.live.length).live[0];
  assert.equal(P.soldFloorOf(run.ctx.ev, "s:b1"), 2);
  assert.ok(!(lr.a === "lower" && lr.p < 2), lr.a + " " + lr.p);
});

test("M1 a test unit is never priced at or under the price the gates already give", () => {
  // a live no-claim row at $1.00 whose sold floor ($1.60) lifts it a step to $1.35: a test at the raise rule's
  // $1.15 would sit under that — the row is raised, not tested
  const nc = (g, o) => L(Object.assign({ g, gl: g, f: "noclaim", o: "unclaimed", bk: g + "|1", n: 1 }, o));
  const listings = [];
  const sales = [];
  const sold = (g, ck, p, d) => {
    const r = nc(g, { ck, p, st: "sold", c: NOW - d * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, g, f: "noclaim", o: "unclaimed", ck, bk: g + "|1", p, t: r.c + 0.3 * DAY }));
  };
  for (const [p, d] of [[1, 3], [1, 4], [1, 5], [1.6, 6]]) sold("beta", "s:b1", p, d);
  for (const [p, d] of [[1, 3], [1, 4], [1, 5], [1.15, 6], [1.15, 7], [1.15, 8]]) sold("gamma", "s:g1", p, d);
  const live = nc("beta", { ck: "s:b1", p: 1, c: NOW - 0.5 * DAY });
  const run = M.buildRun(bundle({ listings: listings.concat([live]), sales, demand: [DR({ k: "beta", f: "noclaim", w: 5, on: 8 }), DR({ k: "gamma", f: "noclaim", w: 5, on: 8 })] }));
  const off = run.offers.find((o) => o.k === "beta" && o.live.length);
  const lr = off.live[0];
  assert.notEqual(lr.a, "test");
  if (lr.p !== null) assert.ok(lr.p >= off.p - 1e-9, "never under the gated price " + off.p);
  assert.ok(off.test === null || off.test > off.p);
});

test("H2 a steadily selling quantity offer is not stale: its age runs from its last sale", () => {
  const r = L({ m: "eldorado", p: 2, c: NOW - 60 * DAY, u: NOW - DAY, qty: 4 });
  const sales = Array.from({ length: 12 }, (_, i) => S({ lid: r.id, m: "eldorado", p: 2, t: NOW - 59 * DAY + i * 5 * DAY }));
  const run = M.buildRun(bundle({ listings: [r], sales, demand: [DR({ w: 1.4, on: 10 })] }));
  const lr = run.offers.find((o) => o.m === "eldorado").live[0];
  assert.equal(lr.stale, false);
  assert.notEqual(lr.a, "lower");
});

test("H2 the stale rule never overrides the curve: an old row the curve would raise is raised, not lowered", () => {
  // fast sales at $1.50 (x = 1); an old live row asks $1.00 — far under what buyers pay
  const { v } = verdictFor({ curveOpts: { soldP: 1.5, sellDays: 2, nLive: 0 }, live: { p: 1.0, c: NOW - 20 * DAY } });
  const lr = v.live[0];
  assert.equal(lr.stale, false);
  assert.equal(lr.a, "raise", lr.why.join(" / "));
  assert.equal(lr.p, U.floor05(1.0 * 1.35));
});

test("M2 every other policy's price is logged through the same gates: a rival's price never raises, never falls under the floor", () => {
  const sales = [];
  for (let i = 0; i < 12; i++) sales.push(S({ g: "beta", ck: "s:f" + i, bk: "beta|1", m: "gameflip", p: 1.5 }), S({ g: "beta", ck: "s:g" + i, bk: "beta|1", m: "ggsel", p: 1.5 }));
  const feed = (p) => Array.from({ length: 4 }, (_, i) => ({ g: G, m: "gameflip", p, u: 1, n: 1, t: NOW - (1 + i) * DAY }));
  const listings = [L({ m: "gameflip", p: 2 }), L({ m: "ggsel", p: 2, qty: 3 })];
  const cells = (p) => M.buildRun(bundle({ listings, sales, radar: { at: NOW, games: [], feed: feed(p) }, demand: [DR()] })).rows.filter((r) => r.k === G && (r.m === "gameflip" || r.m === "ggsel"));
  for (const r of cells(0.3)) {
    assert.ok(r.pol.clear >= 0.75, "never under the floor: " + r.pol.clear);
    assert.ok(r.pol.clear >= U.ceil05(2 * 0.65) - 1e-9, "never further than one step");
    if (r.m === "ggsel") assert.equal(r.pol.clear, 2, "GGSel never comes down");
  }
  for (const r of cells(9)) assert.ok(r.pol.clear <= 2, "a rival's $9 never raises: " + r.pol.clear);
  // priceFor under the clear policy answers today's price (low confidence), never the rival's
  const run = M.buildRun(bundle({ af: { listingBrain: { policyPrice: "clear" } }, listings, sales, radar: { at: NOW, games: [], feed: feed(9) }, demand: [DR()] }));
  assert.equal(M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (1 Items)" }).price, 1);
});

test("M10a a farm-brain row missing its stock or its forecast is unknown, never zero", () => {
  for (const d of [{ on: null }, { on: undefined }, { on: "n/a" }, { w: null }]) {
    const gs = regimeOf(Object.assign({ w: 4, on: 12 }, d));
    assert.equal(gs.regime, "unknown", JSON.stringify(d));
    assert.equal(gs.unknown, true);
  }
  // a backtest's synthesised row has no stock by design: known, cover unknown (H7)
  const synth = regimeOf({ w: 4, on: null, synth: true });
  assert.notEqual(synth.regime, "unknown");
  assert.equal(synth.cover, null);
});

test("M11 a cell's brain price counts every live row, at its own ask where the brain leaves it", () => {
  const listings = [];
  const sales = [];
  for (let i = 0; i < 3; i++) {
    const r = L({ m: "ggsel", ck: "s:y", p: 1, st: "delisted", c: NOW - (6 + i) * DAY, u: NOW - (5 + i) * DAY, qty: 0 });
    listings.push(r);
    sales.push(S({ lid: r.id, m: "ggsel", ck: "s:y", p: 1, t: r.c + 0.5 * DAY }));
  }
  listings.push(L({ m: "ggsel", ck: "s:y", p: 1, c: NOW - 2 * DAY, qty: 3 }));
  for (let i = 0; i < 3; i++) sales.push(S({ m: "ggsel", ck: "s:x", bk: G + "|4-6", n: 5, p: 0.5, t: NOW - (6 + i) * DAY }));
  listings.push(L({ m: "ggsel", ck: "s:x", bk: G + "|4-6", n: 5, p: 5, c: NOW - 2 * DAY, qty: 3 }), L({ m: "ggsel", ck: "s:x", bk: G + "|4-6", n: 5, p: 5, c: NOW - 3 * DAY, qty: 3 }));
  const run = M.buildRun(bundle({ listings, sales, demand: [DR()] }));
  const row = run.rows.find((r) => r.m === "ggsel");
  assert.equal(row.br.a.lower, 0);
  assert.notEqual(row.pc, "brain-lower", "no row is advised lower: " + row.br.p + " vs " + row.old.a);
});

test("M13a a deliberate ladder gets no brain price at all: a number beside it only invites a correction", () => {
  const { v } = verdictFor({ curveOpts: { soldP: 1.5, sellDays: 0.5, nLive: 0 }, live: { p: 1.5, c: NOW - 20 * DAY }, extraListings: [L({ p: 4, o: "manual", c: NOW - 3 * DAY })] });
  assert.equal(v.ladder, true);
  assert.equal(v.p, null);
  assert.equal(v.raw, null);
  assert.ok(v.why.some((w) => /deliberate test/.test(w)));
  const run = M.buildRun(bundle({ listings: curve({ soldP: 1.5, nLive: 0 }).listings.concat([L({ p: 1.5 }), L({ p: 4, o: "manual" })]), sales: curve({ soldP: 1.5, nLive: 0 }).sales, demand: [DR()] }));
  const cell = run.rows.find((r) => r.m === "gameflip");
  assert.equal(cell.pc, "ladder");
  assert.equal(cell.br.p, null);
});

/* --------------------------------- the run ---------------------------------- */

/** A small two-farm world: a measured claim game, a no-claim game, owner rows, a blocked market. */
function world(over = {}) {
  const c = curve({ soldP: 1.5, sellDays: 1, nLive: 3, liveP: 1.5, liveAge: 3 });
  const gg = curve({ m: "ggsel", soldP: 1.4, sellDays: 2, nLive: 1, liveP: 1.4, liveAge: 3 });
  const listings = c.listings.concat(gg.listings, [
    // owner rows: hand-made, claim-at-sale (with a big quantity), a pack, a blocked-market row
    L({ o: "manual", m: "eldorado", ck: "s:hand", p: 2 }),
    L({ kind: "cas", o: "manual", m: "g2g", ck: "s:cas", qty: 50, p: 2 }),
    L({ kind: "cas", o: "auto", script: true, m: "g2g", ck: "s:script", p: 2 }),
    L({ kind: "bulk", pack: 5, m: "eldorado", p: 6 }),
    L({ m: "digiseller", p: 1.3 }),
    // the no-claim game
    L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", n: 1, p: 1.25 }),
    L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b3", bk: "beta|2-3", n: 3, p: 1.0 }),
  ]);
  const sales = c.sales.concat(gg.sales, [S({ m: "digiseller", p: 1.3 })]);
  const b = bundle(
    Object.assign(
      {
        listings,
        sales,
        demand: [DR({ w: 4, on: 14 }), DR({ k: "beta", f: "noclaim", w: 5, on: 6 })],
        old: {
          games: { [G]: { base: 1.25, ggsel: 1.1, post: 1.75, split: { listNow: 7, holdBack: 7 }, flat: { gameflip: 4, ggsel: 3 }, order: ["gameflip", "ggsel"] } },
          offers: { ["gameflip|" + CK]: { np: 1.25, tracker: { price: 1.35, basis: "x", confidence: "medium" } }, ["gameflip|s:b1"]: { np: 1.25 }, ["gameflip|s:b3"]: { np: 1.75 } },
        },
      },
      over,
    ),
  );
  return b;
}

test("never advised: hand-made, claim-at-sale (any origin), bulk, blocked-market rows get no forecast and no move", () => {
  const b = world();
  const run = M.buildRun(b);
  const ev = run.ctx.ev;
  const advisedIds = new Set(run.fc.map((f) => f.l));
  for (const R of ev.rows) {
    if (R.hand || R.cas || R.rk === "bulk" || R.blocked) assert.ok(!advisedIds.has(R.id), R.rk + " " + R.m);
  }
  for (const o of run.offers) for (const l of o.live) assert.ok(ev.byId.get(l.id).advisable, "only system-made rows are live entries");
  const dig = run.rows.find((r) => r.k === G && r.f === "claim" && r.m === "digiseller");
  assert.equal(dig.pc, "managed");
  assert.equal(dig.sc, "closed");
  assert.ok(dig.fl.includes("blocked"));
  assert.equal(dig.br.p, null, "a blocked market gets no price");
});

test("claim-at-sale quantities are never summed as stock; script rows are counted apart", () => {
  const run = M.buildRun(world());
  const g2g = run.rows.find((r) => r.k === G && r.f === "claim" && r.m === "g2g");
  assert.equal(g2g.old.n, 0);
  assert.equal(g2g.old.cur, 0);
  assert.equal(g2g.ev.scr, 1);
  assert.ok(g2g.fl.includes("script"));
  const all = run.rows.find((r) => r.k === G && r.f === "claim" && r.m === "all");
  // only system-made live rows are stock on a shelf: the 50-unit claim-at-sale row adds nothing
  const ev = run.ctx.ev;
  const expect = ev.rows.filter((r) => r.k !== null && r.g === G && r.f === "claim" && r.system && r.activeAtCut).reduce((a, r) => a + E.shelfUnits(r), 0);
  assert.equal(all.old.cur, expect);
  assert.ok(expect < 50);
});

test("a blocked market never teaches another: Digiseller orders never move Gameflip's reference", () => {
  const b = bundle({ sales: [S({ m: "digiseller", p: 9 }), S({ m: "digiseller", p: 9 }), S({ m: "digiseller", p: 9 })], demand: [DR()] });
  const run = M.buildRun(b);
  const r = RF.refFor(run.ctx.ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(r.ref, null);
  const d = RF.refFor(run.ctx.ev, { g: G, m: "digiseller", ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(d.basis, "exact-here", "its own history still describes itself");
});

/** A no-claim unit of the ledger (plan §2.1 U). */
function NU(o = {}) {
  return Object.assign({ g: "beta", m: "gameflip", st: "listed", l: NOW - 2 * DAY, s: null, p: 0, sm: null, x: null, lids: [], bk: "", camps: [] }, o);
}

test("no-claim bundle order: within one event a bundle is lifted to any bundle it contains (bundleKey, U.lids)", () => {
  const nc = (o) => L(Object.assign({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", bk: "beta|1", n: 1, c: NOW - 2 * DAY }, o));
  const a = nc({ ck: "s:a1", n: 1, p: 1.25 });
  const b = nc({ ck: "s:b3", n: 3, bk: "beta|2-3", p: 1.0 });
  const c = nc({ ck: "s:c4", n: 4, bk: "beta|4-6", p: 0.9 });
  const d = nc({ ck: "s:d5", n: 5, bk: "beta|4-6", p: 0.8 });
  const units = [
    NU({ lids: [a.id], bk: "beta|spring cup|week 1" }),
    NU({ lids: [b.id], bk: "beta|spring cup|week 1+week 2" }),
    // a bigger bundle of ANOTHER event: no relation to the others
    NU({ lids: [c.id], bk: "beta|autumn cup|week 1+week 2+week 3" }),
    // d has no unit, so no bundle key
  ];
  // the contained offer is one the brain is confident about: three orders of it here (M3)
  const aOrders = [1.25, 1.25, 1.25].map((p) => S({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:a1", bk: "beta|1", p, t: NOW - 20 * DAY }));
  const ctx = ctxOf(bundle({ listings: [a, b, c, d], sales: aOrders, noclaim: { units, waves: [] }, demand: [DR({ k: "beta", f: "noclaim", w: 5, on: 4 })] }));
  const v = (row) => P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "gameflip", ck: row.ck, bk: row.bk, ex: true, n: row.n, band: "1", live: [ctx.ev.byId.get(row.id)], defer: true });
  const [va, vb, vc, vd] = [a, b, c, d].map(v);
  assert.ok(va.thin && vb.thin, "thin: each starts from today's price");
  assert.equal(va.conf, "high");
  P.applyContainment(ctx, [vd, vc, vb, va]);
  assert.equal(va.p, 1.25);
  assert.equal(vb.p, 1.25, "week 1 + week 2 contains week 1: never under it");
  assert.ok(vb.gates.includes("containment"));
  assert.equal(vc.p, 0.9, "another event: never compared, though it holds more items");
  assert.ok(!vc.gates.includes("containment"));
  assert.equal(vd.p, 0.8);
  assert.ok(vd.why.some((w) => /No bundle key/.test(w)));
  assert.equal(vb.bundle, "beta|spring cup|week 1+week 2");
  // containment points one way: equal waves count only when the bigger bundle holds more items
  const k = (x) => P.parseBundleKey(x);
  assert.equal(P.bundleContains(k("g|ev|w1+w2"), 3, k("g|ev|W1"), 1), true);
  assert.equal(P.bundleContains(k("g|ev|w1"), 1, k("g|ev|w1+w2"), 3), false);
  assert.equal(P.bundleContains(k("g|ev|w1"), 3, k("g|ev|w1"), 2), true);
  assert.equal(P.bundleContains(k("g|ev|w1"), 2, k("g|ev|w1"), 2), false);
  assert.equal(P.bundleContains(k("g|ev|w1+w2"), 3, k("g|other|w1"), 1), false);
  assert.equal(P.parseBundleKey(""), null);
});

/** Two no-claim Gameflip offers of one event, b (weeks 1+2) containing a (week 1); a's orders and b's ask given. */
function containWorld({ aOrders = 3, aP = 1.25, bP = 1.0, ceiling = 4.5 } = {}) {
  const a = L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:a1", bk: "beta|1", n: 1, p: aP, c: NOW - 2 * DAY });
  const b = L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b3", bk: "beta|2-3", n: 3, p: bP, c: NOW - 2 * DAY });
  const units = [NU({ lids: [a.id], bk: "beta|spring cup|week 1" }), NU({ lids: [b.id], bk: "beta|spring cup|week 1+week 2" })];
  const sales = Array.from({ length: aOrders }, () => S({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:a1", bk: "beta|1", p: aP, t: NOW - 20 * DAY }));
  const pricing = { floorUsd: 0.75, ceilingUsd: ceiling, gameFloors: {} };
  const ctx = ctxOf(bundle({ listings: [a, b], sales, pricing, noclaim: { units, waves: [] }, demand: [DR({ k: "beta", f: "noclaim", w: 5, on: 4 })] }));
  const v = (row) => P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "gameflip", ck: row.ck, bk: row.bk, ex: true, n: row.n, band: "1", live: [ctx.ev.byId.get(row.id)], defer: true });
  const va = v(a);
  const vb = v(b);
  P.applyContainment(ctx, [vb, va]);
  return { va, vb };
}

test("M3 the bundle order lifts only from an offer the brain is confident about", () => {
  const thin = containWorld({ aOrders: 0 });
  assert.equal(thin.va.conf, "none");
  assert.equal(thin.vb.p, 1.0, "a thin offer's starting price is today's bundlePrice, not evidence");
  assert.ok(!thin.vb.gates.includes("containment"));
  const sure = containWorld({ aOrders: 3 });
  assert.equal(sure.vb.p, 1.25);
});

test("M3 a containment lift is a raise: at most one step from the base and never over the no-claim ceiling", () => {
  // the contained offer sells at $3: the $1 bundle may go up only to $1.35 this move
  const step = containWorld({ aP: 3, bP: 1.0 });
  assert.equal(step.va.p, 3);
  assert.equal(step.vb.p, 1.35);
  assert.ok(step.vb.gates.includes("containment") && step.vb.gates.includes("containment-held"), step.vb.gates.join(","));
  assert.equal(step.vb.live[0].p === null || step.vb.live[0].p <= 1.35, true);
  // a contained offer above the ceiling lifts no further than the ceiling
  const cap = containWorld({ aP: 3, bP: 2.6, ceiling: 2.75 });
  assert.equal(cap.vb.p, 2.75);
  assert.ok(cap.vb.gates.includes("containment-held"));
});

test("no-claim: a bundle whose units disagree on their bundleKey (rebundled since) gets no bundle order", () => {
  const a = L({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:a1", bk: "beta|1", n: 1, p: 1.25 });
  const b = L({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b3", bk: "beta|2-3", n: 3, p: 1.0 });
  const units = [NU({ lids: [a.id], bk: "beta|ev|week 1" }), NU({ lids: [b.id], bk: "beta|ev|week 1+week 2" }), NU({ lids: [b.id], bk: "beta|ev|week 3" })];
  const ctx = ctxOf(bundle({ listings: [a, b], noclaim: { units, waves: [] }, demand: [DR({ k: "beta", f: "noclaim" })] }));
  const vb = P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "gameflip", ck: "s:b3", bk: "beta|2-3", ex: true, n: 3, band: "2-3", live: [ctx.ev.byId.get(b.id)], defer: true });
  const va = P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "gameflip", ck: "s:a1", bk: "beta|1", ex: true, n: 1, band: "1", live: [ctx.ev.byId.get(a.id)], defer: true });
  P.applyContainment(ctx, [vb, va]);
  assert.equal(vb.p, 1.0);
  assert.equal(vb.bundle, null);
});

test("no-claim: the 30-day Gameflip sold floor of the exact offer is never undercut", () => {
  const b2 = world({ sales: world().sales.concat([S({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b3", bk: "beta|2-3", n: 3, p: 2.4, t: NOW - 5 * DAY })]) });
  const ctx2 = ctxOf(b2);
  // a NEW listing of the offer takes the sold floor in full, as bundlePrice does
  const vNew = P.priceOffer(ctx2, { g: "beta", f: "noclaim", m: "gameflip", ck: "s:b3", bk: "beta|2-3", ex: true, n: 3, band: "2-3", live: null, base: 1.75, np: 1.75 });
  assert.ok(vNew.p >= 2.4, String(vNew.p));
  assert.ok(vNew.gates.includes("sold-floor"));
});

test("M13b a live row reaches its sold floor in steps, with no market evidence needed", () => {
  const b2 = world({ sales: world().sales.concat([S({ g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b3", bk: "beta|2-3", n: 3, p: 2.4, t: NOW - 5 * DAY })]) });
  const ctx2 = ctxOf(b2);
  const r3b = ctx2.ev.rows.find((r) => r.ck === "s:b3");
  assert.equal(r3b.ask, 1.0);
  const v3b = P.priceOffer(ctx2, { g: "beta", f: "noclaim", m: "gameflip", ck: "s:b3", bk: "beta|2-3", ex: true, n: 3, band: "2-3", live: [r3b] });
  assert.equal(v3b.p, 1.35, "one step (35 %) from the $1.00 ask toward the $2.40 sold floor");
  assert.ok(v3b.gates.includes("sold-floor-steps"));
  assert.ok(v3b.why.some((w) => /sold floor is \$2\.40: reached in steps/.test(w)));
});

test("no-claim perish: a unit listed past its estimated expiry is ignored, not read as 0 h; the median stands", () => {
  const waves = [
    { g: "beta", ev: "Old", wave: "Week 1", startAt: NOW - 40 * DAY, endAt: NOW - 30 * DAY },
    { g: "beta", ev: "New", wave: "Week 1", startAt: NOW - 5 * DAY, endAt: NOW + 5 * DAY },
  ];
  const units = [NU({ camps: ["Old Week 1"], l: NOW - 35 * DAY })].concat(Array.from({ length: 4 }, () => NU({ camps: ["New Week 1"] })));
  const b = bundle({ noclaim: { units, waves }, demand: [DR({ k: "beta", f: "noclaim", w: 4, on: 12 })] });
  const ev = E.buildEvidence(b, { cfg: CFG(), cut: NOW });
  const pe = P.perishOf(ev, "beta");
  assert.equal(pe.past, 1);
  assert.equal(pe.dated, 4);
  assert.ok(Math.abs(pe.days - 5) < 1e-9, "wave end in 5 days, no claim window learned: " + pe.days);
  assert.equal(pe.share, 0);
  const gs = P.gameState(ev, "beta", "noclaim");
  assert.notEqual(gs.regime, "overstock");
  assert.equal(gs.perishing, false);
  assert.ok(gs.regimeWhy.some((w) => /1 unit is still listed past its estimated expiry/.test(w)));
});

test("no-claim perish is read per stock: overstock (perishing) only when half the listed units expire within perishHours", () => {
  const waves = [
    { g: "beta", ev: "A", wave: "Week 1", startAt: NOW - 5 * DAY, endAt: NOW + 20 * HOUR },
    { g: "beta", ev: "B", wave: "Week 1", startAt: NOW - 5 * DAY, endAt: NOW + 6 * DAY },
  ];
  const mk = (soon, late) => Array.from({ length: soon }, () => NU({ camps: ["A Week 1"] })).concat(Array.from({ length: late }, () => NU({ camps: ["B Week 1"] })));
  const state = (units) => P.gameState(E.buildEvidence(bundle({ noclaim: { units, waves }, demand: [DR({ k: "beta", f: "noclaim", w: 4, on: 12 })] }), { cfg: CFG(), cut: NOW }), "beta", "noclaim");
  const few = state(mk(1, 3));
  assert.equal(few.perishShare, 0.25);
  assert.equal(few.perishing, false, "one soon-to-expire unit no longer decides for the stock");
  assert.equal(few.regime, "balanced");
  const most = state(mk(3, 1));
  assert.equal(most.perishShare, 0.75);
  assert.equal(most.perishing, true);
  assert.equal(most.regime, "overstock");
  assert.match(most.regimeWhy[0], /^Perishing: 75% of its listed stock expires within 48 h/);
});

test("no-claim: a thin bundle starts from today's bundlePrice answer, not from nothing", () => {
  const ctx = ctxOf(world());
  const v = P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "ggsel", ck: "s:new", bk: "beta|4-6", ex: true, n: 5, band: "4-6", live: null, base: 2.0 });
  assert.equal(v.thin, true);
  assert.equal(v.raw, 2.0);
  assert.equal(v.p, 2.0);
  assert.equal(v.action, "hold", "no evidence: logged, not acted on");
});

/* --------------------------------- placement -------------------------------- */

test("eligibility classes: closed (blocked, switch off, floor above ref), unmeasured, open, unknown, managed", () => {
  const sales = [S({ m: "playerauctions", p: 1.5 }), S({ m: "playerauctions", p: 1.5 }), S({ m: "playerauctions", p: 1.5 })];
  const b = bundle({ sales, af: { takes: { gameflip: true, digiseller: false, ggsel: true, zeusx: true, eldorado: false, playerauctions: true, g2g: true }, mapped: { [G]: { g2g: true } } }, demand: [DR()] });
  const ev = E.buildEvidence(b, { cfg: CFG(), cut: NOW });
  const refByM = {};
  for (const m of U.MARKETS) refByM[m] = RF.refFor(ev, { g: G, m, ck: CK, bk: BK, ex: true, n: 1 });
  const el = PL.eligibility(ev, G, "claim", refByM);
  assert.equal(el.digiseller.cls, "closed");
  assert.equal(el.eldorado.cls, "closed", "switch off");
  assert.equal(el.playerauctions.cls, "closed", "its $5 floor is above the $1.50 the offer sells for");
  assert.equal(el.zeusx.cls, "unmeasured");
  assert.equal(el.gameflip.cls, "open");
  assert.equal(el.g2g.cls, "open", "mapped offline");
  assert.equal(el.ggsel.cls, "unknown", "no category id, never listed there");
  const b2 = bundle({ listings: [L({ m: "ggsel" })] });
  assert.equal(PL.eligibility(E.buildEvidence(b2, { cfg: CFG(), cut: NOW }), G, "claim").ggsel.cls, "open", "a listing of ours proves the mapping");
  const nc = PL.eligibility(ev, G, "noclaim");
  assert.equal(nc.eldorado.cls, "managed");
  assert.equal(nc.g2g.cls, "managed");
  assert.equal(nc.zeusx.cls, "closed");
});

test("eligibility: a market with no evidence of its own is closed when its floor beats any translation of the offer's price", () => {
  // PlayerAuctions rows sit at the $5 floor and never sell; the offer fetches $1.50 on Gameflip
  const c = curve({ soldP: 1.5, nLive: 0 });
  const pa = L({ m: "playerauctions", p: 5, c: NOW - 20 * DAY });
  const ev = E.buildEvidence(bundle({ listings: c.listings.concat([pa]), sales: c.sales, demand: [DR()] }), { cfg: CFG(), cut: NOW });
  const refByM = {};
  for (const m of U.MARKETS) refByM[m] = RF.refFor(ev, { g: G, m, ck: CK, bk: BK, ex: true, n: 1 });
  assert.equal(refByM.playerauctions.ref, null, "no evidence of its own there");
  const el = PL.eligibility(ev, G, "claim", refByM);
  assert.equal(el.playerauctions.cls, "closed");
  assert.match(el.playerauctions.why, /at most 1\.5×/);
  assert.equal(el.gameflip.cls, "open");
});

test("placement: bulk is taken first, the greedy shelf follows Poisson marginal value, the rest is reserve", () => {
  const b = world({ demandOnly: Array.from({ length: 6 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 1) * 3 * DAY, src: "bulk" })) });
  const run = M.buildRun(b);
  const pl = run.ctx.placements.get(G + "|claim");
  assert.equal(pl.bulkTake, Math.round(((6 * 7) / 30) * 14 / 7));
  const placed = Object.values(pl.shelf).reduce((a, n) => a + n, 0);
  assert.equal(placed + pl.reserve + pl.bulkTake, pl.stock);
  // each placed unit was worth at least minMarginalUsd
  for (const v of Object.values(pl.marginal)) assert.ok(v >= run.ctx.cfg.minMarginalUsd);
  // greedy order: the market with the larger λ × net never holds fewer units than one with less
  const fill = PL.greedyFill({ markets: ["gameflip", "ggsel"], mu: { gameflip: 4, ggsel: 1 }, nets: { gameflip: 1, ggsel: 1 }, avail: 6, minMarginal: 0.1 });
  assert.ok(fill.shelf.gameflip > fill.shelf.ggsel);
  assert.equal(fill.shelf.gameflip + fill.shelf.ggsel + fill.left, 6);
  const stop = PL.greedyFill({ markets: ["gameflip"], mu: { gameflip: 0.5 }, nets: { gameflip: 1 }, avail: 10, minMarginal: 0.1 });
  assert.ok(stop.left > 0, "units worth under the floor stay in reserve");
  assert.ok(U.poissonTail(0.5, stop.shelf.gameflip + 1) * 1 < 0.1);
});

test("placement: at most one exploration unit, on an open market we never sold on, rivals first", () => {
  const b = world({
    af: { mapped: { [G]: { g2g: true } } },
    radar: { at: NOW, games: [{ key: G, perWeek: 3, rivalSellers: 4, byMarket: { gameflip: { perWeek: 3 } } }], feed: [] },
  });
  const run = M.buildRun(b);
  const pl = run.ctx.placements.get(G + "|claim");
  assert.ok(pl.reserve >= 0);
  const unproven = U.MARKETS.filter((m) => pl.elig[m] === "open" && !PL.provenOn(run.ctx.ev, G, "claim", m));
  const explored = unproven.filter((m) => pl.shelf[m] > 0);
  assert.ok(explored.length <= 1);
  if (pl.explore) {
    assert.equal(pl.shelf[pl.explore], 1);
    assert.ok(!["zeusx"].includes(pl.explore) && pl.elig[pl.explore] === "open");
  }
  // never on unmeasured or unknown
  for (const m of U.MARKETS) if (pl.elig[m] === "unmeasured" || pl.elig[m] === "unknown") assert.ok(!(pl.shelf[m] > 0));
  const off = M.buildRun(b, { cfg: CFG({ explore: false }) }).ctx.placements.get(G + "|claim");
  assert.equal(off.explore, null);
});

test("placement with no market proven by our sales: split by rivals' sales, else exploration only — never a guess", () => {
  // a game with a forecast, an offer priced on Gameflip (orders of another game set the venue level),
  // and no sale of its own anywhere
  const venue = Array.from({ length: 12 }, (_, i) => S({ g: "beta", ck: "s:v" + i, bk: "beta|1", p: 1.5 }));
  const row = L({ g: "gamma", gl: "Gamma", ck: "s:g1", bk: "gamma|1", c: NOW - 2 * DAY });
  const base = { listings: [row], sales: venue, demand: [DR({ k: "gamma", w: 6, on: 10 })], old: { games: { gamma: { base: 1.5, ggsel: 1.4, flat: { gameflip: 5 } } }, offers: {} } };
  const radar = { at: NOW, games: [{ key: "gamma", perWeek: 4, rivalSellers: 3, byMarket: { gameflip: { perWeek: 3 }, ggsel: { perWeek: 1 } } }], feed: [] };
  const withRadar = M.buildRun(bundle(Object.assign({}, base, { radar, af: { mapped: { gamma: { ggsel: true } } } }))).ctx.placements.get("gamma|claim");
  assert.ok(withRadar.flags.includes("radar-split"));
  assert.ok(Math.abs(withRadar.lambda.gameflip - 4.5) < 1e-6 && Math.abs(withRadar.lambda.ggsel - 1.5) < 1e-6);
  const blind = M.buildRun(bundle(base)).ctx.placements.get("gamma|claim");
  assert.ok(blind.flags.includes("unproven"));
  const placed = Object.values(blind.shelf).reduce((a, n) => a + n, 0);
  assert.ok(placed <= 1, "only the exploration unit");
});

test("no-claim: a thin live bundle starts from today's bundlePrice answer, not from its own ask", () => {
  const ctx = ctxOf(world());
  const r3 = ctx.ev.rows.find((r) => r.ck === "s:b3");
  const v = P.priceOffer(ctx, { g: "beta", f: "noclaim", m: "gameflip", ck: "s:b3", bk: "beta|2-3", ex: true, n: 3, band: "2-3", live: [r3], np: 1.75 });
  assert.equal(v.thin, true);
  assert.equal(v.raw, 1.75);
  assert.equal(v.live[0].a, "hold", "confidence none: logged, never acted on");
});

/** A no-claim game selling on Gameflip and through a claim-at-sale Eldorado offer, plus optional bulk. */
function poolWorld({ bulk = 0, w = 6, on = 20 } = {}) {
  const listings = [L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5, c: NOW - 3 * DAY })];
  const cas = L({ g: "beta", gl: "Beta", f: "noclaim", o: "manual", kind: "cas", m: "eldorado", ck: "s:b1", bk: "beta|1", p: 2, qty: 40, c: NOW - 20 * DAY });
  listings.push(cas);
  const sales = [];
  for (let i = 0; i < 4; i++) {
    const r = L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5, st: "sold", c: NOW - (10 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5, t: r.c + DAY }));
  }
  for (let i = 0; i < 6; i++) sales.push(S({ lid: cas.id, g: "beta", f: "noclaim", o: "manual", m: "eldorado", ck: "s:b1", bk: "beta|1", p: 2, t: NOW - (2 + i * 3) * DAY }));
  const demandOnly = Array.from({ length: bulk }, (_, i) => ({ g: "beta", m: "eldorado", f: "noclaim", t: NOW - (1 + i) * DAY, src: "bulk" }));
  return bundle({ listings, sales, demandOnly, demand: [DR({ k: "beta", f: "noclaim", w, on }), DR({ w: 4, on: 10 })], af: { mapped: {} } });
}

test("no-claim placement: shelves and the pool share one fill; the reserve IS the pool claim-at-sale and bulk sell from", () => {
  const run = M.buildRun(poolWorld({ bulk: 6 }));
  const pl = run.ctx.placements.get("beta|noclaim");
  assert.ok(pl.pool, "the pool is part of the placement");
  assert.deepEqual(pl.pool.markets, ["eldorado", "playerauctions", "g2g"]);
  const bw = (6 * 7) / 30;
  assert.ok(Math.abs(pl.pool.lambda - (pl.lambda.eldorado + bw)) < 0.01, "claim-at-sale share of the forecast + bulk's rate");
  assert.equal(pl.pool.net, U.netOf(2, "eldorado", {}), "priced at the claim-at-sale asks");
  assert.equal(pl.pool.from, "asks");
  const shelf = Object.values(pl.shelf).reduce((a, n) => a + n, 0);
  assert.equal(shelf + pl.reserve + pl.bulkTake, pl.stock, "every unit lands somewhere");
  assert.equal(pl.pool.units, pl.reserve + pl.bulkTake);
  assert.ok(pl.shelf.gameflip > 0);
  assert.ok(!(pl.shelf.eldorado > 0), "claim-at-sale markets hold no shelf");
  const all = run.rows.find((r) => r.k === "beta" && r.f === "noclaim" && r.m === "all");
  assert.ok(all.why.some((w) => w === "Shelf " + shelf + " of " + pl.stock + "; " + pl.pool.units + " to the pool the claim-at-sale offers and bulk sell from."), all.why.join(" / "));
});

test("no-claim placement has no value threshold (perishable stock); the claim farm keeps minMarginalUsd", () => {
  const cfg = CFG({ minMarginalUsd: 5, explore: false });
  const run = M.buildRun(poolWorld(), { cfg });
  const nc = run.ctx.placements.get("beta|noclaim");
  const ncShelf = Object.values(nc.shelf).reduce((a, n) => a + n, 0);
  assert.ok(ncShelf > 0, "a unit worth under $5 still goes where it can sell");
  assert.equal(ncShelf + nc.reserve + nc.bulkTake, nc.stock);
  const w = world();
  const claim = M.buildRun(w, { cfg }).ctx.placements.get(G + "|claim");
  assert.equal(Object.values(claim.shelf).reduce((a, n) => a + n, 0), 0, "the claim farm still keeps under-value units back");
  assert.equal(claim.reserve, claim.stock - claim.bulkTake);
  assert.equal(claim.pool, undefined);
});

test("placement flags: anchor when Gameflip gets nothing; fee-assumed with the equal-fee shelf logged", () => {
  const b = world();
  const run = M.buildRun(b);
  const pl = run.ctx.placements.get(G + "|claim");
  assert.ok(pl.flags.includes("fee-assumed"));
  assert.equal(typeof pl.shEq, "object");
  const gf = run.rows.find((r) => r.k === G && r.f === "claim" && r.m === "gameflip");
  assert.ok(gf.fl.includes("fee-assumed"));
  assert.ok(gf.br.she !== undefined);
  // Gameflip priced out of the shelf: its net is zero
  const pl0 = PL.placeGame(run.ctx, Object.assign({}, pl.input, { nets: Object.assign({}, pl.input.nets, { gameflip: 0 }), stock: 10 }));
  assert.equal(pl0.shelf.gameflip, 0);
  assert.ok(pl0.flags.includes("anchor"));
});

test("no-claim placement: only Gameflip/Digiseller/GGSel; an explicit cap is the owner's (managed)", () => {
  const b = world({ af: { caps: { beta: 20 } } });
  const run = M.buildRun(b);
  const pl = run.ctx.placements.get("beta|noclaim");
  assert.equal(pl.managed, true);
  assert.equal(pl.cap, 20);
  for (const m of ["zeusx", "eldorado", "playerauctions", "g2g"]) assert.ok(!(pl.shelf[m] > 0));
  const all = run.rows.find((r) => r.k === "beta" && r.m === "all");
  assert.equal(all.old.cap, 20);
  assert.ok(all.fl.includes("managed"));
  const gf = run.rows.find((r) => r.k === "beta" && r.f === "noclaim" && r.m === "gameflip");
  assert.equal(gf.sc, "managed");
  const def = M.buildRun(world()).rows.find((r) => r.k === "beta" && r.m === "all");
  assert.equal(def.old.cap, 70);
  assert.equal(def.old.capExplicit, false);
});

test("fail-safe: no fresh farm-brain row → regime unknown, every row hold, no shelf advice", () => {
  const b = world({ demand: [DR({ at: NOW - 30 * HOUR })] });
  const run = M.buildRun(b);
  const cells = run.rows.filter((r) => r.k === G && r.f === "claim" && r.m !== "all");
  assert.ok(cells.length > 0);
  for (const r of cells) {
    assert.equal(r.br.rg, "unknown");
    assert.equal(r.br.p, null);
    assert.ok(["unknown", "closed", "managed"].includes(r.sc), r.m + " " + r.sc);
    assert.equal(r.br.a.lower + r.br.a.raise + r.br.a.test, 0);
  }
  for (const f of run.fc.filter((x) => x.k === G && x.f === "claim")) assert.equal(f.a, "hold");
  assert.equal(run.ctx.placements.get(G + "|claim").unknown, true);
  const s = M.shelfForRun(run, { game: "Alpha Quest", farm: "claim", stock: 9 });
  assert.deepEqual(s.shelf, {});
  assert.equal(s.reserve, 9);
});

/* ------------------------------ classes, summary ---------------------------- */

test("price and shelf classes", () => {
  const cfg = CFG();
  assert.equal(M.priceClass(1.5, 1.55, { cfg }), "agree");
  assert.equal(M.priceClass(1.5, 1.2, { cfg }), "brain-lower");
  assert.equal(M.priceClass(1.5, 2, { cfg }), "brain-higher");
  assert.equal(M.priceClass(null, 2, { cfg }), "no-evidence");
  assert.equal(M.priceClass(1.5, null, { cfg }), "no-evidence");
  assert.equal(M.priceClass(1.5, 2, { cfg, managed: true }), "managed");
  assert.equal(M.priceClass(1.5, 2, { cfg, ladder: true }), "ladder");
  assert.equal(M.shelfClass(3, 4, {}), "agree");
  assert.equal(M.shelfClass(3, 6, {}), "brain-more");
  assert.equal(M.shelfClass(6, 3, {}), "brain-fewer");
  assert.equal(M.shelfClass(0, 3, {}), "brain-add");
  assert.equal(M.shelfClass(3, 0, {}), "brain-drop");
  assert.equal(M.shelfClass(3, 0, { elig: "closed" }), "closed");
  assert.equal(M.shelfClass(3, 0, { elig: "unmeasured" }), "unmeasured");
  assert.equal(M.shelfClass(3, null, {}), "unknown");
  assert.equal(M.shelfClass(3, 9, { managed: true }), "managed");
  assert.deepEqual(M.PRICE_CLASSES, ["agree", "brain-lower", "brain-higher", "no-evidence", "managed", "ladder"]);
});

test("summary totals compare like with like: unknown cells are counted apart, never as zero", () => {
  const rows = [
    { f: "claim", m: "gameflip", pc: "agree", sc: "brain-more", old: { sh: 2, n: 2 }, br: { sh: 5, a: { hold: 2 }, wv: 1, wva: 0.5 }, fl: ["fee-assumed"] },
    { f: "claim", m: "ggsel", pc: "no-evidence", sc: "unknown", old: { sh: 3, n: 0 }, br: { sh: null, a: {} }, fl: [] },
    { f: "claim", m: "all", pc: "", sc: "", old: { sh: 5 }, br: { sh: 5, rsv: 4, bt: 1, rg: "balanced" }, fl: [] },
  ];
  const s = M.summarize(rows);
  assert.equal(s.cells, 2);
  assert.equal(s.games, 1);
  assert.equal(s.shelf.claim.compared, 1);
  assert.equal(s.shelf.claim.old, 2);
  assert.equal(s.shelf.claim.brain, 5);
  assert.equal(s.shelf.claim.unknownCells, 1);
  assert.equal(s.shelf.claim.oldUnknown, 3);
  assert.equal(s.shelf.claim.reserve, 4);
  assert.equal(s.value.claim.compared, 1);
  assert.equal(s.value.claim.old, 1);
  assert.equal(s.value.claim.brain, 2);
  assert.equal(s.byPrice.claim["no-evidence"], 1);
  assert.equal(s.flags["fee-assumed"], 1);
});

/* ------------------------------ outputs, run -------------------------------- */

test("outputs fail safe: no run, unknown market, blocked market, unknown game", () => {
  assert.deepEqual(
    { p: M.priceForRun(null, { marketplace: "gameflip", basePriceUsd: 1.25 }).price, c: M.priceForRun(null, { marketplace: "gameflip", basePriceUsd: 1.25 }).confidence },
    { p: 1.25, c: "none" },
  );
  const s = M.shelfForRun(null, { game: "x", stock: 7 });
  assert.deepEqual(s.shelf, {});
  assert.equal(s.reserve, 7);
  assert.equal(M.valueForRun(null, "x").value, null);
  const run = M.buildRun(world());
  assert.equal(M.priceForRun(run, { marketplace: "nowhere", basePriceUsd: 1 }).confidence, "none");
  const d = M.priceForRun(run, { marketplace: "digiseller", basePriceUsd: 1.3, game: "Alpha Quest" });
  assert.equal(d.price, 1.3);
  assert.equal(d.confidence, "none");
  const u = M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.1, game: "Nobody Plays This" });
  assert.equal(u.price, 1.1);
  assert.equal(u.confidence, "none");
  assert.equal(M.shelfForRun(run, { game: "Nobody Plays This", farm: "claim", stock: 4 }).reserve, 4);
});

test("outputs answer from the run: a measured offer gets the brain's price; shelf and value per account", () => {
  const run = M.buildRun(world());
  const p = M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (1 Items)" });
  assert.ok(p.price > 0);
  assert.ok(Array.isArray(p.reasons) && p.reasons.length <= 6);
  if (U.CONF_RANK[p.confidence] < U.CONF_RANK.medium) assert.equal(p.price, 1.25);
  const s = M.shelfForRun(run, { game: "Alpha Quest", farm: "claim", stock: 10 });
  const placed = Object.values(s.shelf).reduce((a, n) => a + n, 0);
  assert.equal(placed + s.reserve + s.bulkTake, 10);
  const v = M.valueForRun(run, "alpha quest");
  if (v.value !== null) {
    const sum = Object.values(v.shares).reduce((a, n) => a + n, 0);
    assert.ok(Math.abs(sum - 1) < 0.01);
    assert.ok(v.value > 0);
  }
});

test("priceFor is gated against the caller's base: never under it on GGSel", () => {
  const run = M.buildRun(world());
  const p = M.priceForRun(run, { marketplace: "ggsel", basePriceUsd: 2.4, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (1 Items)" });
  assert.ok(p.price >= 2.4, JSON.stringify(p));
});

test("a run is deterministic, the async run matches it, and every reason fits the log", async () => {
  const b = world();
  const before = JSON.stringify(b);
  const a = M.buildRun(b);
  const b2 = M.buildRun(JSON.parse(JSON.stringify(b)));
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b2.rows));
  assert.equal(JSON.stringify(a.fc), JSON.stringify(b2.fc));
  const c = await M.buildRunAsync(b);
  assert.equal(JSON.stringify(c.rows), JSON.stringify(a.rows));
  assert.equal(JSON.stringify(c.summary), JSON.stringify(a.summary));
  for (const r of a.rows) {
    assert.ok(Array.isArray(r.why) && r.why.length <= 6);
    for (const w of r.why) assert.ok(w.length <= 160);
    assert.ok(M.PRICE_CLASSES.includes(r.pc) || r.m === "all");
    assert.ok(M.SHELF_CLASSES.includes(r.sc) || r.m === "all");
  }
  for (const f of a.fc) {
    assert.equal(typeof f.l, "string");
    assert.ok(f.p === null || (f.p >= 0 && f.p <= 1));
    assert.ok(["hold", "lower", "raise", "test", "ladder"].includes(f.a));
  }
  assert.equal(JSON.stringify(b), before, "the bundle is never mutated");
});

test("heartbeat: one line, run number, model version, NOT LOGGED when the write failed", () => {
  const run = M.buildRun(world());
  const line = M.heartbeatText({ ms: 1500, v: 1, summary: run.summary }, run, true, { runs: 4 });
  assert.ok(line.startsWith("listingBrain: run 4 (model v1) — claim "), line);
  assert.ok(!line.includes("\n"));
  assert.match(line, /live rows: hold\/lower\/raise\/test \d+\/\d+\/\d+\/\d+ \| 1\.5s$/);
  const bad = M.heartbeatText({ ms: 10, v: 1, summary: run.summary }, run, false, { runs: 5 });
  assert.ok(bad.endsWith(" | NOT LOGGED (write failed)"));
});

test("C7 rule 3's old side is logged on the claim game's line: half now, half later, the post-event price", () => {
  const all = M.buildRun(world()).rows.find((r) => r.k === G && r.f === "claim" && r.m === "all");
  assert.equal(all.old.post, 1.75);
  assert.equal(all.old.now, 7);
  assert.equal(all.old.hold, 7);
});

test("C8 a single price's pack prices are the pack maths itself, and bulk-anchor is per set", () => {
  const tiers = [{ minQty: 5, discountPct: 10 }, { size: 10, discountPct: 20 }];
  // one world per run: its sales join its own rows (a second world() mints new ids)
  const withPack = (ck) => {
    const b = world({ bulk: { markets: ["gameflip"], tiers, reserveSingles: 0 } });
    b.listings = b.listings.concat([L({ kind: "bulk", pack: 5, ck, p: 6, qty: 5 })]);
    return M.buildRun(b);
  };
  const run = withPack(CK);
  const o = run.offers.find((x) => x.k === G && x.f === "claim" && x.m === "gameflip" && x.p !== null);
  assert.ok(o.fl.includes("bulk-anchor"));
  assert.deepEqual(o.packs, require("../utils/bulkPacks/pricing").tierQuote({ anchor: o.p, market: "gameflip", tiers: [{ minQty: 5, discountPct: 10 }, { minQty: 10, discountPct: 20 }] }), "an older {size} tier reads as minQty");
  assert.equal(o.packs[0].packPrice, Math.max(0.75, Math.round(5 * o.p * 0.9 * 4) / 4), "Gameflip's quarter grid");
  const other = withPack("s:else");
  assert.ok(!other.rows.find((r) => r.k === G && r.f === "claim" && r.m === "gameflip").fl.includes("bulk-anchor"), "another set's pack anchors nothing here");
});

test("C19a the owner's reserveSingles keeps that many units for single shelves, whatever bulk would take", () => {
  const bulkDemand = Array.from({ length: 30 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 1) * DAY, src: "bulk" }));
  const plOf = (reserveSingles) => M.buildRun(world({ demandOnly: bulkDemand, bulk: { markets: [], tiers: [], reserveSingles } })).ctx.placements.get(G + "|claim");
  const free = plOf(0);
  assert.equal(free.bulkTake, Math.min(free.stock, 14), "bulk's 7/wk over 14 days");
  const held = plOf(10);
  assert.equal(held.bulkTake, Math.max(0, held.stock - 10));
  assert.ok(held.why.some((w) => /kept for single shelves \(your reserveSingles\)/.test(w)));
});

test("M5 a no-claim game whose cap the owner set by hand gets no shelf advice", () => {
  const run = M.buildRun(world({ af: { caps: { beta: 20 } } }));
  const s = M.shelfForRun(run, { game: "beta", farm: "noclaim", stock: 9 });
  assert.deepEqual(s.shelf, {});
  assert.equal(s.reserve, 9);
  assert.equal(s.basis, "managed");
});

test("M6 priceFor never prices a no-claim offer on a claim-at-sale market: those are the owner's", () => {
  const run = M.buildRun(world());
  for (const m of ["eldorado", "playerauctions", "g2g"]) {
    const p = M.priceForRun(run, { marketplace: m, basePriceUsd: 6, game: "Beta", farm: "noclaim" });
    assert.equal(p.confidence, "none", m);
    assert.equal(p.basis, "managed");
  }
});

test("M7 a run older than allowed answers nothing of its own: today's price, no shelf, no value", () => {
  const run = M.buildRun(world());
  const q = { marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (1 Items)" };
  const fresh = M.priceForRun(run, q, { now: NOW + HOUR });
  const late = NOW + 30 * DAY;
  const old = M.priceForRun(run, q, { now: late });
  assert.equal(old.confidence, "none");
  assert.equal(old.price, 1.25);
  assert.match(old.reasons[0], /The newest run is 720 h old/);
  assert.ok(fresh.reasons.every((w) => !/h old/.test(w)));
  assert.deepEqual(M.shelfForRun(run, { game: "Alpha Quest", farm: "claim", stock: 5 }, { now: late }).shelf, {});
  assert.equal(M.valueForRun(run, "alpha quest", { now: late }).value, null);
  // the limit: twice the interval between runs, or the farm-brain rows' own age limit
  assert.equal(M.staleRun(run, NOW + 5 * HOUR), null);
  assert.ok(M.staleRun(run, NOW + 7 * HOUR));
});

test("M8 priceFor never answers a brain price without a valid base, and today's price always within today's limits", () => {
  const run = M.buildRun(world());
  for (const b of [0, -1, NaN, Infinity, "1.25", null, undefined, 26]) {
    const r = M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: b, game: "Alpha Quest" });
    assert.equal(r.price, 0, String(b));
    assert.equal(r.basis, "invalid base");
  }
  assert.equal(M.priceForRun(null, { marketplace: "gameflip", basePriceUsd: 0.3 }).price, 0.75, "the platform floor even with no run");
  assert.equal(M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 0.3, game: "Nobody Plays This" }).price, 0.75);
  assert.equal(M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 9, game: "Nobody Plays This", farm: "noclaim" }).price, 4.5, "the no-claim ceiling");
});

test("M9 with nothing taking from the no-claim pool, the shelves hold every unit they can, up to the cap", () => {
  // a no-claim game with Gameflip sales only: no claim-at-sale offer, no bulk, no hand sale
  const listings = [];
  const sales = [];
  for (let i = 0; i < 6; i++) {
    const r = L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5, st: "sold", c: NOW - (3 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, g: "beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5, t: r.c + 0.5 * DAY }));
  }
  listings.push(L({ g: "beta", gl: "Beta", f: "noclaim", o: "unclaimed", ck: "s:b1", bk: "beta|1", p: 1.5 }));
  const pl = M.buildRun(bundle({ listings, sales, af: { caps: {} }, demand: [DR({ k: "beta", f: "noclaim", w: 1, on: 60 })] })).ctx.placements.get("beta|noclaim");
  assert.equal(pl.pool.outlet, null);
  assert.equal(pl.pool.net, null, "no borrowed price for a pool nothing sells from");
  assert.equal(pl.shelf.gameflip, 60, "all 60 on the shelf (cap 70)");
  assert.equal(pl.reserve, 0);
  const capped = M.buildRun(bundle({ listings, sales, af: { caps: {}, capDefault: 40 }, demand: [DR({ k: "beta", f: "noclaim", w: 1, on: 60 })] })).ctx.placements.get("beta|noclaim");
  assert.equal(capped.shelf.gameflip, 40, "never past the cap in force");
});

test("M12 shareShrinkDays 0 is the raw in-stock rate; no sale in 30 days is no split at all", () => {
  const b = world();
  const ev0 = E.buildEvidence(b, { cfg: CFG({ shareShrinkDays: 0 }), cut: NOW });
  const ms = PL.marketShares(ev0, G, "claim", ["gameflip", "ggsel"]);
  const raw = { gameflip: ms.raw.gameflip, ggsel: ms.raw.ggsel };
  near(ms.shares.gameflip, raw.gameflip / (raw.gameflip + raw.ggsel), "K = 0");
  const none = PL.marketShares(ev0, "nobody", "claim", ["gameflip", "ggsel"]);
  assert.deepEqual(none.shares, { gameflip: 0, ggsel: 0 }, "never an equal split passed off as evidence");
});

test("H6 single shelves split the forecast minus what bulk and hand sales take", () => {
  const extra = Array.from({ length: 30 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 1) * DAY, src: i < 15 ? "bulk" : "hand" }));
  const pl = M.buildRun(world({ demandOnly: extra })).ctx.placements.get(G + "|claim");
  near(pl.Ws, Math.max(0, 4 - 3.5 - 3.5), "W 4/wk − bulk 3.5/wk − hand 3.5/wk, never below 0");
  const pl2 = M.buildRun(world({ demandOnly: extra.slice(0, 6) })).ctx.placements.get(G + "|claim");
  near(pl2.Ws, 4 - 1.4, "W 4/wk − bulk 1.4/wk");
  const lam = Object.values(pl2.lambda).reduce((a, x) => a + x, 0);
  near(lam, 2.6, "the split is of 2.6/wk", 0.01);
});

test("H7 a backtest's demand has no stock: cover unknown, the regime from skip, fading or perishing only", () => {
  const ev = E.buildEvidence(world(), { cfg: CFG(), cut: NOW - 7 * DAY, synthDemand: true });
  const d = ev.demand.get(G + "|claim");
  assert.equal(d.on, null);
  const gs = P.gameState(ev, G, "claim");
  assert.equal(gs.cover, null);
  assert.notEqual(gs.regime, "scarce", "no stock is not stock 0");
});

test("H8 every forecast carries the market's base rate over the same days, logged when it is made", () => {
  const run = M.buildRun(world());
  assert.ok(run.fc.length > 0);
  for (const f of run.fc) {
    const hz = run.ctx.hz[f.f];
    const want = H.baseP(hz, f.m, f.h);
    if (want === null) assert.equal(f.pb, null);
    else near(f.pb, U.round3(want), f.m);
  }
});

test("H18 the value per account weighs each market by the units it is expected to SELL there", () => {
  const run = M.buildRun(world());
  const pl = run.ctx.placements.get(G + "|claim");
  const v = M.valueForRun(run, "alpha quest", { farm: "claim" });
  if (v.value === null) return;
  const sells = {};
  let tot = 0;
  for (const m of Object.keys(v.shares)) {
    sells[m] = U.expectedSold(pl.lambda[m], pl.shelf[m]);
    tot += sells[m];
  }
  for (const m of Object.keys(v.shares)) near(v.shares[m], U.round3(sells[m] / tot), m, 0.002);
});

test("H18 the equal-fee shelf compares NET values with the $ threshold, not gross ones", () => {
  const nets = { gameflip: 0.95 };
  const gross = { gameflip: 1.04 };
  // the old shelf read gross prices as nets: a unit worth $1.04 gross, $0.95 net cleared a $1 threshold
  const fill = (n) => PL.greedyFill({ markets: ["gameflip"], mu: { gameflip: 20 }, nets: n, avail: 5, minMarginal: 1 }).shelf.gameflip;
  assert.equal(fill(gross), 5);
  assert.equal(fill(nets), 0);
  const run = M.buildRun(world(), { cfg: CFG({ minMarginalUsd: 1.3 }) });
  const pl = run.ctx.placements.get(G + "|claim");
  // at the open markets' mean fee GGSel's $1.40 nets under $1.30: no unit on the equal-fee shelf (the
  // gross reading put one there), and Gameflip's $1.50 clears it for its first unit only
  assert.equal(pl.input.prices.ggsel, 1.4);
  assert.equal(pl.shEq.ggsel, 0);
  assert.equal(pl.shEq.gameflip, 1);
});

test("P20-4 the async run yields on a time budget and gives exactly the sync run's answer", async () => {
  const FX = require("../scripts/listing-brain-fixture");
  const b = FX.generate({ seed: 3, large: true });
  const sync = M.buildRun(b);
  let maxGap = 0;
  let ticks = 0;
  let last = Date.now();
  let done = false;
  const tick = () => {
    const n = Date.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
    ticks++;
    if (!done) setImmediate(tick);
  };
  setImmediate(tick);
  const run = await M.buildRunAsync(b);
  done = true;
  assert.equal(JSON.stringify(run.rows), JSON.stringify(sync.rows));
  assert.equal(JSON.stringify(run.fc), JSON.stringify(sync.fc));
  assert.equal(JSON.stringify(run.ctx.hz), JSON.stringify(sync.ctx.hz), "the async fit is the sync fit");
  assert.ok(ticks > 5, "the loop got control " + ticks + " times");
  assert.ok(maxGap < 200, "longest synchronous stretch " + maxGap + " ms");
  const y = U.makeYielder(1000);
  assert.equal(y.due(), false);
  assert.equal(y.maybe(), null);
});

test("P20-4 the hazard fit and the evidence yield inside their loops, before the translator, and answer the same", async () => {
  const FX = require("../scripts/listing-brain-fixture");
  const b = FX.generate({ seed: 2, large: true });
  const cfg = U.readConfig(b.af || {});
  const ev = E.buildEvidence(b, { cfg, cut: b.now });
  // a yielder that is always due: every marked point gives the loop back
  let yields = 0;
  const always = { due: () => true, now: async () => void yields++, maybe: () => null };
  const evA = await E.buildEvidenceAsync(b, { cfg, cut: b.now, yielder: always });
  assert.ok(yields > 50, "the evidence yielded " + yields + " times");
  // the no-claim listing → bundle key map is built inside the evidence (it was one 50–70 ms piece in the
  // first no-claim game's cells) and is the same map the price module would build
  const own = new Map();
  for (const u of evA.noclaim.units) {
    const k = String(u.bk || "").trim().toLowerCase();
    if (k) for (const lid of u.lids || []) own.set(lid, own.has(lid) && own.get(lid) !== k ? "" : k);
  }
  assert.ok(own.size > 0);
  assert.deepEqual([...P.bundleKeyByLid(evA)].sort(), [...own].sort());
  // the translator's ratios are asked pair by pair, each a possible yield (7 × 6 pairs)
  const evYields = yields;
  yields = 0;
  for (const farm of ["claim", "noclaim"]) {
    const a = await H.fitHazardAsync(evA, farm, { yielder: always });
    assert.equal(JSON.stringify(a), JSON.stringify(H.fitHazard(ev, farm)), farm);
  }
  assert.ok(yields >= 4, "the fit yielded " + yields + " times");
  // a yielder that is never due still gives the loop back right before the tracker's translator
  yields = 0;
  const never = { due: () => false, now: async () => void yields++, maybe: () => null };
  await E.buildEvidenceAsync(b, { cfg, cut: b.now, yielder: never });
  assert.equal(yields, 2, "before and after the translator, whatever the budget");
  assert.ok(evYields > yields);
});

test("P20-14 callers' questions never grow the run's memo: their own entries are capped", () => {
  const run = M.buildRun(world());
  const before = run.ctx.ev._ref.size;
  for (let i = 0; i < 1300; i++) M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (" + (i + 2) + " Items)", items: [{ itemKey: "k" + i, game: "Alpha Quest", qty: 1 }] });
  assert.equal(run.ctx.ev._ref.size, before, "the run's own memo is untouched");
  assert.ok(run.ctx._caller.ev._ref.own.size <= M.CALLER_MEMO_MAX);
});

test("pd: each placement policy's weekly demand split sums to the single-shelf forecast over the game's markets", () => {
  const extra = Array.from({ length: 6 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 1) * DAY, src: "bulk" }));
  const run = M.buildRun(world({ demandOnly: extra }));
  for (const [g, f] of [[G, "claim"], ["beta", "noclaim"]]) {
    const pl = run.ctx.placements.get(g + "|" + f);
    for (const p of M.PLACE_POLICIES) {
      const lam = pl.policies[p].lambda;
      if (lam === null) continue;
      const sum = Object.values(lam).reduce((a, x) => a + x, 0);
      near(sum, pl.Ws, g + " " + p, 0.01);
    }
    for (const r of run.rows.filter((x) => x.k === g && x.f === f && x.m !== "all")) {
      for (const p of M.PLACE_POLICIES) {
        const lam = pl.policies[p].lambda;
        assert.equal(r.pd[p], lam === null ? null : num(lam[r.m]), g + " " + r.m + " " + p);
      }
    }
  }
  // an unknown game has no split at all
  const unk = M.buildRun(world({ demand: [] })).rows.find((r) => r.m !== "all");
  for (const p of M.PLACE_POLICIES) assert.equal(unk.pd[p], null);
});

test("old side beside the brain: today's ask, new-listing price, flat shelf and tracker policy on the cell", () => {
  const run = M.buildRun(world());
  const gf = run.rows.find((r) => r.k === G && r.f === "claim" && r.m === "gameflip");
  assert.equal(gf.old.a, 1.5);
  assert.equal(gf.old.np, 1.25);
  assert.equal(gf.old.sh, 4);
  assert.equal(gf.pol.tracker, 1.35);
  assert.equal(gf.pol.old, 1.5);
  assert.ok(["agree", "brain-lower", "brain-higher", "no-evidence"].includes(gf.pc));
  for (const p of M.PLACE_POLICIES) assert.ok(p in gf.pf);
  // a cell with live rows counts them by action
  const total = Object.values(gf.br.a).reduce((a, n) => a + n, 0);
  assert.equal(total, 3);
});

test("purity: no clock, no randomness, no I/O in the model's source", () => {
  const dir = path.join(__dirname, "..", "utils", "listingBrain");
  const files = ["model.js"].concat(fs.readdirSync(path.join(dir, "model")).map((f) => path.join("model", f)));
  const allowed = new Set(["../priceTracker/setIdentity", "../bulkPacks/pricing", "../../priceTracker/stats", "../../priceTracker/venues", "../../priceTracker/analyze", "../../priceTracker/setIdentity", "../../farmSizing", "../../marketPricing", "../../bulkPacks/pricing"]);
  for (const f of files) {
    if (!f.endsWith(".js") || /score\.js$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(src), f + " reads the clock or randomness");
    assert.ok(!/setTimeout|setInterval/.test(src), f + " starts a timer");
    if (!/util\.js$/.test(f)) assert.ok(!/setImmediate/.test(src), f + " yields outside util.yieldNow");
    // the one clock: util.js's time-budget yielder (it decides when to yield, never what is computed)
    if (!/util\.js$/.test(f)) assert.ok(!/performance\s*\.\s*now/.test(src), f + " reads performance.now");
    for (const m of src.matchAll(/require\("([^"]+)"\)/g)) {
      const r = m[1];
      if (r.startsWith("./")) continue;
      if (r === "node:perf_hooks" && /util\.js$/.test(f)) continue;
      assert.ok(allowed.has(r), f + " requires " + r);
    }
  }
});

test("performance: a 150-game bundle runs well inside a second and yields between phases", async () => {
  const games = Array.from({ length: 150 }, (_, i) => "game " + i);
  const listings = [];
  const sales = [];
  const demand = [];
  let k = 0;
  for (const g of games) {
    demand.push(DR({ k: g, w: (k % 9) + 0.5, on: (k % 30) + 2 }), DR({ k: g, f: "noclaim", w: (k % 5) + 1, on: (k % 12) + 1 }));
    for (let j = 0; j < 20; j++) {
      const m = U.MARKETS[(k + j) % 7];
      const f = j % 4 === 0 ? "noclaim" : "claim";
      const ck = "s:" + g.replace(" ", "") + "x" + (j % 3);
      const row = L({ g, gl: g, m, f, o: j % 10 === 0 ? "manual" : f === "claim" ? "auto" : "unclaimed", ck, bk: g + "|1", p: 1 + ((k + j) % 7) * 0.25, st: j % 3 === 0 ? (m === "gameflip" ? "sold" : "delisted") : "active", c: NOW - ((j * 4) % 80) * DAY - DAY, u: NOW - DAY, qty: 2 });
      listings.push(row);
      for (let s = 0; s < (j % 3 === 0 ? 2 : 1); s++) sales.push(S({ lid: row.id, g, m, f, o: row.o, ck, bk: g + "|1", p: row.p, t: row.c + (s + 1) * 0.5 * DAY }));
    }
    k++;
  }
  while (sales.length < 5000) {
    const r = listings[sales.length % listings.length];
    sales.push(S({ lid: r.id, g: r.g, m: r.m, f: r.f, o: r.o, ck: r.ck, bk: r.bk, p: r.p, t: r.c + 0.25 * DAY }));
  }
  const b = bundle({ listings, sales, demand });
  M.buildRun(b); // warm the JIT
  const t0 = process.hrtime.bigint();
  const run = M.buildRun(b);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(run.rows.length > 1000);
  assert.ok(ms < 1500, "buildRun took " + ms.toFixed(0) + " ms");
  let maxGap = 0;
  let last = Date.now();
  let done = false;
  const tick = () => {
    const n = Date.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
    if (!done) setImmediate(tick);
  };
  setImmediate(tick);
  await M.buildRunAsync(b);
  done = true;
  assert.ok(maxGap < 400, "longest synchronous stretch " + maxGap + " ms");
});

/* ------------------------- review findings: the model's side (L4, L8, P2b) ------------------------- */

test("L4 a unit the lister took off sale (st not listed/sold) reads off; a backtest cut before its last write reads it as it was", () => {
  const mk = (st, o = {}) => Object.assign({ g: "beta", m: "gameflip", st, l: NOW - 9 * DAY, s: null, p: 0, sm: "", x: null, lids: [], bk: "", camps: [], u: NOW - 2 * DAY }, o);
  // skipped (shrunk, stranded, GGSel switched off), removed (manual-sold tick), manual (an owner listing),
  // released with no last write known, a sold one
  // released with no last write known, a sold one, and an expired one (on sale until its expiry)
  const units = [mk("listed"), mk("skipped"), mk("removed"), mk("manual"), mk("released", { u: null }), mk("sold", { s: NOW - DAY }), mk("expired", { x: NOW - 3 * DAY, u: null })];
  const at = (cut) => E.buildEvidence(bundle({ noclaim: { units, waves: [] } }), { cfg: CFG(), cut }).noclaim.units.map((u) => u.stc);
  assert.deepEqual(at(NOW), ["listed", "off", "off", "off", "off", "sold", "expired"]);
  assert.deepEqual(at(NOW - 5 * DAY), ["listed", "listed", "listed", "listed", "off", "listed", "listed"], "before its last write (or its expiry) the unit was still on sale");
  // the price model's live stock and perish estimate count the listed unit only
  const ev = E.buildEvidence(bundle({ noclaim: { units, waves: [] } }), { cfg: CFG(), cut: NOW });
  assert.equal(P.perishOf(ev, "beta").listed, 1);
});

test("L8 waveEndFor matches a unit's raw campaign name to its own wave (W.name), not the wave live when it was listed", () => {
  const waves = [
    { g: "omega", ev: "Omega Season 18", wave: "Week 1", name: "Omega Season 18 - Week 1", startAt: NOW - 30 * DAY, endAt: NOW - 23 * DAY },
    { g: "omega", ev: "Omega Season 18", wave: "Week 2", name: "Omega Season 18 - Week 2", startAt: NOW - 23 * DAY, endAt: NOW - 16 * DAY },
    { g: "omega", ev: "R6 S2 2026", wave: "Wave 1", name: "R6 S2 2026 1", startAt: NOW - 40 * DAY, endAt: NOW - 26 * DAY },
  ];
  // listed after week 2 started: its week-1 drops are still claimable
  assert.equal(E.waveEndFor(waves, { g: "omega", camps: ["Omega Season 18 - Week 1"], l: NOW - 20 * DAY }), NOW - 23 * DAY);
  assert.equal(E.waveEndFor(waves, { g: "omega", camps: ["r6 s2 2026 1"], l: NOW - 20 * DAY }), NOW - 26 * DAY, "case-insensitive");
  // the label forms still match a wave without a raw name
  assert.equal(E.waveEndFor([{ ev: "Omega Season 18", wave: "Week 1", startAt: NOW - 30 * DAY, endAt: NOW - 23 * DAY }], { camps: ["Omega Season 18 Week 1"], l: NOW }), NOW - 23 * DAY);
});

test("P2b a sale on market 'other' is never a price and never reaches the translator, like 'unknown'", () => {
  const sales = [S({ m: "other", p: 2 }), S({ m: "unknown", p: 2 }), S({ m: "gameflip", p: 1.5 })];
  const ev = E.buildEvidence(bundle({ sales }), { cfg: CFG(), cut: NOW });
  assert.deepEqual(
    ev.orders.map((o) => o.m),
    ["gameflip"],
  );
  for (const per of ev.tr.bySet.values()) for (const m of per.keys()) assert.ok(U.MARKETS.includes(m), "translator market " + m);
});
