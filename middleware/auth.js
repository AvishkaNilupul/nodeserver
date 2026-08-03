// Shared auth guards used across routes.
//
// `wantsHtml` lets page routes redirect a browser to a sensible page while
// API routes get a JSON error.
function wantsHtml(req) {
  return req.accepts(["json", "html"]) === "html";
}

function requireAdmin(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  if (wantsHtml(req)) {
    return res.redirect("/admin-login.html");
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}

function requireSuperadmin(req, res, next) {
  const admin = req.session?.admin;
  if (!admin) {
    if (wantsHtml(req)) {
      return res.redirect("/admin-login.html");
    }
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (admin.role !== "superadmin") {
    if (wantsHtml(req)) {
      // Authenticated but not allowed — send them back to the inbox.
      return res.redirect("/admin.html");
    }
    return res
      .status(403)
      .json({ success: false, message: "Superadmin access required" });
  }
  return next();
}

// When the site requires 2FA for everyone, block a logged-in admin who hasn't
// enrolled from using protected features — sending browsers to the settings
// page (which hosts the 2FA panel) and API calls a clear "enroll_2fa" error.
// Applied only to feature routers, never to the 2FA setup endpoints themselves
// (or enrolment would be impossible). Falls back to allowing access if the
// settings file can't load.
// Everything an admin who has NOT yet enrolled still needs to reach: the page
// this guard redirects them TO, the endpoints that page calls to enrol, and a
// way back out (logout).
//
// This list has to live inside the guard rather than relying on mount order.
// server.js deliberately mounts twoFactorRoutes/settingsRoutes before the
// enforcement gate and defines GET /settings.html with no enforce2fa — but
// `app.use(enforce2fa, adminManageRoutes)` is mounted at "/" and therefore runs
// its middleware for EVERY later request, including that /settings.html route
// declared further down the file. So the intended exemption was silently
// defeated: turning 2FA on redirected /settings.html to /settings.html, an
// infinite loop that locked every admin out of every page — including the one
// where they would have enrolled. Verified in nginx's log: one /integrity.html
// hit at 00:55:40 followed by /settings.html 302 once a second until the
// browser gave up.
const TFA_EXEMPT_PATHS = new Set([
  "/settings.html",
  "/security.html", // legacy bookmark; plain redirect to /settings.html
  "/admin-2fa", // login second step
  "/admin-logout",
]);
const TFA_EXEMPT_PREFIXES = ["/admin/2fa/", "/me/telegram"];

function isTfaEnrollmentPath(req) {
  const path = String(req.path || "");
  if (TFA_EXEMPT_PATHS.has(path)) return true;
  return TFA_EXEMPT_PREFIXES.some((p) => path.startsWith(p));
}

function enforce2fa(req, res, next) {
  let required = false;
  try {
    required = require("../utils/settings").getRequire2fa();
  } catch {
    required = false;
  }
  if (!required) return next();
  // Never gate the enrolment surface — see TFA_EXEMPT_PATHS above.
  if (isTfaEnrollmentPath(req)) return next();
  const admin = req.session?.admin;
  if (!admin || admin.tfa) return next();
  if (wantsHtml(req)) {
    return res.redirect("/settings.html");
  }
  return res.status(403).json({
    success: false,
    code: "enroll_2fa",
    message: "Two-factor authentication setup is required",
  });
}

module.exports = {
  requireAdmin,
  requireSuperadmin,
  enforce2fa,
  // exported for tests
  isTfaEnrollmentPath,
};
