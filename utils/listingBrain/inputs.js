// Everything the listing brain reads, in one place (docs/LISTING-BRAIN-PLAN.md §2), turned into ONE
// plain-JSON bundle (§2.1). The pure model reads the bundle; scripts/listing-brain-export.js writes
// the same object to a file and loadFromBundle() reads it back, so every number a run logs can be
// reproduced offline from one file.
//
// READ-ONLY BY CONSTRUCTION. Every source is a report another module already builds and caches
// (the price tracker, the market radar) or a plain database read that is projected, limited and
// lean. Nothing here writes, calls a marketplace, opens SSH or touches a setting. The only module-level
// requires are Node's crypto and fs: every real dependency is loaded inside realDeps(), so requiring
// this file loads no model, no settings and no connector, and tests inject recording fakes instead.
//
// PRIVACY BY CONSTRUCTION. Every record is built field by field from a whitelist; no database
// document is ever spread into the bundle. Listing ids and order keys are hashed (sha1, 12 hex).
// Radar seller fields are dropped at once. privacyScan() is a second gate, not the first.
//
// MARKET NAMES. The bundle keys every market by the tracker's seven keys. The radar, MarketResearch and
// the auto-lister's market order call Digiseller "plati"; it is translated at this edge, once.
const crypto = require("crypto");
const fs = require("fs");

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;

const BUNDLE_KIND = "listing-brain-bundle";
const BUNDLE_V = 1;

// priceTracker/venues MARKETS, in its order. Repeated here (not required) so validateBundle and
// loadFromBundle work offline with nothing but this file.
const MARKETS = ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];
const KINDS = ["single", "cas", "bulk", "lot", "account", "farm"];
const ORIGINS = ["auto", "unclaimed", "manual"];
const FARMS = ["claim", "noclaim"];
const SALE_SOURCES = ["unit", "signal", "row", "hand", "shop", "unclaimed"];
const DEMAND_SOURCES = ["bulk", "bulk-order", "shop", "burst", "hand"];
// "none" is the ledger's own basis for an unpriced record (p = 0); it never prices anything.
const SALE_BASES = ["reported", "listing-now", "row", "paid", "none"];
// The radar watches three markets and names Digiseller "plati".
const RADAR_MARKETS = { gameflip: "gameflip", ggsel: "ggsel", plati: "digiseller" };
// The only other market strings a sale, a demand record or a unit may carry: the ledger's "unknown" (no
// market), a hand sale's "manual", a shop order's "shop", a bulk record's "bulk" — and "other" for
// anything else. A hand sale's market is free text an operator typed (SaleSignal.marketplace, a chat
// name, a buyer's handle), so it is never copied: it becomes "other", which the model treats exactly
// like "unknown" (no price, demand only).
const OTHER_MARKETS = ["unknown", "manual", "shop", "bulk", "other"];
const BUNDLE_MARKETS = MARKETS.concat(OTHER_MARKETS);

// Read caps, plan §2. A read that returns its cap says so in a note.
const LISTING_CAP = 20000;
const UNIT_CAP = 50000;
const CAMPAIGN_CAP = 5000;
const MANIFEST_CAP = 5000;
const RESEARCH_CAP = 2000;
const DEMAND_ROW_CAP = 5000;

// The tracker report may be built from scratch when nothing is cached (a cold process): wait for it,
// but never forever. A null report fails the load: the brain logs nothing rather than guess.
const REPORT_TIMEOUT_MS = 120000;
// A report older than this says so: its background refresh has not landed.
const STALE_REPORT_MS = 30 * MINUTE;
// venuePrice reads a DB-cached evidence snapshot; one call may never hold a run.
const VENUE_TIMEOUT_MS = 15000;
// Old-side lookups run this many games at a time (like the farm brain's engine calls).
const OLD_CONCURRENCY = 3;
// The farm brain's rows are read back max(maxDemandAgeH, this) hours plus a margin: the model ignores
// anything older than maxDemandAgeH (default 6 h, clamp ≤ 72 h), and the farm brain writes ~120 rows
// an hour — a fixed 72 h read returned ~8,600 rows and hit its 5,000 cap on every run.
const DEMAND_LOOKBACK_MIN_H = 6;
const DEMAND_LOOKBACK_MARGIN_H = 1;
// A no-claim unit listed this long before the fit window can still be live inside it.
const UNIT_LISTED_PAD_DAYS = 60;
// The backtest (plan §5) cuts 6 weeks back and fits on the window before each cut: every windowed
// read reaches that much further, or the oldest cut would see rows ended inside its window as missing.
const BACKTEST_PAD_DAYS = 42;
// unclaimedBundles.CATALOG_WINDOW_DAYS: the same wave horizon loadCatalog reads.
const CAMPAIGN_WINDOW_DAYS = 120;
// Per-row cap on unit dates (a claim-at-sale row can carry hundreds of delivery records).
const MAX_UNITS_PER_ROW = 200;
// More claim games than this is a sign something upstream went wrong; live ones are kept first.
const MAX_OLD_GAMES = 400;
// Offers priced the old way (live system-made ones first).
const MAX_OFFERS = 6000;
// The tracker's suggestForNew filters every order on each call (17–59 ms a call on Node 20 at
// production volume): it is asked only for the offers a logged row reads — each cell's main offer —
// and at most this many, the cells with live system-made rows first.
const MAX_TRACKER_OFFERS = 400;
// Database numbers that drive a loop are clamped: stock on hand (computeSplit deals that many
// placeholder accounts, dealShares is quadratic) and a set item's copies (one drop entry per copy).
const MAX_ON_HAND = 10000;
const MAX_ITEM_COPIES = 100;
// Every database read gives up after this long (maxTimeMS, server side): a stuck read fails the load
// or degrades with a note instead of holding a run open.
const READ_MAX_TIME_MS = 30000;
// $in lists are sent in chunks this long (CampaignDrops by campaign id, DropSet by set id).
const ID_CHUNK = 500;
// The event-bundle pricer's sold floor: the best price the event's own bundle sold at in this many days.
const EVENT_SOLD_FLOOR_DAYS = 30;
// The long passes over database rows pause every STEP_EVERY items and let the event loop breathe once
// YIELD_BUDGET_MS has passed since the last breath: the server delivers paid orders in this process.
const STEP_EVERY = 512;
const YIELD_BUDGET_MS = 50;
// Error text is cleaned from its first CLEAN_SCAN_CHARS characters only (what is shown is 200).
const CLEAN_SCAN_CHARS = 500;
// unclaimedAutoList.GAME_CAP: the no-claim shelf cap when the owner set none.
const CAP_DEFAULT = 70;
// The no-claim farm brain row is per keyword bucket; its forecast is split by this many days of sales.
const SHARE_DAYS = 30;
// analyze.MAX_REAL_PRICE: the tracker drops listing rows priced above this.
const JUNK_PRICE = 25;

// Keys that must never reach a bundle (SPEC §10), plus fields that may carry free text or links.
const FORBIDDEN_KEYS = new Set([
  "login",
  "logins",
  "loginLower",
  "account",
  "accountId",
  "accountLogin",
  "seller",
  "sellerName",
  "sellerScore",
  "sellerRatings",
  "dedupeKey",
  "orderId",
  "externalId",
  "note",
  "contentId",
  "twitchId",
  "poolAccountId",
  "botId",
  "container",
  "_id",
  "email",
  "password",
  "token",
  "url",
  "title",
  "description",
  "lastError",
  "rentFarmPoolId",
]);

// The projections, exactly plan §2's table. Copied per call ({ ...P }) so no driver can mutate them.
const LISTING_PROJECTION = Object.freeze({
  _id: 1,
  marketplace: 1,
  origin: 1,
  status: 1,
  price: 1,
  // IN MEMORY ONLY: a row the tracker skipped is a rent-farm window only when its title says so
  // (classifyKind). Never copied into a record.
  title: 1,
  createdAt: 1,
  updatedAt: 1,
  set: 1,
  noclaimStock: 1,
  autoClaimSet: 1,
  unclaimedGame: 1,
  accountOffer: 1,
  rentFarm: 1,
  bulkOfferId: 1,
  bulkPackSize: 1,
  lotSize: 1,
  qtyRemaining: 1,
  qtyTarget: 1,
  lastStock: 1,
  rebundledAt: 1,
  venueMinPriceUsd: 1,
  "units.addedAt": 1,
  "units.deliveredAt": 1,
});
// No login, no account id: the unit's own _id (returned by default) is used only to merge the two
// reads in memory and is never written anywhere. manualListing and note are read IN MEMORY ONLY (one
// says the unit sold through an owner's listing, the other that an operator marked it sold by hand)
// and are never copied into a record: the first is a listing id, the second free text.
const UNIT_PROJECTION = Object.freeze({
  game: 1,
  market: 1,
  status: 1,
  listedAt: 1,
  soldAt: 1,
  soldPriceUsd: 1,
  soldMarket: 1,
  expiredAt: 1,
  listingIds: 1,
  bundleKey: 1,
  manualListing: 1,
  note: 1,
  // the ledger's last write: the approximate moment a unit the lister took off sale went off (U.u)
  updatedAt: 1,
  "drops.campaign": 1,
});
const CAMPAIGN_PROJECTION = Object.freeze({ campaignId: 1, name: 1, game: 1, startAt: 1, endAt: 1 });
const MANIFEST_PROJECTION = Object.freeze({ campaignId: 1, name: 1, game: 1, "drops.itemKey": 1, "drops.name": 1 });
// What derivePrice and bundlePrice read, and nothing else.
const RESEARCH_PROJECTION = Object.freeze({ game: 1, "markets.gameflip": 1, "markets.ggsel": 1, "markets.plati": 1, scannedAt: 1 });
const DEMAND_PROJECTION = Object.freeze({
  k: 1,
  f: 1,
  at: 1,
  live: 1,
  hl: 1,
  "br.c": 1,
  "br.w": 1,
  "br.t": 1,
  "stk.on": 1,
  "stk.fl": 1,
  "est.avg30": 1,
  "est.avg45": 1,
});

/**
 * The real dependencies, loaded lazily so a require of this file loads nothing. Only the named pure
 * (or cached-read) functions of each module are handed on: the loader cannot reach listActivatedTask,
 * refillMarkets, onCampaignEnded, loadCatalog or any connector even by mistake. autoLister and
 * g2gGames load the marketplace module transitively; on production autoLister is already loaded at
 * boot (server.js), so this is a cache hit there.
 */
function realDeps() {
  const priceTracker = require("../priceTracker");
  const autoLister = require("../autoLister");
  const unclaimedBundles = require("../unclaimedBundles");
  const g2gGames = require("../g2gGames");
  return {
    settings: require("../settings"),
    priceTracker: { getReportSWR: priceTracker.getReportSWR, suggestForNew: priceTracker.suggestForNew },
    setIdentity: require("../priceTracker/setIdentity"),
    venues: require("../priceTracker/venues"),
    marketReport: require("../marketData/report"),
    autoLister: {
      derivePrice: autoLister.derivePrice,
      venuePrice: autoLister.venuePrice,
      computeSplit: autoLister.computeSplit,
      dealShares: autoLister.dealShares,
      postEventPrice: autoLister.postEventPrice,
      platiTakesNewStock: autoLister.platiTakesNewStock,
      ggselTakesNewStock: autoLister.ggselTakesNewStock,
    },
    unclaimedBundles: {
      bundlePrice: unclaimedBundles.bundlePrice,
      classifyHoldings: unclaimedBundles.classifyHoldings,
      buildEventCatalog: unclaimedBundles.buildEventCatalog,
    },
    g2gGames: { brandForGame: g2gGames.brandForGame },
    MarketplaceListing: require("../../models/MarketplaceListing"),
    UnclaimedAccount: require("../../models/UnclaimedAccount"),
    TwitchCampaign: require("../../models/TwitchCampaign"),
    CampaignDrops: require("../../models/CampaignDrops"),
    MarketResearch: require("../../models/MarketResearch"),
    DemandBrainRow: require("../../models/DemandBrainRow"),
    // The model's own config reader (pure): which keys of autoFarm.listingBrain the bundle keeps, and
    // how old a farm-brain row the model still reads.
    listingModel: (() => {
      const MU = require("./model/util");
      return { readConfig: MU.readConfig, DEFAULTS: MU.DEFAULTS };
    })(),
    // The tracker's own count of what a row holds, and bulkPacks' own pack size (both pure): the brain
    // counts with them, it keeps no copies.
    games: { listedUnits: require("../priceTracker/games").listedUnits },
    packMath: { packSizeOf: require("../bulkPacks/packMath").packSizeOf },
    // The realised-price snapshot venuePrice and priceBundle read (a DB read cached 10 minutes): warmed
    // ONCE per run, so a database hiccup is seen (venuePrice itself swallows it and answers the base).
    pricingEvidence: { snapshot: require("../pricingEvidence").snapshot },
    // Today's fifth pricer: claim event bundles (autoFarmBundles.priceBundle, Gameflip evidence).
    autoFarmBundles: (() => {
      const AFB = require("../autoFarmBundles");
      return { SOURCE_TYPE: AFB.SOURCE_TYPE, priceBundle: AFB.priceBundle };
    })(),
    DropSet: require("../../models/DropSet"),
  };
}

/* ---------------------------------- helpers ---------------------------------- */

const num = (v, d = 0) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? d : n;
};
const numOrNull = (v) => num(v, null);
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
// `|| 0` turns -0 into 0: JSON writes -0 as 0, and the bundle must read back identical.
const round1 = (v) => Math.round(num(v) * 10) / 10 || 0;
const round2 = (v) => Math.round(num(v) * 100) / 100 || 0;
const round3 = (v) => Math.round(num(v) * 1000) / 1000 || 0;
const scaled = (v, share) => (v === null || v === undefined ? null : round2(num(v) * share));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// Plain code-unit order (never localeCompare): the bundle's order — and so every cap, tie and log line
// that follows it — is the same on every host, whatever its locale or ICU build.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const yieldNow = () => new Promise((r) => setImmediate(r));

/** Epoch ms of a Date, a number or a date string; null when absent or invalid. */
function msOf(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function clampNum(v, d, lo, hi) {
  return Math.min(hi, Math.max(lo, num(v, d)));
}

/** The tracker's market key: lower-case, and the radar's / research's "plati" is Digiseller. */
function trackerMarket(m) {
  const k = lower(m);
  return k === "plati" ? "digiseller" : k;
}

/**
 * A market string as the bundle may hold it: one of the seven keys or OTHER_MARKETS, anything else
 * "other" (plan §2.1). `empty` is what an absent market reads as ("unknown" on a sale; "" on a unit,
 * where it means "not sold yet" / "not attached yet").
 */
function marketKey(m, empty = "unknown") {
  const k = trackerMarket(m);
  if (!k) return empty;
  return BUNDLE_MARKETS.includes(k) ? k : "other";
}

/** sha1 of the id, first 12 hex: stable across runs, never the database id. */
function hashId(id) {
  return crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 12);
}
// Listing ids are compared lower-cased everywhere (the ledger's listingId is idStr = lower-case), and
// hashed lower-cased.

/**
 * hashId, memoised for one load: a listing id is hashed for its row, its sales and every unit naming
 * it (~200,000 sha1 calls at production volume — 0.7 s on Node 20 — for ~20,000 distinct ids).
 */
function makeHasher() {
  const cache = new Map();
  const h = (id) => {
    const k = String(id);
    let v = cache.get(k);
    if (v === undefined) {
      v = hashId(k);
      cache.set(k, v);
    }
    return v;
  };
  h.cache = cache;
  return h;
}

/**
 * The event loop's breath: resolves at once until `budgetMs` has passed since the last breath, then
 * yields (setImmediate). Awaited between steps and inside every long pass, it keeps the loader's
 * synchronous stretches near the budget whatever the volume or the Node version.
 */
function makeBreather(budgetMs = YIELD_BUDGET_MS) {
  // wall time, only to pace the yields: every date in the bundle comes from `now`
  let next = Date.now() + budgetMs;
  return async () => {
    if (Date.now() < next) return;
    await yieldNow();
    next = Date.now() + budgetMs;
  };
}

// A long pass is a generator that pauses every STEP_EVERY items: drain() runs it straight through (the
// synchronous API the tests and scripts use), drainAsync() breathes at each pause.
function drain(it) {
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
async function drainAsync(it, breathe) {
  let r = it.next();
  while (!r.done) {
    await breathe();
    r = it.next();
  }
  return r.value;
}
// Every database read carries the server-side time limit (a find option, so the chain is unchanged).
const READ_OPTS = Object.freeze({ maxTimeMS: READ_MAX_TIME_MS });
const readOpts = () => ({ ...READ_OPTS });

// A network error names its peer right after its code word ("getaddrinfo ENOTFOUND mongo-primary"),
// often a bare name with no dot or port that no other rule would recognise.
const NET_CODE_RE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EPIPE|querySrv(?:\s+E[A-Z_]+)?)(\s+)(?!<)[^\s,;)]+/g;
// "host mongo-primary-7", "connect to db-2", "connection 5 to node-1": the peer after a network word,
// when it looks like a name (a digit, a dot or a dash in it — "the host is down" stays readable).
const NET_WORD_RE = /\b(host(?:name)?|connect(?:ion)?(?:\s+\d+)?\s+to(?:\s+host)?)(\s+)(?!<)(?=[^\s,;)]*[\d.-])[^\s,;)]+/gi;
// key=value / key: value pairs whose key names a credential or a person.
// Bounded identifiers ({0,40}): an unbounded [\w-]* on both sides backtracked quadratically on
// "key-key-key-…" (2,000 characters took ~0.9 s).
const SECRET_PAIR_RE = /\b([\w-]{0,40}(?:api[_-]?key|key|token|secret|passw(?:or)?d|pwd|login|user(?:name)?|email|seller|buyer|account)[\w-]{0,40})(\s*[=:]\s*)(?!<)("[^"]*"|'[^']*'|[^\s&,;)]+)/gi;
// IPv6: a whole token of hex digits and colons that holds "::" (2001:db8::5, fe80::1, ::1, a trailing
// :port included) or the full eight groups. Whole-token, so no digit of the address is left behind.
const IPV6_RE = /(?<![\w:])(?:(?=[0-9a-f:]*::)[0-9a-f:]{3,}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})(?![\w:])/gi;
const HOST_TLDS = "com|net|org|io|dev|local|internal|cloud|app|co|uk|de|ru|xyz|info|biz|me|tech|lan|host|lk|gg|ovh|store|shop|site|online|top|us|eu|in|cc|tv|ai|invalid|example|localdomain";

/**
 * An error's message with infrastructure and personal detail removed: notes, lastError and route
 * errors travel inside the bundle, the run log and the API, and a driver error can name a host, an
 * address, a file path, a document id, a query filter with a login in it, or a credential. What
 * stays is the error's class and code words ("getaddrinfo ENOTFOUND <host>", "E11000 duplicate key
 * error … dup key: <obj>") and the code-like names that say what failed ("d.MarketResearch.find is
 * not a function").
 */
function cleanMsg(e) {
  // bounded: only the first CLEAN_SCAN_CHARS characters are scanned (and 200 shown), so no rule can
  // spend more than a few milliseconds whatever the message holds
  let s = String((e && e.message) || e || "error").slice(0, CLEAN_SCAN_CHARS);
  // links first: a URI carries user:password@host
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
  s = s.replace(/\bbearer\s+\S+/gi, "Bearer <secret>");
  // object echoes (a dup key { loginLower: "…" }, a query filter) and quoted values carry data
  // (innermost first; the placeholder has no braces, so the next pass collapses the enclosing one)
  for (let i = 0; i < 6 && /\{[^{}]*\}/.test(s); i++) s = s.replace(/\{[^{}]*\}/g, "<obj>");
  s = s.replace(/"[^"]*"/g, '"<value>"');
  // a quote that opens after a letter is an apostrophe ("can't"), not a quoted value
  s = s.replace(/(^|[^\w])'[^']*'(?!\w)/g, "$1'<value>'");
  s = s.replace(SECRET_PAIR_RE, "$1$2<value>");
  s = s.replace(/\b(unescaped characters)\s+\S+/gi, "$1 <value>");
  // network peers
  s = s.replace(/\[[0-9a-f:.]+\](?::\d+)?/gi, "<host>");
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>");
  s = s.replace(IPV6_RE, "<ip>");
  s = s.replace(NET_CODE_RE, "$1$2<host>");
  s = s.replace(NET_WORD_RE, "$1$2<host>");
  s = s.replace(/\S+@\S+/g, "<address>");
  // file paths: Windows (C:\…, \\server\share) and POSIX (one segment or more)
  s = s.replace(/\b[a-z]:\\[^\s'"]*/gi, "<path>");
  s = s.replace(/\\\\[^\s'"]+/g, "<path>");
  s = s.replace(/(^|[\s'"(=,])(?:~|\.{1,2})?\/[\w.~@%+-]+(?:\/[\w.~@%+-]*)*/g, "$1<path>");
  s = s.replace(/[0-9a-f]{24}/gi, "<id>");
  // a name with a port ("localhost:27017"), a lower-case name of three or more labels
  // ("db01.prod.myshop.lk"), a two-label name ending in a network suffix ("myshop.ovh"); code-like
  // dotted names keep their capitals and stay readable ("d.MarketResearch.find is not a function")
  s = s.replace(/\b[\w-]+(\.[\w-]+)*:\d{2,5}\b/g, "<host>");
  s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+){2,}\b/g, "<host>");
  s = s.replace(new RegExp("\\b[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(" + HOST_TLDS + ")\\b", "gi"), "<host>");
  // a long random-looking token (letters and digits, 20+) is a credential whatever its key
  s = s.replace(/\b(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[a-z])[\w-]{20,}\b/gi, "<secret>");
  return s.slice(0, 200);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      // Let delivery and the guardians run between lookups.
      await yieldNow();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Rejects after `ms` (the underlying call keeps running; its answer is simply not waited for). */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + " took longer than " + Math.round(ms / 100) / 10 + " s")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The windows every read uses, from the brain's own config block (plan §8 defaults and clamps,
 * repeated so the loader needs no model): the widest fit window, the reference window, and the
 * backtest's six weeks on top.
 *
 * The listing read and the sold-unit read reach back as far as sales are kept (saleDays, 222 d by
 * default): a no-claim lister's sale is booked only when its row is in the listing read and its unit
 * in the unit read, so a shorter window cut the no-claim reference history at ~132 d while the claim
 * farm's ledger history ran to 222 d. The cost: the non-active part of the listing read covers ~90
 * more days of rows (the same projection, newest first, still capped at LISTING_CAP), and the
 * sold-unit read ~90 more days of sold units (indexed {status, soldAt}, still capped at UNIT_CAP).
 */
function readWindows(af) {
  const lb = af && isObj(af.listingBrain) ? af.listingBrain : {};
  const fitClaim = clampNum(lb.fitDaysClaim, 90, 14, 180);
  const fitNoclaim = clampNum(lb.fitDaysNoclaim, 30, 7, 120);
  const refDays = clampNum(lb.refDays, 180, 30, 365);
  const fitDays = Math.max(fitClaim, fitNoclaim);
  const saleDays = Math.max(refDays, fitDays) + BACKTEST_PAD_DAYS;
  return {
    fitDays,
    refDays,
    listingDays: saleDays,
    unitListedDays: fitDays + BACKTEST_PAD_DAYS + UNIT_LISTED_PAD_DAYS,
    unitSoldDays: saleDays,
    saleDays,
  };
}

/**
 * How far back the farm brain's rows are read: max(the model's maxDemandAgeH, 6) hours plus a
 * margin. The model's own readConfig decides maxDemandAgeH (its default, clamp and typo rule), so the
 * read can never be shorter than what the model accepts; without it, the model's default (6 h).
 */
function demandLookbackH(af, listingModel) {
  let h = DEMAND_LOOKBACK_MIN_H;
  try {
    if (listingModel && typeof listingModel.readConfig === "function") h = num(listingModel.readConfig(af || {}).maxDemandAgeH, h);
  } catch {
    h = DEMAND_LOOKBACK_MIN_H;
  }
  return Math.max(h, DEMAND_LOOKBACK_MIN_H) + DEMAND_LOOKBACK_MARGIN_H;
}

/** The no-claim keyword buckets, normalised like the farm brain does (setIdentity.normGame). */
function noclaimKeywords(af, normGame) {
  const list = af && Array.isArray(af.noClaimGames) ? af.noClaimGames : [];
  return [...new Set(list.map((g) => normGame(String(g || ""))).filter(Boolean))];
}

/** farmDemand.bucketFor's rule: the LONGEST keyword contained in the game key, or "". */
function bucketOfKey(key, keywords) {
  const k = String(key || "");
  let best = "";
  if (!k) return best;
  for (const w of keywords || []) if (w && k.includes(w) && w.length > best.length) best = w;
  return best;
}

/**
 * Kind of a row, plan §3 order (the first match wins). Claim-at-sale is decided from the flags, BEFORE
 * origin: the G2G operator-script rows are origin "auto" AND autoClaimSet, and are never advised.
 * `trackerKind` is the tracker's identify() kind ("farm" for a rent-farm title the flags miss).
 */
function kindOf(x, trackerKind = "drops") {
  if ((x && x.rentFarm) || trackerKind === "farm") return "farm";
  // a pack is a row with bulkOfferId (bulkPacks/packMath's rule): bulkPackSize alone makes no pack
  if ((x && x.bulkOfferId) || trackerKind === "bulk") return "bulk";
  if (num(x && x.lotSize) > 1) return "lot";
  if (x && x.accountOffer) return "account";
  if (x && (x.noclaimStock || x.autoClaimSet || x.unclaimedGame)) return "cas";
  return "single";
}

/**
 * Farm of a row, plan §3: no-claim pool flags and the no-claim lister are "noclaim"; the claim farm's
 * lister and its Drop Archive rows are "claim"; a hand-made row follows its game's no-claim bucket.
 */
function farmOf(row, gameKey, keywords) {
  const r = row || {};
  if (r.noclaimStock || r.unclaimedGame) return "noclaim";
  if (r.autoClaimSet) return "claim";
  const o = r.origin || "manual";
  if (o === "unclaimed") return "noclaim";
  if (o === "auto") return "claim";
  return bucketOfKey(gameKey, keywords) ? "noclaim" : "claim";
}

/** autoLister's zeusxGameMapped (not exported there), verbatim. */
function zeusxMapped(af, game) {
  const map = (af && af.zeusxGames) || {};
  const key = String(game || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return Object.keys(map).some((k) => k === key || key.includes(k) || k.includes(key));
}

// The auto-lister's market order uses "plati"; the bundle uses the tracker's key.
const orderMarket = (m) => (m === "plati" ? "digiseller" : m);

/**
 * The brain's own config block as the bundle keeps it: only the keys the model knows (its DEFAULTS),
 * each a primitive or an array of numbers, raw (the model's readConfig validates them when it reads
 * the bundle). Anything else the owner typed into autoFarm.listingBrain — a comment, a link, a key —
 * never travels in a bundle. With no list of known keys, nothing is copied.
 */
function configBlock(obj, keys) {
  const out = {};
  if (!isObj(obj) || !Array.isArray(keys)) return out;
  const prim = (v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (prim(v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x))) out[k] = v.slice();
  }
  return out;
}

/* ---------------------------------- settings ---------------------------------- */

/**
 * The owner's settings, read once per run (settings re-read their file on every getter call). Read
 * FIRST, before any database read: a run that cannot read the switches abstains and loads nothing.
 */
function settingsBlock(d) {
  try {
    const af = d.settings.getAutoFarm();
    if (!isObj(af)) throw new Error("getAutoFarm returned no settings object");
    const sz = d.settings.getFarmSizing(af) || {};
    const sizing = { coverageDays: num(sz.coverageDays, 28), safetyStock: num(sz.safetyStock, 6), maxPerGame: num(sz.maxPerGame, 250) };
    // Top-level settings.priceTracker.fees (NOT autoFarm.priceTracker, the attach seam's config).
    const all = typeof d.settings.loadSettings === "function" ? d.settings.loadSettings() : null;
    const rawFees = all && isObj(all.priceTracker) && isObj(all.priceTracker.fees) ? all.priceTracker.fees : {};
    const fees = {};
    for (const m of MARKETS) if (rawFees[m] !== undefined && numOrNull(rawFees[m]) !== null) fees[m] = num(rawFees[m]);
    const up = d.settings.getUnclaimedPricing() || {};
    const gameFloors = {};
    if (isObj(up.gameFloors)) for (const [k, v] of Object.entries(up.gameFloors)) if (numOrNull(v) !== null) gameFloors[String(k)] = num(v);
    // bundlePrice stays pure only when `pricing.gameFloors` is an object: it always is here.
    const pricing = {
      floorUsd: num(up.floorUsd, 0.75),
      ceilingUsd: num(up.ceilingUsd, 4.5),
      gameFloors,
      itemStepPct: num(up.itemStepPct, 15),
      itemCapMult: num(up.itemCapMult, 2.5),
      fullEventBonusPct: num(up.fullEventBonusPct, 25),
    };
    const bp = d.settings.getBulkPacks(af) || {};
    const bulk = {
      markets: (Array.isArray(bp.markets) ? bp.markets : []).map(trackerMarket).filter((m) => MARKETS.includes(m)),
      tiers: (Array.isArray(bp.tiers) ? bp.tiers : []).filter(isObj).map((t) => ({ size: num(t.minQty), discountPct: num(t.discountPct) })),
      reserveSingles: num(bp.reserveSingles, 5),
    };
    return { af, sizing, fees, pricing, bulk };
  } catch (e) {
    throw new Error("listing brain: settings unreadable (" + cleanMsg(e) + "): nothing loaded");
  }
}

/* ----------------------------------- reads ----------------------------------- */

/**
 * The one extra listing read (plan §1.3 #2): the flags and exposure dates the tracker does not
 * project. The tracker's own query shape — every market, newest first, capped — so it rides the same
 * index ({marketplace, _id}); an $or on the unindexed updatedAt would be a collection scan. The window
 * (active rows, and rows written inside saleDays: see readWindows for why) is applied here, in memory.
 */
async function readListings(d, now, W, breathe = yieldNow) {
  const all =
    (await d.MarketplaceListing.find({ marketplace: { $in: MARKETS.slice() } }, { ...LISTING_PROJECTION }, readOpts())
      .sort({ _id: -1 })
      .limit(LISTING_CAP)
      .lean()) || [];
  const since = now - W.listingDays * DAY;
  const rows = [];
  let outside = 0;
  for (let i = 0; i < all.length; i++) {
    const x = all[i];
    if (!x) continue;
    const u = msOf(x.updatedAt);
    if (x.status === "active" || (u !== null && u >= since)) rows.push(x);
    else outside++;
    if ((i + 1) % (STEP_EVERY * 4) === 0) await breathe();
  }
  return { rows, read: all.length, outside, truncated: all.length >= LISTING_CAP };
}

/**
 * No-claim units: two indexed reads (listed recently; sold recently), merged by document. Sorted on
 * their indexed date so a capped read loses the oldest, never a random slice. The sold read leaves out
 * what the listed read already returns (listed inside its window) — it stays on {status, soldAt} and
 * still takes the never-listed units (listedAt null: a hand sale of free stock).
 */
async function readUnits(d, now, W, breathe = yieldNow) {
  const listedSince = new Date(now - W.unitListedDays * DAY);
  const listed =
    (await d.UnclaimedAccount.find({ listedAt: { $gte: listedSince } }, { ...UNIT_PROJECTION }, readOpts())
      .sort({ listedAt: -1 })
      .limit(UNIT_CAP)
      .lean()) || [];
  await yieldNow();
  const sold =
    (await d.UnclaimedAccount.find(
      { status: "sold", soldAt: { $gte: new Date(now - W.unitSoldDays * DAY) }, $or: [{ listedAt: { $lt: listedSince } }, { listedAt: null }] },
      { ...UNIT_PROJECTION },
      readOpts(),
    )
      .sort({ soldAt: -1 })
      .limit(UNIT_CAP)
      .lean()) || [];
  const byDoc = new Map();
  let anon = 0;
  let n = 0;
  for (const list of [listed, sold]) {
    for (const u of list) {
      if (++n % (STEP_EVERY * 4) === 0) await breathe();
      if (!u) continue;
      const k = u._id !== undefined && u._id !== null ? String(u._id) : "anon:" + anon++;
      if (!byDoc.has(k)) byDoc.set(k, u);
    }
  }
  return { docs: [...byDoc.values()], read: [listed.length, sold.length], truncated: { listed: listed.length >= UNIT_CAP, sold: sold.length >= UNIT_CAP } };
}

/**
 * Wave ends: the campaigns of the catalog window and their drop manifests, both bounded, for the
 * pure buildEventCatalog (never loadCatalog, which reads without a limit). Open-ended campaigns
 * (endAt null: campaignWatcher stores null when Twitch gives no end) are read too, as loadCatalog
 * does. Sorted by endAt descending: Mongo orders null below every date, so the dated campaigns come
 * first, newest first, and the cap can only ever drop open-ended ones. Manifests are asked for in
 * chunks of ID_CHUNK campaign ids (one $in of 5,000 is one heavy query).
 */
async function readCampaigns(d, now) {
  const campaigns =
    (await d.TwitchCampaign.find({ $or: [{ endAt: { $gte: new Date(now - CAMPAIGN_WINDOW_DAYS * DAY) } }, { endAt: null }] }, { ...CAMPAIGN_PROJECTION }, readOpts())
      .sort({ endAt: -1 })
      .limit(CAMPAIGN_CAP)
      .lean()) || [];
  const ids = [...new Set(campaigns.map((c) => (c && c.campaignId ? String(c.campaignId) : "")).filter(Boolean))];
  const manifests = [];
  for (let i = 0; i < ids.length && manifests.length < MANIFEST_CAP; i += ID_CHUNK) {
    await yieldNow();
    const chunk = ids.slice(i, i + ID_CHUNK);
    const got =
      (await d.CampaignDrops.find({ campaignId: { $in: chunk } }, { ...MANIFEST_PROJECTION }, readOpts())
        .limit(ID_CHUNK)
        .lean()) || [];
    for (const m of got) manifests.push(m);
  }
  return { campaigns, manifests, truncated: { campaigns: campaigns.length >= CAMPAIGN_CAP, manifests: manifests.length >= MANIFEST_CAP } };
}

/** MarketResearch, projected to what derivePrice and bundlePrice read. */
async function readResearch(d) {
  const rows =
    (await d.MarketResearch.find({}, { ...RESEARCH_PROJECTION }, readOpts())
      .limit(RESEARCH_CAP)
      .lean()) || [];
  return { rows, truncated: rows.length >= RESEARCH_CAP };
}

/** The farm brain's rows of the last `lookbackH` hours (demandLookbackH), newest first (the {at} index). */
async function readDemandRows(d, now, lookbackH = DEMAND_LOOKBACK_MIN_H + DEMAND_LOOKBACK_MARGIN_H) {
  const rows =
    (await d.DemandBrainRow.find({ at: { $gte: new Date(now - lookbackH * HOUR) } }, { ...DEMAND_PROJECTION }, readOpts())
      .sort({ at: -1 })
      .limit(DEMAND_ROW_CAP)
      .lean()) || [];
  return { rows, truncated: rows.length >= DEMAND_ROW_CAP };
}

/**
 * Which of the claim auto rows' sets are event bundles (C13): DropSet.sourceType, which the tracker's
 * set read does not project. Bounded by the ids asked (the sets of the listing read's claim auto rows),
 * in chunks of ID_CHUNK, projected to the marker and its event key. The event key is used in memory
 * only (the event's sold floor), never copied.
 * @returns {Promise<Map<string, string>>} set id (lower-case) → event key
 */
async function readEventSets(d, setIds, sourceType) {
  const out = new Map();
  const ids = [...new Set(setIds || [])].filter(Boolean);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const got =
      (await d.DropSet.find({ _id: { $in: chunk }, sourceType }, { _id: 1, sourceType: 1, sourceEventKey: 1 }, readOpts())
        .limit(ID_CHUNK)
        .lean()) || [];
    for (const x of got) if (x && x._id !== undefined && x.sourceType === sourceType) out.set(lower(x._id), String(x.sourceEventKey || ""));
    await yieldNow();
  }
  return out;
}

/* --------------------------------- listings --------------------------------- */

/**
 * Does this title name a rent-farm window (marketPricing.classifyKind, through identify)? The title
 * is the extra read's, fresh; it is read here and nowhere else, and never copied.
 */
function farmTitle(d, x) {
  const title = typeof x.title === "string" ? x.title : "";
  if (!title) return false;
  try {
    return d.setIdentity.identify({ title, rentFarm: false, bulkOfferId: null }, null).kind === "farm";
  } catch {
    return false;
  }
}

/** Identity of a row the tracker did not prepare: from its set (if the report holds it) or its game. */
function identityOf(d, x, set) {
  try {
    const items = set && Array.isArray(set.items) ? set : null;
    return d.setIdentity.identify({ title: "", unclaimedGame: x.unclaimedGame || "", rentFarm: !!x.rentFarm, bulkOfferId: x.bulkOfferId || null }, items);
  } catch {
    return { kind: x.rentFarm ? "farm" : x.bulkOfferId ? "bulk" : "drops", game: "", gameKey: "", contentKey: null, bandKey: "|?", countForBand: null, exact: false };
  }
}

/**
 * Listing rows (L, plan §2.1), joined to the tracker's prepared rows by listing id. The tracker's own
 * row gives identity, price, status and dates (the same snapshot its ledger was built from); the
 * extra read gives the flags, the unit dates and the quantities. A row only in the extra read is still
 * classified so counts are right: the tracker skips rent-farm, bulk and junk-priced rows, and a row
 * newer than its report. A row is kind "farm" (ignored by the model) only when its flag says so or
 * its FRESH title is a rent-farm title (classifyKind). Any other gap — the tracker's read was capped,
 * or the row was repriced since the report (the tracker skipped it by its cached price, the fresh
 * price is fine) — leaves the row its kind by its flags, counted as `unexplained` with a note: a
 * repriced row must not be misfiled as a rent-farm window and vanish from the evidence.
 * What a row holds now is the tracker's own count (games.listedUnits, through deps; null without it)
 * and a pack's size is bulkPacks/packMath's (a row without bulkOfferId is no pack): no copies.
 * @returns {{ listings: object[], byId: Map<string, {L: object, set: object|null, setId: string, raw: string}>, counts: object }}
 */
function normaliseListings(o) {
  return drain(normaliseListingsSteps(o));
}

function* normaliseListingsSteps({ d, report, rows, keywords, hash = hashId }) {
  const listedUnitsOf = d.games && typeof d.games.listedUnits === "function" ? (l) => numOrNull(d.games.listedUnits(l)) : () => null;
  const packSizeOf = d.packMath && typeof d.packMath.packSizeOf === "function" ? (row) => Math.floor(num(d.packMath.packSizeOf(row), 1)) : () => 1;
  const prepared = new Map();
  for (const r of (report && report.prepared && report.prepared.rows) || []) if (r && r.l && r.listingId) prepared.set(lower(r.listingId), r);
  const setById = report && report.prepared && report.prepared.setById instanceof Map ? report.prepared.setById : new Map();
  const reportAt = msOf(report && report.at);
  const trackerComplete = !(report && report.truncated);
  const listings = [];
  const byId = new Map();
  const c = {
    read: 0,
    inReport: 0,
    notInReport: 0,
    newer: 0,
    farmByTitle: 0,
    junkPrice: 0,
    unexplained: 0,
    unexplainedComplete: 0,
    unitsCut: 0,
    farm: 0,
    cas: 0,
    script: 0,
    bulk: 0,
    lot: 0,
    account: 0,
    single: 0,
  };
  let step = 0;
  for (const x of rows || []) {
    if (++step % STEP_EVERY === 0) yield;
    if (!x || x._id === undefined || x._id === null) continue;
    const raw = lower(x._id);
    if (!raw || byId.has(raw)) continue;
    const m = trackerMarket(x.marketplace);
    if (!MARKETS.includes(m)) continue;
    c.read++;
    const p = prepared.get(raw) || null;
    const base = p ? p.l : x;
    const set = x.set !== undefined && x.set !== null ? setById.get(lower(x.set)) || null : null;
    let id;
    let trackerKind = "drops";
    if (p) {
      id = p.id || identityOf(d, x, set);
      c.inReport++;
    } else {
      c.notInReport++;
      id = identityOf(d, x, set);
      trackerKind = id.kind || "drops";
      const created = msOf(x.createdAt);
      if (trackerKind === "drops" && !x.rentFarm && farmTitle(d, x)) {
        trackerKind = "farm";
        c.farmByTitle++;
      } else if (num(x.price) > JUNK_PRICE) c.junkPrice++;
      else if (trackerKind === "drops" && !x.bulkOfferId && !x.rentFarm) {
        if (reportAt !== null && created !== null && created >= reportAt) c.newer++;
        else {
          c.unexplained++;
          if (trackerComplete) c.unexplainedComplete++;
        }
      }
    }
    const kind = kindOf(x, trackerKind);
    const g = String(id.gameKey || "");
    const o = ORIGINS.includes(base.origin) ? base.origin : "manual";
    const f = farmOf({ origin: o, noclaimStock: x.noclaimStock, unclaimedGame: x.unclaimedGame, autoClaimSet: x.autoClaimSet }, g, keywords);
    const units = Array.isArray(x.units) ? x.units : [];
    if (units.length > MAX_UNITS_PER_ROW) c.unitsCut++;
    const packSize = packSizeOf({ bulkOfferId: x.bulkOfferId || null, bulkPackSize: x.bulkPackSize });
    const lotSize = Math.floor(num(x.lotSize));
    const L = {
      id: hash(raw),
      g,
      gl: String(id.game || ""),
      m,
      o,
      f,
      kind,
      script: o === "auto" && kind === "cas",
      ck: id.contentKey ? String(id.contentKey) : null,
      bk: String(id.bandKey || g + "|?"),
      ex: !!id.exact,
      n: numOrNull(id.countForBand),
      p: round2(base.price),
      vmin: round2(base.venueMinPriceUsd),
      smin: set ? round2(set.minPriceUsd) : 0,
      st: lower(base.status) || "active",
      c: msOf(base.createdAt),
      u: msOf(base.updatedAt),
      units: units.slice(0, MAX_UNITS_PER_ROW).map((u) => ({ a: msOf(u && u.addedAt), d: msOf(u && u.deliveredAt) })),
      qty: listedUnitsOf({ marketplace: m, units, lastStock: x.lastStock, qtyTarget: x.qtyTarget }),
      qr: Math.max(0, Math.floor(num(x.qtyRemaining))),
      rb: msOf(x.rebundledAt),
      // accounts per sold unit: a v2 bulk pack's size, a Gameflip lot's size (0 = a single account)
      pack: packSize >= 2 ? packSize : 0,
      lot: lotSize >= 2 ? lotSize : 0,
    };
    c[kind] = (c[kind] || 0) + 1;
    if (L.script) c.script++;
    listings.push(L);
    byId.set(raw, { L, set, setId: x.set !== undefined && x.set !== null ? lower(x.set) : "", raw });
  }
  return { listings, byId, counts: c };
}

/* ----------------------------------- sales ----------------------------------- */

/**
 * The tracker ledger as unit sales (S) and demand-only records (D), plus the bulk channel's
 * per-account prices (B). Every sale of an origin "unclaimed" row is dropped here: those come from
 * UnclaimedAccount instead (plan §1.3 #3), so the same unit is never counted twice.
 * `ledgerBulk` counts the ledger's bulk records per pack row, so a no-claim pack unit the ledger
 * already holds is not added again.
 */
function saleRecords(o) {
  return drain(saleRecordsSteps(o));
}

function* saleRecordsSteps({ report, byId, keywords, since, hash = hashId }) {
  let step = 0;
  const sales = [];
  const demandOnly = [];
  const bulkPrices = [];
  const ledgerBulk = new Map();
  const c = { ledger: 0, unclaimedDropped: 0, outside: 0, unknownSource: 0, demandOnly: 0, unclaimedDemandDropped: 0, bulkUnpriced: 0, bulkRowSales: 0 };
  const ledger = (report && report.ledger) || {};
  const packPrice = (e, g, m, t) => {
    if (e && e.L.pack >= 2 && e.L.p > 0) bulkPrices.push({ g, m, t, pa: round2(e.L.p / e.L.pack), size: e.L.pack });
    else c.bulkUnpriced++;
  };
  for (const s of Array.isArray(ledger.sales) ? ledger.sales : []) {
    if (++step % STEP_EVERY === 0) yield;
    if (!s) continue;
    const t = msOf(s.at);
    if (t === null || t < since) {
      c.outside++;
      continue;
    }
    const origin = ORIGINS.includes(s.origin) ? s.origin : "manual";
    if (origin === "unclaimed") {
      c.unclaimedDropped++;
      continue;
    }
    if (!SALE_SOURCES.includes(s.source)) {
      c.unknownSource++;
      continue;
    }
    const raw = lower(s.listingId);
    const e = raw ? byId.get(raw) || null : null;
    const g = String(s.gameKey || (e && e.L.g) || "");
    const m = marketKey(s.market);
    const f = e ? e.L.f : farmOf({ origin }, g, keywords);
    // A row the loader knows to be a pack (bulkPackSize without the tracker's bulkOfferId test) is
    // demand only, never a single-unit price.
    if (e && e.L.kind === "bulk") {
      demandOnly.push({ g, m, f, t, src: "bulk" });
      packPrice(e, g, m, t);
      c.bulkRowSales++;
      continue;
    }
    const priced = s.priced !== false && num(s.priceUsd) > 0;
    sales.push({
      lid: raw ? hash(raw) : "",
      g,
      m,
      o: origin,
      f,
      ck: s.contentKey ? String(s.contentKey) : null,
      bk: String(s.bandKey || g + "|?"),
      ex: !!s.exact,
      n: numOrNull(s.itemCount),
      p: priced ? round2(s.priceUsd) : 0,
      t,
      grp: hashId(String(s.saleGroup || s.key || "t:" + t)),
      basis: priced ? (SALE_BASES.includes(s.priceBasis) && s.priceBasis !== "none" ? s.priceBasis : "reported") : "none",
      src: s.source,
    });
    c.ledger++;
  }
  for (const x of Array.isArray(ledger.demandOnly) ? ledger.demandOnly : []) {
    if (++step % STEP_EVERY === 0) yield;
    if (!x) continue;
    const t = msOf(x.at);
    if (t === null || t < since) continue;
    const origin = ORIGINS.includes(x.origin) ? x.origin : "manual";
    if (origin === "unclaimed") {
      c.unclaimedDemandDropped++;
      continue;
    }
    // A real-pass burst keeps its original source (signal/row) with burst: true.
    const src = x.burst ? "burst" : DEMAND_SOURCES.includes(x.source) ? x.source : null;
    if (!src) {
      c.unknownSource++;
      continue;
    }
    const raw = lower(x.listingId);
    const e = raw ? byId.get(raw) || null : null;
    const g = String(x.gameKey || (e && e.L.g) || "");
    const m = marketKey(x.market);
    const f = e ? e.L.f : farmOf({ origin }, g, keywords);
    demandOnly.push({ g, m, f, t, src });
    c.demandOnly++;
    if (src === "bulk" && raw) {
      ledgerBulk.set(raw, (ledgerBulk.get(raw) || 0) + 1);
      packPrice(e, g, m, t);
    }
  }
  return { sales, demandOnly, bulkPrices, ledgerBulk, counts: c };
}

// spendAccount's reason from the operator's "Mark an account sold by hand" route
// (POST /api/unclaimed-auto/sell/:id): the ledger then carries the shelf market and price as if the
// platform had sold it, and only this note says otherwise.
const MARK_SOLD_RE = /^manual mark sold/i;

/**
 * The row a sold unit's sale belongs to: among its named origin-"unclaimed" rows on the market it sold
 * on that existed when it sold (createdAt ≤ soldAt), the NEWEST. listingIds only grow — a GGSel set
 * rebuilt into a new offer ($addToSet), a Gameflip successor row, a lot the unit once sat in — so the
 * oldest named row is usually not the one that sold. With no sold market stamped (old ledgers), the
 * newest such row on the unit's own market, else on any market.
 */
function saleRowOf(ours, t, sm, unitMarket) {
  const newest = (list) => {
    let best = null;
    for (const x of list) {
      const c = x.e.L.c;
      if (c !== null && c !== undefined && c > t) continue;
      const k = c === null || c === undefined ? -Infinity : c;
      if (!best || k > best.k) best = { x, k };
    }
    return best ? best.x : null;
  };
  if (sm) return newest(ours.filter((x) => x.e.L.m === sm));
  const own = unitMarket ? newest(ours.filter((x) => x.e.L.m === unitMarket)) : null;
  return own || newest(ours);
}

/**
 * No-claim units (U), and the no-claim lister's sales taken from them (plan §1.3 #3), in this order:
 * - a unit with `manualListing` sold through an owner's listing (a vault row or a claim-at-sale order):
 *   the tracker ledger holds that row's sale by its listing id, so nothing is booked here (its
 *   listingIds may still name a dead auto row from a reused ledger);
 * - a hand sale — soldMarket "manual" (handSellAccounts) or an operator's "manual mark sold" (the
 *   note; read in memory, never copied) — is demand only, whatever rows it names;
 * - else the sale belongs to the newest named origin-"unclaimed" row on its sold market created at or
 *   before the sale (saleRowOf). On a pack or lot row it is demand only with the per-account price
 *   into the bulk series; otherwise a unit sale at its PAID price when the ledger stamped one, else the
 *   row's price ("row");
 * - a unit sold on a market none of its named unclaimed rows is on was re-listed elsewhere: the tracker
 *   ledger holds that sale, so it is not counted here.
 * Every ledger record of an origin-"unclaimed" row is dropped in saleRecords, so no sale is counted
 * from both sources.
 * U.x is the expiry of the unit's CURRENT life: expireAccount stamps expiredAt and nothing clears it on
 * a re-list, so an expiredAt older than listedAt belongs to a previous life and reads null.
 */
function noclaimUnits(o) {
  return drain(noclaimUnitsSteps(o));
}

function* noclaimUnitsSteps({ d, docs, byId, since, ledgerBulk = new Map(), hash = hashId }) {
  let step = 0;
  // a few hundred games over 100,000 units: each game name is normalised once
  const games = new Map();
  const normGame = (name) => {
    let g = games.get(name);
    if (g === undefined) {
      g = d.setIdentity.normGame(name);
      games.set(name, g);
    }
    return g;
  };
  const units = [];
  const sales = [];
  const demandOnly = [];
  const bulkPrices = [];
  const c = { units: 0, sold: 0, sales: 0, paid: 0, rowPriced: 0, hand: 0, markSold: 0, ownerRow: 0, pack: 0, packInLedger: 0, elsewhere: 0, otherRows: 0, staleExpiry: 0 };
  const left = new Map(ledgerBulk);
  for (const u of docs || []) {
    if (++step % STEP_EVERY === 0) yield;
    if (!u) continue;
    const g = normGame(String(u.game || ""));
    const raws = (Array.isArray(u.listingIds) ? u.listingIds : []).map(lower).filter(Boolean);
    const camps = [];
    for (const x of Array.isArray(u.drops) ? u.drops : []) {
      const name = x && x.campaign ? String(x.campaign) : "";
      if (name && !camps.includes(name)) camps.push(name);
    }
    const st = lower(u.status);
    const l = msOf(u.listedAt);
    let x = msOf(u.expiredAt);
    if (x !== null && l !== null && x < l) {
      x = null;
      c.staleExpiry++;
    }
    const sm = marketKey(u.soldMarket, "");
    units.push({
      g,
      m: marketKey(u.market, ""),
      st,
      l,
      s: msOf(u.soldAt),
      p: round2(u.soldPriceUsd),
      sm,
      x,
      u: msOf(u.updatedAt),
      lids: raws.map(hash),
      bk: String(u.bundleKey || ""),
      camps,
    });
    c.units++;
    if (st !== "sold") continue;
    const t = msOf(u.soldAt);
    if (t === null || t < since) continue;
    c.sold++;
    if (String(u.manualListing || "")) {
      c.ownerRow++;
      continue;
    }
    const markSold = MARK_SOLD_RE.test(String(u.note || "").trim());
    if (sm === "manual" || markSold) {
      demandOnly.push({ g, m: "unknown", f: "noclaim", t, src: "hand" });
      c.hand++;
      if (markSold) c.markSold++;
      continue;
    }
    const ours = [];
    for (const r of raws) {
      const e = byId.get(r);
      if (e && e.L.o === "unclaimed") ours.push({ raw: r, e });
    }
    if (!ours.length) {
      // a pool unit sold through an owner row: the ledger records that row's sale or demand
      c.otherRows++;
      continue;
    }
    const row = saleRowOf(ours, t, sm, trackerMarket(u.market));
    if (!row) {
      c.elsewhere++;
      continue;
    }
    const L = row.e.L;
    if (L.kind === "bulk" || L.kind === "lot") {
      c.pack++;
      const k = left.get(row.raw) || 0;
      if (k > 0) {
        left.set(row.raw, k - 1);
        c.packInLedger++;
        continue;
      }
      const size = L.pack >= 2 ? L.pack : L.lot;
      demandOnly.push({ g: L.g || g, m: L.m, f: "noclaim", t, src: "bulk" });
      if (size >= 2 && L.p > 0) bulkPrices.push({ g: L.g || g, m: L.m, t, pa: round2(L.p / size), size });
      continue;
    }
    const paid = round2(u.soldPriceUsd);
    const p = paid > 0 ? paid : L.p > 0 ? L.p : 0;
    if (paid > 0) c.paid++;
    else c.rowPriced++;
    sales.push({
      lid: L.id,
      g: L.g || g,
      m: L.m,
      o: "unclaimed",
      f: "noclaim",
      ck: L.ck,
      bk: L.bk,
      ex: L.ex,
      n: L.n,
      p,
      t,
      // One detection pass is one order (the tracker's det: rule): units booked on one row within
      // the same minute share it. spendAccount stamps each unit with its own clock read.
      grp: hashId("ua:" + row.raw + ":" + Math.floor(t / MINUTE)),
      basis: paid > 0 ? "paid" : "row",
      src: "unclaimed",
    });
    c.sales++;
  }
  return { units, sales, demandOnly, bulkPrices, counts: c };
}

/* ------------------------------- waves, radar, demand ------------------------------- */

/**
 * Wave records (W) of EVERY game whose campaigns are in the read window (bounded by the campaign cap),
 * from the event catalog: the claim farm's "campaign ended and the rivals are gone → scarce" reads its
 * games' waves (price.campaignEnded), and the backtest's demand reads which games are live from them;
 * keeping only the no-claim buckets' games left both blind on real data. `name` is the raw campaign
 * name: a unit's drops carry it (drops[].campaign), and when parseWave finds a wave label ("Week 2",
 * "Wave 1") neither the label nor the event name equals it, so without it a unit could not find its
 * own wave. (They stay under bundle.noclaim.waves, where the model reads them.)
 */
function waves({ d, catalog }) {
  const out = [];
  if (!catalog || typeof catalog.values !== "function") return out;
  const games = new Map();
  for (const ev of catalog.values()) {
    if (!ev) continue;
    const name = String(ev.game || "");
    let g = games.get(name);
    if (g === undefined) games.set(name, (g = d.setIdentity.normGame(name)));
    if (!g) continue;
    for (const w of Array.isArray(ev.waves) ? ev.waves : []) {
      if (!w) continue;
      out.push({ g, ev: String(ev.name || ""), wave: String(w.waveLabel || w.name || ""), name: String(w.name || ""), startAt: msOf(w.startAt), endAt: msOf(w.endAt) });
    }
  }
  // plain code-unit order: the same on every machine, and cheap over thousands of waves
  out.sort((a, b) => cmp(a.g, b.g) || num(a.endAt, Infinity) - num(b.endAt, Infinity) || cmp(a.ev, b.ev) || cmp(a.wave, b.wave));
  return out;
}

function slimRadarMarket(b) {
  if (!isObj(b)) return null;
  const sold = isObj(b.sold) ? b.sold : {};
  return {
    perWeek: numOrNull(b.perWeek),
    liveSellers: num(b.liveSellers),
    sold: { n: num(sold.n), p25: numOrNull(sold.p25), median: numOrNull(sold.median), p75: numOrNull(sold.p75) },
    medianTtsHours: numOrNull(b.medianTtsHours),
  };
}

/**
 * The radar report, slimmed at once to what the model reads (RG, RF): no seller, no title, no link,
 * our own sales and rent-farm sales out of the feed, "plati" translated to "digiseller".
 */
function radarSlim(radar) {
  const out = { at: null, games: [], feed: [] };
  if (!isObj(radar)) return out;
  out.at = msOf(radar.generatedAt);
  for (const r of Array.isArray(radar.games) ? radar.games : []) {
    if (!r || !r.key) continue;
    const bm = isObj(r.byMarket) ? r.byMarket : {};
    const byMarket = {};
    for (const [rk, tk] of Object.entries(RADAR_MARKETS)) byMarket[tk] = slimRadarMarket(bm[rk]);
    out.games.push({ key: String(r.key), perWeek: numOrNull(r.perWeek), rivalSellers: num(r.rivalSellers), medianTtsHours: numOrNull(r.medianTtsHours), byMarket });
  }
  for (const s of Array.isArray(radar.feed) ? radar.feed : []) {
    if (!s || s.ours || s.kind === "farm") continue;
    const m = RADAR_MARKETS[lower(s.market)];
    const t = msOf(s.soldAt);
    if (!m || t === null) continue;
    out.feed.push({ g: String(s.gameKey || ""), m, p: numOrNull(s.priceUsd), u: round1(num(s.units, 1)), n: numOrNull(s.itemCount), t, tts: numOrNull(s.ttsHours) });
  }
  return out;
}

/**
 * settings.normGameName's rule, repeated (this file requires no settings): a–z and 0–9 only. The farm
 * brain keys a no-claim row by normGameName(keyword) (farmDemand.noClaimKeys), while the loader's
 * keywords and game keys use setIdentity.normGame (Unicode letters kept): "Pokémon UNITE" is
 * "pok mon unite" there and "pokémon unite" here.
 */
const asciiKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The farm brain's newest row per (k, f) (DR). A no-claim row is per keyword BUCKET; it is expanded to
 * the bucket's games (SPEC §2): each game's weekly forecast, target and in-flight are the bucket's ×
 * its share of the bucket's no-claim unit sales in the last 30 days (when none sold there is nothing
 * to split by: the games get no row and read unknown, counted in stats.unsplit);
 * its stock on hand is its own listed units plus the bucket's remaining stock × the same share (the
 * farm brain's on-hand is listed + held; the held part is not per game anywhere).
 */
function demandRows(o) {
  return drain(demandRowsSteps(o));
}

function* demandRowsSteps({ docs, keywords, listings = [], units = [], sales = [], demandOnly = [], now, stats = {} }) {
  let step = 0;
  stats.unsplit = stats.unsplit || 0;
  const newest = new Map();
  for (const r of docs || []) {
    if (!r || !r.k) continue;
    const f = r.f === "noclaim" ? "noclaim" : r.f === "claim" ? "claim" : null;
    const at = msOf(r.at);
    if (!f || at === null) continue;
    const key = String(r.k) + "|" + f;
    const cur = newest.get(key);
    if (!cur || at > cur.at) newest.set(key, { r, f, at });
  }
  const bucketGames = new Map();
  // a few hundred game keys over 100,000+ records: each key's bucket is worked out once
  const bucketMemo = new Map();
  const bucketOf = (g) => {
    let b = bucketMemo.get(g);
    if (b === undefined) bucketMemo.set(g, (b = bucketOfKey(g, keywords)));
    return b;
  };
  const addGame = (g) => {
    const b = g ? bucketOf(g) : "";
    if (!b) return;
    if (!bucketGames.has(b)) bucketGames.set(b, new Set());
    bucketGames.get(b).add(g);
  };
  for (const L of listings) {
    if (++step % STEP_EVERY === 0) yield;
    if (L && L.f === "noclaim" && L.kind !== "farm") addGame(L.g);
  }
  const sold = new Map();
  for (const list of [sales, demandOnly]) {
    for (const s of list) {
      if (++step % STEP_EVERY === 0) yield;
      if (!s || s.f !== "noclaim") continue;
      addGame(s.g);
      if (s.t >= now - SHARE_DAYS * DAY && s.t <= now) sold.set(s.g, (sold.get(s.g) || 0) + 1);
    }
  }
  const listed = new Map();
  for (const u of units) {
    if (++step % STEP_EVERY === 0) yield;
    if (!u) continue;
    addGame(u.g);
    if (u.st === "listed") listed.set(u.g, (listed.get(u.g) || 0) + 1);
  }
  // the farm brain's bucket key (normGameName of a keyword) → the loader's keyword(s) it stands for
  const byAscii = new Map();
  for (const w of keywords || []) {
    const a = asciiKey(w);
    if (!a) continue;
    if (!byAscii.has(a)) byAscii.set(a, []);
    byAscii.get(a).push(w);
  }

  const out = [];
  for (const { r, f, at } of newest.values()) {
    const br = isObj(r.br) ? r.br : {};
    const stk = isObj(r.stk) ? r.stk : {};
    const est = isObj(r.est) ? r.est : {};
    const base = {
      at,
      live: !!r.live,
      hl: f === "claim" ? numOrNull(r.hl) : null,
      c: String(br.c || ""),
      w: numOrNull(br.w),
      t: numOrNull(br.t),
      on: numOrNull(stk.on),
      fl: numOrNull(stk.fl),
      a30: numOrNull(est.avg30),
      a45: numOrNull(est.avg45),
    };
    if (f === "claim") {
      out.push({ k: String(r.k), f, ...base, bu: "", sh: 1 });
      continue;
    }
    const bucket = String(r.k);
    const gameSet = new Set(bucketGames.get(bucket) || []);
    for (const w of byAscii.get(asciiKey(bucket)) || []) for (const g of bucketGames.get(w) || []) gameSet.add(g);
    const games = [...gameSet].sort();
    if (!games.length) {
      out.push({ k: bucket, f, ...base, bu: bucket, sh: 1 });
      continue;
    }
    const total = games.reduce((a, g) => a + (sold.get(g) || 0), 0);
    if (!(total > 0)) {
      // Nothing to split the bucket's forecast and stock by: an equal split would be a guess presented
      // as each game's demand. Its games get no row (they read unknown, so the model holds).
      stats.unsplit++;
      continue;
    }
    const listedSum = games.reduce((a, g) => a + (listed.get(g) || 0), 0);
    const free = base.on === null ? null : Math.max(0, base.on - listedSum);
    for (const g of games) {
      const share = (sold.get(g) || 0) / total;
      out.push({
        k: g,
        f,
        at,
        live: base.live,
        hl: null,
        c: base.c,
        w: scaled(base.w, share),
        t: scaled(base.t, share),
        on: free === null ? null : round2((listed.get(g) || 0) + free * share),
        fl: scaled(base.fl, share),
        a30: scaled(base.a30, share),
        a45: scaled(base.a45, share),
        bu: bucket,
        sh: round3(share),
      });
    }
  }
  out.sort((a, b) => cmp(a.k, b.k) || cmp(a.f, b.f));
  return out;
}

/** A display label per game key: the commonest label on its rows, else the tracker's, else the key. */
function gameLabels({ listings = [], report, keys = [] }) {
  const tally = new Map();
  for (const L of listings) {
    if (!L || !L.g || !L.gl || L.kind === "farm") continue;
    if (!tally.has(L.g)) tally.set(L.g, new Map());
    const t = tally.get(L.g);
    t.set(L.gl, (t.get(L.gl) || 0) + 1);
  }
  const labels = new Map();
  for (const [g, t] of tally) {
    const best = [...t.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
    labels.set(g, best[0]);
  }
  const tracker = new Map();
  for (const r of (report && Array.isArray(report.games) ? report.games : [])) if (r && r.key) tracker.set(r.key, String(r.game || r.key));
  for (const k of keys) if (k && !labels.has(k)) labels.set(k, tracker.get(k) || k);
  return labels;
}

/**
 * The auto-farm block of the bundle: the brain's own config, the switches today's listers read
 * (`takes`), the per-game mappings provable without a marketplace call (`mapped`: GGSel by the
 * fallback category id, G2G by its static brand table, ZeusX by the owner's game map), the no-claim
 * buckets and the explicit no-claim caps (every entry reads as the owner's — plan §1.3 #12).
 */
/** The switches today's listers read, per market (true = the lister puts new stock there). */
function takesOf(d, af, platiTakes, ggselTakes) {
  const V = (d.venues && d.venues.VENUES) || {};
  const blocked = !!(V.digiseller && V.digiseller.blocked);
  const a = af || {};
  return {
    gameflip: true,
    digiseller: !!platiTakes && !blocked,
    ggsel: !!ggselTakes,
    // the lister's own tests: `!!af.<switch>` (getAutoFarm does no typing)
    zeusx: !!a.zeusxAuto,
    eldorado: !!a.eldoradoAuto,
    playerauctions: !!a.playerauctionsAuto,
    g2g: !!a.g2gAuto,
  };
}

function afBlock({ d, af, keywords, labels, platiTakes, ggselTakes }) {
  const known = d.listingModel && isObj(d.listingModel.DEFAULTS) ? Object.keys(d.listingModel.DEFAULTS) : null;
  const takes = takesOf(d, af, platiTakes, ggselTakes);
  const ggselMapped = !!String(af.ggselCategoryId || "");
  const brand = (label) => {
    try {
      return !!d.g2gGames.brandForGame(label);
    } catch {
      return false;
    }
  };
  const mapped = {};
  for (const [g, label] of labels) {
    mapped[g] = { gameflip: true, digiseller: true, eldorado: true, ggsel: ggselMapped, g2g: brand(label), zeusx: zeusxMapped(af, label), playerauctions: false };
  }
  const norm =
    typeof d.settings.normGameName === "function"
      ? (s) => d.settings.normGameName(s)
      : (s) =>
          String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
  const capMap = isObj(af.unclaimedGameCaps) ? af.unclaimedGameCaps : {};
  const caps = {};
  for (const [g, label] of labels) {
    if (!bucketOfKey(g, keywords)) continue;
    const nl = norm(label);
    // settings.gameCapFor: the FIRST key (object order) that is a substring of the label wins
    for (const k of Object.keys(capMap)) {
      const nk = norm(k);
      if (!nk || !nl.includes(nk)) continue;
      const v = Math.floor(num(capMap[k]));
      if (v > 0) caps[g] = v;
      break;
    }
  }
  return {
    listingBrain: configBlock(af.listingBrain, known),
    perMarketStock: num(af.perMarketStock, 3),
    // eldoradoFulfiller's offer keep-alive (on unless set to false): it renews an unsold offer's 21-day life
    eldoradoKeepAlive: af.eldoradoKeepAlive !== false,
    takes,
    mapped,
    noClaimGames: keywords.slice(),
    noclaimAutoSize: !!af.noclaimAutoSize,
    capDefault: CAP_DEFAULT,
    caps,
  };
}

/* ---------------------------------- old side ---------------------------------- */

function researchIndex(rows) {
  const exact = new Map();
  const ci = new Map();
  for (const r of rows || []) {
    if (!r || !r.game) continue;
    const g = String(r.game);
    if (!exact.has(g)) exact.set(g, r);
    if (!ci.has(g.toLowerCase())) ci.set(g.toLowerCase(), r);
  }
  return { exact, ci };
}

/**
 * The research row today's lister would read: its findOne({ game }) is an exact label match; this
 * label comes from the set's items, which may be spelled differently from the task's, so a
 * case-insensitive match is the fallback (autoFarmer.researchForGame's rule). `how` is logged.
 */
function matchResearch(idx, label) {
  const g = String(label || "");
  if (idx.exact.has(g)) return { doc: idx.exact.get(g), how: "exact" };
  if (idx.ci.has(g.toLowerCase())) return { doc: idx.ci.get(g.toLowerCase()), how: "ci" };
  return { doc: null, how: "none" };
}

/**
 * listActivatedTask's market order, from the switches alone. Where the lister asks a marketplace
 * (GGSel's category, ZeusX's menu, PlayerAuctions' catalog) the offline stand-in is the owner's
 * mapping or our own listing history of the game on that market.
 */
function oldOrder({ af, label, platiTakes, ggselTakes, hist, brand }) {
  const order = ["gameflip"];
  if (platiTakes) order.push("plati");
  if (ggselTakes && (String(af.ggselCategoryId || "") || hist("ggsel"))) order.push("ggsel");
  if (af.zeusxAuto && (zeusxMapped(af, label) || hist("zeusx"))) order.push("zeusx");
  if (af.eldoradoAuto) order.push("eldorado");
  if (af.playerauctionsAuto && hist("playerauctions")) order.push("playerauctions");
  if (af.g2gAuto && brand) order.push("g2g");
  return order;
}

/** A DropSet's items, in the shapes bundlePrice / suggestForNew / classifyHoldings take (copies ≤ MAX_ITEM_COPIES). */
function setItems(set) {
  return (set && Array.isArray(set.items) ? set.items : [])
    .filter((i) => i && i.itemKey)
    .map((i) => ({ itemKey: String(i.itemKey), name: String(i.name || ""), game: String(i.game || ""), qty: Math.min(MAX_ITEM_COPIES, Math.max(1, Math.floor(num(i.qty, 1)))) }));
}
// unclaimedAutoList.expandSetDrops: one drop entry per copy (classifyHoldings counts copies).
function dropsFromItems(items) {
  const out = [];
  for (const i of items) {
    const n = Math.min(MAX_ITEM_COPIES, Math.max(0, Math.floor(num(i.qty, 1))));
    for (let k = 0; k < n; k++) out.push({ name: i.name, game: i.game, campaign: "", itemKey: i.itemKey });
  }
  return out;
}

// Markets today's lister refills (refillMarkets: Gameflip's queue counter, Plati and GGSel product
// stock), in the auto-lister's own market keys.
const REFILL_ORDER = ["gameflip", "plati", "ggsel"];
// Markets an event bundle is published to (publishStackedListing), with the one Gameflip-priced number;
// GGSel's share goes through venuePrice (publishGgselShare). Everywhere else rule 1 stands.
const EVENT_BUNDLE_MARKETS = new Set(["gameflip", "digiseller", "ggsel"]);

/**
 * Today's flat shelf (rule 4): dealShares' round-robin of split.listNow, then refillMarkets' top-up.
 * refillMarkets itself is impure (it reads the database and the marketplaces' live stock, and writes)
 * and is never called; this restates its arithmetic: every refillable market in today's order is
 * topped back up to perMarketStock from the stock on hand (the held-back half first goes to that),
 * while the total stays within the stock.
 * @param {object} dealt  auto-lister market key → units dealt
 * @returns {object} auto-lister market key → units on the shelf
 */
function refillShelf(dealt, order, onHand, perMarketStock) {
  const per = Math.max(1, Math.floor(num(perMarketStock, 3)) || 3);
  const out = { ...dealt };
  let total = Object.values(out).reduce((a, n) => a + num(n), 0);
  for (const m of REFILL_ORDER) {
    if (!order.includes(m)) continue;
    const add = Math.max(0, Math.min(per - num(out[m]), onHand - total));
    out[m] = num(out[m]) + add;
    total += add;
  }
  return out;
}

// A row still marked active is not live for the model (evidence.activeAt) once Gameflip has expired it,
// 30 days after it was created, or Eldorado has killed it unsold, 21 days after (model/util
// GAMEFLIP_EXPIRY_DAYS, ELDORADO_OFFER_LIFE_DAYS); a single-unit row (Gameflip, ZeusX) that sold is over.
const GAMEFLIP_EXPIRY_DAYS = 30;
const ELDORADO_OFFER_LIFE_DAYS = 21;
// model/util ELDORADO_KEEPALIVE_SINCE: offers whose 21 days ended on or after this were renewed while the keep-alive was on
const ELDORADO_KEEPALIVE_SINCE = Date.UTC(2026, 8, 23);
const SINGLE_UNIT = new Set(["gameflip", "zeusx"]);
// The no-claim farm's own shelves (model/util NOCLAIM_SHELF); elsewhere its offers are the owner's.
const NOCLAIM_SHELF = new Set(["gameflip", "digiseller", "ggsel"]);

/**
 * The offers a logged row reads the tracker's answer for — the model's own choice, restated over the
 * bundle's listings (model.js priceGroup / mainVerdict / identities, evidence.isAdvisable, place.eligibility):
 * - a cell (game × farm × market) is priced only on a market that is not blocked: Digiseller is blocked
 *   in code, and the owner's Plati / GGSel switches block the same way (evidence.marketInfo);
 * - its offers with live rows the brain advises on (system-made plain rows, active, a Gameflip row
 *   inside its 30-day life) each get a verdict; the main one has the most such rows, ties going to
 *   the game × farm's primary offer, then to the first in code-unit order;
 * - with none, the primary offer is priced as a new listing where today's lister could put it (not
 *   blocked, the owner's switch on, a no-claim offer only on the no-claim shelves);
 * - the primary offer: the most live system-made rows across markets, then the most rows (with no
 *   system-made row, the owner's rows decide); the model's last tie-break (orders) is not restated.
 * The key read is the newest live row's offer key (`market|contentKey`, else `market|bandKey`), as
 * model.trackerOf looks it up. Ordered for the cap: the cells with the most live advised rows first.
 * @param {Iterable<object>} listings bundle listings (L)
 * @param {Set<string>} offerKeys     the keys of the offers being priced
 * @param {{blocked: Set<string>, off: Set<string>}} markets
 * @param {number} now
 * @param {{before: Set<string>, after: Set<string>}} [sold] listing id hashes with a sale before `now`, at or after it
 * @returns {string[]} offer keys
 */
function trackerOffers(listings, offerKeys, markets, now, sold = {}) {
  const soldBefore = sold.before || new Set();
  const soldAfter = sold.after || new Set();
  // evidence.activeAt at the cut `now`, clause for clause
  const isLive = (L) => {
    const c = numOrNull(L.c);
    if (c === null || c >= now) return false;
    if (L.m === "gameflip" && now > c + GAMEFLIP_EXPIRY_DAYS * DAY) return false;
    const single = SINGLE_UNIT.has(L.m);
    const sold = soldBefore.has(L.id);
    // model/util eldoradoDead: dead after 21 days unless the keep-alive (on, and already running then) renewed it
    const eldEnd = c + ELDORADO_OFFER_LIFE_DAYS * DAY;
    if (L.m === "eldorado" && !sold && now > eldEnd && (markets.eldoradoKeepAlive === false || eldEnd < ELDORADO_KEEPALIVE_SINCE)) return false;
    if (single && sold) return false;
    if (L.st === "active") return true;
    const u = numOrNull(L.u);
    if (single && L.st === "sold" && u !== null && u < now) return false;
    if (u !== null && u >= now) return true;
    // a sale stamped at or after the cut: the row was still on sale then
    return soldAfter.has(L.id);
  };
  const keyOf = (L) => L.m + "|" + (L.ck || L.bk);
  const identOf = (L) => (L.ex && L.ck ? "c:" + L.ck : "b:" + L.bk);
  const gfs = new Map();
  const gfOf = (L) => {
    const k = L.g + "|" + L.f;
    let x = gfs.get(k);
    if (!x) gfs.set(k, (x = { f: L.f, sys: new Map(), owner: new Map(), cells: new Map() }));
    return x;
  };
  for (const L of listings) {
    // the model's rows: visible at the cut, a plain or claim-at-sale listing of a game
    if (!L || !L.g || (L.kind !== "single" && L.kind !== "cas") || !(numOrNull(L.c) !== null && L.c < now)) continue;
    const sys = L.kind === "single" && (L.o === "auto" || L.o === "unclaimed");
    const gf = gfOf(L);
    const id = identOf(L);
    const live = isLive(L);
    const tally = sys ? gf.sys : gf.owner;
    // rawCk: the first row's content key (model.identities keeps the first row's; bk follows the newest row)
    const t = tally.get(id) || { live: 0, rows: 0, bk: L.bk, c: -Infinity, rawCk: L.ck || null };
    t.rows++;
    if (live) t.live++;
    if (num(L.c, -Infinity) > t.c) Object.assign(t, { c: num(L.c, -Infinity), bk: L.bk });
    tally.set(id, t);
    if (!(sys && live) || markets.blocked.has(L.m)) continue;
    if (!gf.cells.has(L.m)) gf.cells.set(L.m, new Map());
    const cell = gf.cells.get(L.m);
    const v = cell.get(id) || { n: 0, r0: null };
    v.n++;
    if (!v.r0 || num(L.c, -Infinity) > num(v.r0.c, -Infinity) || (L.c === v.r0.c && cmp(L.id, v.r0.id) < 0)) v.r0 = L;
    cell.set(id, v);
  }
  const mains = [];
  for (const gf of gfs.values()) {
    const tally = gf.sys.size ? gf.sys : gf.owner;
    let primary = null;
    for (const id of [...tally.keys()].sort(cmp)) {
      const t = tally.get(id);
      if (!primary || t.live > primary.live || (t.live === primary.live && t.rows > primary.rows)) primary = { id, live: t.live, rows: t.rows, bk: t.bk, rawCk: t.rawCk };
    }
    const done = new Set();
    for (const [m, cell] of gf.cells) {
      let best = null;
      for (const id of [...cell.keys()].sort(cmp)) {
        const v = cell.get(id);
        if (!best || v.n > best.n || (v.n === best.n && primary && id === primary.id && best.id !== primary.id)) best = { id, n: v.n, r0: v.r0 };
      }
      const key = keyOf(best.r0);
      if (offerKeys.has(key)) mains.push({ key, n: best.n });
      done.add(m);
    }
    if (!primary) continue;
    // cells with no live advised row: the primary offer, new, where today's lister could list it
    const rawCk = primary.rawCk;
    for (const m of MARKETS) {
      if (done.has(m) || markets.blocked.has(m) || markets.off.has(m)) continue;
      if (gf.f === "noclaim" && !NOCLAIM_SHELF.has(m)) continue;
      const key = rawCk && offerKeys.has(m + "|" + rawCk) ? m + "|" + rawCk : offerKeys.has(m + "|" + primary.bk) ? m + "|" + primary.bk : null;
      if (key) mains.push({ key, n: 0 });
    }
  }
  mains.sort((a, b) => b.n - a.n || cmp(a.key, b.key));
  const out = [];
  const seen = new Set();
  for (const x of mains) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    out.push(x.key);
  }
  return out;
}

/**
 * Today's rules at this moment (plan §2.1 `old`), computed with today's own exported functions.
 *   games[g] (claim games with live system-made rows or stock): base = derivePrice(research),
 *     ggsel = venuePrice("ggsel", base), post = postEventPrice(base), split = computeSplit(stock on hand,
 *     ≤ MAX_ON_HAND), flat = dealShares of split.listNow placeholder accounts over today's order, topped
 *     back up to perMarketStock on the refillable markets (refillShelf), counted per market.
 *   offers[m|ck-or-bk]: np = the price today's lister would give a new listing of that offer there
 *     (claim: ggsel → venue price, else max(base, the market floor); a claim EVENT BUNDLE on Gameflip,
 *     Plati or GGSel: autoFarmBundles.priceBundle on Gameflip's evidence (GGSel: through venuePrice),
 *     `eb: true`; no-claim: bundlePrice), and the tracker's suggestForNew for the offers a logged row
 *     reads (trackerOffers, ≤ trackerCap; null for the rest).
 * The realised-price snapshot venuePrice and priceBundle read is warmed ONCE first (with a timeout):
 * venuePrice swallows an evidence error and answers the base price, so only the warm-up can tell. If it
 * fails, every GGSel price and every event-bundle price is null, with one note — never a guess.
 * @param {Map<string,string>} [eventSets] set id → event key of the claim auto rows' event-bundle sets
 */
async function oldSide({
  d,
  af,
  report,
  byId,
  demand,
  research,
  catalog,
  pricing,
  labels,
  platiTakes,
  ggselTakes,
  now,
  notes,
  venueTimeoutMs = VENUE_TIMEOUT_MS,
  trackerCap = MAX_TRACKER_OFFERS,
  eventSets = new Map(),
  takes = null,
  sold = {},
}) {
  const games = {};
  const offers = {};
  const c = {
    games: 0,
    gamesCut: 0,
    venueOk: 0,
    venueFailed: 0,
    venueSkipped: 0,
    offers: 0,
    offersCut: 0,
    offerErrors: 0,
    trackerAsked: 0,
    trackerCut: 0,
    eventBundles: 0,
    eventBundlesUnpriced: 0,
    clamped: 0,
    research: { exact: 0, ci: 0, none: 0, unread: 0 },
  };
  const breathe = makeBreather();
  const R = Array.isArray(research) ? researchIndex(research) : null;
  const perMarketStock = num(af && af.perMarketStock, 3);

  const hist = new Map();
  const live = new Map();
  let step = 0;
  for (const e of byId.values()) {
    if (++step % (STEP_EVERY * 4) === 0) await breathe();
    const L = e.L;
    if (!L.g || L.kind === "farm") continue;
    if (!hist.has(L.g)) hist.set(L.g, new Set());
    hist.get(L.g).add(L.m);
    if (L.f === "claim" && L.o === "auto" && L.kind === "single" && L.st === "active") live.set(L.g, (live.get(L.g) || 0) + num(L.qty, 1));
  }
  const stock = new Map();
  for (const r of demand || []) if (r && r.f === "claim" && num(r.on) > 0) stock.set(r.k, num(r.on));
  const trackerOnHand = new Map();
  for (const r of report && Array.isArray(report.games) ? report.games : []) if (r && r.key && r.farm && num(r.farm.onHand) > 0) trackerOnHand.set(r.key, num(r.farm.onHand));

  let keys = [...new Set([...live.keys(), ...stock.keys()])].filter(Boolean);
  keys.sort((a, b) => (live.get(b) || 0) - (live.get(a) || 0) || (stock.get(b) || 0) - (stock.get(a) || 0) || cmp(a, b));
  if (keys.length > MAX_OLD_GAMES) {
    c.gamesCut = keys.length - MAX_OLD_GAMES;
    notes.push(keys.length + " claim games have stock or live rows; today's rules were computed for the first " + MAX_OLD_GAMES + " (live first).");
    keys = keys.slice(0, MAX_OLD_GAMES);
  }
  if (!R) notes.push("Market research unreadable this run: today's new-listing prices (derivePrice, bundlePrice, priceBundle) are not computed.");

  const A = d.autoLister;
  for (const g of keys) {
    const label = labels.get(g) || g;
    const r = R ? matchResearch(R, label) : null;
    if (r) c.research[r.how]++;
    else c.research.unread++;
    const rawOnHand = Math.max(0, Math.floor(stock.has(g) ? stock.get(g) : trackerOnHand.has(g) ? trackerOnHand.get(g) : live.get(g) || 0));
    // a database number drives the deal below (one placeholder per account, quadratic in dealShares)
    const onHand = Math.min(MAX_ON_HAND, rawOnHand);
    if (onHand < rawOnHand) c.clamped++;
    const sp = A.computeSplit(onHand) || {};
    const split = { listNow: Math.max(0, Math.floor(num(sp.listNow))), holdBack: Math.max(0, Math.floor(num(sp.holdBack))) };
    let brand = false;
    try {
      brand = !!d.g2gGames.brandForGame(label);
    } catch {
      brand = false;
    }
    const gh = hist.get(g) || new Set();
    const order = oldOrder({ af, label, platiTakes, ggselTakes, hist: (m) => gh.has(m), brand });
    const shares = {};
    for (const m of order) shares[m] = [];
    // Placeholder accounts: dealShares only deals them round-robin; nothing else ever sees them.
    const accounts = Array.from({ length: split.listNow }, (_, k) => ({ login: "u" + k }));
    A.dealShares(accounts, order, shares, null);
    const dealt = {};
    for (const m of order) dealt[m] = shares[m].length;
    const shelf = refillShelf(dealt, order, onHand, perMarketStock);
    const flat = {};
    for (const m of order) flat[orderMarket(m)] = shelf[m];
    const base = r ? numOrNull(A.derivePrice(r.doc || null)) : null;
    games[g] = {
      base: base === null ? null : round2(base),
      ggsel: null,
      post: base === null ? null : round2(A.postEventPrice(base)),
      split,
      flat,
      order: order.map(orderMarket),
      rm: r ? r.how : "unread",
      label,
    };
    c.games++;
    await breathe();
  }
  if (c.clamped) notes.push(c.clamped + " claim games report more than " + MAX_ON_HAND + " accounts on hand: today's split was computed for " + MAX_ON_HAND + ".");

  // Offers: every distinct (market, exact items or size band) of a plain or claim-at-sale row.
  const groups = new Map();
  step = 0;
  for (const e of byId.values()) {
    if (++step % (STEP_EVERY * 4) === 0) await breathe();
    const L = e.L;
    if (!L.g || (L.kind !== "single" && L.kind !== "cas")) continue;
    const key = L.m + "|" + (L.ck || L.bk);
    const sys = L.kind === "single" && (L.o === "auto" || L.o === "unclaimed");
    let gr = groups.get(key);
    if (!gr) {
      gr = { key, m: L.m, g: L.g, gl: L.gl || L.g, f: L.f, n: L.n, set: e.set, setId: "", live: false, sys: 0, liveSys: 0 };
      groups.set(key, gr);
    }
    if (sys && !gr.sys) Object.assign(gr, { f: L.f, g: L.g, gl: L.gl || L.g, n: L.n, set: e.set || gr.set });
    if (!gr.set && e.set) gr.set = e.set;
    if (sys && L.f === "claim" && L.o === "auto" && e.setId && eventSets.has(e.setId)) gr.setId = e.setId;
    if (sys) gr.sys++;
    if (L.st === "active") {
      gr.live = true;
      if (sys) gr.liveSys++;
    }
  }

  // The realised-price snapshot, warmed once (see above). Without the reader (an older caller's deps)
  // the calls below run as before.
  const ebGroups = [...groups.values()].filter((gr) => gr.setId && gr.f === "claim" && EVENT_BUNDLE_MARKETS.has(gr.m));
  const priced = keys.filter((g) => games[g].base !== null);
  let evidence = { ok: true, why: "" };
  if ((priced.length || ebGroups.length) && d.pricingEvidence && typeof d.pricingEvidence.snapshot === "function") {
    try {
      await withTimeout(
        Promise.resolve().then(() => d.pricingEvidence.snapshot()),
        venueTimeoutMs,
        "the evidence snapshot",
      );
    } catch (e) {
      evidence = { ok: false, why: cleanMsg(e) };
    }
  }

  // GGSel's venue price, from the warm snapshot. The first call still runs alone; if it fails the rest
  // are not tried: null + one note.
  let lastErr = "";
  const callVenue = async (g) => {
    const og = games[g];
    try {
      const p = await withTimeout(
        Promise.resolve().then(() => A.venuePrice("ggsel", og.base, { title: og.label + " Twitch Drops" })),
        venueTimeoutMs,
        "venuePrice",
      );
      const v = numOrNull(p);
      og.ggsel = v === null || v <= 0 ? null : round2(v);
      if (og.ggsel === null) throw new Error("venuePrice returned no price");
      c.venueOk++;
      return true;
    } catch (e) {
      og.ggsel = null;
      c.venueFailed++;
      lastErr = cleanMsg(e);
      return false;
    }
  };
  if (!evidence.ok) {
    c.venueSkipped = priced.length;
    notes.push(
      "The pricing evidence snapshot was unreadable (" +
        evidence.why +
        "): today's GGSel prices (venuePrice) and event-bundle prices (priceBundle) are not computed for any game — null, never a guess.",
    );
  } else if (priced.length) {
    const firstOk = await callVenue(priced[0]);
    await yieldNow();
    if (firstOk) await mapLimit(priced.slice(1), OLD_CONCURRENCY, callVenue);
    else c.venueSkipped = priced.length - 1;
  }
  if (evidence.ok && (c.venueFailed || c.venueSkipped)) {
    notes.push(
      "GGSel venue price unreadable for " + (c.venueFailed + c.venueSkipped) + " of " + priced.length + " games (" + lastErr + ")" + (c.venueSkipped ? "; the rest were not tried after the first failed" : "") + ": their old GGSel price is null.",
    );
  }
  for (const g of keys) delete games[g].label;

  let list = [...groups.values()];
  const rank = (x) => (x.liveSys ? 0 : x.live ? 1 : x.sys ? 2 : 3);
  list.sort((a, b) => rank(a) - rank(b) || cmp(a.key, b.key));
  if (list.length > MAX_OFFERS) {
    c.offersCut = list.length - MAX_OFFERS;
    notes.push(list.length + " offers; today's prices were computed for the first " + MAX_OFFERS + " (live system-made first).");
    list = list.slice(0, MAX_OFFERS);
  }
  // the tracker is asked only for what a logged row reads: the model's main offer of each cell it prices
  const tk = takes || takesOf(d, af, platiTakes, ggselTakes);
  const V = (d.venues && d.venues.VENUES) || {};
  const marketState = { blocked: new Set(), off: new Set(), eldoradoKeepAlive: af.eldoradoKeepAlive !== false };
  for (const m of MARKETS) {
    const off = tk[m] === false;
    if ((V[m] && V[m].blocked) || (off && (m === "digiseller" || m === "ggsel"))) marketState.blocked.add(m);
    if (off) marketState.off.add(m);
  }
  const listingsOf = function* () {
    for (const e of byId.values()) yield e.L;
  };
  const wanted = trackerOffers(listingsOf(), new Set(list.map((gr) => gr.key)), marketState, now, sold);
  const askTracker = new Set(wanted.slice(0, Math.max(0, trackerCap)));
  c.trackerCut = Math.max(0, wanted.length - askTracker.size);
  if (c.trackerCut)
    notes.push(
      "The tracker's suggestion (suggestForNew) was asked for " + askTracker.size + " of " + wanted.length + " priced cells' main offers (live system-made first): the rest log no tracker price.",
    );

  const floorFor = (m) => (d.venues && typeof d.venues.floorFor === "function" ? num(d.venues.floorFor(m)) : 0);
  const hasCatalog = !!(catalog && typeof catalog.values === "function" && catalog.size);
  // the event's sold floor (autoFarmBundles.soldFloorForEvent): the best price an auto row of any of
  // the event's bundle sets sold at in 30 days — from the rows already read
  const soldFloor = new Map();
  if (ebGroups.length) {
    for (const e of byId.values()) {
      const L = e.L;
      const ek = e.setId ? eventSets.get(e.setId) : undefined;
      if (ek === undefined || L.o !== "auto" || L.st !== "sold" || !(num(L.u, -Infinity) >= now - EVENT_SOLD_FLOOR_DAYS * DAY)) continue;
      soldFloor.set(ek, Math.max(soldFloor.get(ek) || 0, num(L.p)));
    }
  }
  const ebPrices = new Map();
  const ebPrice = async (gr, items) => {
    if (ebPrices.has(gr.setId)) return ebPrices.get(gr.setId);
    const r = R ? matchResearch(R, gr.gl) : null;
    let p = null;
    try {
      const out = await withTimeout(
        Promise.resolve().then(() =>
          d.autoFarmBundles.priceBundle({
            // what publishEventBundleFor hands the pricer; whether the set is the COMPLETE event is not
            // knowable here (the plan's waves are not stored), so it is priced as not complete
            plan: { game: gr.gl, items, totalQty: items.reduce((a, x) => a + x.qty, 0), full: false },
            game: gr.gl,
            marketplace: "gameflip",
            research: r ? r.doc : null,
            soldFloorUsd: soldFloor.get(eventSets.get(gr.setId)) || 0,
          }),
        ),
        venueTimeoutMs,
        "priceBundle",
      );
      const v = numOrNull(out && out.price);
      p = v !== null && v > 0 ? round2(v) : null;
    } catch {
      p = null;
    }
    ebPrices.set(gr.setId, p);
    return p;
  };

  for (let k = 0; k < list.length; k++) {
    const gr = list[k];
    const items = setItems(gr.set);
    let np = null;
    let eb = false;
    try {
      if (gr.f === "noclaim") {
        const r = R ? matchResearch(R, gr.gl) : null;
        if (r) {
          const drops = dropsFromItems(items);
          // classifyDrops: no catalog (or no drops) means "no event", i.e. a null classification
          const cls = hasCatalog && drops.length ? d.unclaimedBundles.classifyHoldings(gr.gl, drops, catalog, now) : null;
          const out = d.unclaimedBundles.bundlePrice({
            research: r.doc,
            game: gr.gl,
            items: items.map((x) => ({ itemKey: x.itemKey, name: x.name, qty: x.qty })),
            classification: cls,
            pricing,
            soldFloorUsd: 0,
          });
          const v = numOrNull(out && out.price);
          np = v === null ? null : round2(v);
        }
      } else if (gr.setId && EVENT_BUNDLE_MARKETS.has(gr.m) && d.autoFarmBundles && typeof d.autoFarmBundles.priceBundle === "function") {
        eb = true;
        c.eventBundles++;
        const p = evidence.ok ? await ebPrice(gr, items) : null;
        if (p === null) np = null;
        else if (gr.m === "ggsel") {
          const v = numOrNull(
            await withTimeout(
              Promise.resolve().then(() => A.venuePrice("ggsel", p, { title: gr.gl + " Twitch Drops" })),
              venueTimeoutMs,
              "venuePrice",
            ),
          );
          np = v !== null && v > 0 ? round2(v) : null;
        } else np = round2(Math.max(p, floorFor(gr.m)));
        if (np === null) c.eventBundlesUnpriced++;
      } else {
        const og = games[gr.g];
        if (og && og.base !== null) np = gr.m === "ggsel" ? og.ggsel : round2(Math.max(og.base, floorFor(gr.m)));
      }
    } catch {
      np = null;
      c.offerErrors++;
      if (eb) c.eventBundlesUnpriced++;
    }
    let tracker = null;
    if (askTracker.has(gr.key)) {
      c.trackerAsked++;
      // one tracker call is 17–143 ms on Node 20 at production volume and cannot be split: breathe
      // before every one, so no stretch holds more than a single call
      await yieldNow();
      try {
        const s = d.priceTracker.suggestForNew(report, { market: gr.m, game: gr.gl, title: "", itemCount: gr.n || 0, items: items.map((x) => ({ itemKey: x.itemKey, game: x.game, qty: x.qty })) });
        if (s) tracker = { price: round2(s.price), basis: String(s.basis || s.action || ""), confidence: s.confidence ? String(s.confidence) : null };
      } catch {
        tracker = null;
        c.offerErrors++;
      }
    }
    offers[gr.key] = eb ? { np, tracker, eb: true } : { np, tracker };
    c.offers++;
    await breathe();
  }
  if (c.eventBundles) {
    notes.push(
      c.eventBundles +
        " claim offers are event bundles, priced the way today's lister prices them (autoFarmBundles.priceBundle on Gameflip's evidence; GGSel through venuePrice). Whether each is the complete event is not knowable here, so each is priced as not complete (no full-event bonus)" +
        (c.eventBundlesUnpriced ? "; " + c.eventBundlesUnpriced + " have no price (no evidence or no answer)" : "") +
        ".",
    );
  }
  return { games, offers, counts: c };
}

/* ----------------------------------- load ----------------------------------- */

// Ties (one detection pass books many units at one moment) in plain code-unit order: the same on every
// machine, and no ICU collation over tens of thousands of comparisons.
const byTime = (a, b) => a.t - b.t || cmp(String(a.lid || a.g || ""), String(b.lid || b.g || ""));

/**
 * One run's bundle (plan §2.1). Throws — and so logs nothing — when the settings, the tracker report,
 * the listing read or the no-claim unit reads are unreadable: each of those, missing, would read as
 * "nothing sold" and push verdicts the unsafe way. Everything else degrades with a note.
 * @param {object} o
 * @param {number} [o.now]            epoch ms
 * @param {object} [o.deps]           injected modules (tests)
 * @param {number} [o.venueTimeoutMs] per-call cap on venuePrice, priceBundle and the evidence warm-up
 * @param {number} [o.trackerCap]     how many offers the tracker's suggestForNew is asked about
 * Every long pass breathes (setImmediate) at least every YIELD_BUDGET_MS, and between steps: at
 * production volume on Node 20 no synchronous stretch of the load is much over the budget.
 */
async function load({ now: nowIn, deps = null, venueTimeoutMs = VENUE_TIMEOUT_MS, trackerCap = MAX_TRACKER_OFFERS } = {}) {
  const now = msOf(nowIn) === null ? Date.now() : msOf(nowIn);
  const d = deps || realDeps();
  const notes = [];
  const breathe = makeBreather();
  // one memo per load: a listing id is hashed once for its row, its sales and every unit naming it
  const hash = makeHasher();

  // 1. settings, before any database read
  const S = settingsBlock(d);
  const af = S.af;
  const W = readWindows(af);
  let platiTakes = false;
  try {
    // reads settings again and the process's Digiseller block flag; once per run
    platiTakes = !!d.autoLister.platiTakesNewStock(af);
  } catch (e) {
    notes.push("The Plati switch was unreadable (" + cleanMsg(e) + "): read as off.");
  }
  let ggselTakes = false;
  try {
    ggselTakes = !!d.autoLister.ggselTakesNewStock(af);
  } catch (e) {
    notes.push("The GGSel switch was unreadable (" + cleanMsg(e) + "): read as off.");
  }
  const keywords = noclaimKeywords(af, d.setIdentity.normGame);
  await yieldNow();

  // 2. the price tracker's report (shared cache): no report, no run
  let report = null;
  try {
    report = await d.priceTracker.getReportSWR({ timeoutMs: REPORT_TIMEOUT_MS });
  } catch {
    report = null;
  }
  if (!report || !report.ledger || !Array.isArray(report.ledger.sales) || !report.prepared || !Array.isArray(report.prepared.rows)) {
    throw new Error("listing brain: the price tracker report is not available (none cached, none built within " + REPORT_TIMEOUT_MS / 1000 + " s): nothing loaded");
  }
  const reportAt = msOf(report.at);
  if (report.truncated) notes.push("The price tracker's read hit its row cap: its oldest listings and sales are missing.");
  if (reportAt !== null && now - reportAt > STALE_REPORT_MS) notes.push("The price tracker report is " + Math.round((now - reportAt) / MINUTE) + " min old: sales since then are missing.");
  await yieldNow();

  // 3. the market radar (shared cache): degrade
  let radarRaw = null;
  try {
    radarRaw = await d.marketReport.getReport({ days: 30 });
  } catch (e) {
    notes.push("Market radar unreadable this run (" + cleanMsg(e) + "): no rival evidence.");
  }
  const radar = radarSlim(radarRaw);
  if (radarRaw && isObj(radarRaw.truncated) && (radarRaw.truncated.sales || radarRaw.truncated.rivals)) notes.push("The radar's read hit its cap: its oldest rival sales are missing.");
  await yieldNow();

  // 4. the extra listing read: no run without it
  let lr;
  try {
    lr = await readListings(d, now, W, breathe);
  } catch (e) {
    throw new Error("listing brain: the listing read failed (" + cleanMsg(e) + "): nothing loaded");
  }
  if (lr.truncated) notes.push("The listing read hit its cap of " + LISTING_CAP + " rows (newest first): the oldest rows are missing.");
  await yieldNow();

  // 5. no-claim units: no run without them (the no-claim lister's sales live only there)
  let ur;
  try {
    ur = await readUnits(d, now, W, breathe);
  } catch (e) {
    throw new Error("listing brain: the no-claim unit read failed (" + cleanMsg(e) + "): nothing loaded");
  }
  if (ur.truncated.listed || ur.truncated.sold) notes.push("A no-claim unit read hit its cap of " + UNIT_CAP + " rows: the oldest units are missing.");
  await yieldNow();

  // 6. waves: degrade
  let cr = { campaigns: [], manifests: [], truncated: {} };
  let catalog = new Map();
  try {
    cr = await readCampaigns(d, now);
    if (cr.truncated.campaigns || cr.truncated.manifests) notes.push("The drop-campaign read hit its cap: the oldest waves are missing.");
  } catch (e) {
    notes.push("Drop campaigns unreadable this run (" + cleanMsg(e) + "): no-claim wave ends are unknown, and today's no-claim price has no full-event bonus.");
  }
  try {
    catalog = d.unclaimedBundles.buildEventCatalog(cr.campaigns, cr.manifests) || new Map();
  } catch (e) {
    catalog = new Map();
    notes.push("The event catalog could not be built (" + cleanMsg(e) + "): no-claim wave ends are unknown.");
  }
  await yieldNow();

  // 7. market research: degrade (the old side abstains)
  let research = null;
  try {
    const rr = await readResearch(d);
    research = rr.rows;
    if (rr.truncated) notes.push("The market-research read hit its cap of " + RESEARCH_CAP + " games.");
  } catch (e) {
    research = null;
    notes.push("Market research read failed (" + cleanMsg(e) + ").");
  }
  await yieldNow();

  // 8. the farm brain's rows: degrade (every game reads unknown, so the model holds)
  let demandDocs = [];
  try {
    const dr = await readDemandRows(d, now, demandLookbackH(af, d.listingModel));
    demandDocs = dr.rows;
    if (dr.truncated) notes.push("The farm-brain row read hit its cap of " + DEMAND_ROW_CAP + " rows: some games may read unknown.");
  } catch (e) {
    notes.push("The farm brain's rows were unreadable this run (" + cleanMsg(e) + "): every game reads unknown.");
  }
  await yieldNow();

  // build
  const nl = await drainAsync(normaliseListingsSteps({ d, report, rows: lr.rows, keywords, hash }), breathe);
  if (nl.counts.unexplained) {
    notes.push(
      nl.counts.unexplained +
        " listing rows are missing from the tracker's report for a reason the loader cannot see (" +
        (nl.counts.unexplainedComplete ? "repriced since the report, or another" : "its read hit its cap") +
        "): classified by their flags alone.",
    );
  }
  await yieldNow();

  // 9. which of the claim auto rows' sets are event bundles (today's fifth pricer): degrade (rule 1)
  let eventSets = new Map();
  const sourceType = (d.autoFarmBundles && d.autoFarmBundles.SOURCE_TYPE) || "autofarm-bundle";
  if (d.DropSet && typeof d.DropSet.find === "function") {
    const ids = [];
    for (const e of nl.byId.values()) if (e.setId && e.L.f === "claim" && e.L.o === "auto") ids.push(e.setId);
    try {
      eventSets = await readEventSets(d, ids, sourceType);
    } catch (e) {
      eventSets = new Map();
      notes.push("The event-bundle marker of the auto-lister's sets was unreadable (" + cleanMsg(e) + "): event-bundle offers are priced by rule 1 (derivePrice), not by priceBundle.");
    }
  }

  const since = now - W.saleDays * DAY;
  const sr = await drainAsync(saleRecordsSteps({ report, byId: nl.byId, keywords, since, hash }), breathe);
  await breathe();
  const nu = await drainAsync(noclaimUnitsSteps({ d, docs: ur.docs, byId: nl.byId, since, ledgerBulk: sr.ledgerBulk, hash }), breathe);
  await yieldNow();
  const sales = sr.sales.concat(nu.sales).sort(byTime);
  await breathe();
  const demandOnly = sr.demandOnly.concat(nu.demandOnly).sort(byTime);
  const bulkPrices = sr.bulkPrices.concat(nu.bulkPrices).sort(byTime);
  await breathe();
  const wv = waves({ d, catalog });
  await breathe();
  const dstats = {};
  const demand = await drainAsync(demandRowsSteps({ docs: demandDocs, keywords, listings: nl.listings, units: nu.units, sales, demandOnly, now, stats: dstats }), breathe);
  if (dstats.unsplit) notes.push(dstats.unsplit + " no-claim farm-brain rows had no sale in 30 days to split their bucket's forecast by: those games read unknown.");
  await breathe();
  const keys = [];
  for (const L of nl.listings) if (L.g && L.kind !== "farm") keys.push(L.g);
  for (const r of demand) keys.push(r.k);
  const labels = gameLabels({ listings: nl.listings, report, keys });
  await breathe();
  const afb = afBlock({ d, af, keywords, labels, platiTakes, ggselTakes });
  await yieldNow();
  // the listings with a sale before the cut and at or after it (the model's activeAt: a single-unit row
  // that sold is over, an Eldorado offer that sold is not killed at 21 days, a later sale keeps a row live)
  const sold = { before: new Set(), after: new Set() };
  for (const x of sales) if (x.lid) (x.t < now ? sold.before : sold.after).add(x.lid);
  const old = await oldSide({
    d,
    af,
    report,
    byId: nl.byId,
    demand,
    research,
    catalog,
    pricing: S.pricing,
    labels,
    platiTakes,
    ggselTakes,
    now,
    notes,
    venueTimeoutMs,
    trackerCap,
    eventSets,
    takes: afb.takes,
    sold,
  });

  const ledger = report.ledger || {};
  const counts = {
    trackerAgeMin: reportAt === null ? null : round1((now - reportAt) / MINUTE),
    listingRows: lr.read,
    listingOutsideWindow: lr.outside,
    listings: nl.listings.length,
    ...Object.fromEntries(Object.entries(nl.counts).map(([k, v]) => ["l_" + k, v])),
    sales: sales.length,
    demandOnly: demandOnly.length,
    bulkPrices: bulkPrices.length,
    suspect: Array.isArray(ledger.suspect) ? ledger.suspect.length : 0,
    ...Object.fromEntries(Object.entries(sr.counts).map(([k, v]) => ["s_" + k, v])),
    unitReadListed: ur.read[0],
    unitReadSold: ur.read[1],
    ...Object.fromEntries(Object.entries(nu.counts).map(([k, v]) => ["u_" + k, v])),
    campaigns: cr.campaigns.length,
    manifests: cr.manifests.length,
    waves: wv.length,
    research: Array.isArray(research) ? research.length : null,
    demandRowsRead: demandDocs.length,
    demand: demand.length,
    radarGames: radar.games.length,
    radarFeed: radar.feed.length,
    oldGames: old.counts.games,
    oldGamesCut: old.counts.gamesCut,
    venueOk: old.counts.venueOk,
    venueFailed: old.counts.venueFailed + old.counts.venueSkipped,
    researchExact: old.counts.research.exact,
    researchCi: old.counts.research.ci,
    researchNone: old.counts.research.none,
    offers: old.counts.offers,
    offersCut: old.counts.offersCut,
    offerErrors: old.counts.offerErrors,
    trackerAsked: old.counts.trackerAsked,
    trackerCut: old.counts.trackerCut,
    eventBundleSets: eventSets.size,
    eventBundleOffers: old.counts.eventBundles,
    demandUnsplit: dstats.unsplit || 0,
  };

  return {
    kind: BUNDLE_KIND,
    v: BUNDLE_V,
    now,
    af: afb,
    sizing: S.sizing,
    fees: S.fees,
    pricing: S.pricing,
    bulk: S.bulk,
    listings: nl.listings,
    sales,
    demandOnly,
    bulkPrices,
    radar,
    demand,
    noclaim: { units: nu.units, waves: wv },
    old: { games: old.games, offers: old.offers },
    notes,
    counts,
  };
}

/** The scorer's loader: the same bundle (one read set serves the run and its scores). */
function loadEvidence(o) {
  return load(o);
}

/* ------------------------------ bundle file checks ------------------------------ */

// Key names that say a field carries a person, an account, a credential or free text (any case, any
// spelling: buyerLogin, seller_name, soldTo, username, Title …). FORBIDDEN_KEYS is the exact list the
// loader strips; this is the wider net.
const KEY_RE = /login|account|seller|buyer|username|token|secret|password|api[_-]?key|email|twitch|dedupe|orderid|externalid|note|contentid|soldto/i;
// The bundle's own keys that the wider net would catch (plan §2.1): the run's notes (cleaned text), the
// Digiseller market key ("digi-SELLER"), the radar's rival-seller COUNTS and the count of account
// listings among the rows read (counts.l_account).
const KEY_ALLOW = new Set(["notes", "digiseller", "rivalSellers", "liveSellers", "l_account"]);
// Containers whose KEYS are data (game keys, offer keys), not field names: their keys are checked
// like string values, so a game called "Account Quest" never blocks an export.
const DATA_KEYED = new Set(["af.mapped", "af.caps", "pricing.gameFloors", "old.games", "old.offers"]);
// What an identifying string looks like: an email, a link, an IPv4 / IPv6 address, a raw database id
// anywhere in it, or a credential in its SHAPE — a credential word with a value after "=" or ":", or a
// bearer token. A bare word is not one: real game and campaign names say "Secret", "Token" or
// "Password", and flagging them would refuse every export of such a game. A value already masked
// by cleanMsg ("token=<value>") is not one either.
const VALUE_RES = [
  [/[^\s@]+@[^\s@]+\.[a-z]{2,}/i, "email address"],
  [/\b[a-z][a-z0-9+.-]*:\/\//i, "link"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, "IPv4 address"],
  [/(?:\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::|(?<![\w:])::[0-9a-f]{1,4}\b)/i, "IPv6 address"],
  [/[0-9a-f]{24}/i, "raw database id"],
  [/\b(token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[=:]\s*(?!<)\S+/i, "credential"],
  [/\bbearer\s+(?!<)[A-Za-z0-9._~+/-]{8,}/i, "bearer token"],
];
const valueProblem = (v) => {
  for (const [re, what] of VALUE_RES) if (re.test(v)) return what;
  return null;
};

/**
 * Paths of everything that would make a bundle unsafe to share: a forbidden key (FORBIDDEN_KEYS, in
 * any case), a key whose name says it carries a person, an account, a credential or free text
 * (KEY_RE, except the bundle's own KEY_ALLOW), and every string — value, or key of a data-keyed map —
 * that looks like an email, a link, an IP address, a raw database id or a credential. An unhashed
 * listing id is as identifying as a login. Run by the export before any file is written; it must
 * find nothing on the synthetic fixtures and on the loader's own bundles.
 */
function privacyScan(obj) {
  const out = [];
  const seen = new Set();
  const forbiddenLower = new Set([...FORBIDDEN_KEYS].map((k) => k.toLowerCase()));
  const badKey = (k) => forbiddenLower.has(k.toLowerCase()) || (!KEY_ALLOW.has(k) && KEY_RE.test(k));
  const checkKey = (k, p, dataKeyed) => {
    if (dataKeyed) {
      const why = valueProblem(k);
      if (why) out.push(p + " (key: " + why + ")");
    } else if (badKey(k)) out.push(p);
  };
  const walk = (v, path, depth) => {
    if (depth > 64 || out.length >= 1000) return;
    if (typeof v === "string") {
      const why = valueProblem(v);
      if (why) out.push(path + " (" + why + ")");
      return;
    }
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path + "[" + i + "]", depth + 1));
      return;
    }
    const dataKeyed = DATA_KEYED.has(path);
    if (v instanceof Map) {
      for (const [k, x] of v) {
        checkKey(String(k), path + "<" + k + ">", dataKeyed);
        walk(x, path + "<" + k + ">", depth + 1);
      }
      return;
    }
    for (const k of Object.keys(v)) {
      const p = path ? path + "." + k : k;
      checkKey(k, p, dataKeyed);
      walk(v[k], p, depth + 1);
    }
  };
  walk(obj, "", 0);
  return out;
}

const HEX12 = /^[0-9a-f]{12}$/;

/**
 * Problems that would make a bundle unsafe to model or to share: wrong kind or version, missing
 * sections, anything that is not plain JSON (a Date, a Map, undefined, NaN), an unknown market or
 * enum value, a "plati" left untranslated, a market string outside the seven keys and OTHER_MARKETS
 * (free text). Lenient on optional fields; [] when sound.
 */
function validateBundle(b) {
  const problems = [];
  const add = (s) => {
    if (problems.length < 100) problems.push(s);
  };
  if (!isObj(b)) return ["the bundle is not an object"];
  if (b.kind !== BUNDLE_KIND) add("kind is " + JSON.stringify(b.kind) + ", expected " + JSON.stringify(BUNDLE_KIND));
  if (b.v !== BUNDLE_V) add("v is " + JSON.stringify(b.v) + ", this code reads v" + BUNDLE_V);
  if (!(typeof b.now === "number" && Number.isFinite(b.now) && b.now > 0)) add("now is not a millisecond timestamp");
  for (const k of ["listings", "sales", "demandOnly", "bulkPrices", "demand", "notes"]) if (!Array.isArray(b[k])) add(k + " is not an array");
  for (const k of ["af", "sizing", "fees", "pricing", "bulk", "radar", "noclaim", "old", "counts"]) if (!isObj(b[k])) add(k + " is not an object");
  const radar = isObj(b.radar) ? b.radar : {};
  const noclaim = isObj(b.noclaim) ? b.noclaim : {};
  const old = isObj(b.old) ? b.old : {};
  if (isObj(b.radar)) for (const k of ["games", "feed"]) if (!Array.isArray(radar[k])) add("radar." + k + " is not an array");
  if (isObj(b.noclaim)) for (const k of ["units", "waves"]) if (!Array.isArray(noclaim[k])) add("noclaim." + k + " is not an array");
  if (isObj(b.old)) for (const k of ["games", "offers"]) if (!isObj(old[k])) add("old." + k + " is not an object");

  // plain JSON everywhere: what is written must read back identical
  const walk = (v, path, depth) => {
    if (problems.length >= 100 || depth > 64) return;
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) add(path + " is not a finite number");
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], path + "[" + i + "]", depth + 1);
      return;
    }
    if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      for (const k of Object.keys(v)) walk(v[k], path ? path + "." + k : k, depth + 1);
      return;
    }
    add(path + " is not plain JSON (" + (v === undefined ? "undefined" : v && v.constructor ? v.constructor.name : typeof v) + ")");
  };
  walk(b, "", 0);

  const isT = (v) => typeof v === "number" && Number.isFinite(v);
  const isTN = (v) => v === null || isT(v);
  const each = (list, name, fn) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length && problems.length < 100; i++) {
      const x = list[i];
      if (!isObj(x)) add(name + "[" + i + "] is not an object");
      else fn(x, name + "[" + i + "]");
    }
  };
  // a sale's or a demand record's market: one of the seven keys or OTHER_MARKETS (free text never)
  const market = (m) => BUNDLE_MARKETS.includes(m);
  // a unit's market and sold market may also be "" (not attached / not sold yet)
  const unitMarket = (m) => m === "" || BUNDLE_MARKETS.includes(m);
  each(b.listings, "listings", (L, p) => {
    if (typeof L.id !== "string" || !HEX12.test(L.id)) add(p + ".id is not a 12-hex hash");
    if (!MARKETS.includes(L.m)) add(p + ".m is not a market key: " + JSON.stringify(L.m));
    if (!KINDS.includes(L.kind)) add(p + ".kind is unknown: " + JSON.stringify(L.kind));
    if (!ORIGINS.includes(L.o)) add(p + ".o is unknown: " + JSON.stringify(L.o));
    if (!FARMS.includes(L.f)) add(p + ".f is unknown: " + JSON.stringify(L.f));
    if (!isT(L.p)) add(p + ".p is not a price");
    if (L.c !== undefined && !isTN(L.c)) add(p + ".c is not a time");
    if (L.units !== undefined && !Array.isArray(L.units)) add(p + ".units is not an array");
  });
  each(b.sales, "sales", (s, p) => {
    if (!market(s.m)) add(p + ".m is not a market key: " + JSON.stringify(s.m));
    if (!isT(s.t)) add(p + ".t is not a time");
    if (!(isT(s.p) && s.p >= 0)) add(p + ".p is not a price");
    if (!FARMS.includes(s.f)) add(p + ".f is unknown");
    if (!SALE_SOURCES.includes(s.src)) add(p + ".src is unknown: " + JSON.stringify(s.src));
    if (s.basis !== undefined && !SALE_BASES.includes(s.basis)) add(p + ".basis is unknown: " + JSON.stringify(s.basis));
    if (s.lid !== undefined && s.lid !== "" && !(typeof s.lid === "string" && HEX12.test(s.lid))) add(p + ".lid is not a 12-hex hash");
    if (s.grp !== undefined && !(typeof s.grp === "string" && HEX12.test(s.grp))) add(p + ".grp is not a 12-hex hash");
  });
  each(b.demandOnly, "demandOnly", (x, p) => {
    if (!market(x.m)) add(p + ".m is not a market key: " + JSON.stringify(x.m));
    if (!isT(x.t)) add(p + ".t is not a time");
    if (!FARMS.includes(x.f)) add(p + ".f is unknown");
    if (!DEMAND_SOURCES.includes(x.src)) add(p + ".src is unknown: " + JSON.stringify(x.src));
  });
  each(b.bulkPrices, "bulkPrices", (x, p) => {
    if (!market(x.m)) add(p + ".m is not a market key: " + JSON.stringify(x.m));
    if (!isT(x.t)) add(p + ".t is not a time");
    if (!(isT(x.pa) && x.pa >= 0)) add(p + ".pa is not a price");
  });
  each(radar.feed, "radar.feed", (x, p) => {
    if (!["gameflip", "ggsel", "digiseller"].includes(x.m)) add(p + ".m is not a radar market in tracker keys: " + JSON.stringify(x.m));
    if (!isT(x.t)) add(p + ".t is not a time");
  });
  each(radar.games, "radar.games", (x, p) => {
    if (isObj(x.byMarket)) for (const k of Object.keys(x.byMarket)) if (!["gameflip", "ggsel", "digiseller"].includes(k)) add(p + ".byMarket has key " + JSON.stringify(k));
  });
  each(b.demand, "demand", (x, p) => {
    if (typeof x.k !== "string" || !x.k) add(p + ".k is not a game key");
    if (!FARMS.includes(x.f)) add(p + ".f is unknown");
    if (!isT(x.at)) add(p + ".at is not a time");
  });
  each(noclaim.units, "noclaim.units", (x, p) => {
    if (x.m !== undefined && !unitMarket(x.m)) add(p + ".m is not a market key: " + JSON.stringify(x.m));
    if (x.sm !== undefined && !unitMarket(x.sm)) add(p + ".sm is not a market key: " + JSON.stringify(x.sm));
  });
  each(noclaim.waves, "noclaim.waves", (x, p) => {
    if (typeof x.g !== "string") add(p + ".g is not a game key");
    if (x.endAt !== undefined && !isTN(x.endAt)) add(p + ".endAt is not a time");
  });
  if (isObj(old.games)) {
    for (const [g, og] of Object.entries(old.games)) {
      if (!isObj(og)) {
        add("old.games." + g + " is not an object");
        continue;
      }
      if (og.order !== undefined && !(Array.isArray(og.order) && og.order.every((m) => MARKETS.includes(m)))) add("old.games." + g + ".order holds an unknown market");
      if (isObj(og.flat)) for (const m of Object.keys(og.flat)) if (!MARKETS.includes(m)) add("old.games." + g + ".flat has key " + JSON.stringify(m));
    }
  }
  if (isObj(old.offers)) for (const [k, oo] of Object.entries(old.offers)) if (!isObj(oo) || (oo.np !== null && oo.np !== undefined && !isT(oo.np))) add("old.offers." + k + " has no valid np");
  if (Array.isArray(b.notes) && !b.notes.every((n) => typeof n === "string")) add("notes holds a non-string");
  return problems;
}

/**
 * Read a bundle file written by scripts/listing-brain-export.js (or a fixture). Throws one clear error
 * for a missing file, a file that is not JSON, the wrong kind or version, or a bundle that fails
 * validateBundle.
 */
function loadFromBundle(file) {
  const where = String(file || "");
  if (!where) throw new Error("listing brain bundle: no file given");
  let text;
  try {
    text = fs.readFileSync(where, "utf8");
  } catch (e) {
    throw new Error("listing brain bundle: cannot read " + where + " (" + (e && e.code ? e.code : cleanMsg(e)) + ")");
  }
  let b;
  try {
    b = JSON.parse(text);
  } catch (e) {
    throw new Error("listing brain bundle: " + where + " is not JSON (" + cleanMsg(e) + ")");
  }
  if (!isObj(b) || b.kind !== BUNDLE_KIND) throw new Error("listing brain bundle: " + where + " is not a listing-brain bundle (kind " + JSON.stringify(isObj(b) ? b.kind : typeof b) + ")");
  if (b.v !== BUNDLE_V) throw new Error("listing brain bundle: " + where + " is version " + JSON.stringify(b.v) + "; this code reads v" + BUNDLE_V);
  const problems = validateBundle(b);
  if (problems.length) {
    throw new Error("listing brain bundle: " + where + " failed validation (" + problems.length + (problems.length >= 100 ? "+" : "") + " problems): " + problems.slice(0, 5).join("; "));
  }
  return b;
}

module.exports = {
  realDeps,
  load,
  loadEvidence,
  loadFromBundle,
  validateBundle,
  privacyScan,
  hashId,
  mapLimit,
  withTimeout,
  // the named pieces, each exercised by the tests
  readWindows,
  settingsBlock,
  readListings,
  readUnits,
  readCampaigns,
  readResearch,
  readDemandRows,
  normaliseListings,
  saleRecords,
  noclaimUnits,
  readEventSets,
  refillShelf,
  trackerOffers,
  takesOf,
  setItems,
  dropsFromItems,
  makeHasher,
  makeBreather,
  waves,
  radarSlim,
  demandRows,
  gameLabels,
  afBlock,
  oldSide,
  oldOrder,
  matchResearch,
  researchIndex,
  kindOf,
  farmOf,
  bucketOfKey,
  noclaimKeywords,
  trackerMarket,
  marketKey,
  zeusxMapped,
  cleanMsg,
  msOf,
  configBlock,
  demandLookbackH,
  // constants
  BUNDLE_KIND,
  BUNDLE_V,
  MARKETS,
  OTHER_MARKETS,
  BUNDLE_MARKETS,
  KINDS,
  ORIGINS,
  FARMS,
  SALE_SOURCES,
  DEMAND_SOURCES,
  SALE_BASES,
  FORBIDDEN_KEYS,
  LISTING_PROJECTION,
  UNIT_PROJECTION,
  CAMPAIGN_PROJECTION,
  MANIFEST_PROJECTION,
  RESEARCH_PROJECTION,
  DEMAND_PROJECTION,
  LISTING_CAP,
  UNIT_CAP,
  CAMPAIGN_CAP,
  MANIFEST_CAP,
  RESEARCH_CAP,
  DEMAND_ROW_CAP,
  REPORT_TIMEOUT_MS,
  VENUE_TIMEOUT_MS,
  OLD_CONCURRENCY,
  DEMAND_LOOKBACK_MIN_H,
  DEMAND_LOOKBACK_MARGIN_H,
  BACKTEST_PAD_DAYS,
  UNIT_LISTED_PAD_DAYS,
  CAMPAIGN_WINDOW_DAYS,
  MAX_UNITS_PER_ROW,
  MAX_OLD_GAMES,
  MAX_OFFERS,
  MAX_TRACKER_OFFERS,
  MAX_ON_HAND,
  MAX_ITEM_COPIES,
  READ_MAX_TIME_MS,
  ID_CHUNK,
  YIELD_BUDGET_MS,
  CAP_DEFAULT,
};
