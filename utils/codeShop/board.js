"use strict";
// Code shop — the Listings board read model (docs/code-shop/08-LISTINGS-BOARD.md).
//
// One read of everything both farms earned and sell, for the "Listings" tab of
// the SOOP and CHZZK panels: per game and campaign what is in stock, on sale
// and sold; per product where it is listed (with the market's link) and what
// each market sold; the newest sales; bundles sold per day.
//
// Read-only, like views.js: every read names the fields it keeps, so a code,
// codeHash, codeShape, codeEnc, unit password or cookie never enters this
// file. Units are counted, never read. Every $group key is a slot, a
// product+market, a sold unit, a login or a day, so memory grows with those,
// not with codes (no allowDiskUse: production Mongo is on a shared tier).

const mongoose = require("mongoose");
const { pickListings } = require("./views");
const { defaultLabel } = require("./texts");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_LEAD_HOURS = 36;
const SOLD_STATES = ["sold", "dead"];
const MARKETS = [
  { id: "eldorado", name: "Eldorado" },
  { id: "playerauctions", name: "PlayerAuctions" },
];
const SOURCES = [
  { id: "soop", name: "SOOP" },
  { id: "chzzk", name: "CHZZK" },
];
const CHZZK_PREFIX = "chzzk:";
const PRODUCT_STATUS_RANK = { active: 0, paused: 1, draft: 2 };
// Twitch box art: read once an hour, at the size a card shows it.
const BOX_ART_TTL_MS = HOUR_MS;
const BOX_ART_SIZE = "285x380";
// Our name -> Twitch's, where they differ beyond case, punctuation and a
// trailing number (normalized on both sides).
const COVER_ALIASES = {
  blacksurvivaleternalreturn: "eternalreturn",
  nexon: "suddenattack",
};
const DAYS_DEFAULT = 14;
const DAYS_MAX = 60;
const SALES_DEFAULT = 80;
const SALES_MAX = 300;
// Both farm panels poll every 30 s; one answer serves every caller for this long.
const MEMO_MS = 15 * 1000;
const MEMO_MAX = 20;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

const str = (v) => (v === undefined || v === null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}
const dateOf = (v) => {
  const ms = toMs(v);
  return ms === null ? null : new Date(ms);
};
const minDate = (a, b) => (!a ? b : !b ? a : a.getTime() <= b.getTime() ? a : b);
const maxDate = (a, b) => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b);

function intIn(v, def, lo, hi) {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || require("../../models/" + name);
}

const isChzzkKey = (key) => /:chzzk-/.test(str(key));
const sourceOfLogin = (loginId) => (str(loginId).startsWith(CHZZK_PREFIX) ? "chzzk" : "soop");
const sourceOfGroup = (groupKey) => (isChzzkKey(groupKey) ? "chzzk" : "soop");

// "12:13787" -> { source: "soop", dropsIdx: "13787" }; "12:chzzk-1954" -> { source: "chzzk", campaignNo: 1954 }.
function campaignRef(groupKey) {
  const g = str(groupKey);
  const idx = g.slice(g.indexOf(":") + 1);
  const m = /^chzzk-(\d+)$/.exec(idx);
  if (m) return { source: "chzzk", campaignNo: Number(m[1]) };
  if (/^\d+$/.test(idx)) return { source: "soop", dropsIdx: idx };
  return { source: sourceOfGroup(g) };
}

// An image URL the page may show: http(s) only (the panels' el() scrubs the
// rest anyway), at most 2 kB.
function imageUrl(v) {
  const s = str(v).trim();
  return /^https?:\/\//i.test(s) && s.length <= 2048 ? s : "";
}

// "Overwatch 2" -> "overwatch2": accents folded, everything but a-z0-9
// dropped. Only for matching Twitch's (English) game names.
function normName(v) {
  return str(v)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// The key two game numbers share when they are one game: letters and digits
// of any script, case and accents folded ("오버워치 2" and "배틀그라운드 2" stay
// apart). A name without a single letter gives "" (never merged).
function mergeKey(v) {
  const k = str(v)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return /\p{L}/u.test(k) ? k : "";
}

// The leading-hours rule views.js uses: a missing or bad value means 36.
function leadHoursOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_HOURS;
}

function toObjectId(v) {
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = str(v);
  return OBJECT_ID_HEX.test(s) ? new mongoose.Types.ObjectId(s) : null;
}

function emptyCounts() {
  return { inStock: 0, onSale: 0, inVault: 0, sold: 0, expiring: 0, expired: 0, held: 0, dead: 0 };
}
function addCounts(into, c) {
  for (const k of Object.keys(into)) into[k] += Number(c && c[k]) || 0;
  return into;
}
function emptyMoney() {
  return { d1: 0, d7: 0, d30: 0, all: 0 };
}
function addMoney(into, m) {
  for (const k of Object.keys(into)) into[k] += Number(m && m[k]) || 0;
  return into;
}
function roundMoney(m) {
  for (const k of Object.keys(m)) m[k] = cents(m[k]);
  return m;
}
const emptyListings = () => ({ live: 0, paused: 0, down: 0, error: 0 });
const emptyFarms = () => ({ soop: { units: 0, usd: 0 }, chzzk: { units: 0, usd: 0 } });
function addFarms(into, f) {
  for (const k of ["soop", "chzzk"]) {
    into[k].units += (f && f[k] && f[k].units) || 0;
    into[k].usd += Number(f && f[k] && f[k].usd) || 0;
  }
  return into;
}
const roundFarms = (f) => ({ soop: { units: f.soop.units, usd: cents(f.soop.usd) }, chzzk: { units: f.chzzk.units, usd: cents(f.chzzk.usd) } });

// A listing row's place on the board: live, paused, error or down.
function listingState(l) {
  const status = str(l && l.status);
  if (status === "active") return l.autoPaused ? "paused" : "live";
  if (status === "error") return "error";
  return "down";
}

// ms -> "YYYY-MM-DD" in a time zone. One formatter per call site, read by
// its parts, so no locale's print order is assumed.
function dayKeyer(tz) {
  let f = null;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    f = null;
  }
  return (ms) => {
    if (f) {
      const p = {};
      for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
      if (/^\d{4}$/.test(p.year || "") && /^\d{2}$/.test(p.month || "") && /^\d{2}$/.test(p.day || "")) return p.year + "-" + p.month + "-" + p.day;
    }
    return new Date(ms).toISOString().slice(0, 10);
  };
}

// A time zone name the page sent, or "UTC" when it is not one this server knows.
function timeZoneOf(v) {
  const s = str(v).trim();
  if (!s || s.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(s)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s }).format(0);
    return s;
  } catch {
    return "UTC";
  }
}

// 1 when a ledger row holds a CHZZK login's code, else 0.
const CHZZK_FLAG = { $cond: [{ $eq: [{ $substrCP: [{ $ifNull: ["$loginId", ""] }, 0, CHZZK_PREFIX.length] }, CHZZK_PREFIX] }, 1, 0] };
// Per-bundle fields (a $group by unit over rows carrying `chzzk`): each farm's
// share of the money, and whether the bundle holds that farm's codes at all.
const PER_FARM = {
  soopUsd: { $sum: { $cond: [{ $eq: ["$chzzk", 1] }, 0, "$saleUsd"] } },
  chzzkUsd: { $sum: { $cond: [{ $eq: ["$chzzk", 1] }, "$saleUsd", 0] } },
  hasSoop: { $max: { $subtract: [1, "$chzzk"] } },
  hasChzzk: { $max: "$chzzk" },
};
// A row's money and bundle count, all farms and per farm.
function farmSplit(r) {
  return {
    soop: { units: r.soopUnits || 0, usd: cents(r.soopUsd) },
    chzzk: { units: r.chzzkUnits || 0, usd: cents(r.chzzkUsd) },
  };
}

// { $sum: 1 when <field> is <value> }
function countWhen(field, value) {
  const test = Array.isArray(value) ? { $in: [field, value] } : { $eq: [field, value] };
  return { $sum: { $cond: [test, 1, 0] } };
}

function createBoard(deps = {}) {
  const now = () => {
    const t = typeof deps.now === "function" ? toMs(deps.now()) : null;
    return t === null ? Date.now() : t;
  };
  const M = (name) => modelOf(deps, name);
  let config = deps.config || null;
  let covers = { at: 0, exact: null, loose: null };

  async function getConfig() {
    if (!config) {
      const { createConfig } = require("./config");
      config = createConfig({ model: deps.models && deps.models.CodeShopConfig, now });
    }
    try {
      const cfg = await config.get();
      if (cfg && typeof cfg === "object") return cfg;
    } catch {
      // config.get() never throws by contract; a test fake might.
    }
    const { DEFAULTS, deepMerge } = require("./config");
    return deepMerge(DEFAULTS, null);
  }

  // --- ledger --------------------------------------------------------------------

  // One row per slot: its counts by state, its revenue, its newest name/picture.
  async function slotRows(t) {
    const isSold = { $in: ["$state", SOLD_STATES] };
    const usdSince = (days) => ({
      $sum: { $cond: [{ $and: [isSold, { $gte: ["$soldAt", new Date(t - days * DAY_MS)] }] }, "$saleUsd", 0] },
    });
    const unitIs = (status) => ({
      $sum: { $cond: [{ $and: [{ $eq: ["$state", "in_unit"] }, { $eq: ["$unitStatus", status] }] }, 1, 0] },
    });
    const notGone = { $in: ["$state", ["in_stock", "in_unit"]] };
    return M("CodeStock").aggregate([
      {
        $project: {
          gameNo: 1,
          gameName: 1,
          groupKey: 1,
          campaignTitle: 1,
          campaignEndAt: 1,
          slotKey: 1,
          nameRaw: 1,
          name: 1,
          image: 1,
          state: 1,
          unitStatus: 1,
          unit: 1,
          useBy: 1,
          soldAt: 1,
          saleUsd: 1,
          updatedAt: 1,
        },
      },
      {
        $group: {
          _id: {
            gameNo: { $ifNull: ["$gameNo", ""] },
            groupKey: { $ifNull: ["$groupKey", ""] },
            slotKey: { $ifNull: ["$slotKey", ""] },
          },
          inStock: countWhen("$state", "in_stock"),
          onSale: unitIs("available"),
          inVault: unitIs("fed"),
          sold: countWhen("$state", "sold"),
          expiring: countWhen("$state", "expiring"),
          expired: countWhen("$state", "expired"),
          held: countWhen("$state", "held"),
          dead: countWhen("$state", "dead"),
          usdAll: { $sum: { $cond: [isSold, "$saleUsd", 0] } },
          usd1: usdSince(1),
          usd7: usdSince(7),
          usd30: usdSince(30),
          // $max / $min skip nulls. A replacement code (sold, no bundle) is
          // handed to an earlier buyer: it is not a sale.
          lastSoldAt: { $max: { $cond: [{ $and: [isSold, { $ne: [{ $ifNull: ["$unit", null] }, null] }] }, "$soldAt", null] } },
          nextUseBy: { $min: { $cond: [notGone, "$useBy", null] } },
          info: {
            $max: {
              at: "$updatedAt",
              id: "$_id",
              gameName: "$gameName",
              campaignTitle: "$campaignTitle",
              campaignEndAt: "$campaignEndAt",
              nameRaw: "$nameRaw",
              name: "$name",
              image: "$image",
            },
          },
        },
      },
    ]);
  }

  // One row per farm login: its counts and revenue (for the per-farm totals).
  async function loginRows(t) {
    const isSold = { $in: ["$state", SOLD_STATES] };
    const usdSince = (days) => ({
      $sum: { $cond: [{ $and: [isSold, { $gte: ["$soldAt", new Date(t - days * DAY_MS)] }] }, "$saleUsd", 0] },
    });
    const unitIs = (status) => ({
      $sum: { $cond: [{ $and: [{ $eq: ["$state", "in_unit"] }, { $eq: ["$unitStatus", status] }] }, 1, 0] },
    });
    return M("CodeStock").aggregate([
      { $project: { loginId: 1, state: 1, unitStatus: 1, saleUsd: 1, soldAt: 1, earnedAt: 1 } },
      {
        $group: {
          _id: "$loginId",
          inStock: countWhen("$state", "in_stock"),
          onSale: unitIs("available"),
          inVault: unitIs("fed"),
          sold: countWhen("$state", "sold"),
          expiring: countWhen("$state", "expiring"),
          expired: countWhen("$state", "expired"),
          held: countWhen("$state", "held"),
          dead: countWhen("$state", "dead"),
          usdAll: { $sum: { $cond: [isSold, "$saleUsd", 0] } },
          usd1: usdSince(1),
          usd7: usdSince(7),
          usd30: usdSince(30),
          lastEarnedAt: { $max: "$earnedAt" },
        },
      },
    ]);
  }

  // Sold bundles per product and market, with 1/7/30-day counts.
  async function soldByProductMarket(t) {
    const since = (days) => new Date(t - days * DAY_MS);
    const unitsSince = (days) => ({ $sum: { $cond: [{ $gte: ["$at", since(days)] }, 1, 0] } });
    const usdSince = (days) => ({ $sum: { $cond: [{ $gte: ["$at", since(days)] }, "$usd", 0] } });
    return M("CodeStock").aggregate([
      { $match: { state: { $in: SOLD_STATES }, unit: { $ne: null } } },
      { $project: { product: 1, market: 1, unit: 1, saleUsd: 1, soldAt: 1, chzzk: CHZZK_FLAG } },
      // One row per bundle first (its product and market as the feed reads
      // them), so a bundle whose rows disagree is still counted once.
      {
        $group: {
          _id: "$unit",
          product: { $max: "$product" },
          market: { $max: "$market" },
          usd: { $sum: "$saleUsd" },
          codes: { $sum: 1 },
          at: { $max: "$soldAt" },
          ...PER_FARM,
        },
      },
      {
        $group: {
          _id: { product: "$product", market: "$market" },
          units: { $sum: 1 },
          codes: { $sum: "$codes" },
          usd: { $sum: "$usd" },
          lastAt: { $max: "$at" },
          soopUnits: { $sum: "$hasSoop" },
          soopUsd: { $sum: "$soopUsd" },
          chzzkUnits: { $sum: "$hasChzzk" },
          chzzkUsd: { $sum: "$chzzkUsd" },
          units1: unitsSince(1),
          units7: unitsSince(7),
          units30: unitsSince(30),
          usd1: usdSince(1),
          usd7: usdSince(7),
          usd30: usdSince(30),
        },
      },
    ]);
  }

  // The newest sold bundles. Grouped first, then sorted with the $limit right
  // behind the $sort, so the server keeps only the top `limit` (top-k sort).
  async function salesRows(limit) {
    return M("CodeStock").aggregate([
      { $match: { state: { $in: SOLD_STATES }, unit: { $ne: null } } },
      {
        $project: {
          unit: 1,
          product: 1,
          market: 1,
          orderId: 1,
          gameNo: 1,
          saleUsd: 1,
          soldAt: 1,
          state: 1,
          chzzk: CHZZK_FLAG,
        },
      },
      {
        $group: {
          _id: "$unit",
          soldAt: { $max: "$soldAt" },
          product: { $max: "$product" },
          market: { $max: "$market" },
          orderId: { $max: "$orderId" },
          gameNo: { $max: "$gameNo" },
          usd: { $sum: "$saleUsd" },
          codes: { $sum: 1 },
          dead: countWhen("$state", "dead"),
          ...PER_FARM,
        },
      },
      { $sort: { soldAt: -1, _id: -1 } },
      { $limit: limit },
    ]);
  }

  // Sold bundles per day (in the viewer's time zone) and market, with each farm's
// bundles (a two-farm bundle counts under both) and share of the money.
  async function dailyRows(t, days, tz) {
    const run = (zone) =>
      M("CodeStock").aggregate([
        { $match: { state: { $in: SOLD_STATES }, unit: { $ne: null }, soldAt: { $gte: new Date(t - (days + 1) * DAY_MS) } } },
        {
          $project: {
            unit: 1,
            market: 1,
            saleUsd: 1,
            soldAt: 1,
            chzzk: CHZZK_FLAG,
          },
        },
        {
          $group: {
            _id: "$unit",
            market: { $max: "$market" },
            usd: { $sum: "$saleUsd" },
            at: { $max: "$soldAt" },
            ...PER_FARM,
          },
        },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: zone } },
              market: "$market",
            },
            units: { $sum: 1 },
            usd: { $sum: "$usd" },
            soopUnits: { $sum: "$hasSoop" },
            soopUsd: { $sum: "$soopUsd" },
            chzzkUnits: { $sum: "$hasChzzk" },
            chzzkUsd: { $sum: "$chzzkUsd" },
          },
        },
      ]);
    try {
      return { tz, rows: await run(tz) };
    } catch (err) {
      // A zone this Mongo does not know: count in UTC rather than fail the board.
      if (tz === "UTC") throw err;
      return { tz: "UTC", rows: await run("UTC") };
    }
  }

  // --- products, units, listings ---------------------------------------------------

  async function productRows(soldIds) {
    const q = soldIds.length ? { $or: [{ status: { $ne: "retired" } }, { _id: { $in: soldIds } }] } : { status: { $ne: "retired" } };
    return M("CodeProduct")
      .find(q, {
        name: 1,
        gameNo: 1,
        gameName: 1,
        marketGame: 1,
        groupKeys: 1,
        "slots.slotKey": 1,
        "slots.label": 1,
        "slots.image": 1,
        "slots.nameRaw": 1,
        status: 1,
        origin: 1,
        kind: 1,
        offer: 1,
        "texts.title": 1,
        "pricing.priceUsd": 1,
        markets: 1,
        useBy: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean();
  }

  async function unitsAndListings(offerIds) {
    if (!offerIds.length) return { units: new Map(), listings: new Map() };
    const [unitRows, listingRows] = await Promise.all([
      M("SuppliedAccount").aggregate([
        { $match: { offer: { $in: offerIds } } },
        { $group: { _id: { offer: "$offer", status: "$status" }, n: { $sum: 1 } } },
      ]),
      M("MarketplaceListing").aggregate([
        { $match: { accountOffer: { $in: offerIds } } },
        {
          $project: {
            accountOffer: 1,
            marketplace: 1,
            externalId: 1,
            url: 1,
            price: 1,
            status: 1,
            autoPaused: 1,
            lastError: 1,
            createdAt: 1,
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
      ]),
    ]);
    const units = new Map();
    for (const r of unitRows) {
      const key = str(r._id && r._id.offer);
      if (!units.has(key)) units.set(key, { available: 0, fed: 0, sold: 0, removed: 0 });
      const status = str(r._id && r._id.status);
      if (hasOwn(units.get(key), status)) units.get(key)[status] += r.n || 0;
    }
    const listings = new Map();
    for (const r of listingRows) {
      const key = str(r.accountOffer);
      if (!listings.has(key)) listings.set(key, []);
      listings.get(key).push(r);
    }
    return { units, listings };
  }

  // --- pictures ---------------------------------------------------------------------

  // groupKeys -> Map(groupKey -> { banner, startAt, endAt }) from both farms' campaigns.
  async function campaignArt(groupKeys) {
    const soop = [];
    const chzzk = [];
    for (const g of groupKeys) {
      const ref = campaignRef(g);
      if (ref.dropsIdx) soop.push(ref.dropsIdx);
      else if (ref.campaignNo) chzzk.push(ref.campaignNo);
    }
    const out = new Map();
    let soopRows = [];
    let chzzkRows = [];
    try {
      [soopRows, chzzkRows] = await Promise.all([
        soop.length
          ? M("SoopCampaign").find({ dropsIdx: { $in: soop } }, { _id: 0, dropsIdx: 1, image: 1, startDate: 1, endDate: 1 }).lean()
          : [],
        chzzk.length
          ? M("ChzzkCampaign").find({ campaignNo: { $in: chzzk } }, { _id: 0, campaignNo: 1, imageUrl: 1, startAt: 1, endAt: 1 }).lean()
          : [],
      ]);
    } catch {
      // pictures and dates only: the board goes out without them
      return out;
    }
    const soopBy = new Map(arr(soopRows).map((c) => [str(c.dropsIdx), c]));
    const chzzkBy = new Map(arr(chzzkRows).map((c) => [Number(c.campaignNo), c]));
    for (const g of groupKeys) {
      const ref = campaignRef(g);
      if (ref.dropsIdx && soopBy.has(ref.dropsIdx)) {
        const c = soopBy.get(ref.dropsIdx);
        out.set(g, { banner: imageUrl(c.image), startAt: dateOf(c.startDate), endAt: dateOf(c.endDate) });
      } else if (ref.campaignNo && chzzkBy.has(ref.campaignNo)) {
        const c = chzzkBy.get(ref.campaignNo);
        out.set(g, { banner: imageUrl(c.imageUrl), startAt: dateOf(c.startAt), endAt: dateOf(c.endAt) });
      }
    }
    return out;
  }

  // Twitch box art by game name, read at most once an hour. Cosmetic: a read
  // that fails leaves every cover blank and never fails the board.
  async function coverMaps() {
    const t = now();
    if (covers.exact && t - covers.at < BOX_ART_TTL_MS) return covers;
    const exact = new Map();
    const loose = new Map();
    try {
      const rows = await M("TwitchCampaign").aggregate([
        { $match: { boxArt: { $gt: "" }, game: { $gt: "" } } },
        { $project: { game: 1, boxArt: 1 } },
        { $group: { _id: "$game", boxArt: { $max: "$boxArt" } } },
      ]);
      for (const r of rows) {
        const url = imageUrl(str(r.boxArt).replace("{width}x{height}", BOX_ART_SIZE));
        const key = normName(r._id);
        if (!url || !key) continue;
        if (!exact.has(key)) exact.set(key, url);
        const bare = key.replace(/\d+$/, "");
        if (bare && !loose.has(bare)) loose.set(bare, url);
      }
    } catch {
      // keep the empty maps; tried again in an hour
    }
    covers = { at: t, exact, loose };
    return covers;
  }

  function coverFor(names, maps) {
    const keys = [];
    for (const n of names) {
      const k = normName(n);
      if (k && !keys.includes(k)) keys.push(k);
    }
    for (const k of keys) {
      const alias = COVER_ALIASES[k];
      if (maps.exact.has(k)) return maps.exact.get(k);
      if (alias && maps.exact.has(alias)) return maps.exact.get(alias);
    }
    for (const k of keys) {
      const bare = k.replace(/\d+$/, "");
      if (bare && maps.exact.has(bare)) return maps.exact.get(bare);
      if (bare && maps.loose.has(bare)) return maps.loose.get(bare);
    }
    return "";
  }

  // --- the board ----------------------------------------------------------------------

  // One answer per (days, sales, zone) for MEMO_MS: both panels and every open
  // browser tab poll this, and a read in flight is shared, never repeated.
  const memo = new Map();
  function build({ days, sales, tz } = {}) {
    const nDays = intIn(days, DAYS_DEFAULT, 1, DAYS_MAX);
    const nSales = intIn(sales, SALES_DEFAULT, 1, SALES_MAX);
    const zone = timeZoneOf(tz);
    const key = nDays + "|" + nSales + "|" + zone;
    const t = now();
    const hit = memo.get(key);
    if (hit && t >= hit.at && t - hit.at < MEMO_MS) return hit.promise;
    const promise = compute(t, nDays, nSales, zone);
    memo.set(key, { at: t, promise });
    promise.catch(() => {
      if (memo.get(key) && memo.get(key).promise === promise) memo.delete(key);
    });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return promise;
  }

  async function compute(t, nDays, nSales, zone) {
    const cfg = await getConfig();

    const [slots, logins, soldPM, saleGroups, daily, coverMap] = await Promise.all([
      slotRows(t),
      loginRows(t),
      soldByProductMarket(t),
      salesRows(nSales),
      dailyRows(t, nDays, zone),
      coverMaps(),
    ]);

    // Products: every live one, plus retired ones that sold something.
    const soldIds = [];
    const seenSold = new Set();
    for (const id of [...soldPM.map((r) => r._id && r._id.product), ...saleGroups.map((r) => r.product)]) {
      const oid = toObjectId(id);
      if (oid && !seenSold.has(String(oid))) {
        seenSold.add(String(oid));
        soldIds.push(oid);
      }
    }
    const products = await productRows(soldIds);
    const offerIds = [];
    const seenOffer = new Set();
    for (const p of products) {
      if (p.offer && !seenOffer.has(String(p.offer))) {
        seenOffer.add(String(p.offer));
        offerIds.push(p.offer);
      }
    }
    const { units, listings } = await unitsAndListings(offerIds);

    // slotKey -> the label a live product prints for it (active, then paused,
    // then draft; the newest wins a tie; a blank label never wins).
    const labelBest = new Map();
    for (const p of products) {
      if (!hasOwn(PRODUCT_STATUS_RANK, p.status)) continue;
      const rank = PRODUCT_STATUS_RANK[p.status];
      const at = toMs(p.updatedAt) || 0;
      for (const s of arr(p.slots)) {
        const key = str(s && s.slotKey);
        const label = str(s && s.label).trim();
        if (!key || !label) continue;
        const cur = labelBest.get(key);
        if (!cur || rank < cur.rank || (rank === cur.rank && at > cur.at)) labelBest.set(key, { label, rank, at });
      }
    }
    const sourceWords = Array.isArray(cfg.sourceWords) ? cfg.sourceWords : undefined;
    const labelOf = (slotKey, info) =>
      (labelBest.get(str(slotKey)) || {}).label || defaultLabel(info || {}, { sourceWords }) || str(info && info.name) || str(info && info.nameRaw);

    // --- games and campaigns from the ledger ---
    const games = new Map(); // gameNo -> game
    const gameOf = (gameNo) => {
      const key = str(gameNo);
      if (!games.has(key)) {
        games.set(key, {
          gameNo: key,
          ledgerName: "",
          ledgerNameAt: -1,
          names: new Set(),
          campaigns: new Map(),
          codes: emptyCounts(),
          revenue: emptyMoney(),
          lastSoldAt: null,
          nextUseBy: null,
          products: [],
          productName: "",
          marketGame: "",
        });
      }
      return games.get(key);
    };
    const totalsCodes = emptyCounts();
    const totalsRevenue = emptyMoney();
    // slotKey -> the ledger's newest picture (the slot row's newest code names it).
    const slotImage = new Map();

    for (const r of slots) {
      const id = r._id || {};
      const info = r.info || {};
      const g = gameOf(id.gameNo);
      const at = toMs(info.at) || 0;
      const gameName = str(info.gameName);
      if (gameName) g.names.add(gameName);
      if (gameName && at > g.ledgerNameAt) {
        g.ledgerName = gameName;
        g.ledgerNameAt = at;
      }
      const groupKey = str(id.groupKey);
      if (!g.campaigns.has(groupKey)) {
        g.campaigns.set(groupKey, {
          groupKey,
          source: sourceOfGroup(groupKey),
          title: "",
          titleAt: -1,
          endAtLedger: null,
          codes: emptyCounts(),
          revenue: emptyMoney(),
          lastSoldAt: null,
          nextUseBy: null,
          rewards: [],
        });
      }
      const c = g.campaigns.get(groupKey);
      if (at > c.titleAt) {
        c.title = str(info.campaignTitle);
        c.endAtLedger = dateOf(info.campaignEndAt);
        c.titleAt = at;
      }
      const counts = {
        inStock: r.inStock || 0,
        onSale: r.onSale || 0,
        inVault: r.inVault || 0,
        sold: r.sold || 0,
        expiring: r.expiring || 0,
        expired: r.expired || 0,
        held: r.held || 0,
        dead: r.dead || 0,
      };
      const money = { d1: r.usd1 || 0, d7: r.usd7 || 0, d30: r.usd30 || 0, all: r.usdAll || 0 };
      const lastSoldAt = dateOf(r.lastSoldAt);
      const nextUseBy = dateOf(r.nextUseBy);
      if (imageUrl(info.image) && !slotImage.has(str(id.slotKey))) slotImage.set(str(id.slotKey), imageUrl(info.image));
      c.rewards.push({
        slotKey: str(id.slotKey),
        label: labelOf(id.slotKey, info),
        nameRaw: str(info.nameRaw),
        image: imageUrl(info.image),
        codes: counts,
        nextUseBy,
      });
      addCounts(c.codes, counts);
      addMoney(c.revenue, money);
      c.lastSoldAt = maxDate(c.lastSoldAt, lastSoldAt);
      c.nextUseBy = minDate(c.nextUseBy, nextUseBy);
      addCounts(g.codes, counts);
      addMoney(g.revenue, money);
      g.lastSoldAt = maxDate(g.lastSoldAt, lastSoldAt);
      g.nextUseBy = minDate(g.nextUseBy, nextUseBy);
      addCounts(totalsCodes, counts);
      addMoney(totalsRevenue, money);
    }

    // --- products ---
    const soldBy = new Map(); // productId -> { units, codes, usd, lastAt, byMarket }
    const marketSold = new Map(MARKETS.map((m) => [m.id, { units: 0, codes: 0, usd: 0, lastAt: null, d1: { units: 0, usd: 0 }, d7: { units: 0, usd: 0 }, d30: { units: 0, usd: 0 } }]));
    const salesCount = emptyMoney();
    for (const r of soldPM) {
      const pid = str(r._id && r._id.product);
      const market = str(r._id && r._id.market);
      const lastAt = dateOf(r.lastAt);
      if (pid) {
        if (!soldBy.has(pid)) soldBy.set(pid, { units: 0, codes: 0, usd: 0, lastAt: null, byMarket: {}, bySource: emptyFarms() });
        const s = soldBy.get(pid);
        const split = farmSplit(r);
        s.units += r.units || 0;
        s.codes += r.codes || 0;
        s.usd += Number(r.usd) || 0;
        s.lastAt = maxDate(s.lastAt, lastAt);
        addFarms(s.bySource, split);
        const key = market || "unknown";
        if (!s.byMarket[key]) s.byMarket[key] = { units: 0, usd: 0, lastAt: null, bySource: emptyFarms() };
        s.byMarket[key].units += r.units || 0;
        s.byMarket[key].usd += Number(r.usd) || 0;
        s.byMarket[key].lastAt = maxDate(s.byMarket[key].lastAt, lastAt);
        addFarms(s.byMarket[key].bySource, split);
      }
      if (marketSold.has(market)) {
        const m = marketSold.get(market);
        m.units += r.units || 0;
        m.codes += r.codes || 0;
        m.usd += Number(r.usd) || 0;
        m.lastAt = maxDate(m.lastAt, lastAt);
        m.d1.units += r.units1 || 0;
        m.d1.usd += Number(r.usd1) || 0;
        m.d7.units += r.units7 || 0;
        m.d7.usd += Number(r.usd7) || 0;
        m.d30.units += r.units30 || 0;
        m.d30.usd += Number(r.usd30) || 0;
      }
      salesCount.all += r.units || 0;
      salesCount.d1 += r.units1 || 0;
      salesCount.d7 += r.units7 || 0;
      salesCount.d30 += r.units30 || 0;
    }

    const totalsUnits = { available: 0, fed: 0, sold: 0 };
    const totalsListings = emptyListings();
    const marketListings = new Map(MARKETS.map((m) => [m.id, emptyListings()]));
    const marketOnSale = new Map(MARKETS.map((m) => [m.id, 0]));
    const productViews = [];
    for (const p of products) {
      const id = String(p._id);
      const offerKey = p.offer ? String(p.offer) : "";
      const u = { available: 0, fed: 0, sold: 0, removed: 0, ...(offerKey && units.get(offerKey)) };
      const ls = offerKey
        ? pickListings(listings.get(offerKey) || []).map((l) => ({ ...l, url: imageUrl(l.url), state: listingState(l) }))
        : [];
      const groupKeys = arr(p.groupKeys).map(str);
      const keysForSource = groupKeys.length ? groupKeys : arr(p.slots).map((s) => str(s && s.slotKey));
      const srcs = SOURCES.map((s) => s.id).filter((s) => keysForSource.some((k) => sourceOfGroup(k) === s));
      const s = soldBy.get(id) || { units: 0, codes: 0, usd: 0, lastAt: null, byMarket: {}, bySource: emptyFarms() };
      const byMarket = {};
      for (const [m, v] of Object.entries(s.byMarket)) {
        byMarket[m] = { units: v.units, usd: cents(v.usd), lastAt: v.lastAt, bySource: roundFarms(v.bySource) };
      }
      productViews.push({
        id,
        name: str(p.name),
        title: str(p.texts && p.texts.title),
        status: str(p.status),
        kind: str(p.kind),
        origin: str(p.origin),
        gameNo: str(p.gameNo),
        sources: srcs.length ? srcs : ["soop"],
        groupKeys,
        rewards: arr(p.slots).map((x) => ({
          slotKey: str(x && x.slotKey),
          label: str(x && x.label) || str(x && x.nameRaw),
          // The ledger's newest picture first: a farm can re-host its pictures
          // and leave the one saved on an older product dead.
          image: slotImage.get(str(x && x.slotKey)) || imageUrl(x && x.image),
        })),
        priceUsd: finiteOr(p.pricing && p.pricing.priceUsd, null),
        useBy: dateOf(p.useBy),
        markets: arr(p.markets).map(str),
        units: u,
        listings: ls,
        sold: { units: s.units, codes: s.codes, usd: cents(s.usd), lastAt: s.lastAt, byMarket, bySource: roundFarms(s.bySource) },
        createdAt: dateOf(p.createdAt),
      });
      if (p.status !== "retired") {
        totalsUnits.available += u.available;
        totalsUnits.fed += u.fed;
      }
      totalsUnits.sold += u.sold;
      const liveOn = new Set();
      for (const l of ls) {
        totalsListings[l.state] += 1;
        if (marketListings.has(l.market)) marketListings.get(l.market)[l.state] += 1;
        if (l.state === "live") liveOn.add(l.market);
      }
      if (p.status === "active") {
        for (const m of liveOn) if (marketOnSale.has(m)) marketOnSale.set(m, marketOnSale.get(m) + u.available);
      }
      const g = gameOf(p.gameNo);
      g.products.push(id);
      if (!g.productName && str(p.gameName)) g.productName = str(p.gameName);
      if (!g.marketGame && str(p.marketGame)) g.marketGame = str(p.marketGame);
      if (str(p.gameName)) g.names.add(str(p.gameName));
    }
    productViews.sort(
      (a, b) =>
        (PRODUCT_STATUS_RANK[a.status] ?? 9) - (PRODUCT_STATUS_RANK[b.status] ?? 9) ||
        cmpStr(a.name, b.name) ||
        cmpStr(a.id, b.id),
    );

    // --- pictures ---
    const allGroupKeys = [];
    for (const g of games.values()) for (const k of g.campaigns.keys()) allGroupKeys.push(k);
    const art = await campaignArt(allGroupKeys);

    const gameCfg = (gameNo) => (cfg.games && hasOwn(cfg.games, gameNo) && cfg.games[gameNo]) || null;
    // Named in the settings: its own switch. Never named: the planner adds it
    // by itself the first time it has a bundle when sellNewGames is on.
    const sellsGame = (gameNo) => {
      const gc = gameCfg(gameNo);
      return gc ? gc.sell === true : cfg.sellNewGames === true;
    };
    const gameViews = [];
    for (const g of games.values()) {
      const gc = gameCfg(g.gameNo) || {};
      const displayName = str(gc.displayName);
      const name = displayName || g.ledgerName || g.productName || (g.gameNo ? "Game #" + g.gameNo : "Other");
      const campaigns = [...g.campaigns.values()].map((c) => {
        const a = art.get(c.groupKey) || {};
        return {
          groupKey: c.groupKey,
          source: c.source,
          title: c.title,
          banner: a.banner || "",
          startAt: a.startAt || null,
          endAt: a.endAt || c.endAtLedger || null,
          codes: c.codes,
          revenue: roundMoney(c.revenue),
          lastSoldAt: c.lastSoldAt,
          nextUseBy: c.nextUseBy,
          rewards: c.rewards.sort((x, y) => cmpStr(x.label, y.label) || cmpStr(x.slotKey, y.slotKey)),
        };
      });
      // Newest campaign first; one without an end date last.
      const endMs = (c) => (c.endAt ? c.endAt.getTime() : -Infinity);
      campaigns.sort((a, b) => endMs(b) - endMs(a) || cmpStr(a.groupKey, b.groupKey));
      const banner = (campaigns.find((c) => c.banner) || {}).banner || "";
      const sources = SOURCES.map((s) => s.id).filter((s) => campaigns.some((c) => c.source === s));
      const nameList = [displayName, str(gc.marketGame), g.marketGame, ...g.names, g.productName].filter(Boolean);
      gameViews.push({
        gameNo: g.gameNo,
        name,
        cover: coverFor(nameList, coverMap),
        banner,
        sell: sellsGame(g.gameNo),
        sources,
        codes: g.codes,
        revenue: roundMoney(g.revenue),
        lastSoldAt: g.lastSoldAt,
        nextUseBy: g.nextUseBy,
        products: g.products,
        campaigns,
      });
    }
    gameViews.sort((a, b) => cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) || cmpStr(a.gameNo, b.gameNo));

    // Two farms can file one game under two numbers (CHZZK's Black Survival
    // Eternal Return and SOOP's Eternal Return are both "Eternal Return" in
    // the settings): one card per name, keyed by the name. `gameNo` is the
    // number holding the most codes; `gameNos` lists them all.
    const total = (c) => Object.values(c).reduce((n, v) => n + v, 0);
    const endMsOf = (c) => (c.endAt ? c.endAt.getTime() : -Infinity);
    const merged = new Map();
    const primaryTotal = new Map(); // card key -> codes of its current gameNo alone
    for (const g of gameViews) {
      const key = mergeKey(g.name) || "game" + g.gameNo;
      const cur = merged.get(key);
      const off = g.sell ? [] : [g.gameNo];
      if (!cur) {
        merged.set(key, { ...g, key, gameNos: [g.gameNo], sellOff: off, codes: { ...g.codes }, revenue: { ...g.revenue } });
        primaryTotal.set(key, total(g.codes));
        continue;
      }
      if (total(g.codes) > primaryTotal.get(key)) {
        cur.gameNo = g.gameNo;
        primaryTotal.set(key, total(g.codes));
      }
      cur.gameNos.push(g.gameNo);
      cur.sellOff.push(...off);
      cur.campaigns = cur.campaigns.concat(g.campaigns).sort((a, b) => endMsOf(b) - endMsOf(a) || cmpStr(a.groupKey, b.groupKey));
      addCounts(cur.codes, g.codes);
      roundMoney(addMoney(cur.revenue, g.revenue));
      cur.lastSoldAt = maxDate(cur.lastSoldAt, g.lastSoldAt);
      cur.nextUseBy = minDate(cur.nextUseBy, g.nextUseBy);
      cur.products = cur.products.concat(g.products);
      cur.sources = SOURCES.map((s) => s.id).filter((s) => cur.sources.includes(s) || g.sources.includes(s));
      cur.cover = cur.cover || g.cover;
      cur.banner = (cur.campaigns.find((c) => c.banner) || {}).banner || "";
    }
    const cards = [...merged.values()].map((g) => ({ ...g, sell: g.sellOff.length === 0 }));

    // --- per farm ---
    const bySource = new Map(SOURCES.map((s) => [s.id, { logins: 0, codes: emptyCounts(), revenue: emptyMoney(), lastEarnedAt: null }]));
    for (const r of logins) {
      const s = bySource.get(sourceOfLogin(r._id));
      s.logins += 1;
      addCounts(s.codes, r);
      addMoney(s.revenue, { d1: r.usd1, d7: r.usd7, d30: r.usd30, all: r.usdAll });
      s.lastEarnedAt = maxDate(s.lastEarnedAt, dateOf(r.lastEarnedAt));
    }

    // --- sales feed ---
    const productById = new Map(productViews.map((p) => [p.id, p]));
    const salesView = saleGroups.map((r) => {
      const pid = r.product ? String(r.product) : "";
      const p = productById.get(pid) || null;
      const srcs = [];
      if (r.hasSoop) srcs.push("soop");
      if (r.hasChzzk) srcs.push("chzzk");
      return {
        id: String(r._id),
        product: pid || null,
        productName: p ? p.name : "",
        gameNo: p ? p.gameNo : str(r.gameNo),
        market: str(r.market),
        orderId: str(r.orderId),
        soldAt: dateOf(r.soldAt),
        usd: cents(r.usd),
        codes: r.codes || 0,
        dead: r.dead || 0,
        sources: srcs,
        bySource: { soop: { usd: cents(r.soopUsd) }, chzzk: { usd: cents(r.chzzkUsd) } },
      };
    });

    // --- per day (the viewer's zone) ---
    const dayKeys = [];
    const dayKeyOf = dayKeyer(daily.tz);
    for (let back = 0; dayKeys.length < nDays && back <= (nDays + 2) * 2; back++) {
      const key = dayKeyOf(t - back * 12 * HOUR_MS);
      if (!dayKeys.includes(key)) dayKeys.push(key);
    }
    dayKeys.reverse();
    const dayMap = new Map(dayKeys.map((k) => [k, []]));
    for (const r of daily.rows) {
      const id = r._id || {};
      const rows = dayMap.get(str(id.day));
      if (!rows) continue;
      rows.push({ market: str(id.market), units: r.units || 0, usd: cents(r.usd), ...farmSplit(r) });
    }
    for (const rows of dayMap.values()) rows.sort((a, b) => cmpStr(a.market, b.market));

    return {
      now: new Date(t),
      tz: daily.tz,
      config: {
        markets: { eldorado: !!(cfg.markets && cfg.markets.eldorado === true), playerauctions: !!(cfg.markets && cfg.markets.playerauctions === true) },
        autoPublish: cfg.autoPublish === true,
        expiryLeadHours: leadHoursOf(cfg.expiryLeadHours),
      },
      totals: {
        codes: totalsCodes,
        units: totalsUnits,
        listings: totalsListings,
        revenue: roundMoney(totalsRevenue),
        salesCount,
      },
      sources: SOURCES.map((s) => {
        const v = bySource.get(s.id);
        return { id: s.id, name: s.name, logins: v.logins, codes: v.codes, revenue: roundMoney(v.revenue), lastEarnedAt: v.lastEarnedAt };
      }),
      markets: MARKETS.map((m) => {
        const s = marketSold.get(m.id);
        return {
          id: m.id,
          name: m.name,
          on: !!(cfg.markets && cfg.markets[m.id] === true),
          listings: marketListings.get(m.id),
          unitsOnSale: marketOnSale.get(m.id),
          sold: {
            units: s.units,
            codes: s.codes,
            usd: cents(s.usd),
            lastAt: s.lastAt,
            d1: { units: s.d1.units, usd: cents(s.d1.usd) },
            d7: { units: s.d7.units, usd: cents(s.d7.usd) },
            d30: { units: s.d30.units, usd: cents(s.d30.usd) },
          },
        };
      }),
      games: cards,
      products: productViews,
      sales: salesView,
      daily: dayKeys.map((day) => ({ day, rows: dayMap.get(day) })),
    };
  }

  return { build };
}

module.exports = {
  createBoard,
  // for tests
  normName,
  mergeKey,
  campaignRef,
  listingState,
  timeZoneOf,
  imageUrl,
  intIn,
  DAYS_DEFAULT,
  DAYS_MAX,
  SALES_DEFAULT,
  SALES_MAX,
};
