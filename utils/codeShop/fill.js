"use strict";
// Code shop fill (docs/code-shop/03-MARKETS.md, "fill.js"): grow the stock of
// every ACTIVE product that has an offer from the codes sitting in stock.
//
// The plan is pure (allocate.planUnits: bigger products first, oldest codes
// first, nothing inside the expiry lead); the writes are units.build, whose
// status-guarded claim is what keeps one code out of two units — so two runs
// at once (the scheduler's tick and an owner's approve) can waste a claim but
// never double-sell a code.
//
// Never log or return a code: events carry counts and names only.

const mongoose = require("mongoose");
const { planUnits } = require("./allocate");
const { createUnits } = require("./units");

const HOUR_MS = 3600 * 1000;
const DEFAULT_LEAD_HOURS = 36;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const ObjectId = mongoose.Types.ObjectId;

const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SoopAccount: () => require("../../models/SoopAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

function toObjectId(v) {
  const raw = v && typeof v === "object" && v._id ? v._id : v;
  if (raw instanceof ObjectId) return raw;
  const s = raw === undefined || raw === null ? "" : String(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

// A lead that is missing or unreadable falls back to the default rather than
// to 0: 0 would put codes on sale right up to the minute they stop working.
function leadHoursOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_HOURS;
}

function createFill(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const units = deps.units || createUnits(deps);
  let config = deps.config || null;
  let events = deps.events || null;
  const M = (name) => modelOf(deps, name);

  function configOf() {
    if (!config) {
      const { createConfig } = require("./config");
      config = createConfig({ model: deps.models && deps.models.CodeShopConfig, now });
    }
    return config;
  }

  async function note(entry) {
    try {
      if (!events) {
        const { createEvents } = require("./events");
        events = createEvents({ model: deps.models && deps.models.CodeShopEvent, now });
      }
      await events.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  async function run({ force = false, productIds } = {}) {
    const out = { built: 0, failed: 0, held: 0, byProduct: {} };
    const cfg = (await configOf().get()) || {};
    if (!cfg.autoBuildUnits && !force) return { ...out, skipped: true };

    const q = { status: "active", offer: { $ne: null } };
    if (productIds !== undefined && productIds !== null) {
      const ids = (Array.isArray(productIds) ? productIds : [productIds]).map(toObjectId).filter(Boolean);
      if (!ids.length) return out;
      q._id = { $in: ids };
    }
    const products = await M("CodeProduct").find(q).lean();
    const slotKeys = [
      ...new Set(products.flatMap((p) => (Array.isArray(p.slots) ? p.slots : []).map((s) => (s && s.slotKey) || "")).filter(Boolean)),
    ];
    if (!slotKeys.length) return out;

    // Only rows with a real hash: units.build checks every code against it.
    // Never a code of a farm login that was sold: its buyer can see (and
    // redeem) that login's inventory. Ingest holds those rows on its next pass;
    // until then a pulled or dissolved unit may have put them back in stock.
    const soldLogins = (await M("SoopAccount").find({ sold: true }, { loginId: 1 }).lean()).map((a) => a.loginId);
    const stockQuery = { state: "in_stock", slotKey: { $in: slotKeys }, codeHash: { $gt: "" } };
    if (soldLogins.length) stockQuery.loginId = { $nin: soldLogins };
    const free = await M("CodeStock").find(stockQuery, { slotKey: 1, useBy: 1, earnedAt: 1 }).lean();
    const { plans } = planUnits({
      products: products.map((p) => ({
        id: p._id,
        slots: (Array.isArray(p.slots) ? p.slots : []).map((s) => (s && s.slotKey) || ""),
        createdAt: p.createdAt || null,
      })),
      free: free.map((r) => ({ id: r._id, slotKey: r.slotKey, useBy: r.useBy, earnedAt: r.earnedAt })),
      now: now(),
      leadMs: leadHoursOf(cfg.expiryLeadHours) * HOUR_MS,
    });

    const byId = new Map(products.map((p) => [String(p._id), p]));
    for (const plan of plans) {
      if (!plan.units.length) continue;
      const product = byId.get(String(plan.productId));
      const name = (product && product.name) || "a product";
      let res;
      try {
        res = await units.build(product, plan.units);
      } catch (err) {
        // A product that left sale between the read and the build; the others
        // still get their stock.
        out.failed += plan.units.length;
        await note({
          level: "warn",
          kind: "fill",
          product: plan.productId,
          msg: "Could not add bundles to " + name + ": " + String((err && err.message) || err),
          data: { planned: plan.units.length },
        });
        continue;
      }
      const built = res.built || 0;
      const failed = res.failed || 0;
      const held = res.held || 0;
      out.built += built;
      out.failed += failed;
      out.held += held;
      out.byProduct[String(plan.productId)] = built;
      if (built > 0) {
        await note({
          kind: "fill",
          product: plan.productId,
          msg: "Added " + built + (built === 1 ? " bundle" : " bundles") + " to " + name,
          data: { built, failed, held },
        });
      } else if (failed > 0) {
        await note({
          level: "warn",
          kind: "fill",
          product: plan.productId,
          msg: "Could not add bundles to " + name + " (" + failed + " failed)",
          data: { built, failed, held },
        });
      }
    }
    return out;
  }

  return { run };
}

module.exports = { createFill };
