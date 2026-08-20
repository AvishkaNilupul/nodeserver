const express = require("express");
const {
  authenticate,
  isBlocked,
  isExpired,
  isBeforeStart,
  sanitizeReseller,
} = require("../utils/resellers");
const { requireReseller } = require("../middleware/resellerAuth");
const { loginLimiter } = require("../utils/rateLimit");
const ResellerAudit = require("../models/ResellerAudit");

const router = express.Router();
function regenerateSession(req) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
}
function saveSession(req) {
  return new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
}

router.post("/reseller-login", loginLimiter, async (req, res) => {
  try {
    const username = req.body?.username;
    const password = req.body?.password;
    if (!username || !password)
      return res
        .status(400)
        .json({ success: false, message: "Username and password required" });
    const reseller = await authenticate(username, password);
    if (!reseller)
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    if (isBlocked(reseller)) {
      const message =
        reseller.status === "suspended"
          ? "Your access has been suspended. Contact the operator."
          : isBeforeStart(reseller)
            ? "Your access period has not started yet. Contact the operator."
            : isExpired(reseller)
              ? "Your access period has ended. Contact the operator."
              : "Access ended";
      return res.status(403).json({ success: false, code: "blocked", message });
    }
    await regenerateSession(req);
    req.session.reseller = {
      id: String(reseller._id),
      username: reseller.username,
      at: Date.now(),
    };
    await saveSession(req);

    // The session is now authenticated and persisted. Bookkeeping is
    // best-effort: a database hiccup must not turn a completed login into a
    // 500 or make the reseller retry credentials unnecessarily. Keep the audit
    // write awaited so callers/tests can observe it deterministically when it
    // succeeds.
    try {
      reseller.lastLoginAt = new Date();
      await reseller.save();
      await ResellerAudit.create({
        reseller: reseller._id,
        action: "login",
        ip: req.ip || req.socket?.remoteAddress || "",
      });
    } catch (err) {
      console.error("reseller login bookkeeping:", err.message);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("reseller login error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/reseller-logout", (req, res) => {
  if (!req.session) return res.json({ success: true });
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("connect.sid");
    return res.json({ success: true });
  });
});
router.get("/reseller/whoami", requireReseller, (req, res) =>
  res.json({ success: true, reseller: sanitizeReseller(req.reseller) }),
);

module.exports = router;
