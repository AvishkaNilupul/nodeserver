// Market radar — the PURE half: turn the rows one research scan already fetched into the
// write operations that keep a persistent picture of the market. No database, no network, no
// settings: everything here is a function of (rows, what is already stored, what is ours), so
// each rule can be pinned by a test.
//
// Three public markets are read, each differently (see docs/MARKET-RADAR-PLAN.md):
//
//   gameflip  Dated sales. The sold feed lists other sellers' sold listings with their
//             `onsale` and `updated` stamps, so a sale has a price, a size, a seller AND a
//             time-to-sell. The on-sale feed lists live rivals.
//   ggsel     Undated lifetime counters (`cnt_sell`). A rise above the highest value ever seen is
//   plati     real units sold in the window since the last observation (`numsold` on Plati).
//             Both price in roubles: the USD price moves with the exchange rate every day, so a
//             seller's price move is judged on the ROUBLE price the seller actually set.
//
// The rules below are each a live-market rule or a past mistake:
//   - OUR rows are flagged, never counted as rivals (the scanner once undercut itself). On
//     Gameflip that needs our owner id, which a throttled moment can fail to return: the last
//     known one is kept, our own listing ids count too, and with neither nothing is recorded.
//   - A counter is a counter: the first sight only sets the baseline; only a rise above the
//     HIGHEST value ever seen (or already recorded as sold) is a sale; a dip and its return are
//     not; an implausible jump is ignored; an unreadable counter is skipped, never read as 0.
//   - Absence is not proof of sale: `goneAt` needs a COMPLETE, non-empty result page and two misses
//     in a row, only for that page's own game, and only Gameflip's on-sale feed can say it.
//   - A listing keeps the game that first saw it (overlapping names must not flip it around).
//   - Every history array is bounded.
const { classifyKind, parseAdvertisedCount } = require("../marketPricing");
const { normGame } = require("../priceTracker/setIdentity");

const MARKETS = ["gameflip", "ggsel", "plati"];
const COUNTER_MARKETS = ["ggsel", "plati"];
// A counter may move by at most this many units between two observations before the move is
// treated as a relist / merge / data glitch rather than sales.
const MAX_COUNTER_JUMP = 200;
const MISSES_TO_GONE = 2;
const PRICE_HISTORY_MAX = 15;
const COUNTER_HISTORY_MAX = 20;
const MAX_TITLE = 200;
const MAX_TTS_HOURS = 24 * 400;
const PRICE_EPS = 0.005;
// Without a native (rouble) price, a USD move on a rouble market must be this large to be a
// seller's move rather than the exchange rate.
const FX_MOVE_REL = 0.03;

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
// A number, or null for absent / blank / non-numeric (Number(null) is 0: "unknown" is not zero).
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

// Size bands for the market view. Same edges as the tracker's below 31 so our own sales and the
// market's line up, with the top split in two: a 148-item "complete collection" is a different
// product from a 40-item bundle and must not share a median with it.
const RADAR_BANDS = [
  { name: "1", min: 1, max: 1 },
  { name: "2-3", min: 2, max: 3 },
  { name: "4-6", min: 4, max: 6 },
  { name: "7-12", min: 7, max: 12 },
  { name: "13-30", min: 13, max: 30 },
  { name: "31-99", min: 31, max: 99 },
  { name: "100+", min: 100, max: Infinity },
];
function radarBand(n) {
  const c = Number(n);
  if (!Number.isFinite(c) || c < 1) return "?";
  const b = RADAR_BANDS.find((x) => c >= x.min && c <= x.max);
  return b ? b.name : "?";
}

// The market's own id for a scout row. The scouts now carry `id`; older shapes only have a url.
function idOf(market, r) {
  if (!r) return "";
  const direct = r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
  if (direct) return direct;
  const last = String(r.url || "").split("?")[0].split("/").filter(Boolean).pop() || "";
  if (market === "gameflip") return last.trim();
  // GGSel product urls look like "<slug>-<id>" or just "<id>"; Plati "…/itm/<id>".
  const m = /(\d+)$/.exec(last);
  return m ? m[1] : last.trim();
}

/** One scout row -> the radar's canonical row, or null when it is unusable. */
function normRow(market, r) {
  if (!r) return null;
  const listingId = idOf(market, r);
  const price = num(r.price);
  if (!listingId || !(price > 0)) return null;
  const title = clip(r.title, MAX_TITLE);
  const base = {
    listingId,
    title,
    itemCount: parseAdvertisedCount(title),
    kind: classifyKind(title),
    priceUsd: round2(price),
    seller: String(r.seller == null ? "" : r.seller),
    sellerName: clip(r.sellerName, 60),
  };
  if (market === "gameflip") {
    return {
      ...base,
      priceNative: null,
      sellerScore: num(r.sellerScore),
      sellerRatings: num(r.sellerRatings),
      onsaleAt: toDate(r.onsale),
      listedAt: toDate(r.created),
      updatedAt: toDate(r.updated),
      counter: null,
    };
  }
  return {
    ...base,
    // The rouble price the seller actually set (the USD one moves with the exchange rate).
    priceNative: num(r.priceRub),
    sellerScore: num(r.rating),
    sellerRatings: null,
    onsaleAt: null,
    listedAt: null,
    updatedAt: null,
    // The patched scouts carry `soldRaw` (null when the page had no counter); `sold` turns an
    // absent counter into 0, which would read as a reset and then as a phantom sale.
    counter: r.soldRaw !== undefined ? num(r.soldRaw) : num(r.sold),
  };
}

/**
 * Is this row one of OURS?
 * @param own { gameflipOwners: Set, gameflipOwner: string (legacy), ids: {gameflip,ggsel,plati: Set}, sellers: {ggsel,plati: Set} }
 */
function isOwn(market, nr, own) {
  if (!own || !nr) return false;
  const ids = own.ids && own.ids[market];
  if (ids && ids.has(nr.listingId)) return true;
  if (market === "gameflip") {
    if (!nr.seller) return false;
    if (own.gameflipOwners && own.gameflipOwners.has(nr.seller)) return true;
    return !!own.gameflipOwner && nr.seller === String(own.gameflipOwner);
  }
  const sellers = own.sellers && own.sellers[market];
  return !!(nr.seller && sellers && sellers.has(nr.seller));
}

/** Seller ids to remember as ours: rows whose id is one of our listings but whose seller is not yet known. */
function learnOwnSellers(market, rows, own) {
  const found = new Set();
  if (!own || market === "gameflip") return found;
  const ids = own.ids && own.ids[market];
  const known = (own.sellers && own.sellers[market]) || new Set();
  if (!ids) return found;
  for (const r of rows || []) {
    const nr = normRow(market, r);
    if (nr && nr.seller && ids.has(nr.listingId) && !known.has(nr.seller)) found.add(nr.seller);
  }
  return found;
}

// The highest counter value this listing is known to have reached: the stored high-water mark,
// the last reading, and the newest counter a recorded SALE already accounts for (so a sale whose
// rival update failed is never counted again from the older baseline).
function highWater(ex) {
  let hw = null;
  for (const v of [ex && ex.counterMax, ex && ex.counter, ex && ex.lastSaleCounter]) {
    const n = num(v);
    if (n !== null && (hw === null || n > hw)) hw = n;
  }
  return hw;
}

/** How a counter reading compares with the listing's high-water mark. Pure. */
function counterMove(hw, now) {
  if (hw === null || hw === undefined || now === null || now === undefined) return { kind: "baseline", units: 0 };
  const d = now - hw;
  if (d === 0) return { kind: "same", units: 0 };
  // Below the highest value seen: a stale page, a hidden counter, a reset. Never a sale — and the
  // high-water mark stays, so the return to it is not one either.
  if (d < 0) return { kind: "dip", units: 0 };
  if (d > MAX_COUNTER_JUMP) return { kind: "jump", units: 0 };
  return { kind: "sale", units: d };
}

// Did the seller move the price? On a rouble market compare roubles (the USD figure drifts with the
// exchange rate every day); without a rouble price, only a move bigger than an FX wobble counts.
function priceMoved(market, ex, nr) {
  const prevUsd = Number(ex && ex.priceUsd) || 0;
  if (!COUNTER_MARKETS.includes(market)) return Math.abs(prevUsd - nr.priceUsd) >= PRICE_EPS;
  const prevNative = num(ex && ex.priceNative);
  if (prevNative !== null && nr.priceNative !== null) return Math.abs(prevNative - nr.priceNative) >= 0.5;
  if (!(prevUsd > 0)) return true;
  return Math.abs(nr.priceUsd - prevUsd) / prevUsd >= FX_MOVE_REL;
}

// ---------------------------------------------------------------------------------------------
// Gameflip sold feed -> MarketSale rows
// ---------------------------------------------------------------------------------------------
/**
 * @param job { game, gameKey, at, gameflip:{ sold:[scoutRow] }, own }
 * @param have Set of dedupeKeys already stored (so a known sale is not written twice)
 */
function planSold(job, have = new Set()) {
  const out = [];
  const seen = new Set();
  const rows = (job.gameflip && job.gameflip.sold) || [];
  for (const r of rows) {
    const nr = normRow("gameflip", r);
    if (!nr) continue;
    const key = "gf:" + nr.listingId;
    if (seen.has(key) || have.has(key)) continue;
    seen.add(key);
    const soldAt = nr.updatedAt || job.at;
    let tts = null;
    if (nr.onsaleAt && nr.updatedAt) {
      const h = (nr.updatedAt.getTime() - nr.onsaleAt.getTime()) / 3600000;
      if (h >= 0 && h <= MAX_TTS_HOURS) tts = round1(h);
    }
    out.push({
      dedupeKey: key,
      market: "gameflip",
      listingId: nr.listingId,
      game: job.game,
      gameKey: job.gameKey,
      title: nr.title,
      itemCount: nr.itemCount,
      kind: nr.kind,
      priceUsd: nr.priceUsd,
      priceNative: null,
      units: 1,
      seller: nr.seller,
      sellerName: "",
      sellerScore: nr.sellerScore,
      sellerRatings: nr.sellerRatings,
      onsaleAt: nr.onsaleAt,
      listedAt: nr.listedAt,
      soldAt,
      prevObservedAt: null,
      counterAfter: null,
      ttsHours: tts,
      source: "sold-feed",
      ours: isOwn("gameflip", nr, job.own),
      firstSeenAt: job.at,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rival listings -> MarketRival upserts (+ counter sales for the quantity markets)
// ---------------------------------------------------------------------------------------------
const filterOf = (market, listingId) => ({ market, listingId });

/**
 * @param market  "gameflip" | "ggsel" | "plati"
 * @param job     { game, gameKey, at, gameflip:{sold,active,activeComplete}, ggsel:{rows}, plati:{rows}, own }
 * @param existing Map<listingId, storedRival> — the page's listings by id, plus (Gameflip) this
 *                 game's not-gone rivals, the only ones a miss can apply to
 * @returns { ops, sales, stats }  ops are bulkWrite `updateOne` descriptors for MarketRival;
 *          sales are MarketSale docs (idempotent on dedupeKey) for counter rises.
 */
function planRivals(market, job, existing = new Map()) {
  const at = job.at;
  const ops = [];
  const sales = [];
  const stats = { inserted: 0, updated: 0, counterSales: 0, units: 0, dips: 0, jumps: 0, goneMarked: 0, soldLinked: 0, skippedInvalid: 0 };
  const rows =
    market === "gameflip"
      ? (job.gameflip && job.gameflip.active) || []
      : (job[market] && job[market].rows) || [];

  // Gameflip: a rival listing that the sold feed now shows has SOLD. Done first so the
  // generic updates below leave those documents alone.
  const soldMarks = new Map();
  if (market === "gameflip") {
    for (const r of (job.gameflip && job.gameflip.sold) || []) {
      const nr = normRow("gameflip", r);
      if (!nr) continue;
      const ex = existing.get(nr.listingId);
      if (ex && ex.outcome !== "sold") soldMarks.set(nr.listingId, nr.updatedAt || at);
    }
    for (const [listingId, when] of soldMarks) {
      ops.push({ updateOne: { filter: filterOf(market, listingId), update: { $set: { goneAt: when, outcome: "sold", missed: 0 } } } });
      stats.soldLinked++;
    }
  }

  const seen = new Set();
  for (const r of rows) {
    const nr = normRow(market, r);
    if (!nr) {
      stats.skippedInvalid++;
      continue;
    }
    if (seen.has(nr.listingId)) continue;
    seen.add(nr.listingId);
    if (soldMarks.has(nr.listingId)) continue;
    const ours = isOwn(market, nr, job.own);
    const ex = existing.get(nr.listingId);
    const currency = COUNTER_MARKETS.includes(market) && nr.priceNative !== null ? "RUB" : "USD";
    const common = {
      title: nr.title,
      itemCount: nr.itemCount,
      kind: nr.kind,
      seller: nr.seller,
      sellerName: nr.sellerName,
      sellerScore: nr.sellerScore,
      sellerRatings: nr.sellerRatings,
      ours,
    };
    const point = { at, price: nr.priceUsd, native: nr.priceNative };
    if (!ex) {
      const doc = {
        ...common,
        game: job.game,
        gameKey: job.gameKey,
        market,
        listingId: nr.listingId,
        priceUsd: nr.priceUsd,
        priceNative: nr.priceNative,
        currency,
        priceHistory: [point],
        counter: nr.counter,
        counterMax: nr.counter,
        counterHistory: nr.counter === null ? [] : [{ at, n: nr.counter }],
        onsaleAt: nr.onsaleAt,
        listedAt: nr.listedAt,
        firstSeenAt: at,
        lastSeenAt: at,
        missed: 0,
        goneAt: null,
        outcome: "",
      };
      ops.push({ updateOne: { filter: filterOf(market, nr.listingId), update: { $setOnInsert: doc }, upsert: true } });
      stats.inserted++;
      continue;
    }
    // A rival that is in the on-sale feed is, by definition, not sold: clear any stale outcome.
    const set = { ...common, priceUsd: nr.priceUsd, priceNative: nr.priceNative, currency, lastSeenAt: at, missed: 0, goneAt: null, outcome: "" };
    // A listing keeps the game that first saw it: overlapping names ("Overwatch" / "Overwatch 2")
    // must not flip it from one game to the other on every scan.
    if (!ex.gameKey || ex.gameKey === job.gameKey) {
      set.game = job.game;
      set.gameKey = job.gameKey;
    }
    if (nr.onsaleAt) set.onsaleAt = nr.onsaleAt;
    if (nr.listedAt) set.listedAt = nr.listedAt;
    const push = {};
    if (priceMoved(market, ex, nr)) push.priceHistory = { $each: [point], $slice: -PRICE_HISTORY_MAX };
    if (nr.counter !== null) {
      const hw = highWater(ex);
      const move = counterMove(hw, nr.counter);
      const prevCounter = num(ex.counter);
      if (move.kind === "baseline" || move.kind === "jump") {
        // A first reading, or an implausible jump: re-baseline (upwards), record nothing.
        set.counter = nr.counter;
        set.counterMax = nr.counter;
        push.counterHistory = { $each: [{ at, n: nr.counter }], $slice: -COUNTER_HISTORY_MAX };
        if (move.kind === "jump") stats.jumps++;
      } else if (move.kind === "sale") {
        set.counter = nr.counter;
        set.counterMax = nr.counter;
        push.counterHistory = { $each: [{ at, n: nr.counter }], $slice: -COUNTER_HISTORY_MAX };
        stats.counterSales++;
        stats.units += move.units;
        sales.push({
          // The new count is above every count this listing ever had, so the key cannot repeat.
          dedupeKey: market + ":" + nr.listingId + ":" + nr.counter,
          market,
          listingId: nr.listingId,
          game: ex.gameKey && ex.gameKey !== job.gameKey ? ex.game || job.game : job.game,
          gameKey: ex.gameKey && ex.gameKey !== job.gameKey ? ex.gameKey : job.gameKey,
          title: nr.title,
          itemCount: nr.itemCount,
          kind: nr.kind,
          priceUsd: nr.priceUsd,
          priceNative: nr.priceNative,
          units: move.units,
          seller: nr.seller,
          sellerName: nr.sellerName,
          sellerScore: nr.sellerScore,
          sellerRatings: null,
          onsaleAt: null,
          listedAt: null,
          soldAt: at,
          prevObservedAt: toDate(ex.lastSeenAt),
          counterAfter: nr.counter,
          ttsHours: null,
          source: "counter",
          ours,
          firstSeenAt: at,
        });
      } else {
        // "same" or "dip": nothing sold. The reading is stored as read (a dip stays visible), and
        // the high-water mark is persisted if it was only known from a recorded sale (a rival
        // update that failed after its sale was written) — so the stored state catches up.
        if (move.kind === "dip") stats.dips++;
        if (prevCounter !== nr.counter) {
          set.counter = nr.counter;
          push.counterHistory = { $each: [{ at, n: nr.counter }], $slice: -COUNTER_HISTORY_MAX };
        }
        if (num(ex.counterMax) !== hw) set.counterMax = hw;
      }
    }
    const update = { $set: set };
    if (Object.keys(push).length) update.$push = push;
    ops.push({ updateOne: { filter: filterOf(market, nr.listingId), update } });
    stats.updated++;
  }

  // Gameflip only, and only for a COMPLETE page that actually held rows: rivals of THIS game that
  // were not in it are one miss closer to gone. An empty page proves nothing (an error body read
  // as JSON is an empty page too).
  if (market === "gameflip" && job.gameflip && job.gameflip.activeComplete && seen.size > 0) {
    for (const ex of existing.values()) {
      if (seen.has(ex.listingId) || soldMarks.has(ex.listingId) || ex.goneAt) continue;
      // Only THIS game's page can prove one of this game's rivals missing.
      if (ex.gameKey && ex.gameKey !== job.gameKey) continue;
      const missed = (Number(ex.missed) || 0) + 1;
      const set = { missed };
      if (missed >= MISSES_TO_GONE) {
        set.goneAt = at;
        stats.goneMarked++;
      }
      ops.push({ updateOne: { filter: filterOf(market, ex.listingId), update: { $set: set } } });
    }
  }
  return { ops, sales, stats };
}

/** Everything a tap job holds, built from the scanner's own row lists (copied: the scanner owns the originals). */
function buildJob(input, own, at = new Date()) {
  const game = clip(input && input.game, 120).trim();
  if (!game) return null;
  const take = (a) => (Array.isArray(a) ? a.filter(Boolean) : []);
  return {
    game,
    gameKey: normGame(game),
    at,
    own,
    gameflip: {
      sold: take(input.gfSold),
      active: take(input.gfActive),
      // A result page the scout filled to its limit may have more rows behind it: absence proves nothing.
      activeComplete: !!input.gfActiveComplete,
    },
    ggsel: { rows: take(input.gg) },
    plati: { rows: take(input.pl) },
  };
}

module.exports = {
  MARKETS,
  COUNTER_MARKETS,
  MAX_COUNTER_JUMP,
  MISSES_TO_GONE,
  PRICE_HISTORY_MAX,
  COUNTER_HISTORY_MAX,
  FX_MOVE_REL,
  RADAR_BANDS,
  radarBand,
  idOf,
  normRow,
  isOwn,
  learnOwnSellers,
  highWater,
  counterMove,
  priceMoved,
  planSold,
  planRivals,
  buildJob,
};
