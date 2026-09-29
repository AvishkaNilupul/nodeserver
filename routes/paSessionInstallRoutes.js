// One-click PlayerAuctions session hand-off.
//
// The PlayerAuctions seller session has a hard ~24h ceiling and can only be
// renewed by a human browser sign-in — the login page is captcha-gated
// (Turnstile + reCAPTCHA), so the server cannot log itself back in. The daily
// chore is therefore: sign in, copy the signed-in Cookie header, install it
// here. This route removes the fiddly half of that chore. A small browser
// extension (tools/pa-cookie-pusher) reads the cookies the operator is already
// signed in with and POSTs them straight here, turning "open devtools, copy the
// Cookie header, open the keys modal, paste" into one click. The human still
// does the login (no captcha bypass); only the copy-paste is automated.
//
// Auth model, deliberately different from the rest of the admin panel: the
// extension runs in a plain browser context with NO admin session, so this is
// not behind requireSuperadmin/enforce2fa. Instead it is gated by a long shared
// secret held server-side (settings.playerauctionsInstallSecret) and in the
// extension. Two properties keep that safe:
//   * The route does exactly ONE thing — install a PlayerAuctions cookie and
//     confirm it. A leaked secret can only replace that one credential; it
//     grants no read, no other write, no session.
//   * With no secret configured the route does not exist (404). It is off by
//     default and only turns on when the operator sets a secret.
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const mp = require("../utils/marketplaces");
// Resolved through the module object (not destructured) so the secret lookup
// and the audit write stay stubbable in tests without touching the real
// settings file or the database.
const settings = require("../utils/settings");
const systemLog = require("../utils/systemLog");

const router = express.Router();

// Generous enough for a human retrying a paste, tight enough that the secret
// cannot be brute-forced through this endpoint.
const installLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, message: "Too many attempts, slow down." }),
});

// null  -> feature disabled (no secret configured): the route should 404.
// false -> a secret is configured but the caller's does not match.
// true  -> match.
function secretVerdict(provided) {
  const want = String(settings.loadSettings().playerauctionsInstallSecret || "");
  if (!want) return null;
  const got = String(provided || "");
  // Constant-time compare, but only when the lengths already match — Buffer
  // comparison of unequal lengths throws, and the length itself is not secret.
  if (got.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  } catch {
    return false;
  }
}

// The extension fetches cross-origin from a chrome-extension:// origin. With
// host permissions the browser skips CORS, but reflecting the extension origin
// makes the call work regardless of how the extension is packaged, and never
// opens the route to an ordinary web page (only chrome-extension origins are
// reflected).
function applyExtensionCors(req, res) {
  const origin = req.headers.origin || "";
  if (/^chrome-extension:\/\//.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "content-type, x-pa-install-secret");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
}

router.options("/playerauctions/session/install", (req, res) => {
  applyExtensionCors(req, res);
  res.status(204).end();
});

router.post("/playerauctions/session/install", installLimiter, async (req, res) => {
  applyExtensionCors(req, res);

  const verdict = secretVerdict(req.get("x-pa-install-secret"));
  // A disabled feature and a wrong secret look identical from outside — the
  // endpoint simply does not exist. Nothing here confirms the route or the
  // secret's length to an unauthenticated probe.
  if (verdict !== true) return res.status(404).end();

  const cookie = String((req.body && req.body.cookie) || "").trim();
  if (!cookie) return res.status(400).json({ ok: false, message: "No cookie provided." });
  // Refuse anything that plainly is not a signed-in PlayerAuctions jar, so a
  // stray paste cannot overwrite a working session with junk.
  if (!/Production_access_token=/.test(cookie) || !/Production_refresh_token=/.test(cookie)) {
    return res.status(400).json({
      ok: false,
      message:
        "That does not look like a signed-in PlayerAuctions cookie " +
        "(missing the Production_access_token / Production_refresh_token pair). " +
        "Make sure you are logged in at member.playerauctions.com first.",
    });
  }

  await mp.setKeys("playerauctions", { cookie });

  // Confirm the freshly-installed jar actually authenticates, and read its
  // expiry so the operator (and the audit log) know when the next re-paste is
  // due. Both are best-effort: the cookie is already stored either way.
  let probe = { ok: false, detail: "" };
  try {
    probe = await mp.playerauctionsTest();
  } catch (e) {
    probe = { ok: false, detail: (e && e.message) || String(e) };
  }
  let refreshExpiry = null;
  let accessExpiry = null;
  try {
    const exp = mp.playerauctionsTokenExpiry();
    refreshExpiry = exp.refresh ? exp.refresh.toISOString() : null;
    accessExpiry = exp.access ? exp.access.toISOString() : null;
  } catch {
    /* expiry is a nicety, not required */
  }

  // Audit the install. The cookie itself is never logged — only the outcome and
  // the new expiry.
  systemLog.logEvent({
    category: "marketplace",
    action: "pa-session-install",
    actor: "pa-cookie-pusher",
    severity: probe.ok ? "info" : "warning",
    subject: "playerauctions",
    detail:
      (probe.ok ? "PlayerAuctions session installed via one-click hand-off" : "Cookie installed but probe failed") +
      (refreshExpiry ? "; expires " + refreshExpiry : ""),
    method: "POST",
    route: "/playerauctions/session/install",
  });

  res.json({ ok: probe.ok, detail: probe.detail, refreshExpiry, accessExpiry });
});

module.exports = router;
