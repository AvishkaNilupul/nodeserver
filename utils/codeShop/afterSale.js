"use strict";
// Code shop after-sale (docs/code-shop/04-OPS.md, "afterSale.js"): what was
// sold, a buyer's "this code does not work", and a replacement code.
//
// replace() is the ONLY call in the code shop that hands a plaintext code out
// of the server, so it is built around these rules (05-REVIEW-FIXES.md, R7):
//
// - Dead first. Only a code the owner marked dead (report "dead") is replaced;
//   the original is marked "replaced" guarded by that state, so a report back
//   to "ok" in between makes the replacement lose.
// - Never a code a farm buyer can see: candidates of a farm login that was
//   sold (SoopAccount.sold) are skipped.
// - At most 30 replacements an hour per process (429 after), counted from the
//   moment a call starts looking, so calls at once cannot overshoot.
// - One code, one buyer. A replacement comes only from a ledger row THIS call
//   moved in_stock -> sold (a status-guarded findOneAndUpdate), so two calls at
//   once can never get the same code. The original is then marked "replaced"
//   with a guarded update too, so two calls for the same sold code hand out one
//   code between them; the loser's candidate goes back to stock — its code
//   never left the server.
// - The right code. It is decrypted from the inventory row and checked against
//   the hash ingest took before it is returned; on any failure the candidate
//   goes back in_stock and no code is returned.
// - Time to use it. Candidates inside config.expiryLeadHours of their use-by
//   are skipped, the same rule fill uses for codes put on sale.
//
// Events carry labels and code shapes, never a code.

const mongoose = require("mongoose");
const { hashCode, codeShape } = require("./slots");
const sources = require("./sources");

const ObjectId = mongoose.Types.ObjectId;
const HOUR_MS = 3600 * 1000;
const DEFAULT_LEAD_HOURS = 36;
const HISTORY_MAX = 20;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const SOLD_STATES = ["sold", "dead"];
const MAX_LIMIT = 500;
// Candidates are read a batch at a time (the next batch only when every one
// of a batch was taken by someone else first), a few batches per match.
const CANDIDATE_BATCH = 10;
const CANDIDATE_ROUNDS = 5;
// A code that fails its check goes back to stock and the next one is tried;
// this many failures in one call means something is wrong beyond one row.
const MAX_READ_FAILURES = 3;
const NOTE_MAX = 500;
const REPLACE_MAX_PER_HOUR = 30;

const ROW_FIELDS = {
  loginId: 1,
  itemKey: 1,
  unit: 1,
  product: 1,
  state: 1,
  slotKey: 1,
  gameNo: 1,
  nameRaw: 1,
  name: 1,
  codeHash: 1,
  codeShape: 1,
  soldAt: 1,
  market: 1,
  orderId: 1,
  saleUsd: 1,
  after: 1,
  "history.at": 1,
  "history.to": 1,
};

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SoopInventoryItem: () => require("../../models/SoopInventoryItem"),
  SoopAccount: () => require("../../models/SoopAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

const text = (v) => (v === undefined || v === null ? "" : String(v));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function toObjectId(v) {
  const raw = v && typeof v === "object" && v._id ? v._id : v;
  if (raw instanceof ObjectId) return raw;
  const s = text(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

// A lead that is missing or unreadable falls back to the default rather than
// to 0: 0 would hand a buyer a code minutes before it stops working.
function leadHoursOf(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LEAD_HOURS;
}

// A 0-based slot from a JSON body or a query string, or null.
function slotOf(v) {
  if (v === undefined || v === null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function actorOf(actor) {
  return text(actor).slice(0, 200);
}

// When the row last went into a unit (Infinity when the history does not say).
function inUnitAt(row) {
  const h = Array.isArray(row && row.history) ? row.history : [];
  for (let k = h.length - 1; k >= 0; k--) {
    if (h[k] && h[k].to === "in_unit") {
      const ms = toMs(h[k].at);
      if (ms !== null) return ms;
    }
  }
  return Infinity;
}

function byStoredOrder(a, b) {
  const x = inUnitAt(a);
  const y = inUnitAt(b);
  if (x !== y) return x < y ? -1 : 1;
  return cmpStr(String(a._id), String(b._id));
}

// rows = EVERY ledger row of one unit (any state), so a slot number never
// shifts when one row changes state. Slot = the row's slotKey's place in the
// product's slots (the order of the buyer text); a row the product does not
// name (or a product that is gone) comes after them, in stored order.
function slotIndexes(product, rows) {
  const keys = product && Array.isArray(product.slots) ? product.slots.map((s) => text(s && s.slotKey)) : [];
  const out = new Map();
  const taken = new Set();
  const rest = [];
  for (const r of [...(rows || [])].sort(byStoredOrder)) {
    const k = text(r.slotKey);
    const i = k ? keys.indexOf(k) : -1;
    if (i >= 0 && !taken.has(i)) {
      taken.add(i);
      out.set(String(r._id), i);
    } else {
      rest.push(r);
    }
  }
  let next = keys.length;
  for (const r of rest) out.set(String(r._id), next++);
  return out;
}

function labelOf(product, slot, row) {
  const s = product && Array.isArray(product.slots) ? product.slots[slot] : null;
  if (s && text(s.slotKey) === text(row && row.slotKey) && text(s.label)) return text(s.label);
  return text(row && row.name) || text(row && row.nameRaw);
}

function afterView(a) {
  const x = a || {};
  return {
    status: text(x.status),
    note: text(x.note),
    at: x.at || null,
    by: text(x.by),
    ref: x.ref ? String(x.ref) : null,
  };
}

function codeView(row, slot, product) {
  return {
    slot,
    label: labelOf(product, slot, row),
    codeShape: text(row.codeShape),
    state: text(row.state),
    after: afterView(row.after),
  };
}

function firstText(rows, field) {
  for (const r of rows) if (text(r[field])) return text(r[field]);
  return "";
}

function latest(rows, field) {
  let best = null;
  for (const r of rows) {
    const ms = toMs(r[field]);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best);
}

function createAfterSale(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const secret = deps.secret || require("../secretBox");
  let config = deps.config || null;
  let events = deps.events || null;
  const M = (name) => modelOf(deps, name);
  const maxPerHour = Number.isInteger(deps.maxReplacementsPerHour) && deps.maxReplacementsPerHour >= 0 ? deps.maxReplacementsPerHour : REPLACE_MAX_PER_HOUR;
  // Replacements this process handed out (or is handing out) in the last hour.
  let recent = [];

  function configOf() {
    if (!config) {
      const { createConfig } = require("./config");
      config = createConfig({ model: deps.models && deps.models.CodeShopConfig, now });
    }
    return config;
  }

  // Best-effort: an event that cannot be written never fails the call.
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

  const history = (at, from, to, why) => ({
    $each: [{ at, from, to, why }],
    $slice: -HISTORY_MAX,
  });

  async function productsById(ids) {
    const list = [...new Set(ids.filter(Boolean).map(String))].map(toObjectId).filter(Boolean);
    if (!list.length) return new Map();
    const docs = await M("CodeProduct").find({ _id: { $in: list } }, { name: 1, slots: 1 }).lean();
    return new Map(docs.map((d) => [String(d._id), d]));
  }

  // --- sold() ------------------------------------------------------------------

  // Newest first. One entry per sold unit, plus one per replacement code handed
  // out (unitId null, market "replacement"; it answers for the original's order).
  async function sold({ limit = 100, productId } = {}) {
    const n = Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), MAX_LIMIT);
    const CodeStock = M("CodeStock");
    let match;
    if (productId !== undefined && productId !== null && productId !== "") {
      const pid = toObjectId(productId);
      if (!pid) return [];
      // A replacement row has no product of its own: it belongs to the product
      // of the code it replaced.
      const refs = (await CodeStock.distinct("after.ref", { product: pid, "after.status": "replaced" })).map(toObjectId).filter(Boolean);
      const or = [{ product: pid, unit: { $ne: null } }];
      if (refs.length) or.push({ _id: { $in: refs }, "after.status": "replacement" });
      match = { state: { $in: SOLD_STATES }, $or: or };
    } else {
      match = { state: { $in: SOLD_STATES }, $or: [{ unit: { $ne: null } }, { "after.status": "replacement" }] };
    }
    // Aggregates are not cast by Mongoose: every value above is already typed.
    const groups = await CodeStock.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ["$unit", "$_id"] }, soldAt: { $max: "$soldAt" }, unit: { $max: "$unit" } } },
      { $sort: { soldAt: -1, _id: -1 } },
      { $limit: n },
    ]);
    if (!groups.length) return [];

    const unitIds = groups.filter((g) => g.unit).map((g) => g.unit);
    const replIds = groups.filter((g) => !g.unit).map((g) => g._id);
    const [unitRows, replRows] = await Promise.all([
      unitIds.length ? CodeStock.find({ unit: { $in: unitIds } }, ROW_FIELDS).lean() : [],
      replIds.length ? CodeStock.find({ _id: { $in: replIds } }, ROW_FIELDS).lean() : [],
    ]);
    const origIds = replRows.map((r) => toObjectId(r.after && r.after.ref)).filter(Boolean);
    const origRows = origIds.length ? await CodeStock.find({ _id: { $in: origIds } }, ROW_FIELDS).lean() : [];
    const origById = new Map(origRows.map((r) => [String(r._id), r]));
    const products = await productsById([...unitRows, ...origRows].map((r) => r.product));

    const byUnit = new Map();
    for (const r of unitRows) {
      const k = String(r.unit);
      if (!byUnit.has(k)) byUnit.set(k, []);
      byUnit.get(k).push(r);
    }
    const replById = new Map(replRows.map((r) => [String(r._id), r]));

    const out = [];
    for (const g of groups) {
      if (g.unit) {
        const rows = byUnit.get(String(g.unit)) || [];
        const soldRows = rows.filter((r) => SOLD_STATES.includes(r.state));
        if (!soldRows.length) continue; // moved on since the aggregate
        const pid = (rows.find((r) => r.product) || {}).product || null;
        const product = pid ? products.get(String(pid)) || null : null;
        const idx = slotIndexes(product, rows);
        out.push({
          unitId: String(g.unit),
          product: pid ? String(pid) : null,
          productName: product ? text(product.name) : "",
          market: firstText(soldRows, "market"),
          orderId: firstText(soldRows, "orderId"),
          soldAt: latest(soldRows, "soldAt"),
          usd: round2(soldRows.reduce((s, r) => s + (Number(r.saleUsd) || 0), 0)),
          codes: soldRows.map((r) => codeView(r, idx.get(String(r._id)), product)).sort((a, b) => a.slot - b.slot),
        });
        continue;
      }
      const r = replById.get(String(g._id));
      if (!r || !SOLD_STATES.includes(r.state)) continue;
      const orig = origById.get(String(r.after && r.after.ref)) || null;
      const pid = orig && orig.product ? orig.product : null;
      const product = pid ? products.get(String(pid)) || null : null;
      const keys = product && Array.isArray(product.slots) ? product.slots.map((s) => text(s && s.slotKey)) : [];
      const at = keys.indexOf(text(orig ? orig.slotKey : r.slotKey));
      const slot = at >= 0 ? at : 0;
      const view = codeView(r, slot, product);
      if (orig) view.label = labelOf(product, slot, orig) || view.label;
      out.push({
        unitId: null,
        product: pid ? String(pid) : null,
        productName: product ? text(product.name) : "",
        market: "replacement",
        orderId: orig ? text(orig.orderId) : "",
        soldAt: r.soldAt || null,
        usd: round2(r.saleUsd),
        replaces: orig && orig.unit ? { unitId: String(orig.unit), row: String(orig._id) } : null,
        codes: [view],
      });
    }
    return out;
  }

  // --- one code of one unit ------------------------------------------------------

  async function rowAt(unitId, slot) {
    const uid = toObjectId(unitId);
    if (!uid) throw fail(400, "Unknown bundle id");
    const i = slotOf(slot);
    if (i === null) throw fail(400, "Say which code of the bundle (slot 0, 1, ...)");
    const rows = await M("CodeStock").find({ unit: uid }, ROW_FIELDS).lean();
    if (!rows.length) throw fail(404, "No bundle with that id has codes in the ledger");
    const pid = (rows.find((r) => r.product) || {}).product || null;
    const product = pid ? await M("CodeProduct").findById(pid, { name: 1, slots: 1 }).lean() : null;
    const idx = slotIndexes(product, rows);
    const row = rows.find((r) => idx.get(String(r._id)) === i);
    if (!row) throw fail(404, "The bundle has no code in that place");
    return { uid, row, product, slot: i, label: labelOf(product, i, row) };
  }

  // --- report() ------------------------------------------------------------------

  async function report(unitId, { slot, status, note: why, actor } = {}) {
    if (status !== "dead" && status !== "ok") throw fail(400, 'Status must be "dead" or "ok"');
    const { uid, row, product, slot: i, label } = await rowAt(unitId, slot);
    if (!SOLD_STATES.includes(row.state)) throw fail(409, "Only a sold code can be reported");
    // A new report would clear "replaced" and open the door to a second
    // replacement for the same code.
    if (row.after && row.after.status === "replaced") {
      throw fail(409, "A replacement was already handed out for this code");
    }
    const at = new Date(now());
    const by = actorOf(actor);
    const to = status === "dead" ? "dead" : "sold";
    const update = {
      $set: { state: to, after: { status, note: text(why).slice(0, NOTE_MAX), at, by, ref: null } },
    };
    if (row.state !== to) {
      update.$push = { history: history(at, row.state, to, status === "dead" ? "reported dead after its sale" : "reported working after all") };
    }
    const doc = await M("CodeStock")
      .findOneAndUpdate({ _id: row._id, unit: uid, state: row.state, "after.status": { $ne: "replaced" } }, update, {
        returnDocument: "after",
        projection: ROW_FIELDS,
      })
      .lean();
    if (!doc) throw fail(409, "The code changed while it was being reported; reload and try again");
    await note({
      level: "info",
      kind: "after-report",
      product: doc.product || null,
      msg: `Marked ${label || "a code"} (${text(doc.codeShape)}) ${status === "dead" ? "dead" : "OK"} after its sale`,
      data: { unit: String(uid), row: String(doc._id), slot: i, status, by },
    });
    return { unitId: String(uid), ...codeView(doc, i, product) };
  }

  // --- replace() -----------------------------------------------------------------

  // The next batch of candidates for one match, oldest use-by first, then the
  // ones without a use-by. Never a row inside the lead, never a row without a
  // hash (it could not be checked), never one this call already tried.
  async function candidatesFor(match, leadCut, tried) {
    const base = {
      ...match,
      state: "in_stock",
      codeHash: { $gt: "" },
      _id: { $nin: [...tried].map((id) => new ObjectId(id)) },
    };
    const CodeStock = M("CodeStock");
    const dated = await CodeStock.find({ ...base, useBy: { $gt: leadCut } }, { _id: 1 })
      .sort({ useBy: 1, earnedAt: 1, _id: 1 })
      .limit(CANDIDATE_BATCH)
      .lean();
    if (dated.length) return dated;
    return CodeStock.find({ ...base, useBy: null }, { _id: 1 }).sort({ earnedAt: 1, _id: 1 }).limit(CANDIDATE_BATCH).lean();
  }

  // The claim: in_stock -> sold, guarded by everything the candidate was picked
  // for, so a row ingest re-keyed (or another caller took) in between is lost,
  // not wrongly handed out.
  function claim(id, match, leadCut, orig, at, by) {
    return M("CodeStock")
      .findOneAndUpdate(
        {
          _id: id,
          ...match,
          state: "in_stock",
          codeHash: { $gt: "" },
          $or: [{ useBy: null }, { useBy: { $gt: leadCut } }],
        },
        {
          $set: {
            state: "sold",
            soldAt: at,
            market: "replacement",
            after: { status: "replacement", note: "", at, by, ref: orig._id },
          },
          $push: { history: history(at, "in_stock", "sold", "handed out as a replacement") },
        },
        { returnDocument: "after", projection: { loginId: 1, itemKey: 1, codeHash: 1, codeShape: 1, slotKey: 1 } },
      )
      .lean();
  }

  // The code of a claimed row, or "" when it is missing, unreadable or not the
  // code ingest hashed.
  async function readCode(row) {
    try {
      const enc = await sources.encFor(deps, row);
      if (enc === null) return "";
      const code = text(secret.decrypt(text(enc))).trim();
      if (!code || !row.codeHash || hashCode(code) !== row.codeHash) return "";
      return code;
    } catch {
      return "";
    }
  }

  // Undo this call's claim. Guarded by the marks the claim wrote, so only a row
  // this call took is ever put back. A failure leaves the row sold to nobody:
  // a lost code, never a code sold twice.
  async function putBack(row, orig, why, productId) {
    try {
      const res = await M("CodeStock").updateOne(
        { _id: row._id, state: "sold", market: "replacement", "after.status": "replacement", "after.ref": orig._id },
        {
          $set: { state: "in_stock", soldAt: null, market: "", after: { status: "", note: "", at: null, by: "", ref: null } },
          $push: { history: history(new Date(now()), "sold", "in_stock", "replacement not handed out: " + why) },
        },
      );
      return (res.modifiedCount || 0) === 1;
    } catch {
      await note({
        level: "error",
        kind: "after-replace",
        product: productId,
        msg: `A replacement code (${text(row.codeShape)}) that was not handed out could not go back to stock`,
        data: { row: String(row._id) },
      });
      return false;
    }
  }

  // Original -> after "replaced". true only when this call made that change;
  // guarded by "dead", so a code reported working again meanwhile is not.
  async function markReplaced(orig, uid, row, at, by) {
    const CodeStock = M("CodeStock");
    try {
      const res = await CodeStock.updateOne(
        { _id: orig._id, unit: uid, state: "dead", "after.status": { $ne: "replaced" } },
        { $set: { "after.status": "replaced", "after.ref": row._id, "after.at": at, "after.by": by } },
      );
      return (res.modifiedCount || 0) === 1;
    } catch {
      // Did the write land anyway? Only "yes, pointing at this row" may hand
      // the code out.
      try {
        const cur = await CodeStock.findById(orig._id, { after: 1 }).lean();
        return !!(cur && cur.after && cur.after.status === "replaced" && String(cur.after.ref) === String(row._id));
      } catch {
        return false;
      }
    }
  }

  // A place in this hour's allowance, or a 429. Taken before the search so
  // calls at once cannot overshoot; given back when nothing was handed out.
  function takeAllowance(t) {
    recent = recent.filter((e) => e.at > t - HOUR_MS);
    if (recent.length >= maxPerHour) {
      throw fail(429, `At most ${maxPerHour} replacement codes an hour; try again later`);
    }
    const entry = { at: t };
    recent.push(entry);
    return entry;
  }
  function giveBack(entry) {
    recent = recent.filter((e) => e !== entry);
  }

  async function replace(unitId, opts = {}) {
    const { uid, row: orig, slot: i, label } = await rowAt(unitId, opts.slot);
    if (orig.after && orig.after.status === "replaced") {
      throw fail(409, "A replacement was already handed out for this code");
    }
    if (orig.state !== "dead") {
      throw fail(409, SOLD_STATES.includes(orig.state) ? "Mark the code dead first: only a dead code gets a replacement" : "Only a sold code that was marked dead can be replaced");
    }
    const entry = takeAllowance(now());
    try {
      const out = await replaceDead({ uid, orig, i, label, actor: opts.actor });
      return out;
    } catch (err) {
      giveBack(entry);
      throw err;
    }
  }

  async function replaceDead({ uid, orig, i, label, actor }) {
    const t = now();
    const at = new Date(t);
    const by = actorOf(actor);
    const productId = orig.product || null;
    const cfg = (await configOf().get()) || {};
    const leadCut = new Date(t + leadHoursOf(cfg.expiryLeadHours) * HOUR_MS);

    // Never a code of a farm login that was sold: its buyer can see (and
    // redeem) that login's inventory.
    const soldLogins = await sources.soldLoginIds(deps);
    const notSold = soldLogins.length ? { loginId: { $nin: soldLogins } } : {};

    // Same reward of the same campaign first, then the same reward name of the
    // same game (another campaign's copy of it).
    const matches = [];
    if (text(orig.slotKey)) matches.push({ slotKey: text(orig.slotKey), ...notSold });
    if (text(orig.gameNo) && text(orig.nameRaw)) matches.push({ gameNo: text(orig.gameNo), nameRaw: text(orig.nameRaw), ...notSold });

    const tried = new Set();
    let readFailures = 0;
    for (const match of matches) {
      for (let round = 0; round < CANDIDATE_ROUNDS; round++) {
        const list = await candidatesFor(match, leadCut, tried);
        if (!list.length) break;
        for (const c of list) {
          tried.add(String(c._id));
          const row = await claim(c._id, match, leadCut, orig, at, by);
          if (!row) continue; // another caller (or ingest) got there first

          const code = await readCode(row);
          if (!code) {
            readFailures += 1;
            await putBack(row, orig, "its stored code is missing or changed", productId);
            await note({
              level: "warn",
              kind: "after-replace",
              product: productId,
              msg: `A replacement candidate for ${label || "a code"} (${text(row.codeShape)}) failed its check and went back to stock`,
              data: { unit: String(uid), slot: i, candidate: String(row._id), shape: text(row.codeShape) },
            });
            if (readFailures >= MAX_READ_FAILURES) {
              throw fail(500, "Replacement codes in stock could not be read; nothing was handed out");
            }
            continue;
          }

          if (!(await markReplaced(orig, uid, row, at, by))) {
            await putBack(row, orig, "the code was replaced (or reported working) by another request", productId);
            throw fail(409, "A replacement was already handed out for this code, or it is no longer marked dead");
          }

          const shape = text(row.codeShape) || codeShape(code);
          await note({
            level: "info",
            kind: "after-replace",
            product: productId,
            msg: `Handed out a replacement for ${label || "a code"} (${shape})`,
            data: { unit: String(uid), slot: i, original: String(orig._id), replacement: String(row._id), label, shape, by },
          });
          return { code, label, codeShape: shape };
        }
      }
    }
    if (readFailures) throw fail(500, "No replacement code in stock passed its check; nothing was handed out");
    throw fail(409, "No usable replacement code for this reward is in stock");
  }

  return { sold, report, replace };
}

module.exports = { createAfterSale, slotIndexes, REPLACE_MAX_PER_HOUR };
