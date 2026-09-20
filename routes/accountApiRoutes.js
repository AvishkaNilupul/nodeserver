// External account API (docs/ACCOUNT-API.md).
//
// A machine-to-machine, bearer-token-guarded API that resolves a username to
// its client token (and, optionally, credentials) across EVERY account source
// in the system — Drops Archive bots, the pool, no-claim / unclaimed farms,
// account-listing stock, renter inventory and Epic accounts.
//
// Auth is a static token in `Authorization: Bearer <token>` (middleware/
// apiToken.js), deliberately separate from the session-cookie admin login so an
// external project can call it without a browser session. It is mounted BEFORE
// the blanket requireAdmin cascade in server.js, and self-guards on every route.
//
// Every lookup is audit-logged (utils/systemLog) with the username and caller
// IP — NEVER the token itself (SystemEvent rows must never carry a secret).
const express = require("express");

const { requireApiToken } = require("../middleware/apiToken");
const { lookupAccountByUsername } = require("../utils/accountLookup");
const { logEvent } = require("../utils/systemLog");

const router = express.Router();

// Everything under /api/accounts requires the bearer token.
router.use("/api/accounts", requireApiToken);

function callerIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "";
}

// Health / auth check — confirms the token works without touching the DB.
router.get("/api/accounts/ping", (req, res) => {
  res.json({ success: true, ok: true, service: "account-api", ts: Date.now() });
});

// Shared handler for both the path-param and query-string forms.
async function handleLookup(req, res) {
  const username = String(
    req.params.username || req.query.username || "",
  ).trim();
  if (!username) {
    return res.status(400).json({
      success: false,
      code: "missing_username",
      message: "Provide a username (path /api/accounts/lookup/:username or ?username=).",
    });
  }
  // Callers that only need the token can skip credential decryption entirely
  // with ?credentials=0 (least privilege for the common case).
  const includeCredentials = !["0", "false", "no"].includes(
    String(req.query.credentials || "").toLowerCase(),
  );

  let result;
  try {
    result = await lookupAccountByUsername(username, { includeCredentials });
  } catch (e) {
    logEvent({
      category: "accounts",
      action: "api_lookup",
      actor: "api",
      severity: "error",
      subject: username,
      detail: "account API lookup failed",
      meta: { ip: callerIp(req), error: e.message },
    });
    return res.status(500).json({
      success: false,
      code: "lookup_failed",
      message: "Lookup failed.",
    });
  }

  // Audit: record who asked for what, and whether it resolved — but never the
  // token or any credential.
  logEvent({
    category: "accounts",
    action: "api_lookup",
    actor: "api",
    severity: "info",
    subject: username,
    detail: result.found
      ? `account API lookup hit (${result.count} source(s))`
      : "account API lookup miss",
    meta: {
      ip: callerIp(req),
      found: result.found,
      count: result.count,
      primarySource: result.primarySource,
      withCredentials: includeCredentials,
    },
  });

  if (!result.found) {
    return res.status(404).json({
      success: false,
      code: "not_found",
      username: result.username,
      found: false,
      message: "No account found for that username.",
    });
  }

  return res.json({ success: true, ...result });
}

// Primary lookup — path param form: GET /api/accounts/lookup/:username
router.get("/api/accounts/lookup/:username", handleLookup);
// Query-string form: GET /api/accounts/lookup?username=foo
router.get("/api/accounts/lookup", handleLookup);

module.exports = router;
