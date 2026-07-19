const express = require("express");

const { authenticate, isBlocked, isExpired, sanitizeRenter } = require("../utils/renters");
const { requireRenter } = require("../middleware/renterAuth");
const { loginLimiter } = require("../utils/rateLimit");

const router = express.Router();

// A fresh session id on successful auth (session-fixation defence), matching the
// admin login flow (routes/adminAuthRoutes.js).
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// RENTER LOGIN — separate realm. On success the session carries ONLY
// req.session.renter; it never sets req.session.admin, so a renter can never
// satisfy requireAdmin/requireSuperadmin.
router.post("/renter-login", loginLimiter, async (req, res) => {
  try {
    const username = req.body?.username;
    const password = req.body?.password;
    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Username and password required" });
    }
    const renter = await authenticate(username, password);
    if (!renter) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }
    // Valid password but no access: be specific so the renter knows why.
    if (isBlocked(renter)) {
      const message =
        renter.status === "suspended"
          ? "Your access has been suspended. Contact the operator."
          : isExpired(renter)
            ? "Your access period has ended. Contact the operator."
            : "Access ended";
      return res.status(403).json({ success: false, code: "blocked", message });
    }

    await regenerateSession(req);
    req.session.renter = {
      id: String(renter._id),
      username: renter.username,
      at: Date.now(),
    };
    await saveSession(req);

    renter.lastLoginAt = new Date();
    renter.save().catch((e) => console.error("renter lastLogin:", e.message));

    res.json({ success: true });
  } catch (err) {
    console.error("renter login error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/renter-logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// Lightweight identity check for the dashboard bootstrap.
router.get("/renter/whoami", requireRenter, (req, res) => {
  res.json({ success: true, renter: sanitizeRenter(req.renter) });
});

module.exports = router;
