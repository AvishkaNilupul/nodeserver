// Bearer-token guard for the machine-to-machine account API
// (routes/accountApiRoutes.js). This is a SEPARATE auth realm from the
// session-cookie admin login: external projects present a static token in an
// `Authorization: Bearer <token>` header instead of holding a session.
//
// The token is read from config.ACCOUNT_API_TOKEN (env ACCOUNT_API_TOKEN). If
// it is unset the whole API is treated as DISABLED and every request gets 503 —
// this endpoint hands out account credentials, so it must fail closed rather
// than fall open to "no auth required".
const crypto = require("crypto");
const config = require("../config/config");

// Constant-time compare that also tolerates length differences without leaking
// them through an early return (timingSafeEqual throws on unequal lengths).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still burn a comparison so a wrong-length guess is not measurably faster.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function extractBearer(req) {
  const h = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1].trim();
  // Also accept the token via ?api_token= for quick manual testing, though a
  // header is strongly preferred (query strings leak into logs/history).
  if (typeof req.query?.api_token === "string") return req.query.api_token;
  return "";
}

function requireApiToken(req, res, next) {
  const expected = config.ACCOUNT_API_TOKEN || "";
  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "api_disabled",
      message:
        "Account API is disabled. Set ACCOUNT_API_TOKEN in the environment to enable it.",
    });
  }
  const presented = extractBearer(req);
  if (!presented || !safeEqual(presented, expected)) {
    return res.status(401).json({
      success: false,
      code: "unauthorized",
      message: "Missing or invalid API token.",
    });
  }
  return next();
}

module.exports = { requireApiToken, safeEqual, extractBearer };
