// The listing brain's evidence (docs/LISTING-BRAIN-PLAN.md §3, §4.1): the bundle, read "as of" one
// moment, into rows with exposure, priced orders, indexes and the translator — once per run.
//
// PURE: no database, no network, no settings, no clock. `cut` is the moment the forecast is made: the
// live run passes the bundle's `now`; the backtest passes earlier cuts and sees nothing dated after.
// The bundle is kept by reference and never mutated.
const { VENUES } = require("../../priceTracker/venues");
const analyze = require("../../priceTracker/analyze");
const { sizeBand } = require("../../priceTracker/setIdentity");
const U = require("./util");

const { DAY, MARKETS, SINGLE, num, lower } = U;

// Rows the auto-lister / no-claim auto-lister made. Everything else is the owner's.
const SYSTEM_ORIGINS = new Set(["auto", "unclaimed"]);
// Sale sources that are demand only, never a price (a hand sale, a shop order).
const NO_PRICE_SRC = new Set(["hand", "shop"]);
// Demand-only records that are the bulk channel (plan §4.5 "bulk first").
const BULK_SRC = new Set(["bulk", "bulk-order"]);
// Statuses that mean a row is still on sale.
const LIVE_STATUS = "active";

/**
 * Kind of a listing, in the plan §3 order (the first match wins): rent-farm, bulk/lot, account,
 * claim-at-sale, system-made, hand-made. Claim-at-sale is checked BEFORE origin: the G2G operator
 * script rows are origin "auto" and claim-at-sale, and are never advised.
 * @returns {"farm"|"bulk"|"lot"|"account"|"cas"|"system"|"hand"}
 */
function rowKindOf(L) {
  const k = lower(L && L.kind);
  if (k === "farm") return "farm";
  if (k === "bulk" || num(L && L.pack) > 1) return "bulk";
  if (k === "lot") return "lot";
  if (k === "account") return "account";
  if (k === "cas") return "cas";
  if (k === "manual") return "hand";
  // anything the loader did not call a plain listing fails closed: the owner's, never advised
  if (k && k !== "single") return "hand";
  return SYSTEM_ORIGINS.has(lower(L && L.o)) ? "system" : "hand";
}

/** A row the brain may advise on: system-made, a plain listing, on a market that is not blocked. */
function isAdvisable(R) {
  return !!R && R.rk === "system" && !R.blocked && MARKETS.includes(R.m);
}

/**
 * One order per buyer order, the earliest unit first (analyze.perOrder's rule on our short keys):
 * a 10-unit Eldorado order is one price, not ten confirmations. A sale with no order key is its own
 * order.
 */
function perOrder(sales) {
  const seen = new Set();
  const out = [];
  let anon = 0;
  for (const s of sales || []) {
    const g = s && s.grp ? "g:" + s.grp : "a:" + anon++;
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(s);
  }
  return out;
}

const finite = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Exposure of one listing inside [cut − fitDays, cut] (plan §4.1). `L` is a bundle listing or a
 * row R; `sales` its unit sales dated before `cut`, sorted by time.
 * - start: createdAt; on quantity / order-unit markets the earliest units[].addedAt when the row has
 *   units and is not claim-at-sale (there addedAt is a delivery record); a rebundled row starts at
 *   rebundledAt — the part before belongs to contents nobody recorded;
 * - end: the first sale on single-unit markets (never updatedAt, which later edits move); else the cut
 *   for a row still live then; else updatedAt (approximate — flagged);
 * - Gameflip expires a listing 30 days after createdAt; Eldorado kills an unsold offer after 21.
 * @returns {{ t0, t1, days, units, endApprox, soldT }}
 */
function exposureOf(L, sales, cut, fitDays, opts = {}) {
  const m = L.m;
  const single = SINGLE.has(m);
  const c = finite(L.c);
  const out = { t0: null, t1: null, days: 0, units: 0, endApprox: false, soldT: null };
  if (c === null) return out;
  const kind = opts.kind || rowKindOf(L);
  let start = c;
  if (!single && kind !== "cas" && Array.isArray(L.units) && L.units.length) {
    let a = Infinity;
    for (const u of L.units) {
      const t = finite(u && u.a);
      if (t !== null && t < a) a = t;
    }
    if (Number.isFinite(a)) start = a;
  }
  const rb = finite(L.rb);
  if (!opts.keepRebundle && rb !== null && rb < cut) start = Math.max(start, rb);
  const list = (sales || []).filter((s) => s.t < cut);
  let soldT = list.length ? list[0].t : null;
  // A single-unit row marked sold with no joined sale record: it did sell, at an unknown moment —
  // its last write is the only date there is (approximate).
  const u = finite(L.u);
  if (single && soldT === null && lower(L.st) === "sold" && u !== null && u < cut) {
    soldT = u;
    out.endApprox = true;
  }
  const active = opts.activeAtCut !== undefined ? opts.activeAtCut : activeAt(L, list, cut);
  let end;
  if (single && soldT !== null) end = soldT;
  else if (active) end = cut;
  else {
    end = u !== null ? u : c;
    out.endApprox = true;
  }
  if (m === "gameflip") end = Math.min(end, c + U.GAMEFLIP_EXPIRY_DAYS * DAY);
  if (m === "eldorado" && !list.length) end = Math.min(end, c + U.ELDORADO_OFFER_LIFE_DAYS * DAY);
  const lo = cut - num(fitDays, 0) * DAY;
  const t0 = Math.max(start, lo);
  const t1 = Math.min(end, cut);
  out.t0 = t0;
  out.t1 = t1;
  out.soldT = soldT;
  out.days = t1 > t0 ? (t1 - t0) / DAY : 0;
  if (out.days > 0) {
    if (single) out.units = soldT !== null && soldT >= t0 && soldT <= t1 ? 1 : 0;
    else for (const s of list) if (s.t >= t0 && s.t <= t1) out.units++;
  }
  return out;
}

/**
 * Was the listing on sale at `cut`? Created before it, and: still active, or its first sale / its
 * end (updatedAt) at or after the cut. A single-unit row that sold before the cut is not; a Gameflip
 * row past its 30-day expiry is not (rows stayed "active" past expiry until 2026-10-01).
 */
function activeAt(L, salesBefore, cut) {
  const c = finite(L.c);
  if (c === null || c >= cut) return false;
  if (L.m === "gameflip" && cut > c + U.GAMEFLIP_EXPIRY_DAYS * DAY) return false;
  const single = SINGLE.has(L.m);
  const sold = (salesBefore || []).length > 0;
  if (single && sold) return false;
  const st = lower(L.st);
  const u = finite(L.u);
  if (st === LIVE_STATUS) return true;
  if (single && st === "sold" && u !== null && u < cut) return false;
  if (u !== null && u >= cut) return true;
  return !!L._saleAfterCut;
}

/** Units on the shelf now for a live system-made row: Gameflip's live unit plus its waiting counter. */
function shelfUnits(R) {
  if (R.m === "gameflip") return 1 + Math.max(0, Math.floor(num(R.qr, 0)));
  if (SINGLE.has(R.m)) return 1;
  const q = finite(R.qty);
  return q === null ? 1 : Math.max(0, Math.floor(q));
}

const bandOf = (bk, n) => {
  const s = String(bk || "");
  const i = s.lastIndexOf("|");
  return i >= 0 ? s.slice(i + 1) : sizeBand(n);
};

function pushTo(map, k, v) {
  let a = map.get(k);
  if (!a) map.set(k, (a = []));
  a.push(v);
}

function marketInfo(bundle) {
  const af = bundle.af || {};
  const takes = af.takes || {};
  const out = {};
  for (const m of MARKETS) {
    const v = VENUES[m] || {};
    const fee = U.feeInfo(m, bundle.fees || {});
    // History-only markets (plan §3, brief §1): Digiseller is blocked in code; the owner's Plati and
    // GGSel switches block the same way. Their orders never teach another market's price.
    const switchedOff = takes[m] === false;
    const blocked = !!v.blocked || (switchedOff && (m === "digiseller" || m === "ggsel"));
    out[m] = {
      m,
      single: SINGLE.has(m),
      blocked,
      // any switch off: no stock, no price there (the other markets' switches still let their history teach)
      off: switchedOff,
      feePct: fee.feePct,
      feeVerified: !!fee.verified,
      feeSource: fee.source,
      floor: U.floorFor(m),
      refillable: U.REFILLABLE.has(m),
      listingNow: U.LISTING_NOW.has(m),
    };
  }
  return out;
}

/**
 * Everything the model reads, as of `cut` — synchronous (the scorer's backtest calls it per week).
 * @param {object} bundle  plan §2.1
 * @param {object} o       { cfg (readConfig), cut (ms; default bundle.now), synthDemand (backtest) }
 */
function buildEvidence(bundle, opts = {}) {
  const it = evidenceSteps(bundle, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** The same, yielding the event loop between its sections (rows, orders, translator, the rest). */
async function buildEvidenceAsync(bundle, opts = {}) {
  const it = evidenceSteps(bundle, opts);
  let r = it.next();
  while (!r.done) {
    await U.yieldNow();
    r = it.next();
  }
  return r.value;
}

// The body, as a generator: each `yield` marks a point where the async run may let the loop breathe.
function* evidenceSteps(bundle, { cfg, cut, synthDemand = false } = {}) {
  const b = bundle || {};
  const C = cfg || U.readConfig({});
  const T = Number.isFinite(Number(cut)) ? Number(cut) : num(b.now, 0);
  const markets = marketInfo(b);
  const notes = [];

  // What kind of row each sale was made on: a rent-farm window's sales are a different product and
  // count as nothing; a pack's or a lot's are demand only (their price is the bulk series, never a
  // single-unit price).
  const kindById = new Map();
  for (const L of b.listings || []) if (L && L.id) kindById.set(String(L.id), rowKindOf(L));
  const kindOfSale = (s) => (s && s.lid ? kindById.get(String(s.lid)) || "" : "");

  // 1. unit sales before the cut, in time order (ties by listing, then price: the order is part of
  //    what perOrder keeps, so it must not depend on how the bundle happened to be sorted)
  const allSales = (b.sales || []).filter((s) => s && Number.isFinite(Number(s.t)) && kindOfSale(s) !== "farm");
  const sorted = allSales.slice().sort((x, y) => x.t - y.t || U.cmp(x.lid, y.lid) || num(x.p) - num(y.p) || U.cmp(x.grp, y.grp));
  const salesBefore = [];
  const salesByListing = new Map();
  const saleAfterCut = new Set();
  for (const s of sorted) {
    if (s.t < T) {
      salesBefore.push(s);
      if (s.lid) pushTo(salesByListing, s.lid, s);
    } else if (s.lid) saleAfterCut.add(s.lid);
  }

  // 2. rows: every listing visible at the cut except rent-farm windows (a different product)
  const rows = [];
  const byId = new Map();
  const rbById = new Map();
  for (const L of b.listings || []) {
    if (!L || !L.id) continue;
    const rk = rowKindOf(L);
    if (rk === "farm") continue;
    const c = finite(L.c);
    if (c === null || c >= T) continue;
    const m = lower(L.m);
    const mk = markets[m];
    const sales = salesByListing.get(L.id) || [];
    const Lx = saleAfterCut.has(L.id) ? Object.assign({}, L, { m, _saleAfterCut: true }) : m === L.m ? L : Object.assign({}, L, { m });
    const activeAtCut = MARKETS.includes(m) ? activeAt(Lx, sales, T) : false;
    const f = L.f === "noclaim" ? "noclaim" : "claim";
    const fitDays = f === "noclaim" ? C.fitDaysNoclaim : C.fitDaysClaim;
    const expo = MARKETS.includes(m) ? exposureOf(Lx, sales, T, fitDays, { kind: rk, activeAtCut }) : { t0: null, t1: null, days: 0, units: 0, endApprox: true, soldT: null };
    const p = num(L.p, 0);
    const vmin = finite(L.vmin);
    const floor = Math.max(mk ? mk.floor : U.floorFor(m), vmin || 0);
    const ex = !!L.ex && !!L.ck;
    const R = {
      id: String(L.id),
      g: String(L.g || ""),
      gl: L.gl || L.g || "",
      m,
      f,
      o: lower(L.o) || "manual",
      kind: L.kind || "single",
      rk,
      script: !!L.script,
      cas: rk === "cas",
      hand: rk === "hand",
      system: rk === "system",
      blocked: !mk || mk.blocked,
      off: !!(mk && mk.off),
      advisable: false,
      ck: L.ck || null,
      bk: L.bk || "",
      ex,
      n: finite(L.n),
      band: bandOf(L.bk, L.n),
      p,
      floor: U.round2(floor),
      // what buyers see: ZeusX and no-claim Plati rows store the price before the connector lifts it
      ask: U.round2(Math.max(p, floor)),
      smin: finite(L.smin),
      vmin,
      st: lower(L.st),
      activeAtCut,
      c,
      u: finite(L.u),
      end: expo.t1,
      endApprox: expo.endApprox,
      ageDays: U.round2((T - c) / DAY),
      qty: finite(L.qty),
      qr: finite(L.qr),
      rb: finite(L.rb),
      pack: finite(L.pack),
      units: Array.isArray(L.units) ? L.units : [],
      sales,
      firstSaleT: sales.length ? sales[0].t : null,
      expo,
    };
    R.advisable = isAdvisable(R);
    rows.push(R);
    byId.set(R.id, R);
    if (R.rb !== null) rbById.set(R.id, R.rb);
  }

  yield;

  // 3. priced orders inside the reference window, one per buyer order
  const refLo = T - C.refDays * DAY;
  const pricedUnits = salesBefore.filter((s) => {
    const p = num(s.p, 0);
    const k = kindOfSale(s);
    return p > 0 && p <= U.MAX_REAL_PRICE && !NO_PRICE_SRC.has(lower(s.src)) && k !== "bulk" && k !== "lot" && MARKETS.includes(lower(s.m)) && s.t >= refLo;
  });
  const orders = perOrder(pricedUnits).map((s) => {
    const rb = s.lid ? rbById.get(s.lid) : undefined;
    const m = lower(s.m);
    return {
      g: String(s.g || ""),
      f: s.f === "noclaim" ? "noclaim" : "claim",
      m,
      ck: s.ex && s.ck ? s.ck : null,
      bk: s.bk || "",
      ex: !!s.ex,
      n: finite(s.n),
      p: num(s.p),
      t: s.t,
      lid: s.lid || "",
      o: lower(s.o),
      basis: s.basis || "",
      src: s.src || "",
      // sold before its row was rebundled: the contents then were not recorded, so it is no evidence
      // for the offer the row holds now (kept for the venue and the game's demand)
      pre: rb !== undefined && rb !== null && s.t < rb,
    };
  });
  const idx = { byM: new Map(), byMCk: new Map(), byMBk: new Map(), byCk: new Map(), byBk: new Map(), byGFM: new Map() };
  for (const o of orders) {
    pushTo(idx.byM, o.m, o);
    pushTo(idx.byGFM, o.g + "|" + o.f + "|" + o.m, o);
    if (o.pre) continue;
    if (o.ck) {
      pushTo(idx.byMCk, o.m + "|" + o.ck, o);
      pushTo(idx.byCk, o.ck, o);
    }
    if (o.bk && !o.bk.endsWith("|?")) {
      pushTo(idx.byMBk, o.m + "|" + o.bk, o);
      pushTo(idx.byBk, o.bk, o);
    }
  }

  yield;

  // 4. the tracker's translator, fed the same sales in its own format. A history-only market's
  //    sales are left out entirely (the translator itself refuses Digiseller; the owner's GGSel switch
  //    must refuse the same way). Junk and demand-only prices read as unpriced. It keeps only priced,
  //    non-hand sales inside its window (analyze.windowed), so only those are converted.
  const adapted = [];
  let anon = 0;
  for (const s of salesBefore) {
    const m = lower(s.m);
    if (markets[m] && markets[m].blocked && !VENUES[m].blocked) continue;
    const p = num(s.p, 0);
    if (!(p > 0 && p <= U.MAX_REAL_PRICE) || NO_PRICE_SRC.has(lower(s.src)) || !(s.t >= refLo)) continue;
    const rb = s.lid ? rbById.get(s.lid) : undefined;
    const pre = rb !== undefined && rb !== null && s.t < rb;
    const grp = s.grp ? String(s.grp) : "anon:" + anon++;
    const k = kindOfSale(s);
    adapted.push({
      market: m || "unknown",
      priceUsd: p,
      at: new Date(s.t),
      priced: p > 0 && p <= U.MAX_REAL_PRICE && k !== "bulk" && k !== "lot",
      source: NO_PRICE_SRC.has(lower(s.src)) ? "hand" : "signal",
      saleGroup: grp,
      key: grp,
      exact: !!s.ex && !!s.ck && !pre,
      contentKey: s.ck || null,
      bandKey: s.bk || "",
      gameKey: s.g || "",
    });
  }
  const tr = analyze.buildTranslator(adapted, T, C.refDays);
  // translate()'s fallback filters every order on each call; the ratio depends only on the two
  // markets, so it is asked once per pair (thousands of offers, 7 × 6 pairs).
  const ratios = new Map();
  const ratio = (from, to) => {
    const k = from + ">" + to;
    if (!ratios.has(k)) {
      const r = tr.translate(1, from, to);
      ratios.set(k, { ratio: r.ratio > 0 ? r.ratio : 0, basis: r.basis, n: r.n || 0 });
    }
    return ratios.get(k);
  };

  yield;

  // 5. the farm brain's newest row per game × farm, fresh enough; or, in a backtest, our own
  //    45-day average at the cut (the farm brain's default estimator)
  const demand = new Map();
  const maxAge = C.maxDemandAgeH * U.HOUR;
  if (!synthDemand) {
    for (const d of b.demand || []) {
      if (!d || !d.k) continue;
      const at = finite(d.at);
      if (at === null || at > T || T - at > maxAge) continue;
      const k = d.k + "|" + (d.f === "noclaim" ? "noclaim" : "claim");
      const prev = demand.get(k);
      if (!prev || at > prev.at) demand.set(k, Object.assign({}, d, { at }));
    }
  }

  // 6. radar: the game rows and the rivals' sale feed, by game × market
  const radar = { byGame: new Map(), feed: new Map() };
  const rg = (b.radar && b.radar.games) || [];
  for (const r of rg) if (r && r.key) radar.byGame.set(r.key, r);
  for (const e of (b.radar && b.radar.feed) || []) {
    if (!e || !(num(e.t, NaN) < T)) continue;
    pushTo(radar.feed, e.g + "|" + lower(e.m), e);
  }

  // 7. the bulk channel: weekly units (demand only) and its per-account price series
  const bulk = { weekly: new Map(), perAccount: new Map(), live: new Set() };
  const bulkLo = T - 30 * DAY;
  for (const d of b.demandOnly || []) {
    if (!d || !BULK_SRC.has(lower(d.src)) || !(d.t >= bulkLo && d.t < T)) continue;
    bulk.weekly.set(d.g, (bulk.weekly.get(d.g) || 0) + 7 / 30);
  }
  for (const x of b.bulkPrices || []) {
    if (!x || !(x.t < T)) continue;
    pushTo(bulk.perAccount, x.g, num(x.pa));
    if (x.t >= bulkLo) bulk.live.add(x.g + "|" + lower(x.m));
  }
  for (const L of b.listings || []) {
    const rk = L ? rowKindOf(L) : "";
    if ((rk === "bulk" || rk === "lot") && lower(L.st) === LIVE_STATUS && finite(L.c) !== null && L.c < T) bulk.live.add(L.g + "|" + lower(L.m));
  }

  // 8. no-claim units and wave ends: how long stock lasts once its wave is over
  const waves = new Map();
  for (const w of (b.noclaim && b.noclaim.waves) || []) {
    if (!w || !w.g) continue;
    pushTo(waves, w.g, w);
  }
  for (const list of waves.values()) list.sort((x, y) => num(x.endAt, Infinity) - num(y.endAt, Infinity) || U.cmp(x.ev, y.ev) || U.cmp(x.wave, y.wave));
  const waveEnds = new Map();
  for (const [g, list] of waves) {
    const ends = list.map((w) => finite(w.endAt)).filter((t) => t !== null);
    waveEnds.set(g, ends);
  }
  const units = [];
  for (const u of (b.noclaim && b.noclaim.units) || []) {
    if (!u || !(num(u.l, Infinity) < T)) continue;
    const s = finite(u.s);
    const x = finite(u.x);
    const st = s !== null && s < T ? "sold" : x !== null && x < T ? "expired" : "listed";
    units.push(Object.assign({}, u, { stc: st }));
  }
  const waveEndOf = (u) => waveEndFor(waves.get(u.g) || [], u);
  const winAll = [];
  const winBy = new Map();
  for (const u of units) {
    if (u.stc !== "expired") continue;
    const end = waveEndOf(u);
    if (end === null || !(u.x >= end)) continue;
    const d = (u.x - end) / DAY;
    winAll.push(d);
    pushTo(winBy, u.g, d);
  }
  const claimWindowDays = winAll.length ? quantileAny(winAll, 0.5) : 0;
  const claimWindowByGame = new Map();
  for (const [g, list] of winBy) claimWindowByGame.set(g, quantileAny(list, 0.5));

  // 9. deliberate ladders: an exact offer live at two or more prices on one market with any row the
  //    owner made (origin manual or unclaimed) among them — an experiment, never "corrected"
  const rungs = new Map();
  const owned = new Set();
  const sysCk = new Set();
  for (const R of rows) {
    if (R.system && R.ex) sysCk.add(R.m + "|" + R.ck);
    if (!R.activeAtCut || !R.ex || !(R.rk === "system" || R.rk === "hand" || R.rk === "cas")) continue;
    const k = R.m + "|" + R.ck;
    if (!rungs.has(k)) rungs.set(k, new Set());
    rungs.get(k).add(U.round2(R.p));
    if (R.o !== "auto") owned.add(k);
  }
  const ladders = new Set();
  for (const [k, set] of rungs) if (set.size >= 2 && owned.has(k)) ladders.add(k);

  // 10. per-cell and per-game indexes the later phases share
  const rowsByCell = new Map();
  const rowsByGF = new Map();
  const ggselVmin = new Map();
  const gameLabel = new Map();
  for (const R of rows) {
    pushTo(rowsByCell, R.g + "|" + R.f + "|" + R.m, R);
    pushTo(rowsByGF, R.g + "|" + R.f, R);
    if (R.m === "ggsel" && R.vmin !== null) ggselVmin.set(R.g, Math.max(ggselVmin.get(R.g) || 0, R.vmin));
    if (R.g && R.gl && !gameLabel.has(R.g)) gameLabel.set(R.g, R.gl);
  }
  const salesByGFM = new Map();
  for (const s of salesBefore) pushTo(salesByGFM, s.g + "|" + (s.f === "noclaim" ? "noclaim" : "claim") + "|" + lower(s.m), s);

  const ev = {
    cut: T,
    cfg: C,
    bundle: b,
    markets,
    rows,
    byId,
    orders,
    idx,
    tr,
    ratio,
    salesBefore,
    salesByListing,
    demand,
    radar,
    bulk,
    noclaim: { units, waves, waveEnds, claimWindowDays, claimWindowByGame, waveEndOf },
    ladders,
    sysCk,
    rowsByCell,
    rowsByGF,
    salesByGFM,
    ggselVmin,
    gameLabel,
    notes,
    _ref: new Map(),
    _gs: new Map(),
    _memo: new Map(),
  };
  if (synthDemand) synthesiseDemand(ev);
  ev.gameFarms = gameFarmsOf(ev);
  return ev;
}

// Nearest-rank median that keeps zeros (stats.quantile drops values ≤ 0, and a claim window of
// 0 days is a real answer).
function quantileAny(list, f) {
  const a = list.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(f * a.length))];
}

/**
 * The wave a no-claim unit's drops belong to, as an end time: the waves its campaign names match
 * (latest end), else the wave of its game that was live when it was listed (latest start before
 * listedAt), else null. Only the end matters: the drops vanish a claim window after it.
 */
function waveEndFor(list, u) {
  if (!list.length) return null;
  const camps = (u.camps || []).map(lower).filter(Boolean);
  let best = null;
  if (camps.length) {
    for (const w of list) {
      const end = finite(w.endAt);
      if (end === null) continue;
      const names = [lower(w.wave), lower(w.ev), lower((w.ev || "") + " " + (w.wave || ""))].filter(Boolean);
      if (camps.some((c) => names.includes(c))) best = best === null ? end : Math.max(best, end);
    }
    if (best !== null) return best;
  }
  const l = finite(u.l);
  let startBest = -Infinity;
  for (const w of list) {
    const s = finite(w.startAt);
    const end = finite(w.endAt);
    if (end === null || s === null || l === null || s > l) continue;
    if (s > startBest || (s === startBest && end > best)) {
      startBest = s;
      best = end;
    }
  }
  return best;
}

/** Backtest demand: our own 45-day rate at the cut per game × farm, stock = units listed at the cut. */
function synthesiseDemand(ev) {
  const T = ev.cut;
  const per = new Map();
  const get = (g, f) => {
    const k = g + "|" + f;
    if (!per.has(k)) per.set(k, { k: g, f, n45: 0, n30: 0, on: 0 });
    return per.get(k);
  };
  for (const s of ev.salesBefore) {
    if (!s.g || !(s.t > T - 45 * DAY)) continue;
    const e = get(s.g, s.f === "noclaim" ? "noclaim" : "claim");
    e.n45++;
    if (s.t > T - 30 * DAY) e.n30++;
  }
  for (const d of ev.bundle.demandOnly || []) {
    if (!d || !d.g || !(d.t > T - 45 * DAY && d.t < T)) continue;
    const e = get(d.g, d.f === "noclaim" ? "noclaim" : "claim");
    e.n45++;
    if (d.t > T - 30 * DAY) e.n30++;
  }
  for (const R of ev.rows) if (R.system && R.activeAtCut) get(R.g, R.f).on += shelfUnits(R);
  for (const e of per.values()) {
    const wl = liveWave(ev, e.k, T);
    const w = U.round2((e.n45 * 7) / 45);
    ev.demand.set(e.k + "|" + e.f, {
      k: e.k,
      f: e.f,
      at: T,
      live: !!wl,
      hl: wl ? U.round2((wl - T) / U.HOUR) : null,
      c: null,
      w,
      t: null,
      on: e.on,
      fl: 0,
      a30: U.round2((e.n30 * 7) / 30),
      a45: w,
      synth: true,
    });
  }
}

/** The end of a wave of game g live at T (latest end), or null. */
function liveWave(ev, g, T) {
  let best = null;
  for (const w of ev.noclaim.waves.get(g) || []) {
    const s = finite(w.startAt);
    const e = finite(w.endAt);
    if (e === null || e <= T || (s !== null && s > T)) continue;
    best = best === null ? e : Math.max(best, e);
  }
  return best;
}

/** Every game × farm the run covers, sorted: one with rows, orders, or a fresh farm-brain row. */
function gameFarmsOf(ev) {
  const seen = new Map();
  const add = (g, f) => {
    if (!g) return;
    const k = g + "|" + f;
    if (!seen.has(k)) seen.set(k, { g, f, gl: ev.gameLabel.get(g) || g });
  };
  for (const R of ev.rows) if (R.rk !== "bulk" && R.rk !== "lot" && R.rk !== "account") add(R.g, R.f);
  for (const o of ev.orders) add(o.g, o.f);
  for (const d of ev.demand.values()) add(d.k, d.f);
  return [...seen.values()].sort((a, b) => U.cmp(a.g, b.g) || U.cmp(a.f, b.f));
}

/**
 * Days in [from, to] the given rows were on sale (union of their spans, no rebundle split: this is
 * the game's shelf, not one offer's evidence).
 */
function coveredDays(ev, rows, from, to) {
  const spans = [];
  for (const R of rows || []) {
    const e = exposureOf(R, R.sales, ev.cut, (ev.cut - from) / DAY, { kind: R.rk, activeAtCut: R.activeAtCut, keepRebundle: true });
    const a = Math.max(e.t0 === null ? Infinity : e.t0, from);
    const z = Math.min(e.t1 === null ? -Infinity : e.t1, to);
    if (z > a) spans.push([a, z]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = null;
  let ce = null;
  for (const [a, z] of spans) {
    if (cs === null) {
      cs = a;
      ce = z;
    } else if (a <= ce) {
      if (z > ce) ce = z;
    } else {
      total += ce - cs;
      cs = a;
      ce = z;
    }
  }
  if (cs !== null) total += ce - cs;
  return total / DAY;
}

/** Memoised on ev: a value computed once per key per run. */
function memo(ev, key, fn) {
  if (ev._memo.has(key)) return ev._memo.get(key);
  const v = fn();
  ev._memo.set(key, v);
  return v;
}

module.exports = {
  SYSTEM_ORIGINS,
  NO_PRICE_SRC,
  BULK_SRC,
  rowKindOf,
  isAdvisable,
  perOrder,
  exposureOf,
  activeAt,
  shelfUnits,
  buildEvidence,
  buildEvidenceAsync,
  waveEndFor,
  liveWave,
  coveredDays,
  quantileAny,
  memo,
};
