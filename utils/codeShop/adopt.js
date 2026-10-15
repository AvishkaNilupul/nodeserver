"use strict";
// Code shop adopt (docs/code-shop/02-ENGINE.md, "adopt.js"): take over a
// hand-made code offer that is ALREADY ON SALE, so the ledger knows which of
// its codes sit in which unit and never puts one of them into a second unit.
//
// A hand-made unit is a SuppliedAccount row whose decrypted password is one
// "N) Label = CODE" line per code, every unit of the offer listing the same
// rewards in the same order. Line N's slot is the slotKey of the ledger row
// whose codeHash matches line N's code, and every unit must agree on it.
//
// What adopt writes, and nothing else:
// - ledger rows: the status-guarded `in_stock -> in_unit` link of each unit's
//   codes (a row already linked to exactly that unit is left as it is), and
//   `in_stock -> held` for the codes of a removed unit that carries the marks
//   of having gone out through a market (it may have reached a buyer);
// - one CodeProduct owning the offer (an existing one is reused).
// It NEVER writes a SuppliedAccount: no password, status or login change. A
// unit the shop would have to take off sale (on sale, but carrying vault or
// delivery marks — reconcile pulls those) is refused as a problem instead.
//
// Any problem means nothing at all is written. Codes are decrypted only to
// hash them; reports, problems and events carry labels, slot keys, counts and
// masked shapes (`codeShape`) — never a code.

const mongoose = require("mongoose");
const slotsLib = require("./slots");

const ObjectId = mongoose.Types.ObjectId;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
const HISTORY_MAX = 20;
const LINE_RE = /^\s*(\d+)\)\s*(.+?)\s*=\s*(\S+)\s*$/;
const MARKETS = ["eldorado", "ggsel"];
const STATUSES = ["available", "fed", "sold", "removed"];
const MIN_FLOOR_USD = 0.5;

const WHY_ADOPTED = "adopted";
const WHY_REMOVED_OUT =
  "was in a removed unit of an adopted offer that went out through a market; it may already be sold";

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  AccountOffer: () => require("../../models/AccountOffer"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
  MarketplaceListing: () => require("../../models/MarketplaceListing"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

const text = (v) => (v === undefined || v === null ? "" : String(v));
const leanOf = (q) => (q && typeof q.lean === "function" ? q.lean() : q);

function toObjectId(v) {
  const raw = v && typeof v === "object" && v._id ? v._id : v;
  if (raw instanceof ObjectId) return raw;
  const s = text(raw);
  return OBJECT_ID_HEX.test(s) ? new ObjectId(s) : null;
}

function msOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Same marks reconcile reads as "this unit went out through a market".
function hasMarketMarks(unit) {
  return !!(
    unit &&
    (unit.fedAt || unit.soldAt || unit.deliveredAt || text(unit.market) || unit.listing || text(unit.contentId) || text(unit.orderId))
  );
}

// An unit on sale that reconcile would take off sale at once (a vault hand-off
// or a delivery it cannot prove undone). Adopting it would rewrite it.
function availableButMarked(unit) {
  return unit.status === "available" && !!(unit.fedAt || text(unit.contentId) || unit.deliveredAt);
}

// A unit's buyer text -> { ok, lines: [{ label, hash, shape }] } or
// { ok: false, why }. The code is hashed and dropped here; the reason never
// quotes the line (it would hold a code).
function parseUnit(secret, password) {
  let plain = "";
  try {
    plain = text(secret.decrypt(text(password)));
  } catch {
    plain = "";
  }
  if (!plain.trim()) return { ok: false, why: "its text is empty or cannot be read" };
  const raw = plain.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    const m = LINE_RE.exec(raw[i]);
    if (!m) return { ok: false, why: `line ${i + 1} does not read "N) Label = CODE"` };
    if (Number(m[1]) !== i + 1) return { ok: false, why: `line ${i + 1} is numbered ${m[1]}` };
    lines.push({ label: m[2].trim(), hash: slotsLib.hashCode(m[3]), shape: slotsLib.codeShape(m[3]) });
  }
  return { ok: true, lines };
}

// The base of a slot key (campaign group + reward name, without the step).
function rewardOf(slotKey) {
  const s = text(slotKey);
  const cut = s.lastIndexOf(":");
  return cut > 0 ? s.slice(0, cut) : s;
}

function emptyByStatus() {
  const out = {};
  for (const s of STATUSES) out[s] = 0;
  return out;
}

function createAdopt(deps = {}) {
  const M = (name) => modelOf(deps, name);
  const secret = deps.secret || require("../secretBox");
  const clock = () => {
    const t = msOf(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  let ingest = deps.ingest || null;
  let reconcile = deps.reconcile || null;
  const ingestOf = () => ingest || (ingest = require("./ingest").createIngest(deps));
  const reconcileOf = () => reconcile || (reconcile = require("./reconcile").createReconcile(deps));

  async function note(entry) {
    try {
      if (deps.events && typeof deps.events.log === "function") await deps.events.log(entry);
    } catch {
      // the activity log is best-effort
    }
  }

  // ── candidates ────────────────────────────────────────────────────────────

  async function candidates() {
    const owned = await M("CodeProduct").distinct("offer", { offer: { $ne: null } });
    const offers = await leanOf(
      M("AccountOffer")
        .find({ status: "active", _id: { $nin: owned } })
        .select("_id title game priceUsd")
        .sort({ _id: 1 }),
    );
    if (!offers || !offers.length) return [];

    const counts = await M("SuppliedAccount").aggregate([
      { $match: { offer: { $in: offers.map((o) => o._id) } } },
      { $group: { _id: { offer: "$offer", status: "$status" }, n: { $sum: 1 } } },
    ]);
    const byOffer = new Map();
    for (const c of counts || []) {
      const key = text(c._id && c._id.offer);
      if (!byOffer.has(key)) byOffer.set(key, emptyByStatus());
      const status = text(c._id && c._id.status);
      if (STATUSES.includes(status)) byOffer.get(key)[status] += c.n || 0;
    }

    const out = [];
    for (const offer of offers) {
      const units = byOffer.get(String(offer._id)) || emptyByStatus();
      if (units.available + units.fed + units.sold === 0) continue;
      const first = await leanOf(
        M("SuppliedAccount")
          .findOne({ offer: offer._id, status: { $ne: "removed" } })
          .select("password")
          .sort({ _id: 1 }),
      );
      if (!first || !parseUnit(secret, first.password).ok) continue;
      out.push({
        offerId: String(offer._id),
        title: text(offer.title),
        game: text(offer.game),
        priceUsd: num(offer.priceUsd),
        units,
      });
    }
    return out;
  }

  // ── adopt ─────────────────────────────────────────────────────────────────

  // One adopt at a time per process: two at once could each mint a product
  // for the same offer.
  let chain = Promise.resolve();
  function adopt(offerId, opts = {}) {
    const run = chain.then(() => adoptOnce(offerId, opts));
    chain = run.catch(() => {});
    return run;
  }

  async function adoptOnce(offerId, { apply = false, actor = "" } = {}) {
    const id = toObjectId(offerId);
    // `problems` are sentences for the panel; `details` the same, with where
    // (unit, line, label, codeShape, slot) for anything that wants to point.
    const refuse = (list, report = null) => ({
      ok: false,
      applied: false,
      problems: list.map((p) => p.msg),
      details: list,
      report,
    });
    if (!id) return refuse([{ kind: "offer_missing", msg: "no such offer" }]);
    const offer = await leanOf(M("AccountOffer").findById(id));
    if (!offer) return refuse([{ kind: "offer_missing", msg: "no such offer" }]);
    if (offer.status !== "active") {
      return refuse([{ kind: "offer_not_active", msg: `the offer is ${text(offer.status) || "not active"}, not active` }]);
    }

    // The ledger must know every stored code before the units are matched.
    await ingestOf().run();

    const units = await leanOf(
      M("SuppliedAccount")
        .find({ offer: id })
        .select("_id login password status market listing contentId orderId fedAt soldAt deliveredAt")
        .sort({ _id: 1 }),
    );
    const byStatus = emptyByStatus();
    for (const u of units || []) if (STATUSES.includes(u.status)) byStatus[u.status] += 1;
    const live = (units || []).filter((u) => u.status !== "removed");
    const removed = (units || []).filter((u) => u.status === "removed");

    const problems = [];
    const where = (u, extra = {}) => ({ unitId: String(u._id), login: text(u.login), ...extra });

    // Parse every unit on the shelf (or sold off it); removed ones only to
    // find codes that may have gone out through a market.
    const parsed = [];
    for (const u of live) {
      const p = parseUnit(secret, u.password);
      if (!p.ok) {
        problems.push({ kind: "unparsable", msg: `unit ${text(u.login)}: ${p.why}`, ...where(u) });
        continue;
      }
      if (availableButMarked(u)) {
        problems.push({
          kind: "unit_marked",
          msg: `unit ${text(u.login)} is on sale but carries vault or delivery marks: the shop would have to take it off sale`,
          ...where(u),
        });
      }
      parsed.push({ unit: u, lines: p.lines });
    }
    if (!live.length) problems.push({ kind: "no_units", msg: "the offer has no unit on sale or sold" });

    // The same code twice in this offer: it can only be in one unit.
    const seenHash = new Map();
    for (const { unit, lines } of parsed) {
      lines.forEach((l, i) => {
        const prev = seenHash.get(l.hash);
        if (prev) {
          problems.push({
            kind: "duplicate_code",
            msg: `unit ${text(unit.login)} line ${i + 1} holds the same code as unit ${prev.login} line ${prev.line}`,
            ...where(unit, { line: i + 1, label: l.label, codeShape: l.shape }),
          });
        } else {
          seenHash.set(l.hash, { login: text(unit.login), line: i + 1 });
        }
      });
    }

    const removedOut = [];
    for (const u of removed) {
      if (!hasMarketMarks(u)) continue;
      const p = parseUnit(secret, u.password);
      if (p.ok) removedOut.push({ unit: u, lines: p.lines });
    }

    const hashes = new Set();
    for (const { lines } of parsed) for (const l of lines) hashes.add(l.hash);
    for (const { lines } of removedOut) for (const l of lines) hashes.add(l.hash);
    const rows = hashes.size
      ? await leanOf(
          M("CodeStock")
            .find({ codeHash: { $in: [...hashes] } })
            .select("_id codeHash state unit product offer slotKey groupKey gameNo gameName nameRaw image campaignTitle"),
        )
      : [];
    const rowByHash = new Map((rows || []).map((r) => [r.codeHash, r]));

    // Every line: its ledger row, and whether it is free, already ours, or not.
    let alreadyLinked = 0;
    const toLink = new Map(); // unitId -> [row ids]
    for (const { unit, lines } of parsed) {
      const ids = [];
      lines.forEach((l, i) => {
        const row = rowByHash.get(l.hash);
        l.row = row || null;
        const at = where(unit, { line: i + 1, label: l.label, codeShape: l.shape });
        if (!row) {
          problems.push({ kind: "unknown_code", msg: `unit ${text(unit.login)} line ${i + 1}: this code is not in the stock ledger`, ...at });
          return;
        }
        if (row.unit && String(row.unit) === String(unit._id)) {
          alreadyLinked += 1;
          return;
        }
        if (row.state === "in_stock" && !row.unit) {
          ids.push(row._id);
          return;
        }
        problems.push({
          kind: row.unit ? "in_other_unit" : "not_in_stock",
          msg: row.unit
            ? `unit ${text(unit.login)} line ${i + 1}: this code is already in another unit (${row.state})`
            : `unit ${text(unit.login)} line ${i + 1}: this code is ${row.state}, not in stock`,
          state: text(row.state),
          ...at,
        });
      });
      if (ids.length) toLink.set(String(unit._id), ids);
    }

    // Every unit must have the same number of lines, and line N the same slot.
    const countOf = new Map();
    for (const { lines } of parsed) countOf.set(lines.length, (countOf.get(lines.length) || 0) + 1);
    let lineCount = 0;
    let best = 0;
    for (const { lines } of parsed) {
      const n = countOf.get(lines.length);
      if (n > best) {
        best = n;
        lineCount = lines.length;
      }
    }
    const ref = []; // line index -> { slotKey, row, login }
    for (const { unit, lines } of parsed) {
      if (lines.length !== lineCount) {
        problems.push({
          kind: "line_count",
          msg: `unit ${text(unit.login)} has ${lines.length} codes, the other units have ${lineCount}`,
          ...where(unit),
        });
        continue;
      }
      lines.forEach((l, i) => {
        if (l.row && !ref[i]) ref[i] = { slotKey: text(l.row.slotKey), row: l.row, login: text(unit.login) };
      });
    }
    for (const { unit, lines } of parsed) {
      if (lines.length !== lineCount) continue;
      const inUnit = new Map();
      lines.forEach((l, i) => {
        if (!l.row) return;
        const slotKey = text(l.row.slotKey);
        const at = where(unit, { line: i + 1, label: l.label, codeShape: l.shape, slotKey });
        if (inUnit.has(slotKey)) {
          problems.push({
            kind: "duplicate_slot",
            msg: `unit ${text(unit.login)} lines ${inUnit.get(slotKey)} and ${i + 1} hold two codes of the same reward slot`,
            ...at,
          });
        } else {
          inUnit.set(slotKey, i + 1);
        }
        const want = ref[i];
        if (want && want.slotKey !== slotKey) {
          problems.push({
            kind: "slot_mismatch",
            msg:
              `unit ${text(unit.login)} line ${i + 1} holds a different reward than unit ${want.login} line ${i + 1}` +
              (rewardOf(want.slotKey) === rewardOf(slotKey) ? " (the same reward name, another step)" : ""),
            expectedSlotKey: want.slotKey,
            sameReward: rewardOf(want.slotKey) === rewardOf(slotKey),
            ...at,
          });
        }
      });
    }

    // The product's slots, in line order, labelled with the units' own words
    // (the most used label of each line; the first unit's on a tie).
    const slots = [];
    for (let i = 0; i < lineCount; i += 1) {
      const want = ref[i];
      const votes = new Map();
      for (const { lines } of parsed) {
        if (lines.length !== lineCount) continue;
        const label = lines[i].label;
        votes.set(label, (votes.get(label) || 0) + 1);
      }
      let label = "";
      let top = 0;
      for (const [l, n] of votes) {
        if (n > top) {
          top = n;
          label = l;
        }
      }
      slots.push({
        slotKey: want ? want.slotKey : "",
        label,
        image: want ? text(want.row.image) : "",
        nameRaw: want ? text(want.row.nameRaw) : "",
        campaignTitle: want ? text(want.row.campaignTitle) : "",
      });
    }

    const existing = await leanOf(M("CodeProduct").find({ offer: id }).sort({ _id: 1 }));
    if (existing && existing.length > 1) {
      problems.push({ kind: "product_conflict", msg: `${existing.length} products already own this offer` });
    }
    const product = existing && existing.length ? existing[0] : null;
    if (product && !problems.length) {
      const have = (product.slots || []).map((s) => text(s && s.slotKey));
      const want = slots.map((s) => s.slotKey);
      if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
        problems.push({
          kind: "product_mismatch",
          msg: "the product that already owns this offer has different slots than its units",
          productId: String(product._id),
        });
      }
    }

    // Codes of removed units that went out through a market: held on apply,
    // unless a unit on the shelf holds them (that link is the truth).
    const toHold = [];
    for (const { lines } of removedOut) {
      for (const l of lines) {
        const row = rowByHash.get(l.hash);
        if (!row || seenHash.has(l.hash)) continue;
        if (row.state === "in_stock" && !row.unit) toHold.push(row._id);
      }
    }

    const codes = parsed.reduce((n, p) => n + p.lines.length, 0);
    const linkCount = [...toLink.values()].reduce((n, ids) => n + ids.length, 0);
    const report = {
      offerId: String(id),
      title: text(offer.title),
      units: live.length,
      codes,
      slots: slots.map((s) => ({ label: s.label, slotKey: s.slotKey })),
      byStatus,
      toLink: linkCount,
      alreadyLinked,
      removedToHold: toHold.length,
      productId: product ? String(product._id) : null,
    };

    if (problems.length) return refuse(problems, report);
    // Only a real `true` writes: a stray "false" string must stay a dry run.
    if (apply !== true) return { ok: true, applied: false, problems: [], details: [], report };

    // ── apply ───────────────────────────────────────────────────────────────
    // Link first, create the product after: a product that is active before
    // its units' codes are linked could be filled from those very codes.
    const now = clock();
    const at = new Date(now);
    const productId = product ? product._id : new ObjectId();
    const CodeStock = M("CodeStock");
    let linked = 0;
    const shortfall = [];
    for (const { unit } of parsed) {
      const ids = toLink.get(String(unit._id));
      if (!ids || !ids.length) continue;
      const $set = { state: "in_unit", unit: unit._id, product: productId, offer: id, unitStatus: unit.status };
      // A vault can hand its copy out without telling us: keep the mark.
      if (unit.status === "fed") $set.wasFed = true;
      const res = await CodeStock.updateMany(
        { _id: { $in: ids }, state: "in_stock", unit: null },
        {
          $set,
          $push: { history: { $each: [{ at, from: "in_stock", to: "in_unit", why: WHY_ADOPTED }], $slice: -HISTORY_MAX } },
        },
      );
      const won = (res && res.modifiedCount) || 0;
      linked += won;
      // Lost rows moved out of stock between the check and the write. The
      // rows that won ARE in this live unit, so they stay linked.
      if (won < ids.length) shortfall.push({ unitId: String(unit._id), login: text(unit.login), missed: ids.length - won });
    }

    // A crashed earlier apply may have linked rows to a product id it never
    // created: point every row of these units at the product that owns them.
    const liveIds = parsed.map((p) => p.unit._id);
    await CodeStock.updateMany({ unit: { $in: liveIds }, product: { $ne: productId } }, { $set: { product: productId, offer: id } });

    let held = 0;
    if (toHold.length) {
      const res = await CodeStock.updateMany(
        { _id: { $in: toHold }, state: "in_stock", unit: null },
        {
          $set: { state: "held", problem: WHY_REMOVED_OUT },
          $push: { history: { $each: [{ at, from: "in_stock", to: "held", why: WHY_REMOVED_OUT }], $slice: -HISTORY_MAX } },
        },
      );
      held = (res && res.modifiedCount) || 0;
    }

    let created = false;
    if (!product) {
      const first = (ref.find(Boolean) || {}).row || null;
      const listings = await M("MarketplaceListing").distinct("marketplace", { accountOffer: id, status: "active" });
      const markets = MARKETS.filter((m) => (listings || []).includes(m));
      const groupKeys = [];
      for (const r of ref) if (r && r.row.groupKey && !groupKeys.includes(r.row.groupKey)) groupKeys.push(r.row.groupKey);
      await M("CodeProduct").create({
        _id: productId,
        name: text(offer.title),
        gameNo: first ? text(first.gameNo) : "",
        gameName: first ? text(first.gameName) : "",
        marketGame: text(offer.game),
        groupKeys,
        slots,
        slotSetHash: slotsLib.slotSetHash(slots.map((s) => s.slotKey)),
        status: "active",
        origin: "adopted",
        kind: "custom",
        offer: id,
        texts: {
          title: text(offer.title),
          description: text(offer.description),
          deliveryTemplate: text(offer.deliveryTemplate),
          coverTitle: "",
          coverServiceText: text(offer.coverServiceText),
          coverBullets: Array.isArray(offer.coverBullets) ? offer.coverBullets.map(text) : [],
        },
        pricing: {
          mode: "fixed",
          priceUsd: num(offer.priceUsd),
          floorUsd: Math.max(MIN_FLOOR_USD, num(offer.minPriceUsd)),
          clearance: false,
          followCompetitors: false,
        },
        markets,
        approvedAt: at,
        approvedBy: text(actor),
        note: "adopted from a hand-made offer",
      });
      created = true;
    }

    // Sold / fed units: their codes follow the unit's status.
    let reconciled = null;
    let reconcileError = "";
    try {
      reconciled = await reconcileOf().run();
    } catch (err) {
      reconcileError = text(err && err.message).slice(0, 200);
    }

    if (created || linked || held) {
      await note({
        level: "info",
        kind: "adopt",
        product: productId,
        msg: `Adopted "${text(offer.title).slice(0, 120)}": ${live.length} bundles, ${linked} codes linked` + (held ? `, ${held} held` : ""),
        data: { offer: String(id), units: live.length, codes, linked, alreadyLinked, held, created, byStatus, actor: text(actor) },
      });
    }
    if (shortfall.length) {
      await note({
        level: "error",
        kind: "adopt",
        product: productId,
        msg: `Adopting "${text(offer.title).slice(0, 120)}": ${shortfall.reduce((n, s) => n + s.missed, 0)} code(s) left stock while being linked — they may be in two bundles now; check by hand`,
        data: { offer: String(id), shortfall },
      });
    }
    if (reconcileError) {
      await note({ level: "warn", kind: "adopt", product: productId, msg: "Adopted, but settling sold units failed: " + reconcileError });
    }

    return {
      ok: true,
      applied: true,
      problems: [],
      details: [],
      report,
      productId: String(productId),
      created,
      linked,
      alreadyLinked,
      held,
      shortfall,
      reconciled,
      reconcileError,
    };
  }

  return { candidates, adopt };
}

module.exports = { createAdopt, LINE_RE };
