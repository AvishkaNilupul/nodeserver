"use strict";
// Code shop reconcile (docs/code-shop/02-ENGINE.md, "reconcile.js"): mirror
// each unit's SuppliedAccount status onto the ledger rows of the codes in it.
//
// The fulfillers and the stock sync move units (available -> sold / fed, back
// to available on a released claim, removed by the owner); the ledger follows.
// Wherever a code might already have reached a buyer, the answer is "held",
// never "back on sale":
// - a unit that sat in a platform vault (GGSel) and comes back "available" may
//   already have been handed out by the platform, so the unit is taken off sale
//   (atomic available -> removed) and its codes are held;
// - a removed unit's codes go back to free stock only when nothing on it says
//   it ever left the shelf through a market. A release clears those marks
//   (utils/suppliedStock.releaseClaim); a removal does not, so a vault unit
//   taken down by listingDetach still carries them.
//
// Every write is guarded: ledger rows by their unit AND the state they were
// read in, units by the status they were read in. A change that lands between
// the read and the write is never overwritten; the next pass picks it up.
//
// Nothing here reads or writes a code: rows carry hashes, units stay encrypted.

const { DEFAULTS } = require("./config");

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_MAX = 20;
// units.build claims the ledger rows (pointing them at a fresh unit id) BEFORE
// it writes the unit, so a unit younger than this may just not be written yet.
const MISSING_GRACE_MS = 10 * 60 * 1000;

const NOTE_VAULT = "code unit — came back from a platform vault";

const WHY = {
  missing: "its stock row is gone",
  vaultBack: "was in a platform vault and came back; it may already be sold",
  deliveredBack: "was delivered to a buyer and came back; it may already be sold",
  vaultRemoved: "was in a platform vault before its unit was removed; it may already be sold",
  marketRemoved: "its unit went out through a market before it was removed; it may already be sold",
  sold: "unit sold",
  released: "unit back on sale: its sale was released",
  fed: "unit handed to a platform vault",
  pulled: "unit was pulled before its codes stop working",
  removed: "unit removed",
  removedLead: "unit removed; its codes stop working within the lead time",
  removedPast: "unit removed after its codes stopped working",
};

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
  MarketplaceListing: () => require("../../models/MarketplaceListing"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

// ms from a number or a Date; null when absent or unreadable.
function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date || (typeof v === "object" && typeof v.getTime === "function")) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const text = (v) => (v === undefined || v === null ? "" : String(v));

function leadMsOf(cfg) {
  const h = Number(cfg && cfg.expiryLeadHours);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULTS.expiryLeadHours) * HOUR_MS;
}

// One history entry, kept to the last HISTORY_MAX.
function historyPush(at, from, to, why) {
  return { history: { $each: [{ at: new Date(at), from, to, why }], $slice: -HISTORY_MAX } };
}

// Any row that ever saw its unit in a platform vault.
function rowsWereFed(rows) {
  return rows.some((r) => r.wasFed === true || r.unitStatus === "fed");
}

// Marks a market leaves on a unit that went out through it. A release puts all
// of them back to empty; a removal leaves them in place.
function hasMarketMarks(unit) {
  return !!(
    unit &&
    (unit.fedAt || unit.soldAt || unit.deliveredAt || text(unit.market) || unit.listing || text(unit.contentId) || text(unit.orderId))
  );
}

// The atomic `available -> removed`. units.pull when the caller wired one in,
// else the same single status-guarded update. true only when THIS call won.
function pullerOf(deps) {
  if (deps && deps.units && typeof deps.units.pull === "function") {
    return async (unitId, opts) => (await deps.units.pull(unitId, opts)) === true;
  }
  return async (unitId, { note = "" } = {}) => {
    const res = await modelOf(deps, "SuppliedAccount").updateOne(
      { _id: unitId, status: "available" },
      { $set: { status: "removed", note: text(note) || "code unit — pulled" } },
    );
    return (res.modifiedCount || 0) === 1;
  };
}

// When the unit id was minted (ObjectId time), null when it is not one.
function idTimeMs(id) {
  try {
    if (id && typeof id.getTimestamp === "function") return id.getTimestamp().getTime();
  } catch {
    // not an ObjectId
  }
  return null;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

function createReconcile(deps = {}) {
  const M = (name) => modelOf(deps, name);
  const clock = () => {
    const t = toMs(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  const graceMs = Number.isFinite(Number(deps.missingGraceMs)) ? Math.max(0, Number(deps.missingGraceMs)) : MISSING_GRACE_MS;
  const pull = pullerOf(deps);

  async function effectiveConfig() {
    try {
      if (deps.config && typeof deps.config.get === "function") return (await deps.config.get()) || DEFAULTS;
    } catch {
      // config.get never throws in production; a fake might
    }
    return DEFAULTS;
  }

  async function note(entry) {
    try {
      if (deps.events && typeof deps.events.log === "function") await deps.events.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  async function run() {
    const CodeStock = M("CodeStock");
    const out = { checked: 0, sold: 0, back: 0, held: 0, fed: 0, released: 0, expiring: 0, expired: 0, errors: 0 };
    const now = clock();
    const leadMs = leadMsOf(await effectiveConfig());

    const rows = await CodeStock.find(
      { state: { $in: ["in_unit", "sold"] }, unit: { $ne: null } },
      {
        _id: 1,
        state: 1,
        unit: 1,
        product: 1,
        offer: 1,
        unitStatus: 1,
        wasFed: 1,
        pulledAt: 1,
        useBy: 1,
        saleUsd: 1,
        market: 1,
        orderId: 1,
      },
    ).lean();

    const byUnit = new Map();
    for (const r of rows) {
      const k = String(r.unit);
      if (!byUnit.has(k)) byUnit.set(k, { id: r.unit, rows: [] });
      byUnit.get(k).rows.push(r);
    }

    if (byUnit.size) {
      const unitIds = [...byUnit.values()].map((u) => u.id);
      const units = await M("SuppliedAccount")
        .find(
          { _id: { $in: unitIds } },
          {
            _id: 1,
            offer: 1,
            status: 1,
            market: 1,
            orderId: 1,
            listing: 1,
            contentId: 1,
            fedAt: 1,
            soldAt: 1,
            deliveredAt: 1,
            createdAt: 1,
          },
        )
        .lean();
      const unitById = new Map(units.map((u) => [String(u._id), u]));

      const productIds = [...new Set(rows.map((r) => text(r.product)).filter(Boolean))];
      const products = productIds.length
        ? await M("CodeProduct").find({ _id: { $in: productIds } }, { _id: 1, slots: 1, pricing: 1 }).lean()
        : [];
      const productById = new Map(products.map((p) => [String(p._id), p]));

      const ctx = { now, leadMs, out, productById, prices: new Map() };
      for (const [key, group] of byUnit) {
        out.checked += 1;
        try {
          await settleUnit(ctx, group.id, group.rows, unitById.get(key) || null);
        } catch (err) {
          // One unit that cannot be settled must not stop the others; its
          // rows stay as they were and the next pass tries again.
          out.errors += 1;
          await note({
            level: "error",
            kind: "reconcile",
            product: (group.rows[0] && group.rows[0].product) || null,
            msg: "Reconciling one bundle failed: " + text(err && err.message).slice(0, 200),
            data: { unit: key },
          });
        }
      }
    }

    await refreshProductUseBy();

    if (out.held > 0) {
      await note({
        level: "warn",
        kind: "reconcile",
        msg: out.held + " code(s) held: they may already have reached a buyer, so they are never put back on sale",
        data: { held: out.held },
      });
    }
    if (out.sold > 0 || out.released > 0 || out.back > 0) {
      await note({
        level: "info",
        kind: "reconcile",
        msg: `Reconciled: ${out.sold} sold, ${out.released} released, ${out.back} back in stock`,
        data: { sold: out.sold, released: out.released, back: out.back, fed: out.fed },
      });
    }
    return out;
  }

  // Move the given rows of one unit from `from` to `to`. Only rows still in
  // `from` AND still on this unit move; returns how many did.
  async function move(ctx, unitId, ids, from, to, why, $set = {}, filter = {}) {
    if (!ids.length) return 0;
    const res = await M("CodeStock").updateMany(
      { _id: { $in: ids }, unit: unitId, state: from, ...filter },
      { $set: { state: to, ...$set }, $push: historyPush(ctx.now, from, to, why) },
    );
    return res.modifiedCount || 0;
  }

  // Same state, only fields change: no history entry.
  async function touch(unitId, ids, state, $set, filter = {}) {
    if (!ids.length) return 0;
    const res = await M("CodeStock").updateMany({ _id: { $in: ids }, unit: unitId, state, ...filter }, { $set });
    return res.modifiedCount || 0;
  }

  async function settleUnit(ctx, unitId, rows, unit) {
    const { now, out } = ctx;
    const inUnit = rows.filter((r) => r.state === "in_unit");
    const sold = rows.filter((r) => r.state === "sold");
    const ids = (list) => list.map((r) => r._id);

    // Missing: the codes' unit is gone. Never back on sale: hold what was in it.
    if (!unit) {
      const born = idTimeMs(unitId);
      if (born !== null && now - born < graceMs) return; // build may still be writing it
      out.held += await move(ctx, unitId, ids(inUnit), "in_unit", "held", WHY.missing, { problem: WHY.missing });
      return;
    }

    const status = text(unit.status);

    if (status === "available") {
      const vault = rowsWereFed(rows) || !!unit.fedAt || !!text(unit.contentId);
      const delivered = !!unit.deliveredAt;
      if (vault || delivered) {
        // A platform may have handed this unit out already: take it off sale
        // first, and hold its codes only when that won. Lost = the unit moved
        // on (sold, fed, removed) in between; the next pass reads it again.
        const won = await pull(unitId, { note: NOTE_VAULT });
        if (!won) return;
        const why = vault ? WHY.vaultBack : WHY.deliveredBack;
        const $set = { problem: why, unitStatus: "removed" };
        out.held += await move(ctx, unitId, ids(inUnit), "in_unit", "held", why, $set);
        out.held += await move(ctx, unitId, ids(sold), "sold", "held", why, $set);
        return;
      }
      await touch(unitId, ids(inUnit.filter((r) => r.unitStatus !== "available")), "in_unit", { unitStatus: "available" });
      // A sale that was released (the claim was undone before delivery): the
      // unit is back on the shelf, so its codes are in it again, unsold.
      out.released += await move(ctx, unitId, ids(sold), "sold", "in_unit", WHY.released, {
        unitStatus: "available",
        soldAt: null,
        market: "",
        orderId: "",
        saleUsd: 0,
      });
      return;
    }

    if (status === "fed") {
      const stale = inUnit.filter((r) => r.unitStatus !== "fed" || r.wasFed !== true);
      out.fed += await touch(unitId, ids(stale), "in_unit", { unitStatus: "fed", wasFed: true });
      // A claim that turned into a vault hand-off (claimed "sold", then fed):
      // the code is in the vault, not with a buyer yet.
      out.fed += await move(ctx, unitId, ids(sold), "sold", "in_unit", WHY.fed, {
        unitStatus: "fed",
        wasFed: true,
        soldAt: null,
        market: "",
        orderId: "",
        saleUsd: 0,
      });
      return;
    }

    if (status === "sold") {
      const sale = {
        unitStatus: "sold",
        soldAt: new Date(toMs(unit.deliveredAt) || toMs(unit.soldAt) || now),
        market: text(unit.market),
        orderId: text(unit.orderId),
      };
      const needsPrice = (r) => !(Number(r.saleUsd) > 0);
      const anyNeedsPrice = rows.some(needsPrice);
      const saleUsd = anyNeedsPrice ? await shareOf(ctx, unit, rows) : 0;
      // saleUsd is set once: a row that already has one keeps it.
      out.sold += await move(ctx, unitId, ids(inUnit.filter(needsPrice)), "in_unit", "sold", WHY.sold, { ...sale, saleUsd }, { saleUsd: { $not: { $gt: 0 } } });
      out.sold += await move(ctx, unitId, ids(inUnit.filter((r) => !needsPrice(r))), "in_unit", "sold", WHY.sold, sale, { saleUsd: { $gt: 0 } });
      // Already sold: fill a missing price; follow the order if the unit was
      // released and sold again in between two passes.
      if (saleUsd > 0) await touch(unitId, ids(sold.filter(needsPrice)), "sold", { saleUsd }, { saleUsd: { $not: { $gt: 0 } } });
      if (sale.orderId) {
        await touch(unitId, ids(sold.filter((r) => text(r.orderId) !== sale.orderId)), "sold", sale, { orderId: { $ne: sale.orderId } });
      }
      return;
    }

    if (status === "removed") {
      // Sold rows stay sold. In-unit rows go back to stock only when the unit
      // provably never left the shelf through a market.
      const fed = rowsWereFed(rows);
      if (fed || hasMarketMarks(unit)) {
        const why = fed ? WHY.vaultRemoved : WHY.marketRemoved;
        out.held += await move(ctx, unitId, ids(inUnit), "in_unit", "held", why, { problem: why, unitStatus: "removed" });
        return;
      }
      // pulledAt belongs to THIS unit only if it is not older than the unit:
      // units.build does not clear it, so a code once pulled and re-bundled
      // still carries the earlier stamp.
      const bornAt = toMs(unit.createdAt);
      const pulledHere = (r) => {
        const p = toMs(r.pulledAt);
        return p !== null && (bornAt === null || p >= bornAt);
      };
      // Split by reason too, so each history entry says why the row moved.
      const groups = { expiredPulled: [], expiredPast: [], expiringPulled: [], expiringLead: [], back: [] };
      for (const r of inUnit) {
        const useBy = toMs(r.useBy);
        const pulled = pulledHere(r);
        if (useBy !== null && useBy <= now) (pulled ? groups.expiredPulled : groups.expiredPast).push(r);
        else if (pulled) groups.expiringPulled.push(r);
        else if (useBy !== null && useBy <= now + ctx.leadMs) groups.expiringLead.push(r);
        else groups.back.push(r);
      }
      const off = { unitStatus: "removed" };
      out.expired += await move(ctx, unitId, ids(groups.expiredPulled), "in_unit", "expired", WHY.pulled, off);
      out.expired += await move(ctx, unitId, ids(groups.expiredPast), "in_unit", "expired", WHY.removedPast, off);
      out.expiring += await move(ctx, unitId, ids(groups.expiringPulled), "in_unit", "expiring", WHY.pulled, off);
      out.expiring += await move(ctx, unitId, ids(groups.expiringLead), "in_unit", "expiring", WHY.removedLead, off);
      out.back += await move(ctx, unitId, ids(groups.back), "in_unit", "in_stock", WHY.removed, {
        unit: null,
        product: null,
        offer: null,
        unitStatus: "",
      });
      return;
    }
    // Any other status: not ours to interpret; leave the rows as they are.
  }

  // This code's share of the unit's sale: the newest listing of the offer on
  // that market, else the product's price, divided by the product's slots.
  async function shareOf(ctx, unit, rows) {
    const product = ctx.productById.get(text(rows[0] && rows[0].product)) || null;
    const offer = unit.offer || (rows[0] && rows[0].offer) || null;
    const market = text(unit.market);
    let price = 0;
    if (offer && market) {
      const key = String(offer) + "|" + market;
      if (!ctx.prices.has(key)) {
        const listing = await M("MarketplaceListing")
          .findOne({ accountOffer: offer, marketplace: market }, { price: 1 })
          .sort({ createdAt: -1, _id: -1 })
          .lean();
        ctx.prices.set(key, listing ? Number(listing.price) || 0 : 0);
      }
      price = ctx.prices.get(key);
    }
    if (!(price > 0)) price = Number(product && product.pricing && product.pricing.priceUsd) || 0;
    if (!(price > 0)) return 0;
    const slots = (product && Array.isArray(product.slots) && product.slots.length) || rows.length || 1;
    return round4(price / slots);
  }

  // Each active product's useBy = earliest useBy of its codes on sale.
  async function refreshProductUseBy() {
    const earliest = await M("CodeStock").aggregate([
      { $match: { state: "in_unit", unitStatus: "available", product: { $ne: null }, useBy: { $ne: null } } },
      { $group: { _id: "$product", useBy: { $min: "$useBy" } } },
    ]);
    const want = new Map(earliest.map((e) => [String(e._id), e.useBy || null]));
    const CodeProduct = M("CodeProduct");
    const active = await CodeProduct.find({ status: "active" }, { _id: 1, useBy: 1 }).lean();
    for (const p of active) {
      const next = want.get(String(p._id)) || null;
      if (toMs(next) === toMs(p.useBy)) continue;
      await CodeProduct.updateOne({ _id: p._id, status: "active" }, { $set: { useBy: next } });
    }
  }

  return { run };
}

module.exports = {
  createReconcile,
  // shared with expiry.js so both read "may have reached a buyer" the same way
  pullerOf,
  rowsWereFed,
  hasMarketMarks,
  WHY,
  NOTE_VAULT,
  MISSING_GRACE_MS,
};
