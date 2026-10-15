"use strict";
// Code shop — automatic prices (docs/code-shop/03-MARKETS.md, "pricing.js").
//
// Two reasons to move a price, both only ever DOWN from the owner's base price
// and never under the floor:
// - clearance: the closer the codes are to their use-by date, the bigger the
//   cut (config.pricing.clearanceSteps);
// - competitors: one step (undercutUsd) under the cheapest other seller of the
//   same set, as competitors.js last saw it.
//
// Only products the owner set to `pricing.mode: "auto"` are touched, and only
// their Eldorado offer: GGSel prices are never changed here, and a fixed-price
// product (the default, and always an adopted offer) is never read for a
// change at all. Each product is re-read just before its change, so one the
// owner switched to fixed while this run was busy with others is left alone.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_PRICE_USD = 0.5;
// Float noise: 1.15 - 1.14 is 0.00999…, which is still a one-cent change.
const EPS = 1e-9;

// --- pure ------------------------------------------------------------------

function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date || (typeof v === "object" && typeof v.getTime === "function")) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// toFixed first so 0.8999999999999999 floors to 0.90, not 0.89.
const floorCents = (n) => Math.floor(Number((n * 100).toFixed(6))) / 100;
const ceilCents = (n) => Math.ceil(Number((n * 100).toFixed(6))) / 100;
const money = (n) => "$" + Number(n).toFixed(2);

function finite(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The clearance step for `days` left: among steps with days <= step.days, the
// one with the smallest step.days. Steps that are not { days >= 0, cutPct
// 0..90 } are ignored.
function clearanceStep(days, steps) {
  let pick = null;
  for (const s of Array.isArray(steps) ? steps : []) {
    const d = finite(s && s.days);
    const cut = finite(s && s.cutPct);
    if (d === null || d < 0 || cut === null || cut < 0 || cut > 90) continue;
    if (days <= d && (!pick || d < pick.days)) pick = { days: d, cutPct: cut };
  }
  return pick;
}

// -> { priceUsd, reasons[] }. priceUsd is whole cents, never under the floor
// (max(floorUsd, 0.5), rounded UP to a cent), or null when the product has no
// usable base price.
// A competitor price is only followed while its scan is recent: an old scan
// would keep pulling the price down after the rival has raised theirs or
// sold out. Recent = within two scan intervals (default 2 x 12 h).
function freshLowest(product, nowMs, cfg) {
  const c = (product && product.competitors) || {};
  const lowest = finite(c.lowestSameSetUsd);
  const at = toMs(c.scannedAt);
  if (lowest === null || at === null) return null;
  const every = finite(cfg && cfg.competitorScan && cfg.competitorScan.everyHours) || 12;
  return nowMs - at <= 2 * every * HOUR_MS ? lowest : null;
}

function decidePrice({ product, now, steps, undercutUsd, lowestSameSetUsd } = {}) {
  const pricing = (product && product.pricing) || {};
  const base = finite(pricing.priceUsd);
  if (base === null || base <= 0) return { priceUsd: null, reasons: ["no valid base price"] };
  const floor = ceilCents(Math.max(finite(pricing.floorUsd) || 0, MIN_PRICE_USD));
  const reasons = [];
  let price = base;

  const useBy = toMs(product && product.useBy);
  const t = toMs(now);
  if (pricing.clearance && useBy !== null && t !== null) {
    const days = (useBy - t) / DAY_MS;
    const step = clearanceStep(days, steps);
    if (step && step.cutPct > 0) {
      price = base * (1 - step.cutPct / 100);
      reasons.push("clearance -" + step.cutPct + "% (" + Math.max(0, days).toFixed(1) + " days left)");
    }
  }

  const lowest = finite(lowestSameSetUsd);
  if (pricing.followCompetitors && lowest !== null) {
    const target = lowest - (finite(undercutUsd) || 0);
    if (target < price) {
      price = target;
      reasons.push("under the cheapest same-set offer (" + money(lowest) + ")");
    }
  }

  price = floorCents(price);
  if (price < floor) {
    price = floor;
    reasons.push("held at the floor " + money(floor));
  }
  if (!reasons.length) reasons.push("base price");
  return { priceUsd: price, reasons };
}

// --- run -------------------------------------------------------------------

function leanOf(q) {
  return q && typeof q.lean === "function" ? q.lean() : q;
}

function createPricing(deps = {}) {
  let models = deps.models || null;
  const getModels = () => {
    if (!models) {
      models = {
        CodeProduct: require("../../models/CodeProduct"),
        MarketplaceListing: require("../../models/MarketplaceListing"),
      };
    }
    return models;
  };
  const now = deps.now || Date.now;
  const mp = deps.mp || (() => require("../marketplaces"));
  let config = deps.config || null;
  let events = deps.events || null;
  const getConfig = () => config || (config = require("./config").createConfig());
  const getEvents = () => events || (events = require("./events").createEvents());

  const AUTO = { status: "active", "pricing.mode": "auto" };

  async function run() {
    const { CodeProduct, MarketplaceListing } = getModels();
    const cfg = (await getConfig().get()) || {};
    const pc = cfg.pricing || {};
    const cooldownMs = Math.max(0, finite(pc.cooldownHours) || 0) * HOUR_MS;
    const out = { checked: 0, changed: [], failed: 0 };

    const ids = (await leanOf(CodeProduct.find(AUTO, { _id: 1 }).sort({ _id: 1 }))) || [];
    for (const { _id } of ids) {
      // Fresh read: the owner may have switched it to fixed (or paused it)
      // while earlier products were being repriced.
      const product = await leanOf(CodeProduct.findOne({ _id, ...AUTO }));
      if (!product) continue;
      out.checked += 1;
      if (!product.offer) continue;

      const row = await leanOf(
        MarketplaceListing.findOne({ accountOffer: product.offer, marketplace: "eldorado", status: "active" }).sort({ createdAt: -1 }),
      );
      if (!row || !row.externalId) continue;

      const t = now();
      const last = toMs(product.pricing && product.pricing.lastChangeAt);
      if (last !== null && t - last < cooldownMs) continue;

      const decision = decidePrice({
        product,
        now: t,
        steps: pc.clearanceSteps,
        undercutUsd: pc.undercutUsd,
        lowestSameSetUsd: freshLowest(product, t, cfg),
      });
      if (decision.priceUsd === null) continue;
      const from = finite(row.price) || 0;
      if (Math.abs(decision.priceUsd - from) < 0.01 - EPS) continue;

      const name = product.name || String(product._id);
      let to = decision.priceUsd;
      try {
        const set = await mp().eldoradoReprice(row.externalId, decision.priceUsd);
        // eldoradoReprice answers with the amount it actually sent.
        if (finite(set) !== null && set > 0) to = Number(set);
      } catch (err) {
        out.failed += 1;
        await getEvents().log({
          level: "warn",
          kind: "pricing",
          product: product._id,
          msg: "Could not change the Eldorado price of " + name + " to " + money(decision.priceUsd) + ": " + ((err && err.message) || err),
        });
        continue;
      }

      const reason = decision.reasons.join("; ").slice(0, 300);
      try {
        await MarketplaceListing.updateOne({ _id: row._id }, { $set: { price: to } });
        await CodeProduct.updateOne(
          { _id: product._id },
          { $set: { "pricing.lastChangeAt": new Date(t), "pricing.lastReason": reason } },
        );
      } catch (err) {
        // The live price did change; say so rather than lose it.
        await getEvents().log({
          level: "error",
          kind: "pricing",
          product: product._id,
          msg: "Eldorado price of " + name + " is now " + money(to) + " but saving that failed: " + ((err && err.message) || err),
        });
      }
      await getEvents().log({
        kind: "pricing",
        product: product._id,
        msg: "Eldorado price of " + name + ": " + money(from) + " -> " + money(to) + " (" + reason + ")",
        data: { from, to, reasons: decision.reasons },
      });
      out.changed.push({ product: product._id, from, to, reasons: decision.reasons });
    }
    return out;
  }

  return { run };
}

module.exports = {
  freshLowest, decidePrice, createPricing, clearanceStep, floorCents, MIN_PRICE_USD };
