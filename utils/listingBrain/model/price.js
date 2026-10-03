// The brain's price for an offer on a market, and what a live row should do about it
// (docs/LISTING-BRAIN-PLAN.md §4.4).
//
//   value(p) = pH(p ÷ ref) × net(p)       — the chance a unit sells within the horizon, times what we keep
//
// The REGIME (per game × farm, from the farm brain's row) picks among evidenced candidate prices:
//   scarce     the highest price that still sells with pH ≥ minP7Scarce
//   balanced   the highest value
//   overstock  the fastest-selling price not below what buyers demonstrably pay (p25)
//   unknown    no fresh farm-brain row: nothing but the reason, action hold
// Then the GATES, in this order: confidence (below medium → hold, the price is still logged) → raise
// rule (a raise needs orders here at or above it, or repeated stock-outs; never on a venue median or
// a rival's price) → step limit → [no-claim: ceiling] → GGSel raise-only → [no-claim: bundle order, sold floor]
// → floor LAST (the no-claim floors with the platform's).
//
// PURE. A live row's advice is hold / lower / raise / test, a deliberate ladder is "ladder" (never
// corrected), a new listing is "new" (or hold below medium confidence), no evidence is "none".
const farmSizing = require("../../farmSizing");
const U = require("./util");
const RF = require("./ref");
const H = require("./hazard");
const E = require("./evidence");

const { DAY, HOUR, CONF_RANK, num, round2, usd, lower } = U;
// A price this close to another is the same price (stored prices are cents).
const EPS = 0.005;
// A raise the raise rule cut back is still worth one test unit when its value beats holding by this.
const TEST_VALUE_GAIN = 1.15;
// The shortest horizon a no-claim unit is judged on, even when its estimated expiry has passed:
// pH over zero days is 0 for every price, which would say nothing.
const MIN_HORIZON_DAYS = 1 / 24;
const ACTIONS = ["hold", "lower", "raise", "test", "ladder"];

/* -------------------------------- game state -------------------------------- */

function unitsByGame(ev) {
  return E.memo(ev, "ncUnitsByG", () => {
    const m = new Map();
    for (const u of ev.noclaim.units) {
      if (u.stc !== "listed") continue;
      if (!m.has(u.g)) m.set(u.g, []);
      m.get(u.g).push(u);
    }
    return m;
  });
}

/**
 * When a no-claim game's listed stock expires, read per unit (plan §4.3 last bullet, §4.4 "the stock
 * expires within perishHours"). Each unit listed at the cut expires a claim window after its wave's
 * end: d_u = (waveEnd_u + window − cut) ÷ DAY.
 * - A unit still listed AFTER its estimated expiry proves the estimate wrong for it (its drops are
 *   evidently still there): its expiry is unknown, never 0 — one old straggler used to drag a whole
 *   game to "expires in 0 h".
 * - `days`: the median of the positive d_u (stock-weighted is the same thing over units); with none,
 *   new stock of a live wave lasts until that wave's end plus the window; else null.
 * - `share`: the share of the game's listed units known to expire within perishHours — units of unknown
 *   expiry count as stock that is not known to perish. With no unit ledger at all, the live-wave
 *   estimate stands for the whole stock (1 or 0).
 * Memoised per game.
 * @returns {{ days: number|null, share: number|null, listed: number, dated: number, past: number, soon: number }}
 */
function perishOf(ev, g) {
  return E.memo(ev, "perish|" + g, () => {
    const win = ev.noclaim.claimWindowByGame.has(g) ? ev.noclaim.claimWindowByGame.get(g) : ev.noclaim.claimWindowDays;
    const limit = ev.cfg.perishHours / 24;
    const list = unitsByGame(ev).get(g) || [];
    const ds = [];
    let past = 0;
    let soon = 0;
    for (const u of list) {
      const end = ev.noclaim.waveEndOf(u);
      if (end === null) continue;
      const d = (end + win * DAY - ev.cut) / DAY;
      if (!(d > 0)) {
        past++;
        continue;
      }
      ds.push(d);
      if (d <= limit) soon++;
    }
    let days = null;
    let share = null;
    if (ds.length) {
      ds.sort((a, b) => a - b);
      const mid = ds.length >> 1;
      days = ds.length % 2 ? ds[mid] : (ds[mid - 1] + ds[mid]) / 2;
    } else {
      const live = E.liveWave(ev, g, ev.cut);
      if (live !== null) days = Math.max(0, (live + win * DAY - ev.cut) / DAY);
    }
    if (list.length) share = soon / list.length;
    else if (days !== null) share = days <= limit ? 1 : 0;
    return { days, share, listed: list.length, dated: ds.length, past, soon };
  });
}

/** Days until a no-claim game's listed stock expires (perishOf's median), or null. */
function perishDaysOf(ev, g) {
  return perishOf(ev, g).days;
}

/** Has a campaign of this game ended (inside the waves the bundle holds) with none live now? */
function campaignEnded(ev, g) {
  let ended = false;
  for (const w of ev.noclaim.waves.get(g) || []) {
    const e = num(w.endAt, NaN);
    if (!Number.isFinite(e)) continue;
    const s = num(w.startAt, -Infinity);
    if (e > ev.cut && s <= ev.cut) return false;
    if (e <= ev.cut) ended = true;
  }
  return ended;
}

/**
 * The game's demand and stock as the farm brain sees them, and its regime (plan §4.4 table).
 * Memoised on ev._gs.
 */
function gameState(ev, g, f) {
  const key = g + "|" + f;
  if (ev._gs.has(key)) return ev._gs.get(key);
  const cfg = ev.cfg;
  const d = ev.demand.get(key);
  const sizing = (ev.bundle && ev.bundle.sizing) || {};
  const coverageDays = num(sizing.coverageDays, farmSizing.DEFAULT_COVERAGE_DAYS) || farmSizing.DEFAULT_COVERAGE_DAYS;
  const T = coverageDays / 7;
  const gs = { g, f, unknown: !d, why: "", w: null, on: null, fl: null, live: false, hl: null, c: null, cover: null, T: U.round3(T), tier: 0, fading: false, regime: "unknown", regimeWhy: [], perishDays: null, perishShare: null, perishing: false, rivals: null };
  const pe = f === "noclaim" ? perishOf(ev, g) : null;
  if (pe) {
    gs.perishDays = pe.days;
    gs.perishShare = pe.share === null ? null : U.round3(pe.share);
  }
  // a unit listed past its estimated expiry: said once, wherever the game's reasons are shown
  const pastLine =
    pe && pe.past > 0
      ? pe.past + (pe.past === 1 ? " unit is still listed past its estimated expiry: the estimate is ignored for it." : " units are still listed past their estimated expiry: the estimate is ignored for them.")
      : null;
  if (!d) {
    gs.why = "No fresh farm-brain row for this game (missing, or older than " + cfg.maxDemandAgeH + " h): no advice.";
    gs.regimeWhy = [gs.why];
    ev._gs.set(key, gs);
    return gs;
  }
  gs.w = num(d.w, 0);
  gs.on = Math.max(0, num(d.on, 0));
  gs.fl = Math.max(0, num(d.fl, 0));
  gs.live = !!d.live;
  gs.hl = d.hl === null || d.hl === undefined ? null : num(d.hl);
  gs.c = d.c || null;
  gs.tier = U.tierOf(gs.w, cfg.tierEdges);
  gs.cover = gs.w > 0 ? gs.on / gs.w : gs.on > 0 ? Infinity : null;
  const a30 = num(d.a30, NaN);
  const a45 = num(d.a45, NaN);
  gs.fading = Number.isFinite(a30) && Number.isFinite(a45) && a45 > 0 && a30 < cfg.fadeRatio * a45;
  const rg = ev.radar.byGame.get(g);
  gs.rivals = rg && rg.rivalSellers !== null && rg.rivalSellers !== undefined && Number.isFinite(Number(rg.rivalSellers)) ? Number(rg.rivalSellers) : null;

  // The signals, strongest first (the plan's table states no precedence; this is it):
  //   1. no-claim stock about to expire → overstock: it sells now or it expires;
  //   2. cover far over / under target → overstock / scarce (the two cannot both hold);
  //   3. a campaign that ended with the rivals gone → scarce: supply has left. Our own sales slow once a
  //      campaign ends, so this is checked BEFORE fading, which it would otherwise always trip;
  //   4. the farm brain's skip, or fading demand → overstock.
  const wk = (v) => (v === Infinity ? "∞" : U.round2(v));
  const sig = [];
  // Perishing is read per stock: at least half of what is listed expires within perishHours.
  if (pe && pe.share !== null && pe.share >= 0.5) {
    gs.perishing = true;
    sig.push([
      "overstock",
      "Perishing: " + Math.round(pe.share * 100) + "% of its listed stock expires within " + cfg.perishHours + " h" +
        (gs.perishDays !== null ? " (median " + Math.round(gs.perishDays * 24) + " h)" : "") + ": it sells now or it expires.",
    ]);
  }
  if (gs.cover !== null && gs.cover > cfg.overstockCover * T) {
    sig.push(["overstock", gs.w > 0 ? "Stock covers " + wk(gs.cover) + " weeks, over " + cfg.overstockCover + "× the " + U.round2(T) + "-week target." : "No forecast sale and " + gs.on + " in stock."]);
  }
  if (gs.cover !== null && gs.cover < cfg.scarceCover * T) sig.push(["scarce", "Stock covers " + wk(gs.cover) + " weeks, under " + cfg.scarceCover + "× the " + U.round2(T) + "-week target."]);
  if (f === "claim" && campaignEnded(ev, g) && gs.rivals !== null && gs.rivals <= cfg.rivalsGoneMax) {
    sig.push(["scarce", "The campaign has ended and the radar shows " + gs.rivals + " rival seller" + (gs.rivals === 1 ? "" : "s") + " live."]);
  }
  if (gs.c === "skip") sig.push(["overstock", "The farm brain says skip this game."]);
  if (gs.fading) sig.push(["overstock", "Fading: " + U.round2(a30) + "/wk over 30 days against " + U.round2(a45) + "/wk over 45."]);
  if (sig.length) {
    gs.regime = sig[0][0];
    gs.regimeWhy = sig.filter((x) => x[0] === gs.regime).map((x) => x[1]);
    const other = sig.filter((x) => x[0] !== gs.regime);
    if (other.length) gs.regimeWhy.push("Outranked: " + other[0][1]);
    // no-claim stock is never held back: scarce there only lets the price go up (placement ignores it)
    if (f === "noclaim" && gs.regime === "scarce") gs.regimeWhy.push("Scarce lets the price rise; no-claim stock is never held back.");
  } else {
    gs.regime = "balanced";
    gs.regimeWhy = ["Stock and demand are in balance" + (gs.cover !== null && gs.cover !== Infinity ? " (" + wk(gs.cover) + " weeks of cover)" : "") + "."];
  }
  if (pastLine) gs.regimeWhy.push(pastLine);
  ev._gs.set(key, gs);
  return gs;
}

/* -------------------------------- candidates -------------------------------- */

/**
 * Candidate prices: ref × GRID plus the floor and any extra (p25, the live ask), on the $0.05 grid,
 * inside [floor, ceiling], sorted, unique.
 */
function candidates(refInfo, floor, extra = []) {
  const ref = refInfo && refInfo.ref;
  if (!(ref > 0)) return [];
  const fl = Math.max(0, num(floor, 0));
  const hi = Math.max(fl, refInfo.ceiling === null || refInfo.ceiling === undefined ? Infinity : num(refInfo.ceiling));
  const set = new Set();
  const add = (p) => {
    if (!(num(p) > 0)) return;
    let c = U.snap05(p);
    // snapping must never take a price under the floor: the floor itself is the candidate then
    if (c < fl - 1e-9) c = round2(fl);
    if (c > hi + 1e-9) return;
    set.add(c);
  };
  for (const k of U.GRID) add(ref * k);
  add(fl);
  for (const p of extra || []) add(p);
  return [...set].sort((a, b) => a - b);
}

/* ---------------------------------- helpers --------------------------------- */

/** The horizon a farm's unit is judged on; a no-claim unit's is cut by the time its stock has left. */
function horizonFor(ev, f, gs) {
  if (f !== "noclaim") return ev.cfg.horizonDaysClaim;
  const H0 = ev.cfg.horizonDaysNoclaim;
  if (!gs || gs.perishDays === null || gs.perishDays === undefined) return H0;
  return Math.max(MIN_HORIZON_DAYS, Math.min(H0, gs.perishDays));
}

// unclaimedBundles.bundlePrice's ceiling when the owner set none (PRICE_CEILING_USD there).
const NOCLAIM_CEILING_USD = 4.5;
// settings.normGameName's rule (not requirable here: settings does I/O).
const normGameName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const posNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The owner's no-claim limits for a game, from the bundle's `pricing` (settings.getUnclaimedPricing):
 * the floor is max(floorUsd, the game's own floor — the first gameFloors key contained in the game's
 * normalised label, settings.gameFloorFor's substring rule); the ceiling is ceilingUsd, 0 or unset
 * reading bundlePrice's $4.50. Memoised per game.
 * @returns {{ floor: number, gameFloor: number, ceiling: number }}
 */
function noclaimLimits(ev, g) {
  return E.memo(ev, "ncLimits|" + g, () => {
    const p = (ev.bundle && ev.bundle.pricing) || {};
    const floors = p.gameFloors && typeof p.gameFloors === "object" ? p.gameFloors : {};
    const label = normGameName((ev.gameLabel && ev.gameLabel.get(g)) || g);
    let gameFloor = 0;
    if (label) {
      for (const k of Object.keys(floors)) {
        const key = normGameName(k);
        if (key && label.includes(key)) {
          gameFloor = posNum(floors[k]);
          break;
        }
      }
    }
    return { floor: Math.max(posNum(p.floorUsd), gameFloor), gameFloor, ceiling: posNum(p.ceilingUsd) || NOCLAIM_CEILING_USD };
  });
}

/** The highest Gameflip sold price of this exact offer in the last 30 days (unclaimedAutoList's sold floor). */
function soldFloorOf(ev, ck) {
  if (!ck) return 0;
  return E.memo(ev, "soldFloor|" + ck, () => {
    const lo = ev.cut - 30 * DAY;
    let best = 0;
    for (const o of ev.idx.byMCk.get("gameflip|" + ck) || []) if (o.t >= lo && o.p > best) best = o.p;
    return best;
  });
}

/**
 * Repeated stock-outs on a cell, the raise rule's second door: the shelf stood empty ≥ stockoutShare
 * of the last 30 days, it sold out here at least raiseMinSales times in that span, and the game sold
 * elsewhere meanwhile — the buyers were there, the stock was not.
 */
function stockoutsOf(ev, g, f, m) {
  return E.memo(ev, "stockout|" + g + "|" + f + "|" + m, () => {
    const lo = ev.cut - 30 * DAY;
    const rows = (ev.rowsByCell.get(g + "|" + f + "|" + m) || []).filter((r) => r.system);
    const inStock = Math.min(30, E.coveredDays(ev, rows, lo, ev.cut));
    const empty = 1 - inStock / 30;
    let here = 0;
    for (const s of ev.salesByGFM.get(g + "|" + f + "|" + m) || []) if (s.t >= lo) here++;
    let elsewhere = 0;
    for (const mk of U.MARKETS) {
      if (mk === m) continue;
      for (const s of ev.salesByGFM.get(g + "|" + f + "|" + mk) || []) if (s.t >= lo) elsewhere++;
    }
    const ok = rows.length > 0 && here >= ev.cfg.raiseMinSales && empty >= ev.cfg.stockoutShare && elsewhere > 0;
    return { ok, empty: U.round2(empty), here, elsewhere };
  });
}

function pAt(ctx, v, p) {
  if (!(v.ref > 0) || !(p > 0)) return null;
  const hz = ctx.hz && ctx.hz[v.f];
  if (!hz) return null;
  return H.pH(hz, v.m, v.tier, p / v.ref, v.H);
}
function valueAt(ctx, v, p) {
  const ph = pAt(ctx, v, p);
  if (ph === null) return null;
  return ph * U.netOf(p, v.m, ctx.ev.bundle.fees || {});
}

/* ----------------------------------- gates ---------------------------------- */

/**
 * The gate chain from a regime pick `raw`, relative to `base` (the live ask; for a new listing,
 * today's price), down to `floor`. `minP` is the no-claim bundle order (containment) lift.
 * @returns {{ p, gates, why, raiseCut, wanted }}
 */
function gateChain(ctx, v, { raw, base, floor, minP = null }) {
  const ev = ctx.ev;
  const cfg = ev.cfg;
  const gates = [];
  const why = [];
  let p = raw;
  let raiseCut = false;
  let wanted = null;
  if (p === null || p === undefined) return { p: null, gates, why, raiseCut, wanted };
  if (CONF_RANK[v.conf] < CONF_RANK.medium) gates.push("confidence");
  const b = num(base, 0) > 0 ? num(base) : null;
  // 2. raise rule
  if (b !== null && p > b + EPS) {
    if (v.basis === "venue" || v.basis === "rivals" || v.basis === "none") {
      wanted = p;
      p = b;
      raiseCut = true;
      gates.push("raise-rule");
      why.push("No raise on " + (v.basis === "venue" ? "a market-wide median" : v.basis === "rivals" ? "rivals' prices" : "no evidence") + ": a raise needs our own sales here.");
    } else {
      const so = stockoutsOf(ev, v.k, v.f, v.m);
      if (!so.ok) {
        let best = null;
        for (let i = v.cands.length - 1; i >= 0; i--) {
          const c = v.cands[i];
          if (c.p > p + 1e-9 || c.p <= b + EPS || !c.evid) continue;
          if (RF.ordersAtOrAbove(ev, v.m, v.bk, c.p) >= cfg.raiseMinSales) {
            best = c.p;
            break;
          }
        }
        if (best === null || best < p - 1e-9) {
          wanted = p;
          p = best === null ? b : best;
          raiseCut = true;
          gates.push("raise-rule");
          why.push("Raise held to " + usd(p) + ": fewer than " + cfg.raiseMinSales + " orders here at " + usd(wanted) + " or more.");
        }
      } else {
        why.push("Raise allowed: the shelf here stood empty " + Math.round(so.empty * 100) + "% of 30 days while it sold elsewhere.");
      }
    }
  }
  // 3. step limit
  if (b !== null) {
    const s = cfg.maxStepPct / 100;
    if (p > b * (1 + s) + 1e-9) {
      p = Math.max(b, U.floor05(b * (1 + s)));
      gates.push("step");
    } else if (p < b * (1 - s) - 1e-9) {
      p = Math.min(b, U.ceil05(b * (1 - s)));
      gates.push("step");
    }
    if (gates[gates.length - 1] === "step") why.push("Step limit: at most " + cfg.maxStepPct + "% from " + usd(b) + " in one move.");
  }
  // no-claim: the owner's ceiling (getUnclaimedPricing), as bundlePrice applies it — before the floors,
  // so only the sold floor may lift a price over it. Before GGSel raise-only: a GGSel row already over
  // the ceiling is held, never advised down. A cut-back raise's test price obeys it too.
  if (v.f === "noclaim") {
    const cap = noclaimLimits(ev, v.k).ceiling;
    if (p > cap + 1e-9) {
      p = cap;
      gates.push("ceiling");
      why.push("Not over the no-claim ceiling " + usd(cap) + ".");
    }
    if (wanted !== null && wanted > cap) wanted = cap;
  }
  // 4. GGSel enforces an unpublished per-category minimum: never below the base there
  if (v.m === "ggsel" && b !== null && p < b - 1e-9) {
    p = b;
    gates.push("ggsel-raise-only");
    why.push("GGSel can only be raised (its hidden category minimum).");
  }
  // no-claim: the bundle order and the sold floor (both lift only)
  if (minP !== null && minP !== undefined && p < minP - 1e-9) {
    p = minP;
    gates.push("containment");
    why.push("Lifted to " + usd(minP) + ": a bigger bundle of this game is never cheaper than a smaller one.");
  }
  const sf = v.f === "noclaim" ? soldFloorOf(ev, v.ck) : 0;
  if (sf > 0 && p < sf - 1e-9) {
    p = sf;
    gates.push("sold-floor");
    why.push("Not under its 30-day sold floor " + usd(sf) + ".");
  }
  // 5. the floor, last
  if (p < floor - 1e-9) {
    p = floor;
    gates.push("floor");
  }
  return { p: round2(p), gates, why, raiseCut, wanted };
}

/* ---------------------------------- an offer -------------------------------- */

/**
 * The brain's price for one offer on one market.
 * @param {object} ctx { ev, hz: { claim, noclaim }, prior: Map(listing id → { a, at }) }
 * @param {object} o   { g, f, m, ck, bk, ex, n, band, live: R | [R] | null, base, np, ladder, defer }
 *                     `base`: the live ask, or today's new-listing price (null when unknown);
 *                     `np`: today's new-listing price (no-claim: bundlePrice) — a thin bundle starts there.
 *                     `defer`: leave the per-row actions to finishOffer (the no-claim bundle order
 *                     needs every offer's price first).
 */
function priceOffer(ctx, o) {
  const ev = ctx.ev;
  const cfg = ev.cfg;
  const m = o.m;
  const f = o.f === "noclaim" ? "noclaim" : "claim";
  const mk = ev.markets[m];
  const liveRows = (Array.isArray(o.live) ? o.live : o.live ? [o.live] : []).filter(Boolean).slice().sort((a, b) => U.cmp(a.id, b.id));
  const ck = o.ex && o.ck ? o.ck : null;
  const gs = gameState(ev, o.g, f);
  const v = {
    k: o.g,
    f,
    m,
    ck,
    bk: o.bk || "",
    n: o.n === undefined ? null : o.n,
    band: o.band || "",
    p: null,
    raw: null,
    ref: null,
    conf: "none",
    basis: "none",
    regime: gs.regime,
    tier: gs.tier,
    pH: null,
    pHask: null,
    value: null,
    valueAsk: null,
    action: "none",
    gates: [],
    thin: false,
    stale: false,
    why: [],
    base: num(o.base, 0) > 0 ? round2(o.base) : null,
    ask: null,
    floor: null,
    ladder: !!o.ladder,
    test: null,
    H: horizonFor(ev, f, gs),
    cands: [],
    liveRows,
    live: [],
    flags: [],
  };
  // The offer's own ask: the median live ask of its system-made rows.
  if (liveRows.length) v.ask = U.medianOrNull(liveRows.map((r) => r.ask));
  if (v.base === null && v.ask !== null) v.base = v.ask;
  // Floor: the market's, the rows' own learned minimum, and for a new GGSel listing the highest
  // minimum any GGSel row of the game has hit (its hidden category minimum).
  let floor = mk ? mk.floor : U.floorFor(m);
  for (const r of liveRows) floor = Math.max(floor, r.floor);
  if (!liveRows.length && m === "ggsel" && ev.ggselVmin.has(o.g)) floor = Math.max(floor, ev.ggselVmin.get(o.g));
  // no-claim: the owner's floor and the game's own floor (getUnclaimedPricing), applied last with the rest
  if (f === "noclaim") floor = Math.max(floor, noclaimLimits(ev, o.g).floor);
  v.floor = round2(floor);

  if (!mk || mk.blocked || mk.off) {
    v.gates.push("closed");
    v.why.push(!mk ? "Unknown market." : mk.blocked ? "Market blocked by the owner: history only, no price." : "The owner's switch for this market is off: no stock, no price.");
    return finish(ctx, v, o);
  }
  const ri = RF.refFor(ev, { g: o.g, f, m, ck, bk: o.bk, ex: !!ck, n: o.n, band: o.band });
  v.ref = ri.ref;
  v.conf = ri.conf;
  v.basis = ri.basis;
  v.why.push(...ri.why.slice(0, 2));
  if (gs.unknown) {
    v.why.unshift(gs.why);
    v.gates.push("unknown");
    return finish(ctx, v, o);
  }
  v.why.push(gs.regimeWhy[0]);

  const hz = ctx.hz && ctx.hz[f];
  const fees = ev.bundle.fees || {};
  const extra = [ri.p25];
  if (v.ask !== null) extra.push(v.ask);
  v.cands = candidates(ri, v.floor, extra).map((p) => {
    const x = v.ref > 0 ? p / v.ref : null;
    const ph = hz && x !== null ? H.pH(hz, m, v.tier, x, v.H) : null;
    const net = U.netOf(p, m, fees);
    return { p, x, evid: !!hz && x !== null && H.evidenced(hz, m, x) && ph !== null, pH: ph, net, value: ph === null ? null : ph * net };
  });
  const evid = v.cands.filter((c) => c.evid);
  v.thin = !evid.length;

  let raw = null;
  if (!v.thin) {
    let regime = gs.regime;
    if (regime === "scarce") {
      let best = null;
      for (const c of evid) if (c.pH >= cfg.minP7Scarce) best = c;
      if (best) raw = best.p;
      else {
        v.why.push("No evidenced price keeps a " + Math.round(cfg.minP7Scarce * 100) + "% sell chance: priced as balanced.");
        regime = "balanced";
      }
    }
    if (regime === "overstock") {
      const lb = Math.max(ri.p25 || v.floor, v.floor);
      let best = null;
      for (const c of evid) if (c.p >= lb - 1e-9 && (!best || c.pH >= best.pH)) best = c;
      if (best) raw = best.p;
      else {
        v.why.push("No evidenced price at or above the lower quartile " + usd(lb) + ": priced as balanced.");
        regime = "balanced";
      }
    }
    if (regime === "balanced") {
      let best = null;
      for (const c of evid) if (!best || c.value >= best.value) best = c;
      raw = best.p;
    }
  } else {
    v.gates.push("thin");
    const np = num(o.np, 0) > 0 ? round2(o.np) : v.base;
    if (f === "noclaim" && np !== null) {
      // a thin bundle starts from today's bundlePrice answer, not from nothing
      raw = np;
      v.why.push("Thin evidence: starts from today's bundle price " + usd(np) + ".");
    } else {
      v.why.push(v.ref > 0 ? "No price ratio here has enough listing-days or sales: no price is picked." : "No reference price: no price.");
    }
  }
  v.raw = raw === null ? null : round2(raw);
  if (!o.defer) return finish(ctx, v, o);
  return v;
}

/**
 * Gate the offer's pick (offer level: base = today's price / median ask) and give every live row its
 * action. `minP` is the no-claim containment lift. Mutates and returns `v`.
 */
function finishOffer(ctx, v, { minP = null } = {}) {
  const cfg = ctx.ev.cfg;
  if (v.raw !== null && v.raw !== undefined) {
    const c = gateChain(ctx, v, { raw: v.raw, base: v.base, floor: v.floor, minP });
    v.p = c.p;
    for (const g of c.gates) if (!v.gates.includes(g)) v.gates.push(g);
    v.why.push(...c.why);
    if (c.raiseCut && c.wanted) {
      const testP = stepCapped(cfg, v.base, c.wanted);
      const vt = valueAt(ctx, v, testP);
      const vb = valueAt(ctx, v, v.ask !== null ? v.ask : v.base);
      if (vt !== null && vb !== null && vb > 0 && vt >= TEST_VALUE_GAIN * vb) v.test = round2(Math.max(testP, v.floor));
    }
  }
  v.pH = v.p !== null ? pAt(ctx, v, v.p) : null;
  v.value = v.p !== null ? valueAt(ctx, v, v.p) : null;
  if (v.ask !== null) {
    v.pHask = pAt(ctx, v, v.ask);
    v.valueAsk = valueAt(ctx, v, v.ask);
  }
  v.live = v.liveRows.map((r) => liveAction(ctx, v, r, { minP }));
  if (v.live.some((r) => r.stale)) v.stale = true;
  for (const r of v.live) {
    for (const g of r.gates) if (!v.gates.includes(g)) v.gates.push(g);
    for (const fl of r.flags) if (!v.flags.includes(fl)) v.flags.push(fl);
  }
  if (v.live.length) {
    // the offer's action: what most of its rows are told (ties → hold, the safe answer)
    const count = {};
    for (const r of v.live) count[r.a] = (count[r.a] || 0) + 1;
    let best = "hold";
    for (const a of ACTIONS) if ((count[a] || 0) > (count[best] || 0)) best = a;
    v.action = best;
  } else if (v.p === null) {
    v.action = v.gates.includes("closed") || v.raw === null ? "none" : "hold";
  } else {
    v.action = CONF_RANK[v.conf] >= CONF_RANK.medium ? "new" : "hold";
  }
  if (CONF_RANK[v.conf] < CONF_RANK.medium && v.p !== null) v.why.push("Confidence " + v.conf + ": the price is logged, the action is hold.");
  return v;
}

function finish(ctx, v, o) {
  return o && o.defer ? v : finishOffer(ctx, v);
}

const stepCapped = (cfg, base, p) => {
  const b = num(base, 0);
  if (!(b > 0)) return p;
  const s = cfg.maxStepPct / 100;
  return Math.min(p, Math.max(b, U.floor05(b * (1 + s))));
};

/**
 * What one live system-made row should do (plan §4.4): hold inside the agreement band; a stale row
 * comes down one rung; a raise the raise rule cut back may be tested on one unit; a different move
 * advised within cooldownH is held. A ladder is never corrected.
 * @returns {{ id, ask, ageDays, a, p, p7a, stale, gates, flags, why }}
 */
function liveAction(ctx, v, R, { minP = null } = {}) {
  const ev = ctx.ev;
  const cfg = ev.cfg;
  const out = { id: R.id, ask: R.ask, ageDays: R.ageDays, a: "hold", p: null, p7a: pAt(ctx, v, R.ask), stale: false, gates: [], flags: [], why: [] };
  if (v.ladder) {
    out.a = "ladder";
    out.why.push("This exact offer is live at several prices with a hand-made rung: a deliberate test, not corrected.");
    return out;
  }
  if (v.raw === null || v.raw === undefined || !R.advisable) {
    if (!R.advisable) out.why.push("Not a row the brain advises on.");
    return out;
  }
  const c = gateChain(ctx, v, { raw: v.raw, base: R.ask, floor: Math.max(v.floor, R.floor), minP });
  out.p = c.p;
  out.gates.push(...c.gates.filter((g) => g !== "confidence"));
  if (CONF_RANK[v.conf] < CONF_RANK.medium) {
    out.gates.unshift("confidence");
    out.why.push("Confidence " + v.conf + ": hold.");
    return out;
  }
  const tol = Math.max(cfg.agreeAbsUsd, (cfg.agreeRelPct / 100) * R.ask);
  const hz = ctx.hz && ctx.hz[v.f];
  const xAsk = v.ref > 0 ? R.ask / v.ref : null;
  // Expected days to a sale at the ask — only from an evidenced bucket: a thin one is the market's
  // average rate shrunk in, which says nothing about THIS price (a row asking a third of its reference
  // would read "stale" after a day and be cut further).
  const eds = hz && xAsk !== null && H.evidenced(hz, v.m, xAsk) ? H.expectedDaysToSale(hz, v.m, v.tier, xAsk) : Infinity;
  let a = "hold";
  let p = c.p;
  if (Number.isFinite(eds) && R.ageDays > cfg.staleFactor * eds && c.p >= R.ask - tol) {
    // Rule 5's missing half: listed far longer than its price implies, and the curve does not
    // already say lower — one rung down.
    out.stale = true;
    let rung = null;
    for (const cand of v.cands) if (cand.p < R.ask - EPS && cand.p >= R.floor - 1e-9) rung = cand.p;
    if (v.m === "ggsel") {
      out.gates.push("ggsel-raise-only");
      out.why.push("Stale (" + Math.round(R.ageDays) + " d, about " + Math.round(eds) + " d expected) but GGSel can only be raised.");
    } else if (rung === null) {
      out.why.push("Stale, but no lower rung above the floor.");
    } else {
      a = "lower";
      p = rung;
      out.gates.push("stale");
      out.why.push("Stale: " + Math.round(R.ageDays) + " days listed, about " + Math.round(eds) + " expected at this price → one rung down to " + usd(rung) + ".");
    }
  } else if (c.raiseCut && c.wanted) {
    const testP = Math.max(stepCapped(cfg, R.ask, c.wanted), R.floor);
    const vt = valueAt(ctx, v, testP);
    const vh = valueAt(ctx, v, R.ask);
    if (vt !== null && vh !== null && vh > 0 && vt >= TEST_VALUE_GAIN * vh && testP > R.ask + EPS) {
      a = "test";
      p = round2(testP);
      out.why.push("Worth testing " + usd(p) + " on one unit: " + Math.round((vt / vh - 1) * 100) + "% more value than holding, too few sales to raise.");
    }
  }
  if (a === "hold" && !out.stale) {
    if (c.p < R.ask - tol) a = "lower";
    else if (c.p > R.ask + tol) a = "raise";
  }
  // cool-down: no flip-flopping between different moves on one row
  const prior = ctx.prior && typeof ctx.prior.get === "function" ? ctx.prior.get(R.id) : null;
  if (a !== "hold" && prior && prior.a && prior.a !== "hold" && prior.a !== a && ev.cut - num(prior.at, -Infinity) < cfg.cooldownH * HOUR) {
    out.gates.push("cool-down");
    out.why.push("Cool-down: " + prior.a + " was advised under " + cfg.cooldownH + " h ago.");
    a = "hold";
  }
  out.a = a;
  if (a !== "hold") out.p = round2(p);
  // DropSet.minPriceUsd is the floor the Gameflip relist chain lifts every relist back to
  if (a === "lower" && R.m === "gameflip" && R.smin !== null && R.smin > out.p + EPS) out.flags.push("setmin");
  return out;
}

/** Comparison class of two prices (plan §4.7): inside max($0.10, 8 %) they agree. */
function agrees(cfg, a, b) {
  const tol = Math.max(cfg.agreeAbsUsd, (cfg.agreeRelPct / 100) * Math.abs(num(a)));
  return Math.abs(num(a) - num(b)) <= tol + 1e-9;
}

/** listing id → the bundleKey its no-claim units were attached under (U.lids); "" when they disagree. */
function bundleKeyByLid(ev) {
  return E.memo(ev, "bkByLid", () => {
    const map = new Map();
    for (const u of ev.noclaim.units) {
      const bk = lower(u.bk);
      if (!bk) continue;
      for (const lid of u.lids || []) {
        if (!map.has(lid)) map.set(lid, bk);
        else if (map.get(lid) !== bk) map.set(lid, "");
      }
    }
    return map;
  });
}

/**
 * "event key|label+label" (unclaimedBundles.classifyHoldings: event.key + "|" + held wave labels) →
 * { event, labels: Set }; null when it does not parse.
 */
function parseBundleKey(bk) {
  const k = lower(bk);
  const i = k.lastIndexOf("|");
  if (i <= 0) return null;
  const labels = k
    .slice(i + 1)
    .split("+")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!labels.length) return null;
  return { key: k, event: k.slice(0, i), labels: new Set(labels) };
}

/**
 * The bundle an offer is: the bundleKey of the units on its live rows; for a new listing, of the
 * game's earlier rows of the same items. Null when none is recorded, or its rows disagree (a row
 * rebundled since): no bundle key, no bundle order — never a guess.
 */
function offerBundleOf(ev, v) {
  const map = bundleKeyByLid(ev);
  const keysOf = (rows) => {
    const set = new Set();
    for (const r of rows) {
      const k = map.get(r.id);
      if (k === "") return null;
      if (k) set.add(k);
    }
    return set;
  };
  let set = keysOf(v.liveRows);
  if (set && !set.size) {
    const same = (ev.rowsByGF.get(v.k + "|" + v.f) || []).filter((r) => (v.ck ? r.ex && r.ck === v.ck : !(r.ex && r.ck) && r.bk === v.bk));
    set = keysOf(same);
  }
  if (!set || set.size !== 1) return null;
  return parseBundleKey([...set][0]);
}

/**
 * Is bundle A inside bundle B? Same event and A's held waves ⊆ B's. Equal wave sets count only when
 * B holds more items: containment has to point one way, or a smaller bundle would be lifted to a bigger
 * one's price.
 */
function bundleContains(B, nB, A, nA) {
  if (!A || !B || A.event !== B.event) return false;
  for (const l of A.labels) if (!B.labels.has(l)) return false;
  return A.labels.size < B.labels.size || num(nA, 0) < num(nB, 0);
}

/**
 * The no-claim bundle order (brief §3a: "within one event, a bundle that contains another is never
 * priced below it"), for the no-claim offers of one game on one market. Containment comes from the
 * units' bundleKey (bundleOf): an offer is lifted to the highest price of any offer it contains;
 * offers of different events, or with no recorded bundle key, are never compared. Then every row's
 * action is set (finishOffer). The 30-day sold floor applies in the gates as before.
 * @param {Array} verdicts priceOffer results with `defer`, one game × market
 */
function applyContainment(ctx, verdicts) {
  const ev = ctx.ev;
  const items = verdicts.map((v) => ({ v, b: offerBundleOf(ev, v) }));
  // contained bundles first: fewer held waves, then fewer items (bundleContains points that way)
  items.sort((x, y) => (x.b ? x.b.labels.size : 0) - (y.b ? y.b.labels.size : 0) || num(x.v.n, 0) - num(y.v.n, 0) || U.cmp(x.v.ck || x.v.bk, y.v.ck || y.v.bk));
  const done = [];
  for (const it of items) {
    let minP = null;
    if (!it.b) {
      if (verdicts.length > 1) it.v.why.push("No bundle key recorded on its units: the bundle order is not applied to it.");
    } else {
      for (const d of done) if (d.v.p !== null && bundleContains(it.b, it.v.n, d.b, d.v.n) && (minP === null || d.v.p > minP)) minP = d.v.p;
    }
    it.v.bundle = it.b ? it.b.key : null;
    finishOffer(ctx, it.v, { minP });
    if (it.b) done.push(it);
  }
  return verdicts;
}

module.exports = {
  EPS,
  TEST_VALUE_GAIN,
  MIN_HORIZON_DAYS,
  ACTIONS,
  gameState,
  perishOf,
  perishDaysOf,
  campaignEnded,
  candidates,
  horizonFor,
  soldFloorOf,
  noclaimLimits,
  NOCLAIM_CEILING_USD,
  stockoutsOf,
  gateChain,
  priceOffer,
  finishOffer,
  liveAction,
  applyContainment,
  bundleKeyByLid,
  parseBundleKey,
  offerBundleOf,
  bundleContains,
  agrees,
  pAt,
  valueAt,
};
