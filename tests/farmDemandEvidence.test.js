// No-claim demand evidence, utils/farmDemand.js (docs/LIVE-FIXES-1003.md §A4).
//
// Two defects in the numbers the no-claim feeder sizes its fleet on:
//
//   5. Every GGSel/Digiseller quantity sale counted twice. The auto-lister's
//      expiry pass spends a victim out of the row's pool (a ledger row under the
//      victim's login) AND writes a listing_sold signal whose login is the row's
//      whole delivery pool, "a, b, c". Two keys, two units.
//   4. A one-day lump (a hand sale, a bulk pack) went through the in-stock
//      correction and read as N a week. The burst guard counts those raw; it
//      ships DARK (autoFarm.noclaimBurstGuard, false).
//
// The promise this file holds the module to: with the guard off, every number
// is the one production's bytes (119faace) produced, except the dropped
// duplicates. The GOLDEN below was recorded by running this exact fixture
// through those bytes. No database, no settings.json: the five models and
// utils/settings are stubbed at require time.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const farmSizing = require("../utils/farmSizing");

// <world> — the fixture and the stand-ins, kept in one self-contained block
// (down to </world>) so the GOLDEN can be re-recorded against any bytes of
// utils/farmDemand.js by evaluating just this block.
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const ago = (days) => new Date(NOW - days * DAY);
const NO_CLAIM_GAMES = ["overwatch", "rainbow six", "call of duty"];

const R6 = "Tom Clancy's Rainbow Six Siege";
const OW = "Overwatch 2";
const COD = "Call of Duty: Black Ops 6";
const L_PACK = "aaaaaaaaaaaaaaaaaaaaaa01"; // a bulk pack's claim-at-sale row
const L_ELD = "aaaaaaaaaaaaaaaaaaaaaa02";
const L_G2G = "aaaaaaaaaaaaaaaaaaaaaa03";
const L_PA = "aaaaaaaaaaaaaaaaaaaaaa04";
const S_R6 = "bbbbbbbbbbbbbbbbbbbbbb01";
const S_OW = "bbbbbbbbbbbbbbbbbbbbbb02";
const S_COD = "bbbbbbbbbbbbbbbbbbbbbb03";

let seq = 0;
function ledger(login, game, status, extra = {}) {
  seq++;
  return {
    _id: "u" + String(seq).padStart(3, "0"),
    login,
    loginLower: login.toLowerCase(),
    game,
    status,
    market: "",
    soldMarket: "",
    soldAt: null,
    soldPriceUsd: 0,
    set: null,
    manualListing: "",
    listedAt: null,
    ...extra,
  };
}
const sold = (login, game, days, soldMarket, price, extra = {}) =>
  ledger(login, game, "sold", { soldAt: ago(days), soldMarket, market: extra.market || "", soldPriceUsd: price, ...extra });

function signal(gameKey, login, source, marketplace, days, priceUsd, dedupeKey) {
  return { gameKey, game: gameKey, login, source, marketplace, at: ago(days), priceUsd, dedupeKey };
}

// The base fixture: three buckets plus a game that is not one, every source
// and every dating rule the module has (window, 14-day window, prior history,
// confirming-only witnesses, anonymous units, set-price fallback), hand sales
// and a bulk pack. No pooled signal anywhere.
function baseWorld() {
  seq = 0;
  const ledgers = [
    // Rainbow Six: Eldorado singles (one priced from its set), a 5-account bulk
    // pack, a 5-account hand sale, a GGSel quantity read that sold two units,
    // G2G, an old sale inside the prior history, a Gameflip unit, and one older
    // than the history (the query must not return it).
    sold("r6a", R6, 2, "eldorado", 4.5, { market: "eldorado", manualListing: L_ELD, set: S_R6, listedAt: ago(2.5) }),
    sold("r6b", R6, 3, "eldorado", 4.5, { market: "eldorado", manualListing: L_ELD, set: S_R6, listedAt: ago(4) }),
    sold("r6c", R6, 5, "eldorado", 0, { market: "eldorado", manualListing: L_ELD, set: S_R6 }),
    ...[1, 2, 3, 4, 5].map((i) =>
      sold("r6pk" + i, R6, 4, "eldorado", 0, { market: "eldorado", manualListing: L_PACK, set: S_R6 }),
    ),
    ...[1, 2, 3, 4, 5].map((i) => sold("r6h" + i, R6, 6, "manual", 0)),
    sold("r6n", R6, 10, "ggsel", 3, { market: "ggsel", set: S_R6, listedAt: ago(15) }),
    sold("r6o", R6, 10 - 1 / 1440, "ggsel", 3, { market: "ggsel", set: S_R6, listedAt: ago(15) }),
    sold("r6p", R6, 20, "g2g", 5, { market: "g2g", manualListing: L_G2G }),
    sold("r6q", R6, 40, "eldorado", 4, { market: "eldorado" }),
    sold("r6r", R6, 25, "", 3.3, { market: "gameflip", set: S_R6, listedAt: ago(26) }),
    sold("r6old", R6, 200, "eldorado", 4, { market: "eldorado" }),
    // Overwatch: Gameflip, PlayerAuctions, a GGSel unit, an Eldorado sale priced
    // from its set, an old-ish Eldorado sale and one hand sale.
    sold("owa", OW, 1, "gameflip", 2, { market: "gameflip", set: S_OW, listedAt: ago(3) }),
    sold("owb", OW, 8, "playerauctions", 3.5, { market: "playerauctions", manualListing: L_PA }),
    sold("owc", OW, 12, "ggsel", 2.2, { market: "ggsel", set: S_OW, listedAt: ago(13) }),
    sold("owd", "overwatch", 16, "eldorado", 0, { market: "eldorado", set: S_OW }),
    sold("owe", OW, 28, "eldorado", 3, { market: "eldorado" }),
    sold("owf", OW, 2, "manual", 0),
    // Call of Duty: Eldorado and a hand sale near the window's edge.
    sold("coda", COD, 3, "eldorado", 6, { market: "eldorado", set: S_COD }),
    sold("codb", COD, 29, "manual", 0),
    // Not a no-claim game.
    sold("rusta", "Rust", 2, "gameflip", 1, { market: "gameflip" }),
    // Stock (never sold).
    ...["r6l1", "r6l2", "r6l3"].map((l) => ledger(l, R6, "listed")),
    ...["r6s1", "r6s2"].map((l) => ledger(l, R6, "skipped")),
    ledger("r6e1", R6, "expired"),
    ledger("r6e2", R6, "released"),
    ledger("r6m1", R6, "manual"),
    ledger("r6x1", R6, "removed"),
    ...["owl1", "owl2", "owl3"].map((l) => ledger(l, OW, "listed")),
    ledger("owl4", "overwatch", "listed"),
    ledger("ows1", OW, "skipped"),
    ...["owe1", "owe2"].map((l) => ledger(l, OW, "expired")),
    ledger("codl1", COD, "listed"),
    ...["rustl1", "rustl2"].map((l) => ledger(l, "Rust", "listed")),
  ];
  const signals = [
    signal("overwatch 2", "owa", "connected", "", 0.5, 0, "c:owa"),
    signal("overwatch 2", "owa", "listing_sold", "gameflip", 1, 2.1, "sold:f1:overwatch 2:0"),
    signal("overwatch 2", "owx", "connected", "", 6, 0, "c:owx"),
    signal("overwatch 2", "owold", "connected", "", 60, 0, "c:owold"),
    signal("overwatch", "owz", "listing_sold", "gameflip", 9, 2.4, "sold:f2:overwatch:0"),
    // Anonymous Digiseller units: no login, and a dedupeKey whose gameKey has
    // spaces in it — which must never be mistaken for a login pool.
    signal("call of duty black ops 6", "", "listing_sold", "digiseller", 7, 1.5, "sold:d1:call of duty black ops 6:0"),
    signal("call of duty black ops 6", "", "listing_sold", "digiseller", 7 - 1 / 24, 1.5, "sold:d1:call of duty black ops 6:1"),
    signal("tom clancy's rainbow six siege", "r6a", "connected", "", 1, 0, "c:r6a"),
    signal("tom clancy's rainbow six siege", "r6conn", "connected", "", 13, 0, "c:r6conn"),
    signal("rust", "rusta", "listing_sold", "gameflip", 2, 1, "sold:f3:rust:0"),
  ];
  const spent = [
    { loginLower: "r6a", login: "r6a", game: R6, sold: true, connected: false, sweptAt: ago(1) },
    { loginLower: "owlegacy", login: "owlegacy", game: OW, sold: false, connected: true, sweptAt: ago(3) },
    { loginLower: "owswept", login: "owswept", game: "Overwatch", sold: true, connected: false, sweptAt: ago(45) },
    { loginLower: "r6x", login: "r6x", game: "Rainbow Six", sold: false, connected: false, sweptAt: ago(2) },
  ];
  const pool = [
    { usernameLower: "codlegacy", username: "codlegacy", status: "claimed", manualSold: true, soldGames: ["call of duty"], claimedNote: "", updatedAt: ago(2) },
    { usernameLower: "owhand", username: "owhand", status: "claimed", manualSold: true, soldGames: [], claimedNote: "noclaim-farm:Overwatch 2", updatedAt: ago(4) },
    { usernameLower: "r6h1", username: "r6h1", status: "claimed", manualSold: true, soldGames: ["rainbow six"], claimedNote: "", updatedAt: ago(5) },
    { usernameLower: "r6new1", username: "r6new1", status: "claimed", manualSold: false, soldGames: [], claimedNote: "noclaim-farm:" + R6, updatedAt: ago(1) },
    { usernameLower: "r6new2", username: "r6new2", status: "claimed", soldGames: [], claimedNote: "noclaim-farm:" + R6, updatedAt: ago(1) },
    { usernameLower: "r6l1", username: "r6l1", status: "claimed", manualSold: false, soldGames: [], claimedNote: "noclaim-farm:" + R6, updatedAt: ago(9) },
    { usernameLower: "ownew1", username: "ownew1", status: "claimed", manualSold: false, soldGames: [], claimedNote: "noclaim-farm:" + OW, updatedAt: ago(1) },
    { usernameLower: "autofarm1", username: "autofarm1", status: "claimed", manualSold: false, soldGames: [], claimedNote: "auto-farm: Rust", updatedAt: ago(1) },
  ];
  const listings = [
    { _id: L_PACK, bulkOfferId: "cccccccccccccccccccccc01", origin: "manual", marketplace: "eldorado", set: S_R6, price: 20 },
    { _id: L_ELD, bulkOfferId: null, origin: "manual", marketplace: "eldorado", set: S_R6, price: 4.5 },
    { _id: L_G2G, bulkOfferId: null, origin: "manual", marketplace: "g2g", set: S_R6, price: 5 },
    { _id: L_PA, bulkOfferId: null, origin: "manual", marketplace: "playerauctions", set: S_OW, price: 3.5 },
    { _id: "aaaaaaaaaaaaaaaaaaaaaa05", bulkOfferId: null, origin: "unclaimed", marketplace: "gameflip", set: S_R6, price: 3.9 },
    { _id: "aaaaaaaaaaaaaaaaaaaaaa06", bulkOfferId: null, origin: "unclaimed", marketplace: "ggsel", set: S_R6, price: 4.2 },
    { _id: "aaaaaaaaaaaaaaaaaaaaaa07", bulkOfferId: null, origin: "unclaimed", marketplace: "gameflip", set: S_OW, price: 2.5 },
  ];
  return { ledgers, signals, spent, pool, listings, af: {} };
}

// The pooled signals production writes for the GGSel quantity sales above —
// each a DUPLICATE of victims already in the ledger (r6n + r6o, owc), plus one
// pooled sale older than the window (counted by neither version) and the same
// pool under a second gameKey of the same bucket (one unit, not two).
function pooledSignals() {
  return [
    signal("tom clancy's rainbow six siege", "r6n, r6o, r6z", "listing_sold", "ggsel", 10, 3, "sold:g1:tom clancy's rainbow six siege:0"),
    signal("tom clancy's rainbow six siege", "r6n, r6o, r6z", "listing_sold", "ggsel", 10 - 1 / 1440, 3, "sold:g1:tom clancy's rainbow six siege:1"),
    signal("tom clancy's rainbow six siege", "r6q, r6w", "listing_sold", "digiseller", 50, 4, "sold:g3:tom clancy's rainbow six siege:0"),
    signal("overwatch 2", "owc, owy", "listing_sold", "ggsel", 12, 2.2, "sold:g2:overwatch 2:0"),
    signal("overwatch", "owc, owy", "listing_sold", "ggsel", 11, 2.2, "sold:g2:overwatch:0"),
  ];
}

// --- the stand-ins -----------------------------------------------------------

// Just enough of a MongoDB filter for the queries utils/farmDemand.js makes. An
// operator it does not know throws, so a new query shape cannot pass unnoticed.
function cmp(v, cond) {
  if (cond instanceof RegExp) return cond.test(v == null ? "" : String(v));
  if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$gte") return v != null && v >= arg;
      if (op === "$in") return arg.some((a) => String(a) === String(v));
      if (op === "$ne") return arg === null ? v != null : v !== arg;
      throw new Error("fake model: unsupported operator " + op);
    });
  }
  return v === cond;
}
function matches(doc, q = {}) {
  return Object.entries(q).every(([k, cond]) =>
    k === "$or" ? cond.some((c) => matches(doc, c)) : cmp(doc[k], cond),
  );
}
// Projections are honoured, so a field the module reads but forgot to project
// comes back undefined here exactly as it would from the database.
function project(doc, proj) {
  if (!proj || !Object.keys(proj).length) return { ...doc };
  const out = {};
  if (proj._id !== 0 && "_id" in doc) out._id = doc._id;
  for (const [k, on] of Object.entries(proj)) if (on && k in doc) out[k] = doc[k];
  return out;
}

function fakeModels(w) {
  const calls = [];
  const finder = (name, rows) => ({
    find(q, proj) {
      calls.push({ model: name, q, proj });
      if (w.failPackLookup && name === "MarketplaceListing" && q && "bulkOfferId" in q) {
        return { lean: async () => { throw new Error("listing read timed out"); } };
      }
      const out = rows.filter((r) => matches(r, q)).map((r) => project(r, proj));
      return { lean: async () => out };
    },
  });
  const UnclaimedAccount = {
    ...finder("UnclaimedAccount", w.ledgers),
    async aggregate(pipeline) {
      // stockByBucket: { $group: { _id: { g: "$game", s: "$status" }, n: { $sum: 1 } } }
      assert.ok(pipeline[0].$group, "unexpected UnclaimedAccount pipeline");
      const by = new Map();
      for (const l of w.ledgers) {
        const k = l.game + "\u0000" + l.status;
        const cur = by.get(k) || by.set(k, { _id: { g: l.game, s: l.status }, n: 0 }).get(k);
        cur.n++;
      }
      return [...by.values()];
    },
  };
  const SaleSignal = {
    async distinct(field) {
      return [...new Set(w.signals.map((s) => s[field]))];
    },
    async aggregate(pipeline) {
      // The evidence pipeline: $match, then $group on (gameKey, login > "" ?
      // login : "anon:" + dedupeKey), exactly as farmDemand writes it.
      const match = pipeline[0].$match;
      assert.ok(match && pipeline[1].$group, "unexpected SaleSignal pipeline");
      const groups = new Map();
      for (const s of w.signals.filter((x) => matches(x, match))) {
        const who = typeof s.login === "string" && s.login > "" ? s.login : "anon:" + (s.dedupeKey ?? "?");
        const k = s.gameKey + "\u0000" + who;
        let g = groups.get(k);
        if (!g) {
          g = { _id: { g: s.gameKey, who }, sources: [], markets: [], priceUsd: 0, at: null, first: null };
          groups.set(k, g);
        }
        if (!g.sources.includes(s.source)) g.sources.push(s.source);
        if (!g.markets.includes(s.marketplace)) g.markets.push(s.marketplace);
        g.priceUsd = Math.max(g.priceUsd, s.priceUsd ?? 0);
        if (!g.at || s.at > g.at) g.at = s.at;
        if (!g.first || s.at < g.first) g.first = s.at;
      }
      return [...groups.values()];
    },
  };
  return {
    calls,
    UnclaimedAccount,
    SaleSignal,
    NoclaimSpentAccount: finder("NoclaimSpentAccount", w.spent),
    AvailableAccount: finder("AvailableAccount", w.pool),
    MarketplaceListing: finder("MarketplaceListing", w.listings),
  };
}

// utils/settings, reduced to what farmDemand calls. The sizing policy mirrors
// settings.getFarmSizing's defaults (28 days, safety 6, max 250) with one
// per-game override, so the per-bucket path is exercised too.
function fakeSettings(w) {
  const reads = { getAutoFarm: 0 };
  const per = { "call of duty": { coverageDays: 14, max: 40 } };
  const pick = (k, f, d) => (per[k] && per[k][f] != null ? per[k][f] : d);
  return {
    reads,
    normGameName: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    getAutoFarm() {
      reads.getAutoFarm++;
      return { noClaimGames: NO_CLAIM_GAMES, ...(w.af || {}) };
    },
    getNoclaimSizing: () => ({
      coverageDays: 28,
      safetyStock: 6,
      coverageDaysFor: (k) => pick(k, "coverageDays", 28),
      safetyStockFor: (k) => pick(k, "safetyStock", 6),
      minFor: (k) => pick(k, "min", 0),
      maxFor: (k) => pick(k, "max", 250),
    }),
  };
}

function loadFarmDemand(w) {
  const models = fakeModels(w);
  const settings = fakeSettings(w);
  const stubs = new Map([
    [require.resolve("../models/AvailableAccount"), models.AvailableAccount],
    [require.resolve("../models/NoclaimSpentAccount"), models.NoclaimSpentAccount],
    [require.resolve("../models/SaleSignal"), models.SaleSignal],
    [require.resolve("../models/UnclaimedAccount"), models.UnclaimedAccount],
    [require.resolve("../models/MarketplaceListing"), models.MarketplaceListing],
    [require.resolve("../utils/settings"), settings],
  ]);
  const target = require.resolve("../utils/farmDemand");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  delete require.cache[target];
  try {
    return { fd: require("../utils/farmDemand"), models, settings };
  } finally {
    Module._load = origLoad;
    delete require.cache[target];
  }
}

// The module reads the clock through Date.now() only.
async function atNow(fn) {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
// Every field the evidence carries, in the module's own insertion order. The
// `pack` marker is new (2026-10-03) and left out unless asked for, so the view
// of the OLD fields can be compared with the old bytes'.
function evidenceView(ev, { withPack = false } = {}) {
  const units = {};
  for (const [bucket, inner] of ev.units) {
    units[bucket] = [...inner.entries()].map(([id, u]) => ({
      id,
      sources: [...u.sources],
      priceUsd: u.priceUsd,
      market: u.market,
      at: iso(u.at),
      firstAt: iso(u.firstAt),
      confirmedAt: iso(u.confirmedAt),
      ...(withPack && u.pack ? { pack: true } : {}),
    }));
  }
  return { since: iso(ev.since), units, undated: Object.fromEntries(ev.undated) };
}
// </world>

// Recorded 2026-10-03 by running baseWorld() through production's
// utils/farmDemand.js (blob 119faace) with the stand-ins above: the snapshot rows
// as JSON, and evidenceView() of saleEvidenceByBucket({ days: 30 }). Through
// those bytes, baseWorld() + pooledSignals() read Rainbow Six 19 units / shelf
// 1.5 a week / target 68 and Overwatch 9 / 2 / 26 — one phantom unit per pool.
const GOLDEN = {
  snapshot: [
    {"key":"rainbow six","label":"Rainbow Six","windowDays":30,"sales":{"count":18,"perWeek":15,"rawPerWeek":4.2,"shelfPerWeek":1,"otherPerWeek":14,"sellingDays":7,"undated":0,"revenue":48.5,"avgPrice":4.04,"priced":12,"bySource":{"ledger":17,"connected":2,"swept":1,"manual_sold":1},"byMarket":{"eldorado":8,"manual":5,"ggsel":2,"g2g":1,"gameflip":1}},"stock":{"listed":3,"held":2,"inFlight":2,"sold":19,"expired":2},"onHand":5,"timeToSale":{"n":5,"medianHours":24,"minHours":12,"maxHours":120.01666666666667},"daysOfCover":2.3,"policy":{"coverageDays":28,"safetyStock":6,"min":0,"max":250},"targetParts":{"shelf":4,"other":56,"safety":6},"target":66,"inFlight":2,"need":59,"spare":0,"weight":60.6},
    {"key":"overwatch","label":"Overwatch","windowDays":30,"sales":{"count":8,"perWeek":4.5,"rawPerWeek":1.9,"shelfPerWeek":1.5,"otherPerWeek":3,"sellingDays":5,"undated":2,"revenue":15.7,"avgPrice":2.62,"priced":6,"bySource":{"ledger":6,"connected":2,"listing_sold":2},"byMarket":{"gameflip":2,"playerauctions":1,"ggsel":1,"eldorado":2,"manual":1}},"stock":{"listed":4,"held":1,"inFlight":1,"sold":6,"expired":2},"onHand":5,"timeToSale":{"n":2,"medianHours":36,"minHours":24,"maxHours":48},"daysOfCover":7.8,"policy":{"coverageDays":28,"safetyStock":6,"min":0,"max":250},"targetParts":{"shelf":6,"other":12,"safety":6},"target":24,"inFlight":1,"need":18,"spare":0,"weight":11.790000000000001},
    {"key":"call of duty","label":"Call Of Duty","windowDays":30,"sales":{"count":4,"perWeek":2,"rawPerWeek":0.9,"shelfPerWeek":1,"otherPerWeek":1,"sellingDays":2,"undated":1,"revenue":9,"avgPrice":3,"priced":3,"bySource":{"ledger":2,"listing_sold":2},"byMarket":{"eldorado":1,"manual":1,"digiseller":2}},"stock":{"listed":1,"held":0,"inFlight":0,"sold":2,"expired":0},"onHand":1,"timeToSale":null,"daysOfCover":3.5,"policy":{"coverageDays":14,"safetyStock":6,"min":0,"max":40},"targetParts":{"shelf":2,"other":2,"safety":6},"target":10,"inFlight":0,"need":9,"spare":0,"weight":6},
  ],
  evidence: {
    since: "2026-09-03T12:00:00.000Z",
    units: {
      "rainbow six": [
        {"id":"r6a","sources":["ledger","connected","swept"],"priceUsd":4.5,"market":"eldorado","at":"2026-10-02T12:00:00.000Z","firstAt":"2026-10-01T12:00:00.000Z","confirmedAt":"2026-10-02T12:00:00.000Z"},
        {"id":"r6b","sources":["ledger"],"priceUsd":4.5,"market":"eldorado","at":"2026-09-30T12:00:00.000Z","firstAt":"2026-09-30T12:00:00.000Z","confirmedAt":null},
        {"id":"r6c","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-28T12:00:00.000Z","firstAt":"2026-09-28T12:00:00.000Z","confirmedAt":null},
        {"id":"r6pk1","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-29T12:00:00.000Z","firstAt":"2026-09-29T12:00:00.000Z","confirmedAt":null},
        {"id":"r6pk2","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-29T12:00:00.000Z","firstAt":"2026-09-29T12:00:00.000Z","confirmedAt":null},
        {"id":"r6pk3","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-29T12:00:00.000Z","firstAt":"2026-09-29T12:00:00.000Z","confirmedAt":null},
        {"id":"r6pk4","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-29T12:00:00.000Z","firstAt":"2026-09-29T12:00:00.000Z","confirmedAt":null},
        {"id":"r6pk5","sources":["ledger"],"priceUsd":4.2,"market":"eldorado","at":"2026-09-29T12:00:00.000Z","firstAt":"2026-09-29T12:00:00.000Z","confirmedAt":null},
        {"id":"r6h1","sources":["ledger","manual_sold"],"priceUsd":0,"market":"manual","at":"2026-09-28T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":"2026-09-28T12:00:00.000Z"},
        {"id":"r6h2","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-09-27T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":null},
        {"id":"r6h3","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-09-27T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":null},
        {"id":"r6h4","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-09-27T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":null},
        {"id":"r6h5","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-09-27T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":null},
        {"id":"r6n","sources":["ledger"],"priceUsd":3,"market":"ggsel","at":"2026-09-23T12:00:00.000Z","firstAt":"2026-09-23T12:00:00.000Z","confirmedAt":null},
        {"id":"r6o","sources":["ledger"],"priceUsd":3,"market":"ggsel","at":"2026-09-23T12:01:00.000Z","firstAt":"2026-09-23T12:01:00.000Z","confirmedAt":null},
        {"id":"r6p","sources":["ledger"],"priceUsd":5,"market":"g2g","at":"2026-09-13T12:00:00.000Z","firstAt":"2026-09-13T12:00:00.000Z","confirmedAt":null},
        {"id":"r6r","sources":["ledger"],"priceUsd":3.3,"market":"gameflip","at":"2026-09-08T12:00:00.000Z","firstAt":"2026-09-08T12:00:00.000Z","confirmedAt":null},
        {"id":"r6conn","sources":["connected"],"priceUsd":0,"market":"","at":"2026-09-20T12:00:00.000Z","firstAt":"2026-09-20T12:00:00.000Z","confirmedAt":null},
      ],
      "overwatch": [
        {"id":"owa","sources":["ledger","connected","listing_sold"],"priceUsd":2.1,"market":"gameflip","at":"2026-10-03T00:00:00.000Z","firstAt":"2026-10-02T12:00:00.000Z","confirmedAt":null},
        {"id":"owb","sources":["ledger"],"priceUsd":3.5,"market":"playerauctions","at":"2026-09-25T12:00:00.000Z","firstAt":"2026-09-25T12:00:00.000Z","confirmedAt":null},
        {"id":"owc","sources":["ledger"],"priceUsd":2.2,"market":"ggsel","at":"2026-09-21T12:00:00.000Z","firstAt":"2026-09-21T12:00:00.000Z","confirmedAt":null},
        {"id":"owd","sources":["ledger"],"priceUsd":2.5,"market":"eldorado","at":"2026-09-17T12:00:00.000Z","firstAt":"2026-09-17T12:00:00.000Z","confirmedAt":null},
        {"id":"owe","sources":["ledger"],"priceUsd":3,"market":"eldorado","at":"2026-09-05T12:00:00.000Z","firstAt":"2026-09-05T12:00:00.000Z","confirmedAt":null},
        {"id":"owf","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-10-01T12:00:00.000Z","firstAt":"2026-10-01T12:00:00.000Z","confirmedAt":null},
        {"id":"owx","sources":["connected"],"priceUsd":0,"market":"","at":"2026-09-27T12:00:00.000Z","firstAt":"2026-09-27T12:00:00.000Z","confirmedAt":null},
        {"id":"owz","sources":["listing_sold"],"priceUsd":2.4,"market":"gameflip","at":"2026-09-24T12:00:00.000Z","firstAt":"2026-09-24T12:00:00.000Z","confirmedAt":null},
      ],
      "call of duty": [
        {"id":"coda","sources":["ledger"],"priceUsd":6,"market":"eldorado","at":"2026-09-30T12:00:00.000Z","firstAt":"2026-09-30T12:00:00.000Z","confirmedAt":null},
        {"id":"codb","sources":["ledger"],"priceUsd":0,"market":"manual","at":"2026-09-04T12:00:00.000Z","firstAt":"2026-09-04T12:00:00.000Z","confirmedAt":null},
        {"id":"anon:listing_sold:anon:sold:d1:call of duty black ops 6:0","sources":["listing_sold"],"priceUsd":1.5,"market":"digiseller","at":"2026-09-26T12:00:00.000Z","firstAt":"2026-09-26T12:00:00.000Z","confirmedAt":null},
        {"id":"anon:listing_sold:anon:sold:d1:call of duty black ops 6:1","sources":["listing_sold"],"priceUsd":1.5,"market":"digiseller","at":"2026-09-26T13:00:00.000Z","firstAt":"2026-09-26T13:00:00.000Z","confirmedAt":null},
      ],
    },
    undated: {"rainbow six":0,"overwatch":2,"call of duty":1},
  },
};

const sameBytes = (actual, expected, msg) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
const snapshotOf = async (w, opts = {}) => {
  const { fd } = loadFarmDemand(w);
  return JSON.parse(JSON.stringify(await atNow(() => fd.unclaimedDemandSnapshot({ days: 30, ...opts }))));
};
const withPools = () => {
  const w = baseWorld();
  w.signals = w.signals.concat(pooledSignals());
  return w;
};
const rowOf = (rows, key) => rows.find((r) => r.key === key);

// ---------------------------------------------------------------------------
// Defect 5 — the pooled listing_sold double count
// ---------------------------------------------------------------------------

test("a login pool is more than one name; a single login (or a blank) is not", () => {
  const { fd } = loadFarmDemand(baseWorld());
  for (const pool of ["a, b", "r6n, r6o, r6z", "a,b", "a;b", "a b"]) assert.equal(fd.isLoginPool(pool), true, pool);
  for (const one of ["r6n", "R6N", " r6n ", "r6n,", "", null, undefined]) assert.equal(fd.isLoginPool(one), false, String(one));
});

test("a pooled listing_sold beside its victim's ledger row is ONE sale, not two", () => {
  const { fd } = loadFarmDemand(baseWorld());
  const acc = fd.saleAccumulator(NO_CLAIM_GAMES);
  // One GGSel stock drop of 1: the expiry pass spends the victim (a ledger row
  // under its own login) and recordListingSale writes the row's whole pool.
  acc.add(R6, "r6n", "ledger", { market: "ggsel", at: ago(10), priceUsd: 3, dedupe: "u1" });
  acc.add("tom clancy's rainbow six siege", "r6n, r6o, r6z", "listing_sold", {
    market: "ggsel",
    at: ago(10),
    firstAt: ago(10),
    priceUsd: 3,
    dedupe: "r6n, r6o, r6z",
  });
  const out = acc.split(ago(30));
  assert.deepEqual([...out.units.get("rainbow six").keys()], ["r6n"], "production counted r6n AND the pool string");
  assert.equal(out.pooled.get("rainbow six"), 1);
});

test("two units sold in one read are two sales, not three", () => {
  const { fd } = loadFarmDemand(baseWorld());
  const acc = fd.saleAccumulator(NO_CLAIM_GAMES);
  acc.add(R6, "r6n", "ledger", { market: "ggsel", at: ago(10), dedupe: "u1" });
  acc.add(R6, "r6o", "ledger", { market: "ggsel", at: ago(10), dedupe: "u2" });
  // recordListingSale writes one signal per unit; both carry the same pool, so
  // the database groups them into one row (one source, the earliest `first`).
  acc.add("tom clancy's rainbow six siege", "r6n, r6o, r6z", "listing_sold", { market: "ggsel", at: ago(10), firstAt: ago(10) });
  // A pool first seen before the window would not have counted either way.
  acc.add("tom clancy's rainbow six siege", "r6q, r6w", "listing_sold", { market: "ggsel", at: ago(50), firstAt: ago(50) });
  const out = acc.split(ago(30));
  assert.deepEqual([...out.units.get("rainbow six").keys()], ["r6n", "r6o"]);
  assert.equal(out.pooled.get("rainbow six"), 1, "only the in-window pool was ever counted");
  // A connection flip is never dropped, pool-looking or not: only listing_sold.
  const acc2 = fd.saleAccumulator(NO_CLAIM_GAMES);
  acc2.add(R6, "a, b", "connected", { at: ago(3) });
  assert.equal(acc2.split(ago(30)).units.get("rainbow six").size, 1);
});

test("saleEvidenceByBucket: production's pooled signals add nothing; everything else is untouched", async () => {
  const { fd } = loadFarmDemand(withPools());
  const ev = await atNow(() => fd.saleEvidenceByBucket({ days: 30 }));
  // Every unit, every field, in order — the pools were the whole difference.
  sameBytes(evidenceView(ev), GOLDEN.evidence);
  // One pool per bucket counted: R6's in-window pool (two signals, one row),
  // Overwatch's pool under two gameKeys (one unit); R6's 50-day-old pool never
  // counted in the window.
  assert.deepEqual(Object.fromEntries(ev.pooled), { "rainbow six": 1, overwatch: 1 });
  // An anonymous unit's dedupeKey holds its gameKey's spaces; it is no pool.
  assert.equal([...ev.units.get("call of duty").keys()].filter((k) => k.startsWith("anon:")).length, 2);
});

test("unclaimedDemandSnapshot: with production's pooled signals present, every number is the no-duplicate one", async () => {
  sameBytes(await snapshotOf(withPools()), GOLDEN.snapshot, "old bytes: R6 19 units, target 68; OW 9, target 26");
});

// ---------------------------------------------------------------------------
// Guard OFF (the default) is production, to the byte
// ---------------------------------------------------------------------------

test("guard off: the snapshot is production's, byte for byte, however 'off' is said", async () => {
  sameBytes(await snapshotOf(baseWorld()), GOLDEN.snapshot, "switch absent");
  sameBytes(await snapshotOf(baseWorld(), { burstGuard: false }), GOLDEN.snapshot, "explicit false");
  for (const v of [false, "true", 1, null]) {
    const w = baseWorld();
    w.af = { noclaimBurstGuard: v };
    sameBytes(await snapshotOf(w), GOLDEN.snapshot, "switch " + JSON.stringify(v) + " is not exactly true");
  }
});

test("guard off: every evidence field is production's (the pack marker is the only addition)", async () => {
  const { fd } = loadFarmDemand(baseWorld());
  const ev = await atNow(() => fd.saleEvidenceByBucket({ days: 30 }));
  sameBytes(evidenceView(ev), GOLDEN.evidence);
  assert.equal(ev.packError, undefined);
});

// Production's demandRates (utils/farmDemand.js, blob 119faace), VERBATIM apart
// from the module constants it closed over, so the new function can be held to
// it on any input.
function productionDemandRates(units, { days = 30, shortDays = 14, now = Date.now() } = {}) {
  const DAY_MS = 86400000;
  const SHELF_MARKETS = new Set(["gameflip", "ggsel", "digiseller"]);
  const lower = (s) => String(s || "").trim().toLowerCase();
  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const sizing = farmSizing;
  const shortW = Math.max(1, Math.min(shortDays, days));
  const shortSince = now - shortW * DAY_MS;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  let shelf = 0;
  let shelfShort = 0;
  let other = 0;
  let otherShort = 0;
  const otherDays = new Set();
  const otherDaysShort = new Set();
  for (const u of units || []) {
    const t = u && u.firstAt ? new Date(u.firstAt).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const recent = t >= shortSince;
    if (SHELF_MARKETS.has(lower(u.market))) {
      shelf++;
      if (recent) shelfShort++;
    } else {
      other++;
      otherDays.add(dayOf(t));
      if (recent) {
        otherShort++;
        otherDaysShort.add(dayOf(t));
      }
    }
  }
  const shelfPerWeek = Math.max(
    sizing.salesPerWeek(shelf, days),
    sizing.salesPerWeek(shelfShort, shortW),
  );
  const otherPerWeek = Math.max(
    sizing.inStockRate({ count: other, sellingDays: otherDays.size, windowDays: days }),
    sizing.inStockRate({ count: otherShort, sellingDays: otherDaysShort.size, windowDays: shortW }),
  );
  return {
    shelfPerWeek: round1(shelfPerWeek),
    otherPerWeek: round1(otherPerWeek),
    sellingDays: otherDays.size,
    shelfSales: shelf,
    otherSales: other,
  };
}

// A deterministic pseudo-random stream, so a failing case is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 500 random cases: any market spelling, packs, bad dates, odd windows.
function randomCases(n = 500) {
  const MARKETS = ["gameflip", "ggsel", "digiseller", "eldorado", "g2g", "playerauctions", "manual", "Manual", " MANUAL ", "", "unknown", undefined];
  const out = [];
  for (let c = 0; c < n; c++) {
    const r = rng(1000 + c);
    const now = NOW + Math.floor(r() * 48) * 3600000;
    const units = [];
    for (let i = Math.floor(r() * 60); i > 0; i--) {
      const k = r();
      const firstAt = k < 0.04 ? null : k < 0.07 ? "garbage" : new Date(now - r() * 40 * DAY + (k > 0.97 ? 2 * DAY : 0));
      units.push({ firstAt, market: MARKETS[Math.floor(r() * MARKETS.length)], ...(r() < 0.2 ? { pack: true } : {}) });
    }
    const opts = { days: [30, 14, 7, 1, 45, 0][Math.floor(r() * 6)], shortDays: [14, 7, 30, 1][Math.floor(r() * 4)], now };
    out.push({ c, units, opts });
  }
  return out;
}

test("guard off: demandRates is production's function on 500 random inputs (hand sales and packs included)", () => {
  const { fd } = loadFarmDemand(baseWorld());
  for (const { c, units, opts } of randomCases()) {
    const want = productionDemandRates(units, opts);
    sameBytes(fd.demandRates(units, opts), want, "case " + c + ": switch absent");
    sameBytes(fd.demandRates(units, { ...opts, burstGuard: false }), want, "case " + c + ": explicit false");
    sameBytes(fd.demandRates(units.values(), opts), want, "case " + c + ": an iterator, read once");
  }
});

test("guard on, but no hand sale or pack in the units: production's numbers again", () => {
  const { fd } = loadFarmDemand(baseWorld());
  const calm = (u) => !u.pack && String(u.market || "").trim().toLowerCase() !== "manual";
  for (const { c, units, opts } of randomCases()) {
    const rest = units.filter(calm);
    sameBytes(fd.demandRates(rest, { ...opts, burstGuard: true }), productionDemandRates(rest, opts), "case " + c);
  }
});

// ---------------------------------------------------------------------------
// Defect 4 — the burst guard (dark)
// ---------------------------------------------------------------------------

test("guard on: a 40-account one-day hand sale no longer reads as 40 a week", () => {
  const { fd } = loadFarmDemand(baseWorld());
  const burst = Array.from({ length: 40 }, () => ({ firstAt: ago(2), market: "manual" }));
  const off = fd.demandRates(burst, { now: NOW, burstGuard: false });
  assert.equal(off.otherPerWeek, 40, "production: one day over the 7-day floor of the 14-day window");
  const on = fd.demandRates(burst, { now: NOW, burstGuard: true });
  assert.equal(on.otherPerWeek, 20, "raw over the 14-day window, the shelf rule: 40 × 7 / 14");
  assert.equal(on.burstSales, 40);
  assert.equal(on.sellingDays, 0, "a hand-sale day says nothing about stock-outs");
  // At the feeder's 28-day cover: +86 accounts instead of +166.
  const target = (r) =>
    farmSizing.shelfAwareTarget({ shelfHeld: 0, shelfPerWeek: 0, otherPerWeek: r.otherPerWeek, coverageDays: 28, safetyStock: 6 }).target;
  assert.equal(target(off), 166);
  assert.equal(target(on), 86);
  // A bulk pack is the same lump, whatever claim-at-sale market it sold on.
  const pack = burst.map((u) => ({ ...u, market: "eldorado", pack: true }));
  assert.equal(fd.demandRates(pack, { now: NOW, burstGuard: false }).otherPerWeek, 40);
  assert.equal(fd.demandRates(pack, { now: NOW, burstGuard: true }).otherPerWeek, 20);
  // The steady sales beside a burst keep their in-stock rate: 6 Eldorado sales
  // over 3 days read 6 a week, plus the burst's 20 — not (6 + 40) over 4 days.
  const steady = [3, 3, 5, 5, 9, 9].map((d) => ({ firstAt: ago(d), market: "eldorado" }));
  assert.equal(fd.demandRates(steady.concat(burst), { now: NOW, burstGuard: false }).otherPerWeek, 46);
  assert.equal(fd.demandRates(steady.concat(burst), { now: NOW, burstGuard: true }).otherPerWeek, 26);
});

test("the switch: omitted follows autoFarm.noclaimBurstGuard, read only when there is a burst to guard", () => {
  const w = baseWorld();
  w.af = { noclaimBurstGuard: true };
  const { fd, settings } = loadFarmDemand(w);
  const burst = Array.from({ length: 40 }, () => ({ firstAt: ago(2), market: "manual" }));
  const calm = [{ firstAt: ago(2), market: "eldorado" }];
  let before = settings.reads.getAutoFarm;
  assert.equal(fd.demandRates(calm, { now: NOW }).otherPerWeek, 1);
  assert.equal(settings.reads.getAutoFarm, before, "no burst: settings.json is not read");
  before = settings.reads.getAutoFarm;
  assert.equal(fd.demandRates(burst, { now: NOW }).otherPerWeek, 20, "the switch is on");
  assert.equal(settings.reads.getAutoFarm, before + 1);
  // An explicit choice beats the switch, both ways, without reading it.
  before = settings.reads.getAutoFarm;
  assert.equal(fd.demandRates(burst, { now: NOW, burstGuard: false }).otherPerWeek, 40);
  assert.equal(settings.reads.getAutoFarm, before);
});

test("bulk packs are found through their listing (bulkOfferId), never by market", async () => {
  const { fd, models } = loadFarmDemand(baseWorld());
  const ev = await atNow(() => fd.saleEvidenceByBucket({ days: 30 }));
  const packs = [];
  for (const [bucket, inner] of ev.units) for (const [id, u] of inner) if (u.pack) packs.push(bucket + "/" + id);
  assert.deepEqual(packs, ["rainbow six/r6pk1", "rainbow six/r6pk2", "rainbow six/r6pk3", "rainbow six/r6pk4", "rainbow six/r6pk5"]);
  const r6pk1 = ev.units.get("rainbow six").get("r6pk1");
  assert.equal(r6pk1.market, "eldorado", "a pack keeps the market it sold on");
  assert.equal(fd.isBurstSale(r6pk1), true);
  assert.equal(fd.isBurstSale(ev.units.get("rainbow six").get("r6a")), false, "the same offer's single sale");
  assert.equal(fd.isBurstSale(ev.units.get("rainbow six").get("r6h1")), true, "a hand sale");
  // The ledger read asks for the field the lookup needs, and the lookup is one
  // read over the listings those ledgers name.
  const ledgerRead = models.calls.find((c) => c.model === "UnclaimedAccount" && c.q.status === "sold" && c.q.soldAt);
  assert.equal(ledgerRead.proj.manualListing, 1);
  const lookups = models.calls.filter((c) => c.model === "MarketplaceListing" && "bulkOfferId" in c.q);
  assert.equal(lookups.length, 1);
  assert.deepEqual([...lookups[0].q._id.$in].sort(), [L_ELD, L_G2G, L_PA, L_PACK].sort());
});

test("guard on: hand sales and packs count raw, every other sale keeps its in-stock rate", async () => {
  const on = await snapshotOf(baseWorld(), { burstGuard: true });
  const r6 = rowOf(on, "rainbow six");
  // R6: 5 pack + 5 hand sales raw (10×7/14 = 5 a week), the 4 other sales of
  // the last 14 days over the 7-day floor (4 a week): 9, not 14.
  assert.equal(r6.sales.otherPerWeek, 9);
  assert.equal(r6.sales.burstSales, 10);
  assert.equal(r6.sales.sellingDays, 5);
  assert.equal(r6.target, 46, "production: 66");
  const ow = rowOf(on, "overwatch");
  assert.equal(ow.sales.otherPerWeek, 2.5);
  assert.equal(ow.sales.burstSales, 1);
  assert.equal(ow.target, 22, "production: 24");
  // CoD's hand sale is 29 days old: it moves the 30-day figure only, and the
  // 14-day figure was already the larger, so the rate stands.
  const cod = rowOf(on, "call of duty");
  assert.equal(cod.sales.otherPerWeek, 1);
  assert.equal(cod.target, 10);
  // Shelf rates, stock and evidence are not the guard's business.
  for (const g of GOLDEN.snapshot) {
    const r = rowOf(on, g.key);
    assert.equal(r.sales.shelfPerWeek, g.sales.shelfPerWeek);
    assert.equal(r.sales.count, g.sales.count);
    sameBytes(r.sales.byMarket, g.sales.byMarket);
    sameBytes(r.stock, g.stock);
  }
  // The live switch gives the same rows as the explicit option.
  const w = baseWorld();
  w.af = { noclaimBurstGuard: true };
  sameBytes(await snapshotOf(w), on);
});

test("a failed pack lookup: guard off sizes exactly as before; guard on sizes nothing", async () => {
  const w = baseWorld();
  w.failPackLookup = true;
  sameBytes(await snapshotOf(w), GOLDEN.snapshot, "the lookup only feeds the guard");
  const { fd } = loadFarmDemand(w);
  const ev = await atNow(() => fd.saleEvidenceByBucket({ days: 30 }));
  assert.match(ev.packError, /timed out/);
  // On, a pack it cannot see would be read through the in-stock correction
  // again and the allocator would claim on it: no snapshot, no growth.
  await assert.rejects(snapshotOf(w, { burstGuard: true }), /no-claim demand withheld/);
});
