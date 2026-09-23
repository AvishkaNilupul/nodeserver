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

// The keys that carry a PASTED ACCOUNT LIST verbatim (review finding F6).
// public/listings.html POSTs the whole supplied-stock paste as
// `{ accounts: "<login:password:token:email…>" }`, express.json parses it before
// middleware/auditRequest.js summarizes EVERY mutating body, and none of those
// key names look secret — so a real login and a working password were persisted
// here in cleartext on every outcome (403s and 500s included, because the body
// is summarized before the router runs) and rendered verbatim by
// public/activity.html for the whole 90-day TTL. models/SystemEvent.js:28 says
// meta is NEVER a secret; this list is what makes that true for every route,
// present and future — it lives HERE, at the one chokepoint every logEvent
// caller passes through, and deliberately NOT in the middleware, so it cannot
// drift into four copies the way utils/marketClaimTags.js did.
//
// `logins` is deliberately absent: logins are printed on the listing, they are
// half the debugging value, and several callers log them on purpose
// (utils/botFactory.js, utils/suspendedAccounts.js).
const PASTE_KEY =
  /^(accounts?|accountstext|accountlist|badlines|lines|text|paste|pasted|creds|credentials|stock|stocktext)$/i;

// Belt and braces for a paste that arrives under a key nobody thought of.
// utils/suppliedStock.js parses stock as "login:password[:token[:email[:extra]]]",
// one account per line, so that SHAPE is the leak whatever the field is called.
// Deliberately narrow, because meta is where the diagnostics live and a
// too-eager mask costs the row its whole point:
//   - a URL ("https://…") splits on ":" but is not a credential;
//   - a 1-5 digit second field is a port, a clock time or the middle of an ISO
//     timestamp, never a password (a longer all-digit one is still masked);
//   - both fields must be whitespace-free, so prose like "error: no such offer"
//     and "Username: bob" survive untouched.
// The labelled "Password: x" shape is handled by utils/marketplaceLog.js's own
// masker, which cannot be reused from here — it requires THIS module.
const CRED_LINE = /^[^\s:]{3,}:[^\s:]{3,}(?::[^\s:]*)*$/;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

function looksLikeCredentialLine(line) {
  if (!CRED_LINE.test(line) || URLISH.test(line)) return false;
  return !/^\d{1,5}$/.test(line.split(":")[1]);
}

// Redact per LINE, not per value: a meta string is far more often a summary
// that happens to contain one pasted line than a pure credential dump, and the
// lines that survive are what keep the row worth reading.
function redactCredentialLines(s) {
  if (!s.includes(":")) return s;
  return s
    .split(/\r?\n/)
    .map((l) => (looksLikeCredentialLine(l.trim()) ? "[redacted]" : l))
    .join("\n");
}

// The array-count placeholder middleware/auditRequest.js:38 writes ("[" +
// v.length + "]") for an array body value. It reaches sanitize() as a STRING,
// so the string branch below redacted it and the row lost "how many" — the one
// thing the body summary exists to record (review finding G6). A bracketed
// integer is the middleware's own arithmetic, never a byte of the paste: a
// credential line always carries a ":" and at least one non-digit, so nothing
// that matches this can be a credential. Bounded on purpose — anything longer
// or with text around it ("[3] login:pw") is not a count and stays redacted.
const SUMMARY_COUNT = /^\[\d{1,9}\]$/;

// A paste reaches meta either as one blob or as the array of lines it was split
// into (suppliedStock's badLines[] — and an UNPARSABLE line is exactly the one
// whose password landed in the wrong column, so it is not the safe half).
function redactPaste(value, depth) {
  if (typeof value === "string")
    return SUMMARY_COUNT.test(value) ? value : "[redacted]";
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((v) => (typeof v === "string" ? "[redacted]" : sanitize(v, depth)));
  // A count (`accounts: 12`) is not a credential, and the audit log's value is
  // that it says what changed — leave every non-string shape alone.
  return sanitize(value, depth);
}

// Deep-copy a value, redacting secret-looking keys and capping size/depth so an
// audit row can never leak a token/password nor bloat the bytes-bound Atlas tier.
function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    const s = redactCredentialLines(value);
    return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + "…" : s;
  }
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
    // F6: drop a pasted list wholesale rather than trusting the shape guard to
    // recognise the 40-character slice middleware/auditRequest.js keeps of it.
    if (PASTE_KEY.test(k)) {
      out[k] = redactPaste(value[k], depth + 1);
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
    // `detail` is free text rendered by public/activity.html exactly like meta,
    // so it gets the same F6 shape guard — meta was the leak we found, but a
    // route dropping the paste in here would be the identical incident. Only
    // the SHAPE guard: `detail` is prose (it always contains whitespace), and
    // `subject` is left alone because it holds a title, which may legitimately
    // read "GGSel:RocketLeague" and is looked up by exact string.
    if (typeof doc.detail === "string")
      doc.detail = redactCredentialLines(doc.detail);
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
