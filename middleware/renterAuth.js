// Auth guard for the renter realm. Completely independent of middleware/auth.js:
// it only ever consults req.session.renter (never req.session.admin), so an
// operator admin is not a renter and a renter is not an admin.
//
// The lease + suspension are enforced on EVERY request, not just at login — a
// renter whose access period lapses or who gets suspended is locked out on
// their very next call, and their session is destroyed.
const { getById, isBlocked } = require("../utils/renters");

function wantsHtml(req) {
  return req.accepts(["json", "html"]) === "html";
}

function denyBlocked(req, res) {
  // Tear down the session so a blocked renter can't keep poking authenticated
  // endpoints with a stale cookie.
  if (req.session) {
    req.session.destroy(() => {});
  }
  if (wantsHtml(req)) {
    return res.redirect("/renter-login.html?blocked=1");
  }
  return res
    .status(403)
    .json({ success: false, code: "blocked", message: "Access ended" });
}

async function requireRenter(req, res, next) {
  const sess = req.session && req.session.renter;
  if (!sess || !sess.id) {
    if (wantsHtml(req)) {
      return res.redirect("/renter-login.html");
    }
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const renter = await getById(sess.id);
    if (!renter) {
      return denyBlocked(req, res);
    }
    if (isBlocked(renter)) {
      return denyBlocked(req, res);
    }
    // Attach the fresh record so routes derive scope from the DB, not the
    // session snapshot (which could be stale after an admin edit).
    req.renter = renter;
    return next();
  } catch (err) {
    console.error("requireRenter error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { requireRenter };
