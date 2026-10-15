"use strict";
// Code shop expiry guard (docs/code-shop/02-ENGINE.md, "expiry.js"): take
// stock off sale before its codes stop working, so no buyer is sold a code
// they cannot redeem.
//
// A unit leaves sale only through the atomic `available -> removed` (units.pull)
// and its ledger rows move only when that write won: a unit a buyer took in
// the meantime (sold) or a platform holds (fed) is never touched. A unit in a
// platform vault cannot be pulled from here at all — the platform would hand
// it out without asking us — so the owner is told once, by Telegram, to take
// it down by hand.
//
// Codes of a pulled unit that are still good go back to free stock, except
// when the unit had ever been in a platform vault: those may already be sold,
// so they are held, exactly as reconcile.js holds them.
//
// Nothing here reads or writes a code; messages carry names, counts and dates.

const { DEFAULTS } = require("./config");
const { createEvents } = require("./events");
const { pullerOf, rowsWereFed, WHY: RECONCILE_WHY } = require("./reconcile");

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_MAX = 20;
const PULL_NOTE = "code unit — pulled before its codes stop working";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WHY = {
  pulledLead: "unit pulled: its codes stop working within the lead time",
  pulledPast: "unit pulled: its codes have stopped working",
  pulledBack: "its unit was pulled for another code that stops working soon",
  lead: "stops working within the lead time",
  past: "stopped working",
};

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

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
const pad2 = (n) => String(n).padStart(2, "0");

// Owner-facing: "16 Oct 2026 14:00 UTC".
function whenText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "an unknown date";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

function historyPush(at, from, to, why) {
  return { history: { $each: [{ at: new Date(at), from, to, why }], $slice: -HISTORY_MAX } };
}

function minMs(values) {
  let best = null;
  for (const v of values) if (v !== null && (best === null || v < best)) best = v;
  return best;
}

function createExpiry(deps = {}) {
  const M = (name) => modelOf(deps, name);
  const clock = () => {
    const t = toMs(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  const events = deps.events || createEvents({ now: clock });
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
      if (events && typeof events.log === "function") await events.log(entry);
    } catch {
      // logging is best-effort
    }
  }

  // A failed send must never fail the run: the pulls have already happened.
  async function sendSafely(message) {
    try {
      if (deps.telegram && typeof deps.telegram.send === "function") await deps.telegram.send(message);
    } catch (err) {
      await note({ level: "warn", kind: "telegram", msg: "Code shop expiry message was not sent: " + text(err && err.message).slice(0, 200) });
    }
  }

  async function run() {
    const out = { pulled: 0, expiring: 0, expired: 0, vaultWarned: 0, held: 0, errors: 0 };
    const cfg = await effectiveConfig();
    if (!cfg || !cfg.expiryGuard) return out;

    const now = clock();
    const hours = Number(cfg.expiryLeadHours);
    const leadMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULTS.expiryLeadHours) * HOUR_MS;
    const horizon = now + leadMs;
    const CodeStock = M("CodeStock");

    const pulledByProduct = new Map(); // product id -> { product, units, useBy }
    const vaultLines = [];

    // 1. Units holding a code that stops working within the lead time.
    const near = await CodeStock.find(
      { state: "in_unit", unit: { $ne: null }, useBy: { $ne: null, $lte: new Date(horizon) } },
      { unit: 1 },
    ).lean();
    const unitIds = [...new Map(near.map((r) => [String(r.unit), r.unit])).values()];

    if (unitIds.length) {
      const units = await M("SuppliedAccount")
        .find({ _id: { $in: unitIds } }, { _id: 1, status: 1, fedAt: 1, contentId: 1, deliveredAt: 1 })
        .lean();
      const unitById = new Map(units.map((u) => [String(u._id), u]));
      const rows = await CodeStock.find(
        { unit: { $in: unitIds }, state: "in_unit" },
        { _id: 1, unit: 1, product: 1, useBy: 1, wasFed: 1, unitStatus: 1 },
      ).lean();
      const rowsByUnit = new Map();
      for (const r of rows) {
        const k = String(r.unit);
        if (!rowsByUnit.has(k)) rowsByUnit.set(k, []);
        rowsByUnit.get(k).push(r);
      }
      const productIds = [...new Set(rows.map((r) => text(r.product)).filter(Boolean))];
      const products = productIds.length ? await M("CodeProduct").find({ _id: { $in: productIds } }, { _id: 1, name: 1 }).lean() : [];
      const nameById = new Map(products.map((p) => [String(p._id), text(p.name)]));
      const nameOf = (id) => nameById.get(text(id)) || (id ? "product " + text(id).slice(-6) : "a code product");

      for (const unitId of unitIds) {
        const key = String(unitId);
        const unit = unitById.get(key);
        const list = rowsByUnit.get(key) || [];
        // Missing, sold or removed: nothing to pull; reconcile settles the rows.
        if (!unit || !list.length) continue;
        try {
          const productId = list[0].product || null;
          const soonest = minMs(list.map((r) => toMs(r.useBy)));
          if (unit.status === "available") {
            // Lost = a buyer or a platform took the unit in between: not ours.
            if (!(await pull(unitId, { note: PULL_NOTE }))) continue;
            out.pulled += 1;
            const pk = text(productId) || "-";
            const entry = pulledByProduct.get(pk) || { product: productId, units: 0, useBy: null };
            entry.units += 1;
            entry.useBy = minMs([entry.useBy, soonest]);
            pulledByProduct.set(pk, entry);
            // If this throws, the unit is off sale already and reconcile
            // settles a removed unit's rows on its next pass.
            await settlePulled(unitId, unit, list, now, horizon, out);
          } else if (unit.status === "fed") {
            const msg = `A ${nameOf(productId)} bundle sits in a platform vault and its codes stop working on ${whenText(soonest)}: take it down by hand`;
            let fresh = false;
            try {
              fresh = (await events.stamp("vault-expiry:" + key, { kind: "vault-expiry", msg })) === true;
            } catch (err) {
              // Unknown whether it was sent before: try again next run rather than guess.
              await note({ level: "error", kind: "vault-expiry", product: productId, msg: "Could not record a vault warning: " + text(err && err.message).slice(0, 200) });
            }
            if (!fresh) continue;
            out.vaultWarned += 1;
            await note({ level: "warn", kind: "vault-expiry", product: productId, msg, data: { unit: key, useBy: soonest === null ? null : new Date(soonest) } });
            vaultLines.push(msg);
          }
        } catch (err) {
          out.errors += 1;
          await note({ level: "error", kind: "expiry", product: list[0].product || null, msg: "Expiry check of one bundle failed: " + text(err && err.message).slice(0, 200), data: { unit: key } });
        }
      }

      for (const p of pulledByProduct.values()) {
        p.msg = `Took ${p.units} bundle${p.units === 1 ? "" : "s"} of ${nameOf(p.product)} off sale: their codes stop working on ${whenText(p.useBy)}`;
      }
    }

    // 2. Free codes inside the lead time: no longer worth selling.
    const nowDate = new Date(now);
    const lead = await CodeStock.updateMany(
      { state: "in_stock", useBy: { $gt: nowDate, $lte: new Date(horizon) } },
      { $set: { state: "expiring" }, $push: historyPush(now, "in_stock", "expiring", WHY.lead) },
    );
    out.expiring += lead.modifiedCount || 0;

    // 3. Past their use-by. (Straight to expired, not via expiring.)
    for (const from of ["in_stock", "expiring"]) {
      const past = await CodeStock.updateMany(
        { state: from, useBy: { $ne: null, $lte: nowDate } },
        { $set: { state: "expired" }, $push: historyPush(now, from, "expired", WHY.past) },
      );
      out.expired += past.modifiedCount || 0;
    }

    // 4. One event per product, ONE Telegram message per run.
    const lines = [];
    for (const p of pulledByProduct.values()) {
      await note({ level: "info", kind: "expiry-pull", product: p.product, msg: p.msg, data: { units: p.units, useBy: p.useBy === null ? null : new Date(p.useBy) } });
      lines.push(p.msg);
    }
    lines.push(...vaultLines);
    if (lines.length) await sendSafely("Code shop:\n" + lines.join("\n"));

    return out;
  }

  // The rows of a unit this run pulled (the pull won).
  async function settlePulled(unitId, unit, list, now, horizon, out) {
    const CodeStock = M("CodeStock");
    const pulledAt = new Date(now);
    const ids = (rows) => rows.map((r) => r._id);
    const move = async (rows, to, why, $set = {}) => {
      if (!rows.length) return 0;
      const res = await CodeStock.updateMany(
        { _id: { $in: ids(rows) }, unit: unitId, state: "in_unit" },
        { $set: { state: to, pulledAt, ...$set }, $push: historyPush(now, "in_unit", to, why) },
      );
      return res.modifiedCount || 0;
    };

    // Ever in a platform vault: it may be sold already, so never back to stock.
    if (rowsWereFed(list) || unit.fedAt || text(unit.contentId) || unit.deliveredAt) {
      const why = RECONCILE_WHY.vaultBack;
      out.held += await move(list, "held", why, { problem: why, unitStatus: "removed" });
      return;
    }

    const past = [];
    const soon = [];
    const good = [];
    for (const r of list) {
      const useBy = toMs(r.useBy);
      if (useBy !== null && useBy <= now) past.push(r);
      else if (useBy !== null && useBy <= horizon) soon.push(r);
      else good.push(r);
    }
    out.expired += await move(past, "expired", WHY.pulledPast, { unitStatus: "removed" });
    out.expiring += await move(soon, "expiring", WHY.pulledLead, { unitStatus: "removed" });
    // Still good: free for other units.
    await move(good, "in_stock", WHY.pulledBack, { unit: null, product: null, offer: null, unitStatus: "" });
  }

  return { run };
}

module.exports = { createExpiry, PULL_NOTE, whenText };
