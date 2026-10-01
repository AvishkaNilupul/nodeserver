// The sale ledger: ONE list of every sale we can prove, each tied to the exact
// listing, the exact items and (where the platform gives one) the exact order.
//
// Why this exists. Before it, "what did we sell this for?" was answered by four
// separate readers that each re-derived it a little differently and each had
// shipped a bug of its own: utils/pricingEvidence.js (double counted Gameflip
// sales, 284 prices for 147 sales; rent-farm windows set a $16 ceiling; Eldorado
// invisible), utils/systemHealth.js `realisedSales`, the catalog's own signal
// read, and routes/marketplaceConsoleRoutes.js (revenue = delivered units x the
// listing's CURRENT price). This module is the single definition they can all
// read from. It is pure — rows in, records out — so it is tested without a DB and
// can be fed a snapshot.
//
// EVIDENCE SOURCES, strongest first (each record says which it came from):
//   unit     a delivered unit with a real order id (Eldorado / PlayerAuctions /
//            G2G). Price is the listing's price NOW, because nothing stamps the
//            price at delivery — `priceBasis: "listing-now"`, an honest
//            approximation, never presented as the sale price.
//   signal   a "listing_sold" SaleSignal written when the platform told us a
//            unit was bought (Gameflip poller, Plati/GGSel stock drops). The
//            price was recorded at the moment of sale — `priceBasis: "reported"`.
//   row      a MarketplaceListing marked "sold" that neither of the above
//            already explains. `priceBasis: "row"`.
//   hand     the operator's manual mark-sold. Usually no marketplace and no
//            price; it proves demand for a GAME, never a price for a listing.
//
// DEDUPE RULES (each one is a bug that already happened — see
// project_pricing_evidence_sources_1001):
//   * every writer of a priced signal writes ONE PER GAME at the full price, so a
//     3-game bundle would count three times. Signals collapse to one record per
//     (listing, seq).
//   * a signal or a sold row for a listing whose sale is already counted from its
//     delivered units does not count again.
//   * rent-farm windows, bulk packs and anything classified "farm" are a
//     DIFFERENT PRODUCT and are excluded (counted in `excluded`, never silently).
//   * MASS-CLOSE signals are not sales. The Listings delist route records a
//     "listing_sold" signal for stock it closes out, so wiping a market writes
//     one signal per remaining unit. Measured 2026-10-01: 182 of GGSel's 204
//     priced "sales" were written in one 34-minute window on 2026-09-28 (60
//     offers, ~3 units each, every listing delisted within seconds of its
//     signals) and 35 of Digiseller's 63 in one 3-minute window on 2026-08-16.
//     A signal is a mass-close when its listing was DELISTED within 90s of it AND
//     at least 8 such signals share that market and hour. Both conditions: a
//     single sale on a listing that is delisted soon after must still count.
//     They are returned in `suspect`, never silently dropped, and they never
//     enter a price.
const { identify } = require("./setIdentity");

// Marketplaces whose sales exist only as delivered units on the listing row.
const UNIT_LEDGER_MARKETS = ["eldorado", "playerauctions", "g2g"];

function ts(d) {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function idStr(x) {
  return x == null ? "" : String(x).toLowerCase();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} input
 * @param {Array}  input.listings MarketplaceListing rows (lean, projected)
 * @param {Array}  input.signals  SaleSignal rows with source "listing_sold"
 * @param {Array}  input.sets     DropSet rows referenced by the listings
 * @returns {{ sales: object[], excluded: object, quality: object }}
 */
function buildLedger({ listings = [], signals = [], sets = [] } = {}) {
  const setById = new Map(sets.map((s) => [idStr(s._id), s]));
  const listingById = new Map(listings.map((l) => [idStr(l._id), l]));
  const identCache = new Map();
  const identOf = (l) => {
    const k = idStr(l._id);
    if (!identCache.has(k)) identCache.set(k, identify(l, l.set ? setById.get(idStr(l.set)) : null));
    return identCache.get(k);
  };

  const sales = [];
  const excluded = { farm: 0, bulk: 0, noListing: 0, unpricedSignal: 0, duplicate: 0, massClose: 0 };
  const suspect = [];

  // Pre-pass: which sold:<listing> signals look like a delist closing out stock?
  const nearDelist = new Map(); // dedupeKey -> hourBucket "market|ISOhour"
  const hourCount = new Map();
  for (const s of signals) {
    const m = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(String(s.dedupeKey || ""));
    if (!m) continue;
    const l = listingById.get(m[1].toLowerCase());
    if (!l || l.status !== "delisted") continue;
    const at = ts(s.at);
    const up = ts(l.updatedAt);
    if (at == null || up == null || Math.abs(up - at) > 90 * 1000) continue;
    const bucket = String(s.marketplace || l.marketplace || "").toLowerCase() + "|" + new Date(at).toISOString().slice(0, 13);
    nearDelist.set(String(s.dedupeKey), bucket);
    hourCount.set(bucket, (hourCount.get(bucket) || 0) + 1);
  }
  const countedByUnits = new Set(); // listing ids whose sales are their units

  const base = (l, ident) => ({
    market: String(l.marketplace || "").toLowerCase(),
    listingId: idStr(l._id),
    externalId: String(l.externalId || ""),
    origin: l.origin || "manual",
    title: String(l.title || ""),
    listedPrice: Number(l.price) || 0,
    listedAt: l.createdAt || null,
    game: ident.game,
    gameKey: ident.gameKey,
    contentKey: ident.contentKey,
    bandKey: ident.bandKey,
    itemCount: ident.countForBand,
    exact: ident.exact,
    titleMismatch: ident.titleMismatch,
    identBasis: ident.basis,
  });

  // 1. delivered units ------------------------------------------------------
  for (const l of listings) {
    if (!UNIT_LEDGER_MARKETS.includes(String(l.marketplace || "").toLowerCase())) continue;
    const delivered = (l.units || []).filter((u) => u && u.orderId && u.deliveredAt);
    if (!delivered.length) continue;
    countedByUnits.add(idStr(l._id));
    const ident = identOf(l);
    if (ident.kind !== "drops") {
      excluded[ident.kind === "bulk" ? "bulk" : "farm"] += delivered.length;
      continue;
    }
    const price = Number(l.price) || 0;
    let unitIdx = 0;
    for (const u of delivered) {
      sales.push({
        ...base(l, ident),
        // One buyer order can deliver several units (Eldorado: 270 units across
        // 168 orders, one order carried 10). Each unit is its own record (it is
        // its own account and its own revenue), so the key carries the unit
        // index; `saleGroup` names the ORDER, which is what counts as one piece
        // of price evidence.
        key: "unit:" + idStr(l._id) + ":" + String(u.orderId) + ":" + unitIdx++,
        saleGroup: String(l.marketplace || "").toLowerCase() + ":order:" + String(u.orderId),
        source: "unit",
        confidence: "exact",
        orderId: String(u.orderId),
        at: new Date(u.deliveredAt),
        priceUsd: price,
        priceBasis: "listing-now",
        priced: price > 0,
      });
    }
  }

  // 2. sale signals ---------------------------------------------------------
  // dedupeKey shapes: sold:<listingId>:<gameKey>:<seq>, reserved:<accountId>:
  // <setId>:<game>, manual-sold:<accountId>:<game>.
  const seen = new Set();
  const ordered = [...signals].sort((a, b) => (ts(a.at) || 0) - (ts(b.at) || 0));
  for (const s of ordered) {
    const dk = String(s.dedupeKey || "");
    const unit = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(dk);
    const hand = /^manual-sold:([0-9a-f]{24}):/i.exec(dk);
    const shop = /^reserved:([0-9a-f]{24}):/i.exec(dk);
    const price = Number(s.priceUsd) || 0;

    if (unit) {
      const lid = unit[1].toLowerCase();
      const key = "sig:" + lid + ":" + unit[2];
      if (seen.has(key)) {
        excluded.duplicate += 1; // the same sale, written once per game
        continue;
      }
      seen.add(key);
      if (countedByUnits.has(lid)) {
        excluded.duplicate += 1;
        continue;
      }
      const l = listingById.get(lid);
      if (!l) {
        excluded.noListing += 1;
        continue;
      }
      const nb = nearDelist.get(dk);
      if (nb && hourCount.get(nb) >= 8) {
        excluded.massClose += 1;
        suspect.push({ key, market: nb.split("|")[0], at: new Date(s.at), priceUsd: price, listingId: lid, reason: "mass-close" });
        continue;
      }
      const ident = identOf(l);
      if (s.bulk || ident.kind === "bulk") {
        excluded.bulk += 1;
        continue;
      }
      if (ident.kind === "farm") {
        excluded.farm += 1;
        continue;
      }
      if (price <= 0) excluded.unpricedSignal += 1;
      sales.push({
        ...base(l, ident),
        // The signal's market wins if the row ever disagrees: it is what the
        // platform reported at the time.
        market: String(s.marketplace || l.marketplace || "").toLowerCase(),
        key,
        saleGroup: key,
        source: "signal",
        confidence: "exact",
        orderId: "",
        seq: Number(unit[2]),
        at: new Date(s.at),
        priceUsd: price,
        priceBasis: "reported",
        priced: price > 0,
      });
      continue;
    }

    if (hand || (shop && price > 0 && s.marketplace !== "bulk" && !s.bulk)) {
      // The GAME is part of the key: one account sold in two games is two sales
      // of two things (the 39 "duplicates" first measured were all this).
      const key = (hand ? "hand:" : "shop:") + (hand || shop)[1].toLowerCase() + ":" + String(s.gameKey || "").toLowerCase();
      if (seen.has(key)) {
        excluded.duplicate += 1;
        continue;
      }
      seen.add(key);
      const gk = String(s.gameKey || "").toLowerCase();
      sales.push({
        key,
        saleGroup: key,
        source: hand ? "hand" : "shop",
        confidence: "hand",
        market: String(s.marketplace || "").toLowerCase() || "unknown",
        listingId: "",
        externalId: "",
        origin: "manual",
        title: String(s.name || ""),
        listedPrice: 0,
        listedAt: null,
        game: String(s.game || ""),
        gameKey: gk,
        contentKey: null,
        bandKey: gk + "|?",
        itemCount: null,
        exact: false,
        titleMismatch: false,
        identBasis: "none",
        orderId: "",
        at: new Date(s.at),
        priceUsd: price,
        priceBasis: price > 0 ? "reported" : "none",
        priced: price > 0,
      });
    }
  }

  // 3. rows marked sold that nothing above explains -------------------------
  const signalListings = new Set(
    sales.filter((x) => x.source === "signal").map((x) => x.listingId),
  );
  for (const l of listings) {
    if (l.status !== "sold") continue;
    const id = idStr(l._id);
    if (countedByUnits.has(id) || signalListings.has(id)) continue;
    const ident = identOf(l);
    if (ident.kind !== "drops") {
      excluded[ident.kind === "bulk" ? "bulk" : "farm"] += 1;
      continue;
    }
    const price = Number(l.price) || 0;
    sales.push({
      ...base(l, ident),
      key: "row:" + id,
      saleGroup: "row:" + id,
      source: "row",
      confidence: "exact",
      orderId: "",
      at: new Date(l.updatedAt || l.createdAt || 0),
      priceUsd: price,
      priceBasis: "row",
      priced: price > 0,
    });
  }

  sales.sort((a, b) => a.at - b.at);

  // BURSTS on timestamps alone. The delist rule above needs the listing's
  // updatedAt to sit within 90s of the signal, and any later write to the row
  // defeats it: 35 Digiseller signals written in 3 minutes on 2026-08-16 slipped
  // through because every listing was touched again afterwards, and 25 Gameflip
  // signals written ~1 second apart on 2026-09-08 were a bulk mark-sold, not 25
  // purchases. Organic sales do not arrive 8 in 5 minutes on any market this shop
  // sells on, and a burst proves the DETECTION happened at once, not the sales —
  // so for PRICE evidence it is set aside. (Delivered units carry real order ids
  // and are exempt.)
  {
    const BURST_N = 8;
    const BURST_MS = 5 * 60 * 1000;
    const byMarket = new Map();
    for (const x of sales) {
      if (x.source !== "signal" && x.source !== "row") continue;
      if (!byMarket.has(x.market)) byMarket.set(x.market, []);
      byMarket.get(x.market).push(x);
    }
    const flagged = new Set();
    for (const arr of byMarket.values()) {
      arr.sort((a, b) => a.at - b.at);
      let j = 0;
      for (let i = 0; i < arr.length; i += 1) {
        while (arr[i].at - arr[j].at > BURST_MS) j += 1;
        if (i - j + 1 >= BURST_N) for (let k = j; k <= i; k += 1) flagged.add(arr[k]);
      }
    }
    if (flagged.size) {
      for (const x of flagged) {
        suspect.push({ key: x.key, market: x.market, at: x.at, priceUsd: x.priceUsd, listingId: x.listingId, reason: "burst" });
        excluded.massClose += 1;
      }
      for (let i = sales.length - 1; i >= 0; i -= 1) if (flagged.has(sales[i])) sales.splice(i, 1);
    }
  }

  // Data-quality counters, shown on the page so a gap is visible, not silent.
  const unitsSoldByListing = new Map();
  for (const l of listings) {
    if (Number(l.unitsSold) > 0) unitsSoldByListing.set(idStr(l._id), Number(l.unitsSold));
  }
  const signalCount = new Map();
  for (const x of sales) if (x.source === "signal") signalCount.set(x.listingId, (signalCount.get(x.listingId) || 0) + 1);
  // Mass-close signals are set aside, but the listing's unitsSold counter still
  // includes them — they are accounted for, not "unattributed".
  for (const x of suspect) signalCount.set(x.listingId, (signalCount.get(x.listingId) || 0) + 1);
  let unattributedUnits = 0;
  for (const [id, n] of unitsSoldByListing) {
    const have = signalCount.get(id) || 0;
    if (n > have) unattributedUnits += n - have;
  }
  const quality = {
    total: sales.length,
    priced: sales.filter((x) => x.priced).length,
    byConfidence: sales.reduce((m, x) => ((m[x.confidence] = (m[x.confidence] || 0) + 1), m), {}),
    bySource: sales.reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {}),
    // Units a listing says it sold with no priced signal behind them: real sales
    // whose price we do not know.
    unattributedUnits,
    titleMismatch: sales.filter((x) => x.titleMismatch).length,
    // Distinct buyer orders among delivered units (a unit is one account; an
    // order may carry several).
    orders: new Set(sales.map((x) => x.saleGroup)).size,
    suspectMassClose: suspect.length,
  };

  return { sales, excluded, quality, suspect };
}

module.exports = { UNIT_LEDGER_MARKETS, buildLedger, round2 };
