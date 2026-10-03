// The listing brain's loader (utils/listingBrain/inputs.js): what it reads, how it reads it, what the
// bundle holds and what it must never hold. Every database model is a recording fake and every
// marketplace-adjacent function a fake that throws if the loader reaches for it; the pure modules
// (setIdentity, venues, unclaimedBundles) are the real ones. Synthetic games and ids only.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const I = require("../utils/listingBrain/inputs");
const setIdentity = require("../utils/priceTracker/setIdentity");
const venues = require("../utils/priceTracker/venues");
const unclaimedBundles = require("../utils/unclaimedBundles");
const G = require("../utils/priceTracker/games");
const EXPORT = require("../scripts/listing-brain-export");

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 10, 12);
const REPORT_AT = NOW - 3 * 60000;

// Synthetic 24-hex ids (digits are hex); the bundle must hold none of them.
const ID = (n) => "a" + String(n).padStart(23, "0");
const H = (n) => I.hashId(ID(n));

/* ------------------------------- the fake world ------------------------------- */

function query(rows, calls, name) {
  return (filter, projection) => {
    const call = { name, filter, projection, sort: null, limit: null, lean: false, skipped: false };
    calls.push(call);
    const q = {
      sort(s) {
        call.sort = s;
        return q;
      },
      limit(n) {
        call.limit = n;
        return q;
      },
      skip() {
        call.skipped = true;
        return q;
      },
      lean: async () => {
        call.lean = true;
        if (rows instanceof Error) throw rows;
        return typeof rows === "function" ? rows(filter) : rows;
      },
    };
    return q;
  };
}

const SETS = {
  A1: { _id: ID(101), name: "Set A1", price: 2, minPriceUsd: 1.5, items: [{ itemKey: "aq-sword", game: "Alpha Quest", qty: 1, name: "Sword" }, { itemKey: "aq-shield", game: "Alpha Quest", qty: 1, name: "Shield" }] },
  B1: { _id: ID(102), name: "Set B1", price: 3, minPriceUsd: 0, items: [{ itemKey: "ba-helm", game: "Beta Arena", qty: 2, name: "Helm" }] },
  G1: { _id: ID(103), name: "Set G1", price: 2, minPriceUsd: 1, items: [{ itemKey: "gr-cape", game: "Gamma Rush", qty: 1, name: "Cape" }, { itemKey: "gr-hat", game: "Gamma Rush", qty: 1, name: "Hat" }] },
  G2: { _id: ID(104), name: "Set G2", price: 1.5, minPriceUsd: 0, items: [{ itemKey: "gro-boots", game: "Gamma Rush Origins", qty: 1, name: "Boots" }] },
};

// One listing: the extra read's document (`x`, with identifying fields the DB holds, so the
// whitelisting is tested) and, when the tracker prepared it, its prepared row.
function listing(n, o) {
  const x = {
    _id: ID(n),
    marketplace: o.m,
    origin: o.origin,
    status: o.status || "active",
    price: o.price,
    createdAt: new Date(o.created || NOW - 10 * DAY),
    updatedAt: new Date(o.updated || NOW - DAY),
    set: o.set ? o.set._id : undefined,
    noclaimStock: !!o.noclaimStock,
    autoClaimSet: !!o.autoClaimSet,
    unclaimedGame: o.unclaimedGame || "",
    accountOffer: o.accountOffer || null,
    rentFarm: !!o.rentFarm,
    bulkOfferId: o.bulkOfferId || null,
    bulkPackSize: o.bulkPackSize || 0,
    lotSize: o.lotSize || 0,
    qtyRemaining: o.qtyRemaining || 0,
    qtyTarget: o.qtyTarget || 0,
    lastStock: o.lastStock === undefined ? null : o.lastStock,
    rebundledAt: o.rebundledAt ? new Date(o.rebundledAt) : null,
    venueMinPriceUsd: o.vmin || 0,
    units: o.units || [],
    // never projected by the loader; a careless spread would leak them
    accountLogin: "secret_login_" + n,
    note: "auto-farm: automatic delivery — secret_login_" + n,
    externalId: "EXT-" + n,
  };
  const title = o.title || (o.game ? o.game + " Twitch Drops" : "");
  const l = { ...x, title, units: (o.units || []).map((u) => ({ deliveredAt: u.deliveredAt || null, orderId: u.orderId || "", login: "secret_unit_login" })) };
  const prepared = o.prepared === false ? null : { l, id: setIdentity.identify(l, o.set || null), market: o.m, listingId: ID(n) };
  return { x, prepared, n };
}

const units = (k, from = NOW - 5 * DAY) => Array.from({ length: k }, (_, i) => ({ addedAt: new Date(from + i * HOUR), deliveredAt: null }));

const LISTINGS = [
  listing(1, { m: "gameflip", origin: "auto", price: 1.75, set: SETS.A1, game: "Alpha Quest" }),
  // the G2G operator script: origin auto AND claim-at-sale
  listing(2, { m: "g2g", origin: "auto", autoClaimSet: true, price: 3, set: SETS.B1, game: "Beta Arena" }),
  listing(3, { m: "eldorado", origin: "manual", noclaimStock: true, price: 2, set: SETS.G1, game: "Gamma Rush" }),
  listing(4, { m: "eldorado", origin: "manual", unclaimedGame: "Gamma Rush", price: 2, game: "Gamma Rush" }),
  listing(5, { m: "gameflip", origin: "manual", accountOffer: ID(900), price: 4, title: "Alpha Quest account" }),
  // a v2 bulk pack: the tracker skips it (kind bulk), 250 accounts attached
  listing(6, { m: "eldorado", origin: "manual", bulkOfferId: ID(901), bulkPackSize: 5, price: 10, set: SETS.A1, prepared: false, units: units(250) }),
  // a Gameflip lot of 5 no-claim accounts (the tracker does not know lots)
  listing(7, { m: "gameflip", origin: "unclaimed", lotSize: 5, price: 8, set: SETS.G1, game: "Gamma Rush" }),
  listing(8, { m: "gameflip", origin: "manual", rentFarm: true, price: 3, prepared: false }),
  listing(9, { m: "gameflip", origin: "unclaimed", price: 2, set: SETS.G1, game: "Gamma Rush" }),
  listing(10, { m: "ggsel", origin: "unclaimed", price: 2, set: SETS.G1, game: "Gamma Rush", lastStock: 3, units: units(3) }),
  // not prepared, no flag, older than the report, price fine: a rent-farm TITLE
  listing(11, { m: "gameflip", origin: "manual", price: 3, created: NOW - 20 * DAY, prepared: false }),
  // not prepared: junk price
  listing(12, { m: "gameflip", origin: "manual", price: 30, set: SETS.A1, prepared: false }),
  listing(13, {
    m: "eldorado",
    origin: "auto",
    price: 2,
    set: SETS.A1,
    game: "Alpha Quest",
    rebundledAt: NOW - 2 * DAY,
    units: [{ addedAt: new Date(NOW - 9 * DAY), deliveredAt: new Date(NOW - 3 * DAY), orderId: "ORD-1" }, { addedAt: new Date(NOW - 9 * DAY), deliveredAt: null }],
  }),
  listing(14, { m: "ggsel", origin: "manual", price: 1.5, set: SETS.G2, game: "Gamma Rush Origins" }),
  listing(15, { m: "zeusx", origin: "manual", price: 0.8, set: SETS.A1, game: "Alpha Quest" }),
  // newer than the tracker's report: not in it yet
  listing(16, { m: "gameflip", origin: "auto", price: 1.5, created: NOW - 60000, set: { _id: ID(199), items: [] }, prepared: false }),
];
const BY_N = new Map(LISTINGS.map((r) => [r.n, r]));

// A ledger record as utils/priceTracker/ledger.js builds it (identifying fields included).
function ledgerSale(n, o) {
  const r = n ? BY_N.get(n) : null;
  const id = r && r.prepared ? r.prepared.id : { gameKey: o.gameKey || "", contentKey: null, bandKey: (o.gameKey || "") + "|?", countForBand: null, exact: false };
  return {
    market: o.market || (r ? r.x.marketplace : "unknown"),
    listingId: r ? ID(n) : "",
    externalId: r ? "EXT-" + n : "",
    origin: o.origin || (r ? r.x.origin : "manual"),
    title: "a title with secret_title_word",
    listedPrice: r ? r.x.price : 0,
    gameKey: id.gameKey,
    contentKey: id.contentKey,
    bandKey: id.bandKey,
    itemCount: id.countForBand,
    exact: id.exact,
    login: "buyer_secret",
    logins: ["buyer_secret"],
    account: ID(950),
    dedupeKey: "sold:" + ID(n || 0) + ":x:1",
    orderId: o.orderId || "",
    key: o.key || "k:" + n + ":" + (o.at || 0),
    saleGroup: o.saleGroup || "grp:" + n + ":" + (o.at || 0),
    source: o.source || "signal",
    at: new Date(o.at),
    priceUsd: o.price || 0,
    priceBasis: o.basis || (o.price ? "reported" : "none"),
    priced: (o.price || 0) > 0,
    ...(o.burst ? { burst: true } : {}),
  };
}

const LEDGER_SALES = [
  ledgerSale(1, { at: NOW - 2 * DAY, price: 1.75, saleGroup: "det:" + ID(1) + ":1" }),
  // a no-claim lister row's sale in the ledger: replaced by the unit ledger
  ledgerSale(9, { at: NOW - DAY, price: 2, source: "row", basis: "row" }),
  ledgerSale(13, { at: NOW - 3 * DAY, price: 2, source: "unit", basis: "listing-now", orderId: "ORD-1", saleGroup: "eldorado:order:ORD-1" }),
  // a hand sale typed as "plati"
  ledgerSale(null, { at: NOW - 4 * DAY, market: "plati", gameKey: "gamma rush", source: "hand", origin: "manual" }),
  ledgerSale(2, { at: NOW - 5 * DAY, price: 3, source: "unit", basis: "listing-now", orderId: "ORD-2" }),
  ledgerSale(14, { at: NOW - 6 * DAY, price: 1.5 }),
  ledgerSale(1, { at: NOW - 400 * DAY, price: 1 }),
  ledgerSale(1, { at: NOW - 2 * DAY, price: 1, source: "weird" }),
];
const LEDGER_DEMAND = [
  ledgerSale(6, { at: NOW - 3 * DAY, source: "bulk" }),
  ledgerSale(6, { at: NOW - 3 * DAY + 1, source: "bulk" }),
  ledgerSale(1, { at: NOW - 8 * DAY, source: "signal", burst: true }),
  ledgerSale(null, { at: NOW - 9 * DAY, market: "shop", gameKey: "alpha quest", source: "shop" }),
  ledgerSale(10, { at: NOW - 2 * DAY, source: "signal", burst: true }),
];

function unit(n, o) {
  return {
    _id: ID(500 + n),
    login: "secret_unit_" + n,
    loginLower: "secret_unit_" + n,
    poolAccountId: ID(600 + n),
    twitchId: "tw-" + n,
    game: o.game || "Gamma Rush",
    market: o.market || "gameflip",
    status: o.status,
    listedAt: o.listedAt === undefined ? new Date(NOW - 5 * DAY) : o.listedAt,
    soldAt: o.soldAt ? new Date(o.soldAt) : null,
    soldPriceUsd: o.paid || 0,
    soldMarket: o.soldMarket || "",
    expiredAt: o.expiredAt ? new Date(o.expiredAt) : null,
    listingIds: (o.rows || []).map(ID),
    bundleKey: "gamma rush|gamma rush cup|week 1",
    drops: [{ campaign: "Gamma Rush Cup Week 1", name: "Cape", itemKey: "gr-cape", login: "secret_drop" }],
  };
}
const UNITS = {
  u1: unit(1, { status: "sold", soldAt: NOW - DAY, paid: 2.25, soldMarket: "gameflip", rows: [9] }),
  u2: unit(2, { status: "sold", market: "ggsel", soldAt: NOW - 2 * DAY, soldMarket: "ggsel", rows: [10] }),
  u3: unit(3, { status: "sold", soldAt: NOW - 3 * DAY, soldMarket: "manual", rows: [9] }),
  u4: unit(4, { status: "sold", soldAt: NOW - 2 * DAY, paid: 3, soldMarket: "eldorado", rows: [9] }),
  u5: unit(5, { status: "sold", soldAt: NOW - 2 * DAY, paid: 1.6, soldMarket: "gameflip", rows: [7] }),
  u6: unit(6, { status: "listed", rows: [9] }),
  u7: unit(7, { status: "expired", expiredAt: NOW - 2 * DAY, rows: [] }),
  u9: unit(9, { status: "sold", soldAt: NOW - DAY, paid: 2, soldMarket: "plati", rows: [] }),
  u10: unit(10, { status: "listed", game: "Gamma Rush Origins", market: "ggsel", rows: [14] }),
};

const CAMPAIGNS = [
  { _id: ID(700), campaignId: "cmp1", name: "Gamma Rush Cup Week 1", game: "Gamma Rush", startAt: new Date(NOW - 10 * DAY), endAt: new Date(NOW - 2 * DAY) },
  { _id: ID(701), campaignId: "cmp2", name: "Gamma Rush Cup Week 2", game: "Gamma Rush", startAt: new Date(NOW - DAY), endAt: new Date(NOW + 3 * DAY) },
  { _id: ID(702), campaignId: "cmp3", name: "Alpha Quest Launch", game: "Alpha Quest", startAt: new Date(NOW - 5 * DAY), endAt: new Date(NOW + 5 * DAY) },
];
const MANIFESTS = [
  { _id: ID(710), campaignId: "cmp1", name: "Gamma Rush Cup Week 1", game: "Gamma Rush", drops: [{ itemKey: "gr-cape", name: "Cape" }] },
  { _id: ID(711), campaignId: "cmp2", name: "Gamma Rush Cup Week 2", game: "Gamma Rush", drops: [{ itemKey: "gr-hat", name: "Hat" }] },
];
const RESEARCH = [
  { _id: ID(800), game: "Alpha Quest", markets: { gameflip: { soldRecent: 5, avgSoldPrice: 2.1, lowestOther: 2.4 }, ggsel: { lowest: 1 }, plati: { lowest: 1.4 } }, scannedAt: new Date(NOW - DAY) },
  // only a case-insensitive match for the label "Gamma Rush"
  { _id: ID(801), game: "gamma rush", markets: { gameflip: { soldRecent: 4, avgSoldPrice: 1.8 } }, scannedAt: new Date(NOW - DAY) },
];
const DEMAND_ROWS = [
  { _id: ID(850), k: "alpha quest", f: "claim", at: new Date(NOW - HOUR), live: true, hl: 30, br: { c: "farm", w: 7, t: 20 }, stk: { on: 6, fl: 2 }, est: { avg30: 6, avg45: 5 } },
  { _id: ID(851), k: "alpha quest", f: "claim", at: new Date(NOW - 3 * HOUR), live: true, hl: 32, br: { c: "farm", w: 99, t: 99 }, stk: { on: 1, fl: 0 }, est: { avg30: 1, avg45: 1 } },
  { _id: ID(852), k: "gamma rush", f: "noclaim", at: new Date(NOW - 2 * HOUR), live: true, hl: null, br: { c: "fleet", w: 10, t: 40 }, stk: { on: 20, fl: 4 }, est: { avg30: 9, avg45: 8 } },
  { _id: ID(853), k: "beta arena", f: "claim", at: new Date(NOW - HOUR), live: false, hl: null, br: { c: "farm", w: 2, t: 8 }, stk: { on: 3, fl: 0 }, est: { avg30: 2, avg45: 2 } },
];
// more claim games with stock, so the old side's concurrency can be measured
for (let i = 1; i <= 8; i++) DEMAND_ROWS.push({ k: "delta " + i, f: "claim", at: new Date(NOW - HOUR), live: true, br: { c: "farm", w: 1, t: 5 }, stk: { on: 2, fl: 0 }, est: {} });

function radarReport() {
  const bm = (o) => ({ units: 3, orders: 3, perWeek: o.perWeek, observedDays: 20, sold: { n: o.n, min: 1, p25: 1.2, median: o.median, p75: 2.5, max: 3 }, medianTtsHours: o.tts, live: 4, liveSellers: o.sellers, farmLive: 1, asking: { n: 2 }, oursLive: 1, oursSold: 1 });
  return {
    generatedAt: new Date(NOW - 5 * 60000),
    windowDays: 30,
    games: [
      {
        key: "alpha quest",
        game: "Alpha Quest",
        units: 10,
        perWeek: 12,
        rivalSellers: 4,
        medianTtsHours: 20,
        realised: { n: 9 },
        bands: [],
        byMarket: { gameflip: bm({ perWeek: 8, n: 5, median: 2, tts: 20, sellers: 3 }), ggsel: bm({ perWeek: 3, n: 3, median: 1, tts: null, sellers: 1 }), plati: bm({ perWeek: 1, n: 1, median: 1.3, tts: null, sellers: 1 }) },
        flags: [{ id: "crowded", text: "x" }],
      },
    ],
    feed: [
      { market: "plati", game: "Alpha Quest", gameKey: "alpha quest", title: "Rival title", priceUsd: 1.3, units: 1, unitsSeen: 1, itemCount: 2, band: "2-3", kind: "drops", soldAt: new Date(NOW - DAY), ttsHours: null, source: "counter", seller: "Rival Shop", ours: false },
      { market: "gameflip", gameKey: "alpha quest", priceUsd: 2, units: 1, itemCount: 2, kind: "drops", soldAt: new Date(NOW - DAY), ttsHours: 10, seller: "seller 123456", ours: false },
      { market: "gameflip", gameKey: "alpha quest", priceUsd: 1.75, units: 1, kind: "drops", soldAt: new Date(NOW - DAY), ours: true, seller: "us" },
      { market: "gameflip", gameKey: "alpha quest", priceUsd: 9, units: 1, kind: "farm", soldAt: new Date(NOW - DAY), ours: false, seller: "farmer" },
    ],
    sellers: [{ market: "gameflip", label: "Rival Shop" }],
    undercuts: [{ externalId: "EXT-1", cheapest: { seller: "Rival Shop" } }],
    liveByGame: new Map([["alpha quest", [{ market: "gameflip", seller: "Rival Shop", url: "https://example.invalid/item/1" }]]]),
    truncated: { sales: false, rivals: false },
  };
}

function trackerReport(over = {}) {
  return {
    at: new Date(REPORT_AT),
    truncated: !!over.truncated,
    games: [{ key: "alpha quest", game: "Alpha Quest", farm: { onHand: 9 } }],
    ledger: { sales: LEDGER_SALES, demandOnly: LEDGER_DEMAND, suspect: [{ key: "x", reason: "burst" }] },
    prepared: { rows: LISTINGS.filter((r) => r.prepared).map((r) => r.prepared), setById: new Map(Object.values(SETS).map((s) => [s._id, s])) },
    ctx: {},
  };
}

// The real computeSplit / dealShares / postEventPrice arithmetic (autoLister.js), so the old side's
// numbers are today's.
function computeSplit(qty) {
  const n = Math.max(0, Number(qty) || 0);
  if (n <= 1) return { listNow: n, holdBack: 0 };
  const listNow = Math.ceil(n / 2);
  return { listNow, holdBack: n - listNow };
}
function dealShares(accounts, marketOrder, shares, gfHeld) {
  const queue = (accounts || []).slice();
  const takes = (a) => !(gfHeld && gfHeld.has(String((a && a.login) || "").toLowerCase()));
  for (let i = 0; queue.length; i++) {
    const market = marketOrder[i % marketOrder.length];
    let at = 0;
    if (market === "gameflip") {
      at = queue.findIndex(takes);
      if (at === -1) {
        if (marketOrder.length === 1) break;
        continue;
      }
    }
    shares[market].push(queue.splice(at, 1)[0]);
  }
  return shares;
}
const postEventPrice = (b) => Math.max(0.75, Math.round((Number(b) > 0 ? Number(b) : 1) * 1.5 * 4) / 4);

function world(over = {}) {
  const calls = [];
  const seen = { derive: [], venue: [], suggest: [], venueInflight: 0, venueMax: 0, venueOrder: [] };
  const af = {
    noClaimGames: ["Gamma Rush"],
    perMarketStock: 3,
    platiCategoryId: "34187",
    platiEnabled: true,
    ggselEnabled: true,
    ggselCategoryId: "",
    eldoradoAuto: true,
    g2gAuto: true,
    zeusxAuto: false,
    playerauctionsAuto: false,
    unclaimedGameCaps: { "gamma rush origins": 25 },
    noclaimAutoSize: false,
    listingBrain: { enabled: true, fitDaysClaim: 60, note: "never copied" },
    ...(over.af || {}),
  };
  const unitDocs = over.units || Object.values(UNITS);
  const deps = {
    settings: {
      getAutoFarm: () => {
        if (over.settingsFail) throw new Error("settings.json damaged at /srv/app/utils/settings.json");
        return af;
      },
      getFarmSizing: () => ({ enabled: false, coverageDays: 28, safetyStock: 6, maxPerGame: 250, gameCaps: {}, coverageDaysFor: () => 28 }),
      loadSettings: () => ({ priceTracker: { fees: { gameflip: 7, plati: 9, bogus: 3, ggsel: "x" } } }),
      getUnclaimedPricing: () => ({ floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: { "gamma rush": 1 }, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25, repriceExisting: false, gameCaps: { x: 1 } }),
      getBulkPacks: () => ({ enabled: false, markets: ["eldorado", "g2g"], tiers: [{ minQty: 5, discountPct: 5 }, { minQty: 10, discountPct: 10 }], reserveSingles: 5, unitsPerOffer: 20 }),
      normGameName: (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      setAutoFarm: () => {
        throw new Error("the loader must never write a setting");
      },
    },
    priceTracker: {
      getReportSWR: async (o) => {
        calls.push({ name: "report", opts: o });
        return over.report === undefined ? trackerReport(over) : over.report;
      },
      suggestForNew: (report, q) => {
        seen.suggest.push(q);
        if (q.market === "digiseller") return { price: 0, action: "blocked", confidence: "none", reasons: ["market blocked by owner"] };
        return { price: 1.6, basis: "this game sold on this market", confidence: "medium", reasons: ["secret reason"], contentKey: "s:x", game: q.game };
      },
      getReport: async () => {
        throw new Error("the loader reads the shared cache through getReportSWR only");
      },
    },
    setIdentity,
    venues,
    marketReport: {
      getReport: async (o) => {
        calls.push({ name: "radar", opts: o });
        if (over.radarFails) throw new Error("radar read failed at 10.1.2.3:27017");
        return radarReport();
      },
    },
    autoLister: {
      derivePrice: (r) => {
        seen.derive.push(r ? r.game : null);
        return r ? 2 : 1;
      },
      venuePrice: async (m, base, opts) => {
        seen.venue.push({ m, base, title: opts && opts.title });
        seen.venueOrder.push("start");
        seen.venueInflight++;
        seen.venueMax = Math.max(seen.venueMax, seen.venueInflight);
        await new Promise((r) => setImmediate(r));
        seen.venueInflight--;
        seen.venueOrder.push("end");
        if (over.venueFails) throw new Error("snapshot read failed: mongodb://db.example.net:27017/shop");
        if (over.venueHangs) return new Promise(() => {});
        return Math.round(base * 0.8 * 100) / 100;
      },
      computeSplit,
      dealShares,
      postEventPrice,
      platiTakesNewStock: () => (over.platiTakes === undefined ? false : over.platiTakes),
      ggselTakesNewStock: (a) => !!a && a.ggselEnabled !== false,
      listActivatedTask: () => {
        throw new Error("never listActivatedTask");
      },
      refillMarkets: () => {
        throw new Error("never refillMarkets");
      },
      onCampaignEnded: () => {
        throw new Error("never onCampaignEnded");
      },
    },
    unclaimedBundles: {
      bundlePrice: unclaimedBundles.bundlePrice,
      classifyHoldings: unclaimedBundles.classifyHoldings,
      buildEventCatalog: unclaimedBundles.buildEventCatalog,
      loadCatalog: () => {
        throw new Error("never loadCatalog (unbounded)");
      },
    },
    g2gGames: { brandForGame: (g) => (/beta arena/i.test(String(g)) ? "Beta Brand" : null) },
    MarketplaceListing: { find: query(over.listingRows || (over.listingsFail ? new Error("listings down") : LISTINGS.map((r) => r.x)), calls, "listings") },
    UnclaimedAccount: {
      find: (filter, projection) => {
        if (over.unitsFail) return query(new Error("units down"), calls, "units")(filter, projection);
        const sold = filter.status === "sold";
        // the same document comes back from both reads (u1 is sold and listed in the window)
        const rows = sold ? unitDocs.filter((u) => u.status === "sold") : unitDocs.filter((u) => u.listedAt);
        return query(rows, calls, sold ? "unitsSold" : "unitsListed")(filter, projection);
      },
    },
    TwitchCampaign: { find: query(over.campaignsFail ? new Error("campaigns down") : CAMPAIGNS, calls, "campaigns") },
    CampaignDrops: { find: query(MANIFESTS, calls, "manifests") },
    MarketResearch: { find: query(over.researchFail ? new Error("research down") : RESEARCH, calls, "research") },
    DemandBrainRow: { find: query(over.demandRows || (over.demandFail ? new Error("rows down") : DEMAND_ROWS), calls, "demand") },
  };
  return { deps, calls, seen, af };
}

const loadWith = (over = {}, opts = {}) => {
  const w = world(over);
  return I.load({ now: NOW, deps: w.deps, ...opts }).then((b) => ({ ...w, b }));
};
const byId = (b) => new Map(b.listings.map((L) => [L.id, L]));

/* ----------------------------------- reads ----------------------------------- */

test("every read is projected, limited, lean and never skipped — exactly plan §2's table", async () => {
  const { b, calls } = await loadWith();
  const W = I.readWindows({ listingBrain: { fitDaysClaim: 60 } });
  assert.equal(W.fitDays, 60);
  const db = calls.filter((c) => c.filter !== undefined);
  assert.deepEqual(db.map((c) => c.name).sort(), ["campaigns", "demand", "listings", "manifests", "research", "unitsListed", "unitsSold"]);
  for (const c of db) {
    assert.ok(c.projection && Object.keys(c.projection).length > 0, c.name + " is projected");
    assert.ok(Number.isInteger(c.limit) && c.limit > 0, c.name + " is limited");
    assert.equal(c.lean, true, c.name + " is lean");
    assert.equal(c.skipped, false, c.name + " never skips");
  }
  const get = (n) => calls.find((c) => c.name === n);
  const L = get("listings");
  assert.deepEqual(L.projection, { ...I.LISTING_PROJECTION });
  assert.ok(!("units.login" in L.projection) && !("accountLogin" in L.projection) && !("title" in L.projection) && !("note" in L.projection));
  assert.deepEqual(L.filter.marketplace.$in, I.MARKETS);
  assert.deepEqual(L.filter.$or[0], { status: "active" });
  assert.equal(L.filter.$or[1].updatedAt.$gte.getTime(), NOW - (60 + I.BACKTEST_PAD_DAYS) * DAY);
  assert.deepEqual(L.sort, { _id: -1 });
  assert.equal(L.limit, I.LISTING_CAP);
  const UL = get("unitsListed");
  const US = get("unitsSold");
  assert.deepEqual(UL.projection, { ...I.UNIT_PROJECTION });
  assert.ok(!("login" in UL.projection) && !("loginLower" in UL.projection) && !("poolAccountId" in UL.projection));
  assert.equal(UL.filter.listedAt.$gte.getTime(), NOW - (60 + I.BACKTEST_PAD_DAYS + I.UNIT_LISTED_PAD_DAYS) * DAY);
  assert.deepEqual(Object.keys(US.filter).sort(), ["soldAt", "status"]);
  assert.equal(US.filter.status, "sold");
  assert.equal(US.filter.soldAt.$gte.getTime(), NOW - (60 + I.BACKTEST_PAD_DAYS) * DAY);
  assert.equal(UL.limit, I.UNIT_CAP);
  assert.equal(US.limit, I.UNIT_CAP);
  const C = get("campaigns");
  assert.deepEqual(C.projection, { campaignId: 1, name: 1, game: 1, startAt: 1, endAt: 1 });
  assert.equal(C.filter.endAt.$gte.getTime(), NOW - I.CAMPAIGN_WINDOW_DAYS * DAY);
  assert.equal(C.limit, I.CAMPAIGN_CAP);
  const M = get("manifests");
  assert.deepEqual(M.filter, { campaignId: { $in: ["cmp1", "cmp2", "cmp3"] } });
  assert.deepEqual(M.projection, { campaignId: 1, name: 1, game: 1, "drops.itemKey": 1, "drops.name": 1 });
  assert.equal(M.limit, I.MANIFEST_CAP);
  const R = get("research");
  assert.deepEqual(R.filter, {});
  assert.deepEqual(R.projection, { game: 1, "markets.gameflip": 1, "markets.ggsel": 1, "markets.plati": 1, scannedAt: 1 });
  assert.equal(R.limit, I.RESEARCH_CAP);
  const D = get("demand");
  assert.equal(D.filter.at.$gte.getTime(), NOW - 72 * HOUR);
  assert.deepEqual(D.sort, { at: -1 });
  assert.equal(D.limit, I.DEMAND_ROW_CAP);
  assert.deepEqual(D.projection, { ...I.DEMAND_PROJECTION });
  // the two shared caches, asked the documented way
  assert.deepEqual(get("report").opts, { timeoutMs: 120000 });
  assert.deepEqual(get("radar").opts, { days: 30 });
  assert.equal(b.kind, "listing-brain-bundle");
});

test("settings are read first: a load whose getAutoFarm throws fails safely, before any read", async () => {
  const w = world({ settingsFail: true });
  await assert.rejects(I.load({ now: NOW, deps: w.deps }), (e) => {
    assert.match(e.message, /settings unreadable/);
    assert.match(e.message, /nothing loaded/);
    assert.ok(!e.message.includes("/srv/app"), "no server path in the message: " + e.message);
    return true;
  });
  assert.equal(w.calls.length, 0, "no report, radar or database read happened");
});

test("a null tracker report fails the load, and nothing after it is read", async () => {
  const w = world({ report: null });
  await assert.rejects(I.load({ now: NOW, deps: w.deps }), /price tracker report is not available/);
  assert.deepEqual(
    w.calls.map((c) => c.name),
    ["report"],
  );
  const w2 = world({ report: { at: new Date(NOW) } });
  await assert.rejects(I.load({ now: NOW, deps: w2.deps }), /price tracker report is not available/, "a report without a ledger is no report");
});

test("an unreadable listing read or unit read fails the load (missing, they would read as nothing sold)", async () => {
  await assert.rejects(I.load({ now: NOW, deps: world({ listingsFail: true }).deps }), /listing read failed \(listings down\)/);
  await assert.rejects(I.load({ now: NOW, deps: world({ unitsFail: true }).deps }), /no-claim unit read failed \(units down\)/);
});

test("a failed radar read degrades with a note; the run still loads", async () => {
  const { b } = await loadWith({ radarFails: true });
  assert.deepEqual(b.radar, { at: null, games: [], feed: [] });
  const n = b.notes.find((x) => /Market radar unreadable/.test(x));
  assert.ok(n, b.notes.join(" | "));
  assert.ok(!n.includes("10.1.2.3"), "no address in the note: " + n);
  assert.ok(b.listings.length > 0 && b.sales.length > 0);
});

test("failed campaign, research and farm-brain reads degrade with notes", async () => {
  const { b } = await loadWith({ campaignsFail: true, researchFail: true, demandFail: true });
  assert.ok(b.notes.some((x) => /Drop campaigns unreadable/.test(x)));
  assert.ok(b.notes.some((x) => /Market research read failed/.test(x)));
  assert.ok(b.notes.some((x) => /farm brain's rows were unreadable/.test(x)));
  assert.deepEqual(b.noclaim.waves, []);
  assert.deepEqual(b.demand, [], "no demand row: the model reads every game as unknown and holds");
  // research unreadable: no old base price (never derivePrice(null)'s $1 as if it were today's)
  for (const og of Object.values(b.old.games)) {
    assert.equal(og.base, null);
    assert.equal(og.rm, "unread");
  }
  for (const oo of Object.values(b.old.offers)) assert.equal(oo.np, null);
});

test("a read that returns its cap says so in a note", async () => {
  const many = Array.from({ length: I.DEMAND_ROW_CAP }, (_, i) => ({ k: "game " + (i % 50), f: "claim", at: new Date(NOW - HOUR), br: {}, stk: {}, est: {} }));
  const rows = Array.from({ length: I.LISTING_CAP }, (_, i) => ({ _id: "b" + String(i).padStart(23, "0"), marketplace: "gameflip", origin: "manual", status: "delisted", price: 1, createdAt: new Date(NOW - 50 * DAY), updatedAt: new Date(NOW - 40 * DAY) }));
  const { b } = await loadWith({ demandRows: many, listingRows: rows });
  assert.ok(b.notes.some((x) => x.includes("farm-brain row read hit its cap of " + I.DEMAND_ROW_CAP)), b.notes.join(" | "));
  assert.ok(b.notes.some((x) => x.includes("listing read hit its cap of " + I.LISTING_CAP)), b.notes.join(" | "));
});

/* ---------------------------------- the bundle ---------------------------------- */

test("the bundle is plain JSON: it round-trips identical and passes privacyScan and validateBundle", async () => {
  const { b } = await loadWith({ platiTakes: true });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  assert.deepEqual(I.privacyScan(b), []);
  assert.deepEqual(I.validateBundle(b), []);
  const text = JSON.stringify(b);
  for (const bad of ["secret", "EXT-", "ORD-", "Rival Shop", "seller 123456", "example.invalid", "buyer_", "tw-", "never copied", "Rival title"]) {
    assert.ok(!text.includes(bad), "the bundle holds " + JSON.stringify(bad));
  }
  assert.ok(!/[0-9a-f]{24}/i.test(text), "no raw database id anywhere");
  assert.deepEqual(Object.keys(b).sort(), ["af", "bulk", "bulkPrices", "counts", "demand", "demandOnly", "fees", "kind", "listings", "noclaim", "notes", "now", "old", "pricing", "radar", "sales", "sizing", "v"]);
  assert.equal(b.v, 1);
  assert.equal(b.now, NOW);
  assert.deepEqual(b.sizing, { coverageDays: 28, safetyStock: 6, maxPerGame: 250 });
  assert.deepEqual(b.fees, { gameflip: 7 }, "only known markets with numeric fees");
  assert.deepEqual(b.pricing, { floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: { "gamma rush": 1 }, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25 });
  assert.deepEqual(b.bulk, { markets: ["eldorado", "g2g"], tiers: [{ size: 5, discountPct: 5 }, { size: 10, discountPct: 10 }], reserveSingles: 5 });
  assert.deepEqual(b.af.listingBrain, { enabled: true, fitDaysClaim: 60 }, "the brain's block, without free text");
  assert.equal(b.af.capDefault, 70);
  assert.deepEqual(b.af.caps, { "gamma rush origins": 25 }, "an explicit cap, matched like settings.gameCapFor");
  assert.deepEqual(b.af.noClaimGames, ["gamma rush"]);
});

test("listing ids are sha1-12 hashes, stable, and the sales point at them", async () => {
  assert.equal(I.hashId("abc"), crypto.createHash("sha1").update("abc").digest("hex").slice(0, 12));
  assert.match(I.hashId(ID(1)), /^[0-9a-f]{12}$/);
  const { b } = await loadWith();
  const ids = byId(b);
  assert.ok(ids.has(H(1)));
  const s = b.sales.filter((x) => x.lid === H(1));
  assert.equal(s.length, 1, "one sale of row 1 inside the window (the 400-day-old one and the unknown source are out)");
  assert.equal(s[0].grp, I.hashId("det:" + ID(1) + ":1"), "the order key is hashed too");
  assert.equal(s[0].basis, "reported");
  assert.equal(s[0].p, 1.75);
  const eld = b.sales.find((x) => x.lid === H(13));
  assert.deepEqual([eld.src, eld.basis, eld.m, eld.f, eld.o], ["unit", "listing-now", "eldorado", "claim", "auto"]);
});

test("kind and farm of every row, plan §3 order (claim-at-sale before origin)", async () => {
  const { b } = await loadWith();
  const ids = byId(b);
  const at = (n) => ids.get(H(n));
  const kf = (n) => [at(n).kind, at(n).f, at(n).o, at(n).script];
  assert.deepEqual(kf(1), ["single", "claim", "auto", false]);
  assert.deepEqual(kf(2), ["cas", "claim", "auto", true], "a G2G script row: origin auto + autoClaimSet");
  assert.deepEqual(kf(3), ["cas", "noclaim", "manual", false], "noclaimStock");
  assert.deepEqual(kf(4), ["cas", "noclaim", "manual", false], "unclaimedGame");
  assert.deepEqual(kf(5), ["account", "claim", "manual", false]);
  assert.deepEqual(kf(6), ["bulk", "claim", "manual", false]);
  assert.equal(at(6).pack, 5);
  assert.deepEqual(kf(7), ["lot", "noclaim", "unclaimed", false]);
  assert.deepEqual([at(7).lot, at(7).pack], [5, 0], "a lot keeps its size apart from pack size");
  assert.deepEqual(kf(8), ["farm", "claim", "manual", false], "rent-farm flag");
  assert.deepEqual(kf(9), ["single", "noclaim", "unclaimed", false]);
  assert.deepEqual(kf(10), ["single", "noclaim", "unclaimed", false]);
  assert.deepEqual(kf(13), ["single", "claim", "auto", false]);
  assert.deepEqual(kf(14), ["single", "noclaim", "manual", false], "hand-made row of a no-claim game: noclaim by its bucket");
  assert.deepEqual(kf(15), ["single", "claim", "manual", false]);
  // identity, prices and dates from the tracker's own row
  assert.equal(at(1).g, "alpha quest");
  assert.equal(at(1).gl, "Alpha Quest");
  assert.equal(at(1).ck, LISTINGS[0].prepared.id.contentKey);
  assert.equal(at(1).ex, true);
  assert.equal(at(1).smin, 1.5, "DropSet.minPriceUsd");
  assert.equal(at(1).c, NOW - 10 * DAY);
  assert.equal(at(13).rb, NOW - 2 * DAY);
  assert.deepEqual(at(13).units, [{ a: NOW - 9 * DAY, d: NOW - 3 * DAY }, { a: NOW - 9 * DAY, d: null }]);
  assert.equal(at(13).qty, 1, "games.listedUnits: one undelivered unit");
  assert.equal(at(10).qty, 3, "GGSel: lastStock");
  assert.equal(at(6).units.length, I.MAX_UNITS_PER_ROW, "unit dates capped per row");
  assert.equal(b.counts.l_unitsCut, 1);
  assert.equal(b.counts.l_script, 1);
});

test("rows only in the extra read: a rent-farm title, a junk price, a row newer than the report", async () => {
  const { b } = await loadWith();
  const ids = byId(b);
  assert.equal(ids.get(H(11)).kind, "farm", "older than the complete report, no flag, price fine: a rent-farm TITLE");
  assert.equal(ids.get(H(12)).kind, "single", "junk-priced: classified by its flags");
  assert.equal(ids.get(H(12)).g, "alpha quest", "identity from the set the report holds");
  const n16 = ids.get(H(16));
  assert.deepEqual([n16.kind, n16.o, n16.f, n16.g, n16.ck], ["single", "auto", "claim", "", null], "newer than the report, its set unknown");
  assert.deepEqual([b.counts.l_farmByTitle, b.counts.l_junkPrice, b.counts.l_newer, b.counts.l_unexplained], [1, 1, 1, 0]);
  // a truncated tracker read cannot prove the title: classified by flags, and said
  const t = await loadWith({ truncated: true });
  assert.equal(byId(t.b).get(H(11)).kind, "single");
  assert.equal(t.b.counts.l_unexplained, 1);
  assert.ok(t.b.notes.some((x) => /classified by their flags alone/.test(x)));
  assert.ok(t.b.notes.some((x) => /tracker's read hit its row cap/.test(x)));
});

test("the no-claim lister's sales come from UnclaimedAccount, never from the ledger", async () => {
  const { b } = await loadWith();
  const r9 = b.sales.filter((s) => s.lid === H(9));
  assert.equal(r9.length, 1, "the ledger's row sale of row 9 is dropped; u1 is its one sale (u3 hand, u4 elsewhere)");
  assert.deepEqual([r9[0].src, r9[0].basis, r9[0].p, r9[0].o, r9[0].f, r9[0].m, r9[0].t], ["unclaimed", "paid", 2.25, "unclaimed", "noclaim", "gameflip", NOW - DAY]);
  assert.match(r9[0].grp, /^[0-9a-f]{12}$/);
  const r10 = b.sales.filter((s) => s.lid === H(10));
  assert.equal(r10.length, 1);
  assert.deepEqual([r10[0].basis, r10[0].p, r10[0].m], ["row", 2, "ggsel"], "no paid price: the row's price, said so");
  assert.ok(!b.sales.some((s) => s.o === "unclaimed" && s.src !== "unclaimed"), "no ledger sale of an unclaimed row survives");
  assert.equal(b.counts.s_unclaimedDropped, 1);
  assert.equal(b.counts.s_unclaimedDemandDropped, 1, "nor its burst copy in demand-only");
  assert.equal(b.counts.u_elsewhere, 1, "u4 sold on Eldorado: not a sale of the Gameflip row it once sat on");
  assert.equal(b.counts.u_otherRows, 1, "u9 names no no-claim row");
  // the units themselves, de-duplicated across the two reads and whitelisted
  assert.equal(b.noclaim.units.length, Object.keys(UNITS).length);
  const u1 = b.noclaim.units.find((u) => u.p === 2.25);
  assert.deepEqual(Object.keys(u1).sort(), ["bk", "camps", "g", "l", "lids", "m", "p", "s", "sm", "st", "x"]);
  assert.deepEqual(u1.lids, [H(9)]);
  assert.deepEqual(u1.camps, ["Gamma Rush Cup Week 1"]);
  assert.equal(b.noclaim.units.find((u) => u.p === 2 && u.st === "sold").sm, "digiseller", "soldMarket plati → digiseller");
});

test("packs, lots and hand sales are demand only, with the per-account bulk price", async () => {
  const { b } = await loadWith();
  const hand = b.demandOnly.filter((x) => x.src === "hand");
  assert.deepEqual(hand, [{ g: "gamma rush", m: "unknown", f: "noclaim", t: NOW - 3 * DAY, src: "hand" }], "u3: soldMarket manual");
  const lotD = b.demandOnly.filter((x) => x.src === "bulk" && x.m === "gameflip");
  assert.deepEqual(lotD, [{ g: "gamma rush", m: "gameflip", f: "noclaim", t: NOW - 2 * DAY, src: "bulk" }], "u5: a lot unit");
  assert.ok(!b.sales.some((s) => s.lid === H(7)), "a lot never prices a single unit");
  assert.deepEqual(
    b.bulkPrices.filter((x) => x.m === "gameflip"),
    [{ g: "gamma rush", m: "gameflip", t: NOW - 2 * DAY, pa: 1.6, size: 5 }],
  );
  const packD = b.demandOnly.filter((x) => x.src === "bulk" && x.m === "eldorado");
  assert.equal(packD.length, 2, "the ledger's two bulk units");
  assert.deepEqual(
    b.bulkPrices.filter((x) => x.m === "eldorado").map((x) => [x.pa, x.size]),
    [
      [2, 5],
      [2, 5],
    ],
    "pack price ÷ pack size",
  );
  assert.deepEqual(b.demandOnly.filter((x) => x.src === "burst").map((x) => [x.g, x.m, x.f]), [["alpha quest", "gameflip", "claim"]]);
  assert.deepEqual(b.demandOnly.filter((x) => x.src === "shop").map((x) => [x.g, x.m]), [["alpha quest", "shop"]]);
  // a ledger hand sale stays a sale record, unpriced (src hand never prices)
  const h = b.sales.find((s) => s.src === "hand");
  assert.deepEqual([h.lid, h.p, h.basis, h.f, h.m], ["", 0, "none", "noclaim", "digiseller"]);
});

test("a pack unit the ledger already holds is not counted twice", () => {
  const rows = new Map([[ID(6), { raw: ID(6), L: { id: H(6), g: "gamma rush", m: "eldorado", o: "manual", kind: "bulk", pack: 5, lot: 0, p: 10 } }], [ID(9), { raw: ID(9), L: { id: H(9), g: "gamma rush", m: "gameflip", o: "unclaimed", kind: "single", pack: 0, lot: 0, p: 2 } }]]);
  const docs = [unit(21, { status: "sold", soldAt: NOW - DAY, soldMarket: "eldorado", rows: [9, 6] }), unit(22, { status: "sold", soldAt: NOW - DAY, soldMarket: "eldorado", rows: [9, 6] })];
  const out = I.noclaimUnits({ d: { setIdentity }, docs, byId: rows, since: NOW - 30 * DAY, ledgerBulk: new Map([[ID(6), 1]]) });
  assert.equal(out.demandOnly.length, 1, "one of the two pack units is already a ledger bulk record");
  assert.equal(out.counts.packInLedger, 1);
  assert.deepEqual(out.bulkPrices.map((x) => x.pa), [2]);
  assert.equal(out.sales.length, 0);
});

test("plati is digiseller everywhere: radar, feed, ledger, fees, the auto-lister's order", async () => {
  const { b } = await loadWith({ platiTakes: true });
  assert.ok(!JSON.stringify(b).includes("plati"), "no plati anywhere in the bundle");
  const g = b.radar.games[0];
  assert.deepEqual(Object.keys(g.byMarket), ["gameflip", "ggsel", "digiseller"]);
  assert.deepEqual(g.byMarket.digiseller, { perWeek: 1, liveSellers: 1, sold: { n: 1, p25: 1.2, median: 1.3, p75: 2.5 }, medianTtsHours: null });
  assert.deepEqual(
    b.radar.feed.map((x) => x.m),
    ["digiseller", "gameflip"],
    "rivals only: our own sale and the rent-farm sale are out",
  );
  assert.deepEqual(Object.keys(b.radar.feed[0]).sort(), ["g", "m", "n", "p", "t", "tts", "u"]);
  assert.deepEqual(b.old.games["alpha quest"].order, ["gameflip", "digiseller", "eldorado"]);
  assert.equal(b.old.games["alpha quest"].flat.digiseller, 1);
  assert.equal(b.af.takes.digiseller, false, "Digiseller is blocked in venues whatever the switch says");
});

test("demand: the newest farm-brain row per game × farm; the no-claim bucket row split over its games", async () => {
  const { b } = await loadWith();
  const aq = b.demand.filter((r) => r.k === "alpha quest");
  assert.equal(aq.length, 1);
  assert.deepEqual(aq[0], { k: "alpha quest", f: "claim", at: NOW - HOUR, live: true, hl: 30, c: "farm", w: 7, t: 20, on: 6, fl: 2, a30: 6, a45: 5, bu: "", sh: 1 });
  const nc = b.demand.filter((r) => r.f === "noclaim");
  assert.deepEqual(nc.map((r) => r.k), ["gamma rush", "gamma rush origins"]);
  // shares from the bucket's no-claim unit sales in 30 days, as the bundle holds them
  const sold = (g) => b.sales.concat(b.demandOnly).filter((s) => s.f === "noclaim" && s.g === g && s.t >= NOW - 30 * DAY).length;
  const total = sold("gamma rush") + sold("gamma rush origins");
  for (const r of nc) {
    const share = sold(r.k) / total;
    assert.equal(r.sh, Math.round(share * 1000) / 1000);
    assert.equal(r.w, Math.round(10 * share * 100) / 100);
    assert.equal(r.t, Math.round(40 * share * 100) / 100);
    assert.equal(r.bu, "gamma rush");
    assert.equal(r.hl, null);
  }
  assert.ok(Math.abs(nc.reduce((a, r) => a + r.w, 0) - 10) < 0.02, "the split keeps the bucket's forecast");
  // on hand: own listed units + the bucket's remaining stock × share
  const listed = (g) => b.noclaim.units.filter((u) => u.st === "listed" && u.g === g).length;
  const free = 20 - listed("gamma rush") - listed("gamma rush origins");
  for (const r of nc) assert.equal(r.on, Math.round((listed(r.k) + free * (sold(r.k) / total)) * 100) / 100);
  // an equal split when nothing sold
  const eq = I.demandRows({ docs: [{ k: "zed", f: "noclaim", at: new Date(NOW), br: { w: 4 }, stk: { on: 2 } }], keywords: ["zed"], units: [{ g: "zed one", st: "listed" }, { g: "zed two", st: "skipped" }], now: NOW });
  assert.deepEqual(eq.map((r) => [r.k, r.w, r.sh, r.on]), [["zed one", 2, 0.5, 1.5], ["zed two", 2, 0.5, 0.5]]);
});

test("waves: the no-claim games' waves from the pure event catalog", async () => {
  const { b, deps } = await loadWith();
  assert.deepEqual(b.noclaim.waves, [
    { g: "gamma rush", ev: "Gamma Rush Cup", wave: "Week 1", startAt: NOW - 10 * DAY, endAt: NOW - 2 * DAY },
    { g: "gamma rush", ev: "Gamma Rush Cup", wave: "Week 2", startAt: NOW - DAY, endAt: NOW + 3 * DAY },
  ]);
  assert.equal(typeof deps.unclaimedBundles.loadCatalog, "function", "present, and never called (it would throw)");
});

/* ---------------------------------- old side ---------------------------------- */

test("old side per claim game: derivePrice on the matched research, GGSel venue price, split, flat deal, order", async () => {
  const { b, seen } = await loadWith();
  const aq = b.old.games["alpha quest"];
  assert.deepEqual(aq, { base: 2, ggsel: 1.6, post: 3, split: { listNow: 3, holdBack: 3 }, flat: { gameflip: 2, eldorado: 1 }, order: ["gameflip", "eldorado"], rm: "exact" });
  const ba = b.old.games["beta arena"];
  assert.deepEqual(ba, { base: 1, ggsel: 0.8, post: 1.5, split: { listNow: 2, holdBack: 1 }, flat: { gameflip: 1, eldorado: 1, g2g: 0 }, order: ["gameflip", "eldorado", "g2g"], rm: "none" }, "G2G only where the brand table knows the game; no research → derivePrice(null)");
  assert.ok(seen.derive.includes("Alpha Quest"));
  assert.deepEqual(Object.keys(b.old.games).sort(), ["alpha quest", "beta arena", "delta 1", "delta 2", "delta 3", "delta 4", "delta 5", "delta 6", "delta 7", "delta 8"]);
  assert.ok(!b.old.games["gamma rush"], "a no-claim game has no claim-side old row");
  assert.ok(seen.venue.every((v) => v.m === "ggsel" && !/farm/i.test(v.title)));
  // the switches today's lister reads
  assert.deepEqual(b.af.takes, { gameflip: true, digiseller: false, ggsel: true, zeusx: false, eldorado: true, playerauctions: false, g2g: true });
  assert.deepEqual(b.af.mapped["beta arena"], { gameflip: true, digiseller: true, eldorado: true, ggsel: false, g2g: true, zeusx: false, playerauctions: false });
  // GGSel joins the order with a fallback category, or for a game we have listed there
  const withCat = await loadWith({ af: { ggselCategoryId: "123" } });
  assert.deepEqual(withCat.b.old.games["alpha quest"].order, ["gameflip", "ggsel", "eldorado"]);
  assert.equal(withCat.b.af.mapped["alpha quest"].ggsel, true);
});

test("old side per offer: today's new-listing price and the tracker's answer, slim", async () => {
  const { b, seen } = await loadWith();
  const ck1 = LISTINGS[0].prepared.id.contentKey;
  assert.deepEqual(b.old.offers["gameflip|" + ck1], { np: 2, tracker: { price: 1.6, basis: "this game sold on this market", confidence: "medium" } });
  assert.equal(b.old.offers["eldorado|" + ck1].np, 2, "max(base, the Eldorado floor)");
  assert.equal(b.old.offers["zeusx|" + ck1].np, 2);
  // no-claim: bundlePrice with the ci-matched research, the set's items and the catalog's classification
  const ckG = LISTINGS[8].prepared.id.contentKey;
  const catalog = unclaimedBundles.buildEventCatalog(CAMPAIGNS, MANIFESTS);
  const drops = SETS.G1.items.map((i) => ({ name: i.name, game: i.game, campaign: "", itemKey: i.itemKey }));
  const cls = unclaimedBundles.classifyHoldings("Gamma Rush", drops, catalog, NOW);
  assert.equal(cls.full, true, "both waves held");
  const pricing = { floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: { "gamma rush": 1 }, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25 };
  const expected = unclaimedBundles.bundlePrice({ research: RESEARCH[1], game: "Gamma Rush", items: SETS.G1.items.map((i) => ({ itemKey: i.itemKey, name: i.name, qty: i.qty })), classification: cls, pricing, soldFloorUsd: 0 }).price;
  const flatPrice = unclaimedBundles.bundlePrice({ research: RESEARCH[1], game: "Gamma Rush", items: SETS.G1.items, classification: null, pricing }).price;
  assert.ok(expected > flatPrice, "the full-event bonus is in");
  assert.equal(b.old.offers["gameflip|" + ckG].np, expected);
  assert.equal(b.old.offers["ggsel|" + ckG].np, expected, "one set price on every no-claim market");
  // the tracker was asked with the market, the game label and the set's items
  const q = seen.suggest.find((x) => x.market === "gameflip" && x.game === "Alpha Quest");
  assert.deepEqual(q.items, [
    { itemKey: "aq-sword", game: "Alpha Quest", qty: 1 },
    { itemKey: "aq-shield", game: "Alpha Quest", qty: 1 },
  ]);
  // one offer per (market, exact items or band) of a plain or claim-at-sale row with a game; farm,
  // bulk, lot and account rows are never offers
  const want = new Set(b.listings.filter((L) => L.g && (L.kind === "single" || L.kind === "cas")).map((L) => L.m + "|" + (L.ck || L.bk)));
  assert.deepEqual(Object.keys(b.old.offers).sort(), [...want].sort());
  assert.ok(!Object.keys(b.old.offers).some((k) => k.startsWith("eldorado|") && k.endsWith(byId(b).get(H(6)).bk)), "the bulk pack is not an offer");
});

test("venuePrice runs one warm-up call alone, then at most 3 at a time with yields", async () => {
  const { seen } = await loadWith();
  assert.equal(seen.venue.length, 10, "one call per claim game with a base price");
  assert.ok(seen.venueMax <= I.OLD_CONCURRENCY, "at most " + I.OLD_CONCURRENCY + " at once, saw " + seen.venueMax);
  assert.deepEqual(seen.venueOrder.slice(0, 2), ["start", "end"], "the first call fills the snapshot before any other starts");
});

test("venuePrice failure: null and a note, and no stampede on a cold snapshot", async () => {
  const { b, seen } = await loadWith({ venueFails: true });
  for (const og of Object.values(b.old.games)) assert.equal(og.ggsel, null);
  const n = b.notes.find((x) => /GGSel venue price unreadable/.test(x));
  assert.ok(n, b.notes.join(" | "));
  assert.match(n, /the rest were not tried/);
  assert.ok(!/example\.net|mongodb:/.test(n), "no host in the note: " + n);
  assert.equal(seen.venue.length, 1, "after the warm-up failed, no further call");
  assert.equal(b.counts.venueFailed, 10);
  // a call that never answers is cut at the per-call timeout
  const h = await loadWith({ venueHangs: true }, { venueTimeoutMs: 20 });
  assert.equal(h.b.old.games["alpha quest"].ggsel, null);
  assert.ok(h.b.notes.some((x) => /took longer than/.test(x)), h.b.notes.join(" | "));
  assert.equal(h.b.old.offers["gameflip|" + LISTINGS[0].prepared.id.contentKey].np, 2, "the other markets' prices stand");
});

/* ------------------------------- bundle files ------------------------------- */

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lbi-")), name);
}

test("loadFromBundle reads back what the export writes; a bad file throws one clear error", async () => {
  const { b } = await loadWith();
  const good = tmpFile("bundle.json");
  fs.writeFileSync(good, JSON.stringify(b));
  assert.deepEqual(I.loadFromBundle(good), b);
  assert.throws(() => I.loadFromBundle(""), /no file given/);
  assert.throws(() => I.loadFromBundle(path.join(os.tmpdir(), "no-such-listing-brain-bundle.json")), /cannot read .*ENOENT/);
  const notJson = tmpFile("x.json");
  fs.writeFileSync(notJson, "{ not json");
  assert.throws(() => I.loadFromBundle(notJson), /is not JSON/);
  const wrongKind = tmpFile("k.json");
  fs.writeFileSync(wrongKind, JSON.stringify({ kind: "something-else", v: 1 }));
  assert.throws(() => I.loadFromBundle(wrongKind), /is not a listing-brain bundle \(kind "something-else"\)/);
  const wrongV = tmpFile("v.json");
  fs.writeFileSync(wrongV, JSON.stringify({ ...b, v: 2 }));
  assert.throws(() => I.loadFromBundle(wrongV), /is version 2; this code reads v1/);
  const broken = tmpFile("b.json");
  fs.writeFileSync(broken, JSON.stringify({ ...b, sales: [{ m: "plati", t: "yesterday", p: -1, f: "x", src: "?" }] }));
  assert.throws(() => I.loadFromBundle(broken), /failed validation/);
});

test("privacyScan names every forbidden key and every raw database id", () => {
  const dirty = { listings: [{ id: "abc", units: [{ login: "x" }] }], sales: [{ lid: ID(1) }], radar: { feed: [{ seller: "s", sellerName: "n" }] }, note: "n", nested: { _id: 1, deeper: [{ externalId: "e", orderId: "o", dedupeKey: "d" }] } };
  assert.deepEqual(I.privacyScan(dirty).sort(), [
    "listings[0].units[0].login",
    "nested._id",
    "nested.deeper[0].dedupeKey",
    "nested.deeper[0].externalId",
    "nested.deeper[0].orderId",
    "note",
    "radar.feed[0].seller",
    "radar.feed[0].sellerName",
    "sales[0].lid (raw database id)",
  ]);
  assert.deepEqual(I.privacyScan({ a: [1, "two", { b: null }] }), []);
});

test("validateBundle names what is not plain JSON, an unknown market and a bad enum", async () => {
  const { b } = await loadWith();
  const bad = JSON.parse(JSON.stringify(b));
  bad.now = new Date(NOW);
  bad.listings[0].m = "plati";
  bad.listings[1].kind = "weird";
  bad.sales[0].p = NaN;
  bad.radar.feed[0].m = "plati";
  bad.extra = new Map();
  bad.old.games["alpha quest"].order = ["gameflip", "plati"];
  const p = I.validateBundle(bad);
  for (const re of [/now is not a millisecond/, /listings\[0\]\.m is not a market key: "plati"/, /listings\[1\]\.kind is unknown/, /sales\[0\]\.p is not a finite number/, /radar\.feed\[0\]\.m/, /extra is not plain JSON \(Map\)/, /old\.games\.alpha quest\.order/]) {
    assert.ok(p.some((x) => re.test(x)), re + " in " + p.join(" | "));
  }
  assert.deepEqual(I.validateBundle(null), ["the bundle is not an object"]);
});

test("the export script refuses to write a bundle that fails privacyScan or validateBundle", async () => {
  const { b } = await loadWith();
  const fakeInputs = (bundle) => ({ load: async () => bundle, privacyScan: I.privacyScan, validateBundle: I.validateBundle });
  const lines = [];
  const dirty = JSON.parse(JSON.stringify(b));
  dirty.listings[0].login = "someone";
  const out1 = tmpFile("dirty.json");
  const r1 = await EXPORT.exportBundle({ inputs: fakeInputs(dirty), now: NOW, out: out1, log: (s) => lines.push(s) });
  assert.equal(r1.written, false);
  assert.ok(!fs.existsSync(out1), "nothing written");
  assert.ok(lines.some((s) => /REFUSED/.test(s)));
  const invalid = JSON.parse(JSON.stringify(b));
  invalid.kind = "nope";
  const out2 = tmpFile("invalid.json");
  assert.equal((await EXPORT.exportBundle({ inputs: fakeInputs(invalid), now: NOW, out: out2, log: () => {} })).written, false);
  assert.ok(!fs.existsSync(out2));
  const out3 = tmpFile("good.json");
  const r3 = await EXPORT.exportBundle({ inputs: fakeInputs(b), now: NOW, out: out3, log: () => {} });
  assert.equal(r3.written, true);
  assert.deepEqual(I.loadFromBundle(out3), b);
  await assert.rejects(EXPORT.exportBundle({ inputs: fakeInputs(b), now: NOW, out: out3, log: () => {} }), /EEXIST/, "never over an existing file");
  assert.equal(EXPORT.argValue(["--out", "x.json"], "--out"), "x.json");
  assert.equal(EXPORT.argValue(["--out=y.json"], "--out"), "y.json");
  assert.match(EXPORT.defaultOut(NOW), /^listing-brain-bundle-20261010-120000\.json$/);
});

/* --------------------------------- pure pieces --------------------------------- */

test("listedUnits is the tracker's games.listedUnits, verbatim", () => {
  const rows = [
    { marketplace: "eldorado", units: [{ deliveredAt: null }, { deliveredAt: new Date() }] },
    { marketplace: "g2g", units: [] },
    { marketplace: "playerauctions", units: [{ deliveredAt: new Date() }] },
    { marketplace: "ggsel", lastStock: 4, units: [] },
    { marketplace: "ggsel", lastStock: null, units: [{}, {}], qtyTarget: 9 },
    { marketplace: "digiseller", qtyTarget: 7 },
    { marketplace: "digiseller" },
    { marketplace: "gameflip", qtyRemaining: 5 },
    { marketplace: "zeusx", qtyTarget: 3 },
  ];
  for (const r of rows) assert.equal(I.listedUnits(r), G.listedUnits(r), JSON.stringify(r));
});

test("kindOf / farmOf / bucketOfKey / trackerMarket / cleanMsg", () => {
  assert.equal(I.kindOf({ rentFarm: true, bulkOfferId: "x" }), "farm");
  assert.equal(I.kindOf({ bulkPackSize: 3 }), "bulk");
  assert.equal(I.kindOf({ lotSize: 5, noclaimStock: true }), "lot");
  assert.equal(I.kindOf({ accountOffer: "x", autoClaimSet: true }), "account");
  assert.equal(I.kindOf({ autoClaimSet: true, origin: "auto" }), "cas");
  assert.equal(I.kindOf({}, "farm"), "farm");
  assert.equal(I.kindOf({}), "single");
  const kw = ["gamma", "gamma rush"];
  assert.equal(I.bucketOfKey("gamma rush origins", kw), "gamma rush", "the longest keyword");
  assert.equal(I.bucketOfKey("alpha", kw), "");
  assert.equal(I.farmOf({ origin: "auto", autoClaimSet: true }, "x", kw), "claim");
  assert.equal(I.farmOf({ origin: "auto", noclaimStock: true }, "x", kw), "noclaim");
  assert.equal(I.farmOf({ origin: "unclaimed" }, "alpha", kw), "noclaim");
  assert.equal(I.farmOf({}, "gamma rush 2", kw), "noclaim");
  assert.equal(I.farmOf({}, "alpha", kw), "claim");
  assert.equal(I.trackerMarket(" Plati "), "digiseller");
  assert.equal(I.trackerMarket("GGSel"), "ggsel");
  const m = I.cleanMsg(new Error("connect ECONNREFUSED 10.0.0.5:27017 at mongodb://user:pw@db.example.net/x for " + ID(3) + " in /srv/app/utils/x.js, host cluster0.abc.example.net and localhost:27017"));
  for (const bad of ["10.0.0.5", "mongodb://", "example.net", ID(3), "/srv/app", "localhost"]) assert.ok(!m.includes(bad), bad + " in " + m);
  assert.equal(I.cleanMsg(new Error("d.MarketResearch.find is not a function")), "d.MarketResearch.find is not a function");
});

test("zeusxMapped is the auto-lister's zeusxGameMapped, verbatim", () => {
  const af = { zeusxGames: { "alpha quest": "cat-1", beta: "cat-2" } };
  assert.equal(I.zeusxMapped(af, "Alpha Quest"), true);
  assert.equal(I.zeusxMapped(af, "Beta Arena"), true, "either-way substring");
  assert.equal(I.zeusxMapped(af, "Gamma"), false);
  assert.equal(I.zeusxMapped({}, "Alpha Quest"), false);
});

test("mapLimit keeps the order and the limit", async () => {
  let inflight = 0;
  let max = 0;
  const out = await I.mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    inflight++;
    max = Math.max(max, inflight);
    await new Promise((r) => setImmediate(r));
    inflight--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(max <= 3);
});

/* -------------------------------- source rules -------------------------------- */

const SRC_PATH = path.join(__dirname, "..", "utils", "listingBrain", "inputs.js");
// Comments stripped (block and line): the loader's comments name the functions it must never call.
const SRC = fs
  .readFileSync(SRC_PATH, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\s\/\/.*$/gm, "");

test("source: no skip, no allowDiskUse, no new: true, no write, no marketplace call", () => {
  for (const bad of [
    /\.skip\(/,
    /allowDiskUse/,
    /new:\s*true/,
    /\.save\(/,
    /\.create\(/,
    /updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate/,
    /insertMany|insertOne|deleteOne|deleteMany|bulkWrite|replaceOne/,
    /\$group/,
    /\.aggregate\(/,
    /axios|fetch\(/,
    /child_process|\bssh\b|botHosts/,
    /setAutoFarm|saveSettings/,
    /listActivatedTask|refillMarkets|onCampaignEnded|retryMissingSecondaries|freshResearchForGame|loadCatalog|soldFloorForSet|repriceUnclaimedRows|gameflipCodeHeldLogins|pickDeliveryAccounts/,
    /Date\.now\(\)\s*-/,
  ]) {
    assert.ok(!bad.test(SRC), "inputs.js matches " + bad);
  }
});

test("source: every .find( is followed by .limit( in the same chain", () => {
  const re = /\.find\(/g;
  let m;
  let n = 0;
  while ((m = re.exec(SRC))) {
    n++;
    const end = SRC.indexOf(";", m.index);
    const chain = SRC.slice(m.index, end);
    assert.ok(/\.limit\(/.test(chain), "a .find( without .limit(: " + chain.slice(0, 120));
    assert.ok(/\.lean\(\)/.test(chain), "a .find( without .lean(): " + chain.slice(0, 120));
  }
  assert.equal(n, 7, "the seven reads of plan §2 (units twice)");
});

test("source: nothing but crypto and fs is required outside realDeps(), and realDeps loads no connector directly", () => {
  const start = SRC.indexOf("function realDeps()");
  assert.ok(start > 0);
  // realDeps' body ends at the first line that is exactly "}"
  const end = SRC.indexOf("\n}\n", start);
  const body = SRC.slice(start, end);
  const outside = SRC.slice(0, start) + SRC.slice(end);
  const reqs = [...outside.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((x) => x[1]).sort();
  assert.deepEqual(reqs, ["crypto", "fs"]);
  const inside = [...body.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((x) => x[1]).sort();
  assert.deepEqual(inside, [
    "../../models/CampaignDrops",
    "../../models/DemandBrainRow",
    "../../models/MarketResearch",
    "../../models/MarketplaceListing",
    "../../models/TwitchCampaign",
    "../../models/UnclaimedAccount",
    "../autoLister",
    "../g2gGames",
    "../marketData/report",
    "../priceTracker",
    "../priceTracker/setIdentity",
    "../priceTracker/venues",
    "../settings",
    "../unclaimedBundles",
  ]);
  for (const bad of [/marketplaces/, /Fulfiller/i, /unclaimedAutoList/, /unclaimedListingAudit/, /noclaimOfferRotation/, /pricingEvidence/]) assert.ok(!bad.test(body), "realDeps requires " + bad);
});

test("requiring the loader loads no other module (no model, no settings, no timer)", () => {
  delete require.cache[require.resolve(SRC_PATH)];
  const before = new Set(Object.keys(require.cache));
  require(SRC_PATH);
  const added = Object.keys(require.cache).filter((k) => !before.has(k));
  assert.deepEqual(added, [require.resolve(SRC_PATH)]);
});

test("the export script is read-only and says who runs it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "listing-brain-export.js"), "utf8");
  assert.match(src, /You never run this here; the owner reviews and runs it\./);
  assert.match(src, /autoIndex: false, autoCreate: false/);
  assert.match(src, /privacyScan\(bundle\)/);
  assert.match(src, /validateBundle\(bundle\)/);
  assert.match(src, /flag: "wx"/);
  const code = src.replace(/\/\/.*$/gm, "");
  for (const bad of [/\.save\(/, /\.create\(/, /updateOne|updateMany|findOneAndUpdate/, /insertMany|deleteOne|deleteMany|bulkWrite|dropDatabase|\.drop\(/, /require\([^)]*marketplaces[^)]*\)/, /axios|fetch\(/, /setAutoFarm|saveSettings/]) {
    assert.ok(!bad.test(code), "the export script matches " + bad);
  }
});
