// Market radar — the READ half: turn what the recorder stored into answers. Pure (no database,
// no network, no settings), so every number on the page is reproducible from its inputs.
//
// What it answers, per game and overall:
//   * what OTHER sellers' buyers actually paid (Gameflip sold feed, GGSel/Plati counter rises),
//     by size band, and how long a Gameflip listing took to sell;
//   * who the rivals are, what they ask, how many units they move;
//   * which of OUR live listings have a cheaper comparable rival right now.
//
// The rules it keeps (docs/MARKET-RADAR-PLAN.md):
//   * our own rows are never rivals (they are counted separately, as "ours");
//   * comparable = same market, same kind (drops vs rent-farm), half-to-double size when both
//     sides state one (marketPricing.comparableRivals — the same rule the pricer uses);
//   * a price statistic is over SALE EVENTS (a counter rise of 3 units at one price is one
//     observation of that price); units are summed separately;
//   * a rate is units over the days each market was actually OBSERVED, never an assumed window;
//   * a "live" rival is one seen recently (Gameflip 3 days, the others 7) and not gone;
//   * a rent-farm window is a different product: it is listed, labelled, but never counted as a
//     drops rival and never used in an undercut comparison (rent-farm prices are the owner's).
const { band, comparableRivals, parseAdvertisedCount, classifyKind } = require("../marketPricing");
const { radarBand, RADAR_BANDS } = require("./plan");
const { gameFromTitle, normGame } = require("../priceTracker/setIdentity");

const DAY = 86400000;
const MARKETS = ["gameflip", "ggsel", "plati"];
const FRESH_MS = { gameflip: 3 * DAY, ggsel: 7 * DAY, plati: 7 * DAY };
const PRICE_MOVE_DAYS = 7;
// Our listings the undercut check looks at: the markets whose rivals the radar can see.
const UNDERCUT_MARKETS = ["gameflip", "ggsel"];
const MIN_SAMPLES = 3;
// A weekly rate from fewer days than this is an extrapolation of a few hours: not shown.
const MIN_RATE_DAYS = 2;
// Gameflip's sold feed shows about three weeks of other sellers' sales (measured 2026-10-02: the
// oldest sold row of a busy game was 20 days old), so the first scan of a game has already
// watched those weeks: a rate counts them, or two sales on day one would read as 7 a week.
const GAMEFLIP_FEED_REACH_DAYS = 21;
// A game whose market was not re-read for this long shows rival counts that are out of date.
const STALE_SCAN_DAYS = 3;
const SMALL_BANDS = ["1", "2-3", "4-6", "7-12"];
const BIG_BANDS = ["31-99", "100+"];

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const ms = (d) => (d ? new Date(d).getTime() : NaN);

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isFresh(r, now) {
  if (!r || r.goneAt) return false;
  const win = FRESH_MS[r.market] || 7 * DAY;
  return ms(r.lastSeenAt) >= now - win;
}

// What the page shows for a seller. GGSel / Plati publish shop names; Gameflip only an opaque
// owner id, shown shortened. Never more than the public page itself shows.
function sellerLabel(market, seller, sellerName) {
  if (sellerName) return String(sellerName).slice(0, 40);
  const s = String(seller || "");
  if (!s) return "unknown";
  return market === "gameflip" ? "seller …" + s.slice(-6) : s.slice(0, 40);
}

// The public page of a listing, so the owner can click through to exactly what was counted.
function listingUrl(market, listingId) {
  const id = encodeURIComponent(String(listingId || ""));
  if (!id) return "";
  if (market === "gameflip") return "https://gameflip.com/item/" + id;
  if (market === "ggsel") return "https://ggsel.net/en/catalog/product/" + id;
  if (market === "plati") return "https://plati.market/itm/" + id;
  return "";
}

function priceStats(prices) {
  const b = band(prices);
  if (!b.n) return { n: 0 };
  return { n: b.n, min: round2(b.min), p25: round2(b.p25), median: round2(b.median), p75: round2(b.p75), max: round2(b.max) };
}

function newMarketAgg() {
  return { events: [], units: 0, oursUnits: 0, oursEvents: 0, live: [], ourLive: 0, farmLive: 0, firstObserved: Infinity, liveSellers: new Set() };
}

function newSellerAgg(market, seller, sellerName) {
  return { market, seller: seller || "", label: sellerLabel(market, seller, sellerName), units: 0, orders: 0, revenue: 0, prices: [], games: new Set(), score: null, ratings: null, live: 0 };
}

/**
 * @param input {
 *   sales:   MarketSale-like docs (already limited to the loader's horizon),
 *   rivals:  MarketRival-like docs,
 *   ownListings: our active MarketplaceListing rows { marketplace, externalId, title, price, origin },
 *   research: [{ game, scannedAt }],
 * }
 * @param opts { now, windowDays }
 */
function buildMarketReport(input, { now = Date.now(), windowDays = 30 } = {}) {
  const sales = (input && input.sales) || [];
  const rivals = (input && input.rivals) || [];
  const ownListings = (input && input.ownListings) || [];
  const research = (input && input.research) || [];
  const since = now - windowDays * DAY;

  const games = new Map(); // gameKey -> agg
  const gameOf = (key, name) => {
    let g = games.get(key);
    if (!g) {
      g = { key, game: name || key, markets: Object.fromEntries(MARKETS.map((m) => [m, newMarketAgg()])), farmEvents: 0 };
      games.set(key, g);
    }
    if (name && g.game === key) g.game = name;
    return g;
  };
  const sellers = new Map(); // market:seller -> agg
  const sellerOf = (market, seller, sellerName) => {
    const k = market + ":" + (seller || "?");
    let s = sellers.get(k);
    if (!s) {
      s = newSellerAgg(market, seller, sellerName);
      sellers.set(k, s);
    }
    return s;
  };

  let firstRecord = Infinity;
  let lastRecord = -Infinity;

  // ---- sales in the window ----
  const feed = [];
  for (const s of sales) {
    const fs = ms(s.firstSeenAt);
    if (Number.isFinite(fs)) {
      if (fs < firstRecord) firstRecord = fs;
      if (fs > lastRecord) lastRecord = fs;
    }
    const at = ms(s.soldAt);
    if (!(at >= since) || !MARKETS.includes(s.market)) continue;
    const g = gameOf(s.gameKey, s.game);
    const m = g.markets[s.market];
    // When this market was first watched for this game: a counter sale's window start, else the
    // sale's own date — and on Gameflip the feed's reach before the scan that first recorded it.
    let start = Number.isFinite(ms(s.prevObservedAt)) ? ms(s.prevObservedAt) : at;
    if (s.market === "gameflip" && Number.isFinite(fs)) start = Math.min(start, fs - GAMEFLIP_FEED_REACH_DAYS * DAY);
    if (start < m.firstObserved) m.firstObserved = start;
    const units = Math.max(1, Number(s.units) || 1);
    const kind = s.kind || classifyKind(s.title);
    feed.push({
      market: s.market,
      game: g.game,
      gameKey: s.gameKey,
      title: s.title,
      priceUsd: s.priceUsd,
      units,
      itemCount: s.itemCount == null ? null : s.itemCount,
      band: radarBand(s.itemCount),
      kind,
      soldAt: s.soldAt,
      ttsHours: s.ttsHours == null ? null : s.ttsHours,
      source: s.source,
      seller: sellerLabel(s.market, s.seller, s.sellerName),
      ours: !!s.ours,
    });
    if (kind === "farm") {
      g.farmEvents++;
      continue;
    }
    if (s.ours) {
      m.oursEvents++;
      m.oursUnits += units;
      continue;
    }
    const price = Number(s.priceUsd) || 0;
    m.events.push({ priceUsd: price, units, ttsHours: s.ttsHours == null ? null : s.ttsHours, itemCount: s.itemCount == null ? null : s.itemCount });
    m.units += units;
    const sa = sellerOf(s.market, s.seller, s.sellerName);
    sa.units += units;
    sa.orders++;
    sa.revenue += units * price;
    sa.prices.push(price);
    sa.games.add(s.gameKey);
    if (s.sellerScore != null) sa.score = s.sellerScore;
    if (s.sellerRatings != null) sa.ratings = s.sellerRatings;
  }

  // ---- rivals ----
  const liveRivalsByGameMarket = new Map(); // gameKey|market -> fresh non-ours rival rows
  const liveByGame = new Map(); // gameKey -> public rows of every live listing (ours flagged), for the detail view
  const ourShown = new Map(); // market:listingId -> our own listing's price as the public page shows it now
  const priceMoves = [];
  for (const r of rivals) {
    const f = ms(r.firstSeenAt);
    const l = ms(r.lastSeenAt);
    if (Number.isFinite(f) && f < firstRecord) firstRecord = f;
    if (Number.isFinite(l) && l > lastRecord) lastRecord = l;
    if (!MARKETS.includes(r.market)) continue;
    const g = gameOf(r.gameKey, r.game);
    const m = g.markets[r.market];
    // The scan that first saw a Gameflip rival also read the sold feed, which reaches back weeks.
    const watchedFrom = r.market === "gameflip" && Number.isFinite(f) ? f - GAMEFLIP_FEED_REACH_DAYS * DAY : f;
    if (Number.isFinite(watchedFrom) && watchedFrom < m.firstObserved) m.firstObserved = watchedFrom;
    if (!isFresh(r, now)) continue;
    if (!liveByGame.has(r.gameKey)) liveByGame.set(r.gameKey, []);
    liveByGame.get(r.gameKey).push({
      market: r.market,
      title: String(r.title || "").slice(0, 140),
      priceUsd: r.priceUsd,
      itemCount: r.itemCount == null ? null : r.itemCount,
      band: radarBand(r.itemCount),
      kind: r.kind || "drops",
      seller: sellerLabel(r.market, r.seller, r.sellerName),
      score: r.sellerScore == null ? null : r.sellerScore,
      ratings: r.sellerRatings == null ? null : r.sellerRatings,
      counter: r.counter == null ? null : r.counter,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      ours: !!r.ours,
      url: listingUrl(r.market, r.listingId),
    });
    if (r.ours) {
      m.ourLive++;
      ourShown.set(r.market + ":" + String(r.listingId), Number(r.priceUsd) || 0);
      continue;
    }
    if ((r.kind || classifyKind(r.title)) === "farm") {
      m.farmLive++;
      continue;
    }
    m.live.push(r);
    if (r.seller) m.liveSellers.add(r.seller);
    const k = r.gameKey + "|" + r.market;
    if (!liveRivalsByGameMarket.has(k)) liveRivalsByGameMarket.set(k, []);
    liveRivalsByGameMarket.get(k).push(r);
    const sa = sellerOf(r.market, r.seller, r.sellerName);
    sa.live++;
    sa.games.add(r.gameKey);
    if (sa.score == null && r.sellerScore != null) sa.score = r.sellerScore;
    if (sa.ratings == null && r.sellerRatings != null) sa.ratings = r.sellerRatings;
    const h = Array.isArray(r.priceHistory) ? r.priceHistory : [];
    if (h.length >= 2) {
      const last = h[h.length - 1];
      const prev = h[h.length - 2];
      // A seller's move, not the exchange rate: roubles compared in roubles; a USD-only point on a
      // rouble market needs a move larger than an FX wobble.
      const native = last.native != null && prev.native != null;
      const moved = native
        ? Math.abs(last.native - prev.native) >= 0.5
        : Math.abs(last.price - prev.price) >= 0.01 && (r.market === "gameflip" || Math.abs(last.price - prev.price) / (prev.price || 1) >= 0.03);
      if (ms(last.at) >= now - PRICE_MOVE_DAYS * DAY && moved) {
        const cut = native ? last.native < prev.native : last.price < prev.price;
        priceMoves.push({ market: r.market, gameKey: r.gameKey, game: g.game, title: r.title, seller: sellerLabel(r.market, r.seller, r.sellerName), from: prev.price, to: last.price, fromNative: native ? prev.native : null, toNative: native ? last.native : null, cut, at: last.at, itemCount: r.itemCount == null ? null : r.itemCount });
      }
    }
  }

  // ---- our listings vs live rivals: undercuts ----
  const undercuts = [];
  const undercutByGame = new Map();
  const ownByGame = new Map(); // gameKey -> our live listings on the markets the radar sees
  for (const l of ownListings) {
    const market = String(l.marketplace || "");
    if (!UNDERCUT_MARKETS.includes(market)) continue;
    const gname = gameFromTitle(l.title);
    if (!gname) continue;
    const gameKey = normGame(gname);
    ownByGame.set(gameKey, (ownByGame.get(gameKey) || 0) + 1);
    // A bulk pack is priced per PACK and a rent-farm window by its own rules: neither compares
    // with a single bundle.
    if (l.bulkOfferId || l.rentFarm) continue;
    const kind = classifyKind(l.title);
    if (kind === "farm") continue;
    // Our price as the market shows it now when the radar saw our listing (GGSel converts our
    // rouble price at today's rate, exactly as it does the rivals'), else our stored price.
    const shown = ourShown.get(market + ":" + String(l.externalId));
    const ourPrice = shown > 0 ? shown : Number(l.price) || 0;
    if (!(ourPrice > 0)) continue;
    const live = liveRivalsByGameMarket.get(gameKey + "|" + market) || [];
    if (!live.length) continue;
    const itemCount = parseAdvertisedCount(l.title);
    const pool = comparableRivals(
      live.map((r) => ({ price: r.priceUsd, title: r.title, seller: r.seller, sellerName: r.sellerName })),
      { ownerId: "", kind, itemCount },
    );
    if (!pool.length) continue;
    const cheaper = pool.filter((r) => r.price < ourPrice - 0.005).sort((a, b) => a.price - b.price);
    if (!cheaper.length) continue;
    const g = games.get(gameKey);
    const sameBand = (e) => itemCount == null || e.itemCount == null || (e.itemCount >= itemCount / 2 && e.itemCount <= itemCount * 2);
    const sold = g ? g.markets[market].events.filter(sameBand) : [];
    undercuts.push({
      market,
      externalId: l.externalId,
      title: String(l.title || "").slice(0, 140),
      origin: l.origin || "",
      kind,
      itemCount,
      ourPrice: round2(ourPrice),
      ourPriceBasis: shown > 0 ? "as the market shows it" : "our stored price",
      comparable: pool.length,
      cheaper: cheaper.length,
      cheapest: { price: round2(cheaper[0].price), seller: sellerLabel(market, cheaper[0].seller, cheaper[0].sellerName), title: String(cheaper[0].title || "").slice(0, 100) },
      rivalMedian: round2(median(pool.map((r) => r.price))),
      gapPct: round1(((ourPrice - cheaper[0].price) / ourPrice) * 100),
      // What rivals' buyers paid for this size here — the number that says whether "cheaper" matters.
      soldMedian: sold.length >= MIN_SAMPLES ? round2(median(sold.map((e) => e.priceUsd))) : null,
      soldN: sold.length,
      game: g ? g.game : gname,
      gameKey,
    });
    undercutByGame.set(gameKey, (undercutByGame.get(gameKey) || 0) + 1);
  }
  undercuts.sort((a, b) => b.gapPct - a.gapPct || b.cheaper - a.cheaper);

  // ---- per-game rows ----
  const researchByKey = new Map(research.map((r) => [normGame(r.game), r]));
  const rows = [];
  for (const g of games.values()) {
    const byMarket = {};
    let units = 0;
    let orders = 0;
    let perWeek = 0;
    let ratePartial = false;
    let oursSold = 0;
    const allEvents = [];
    for (const mk of MARKETS) {
      const m = g.markets[mk];
      units += m.units;
      orders += m.events.length;
      oursSold += m.oursUnits;
      allEvents.push(...m.events);
      // A rate needs the days this market was actually watched (at most the window), and at
      // least MIN_RATE_DAYS of them: a few hours of counter rises are not a weekly rate.
      const watched = Number.isFinite(m.firstObserved) ? Math.min(windowDays, (now - m.firstObserved) / DAY) : null;
      const observedDays = watched == null ? null : Math.max(0, watched);
      const rated = observedDays != null && observedDays >= MIN_RATE_DAYS;
      const pw = rated ? (m.units / observedDays) * 7 : null;
      if (pw != null) perWeek += pw;
      else if (m.units > 0) ratePartial = true;
      const tts = m.events.map((e) => e.ttsHours).filter((h) => h != null);
      const asking = m.live.map((r) => r.priceUsd);
      byMarket[mk] = {
        units: m.units,
        orders: m.events.length,
        perWeek: pw == null ? null : round1(pw),
        observedDays: observedDays == null ? null : round1(observedDays),
        sold: priceStats(m.events.map((e) => e.priceUsd)),
        medianTtsHours: tts.length ? round1(median(tts)) : null,
        live: m.live.length,
        liveSellers: m.liveSellers.size,
        farmLive: m.farmLive,
        asking: priceStats(asking),
        oursLive: m.ourLive,
        oursSold: m.oursUnits,
      };
    }
    const tts = allEvents.map((e) => e.ttsHours).filter((h) => h != null);
    // Size bands: what each size of product sells for (all three markets' sale events).
    const bands = [];
    for (const b of [...RADAR_BANDS.map((x) => x.name), "?"]) {
      const ev = allEvents.filter((e) => radarBand(e.itemCount) === b);
      if (!ev.length) continue;
      const bt = ev.map((e) => e.ttsHours).filter((h) => h != null);
      bands.push({ band: b, ...priceStats(ev.map((e) => e.priceUsd)), units: ev.reduce((a, e) => a + e.units, 0), medianTtsHours: bt.length ? round1(median(bt)) : null });
    }
    const gf = g.markets.gameflip;
    const gfAll = gf.units + gf.oursUnits;
    const flags = [];
    const smallEv = allEvents.filter((e) => SMALL_BANDS.includes(radarBand(e.itemCount)));
    const bigEv = allEvents.filter((e) => BIG_BANDS.includes(radarBand(e.itemCount)));
    const smallMedian = smallEv.length >= MIN_SAMPLES ? median(smallEv.map((e) => e.priceUsd)) : null;
    if (bigEv.length >= MIN_SAMPLES) {
      const bigMedian = median(bigEv.map((e) => e.priceUsd));
      if ((smallMedian != null && bigMedian >= 2 * smallMedian) || (smallMedian == null && bigMedian >= 4)) {
        flags.push({ id: "collector-niche", text: "Big collections (31+ items) sell for $" + round2(bigMedian) + " (" + bigEv.length + " sales)" + (smallMedian != null ? " vs $" + round2(smallMedian) + " for small bundles" : "") });
      }
    }
    if (tts.length >= MIN_SAMPLES) {
      const mt = median(tts);
      if (mt <= 24) flags.push({ id: "fast", text: "Rivals' listings that sold took about " + round1(mt) + " h" });
      else if (mt >= 24 * 7) flags.push({ id: "slow", text: "Rivals' listings that sold took about " + round1(mt / 24) + " days" });
    }
    const liveSellers = new Set();
    for (const mk of MARKETS) for (const s of g.markets[mk].liveSellers) liveSellers.add(mk + ":" + s);
    if (liveSellers.size >= 8) flags.push({ id: "crowded", text: liveSellers.size + " rival sellers live" });
    const ourLive = MARKETS.reduce((a, mk) => a + g.markets[mk].ourLive, 0);
    const rivalLive = MARKETS.reduce((a, mk) => a + g.markets[mk].live.length, 0);
    if (ourLive > 0 && rivalLive === 0) flags.push({ id: "alone", text: "No live rival listing seen" });
    const oursListed = ownByGame.get(g.key) || 0;
    if (oursListed === 0 && units >= 5) flags.push({ id: "not-selling", text: units + " units sold by rivals in " + windowDays + " days; we have no live listing on Gameflip or GGSel" });
    const uc = undercutByGame.get(g.key) || 0;
    if (uc) flags.push({ id: "undercut", text: uc + " of our listing(s) have a cheaper comparable rival" });
    const cuts = priceMoves.filter((p) => p.gameKey === g.key && p.cut).length;
    if (cuts >= MIN_SAMPLES) flags.push({ id: "price-war", text: cuts + " rival price cuts in " + PRICE_MOVE_DAYS + " days" });
    const rs = researchByKey.get(g.key);
    const readDaysAgo = rs && Number.isFinite(ms(rs.scannedAt)) ? (now - ms(rs.scannedAt)) / DAY : null;
    if (readDaysAgo != null && readDaysAgo > STALE_SCAN_DAYS) flags.push({ id: "stale-scan", text: "This market was last read " + round1(readDaysAgo) + " days ago: live listing counts are out of date" });
    rows.push({
      key: g.key,
      game: g.game,
      units,
      orders,
      // null while every market with sales is still too new to rate; ratePartial = a market with
      // sales was left out because it has not been watched for MIN_RATE_DAYS yet
      perWeek: perWeek > 0 || !ratePartial ? round1(perWeek) : null,
      ratePartial,
      realised: priceStats(allEvents.map((e) => e.priceUsd)),
      medianTtsHours: tts.length ? round1(median(tts)) : null,
      bands,
      byMarket,
      rivalsLive: rivalLive,
      rivalSellers: liveSellers.size,
      oursLive: ourLive,
      oursListed,
      oursSold,
      gameflipShare: gfAll > 0 ? round1((gf.oursUnits / gfAll) * 100) : null,
      undercut: uc,
      farmSales: g.farmEvents,
      researchScannedAt: rs ? rs.scannedAt || null : null,
      flags,
    });
  }
  rows.sort((a, b) => b.units - a.units || b.rivalsLive - a.rivalsLive || String(a.game).localeCompare(String(b.game)));

  // ---- sellers (anyone with a sale in the window or a live listing) ----
  const sellerRows = [...sellers.values()]
    .map((s) => ({
      market: s.market,
      label: s.label,
      units: s.units,
      orders: s.orders,
      revenueUsd: round2(s.revenue),
      medianPrice: s.prices.length ? round2(median(s.prices)) : null,
      games: s.games.size,
      live: s.live,
      score: s.score,
      ratings: s.ratings,
    }))
    .sort((a, b) => b.units - a.units || b.revenueUsd - a.revenueUsd || b.live - a.live);

  // ---- overview ----
  const markets = {};
  for (const mk of MARKETS) {
    const prices = [];
    const tts = [];
    let unitsM = 0;
    let ordersM = 0;
    let liveM = 0;
    let oursLiveM = 0;
    let oursUnitsM = 0;
    const sellersM = new Set();
    for (const g of games.values()) {
      const m = g.markets[mk];
      for (const e of m.events) {
        prices.push(e.priceUsd);
        if (e.ttsHours != null) tts.push(e.ttsHours);
      }
      unitsM += m.units;
      ordersM += m.events.length;
      liveM += m.live.length;
      oursLiveM += m.ourLive;
      oursUnitsM += m.oursUnits;
      for (const s of m.liveSellers) sellersM.add(s);
    }
    markets[mk] = {
      units: unitsM,
      orders: ordersM,
      sold: priceStats(prices),
      medianTtsHours: tts.length ? round1(median(tts)) : null,
      liveRivals: liveM,
      liveSellers: sellersM.size,
      oursLive: oursLiveM,
      oursSold: oursUnitsM,
    };
  }
  let fresh24 = 0;
  for (const r of research) if (ms(r.scannedAt) >= now - DAY) fresh24++;
  const coverage = {
    gamesWithData: games.size,
    researchGames: research.length,
    researchFresh24h: fresh24,
    salesStored: sales.length,
    rivalsStored: rivals.length,
    firstRecordAt: Number.isFinite(firstRecord) ? new Date(firstRecord) : null,
    lastRecordAt: Number.isFinite(lastRecord) ? new Date(lastRecord) : null,
  };

  feed.sort((a, b) => ms(b.soldAt) - ms(a.soldAt));
  priceMoves.sort((a, b) => ms(b.at) - ms(a.at));
  for (const list of liveByGame.values()) list.sort((a, b) => a.market.localeCompare(b.market) || a.priceUsd - b.priceUsd);
  return { generatedAt: new Date(now), windowDays, coverage, markets, games: rows, sellers: sellerRows, undercuts, feed, priceMoves, liveByGame };
}

module.exports = { buildMarketReport, sellerLabel, listingUrl, isFresh, median, priceStats, FRESH_MS, UNDERCUT_MARKETS, MIN_SAMPLES, MIN_RATE_DAYS, GAMEFLIP_FEED_REACH_DAYS, STALE_SCAN_DAYS };
