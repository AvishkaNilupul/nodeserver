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
function enforce2fa(req, res, next) {
  let required = false;
  try {
    required = require("../utils/settings").getRequire2fa();
  } catch {
    required = false;
  }
  if (!required) return next();
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

module.exports = { requireAdmin, requireSuperadmin, enforce2fa };
