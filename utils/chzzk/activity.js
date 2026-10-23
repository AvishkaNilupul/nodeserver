// CHZZK farm activity log (docs/CHZZK-FARM.md §7).
//
// What happened, newest first: a bounded ring in memory plus a copy in Mongo
// (ChzzkActivity, 14-day TTL) so the history survives a restart. Writes are
// best-effort — a failed write is dropped, never retried, and never allowed
// to break the caller.
//
// Callers must not put cookies or reward codes in `msg` / `data`.

const LEVELS = ["info", "warn", "error"];
const MAX_MSG = 500;
const MEM_CAP = 200;

function idOrNull(v) {
  return v === undefined || v === null || v === "" ? null : String(v);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Default singleton (used by the farm wiring). Tests pass their own model.
function createActivity({ model, cap = MEM_CAP, now = Date.now } = {}) {
  const size = Math.max(1, Number(cap) || MEM_CAP);
  const ring = []; // newest at the end
  let seq = 0;
  // Resolved lazily so tests can create an activity log without the real model loading.
  const getModel = () => model || (model = require("../../models/ChzzkActivity"));

  function add(input) {
    let entry;
    try {
      const e = input || {};
      entry = {
        id: `${now().toString(36)}-${(seq++).toString(36)}`,
        at: new Date(now()),
        level: LEVELS.includes(e.level) ? e.level : "info",
        kind: e.kind ? String(e.kind) : "note",
        accountId: idOrNull(e.accountId),
        campaignNo: numOrNull(e.campaignNo),
        msg: String(e.msg === undefined || e.msg === null ? "" : e.msg).slice(0, MAX_MSG),
        data: e.data === undefined ? null : e.data,
      };
      ring.push(entry);
      if (ring.length > size) ring.splice(0, ring.length - size);
    } catch (err) {
      // Logging is never a reason for the farm to fail.
      console.error("chzzk activity add error:", err.message);
      return null;
    }
    // Write-through to Mongo, best effort. We fire and swallow the promise.
    try {
      const Mod = getModel();
      if (Mod && typeof Mod.create === "function") {
        const { id: _id, ...doc } = entry;
        Promise.resolve(Mod.create(doc)).catch(() => {});
      }
    } catch {
      /* no model, no network — the in-memory ring still has it */
    }
    return entry;
  }

  // Newest first. Falls back to the in-memory ring when Mongo is unreachable.
  async function list({ limit = 100, accountId } = {}) {
    // Mongo answers up to 500 (the route's cap); only the in-memory fallback
    // is limited to what the ring holds.
    const max = Math.min(500, Math.max(1, Number(limit) || 100));
    try {
      const Mod = getModel();
      if (Mod && typeof Mod.find === "function") {
        const q = {};
        if (accountId) q.accountId = String(accountId);
        const rows = await Mod.find(q).sort({ at: -1 }).limit(max).lean();
        if (Array.isArray(rows)) {
          return rows.map((r) => ({
            at: r.at,
            level: r.level || "info",
            kind: r.kind || "note",
            accountId: r.accountId == null ? null : String(r.accountId),
            campaignNo: r.campaignNo == null ? null : Number(r.campaignNo),
            msg: r.msg || "",
            data: r.data == null ? null : r.data,
          }));
        }
      }
    } catch {
      /* fall through to memory */
    }
    const out = [];
    for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
      const e = ring[i];
      if (accountId && e.accountId !== String(accountId)) continue;
      out.push({
        at: e.at,
        level: e.level,
        kind: e.kind,
        accountId: e.accountId,
        campaignNo: e.campaignNo,
        msg: e.msg,
        data: e.data,
      });
    }
    return out;
  }

  function recent() {
    return ring.slice();
  }

  return { add, list, recent };
}

module.exports = { createActivity };
