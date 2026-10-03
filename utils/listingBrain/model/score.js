// The listing brain's scorer (docs/LISTING-BRAIN-PLAN.md §5): how good is it, without changing a price.
//
// Six scores, each against what really sold at the price that was really asked:
//   calibration      every live system-made listing's chance to sell within its horizon (pH at its ask)
//                    against the baseline "every listing on this market sells at the market's base rate";
//                    Brier, reliability (10 bins), skill = 1 − Brier ÷ baseline Brier, per farm
//   discrimination   realised sell rates of the rows the brain told to hold / lower / raise / test
//   placement        units sold per game × market the next 7 days against each placement policy's forecast
//                    (the farm brain's admission rule and its "missing is not zero" rule)
//   agreement        realised net per listing-day near each price policy's price against further away —
//                    correlation, never cause
//   sold or expired  no-claim units live at the forecast: the share expected to sell before their stock
//                    expires against the share that did
//   decision review  the largest logged disagreements a week old, with what sold next
// Two timings, as in the farm brain: a BACKTEST that works from day one (each of the last weeks replayed
// from the bundle as of its cut, through the model's own buildRun) and a FORWARD score of the logged daily
// forecasts, each scored once its horizon has passed.
//
// PURE: no database, no network, no settings, no clock but the bundle's `now` and the caller's `now`.
// The model façade (../model) is required lazily, inside the functions: model.js requires this file at
// the end of its own load, so a top-level require here would read a half-built module.
const U = require("./util");
const E = require("./evidence");
const H = require("./hazard");
const P = require("./price");

const { DAY, num, round2, round3, lower } = U;
const facade = () => require("../model");

// The reliability table's bins of the forecast chance: [0, 0.1), [0.1, 0.2), …, [0.9, 1].
const RELIABILITY_BINS = 10;
// The agreement analysis' "near": a listing whose ask is within this % of a policy's price.
const NEAR_PCT = 10;
// Placement forecasts are weekly (place.js forecastOf: 7 days); the decision review looks 7 days on.
const PLACE_DAYS = 7;
const REVIEW_DAYS = 7;
const REVIEW_LIMIT = 40;
const BACKTEST_WEEKS = 6;
// The four live-row actions the discrimination table reports (a ladder is never corrected; an unknown
// game's "hold" is an abstention, not advice — both counted apart).
const SCORED_ACTIONS = ["hold", "lower", "raise", "test"];
const PRICE_DISAGREE = new Set(["brain-lower", "brain-higher"]);
const SHELF_DISAGREE = new Set(["brain-more", "brain-fewer", "brain-add", "brain-drop"]);

const NOTE =
  "The brain's chance to sell is scored against a baseline that gives every listing on a market that market's base rate. " +
  "The model must beat the baseline (skill above 0) before anything it says is trusted.";
const CANNOT_SHOW =
  "What test mode cannot show: whether a different price would have sold. Every score here compares what the brain would " +
  "have said with what happened at the price that was actually asked; that needs live price experiments, a later round.";
const AGREEMENT_NOTE =
  "Correlation, not cause: listings that happened to sit near a policy's price are no proof that the price made them sell.";

const finite = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round4 = (n) => Math.round(num(n) * 10000) / 10000;
const ratio = (a, b, r = round3) => (b > 0 ? r(a / b) : null);
const dayText = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "?");
const farmOf = (f) => (f === "noclaim" ? "noclaim" : "claim");
const pushTo = (map, k, v) => {
  let a = map.get(k);
  if (!a) map.set(k, (a = []));
  a.push(v);
};

/* ------------------------------- the bundle's truth ------------------------------ */

/**
 * What really happened, from the bundle (every time, not only before a cut): listings by id, each
 * listing's unit sales in time order, and the unit sales of SYSTEM-MADE rows per cell (the placement
 * truth — the owner's rows, claim-at-sale and bulk are not a policy's shelf).
 */
function indexBundle(bundle) {
  const b = bundle || {};
  const fees = b.fees || {};
  const byId = new Map();
  for (const L of b.listings || []) if (L && L.id) byId.set(String(L.id), L);
  const salesByLid = new Map();
  const sysByCell = new Map();
  const sysByFarm = new Map();
  for (const s of b.sales || []) {
    const t = s ? finite(s.t) : null;
    if (t === null) continue;
    const lid = s.lid ? String(s.lid) : "";
    if (!lid) continue;
    pushTo(salesByLid, lid, s);
    const L = byId.get(lid);
    if (!L || E.rowKindOf(L) !== "system") continue;
    const m = lower(L.m);
    const f = farmOf(L.f);
    const rec = { t, net: U.netOf(salePrice(L, s), m, fees) };
    pushTo(sysByCell, U.cellKey(L.g, f, m), rec);
    pushTo(sysByFarm, f, rec);
  }
  const byT = (x, y) => x.t - y.t;
  for (const list of salesByLid.values()) list.sort((x, y) => x.t - y.t || U.cmp(x.grp, y.grp) || num(x.p) - num(y.p));
  for (const list of sysByCell.values()) list.sort(byT);
  for (const list of sysByFarm.values()) list.sort(byT);
  return { now: num(b.now, 0), fees, byId, salesByLid, sysByCell, sysByFarm, units: (b.noclaim && b.noclaim.units) || [] };
}

// What a buyer paid for a unit: the sale's price, else (an unpriced record) the listing's ask — the
// stored price lifted to the market's floor, as the evidence reads every ask.
function salePrice(L, s) {
  const p = num(s && s.p, 0);
  if (p > 0) return p;
  const m = lower(L && L.m);
  return Math.max(num(L && L.p, 0), U.floorFor(m), num(L && L.vmin, 0));
}

/**
 * Did listing `id` sell inside [from, to)? Single-unit rows: its sale; quantity rows: at least one unit.
 * A single-unit row marked sold with no joined sale record sold at its last write (approximate — the
 * evidence's own rule). Null when the listing is absent from the bundle: MISSING, never "unsold".
 */
function truthSold(ix, id, from, to) {
  const L = ix.byId.get(String(id));
  if (!L) return null;
  const sales = ix.salesByLid.get(String(id)) || [];
  for (const s of sales) if (s.t >= from && s.t < to) return 1;
  const u = finite(L.u);
  if (!sales.length && U.SINGLE.has(lower(L.m)) && lower(L.st) === "sold" && u !== null && u >= from && u < to) return 1;
  return 0;
}

/** Units sold (and their net after the market's fee) by system-made rows of g × f × m inside [from, to). */
function placementTruth(ix, g, f, m, from, to) {
  let units = 0;
  let net = 0;
  for (const s of ix.sysByCell.get(U.cellKey(g, farmOf(f), lower(m))) || []) {
    if (s.t < from) continue;
    if (s.t >= to) break;
    units++;
    net += s.net;
  }
  return { units, net: round2(net) };
}

/**
 * A listing's exposure and realised net inside [from, to] — the evidence's own exposure rule
 * (evidence.exposureOf: first sale ends a single-unit row, the Gameflip 30-day expiry, a delist ends at
 * the last write), read as of `to`.
 */
function listingWindow(ix, id, from, to) {
  const L = ix.byId.get(String(id));
  if (!L) return null;
  const m = lower(L.m);
  const sales = ix.salesByLid.get(String(id)) || [];
  const before = sales.filter((s) => s.t < to);
  const Lx = Object.assign({}, L, { m }, sales.some((s) => s.t >= to) ? { _saleAfterCut: true } : null);
  const kind = E.rowKindOf(L);
  const e = E.exposureOf(Lx, before, to, (to - from) / DAY, { kind, activeAtCut: E.activeAt(Lx, before, to) });
  let net = 0;
  if (e.days > 0 && e.units > 0) {
    const inside = before.filter((s) => s.t >= e.t0 && s.t <= e.t1);
    for (const s of U.SINGLE.has(m) ? inside.slice(0, 1) : inside) net += U.netOf(salePrice(L, s), m, ix.fees);
  }
  return { days: e.days, units: e.units, net };
}

/* ---------------------------------- calibration ---------------------------------- */

/**
 * Brier score, the baseline's Brier score on the very same pairs, skill and a reliability table.
 * @param {Array} pairs [{ p: forecast chance, y: 0|1 outcome, pb: baseline chance }] — a pair missing
 *   either chance is left out of BOTH scores (the two are compared on the same rows only)
 * @returns {{ n, sold, meanP, rate, brier, brierBase, skill, verdict, reliability: [{ lo, hi, n, meanP, rate }] x 10 }}
 */
function calibration(pairs) {
  const bins = Array.from({ length: RELIABILITY_BINS }, (_, i) => ({ lo: i / RELIABILITY_BINS, hi: (i + 1) / RELIABILITY_BINS, n: 0, sp: 0, sy: 0 }));
  let n = 0;
  let sq = 0;
  let sqb = 0;
  let sp = 0;
  let sy = 0;
  for (const x of pairs || []) {
    const p = x ? finite(x.p) : null;
    const pb = x ? finite(x.pb) : null;
    const y = x && (x.y === 1 || x.y === true) ? 1 : x && (x.y === 0 || x.y === false) ? 0 : null;
    if (p === null || pb === null || y === null) continue;
    const pc = U.clamp(p, 0, 1);
    const pbc = U.clamp(pb, 0, 1);
    n++;
    sq += (pc - y) * (pc - y);
    sqb += (pbc - y) * (pbc - y);
    sp += pc;
    sy += y;
    const bin = bins[Math.min(RELIABILITY_BINS - 1, Math.floor(pc * RELIABILITY_BINS))];
    bin.n++;
    bin.sp += pc;
    bin.sy += y;
  }
  const brier = n ? round4(sq / n) : null;
  const brierBase = n ? round4(sqb / n) : null;
  // skill against a baseline that is itself perfect (Brier 0) is undefined, not −∞
  const skill = n && sqb > 0 ? round3(1 - sq / sqb) : null;
  return {
    n,
    sold: sy,
    meanP: n ? round3(sp / n) : null,
    rate: n ? round3(sy / n) : null,
    brier,
    brierBase,
    skill,
    verdict: !n ? "not enough history yet" : skill !== null && skill > 0 ? "beats the baseline" : "does not beat the baseline yet: do not trust its prices",
    reliability: bins.map((b) => ({ lo: round2(b.lo), hi: round2(b.hi), n: b.n, meanP: b.n ? round3(b.sp / b.n) : null, rate: b.n ? round3(b.sy / b.n) : null })),
  };
}

/** calibration() per farm, with a per-market breakdown (no reliability table there). */
function calibrationByFarm(records) {
  const out = {};
  for (const f of ["claim", "noclaim"]) {
    const mine = records.filter((r) => r.f === f);
    const c = calibration(mine);
    const byM = new Map();
    for (const r of mine) pushTo(byM, r.m, r);
    c.byMarket = {};
    for (const m of U.MARKETS) {
      if (!byM.has(m)) continue;
      const x = calibration(byM.get(m));
      delete x.reliability;
      c.byMarket[m] = x;
    }
    out[f] = c;
  }
  return out;
}

/* -------------------------------- discrimination -------------------------------- */

/**
 * Realised sell rates within the horizon by what the brain told each live row.
 * @param {Array} records [{ f, a: action | "abstained", y: 0|1 }]
 * @returns {{ claim: { n, hold: {n, sold, rate}, lower, raise, test, ladder, abstained }, noclaim }}
 */
function discrimination(records) {
  const out = {};
  for (const f of ["claim", "noclaim"]) {
    const t = { n: 0 };
    for (const a of SCORED_ACTIONS.concat(["ladder", "abstained"])) t[a] = { n: 0, sold: 0, rate: null };
    out[f] = t;
  }
  for (const r of records || []) {
    const t = out[farmOf(r.f)];
    const a = t[r.a] ? r.a : null;
    if (!a) continue;
    t[a].n++;
    t[a].sold += r.y ? 1 : 0;
    if (SCORED_ACTIONS.includes(a)) t.n++;
  }
  for (const t of Object.values(out)) for (const k of Object.keys(t)) if (t[k] && typeof t[k] === "object") t[k].rate = ratio(t[k].sold, t[k].n);
  return out;
}

/* ------------------------------------ placement ----------------------------------- */

// Three numbers per policy, as the farm brain's scorer: MAE (easy to read), RMSE (the ranking — it is
// minimised by the mean, the number a shelf needs; MAE is minimised by the median, which for a cell
// selling under one a week is ZERO and would reward an empty shelf) and the bias.
function newScore() {
  return { n: 0, absErr: 0, sqErr: 0, err: 0, forecast: 0, actual: 0 };
}
function addScore(s, f, a) {
  s.n++;
  s.absErr += Math.abs(f - a);
  s.sqErr += (f - a) * (f - a);
  s.err += f - a;
  s.forecast += f;
  s.actual += a;
}
function finishScore(s) {
  return {
    n: s.n,
    rmse: s.n ? round3(Math.sqrt(s.sqErr / s.n)) : null,
    mae: s.n ? round3(s.absErr / s.n) : null,
    bias: s.n ? round3(s.err / s.n) : null,
    forecast: round2(s.forecast),
    actual: s.actual,
  };
}

/**
 * A placement policy's 7-day forecast for one logged cell row, or null when it has none.
 * A null in the log is MISSING — except where the model's own row says the policy's shelf on this cell is
 * zero: the expected units sold from an empty shelf is E[min(D, 0)] = 0 whatever the demand, so that is a
 * forecast of 0, not a missing one. place.js logs a forecast only for markets in a policy's shelf: the
 * brain's three policies (newsvendor, share30, instock) shelve only open markets, so a closed, unknown or
 * unmeasured cell — logged with the brain's shelf `br.sh` = 0 — is 0 for all three; today's flat split
 * leaves out the markets it deals nothing to, logged with `old.sh` = 0. A game the brain abstained on (no
 * fresh demand row: regime "unknown") has no forecast at all.
 */
function forecastFor(row, policy) {
  const v = row && row.pf ? finite(row.pf[policy]) : null;
  if (v !== null) return v;
  if (!row || !row.br || row.br.rg === "unknown") return null;
  const sh = policy === "flat" ? row.old && row.old.sh : row.br.sh;
  return sh === 0 ? 0 : null;
}

/**
 * ONE admission rule (the farm brain's): a cell-week is scored when it sold or ANY policy forecast a sale
 * (> 0 at two decimals). Each policy is scored on the admitted rows it has a number for; one with no
 * number on an admitted row is MISSING there — never a forecast of 0 — and is flagged `partial`.
 * @returns {boolean} admitted
 */
function admitRow(by, farm, forecasts, actual) {
  const ids = U.PLACE_POLICIES;
  const anySale = ids.some((id) => forecasts[id] !== null && forecasts[id] !== undefined && round2(forecasts[id]) > 0);
  if (!actual && !anySale) return false;
  const f = by[farm] || (by[farm] = { rows: 0, units: 0, s: {} });
  f.rows++;
  f.units += actual;
  for (const id of ids) {
    const v = finite(forecasts[id]);
    if (v === null) continue; // missing on this row: the policy becomes partial, never a 0
    if (!f.s[id]) f.s[id] = newScore();
    addScore(f.s[id], v, actual);
  }
  return true;
}

/** Per farm: each policy's score, the admitted rows, the winner and the policies that may not compete. */
function finishPlacement(by, extra = {}) {
  const ids = U.PLACE_POLICIES;
  const scores = {};
  const out = {};
  for (const farm of ["claim", "noclaim"]) {
    const f = by[farm] || { rows: 0, units: 0, s: {} };
    const t = { rows: f.rows, n: f.rows, units: f.units };
    for (const id of ids) {
      const s = finishScore(f.s[id] || newScore());
      if (s.n < f.rows) s.partial = true;
      t[id] = s;
    }
    scores[farm] = Object.fromEntries(ids.map((id) => [id, t[id]]));
    t.partial = ids.filter((id) => t[id].partial);
    Object.assign(t, extra[farm] || {});
    out[farm] = t;
  }
  const best = bestOf(scores);
  for (const farm of Object.keys(out)) out[farm].best = best[farm] ? best[farm].id : null;
  return out;
}

/**
 * The policy with the lowest RMSE per farm (ties: the smaller |bias|, then the policy order), among the
 * policies scored on the very same rows: a `partial` one, or one scored on fewer rows than another
 * ("not enough history yet"), is never ranked.
 * @param {object} scores { farm: { policy: { n, rmse, mae, bias, partial } } }
 * @returns {{ [farm]: { id, n, rmse, mae, bias } }}
 */
function bestOf(scores) {
  const order = U.PLACE_POLICIES;
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  const best = {};
  for (const [farm, m] of Object.entries(scores || {})) {
    if (!m || typeof m !== "object") continue;
    const list = Object.entries(m).filter(([, s]) => s && typeof s === "object" && finite(s.n) !== null && "rmse" in s);
    const maxN = list.reduce((a, [, s]) => Math.max(a, num(s.n)), 0);
    let pick = null;
    for (const [id, s] of list.sort((a, b) => rank(a[0]) - rank(b[0]) || U.cmp(a[0], b[0]))) {
      if (!(num(s.n) > 0) || s.partial || num(s.n) < maxN || finite(s.rmse) === null) continue;
      const better = !pick || s.rmse < pick.rmse || (s.rmse === pick.rmse && Math.abs(num(s.bias)) < Math.abs(num(pick.bias)));
      if (better) pick = { id, n: s.n, rmse: s.rmse, mae: s.mae, bias: s.bias };
    }
    if (pick) best[farm] = pick;
  }
  return best;
}

/* ------------------------------------ agreement ----------------------------------- */

/**
 * Realised net per listing-day of listings priced within NEAR_PCT % of each price policy's price against
 * listings further away, by market. Correlation, never cause (AGREEMENT_NOTE).
 * @param {Array} records [{ m, ask, pol: { old, tracker, curve, clear }, net, days }]
 * @returns {{ [m]: { [policy]: { near: { n, net, days, netPerDay }, far: {...} } } }}
 */
function agreement(records) {
  const policies = U.PRICE_POLICIES;
  const acc = new Map();
  for (const r of records || []) {
    const ask = finite(r && r.ask);
    if (ask === null || !r.pol) continue;
    for (const pol of policies) {
      const price = finite(r.pol[pol]);
      if (price === null || !(price > 0)) continue;
      const side = Math.abs(ask - price) <= (NEAR_PCT / 100) * price + 1e-9 ? "near" : "far";
      const k = r.m + "|" + pol;
      if (!acc.has(k)) acc.set(k, { near: { n: 0, net: 0, days: 0 }, far: { n: 0, net: 0, days: 0 } });
      const a = acc.get(k)[side];
      a.n++;
      a.net += num(r.net);
      a.days += num(r.days);
    }
  }
  const out = {};
  for (const m of U.MARKETS) {
    for (const pol of policies) {
      const a = acc.get(m + "|" + pol);
      if (!a) continue;
      if (!out[m]) out[m] = {};
      const fin = (x) => ({ n: x.n, net: round2(x.net), days: round2(x.days), netPerDay: x.days > 0 ? round3(x.net / x.days) : null });
      out[m][pol] = { near: fin(a.near), far: fin(a.far) };
    }
  }
  return out;
}

/* --------------------------------- sold or expired -------------------------------- */

/**
 * When a no-claim unit's stock expires, as the model reads it (price.perishOf): a claim window — learned
 * from the ledger, the game's own else every game's — after the end of the unit's wave. Null when no
 * wave dates it.
 */
function unitExpiry(ev, u) {
  const end = ev.noclaim.waveEndOf(u);
  if (end === null || end === undefined) return null;
  const win = ev.noclaim.claimWindowByGame && ev.noclaim.claimWindowByGame.has(u.g) ? ev.noclaim.claimWindowByGame.get(u.g) : num(ev.noclaim.claimWindowDays, 0);
  return end + win * DAY;
}

/**
 * The share of no-claim units the brain expected to sell before their stock expired against the share that
 * did, and the Brier score per unit.
 * @param {Array} records [{ g, m, p: chance to sell before expiry, y: 0|1 }]
 */
function soldOrExpired(records, skipped = null) {
  const by = new Map();
  let n = 0;
  let sp = 0;
  let sy = 0;
  let sq = 0;
  for (const r of records || []) {
    const p = finite(r && r.p);
    if (p === null) continue;
    const y = r.y ? 1 : 0;
    n++;
    sp += p;
    sy += y;
    sq += (p - y) * (p - y);
    if (!by.has(r.g)) by.set(r.g, { n: 0, sp: 0, sy: 0, sq: 0 });
    const g = by.get(r.g);
    g.n++;
    g.sp += p;
    g.sy += y;
    g.sq += (p - y) * (p - y);
  }
  const byGame = {};
  for (const g of [...by.keys()].sort(U.cmp)) {
    const x = by.get(g);
    byGame[g] = { n: x.n, expected: round3(x.sp / x.n), actual: round3(x.sy / x.n), sold: x.sy, expired: x.n - x.sy, brier: round4(x.sq / x.n) };
  }
  const out = {
    n,
    expected: n ? round3(sp / n) : null,
    actual: n ? round3(sy / n) : null,
    sold: sy,
    expired: n - sy,
    brier: n ? round4(sq / n) : null,
    byGame,
  };
  if (skipped) out.skipped = Object.assign({}, skipped);
  return out;
}

/**
 * Score the no-claim units live at T (records pushed to `t.soe`). Units of one wave on one market share
 * one queue: a Gameflip chain shows one unit at a time, a GGSel / Plati pool sells oldest first — either
 * way the offer sells at the hazard h(x) per listing-day of each live row while stock lasts, so of k units
 * with d days to their expiry E[min(Poisson(h·rows·d), k)] are expected to sell (the expected-units rule
 * the placement uses) — each unit's chance is that ÷ k. A unit counts only when its expiry is dated and
 * after T (the model ignores an estimate a unit has already outlived), its expiry has passed by `now`, and
 * the ledger says how it ended (sold, or expired).
 * @param {object} o { units (live at T), expiryOf(u), fc (the forecasts logged at T), hz (no-claim fit),
 *                     tierOf(g), T, now }
 */
function scoreUnits(t, { units, expiryOf, fc, hz, tierOf, T, now }) {
  const live = new Map();
  const cellX = new Map();
  for (const x of fc || []) {
    if (!x || farmOf(x.f) !== "noclaim") continue;
    live.set(String(x.l), x);
    const v = finite(x.x);
    if (v !== null) pushTo(cellX, x.k + "|" + lower(x.m), v);
  }
  const groups = new Map();
  for (const u of units || []) {
    if (!u) continue;
    const exp = expiryOf(u);
    if (exp === null) {
      t.soeSkip.undated++;
      continue;
    }
    if (!(exp > T)) {
      t.soeSkip.past++;
      continue;
    }
    if (exp > now) {
      t.soeSkip.open++;
      continue;
    }
    const s = finite(u.s);
    const sold = s !== null && s >= T;
    const expired = !sold && finite(u.x) !== null;
    if (!sold && !expired) {
      t.soeSkip.unresolved++;
      continue;
    }
    const m = lower(u.m);
    const k = [u.g, m, lower(u.bk), exp].join("|");
    if (!groups.has(k)) groups.set(k, { g: u.g, m, exp, units: [] });
    groups.get(k).units.push({ u, y: sold ? 1 : 0 });
  }
  for (const k of [...groups.keys()].sort(U.cmp)) {
    const gr = groups.get(k);
    const rows = new Map();
    for (const { u } of gr.units) {
      for (const lid of u.lids || []) {
        const x = live.get(String(lid));
        if (x && lower(x.m) === gr.m) rows.set(String(lid), x);
      }
    }
    const xs = [...rows.values()].map((x) => finite(x.x)).filter((v) => v !== null);
    const cx = cellX.get(gr.g + "|" + gr.m) || [];
    // the offer's own live rows at T, else the cell's other live rows, else an offer at its reference
    const x = xs.length ? U.median(xs) : cx.length ? U.median(cx) : 1;
    const h = H.hazardAt(hz, gr.m, tierOf(gr.g), x);
    if (h === null) {
      t.soeSkip.noEstimate += gr.units.length;
      continue;
    }
    const kk = gr.units.length;
    const mu = h * Math.max(1, rows.size) * ((gr.exp - T) / DAY);
    const p = U.expectedSold(mu, kk) / kk;
    for (const { y } of gr.units) t.soe.push({ g: gr.g, m: gr.m, p: round4(p), y });
  }
}

/* --------------------------------- one forecast set -------------------------------- */

const newExtra = () => ({ unitsAll: 0, unforecast: { cells: 0, units: 0 }, unmeasured: { cells: 0, units: 0 }, outside: 0 });

function newTables() {
  return {
    cal: [],
    disc: [],
    place: {},
    // per farm: every unit system-made rows sold in the scored weeks, and where the ones not admitted went
    placeExtra: { claim: newExtra(), noclaim: newExtra() },
    agree: [],
    soe: [],
    soeSkip: { undated: 0, past: 0, open: 0, unresolved: 0, noEstimate: 0 },
    soeSeen: false,
    counts: { forecasts: 0, scored: 0, waiting: 0, missing: 0, unmeasured: 0, noP: 0, noBase: 0 },
  };
}

/**
 * Score one set of per-listing forecasts made at T (a backtest cut's run.fc, or a logged daily sample):
 * calibration, discrimination and agreement. A forecast is scored once T + its horizon ≤ now; a listing
 * absent from the bundle is skipped and counted `missing` (never "unsold").
 * @param {object} o { fc, rowsByKey: Map(cell → row at T), ix, T, now, hzBase: { claim, noclaim } (the
 *                     fit the baseline's market rates come from), cfg }
 * @returns {{ scored, sold }}
 */
function scoreForecasts(t, { fc, rowsByKey, ix, T, now, hzBase, cfg }) {
  let scored = 0;
  let sold = 0;
  for (const x of fc || []) {
    if (!x || !x.l) continue;
    t.counts.forecasts++;
    const f = farmOf(x.f);
    const m = lower(x.m);
    const h = num(x.h, 0) > 0 ? num(x.h) : f === "noclaim" ? cfg.horizonDaysNoclaim : cfg.horizonDaysClaim;
    const to = T + h * DAY;
    if (to > now) {
      t.counts.waiting++;
      continue;
    }
    const y = truthSold(ix, x.l, T, to);
    if (y === null) {
      t.counts.missing++;
      continue;
    }
    t.counts.scored++;
    scored++;
    sold += y;
    // ZeusX records no sale for an auto row: "never sold" there is a blind spot, not an outcome — it
    // would read as a row the brain judged badly in every table but the calibration (where its chance
    // is already null: the market is never fitted)
    if (H.UNMEASURED.has(m)) {
      t.counts.unmeasured++;
      continue;
    }
    const p = finite(x.p);
    const pb = hzBase && hzBase[f] ? H.baseP(hzBase[f], m, h) : null;
    if (p === null) t.counts.noP++;
    else if (pb === null) t.counts.noBase++;
    else t.cal.push({ f, m, p, y, pb });
    const row = rowsByKey.get(U.cellKey(x.k, f, m));
    const abstained = !!(row && row.br && row.br.rg === "unknown");
    t.disc.push({ f, a: abstained ? "abstained" : x.a, y });
    if (row && row.pol) {
      const w = listingWindow(ix, x.l, T, to);
      if (w) t.agree.push({ m, ask: finite(x.ask), pol: row.pol, net: w.net, days: w.days });
    }
  }
  return { scored, sold };
}

/**
 * Score one set of cell rows made at T against the units system-made rows sold in [T, T + 7 d).
 * ZeusX records no sale for an auto row: its cells can never be scored (counted `unmeasured`). A row no
 * policy has a number for is outside the placement (an abstention, a managed cell) — its units are counted
 * `unforecast`, never admitted.
 * @returns {{ cells, units }} admitted rows and their units
 */
function scorePlacement(t, { rows, ix, T }) {
  const to = T + PLACE_DAYS * DAY;
  const policies = U.PLACE_POLICIES;
  let cells = 0;
  let units = 0;
  for (const f of ["claim", "noclaim"]) for (const s of ix.sysByFarm.get(f) || []) if (s.t >= T && s.t < to) t.placeExtra[f].unitsAll++;
  for (const r of rows || []) {
    if (!r || r.m === "all") continue;
    const f = farmOf(r.f);
    const m = lower(r.m);
    const actual = placementTruth(ix, r.k, f, m, T, to).units;
    if (H.UNMEASURED.has(m)) {
      t.placeExtra[f].unmeasured.cells++;
      t.placeExtra[f].unmeasured.units += actual;
      continue;
    }
    const fcs = {};
    let any = false;
    for (const p of policies) {
      fcs[p] = forecastFor(r, p);
      if (fcs[p] !== null) any = true;
    }
    if (!any) {
      if (actual) {
        t.placeExtra[f].unforecast.cells++;
        t.placeExtra[f].unforecast.units += actual;
      }
      continue;
    }
    if (admitRow(t.place, f, fcs, actual)) {
      cells++;
      units += actual;
    }
  }
  return { cells, units };
}

/** The tables, finished. */
function finishTables(t) {
  const extra = {};
  for (const f of ["claim", "noclaim"]) {
    const x = t.placeExtra[f];
    const admitted = (t.place[f] && t.place[f].units) || 0;
    // units sold on cells the forecast had no row for (a game or market first listed after it)
    extra[f] = Object.assign({}, x, { outside: Math.max(0, x.unitsAll - admitted - x.unforecast.units - x.unmeasured.units) });
  }
  return {
    calibration: calibrationByFarm(t.cal),
    discrimination: discrimination(t.disc),
    placement: finishPlacement(t.place, extra),
    agreement: agreement(t.agree),
    agreementNote: AGREEMENT_NOTE,
    soldOrExpired: t.soeSeen ? soldOrExpired(t.soe, t.soeSkip) : null,
    counts: Object.assign({}, t.counts),
  };
}

const rowsIndex = (rows) => {
  const map = new Map();
  for (const r of rows || []) if (r && r.m !== "all") map.set(U.cellKey(r.k, farmOf(r.f), lower(r.m)), r);
  return map;
};

const cfgOf = (bundle, cfg) => Object.assign({}, U.readConfig((bundle && bundle.af) || {}), cfg && typeof cfg === "object" ? cfg : {});

/* ------------------------------------- backtest ------------------------------------ */

// What a replayed week cannot know, said beside its numbers.
const BACKTEST_LIMITS = [
  "Each week is replayed from the bundle as it stood at the cut: listings created, sales made and orders priced before it only.",
  "The farm brain's demand at a cut is our own 45-day average then (its default estimator); no cool-down history is replayed.",
  "Today's old-side numbers (new-listing prices, the flat split, the tracker's suggestion) stand in for the old side at each cut: the bundle holds only today's.",
  "Weekly cuts see a no-claim expiry at most a week ahead; the daily forward samples see its last days.",
];

/**
 * The bundle as the model would have seen it at `cut`: its clock moved back, and the farm brain's rows
 * replaced by the demand the evidence synthesises at the cut (backtest mode). buildRun then sees nothing
 * dated after the cut — buildEvidence's own "as of" rule.
 */
function viewAt(bundle, cut, ev) {
  return Object.assign({}, bundle, { now: cut, demand: [...ev.demand.values()] });
}

function startBacktest(bundle, { cfg, weeks = BACKTEST_WEEKS, cuts: at = null } = {}) {
  if (!bundle || typeof bundle !== "object") throw new Error("listing brain scorer: no bundle to replay");
  const C = cfgOf(bundle, cfg);
  const W = Math.max(0, Math.min(52, Math.floor(num(weeks, BACKTEST_WEEKS))));
  const now = num(bundle.now, 0);
  const cuts = [];
  if (Array.isArray(at)) {
    // explicit moments (a test, a closer look at one wave): only those strictly before the bundle's now
    for (const c of at) if (finite(c) !== null && Number(c) < now) cuts.push(Number(c));
    cuts.sort((a, b) => a - b);
  } else for (let w = W; w >= 1; w--) cuts.push(now - w * 7 * DAY);
  return { bundle, cfg: C, now, cuts, ix: indexBundle(bundle), t: newTables(), weeks: [] };
}

/** Score the run the model made at one cut. */
function scoreRun(st, run, cut) {
  const ev = run.ctx.ev;
  const hz = run.ctx.hz;
  const t = st.t;
  const fc = scoreForecasts(t, { fc: run.fc, rowsByKey: rowsIndex(run.rows), ix: st.ix, T: cut, now: st.now, hzBase: hz, cfg: st.cfg });
  const pl = cut + PLACE_DAYS * DAY <= st.now ? scorePlacement(t, { rows: run.rows, ix: st.ix, T: cut }) : { cells: 0, units: 0 };
  const before = t.soe.length;
  const live = ev.noclaim.units.filter((u) => u.stc === "listed");
  if (live.length) t.soeSeen = true;
  scoreUnits(t, { units: live, expiryOf: (u) => unitExpiry(ev, u), fc: run.fc, hz: hz.noclaim, tierOf: (g) => P.gameState(ev, g, "noclaim").tier, T: cut, now: st.now });
  return {
    cut,
    day: dayText(cut),
    listings: (run.fc || []).length,
    scored: fc.scored,
    sold: fc.sold,
    cells: pl.cells,
    units: pl.units,
    noclaimUnits: t.soe.length - before,
  };
}

function finishBacktest(st) {
  const out = finishTables(st.t);
  return Object.assign(
    {
      weeks: st.weeks,
      from: st.cuts.length ? st.cuts[0] : null,
      to: st.now,
      horizonDays: { claim: st.cfg.horizonDaysClaim, noclaim: st.cfg.horizonDaysNoclaim },
    },
    out,
    { note: NOTE, cannotShow: CANNOT_SHOW, limits: BACKTEST_LIMITS.slice() },
  );
}

/**
 * Replay the last `weeks` weeks (backtest from day one). For each cut = bundle.now − w × 7 d: the evidence
 * as of the cut (buildEvidence, demand synthesised), the model's own run on the bundle as it stood then
 * (buildRun: fit, prices, actions, shelves, per-listing forecasts), every forecast scored against the
 * bundle's later sales.
 * @param {object} bundle plan §2.1
 * @param {object} [o] { cfg: readConfig(), weeks = 6, cuts: [ms] (explicit moments instead of weekly cuts) }
 */
function backtest(bundle, opts = {}) {
  const st = startBacktest(bundle, opts);
  const M = facade();
  for (const cut of st.cuts) {
    const ev = E.buildEvidence(bundle, { cfg: st.cfg, cut, synthDemand: true });
    const run = M.buildRun(viewAt(bundle, cut, ev), { cfg: st.cfg });
    st.weeks.push(scoreRun(st, run, cut));
  }
  return finishBacktest(st);
}

/** The same replay, yielding the event loop between weeks and inside each (the async evidence and run). */
async function backtestAsync(bundle, opts = {}) {
  const st = startBacktest(bundle, opts);
  const M = facade();
  for (const cut of st.cuts) {
    await U.yieldNow();
    const ev = await E.buildEvidenceAsync(bundle, { cfg: st.cfg, cut, synthDemand: true });
    await U.yieldNow();
    const run = await M.buildRunAsync(viewAt(bundle, cut, ev), { cfg: st.cfg });
    await U.yieldNow();
    st.weeks.push(scoreRun(st, run, cut));
  }
  return finishBacktest(st);
}

/* -------------------------------------- forward ------------------------------------- */

// The first sample of each UTC day (the runner logs one; a duplicate after a restart is harmless and
// ignored here), oldest first.
function dailyFirst(samples) {
  const list = (samples || []).map((s) => ({ s, at: finite(s && s.at) === null ? new Date(s && s.at).getTime() : Number(s.at) })).filter((x) => Number.isFinite(x.at));
  list.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const d = dayText(x.at);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(Object.assign({}, x.s, { at: x.at }));
  }
  return out;
}

/**
 * Score the logged daily forecasts once their horizon has passed (forward). Same tables as the backtest.
 * Truth comes from the bundle's sales by listing id; a listing absent from the bundle is skipped and
 * counted `missing`. The baseline's market rates come from one fit on the evidence as of the OLDEST scored
 * sample — never from anything after a forecast it judges. No-claim units live at each sample are scored
 * for sold-or-expired when the bundle carries the unit ledger.
 * @param {object} o { samples: [{ at, fc: [FC], rows: [Row slim] }], bundle, cfg, now }
 */
function forwardScores({ samples = [], bundle, cfg, now } = {}) {
  const t = newTables();
  const out = { runsScored: 0, runsWaiting: 0, missing: 0, samples: 0, baselineAt: null };
  const list = dailyFirst(samples);
  out.samples = list.length;
  if (!bundle || typeof bundle !== "object") return Object.assign(out, finishTables(t), { note: NOTE, cannotShow: CANNOT_SHOW });
  const C = cfgOf(bundle, cfg);
  const N = finite(now) !== null ? Number(now) : num(bundle.now, 0);
  const ix = indexBundle(bundle);
  const minH = Math.min(C.horizonDaysClaim, C.horizonDaysNoclaim);
  const due = (s) => (s.fc || []).some((x) => x && s.at + num(x.h, minH) * DAY <= N) || s.at + PLACE_DAYS * DAY <= N || (ix.units.length && s.at + minH * DAY <= N);
  const scorable = list.filter(due);
  let ev0 = null;
  let hz0 = null;
  if (scorable.length) {
    out.baselineAt = scorable[0].at;
    ev0 = E.buildEvidence(bundle, { cfg: C, cut: scorable[0].at, synthDemand: true });
    hz0 = { claim: H.fitHazard(ev0, "claim"), noclaim: H.fitHazard(ev0, "noclaim") };
  }
  for (const s of list) {
    if (!due(s)) {
      out.runsWaiting++;
      continue;
    }
    out.runsScored++;
    const T = s.at;
    const rowsByKey = rowsIndex(s.rows);
    scoreForecasts(t, { fc: s.fc, rowsByKey, ix, T, now: N, hzBase: hz0, cfg: C });
    if (T + PLACE_DAYS * DAY <= N) scorePlacement(t, { rows: s.rows, ix, T });
    if (ix.units.length) {
      const live = ix.units.filter((u) => {
        const l = finite(u && u.l);
        const so = finite(u && u.s);
        const x = finite(u && u.x);
        return l !== null && l < T && !(so !== null && so < T) && !(x !== null && x < T);
      });
      if (live.length) t.soeSeen = true;
      scoreUnits(t, { units: live, expiryOf: (u) => unitExpiry(ev0, u), fc: s.fc, hz: hz0.noclaim, tierOf: (g) => P.gameState(ev0, g, "noclaim").tier, T, now: N });
    }
  }
  out.missing = t.counts.missing;
  return Object.assign(out, finishTables(t), { note: NOTE, cannotShow: CANNOT_SHOW });
}

/* ---------------------------------- decision review --------------------------------- */

/**
 * How far apart today's code and the brain are on one logged cell row, in dollars at stake: the price gap
 * times the units it applies to (units listed; a new listing is one unit), plus the shelf gap in units
 * valued at the cell's price. Only a real disagreement counts (pc brain-lower / brain-higher, sc
 * brain-more / fewer / add / drop); anything else is 0, not a gap.
 * @returns {{ any, price, units, shelf, usd }}
 */
function disagreementOf(row) {
  const o = (row && row.old) || {};
  const b = (row && row.br) || {};
  const base = finite(o.a) !== null ? finite(o.a) : finite(o.np);
  const bp = finite(b.p);
  let price = 0;
  let units = 0;
  if (row && PRICE_DISAGREE.has(row.pc) && base !== null && bp !== null) {
    price = Math.abs(bp - base);
    units = Math.max(1, Math.floor(num(o.n, 0)));
  }
  let shelf = 0;
  if (row && SHELF_DISAGREE.has(row.sc) && finite(o.sh) !== null && finite(b.sh) !== null) shelf = Math.abs(num(b.sh) - num(o.sh));
  const unitPrice = bp !== null ? bp : base !== null ? base : 0;
  return { any: price > 0 || shelf > 0, price: round2(price), units, shelf, usd: round2(price * units + shelf * unitPrice) };
}

/**
 * The largest disagreements of the logged samples at least a week old, with what happened next: units
 * system-made rows of the cell sold and their net in the 7 days after. One entry per cell, from its newest
 * such sample; largest dollars at stake first.
 * @param {object} o { samples, bundle, now, limit = 40 }
 */
function decisionReview({ samples = [], bundle, now, limit = REVIEW_LIMIT } = {}) {
  if (!bundle || typeof bundle !== "object") return [];
  const N = finite(now) !== null ? Number(now) : num(bundle.now, 0);
  const ix = indexBundle(bundle);
  const list = dailyFirst(samples).filter((s) => s.at + REVIEW_DAYS * DAY <= N);
  list.sort((a, b) => b.at - a.at);
  const seen = new Map();
  for (const s of list) {
    for (const r of s.rows || []) {
      if (!r || r.m === "all") continue;
      const f = farmOf(r.f);
      const m = lower(r.m);
      const key = U.cellKey(r.k, f, m);
      if (seen.has(key)) continue;
      const gap = disagreementOf(r);
      if (!gap.any) continue;
      const o = r.old || {};
      const b = r.br || {};
      const next = placementTruth(ix, r.k, f, m, s.at, s.at + REVIEW_DAYS * DAY);
      seen.set(key, {
        at: s.at,
        day: dayText(s.at),
        k: r.k,
        g: r.g,
        f,
        m,
        pc: r.pc,
        sc: r.sc,
        old: { a: finite(o.a), np: finite(o.np), n: finite(o.n), sh: finite(o.sh) },
        br: { p: finite(b.p), sh: finite(b.sh), cf: b.cf || null, rg: b.rg || null },
        gap: { price: gap.price, units: gap.units, shelf: gap.shelf, usd: gap.usd },
        next: { units: next.units, net: next.net, days: REVIEW_DAYS },
      });
    }
  }
  const out = [...seen.values()];
  out.sort((a, b) => b.gap.usd - a.gap.usd || b.at - a.at || U.cmp(U.cellKey(a.k, a.f, a.m), U.cellKey(b.k, b.f, b.m)));
  return out.slice(0, Math.max(0, Math.floor(num(limit, REVIEW_LIMIT))));
}

/** The run's own disagreements (one cell row each), largest dollars at stake first — the backtest script's list. */
function topDisagreements(rows, limit = 15) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.m === "all") continue;
    const gap = disagreementOf(r);
    if (gap.any) out.push({ r, gap });
  }
  out.sort((a, b) => b.gap.usd - a.gap.usd || U.cmp(U.cellKey(a.r.k, a.r.f, a.r.m), U.cellKey(b.r.k, b.r.f, b.r.m)));
  return out.slice(0, limit);
}

module.exports = {
  RELIABILITY_BINS,
  NEAR_PCT,
  PLACE_DAYS,
  REVIEW_DAYS,
  REVIEW_LIMIT,
  SCORED_ACTIONS,
  SCORE_NOTE: NOTE,
  CANNOT_SHOW,
  AGREEMENT_NOTE,
  BACKTEST_LIMITS,
  indexBundle,
  truthSold,
  placementTruth,
  listingWindow,
  calibration,
  discrimination,
  newScore,
  addScore,
  finishScore,
  forecastFor,
  admitRow,
  finishPlacement,
  bestOf,
  agreement,
  unitExpiry,
  soldOrExpired,
  scoreUnits,
  newTables,
  scoreForecasts,
  scorePlacement,
  finishTables,
  viewAt,
  backtest,
  backtestAsync,
  forwardScores,
  decisionReview,
  disagreementOf,
  topDisagreements,
};
