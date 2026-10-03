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
const PACK = require("../utils/bulkPacks/packMath");
const MU = require("../utils/listingBrain/model/util");
const E = require("../utils/listingBrain/model/evidence");
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
  return (filter, projection, options) => {
    const call = { name, filter, projection, options, sort: null, limit: null, lean: false, skipped: false };
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
  const title = o.title || (o.game ? o.game + " Twitch Drops" : "");
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
    // read for classifyKind in memory only (plan §3 rent-farm by title); never copied
    title,
    // never projected by the loader; a careless spread would leak them
    accountLogin: "secret_login_" + n,
    note: "auto-farm: automatic delivery — secret_login_" + n,
    externalId: "EXT-" + n,
  };
  const l = { ...x, units: (o.units || []).map((u) => ({ deliveredAt: u.deliveredAt || null, orderId: u.orderId || "", login: "secret_unit_login" })) };
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
  listing(11, { m: "gameflip", origin: "manual", price: 3, created: NOW - 20 * DAY, prepared: false, title: "Rental auto farm 7 days" }),
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
        return over.radar || radarReport();
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
      find: (filter, projection, options) => {
        if (over.unitsFail) return query(new Error("units down"), calls, "units")(filter, projection, options);
        const sold = filter.status === "sold";
        // the same document comes back from both reads (u1 is sold and listed in the window)
        const rows = sold ? unitDocs.filter((u) => u.status === "sold") : unitDocs.filter((u) => u.listedAt);
        return query(rows, calls, sold ? "unitsSold" : "unitsListed")(filter, projection, options);
      },
    },
    TwitchCampaign: { find: query(over.campaignsFail ? new Error("campaigns down") : over.campaigns || CAMPAIGNS, calls, "campaigns") },
    CampaignDrops: { find: query(over.manifests || MANIFESTS, calls, "manifests") },
    // the event-bundle marker of the claim auto rows' sets (C13): {_id, sourceType, sourceEventKey}
    DropSet: { find: query(over.dropSetsFail ? new Error("sets down") : over.dropSets || [], calls, "dropSets") },
    MarketResearch: { find: query(over.researchFail ? new Error("research down") : RESEARCH, calls, "research") },
    DemandBrainRow: { find: query(over.demandRows || (over.demandFail ? new Error("rows down") : DEMAND_ROWS), calls, "demand") },
    // the model's own config reader (pure): which keys the bundle keeps, how far back demand rows are read
    listingModel: { readConfig: MU.readConfig, DEFAULTS: MU.DEFAULTS },
    // the tracker's own counting rule and bulkPacks' pack size (both pure)
    games: over.games === undefined ? { listedUnits: G.listedUnits } : over.games,
    packMath: { packSizeOf: PACK.packSizeOf },
    // pricingEvidence's cached snapshot (GGSel's venue factor, the event-bundle pricer): warmed once
    pricingEvidence: {
      snapshot: async () => {
        seen.snapshot = (seen.snapshot || 0) + 1;
        if (over.snapshotFails) throw new Error("snapshot read failed at db01.example.invalid:27017");
        if (over.snapshotHangs) return new Promise(() => {});
        return { ok: true };
      },
    },
    autoFarmBundles: {
      SOURCE_TYPE: "autofarm-bundle",
      priceBundle: async (o) => {
        (seen.priceBundle = seen.priceBundle || []).push(o);
        if (over.priceBundleNull) return null;
        return { price: 4.25, basis: "platformGame" };
      },
    },
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
  // plus the event-bundle marker of the claim auto rows' sets (C13)
  assert.deepEqual(db.map((c) => c.name).sort(), ["campaigns", "demand", "dropSets", "listings", "manifests", "research", "unitsListed", "unitsSold"]);
  for (const c of db) {
    assert.ok(c.projection && Object.keys(c.projection).length > 0, c.name + " is projected");
    assert.ok(Number.isInteger(c.limit) && c.limit > 0, c.name + " is limited");
    assert.equal(c.lean, true, c.name + " is lean");
    assert.equal(c.skipped, false, c.name + " never skips");
  }
  const get = (n) => calls.find((c) => c.name === n);
  const L = get("listings");
  assert.deepEqual(L.projection, { ...I.LISTING_PROJECTION });
  // the title is read for classifyKind in memory (L13); no bundle ever holds it (the plain-JSON test)
  assert.ok(!("units.login" in L.projection) && !("accountLogin" in L.projection) && !("note" in L.projection));
  // the tracker's own shape (P20-7): the active / saleDays window is applied in memory
  assert.deepEqual(L.filter, { marketplace: { $in: I.MARKETS } });
  assert.equal(W.saleDays, 222);
  assert.deepEqual(L.sort, { _id: -1 });
  assert.equal(L.limit, I.LISTING_CAP);
  const UL = get("unitsListed");
  const US = get("unitsSold");
  assert.deepEqual(UL.projection, { ...I.UNIT_PROJECTION });
  assert.ok(!("login" in UL.projection) && !("loginLower" in UL.projection) && !("poolAccountId" in UL.projection));
  assert.equal(UL.filter.listedAt.$gte.getTime(), NOW - (60 + I.BACKTEST_PAD_DAYS + I.UNIT_LISTED_PAD_DAYS) * DAY);
  assert.deepEqual(Object.keys(US.filter).sort(), ["$or", "soldAt", "status"]);
  assert.equal(US.filter.status, "sold");
  assert.equal(US.filter.soldAt.$gte.getTime(), NOW - W.saleDays * DAY);
  assert.equal(UL.limit, I.UNIT_CAP);
  assert.equal(US.limit, I.UNIT_CAP);
  const C = get("campaigns");
  assert.deepEqual(C.projection, { campaignId: 1, name: 1, game: 1, startAt: 1, endAt: 1 });
  assert.equal(C.filter.$or[0].endAt.$gte.getTime(), NOW - I.CAMPAIGN_WINDOW_DAYS * DAY);
  assert.deepEqual(C.filter.$or[1], { endAt: null });
  assert.equal(C.limit, I.CAMPAIGN_CAP);
  const M = get("manifests");
  assert.deepEqual(M.filter, { campaignId: { $in: ["cmp1", "cmp2", "cmp3"] } });
  assert.deepEqual(M.projection, { campaignId: 1, name: 1, game: 1, "drops.itemKey": 1, "drops.name": 1 });
  assert.equal(M.limit, I.ID_CHUNK, "chunks of ids, each limited");
  const R = get("research");
  assert.deepEqual(R.filter, {});
  assert.deepEqual(R.projection, { game: 1, "markets.gameflip": 1, "markets.ggsel": 1, "markets.plati": 1, scannedAt: 1 });
  assert.equal(R.limit, I.RESEARCH_CAP);
  const D = get("demand");
  assert.equal(D.filter.at.$gte.getTime(), NOW - 7 * HOUR, "the model's maxDemandAgeH (6 h) + 1 h");
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
  assert.equal(b.af.eldoradoKeepAlive, true, "the Eldorado keep-alive is on unless the setting says false");
});

test("the bundle says when the Eldorado keep-alive is off, and only an explicit false turns it off", async () => {
  const off = await loadWith({ af: { eldoradoKeepAlive: false } });
  assert.equal(off.b.af.eldoradoKeepAlive, false);
  assert.deepEqual(I.validateBundle(off.b), []);
  for (const v of [true, undefined, null, 0, "false"]) {
    const { b } = await loadWith({ af: { eldoradoKeepAlive: v } });
    assert.equal(b.af.eldoradoKeepAlive, true, "eldoradoKeepAlive " + JSON.stringify(v) + " keeps it on, like eldoradoFulfiller");
  }
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
  // a truncated tracker read: the fresh title still proves a rent-farm row; a row with no reason the
  // loader can see is classified by its flags, and said
  const plain = listing(17, { m: "gameflip", origin: "manual", price: 3, created: NOW - 20 * DAY, prepared: false, title: "Alpha Quest Twitch Drops" });
  const t = await loadWith({ truncated: true, listingRows: LISTINGS.map((r) => r.x).concat([plain.x]) });
  assert.equal(byId(t.b).get(H(11)).kind, "farm");
  assert.equal(byId(t.b).get(H(17)).kind, "single");
  assert.equal(t.b.counts.l_unexplained, 1);
  assert.ok(t.b.notes.some((x) => /classified by their flags alone/.test(x) && /hit its cap/.test(x)), t.b.notes.join(" | "));
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
  assert.deepEqual(Object.keys(u1).sort(), ["bk", "camps", "g", "l", "lids", "m", "p", "s", "sm", "st", "u", "x"]);
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
  const pack = { id: H(6), g: "gamma rush", m: "eldorado", o: "manual", kind: "bulk", pack: 5, lot: 0, p: 10, c: NOW - 20 * DAY };
  const single = { id: H(9), g: "gamma rush", m: "gameflip", o: "unclaimed", kind: "single", pack: 0, lot: 0, p: 2, c: NOW - 20 * DAY };
  const rows = new Map([[ID(6), { raw: ID(6), L: pack }], [ID(9), { raw: ID(9), L: single }]]);
  const docs = [unit(21, { status: "sold", soldAt: NOW - DAY, soldMarket: "eldorado", rows: [9, 6] }), unit(22, { status: "sold", soldAt: NOW - DAY, soldMarket: "eldorado", rows: [9, 6] })];
  // an owner's v2 pack (origin manual): its sales are the ledger's bulk records, never the units'
  const out = I.noclaimUnits({ d: { setIdentity }, docs, byId: rows, since: NOW - 30 * DAY, ledgerBulk: new Map([[ID(6), 1]]) });
  assert.deepEqual([out.demandOnly.length, out.sales.length, out.counts.elsewhere], [0, 0, 2]);
  // a no-claim pack row the ledger already counted is not added again
  const nc = new Map([[ID(6), { raw: ID(6), L: { ...pack, o: "unclaimed" } }], [ID(9), { raw: ID(9), L: single }]]);
  const out2 = I.noclaimUnits({ d: { setIdentity }, docs, byId: nc, since: NOW - 30 * DAY, ledgerBulk: new Map([[ID(6), 1]]) });
  assert.equal(out2.demandOnly.length, 1, "one of the two pack units is already a ledger bulk record");
  assert.equal(out2.counts.packInLedger, 1);
  assert.deepEqual(out2.bulkPrices.map((x) => x.pa), [2]);
  assert.equal(out2.sales.length, 0);
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
  assert.equal(b.old.games["alpha quest"].flat.digiseller, 2, "dealt 1, topped up by refillMarkets' rule (C12)");
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
  // nothing sold in 30 days: no basis to split by, so no row (M10b)
  const eq = I.demandRows({ docs: [{ k: "zed", f: "noclaim", at: new Date(NOW), br: { w: 4 }, stk: { on: 2 } }], keywords: ["zed"], units: [{ g: "zed one", st: "listed" }, { g: "zed two", st: "skipped" }], now: NOW });
  assert.deepEqual(eq, []);
});

test("waves: the no-claim games' waves from the pure event catalog", async () => {
  const { b, deps } = await loadWith();
  // every game's waves (C3): the claim game Alpha Quest's campaign too
  assert.deepEqual(b.noclaim.waves, [
    { g: "alpha quest", ev: "Alpha Quest Launch", wave: "Alpha Quest Launch", name: "Alpha Quest Launch", startAt: NOW - 5 * DAY, endAt: NOW + 5 * DAY },
    { g: "gamma rush", ev: "Gamma Rush Cup", wave: "Week 1", name: "Gamma Rush Cup Week 1", startAt: NOW - 10 * DAY, endAt: NOW - 2 * DAY },
    { g: "gamma rush", ev: "Gamma Rush Cup", wave: "Week 2", name: "Gamma Rush Cup Week 2", startAt: NOW - DAY, endAt: NOW + 3 * DAY },
  ]);
  assert.equal(typeof deps.unclaimedBundles.loadCatalog, "function", "present, and never called (it would throw)");
});

/* ---------------------------------- old side ---------------------------------- */

test("old side per claim game: derivePrice on the matched research, GGSel venue price, split, flat deal, order", async () => {
  const { b, seen } = await loadWith();
  const aq = b.old.games["alpha quest"];
  // flat: dealt gameflip 2, eldorado 1, then Gameflip topped back up to perMarketStock 3 (C12)
  assert.deepEqual(aq, { base: 2, ggsel: 1.6, post: 3, split: { listNow: 3, holdBack: 3 }, flat: { gameflip: 3, eldorado: 1 }, order: ["gameflip", "eldorado"], rm: "exact" });
  const ba = b.old.games["beta arena"];
  assert.deepEqual(ba, { base: 1, ggsel: 0.8, post: 1.5, split: { listNow: 2, holdBack: 1 }, flat: { gameflip: 2, eldorado: 1, g2g: 0 }, order: ["gameflip", "eldorado", "g2g"], rm: "none" }, "G2G only where the brand table knows the game; no research → derivePrice(null); Gameflip topped up while the 3 on hand last");
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
  assert.match(path.basename(EXPORT.defaultOut(NOW)), /^listing-brain-bundle-20261010-120000\.json$/);
});

/* --------------------------------- pure pieces --------------------------------- */

test("kindOf / farmOf / bucketOfKey / trackerMarket / cleanMsg", () => {
  assert.equal(I.kindOf({ rentFarm: true, bulkOfferId: "x" }), "farm");
  assert.equal(I.kindOf({ bulkPackSize: 3, bulkOfferId: "x" }), "bulk");
  assert.equal(I.kindOf({ bulkPackSize: 3 }), "single", "packMath's rule: no bulkOfferId, no pack (C9)");
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
  assert.equal(n, 8, "the eight reads of plan §2 (units twice; the event-bundle marker of the sets)");
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
    "../../models/DropSet",
    "../../models/MarketResearch",
    "../../models/MarketplaceListing",
    "../../models/TwitchCampaign",
    "../../models/UnclaimedAccount",
    "../autoFarmBundles",
    "../autoLister",
    "../bulkPacks/packMath",
    "../g2gGames",
    "../marketData/report",
    "../priceTracker",
    "../priceTracker/games",
    "../priceTracker/setIdentity",
    "../priceTracker/venues",
    "../pricingEvidence",
    "../settings",
    "../unclaimedBundles",
    "./model/util",
  ]);
  // pricingEvidence is a cached read (its snapshot is warmed once per run, P20-6): allowed, read-only
  for (const bad of [/marketplaces/, /Fulfiller/i, /unclaimedAutoList/, /unclaimedListingAudit/, /noclaimOfferRotation/]) assert.ok(!bad.test(body), "realDeps requires " + bad);
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

/* ------------------------- review findings: the loader (L1–L13) ------------------------- */

// A no-claim row the loader knows (a byId entry, the shape normaliseListings builds).
function ncRow(n, o = {}) {
  const L = {
    id: H(n),
    g: "gamma rush",
    gl: "Gamma Rush",
    m: o.m || "gameflip",
    o: o.o || "unclaimed",
    f: "noclaim",
    kind: o.kind || "single",
    ck: "s:gr",
    bk: "gamma rush|2",
    ex: true,
    n: 2,
    p: o.p === undefined ? 2 : o.p,
    c: o.c === undefined ? NOW - 10 * DAY : o.c,
    pack: o.pack || 0,
    lot: o.lot || 0,
  };
  return [ID(n), { raw: ID(n), L }];
}
const ncUnits = (rows, docs, extra = {}) => I.noclaimUnits({ d: { setIdentity }, docs, byId: new Map(rows), since: NOW - 222 * DAY, ...extra });

test("L1 a re-listed unit's stale expiredAt (older than its listedAt) is not carried into U.x", () => {
  const relisted = unit(31, { status: "listed", listedAt: new Date(NOW - 5 * DAY), expiredAt: NOW - 40 * DAY, rows: [9] });
  const expired = unit(32, { status: "expired", listedAt: new Date(NOW - 50 * DAY), expiredAt: NOW - 40 * DAY, rows: [9] });
  const out = ncUnits([ncRow(9)], [relisted, expired]);
  assert.equal(out.units[0].x, null, "expireAccount's stamp from the unit's previous life");
  assert.equal(out.units[1].x, NOW - 40 * DAY, "a real expiry stays");
  const ev = E.buildEvidence({ now: NOW, noclaim: { units: out.units, waves: [] } }, { cfg: MU.readConfig({}) });
  assert.deepEqual(
    ev.noclaim.units.map((u) => u.stc),
    ["listed", "expired"],
    "the unit on sale now reads live",
  );
});

test("L2 a unit's sale is booked on the newest named no-claim row of its sold market created before the sale", () => {
  // a GGSel set rebuilt twice: v1 (30 d), v2 (10 d), v3 (1 d, after the sale) — every id $addToSet on the unit
  const rows = [ncRow(41, { m: "ggsel", c: NOW - 30 * DAY }), ncRow(42, { m: "ggsel", c: NOW - 10 * DAY }), ncRow(43, { m: "ggsel", c: NOW - DAY })];
  const u = unit(41, { status: "sold", market: "ggsel", soldMarket: "ggsel", soldAt: NOW - 3 * DAY, paid: 1.5, rows: [41, 42, 43] });
  assert.deepEqual(
    ncUnits(rows, [u]).sales.map((s) => s.lid),
    [H(42)],
    "v2: the newest row that existed when it sold",
  );
  const flipped = { ...u, listingIds: [ID(43), ID(42), ID(41)] };
  assert.deepEqual(
    ncUnits(rows, [flipped]).sales.map((s) => s.lid),
    [H(42)],
    "the order of listingIds does not matter",
  );
});

test("L3 a unit sold through an owner listing (manualListing) is left to the tracker ledger, never booked on a dead auto row", () => {
  assert.equal(I.UNIT_PROJECTION.manualListing, 1);
  // commitLedger reused an expired ledger for an owner vault row: listingIds still names the old auto row
  const rows = [ncRow(61, { c: NOW - 60 * DAY })];
  const owner = { ...unit(61, { status: "sold", soldAt: NOW - 4 * DAY, paid: 1.75, soldMarket: "gameflip", rows: [61] }), manualListing: ID(62) };
  const out = ncUnits(rows, [owner]);
  assert.deepEqual(out.sales, []);
  assert.deepEqual(out.demandOnly, []);
  assert.equal(out.counts.ownerRow, 1);
  assert.ok(!("manualListing" in out.units[0]) && !JSON.stringify(out.units).includes(ID(62)), "the owner row's id is used in memory only");
  // a released ledger (manualListing cleared) sold by the auto-lister counts as before
  assert.equal(ncUnits(rows, [{ ...owner, manualListing: "" }]).sales.length, 1);
});

test("L4 U carries the ledger's last write (u), the approximate moment a unit went off sale", async () => {
  assert.equal(I.UNIT_PROJECTION.updatedAt, 1);
  const off = { ...unit(35, { status: "skipped", rows: [9] }), updatedAt: new Date(NOW - 2 * DAY) };
  const out = ncUnits([ncRow(9)], [off]);
  assert.equal(out.units[0].u, NOW - 2 * DAY);
  assert.equal(out.units[0].st, "skipped");
});

test("L5 every hand sale (soldMarket manual) is a demand-only hand record, whether or not it names a row", () => {
  const rows = [ncRow(71)];
  const never = unit(71, { status: "sold", soldAt: NOW - 2 * DAY, soldMarket: "manual", listedAt: null, rows: [] });
  const outside = unit(72, { status: "sold", soldAt: NOW - 2 * DAY, soldMarket: "manual", rows: [99] });
  const named = unit(73, { status: "sold", soldAt: NOW - 2 * DAY, soldMarket: "manual", rows: [71] });
  const out = ncUnits(rows, [never, outside, named]);
  assert.equal(out.counts.hand, 3, "a never-listed account, one whose old row is out of the window, one naming a live row");
  assert.deepEqual(
    out.demandOnly.map((x) => [x.g, x.m, x.f, x.t, x.src]),
    [0, 1, 2].map(() => ["gamma rush", "unknown", "noclaim", NOW - 2 * DAY, "hand"]),
  );
  assert.deepEqual(out.sales, []);
});

test("L6 a broken lot's member sold later as a single is a single sale: the pack test runs on the chosen row only", () => {
  const rows = [ncRow(51, { kind: "lot", lot: 3, p: 3.75, c: NOW - 20 * DAY }), ncRow(52, { c: NOW - 8 * DAY, p: 1.5 })];
  const single = unit(51, { status: "sold", soldAt: NOW - 2 * DAY, paid: 1.5, soldMarket: "gameflip", rows: [51, 52] });
  const out = ncUnits(rows, [single]);
  assert.deepEqual(
    out.sales.map((s) => [s.lid, s.p, s.basis]),
    [[H(52), 1.5, "paid"]],
  );
  assert.deepEqual(out.demandOnly, []);
  assert.deepEqual(out.bulkPrices, []);
  // sold while the lot was its newest row: a lot sale (demand only, per-account price)
  const inLot = unit(53, { status: "sold", soldAt: NOW - 15 * DAY, paid: 3.75, soldMarket: "gameflip", rows: [51, 52] });
  const out2 = ncUnits(rows, [inLot]);
  assert.equal(out2.sales.length, 0);
  assert.deepEqual(
    out2.demandOnly.map((x) => x.src),
    ["bulk"],
  );
  assert.deepEqual(
    out2.bulkPrices.map((x) => [x.pa, x.size]),
    [[1.25, 3]],
  );
});

test("L7 the listing read and the sold-unit read reach back as far as sales are kept (saleDays)", async () => {
  const W = I.readWindows({});
  assert.equal(W.saleDays, 222);
  assert.equal(W.listingDays, W.saleDays);
  assert.equal(W.unitSoldDays, W.saleDays);
  // a sold row last written 150 days ago is inside the (in-memory, P20-7) listing window
  const old = listing(21, { m: "gameflip", origin: "unclaimed", price: 2, status: "sold", created: NOW - 155 * DAY, updated: NOW - 150 * DAY, set: SETS.G1, game: "Gamma Rush", prepared: false });
  const { b, calls } = await loadWith({ listingRows: LISTINGS.map((r) => r.x).concat([old.x]) });
  assert.ok(byId(b).has(H(21)));
  const WL = I.readWindows({ listingBrain: { fitDaysClaim: 60 } });
  const get = (n) => calls.find((c) => c.name === n);
  assert.equal(get("unitsSold").filter.soldAt.$gte.getTime(), NOW - WL.saleDays * DAY);
  assert.equal(get("listings").limit, I.LISTING_CAP);
  assert.equal(get("unitsSold").limit, I.UNIT_CAP);
});

test("L8 every wave record keeps its raw campaign name (W.name)", async () => {
  const { b } = await loadWith();
  assert.deepEqual(
    b.noclaim.waves.map((w) => [w.wave, w.name]),
    [
      ["Alpha Quest Launch", "Alpha Quest Launch"],
      ["Week 1", "Gamma Rush Cup Week 1"],
      ["Week 2", "Gamma Rush Cup Week 2"],
    ],
  );
});

test("L9 open-ended campaigns (endAt null) are read too; dated ones sort first so the cap never drops them", async () => {
  const { calls } = await loadWith();
  const C = calls.find((c) => c.name === "campaigns");
  assert.deepEqual(C.filter, { $or: [{ endAt: { $gte: new Date(NOW - I.CAMPAIGN_WINDOW_DAYS * DAY) } }, { endAt: null }] });
  assert.deepEqual(C.sort, { endAt: -1 }, "descending: Mongo sorts null below every date, so nulls come last");
  assert.equal(C.limit, I.CAMPAIGN_CAP);
});

test("L10 a no-claim farm-brain row keyed by normGameName (a–z0–9) joins the loader's Unicode keyword bucket", () => {
  const kw = I.noclaimKeywords({ noClaimGames: ["Pokémon UNITE"] }, setIdentity.normGame);
  const g = setIdentity.normGame("Pokémon UNITE");
  // farmDemand.noClaimKeys → settings.normGameName("Pokémon UNITE") = "pok mon unite"
  const docs = [{ k: "pok mon unite", f: "noclaim", at: new Date(NOW - HOUR), live: true, br: { c: "fleet", w: 14, t: 30 }, stk: { on: 20, fl: 0 }, est: { avg30: 12, avg45: 11 } }];
  // one sale in 30 days gives the bucket's split its basis (M10b)
  const out = I.demandRows({ docs, keywords: kw, listings: [{ g, f: "noclaim", kind: "single" }], sales: [{ g, f: "noclaim", t: NOW - DAY }], now: NOW });
  assert.deepEqual(
    out.map((r) => [r.k, r.w, r.sh]),
    [[g, 14, 1]],
    "expanded to the bucket's game, the key the model looks up",
  );
});

test("L11 an operator's 'manual mark sold' is a hand sale (demand only); the note never reaches the bundle", async () => {
  assert.equal(I.UNIT_PROJECTION.note, 1);
  const rows = [ncRow(81, { c: NOW - 9 * DAY, p: 1.5 })];
  // POST /api/unclaimed-auto/sell/:id → spendAccount(ledger, "manual mark sold"): market and shelf price stamped
  const u = { ...unit(81, { status: "sold", soldAt: NOW - DAY, paid: 1.5, soldMarket: "gameflip", rows: [81] }), note: "manual mark sold" };
  const out = ncUnits(rows, [u]);
  assert.deepEqual(out.sales, []);
  assert.deepEqual(
    out.demandOnly.map((x) => [x.src, x.m, x.f]),
    [["hand", "unknown", "noclaim"]],
  );
  assert.equal(out.counts.hand, 1);
  assert.ok(!JSON.stringify(out).toLowerCase().includes("mark sold"));
  const noted = { ...unit(82, { status: "sold", soldAt: NOW - DAY, paid: 2, soldMarket: "gameflip", rows: [9] }), note: "Manual mark sold — secret_operator" };
  const { b } = await loadWith({ units: [noted] });
  assert.deepEqual(
    b.sales.filter((s) => s.lid === H(9)),
    [],
  );
  assert.equal(b.demandOnly.filter((x) => x.src === "hand").length, 1);
  const text = JSON.stringify(b);
  assert.ok(!/mark sold|secret_operator/i.test(text));
  assert.deepEqual(I.privacyScan(b), []);
});

test("L12 the farm-brain row read looks back max(maxDemandAgeH, 6) h + 1 h, never 72 h", async () => {
  const from = async (lb) => {
    const { calls } = await loadWith({ af: { listingBrain: lb } });
    return calls.find((c) => c.name === "demand").filter.at.$gte.getTime();
  };
  assert.equal(await from({ enabled: true }), NOW - 7 * HOUR);
  assert.equal(await from({ maxDemandAgeH: 12 }), NOW - 13 * HOUR);
  assert.equal(await from({ maxDemandAgeH: 2 }), NOW - 7 * HOUR);
  assert.equal(await from({ maxDemandAgeH: 500 }), NOW - 73 * HOUR, "the model's clamp: 72 h at most");
  assert.equal(await from({ maxDemandAgeH: "x" }), NOW - 7 * HOUR, "a typo reads as the model's default");
});

test("L13 kind farm is inferred only from the flag or a fresh rent-farm title; any other gap keeps the row's kind by its flags", () => {
  assert.equal(I.LISTING_PROJECTION.title, 1, "read for classifyKind in memory");
  const report = { at: new Date(REPORT_AT), truncated: false, prepared: { rows: [], setById: new Map() } };
  const mk = (n, o) => ({
    _id: ID(n),
    marketplace: "gameflip",
    origin: "auto",
    status: "active",
    price: 2,
    createdAt: new Date(NOW - 20 * DAY),
    updatedAt: new Date(NOW - DAY),
    title: o.title,
    rentFarm: !!o.rentFarm,
    units: [],
  });
  const rows = [mk(91, { title: "Alpha Quest Twitch Drops (2 Items) secret_title_word" }), mk(92, { title: "Alpha Quest auto farm 7 days" }), mk(93, { title: "", rentFarm: true })];
  const nl = I.normaliseListings({ d: { setIdentity }, report, rows, keywords: [] });
  const kind = (n) => nl.byId.get(ID(n)).L.kind;
  assert.equal(kind(91), "single", "missing for a reason the loader cannot see (repriced since the report, …): kind by its flags");
  assert.equal(kind(92), "farm", "a rent-farm title");
  assert.equal(kind(93), "farm", "the rent-farm flag");
  assert.equal(nl.counts.unexplained, 1);
  assert.equal(nl.counts.farmByTitle, 1);
  assert.ok(!/secret_title_word|auto farm/.test(JSON.stringify(nl.listings)), "the title never reaches the bundle");
});

/* ------------------------- review findings: privacy (P1–P8) ------------------------- */

test("P1 the export writes to the OS temp dir by default and refuses an --out inside the repository", async () => {
  const def = EXPORT.defaultOut(NOW);
  assert.equal(path.dirname(def), os.tmpdir());
  assert.match(path.basename(def), /^listing-brain-bundle-20261010-120000\.json$/);
  const root = path.join(__dirname, "..");
  assert.equal(EXPORT.insideRepo(path.join(root, "x.json")), true);
  assert.equal(EXPORT.insideRepo(path.join(root, "docs", "deeper", "x.json")), true);
  assert.equal(EXPORT.insideRepo(def), false);
  let loaded = 0;
  // validateBundle always refuses, so no code version can ever write this file into the repo
  const inputs = {
    load: async () => {
      loaded++;
      return {};
    },
    privacyScan: () => [],
    validateBundle: () => ["never written"],
  };
  const out = path.join(root, "listing-brain-bundle-p1-test.json");
  const lines = [];
  const r = await EXPORT.exportBundle({ inputs, now: NOW, out, log: (s) => lines.push(s) });
  assert.equal(r.written, false);
  assert.equal(loaded, 0, "refused before anything is read");
  assert.ok(!fs.existsSync(out));
  assert.ok(
    lines.some((s) => /inside the repository/.test(s) && /public/.test(s)),
    lines.join("\n"),
  );
  const src = fs.readFileSync(path.join(root, "scripts", "listing-brain-export.js"), "utf8");
  assert.match(src, /\.gitignore[^\n]*listing-brain-bundle-\*\.json/, "the header proposes the ignore line to the owner");
});

test("P2a only the brain's own config keys (the model's DEFAULTS) reach the bundle, with plain values", async () => {
  const lb = {
    enabled: true,
    fitDaysClaim: 60,
    tierEdges: [2, 6],
    policyPrice: "curve",
    explore: false,
    refDays: ["a", "b"],
    maxStepPct: { x: 1 },
    comment: "owner text secret_comment",
    owner: "someone@example.invalid",
    webhook: "https://example.invalid/hook",
    apiKey: "k-123",
    nested: { a: 1 },
  };
  const { b } = await loadWith({ af: { listingBrain: lb } });
  assert.deepEqual(b.af.listingBrain, { enabled: true, fitDaysClaim: 60, tierEdges: [2, 6], policyPrice: "curve", explore: false });
  for (const k of Object.keys(b.af.listingBrain)) assert.ok(k in MU.DEFAULTS, k);
});

test("P2b every market string in the bundle is a known key or 'other'; validateBundle enforces the set", async () => {
  const rep = trackerReport();
  const hand = ledgerSale(null, { at: NOW - 4 * DAY, market: "Discord buyer secret_handle", gameKey: "gamma rush", source: "hand", origin: "manual" });
  const shop = ledgerSale(null, { at: NOW - 4 * DAY, market: "shop counter 2", gameKey: "alpha quest", source: "shop" });
  rep.ledger = { ...rep.ledger, sales: rep.ledger.sales.concat([hand]), demandOnly: rep.ledger.demandOnly.concat([shop]) };
  const odd = unit(40, { status: "sold", soldAt: NOW - DAY, soldMarket: "Telegram secret_handle", rows: [] });
  const { b } = await loadWith({ report: rep, units: Object.values(UNITS).concat([odd]) });
  const KNOWN = I.MARKETS.concat(["unknown", "manual", "shop", "bulk", "other"]);
  for (const s of b.sales) assert.ok(KNOWN.includes(s.m), "sales m " + s.m);
  for (const x of b.demandOnly) assert.ok(KNOWN.includes(x.m), "demandOnly m " + x.m);
  for (const u of b.noclaim.units) (assert.ok(u.m === "" || KNOWN.includes(u.m), "unit m " + u.m), assert.ok(u.sm === "" || KNOWN.includes(u.sm), "unit sm " + u.sm));
  assert.equal(b.sales.filter((s) => s.m === "other").length, 1);
  assert.equal(b.demandOnly.filter((x) => x.m === "other").length, 1);
  assert.equal(b.noclaim.units.filter((u) => u.sm === "other").length, 1);
  assert.ok(!JSON.stringify(b).includes("secret_handle"));
  assert.deepEqual(I.validateBundle(b), []);
  const bad = JSON.parse(JSON.stringify(b));
  bad.sales[0].m = "discord";
  bad.demandOnly[0].m = "telegram";
  bad.noclaim.units[0].sm = "zelle";
  const p = I.validateBundle(bad);
  for (const re of [/sales\[0\]\.m/, /demandOnly\[0\]\.m/, /noclaim\.units\[0\]\.sm/])
    assert.ok(
      p.some((x) => re.test(x)),
      re + " in " + p.join(" | "),
    );
});

test("P2-scan privacyScan flags identifying key names (any case) and identifying values; the fixtures and the loader's bundle are clean", async () => {
  const dirty = {
    a: { buyerLogin: "x", soldTo: "y", username: "z", seller_name: "w", Title: "t", TwitchName: "q", accountRef: "r" },
    notes: [
      "mail someone@example.invalid",
      "see https://example.invalid/x",
      "host 10.1.2.3 down",
      "v6 2001:db8::5 down",
      "doc " + "a".repeat(23) + "1 gone",
      // credential-SHAPED values (C-extra: a bare word in a game's name is not one)
      "my api_key=leaked123",
      "Bearer abcdefgh123",
      "password: reset123",
    ],
  };
  const found = I.privacyScan(dirty);
  for (const p of ["a.buyerLogin", "a.soldTo", "a.username", "a.seller_name", "a.Title", "a.TwitchName", "a.accountRef"])
    assert.ok(
      found.some((x) => x.startsWith(p)),
      p + " in " + found.join(" | "),
    );
  for (let i = 0; i < dirty.notes.length; i++)
    assert.ok(
      found.some((x) => x.startsWith("notes[" + i + "]")),
      "notes[" + i + "] in " + found.join(" | "),
    );
  // the bundle's own keys pass; a game-keyed map's keys are data (checked as values, not as field names)
  assert.deepEqual(I.privacyScan({ notes: ["The price tracker report is 4 min old"], af: { mapped: { "account quest": { gameflip: true } }, caps: { "seller simulator": 3 } } }), []);
  assert.equal(I.privacyScan({ af: { mapped: { "x@example.invalid": {} } } }).length, 1);
  // nothing in the synthetic fixtures or the loader's own bundle
  const { generate } = require("../scripts/listing-brain-fixture");
  assert.deepEqual(I.privacyScan(generate({ large: true })), []);
  assert.deepEqual(I.privacyScan(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "listingBrain", "small.json"), "utf8"))), []);
  const { b } = await loadWith({ platiTakes: true });
  assert.deepEqual(I.privacyScan(b), []);
});

test("P3 cleanMsg masks bare hosts, [ipv6]:port, key=/token= values, Windows and POSIX paths, object echoes and quoted values — and keeps the error words", () => {
  const cases = [
    ["getaddrinfo ENOTFOUND mongo-primary-7", ["mongo-primary-7"], ["getaddrinfo", "ENOTFOUND"]],
    ["getaddrinfo EAI_AGAIN db.myshop.lk", ["myshop"], ["EAI_AGAIN"]],
    ["getaddrinfo ENOTFOUND myshop.ovh", ["myshop"], ["ENOTFOUND"]],
    ["querySrv ENOTFOUND _mongodb._tcp.cluster0.ab1cd.mongodb.net", ["cluster0", "ab1cd", "mongodb.net"], ["querySrv", "ENOTFOUND"]],
    ["connect ECONNREFUSED [2001:db8::5]:27017", ["2001", "db8"], ["connect", "ECONNREFUSED"]],
    ["connect ETIMEDOUT 2001:db8::1:27017", ["2001:db8", "7"], ["ETIMEDOUT"]],
    ["reply from fe80::1 dropped", ["fe80"], ["reply from", "dropped"]],
    ["pool for db01.prod.myshop.store cleared", ["myshop"], ["pool", "cleared"]],
    ["HTTP 403 from ggsel api key=AbCdEf0123456789 seller_id=998877", ["AbCdEf0123456789", "998877"], ["HTTP 403"]],
    ["GET /api/v2/offers?token=tok_9f8e7d6c5b4a&seller=jdoe 401", ["tok_9f8e7d6c5b4a", "jdoe", "/api/v2"], ["401"]],
    ["EACCES: permission denied, open 'C:\\Users\\owner\\app\\settings.json'", ["owner", "Users"], ["EACCES", "permission denied"]],
    ["EACCES: permission denied, open C:\\Users\\owner\\app\\settings.json", ["owner", "Users"], ["EACCES"]],
    ["ENOENT: no such file or directory, open '/settings.json'", ["/settings.json"], ["ENOENT"]],
    ['E11000 duplicate key error collection: farm.accounts index: loginLower_1 dup key: { loginLower: "jdoefarm01" }', ["jdoefarm01"], ["E11000", "duplicate key"]],
    ['not authorized on farm to execute command { find: "x", filter: { login: "jdoefarm01" } }', ["jdoefarm01", "find:", "filter"], ["not authorized", "execute command <obj>"]],
    ['Cast to ObjectId failed for value "jdoefarm01" (type string) at path "_id"', ["jdoefarm01"], ["Cast to ObjectId failed"]],
    ["Error: secret token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", ["ghp_", "abcdefghij"], ["leaked"]],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc", ["eyJ"], ["Bearer"]],
    ["Username contains unescaped characters ad/min", ["ad/min"], ["unescaped characters"]],
    ["\\\\fileserver\\share\\bundle.json is locked", ["fileserver"], ["is locked"]],
    ["E11000 dup key host mongo-primary-7 rejected", ["mongo-primary-7"], ["E11000", "host"]],
    ["failed to connect to db-2 after 3 tries", ["db-2"], ["failed to connect to"]],
    ["the host is unreachable", [], ["the host is unreachable"]],
  ];
  for (const [raw, gone, kept] of cases) {
    const m = I.cleanMsg(new Error(raw));
    for (const g of gone) assert.ok(!m.includes(g), JSON.stringify(g) + " survives in " + JSON.stringify(m));
    for (const k of kept) assert.ok(m.includes(k), JSON.stringify(k) + " lost from " + JSON.stringify(m));
  }
  assert.equal(I.cleanMsg(new Error("d.MarketResearch.find is not a function")), "d.MarketResearch.find is not a function");
  assert.equal(I.cleanMsg(new Error("Authentication failed.")), "Authentication failed.");
  assert.equal(I.cleanMsg("venuePrice took longer than 15 s"), "venuePrice took longer than 15 s");
  assert.equal(I.cleanMsg(new Error("the loader can't read the report")), "the loader can't read the report");
});

test("P7 a failed connect prints a generic line and the error's class, never its text", () => {
  const e = new Error("getaddrinfo ENOTFOUND db01.prod.myshop.lk (user admin)");
  e.name = "MongoServerSelectionError";
  assert.equal(EXPORT.connectFailure(e), "could not connect (check MONGO_URI): MongoServerSelectionError");
  assert.equal(EXPORT.connectFailure("x"), "could not connect (check MONGO_URI): Error");
  const code = fs.readFileSync(path.join(__dirname, "..", "scripts", "listing-brain-export.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/e\.message/.test(code), "the export never prints a raw error message");
  assert.match(code, /connectFailure\(e\)/);
});

/* ------------------------- batch 2: completeness (C), money (M), Node 20 load (P20), privacy (C-extra) ------------------------- */

const P = require("../utils/listingBrain/model/price");

// The longest synchronous stretch while `fn` runs: a setImmediate probe ticking beside it.
async function longestStretch(fn) {
  const st = { max: 0, last: Date.now(), done: false };
  const tick = () => {
    const n = Date.now();
    if (n - st.last > st.max) st.max = n - st.last;
    st.last = n;
    if (!st.done) setImmediate(tick);
  };
  setImmediate(tick);
  let value;
  try {
    value = await fn();
  } finally {
    st.done = true;
    const tail = Date.now() - st.last;
    if (tail > st.max) st.max = tail;
  }
  return { value, max: st.max };
}
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
const emptyReport = () => ({ at: new Date(REPORT_AT), truncated: false, games: [], prepared: { rows: [], setById: new Map() } });
const pureDeps = (o = {}) => ({ setIdentity, games: { listedUnits: G.listedUnits }, packMath: { packSizeOf: PACK.packSizeOf }, ...o });

test("C3 every game's waves are kept, so a claim campaign that ended with the rivals gone reads scarce", async () => {
  const campaigns = CAMPAIGNS.concat([{ _id: ID(703), campaignId: "cmp4", name: "Beta Arena Finals", game: "Beta Arena", startAt: new Date(NOW - 12 * DAY), endAt: new Date(NOW - 2 * DAY) }]);
  // 6 on hand at 1 a week: 6 weeks of cover, inside the 2–8 week band, so only the ended campaign can say scarce
  const demandRows = DEMAND_ROWS.map((r) => (r.k === "beta arena" ? { ...r, br: { c: "farm", w: 1, t: 8 }, stk: { on: 6, fl: 0 }, est: { avg30: 1, avg45: 1 } } : r));
  const radar = radarReport();
  radar.games.push({ key: "beta arena", game: "Beta Arena", units: 2, perWeek: 1, rivalSellers: 1, medianTtsHours: 20, byMarket: {} });
  const { b } = await loadWith({ campaigns, demandRows, radar });
  assert.deepEqual(
    b.noclaim.waves.filter((w) => w.g === "beta arena").map((w) => w.endAt),
    [NOW - 2 * DAY],
    "a claim game's wave",
  );
  assert.ok(
    b.noclaim.waves.some((w) => w.g === "alpha quest"),
    "every game in the read window",
  );
  const ev = E.buildEvidence(b, { cfg: MU.readConfig({}), cut: NOW });
  const gs = P.gameState(ev, "beta arena", "claim");
  assert.equal(gs.regime, "scarce", gs.regimeWhy.join(" | "));
  assert.ok(
    gs.regimeWhy.some((x) => /campaign has ended/.test(x)),
    gs.regimeWhy.join(" | "),
  );
});

test("C9 a pack's size comes from bulkPacks/packMath: bulkPackSize without bulkOfferId is not a pack", () => {
  const asked = [];
  const d = pureDeps({ packMath: { packSizeOf: (row) => (asked.push(row), PACK.packSizeOf(row)) } });
  const mk = (n, o) => ({ _id: ID(n), marketplace: "eldorado", origin: "manual", status: "active", price: 10, createdAt: new Date(NOW - 5 * DAY), updatedAt: new Date(NOW - DAY), units: [], ...o });
  const nl = I.normaliseListings({
    d,
    report: emptyReport(),
    rows: [mk(95, { bulkPackSize: 5 }), mk(96, { bulkPackSize: 5, bulkOfferId: ID(901) }), mk(98, { lotSize: 3, origin: "unclaimed", marketplace: "gameflip" })],
    keywords: [],
  });
  const at = (n) => nl.byId.get(ID(n)).L;
  assert.deepEqual([at(95).kind, at(95).pack], ["single", 0], "no bulkOfferId: not a pack (packMath's rule)");
  assert.deepEqual([at(96).kind, at(96).pack], ["bulk", 5]);
  assert.deepEqual([at(98).kind, at(98).lot, at(98).pack], ["lot", 3, 0], "a Gameflip lot is not a bulk pack");
  assert.ok(asked.length >= 3, "every row's pack size is asked of packMath");
  assert.equal(I.kindOf({ bulkPackSize: 3 }), "single", "the size alone makes no pack");
});

test("C11 listed units are the tracker's own count (games.listedUnits through deps); a missing dep reads unknown, never a copy", async () => {
  const seen = [];
  const row = { _id: ID(97), marketplace: "ggsel", origin: "unclaimed", status: "active", price: 2, createdAt: new Date(NOW - 5 * DAY), updatedAt: new Date(NOW - DAY), lastStock: 3, units: [] };
  const nl = I.normaliseListings({ d: pureDeps({ games: { listedUnits: (l) => (seen.push(l), 7) } }), report: emptyReport(), rows: [row], keywords: [] });
  assert.equal(nl.byId.get(ID(97)).L.qty, 7);
  assert.equal(seen.length, 1);
  const none = I.normaliseListings({ d: pureDeps({ games: null }), report: emptyReport(), rows: [row], keywords: [] });
  assert.equal(none.byId.get(ID(97)).L.qty, null);
  assert.equal(I.listedUnits, undefined, "no second copy of the tracker's rule");
  // the fake-deps path (the real module injected) still loads the whole world
  const { b } = await loadWith();
  assert.equal(byId(b).get(H(10)).qty, 3, "GGSel: lastStock");
  assert.equal(byId(b).get(H(13)).qty, 1, "Eldorado: one undelivered unit");
});

test("C12 today's flat shelf tops the refillable markets back up to perMarketStock while stock lasts (rule 4)", async () => {
  // alpha quest: 6 on hand → listNow 3 dealt gameflip 2, eldorado 1; refillMarkets tops Gameflip up to 3
  const { b } = await loadWith();
  assert.deepEqual(b.old.games["alpha quest"].split, { listNow: 3, holdBack: 3 });
  assert.deepEqual(b.old.games["alpha quest"].flat, { gameflip: 3, eldorado: 1 });
  // Plati and GGSel taking stock, perMarketStock 2: each refillable market in order, while Σ ≤ stock
  const w = await loadWith({ platiTakes: true, af: { ggselCategoryId: "123", perMarketStock: 2 } });
  assert.deepEqual(w.b.old.games["alpha quest"].flat, { gameflip: 2, digiseller: 2, ggsel: 2, eldorado: 0 });
  // stock runs out first: 2 on hand → 1 dealt to Gameflip, one more tops it up, nothing left for the rest
  assert.deepEqual(w.b.old.games["delta 1"].flat, { gameflip: 2, digiseller: 0, ggsel: 0, eldorado: 0 });
});

test("C13 a claim event bundle's new-listing price is autoFarmBundles.priceBundle's (eb), from one bounded set read", async () => {
  const dropSets = [{ _id: SETS.A1._id, sourceType: "autofarm-bundle", sourceEventKey: "alpha quest|launch" }];
  const ck = LISTINGS[0].prepared.id.contentKey;
  // the event's own bundle sold at $3.50 on Gameflip 5 days ago (its 30-day sold floor), and a GGSel share is live
  const sold = listing(19, { m: "gameflip", origin: "auto", status: "sold", price: 3.5, set: SETS.A1, game: "Alpha Quest", updated: NOW - 5 * DAY });
  const gg = listing(20, { m: "ggsel", origin: "auto", price: 3, set: SETS.A1, game: "Alpha Quest" });
  const listingRows = LISTINGS.map((r) => r.x).concat([sold.x, gg.x]);
  const report = trackerReport();
  report.prepared.rows.push(sold.prepared, gg.prepared);
  const { b, calls, seen } = await loadWith({ dropSets, listingRows, report });
  const gf = b.old.offers["gameflip|" + ck];
  assert.deepEqual([gf.np, gf.eb], [4.25, true]);
  assert.deepEqual([b.old.offers["ggsel|" + ck].np, b.old.offers["ggsel|" + ck].eb], [3.4, true], "GGSel's share: venuePrice of the bundle price");
  assert.equal(b.old.offers["eldorado|" + ck].np, 2, "not an event-bundle market: rule 1's lifted base");
  assert.ok(!b.old.offers["eldorado|" + ck].eb);
  const call = seen.priceBundle[0];
  assert.deepEqual([call.marketplace, call.game, call.plan.totalQty, call.plan.full, call.soldFloorUsd, call.research.game], ["gameflip", "Alpha Quest", 2, false, 3.5, "Alpha Quest"]);
  assert.deepEqual(
    call.plan.items.map((x) => x.itemKey),
    ["aq-sword", "aq-shield"],
  );
  assert.ok(
    b.notes.some((n) => /event bundle/i.test(n) && /complete/i.test(n)),
    b.notes.join(" | "),
  );
  const ds = calls.filter((c) => c.name === "dropSets");
  assert.equal(ds.length, 1);
  assert.deepEqual(ds[0].projection, { _id: 1, sourceType: 1, sourceEventKey: 1 });
  assert.ok(ds[0].filter._id.$in.length <= 500 && ds[0].limit === 500);
  assert.ok(!JSON.stringify(b).includes("alpha quest|launch"), "the event key is used in memory only");
  // the evidence snapshot unreadable: no price (never a guess), one note
  const failed = await loadWith({ dropSets, snapshotFails: true });
  assert.equal(failed.b.old.offers["gameflip|" + ck].np, null);
  assert.equal(failed.seen.priceBundle, undefined);
  // the marker read failing: rule 1 as before, with a note
  const down = await loadWith({ dropSets, dropSetsFail: true });
  assert.equal(down.b.old.offers["gameflip|" + ck].np, 2);
  assert.ok(
    down.b.notes.some((n) => /event-bundle/i.test(n)),
    down.b.notes.join(" | "),
  );
});

test("M10b a no-claim bucket row whose games sold nothing in 30 days is not split equally: they read unknown", () => {
  const doc = { k: "zed", f: "noclaim", at: new Date(NOW), br: { w: 4 }, stk: { on: 2 } };
  const units = [
    { g: "zed one", st: "listed" },
    { g: "zed two", st: "skipped" },
  ];
  const stats = {};
  const none = I.demandRows({ docs: [doc], keywords: ["zed"], units, now: NOW, stats });
  assert.deepEqual(
    none.filter((r) => r.k.startsWith("zed ")),
    [],
  );
  assert.equal(stats.unsplit, 1);
  // one sale gives the split its basis
  const one = I.demandRows({ docs: [doc], keywords: ["zed"], units, sales: [{ g: "zed one", f: "noclaim", t: NOW - DAY }], now: NOW });
  assert.deepEqual(
    one.map((r) => [r.k, r.sh]),
    [
      ["zed one", 1],
      ["zed two", 0],
    ],
  );
});

test("P20-2 the tracker is asked only for the offers the log uses (each cell's main offer), capped with a note, yielding within 50 ms", async () => {
  const mk = (n, m, o, st, ck) => ({ raw: ID(n), set: null, L: { id: H(n), g: "alpha", gl: "Alpha", m, o, f: "claim", kind: "single", st, ck, bk: "alpha|2", ex: true, n: 2, qty: 1, p: 2, c: NOW - 5 * DAY } });
  // primary offer c1 (live on Gameflip); c2 sold out on Gameflip; the owner's Eldorado c1; a delisted GGSel c1
  const rows = [mk(1, "gameflip", "auto", "active", "c1"), mk(2, "gameflip", "auto", "sold", "c2"), mk(3, "eldorado", "manual", "active", "c1"), mk(4, "ggsel", "auto", "delisted", "c1")];
  const byIdMap = new Map(rows.map((e) => [e.raw, e]));
  const asked = [];
  const d = {
    autoLister: { computeSplit: () => ({ listNow: 0, holdBack: 0 }), dealShares: () => {}, derivePrice: () => 2, postEventPrice: (x) => x, venuePrice: async (m, b) => b },
    g2gGames: { brandForGame: () => null },
    venues,
    priceTracker: {
      suggestForNew: (rep, q) => {
        asked.push(q.market);
        busy(30);
        return { price: 1.6, basis: "x", confidence: "low" };
      },
    },
    unclaimedBundles,
  };
  // Eldorado's switch on: the game's main offer would be listed there new (N5: only cells the model prices)
  const base = { d, af: { eldoradoAuto: true }, report: { games: [] }, byId: byIdMap, demand: [], research: [], catalog: new Map(), pricing: {}, labels: new Map(), platiTakes: false, ggselTakes: true, now: NOW };
  const notes = [];
  const out = await I.oldSide({ ...base, notes });
  assert.deepEqual(asked.sort(), ["eldorado", "gameflip", "ggsel"], "the three cells' main offers; never the sold-out c2");
  assert.equal(out.offers["gameflip|c2"].tracker, null);
  assert.ok(out.offers["gameflip|c1"].tracker && out.offers["eldorado|c1"].tracker && out.offers["ggsel|c1"].tracker);
  assert.ok(out.offers["gameflip|c2"].np !== undefined, "today's new-listing price is still computed for every offer");
  // capped: the live cells first, said in a note
  asked.length = 0;
  const notes2 = [];
  const capped = await I.oldSide({ ...base, notes: notes2, trackerCap: 1 });
  assert.deepEqual(asked, ["gameflip"]);
  assert.ok(capped.counts.trackerCut === 2 && notes2.some((n) => /tracker/i.test(n) && /1 of 3/.test(n)), notes2.join(" | "));
  // slow answers (30 ms each) never hold the loop past the 50 ms budget plus one call
  const many = new Map();
  for (let k = 0; k < 8; k++) {
    const e = mk(10 + k, "gameflip", "auto", "active", "k" + k);
    e.L.g = "game " + k;
    many.set(e.raw, e);
  }
  const { max } = await longestStretch(() => I.oldSide({ ...base, byId: many, notes: [] }));
  assert.ok(max < 120, "longest synchronous stretch " + max + " ms");
});

test("P20-3 listing ids are hashed once per load: a memoised hasher, the same digest as hashId", () => {
  const h = I.makeHasher();
  assert.equal(h(ID(1)), I.hashId(ID(1)));
  h(ID(1));
  h(ID(2));
  assert.equal(h.cache.size, 2);
});

test("P20-6 the evidence snapshot is warmed once before the venue loop; when it fails every GGSel price is null with one note and venuePrice is never called", async () => {
  const ok = await loadWith();
  assert.equal(ok.seen.snapshot, 1);
  assert.equal(ok.seen.venue.length, 10);
  // the real venuePrice swallows an evidence error and answers the base: it must not be asked then
  const bad = await loadWith({ snapshotFails: true });
  assert.equal(bad.seen.snapshot, 1);
  assert.equal(bad.seen.venue.length, 0);
  for (const og of Object.values(bad.b.old.games)) assert.equal(og.ggsel, null);
  const n = bad.b.notes.filter((x) => /evidence snapshot/i.test(x));
  assert.equal(n.length, 1, bad.b.notes.join(" | "));
  assert.ok(!/example\.invalid|27017/.test(n[0]), n[0]);
  const hang = await loadWith({ snapshotHangs: true }, { venueTimeoutMs: 20 });
  assert.equal(hang.seen.venue.length, 0);
  assert.ok(
    hang.b.notes.some((x) => /evidence snapshot/i.test(x) && /took longer/.test(x)),
    hang.b.notes.join(" | "),
  );
});

test("P20-7 the listing read is the tracker's own shape; the active/updatedAt window is applied in memory", async () => {
  const old = listing(18, { m: "gameflip", origin: "auto", price: 2, status: "sold", created: NOW - 400 * DAY, updated: NOW - 300 * DAY, set: SETS.A1, prepared: false });
  const { b, calls } = await loadWith({ listingRows: LISTINGS.map((r) => r.x).concat([old.x]) });
  const L = calls.find((c) => c.name === "listings");
  assert.deepEqual(L.filter, { marketplace: { $in: I.MARKETS } });
  assert.deepEqual(L.sort, { _id: -1 });
  assert.equal(L.limit, I.LISTING_CAP);
  assert.ok(!byId(b).has(H(18)), "a row neither active nor written inside the window is dropped in memory");
  assert.equal(b.counts.listingRows, LISTINGS.length + 1);
  assert.equal(b.counts.listingOutsideWindow, 1);
});

test("P20-8 the sold-unit read skips the units the listed read already returns", async () => {
  const { calls } = await loadWith();
  const W = I.readWindows({ listingBrain: { fitDaysClaim: 60 } });
  const US = calls.find((c) => c.name === "unitsSold");
  assert.equal(US.filter.status, "sold");
  assert.equal(US.filter.soldAt.$gte.getTime(), NOW - W.saleDays * DAY);
  assert.deepEqual(US.filter.$or, [{ listedAt: { $lt: new Date(NOW - W.unitListedDays * DAY) } }, { listedAt: null }], "never-listed hand sales included");
  assert.deepEqual(US.sort, { soldAt: -1 });
});

test("P20-9 database numbers that drive loops are clamped: on-hand stock ≤ 10,000 accounts, a set item's copies ≤ 100", async () => {
  const demandRows = DEMAND_ROWS.concat([{ k: "huge game", f: "claim", at: new Date(NOW - HOUR), live: true, br: { c: "farm", w: 1, t: 5 }, stk: { on: 5e6, fl: 0 }, est: {} }]);
  const w = world({ demandRows });
  const asked = [];
  // a split of millions would deal millions of placeholder accounts: answer only what the clamp allows
  w.deps.autoLister.computeSplit = (n) => (asked.push(n), n <= 10000 ? computeSplit(n) : { listNow: 0, holdBack: 0 });
  const b = await I.load({ now: NOW, deps: w.deps });
  assert.ok(Math.max(...asked) <= 10000, "computeSplit asked " + Math.max(...asked));
  assert.deepEqual(b.old.games["huge game"].split, { listNow: 5000, holdBack: 5000 });
  assert.equal(I.dropsFromItems(I.setItems({ items: [{ itemKey: "a", name: "A", game: "G", qty: 1e6 }] })).length, 100);
});

test("P20-10 cleanMsg stays fast on hostile input: bounded identifiers, only the first 500 characters scanned", () => {
  for (const s of ["key-".repeat(500), "user-1a".repeat(285), "token_".repeat(333), "a.".repeat(1000)]) {
    const t = process.hrtime.bigint();
    const m = I.cleanMsg(new Error(s));
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 50, ms.toFixed(1) + " ms for " + s.slice(0, 12));
    assert.ok(m.length <= 200);
  }
  const late = I.cleanMsg(new Error("x".repeat(600) + " token=SECRETVALUE"));
  assert.ok(!late.includes("SECRETVALUE"));
});

test("P20-14 manifests are read in chunks of 500 ids; every database read carries maxTimeMS", async () => {
  const campaigns = Array.from({ length: 1201 }, (_, i) => ({
    campaignId: "cmp" + i,
    name: "Gamma Rush Cup Week " + (i + 1),
    game: "Gamma Rush",
    startAt: new Date(NOW - 10 * DAY),
    endAt: new Date(NOW - DAY),
  }));
  const dropSets = [{ _id: SETS.A1._id, sourceType: "autofarm-bundle", sourceEventKey: "e" }];
  const { calls } = await loadWith({ campaigns, dropSets });
  const M = calls.filter((c) => c.name === "manifests");
  assert.deepEqual(
    M.map((c) => c.filter.campaignId.$in.length),
    [500, 500, 201],
  );
  assert.equal(new Set(M.flatMap((c) => c.filter.campaignId.$in)).size, 1201);
  const db = calls.filter((c) => c.filter !== undefined);
  assert.ok(db.length >= 9);
  for (const c of db) assert.equal(c.options && c.options.maxTimeMS, I.READ_MAX_TIME_MS, c.name);
});

test("C-extra privacyScan's credential check is shape-based: a game named 'Secret Agent Saga' passes, 'token=abc123' does not", () => {
  const clean = {
    listings: [{ gl: "Secret Agent Saga", g: "token tycoon" }],
    noclaim: { waves: [{ ev: "Golden Token Week", name: "Password Panic Finals", wave: "API Key Cup" }] },
    notes: ["The bearer of good news"],
  };
  assert.deepEqual(I.privacyScan(clean), []);
  for (const v of ["token=abc123", "api_key: ZZZ999", "access-key=q1w2e3", "Bearer abcdefgh12345", "password: hunter2", "secret = s3cr3t"]) {
    assert.equal(I.privacyScan({ notes: [v] }).length, 1, v);
  }
});

/**
 * A world at the loader's read caps (synthetic): 20,000 listings, 30,000 ledger sales built the way the
 * tracker's ledger builds them (object spread — the slow shape on Node 20), 2 × 50,000 no-claim units,
 * 5,000 campaigns and manifests, 2,000 research rows, 5,000 farm-brain rows. The tracker's answer is a
 * fast fake: its own cost is P20-2's, measured there.
 */
function capWorld() {
  const NG = 150;
  const games = Array.from({ length: NG }, (_, i) => "Cap Game " + String.fromCharCode(65 + (i % 26)) + i);
  const noclaim = games.slice(0, 30);
  const hex = (p, n) => (p + n.toString(16)).padStart(24, "0").slice(-24);
  const sets = [];
  const setsOf = new Map();
  for (const g of games) {
    const list = [];
    for (let j = 0; j < 4; j++) {
      const s = {
        _id: hex("5e", sets.length + 1),
        name: g + " " + j,
        price: 1.5,
        minPriceUsd: 1,
        items: Array.from({ length: j + 1 }, (_, k) => ({ itemKey: g.replace(/\W/g, "") + "-" + j + "-" + k, game: g, qty: 1, name: "Item " + k })),
      };
      sets.push(s);
      list.push(s);
    }
    setsOf.set(g, list);
  }
  const rows = [];
  const prepared = [];
  const sales = [];
  const unclaimedIds = [];
  for (let i = 0; i < 20000; i++) {
    const g = games[i % NG];
    const nc = i % NG < 30;
    const m = I.MARKETS[i % 7];
    const set = setsOf.get(g)[i % 4];
    const created = NOW - ((i * 7919) % 200) * DAY - HOUR;
    const status = i % 3 === 0 ? "active" : i % 3 === 1 ? "sold" : "delisted";
    const x = {
      _id: hex("a1", i + 1),
      marketplace: m,
      origin: i % 10 === 0 ? "manual" : nc ? "unclaimed" : "auto",
      status,
      price: 1 + (i % 12) * 0.25,
      title: g + " Twitch Drops",
      createdAt: new Date(created),
      updatedAt: new Date(Math.min(NOW - HOUR, created + 3 * DAY)),
      set: set._id,
      noclaimStock: false,
      autoClaimSet: false,
      unclaimedGame: "",
      rentFarm: false,
      bulkOfferId: null,
      bulkPackSize: 0,
      lotSize: 0,
      qtyRemaining: 1,
      qtyTarget: 0,
      lastStock: m === "ggsel" || m === "digiseller" ? 2 : null,
      rebundledAt: null,
      venueMinPriceUsd: 0,
      units: m === "eldorado" || m === "g2g" || m === "playerauctions" ? [{ addedAt: new Date(created), deliveredAt: status === "sold" ? new Date(created + DAY) : null }] : [],
    };
    rows.push(x);
    if (x.origin === "unclaimed") unclaimedIds.push(x._id);
    const l = { ...x };
    const id = {
      kind: "drops",
      game: g,
      gameKey: g.toLowerCase(),
      contentKey: "s:" + set._id.slice(-12),
      bandKey: g.toLowerCase() + "|" + (set.items.length > 1 ? "2-3" : "1"),
      countForBand: set.items.length,
      exact: true,
    };
    prepared.push({ l, id, market: m, listingId: x._id });
  }
  for (let k = 0; k < 30000; k++) {
    const r = prepared[(k * 31) % prepared.length];
    const base = {
      market: r.market,
      listingId: r.listingId,
      externalId: "",
      origin: r.l.origin,
      title: "",
      listedPrice: r.l.price,
      gameKey: r.id.gameKey,
      contentKey: r.id.contentKey,
      bandKey: r.id.bandKey,
      itemCount: r.id.countForBand,
      exact: true,
    };
    sales.push({ ...base, key: "k" + k, saleGroup: "grp" + k, source: k % 3 ? "signal" : "unit", at: new Date(NOW - (k % 200) * DAY - HOUR), priceUsd: 1.5, priceBasis: "reported", priced: true });
  }
  const unit = (n, sold) => ({
    _id: hex("ff", n),
    game: noclaim[n % 30],
    market: "gameflip",
    status: sold ? "sold" : n % 3 ? "listed" : "expired",
    listedAt: new Date(NOW - (n % 150) * DAY - DAY),
    soldAt: sold ? new Date(NOW - (n % 140) * DAY) : null,
    soldPriceUsd: sold ? 1.5 : 0,
    soldMarket: sold ? "gameflip" : "",
    expiredAt: !sold && n % 3 === 0 ? new Date(NOW - (n % 100) * DAY) : null,
    updatedAt: new Date(NOW - DAY),
    listingIds: [unclaimedIds[n % unclaimedIds.length], unclaimedIds[(n * 7) % unclaimedIds.length]],
    bundleKey: "",
    manualListing: "",
    note: "",
    drops: [{ campaign: noclaim[n % 30] + " Cup Week " + (n % 4) }],
  });
  const listed = Array.from({ length: 50000 }, (_, n) => unit(n, false));
  const sold = Array.from({ length: 50000 }, (_, n) => unit(50000 + n, true));
  const campaigns = Array.from({ length: 5000 }, (_, i) => ({
    campaignId: "c" + i,
    name: games[i % NG] + " Cup Week " + (i % 4),
    game: games[i % NG],
    startAt: new Date(NOW - ((i % 100) + 7) * DAY),
    endAt: new Date(NOW - (i % 100) * DAY),
  }));
  const manifests = campaigns.map((c) => ({ campaignId: c.campaignId, name: c.name, game: c.game, drops: [{ itemKey: c.campaignId + "-i", name: "Item" }] }));
  const research = games.map((g) => ({ game: g, markets: { gameflip: { soldRecent: 5, avgSoldPrice: 1.8, lowestOther: 2 } }, scannedAt: new Date(NOW - DAY) }));
  const demand = Array.from({ length: 5000 }, (_, i) => ({
    k: (i % NG < 30 ? noclaim[i % 30] : games[i % NG]).toLowerCase(),
    f: i % NG < 30 ? "noclaim" : "claim",
    at: new Date(NOW - (i % 6) * HOUR - 60000),
    live: true,
    br: { c: "farm", w: 3, t: 10 },
    stk: { on: 12, fl: 2 },
    est: { avg30: 3, avg45: 3 },
  }));
  const q = (list) => () => {
    const o = { sort: () => o, limit: () => o, lean: async () => list };
    return o;
  };
  const report = { at: new Date(REPORT_AT), truncated: false, games: [], ledger: { sales, demandOnly: [], suspect: [] }, prepared: { rows: prepared, setById: new Map(sets.map((s) => [s._id, s])) } };
  const af = { noClaimGames: noclaim.slice(), perMarketStock: 3, eldoradoAuto: true, g2gAuto: true, listingBrain: { enabled: true } };
  return {
    settings: { getAutoFarm: () => af, getFarmSizing: () => ({}), loadSettings: () => ({}), getUnclaimedPricing: () => ({}), getBulkPacks: () => ({}) },
    priceTracker: { getReportSWR: async () => report, suggestForNew: () => ({ price: 1.5, basis: "x", confidence: "low" }) },
    setIdentity,
    venues,
    marketReport: { getReport: async () => ({ generatedAt: new Date(NOW), games: [], feed: [] }) },
    autoLister: { derivePrice: () => 2, venuePrice: async (m, b) => b, computeSplit, dealShares, postEventPrice, platiTakesNewStock: () => false, ggselTakesNewStock: () => true },
    unclaimedBundles,
    g2gGames: { brandForGame: () => null },
    games: { listedUnits: G.listedUnits },
    packMath: { packSizeOf: PACK.packSizeOf },
    pricingEvidence: { snapshot: async () => ({}) },
    autoFarmBundles: { SOURCE_TYPE: "autofarm-bundle", priceBundle: async () => ({ price: 3 }) },
    listingModel: { readConfig: MU.readConfig, DEFAULTS: MU.DEFAULTS },
    MarketplaceListing: { find: q(rows) },
    UnclaimedAccount: { find: (f) => q(f.status === "sold" ? sold : listed)() },
    TwitchCampaign: { find: q(campaigns) },
    CampaignDrops: { find: q(manifests) },
    MarketResearch: { find: q(research) },
    DemandBrainRow: { find: q(demand) },
    DropSet: { find: q([]) },
  };
}

test("C14 the loader yields inside its long passes: no synchronous stretch over 200 ms at its read caps", async () => {
  const deps = capWorld();
  const { value: b, max } = await longestStretch(() => I.load({ now: NOW, deps }));
  assert.equal(b.listings.length, 20000);
  assert.equal(b.noclaim.units.length, 100000);
  assert.ok(b.sales.length > 20000, b.sales.length + " sales");
  assert.ok(max < 200, "longest synchronous stretch " + max + " ms");
});

/* ------------------------- batch 3: the final review (N5, LC) ------------------------- */

test("N5 the tracker is asked only for cells the model prices: no blocked or switched-off market, each cell's main offer by its advisable live rows", async () => {
  const mk = (n, m, o, st, ck, ageDays) => ({
    raw: ID(n),
    set: null,
    L: { id: H(n), g: "alpha", gl: "Alpha", m, o, f: "claim", kind: "single", st, ck, bk: "alpha|2", ex: true, n: 2, qty: 1, p: 2, c: NOW - ageDays * DAY },
  });
  const rows = [
    // Gameflip: c1 has 2 live rows; c2 has 3 rows still "active" but past Gameflip's 30-day expiry (not live for the model)
    mk(1, "gameflip", "auto", "active", "c1", 5),
    mk(2, "gameflip", "auto", "active", "c1", 6),
    mk(3, "gameflip", "auto", "active", "c2", 40),
    mk(4, "gameflip", "auto", "active", "c2", 41),
    mk(5, "gameflip", "auto", "active", "c2", 42),
    // Digiseller is blocked in code; GGSel is switched off by the owner (blocked the same way); ZeusX is off
    mk(6, "digiseller", "auto", "active", "c1", 5),
    mk(7, "ggsel", "auto", "active", "c1", 5),
    mk(8, "zeusx", "auto", "delisted", "c1", 9),
    // Eldorado: no live system row; the game's main offer would be listed new there (switch on)
    mk(9, "eldorado", "auto", "delisted", "c1", 9),
  ];
  const byIdMap = new Map(rows.map((e) => [e.raw, e]));
  const asked = [];
  const d = {
    autoLister: { computeSplit: () => ({ listNow: 0, holdBack: 0 }), dealShares: () => {}, derivePrice: () => 2, postEventPrice: (x) => x, venuePrice: async (m, b) => b },
    g2gGames: { brandForGame: () => null },
    venues,
    priceTracker: {
      suggestForNew: (rep, q) => {
        asked.push(q.market + "|" + q.items.length);
        return { price: 1.6, basis: "x", confidence: "low" };
      },
    },
    unclaimedBundles,
  };
  const af = { eldoradoAuto: true, zeusxAuto: false };
  const base = { d, af, report: { games: [] }, byId: byIdMap, demand: [], research: [], catalog: new Map(), pricing: {}, labels: new Map(), platiTakes: true, ggselTakes: false, now: NOW };
  const out = await I.oldSide({ ...base, notes: [] });
  assert.deepEqual(asked.map((x) => x.split("|")[0]).sort(), ["eldorado", "gameflip"]);
  assert.ok(out.offers["gameflip|c1"].tracker, "the cell's main offer: the one with live rows the model advises");
  assert.equal(out.offers["gameflip|c2"].tracker, null, "rows past Gameflip's expiry are not live");
  for (const k of ["digiseller|c1", "ggsel|c1", "zeusx|c1"]) assert.equal(out.offers[k].tracker, null, k);
  // the cap's note counts only the cells the model prices
  const notes = [];
  const capped = await I.oldSide({ ...base, notes, trackerCap: 1 });
  assert.equal(capped.counts.trackerCut, 1);
  assert.ok(
    notes.some((n) => /1 of 2/.test(n)),
    notes.join(" | "),
  );
  // a game × farm with only the owner's rows: its main offer comes from them, priced new on the shelf
  const owner = [mk(30, "eldorado", "manual", "active", "o1", 3), mk(31, "gameflip", "manual", "delisted", "o1", 9)];
  for (const e of owner) Object.assign(e.L, { g: "beta", gl: "Beta", f: "noclaim" });
  asked.length = 0;
  await I.oldSide({ ...base, byId: new Map(owner.map((e) => [e.raw, e])), notes: [] });
  assert.deepEqual(
    asked.map((x) => x.split("|")[0]),
    ["gameflip"],
    "the no-claim shelf only; Eldorado is claim-at-sale (managed)",
  );
});

test("N5 on the loader's own bundle the tracker is asked exactly for the offers the model reads its answer for", async () => {
  const M = require("../utils/listingBrain/model");
  const { b } = await loadWith({ platiTakes: true, af: { ggselCategoryId: "123", zeusxAuto: true } });
  const asked = new Set(Object.keys(b.old.offers).filter((k) => b.old.offers[k].tracker));
  // every `.tracker` read the model makes on the bundle's offers
  const read = new Set();
  const raw = b.old.offers;
  const watched = {};
  for (const [k, v] of Object.entries(raw)) watched[k] = new Proxy(v, { get: (t, p) => (p === "tracker" && read.add(k), t[p]) });
  M.buildRun({ ...b, old: { ...b.old, offers: watched } });
  assert.ok(read.size > 0);
  assert.deepEqual([...asked].sort(), [...read].sort());
});

test("LC the bundle's order never depends on the host's locale: plain code-unit comparison everywhere in the loader", async () => {
  // under a locale collation "épée…" sorts before "zeta…" and "alpha" before "Alpha"; in code units both reverse
  const docs = [
    { k: "zeta quest", f: "claim", at: new Date(NOW - HOUR), br: { w: 1 }, stk: { on: 1 } },
    { k: "épée arena", f: "claim", at: new Date(NOW - HOUR), br: { w: 1 }, stk: { on: 1 } },
  ];
  assert.deepEqual(
    I.demandRows({ docs, keywords: [], now: NOW }).map((r) => r.k),
    ["zeta quest", "épée arena"],
  );
  const labels = I.gameLabels({
    listings: [
      { g: "alpha", gl: "alpha", kind: "single" },
      { g: "alpha", gl: "Alpha", kind: "single" },
    ],
    report: null,
    keys: [],
  });
  assert.equal(labels.get("alpha"), "Alpha", "a tie between labels goes to the code-unit first");
  // the old side's game order (equal stock): code units
  const d = {
    autoLister: { computeSplit: () => ({ listNow: 0, holdBack: 0 }), dealShares: () => {}, derivePrice: () => 2, postEventPrice: (x) => x, venuePrice: async (m, b) => b },
    g2gGames: { brandForGame: () => null },
    venues,
    priceTracker: { suggestForNew: () => null },
    unclaimedBundles,
  };
  const demand = [
    { k: "épée arena", f: "claim", on: 2 },
    { k: "zeta quest", f: "claim", on: 2 },
  ];
  const out = await I.oldSide({
    d,
    af: {},
    report: { games: [] },
    byId: new Map(),
    demand,
    research: [],
    catalog: new Map(),
    pricing: {},
    labels: new Map(),
    platiTakes: false,
    ggselTakes: false,
    now: NOW,
    notes: [],
  });
  assert.deepEqual(Object.keys(out.games), ["zeta quest", "épée arena"]);
  assert.ok(!/localeCompare/.test(SRC), "no locale-dependent comparison in inputs.js");
});
