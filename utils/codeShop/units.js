"use strict";
// Code shop units (docs/code-shop/02-ENGINE.md, "units.js"): turn ledger rows
// into sellable units and take units off sale again.
//
// A unit is one SuppliedAccount row of the product's AccountOffer. Its login is
// an internal label and its encrypted password is the buyer text, one code per
// slot. These are the rows buyers receive, so two things must never happen:
//
// - one code in two units. The ONLY way a ledger row enters a unit is the
//   status-guarded `in_stock -> in_unit` updateMany below, and a unit is
//   written only when that update moved every one of its rows. Anything that
//   goes wrong after the claim puts back only the rows carrying THIS attempt's
//   unit id, so a row another unit won is never touched.
// - a wrong code in a unit. Every code is decrypted from the inventory and
//   checked against the ledger row's codeHash, and every row against the slot
//   it fills, before anything is written.
//
// Units leave sale only through `updateOne({ _id, status: "available" })`, so a
// unit a buyer already took (sold) or a platform holds (fed) is never touched,
// and ledger rows are released only when that update won.
//
// Never log, store or return a code: events carry counts, labels and shapes.

const mongoose = require("mongoose");
const { hashCode } = require("./slots");

const ObjectId = mongoose.Types.ObjectId;
const HISTORY_MAX = 20;
const sources = require("./sources");
const HELD_PROBLEM = "stored code is missing or changed";
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
  SoopInventoryItem: () => require("../../models/SoopInventoryItem"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

// null/undefined read as "" so the buyer never gets the word "undefined"
// (a spread Mongoose sub-document once shipped exactly that).
const text = (v) => (v === undefined || v === null ? "" : String(v));

// The buyer text of one unit: one numbered line per slot, in slot order.
function unitText(slots, codes) {
  const list = Array.isArray(slots) ? slots : [];
  const values = Array.isArray(codes) ? codes : [];
  return list.map((s, i) => `${i + 1}) ${text(s && s.label)} = ${text(values[i])}`).join("\n");
}

// The unit's login: internal only, unique per offer through the product's
// unitSeq counter.
function labelFor(id, seq) {
  return `cs-${String(id).slice(-6)}-${seq}`;
}

function idOf(v) {
  return v && typeof v === "object" && v._id ? v._id : v;
}

function toObjectId(v) {
  const raw = idOf(v);
  if (raw instanceof ObjectId) return raw;
  const s = text(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

function errInfo(err) {
  // Never the message: a validation message can echo a field value.
  return {
    name: text(err && err.name),
    code: err && err.code !== undefined ? err.code : null,
    index: err && err.keyPattern ? Object.keys(err.keyPattern).join(",") : "",
  };
}

function createUnits(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const secret = deps.secret || require("../secretBox");
  let events = deps.events || null;
  const M = (name) => modelOf(deps, name);

  // Best-effort: an event that cannot be written never fails a build.
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

  const history = (from, to, why) => ({
    $each: [{ at: new Date(now()), from, to, why }],
    $slice: -HISTORY_MAX,
  });

  const backToStock = (why) => ({
    $set: { state: "in_stock", unit: null, product: null, offer: null, unitStatus: "" },
    $push: { history: history("in_unit", "in_stock", why) },
  });

  // Undo a claim: only the rows carrying this attempt's unit id, and only while
  // they are still in_unit (a row something else moved on is left where it is).
  // A failure here leaves the rows on a unit id that was never written; the
  // reconciler holds those, which is the direction that can never resell.
  async function putBack(unitId, productId, why) {
    try {
      const res = await M("CodeStock").updateMany({ unit: unitId, state: "in_unit" }, backToStock(why));
      return res.modifiedCount || 0;
    } catch (err) {
      await note({
        level: "error",
        kind: "unit-putback",
        product: productId,
        msg: "Could not put the codes of a failed bundle back in stock; the next check will hold them",
        data: { unit: String(unitId), error: errInfo(err) },
      });
      return 0;
    }
  }

  // One unit. Resolves to { status: "built" | "failed" | "stop", held }.
  // "stop" = carrying on would only fail the same way (the product left sale,
  // or the database is not answering).
  async function buildOne(ctx, ids) {
    const unitId = new ObjectId();
    try {
      return await attempt(ctx, ids, unitId);
    } catch (err) {
      // Nothing in attempt() that can throw writes the unit (the write has its
      // own catch), so whatever this attempt claimed goes back — by its own
      // unit id only — and the rest of the build waits for the next run.
      await note({
        level: "error",
        kind: "unit-build",
        product: ctx.productId,
        msg: "Building a bundle failed; its codes go back to stock",
        data: { error: errInfo(err) },
      });
      await putBack(unitId, ctx.productId, "building its bundle failed");
      return { status: "stop", held: 0 };
    }
  }

  async function attempt(ctx, ids, unitId) {
    const CodeStock = M("CodeStock");
    const { productId, offerId, slots, slotKeys } = ctx;

    // 2. Claim: every row of the unit, or none of it.
    const claim = await CodeStock.updateMany(
      { _id: { $in: ids }, state: "in_stock" },
      {
        $set: { state: "in_unit", unit: unitId, product: productId, offer: offerId, unitStatus: "available" },
        $push: { history: history("in_stock", "in_unit", "claimed for a new bundle") },
      },
    );
    if ((claim.modifiedCount || 0) !== ids.length) {
      await putBack(unitId, productId, "another bundle took one of its codes first");
      return { status: "failed", held: 0 };
    }

    // The claimed rows, re-read now that nothing else can move them: each must
    // be the reward its slot names (ingest may re-key an in_stock row between
    // the plan and the claim).
    const rows = await CodeStock.find(
      { unit: unitId, state: "in_unit" },
      { loginId: 1, itemKey: 1, slotKey: 1, codeHash: 1, codeShape: 1 },
    ).lean();
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    const ordered = ids.map((id) => byId.get(String(id)));
    if (rows.length !== ids.length || ordered.some((r) => !r)) {
      await putBack(unitId, productId, "its codes changed while the bundle was built");
      return { status: "failed", held: 0 };
    }
    if (ordered.some((r, i) => text(r.slotKey) !== slotKeys[i])) {
      await putBack(unitId, productId, "a code is not the reward its slot names");
      return { status: "failed", held: 0 };
    }

    // 3. The codes themselves, each checked against the hash taken at ingest.
    // Either farm's stored ciphertext (sources.js: SOOP inventory or CHZZK reward).
    const encBy = await sources.encOf(deps, ordered);
    const codes = [];
    const bad = [];
    for (const r of ordered) {
      const enc = encBy.get(sources.idKey(r.loginId, r.itemKey));
      let code = "";
      if (enc !== undefined) {
        try {
          code = text(secret.decrypt(text(enc))).trim();
        } catch {
          code = "";
        }
      }
      if (!code || !r.codeHash || hashCode(code) !== r.codeHash) bad.push(r);
      else codes.push(code);
    }
    if (bad.length) {
      // Hold the bad rows BEFORE the rest go back, so a bad row is never in
      // stock for another builder even for a moment.
      await CodeStock.updateMany(
        { _id: { $in: bad.map((r) => r._id) }, unit: unitId, state: "in_unit" },
        {
          $set: { state: "held", problem: HELD_PROBLEM, unit: null, product: null, offer: null, unitStatus: "" },
          $push: { history: history("in_unit", "held", HELD_PROBLEM) },
        },
      );
      await putBack(unitId, productId, "another code of its bundle failed the check");
      for (const r of bad) {
        await note({
          level: "warn",
          kind: "code-held",
          product: productId,
          msg: "Held a stored code (" + text(r.codeShape) + "): " + HELD_PROBLEM,
          data: { row: String(r._id), shape: text(r.codeShape) },
        });
      }
      return { status: "failed", held: bad.length };
    }

    // 4. The label number. Guarded by status and offer, so a product paused,
    // retired or moved to another offer since the plan gets no new unit.
    const seqDoc = await M("CodeProduct")
      .findOneAndUpdate(
        { _id: productId, status: "active", offer: offerId },
        { $inc: { unitSeq: 1 } },
        { returnDocument: "after", projection: { unitSeq: 1 } },
      )
      .lean();
    if (!seqDoc || !Number.isFinite(seqDoc.unitSeq)) {
      await putBack(unitId, productId, "its product is no longer on sale");
      return { status: "stop", held: 0 };
    }

    // 5. The unit. The text is checked to come back out of the box intact
    // before it is written: a broken key must not ship garbage to a buyer.
    const body = unitText(slots, codes);
    const password = secret.encrypt(body);
    if (!password || secret.decrypt(password) !== body) {
      await putBack(unitId, productId, "the bundle text could not be encrypted");
      return { status: "stop", held: 0 };
    }
    const SuppliedAccount = M("SuppliedAccount");
    try {
      await SuppliedAccount.create({
        _id: unitId,
        offer: offerId,
        login: labelFor(productId, seqDoc.unitSeq),
        password,
        status: "available",
        conflict: "",
        note: "code unit",
      });
    } catch (err) {
      // Did the write land anyway (an error after the insert)? Only an answer
      // of "no" may put the codes back: putting them back next to a unit that
      // exists would sell them twice.
      let exists = null;
      try {
        exists = !!(await SuppliedAccount.exists({ _id: unitId }));
      } catch {
        exists = null;
      }
      if (exists === true) return { status: "built", held: 0, unitId };
      await note({
        level: "warn",
        kind: "unit-write",
        product: productId,
        msg: "Could not write a bundle (" + labelFor(productId, seqDoc.unitSeq) + ")",
        data: { error: errInfo(err) },
      });
      if (exists === false) {
        await putBack(unitId, productId, "its stock row could not be written");
        return { status: "failed", held: 0 };
      }
      // Unknown: leave the rows on the unit id; the reconciler settles them
      // from whether the unit exists.
      return { status: "stop", held: 0 };
    }
    return { status: "built", held: 0, unitId };
  }

  // unitPlans: [[codeId per slot, in the product's slot order], ...] — the
  // `units` of one allocate.planUnits plan (the plan object itself is accepted).
  async function build(product, unitPlans) {
    if (!product || product.status !== "active") {
      throw new Error("code shop: bundles are built only for an active product");
    }
    const productId = toObjectId(product);
    const offerId = toObjectId(product.offer);
    if (!productId) throw new Error("code shop: the product has no id");
    if (!offerId) throw new Error("code shop: the product has no offer");
    const slots = Array.isArray(product.slots) ? [...product.slots] : [];
    if (!slots.length) throw new Error("code shop: the product has no slots");
    const slotKeys = slots.map((s) => text(s && s.slotKey));
    if (slotKeys.some((k) => !k)) throw new Error("code shop: a slot of the product has no key");

    const plans = Array.isArray(unitPlans) ? unitPlans : unitPlans && Array.isArray(unitPlans.units) ? unitPlans.units : [];
    const ctx = { productId, offerId, slots, slotKeys };
    const out = { built: 0, failed: 0, held: 0, unitIds: [] };

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const ids = Array.isArray(plan) ? plan.map(toObjectId) : [];
      // A plan that does not fill every slot with a distinct code is never claimed.
      if (ids.length !== slots.length || ids.some((id) => !id) || new Set(ids.map(String)).size !== ids.length) {
        out.failed += 1;
        continue;
      }
      const res = await buildOne(ctx, ids);
      out.held += res.held || 0;
      if (res.status === "built") {
        out.built += 1;
        if (res.unitId) out.unitIds.push(res.unitId);
        continue;
      }
      out.failed += 1;
      if (res.status === "stop") {
        out.failed += plans.length - i - 1;
        break;
      }
    }
    return out;
  }

  // Take every available unit of a product off sale and put its codes back in
  // stock. A unit whose codes were ever in a platform vault is left to the
  // reconciler (it may already be sold there). Newest units go first: they are
  // the last ones a buyer would get.
  async function dissolve(product, { reason = "", limit = Infinity } = {}) {
    const productId = toObjectId(product);
    const max = limit === undefined || limit === null ? Infinity : Number(limit);
    const out = { dissolved: 0, released: 0 };
    if (!productId || !(max > 0)) return out;
    const CodeStock = M("CodeStock");
    const rows = await CodeStock.find(
      { product: productId, state: "in_unit", unit: { $ne: null } },
      { unit: 1, unitStatus: 1, wasFed: 1 },
    ).lean();
    const units = new Map();
    for (const r of rows) {
      const k = String(r.unit);
      const u = units.get(k) || { id: r.unit, key: k, ok: true };
      if (r.unitStatus !== "available" || r.wasFed) u.ok = false;
      units.set(k, u);
    }
    const candidates = [...units.values()].filter((u) => u.ok).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const why = text(reason);
    for (const u of candidates) {
      if (out.dissolved >= max) break;
      const res = await M("SuppliedAccount").updateOne(
        { _id: u.id, status: "available" },
        { $set: { status: "removed", note: "code unit — " + (why || "removed") } },
      );
      if ((res.modifiedCount || 0) !== 1) continue;
      out.dissolved += 1;
      try {
        const back = await CodeStock.updateMany({ unit: u.id, state: "in_unit" }, backToStock("bundle removed" + (why ? " — " + why : "")));
        out.released += back.modifiedCount || 0;
      } catch (err) {
        // The unit is off sale; the reconciler returns rows of a removed unit.
        await note({
          level: "warn",
          kind: "unit-dissolve",
          product: productId,
          msg: "Took a bundle off sale but could not put its codes back yet",
          data: { unit: u.key, error: errInfo(err) },
        });
      }
    }
    return out;
  }

  // Take one unit off sale. true only when this call moved it available ->
  // removed. The ledger rows are the caller's job.
  async function pull(unitId, { note: why } = {}) {
    const id = toObjectId(unitId);
    if (!id) return false;
    const res = await M("SuppliedAccount").updateOne(
      { _id: id, status: "available" },
      { $set: { status: "removed", note: text(why) || "code unit — pulled" } },
    );
    return (res.modifiedCount || 0) === 1;
  }

  return { build, dissolve, pull };
}

module.exports = { createUnits, unitText, labelFor, HELD_PROBLEM };
