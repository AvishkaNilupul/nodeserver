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

module.exports = { requireAdmin, requireSuperadmin };
