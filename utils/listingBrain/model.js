// The listing brain's model — docs/LISTING-BRAIN-PLAN.md §4.
//
// The second half of one system: the farm brain (utils/demandBrain) says how many accounts each
// farm should hold per game; this says what happens to them once farmed — WHERE the stock goes (the
// shelf per market), HOW MUCH each offer costs there, and WHEN a live listing's price should move.
//
// TEST MODE. Nothing here is read by a publisher. utils/listingBrain/index.js logs what this computes
// beside what today's code does at the same moment, and scores it; wiring is a later round.
//
// PURE: no database, no network, no settings read, no clock but the bundle's `now`. Every number a run
// logs is reproducible from the bundle (scripts/listing-brain-export.js writes one to a file).
//
// The pieces (model/*.js): util (constants, config), evidence (rows, exposure, orders, indexes),
// ref (reference price cascade), hazard (sell-through per price ratio), price (regime pick, gates,
// live-row actions), place (eligibility, shares, greedy shelf, policies). This file runs them in
// phases — evidence → fit → cells → placement → summary — and lays out the log rows.
const { identify, normGame, sizeBand } = require("../priceTracker/setIdentity");
const packPricing = require("../bulkPacks/pricing");
const U = require("./model/util");
const E = require("./model/evidence");
const RF = require("./model/ref");
const H = require("./model/hazard");
const P = require("./model/price");
const PL = require("./model/place");

const { MARKETS, CONF_RANK, num, round2, round3, lower } = U;

const MODEL_VERSION = 1;
// A run's cells are capped (150 games × 2 farms × 7 markets is 2,100); past this the run says so.
const MAX_CELLS = 4000;
// Milliseconds of work between two yields of buildRunAsync (P20-4: a fixed number of games per chunk
// held ~200 ms on Node 22 and ~350 ms on Node 20; a time budget holds on both).
const YIELD_MS = 40;
// What priceFor / shelfFor may add to a run's memo for callers' own questions (P20-14): least recently
// used first out, the run's own entries never touched.
const CALLER_MEMO_MAX = 1000;
const DEFAULTS = U.DEFAULTS;
const PRICE_CLASSES = ["agree", "brain-lower", "brain-higher", "no-evidence", "managed", "ladder"];
const SHELF_CLASSES = ["agree", "brain-more", "brain-fewer", "brain-add", "brain-drop", "closed", "unknown", "unmeasured", "managed"];
const PRICE_POLICIES = U.PRICE_POLICIES;
const PLACE_POLICIES = U.PLACE_POLICIES;
const LIVE_ACTIONS = ["hold", "lower", "raise", "test", "ladder"];
const REGIMES = ["scarce", "balanced", "overstock", "unknown"];

/* --------------------------------- classes ---------------------------------- */

/**
 * Old versus brain price (plan §4.7): managed and ladder first; no number on either side is
 * "no-evidence" (counted apart, never as zero); inside max($0.10, 8 %) they agree.
 */
function priceClass(old, br, { managed = false, ladder = false, cfg = DEFAULTS } = {}) {
  if (managed) return "managed";
  if (ladder) return "ladder";
  const o = num(old, NaN);
  const b = num(br, NaN);
  if (!(o > 0) || !(b > 0)) return "no-evidence";
  if (P.agrees(cfg, o, b)) return "agree";
  return b < o ? "brain-lower" : "brain-higher";
}

/** Old versus brain shelf (plan §4.7): within one unit they agree. */
function shelfClass(oldSh, brSh, { elig = "open", managed = false } = {}) {
  if (managed || elig === "managed") return "managed";
  if (elig === "closed" || elig === "unknown" || elig === "unmeasured") return elig;
  if (brSh === null || brSh === undefined) return "unknown";
  const o = Math.max(0, num(oldSh, 0));
  const b = Math.max(0, num(brSh, 0));
  if (Math.abs(b - o) <= 1) return "agree";
  if (o === 0) return "brain-add";
  if (b === 0) return "brain-drop";
  return b > o ? "brain-more" : "brain-fewer";
}

/* ---------------------------------- helpers --------------------------------- */

// An offer's identity inside a game: the exact items when known, else the size band.
const identKey = (r) => (r.ex && r.ck ? "c:" + r.ck : "b:" + r.bk);

// The loader's old-side record of an offer on m: by its exact items, else its size band.
function oldOfferOf(bundle, m, id) {
  const offers = (bundle.old && bundle.old.offers) || {};
  return (id && id.rawCk && offers[m + "|" + id.rawCk]) || (id && id.bk && offers[m + "|" + id.bk]) || null;
}

/** Today's price for a NEW listing of this offer on m (plan §4.6 "old"): bundlePrice / rules 1–2. */
function newBase(bundle, g, f, m, id) {
  const oo = oldOfferOf(bundle, m, id);
  if (oo && num(oo.np) > 0) return round2(oo.np);
  if (f === "claim") {
    const og = bundle.old && bundle.old.games && bundle.old.games[g];
    if (og) {
      if (m === "ggsel") return num(og.ggsel) > 0 ? round2(og.ggsel) : null;
      return num(og.base) > 0 ? round2(Math.max(num(og.base), U.floorFor(m))) : null;
    }
  }
  return null;
}

/**
 * The tracker's suggestForNew answer for the offer (either shape the loader may hand over):
 * { price, basis, conf } — its engine fallback reads basis "none" (it never raises a price).
 */
function trackerOf(bundle, m, id) {
  const oo = oldOfferOf(bundle, m, id);
  const t = oo && oo.tracker;
  if (!t) return null;
  const x = t.price !== undefined ? t : t[m] || {};
  if (!(num(x.price) > 0)) return null;
  const b = String(x.basis || "");
  const conf = ["high", "medium", "low", "none"].includes(x.confidence) ? x.confidence : "none";
  return { price: round2(x.price), basis: !b || /^engine/i.test(b) ? "none" : "tracker", conf };
}

/**
 * The pack prices a single price would anchor (brief §3a c): bulkPacks/pricing.tierQuote — the pack
 * maths itself (per-listing market floor, Gameflip's quarter grid, the 60 % discount cap), never a
 * copy (C8). Tiers are getBulkPacks()' {minQty, discountPct} (an older {size} reads as minQty).
 */
function packPrices(bundle, m, p) {
  const tiers = (bundle.bulk && Array.isArray(bundle.bulk.tiers) ? bundle.bulk.tiers : [])
    .filter((t) => t && typeof t === "object")
    .map((t) => ({ minQty: t.minQty !== undefined && t.minQty !== null ? t.minQty : t.size, discountPct: t.discountPct }));
  return packPricing.tierQuote({ anchor: p, market: m, tiers }).filter((q) => q.packPrice > 0);
}

/** Identities of a game × farm's offers and the game's main one (most live system rows). */
function identities(ev, g, f) {
  const rows = ev.rowsByGF.get(g + "|" + f) || [];
  const map = new Map();
  const add = (r, live) => {
    const k = identKey(r);
    let e = map.get(k);
    if (!e) {
      e = { key: k, ck: r.ex ? r.ck : null, rawCk: r.ck || null, bk: r.bk, ex: !!(r.ex && r.ck), n: r.n, band: r.band, live: 0, rows: 0, last: -Infinity, orders: 0 };
      map.set(k, e);
    }
    e.rows++;
    if (live) e.live++;
    if (r.c > e.last) {
      e.last = r.c;
      if (r.n !== null) e.n = r.n;
      e.band = r.band;
      e.bk = r.bk;
    }
  };
  for (const r of rows) if (r.system) add(r, r.activeAtCut);
  let from = "system";
  if (!map.size) {
    // no system-made row: the game's offer is what the owner lists, else what sold
    for (const r of rows) if (r.rk === "hand" || r.rk === "cas") add(r, r.activeAtCut);
    from = "owner";
  }
  if (!map.size) {
    for (const m of MARKETS) {
      for (const o of ev.idx.byGFM.get(g + "|" + f + "|" + m) || []) {
        const r = { ex: !!o.ck, ck: o.ck, bk: o.bk, n: o.n, band: o.bk ? o.bk.slice(o.bk.lastIndexOf("|") + 1) : sizeBand(o.n), c: o.t };
        add(r, false);
      }
    }
    from = "orders";
  }
  for (const e of map.values()) e.orders = (e.ck ? (ev.idx.byCk.get(e.ck) || []).length : 0) + (e.bk ? (ev.idx.byBk.get(e.bk) || []).length : 0);
  const list = [...map.values()].sort((a, b) => U.cmp(a.key, b.key));
  let primary = null;
  for (const e of list) {
    if (!primary || e.live > primary.live || (e.live === primary.live && (e.rows > primary.rows || (e.rows === primary.rows && e.orders > primary.orders)))) primary = e;
  }
  return { list, primary, from };
}

const median = (list) => {
  const v = (list || []).filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x)) && Number(x) > 0);
  return v.length ? U.median(v) : null;
};

// The median of finite values, zeros kept (a sell chance of 0 is an answer); null when none.
function medianAny(list) {
  const a = (list || []).filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return round3(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
}

/* ------------------------------------ run ------------------------------------ */

function startRun(bundle, { cfg, prior } = {}) {
  if (!bundle || typeof bundle !== "object") throw new Error("listing brain: no bundle to compute from");
  const C = cfg && typeof cfg === "object" ? Object.assign({}, U.readConfig(bundle.af || {}), cfg) : U.readConfig(bundle.af || {});
  return { bundle, cfg: C, prior: prior instanceof Map ? prior : new Map(), notes: [] };
}

function phaseEvidence(st) {
  st.ev = E.buildEvidence(st.bundle, { cfg: st.cfg, cut: num(st.bundle.now, 0) });
  st.notes.push(...st.ev.notes);
}
async function phaseEvidenceAsync(st, y) {
  st.ev = await E.buildEvidenceAsync(st.bundle, { cfg: st.cfg, cut: num(st.bundle.now, 0), yielder: y });
  st.notes.push(...st.ev.notes);
}

function phaseFit(st) {
  fitDone(st, { claim: H.fitHazard(st.ev, "claim"), noclaim: H.fitHazard(st.ev, "noclaim") });
}

/** The same fit, yielding inside each farm's row loop on the run's budget (P20-4). */
async function phaseFitAsync(st, y) {
  const claim = await H.fitHazardAsync(st.ev, "claim", { yielder: y });
  if (y.due()) await y.now();
  const noclaim = await H.fitHazardAsync(st.ev, "noclaim", { yielder: y });
  fitDone(st, { claim, noclaim });
}

function fitDone(st, hz) {
  const ev = st.ev;
  st.hz = hz;
  st.ctx = { ev, hz: st.hz, prior: st.prior, gameStates: ev._gs, placements: new Map(), cfg: st.cfg };
  st.groups = ev.gameFarms.map((gf) => ({ g: gf.g, f: gf.f, gl: gf.gl }));
}

/** Price every offer of one game × farm on every market that may show a cell. */
function priceGroup(st, grp) {
  const { ev, ctx, bundle } = st;
  const { g, f } = grp;
  const gs = P.gameState(ev, g, f);
  const ids = identities(ev, g, f);
  grp.gs = gs;
  grp.ids = ids;
  const pr = ids.primary;
  const refByM = {};
  if (pr) for (const m of MARKETS) refByM[m] = RF.refFor(ev, { g, f, m, ck: pr.ck, bk: pr.bk, ex: pr.ex, n: pr.n, band: pr.band });
  grp.refByM = refByM;
  grp.elig = PL.eligibility(ev, g, f, refByM);
  grp.cells = {};
  for (const m of MARKETS) {
    const rows = ev.rowsByCell.get(g + "|" + f + "|" + m) || [];
    const liveSys = rows.filter((r) => r.system && r.activeAtCut);
    const byId = new Map();
    // only rows the brain may advise on get an action (a blocked market's live rows are history)
    for (const r of liveSys) {
      if (!r.advisable) continue;
      const k = identKey(r);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(r);
    }
    const verdicts = [];
    const defer = f === "noclaim";
    for (const k of [...byId.keys()].sort()) {
      const list = byId.get(k);
      const r0 = list.slice().sort((a, b) => b.c - a.c || U.cmp(a.id, b.id))[0];
      const id = { key: k, ck: r0.ex ? r0.ck : null, rawCk: r0.ck, bk: r0.bk, ex: !!(r0.ex && r0.ck), n: r0.n, band: r0.band };
      const np = newBase(bundle, g, f, m, id);
      const v = P.priceOffer(ctx, { g, f, m, ck: id.ck, bk: id.bk, ex: id.ex, n: id.n, band: id.band, live: list, base: null, np, ladder: !!id.ck && ev.ladders.has(m + "|" + id.ck), defer });
      v.ident = id;
      v.np = np;
      verdicts.push(v);
    }
    const cls = grp.elig[m].cls;
    if (pr && !byId.has(pr.key) && (cls === "open" || cls === "unknown" || cls === "unmeasured")) {
      const base = newBase(bundle, g, f, m, pr);
      // an offer the owner runs as a ladder here is left alone as a new listing too (N7)
      const ladder = !!pr.ck && ev.ladders.has(m + "|" + pr.ck);
      const v = P.priceOffer(ctx, { g, f, m, ck: pr.ck, bk: pr.bk, ex: pr.ex, n: pr.n, band: pr.band, live: null, base, np: base, ladder, defer });
      v.ident = pr;
      v.np = base;
      v.isNew = true;
      verdicts.push(v);
    }
    if (defer && verdicts.length) P.applyContainment(ctx, verdicts);
    grp.cells[m] = { m, rows, liveSys, verdicts };
  }
}

function phaseCells(st, from = 0, to = Infinity) {
  const end = Math.min(st.groups.length, to);
  for (let i = from; i < end; i++) priceGroup(st, st.groups[i]);
}

/** The cell's main verdict: most live rows, then the game's main offer, then its key. */
function mainVerdict(cell, pr) {
  let best = null;
  for (const v of cell.verdicts) {
    if (!best) {
      best = v;
      continue;
    }
    const a = v.live.length;
    const b = best.live.length;
    if (a > b || (a === b && pr && v.ident.key === pr.key && best.ident.key !== pr.key)) best = v;
  }
  return best;
}

const slimOffer = (v) => ({
  k: v.k,
  f: v.f,
  m: v.m,
  ck: v.ck,
  bk: v.bk,
  n: v.n,
  live: v.live.map((r) => ({ id: r.id, ask: r.ask, ageDays: r.ageDays, a: r.a, p: r.p, p7a: r.p7a === null ? null : round3(r.p7a), stale: !!r.stale })),
  p: v.p,
  raw: v.raw,
  ref: v.ref,
  conf: v.conf,
  basis: v.basis,
  regime: v.regime,
  tier: v.tier,
  pH: v.pH === null ? null : round3(v.pH),
  pHask: v.pHask === null ? null : round3(v.pHask),
  value: v.value === null ? null : round3(v.value),
  valueAsk: v.valueAsk === null ? null : round3(v.valueAsk),
  action: v.action,
  gates: v.gates.slice(),
  thin: v.thin,
  stale: v.stale,
  why: U.shortWhy(v.why),
  base: v.base,
  np: v.np === undefined ? null : v.np,
  test: v.test,
  isNew: !!v.isNew,
  h: round3(v.H),
  fl: v.flags.slice(),
});

/** Place one game × farm and lay out its cell rows, its "all" row, its offers and its forecasts. */
function placeGroup(st, grp) {
  const out = { offers: [], fc: [] };
  const { ev, ctx, bundle, cfg } = st;
  const { g, f, gs } = grp;
  const fees = bundle.fees || {};
  const pr = grp.ids.primary;
  const nets = {};
  const prices = {};
  const cur = {};
  for (const m of MARKETS) {
    const cell = grp.cells[m];
    cur[m] = cell.liveSys.reduce((a, r) => a + E.shelfUnits(r), 0);
    const v = pr ? cell.verdicts.find((x) => x.ident.key === pr.key) : cell.verdicts[0];
    const price = v ? (v.p !== null ? v.p : v.base !== null ? v.base : null) : null;
    if (price !== null) {
      prices[m] = price;
      nets[m] = U.netOf(price, m, fees);
    }
  }
  const og = bundle.old && bundle.old.games && bundle.old.games[g];
  const oldShelf = f === "claim" ? (og && og.flat ? Object.assign({}, og.flat) : null) : Object.assign({}, cur);
  const bulkMarkets = ((bundle.bulk && bundle.bulk.markets) || []).map(lower);
  const pl = PL.placeGame(ctx, { g, f, stock: gs.on, nets, prices, elig: grp.elig, refByM: grp.refByM, cur, oldShelf });
  ctx.placements.set(g + "|" + f, pl);

  const gl = grp.gl || g;
  let oldSum = 0;
  let oldKnown = false;
  let curSum = 0;
  const rowsOut = [];
  for (const m of MARKETS) {
    const cell = grp.cells[m];
    const mk = ev.markets[m];
    const el = grp.elig[m];
    const brSh = pl.unknown ? null : el.cls === "open" ? num(pl.shelf[m], 0) : el.cls === "managed" ? null : 0;
    const oldSh = f === "claim" ? (og ? (og.flat && og.flat[m] !== undefined ? num(og.flat[m], 0) : 0) : null) : cur[m];
    const orders = (ev.idx.byGFM.get(g + "|" + f + "|" + m) || []).length;
    const ownerLive = cell.rows.filter((r) => (r.rk === "hand" || r.rk === "cas") && r.activeAtCut);
    const anyRow = cell.rows.some((r) => r.rk === "system" || r.rk === "hand" || r.rk === "cas");
    if (!(anyRow || orders > 0 || num(oldSh, 0) > 0 || num(brSh, 0) > 0)) continue;
    if (oldSh !== null) {
      oldSum += num(oldSh, 0);
      oldKnown = true;
    }
    curSum += cur[m];
    const main = mainVerdict(cell, pr);
    const ladder = cell.verdicts.some((v) => v.ladder);
    const managed = (f === "noclaim" && !U.NOCLAIM_SHELF.has(m)) || mk.blocked || mk.off || (!cell.liveSys.length && ownerLive.length > 0 && !(num(brSh, 0) > 0));
    const liveActs = [];
    for (const v of cell.verdicts) for (const r of v.live) liveActs.push(r);
    const oldA = median(cell.liveSys.map((r) => r.ask));
    const np = main ? (main.np !== undefined ? main.np : main.base) : pr ? newBase(bundle, g, f, m, pr) : null;
    // The cell's brain price, like with like against today's median ask (M11): every advised live row
    // counts, a row the brain leaves where it is at its own ask — but only when the brain priced at least
    // one of them: with none, the cell has no brain price (N4; a median of asks alone would read
    // "agree"). A deliberate ladder gets none (M13a); a blocked or switched-off market none at all.
    const offMarket = mk.blocked || mk.off;
    const advised = liveActs.filter((r) => r.a !== "ladder" && ev.byId.get(r.id) && ev.byId.get(r.id).advisable);
    const priced = advised.some((r) => r.p !== null && r.p !== undefined);
    let brP;
    if (offMarket) brP = null;
    else if (cell.liveSys.length) brP = priced ? median(advised.map((r) => (r.p !== null && r.p !== undefined ? r.p : r.ask))) : null;
    else brP = main ? main.p : null;
    const oldP = cell.liveSys.length ? oldA : np;
    const unknown = gs.unknown;
    const pc = priceClass(oldP, unknown ? null : brP, { managed, ladder, cfg });
    // a no-claim shelf under a cap the owner set is the owner's lever: shown, classed managed
    const capManaged = f === "noclaim" && pl.managed && U.NOCLAIM_SHELF.has(m);
    const sc = shelfClass(oldSh, brSh, { elig: el.cls, managed: (managed || capManaged) && el.cls !== "closed" && el.cls !== "unmeasured" });
    const acts = { hold: 0, lower: 0, raise: 0, test: 0, ladder: 0 };
    for (const r of liveActs) if (acts[r.a] !== undefined) acts[r.a]++;
    const sysRows = cell.rows.filter((r) => r.system);
    let s = 0;
    let d = 0;
    for (const r of sysRows) {
      s += r.expo.units;
      d += r.expo.days;
    }
    const scr = cell.rows.filter((r) => r.script).length;
    const fl = [];
    if (!mk.feeVerified) fl.push("fee-assumed");
    if (!U.RADAR_MARKETS[m]) fl.push("blind");
    if (ladder) fl.push("ladder");
    if (managed) fl.push("managed");
    if (main && main.thin) fl.push("thin");
    if (mk.blocked) fl.push("blocked");
    else if (mk.off) fl.push("off");
    if (scr) fl.push("script");
    if (cell.verdicts.some((v) => v.flags.includes("setmin"))) fl.push("setmin");
    // bulk-anchor per SET (C8): a single row's price anchors the next pack of the same set here
    const anchorOf = (v) => bulkMarkets.includes(m) && !!v.ck && ev.bulk.liveCk.has(m + "|" + v.ck);
    if (cell.verdicts.some(anchorOf)) fl.push("bulk-anchor");
    if (m === "gameflip" && pl.flags.includes("anchor")) fl.push("anchor");
    if (m === "ggsel" && pl.flags.includes("noRemove")) fl.push("noRemove");
    if (pl.explore === m) fl.push("explore");
    if (m === "eldorado" && pl.flags.includes("eld-limit")) fl.push("eld-limit");
    if (cell.rows.some((r) => r.system && r.st === "active" && !r.activeAtCut && r.m === "gameflip")) fl.push("expired");
    const why = [];
    if (unknown) why.push(gs.why);
    else if (main) why.push(...main.why);
    if (el.why && el.cls !== "open") why.push(el.why);
    if (liveActs.length) {
      const moves = LIVE_ACTIONS.filter((a) => acts[a] > 0).map((a) => acts[a] + " " + a);
      why.push("Live rows: " + moves.join(", ") + ".");
    }
    const pf = {};
    const pd = {};
    for (const p of PLACE_POLICIES) {
      const pol = pl.policies[p];
      pf[p] = pol && pol.fc && pol.fc[m] !== undefined ? pol.fc[m] : null;
      // each policy's weekly demand split for this market, uncapped (the scorer's H1 number)
      pd[p] = pol && pol.lambda ? num(pol.lambda[m], 0) : null;
    }
    // the other policies' prices are logged only through the same gates (M2); with no verdict there is
    // no evidence to gate by, so only today's own price is shown, at its floor
    // (no tracker or rival price on a market the owner blocked or switched off — N8)
    const tr = main && !offMarket ? trackerOf(bundle, m, main.ident) : null;
    const gp = (price, o) => (main ? P.gatePolicy(ctx, main, price, Object.assign({ live: cell.liveSys.length > 0 }, o)) : null);
    const clearRaw = main && !offMarket ? RF.clearPrice(ev, g, main.n, m, cfg.minSales) : null;
    const pol = {
      // today's price is its own base: only the floors, the no-claim ceiling and the sold floor apply to
      // it — gated against the main offer's base it moved a whole step, and no longer was today's (N3)
      old: oldP === null ? null : main ? gp(oldP, { basis: "old", base: oldP }) : round2(Math.max(oldP, mk.floor)),
      tracker: tr ? gp(tr.price, { basis: tr.basis, conf: tr.conf }) : null,
      curve: unknown || offMarket ? null : brP,
      clear: clearRaw === null ? null : gp(clearRaw, { basis: "rivals", conf: "low" }),
    };
    const tierP = main ? main.tier : gs.tier;
    const row = {
      k: g,
      g: gl,
      f,
      m,
      live: gs.live,
      hl: gs.hl === null ? null : round2(gs.hl),
      pc,
      sc,
      old: { a: oldA, n: cur[m], np, sh: oldSh, cur: cur[m] },
      br: {
        p: unknown ? null : brP,
        ref: main ? main.ref : null,
        cf: main ? main.conf : "none",
        b: main ? main.basis : "none",
        rg: gs.regime,
        p7: main && main.pH !== null && !unknown ? round3(main.pH) : null,
        p7a: medianAny(liveActs.map((r) => r.p7a)),
        wv: main && main.value !== null && !unknown ? round3(main.value) : null,
        wva: main && main.valueAsk !== null ? round3(main.valueAsk) : null,
        sh: brSh,
        // the same placement with every fee equal (fees rank markets; five are assumptions)
        she: pl.unknown || el.cls !== "open" ? null : num(pl.shEq[m], 0),
        t: tierP,
        a: acts,
      },
      pol,
      pf,
      pd,
      ev: { o: orders, s, d: round2(d), thin: !!(main && main.thin), el: el.cls, fee: mk.feeVerified ? "verified" : "assumed", blind: !U.RADAR_MARKETS[m] },
      fl,
      why: U.shortWhy(why),
    };
    if (scr) row.ev.scr = scr;
    rowsOut.push(row);
    for (const v of cell.verdicts) {
      const so = slimOffer(v);
      // a claim event bundle (the loader's mark): today it is priced by the event-bundle pricer
      const oo = oldOfferOf(bundle, m, v.ident);
      if (oo && oo.eb === true) so.eb = true;
      // a single listing's price anchors the next pack's (bulkPacks/pricing.pickAnchor): show the packs
      if (anchorOf(v)) {
        so.fl = so.fl.concat("bulk-anchor");
        if (so.p !== null) so.packs = packPrices(bundle, m, so.p);
      }
      out.offers.push(so);
      for (const r of v.live) {
        const R = ev.byId.get(r.id);
        if (!R || !R.advisable) continue;
        const x = v.ref > 0 ? R.ask / v.ref : null;
        // pb: the market's base rate over the same days — the scorer's baseline, logged at forecast time (H8)
        out.fc.push({
          l: r.id,
          k: g,
          f,
          m,
          x: x === null ? null : round3(x),
          b: x === null ? null : U.bucketOf(x),
          p: r.p7a === null ? null : round3(r.p7a),
          pb: r.pb === null || r.pb === undefined ? null : round3(r.pb),
          a: r.a,
          ask: R.ask,
          h: round3(r.h !== undefined ? r.h : v.H),
        });
      }
    }
  }
  // the game × farm line: its whole shelf, the reserve, bulk's take and the regime
  const total = pl.unknown ? null : MARKETS.reduce((a, m) => a + (grp.elig[m].cls === "open" ? num(pl.shelf[m], 0) : 0), 0);
  const allFl = pl.flags.slice();
  if (f === "noclaim" && pl.managed) allFl.push("managed");
  if (gs.unknown) allFl.push("unknown");
  const all = {
    k: g,
    g: gl,
    f,
    m: "all",
    live: gs.live,
    hl: gs.hl === null ? null : round2(gs.hl),
    pc: "",
    sc: "",
    old: { sh: oldKnown ? oldSum : null, cur: curSum },
    br: {
      sh: total,
      rsv: pl.unknown ? null : pl.reserve,
      bt: pl.unknown ? null : pl.bulkTake,
      ex: pl.explore,
      rg: gs.regime,
      w: gs.w,
      on: gs.on,
      cov: gs.cover === null ? null : gs.cover === Infinity ? null : round2(gs.cover),
    },
    pol: {},
    pf: {},
    ev: { stock: pl.stock, src: grp.ids.from, offers: grp.ids.list.length },
    fl: allFl,
    why: U.shortWhy(gs.regimeWhy.concat(pl.why)),
  };
  if (f === "noclaim") {
    all.old.cap = pl.cap;
    all.old.capExplicit = pl.managed;
  }
  // rule 3's old side (C7): half now, half later at the post-event price — today's numbers beside the brain's
  if (f === "claim" && og) {
    all.old.post = num(og.post) > 0 ? round2(og.post) : null;
    all.old.now = og.split && Number.isFinite(Number(og.split.listNow)) ? Number(og.split.listNow) : null;
    all.old.hold = og.split && Number.isFinite(Number(og.split.holdBack)) ? Number(og.split.holdBack) : null;
  }
  return { rows: rowsOut, all, offers: out.offers, fc: out.fc };
}

function phasePlacement(st, from = 0, to = Infinity) {
  if (!st.out) st.out = { rows: [], offers: [], fc: [], cut: false };
  const end = Math.min(st.groups.length, to);
  for (let i = from; i < end; i++) {
    const grp = st.groups[i];
    const r = placeGroup(st, grp);
    if (st.out.rows.length + r.rows.length + 1 > MAX_CELLS) {
      if (!st.out.cut) st.notes.push("More than " + MAX_CELLS + " cells: the rest of the games were not logged this run.");
      st.out.cut = true;
      continue;
    }
    st.out.rows.push(...r.rows, r.all);
    st.out.offers.push(...r.offers);
    st.out.fc.push(...r.fc);
  }
}

function phaseSummary(st) {
  const summary = summarize(st.out.rows, { fc: st.out.fc.length });
  const ctx = Object.assign(st.ctx, { gameStates: st.ev._gs });
  return { rows: st.out.rows, offers: st.out.offers, fc: st.out.fc, summary, ctx, notes: st.notes };
}

/**
 * One run of the model, synchronous.
 * @param {object} bundle  plan §2.1
 * @param {object} [o]     { cfg: readConfig(), prior: Map(listing id → { a, at }) — the cool-down }
 * @returns {{ rows, offers, fc, summary, ctx, notes }}
 */
function buildRun(bundle, opts = {}) {
  const st = startRun(bundle, opts);
  phaseEvidence(st);
  phaseFit(st);
  phaseCells(st);
  phasePlacement(st);
  return phaseSummary(st);
}

/**
 * The same run, letting the event loop breathe on a time budget: between phases (evidence → fit →
 * cells → placement → summary), inside the evidence, and between games whenever YIELD_MS has passed
 * (P20-4). The output is identical to buildRun's.
 */
async function buildRunAsync(bundle, opts = {}) {
  const st = startRun(bundle, opts);
  const y = U.makeYielder(YIELD_MS);
  await y.now();
  await phaseEvidenceAsync(st, y);
  await y.now();
  await phaseFitAsync(st, y);
  await y.now();
  for (let i = 0; i < st.groups.length; i++) {
    phaseCells(st, i, i + 1);
    if (y.due()) await y.now();
  }
  await y.now();
  for (let i = 0; i < st.groups.length; i++) {
    phasePlacement(st, i, i + 1);
    if (y.due()) await y.now();
  }
  if (!st.out) st.out = { rows: [], offers: [], fc: [], cut: false };
  await y.now();
  return phaseSummary(st);
}

/* --------------------------------- summary ---------------------------------- */

const COMPARED_SHELF = new Set(["agree", "brain-more", "brain-fewer", "brain-add", "brain-drop"]);

/**
 * Counts and totals of one run's rows, per farm. Totals compare like with like: a shelf total counts
 * only cells where both sides have a number, a value total only cells with live stock valued at both
 * prices; a cell the brain cannot judge is counted apart, never as zero.
 */
function summarize(rows, { fc = 0 } = {}) {
  const farm = () => ({
    byPrice: Object.fromEntries(PRICE_CLASSES.map((c) => [c, 0])),
    byShelf: Object.fromEntries(SHELF_CLASSES.map((c) => [c, 0])),
    actions: { hold: 0, lower: 0, raise: 0, test: 0, ladder: 0 },
    regimes: Object.fromEntries(REGIMES.map((r) => [r, 0])),
    shelf: { old: 0, brain: 0, reserve: 0, bulkTake: 0, compared: 0, unknownCells: 0, oldUnknown: 0 },
    value: { old: 0, brain: 0, compared: 0 },
    cells: 0,
    games: 0,
  });
  const by = { claim: farm(), noclaim: farm() };
  const flags = {};
  for (const r of rows || []) {
    const s = by[r.f === "noclaim" ? "noclaim" : "claim"];
    for (const fl of r.fl || []) flags[fl] = (flags[fl] || 0) + 1;
    if (r.m === "all") {
      s.games++;
      s.regimes[r.br.rg] = (s.regimes[r.br.rg] || 0) + 1;
      if (r.br.rsv !== null && r.br.rsv !== undefined) s.shelf.reserve += num(r.br.rsv);
      if (r.br.bt !== null && r.br.bt !== undefined) s.shelf.bulkTake += num(r.br.bt);
      continue;
    }
    s.cells++;
    s.byPrice[r.pc] = (s.byPrice[r.pc] || 0) + 1;
    s.byShelf[r.sc] = (s.byShelf[r.sc] || 0) + 1;
    for (const a of LIVE_ACTIONS) s.actions[a] += num(r.br.a && r.br.a[a]);
    if (COMPARED_SHELF.has(r.sc)) {
      s.shelf.compared++;
      s.shelf.old += num(r.old.sh);
      s.shelf.brain += num(r.br.sh);
    } else if (r.sc === "unknown") {
      s.shelf.unknownCells++;
      s.shelf.oldUnknown += num(r.old.sh);
    }
    if (num(r.old.n) > 0 && r.br.wv !== null && r.br.wva !== null && r.br.wv !== undefined && r.br.wva !== undefined) {
      s.value.compared++;
      s.value.old += num(r.old.n) * num(r.br.wva);
      s.value.brain += num(r.old.n) * num(r.br.wv);
    }
  }
  for (const s of Object.values(by)) {
    s.value.old = round2(s.value.old);
    s.value.brain = round2(s.value.brain);
  }
  const pick = (k) => ({ claim: by.claim[k], noclaim: by.noclaim[k] });
  return {
    cells: by.claim.cells + by.noclaim.cells,
    games: by.claim.games + by.noclaim.games,
    byPrice: pick("byPrice"),
    byShelf: pick("byShelf"),
    actions: pick("actions"),
    regimes: pick("regimes"),
    shelf: pick("shelf"),
    value: pick("value"),
    flags,
    fc,
  };
}

/* ---------------------------------- outputs --------------------------------- */

const reasons = (list) => U.shortWhy(list);

/**
 * A Map over the run's own memo whose additions are the caller's (P20-14): reads fall through to the
 * run's entries; what a caller's question adds is kept here, least recently used first out, so
 * thousands of priceFor calls never grow the newest run's memory.
 */
class CallerMemo {
  constructor(base, cap) {
    this.base = base;
    this.own = new Map();
    this.cap = cap;
  }
  has(k) {
    return this.own.has(k) || this.base.has(k);
  }
  get(k) {
    if (this.own.has(k)) {
      const v = this.own.get(k);
      this.own.delete(k);
      this.own.set(k, v);
      return v;
    }
    return this.base.get(k);
  }
  set(k, v) {
    this.own.delete(k);
    this.own.set(k, v);
    if (this.own.size > this.cap) this.own.delete(this.own.keys().next().value);
    return this;
  }
  get size() {
    return this.base.size + this.own.size;
  }
}

/** The run's context for callers' questions: the run's evidence and fit, with a bounded memo of its own. */
function callerCtx(run) {
  const ctx = run.ctx;
  if (!ctx._caller) {
    // a shallow copy (once per run): the same rows, indexes and fit, the memo maps wrapped
    const ev = Object.assign({}, ctx.ev, {
      _ref: new CallerMemo(ctx.ev._ref, CALLER_MEMO_MAX),
      _memo: new CallerMemo(ctx.ev._memo, CALLER_MEMO_MAX),
      _gs: new CallerMemo(ctx.ev._gs, CALLER_MEMO_MAX),
    });
    ctx._caller = Object.assign({}, ctx, { ev });
  }
  return ctx._caller;
}

/**
 * How old the run is at `now`, and whether it is too old to answer from (M7): older than twice the
 * interval between runs, or than the farm-brain rows it read may be. No `now`: not checked.
 */
function staleRun(run, now) {
  const t = finite(now);
  if (t === null || !run || !run.ctx || !run.ctx.ev) return null;
  const cfg = run.ctx.cfg || DEFAULTS;
  const age = t - num(run.ctx.ev.cut, t);
  const limit = Math.max(2 * num(cfg.intervalMin, DEFAULTS.intervalMin) * 60000, num(cfg.maxDemandAgeH, DEFAULTS.maxDemandAgeH) * U.HOUR);
  return age > limit ? "The newest run is " + Math.round(age / U.HOUR) + " h old: no advice from it." : null;
}

/** A finite number or null (a string, NaN, Infinity is no number). */
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A caller's base price as a number, the way its caller reads it (attach.priceForNew: Number(base)):
 * a number, or a numeric string ("2.50") — N9. Anything else (null, a boolean, "", "abc") is none.
 */
function baseNumber(v) {
  if (typeof v === "number") return finite(v);
  if (typeof v !== "string" || !v.trim()) return null;
  return finite(Number(v));
}

/**
 * Every answer that passes today's price through still obeys today's limits (M8): never under the floor
 * (the platform's, the game's learned GGSel minimum, the owner's no-claim floors), never over the
 * no-claim ceiling.
 */
function clampToLimits(run, price, m, f, g) {
  if (price === null) return null;
  let lo = MARKETS.includes(m) ? U.floorFor(m) : 0;
  let hi = Infinity;
  const ev = run && run.ctx && run.ctx.ev;
  if (ev && g) {
    if (m === "ggsel" && ev.ggselVmin && ev.ggselVmin.has(g)) lo = Math.max(lo, ev.ggselVmin.get(g));
    if (f === "noclaim") {
      const lim = P.noclaimLimits(ev, g);
      lo = Math.max(lo, lim.floor);
      hi = lim.ceiling;
    }
  }
  return round2(Math.max(lo, Math.min(hi, price)));
}

/**
 * The brain's price for a new listing (plan §4.8): the question priceTracker/attach.priceForNew asks.
 * Fail-safe: no run, a run too old, an unknown game or market, a blocked market, a no-claim offer the
 * owner runs (claim-at-sale markets), no evidence → today's price with confidence "none". Below medium
 * confidence the brain's own rule is hold: today's price is kept. Today's price always within today's
 * limits (floors, no-claim ceiling). An invalid base answers price 0, confidence "none": the brain
 * never invents a price without one (M8).
 * @param {object} q { marketplace, basePriceUsd, title, game, itemCount, items, farm? }
 * @param {object} [o] { now } — the moment asked at; a run older than allowed abstains (M7)
 */
function priceForRun(run, q = {}, { now } = {}) {
  const b0 = baseNumber(q && q.basePriceUsd);
  const m = lower(q && q.marketplace);
  const f = q && q.farm === "noclaim" ? "noclaim" : "claim";
  if (b0 === null || !(b0 > 0) || b0 > U.MAX_REAL_PRICE) {
    return { price: 0, confidence: "none", basis: "invalid base", regime: "unknown", reasons: reasons(["No valid base price was given (a positive number up to $" + U.MAX_REAL_PRICE + "): no price."]) };
  }
  const base = round2(b0);
  let g = "";
  const pass = (why, extra = {}) => Object.assign({ price: clampToLimits(run, base, m, f, g), confidence: "none", basis: "none", regime: "unknown", reasons: reasons([why]) }, extra);
  try {
    if (!run || !run.ctx || !run.ctx.ev) return pass("No listing-brain run in memory: today's price.");
    const stale = staleRun(run, now);
    if (stale) return pass(stale);
    const ctx = callerCtx(run);
    const ev = ctx.ev;
    if (!MARKETS.includes(m)) return pass("Unknown market: today's price.");
    const items = Array.isArray(q.items) ? q.items.filter((i) => i && i.itemKey) : [];
    const title = q.title || String(q.game || "") + " Twitch Drops" + (q.itemCount ? " (" + q.itemCount + " Items)" : "");
    const id = identify({ title }, items.length ? { items } : null);
    g = id.gameKey || normGame(q.game);
    if (ev.markets[m].blocked) return pass("Market blocked by the owner: no brain price.");
    if (ev.markets[m].off) return pass("The owner's switch for this market is off: no brain price.");
    // no-claim offers on Eldorado / PlayerAuctions / G2G are claim-at-sale: the owner's (M6)
    if (f === "noclaim" && !U.NOCLAIM_SHELF.has(m)) return pass("No-claim offers on " + m + " are claim-at-sale, the owner's: no brain price.", { basis: "managed" });
    if (!g) return pass("No game named: today's price.");
    const gs = P.gameState(ev, g, f);
    if (gs.unknown) return pass(gs.why);
    const ck = id.exact ? id.contentKey : null;
    // Priced afresh against THIS base (the run's offers are gated against their live asks: reusing one
    // could answer under the caller's base on GGSel). The fitted curve, the regime and the references
    // are the run's. (A query carries items, not a no-claim bundle key: the bundle order has nothing to
    // compare it to.)
    const band = String(id.bandKey).slice(String(id.bandKey).lastIndexOf("|") + 1);
    const n = id.countForBand;
    const v = P.priceOffer(ctx, { g, f, m, ck, bk: id.bandKey, ex: !!ck, n, band, live: null, base, np: base, ladder: false });
    const policy = ctx.cfg.policyPrice;
    if (policy === "old" || policy === "tracker") return pass("The " + policy + " policy answers today's price.", { basis: policy, regime: v.regime });
    let price = v.p;
    let conf = v.conf;
    let basis = v.basis;
    if (policy === "clear") {
      // a rival's sold price through the same gates: it never raises (M2)
      price = P.gatePolicy(ctx, v, RF.clearPrice(ev, g, n, m, ctx.cfg.minSales), { basis: "rivals", conf: "low" });
      conf = "low";
      basis = "clear";
    }
    if (price === null || price === undefined || !(price > 0)) return pass("No evidenced price for this offer here: today's price.", { regime: v.regime });
    if (CONF_RANK[conf] < CONF_RANK.medium) {
      return pass("The brain would ask " + U.usd(price) + " on " + conf + " confidence; below medium it keeps today's price.", { confidence: conf, basis, regime: v.regime, reasons: reasons(["The brain would ask " + U.usd(price) + " on " + conf + " confidence; below medium it keeps today's price."].concat(v.why || [])) });
    }
    return { price: round2(price), confidence: conf, basis, regime: v.regime, reasons: reasons(v.why || []) };
  } catch (e) {
    return pass("Listing brain error: " + String((e && e.message) || e).slice(0, 120));
  }
}

/**
 * The brain's shelf for a game's stock (plan §4.8): what computeSplit + dealShares decide today.
 * Fail-safe (no run, a run too old, an unknown game, a no-claim game under a cap the owner set): no
 * shelf advice — `shelf` is empty and every unit stays in `reserve`, so a caller keeps today's split.
 * @param {object} q { game, farm, stock }
 * @param {object} [o] { now }
 */
function shelfForRun(run, q = {}, { now } = {}) {
  const stock = Math.max(0, Math.floor(num(q && q.stock, 0)));
  const fail = (why, basis = "none") => ({ shelf: {}, reserve: stock, bulkTake: 0, explore: null, basis, reasons: reasons([why]) });
  try {
    if (!run || !run.ctx || !run.ctx.placements) return fail("No listing-brain run in memory: no shelf advice.");
    const stale = staleRun(run, now);
    if (stale) return fail(stale);
    const f = q.farm === "noclaim" ? "noclaim" : "claim";
    const g = normGame(q.game);
    let pl = run.ctx.placements.get(g + "|" + f);
    if (!pl) return fail("This game is not in the newest run: no shelf advice.");
    if (pl.unknown) return fail(pl.why[0] || "No fresh farm-brain row: no shelf advice.");
    // the owner set this game's no-claim cap by hand: the shelf is the owner's lever (M5)
    if (pl.managed) return fail("You set this game's no-claim cap by hand: its shelf is yours, no advice.", "managed");
    if (q.stock !== undefined && q.stock !== null && stock !== pl.stock) pl = PL.placeGame(callerCtx(run), Object.assign({}, pl.input, { stock }));
    const policy = run.ctx.cfg.policyPlace;
    const pol = pl.policies[policy];
    const shelf = Object.assign({}, policy === "newsvendor" || !pol || !pol.shelf ? pl.shelf : pol.shelf);
    for (const m of Object.keys(shelf)) if (!(shelf[m] > 0)) delete shelf[m];
    const placed = Object.values(shelf).reduce((a, n) => a + n, 0);
    return {
      shelf,
      reserve: policy === "newsvendor" ? pl.reserve : Math.max(0, stock - pl.bulkTake - placed),
      bulkTake: pl.bulkTake,
      explore: policy === "newsvendor" ? pl.explore : null,
      basis: policy,
      reasons: reasons(pl.why),
    };
  } catch (e) {
    return fail("Listing brain error: " + String((e && e.message) || e).slice(0, 120));
  }
}

/**
 * Expected net per account under the brain's placement and prices (plan §4.8) — for the farm brain's
 * "value per account" later. Each market weighs by the units it is expected to SELL there in a week,
 * E[min(D, shelf)], not by the units it holds (H18: a deep shelf on a slow market is not where accounts
 * turn into money). Claim farm first, else the no-claim farm.
 * @param {object} [o] { farm, now }
 */
function valueForRun(run, gameKey, { farm, now } = {}) {
  const fail = (why) => ({ value: null, shares: {}, nets: {}, basis: "none", reasons: reasons([why]) });
  try {
    if (!run || !run.ctx || !run.ctx.placements) return fail("No listing-brain run in memory.");
    const stale = staleRun(run, now);
    if (stale) return fail(stale);
    const g = normGame(gameKey);
    const pl = (farm ? [farm] : ["claim", "noclaim"]).map((f) => run.ctx.placements.get(g + "|" + f)).find(Boolean);
    if (!pl) return fail("This game is not in the newest run.");
    if (pl.unknown) return fail("No fresh farm-brain row for this game.");
    const w = {};
    let total = 0;
    for (const m of MARKETS) {
      const n = num(pl.shelf[m], 0);
      if (!(n > 0) || !(num(pl.input.nets[m]) > 0)) continue;
      const sells = U.expectedSold(num(pl.lambda[m], 0), n);
      if (!(sells > 0)) continue;
      w[m] = sells;
      total += sells;
    }
    if (!(total > 0)) return fail("The brain expects none of this game's shelved stock to sell: no value per account.");
    const shares = {};
    const nets = {};
    let value = 0;
    for (const m of Object.keys(w)) {
      shares[m] = round3(w[m] / total);
      nets[m] = round2(pl.input.nets[m]);
      value += (w[m] / total) * pl.input.nets[m];
    }
    return { value: round2(value), shares, nets, basis: "newsvendor", reasons: [] };
  } catch (e) {
    return fail("Listing brain error: " + String((e && e.message) || e).slice(0, 120));
  }
}

/**
 * One heartbeat line per run:
 * "listingBrain: run N (model v1) — claim C cells (P priced: agree a, lower l, higher h, no-evidence n)
 *  shelf old S → brain B (+R reserve) | no-claim … | live rows: hold/lower/raise/test h/l/r/t | Ns"
 */
function heartbeatText(doc, run, persisted, { runs } = {}) {
  const s = (doc && doc.summary) || (run && run.summary) || summarize([]);
  const farmText = (name, k) => {
    const bp = (s.byPrice && s.byPrice[k]) || {};
    const sh = (s.shelf && s.shelf[k]) || {};
    let cells = 0;
    for (const c of PRICE_CLASSES) cells += num(bp[c]);
    const priced = num(bp.agree) + num(bp["brain-lower"]) + num(bp["brain-higher"]);
    return (
      name + " " + cells + " cells (" + priced + " priced: agree " + num(bp.agree) + ", lower " + num(bp["brain-lower"]) + ", higher " + num(bp["brain-higher"]) +
      ", no-evidence " + num(bp["no-evidence"]) + ") shelf old " + num(sh.old) + " → brain " + num(sh.brain) + " (+" + num(sh.reserve) + " reserve)"
    );
  };
  const a = s.actions || {};
  const act = (k) => num(a.claim && a.claim[k]) + num(a.noclaim && a.noclaim[k]);
  const n = runs !== undefined && runs !== null ? runs : 1;
  const secs = doc && Number.isFinite(Number(doc.ms)) ? (Number(doc.ms) / 1000).toFixed(1) : "?";
  const v = doc && doc.v ? doc.v : MODEL_VERSION;
  return (
    "listingBrain: run " + n + " (model v" + v + ") — " + farmText("claim", "claim") + " | " + farmText("no-claim", "noclaim") +
    " | live rows: hold/lower/raise/test " + act("hold") + "/" + act("lower") + "/" + act("raise") + "/" + act("test") + " | " + secs + "s" +
    (persisted === false ? " | NOT LOGGED (write failed)" : "")
  );
}

module.exports = {
  MODEL_VERSION,
  MAX_CELLS,
  DEFAULTS,
  PRICE_CLASSES,
  SHELF_CLASSES,
  PRICE_POLICIES,
  PLACE_POLICIES,
  LIVE_ACTIONS,
  REGIMES,
  readConfig: U.readConfig,
  isOn: U.isOn,
  priceClass,
  shelfClass,
  identities,
  newBase,
  trackerOf,
  packPrices,
  staleRun,
  CALLER_MEMO_MAX,
  buildRun,
  buildRunAsync,
  summarize,
  priceForRun,
  shelfForRun,
  valueForRun,
  heartbeatText,
  // the pieces, for the tests and the scorer
  util: U,
  evidence: E,
  ref: RF,
  hazard: H,
  price: P,
  place: PL,
  // util
  DAY: U.DAY,
  MARKETS: U.MARKETS,
  BUCKET_EDGES: U.BUCKET_EDGES,
  BUCKET_LABELS: U.BUCKET_LABELS,
  BUCKET_CENTRES: U.BUCKET_CENTRES,
  GRID: U.GRID,
  bucketOf: U.bucketOf,
  tierOf: U.tierOf,
  pava: U.pava,
  poissonTail: U.poissonTail,
  poissonTailer: U.poissonTailer,
  expectedSold: U.expectedSold,
  snap05: U.snap05,
  cellKey: U.cellKey,
  parseCellKey: U.parseCellKey,
  // evidence
  buildEvidence: E.buildEvidence,
  buildEvidenceAsync: E.buildEvidenceAsync,
  makeWaveEndOf: E.makeWaveEndOf,
  daysLeftOf: E.daysLeftOf,
  rowKindOf: E.rowKindOf,
  isAdvisable: E.isAdvisable,
  exposureOf: E.exposureOf,
  perOrder: E.perOrder,
  shelfUnits: E.shelfUnits,
  // ref
  refFor: RF.refFor,
  radarBand: RF.radarBand,
  orderStats: RF.orderStats,
  marketP75: RF.marketP75,
  clearPrice: RF.clearPrice,
  // hazard
  fitHazard: H.fitHazard,
  fitHazardAsync: H.fitHazardAsync,
  hazardAt: H.hazardAt,
  pH: H.pH,
  baseP: H.baseP,
  evidenced: H.evidenced,
  expectedDaysToSale: H.expectedDaysToSale,
  rowPH: H.rowPH,
  rankOf: H.rankOf,
  maxEvidencedX: H.maxEvidencedX,
  // price
  gameState: P.gameState,
  candidates: P.candidates,
  priceOffer: P.priceOffer,
  finishOffer: P.finishOffer,
  liveAction: P.liveAction,
  gateChain: P.gateChain,
  gatePolicy: P.gatePolicy,
  rowChance: P.rowChance,
  applyContainment: P.applyContainment,
  soldFloorOf: P.soldFloorOf,
  // place
  eligibility: PL.eligibility,
  placeGame: PL.placeGame,
  marketShares: PL.marketShares,
  greedyFill: PL.greedyFill,
  provenOn: PL.provenOn,
  PLATFORM_LIMITS: PL.PLATFORM_LIMITS,
  horizonFor: P.horizonFor,
  perishDaysOf: P.perishDaysOf,
  stockoutsOf: P.stockoutsOf,
  ordersAtOrAbove: RF.ordersAtOrAbove,
  activeAt: E.activeAt,
  coveredDays: E.coveredDays,
};

// The scorer (model/score.js, built separately) joins the façade when it exists: backtest,
// backtestAsync, forwardScores, decisionReview. Only ITS absence is tolerated — an error inside it, or
// a module it requires that is missing, still throws.
try {
  Object.assign(module.exports, require("./model/score"));
} catch (e) {
  const first = String((e && e.message) || "").split("\n")[0];
  if (!(e && e.code === "MODULE_NOT_FOUND" && first.includes("./model/score"))) throw e;
}
