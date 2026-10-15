// Code shop activity log and alert stamps (docs/code-shop/01-DATA.md).
//
// One collection (CodeShopEvent, 30-day TTL on `at`) serves two jobs:
// - log()/recent(): what the shop did, for the panel. Logging is best-effort —
//   a failed write goes to console.error and never breaks the caller.
// - stamp()/has(): "this alert was already sent". The unique partial index on
//   `stampKey` makes stamp() an atomic claim: of any number of concurrent calls
//   with one key, exactly one gets `true`. Stamps expire with the TTL too, so a
//   key must carry whatever makes it unique for longer than 30 days.
//
// Callers must not put codes, cookies or passwords in `msg` / `data`.

const LEVELS = new Set(["info", "warn", "error"]);
const MAX_MSG = 500;
const MAX_LIMIT = 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

function leanOf(q) {
  return q && typeof q.lean === "function" ? q.lean() : q;
}

function isDuplicateKey(err) {
  return !!err && (err.code === 11000 || err.code === 11001);
}

function stampKeyOf(key) {
  const k = typeof key === "number" && Number.isFinite(key) ? String(key) : key;
  if (typeof k !== "string" || k === "") throw new TypeError("code-shop stamp key must be a non-empty string");
  return k;
}

// A filter value from a query string: a string (or list of strings), never an
// object a caller could smuggle an operator in.
function textFilter(v) {
  if (Array.isArray(v)) return { $in: v.map(String) };
  return String(v);
}

function createEvents({ model, now = Date.now } = {}) {
  // Resolved on first use so a test can pass its own model and the real one
  // never has to load.
  const getModel = () => model || (model = require("../../models/CodeShopEvent"));

  // Never throws or rejects. Resolves true when the row was saved.
  async function log({ level = "info", kind = "", product = null, msg = "", data = null } = {}) {
    let text = "";
    try {
      const lvl = LEVELS.has(level) ? level : "info";
      text = String(msg == null ? "" : msg).slice(0, MAX_MSG);
      if (lvl !== "info") console.log("[code-shop] " + text);
      await getModel().create({
        at: new Date(now()),
        level: lvl,
        kind: String(kind == null ? "" : kind),
        product: product || null,
        msg: text,
        data: data === undefined ? null : data,
      });
      return true;
    } catch (err) {
      try {
        console.error("[code-shop] event not saved (" + String(kind) + "): " + (err && err.message));
      } catch (_) {
        // a broken console must not break the caller either
      }
      return false;
    }
  }

  // Newest first, lean. `kind` / `level` take a string or a list of strings.
  async function recent({ limit = 100, kind, product, level } = {}) {
    const q = {};
    if (kind !== undefined && kind !== null && kind !== "") q.kind = textFilter(kind);
    if (level !== undefined && level !== null && level !== "") q.level = textFilter(level);
    if (product !== undefined && product !== null && product !== "") {
      const id = String(product);
      if (!OBJECT_ID.test(id)) return []; // nothing can match; not worth a CastError
      q.product = id;
    }
    const n = Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), MAX_LIMIT);
    return leanOf(getModel().find(q).sort({ at: -1, _id: -1 }).limit(n));
  }

  // true: this call created the stamp. false: it already existed. Any other
  // database error is thrown — neither answer would be true then, and a caller
  // that guessed would either repeat an alert or swallow one.
  async function stamp(key, { kind = "stamp", msg = "" } = {}) {
    const stampKey = stampKeyOf(key);
    try {
      await getModel().create({
        at: new Date(now()),
        level: "info",
        kind: String(kind || "stamp"),
        msg: String(msg == null ? "" : msg).slice(0, MAX_MSG),
        stampKey,
      });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  }

  async function has(key) {
    if (typeof key === "number" && Number.isFinite(key)) key = String(key);
    if (typeof key !== "string" || key === "") return false;
    return !!(await getModel().exists({ stampKey: key }));
  }

  return { log, recent, stamp, has };
}

module.exports = { createEvents };
