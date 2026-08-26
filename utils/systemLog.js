const SystemEvent = require("../models/SystemEvent");

// Central audit helper. Mirrors the best-effort contract of
// utils/autoFarmEventLog.js / utils/poolUsageLog.js: a logging failure (Mongo
// down, malformed doc) must NEVER surface to the caller, and callers on a hot
// path can fire-and-forget (no await). See models/SystemEvent.js.

// Keys whose VALUES must never be stored — redacted anywhere they appear in a
// meta object (request bodies, event details, nested objects).
const SECRET_KEY =
  /(secret|password|passwd|token|credpassword|clientsecret|cookie|authorization|apikey|api[_-]?key|otp|2fa)/i;
const MAX_DETAIL = 500;
const MAX_META_CHARS = 2000;

// Deep-copy a value, redacting secret-looking keys and capping size/depth so an
// audit row can never leak a token/password nor bloat the bytes-bound Atlas tier.
function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string")
    return value.length > MAX_DETAIL ? value.slice(0, MAX_DETAIL) + "…" : value;
  if (typeof value !== "object") return value;
  if (depth > 4) return "[deep]";
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitize(value[k], depth + 1);
  }
  return out;
}

function capMeta(meta) {
  if (meta == null) return undefined;
  let clean;
  try {
    clean = sanitize(meta);
    const s = JSON.stringify(clean);
    if (s && s.length > MAX_META_CHARS)
      return { note: "meta truncated", size: s.length };
  } catch {
    return undefined;
  }
  return clean;
}

// Write one audit event. Best-effort — swallows every error.
async function logEvent(fields = {}) {
  try {
    if (!fields || (!fields.category && !fields.action)) return;
    const doc = {
      at: new Date(),
      category: "",
      action: "",
      actor: "system",
      severity: "info",
      subject: "",
      count: 0,
      game: "",
      host: "",
      container: "",
      detail: "",
      method: "",
      route: "",
      status: 0,
      sessionId: "",
      ...fields,
    };
    if (typeof doc.detail === "string" && doc.detail.length > MAX_DETAIL)
      doc.detail = doc.detail.slice(0, MAX_DETAIL) + "…";
    if (typeof doc.subject === "string" && doc.subject.length > 200)
      doc.subject = doc.subject.slice(0, 200);
    const meta = capMeta(fields.meta);
    if (meta === undefined) delete doc.meta;
    else doc.meta = meta;
    await SystemEvent.create(doc);
  } catch (e) {
    // The whole point is that a failed audit write is harmless.
    console.error("logEvent failed:", e && e.message);
  }
}

// Resolve the actor string for an HTTP request from whichever tenant session it
// carries (admin / renter / reseller), else "anon".
function actorFromReq(req) {
  try {
    const s = req && req.session;
    if (s) {
      if (s.admin && s.admin.id) return "admin:" + s.admin.id;
      if (s.renter && s.renter.id) return "renter:" + s.renter.id;
      if (s.reseller && s.reseller.id) return "reseller:" + s.reseller.id;
    }
  } catch {
    /* ignore */
  }
  return "anon";
}

module.exports = { logEvent, actorFromReq, sanitize };
