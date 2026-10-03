// Where a game's stock goes: the shelf per market (docs/LISTING-BRAIN-PLAN.md §4.5, §4.6).
//
// Per game × farm with stock: bulk's expected take is set aside first; the farm brain's weekly
// forecast is split across the PROVEN markets by their shrunk in-stock rate (a market that was out of
// stock is not read as one that does not sell); the k-th unit on market m is worth
// P(D_m ≥ k) × net_m with D_m ~ Poisson(λ_m × horizon_m ÷ 7); units go greedily to the highest marginal
// value until the stock runs out or a unit is worth less than minMarginalUsd. The rest is the
// reserve (today's hold-back), released as shelves empty. At most one exploration unit per game.
//
// PURE. No marketplace call: eligibility comes from switches, offline mappings and our own history.
const U = require("./util");
const E = require("./evidence");
const P = require("./price");

const { DAY, MARKETS, REFILLABLE, NO_MAPPING, NOCLAIM_SHELF, CONF_RANK, num } = U;

// Platform limits that bound a shelf, with where each one comes from. Only the Eldorado offer cap
// changes a number here; the rest are carried so a cell can say why its shelf cannot be what it says.
const PLATFORM_LIMITS = Object.freeze({
  // autoLister ELD_LIMIT_RE: Eldorado refuses new offers once a category holds 100 active offers, or
  // the daily quota is spent; an offer closes at quantity 0.
  eldoradoMaxActiveOffers: U.ELDORADO_MAX_ACTIVE_OFFERS,
  // utils/marketplaces.js expire_in_days: 30 — a Gameflip listing expires; Gameflip also refuses a login
  // it has already sold (one account is on at most one listing: utils/listedLogins.js).
  gameflipExpiryDays: U.GAMEFLIP_EXPIRY_DAYS,
  // PlayerAuctions accepts item offers only for some games and replaces the offer (new id) on every
  // update: its mapping is never assumed (an unproven game there is "unknown").
  playerauctionsMappingAssumed: false,
  // GGSel cannot remove a single unit from an offer: a brain shelf below today's is flagged noRemove.
  ggselCanRemoveUnit: false,
});

// The translator never scales a price by more than this between two markets (analyze.buildTranslator's
// CLAMP [0.4, 1.5], not exported): the most any market can be expected to pay over another's level.
const TRANSLATE_MAX = 1.5;

/** The offer's highest reference (confidence ≥ low) on any other market that is not blocked; null when none. */
function elsewhere(refByM, m, ev) {
  let best = null;
  for (const x of MARKETS) {
    if (x === m || ev.markets[x].blocked) continue;
    const r = refByM[x];
    if (r && r.ref > 0 && CONF_RANK[r.conf] >= CONF_RANK.low && (best === null || r.ref > best)) best = r.ref;
  }
  return best;
}

/** A sale of the game on m inside the farm's fit window: the market is proven for it. */
function provenOn(ev, g, f, m) {
  const lo = ev.cut - (f === "noclaim" ? ev.cfg.fitDaysNoclaim : ev.cfg.fitDaysClaim) * DAY;
  for (const s of ev.salesByGFM.get(g + "|" + f + "|" + m) || []) if (s.t >= lo) return true;
  return false;
}

/** We have, or have had, a system-made listing of the game on m (either farm): the mapping exists. */
function hadAuto(ev, g, m) {
  for (const f of ["claim", "noclaim"]) for (const r of ev.rowsByCell.get(g + "|" + f + "|" + m) || []) if (r.system) return true;
  return false;
}

/** Active Eldorado offers of a game (any origin) at the cut: the category's 100-offer cap. */
function eldoradoActive(ev, g) {
  let n = 0;
  for (const f of ["claim", "noclaim"]) for (const r of ev.rowsByCell.get(g + "|" + f + "|eldorado") || []) if (r.activeAtCut) n++;
  return n;
}

/**
 * Which markets may hold this game's stock (plan §4.5 table).
 * @param {object} refByM { m: refFor(...) } for the game's main offer — the floor test
 * @returns {{ [m]: { cls: "open"|"closed"|"unknown"|"unmeasured"|"managed", why, proven, refillable, horizonDays } }}
 */
function eligibility(ev, g, f, refByM = {}) {
  const cfg = ev.cfg;
  const af = ev.bundle.af || {};
  const mapped = (af.mapped && af.mapped[g]) || {};
  const out = {};
  for (const m of MARKETS) {
    const mk = ev.markets[m];
    const refillable = REFILLABLE.has(m);
    const e = { cls: "open", why: "", proven: provenOn(ev, g, f, m), refillable, horizonDays: refillable ? cfg.shelfHorizonDays : cfg.nonRefillHorizonDays };
    const ri = refByM[m];
    if (f === "noclaim" && !NOCLAIM_SHELF.has(m)) {
      if (m === "zeusx") {
        e.cls = "closed";
        e.why = "The no-claim farm does not list on ZeusX.";
      } else {
        e.cls = "managed";
        e.why = "No-claim offers here are claim-at-sale (the owner's): no placement.";
      }
    } else if (mk.blocked) {
      e.cls = "closed";
      e.why = "Blocked by the owner: no stock goes here.";
    } else if (mk.off) {
      e.cls = "closed";
      e.why = "The owner's switch for this market is off.";
    } else if (ri && ri.ref > 0 && CONF_RANK[ri.conf] >= CONF_RANK.low && mk.floor > ri.ref + P.EPS) {
      e.cls = "closed";
      e.why = "Its floor " + U.usd(mk.floor) + " is above what the offer sells for (" + U.usd(ri.ref) + ").";
    } else if (!(ri && ri.ref > 0 && CONF_RANK[ri.conf] >= CONF_RANK.low) && elsewhere(refByM, m, ev) !== null && mk.floor > TRANSLATE_MAX * elsewhere(refByM, m, ev) + P.EPS) {
      // No evidence here (PlayerAuctions rows sit at their $5 floor and rarely sell): even the most a
      // translation could make of the offer's best price elsewhere is under this floor.
      e.cls = "closed";
      e.why = "Its floor " + U.usd(mk.floor) + " is above anything the offer fetches: at most " + TRANSLATE_MAX + "× its " + U.usd(elsewhere(refByM, m, ev)) + " elsewhere.";
    } else if (m === "zeusx") {
      e.cls = "unmeasured";
      e.why = "ZeusX records no sale for an auto row: it can never earn evidence, so no shelf and no exploration.";
    } else if (NO_MAPPING.has(m) || mapped[m] === true || hadAuto(ev, g, m)) {
      e.cls = "open";
      e.why = NO_MAPPING.has(m) ? "Open: needs no per-game mapping." : mapped[m] === true ? "Open: mapped offline." : "Open: we have listed this game here.";
    } else {
      e.cls = "unknown";
      e.why = "Switch on, but nothing proves this game's mapping here (today's lister would ask the marketplace).";
    }
    out[m] = e;
  }
  return out;
}

/**
 * The game's in-stock selling rate per market over the last 30 days (units ÷ days a listing of it was
 * up), shrunk toward its pooled rate with shareShrinkDays days, and the shares that follow.
 * @param {string[]} markets the markets the split is over
 */
function marketShares(ev, g, f, markets) {
  const lo = ev.cut - 30 * DAY;
  const K = ev.cfg.shareShrinkDays;
  const S = {};
  const D = {};
  let sS = 0;
  let sD = 0;
  for (const m of markets) {
    // the cell's 30-day units and in-stock days, once per run (two policies and the shelf read them)
    const cell = E.memo(ev, "s30|" + g + "|" + f + "|" + m, () => {
      let n = 0;
      for (const s of ev.salesByGFM.get(g + "|" + f + "|" + m) || []) if (s.t >= lo) n++;
      const rows = (ev.rowsByCell.get(g + "|" + f + "|" + m) || []).filter((r) => r.rk === "system" || r.rk === "hand" || r.rk === "cas");
      return { n, d: Math.min(30, E.coveredDays(ev, rows, lo, ev.cut)) };
    });
    S[m] = cell.n;
    D[m] = U.round3(cell.d);
    sS += cell.n;
    sD += cell.d;
  }
  const pooled = sD > 0 ? sS / sD : 0;
  const rate = {};
  const raw = {};
  let sum = 0;
  for (const m of markets) {
    // sales with no recorded shelf time (a claim-at-sale market): over the whole window
    raw[m] = D[m] > 0 ? S[m] / D[m] : S[m] > 0 ? S[m] / 30 : 0;
    // no shrinkage (K = 0) is the raw in-stock rate itself, not "nothing to say" (M12)
    rate[m] = K > 0 ? (D[m] + K > 0 ? (S[m] + K * pooled) / (D[m] + K) : 0) : raw[m];
    sum += rate[m];
  }
  // No sale anywhere in 30 days is no split at all — never an equal split passed off as evidence (M12).
  const shares = {};
  for (const m of markets) shares[m] = sum > 0 ? rate[m] / sum : 0;
  return { shares, rate, raw, S, D, pooled };
}

/**
 * Greedy newsvendor fill: each unit to the market with the highest P(D ≥ k) × net, until the stock
 * runs out or the next unit is worth under `minMarginal`. Ties go to the earlier market in `markets`.
 * @returns {{ shelf: {m}, marginal: {m}, left }}
 */
function greedyFill({ markets, mu, nets, avail, minMarginal = 0, caps = {}, offsets = {} }) {
  const shelf = {};
  const marginal = {};
  const tail = {};
  const next = {};
  for (const m of markets) {
    shelf[m] = 0;
    if (!(num(nets[m]) > 0) || !(num(mu[m]) > 0)) {
      next[m] = -Infinity;
      continue;
    }
    tail[m] = U.poissonTailer(mu[m]);
    // `offsets[m]` units of m's demand are already covered (the no-claim pool's bulk set-aside): its
    // first unit here is worth P(D ≥ offset + 1)
    for (let k = Math.max(0, Math.floor(num(offsets[m], 0))); k > 0; k--) tail[m].next();
    next[m] = tail[m].next() * nets[m];
  }
  let left = Math.max(0, Math.floor(num(avail)));
  while (left > 0) {
    let best = null;
    for (const m of markets) if (next[m] > (best === null ? -Infinity : next[best])) best = m;
    if (best === null || !(next[best] > 0) || next[best] < minMarginal) break;
    if (caps[best] !== undefined && caps[best] !== null && shelf[best] >= caps[best]) {
      next[best] = -Infinity;
      continue;
    }
    shelf[best]++;
    marginal[best] = U.round3(next[best]);
    left--;
    next[best] = tail[best].next() * nets[best];
  }
  return { shelf, marginal, left };
}

/** Split `n` units over markets by weight, largest remainder (ties: MARKETS order). */
function proportional(n, weights, markets) {
  const out = {};
  const tot = markets.reduce((a, m) => a + Math.max(0, num(weights[m])), 0);
  for (const m of markets) out[m] = 0;
  if (!(tot > 0) || !(n > 0)) return out;
  const rem = [];
  let used = 0;
  for (const m of markets) {
    const exact = (n * Math.max(0, num(weights[m]))) / tot;
    out[m] = Math.floor(exact);
    used += out[m];
    rem.push([m, exact - out[m]]);
  }
  rem.sort((a, b) => b[1] - a[1] || MARKETS.indexOf(a[0]) - MARKETS.indexOf(b[0]));
  for (let i = 0; i < n - used; i++) out[rem[i % rem.length][0]]++;
  return out;
}

/** {m: expected units sold in 7 days} = E[min(Poisson(λ_m), shelf_m)]; null where there is no shelf number. */
function forecastOf(lambda, shelf) {
  if (!shelf) return null;
  const out = {};
  for (const m of MARKETS) {
    if (shelf[m] === undefined || shelf[m] === null) continue;
    out[m] = U.round3(U.expectedSold(num(lambda[m], 0), shelf[m]));
  }
  return out;
}

function capInfo(ev, g) {
  const af = ev.bundle.af || {};
  const caps = af.caps || {};
  const explicit = caps[g] !== undefined && caps[g] !== null && Number.isFinite(Number(caps[g]));
  return { cap: explicit ? Number(caps[g]) : num(af.capDefault, 70), managed: explicit };
}

// The no-claim farm's free pool, as one pseudo-market of the shelf fill (key never a market's).
const POOL = "pool";

/**
 * What a unit fetches when it is sold from the no-claim pool: the median, over the game's live
 * claim-at-sale rows (Eldorado / PlayerAuctions / G2G), of their ask and its net there; with none, of
 * the game's no-claim orders on those markets; with none, the shelf markets' prices.
 * @returns {{ price: number|null, net: number|null, from: "asks"|"orders"|"shelf"|"none" }}
 */
function poolPriceOf(ev, g, poolMs, prices, nets) {
  const fees = ev.bundle.fees || {};
  const pick = (pairs, from) => {
    if (!pairs.length) return null;
    const p = pairs.map((x) => x[0]).sort((a, b) => a - b);
    const n = pairs.map((x) => x[1]).sort((a, b) => a - b);
    const mid = (a) => (a.length % 2 ? a[a.length >> 1] : (a[(a.length >> 1) - 1] + a[a.length >> 1]) / 2);
    return { price: U.round2(mid(p)), net: U.round2(mid(n)), from };
  };
  const asks = [];
  for (const m of poolMs) for (const r of ev.rowsByCell.get(g + "|noclaim|" + m) || []) if (r.cas && r.activeAtCut && r.ask > 0) asks.push([r.ask, U.netOf(r.ask, m, fees)]);
  const a = pick(asks, "asks");
  if (a) return a;
  const orders = [];
  for (const m of poolMs) for (const o of ev.idx.byGFM.get(g + "|noclaim|" + m) || []) orders.push([o.p, U.netOf(o.p, m, fees)]);
  const o = pick(orders, "orders");
  if (o) return o;
  const shelf = [];
  for (const m of Object.keys(nets)) if (num(nets[m]) > 0 && num(prices[m]) > 0) shelf.push([num(prices[m]), num(nets[m])]);
  return pick(shelf, "shelf") || { price: null, net: null, from: "none" };
}

/** Does anything take units out of the no-claim pool: a live claim-at-sale offer, bulk, or hand sales? */
function poolOutlet(ev, g, poolMs) {
  for (const m of poolMs) for (const r of ev.rowsByCell.get(g + "|noclaim|" + m) || []) if (r.cas && r.activeAtCut) return "claim-at-sale";
  if ((ev.bulk.weekly.get(g) || 0) > 0) return "bulk";
  if ((ev.hand.weekly.get(g + "|noclaim") || 0) > 0) return "hand";
  return null;
}

// Policies' weekly demand split per market: a number on every market (0 where it splits nothing), or
// null when the policy has no split for the game at all — what the scorer compares with units sold
// (H1: the demand split, uncapped by any shelf).
function splitOf(lam, total) {
  if (!(total > 0)) {
    const zero = {};
    for (const m of MARKETS) zero[m] = 0;
    return zero;
  }
  let sum = 0;
  for (const m of MARKETS) sum += num(lam[m], 0);
  if (!(sum > 0)) return null;
  const out = {};
  for (const m of MARKETS) out[m] = U.round3(num(lam[m], 0));
  return out;
}

/**
 * The shelf for one game × farm.
 * @param {object} ctx { ev, hz, ... }
 * @param {object} q   { g, f, stock, nets: {m: net}, prices: {m: price}, elig?, refByM?, cur: {m: units now},
 *                       oldShelf: {m: units} | null (today's flat share, or the no-claim units listed) }
 */
function placeGame(ctx, q) {
  const ev = ctx.ev;
  const cfg = ev.cfg;
  const g = q.g;
  const f = q.f === "noclaim" ? "noclaim" : "claim";
  const gs = P.gameState(ev, g, f);
  const elig = q.elig || eligibility(ev, g, f, q.refByM || {});
  const cls = {};
  for (const m of MARKETS) cls[m] = elig[m].cls;
  const stock = Math.max(0, Math.floor(num(q.stock, gs.on || 0)));
  const nets = q.nets || {};
  const cur = q.cur || {};
  const res = {
    g,
    f,
    unknown: false,
    stock,
    shelf: {},
    reserve: 0,
    bulkTake: 0,
    explore: null,
    lambda: {},
    shares: {},
    marginal: {},
    horizon: {},
    elig: cls,
    flags: [],
    why: [],
    shEq: {},
    policies: {},
    W: gs.w,
    cap: null,
    managed: false,
    input: { g, f, nets, prices: q.prices || {}, elig, cur, oldShelf: q.oldShelf || null },
  };
  if (f === "noclaim") {
    const ci = capInfo(ev, g);
    res.cap = ci.cap;
    res.managed = ci.managed;
  }
  const oldShelf = q.oldShelf || null;
  if (gs.unknown) {
    // fail-safe: no demand row, no shelf advice — everything stays where today's code puts it
    res.unknown = true;
    res.reserve = stock;
    res.why.push(gs.why);
    for (const p of U.PLACE_POLICIES) res.policies[p] = { shelf: p === "flat" ? oldShelf : null, fc: null, lambda: null };
    return res;
  }
  const W = Math.max(0, num(gs.w, 0));
  // The farm brain's forecast counts every unit the game sells — bulk packs and the owner's hand sales
  // too. Those never come off a single shelf, so the single shelves split only what is left (H6: bulk
  // was counted twice, once set aside and once inside the split).
  const bw = ev.bulk.weekly.get(g) || 0;
  const hw = ev.hand.weekly.get(g + "|" + f) || 0;
  const Ws = Math.max(0, W - bw - hw);
  res.Ws = U.round3(Ws);
  if (bw > 0 || hw > 0) res.why.push("Single shelves split " + U.round2(Ws) + " of the " + U.round2(W) + "/wk forecast: bulk " + U.round2(bw) + "/wk and hand sales " + U.round2(hw) + "/wk come off no shelf.");
  // 1. bulk first: what the bulk channel is expected to take over the horizon, its own line (on the
  //    no-claim side bulk sells from the free pool, so that is where it is set aside). The owner's
  //    reserveSingles is the other half of that split: single shelves keep at least that many (C19a).
  const reserveSingles = Math.max(0, Math.floor(num(ev.bundle.bulk && ev.bundle.bulk.reserveSingles, 0)));
  const want = Math.round((bw * cfg.shelfHorizonDays) / 7);
  res.bulkTake = Math.min(stock, want, Math.max(0, stock - reserveSingles));
  if (want > 0) {
    res.why.push(
      "Bulk takes about " + res.bulkTake + " in " + cfg.shelfHorizonDays + " days (" + U.round2(bw) + "/wk): set aside" + (f === "noclaim" ? " in the pool" : "") + " first" +
        (res.bulkTake < Math.min(stock, want) ? "; " + reserveSingles + " kept for single shelves (your reserveSingles)." : "."),
    );
  }
  const avail = stock - res.bulkTake;

  // 2. the markets: where stock may go, and where demand is counted (no-claim claim-at-sale markets
  //    sell from the pool — their demand is real, it is just not a shelf)
  const open = MARKETS.filter((m) => cls[m] === "open");
  const demandM = MARKETS.filter((m) => (cls[m] === "open" || cls[m] === "managed") && elig[m].proven);
  const sh = marketShares(ev, g, f, demandM);
  let splitAny = false;
  for (const m of demandM) {
    res.shares[m] = U.round3(sh.shares[m]);
    res.lambda[m] = Ws * sh.shares[m];
    if (sh.shares[m] > 0) splitAny = true;
  }
  // (no market proven at all — or none sold in 30 days: nothing to split the forecast by)
  if (!splitAny && Ws > 0 && open.length) {
    // Nothing of ours sold anywhere open. The radar's rival sales are evidence of where buyers are; with
    // none, the plan's answer stands — no shelf on evidence, one exploration unit (never a guessed split).
    const radar = ev.radar.byGame.get(g);
    const bm = (radar && radar.byMarket) || {};
    const rm = open.filter((m) => U.RADAR_MARKETS[m] && num(bm[m] && bm[m].perWeek, 0) > 0);
    if (rm.length) {
      const tot = rm.reduce((a, m) => a + num(bm[m].perWeek), 0);
      for (const m of rm) {
        res.lambda[m] = (Ws * num(bm[m].perWeek)) / tot;
        res.shares[m] = U.round3(num(bm[m].perWeek) / tot);
      }
      res.flags.push("radar-split");
      res.why.push("No sale of ours on an open market yet: the forecast is split by where rivals sell it (" + rm.join(", ") + ").");
    } else {
      res.flags.push("unproven");
      res.why.push("No sale of ours on an open market and no rival sales seen: no shelf on evidence, only exploration.");
    }
  }
  // 3. the horizons; a no-claim unit's is cut by the time its stock has left
  const mu = {};
  for (const m of MARKETS) {
    let h = elig[m].horizonDays;
    if (f === "noclaim" && gs.perishDays !== null) h = Math.max(P.MIN_HORIZON_DAYS, Math.min(h, gs.perishDays));
    res.horizon[m] = U.round3(h);
    mu[m] = (num(res.lambda[m], 0) * h) / 7;
  }
  // 4. platform limits
  const caps = {};
  if (open.includes("eldorado") && eldoradoActive(ev, g) >= PLATFORM_LIMITS.eldoradoMaxActiveOffers) {
    caps.eldorado = Math.max(0, num(cur.eldorado, 0));
    res.flags.push("eld-limit");
    res.why.push("Eldorado already holds " + PLATFORM_LIMITS.eldoradoMaxActiveOffers + " active offers of this game: no new offer.");
  }
  // 5. the greedy fill.
  //    Claim farm: shelves only; a unit worth under minMarginalUsd stays in reserve, released as
  //    shelves empty.
  //    No-claim farm: its stock perishes, so nothing is "held for later": the reserve is the free pool
  //    the claim-at-sale offers and bulk sell from — one more market in the fill, its demand the
  //    claim-at-sale markets' share of the forecast plus bulk's rate (bulk's set-aside already covers
  //    the first units of it). No value threshold — any chance of a sale beats a certain expiry, so
  //    every unit lands somewhere; what reaches no market at all also stays in the pool.
  let fill;
  let pool = null;
  const fillMarkets = f === "noclaim" ? open.concat(POOL) : open;
  if (f === "noclaim") {
    const poolMs = MARKETS.filter((m) => cls[m] === "managed");
    const outlet = poolOutlet(ev, g, poolMs);
    // with no outlet (no live claim-at-sale offer, no bulk, no hand sales) the pool sells nothing: no
    // borrowed price for it (M9)
    const pp = outlet ? poolPriceOf(ev, g, poolMs, q.prices || {}, nets) : { price: null, net: null, from: "none" };
    let lam = bw + hw;
    for (const m of poolMs) lam += num(res.lambda[m], 0);
    if (!outlet) lam = 0;
    let h = cfg.shelfHorizonDays;
    if (gs.perishDays !== null) h = Math.max(P.MIN_HORIZON_DAYS, Math.min(h, gs.perishDays));
    pool = { markets: poolMs, outlet, lambda: U.round3(lam), horizon: U.round3(h), price: pp.price, net: pp.net, from: pp.from, units: 0, marginal: null };
    mu[POOL] = (lam * h) / 7;
    fill = greedyFill({ markets: fillMarkets, mu, nets: Object.assign({}, nets, { [POOL]: num(pp.net, 0) }), avail, minMarginal: 0, caps, offsets: { [POOL]: res.bulkTake } });
    delete fill.marginal[POOL];
    pool.marginal = null;
    let left = fill.shelf[POOL] + fill.left;
    delete fill.shelf[POOL];
    if (!outlet && left > 0) {
      // Nothing takes from the pool: every unit the shelves can still sell goes on them, up to the cap
      // in force — perishable stock held "for later" just expires (M9).
      const room = Math.max(0, res.cap - open.reduce((a, m) => a + fill.shelf[m], 0));
      const sellable = open.filter((m) => num(nets[m]) > 0 && !(caps[m] !== undefined && fill.shelf[m] >= caps[m]));
      sellable.sort((a, b) => num(res.lambda[b], 0) - num(res.lambda[a], 0) || MARKETS.indexOf(a) - MARKETS.indexOf(b));
      let put = Math.min(left, room);
      const before = put;
      // round-robin, dropping a market the moment it reaches a platform cap
      let i = 0;
      while (put > 0 && sellable.length) {
        const m = sellable[i];
        if (caps[m] !== undefined && fill.shelf[m] >= caps[m]) {
          sellable.splice(i, 1);
          if (i >= sellable.length) i = 0;
          continue;
        }
        fill.shelf[m]++;
        put--;
        i = (i + 1) % sellable.length;
      }
      left -= before - put;
      if (before - put > 0) res.why.push("Nothing takes from the pool (no claim-at-sale offer, bulk or hand sale): " + (before - put) + " more on the shelves, up to the cap " + res.cap + ".");
    }
    res.reserve = left;
  } else {
    fill = greedyFill({ markets: open, mu, nets, avail, minMarginal: cfg.minMarginalUsd, caps });
    res.reserve = fill.left;
  }
  res.shelf = fill.shelf;
  res.marginal = fill.marginal;
  // 6. one exploration unit, on one open market we have never sold the game on
  if (cfg.explore && res.reserve > 0) {
    const radar = ev.radar.byGame.get(g);
    const rivalsSell = (m) => {
      const bm = radar && radar.byMarket && radar.byMarket[m];
      return bm && num(bm.perWeek, 0) > 0 ? 1 : 0;
    };
    const cand = open.filter((m) => !elig[m].proven && !(res.shelf[m] > 0) && num(nets[m]) > 0 && !(caps[m] !== undefined && caps[m] <= 0));
    cand.sort((a, b) => rivalsSell(b) - rivalsSell(a) || MARKETS.indexOf(a) - MARKETS.indexOf(b));
    if (cand.length) {
      res.explore = cand[0];
      res.shelf[cand[0]] = 1;
      res.reserve--;
      res.why.push("One exploration unit on " + cand[0] + (rivalsSell(cand[0]) ? " (rivals sell there)" : "") + ": it can only earn evidence by being listed.");
    }
  }
  const total = open.reduce((a, m) => a + (res.shelf[m] || 0), 0);
  if (pool) {
    pool.units = res.reserve + res.bulkTake;
    res.pool = pool;
  }
  if (stock > 0 && f === "noclaim") {
    res.why.push("Shelf " + total + " of " + stock + "; " + pool.units + " to the pool the claim-at-sale offers and bulk sell from.");
  } else if (stock > 0) {
    res.why.push("Shelf " + total + " of " + stock + (res.reserve > 0 ? "; " + res.reserve + " in reserve (released as shelves empty)" : "") + ".");
  }
  if (f === "noclaim") res.why.push("The no-claim shelf cap in force is " + res.cap + (res.managed ? " (set by the owner: managed)." : " (the default)."));
  // 7. flags
  if (stock > 0 && cls.gameflip === "open" && !(res.shelf.gameflip > 0)) res.flags.push("anchor");
  if (open.includes("ggsel") && num(cur.ggsel, 0) > num(res.shelf.ggsel, 0)) res.flags.push("noRemove");
  if (open.some((m) => !ev.markets[m].feeVerified)) res.flags.push("fee-assumed");
  // 8. the same placement with every fee equal (a fee never changes a price, but it ranks markets): each
  //    market's gross price at the open markets' mean fee — so the $ threshold still compares NETS (H18)
  let feeSum = 0;
  for (const m of open) feeSum += num(ev.markets[m].feePct, 0);
  const feeEq = open.length ? feeSum / open.length / 100 : 0;
  const eqNet = (p) => U.round2(num(p, 0) * (1 - feeEq));
  const eqNets = {};
  for (const m of open) eqNets[m] = eqNet((q.prices || {})[m]);
  if (pool) {
    eqNets[POOL] = eqNet(pool.price);
    res.shEq = greedyFill({ markets: fillMarkets, mu, nets: eqNets, avail, minMarginal: 0, caps, offsets: { [POOL]: res.bulkTake } }).shelf;
    delete res.shEq[POOL];
  } else {
    res.shEq = greedyFill({ markets: open, mu, nets: eqNets, avail, minMarginal: cfg.minMarginalUsd, caps }).shelf;
  }
  // 9. the policies, each with its weekly demand split (λ, uncapped; the scorer's H1 number) and its
  //    forecast for the next 7 days at its shelf. Every split is of the same single-shelf demand Ws.
  const flatM = MARKETS.filter((m) => cls[m] === "open" || cls[m] === "unknown");
  const lamFlat = {};
  for (const m of flatM) lamFlat[m] = Ws / flatM.length;
  res.policies.flat = { shelf: oldShelf, fc: forecastOf(lamFlat, oldShelf), lambda: splitOf(lamFlat, Ws) };
  const all30 = marketShares(ev, g, f, MARKETS);
  const s30tot = MARKETS.reduce((a, m) => a + all30.S[m], 0);
  const lam30 = {};
  for (const m of MARKETS) lam30[m] = s30tot > 0 ? (Ws * all30.S[m]) / s30tot : 0;
  const shelf30 = proportional(avail, all30.S, open);
  res.policies.share30 = { shelf: shelf30, fc: forecastOf(lam30, shelf30), lambda: splitOf(lam30, Ws) };
  const rawTot = MARKETS.reduce((a, m) => a + all30.raw[m], 0);
  const lamIn = {};
  for (const m of MARKETS) lamIn[m] = rawTot > 0 ? (Ws * all30.raw[m]) / rawTot : 0;
  const shelfIn = proportional(avail, all30.raw, open);
  res.policies.instock = { shelf: shelfIn, fc: forecastOf(lamIn, shelfIn), lambda: splitOf(lamIn, Ws) };
  res.policies.newsvendor = { shelf: res.shelf, fc: forecastOf(res.lambda, res.shelf), lambda: splitOf(res.lambda, Ws) };
  for (const m of Object.keys(res.lambda)) res.lambda[m] = U.round3(res.lambda[m]);
  return res;
}

module.exports = {
  PLATFORM_LIMITS,
  TRANSLATE_MAX,
  POOL,
  poolPriceOf,
  poolOutlet,
  splitOf,
  provenOn,
  hadAuto,
  eldoradoActive,
  eligibility,
  marketShares,
  greedyFill,
  proportional,
  forecastOf,
  capInfo,
  placeGame,
};
