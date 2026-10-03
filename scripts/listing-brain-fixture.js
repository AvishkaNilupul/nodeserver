#!/usr/bin/env node
/**
 * Seeded synthetic bundle for the listing brain (docs/LISTING-BRAIN-PLAN.md §2.1 is the format, §11 the purpose).
 *
 *   node scripts/listing-brain-fixture.js                      # small bundle, seed 1, JSON on stdout
 *   node scripts/listing-brain-fixture.js --large --seed 7     # 150 games x 7 markets, ~120 days of history
 *   node scripts/listing-brain-fixture.js --out bundle.json    # write a file instead of stdout
 *
 * Everything in it is INVENTED: game names ("Alpha Quest", "Omega Saga"), prices, listing ids (12 hex drawn from
 * the PRNG, not hashes of anything real), times. The repository is public, so no real title, price, seller or
 * login may ever appear here.
 *
 * Why a generator and not a hand-written file: the model's tests have to show that it RECOVERS what was planted —
 * a price elasticity it can only see through censored exposures, a market that sold fine while it was stocked, a
 * blocked market whose prices must never leak — and that needs data drawn from a known law, at a size where the
 * law shows through the noise. `PLANTED` describes every planted truth (games, markets, true parameters and the
 * tolerance a test should use); `generate()` draws the data; tests/fixtures/listingBrain/small.json is
 * `generate()` with the defaults, committed so a model test needs no generator run.
 *
 * Deterministic: one seeded mulberry32 stream per named part (a game, the ids, the final pass), so adding a filler
 * game never reshuffles a planted one; the only clock is the `now` argument (default 2026-10-03T12:00Z). No
 * Math.random, no Date.now. It requires only pure helpers: setIdentity (real-format content and band keys), venues
 * (the platform floors) and stats (the radar's quartiles). Nothing runs on require; the CLI runs only under
 * `require.main === module`.
 */
const { identify, normGame } = require("../utils/priceTracker/setIdentity");
const { floorFor } = require("../utils/priceTracker/venues");
const stats = require("../utils/priceTracker/stats");

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const DEFAULT_NOW = Date.UTC(2026, 9, 3, 12);
const MARKETS = ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];
const ORDER_UNIT = new Set(["eldorado", "playerauctions", "g2g"]);
// The owner's switches as listActivatedTask reads them: Digiseller (Plati) is blocked, everything else takes stock.
const TAKES = {
  gameflip: true,
  digiseller: false,
  ggsel: true,
  zeusx: true,
  eldorado: true,
  playerauctions: true,
  g2g: true,
};
// Today's auto-lister market order (autoLister rule 4) in tracker keys, each only while its switch is on.
const OLD_ORDER = MARKETS.filter((m) => TAKES[m]);
// Relative to `now` so any `now` gives the same story: Digiseller blocked by the owner (2026-09-28 for the default
// now), and the 2026-10-01 pass that finally closed Gameflip rows left `active` past their 30-day expiry.
const BLOCKED_DAYS_AGO = 5.5;
const CLEANUP_DAYS_AGO = 2.375;
// No-claim drops outlive their wave by a claim window nobody states; here it is 20-28 h (median 24 h).
const CLAIM_WINDOW_H = [20, 28];
const GF_EXPIRY_DAYS = 30;
const RECENT_SHARE = 0.25;
const RECENT_DAYS = 28;
const ELD_LIFE_DAYS = 21;

// The laws the fixture draws sales from. Hazard h(x) = h0 * exp(-beta * (x - 1)), x = ask / ref, in units per
// listing-day (single-unit markets: per row-day; quantity and order-unit markets: per in-stock day of an offer).
// Only `claim.gameflip` is a planted truth with a tolerance (PLANTED.A); the others make plausible filler.
const LAWS = {
  claim: {
    gameflip: { h0: 0.12, beta: 1.6 },
    ggsel: { h0: 0.1, beta: 1.2 },
    eldorado: { h0: 0.14, beta: 1.0 },
    g2g: { h0: 0.07, beta: 1.0 },
    playerauctions: { h0: 0.02, beta: 0 },
    digiseller: { h0: 0.08, beta: 0 },
    zeusx: { h0: 0, beta: 0 }, // ZeusX records no sale for an auto row (venues.js)
  },
  noclaim: {
    gameflip: { h0: 0.9, beta: 1.4 },
    ggsel: { h0: 0.8, beta: 1.2 },
    digiseller: { h0: 0.4, beta: 0 },
  },
};
// Ask/ref design of the Gameflip claim rows: [lo, hi, weight] per BUCKETS of plan §4.3, x uniform inside. Most
// rows go where PLANTED.A's ratio is read (around 0.9 and 1.35-1.75); the ends are covered, thinner.
const X_DESIGN = [
  [0.6, 0.8, 9],
  [0.8, 1.0, 25],
  [1.0, 1.2, 13],
  [1.2, 1.5, 20],
  [1.5, 2.0, 24],
  [2.0, 2.2, 9],
];
// Price level of an offer on each market relative to its Gameflip reference price R. Digiseller's 3x is planted
// (PLANTED.E): a blocked market whose prices must never teach another market.
const LEVEL = { gameflip: 1, ggsel: 0.85, eldorado: 1.1, g2g: 1.05, zeusx: 1, digiseller: 3 };
const ROWS = { ggsel: 2, eldorado: 3, g2g: 2, playerauctions: 1, zeusx: 2, digiseller: 2 };
const QTY = { ggsel: [2, 5], eldorado: [2, 5], g2g: [1, 3], playerauctions: [1, 2], digiseller: [2, 5] };
const LIFE = {
  ggsel: [15, 40],
  eldorado: [10, 30],
  g2g: [15, 45],
  playerauctions: [20, 60],
  zeusx: [10, 40],
  digiseller: [20, 50],
};

// prettier-ignore
const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu",
  "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi"];
// prettier-ignore
const NOUNS = ["Quest", "Arena", "Rush", "Forge", "Rift", "Siege", "Drift", "Tactics", "Raiders", "Racers", "Kingdoms",
  "Frontier", "Outpost", "Wars", "Dungeon", "Galaxy", "Strike", "Harbor", "Tides", "Colony", "Arcana", "Horizon",
  "Orchard", "Canyon", "Lantern", "Meadow", "Citadel"];
// prettier-ignore
const EVENTS = ["Frost Cup", "Ember League", "Tide Series", "Sun Rally", "Spring Clash", "Night Open", "Dawn Trials",
  "Storm Masters", "Harvest Games", "Comet Circuit"];

/* -------------------------------------------------------------------------------------------------------------- */
/* PRNG and small helpers                                                                                         */
/* -------------------------------------------------------------------------------------------------------------- */

/** mulberry32: a tiny, well-mixed 32-bit PRNG. Returns a function giving floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a: turns a stream label into a sub-seed, so each game draws from its own stream.
function hash32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(seed, label) {
  const next = mulberry32((hash32(label) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
  return {
    u: next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor((b - a + 1) * next()),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // Exponential waiting time in days for a daily rate; a zero rate never fires.
    exp: (rate) => (rate > 0 ? -Math.log(1 - next()) / rate : Infinity),
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const snap05 = (p) => Math.max(0.05, Math.round(p * 20) / 20);
const quarter = (p) => Math.round(p * 4) / 4;
const hazard = (law, x) => law.h0 * Math.exp(-law.beta * (x - 1));
const slug = (s) => normGame(s).replace(/ /g, "-");

function marketPrice(m, R) {
  if (m === "playerauctions") return 5; // the platform floor: every PA row sits at $5
  return Math.max(floorFor(m), snap05(R * LEVEL[m]));
}

// The no-claim new-listing price, shaped like unclaimedBundles.bundlePrice (anchor capped at $2.50, x a capped
// per-item step, x the full-event bonus, nearest quarter, [floor, ceiling]). Synthetic: the real one reads research.
function bundlePriceLike(anchor, n, pricing) {
  const step = Math.min(pricing.itemCapMult, 1 + (pricing.itemStepPct / 100) * (n - 1));
  const p = quarter(Math.min(anchor, 2.5) * step * (1 + pricing.fullEventBonusPct / 100));
  return Math.max(pricing.floorUsd, Math.min(pricing.ceilingUsd, p));
}

const PRICING = {
  floorUsd: 0.75,
  ceilingUsd: 4.5,
  gameFloors: {},
  itemStepPct: 15,
  itemCapMult: 2.5,
  fullEventBonusPct: 25,
};

/* -------------------------------------------------------------------------------------------------------------- */
/* Context, records                                                                                               */
/* -------------------------------------------------------------------------------------------------------------- */

function newCtx(seed, now) {
  const idRng = makeRng(seed, "ids");
  const ids = new Set();
  return {
    seed,
    now,
    blockedAt: now - BLOCKED_DAYS_AGO * DAY,
    cleanupAt: now - CLEANUP_DAYS_AGO * DAY,
    // 12 hex from the PRNG: shaped like the loader's sha1-12 ids, derived from nothing real.
    newId() {
      for (;;) {
        const a = Math.floor(idRng.u() * 0x1000000)
          .toString(16)
          .padStart(6, "0");
        const b = Math.floor(idRng.u() * 0x1000000)
          .toString(16)
          .padStart(6, "0");
        const id = a + b;
        if (!ids.has(id)) {
          ids.add(id);
          return id;
        }
      }
    },
    games: [],
    listings: [],
    sales: [],
    demandOnly: [],
    bulkPrices: [],
    feed: [],
    radarGames: [],
    demand: [],
    units: [],
    waves: [],
    oldGames: {},
    oldOffers: {},
    mapped: {},
    caps: {},
  };
}

function addGame(ctx, name, farm, opts = {}) {
  const key = normGame(name);
  if (ctx.games.some((g) => g.key === key)) throw new Error("duplicate fixture game " + key);
  const game = { name, key, farm, opts, offers: [], radarEvents: null, g2gBrand: opts.g2gBrand };
  ctx.games.push(game);
  return game;
}

// An offer = one exact item multiset. The content and band keys come from the tracker's own identify(), so they
// have the production format ("s:<12 hex>", "<gameKey>|<band>").
function makeOffer(game, tag, n) {
  const items = [];
  for (let i = 0; i < n; i++)
    items.push({ itemKey: `${slug(game.name)}:${slug(tag)}:${i + 1}`, game: game.name, qty: 1 });
  const id = identify({ title: `${game.name} Twitch Drops (${n} Items) — ${tag}` }, { items });
  return { g: id.gameKey, gl: game.name, ck: id.contentKey, bk: id.bandKey, ex: id.exact, n };
}

function addListing(ctx, x) {
  const L = {
    id: ctx.newId(),
    g: x.offer.g,
    gl: x.offer.gl,
    m: x.m,
    o: x.o || "auto",
    f: x.f || "claim",
    kind: x.kind || "single",
    script: !!x.script,
    ck: x.offer.ck,
    bk: x.offer.bk,
    ex: x.offer.ex,
    n: x.offer.n,
    p: round2(x.p),
    vmin: x.vmin == null ? null : x.vmin,
    smin: x.smin == null ? null : x.smin,
    st: x.st,
    c: Math.round(x.c),
    u: Math.round(Math.min(ctx.now, Math.max(x.u, x.c))),
    units: (x.units || []).slice(0, 200).map((w) => ({ a: Math.round(w.a), d: w.d == null ? null : Math.round(w.d) })),
    qty: x.qty || 0,
    qr: x.qr == null ? null : x.qr,
    rb: x.rb == null ? null : Math.round(x.rb),
    pack: x.pack == null ? null : x.pack,
  };
  ctx.listings.push(L);
  return L;
}

function addSale(ctx, L, t, extra = {}) {
  const unitMarket = ORDER_UNIT.has(L.m);
  const S = {
    lid: L.id,
    g: L.g,
    m: L.m,
    o: L.o,
    f: L.f,
    ck: L.ck,
    bk: L.bk,
    ex: L.ex,
    n: L.n,
    p: round2(extra.p != null ? extra.p : L.p),
    t: Math.round(t),
    grp: extra.grp || ctx.newId(),
    basis: extra.basis || (L.o === "unclaimed" ? "paid" : unitMarket ? "listing-now" : "reported"),
    src: extra.src || (L.o === "unclaimed" ? "unclaimed" : unitMarket ? "unit" : "signal"),
  };
  ctx.sales.push(S);
  return S;
}

// A hand sale: no listing, no content identity, never price evidence (src "hand").
function addHandSale(ctx, game, farm, m, t, p) {
  ctx.sales.push({
    lid: "",
    g: game.key,
    m,
    o: "manual",
    f: farm,
    ck: null,
    bk: game.key + "|?",
    ex: false,
    n: null,
    p: round2(p),
    t: Math.round(t),
    grp: ctx.newId(),
    basis: "reported",
    src: "hand",
  });
}

function addDemandOnly(ctx, g, m, f, t, src) {
  ctx.demandOnly.push({ g, m, f, t: Math.round(t), src });
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Simulators                                                                                                     */
/* -------------------------------------------------------------------------------------------------------------- */

// One single-unit row (Gameflip / ZeusX): sells after an exponential time at daily hazard h, unless a delist, the
// 30-day Gameflip expiry or `now` comes first. Censoring is independent of the sale time, so the law is
// recoverable from (exposure, sold) pairs.
function simulateSingle(
  ctx,
  rng,
  c,
  h,
  { delistP = 0.2, expiryDays = GF_EXPIRY_DAYS, endBy = Infinity, u = null } = {},
) {
  const now = ctx.now;
  const wait = u == null ? rng.exp(h) : h > 0 ? -Math.log(1 - u) / h : Infinity;
  const saleT = c + wait * DAY;
  const delistT = Math.min(endBy, rng.chance(delistP) ? c + rng.range(2, 28) * DAY : Infinity);
  const expiryT = c + expiryDays * DAY;
  const end = Math.min(saleT, delistT, expiryT, now);
  if (end === saleT) return { st: "sold", t: saleT, u: Math.min(now, saleT + rng.range(1, 30) * MIN) };
  if (end === now) return { st: "active", u: Math.min(now - MIN, c + rng.range(0.1, 6) * HOUR) };
  if (end === delistT) return { st: "delisted", u: delistT };
  // Expired: rows stayed `active` past their expiry until the cleanup pass, so `updatedAt` overstates exposure —
  // the model must cap Gameflip exposure at createdAt + 30 d (plan §1.3 #10).
  const closed = expiryT < ctx.cleanupAt ? ctx.cleanupAt + rng.range(0, 30) * MIN : Math.min(now - MIN, expiryT + HOUR);
  return { st: "delisted", u: closed };
}

// One quantity / order-unit row: `qty` units (the first at creation, the rest added over `staggerDays`), sold one
// order at a time at daily hazard h while a unit is in stock. Eldorado offers die 21 days after creation with no
// sale. Returns the row's fate, its units and its orders.
function simulateQty(ctx, rng, { m, c, h, qty, lifeDays, endCap = Infinity, staggerDays = 3, multi = 0 }) {
  const now = ctx.now;
  const adds = [c];
  for (let k = 1; k < qty; k++) adds.push(c + rng.range(0, staggerDays) * DAY);
  adds.sort((a, b) => a - b);
  let end = Math.min(c + lifeDays * DAY, now, endCap);
  let why = end === now ? "now" : end === endCap ? "cap" : "life";
  const orders = [];
  let sold = 0;
  let t = c;
  for (;;) {
    t += rng.exp(h) * DAY;
    if (m === "eldorado" && !orders.length && t >= c + ELD_LIFE_DAYS * DAY && c + ELD_LIFE_DAYS * DAY < end) {
      end = c + ELD_LIFE_DAYS * DAY;
      why = "died";
      break;
    }
    if (t >= end) break;
    const avail = adds.filter((a) => a <= t).length - sold;
    if (avail <= 0) continue;
    let k = 1;
    if (multi && avail >= 2 && rng.chance(multi)) k = avail >= 3 && rng.chance(0.3) ? 3 : 2;
    orders.push({ t, k });
    sold += k;
    if (sold >= qty) {
      end = t;
      why = "soldout";
      break;
    }
  }
  if (m === "eldorado" && !orders.length && why !== "died" && c + ELD_LIFE_DAYS * DAY < end) {
    end = c + ELD_LIFE_DAYS * DAY;
    why = "died";
  }
  const saleTimes = [];
  for (const o of orders) for (let i = 0; i < o.k; i++) saleTimes.push(o.t);
  const units = adds.map((a, i) => ({ a, d: i < saleTimes.length ? saleTimes[i] : null }));
  const left = qty - sold;
  let st = "delisted";
  let u = end;
  if (why === "soldout") {
    st = "sold";
    u = Math.min(now, end + rng.range(1, 20) * MIN);
  } else if (why === "now") {
    st = "active";
    u = Math.min(now - MIN, Math.max(c, orders.length ? orders[orders.length - 1].t : c) + rng.range(0.1, 6) * HOUR);
  }
  return { st, u, units, orders, left, active: st === "active" };
}

// Stratified draw of ask/ref ratios over X_DESIGN, shuffled so price is not tied to creation time.
function designXs(rng, n) {
  const total = X_DESIGN.reduce((a, d) => a + d[2], 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = ((i + rng.u()) / n) * total;
    let acc = 0;
    let b = X_DESIGN[X_DESIGN.length - 1];
    for (const d of X_DESIGN) {
      acc += d[2];
      if (q <= acc) {
        b = d;
        break;
      }
    }
    out.push(b[0] + (b[1] - b[0]) * rng.u());
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.u() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// The uniforms behind each Gameflip claim row's sale time and creation time, drawn per ask bucket from a seeded
// 2-D Kronecker sequence (k * golden ratio, k * (sqrt 2 - 1), mod 1, random offsets) shared by the whole fixture.
// Each row's wait is still exactly exponential and its creation time uniform, but any run of a bucket's rows — one
// offer's, one game's, the whole fixture's — covers both evenly and pairs them evenly, so a few hundred rows show the
// planted law about as clearly as a random sample many times that size.
const PHI = 0.6180339887498949;
const SQRT2M1 = 0.41421356237309515;
function strataFor(ctx, x) {
  if (!ctx.strata) {
    const rng = makeRng(ctx.seed, "strata");
    ctx.strata = X_DESIGN.map(() => ({ k: 0, ou: rng.u(), oc: rng.u() }));
  }
  const b = X_DESIGN.findIndex((d) => x < d[1]);
  const st = ctx.strata[b === -1 ? X_DESIGN.length - 1 : b];
  const k = st.k++;
  return { u: (st.ou + k * PHI) % 1, f: (st.oc + k * SQRT2M1) % 1 };
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Claim-farm building blocks                                                                                     */
/* -------------------------------------------------------------------------------------------------------------- */

function pushSingleRow(ctx, game, entry, m, price, c, sim, extra = {}) {
  const L = addListing(ctx, {
    offer: entry.offer,
    m,
    o: extra.o || "auto",
    f: extra.f || game.farm,
    kind: extra.kind,
    p: price,
    smin: extra.smin,
    st: sim.st,
    c,
    u: sim.u,
    qty: sim.st === "active" ? 1 : 0,
  });
  if (sim.st === "sold") addSale(ctx, L, sim.t);
  return L;
}

// PLANTED.A: the Gameflip claim rows of one offer, asks spread over 0.6-2.2 x R, sold the way buyers really
// buy (H3): ONE buyer stream per offer at h(x_min) a day, x_min = the offer's lowest live ask / R, each buyer
// taking our cheapest live row (ties: the oldest). A dear row sells only once every cheaper row is gone — its
// slow sale is its rank on our own shelf, which the model must not read as the buyers' price response. Then
// older "anchor" rows at exactly R (created 96-125 days ago and ended before the 90-day fit window opens, inside
// the 180-day reference window) until R is strictly the median of the offer's Gameflip orders — so the model's
// `ref` (the realised median of that exact offer, plan §4.2 step 1) IS the R the law was written in.
function lawRows(ctx, rng, game, entry, { rows, fromDays = 88, toDays = 0.3, liveCap = Infinity, smin = null }) {
  const now = ctx.now;
  const R = entry.R;
  const law = LAWS.claim.gameflip;
  const floor = floorFor("gameflip");
  const xs = designXs(rng, rows);
  const plan = [];
  for (let i = 0; i < rows; i++) {
    // A quarter of each bucket's rows are recent (most of them still live), the rest old enough to have had their
    // whole 30-day life inside the fit window: the live rows the brain must advise on, without letting censoring at
    // `now` blur the law.
    const { f } = strataFor(ctx, xs[i]);
    const c =
      f < RECENT_SHARE
        ? now - RECENT_DAYS * DAY + (f / RECENT_SHARE) * (RECENT_DAYS - toDays) * DAY
        : now - fromDays * DAY + ((f - RECENT_SHARE) / (1 - RECENT_SHARE)) * (fromDays - GF_EXPIRY_DAYS) * DAY;
    const ask = Math.max(floor, snap05(xs[i] * R));
    // a take-down chosen in advance, independent of any sale: censoring, so the law still holds
    const delistT = rng.chance(0.1) ? c + rng.range(2, 28) * DAY : Infinity;
    plan.push({ c: Math.round(c), ask, delistT, idx: i });
  }
  // A game short of stock keeps only its newest live rows; the rest were taken down unsold a little before now.
  // Taking a row down changes who the cheapest is, so the stream is replayed (same buyer draws) until it holds.
  const seedLabel = "buyers:" + game.key + "|" + entry.offer.ck;
  let out = simulateOfferStream(ctx, plan, law, R, seedLabel);
  for (let pass = 0; pass < 3 && Number.isFinite(liveCap); pass++) {
    const live = out.filter((o) => o.st === "active").sort((a, b) => b.c - a.c);
    const extra = live.slice(liveCap);
    if (!extra.length) break;
    for (const o of extra) {
      const p = plan[o.idx];
      p.delistT = Math.round(Math.max(p.c + HOUR, now - rng.range(0.4, 3) * DAY));
      if (p.delistT >= now) p.delistT = now - MIN;
    }
    out = simulateOfferStream(ctx, plan, law, R, seedLabel);
  }
  let below = 0;
  let above = 0;
  let at = 0;
  const tally = (p) => {
    if (p < R - 1e-9) below++;
    else if (p > R + 1e-9) above++;
    else at++;
  };
  const made = [];
  for (const o of out) {
    const L = pushSingleRow(ctx, game, entry, "gameflip", o.ask, o.c, o, { smin });
    if (o.st === "sold") tally(o.ask);
    made.push(L);
  }
  const need = Math.max(Math.abs(below - above) + 1 - at, 3 - (below + above + at), 0);
  // Anchors are taken down unsold before the fit window opens: the loop stops on a sale, so an anchor's outcome is
  // not a fair draw and must never reach the live fit — they only make the median.
  let got = 0;
  for (let tries = 0; got < need && tries < need * 8 + 20; tries++) {
    const c = now - rng.range(96, 125) * DAY;
    const sim = simulateSingle(ctx, rng, c, hazard(law, 1), { delistP: 0, endBy: now - 90.5 * DAY });
    pushSingleRow(ctx, game, entry, "gameflip", R, c, sim, { smin });
    if (sim.st === "sold") {
      got++;
      tally(R);
    }
  }
  entry.prices.gameflip = R;
  return made;
}

/**
 * One offer's Gameflip rows under one buyer stream (law A, H3). Rows open at `c` and close at their planned
 * take-down, their 30-day expiry or `now`; while any is live, buyers arrive at h(x_min) a day (memoryless, so
 * the wait is drawn afresh at every change of the live set) and each takes the cheapest live row, the oldest
 * first on a tie. The buyer draws come from their own seeded stream, so a replay with one take-down moved
 * changes nothing before it. Returns each row's fate in plan order.
 */
function simulateOfferStream(ctx, plan, law, R, seedLabel) {
  const now = ctx.now;
  const rng = makeRng(ctx.seed, seedLabel);
  const fate = plan.map((p) => ({ idx: p.idx, c: p.c, ask: p.ask, end: Math.min(p.delistT, p.c + GF_EXPIRY_DAYS * DAY, now), st: null, t: null, u: null }));
  const order = fate.slice().sort((a, b) => a.c - b.c || a.idx - b.idx);
  const live = [];
  let next = 0;
  let t = order.length ? order[0].c : now;
  for (;;) {
    while (next < order.length && order[next].c <= t) live.push(order[next++]);
    let tEnd = Infinity;
    for (const r of live) tEnd = Math.min(tEnd, r.end);
    const tE = Math.min(next < order.length ? order[next].c : Infinity, tEnd, now);
    if (live.length) {
      let best = live[0];
      for (const r of live) if (r.ask < best.ask - 1e-9 || (Math.abs(r.ask - best.ask) <= 1e-9 && (r.c < best.c || (r.c === best.c && r.idx < best.idx)))) best = r;
      const tb = t + rng.exp(hazard(law, best.ask / R)) * DAY;
      if (tb < tE) {
        t = tb;
        best.st = "sold";
        best.t = Math.round(tb);
        live.splice(live.indexOf(best), 1);
        continue;
      }
    }
    if (tE >= now && next >= order.length) break;
    t = tE;
    for (let i = live.length - 1; i >= 0; i--) if (live[i].end <= t && live[i].end < now) live.splice(i, 1);
    if (t >= now && next >= order.length) break;
  }
  // every row's record, the way simulateSingle writes it
  const pick = makeRng(ctx.seed, seedLabel + ":records");
  for (const r of fate) {
    if (r.st === "sold") {
      r.u = Math.min(now, r.t + pick.range(1, 30) * MIN);
      continue;
    }
    const expiryT = r.c + GF_EXPIRY_DAYS * DAY;
    if (r.end >= now) {
      r.st = "active";
      r.u = Math.min(now - MIN, r.c + pick.range(0.1, 6) * HOUR);
    } else if (r.end < expiryT) {
      r.st = "delisted";
      r.u = r.end;
    } else {
      // Expired: rows stayed `active` past their expiry until the cleanup pass, so `updatedAt` overstates
      // exposure — the model must cap Gameflip exposure at createdAt + 30 d (plan §1.3 #10).
      r.st = "delisted";
      r.u = expiryT < ctx.cleanupAt ? ctx.cleanupAt + pick.range(0, 30) * MIN : Math.min(now - MIN, expiryT + HOUR);
    }
  }
  return fate;
}

// Rows of one offer on a quantity / order-unit market (or ZeusX), priced around the market's level with a small
// per-row jitter, selling by that market's law.
function qtyRows(ctx, rng, game, entry, m, s = {}) {
  const now = ctx.now;
  const law = s.law || LAWS.claim[m];
  const P = s.P != null ? s.P : marketPrice(m, entry.R);
  entry.prices[m] = P;
  const rows = s.rows != null ? s.rows : ROWS[m];
  const fromDays = s.fromDays != null ? s.fromDays : 118;
  const toDays = s.toDays != null ? s.toDays : m === "digiseller" ? 20 : 1;
  const endCap = s.endDays != null ? now - s.endDays * DAY : m === "digiseller" ? ctx.blockedAt : Infinity;
  const made = [];
  for (let i = 0; i < rows; i++) {
    const c = now - fromDays * DAY + ((i + rng.u()) / rows) * (fromDays - toDays) * DAY;
    let price = m === "playerauctions" || s.fixed ? P : snap05(P * rng.range(0.92, 1.08));
    price = Math.max(price, floorFor(m), s.vmin || 0);
    const h = hazard(law, price / P);
    if (m === "zeusx") {
      // Single-unit and silent: a ZeusX auto row never records a sale, it only lives and ends.
      const end = Math.min(c + rng.range(...LIFE.zeusx) * DAY, now);
      const active = end === now;
      made.push(
        addListing(ctx, {
          offer: entry.offer,
          m,
          o: s.o,
          f: game.farm,
          p: price,
          st: active ? "active" : "delisted",
          c,
          u: active ? Math.min(now - MIN, c + rng.range(1, 48) * HOUR) : end,
          qty: active ? 1 : 0,
        }),
      );
      continue;
    }
    const sim = simulateQty(ctx, rng, {
      m,
      c,
      h,
      qty: rng.int(...QTY[m]),
      lifeDays: s.lifeDays || rng.range(...LIFE[m]),
      endCap,
      multi: ORDER_UNIT.has(m) ? 0.2 : 0.1,
    });
    const L = addListing(ctx, {
      offer: entry.offer,
      m,
      o: s.o,
      f: game.farm,
      kind: s.kind,
      p: price,
      vmin: s.vmin,
      st: sim.st,
      c,
      u: sim.u,
      units: sim.units,
      qty: sim.active ? sim.left : 0,
      qr: sim.left,
    });
    for (const o of sim.orders) {
      const grp = ctx.newId();
      for (let k = 0; k < o.k; k++) addSale(ctx, L, o.t, { grp });
    }
    made.push(L);
  }
  return made;
}

// Rival sales on the radar's markets (rivals only, no seller field), and the radar's game row built from them.
function radarFor(ctx, rng, game, r = {}) {
  const now = ctx.now;
  const R = game.offers.length ? game.offers[0].R : 1.5;
  const ns = game.offers.length ? game.offers.map((e) => e.offer.n) : [1, 2, 3];
  const plan = [
    ["gameflip", r.gameflip != null ? r.gameflip : round1(rng.range(0.4, 1.6)), 1],
    ["ggsel", r.ggsel != null ? r.ggsel : round1(rng.range(0, 0.9)), 0.85],
  ];
  const events = { gameflip: [], ggsel: [] };
  for (const [m, perWeek, level] of plan) {
    const k = Math.round((perWeek * 30) / 7);
    for (let i = 0; i < k; i++) {
      const n = rng.chance(0.8) ? rng.pick(ns) : rng.pick([1, 2, 3, 5, 8]);
      const ev = {
        g: game.key,
        m,
        p: Math.max(0.75, snap05(R * level * rng.range(0.85, 1.25) * (n >= 5 ? 1.2 : 1))),
        u: m === "ggsel" && rng.chance(0.2) ? 2 : 1,
        n,
        t: Math.round(now - rng.range(0.05, 30) * DAY),
        tts: m === "gameflip" ? round1(rng.range(2, 140)) : null,
      };
      ctx.feed.push(ev);
      events[m].push(ev);
    }
  }
  const sellers = {
    gameflip: r.gfSellers != null ? r.gfSellers : rng.int(1, 8),
    ggsel: r.ggSellers != null ? r.ggSellers : rng.int(0, 4),
    digiseller: r.plSellers != null ? r.plSellers : rng.int(0, 2),
  };
  const soldOf = (list) => {
    const b = stats.band(list.map((e) => e.p));
    return { n: b.n, p25: b.p25, median: b.median, p75: b.p75 };
  };
  const ttsOf = (list) => {
    const v = list.map((e) => e.tts).filter((x) => x != null);
    return v.length ? stats.median(v) : null;
  };
  const perWeekOf = (list) => round1((list.reduce((a, e) => a + e.u, 0) * 7) / 30);
  const byMarket = {
    gameflip: {
      perWeek: perWeekOf(events.gameflip),
      liveSellers: sellers.gameflip,
      sold: soldOf(events.gameflip),
      medianTtsHours: ttsOf(events.gameflip),
    },
    ggsel: {
      perWeek: perWeekOf(events.ggsel),
      liveSellers: sellers.ggsel,
      sold: soldOf(events.ggsel),
      medianTtsHours: null,
    },
    digiseller: { perWeek: 0, liveSellers: sellers.digiseller, sold: soldOf([]), medianTtsHours: null },
  };
  ctx.radarGames.push({
    key: game.key,
    perWeek: round1(byMarket.gameflip.perWeek + byMarket.ggsel.perWeek),
    rivalSellers: sellers.gameflip + sellers.ggsel + sellers.digiseller,
    medianTtsHours: ttsOf(events.gameflip),
    byMarket,
  });
  game.radarEvents = events;
}

function randomOffers(rng) {
  const k = rng.chance(0.6) ? 1 : 2;
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push({ n: rng.pick([1, 2, 2, 3, 3, 4, 5, 6, 8]), R: quarter(rng.range(1.25, 2.6)), rows: rng.int(11, 15) });
  }
  return out;
}

// Filler games only (every planted game names its markets): a little more history per market than the planted
// defaults, so the large bundle has the volume of plan §6 (>= 3,000 listings, >= 5,000 sales).
function randomMarkets(rng, R) {
  return {
    ggsel: rng.chance(0.75) && { rows: 6 },
    eldorado: rng.chance(0.6) && { rows: 5 },
    g2g: rng.chance(0.35) && { rows: 3 },
    playerauctions: rng.chance(0.15),
    zeusx: rng.chance(0.2),
    digiseller: R <= 2 && rng.chance(0.3),
  };
}

// A claim game the ordinary way: Gameflip rows by the planted law for each offer, then whatever other markets
// `opts.markets` names (GGSel carries every offer; the others the first), then the radar.
function standardClaim(ctx, name, opts = {}) {
  const rng = makeRng(ctx.seed, "claim:" + name);
  const game = addGame(ctx, name, "claim", opts);
  const offers = opts.offers || randomOffers(rng);
  offers.forEach((os, i) => {
    const entry = { offer: makeOffer(game, os.tag || "s" + (i + 1), os.n), R: os.R, prices: {} };
    game.offers.push(entry);
    if (os.rows !== 0)
      lawRows(ctx, rng, game, entry, {
        rows: os.rows || 12,
        liveCap: opts.liveCap,
        smin: opts.smin ? round2(opts.smin * os.R) : null,
      });
  });
  const markets = opts.markets || randomMarkets(rng, game.offers[0].R);
  for (const m of ["ggsel", "eldorado", "g2g", "playerauctions", "zeusx", "digiseller"]) {
    if (!markets[m]) continue;
    const spec = markets[m] === true ? {} : markets[m];
    for (const entry of m === "ggsel" ? game.offers : game.offers.slice(0, 1)) qtyRows(ctx, rng, game, entry, m, spec);
  }
  if (opts.handHigh) {
    for (const t of opts.handHigh) addHandSale(ctx, game, "claim", "gameflip", ctx.now - t * DAY, 9.5);
  }
  if (opts.shop) {
    for (let i = 0; i < opts.shop; i++)
      addDemandOnly(ctx, game.key, "unknown", "claim", ctx.now - rng.range(1, 40) * DAY, "shop");
  }
  if (opts.radar !== false) radarFor(ctx, rng, game, opts.radar || {});
  return { game, rng };
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Claim-farm planted scenarios                                                                                   */
/* -------------------------------------------------------------------------------------------------------------- */

// PLANTED.D: GGSel stocked only on alternate 5-day periods, Gameflip continuously (one row live at a time), both
// selling at the same rate per in-stock day. Sales are placed deterministically on each market's in-stock clock, so
// the 30-day counts are exact: Gameflip 4 sales in 30 in-stock days, GGSel 2 in 15.
function zetaLegends(ctx) {
  const now = ctx.now;
  const rng = makeRng(ctx.seed, "claim:Zeta Legends");
  const game = addGame(ctx, "Zeta Legends", "claim", { demand: { w: 2, on: 6 } });
  const entry = { offer: makeOffer(game, "s1", 2), R: 1.75, prices: { gameflip: 1.75, ggsel: 1.5 } };
  game.offers.push(entry);
  const rate = PLANTED_D_RATE;
  const gap = DAY / rate;
  const saleTimes = [];
  for (let s = now - 1 * DAY; s - gap >= now - 90 * DAY; s -= gap) saleTimes.unshift(s);
  for (const s of saleTimes) {
    const c = s - gap + 5 * MIN;
    pushSingleRow(ctx, game, entry, "gameflip", 1.75, c, { st: "sold", t: s, u: s + 7 * MIN });
  }
  const lastC = saleTimes[saleTimes.length - 1] + 5 * MIN;
  pushSingleRow(ctx, game, entry, "gameflip", 1.75, lastC, { st: "active", u: lastC + 2 * MIN });
  // GGSel: in stock [now - 10j - 5 d, now - 10j d) for j = 0..8; sales every 1/rate in-stock days, half a gap in.
  const gapDays = 1 / rate;
  const byPeriod = new Map();
  for (let tau = gapDays / 2; tau < 45; tau += gapDays) {
    const j = Math.floor(tau / 5);
    const t = now - 10 * j * DAY - (tau - 5 * j) * DAY;
    if (!byPeriod.has(j)) byPeriod.set(j, []);
    byPeriod.get(j).push(t);
  }
  for (let j = 0; j < 9; j++) {
    const start = now - (10 * j + 5) * DAY;
    const stop = now - 10 * j * DAY;
    const sales = (byPeriod.get(j) || []).sort((a, b) => a - b);
    const active = j === 0;
    const units = [0, 1, 2].map((k) => ({ a: start, d: k < sales.length ? sales[k] : null }));
    const L = addListing(ctx, {
      offer: entry.offer,
      m: "ggsel",
      p: 1.5,
      st: active ? "active" : "delisted",
      c: start,
      u: active ? now - 3 * HOUR : stop,
      units,
      qty: active ? 3 - sales.length : 0,
      qr: 3 - sales.length,
    });
    for (const t of sales) addSale(ctx, L, t);
  }
  radarFor(ctx, rng, game, {});
}

// PLANTED.E probe: an exact offer with 2 Gameflip orders (not enough for exact-here), 5 GGSel orders at $1.30 and 6
// Digiseller orders at $4.50 (3x). Its Gameflip ref must come from GGSel through the translator, never Digiseller.
function etaSiege(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Eta Siege", {
    offers: [{ tag: "s1", n: 1, R: 1.5, rows: 7 }],
    markets: { digiseller: true },
    demand: { w: 2.4 },
  });
  const entry = { offer: makeOffer(game, "probe", 3), R: 1.5, prices: { gameflip: 1.5, ggsel: 1.3, digiseller: 4.5 } };
  game.offers.push(entry);
  const d = (x) => now - x * DAY;
  pushSingleRow(ctx, game, entry, "gameflip", 1.45, d(44), { st: "sold", t: d(40), u: d(40) + 9 * MIN });
  pushSingleRow(ctx, game, entry, "gameflip", 1.55, d(23), { st: "sold", t: d(20), u: d(20) + 4 * MIN });
  pushSingleRow(ctx, game, entry, "gameflip", 1.5, d(4), { st: "active", u: d(4) + HOUR });
  const qtyRow = (m, p, c, saleDays, qty, st, u) => {
    const units = [];
    for (let k = 0; k < qty; k++) units.push({ a: c, d: k < saleDays.length ? d(saleDays[k]) : null });
    const L = addListing(ctx, {
      offer: entry.offer,
      m,
      p,
      st,
      c,
      u,
      units,
      qty: st === "active" ? qty - saleDays.length : 0,
      qr: qty - saleDays.length,
    });
    for (const s of saleDays) addSale(ctx, L, d(s));
    return L;
  };
  qtyRow("ggsel", 1.3, d(60), [55, 48, 41], 3, "sold", d(41) + 8 * MIN);
  qtyRow("ggsel", 1.3, d(35), [30, 18], 4, "active", d(18) + HOUR);
  qtyRow("digiseller", 4.5, d(100), [95, 90, 80, 70], 4, "sold", d(70) + 5 * MIN);
  // Still `active` on a blocked market (never cleaned up): it must not be advised or given a shelf.
  qtyRow("digiseller", 4.5, d(60), [50, 30], 4, "active", d(30) + HOUR);
}

// PLANTED.F: a hand-made ladder on Eldorado — one exact offer live at $1, $2 and $4 (origin manual) beside an auto
// row of the same offer. Orders of 2 units share one order key.
function thetaDrift(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Theta Drift", {
    offers: [{ tag: "s2", n: 4, R: 2.25, rows: 8 }],
    markets: { ggsel: true },
    demand: { w: 3, on: 16 },
  });
  const entry = { offer: makeOffer(game, "ladder", 2), R: 1.75, prices: { eldorado: 1.75 } };
  game.offers.push(entry);
  for (const rung of PLANTED_F_RUNGS) {
    const c = now - 18 * DAY + rung.p * 7 * MIN;
    const K = rung.orders.length;
    const times = rung.orders.map((_, k) => c + ((k + 0.5) / K) * 17 * DAY);
    const sold = rung.orders.reduce((a, b) => a + b, 0);
    const units = [];
    rung.orders.forEach((size, i) => {
      for (let j = 0; j < size; j++) units.push({ a: c, d: times[i] });
    });
    while (units.length < rung.qty) units.push({ a: c, d: null });
    const L = addListing(ctx, {
      offer: entry.offer,
      m: "eldorado",
      o: rung.o,
      p: rung.p,
      st: "active",
      c,
      u: now - 5 * HOUR,
      units,
      qty: rung.qty - sold,
      qr: rung.qty - sold,
    });
    rung.orders.forEach((size, i) => {
      const grp = ctx.newId();
      for (let j = 0; j < size; j++) addSale(ctx, L, times[i], { grp });
    });
  }
}

// PLANTED.G: a rent-farm row (kind "farm") with sales at $12 — ignored entirely by the model.
function iotaTactics(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Iota Tactics", {
    offers: [{ n: 3, R: 1.75, rows: 7 }],
    markets: { ggsel: true, eldorado: true },
    demand: { w: 2.2 },
  });
  const id = identify({ title: "Iota Tactics Twitch Drops Auto Farm 7 Days" }, null);
  const offer = { g: id.gameKey, gl: game.name, ck: id.contentKey, bk: id.bandKey, ex: id.exact, n: id.countForBand };
  const L = addListing(ctx, {
    offer,
    m: "gameflip",
    o: "manual",
    kind: "farm",
    p: 12,
    st: "active",
    c: now - 50 * DAY,
    u: now - DAY,
    qty: 1,
  });
  for (const x of [45, 30, 18, 6]) addSale(ctx, L, now - x * DAY);
}

// PLANTED.H: a mass close — 12 hand-made GGSel rows at a fake $8 closed inside 4 minutes; the ledger kept the
// closes as `burst` demand-only records (no price), and none of them is a sale.
function kappaRaiders(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Kappa Raiders", {
    offers: [{ n: 2, R: 1.5, rows: 7 }],
    markets: { ggsel: true, digiseller: true },
    demand: { w: 2.8 },
  });
  const offer = makeOffer(game, "pack5", 5);
  const t0 = now - PLANTED.H.atDaysAgo * DAY;
  for (let i = 0; i < PLANTED.H.n; i++) {
    const t = t0 + i * 20000;
    addListing(ctx, {
      offer,
      m: "ggsel",
      o: "manual",
      p: PLANTED.H.fakePrice,
      st: "delisted",
      c: now - 20 * DAY + i * 2 * HOUR,
      u: t,
      units: [{ a: now - 20 * DAY + i * 2 * HOUR, d: null }],
      qty: 0,
      qr: 0,
    });
    addDemandOnly(ctx, game.key, "ggsel", "claim", t + 1500, "burst");
  }
}

// PLANTED.K: fee near-tie — the same offer at $2.00 on Gameflip (fee 8 %, assumed) and $2.03 on Eldorado (fee 10 %,
// verified): gross Eldorado is higher, net Gameflip is higher; with equal fees the order flips.
function nuFrontier(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Nu Frontier", {
    offers: [{ n: 2, R: 2.0, rows: 8 }],
    markets: {},
    demand: { w: 2.5, on: 8 },
  });
  const entry = game.offers[0];
  entry.prices.eldorado = 2.03;
  for (const [cDays, sales] of [
    [60, [52, 45]],
    [38, [30, 22]],
    [16, [9, 3]],
  ]) {
    const c = now - cDays * DAY;
    const active = cDays === 16;
    const units = [0, 1, 2].map((k) => ({ a: c, d: k < sales.length ? now - sales[k] * DAY : null }));
    const L = addListing(ctx, {
      offer: entry.offer,
      m: "eldorado",
      p: 2.03,
      st: active ? "active" : "delisted",
      c,
      u: active ? now - 2 * DAY : now - (sales[sales.length - 1] - 4) * DAY,
      units,
      qty: active ? 1 : 0,
      qr: 1,
    });
    for (const s of sales) addSale(ctx, L, now - s * DAY);
  }
}

// PLANTED.J (claim side): a G2G operator-script row — origin auto, claim-at-sale, script — with a large advertised
// quantity; its units are delivery records (addedAt == deliveredAt).
function sigmaStrike(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Sigma Strike", {
    offers: [{ n: 3, R: 1.75, rows: 7 }],
    markets: { ggsel: true },
    demand: { w: 3.4 },
  });
  const entry = game.offers[0];
  const orders = [
    [22, 2],
    [15, 1],
    [9, 1],
    [3, 2],
  ];
  const units = [];
  for (const [x, k] of orders) for (let i = 0; i < k; i++) units.push({ a: now - x * DAY, d: now - x * DAY });
  const L = addListing(ctx, {
    offer: entry.offer,
    m: "g2g",
    o: "auto",
    kind: "cas",
    script: true,
    p: 1.5,
    st: "active",
    c: now - 25 * DAY,
    u: now - 3 * HOUR,
    units,
    qty: PLANTED.J.script.qty,
    qr: PLANTED.J.script.qty - units.length,
  });
  for (const [x, k] of orders) {
    const grp = ctx.newId();
    for (let i = 0; i < k; i++) addSale(ctx, L, now - x * DAY, { grp });
  }
}

// An account listing (accountOffer) on Eldorado with one sale: never advised, its sale as the ledger treats it.
function tauHarbor(ctx) {
  const now = ctx.now;
  const { game } = standardClaim(ctx, "Tau Harbor", {
    offers: [{ n: 2, R: 1.5, rows: 7 }],
    markets: { eldorado: true },
    radar: false, // unwatched by the radar
  });
  const offer = makeOffer(game, "account", 6);
  const L = addListing(ctx, {
    offer,
    m: "eldorado",
    o: "manual",
    kind: "account",
    p: 3.5,
    st: "sold",
    c: now - 30 * DAY,
    u: now - 21 * DAY,
    units: [{ a: now - 30 * DAY, d: now - 21 * DAY }],
  });
  addSale(ctx, L, now - 21 * DAY);
}

/* -------------------------------------------------------------------------------------------------------------- */
/* No-claim farm                                                                                                  */
/* -------------------------------------------------------------------------------------------------------------- */

function makeUnit(game, entry, l, xTime) {
  return {
    rec: {
      g: game.key,
      m: "",
      st: "listed",
      l: Math.round(l),
      s: null,
      p: 0,
      sm: "",
      x: null,
      lids: [],
      bk: entry.bundleKey,
      camps: [entry.camp],
    },
    l,
    xTime,
  };
}

// Gameflip no-claim: a relist chain — one unit live at a time, the next one gets a fresh row when it sells.
function chainNoclaim(ctx, rng, game, entry, ws, h) {
  const now = ctx.now;
  ws.sort((a, b) => a.l - b.l);
  let free = -Infinity;
  for (const w of ws) {
    w.rec.m = "gameflip";
    const c = Math.max(w.l, free);
    const stop = Math.min(w.xTime, now);
    if (c >= stop) {
      // Never reached the shelf: still waiting (lids []) or expired while waiting.
      if (w.xTime <= now) {
        w.rec.st = "expired";
        w.rec.x = Math.round(w.xTime);
      }
      continue;
    }
    const sale = c + rng.exp(h) * DAY;
    if (sale < stop) {
      const L = addListing(ctx, {
        offer: entry.offer,
        m: "gameflip",
        o: "unclaimed",
        f: "noclaim",
        p: entry.R,
        st: "sold",
        c,
        u: sale + rng.range(1, 15) * MIN,
      });
      Object.assign(w.rec, { st: "sold", s: Math.round(sale), p: entry.R, sm: "gameflip", lids: [L.id] });
      addSale(ctx, L, sale);
      free = sale + rng.range(2, 15) * MIN;
    } else if (w.xTime <= now) {
      const L = addListing(ctx, {
        offer: entry.offer,
        m: "gameflip",
        o: "unclaimed",
        f: "noclaim",
        p: entry.R,
        st: "delisted",
        c,
        u: w.xTime,
      });
      Object.assign(w.rec, { st: "expired", x: Math.round(w.xTime), lids: [L.id] });
      free = w.xTime;
    } else {
      const L = addListing(ctx, {
        offer: entry.offer,
        m: "gameflip",
        o: "unclaimed",
        f: "noclaim",
        p: entry.R,
        st: "active",
        c,
        u: Math.min(now - MIN, c + HOUR),
        qty: 1,
      });
      w.rec.lids = [L.id];
      free = Infinity;
    }
  }
}

// GGSel / Digiseller no-claim: one quantity row per offer that every unit of the wave joins; units sell oldest
// first at daily hazard h while one is in stock, and expire at their own claim-window end.
function poolNoclaim(ctx, rng, game, entry, m, ws, h, endCap = Infinity) {
  if (!ws.length) return;
  const now = ctx.now;
  ws.sort((a, b) => a.l - b.l);
  const c = ws[0].l;
  const end = Math.min(now, endCap, Math.max(...ws.map((w) => w.xTime)));
  for (let t = c; ;) {
    t += rng.exp(h) * DAY;
    if (t >= end) break;
    const w = ws.find((x) => x.l <= t && x.xTime > t && x.soldAt == null);
    if (w) w.soldAt = t;
  }
  let listed = 0;
  let lastEvent = c;
  for (const w of ws) {
    w.rec.m = m;
    if (w.soldAt != null) {
      Object.assign(w.rec, { st: "sold", s: Math.round(w.soldAt), p: entry.R, sm: m });
      lastEvent = Math.max(lastEvent, w.soldAt);
    } else if (w.xTime <= Math.min(now, endCap)) {
      Object.assign(w.rec, { st: "expired", x: Math.round(w.xTime) });
      lastEvent = Math.max(lastEvent, w.xTime);
    } else listed++;
  }
  const allSold = ws.every((w) => w.soldAt != null);
  const st = listed ? "active" : allSold ? "sold" : "delisted";
  const L = addListing(ctx, {
    offer: entry.offer,
    m,
    o: "unclaimed",
    f: "noclaim",
    p: entry.R,
    st,
    c,
    u: st === "active" ? Math.min(now - MIN, lastEvent + HOUR) : lastEvent + (allSold ? 5 * MIN : 0),
    units: ws.map((w) => ({ a: w.l, d: w.soldAt == null ? null : w.soldAt })),
    qty: listed,
    qr: listed,
  });
  for (const w of ws) {
    w.rec.lids = [L.id];
    if (w.soldAt != null) addSale(ctx, L, w.soldAt);
  }
}

function waveEntry(game, ev, wave, n, W, anchor) {
  const offer = makeOffer(game, `${ev} ${wave}`, n);
  return {
    offer,
    R: bundlePriceLike(anchor, n, PRICING),
    prices: {},
    wave: W,
    camp: `${ev} ${wave}`,
    bundleKey: `${game.key}|${ev.toLowerCase()}|${wave.toLowerCase()}`,
  };
}

// A no-claim game: events of weekly waves; each wave is one offer (its drops) whose units are listed through the
// wave and sold or expired by the wave's end plus the claim window.
function noclaimGame(ctx, name, opts) {
  const now = ctx.now;
  const rng = makeRng(ctx.seed, "noclaim:" + name);
  const game = addGame(ctx, name, "noclaim", opts);
  const anchor = opts.anchor || quarter(rng.range(0.9, 1.4));
  game.anchor = anchor;
  for (const ev of opts.events) {
    for (const wv of ev.waves) {
      const [label, startDaysAgo, endDaysAgo, nUnits, rate = 1] = wv;
      const W = {
        g: game.key,
        ev: ev.name,
        wave: label,
        startAt: Math.round(now - startDaysAgo * DAY),
        endAt: Math.round(now - endDaysAgo * DAY),
      };
      ctx.waves.push(W);
      const entry = waveEntry(game, ev.name, label, rng.int(2, 4), W, anchor);
      game.offers.push(entry);
      const byM = { gameflip: [], ggsel: [], digiseller: [] };
      for (let i = 0; i < nUnits; i++) {
        const l = W.startAt + (W.endAt - W.startAt) * 0.95 * ((i + rng.u()) / nUnits) + 2 * HOUR;
        if (l >= now - 10 * MIN) continue; // not farmed yet
        const xTime = W.endAt + rng.range(...CLAIM_WINDOW_H) * HOUR;
        const w = makeUnit(game, entry, l, xTime);
        const roll = rng.u();
        if (roll < 0.05) {
          // A hand sale: sold off-platform, unpriced, no listing.
          const s = Math.min(now - MIN, xTime - HOUR, l + rng.range(0.1, 1.5) * DAY);
          Object.assign(w.rec, { st: "sold", s: Math.round(s), sm: "manual" });
          addHandSale(ctx, game, "noclaim", "unknown", s, 0);
        } else if (roll < 0.08) {
          w.rec.st = "released"; // returned to the pool before it was listed anywhere
        } else if (xTime < ctx.blockedAt && rng.chance(0.15)) byM.digiseller.push(w);
        else if (rng.chance(opts.gfShare != null ? opts.gfShare : 0.5)) byM.gameflip.push(w);
        else byM.ggsel.push(w);
        ctx.units.push(w.rec);
      }
      chainNoclaim(ctx, rng, game, entry, byM.gameflip, LAWS.noclaim.gameflip.h0 * rate);
      poolNoclaim(ctx, rng, game, entry, "ggsel", byM.ggsel, LAWS.noclaim.ggsel.h0 * rate);
      poolNoclaim(
        ctx,
        rng,
        game,
        entry,
        "digiseller",
        byM.digiseller,
        LAWS.noclaim.digiseller.h0 * rate,
        ctx.blockedAt,
      );
      for (const m of ["gameflip", "ggsel", "digiseller"]) if (byM[m].length) entry.prices[m] = entry.R;
    }
  }
  if (opts.radar !== false) radarFor(ctx, rng, game, opts.radar || {});
  return { game, rng };
}

const waveOf = (game, t) => {
  const own = game.offers.filter((e) => e.wave && e.wave.startAt <= t).sort((a, b) => b.wave.startAt - a.wave.startAt);
  return own[0] || game.offers.find((e) => e.wave);
};

// PLANTED.J (no-claim side): an Eldorado noclaimStock row — hand-made, claim-at-sale — advertising a share of the
// free pool; its sold units are in the ledger as unit sales AND in noclaim.units (the same units, not extra sales).
function noclaimStockRow(ctx, game) {
  const now = ctx.now;
  const entry = game.offers[game.offers.length - 1];
  const times = [9, 7, 4.5, 2, 0.5].map((x) => now - x * DAY);
  const L = addListing(ctx, {
    offer: entry.offer,
    m: "eldorado",
    o: "manual",
    f: "noclaim",
    kind: "cas",
    p: 2,
    st: "active",
    c: now - 12 * DAY,
    u: now - 6 * HOUR,
    units: times.map((t) => ({ a: t, d: t })),
    qty: PLANTED.J.cas.qty,
    qr: PLANTED.J.cas.qty,
  });
  for (const t of times) {
    addSale(ctx, L, t);
    const e = waveOf(game, t);
    ctx.units.push({
      g: game.key,
      m: "eldorado",
      st: "sold",
      l: Math.round(t),
      s: Math.round(t),
      p: 2,
      sm: "eldorado",
      x: null,
      lids: [L.id],
      bk: e.bundleKey,
      camps: [e.camp],
    });
  }
}

// PLANTED.O: a game sold mostly in bulk — packs of 5 and 10 on Eldorado / G2G. Pack sales are demand only (one
// `bulk` record per account) and a per-account price series (bulkPrices); single sales are few.
function bulkPacks(ctx, rng, game) {
  const now = ctx.now;
  const offers = { 5: makeOffer(game, "bulk pack 5", 3), 10: makeOffer(game, "bulk pack 10", 3) };
  const nPacks = PLANTED.O.packs30;
  for (let k = 0; k < nPacks; k++) {
    const size = k % 3 === 0 ? 10 : 5;
    const m = k % 2 ? "g2g" : "eldorado";
    const pa = size === 10 ? 0.55 : 0.62;
    const t = now - ((k + rng.u()) / nPacks) * 29 * DAY;
    const c = t - rng.range(0.3, 3) * DAY;
    const units = [];
    for (let i = 0; i < size; i++) units.push({ a: c, d: t });
    const L = addListing(ctx, {
      offer: offers[size],
      m,
      o: "auto",
      f: "noclaim",
      kind: "bulk",
      p: round2(size * pa),
      st: "sold",
      c,
      u: t + 3 * MIN,
      units,
      qty: 0,
      qr: 0,
      pack: size,
    });
    const e = waveOf(game, c);
    for (let i = 0; i < size; i++) {
      ctx.units.push({
        g: game.key,
        m,
        st: "sold",
        l: Math.round(c),
        s: Math.round(t),
        p: pa,
        sm: m,
        x: null,
        lids: [L.id],
        bk: e.bundleKey,
        camps: [e.camp],
      });
      addDemandOnly(ctx, game.key, m, "noclaim", t, "bulk");
    }
    ctx.bulkPrices.push({ g: game.key, m, t: Math.round(t), pa, size });
  }
  // One pack live now, and a few off-platform bulk orders.
  const c = now - 2 * DAY;
  const units = [];
  for (let i = 0; i < 10; i++) units.push({ a: c, d: null });
  const L = addListing(ctx, {
    offer: offers[10],
    m: "eldorado",
    o: "auto",
    f: "noclaim",
    kind: "bulk",
    p: 5.5,
    st: "active",
    c,
    u: c + HOUR,
    units,
    qty: 10,
    qr: 10,
    pack: 10,
  });
  const e = waveOf(game, c);
  for (let i = 0; i < 10; i++) {
    ctx.units.push({
      g: game.key,
      m: "eldorado",
      st: "listed",
      l: Math.round(c),
      s: null,
      p: 0,
      sm: "",
      x: null,
      lids: [L.id],
      bk: e.bundleKey,
      camps: [e.camp],
    });
  }
  for (let i = 0; i < 6; i++)
    addDemandOnly(ctx, game.key, "eldorado", "noclaim", now - rng.range(1, 28) * DAY, "bulk-order");
}

// PLANTED.P: a GGSel no-claim row rebundled 12 days ago (the wave 2 -> 3 boundary): 7 sales at $3.00 before the
// rebundle (contents nobody recorded), 4 at $1.25 after. The before-sales carry the row's CURRENT content key, as
// the tracker would attribute them — the model must drop them from offer evidence.
function rebundledRow(ctx, game) {
  const now = ctx.now;
  const P = PLANTED.P;
  const entry = { offer: makeOffer(game, "rebundled", 4), R: P.after.p, prices: { ggsel: P.after.p } };
  game.offers.push(entry);
  const c = now - 26 * DAY;
  const rb = now - P.rbDaysAgo * DAY;
  const ws = [];
  const before = P.before.n;
  const after = P.after.n;
  const listedLeft = 5;
  for (let i = 0; i < before; i++) {
    const s = c + ((i + 0.6) / before) * (rb - c - DAY);
    ws.push({ l: s - 0.4 * DAY, s, p: P.before.p });
  }
  for (let i = 0; i < after; i++) {
    const s = rb + ((i + 0.6) / after) * (now - rb - DAY);
    ws.push({ l: s - 0.5 * DAY, s, p: P.after.p });
  }
  for (let i = 0; i < listedLeft; i++) ws.push({ l: now - (3 - i * 0.5) * DAY, s: null, p: 0 });
  const L = addListing(ctx, {
    offer: entry.offer,
    m: "ggsel",
    o: "unclaimed",
    f: "noclaim",
    p: P.after.p,
    st: "active",
    c,
    u: now - 2 * HOUR,
    units: ws.map((w) => ({ a: w.l, d: w.s })),
    qty: listedLeft,
    qr: listedLeft,
    rb,
  });
  for (const w of ws) {
    const e = waveOf(game, w.s != null ? w.s : now);
    ctx.units.push({
      g: game.key,
      m: "ggsel",
      st: w.s != null ? "sold" : "listed",
      l: Math.round(w.l),
      s: w.s != null ? Math.round(w.s) : null,
      p: w.s != null ? w.p : 0,
      sm: w.s != null ? "ggsel" : "",
      x: null,
      lids: [L.id],
      bk: e.bundleKey,
      camps: [e.camp],
    });
    if (w.s != null) addSale(ctx, L, w.s, { p: w.p });
  }
}

// PLANTED.Q: a no-claim ladder on Gameflip — the auto-lister's chain of one exact offer at $1.50 beside hand-made
// rows of the very same offer at $2.25 and $3.00, all live now.
function noclaimLadder(ctx, game) {
  const now = ctx.now;
  const Q = PLANTED.Q;
  const entry = { offer: makeOffer(game, "ladder", 3), R: Q.autoPrice, prices: { gameflip: Q.autoPrice } };
  game.offers.push(entry);
  const pushUnit = (L, l, s) => {
    const e = waveOf(game, l);
    ctx.units.push({
      g: game.key,
      m: "gameflip",
      st: s != null ? "sold" : "listed",
      l: Math.round(l),
      s: s != null ? Math.round(s) : null,
      p: s != null ? Q.autoPrice : 0,
      sm: s != null ? "gameflip" : "",
      x: null,
      lids: L ? [L.id] : [],
      bk: e.bundleKey,
      camps: [e.camp],
    });
  };
  for (let i = 0; i < Q.autoSold; i++) {
    const l = now - (19 - i * 3.5) * DAY;
    const s = l + (0.2 + 0.1 * i) * DAY;
    const L = addListing(ctx, {
      offer: entry.offer,
      m: "gameflip",
      o: "unclaimed",
      f: "noclaim",
      p: Q.autoPrice,
      st: "sold",
      c: l,
      u: s + 4 * MIN,
    });
    addSale(ctx, L, s);
    pushUnit(L, l, s);
  }
  const liveC = now - 1 * DAY;
  const live = addListing(ctx, {
    offer: entry.offer,
    m: "gameflip",
    o: "unclaimed",
    f: "noclaim",
    p: Q.autoPrice,
    st: "active",
    c: liveC,
    u: liveC + HOUR,
    qty: 1,
  });
  pushUnit(live, liveC, null);
  pushUnit(null, now - 0.5 * DAY, null); // the next unit of the chain, waiting (no row yet)
  for (const p of Q.manualPrices) {
    addListing(ctx, {
      offer: entry.offer,
      m: "gameflip",
      o: "manual",
      f: "noclaim",
      p,
      st: "active",
      c: now - 10 * DAY + p * MIN,
      u: now - 10 * DAY + p * MIN + HOUR,
      qty: 1,
    });
  }
  const sold = addListing(ctx, {
    offer: entry.offer,
    m: "gameflip",
    o: "manual",
    f: "noclaim",
    p: Q.manualPrices[0],
    st: "sold",
    c: now - 15 * DAY,
    u: now - 12 * DAY + 5 * MIN,
  });
  addSale(ctx, sold, now - 12 * DAY);
}

/* -------------------------------------------------------------------------------------------------------------- */
/* The planted set (small = these; large = these + fillers)                                                       */
/* -------------------------------------------------------------------------------------------------------------- */

function buildPlanted(ctx) {
  // A — every claim game's Gameflip offer follows the law; these three carry most of the rows.
  const aOffers = (game) =>
    PLANTED.A.offers.filter((o) => o.game === normGame(game)).map(({ n, R, rows }) => ({ n, R, rows }));
  standardClaim(ctx, "Alpha Quest", {
    offers: aOffers("Alpha Quest"),
    markets: { ggsel: true, eldorado: true, digiseller: { rows: 1 } },
    demand: { w: 3.2 },
    handHigh: [33, 12], // hand sales at $9.50: demand, never price evidence
  });
  standardClaim(ctx, "Beta Arena", {
    offers: aOffers("Beta Arena"),
    markets: { ggsel: true, g2g: true },
    demand: { w: 2.6 },
    g2gBrand: true,
  });
  standardClaim(ctx, "Gamma Rush", {
    offers: aOffers("Gamma Rush"),
    markets: { eldorado: true, zeusx: true },
    demand: { w: 2.2 },
  });
  // B — overstocked: one a week, forty on hand.
  standardClaim(ctx, "Delta Forge", {
    offers: [{ n: 2, R: 1.75, rows: 8 }],
    markets: { ggsel: true },
    smin: 0.8,
    demand: { w: PLANTED.B.w, on: PLANTED.B.on, fl: 0, c: "farm" },
  });
  // C — scarce: twelve a week, two on hand (one live row).
  standardClaim(ctx, "Epsilon Rift", {
    offers: [{ n: 3, R: 2.0, rows: 10 }],
    markets: { ggsel: { rows: 4, endDays: 0.5 } },
    liveCap: 1,
    demand: { w: PLANTED.C.w, on: PLANTED.C.on, fl: 6 },
    radar: { gameflip: 9, ggsel: 4 },
    shop: 6,
  });
  zetaLegends(ctx); // D
  etaSiege(ctx); // E
  thetaDrift(ctx); // F
  iotaTactics(ctx); // G
  kappaRaiders(ctx); // H
  // I — listings and sales, no farm-brain row.
  standardClaim(ctx, "Lambda Racers", { offers: [{ n: 2, R: 1.75, rows: 7 }], markets: { ggsel: true }, demand: null });
  // I' — a farm-brain row 9 h old (older than maxDemandAgeH 6 h).
  standardClaim(ctx, "Mu Kingdoms", {
    offers: [{ n: 4, R: 2.25, rows: 7 }],
    markets: { eldorado: true },
    demand: { staleH: PLANTED.I.staleHours },
  });
  nuFrontier(ctx); // K
  // L — ZeusX auto rows, never a sale.
  standardClaim(ctx, "Xi Outpost", {
    offers: [{ n: 2, R: 1.5, rows: 7 }],
    markets: { ggsel: true, zeusx: { rows: 3, fromDays: 40 } },
    demand: { w: 2 },
  });
  // M — sells for ~$1.50 elsewhere; its PlayerAuctions row sits at the $5 floor and never sells.
  standardClaim(ctx, "Omicron Wars", {
    offers: [{ n: 2, R: 1.5, rows: 8 }],
    markets: {
      ggsel: { P: 1.3 },
      playerauctions: { rows: 1, fromDays: 26, toDays: 24, lifeDays: 60, law: { h0: 0, beta: 0 } },
    },
    demand: { w: 2.4 },
  });
  sigmaStrike(ctx); // J (claim side)
  // Fading (avg30 < 0.5 x avg45) -> overstock although its cover is ordinary.
  standardClaim(ctx, "Pi Dungeon", {
    offers: [{ n: 1, R: 1.25, rows: 7 }],
    markets: { ggsel: true },
    demand: PLANTED.B2.demand,
  });
  // Campaign ended, the radar shows one live rival seller -> scarce although its cover is ordinary.
  standardClaim(ctx, "Rho Galaxy", {
    offers: [{ n: 3, R: 2.0, rows: 7 }],
    markets: { ggsel: true },
    demand: { live: false, w: PLANTED.C2.w, on: PLANTED.C2.on, endedDaysAgo: PLANTED.C2.endedDaysAgo },
    radar: { gfSellers: 1, ggSellers: 0, plSellers: 0 },
  });
  tauHarbor(ctx);
  // G2G switch on, no brand mapping, no G2G history -> eligibility unknown.
  standardClaim(ctx, "Upsilon Tides", {
    offers: [{ n: 2, R: 1.75, rows: 7 }],
    markets: { ggsel: true },
    g2gBrand: false,
    demand: { w: 1.8 },
  });
  // GGSel hidden category minimum (venueMinPriceUsd) binding on every row.
  standardClaim(ctx, "Phi Colony", {
    offers: [{ n: 3, R: 1.5, rows: 7 }],
    markets: { ggsel: { P: 1.1, vmin: 1.1, fixed: true } },
    demand: { w: 1.6 },
  });
  standardClaim(ctx, "Chi Arcana", {
    offers: [{ n: 6, R: 1.75, rows: 7 }],
    markets: { eldorado: true, digiseller: true },
    demand: { c: "probe" },
  });

  // ---- no-claim farm ------------------------------------------------------------------------------------------
  // N (perish) + J (noclaimStock): the live wave ends in 12 h with most of its units unsold.
  const online = noclaimGame(ctx, "Omega Online", {
    anchor: 1.25,
    events: [
      {
        name: "Spring Clash",
        waves: [
          ["Week 1", 75, 68, 3],
          ["Week 2", 68, 61, 3],
        ],
      },
      {
        name: "Frost Cup",
        waves: [
          ["Week 1", 34.5, 27.5, 5],
          ["Week 2", 27.5, 20.5, 5],
          ["Week 3", 20.5, 13.5, 5],
          ["Week 4", 13.5, 6.5, 5],
          ["Week 5", 6.5, -PLANTED.N.perish.endsInHours / 24, PLANTED.N.perish.units, 0.3],
        ],
      },
    ],
    demand: { w: PLANTED.N.perish.w, freeUnits: 4 },
  });
  noclaimStockRow(ctx, online.game);
  // N (ended): the last wave ended 3 days ago; most of its units expired unsold.
  noclaimGame(ctx, "Omega Saga", {
    anchor: 1.0,
    events: [
      {
        name: "Ember League",
        waves: [
          ["Week 1", 31, 24, 5],
          ["Week 2", 24, 17, 5],
          ["Week 3", 17, 10, 5],
          ["Week 4", 10, 3, PLANTED.N.ended.units, 0.15],
        ],
      },
    ],
    demand: { w: 4.5 },
  });
  // O + R: sold mostly in bulk; explicit no-claim cap 40.
  const tactics = noclaimGame(ctx, "Omega Tactics", {
    anchor: 1.0,
    events: [
      {
        name: "Tide Series",
        waves: [
          ["Week 1", 24, 17, 4, 0.4],
          ["Week 2", 17, 10, 4, 0.4],
          ["Week 3", 10, 3, 4, 0.4],
          ["Week 4", 3, -4, 4, 0.4],
        ],
      },
    ],
    demand: {},
  });
  bulkPacks(ctx, tactics.rng, tactics.game);
  ctx.caps[tactics.game.key] = PLANTED.R.explicit[tactics.game.key];
  // P + Q.
  const racers = noclaimGame(ctx, "Omega Racers", {
    anchor: 1.25,
    events: [
      {
        name: "Sun Rally",
        waves: [
          ["Week 1", 26, 19, 5],
          ["Week 2", 19, 12, 5],
          ["Week 3", 12, 5, 5],
          ["Week 4", 5, -2, 5],
        ],
      },
    ],
    demand: {},
  });
  rebundledRow(ctx, racers.game);
  noclaimLadder(ctx, racers.game);
}

// Large mode: filler games up to 150, most claim, one in eight no-claim ("Omega <noun>", the no-claim bucket).
function buildFillers(ctx, total) {
  const used = new Set(ctx.games.map((g) => g.key));
  const claimNames = [];
  for (const noun of NOUNS) {
    for (const greek of GREEK) {
      const name = `${greek} ${noun}`;
      if (!used.has(normGame(name))) claimNames.push(name);
    }
  }
  const noclaimNames = NOUNS.map((n) => "Omega " + n).filter((n) => !used.has(normGame(n)));
  let ci = 0;
  let ni = 0;
  for (let i = 0; ctx.games.length < total; i++) {
    if (i % 8 === 7 && ni < noclaimNames.length) {
      const name = noclaimNames[ni++];
      const rng = makeRng(ctx.seed, "filler-plan:" + name);
      const evA = rng.pick(EVENTS);
      const evB = rng.pick(EVENTS.filter((e) => e !== evA));
      const lastEnd = round1(rng.range(-5, 4)); // days ago (negative: still running)
      const units = () => rng.int(8, 18);
      const recent = [];
      for (let k = 3; k >= 0; k--) recent.push([`Week ${4 - k}`, lastEnd + 7 * (k + 1), lastEnd + 7 * k, units()]);
      const { game } = noclaimGame(ctx, name, {
        anchor: quarter(rng.range(0.9, 1.5)),
        events: [
          {
            name: evB,
            waves: [
              ["Week 1", 80, 73, units()],
              ["Week 2", 73, 66, units()],
              ["Week 3", 66, 59, units()],
            ],
          },
          { name: evA, waves: recent },
        ],
        demand: {},
      });
      if (ni % 5 === 0) ctx.caps[game.key] = rng.pick([30, 40, 50, 60]);
      continue;
    }
    const name = claimNames[ci++];
    const rng = makeRng(ctx.seed, "filler-plan:" + name);
    const roll = rng.u();
    const opts = {};
    if (roll < 0.04)
      opts.demand = null; // no farm-brain row
    else if (roll < 0.06) opts.demand = { staleH: rng.range(7, 30) };
    else if (roll < 0.1) opts.demand = { c: "skip" };
    if (rng.chance(0.12)) opts.radar = false;
    if (rng.chance(0.15)) opts.g2gBrand = false;
    if (rng.chance(0.2)) opts.shop = rng.int(1, 4);
    standardClaim(ctx, name, opts);
  }
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Final pass: farm-brain rows, old side, mappings, claim campaigns                                               */
/* -------------------------------------------------------------------------------------------------------------- */

function oldBase(game) {
  // derivePrice's shape over the synthetic radar feed: Gameflip >= 3 rival sales -> min(average, lowest x 0.95);
  // else GGSel lowest x 0.95; else $1.00. Quarter grid, clamped [0.75, 10].
  const ev = game.radarEvents;
  let p = 1;
  if (ev && ev.gameflip.length >= 3) {
    const prices = ev.gameflip.map((e) => e.p);
    const avg = Math.min(10, prices.reduce((a, b) => a + b, 0) / prices.length);
    p = Math.min(avg, Math.min(...prices) * 0.95);
  } else if (ev && ev.ggsel.length) p = Math.min(...ev.ggsel.map((e) => e.p)) * 0.95;
  return Math.max(0.75, Math.min(10, quarter(p)));
}

function finish(ctx) {
  const now = ctx.now;
  const salesByG = new Map();
  const bump = (g, t) => {
    if (!salesByG.has(g)) salesByG.set(g, []);
    salesByG.get(g).push(t);
  };
  for (const s of ctx.sales) bump(s.g, s.t);
  for (const d of ctx.demandOnly) bump(d.g, d.t);
  const rowsByG = new Map();
  for (const L of ctx.listings) {
    if (!rowsByG.has(L.g)) rowsByG.set(L.g, []);
    rowsByG.get(L.g).push(L);
  }
  const unitsByG = new Map();
  for (const U of ctx.units) {
    if (!unitsByG.has(U.g)) unitsByG.set(U.g, []);
    unitsByG.get(U.g).push(U);
  }

  for (const game of ctx.games) {
    const rng = makeRng(ctx.seed, "final:" + game.name);
    const o = game.opts.demand === undefined ? {} : game.opts.demand;
    const times = salesByG.get(game.key) || [];
    const n45 = times.filter((t) => t >= now - 45 * DAY && t < now).length;
    const n30 = times.filter((t) => t >= now - 30 * DAY && t < now).length;
    const a45 = o && o.a45 != null ? o.a45 : round1((n45 * 7) / 45);
    const a30 = o && o.a30 != null ? o.a30 : round1((n30 * 7) / 30);
    const rows = rowsByG.get(game.key) || [];
    let live;
    let hl = null;
    if (game.farm === "claim") {
      live = o && o.live != null ? o.live : rng.chance(0.45);
      if (live) hl = round1(rng.range(6, 240));
      const ev = game.name + " Launch";
      if (live)
        ctx.waves.push({
          g: game.key,
          ev,
          wave: "",
          startAt: Math.round(now - rng.range(5, 20) * DAY),
          endAt: Math.round(now + hl * HOUR),
        });
      else {
        const ended = o && o.endedDaysAgo != null ? o.endedDaysAgo : rng.range(3, 60);
        ctx.waves.push({
          g: game.key,
          ev,
          wave: "",
          startAt: Math.round(now - (ended + 14) * DAY),
          endAt: Math.round(now - ended * DAY),
        });
      }
    } else live = ctx.waves.some((W) => W.g === game.key && W.startAt <= now && W.endAt > now);

    // Stock on hand: claim = live units of its system-made rows + archive holders; no-claim = units listed + free.
    const listed =
      game.farm === "claim"
        ? rows.filter((L) => L.st === "active" && L.o === "auto" && L.kind === "single").reduce((a, L) => a + L.qty, 0)
        : (unitsByG.get(game.key) || []).filter((U) => U.st === "listed").length;
    const w = o && o.w != null ? o.w : round1(Math.max(0.3, ((a30 + a45) / 2) * rng.range(1.0, 1.3)));
    let on;
    if (o && o.on != null) on = o.on;
    else if (o && o.freeUnits != null) on = listed + o.freeUnits;
    else on = listed + Math.max(0, Math.round(w * rng.range(2.5, 6)) - listed);
    const fl = o && o.fl != null ? o.fl : rng.int(0, 4);

    if (o !== null) {
      ctx.demand.push({
        k: game.key,
        f: game.farm,
        at: Math.round(o.staleH != null ? now - o.staleH * HOUR : now - rng.range(4, 55) * MIN),
        live,
        hl,
        c: game.farm === "noclaim" ? "fleet" : o.c || (rng.chance(0.85) ? "farm" : "probe"),
        w,
        t: Math.min(250, Math.ceil(w * (game.farm === "noclaim" ? 2 : 4) + 6)),
        on,
        fl,
        a30,
        a45,
      });
    }

    // Mapping the loader can prove offline: Gameflip, Digiseller, Eldorado need none; GGSel by category id;
    // G2G by the brand table; ZeusX / PlayerAuctions only by having had an auto row of the game.
    const hadAuto = (m) => rows.some((L) => L.m === m && L.o === "auto");
    const g2g = game.g2gBrand != null ? game.g2gBrand : hadAuto("g2g") || rng.chance(0.5);
    ctx.mapped[game.key] =
      game.farm === "claim"
        ? {
            gameflip: true,
            digiseller: true,
            ggsel: true,
            zeusx: hadAuto("zeusx"),
            eldorado: true,
            playerauctions: hadAuto("playerauctions"),
            g2g: g2g || hadAuto("g2g"),
          }
        : {
            gameflip: true,
            digiseller: true,
            ggsel: true,
            zeusx: false,
            eldorado: true,
            playerauctions: false,
            g2g: false,
          };

    // Old side.
    const base = game.farm === "claim" ? oldBase(game) : null;
    const ggselOld = base == null ? null : Math.max(0.75, round2(base * 0.86));
    if (game.farm === "claim" && (on > 0 || rows.some((L) => L.st === "active" && L.o === "auto"))) {
      const listNow = Math.ceil(on / 2);
      const flat = {};
      for (const m of OLD_ORDER) flat[m] = 0;
      for (let i = 0; i < listNow; i++) flat[OLD_ORDER[i % OLD_ORDER.length]]++;
      ctx.oldGames[game.key] = {
        base,
        ggsel: ggselOld,
        post: Math.max(0.75, quarter(base * 1.5)),
        split: { listNow, holdBack: on - listNow },
        flat,
        order: OLD_ORDER.slice(),
      };
    }
    const seen = new Set();
    for (const L of rows) {
      if (L.kind !== "single" || (L.o !== "auto" && L.o !== "unclaimed")) continue;
      const key = L.m + "|" + (L.ck || L.bk);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = game.offers.find((e) => e.offer.ck === L.ck);
      const level = entry && entry.prices[L.m] != null ? entry.prices[L.m] : L.p;
      const np =
        game.farm === "noclaim" ? (entry ? entry.R : L.p) : L.m === "ggsel" ? ggselOld : Math.max(base, floorFor(L.m));
      const tracker = rng.chance(0.75)
        ? {
            price: snap05(level * rng.range(0.9, 1.1)),
            basis: rng.pick(["exact", "band", "game", "translated"]),
            confidence: rng.pick(["high", "medium", "low"]),
          }
        : null;
      ctx.oldOffers[key] = { np, tracker };
    }
  }
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Assembly                                                                                                       */
/* -------------------------------------------------------------------------------------------------------------- */

const byThenId = (field, dir) => (a, b) =>
  (a[field] - b[field]) * dir || (a.id || a.grp || "").localeCompare(b.id || b.grp || "");

function generate({ seed = 1, large = false, now = DEFAULT_NOW } = {}) {
  const s = Number(seed);
  if (!Number.isInteger(s) || s < 0) throw new Error("seed must be a non-negative integer");
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) throw new Error("now must be a millisecond timestamp");
  const ctx = newCtx(s, nowMs);
  buildPlanted(ctx);
  if (large) buildFillers(ctx, LARGE_GAMES);
  finish(ctx);

  const listings = ctx.listings.slice().sort(byThenId("c", -1)); // newest first, like the loader's _id sort
  const sales = ctx.sales.slice().sort(byThenId("t", 1)); // oldest first, like the ledger
  const demandOnly = ctx.demandOnly.slice().sort((a, b) => a.t - b.t || a.g.localeCompare(b.g));
  const bulkPrices = ctx.bulkPrices.slice().sort((a, b) => a.t - b.t);
  const feed = ctx.feed.slice().sort((a, b) => b.t - a.t || a.g.localeCompare(b.g)); // newest first, like the radar
  const units = ctx.units.slice().sort((a, b) => a.l - b.l || a.g.localeCompare(b.g));
  const waves = ctx.waves.slice().sort((a, b) => a.g.localeCompare(b.g) || a.startAt - b.startAt);
  const demand = ctx.demand.slice().sort((a, b) => a.k.localeCompare(b.k) || a.f.localeCompare(b.f));
  const radarGames = ctx.radarGames.slice().sort((a, b) => a.key.localeCompare(b.key));
  const countBy = (list, f) => {
    const o = {};
    for (const m of MARKETS) o[m] = 0;
    for (const x of list) o[f(x)] = (o[f(x)] || 0) + 1;
    return o;
  };
  const claimGames = ctx.games.filter((g) => g.farm === "claim").length;

  return {
    kind: "listing-brain-bundle",
    v: 1,
    now: nowMs,
    af: {
      listingBrain: {},
      perMarketStock: 3,
      takes: { ...TAKES },
      mapped: ctx.mapped,
      noClaimGames: ["omega"],
      noclaimAutoSize: false,
      capDefault: 70,
      caps: ctx.caps,
    },
    sizing: { coverageDays: 28, safetyStock: 6, maxPerGame: 250 },
    fees: {},
    pricing: { ...PRICING, gameFloors: {} },
    bulk: {
      markets: ["eldorado", "g2g"],
      tiers: [
        { minQty: 5, discountPct: 10 },
        { minQty: 10, discountPct: 20 },
      ],
      reserveSingles: 2,
    },
    listings,
    sales,
    demandOnly,
    bulkPrices,
    radar: { at: nowMs - 20 * MIN, games: radarGames, feed },
    demand,
    noclaim: { units, waves },
    old: { games: ctx.oldGames, offers: ctx.oldOffers },
    notes: [
      `synthetic fixture (scripts/listing-brain-fixture.js, seed ${s}, ${large ? "large" : "small"}): every name, price and id is invented`,
      "old.games base: a derivePrice-shaped rule over the synthetic radar feed (no MarketResearch in a fixture)",
      "old.games split/flat: inline stand-ins for computeSplit (ceil(n/2)) and dealShares (round-robin over the order), not autoLister",
      "old.offers np (no-claim): a bundlePrice-shaped rule (anchor x item step x full-event bonus, quarter grid, floor/ceiling)",
    ],
    counts: {
      games: ctx.games.length,
      claimGames,
      noclaimGames: ctx.games.length - claimGames,
      listings: listings.length,
      sales: sales.length,
      demandOnly: demandOnly.length,
      bulkPrices: bulkPrices.length,
      radarGames: radarGames.length,
      feed: feed.length,
      demand: demand.length,
      units: units.length,
      waves: waves.length,
      oldGames: Object.keys(ctx.oldGames).length,
      oldOffers: Object.keys(ctx.oldOffers).length,
      listingsByMarket: countBy(listings, (L) => L.m),
      salesByMarket: countBy(sales, (S) => S.m),
    },
  };
}

const LARGE_GAMES = 150;

// One record per line (unindented) inside arrays and maps: the committed fixture diffs record by record and
// stays compact.
function toJson(bundle) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const fmt = (v, depth, pad) => {
    const inner = pad + "  ";
    if (Array.isArray(v) && v.length && v.every(isObj) && depth <= 3) {
      return "[\n" + v.map((r) => JSON.stringify(r)).join(",\n") + "\n" + pad + "]";
    }
    if (isObj(v) && depth <= 2 && Object.keys(v).length) {
      const parts = Object.keys(v).map((k) => inner + JSON.stringify(k) + ": " + fmt(v[k], depth + 1, inner));
      return "{\n" + parts.join(",\n") + "\n" + pad + "}";
    }
    return JSON.stringify(v);
  };
  return fmt(bundle, 0, "") + "\n";
}

/* -------------------------------------------------------------------------------------------------------------- */
/* What was planted                                                                                               */
/* -------------------------------------------------------------------------------------------------------------- */

const PLANTED_D_RATE = 0.12;
const PLANTED_F_RUNGS = [
  { p: 1.0, o: "manual", qty: 8, orders: [2, 1, 2, 1] },
  { p: 2.0, o: "manual", qty: 5, orders: [1, 1, 1] },
  { p: 4.0, o: "manual", qty: 5, orders: [1] },
  { p: 1.75, o: "auto", qty: 4, orders: [2] },
];

// Every planted truth: the games and markets involved, the true parameters, and the tolerance a model test should
// use. Game keys are setIdentity.normGame of the names. Present in both the small and the large bundle (the large
// one adds fillers that follow the same laws). Times are relative to the bundle's `now`.
const PLANTED = {
  seed: 1,
  now: DEFAULT_NOW,
  laws: LAWS,
  A: {
    what:
      "Gameflip claim auto rows of EVERY claim game are listed at ask/ref spread over 0.6-2.2; each OFFER has one buyer " +
      "stream at h(x_min) = h0 * exp(-beta * (x_min - 1)) a day, x_min its lowest live ask / ref, each buyer taking the " +
      "cheapest live row (H3: buyers take our cheapest row, so a dear row's rank is not a price response). Rows are " +
      "censored at a take-down, the 30-day expiry or now. Older rows at x = 1 make the reference price exactly the " +
      "realised median of the offer's Gameflip orders (exact-here, >= 3 orders)",
    market: "gameflip",
    farm: "claim",
    games: ["alpha quest", "beta arena", "gamma rush"],
    // The three games that carry most of the rows: their offers (n items, planted reference price R, rows).
    offers: [
      { game: "alpha quest", n: 3, R: 2.0, rows: 26 },
      { game: "alpha quest", n: 1, R: 1.5, rows: 20 },
      { game: "beta arena", n: 2, R: 1.75, rows: 26 },
      { game: "gamma rush", n: 5, R: 2.5, rows: 26 },
    ],
    allClaimGames: true,
    notes: [
      "the eta siege probe offer has 2 Gameflip orders only: no exact-here ref, so it never enters the fit",
      "zeta legends' Gameflip chain sits at x = 1 with deterministic waits of 1 / h0: on the law, not drawn from it",
      "data-level error of h(0.9)/h(1.5) (no shrinkage): within 20 % on small seed 1, within 10 % on large; assert " +
        "a tight tolerance on the large bundle (generate({ large: true }), ~0.2 s), the stated tolPct on the small one",
    ],
    h0: 0.12,
    beta: 1.6,
    ratio: { x1: 0.9, x2: 1.5, value: round4(Math.exp(1.6 * 0.6)), tolPct: 35 },
    h0TolPct: 35,
    xRange: [0.6, 2.2],
    refBasis: "exact-here",
    minOrdersPerOffer: 3,
    tierIndependent: true,
  },
  B: { game: "delta forge", farm: "claim", w: 1, on: 40, expectRegime: "overstock", sminFactor: 0.8 },
  B2: {
    game: "pi dungeon",
    farm: "claim",
    demand: { w: 1.5, on: 6, a30: 0.5, a45: 2 },
    expectRegime: "overstock",
    why: "fading: avg30 < 0.5 x avg45",
  },
  C: { game: "epsilon rift", farm: "claim", w: 12, on: 2, expectRegime: "scarce" },
  C2: {
    game: "rho galaxy",
    farm: "claim",
    w: 2.5,
    on: 10,
    endedDaysAgo: 2,
    liveRivalSellers: 1,
    expectRegime: "scarce",
    why: "campaign ended (demand live false, wave ended 2 days ago) and the radar shows <= rivalsGoneMax live rival sellers",
  },
  D: {
    game: "zeta legends",
    farm: "claim",
    periodDays: 5,
    markets: {
      gameflip: { dailyRate: PLANTED_D_RATE, inStockShare30: 1, sales30: 4, inStockDays30: 30, price: 1.75 },
      ggsel: { dailyRate: PLANTED_D_RATE, inStockShare30: 0.5, sales30: 2, inStockDays30: 15, price: 1.5 },
    },
    expect: "the shrunk in-stock rate share of ggsel / gameflip stays near 1 (a raw 30-day sales share would read 0.5)",
    shareRatio: { value: 1, tolPct: 35, naive: 0.5 },
    stockout: { market: "ggsel", emptyShare30: 0.5 },
  },
  E: {
    market: "digiseller",
    blocked: true,
    priceMult: 3,
    games: ["alpha quest", "eta siege", "kappa raiders", "chi arcana"],
    expect: "digiseller cells closed (shelf 0); no digiseller order ever prices another market",
    probe: {
      game: "eta siege",
      n: 3,
      market: "gameflip",
      orders: { gameflip: 2, ggsel: 5, digiseller: 6 },
      prices: { gameflip: 1.5, ggsel: 1.3, digiseller: 4.5 },
      expectBasis: "translated",
      expectRef: { value: 1.5, tolPct: 30, never: 4.5, max: 2.5 },
    },
    liveRow: { game: "eta siege", market: "digiseller", expect: "never advised, no shelf" },
  },
  F: {
    game: "theta drift",
    farm: "claim",
    market: "eldorado",
    n: 2,
    rungs: PLANTED_F_RUNGS.map((r) => ({
      p: r.p,
      o: r.o,
      qty: r.qty,
      sold: r.orders.reduce((a, b) => a + b, 0),
      orders: r.orders.length,
    })),
    liveDays: 18,
    expect: "price class ladder, never corrected; rungs read as evidence",
  },
  G: {
    game: "iota tactics",
    market: "gameflip",
    kind: "farm",
    price: 12,
    sales: 4,
    expect: "ignored entirely: no order, no exposure, no cell from it",
  },
  H: {
    game: "kappa raiders",
    farm: "claim",
    market: "ggsel",
    n: 12,
    fakePrice: 8,
    atDaysAgo: 6,
    windowMinutes: 5,
    expect: "burst records are demand only; no order at the fake price; the closed rows have no sale",
    handHigh: { game: "alpha quest", market: "gameflip", price: 9.5, n: 2, expect: "hand sales never price evidence" },
  },
  I: {
    noDemand: "lambda racers",
    staleGame: "mu kingdoms",
    staleHours: 9,
    maxDemandAgeH: 6,
    expectRegime: "unknown",
    expectAction: "hold",
  },
  J: {
    cas: {
      game: "omega online",
      market: "eldorado",
      o: "manual",
      f: "noclaim",
      kind: "cas",
      qty: 35,
      sold: 5,
      alsoInUnits: true,
    },
    script: { game: "sigma strike", market: "g2g", o: "auto", f: "claim", kind: "cas", script: true, qty: 60, sold: 6 },
    expect: "never advised; their qty never summed into stock or shelves; their sales are price evidence and demand",
  },
  K: {
    fees: {},
    assumed: ["gameflip", "digiseller", "ggsel", "zeusx", "playerauctions"],
    verified: ["eldorado", "g2g"],
    game: "nu frontier",
    design: { gameflip: { ref: 2.0, feePct: 8, net: 1.84 }, eldorado: { ref: 2.03, feePct: 10, net: 1.83 } },
    expect:
      "fee-assumed flags on the assumed markets; nu frontier is a near-tie whose placement (shelf vs shEq) can flip with equal fees",
  },
  L: { game: "xi outpost", market: "zeusx", expect: "unmeasured: no sales on any zeusx row, shelf 0, no exploration" },
  M: {
    game: "omicron wars",
    market: "playerauctions",
    floor: 5,
    sellsFor: 1.5,
    expect: "closed: floor above what the offer sells for",
  },
  N: {
    claimWindowDays: { value: 1, tolDays: 0.25 },
    ended: {
      game: "omega saga",
      event: "Ember League",
      wave: "Week 4",
      endedDaysAgo: 3,
      units: 16,
      expect: "expired units outnumber sold ones",
    },
    perish: {
      game: "omega online",
      event: "Frost Cup",
      wave: "Week 5",
      endsInHours: 12,
      units: 20,
      w: 6,
      expectRegime: "overstock",
      why: "stock expires (wave end + claim window ~ 36 h) within perishHours 48",
    },
  },
  O: {
    game: "omega tactics",
    farm: "noclaim",
    markets: ["eldorado", "g2g"],
    packs30: 8,
    packSizes: [5, 10],
    perAccount: { 5: 0.62, 10: 0.55 },
    expect:
      "bulk weekly units >> single sales; bulkTake set aside first; per-account prices never single-unit evidence",
  },
  P: {
    game: "omega racers",
    market: "ggsel",
    rbDaysAgo: 12,
    before: { n: 7, p: 3 },
    after: { n: 4, p: 1.25 },
    expect: "sales before rb dropped from offer evidence: exact-here ref on ggsel = the after price",
    expectRef: { value: 1.25, tolAbs: 0.1, leakWouldGive: 3 },
  },
  Q: {
    game: "omega racers",
    market: "gameflip",
    farm: "noclaim",
    autoPrice: 1.5,
    autoSold: 5,
    manualPrices: [2.25, 3.0],
    expect: "ladder",
  },
  R: {
    explicit: { "omega tactics": 40 },
    capDefault: 70,
    defaultGame: "omega online",
    expect: "explicit cap is managed; others use 70",
  },
  V: {
    game: "phi colony",
    market: "ggsel",
    vmin: 1.1,
    expect: "GGSel hidden category minimum: floor = max(floorFor, vmin)",
  },
  U: {
    game: "upsilon tides",
    market: "g2g",
    expect: "switch on, no brand mapping, no history: eligibility unknown, shelf 0",
  },
  unwatched: ["tau harbor"],
  large: { games: LARGE_GAMES, minListings: 3000, minSales: 5000, days: 120 },
};

/* -------------------------------------------------------------------------------------------------------------- */
/* CLI                                                                                                            */
/* -------------------------------------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { large: false, seed: 1, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--large") out.large = true;
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a.startsWith("--seed=")) out.seed = Number(a.slice(7));
    else if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice(6);
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error("unknown argument " + a);
  }
  return out;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      e.message + "\nusage: node scripts/listing-brain-fixture.js [--large] [--seed N] [--out file]\n",
    );
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write("usage: node scripts/listing-brain-fixture.js [--large] [--seed N] [--out file]\n");
    process.exit(0);
  }
  const t0 = process.hrtime.bigint();
  const bundle = generate({ seed: args.seed, large: args.large });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const text = toJson(bundle);
  if (args.out) {
    require("fs").writeFileSync(args.out, text);
    const c = bundle.counts;
    process.stderr.write(
      `wrote ${args.out}: ${Buffer.byteLength(text)} bytes, ${c.games} games, ${c.listings} listings, ${c.sales} sales, ` +
        `${c.units} no-claim units (${ms.toFixed(0)} ms)\n`,
    );
  } else process.stdout.write(text);
}

module.exports = { generate, PLANTED, LAWS, mulberry32, toJson, DEFAULT_NOW };
