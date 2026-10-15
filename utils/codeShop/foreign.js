"use strict";
// Code shop foreign-stock guard: a code the ledger holds as free stock may
// ALREADY be on sale in a stock row the shop does not own — a hand-made
// listing that was never adopted (the very first one used `login = owkey-<n>`,
// `password = <CODE>`; later ones use "N) Label = CODE" lines). Left alone,
// fill could put that code into one of our bundles and it would sell twice.
//
// Every SuppliedAccount row that is on sale, in a vault or sold
// (available | fed | sold) and is not one of our units (no ledger row points
// at it) is decrypted (password and extra), cut into tokens, and each token
// hashed and looked up in the ledger:
// - a free row (in_stock / expiring) is held, with a problem that names the
//   stock row, so adopt.js can link it once that listing is adopted;
// - a row already in one of OUR units (in_unit / sold) is a conflict the shop
//   cannot settle by itself: one error event and one Telegram line per pair,
//   once (stamp `foreign-conflict:<suppliedId>:<ledgerId>`). Nothing changes.
//
// A held code goes back to stock once its stock row lets it go: the row is
// gone, or it was removed without any mark of having gone out through a
// market (it never reached a buyer). Removed WITH marks, or still on sale, in
// a vault or sold: it stays held. If the stock rows cannot be read, nothing is
// released that run.
//
// A row is decrypted once per process until its updatedAt moves; the cache
// keeps only hashes. Never a code or a token in a log, event, message or
// return value. This module writes ledger rows only — never a SuppliedAccount.

const slots = require("./slots");

const HISTORY_MAX = 20;
const BATCH = 500;
const LIVE_STATUSES = ["available", "fed", "sold"];
const FREE_STATES = ["in_stock", "expiring"];
const OURS_STATES = ["in_unit", "sold"];
const TOKEN_SPLIT = /[\s=:,;|]+/;
const PROBLEM_PREFIX = "in a stock row of another listing (";
const PROBLEM_RE = /^in a stock row of another listing \(([0-9a-f]{24})\)$/;
const WHY_RELEASED = "its other listing let it go";

// Factories, not values: a test that passes its own models never loads these.
const REAL_MODELS = {
  CodeStock: () => require("../../models/CodeStock"),
  CodeProduct: () => require("../../models/CodeProduct"),
  AccountOffer: () => require("../../models/AccountOffer"),
  SuppliedAccount: () => require("../../models/SuppliedAccount"),
};

function modelOf(deps, name) {
  const given = deps && deps.models && deps.models[name];
  return given || REAL_MODELS[name]();
}

const text = (v) => (v === undefined || v === null ? "" : String(v));
const oneLine = (v) => text(v).replace(/\s+/g, " ").trim();

function msOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// The problem a held row carries; adopt.js reads it back to know which stock
// row the code sits in. Keep the wording exact.
function foreignProblem(suppliedId) {
  return `in a stock row of another listing (${text(suppliedId)})`;
}

// Marks a market leaves on a stock row that went out through it (a vault
// hand-off, a claim, a delivery). `listing` too: a market took the row.
function hasMarketMarks(row) {
  return !!(
    row &&
    (row.fedAt || row.soldAt || row.deliveredAt || text(row.market) || row.listing || text(row.contentId) || text(row.orderId))
  );
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Hashes of everything in a stock row that could be a code: each field whole
// (trimmed) and each token. The plaintext never leaves this function.
function hashesOf(secret, row) {
  const out = new Set();
  for (const field of [row.password, row.extra]) {
    let plain = "";
    try {
      plain = text(secret.decrypt(text(field)));
    } catch {
      plain = "";
    }
    const whole = plain.trim();
    if (!whole) continue;
    out.add(slots.hashCode(whole));
    for (const token of whole.split(TOKEN_SPLIT)) if (token) out.add(slots.hashCode(token));
  }
  return [...out];
}

function createForeignGuard(deps = {}) {
  const M = (name) => modelOf(deps, name);
  const secret = deps.secret || require("../secretBox");
  const clock = () => {
    const t = msOf(typeof deps.now === "function" ? deps.now() : Date.now());
    return t === null ? Date.now() : t;
  };
  // SuppliedAccount id -> { updatedAt: ms|null, hashes: [sha256] }
  const cache = new Map();

  async function note(entry) {
    try {
      if (deps.events && typeof deps.events.log === "function") await deps.events.log(entry);
    } catch {
      // the activity log is best-effort
    }
  }

  async function runOnce() {
    const at = new Date(clock());
    const out = { scanned: 0, decrypted: 0, held: 0, conflicts: 0, released: 0 };
    const SuppliedAccount = M("SuppliedAccount");
    const CodeStock = M("CodeStock");

    // Stock rows first, then which of them are ours: a unit units.build
    // finishes in between is then already known as ours.
    const listed = await SuppliedAccount.find({ status: { $in: LIVE_STATUSES } }, { _id: 1, offer: 1, status: 1, updatedAt: 1 })
      .sort({ _id: 1 })
      .lean();
    const ours = new Set((await CodeStock.distinct("unit", { unit: { $ne: null } })).map(String));
    const foreign = listed.filter((r) => !ours.has(String(r._id)));
    out.scanned = foreign.length;

    const keep = new Set(foreign.map((r) => String(r._id)));
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);

    const stale = foreign.filter((r) => {
      const c = cache.get(String(r._id));
      return !c || c.updatedAt !== msOf(r.updatedAt);
    });
    for (const part of chunks(stale, BATCH)) {
      const docs = await SuppliedAccount.find({ _id: { $in: part.map((r) => r._id) } }, { _id: 1, password: 1, extra: 1, updatedAt: 1 }).lean();
      for (const d of docs) {
        // The version actually read: a change after this read shows next run.
        cache.set(String(d._id), { updatedAt: msOf(d.updatedAt), hashes: hashesOf(secret, d) });
        out.decrypted += 1;
      }
    }

    // Before the ledger is read for matching: a code let go by one listing
    // but sitting in another is held again for that one in this same run.
    out.released = await releaseLetGo(at);

    const ledger = await CodeStock.find({ codeHash: { $gt: "" } }, { codeHash: 1, state: 1, unit: 1 }).lean();
    const byHash = new Map(ledger.map((r) => [r.codeHash, r]));

    // Oldest stock row first: a code found in two of them is held for the first.
    const hold = []; // [{ supplied, ids: { in_stock: [], expiring: [] } }]
    const conflicts = [];
    const taken = new Set();
    for (const s of foreign) {
      const sid = String(s._id);
      const c = cache.get(sid);
      if (!c) continue;
      const ids = { in_stock: [], expiring: [] };
      for (const h of c.hashes) {
        const row = byHash.get(h);
        if (!row) continue;
        // Its own unit (written after the ours-list was read): not foreign.
        if (row.unit && String(row.unit) === sid) continue;
        if (FREE_STATES.includes(row.state)) {
          const rid = String(row._id);
          if (taken.has(rid)) continue;
          taken.add(rid);
          ids[row.state].push(row._id);
        } else if (OURS_STATES.includes(row.state)) {
          conflicts.push({ supplied: s, row });
        }
      }
      if (ids.in_stock.length || ids.expiring.length) hold.push({ supplied: s, ids });
    }

    const heldBy = [];
    for (const { supplied, ids } of hold) {
      const problem = foreignProblem(supplied._id);
      let n = 0;
      for (const from of FREE_STATES) {
        if (!ids[from].length) continue;
        const res = await CodeStock.updateMany(
          { _id: { $in: ids[from] }, state: from },
          {
            $set: { state: "held", problem },
            $push: { history: { $each: [{ at, from, to: "held", why: problem }], $slice: -HISTORY_MAX } },
          },
        );
        n += (res && res.modifiedCount) || 0;
      }
      if (n) heldBy.push({ supplied: String(supplied._id), offer: text(supplied.offer), codes: n });
      out.held += n;
    }
    if (out.held) {
      await note({
        level: "warn",
        kind: "foreign-stock",
        msg: `Held ${out.held} code(s) that already sit in ${heldBy.length} stock row(s) of other listings`,
        data: { held: out.held, rows: heldBy.slice(0, 50) },
      });
    }

    out.conflicts = conflicts.length;
    if (conflicts.length) await alertConflicts(conflicts);
    return out;
  }

  // Held rows whose stock row is gone, or removed without a market mark, go
  // back to stock. Any read error: nothing is released this run.
  async function releaseLetGo(at) {
    const CodeStock = M("CodeStock");
    const held = new Map(); // stock row id -> [ledger row ids]
    const rows = [];
    try {
      const list = await CodeStock.find(
        { state: "held", problem: { $regex: "^" + escapeRe(PROBLEM_PREFIX) } },
        { _id: 1, problem: 1 },
      ).lean();
      for (const r of list) {
        const m = PROBLEM_RE.exec(text(r.problem));
        if (!m) continue;
        if (!held.has(m[1])) held.set(m[1], []);
        held.get(m[1]).push(r._id);
      }
      if (!held.size) return 0;
      for (const part of chunks([...held.keys()], BATCH)) {
        const found = await M("SuppliedAccount")
          .find(
            { _id: { $in: part } },
            { _id: 1, status: 1, fedAt: 1, contentId: 1, deliveredAt: 1, soldAt: 1, orderId: 1, market: 1, listing: 1 },
          )
          .lean();
        if (!Array.isArray(found)) throw new Error("stock rows came back unreadable");
        rows.push(...found);
      }
    } catch (err) {
      await note({
        level: "warn",
        kind: "foreign-stock",
        msg: "Could not read the other listings' stock rows; no held code is released this run: " + text(err && err.message).slice(0, 200),
      });
      return 0;
    }

    const byId = new Map(rows.map((r) => [String(r._id), r]));
    let released = 0;
    const letGo = [];
    for (const [sid, ids] of held) {
      const row = byId.get(sid);
      const free = !row || (row.status === "removed" && !hasMarketMarks(row));
      if (!free) continue;
      const res = await CodeStock.updateMany(
        { _id: { $in: ids }, state: "held", problem: foreignProblem(sid) },
        {
          $set: { state: "in_stock", problem: "", unit: null, product: null, offer: null, unitStatus: "" },
          $push: { history: { $each: [{ at, from: "held", to: "in_stock", why: WHY_RELEASED }], $slice: -HISTORY_MAX } },
        },
      );
      const n = (res && res.modifiedCount) || 0;
      if (n) letGo.push({ supplied: sid, gone: !row, codes: n });
      released += n;
    }
    if (released) {
      await note({
        level: "info",
        kind: "foreign-stock",
        msg: `${released} held code(s) back in stock: ${letGo.length} other listing stock row(s) were taken down unsold`,
        data: { released, rows: letGo.slice(0, 50) },
      });
    }
    return released;
  }

  // One error event and one Telegram line per (stock row, ledger row) pair,
  // once. Nothing is stamped when the Telegram send fails, so the next run
  // tells again rather than never.
  async function alertConflicts(conflicts) {
    const events = deps.events;
    if (!events || typeof events.has !== "function" || typeof events.stamp !== "function") return; // no way to say it only once
    const fresh = [];
    for (const c of conflicts) {
      const key = `foreign-conflict:${String(c.supplied._id)}:${String(c.row._id)}`;
      try {
        if (!(await events.has(key))) fresh.push({ ...c, key });
      } catch {
        // unknown: try again next run
      }
    }
    if (!fresh.length) return;

    const offerIds = [...new Set(fresh.map((c) => text(c.supplied.offer)).filter(Boolean))];
    const offers = offerIds.length ? await M("AccountOffer").find({ _id: { $in: offerIds } }, { title: 1 }).lean() : [];
    const titleOf = new Map(offers.map((o) => [String(o._id), oneLine(o.title).slice(0, 80)]));
    const rows = await M("CodeStock")
      .find({ _id: { $in: fresh.map((c) => c.row._id) } }, { product: 1 })
      .lean();
    const productOf = new Map(rows.map((r) => [String(r._id), r.product || null]));
    const productIds = [...new Set(rows.map((r) => text(r.product)).filter(Boolean))];
    const products = productIds.length ? await M("CodeProduct").find({ _id: { $in: productIds } }, { name: 1 }).lean() : [];
    const nameOf = new Map(products.map((p) => [String(p._id), oneLine(p.name).slice(0, 80)]));

    for (const c of fresh) {
      const product = productOf.get(String(c.row._id)) || null;
      const name = nameOf.get(text(product)) || "code";
      const listing = titleOf.get(text(c.supplied.offer)) || "another listing";
      c.product = product;
      c.line =
        `Code shop: a code in our ${name} bundle (${c.row.state === "sold" ? "sold" : "on sale"}) also sits in stock row ` +
        `${String(c.supplied._id)} (${text(c.supplied.status)}) of "${listing}": it can sell twice, take one of them down by hand`;
    }

    const telegram = deps.telegram;
    if (telegram && typeof telegram.send === "function") {
      try {
        await telegram.send(fresh.map((c) => c.line).join("\n"));
      } catch (err) {
        await note({
          level: "error",
          kind: "foreign-conflict",
          msg: `${fresh.length} code(s) can sell twice, and the Telegram alert failed (told again next run): ` + text(err && err.message).slice(0, 200),
          data: { pairs: fresh.slice(0, 50).map((c) => ({ supplied: String(c.supplied._id), ledger: String(c.row._id) })) },
        });
        return;
      }
    }
    for (const c of fresh) {
      let stamped = false;
      try {
        stamped = (await events.stamp(c.key, { kind: "foreign-conflict", msg: c.line })) === true;
      } catch {
        stamped = false; // told already; at worst told once more next run
      }
      if (!stamped) continue;
      await note({
        level: "error",
        kind: "foreign-conflict",
        product: c.product,
        msg: c.line,
        data: { supplied: String(c.supplied._id), offer: text(c.supplied.offer), ledger: String(c.row._id), unit: text(c.row.unit), state: text(c.row.state) },
      });
    }
  }

  // One run at a time per process: a second caller shares the running one.
  let running = null;
  function run() {
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return { run };
}

module.exports = { createForeignGuard, foreignProblem };
