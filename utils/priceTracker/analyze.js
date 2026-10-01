// The price tracker's analysis: pure functions from (ledger, listings, sets) to
// answers. No DB, no network, no clock except the injected `now`.
//
// Four questions, in the order the owner asked them:
//   1. What do we actually get on each market?              venueSummary
//   2. Do lower prices really buy more sales?               priceCurve
//   3. Same items, different markets — who pays what?       setBoard / translate
//   4. So what should THIS listing cost HERE?               recommend
//
// THE RULES THAT KEEP IT HONEST (each one is a mistake this codebase has made):
//   * Every number states its evidence (n, source, price basis). A median of 2 is
//     shown as "2", not as a trend.
//   * A price is only compared with another price for the SAME items. Exact set
//     content first; same game + size band second; never "all drops".
//   * A price earned on another market is TRANSLATED to this market's level with
//     a ratio measured on sets sold on both — it is never copied across. (GGSel
//     once wanted $10 on the strength of a Gameflip rival.)
//   * Rent-farm windows, bulk packs and unpriced sales never enter a price.
//   * Nothing here writes. `recommend` returns advice with its reasons; applying
//     it is a separate, owner-approved act, and only ever on origin:"auto" rows.
const { identify } = require("./setIdentity");
const { median, quantile, band, wilson, DAY, round2 } = require("./stats");
const { MARKETS, VENUES, feeFor, netOf, floorFor } = require("./venues");
const pricing = require("../pricing");

const idStr = (x) => (x == null ? "" : String(x).toLowerCase());
const ts = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

// Evidence older than this no longer says what buyers pay today.
const WINDOW_DAYS = 180;
// The price rungs the shop actually uses (0.75, 1.00, 1.25, ... ). Curve bins are
// built around them so a bin means "this price point", not an arbitrary slice.
const BIN_EDGES = [0.8, 1.1, 1.35, 1.6, 1.9, 2.4, 3.1, 4.1, Infinity];
const BIN_LABELS = ["≤$0.80", "$0.81–1.10", "$1.11–1.35", "$1.36–1.60", "$1.61–1.90", "$1.91–2.40", "$2.41–3.10", "$3.11–4.10", ">$4.10"];
const MIN_RESOLVED = 10; // a curve cell with fewer resolved listings is "thin"
// No drop bundle here has ever sold above $4.50. A listing priced above this is
// a placeholder or a hand-priced one-off (a $999 row exists), not a price point;
// letting it into a curve bin made ">$4.10" look like the best price on Gameflip.
const MAX_REAL_PRICE = 25;
const round3 = (n) => Math.round(n * 1000) / 1000;

function binOf(price) {
  const i = BIN_EDGES.findIndex((e) => price <= e + 1e-9);
  return i < 0 ? BIN_EDGES.length - 1 : i;
}

/* --------------------------- preparing the inputs -------------------------- */

// Listings + sets -> identified drops listings. Everything else (farm, bulk) is
// set aside here so no later step has to remember to skip it.
function prepare({ listings = [], sets = [], sales = [] }) {
  const setById = new Map(sets.map((s) => [idStr(s._id), s]));
  const rows = [];
  const skipped = { farm: 0, bulk: 0, junkPrice: 0 };
  for (const l of listings) {
    if (Number(l.price) > MAX_REAL_PRICE) {
      skipped.junkPrice += 1;
      continue;
    }
    const id = identify(l, l.set ? setById.get(idStr(l.set)) : null);
    if (id.kind !== "drops") {
      skipped[id.kind === "bulk" ? "bulk" : "farm"] += 1;
      continue;
    }
    rows.push({ l, id, market: String(l.marketplace || "").toLowerCase(), listingId: idStr(l._id) });
  }
  const salesByListing = new Map();
  for (const s of sales) {
    if (!s.listingId) continue;
    if (!salesByListing.has(s.listingId)) salesByListing.set(s.listingId, []);
    salesByListing.get(s.listingId).push(s);
  }
  return { rows, skipped, salesByListing, setById };
}

// One piece of PRICE evidence per buyer order. A single Eldorado order can
// deliver 10 units (270 units came from 168 orders); counting units made one
// order read as ten confirmations and could lift a recommendation to "high".
// Revenue still sums units — each is its own account — but a price, a median and
// a confidence count orders.
function perOrder(sales) {
  const seen = new Set();
  const out = [];
  for (const s of sales) {
    const g = s.saleGroup || s.key;
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(s);
  }
  return out;
}

// A blocked market (Digiseller, by the owner's order) is history: it may still be
// shown, but it never TEACHES another market's price.
const isBlocked = (m) => !!(VENUES[m] && VENUES[m].blocked);

function windowed(sales, now, windowDays) {
  const since = now - windowDays * DAY;
  return sales.filter((s) => s.priced && s.source !== "hand" && s.market !== "unknown" && s.at.getTime() >= since);
}

/* ------------------------------ 1. the venues ------------------------------ */

function venueSummary({ sales, prepared, now, fees, windowDays = WINDOW_DAYS }) {
  const priced = windowed(sales, now, windowDays);
  const out = [];
  for (const market of MARKETS) {
    const mine = priced.filter((s) => s.market === market);
    const orders = perOrder(mine);
    const prices = orders.map((s) => s.priceUsd);
    const b = band(prices);
    const t30 = mine.filter((s) => s.at.getTime() >= now - 30 * DAY);
    const p30 = mine.filter((s) => s.at.getTime() < now - 30 * DAY && s.at.getTime() >= now - 60 * DAY);
    const t7 = mine.filter((s) => s.at.getTime() >= now - 7 * DAY);
    const floor = floorFor(market);
    const live = prepared.rows.filter((r) => r.market === market && r.l.status === "active");
    const asks = live.map((r) => Number(r.l.price)).filter((p) => p > 0);
    const askMed = median(asks);
    const gross = mine.reduce((a, s) => a + s.priceUsd, 0);
    const fee = feeFor(market, fees);
    out.push({
      market,
      label: VENUES[market].label,
      blocked: !!VENUES[market].blocked,
      fee: { pct: fee.feePct, verified: fee.verified, source: fee.source },
      floorUsd: floor,
      realised: b,
      // `total` counts units (accounts sold); `orders` counts buyer orders, and
      // `realised` is computed over orders.
      sales: { total: mine.length, orders: orders.length, d7: t7.length, d30: t30.length, prev30: p30.length },
      grossUsd: round2(gross),
      netUsd: round2(mine.reduce((a, s) => a + netOf(s.priceUsd, market, fees), 0)),
      // Revenue on unit markets uses the listing's price NOW, not the price at
      // delivery (nothing stamps it). Say so wherever the number appears.
      approxShare: mine.length ? round2(mine.filter((s) => s.priceBasis === "listing-now").length / mine.length) : 0,
      // Selling at the floor is not wrong, but if a lot of sales happen there the
      // floor is the price discovery, and we have no evidence about higher ones.
      atFloorShare: mine.length ? round2(mine.filter((s) => s.priceUsd <= floor * 1.05).length / mine.length) : 0,
      trend: {
        medianLast30: median(t30.map((s) => s.priceUsd)),
        medianPrev30: median(p30.map((s) => s.priceUsd)),
      },
      live: { n: live.length, askMedian: askMed, askP75: quantile(asks, 0.75), askMax: asks.length ? Math.max(...asks) : 0 },
      // > 0: we ask more than we have ever realised on this market's median.
      askVsRealisedPct: b.median > 0 && askMed > 0 ? round2(((askMed - b.median) / b.median) * 100) : null,
    });
  }
  return out;
}

/* ------------------------------ 2. price curve ----------------------------- */

// For every listing row of one market: at what price was it offered, how long was
// it exposed, and did it sell? Then group by price bin.
//
// This answers "do lower prices really sell more?". It CANNOT prove cause: cheap
// rows are partly cheap because they are weaker sets, so the page carries that
// caveat and offers the `origin` filter and per-bin n. What it can do is show,
// with intervals, where the evidence says money is being left on the table.
function priceCurve({ market, prepared, now, origin = "auto", windowDays = WINDOW_DAYS }) {
  const single = VENUES[market] && VENUES[market].saleModel === "single-unit";
  const since = now - windowDays * DAY;
  let quickEnds = 0;
  const cells = BIN_LABELS.map((label, i) => ({
    i,
    label,
    listings: 0,
    resolved: 0,
    soldRows: 0,
    soldUnits: 0,
    revenueUsd: 0,
    listingDays: 0,
    prices: [],
    soldPrices: [],
    daysToSale: [],
  }));
  for (const r of prepared.rows) {
    if (r.market !== market) continue;
    if (origin && r.l.origin !== origin) continue;
    const l = r.l;
    const created = ts(l.createdAt);
    if (created == null || created < since) continue;
    const mySales = (prepared.salesByListing.get(r.listingId) || []).filter((s) => s.priced);
    const unitsSold = Math.max(mySales.length, l.status === "sold" ? 1 : 0);
    const sold = unitsSold > 0;
    // An unsold row that ended in under a day was replaced or relisted, not
    // "rejected by buyers"; counting it as a non-sale made cheap bins look worse.
    if (!sold && l.status !== "active" && ((ts(l.updatedAt) || now) - created) / DAY < 1) {
      quickEnds += 1;
      continue;
    }
    // The price this row is judged at: what it actually sold for when we know,
    // else what it asked.
    const price = mySales.length ? mySales[0].priceUsd : Number(l.price) || 0;
    if (!(price > 0)) continue;
    const firstSaleAt = mySales.length ? Math.min(...mySales.map((s) => s.at.getTime())) : null;
    const updated = ts(l.updatedAt) || now;
    const end = l.status === "active" ? now : firstSaleAt && single ? firstSaleAt : updated;
    const exposure = Math.min(365, Math.max(0, (end - created) / DAY));
    const c = cells[binOf(price)];
    c.listings += 1;
    c.listingDays += exposure;
    c.prices.push(price);
    if (single) {
      if (l.status !== "active") {
        c.resolved += 1;
        if (sold) c.soldRows += 1;
      }
    }
    if (sold) {
      c.soldUnits += unitsSold;
      c.revenueUsd += mySales.reduce((a, s) => a + s.priceUsd, 0) || price;
      c.soldPrices.push(price);
      if (single && firstSaleAt) c.daysToSale.push(Math.max(0, (firstSaleAt - created) / DAY));
    }
  }
  const bins = cells
    .filter((c) => c.listings > 0)
    .map((c) => {
      const conv = single ? wilson(c.soldRows, c.resolved) : null;
      const meanPrice = c.prices.length ? c.prices.reduce((a, b) => a + b, 0) / c.prices.length : 0;
      return {
        label: c.label,
        meanPrice: round2(meanPrice),
        listings: c.listings,
        resolved: c.resolved,
        soldUnits: c.soldUnits,
        conversion: conv ? { p: round2(conv.p), lo: round2(conv.lo), hi: round2(conv.hi) } : null,
        medianDaysToSale: c.daysToSale.length ? round2(median(c.daysToSale.map((d) => d + 0.001))) : null,
        fastShare24h: c.daysToSale.length ? round2(c.daysToSale.filter((d) => d <= 1).length / c.daysToSale.length) : null,
        salesPerListingDay: c.listingDays > 0 ? round3(c.soldUnits / c.listingDays) : 0,
        revenueUsd: round2(c.revenueUsd),
        revenuePerListingDay: c.listingDays > 0 ? round3(c.revenueUsd / c.listingDays) : 0,
        // Expected revenue per listing that RESOLVES (sells or ends): the right
        // yardstick when each listing is one account that can only sell once.
        expectedRevenuePerListing: conv ? round2(meanPrice * conv.p) : null,
        // The same with the interval's lower end: what we can claim at ~80%.
        expectedRevenueLow: conv ? round2(meanPrice * conv.lo) : null,
        thin: single ? c.resolved < MIN_RESOLVED : c.soldUnits < MIN_RESOLVED,
      };
    });
  // Best bin: only bins with enough evidence, judged on the conservative end.
  const solid = bins.filter((b) => !b.thin);
  const key = single ? "expectedRevenueLow" : "revenuePerListingDay";
  // A market with no recorded sale has no curve at all: every bin would read 0%
  // and "best" would be an arbitrary empty bin (ZeusX records no sales).
  const anySold = bins.some((b) => b.soldUnits > 0);
  const best0 = solid.length ? solid.reduce((a, b) => (b[key] > a[key] ? b : a)) : null;
  const best = anySold && best0 && best0[key] > 0 ? best0 : null;
  return {
    market,
    metric: single ? "expected revenue per resolved listing" : "revenue per listing-day",
    saleModel: single ? "single-unit" : VENUES[market] ? VENUES[market].saleModel : "?",
    origin: origin || "all",
    bins,
    best: best ? best.label : null,
    noEvidence: !anySold,
    quickEnds,
    caveat:
      "Cheap listings are partly cheap because they are weaker sets, so this shows where sales " +
      "happen, not that a price caused them. Bins marked thin have fewer than " +
      MIN_RESOLVED +
      " resolved listings.",
  };
}

/* --------------------------- 3. the same items, everywhere ------------------ */

function groupKeyOf(x) {
  return x.exact ? x.contentKey : x.bandKey;
}

// Translation between markets, measured on SETS SOLD ON BOTH. This is the heart
// of "different markets, different prices": not a fee guess and not a copy.
function buildTranslator(sales, now, windowDays = WINDOW_DAYS) {
  const priced = perOrder(windowed(sales, now, windowDays)).filter((s) => s.exact && s.contentKey);
  const bySet = new Map(); // contentKey -> market -> prices
  for (const s of priced) {
    if (!bySet.has(s.contentKey)) bySet.set(s.contentKey, new Map());
    const m = bySet.get(s.contentKey);
    if (!m.has(s.market)) m.set(s.market, []);
    m.get(s.market).push(s.priceUsd);
  }
  // Venue level: median of everything realised there (the fallback ratio).
  const level = new Map();
  for (const mk of MARKETS) level.set(mk, median(priced.filter((s) => s.market === mk).map((s) => s.priceUsd)));
  // Looser, wider level using ALL priced drops on that market (not just exact).
  const allPriced = perOrder(windowed(sales, now, windowDays));
  const level2 = new Map();
  for (const mk of MARKETS) level2.set(mk, median(allPriced.filter((s) => s.market === mk).map((s) => s.priceUsd)));

  const pairs = new Map();
  function pairRatio(from, to) {
    const k = from + ">" + to;
    if (pairs.has(k)) return pairs.get(k);
    const ratios = [];
    for (const m of bySet.values()) {
      if (m.has(from) && m.has(to)) {
        const a = median(m.get(from));
        const b = median(m.get(to));
        if (a > 0 && b > 0) ratios.push(b / a);
      }
    }
    const r = { n: ratios.length, ratio: ratios.length ? median(ratios) : 0 };
    pairs.set(k, r);
    return r;
  }

  const CLAMP = [0.4, 1.5]; // same band utils/pricing.js venueFactor uses
  function translate(price, from, to) {
    if (from === to) return { price, ratio: 1, basis: "same venue", n: 0 };
    if (isBlocked(from) || isBlocked(to)) return { price: 0, ratio: 0, basis: "blocked market is not a price source", n: 0 };
    const pr = pairRatio(from, to);
    if (pr.n >= 3) {
      const ratio = Math.min(CLAMP[1], Math.max(CLAMP[0], pr.ratio));
      return { price: price * ratio, ratio, basis: "paired on " + pr.n + " sets sold on both", n: pr.n };
    }
    const a = level2.get(from);
    const b = level2.get(to);
    const nFrom = allPriced.filter((s) => s.market === from).length;
    const nTo = allPriced.filter((s) => s.market === to).length;
    if (a > 0 && b > 0 && nFrom >= 10 && nTo >= 10) {
      const ratio = Math.min(CLAMP[1], Math.max(CLAMP[0], b / a));
      return { price: price * ratio, ratio, basis: "venue medians (" + nFrom + " vs " + nTo + " sales)", n: 0 };
    }
    return { price: 0, ratio: 0, basis: "no basis — too little evidence on one side", n: 0 };
  }
  return { translate, pairRatio, level, level2, bySet };
}

function setBoard({ sales, prepared, now, fees, windowDays = WINDOW_DAYS }) {
  const priced = perOrder(windowed(sales, now, windowDays));
  const groups = new Map();
  const get = (k, x) => {
    if (!groups.has(k)) {
      groups.set(k, {
        key: k,
        tier: x.exact ? "exact" : "band",
        game: x.game || "",
        gameKey: x.gameKey || "",
        itemCount: x.itemCount || x.countForBand || null,
        title: "",
        titleAt: 0,
        markets: {},
      });
    }
    return groups.get(k);
  };
  const cell = (g, market) => {
    if (!g.markets[market]) g.markets[market] = { live: [], soldPrices: [], soldAt: [], orderIds: [] };
    return g.markets[market];
  };
  for (const r of prepared.rows) {
    if (r.l.status !== "active") continue;
    const x = { ...r.id, itemCount: r.id.countForBand };
    const g = get(groupKeyOf(r.id), x);
    const t = ts(r.l.updatedAt) || 0;
    if (t >= g.titleAt) {
      g.title = r.l.title;
      g.titleAt = t;
    }
    cell(g, r.market).live.push({
      listingId: r.listingId,
      externalId: String(r.l.externalId || ""),
      price: Number(r.l.price) || 0,
      origin: r.l.origin || "manual",
      ageDays: round2((now - (ts(r.l.createdAt) || now)) / DAY),
      title: r.l.title,
    });
  }
  for (const s of priced) {
    const k = s.exact ? s.contentKey : s.bandKey;
    if (!k) continue;
    const g = get(k, s);
    if (s.at.getTime() >= g.titleAt) {
      g.title = s.title || g.title;
      g.titleAt = s.at.getTime();
    }
    const c = cell(g, s.market);
    c.soldPrices.push(s.priceUsd);
    c.soldAt.push(s.at.getTime());
    if (s.orderId) c.orderIds.push(s.orderId);
  }
  const out = [];
  for (const g of groups.values()) {
    const mk = {};
    let comparable = 0;
    for (const [m, c] of Object.entries(g.markets)) {
      const sold = c.soldPrices.length;
      mk[m] = {
        live: c.live.sort((a, b) => a.price - b.price),
        liveN: c.live.length,
        sold,
        soldMedian: median(c.soldPrices),
        soldMin: sold ? Math.min(...c.soldPrices) : 0,
        soldMax: sold ? Math.max(...c.soldPrices) : 0,
        lastSoldAt: sold ? new Date(Math.max(...c.soldAt)).toISOString() : null,
        netMedian: sold ? netOf(median(c.soldPrices), m, fees) : 0,
        orderIds: c.orderIds.slice(-5),
      };
      if (sold) comparable += 1;
    }
    const withSales = Object.entries(mk).filter(([, v]) => v.sold > 0);
    const best = withSales.length ? withSales.reduce((a, b) => (b[1].netMedian > a[1].netMedian ? b : a)) : null;
    const lo = withSales.length ? Math.min(...withSales.map(([, v]) => v.soldMedian)) : 0;
    const hi = withSales.length ? Math.max(...withSales.map(([, v]) => v.soldMedian)) : 0;
    out.push({
      key: g.key,
      tier: g.tier,
      game: g.game,
      itemCount: g.itemCount,
      title: g.title,
      markets: mk,
      soldTotal: withSales.reduce((a, [, v]) => a + v.sold, 0),
      liveTotal: Object.values(mk).reduce((a, v) => a + v.liveN, 0),
      marketsWithSales: comparable,
      // "who pays most" for the same items, after fees (informational — fee
      // rates are partly assumed; see venues.js).
      bestVenue: best ? best[0] : null,
      spread: comparable >= 2 && lo > 0 ? round2(hi / lo) : null,
    });
  }
  // Most evidence first: that is the page's whole job.
  out.sort((a, b) => b.marketsWithSales - a.marketsWithSales || b.soldTotal - a.soldTotal || b.liveTotal - a.liveTotal);
  return out;
}

/* ------------------------------- 4. the advice ------------------------------ */

// Snap to the shop's own rungs so a recommendation looks like a price a human
// would set. Evidence prices from exact sold sets are kept to the cent.
function snap(p) {
  if (!(p > 0)) return 0;
  return Math.round(p * 20) / 20; // $0.05
}

function evidenceFromLedger(sales, now, { market, gameKey }, pricedAll = null) {
  const priced = (pricedAll || perOrder(windowed(sales, now, WINDOW_DAYS))).filter((s) => !isBlocked(s.market) || s.market === market);
  const plat = priced.filter((s) => s.market === market).map((s) => s.priceUsd);
  const game = priced.filter((s) => gameKey && s.gameKey === gameKey).map((s) => s.priceUsd);
  const platGame = priced.filter((s) => gameKey && s.gameKey === gameKey && s.market === market).map((s) => s.priceUsd);
  return { platformGame: platGame, game, platform: plat, global: priced.map((s) => s.priceUsd), rivalLowest: 0, researchMedian: 0, marketplace: market };
}

const CONF_RANK = { high: 3, medium: 2, low: 1, none: 0 };

// The order-level priced sales inside the window, and the per-venue / global p75 that
// cap a price, are the same for every listing and every game in one build. They were
// recomputed per call (O(sales) each, thousands of calls), which was most of the
// report's ~1 s of event-loop time. Computed once on the ctx and reused.
function pricedOf(ctx) {
  if (!ctx._priced) ctx._priced = perOrder(windowed(ctx.sales, ctx.now, WINDOW_DAYS));
  return ctx._priced;
}
function venueP75Of(ctx, market) {
  if (!ctx._venueP75) ctx._venueP75 = new Map();
  if (!ctx._venueP75.has(market)) {
    const v = pricedOf(ctx).filter((s) => s.market === market).map((s) => s.priceUsd);
    ctx._venueP75.set(market, { n: v.length, p75: band(v).p75 });
  }
  return ctx._venueP75.get(market);
}
function globalP75Of(ctx) {
  if (ctx._globalP75 == null) ctx._globalP75 = band(pricedOf(ctx).map((s) => s.priceUsd)).p75;
  return ctx._globalP75;
}

/**
 * What should this exact offer cost on this market?
 *
 * @param {object} ctx   { sales, now, tr (translator), fees, curves }
 * @param {object} q     { market, id (identify() result), currentPrice,
 *                         floorUsd, setMinUsd, venueMinUsd, ageDays, origin, soldHere }
 */
function recommend(ctx, q) {
  const { sales, now, tr } = ctx;
  const market = q.market;
  const id = q.id;
  const reasons = [];
  const priced = pricedOf(ctx);
  const sameSet = id.exact && id.contentKey ? priced.filter((s) => s.exact && s.contentKey === id.contentKey) : [];
  const bandSales = id.bandKey && !id.bandKey.endsWith("|?") ? priced.filter((s) => s.bandKey === id.bandKey && s.exact) : [];

  let anchor = 0;
  let basis = "none";
  let confidence = "none";
  let evidenceN = 0;

  const here = sameSet.filter((s) => s.market === market).map((s) => s.priceUsd);
  if (here.length) {
    // Latest first: the most recent sale is the best statement of today's price.
    anchor = here.length >= 2 ? median(here) : here[0];
    basis = "exact set sold on this market";
    confidence = here.length >= 3 ? "high" : here.length === 2 ? "medium" : "low";
    evidenceN = here.length;
    reasons.push("This exact set has sold " + here.length + "× here (median $" + anchor.toFixed(2) + ").");
  }
  if (!anchor) {
    const others = [];
    const marketsUsed = new Set();
    let used = null;
    for (const m of MARKETS) {
      if (m === market || isBlocked(m)) continue;
      const ps = sameSet.filter((s) => s.market === m).map((s) => s.priceUsd);
      if (!ps.length) continue;
      const t = tr.translate(median(ps), m, market);
      if (t.price > 0) {
        others.push(t.price);
        marketsUsed.add(m);
        used = used || t;
      }
    }
    if (others.length) {
      anchor = median(others);
      basis = "exact set sold on other markets, translated";
      confidence = marketsUsed.size >= 2 ? "medium" : "low";
      evidenceN = sameSet.length;
      reasons.push(
        "Same items sold on " + [...marketsUsed].join(", ") + "; scaled to " + market + " (" + (used ? used.basis : "") + ").",
      );
    }
  }
  if (!anchor && bandSales.length) {
    const here2 = bandSales.filter((s) => s.market === market).map((s) => s.priceUsd);
    if (here2.length >= 3) {
      anchor = median(here2);
      basis = "same game + size band on this market";
      confidence = "low";
      evidenceN = here2.length;
      reasons.push(here2.length + " sales of this game at a similar size here (median $" + anchor.toFixed(2) + ").");
    } else {
      const tl = [];
      for (const m of MARKETS) {
        if (m === market || isBlocked(m)) continue;
        const ps = bandSales.filter((s) => s.market === m).map((s) => s.priceUsd);
        if (ps.length < 2) continue;
        const t = tr.translate(median(ps), m, market);
        if (t.price > 0) tl.push(t.price);
      }
      if (tl.length) {
        anchor = median(tl);
        basis = "same game + size band on other markets, translated";
        confidence = "low";
        evidenceN = bandSales.length;
        reasons.push("Similar sets of this game sold elsewhere; scaled to " + market + ".");
      }
    }
  }
  if (!anchor) {
    // Last resort: the existing engine, fed from THIS ledger so there is one
    // source of evidence, not two.
    try {
      const ev = evidenceFromLedger(sales, now, { market, gameKey: id.gameKey }, pricedOf(ctx));
      const r = pricing.priceListing({ evidence: ev, itemCount: id.countForBand || 1, marketplace: market });
      if (r && r.price > 0) {
        anchor = r.price;
        basis = "engine (" + r.basis + ")";
        confidence = "low";
        evidenceN = 0;
        reasons.push("No comparable sales; the shared pricing engine says $" + r.price.toFixed(2) + " (" + r.reason + ").");
      }
    } catch {
      /* the engine is a fallback; no answer is a legitimate answer */
    }
  }

  // Guards.
  const floor = Math.max(floorFor(market), Number(q.setMinUsd) || 0, Number(q.venueMinUsd) || 0);
  // The ceiling for anything that is NOT this exact set's own sale here: 1.5x the
  // p75 of what this venue has actually paid (the whole business's p75 when the
  // venue has fewer than 10 sales). Measured 2026-10-01: a p90-based cap let a
  // GGSel suggestion reach $2.65 on a venue whose p75 is $1.00. The cap exists so
  // translated or engine evidence can never claim a price the venue has only seen
  // in its top tail; exact own-venue evidence is exempt (a buyer really paid it).
  const vs = venueP75Of(ctx, market);
  const ref = vs.n >= 10 && vs.p75 > 0 ? vs.p75 : globalP75Of(ctx) || 25;
  const cap = Math.max(floor, Math.min(25, ref * 1.5));
  let price = id.exact && basis === "exact set sold on this market" ? round2(anchor) : snap(anchor);
  let clamped = "";
  if (price > 0 && price < floor) {
    price = round2(floor);
    clamped = "floor";
  }
  const exactHere = basis === "exact set sold on this market";
  if (price > cap && !exactHere) {
    price = snap(cap);
    clamped = "ceiling";
  }
  if (!(price > 0)) {
    return { price: 0, basis, confidence: "none", evidenceN: 0, reasons: ["Not enough evidence to suggest a price."], floor, cap, clamped, action: "insufficient" };
  }

  // The money-making nudge: a price STEP above the base, offered as a test, only
  // when this market's own curve says a higher bin earns more (conservative end)
  // and the base evidence is not already "high".
  let test = null;
  const curve = ctx.curves && ctx.curves[market];
  if (curve && curve.best && confidence !== "high") {
    const mine = curve.bins.find((b) => binOf(price) === BIN_LABELS.indexOf(b.label));
    const bestBin = curve.bins.find((b) => b.label === curve.best);
    const key = curve.saleModel === "single-unit" ? "expectedRevenueLow" : "revenuePerListingDay";
    if (bestBin && bestBin.meanPrice > price * 1.1 && (!mine || bestBin[key] >= (mine[key] || 0) * 1.15)) {
      const stepUp = Math.min(snap(bestBin.meanPrice), snap(cap));
      if (stepUp > price) {
        test = {
          price: stepUp,
          why:
            "On " +
            market +
            " the " +
            bestBin.label +
            " price point earns the most per listing (" +
            curve.metric +
            "); worth testing on one or two of these, not all.",
        };
      }
    }
  }

  // Compare with what it costs today.
  //
  // The engine fallback is the weakest evidence we have (it is the old
  // all-purpose pricer, fed from this ledger). It may tell the owner a listing
  // looks high after a long unsold wait, but it never says "raise": a raise on
  // no comparable sale is a guess, and guessing up is how GGSel got $10 asks.
  const engineBasis = basis.indexOf("engine") === 0;
  const cur = Number(q.currentPrice) || 0;
  let action = "hold";
  const age = Number(q.ageDays) || 0;
  if (cur > 0) {
    // A change needs MEDIUM confidence or better: two or more distinct orders of
    // this exact set here, or the same items sold on two or more other markets.
    // One sale, a band-level guess or the engine fallback may inform the owner
    // (the reasons say so) but never produce a raise/lower that something could
    // act on. Measured on the first run: "lower" on one translated sale and
    // "raise" on band evidence from a venue with 12 sales in total.
    const strong = !engineBasis && CONF_RANK[confidence] >= 2;
    if (strong && price >= cur * 1.15) action = "raise";
    else if (strong && cur >= price * 1.25) action = "lower";
    else if (cur >= price * 1.5 && age >= 21 && !q.soldHere) {
      reasons.push("Informational: asking " + Math.round((cur / price - 1) * 100) + "% above this estimate after " + Math.round(age) + " days unsold, on " + confidence + " evidence — not strong enough to recommend a change.");
    }
  } else {
    action = "new";
  }
  if (q.ladder) {
    // The same exact set is deliberately offered at several price points on this
    // market. That is an experiment (the owner's Eldorado OWCS $1/$2/$4/$5
    // copies); a recommender that "corrects" every rung to the cheapest one
    // would destroy it. Compare the rungs in the Sets view instead.
    action = "ladder";
    reasons.push("This exact set is live at " + q.ladder + " price points here — treated as a deliberate test, not corrected.");
  }
  return { price, anchor: round2(anchor), basis, confidence, evidenceN, reasons, floor, cap, clamped, action, test };
}

function curvesFor({ prepared, now, origin = "auto" }) {
  const curves = {};
  for (const m of MARKETS) curves[m] = priceCurve({ market: m, prepared, now, origin });
  return curves;
}

/**
 * Advice for every LIVE drops listing. `applicable` is true only for origin
 * "auto" rows on a market that is not blocked — everything else is advisory,
 * because manual and no-claim prices are the owner's (feedback_manual_listings_
 * never_repriced) and Digiseller is blocked.
 */
function advise({ sales, prepared, now, fees }) {
  const tr = buildTranslator(sales, now);
  const curves = curvesFor({ prepared, now });
  const ctx = { sales, now, tr, fees, curves };
  const rows = [];
  // Exact sets live at 2+ distinct prices on one market. When the owner made any
  // of those rows (origin manual / unclaimed) it is a deliberate ladder; when
  // they are all auto rows it is only drift (copies published on different days
  // at different prices), which is advice-worthy, not protected.
  const rungs = new Map();
  const handMade = new Set();
  for (const r of prepared.rows) {
    if (r.l.status !== "active" || !r.id.exact) continue;
    const k = r.market + "|" + r.id.contentKey;
    if (!rungs.has(k)) rungs.set(k, new Set());
    rungs.get(k).add(Number(r.l.price));
    if (r.l.origin !== "auto") handMade.add(k);
  }
  for (const r of prepared.rows) {
    if (r.l.status !== "active") continue;
    const set = r.l.set ? prepared.setById.get(idStr(r.l.set)) : null;
    const lk = r.market + "|" + r.id.contentKey;
    const ladderN = r.id.exact && handMade.has(lk) ? (rungs.get(lk) || new Set()).size : 0;
    const rec = recommend(ctx, {
      ladder: ladderN >= 2 ? ladderN : 0,
      market: r.market,
      id: r.id,
      currentPrice: Number(r.l.price) || 0,
      setMinUsd: set ? Number(set.minPriceUsd) || 0 : 0,
      venueMinUsd: Number(r.l.venueMinPriceUsd) || 0,
      ageDays: (now - (ts(r.l.createdAt) || now)) / DAY,
    });
    const blocked = !!(VENUES[r.market] && VENUES[r.market].blocked);
    const auto = r.l.origin === "auto";
    rows.push({
      listingId: r.listingId,
      externalId: String(r.l.externalId || ""),
      market: r.market,
      origin: r.l.origin || "manual",
      title: r.l.title,
      game: r.id.game,
      gameKey: r.id.gameKey,
      itemCount: r.id.countForBand,
      exact: r.id.exact,
      contentKey: r.id.contentKey,
      current: Number(r.l.price) || 0,
      ageDays: round2((now - (ts(r.l.createdAt) || now)) / DAY),
      // Applicable means "this is advice to CHANGE an auto row on an open market".
      // A hold, a deliberate ladder or an insufficient-evidence row is not
      // something a consumer should ever act on.
      applicable: auto && !blocked && (rec.action === "raise" || rec.action === "lower"),
      advisoryReason: blocked ? "market blocked by owner" : !auto ? "origin " + (r.l.origin || "manual") + " — owner's price" : "",
      ...rec,
      delta: rec.price > 0 ? round2(rec.price - (Number(r.l.price) || 0)) : 0,
    });
  }
  return { rows, tr, curves };
}

module.exports = {
  pricedOf,
  venueP75Of,
  globalP75Of,
  perOrder,
  isBlocked,
  snap,
  WINDOW_DAYS,
  BIN_LABELS,
  prepare,
  windowed,
  venueSummary,
  priceCurve,
  curvesFor,
  buildTranslator,
  setBoard,
  recommend,
  advise,
  evidenceFromLedger,
};
