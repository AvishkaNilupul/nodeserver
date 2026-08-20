const { getById, isBlocked } = require("../utils/resellers");

function wantsHtml(req) {
  return req.accepts(["json", "html"]) === "html";
}
function denyBlocked(req, res) {
  if (req.session) req.session.destroy(() => {});
  if (wantsHtml(req)) return res.redirect("/reseller-login.html?blocked=1");
  return res
    .status(403)
    .json({ success: false, code: "blocked", message: "Access ended" });
}
async function requireReseller(req, res, next) {
  const sess = req.session && req.session.reseller;
  if (!sess || !sess.id) {
    if (wantsHtml(req)) return res.redirect("/reseller-login.html");
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const reseller = await getById(sess.id);
    if (!reseller || isBlocked(reseller)) return denyBlocked(req, res);
    req.reseller = reseller;
    return next();
  } catch (err) {
    console.error("requireReseller error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}
module.exports = { requireReseller, wantsHtml, denyBlocked };
