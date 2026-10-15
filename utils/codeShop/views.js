"use strict";
// Code shop read models for the "Sales" panel (docs/code-shop/04-OPS.md,
// "views.js"). Read-only: nothing here writes.
//
// Every view is plain JSON built from a whitelist of fields. A view never holds
// a code, a codeHash, an inventory codeEnc or a unit password: the ledger is
// read only through projections / $group stages that name the fields they
// keep, units are only ever COUNTED (never read), and SoopAccount is read for
// its nickname alone (its cookies stay where they are).
//
// Counting is done in Mongo with $group stages that hold one small entry per
// state / slot / login (no $sort over the ledger, no allowDiskUse), so the
// memory a view needs grows with the number of slots and logins, not codes.

const mongoose = require("mongoose");
const { checkBuyerText } = require("./textGuard");
const { defaultLabel } = require("./texts");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_LEAD_HOURS = 36;
// allocate.planUnits' default maxUnitsPerProduct: fill never builds more than
// this many units for one product in one run, so "could build now" stops there.
const MAX_UNITS_PER_PRODUCT = 200;
// The held list is for a person to read; the summary carries the full count.
const HELD_LIMIT = 500;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const ObjectId = mongoose.Types.ObjectId;

const STATES = ["in_stock", "in_unit", "sold", "expiring", "expired", "held", "dead"];
const UNIT_STATUSES = ["available", "fed", "sold", "removed"];
const SOLD_STATES = ["sold", "dead"];
const STATUS_RANK = { draft: 0, active: 1, paused: 2, retired: 3 };
// Which product's label names a slot in the stock view when several do.
const LABEL_RANK = { active: 0, paused: 1, draft: 2 };

const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
  MarketplaceListing: () => require("../../models/MarketplaceListing"),
  SoopAccount: () => require("../../models/SoopAccount"),
};

// The product fields every view reads. Competitor offers are summarised in
// Mongo for the list (only the product page carries them in full).
const PRODUCT_FIELDS = {
  name: 1,
  gameNo: 1,
  gameName: 1,
  marketGame: 1,
  slots: 1,
  status: 1,
  origin: 1,
  kind: 1,
  stale: 1,
  edited: 1,
  offer: 1,
  texts: 1,
  pricing: 1,
  markets: 1,
  publish: 1,
  useBy: 1,
  proposed: 1,
  createdAt: 1,
  competitorCount: {
    $cond: [{ $isArray: "$competitors.offers" }, { $size: "$competitors.offers" }, 0],
  },
};

const str = (v) => (v === undefined || v === null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const dateOr = (v) => (v instanceof Date && Number.isFinite(v.getTime()) ? v : null);
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

function toObjectId(v) {
  const raw = v && typeof v === "object" && v._id ? v._id : v;
  if (raw instanceof ObjectId) return raw;
  const s = str(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

// Same fallback as fill.js: a missing or unreadable lead is the default, never
// 0 (0 would count codes that are about to stop working).
function leadHoursOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_HOURS;
}

function notFound(id) {
  const err = new Error("Code shop product not found: " + str(id).slice(0, 64));
  err.status = 404;
  return err;
}

// { $sum: 1 when <field> is <value> (or one of <values>) }
function countWhen(field, value) {
  const test = Array.isArray(value) ? { $in: [field, value] } : { $eq: [field, value] };
  return { $sum: { $cond: [test, 1, 0] } };
}

// The units "fill" could build for ONE product from free codes, given how many
// usable free codes each slot has: the same answer allocate.planUnits gives for
// that product alone (a slot listed twice needs two codes per unit; a product
// without slots, or with a blank slot key, builds nothing).
function freeUnitsFor(slots, freeBySlot) {
  const keys = arr(slots).map((s) => str(s && s.slotKey));
  if (!keys.length) return 0;
  const need = new Map();
  for (const k of keys) need.set(k, (need.get(k) || 0) + 1);
  let n = MAX_UNITS_PER_PRODUCT;
  for (const [k, per] of need) n = Math.min(n, Math.floor((k ? freeBySlot.get(k) || 0 : 0) / per));
  return n;
}

// The buyer-text problems the publisher would raise, for when no publisher is
// injected: no slots, then textGuard on the texts and the slot labels.
function defaultProblems(product, cfg) {
  const slots = arr(product && product.slots);
  const out = [];
  if (!slots.length) out.push("no slots: the bundle holds no codes");
  const t = (product && product.texts) || {};
  out.push(
    ...checkBuyerText(
      {
        title: t.title,
        description: t.description,
        deliveryTemplate: t.deliveryTemplate,
        coverTitle: t.coverTitle,
        coverServiceText: t.coverServiceText,
        coverBullets: t.coverBullets,
        labels: slots.map((s) => str(s && s.label)),
      },
      { sourceWords: cfg && cfg.sourceWords },
    ),
  );
  return out;
}

function slotView(s) {
  const x = s || {};
  return { slotKey: str(x.slotKey), label: str(x.label), image: str(x.image), nameRaw: str(x.nameRaw) };
}

function pricingView(pr) {
  const p = pr || {};
  return {
    mode: p.mode === "auto" ? "auto" : "fixed",
    priceUsd: finiteOr(p.priceUsd, null),
    floorUsd: finiteOr(p.floorUsd, null),
    clearance: p.clearance === true,
    followCompetitors: p.followCompetitors === true,
    lastChangeAt: dateOr(p.lastChangeAt),
    lastReason: str(p.lastReason),
  };
}

function textsView(t) {
  const x = t || {};
  return {
    title: str(x.title),
    description: str(x.description),
    deliveryTemplate: str(x.deliveryTemplate),
    coverTitle: str(x.coverTitle),
    coverServiceText: str(x.coverServiceText),
    coverBullets: arr(x.coverBullets).map(str),
  };
}

function listingView(r) {
  return {
    market: str(r.marketplace),
    externalId: str(r.externalId),
    url: str(r.url),
    price: finiteOr(r.price, 0),
    status: str(r.status),
    autoPaused: r.autoPaused === true,
    lastError: str(r.lastError),
  };
}

// One offer's listing rows (newest first) -> what the product card shows: every
// live row, and for a market with no live row only its newest row (so a market
// that was taken down says so once, not once per pause/resume).
function pickListings(rows) {
  const byMarket = new Map();
  for (const r of rows) {
    const m = str(r.marketplace);
    if (!byMarket.has(m)) byMarket.set(m, []);
    byMarket.get(m).push(r);
  }
  const out = [];
  for (const m of [...byMarket.keys()].sort(cmpStr)) {
    const list = byMarket.get(m);
    const live = list.filter((r) => r.status === "active");
    out.push(...(live.length ? live : list.slice(0, 1)));
  }
  return out.map(listingView);
}

function competitorOfferView(o) {
  const x = o || {};
  return {
    id: str(x.id),
    title: str(x.title),
    priceUsd: finiteOr(x.priceUsd, 0),
    qty: finiteOr(x.qty, 0),
    score: finiteOr(x.score, 0),
    sameSet: x.sameSet === true,
  };
}

function createViews(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const M = (name) => modelOf(deps, name);
  let config = deps.config || null;

  async function getConfig() {
    if (!config) {
      const { createConfig } = require("./config");
      config = createConfig({ model: deps.models && deps.models.CodeShopConfig, now });
    }
    try {
      return (await config.get()) || {};
    } catch {
      // config.get() never throws by contract; a test fake might.
      return require("./config").deepMerge(require("./config").DEFAULTS, null);
    }
  }

  async function problemsOf(product, cfg) {
    if (typeof deps.problems === "function") {
      try {
        const found = await deps.problems(product);
        return arr(found).map(str);
      } catch (err) {
        // Unknown is not "fine": the panel must not show a product as ready.
        return ["could not check this product: " + str((err && err.message) || err).slice(0, 200)];
      }
    }
    return defaultProblems(product, cfg);
  }

  async function extrasOf() {
    let x = null;
    if (typeof deps.extras === "function") {
      try {
        x = await deps.extras();
      } catch {
        x = null;
      }
    }
    const adoptable = Number(x && x.adoptable);
    return {
      adoptable: Number.isFinite(adoptable) && adoptable > 0 ? Math.floor(adoptable) : 0,
      lastTick: x && x.lastTick !== undefined ? x.lastTick : null,
    };
  }

  // --- products ---------------------------------------------------------------

  function productPipeline(match, { full = false } = {}) {
    const $project = { ...PRODUCT_FIELDS };
    if (full) $project.competitors = 1;
    else {
      $project["competitors.scannedAt"] = 1;
      $project["competitors.lowestSameSetUsd"] = 1;
    }
    return [{ $match: match }, { $project }];
  }

  // Usable free codes per slot, as fill.js picks them: in stock, with a hash
  // (fill only builds those), not inside the expiry lead, and not held by a
  // farm login that was sold (fill never builds from those).
  async function freeBySlot(slotKeys, cfg) {
    const out = new Map();
    const keys = [...new Set(slotKeys.filter(Boolean))];
    if (!keys.length) return out;
    const cutoff = new Date(now() + leadHoursOf(cfg.expiryLeadHours) * HOUR_MS);
    const soldLogins = (await M("SoopAccount").find({ sold: true }, { _id: 0, loginId: 1 }).lean()).map((a) => a.loginId);
    const $match = {
      state: "in_stock",
      slotKey: { $in: keys },
      codeHash: { $gt: "" },
      $or: [{ useBy: null }, { useBy: { $gt: cutoff } }],
    };
    if (soldLogins.length) $match.loginId = { $nin: soldLogins };
    const rows = await M("CodeStock").aggregate([{ $match }, { $group: { _id: "$slotKey", n: { $sum: 1 } } }]);
    for (const r of rows) out.set(str(r._id), r.n || 0);
    return out;
  }

  // Product rows (from productPipeline) -> views, with their units, listings,
  // free units and problems read in one batch for all of them.
  async function describe(products, cfg) {
    const offerIds = [];
    const seenOffer = new Set();
    for (const p of products) {
      if (p.offer && !seenOffer.has(String(p.offer))) {
        seenOffer.add(String(p.offer));
        offerIds.push(p.offer);
      }
    }
    const slotKeys = products.flatMap((p) => arr(p.slots).map((s) => str(s && s.slotKey)));

    const [unitRows, listingRows, free] = await Promise.all([
      offerIds.length
        ? M("SuppliedAccount").aggregate([
            { $match: { offer: { $in: offerIds } } },
            { $group: { _id: { offer: "$offer", status: "$status" }, n: { $sum: 1 } } },
          ])
        : [],
      offerIds.length
        ? M("MarketplaceListing").aggregate([
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
          ])
        : [],
      freeBySlot(slotKeys, cfg),
    ]);

    const units = new Map(); // offer -> { available, fed, sold, removed }
    for (const r of unitRows) {
      const key = String(r._id && r._id.offer);
      if (!units.has(key)) units.set(key, { available: 0, fed: 0, sold: 0, removed: 0 });
      const status = str(r._id && r._id.status);
      if (UNIT_STATUSES.includes(status)) units.get(key)[status] += r.n || 0;
    }
    const listings = new Map(); // offer -> rows, newest first
    for (const r of listingRows) {
      const key = String(r.accountOffer);
      if (!listings.has(key)) listings.set(key, []);
      listings.get(key).push(r);
    }

    const views = [];
    for (const p of products) {
      const offerKey = p.offer ? String(p.offer) : "";
      const c = p.competitors || {};
      const proposed = p.proposed || {};
      const publish = p.publish || {};
      views.push({
        id: String(p._id),
        name: str(p.name),
        status: str(p.status),
        origin: str(p.origin),
        kind: str(p.kind),
        stale: p.stale === true,
        edited: p.edited === true,
        gameNo: str(p.gameNo),
        gameName: str(p.gameName),
        marketGame: str(p.marketGame),
        slots: arr(p.slots).map(slotView),
        units: { available: 0, fed: 0, sold: 0, removed: 0, ...(offerKey && units.get(offerKey)) },
        freeUnits: freeUnitsFor(p.slots, free),
        proposed: { units: finiteOr(proposed.units, 0), at: dateOr(proposed.at) },
        useBy: dateOr(p.useBy),
        pricing: pricingView(p.pricing),
        markets: arr(p.markets).map(str),
        listings: offerKey ? pickListings(listings.get(offerKey) || []) : [],
        competitors: {
          scannedAt: dateOr(c.scannedAt),
          lowestSameSetUsd: finiteOr(c.lowestSameSetUsd, null),
          count: finiteOr(p.competitorCount, 0),
        },
        publish: { lastError: str(publish.lastError), lastAttemptAt: dateOr(publish.lastAttemptAt) },
        problems: await problemsOf(p, cfg),
      });
    }
    return views;
  }

  // --- summary ----------------------------------------------------------------

  async function summaryOf(drafts) {
    const t = now();
    const since = (days) => new Date(t - days * DAY_MS);
    const usdSince = (days) => ({
      $sum: { $cond: [{ $gte: ["$soldAt", since(days)] }, "$saleUsd", 0] },
    });
    const rows = await M("CodeStock").aggregate([
      { $project: { state: 1, unitStatus: 1, saleUsd: 1, soldAt: 1 } },
      {
        $group: {
          _id: {
            state: "$state",
            unitStatus: { $cond: [{ $eq: ["$state", "in_unit"] }, "$unitStatus", ""] },
          },
          n: { $sum: 1 },
          usd: { $sum: "$saleUsd" },
          d1: usdSince(1),
          d7: usdSince(7),
          d30: usdSince(30),
        },
      },
    ]);
    const out = {
      inStock: 0,
      onSale: 0,
      inVault: 0,
      sold: 0,
      expiring: 0,
      expired: 0,
      held: 0,
      dead: 0,
      drafts,
      revenue: { d1: 0, d7: 0, d30: 0, all: 0 },
    };
    const byState = { in_stock: "inStock", sold: "sold", expiring: "expiring", expired: "expired", held: "held", dead: "dead" };
    for (const r of rows) {
      const state = str(r._id && r._id.state);
      const n = r.n || 0;
      if (state === "in_unit") {
        const us = str(r._id && r._id.unitStatus);
        if (us === "available") out.onSale += n;
        else if (us === "fed") out.inVault += n;
      } else if (byState[state]) {
        out[byState[state]] += n;
      }
      if (SOLD_STATES.includes(state)) {
        out.revenue.all += Number(r.usd) || 0;
        out.revenue.d1 += Number(r.d1) || 0;
        out.revenue.d7 += Number(r.d7) || 0;
        out.revenue.d30 += Number(r.d30) || 0;
      }
    }
    for (const k of Object.keys(out.revenue)) out.revenue[k] = cents(out.revenue[k]);
    return out;
  }

  // --- public views -------------------------------------------------------------

  async function state() {
    const cfg = await getConfig();
    const [rows, extras] = await Promise.all([
      M("CodeProduct").aggregate(productPipeline({})),
      extrasOf(),
    ]);
    rows.sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
        cmpStr(str(a.name), str(b.name)) ||
        cmpStr(String(a._id), String(b._id)),
    );
    const drafts = rows.filter((p) => p.status === "draft").length;
    const [summary, products] = await Promise.all([summaryOf(drafts), describe(rows, cfg)]);
    return { config: cfg, summary, products, adoptable: extras.adoptable, lastTick: extras.lastTick };
  }

  async function product(id) {
    const oid = toObjectId(id);
    if (!oid) throw notFound(id);
    const cfg = await getConfig();
    const [p] = await M("CodeProduct").aggregate(productPipeline({ _id: oid }, { full: true }));
    if (!p) throw notFound(id);
    const [view] = await describe([p], cfg);
    const c = p.competitors || {};
    return {
      product: {
        ...view,
        texts: textsView(p.texts),
        competitors: {
          ...view.competitors,
          queries: arr(c.queries).map(str),
          offers: arr(c.offers).map(competitorOfferView),
        },
      },
    };
  }

  // slotKey -> the label a live (non-retired) product prints for it: an active
  // product's label first, then paused, then draft; the newest product wins a
  // tie; a blank label never wins.
  async function productLabels() {
    const rows = await M("CodeProduct").aggregate([
      { $match: { status: { $ne: "retired" } } },
      { $project: { status: 1, updatedAt: 1, "slots.slotKey": 1, "slots.label": 1 } },
    ]);
    const best = new Map(); // slotKey -> { label, rank, at }
    for (const p of rows) {
      const rank = LABEL_RANK[p.status] ?? 9;
      const at = dateOr(p.updatedAt) ? p.updatedAt.getTime() : 0;
      for (const s of arr(p.slots)) {
        const key = str(s && s.slotKey);
        const label = str(s && s.label).trim();
        if (!key || !label) continue;
        const cur = best.get(key);
        if (!cur || rank < cur.rank || (rank === cur.rank && at > cur.at)) best.set(key, { label, rank, at });
      }
    }
    const out = new Map();
    for (const [k, v] of best) out.set(k, v.label);
    return out;
  }

  function labelFor(slotKey, row, labels, cfg) {
    return labels.get(str(slotKey)) || defaultLabel(row, { sourceWords: cfg.sourceWords }) || str(row && row.name);
  }

  async function stock() {
    const cfg = await getConfig();
    const group = {
      _id: { gameNo: "$gameNo", groupKey: "$groupKey", slotKey: "$slotKey" },
      // $min skips nulls, so this is the earliest use-by among in-stock rows.
      nextUseBy: { $min: { $cond: [{ $eq: ["$state", "in_stock"] }, "$useBy", null] } },
      // The most recently touched row names the slot (documents compare field by
      // field, so `at` decides and the row id breaks a tie).
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
    };
    for (const s of STATES) group[s] = countWhen("$state", s);

    const [slotRows, labels, heldRows] = await Promise.all([
      M("CodeStock").aggregate([
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
            useBy: 1,
            updatedAt: 1,
          },
        },
        { $group: group },
      ]),
      productLabels(),
      M("CodeStock")
        .find({ state: "held" }, { loginId: 1, slotKey: 1, name: 1, nameRaw: 1, problem: 1, updatedAt: 1 })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(HELD_LIMIT)
        .lean(),
    ]);

    const games = new Map(); // gameNo -> { gameNo, gameName, at, groups: Map }
    for (const r of slotRows) {
      const id = r._id || {};
      const info = r.info || {};
      const at = dateOr(info.at) ? info.at.getTime() : 0;
      const gameNo = str(id.gameNo);
      const groupKey = str(id.groupKey);
      if (!games.has(gameNo)) games.set(gameNo, { gameNo, gameName: "", at: -1, groups: new Map() });
      const g = games.get(gameNo);
      if (at > g.at && str(info.gameName)) {
        g.gameName = str(info.gameName);
        g.at = at;
      }
      if (!g.groups.has(groupKey)) {
        g.groups.set(groupKey, { groupKey, campaignTitle: "", campaignEndAt: null, at: -1, slots: [] });
      }
      const gr = g.groups.get(groupKey);
      if (at > gr.at) {
        gr.campaignTitle = str(info.campaignTitle);
        gr.campaignEndAt = dateOr(info.campaignEndAt);
        gr.at = at;
      }
      const counts = {};
      for (const s of STATES) counts[s] = r[s] || 0;
      gr.slots.push({
        slotKey: str(id.slotKey),
        label: labelFor(id.slotKey, info, labels, cfg),
        nameRaw: str(info.nameRaw),
        image: str(info.image),
        counts,
        nextUseBy: dateOr(r.nextUseBy),
      });
    }

    const displayName = (gameNo) => {
      const gc = cfg.games && Object.prototype.hasOwnProperty.call(cfg.games, gameNo) ? cfg.games[gameNo] : null;
      return gc && typeof gc.displayName === "string" ? gc.displayName : "";
    };
    const ordinal = (slotKey) => {
      const n = Number(str(slotKey).split(":").pop());
      return Number.isFinite(n) ? n : 0;
    };
    const endMs = (d) => (d ? d.getTime() : -Infinity);
    const gameNoOrder = (a, b) => {
      const na = Number(a);
      const nb = Number(b);
      const fa = a !== "" && Number.isFinite(na);
      const fb = b !== "" && Number.isFinite(nb);
      if (fa && fb && na !== nb) return na - nb;
      if (fa !== fb) return fa ? -1 : 1;
      return cmpStr(a, b);
    };

    const out = [...games.values()]
      .sort((a, b) => gameNoOrder(a.gameNo, b.gameNo))
      .map((g) => ({
        gameNo: g.gameNo,
        gameName: g.gameName || displayName(g.gameNo),
        groups: [...g.groups.values()]
          // Newest campaign first; a campaign without an end date last.
          .sort((a, b) => endMs(b.campaignEndAt) - endMs(a.campaignEndAt) || cmpStr(a.groupKey, b.groupKey))
          .map((gr) => ({
            groupKey: gr.groupKey,
            campaignTitle: gr.campaignTitle,
            campaignEndAt: gr.campaignEndAt,
            slots: gr.slots.sort(
              (a, b) =>
                cmpStr(a.nameRaw, b.nameRaw) || ordinal(a.slotKey) - ordinal(b.slotKey) || cmpStr(a.slotKey, b.slotKey),
            ),
          })),
      }));

    const held = heldRows.map((r) => ({
      loginId: str(r.loginId),
      label: labelFor(r.slotKey, r, labels, cfg),
      problem: str(r.problem),
    }));
    return { games: out, held };
  }

  async function logins() {
    const rows = await M("CodeStock").aggregate([
      { $project: { loginId: 1, state: 1, saleUsd: 1, earnedAt: 1 } },
      {
        $group: {
          _id: "$loginId",
          codes: { $sum: 1 },
          inStock: countWhen("$state", "in_stock"),
          // In a bundle: on a shelf or in a platform vault.
          onSale: countWhen("$state", "in_unit"),
          sold: countWhen("$state", SOLD_STATES),
          usd: { $sum: { $cond: [{ $in: ["$state", SOLD_STATES] }, "$saleUsd", 0] } },
          // $max skips nulls: the latest known earn time, else null.
          lastEarnedAt: { $max: "$earnedAt" },
        },
      },
    ]);
    const ids = rows.map((r) => str(r._id)).filter(Boolean);
    const nicks = new Map();
    if (ids.length) {
      const accounts = await M("SoopAccount")
        .find({ loginId: { $in: ids } }, { _id: 0, loginId: 1, nickname: 1 })
        .lean();
      for (const a of accounts) nicks.set(str(a.loginId), str(a.nickname));
    }
    const list = rows
      .map((r) => ({
        loginId: str(r._id),
        nick: nicks.get(str(r._id)) || "",
        codes: r.codes || 0,
        inStock: r.inStock || 0,
        onSale: r.onSale || 0,
        sold: r.sold || 0,
        usd: cents(r.usd),
        lastEarnedAt: dateOr(r.lastEarnedAt),
      }))
      .sort((a, b) => b.codes - a.codes || cmpStr(a.loginId, b.loginId));
    return { logins: list };
  }

  return { state, product, stock, logins };
}

module.exports = { createViews, freeUnitsFor, defaultProblems, pickListings };
