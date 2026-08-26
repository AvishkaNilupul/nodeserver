const { logEvent, actorFromReq } = require("../utils/systemLog");

// Records every MUTATING HTTP request (POST/PUT/PATCH/DELETE) after it finishes:
// who (session actor), what route, and the status — the "who did it" half of the
// audit trail. Reads/static/asset requests are ignored so the log stays a record
// of CHANGES, not traffic. Fire-and-forget on res 'finish' — it can never block
// or break a request. Mounted once in server.js, after the session middleware.
//
// NOTE: raw `node -e` scripts (run outside the app) bypass HTTP and so won't
// appear here — those are caught by the model-level instrumentation in later
// phases instead.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ASSET_RE = /\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|map|woff2?|ttf|json)$/i;
// High-frequency internal endpoints that would drown the log without recording a
// meaningful change. Matched as a path prefix.
const SKIP_PREFIXES = ["/auto-farm/tick"];

// A tiny, redaction-safe summary of the body: top-level keys with scalar sizes,
// so we know WHAT KIND of action ran without storing payloads. logEvent's own
// sanitize() still redacts any secret-looking keys before persistence.
function summarizeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (!keys.length) return undefined;
  const out = {};
  for (const k of keys.slice(0, 20)) {
    const v = body[k];
    if (Array.isArray(v)) out[k] = "[" + v.length + "]";
    else if (v && typeof v === "object") out[k] = "{obj}";
    else if (typeof v === "string")
      out[k] = v.length > 40 ? v.slice(0, 40) + "…" : v;
    else out[k] = v;
  }
  return out;
}

function auditRequest(req, res, next) {
  try {
    if (!MUTATING.has(req.method)) return next();
    const path = String(req.path || req.originalUrl || "").split("?")[0];
    if (ASSET_RE.test(path)) return next();
    if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return next();
    const body = summarizeBody(req.body);
    res.on("finish", () => {
      logEvent({
        category: "request",
        action: req.method.toLowerCase(),
        actor: actorFromReq(req),
        severity:
          res.statusCode >= 500
            ? "error"
            : res.statusCode >= 400
              ? "warn"
              : "info",
        method: req.method,
        route: path.slice(0, 200),
        status: res.statusCode,
        sessionId:
          req.sessionID ? String(req.sessionID).slice(0, 12) : "",
        meta: body,
      });
    });
  } catch {
    /* never break the request path */
  }
  return next();
}

module.exports = auditRequest;
