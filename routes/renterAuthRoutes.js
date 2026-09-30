const express = require("express");

const {
  authenticate,
  isBlocked,
  isExpired,
  isOperatorHolder,
  notStarted,
  portalRenter,
} = require("../utils/renters");
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

// Per-USERNAME failed-login lockout (2026-10-01). loginLimiter is per IP, so
// guessing one renter's password from many addresses was unlimited. After
// LOCK_AFTER failures inside LOCK_WINDOW_MS the username is refused for
// LOCK_MS (the same answer as the IP limiter, correct password or not), and the
// operator is told once per lock. In-process (the server is one process, as
// utils/fileLock assumes); a restart clears it.
const LOCK_AFTER = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const failures = new Map(); // usernameLower -> { n, first, lockedUntil }

function lockState(key, now) {
  const f = failures.get(key);
  if (!f) return null;
  if (f.lockedUntil && f.lockedUntil > now) return f;
  if (now - f.first > LOCK_WINDOW_MS && !(f.lockedUntil > now)) {
    failures.delete(key);
    return null;
  }
  return f;
}

function recordFailure(key, now, ip) {
  let f = lockState(key, now);
  if (!f) {
    f = { n: 0, first: now, lockedUntil: 0 };
    failures.set(key, f);
  }
  f.n += 1;
  if (f.n >= LOCK_AFTER && !(f.lockedUntil > now)) {
    f.lockedUntil = now + LOCK_MS;
    require("../utils/telegram")
      .sendTelegram(
        "🔒 Renter login for '" + key + "' locked for " + LOCK_MS / 60000 + " min after " + f.n +
          " failed passwords in " + Math.round((now - f.first) / 60000) + " min (last from " + (ip || "?") + ").",
      )
      .catch(() => {});
  }
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
    const key = String(username).trim().toLowerCase().slice(0, 64);
    const now = Date.now();
    const lock = lockState(key, now);
    if (lock && lock.lockedUntil > now) {
      return res
        .status(429)
        .json({ success: false, message: "Too many login attempts. Please try again later." });
    }
    const renter = await authenticate(username, password);
    // The rent-farm holder never logs in (same answer as a wrong password).
    if (!renter || isOperatorHolder(renter)) {
      if (!renter) recordFailure(key, now, req.ip);
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }
    failures.delete(key);
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

    if (notStarted(renter)) {
      return res.status(403).json({
        success: false,
        code: "not_started",
        message:
          "Your access starts on " + new Date(renter.accessStart).toISOString().slice(0, 10) + ".",
      });
    }

    await regenerateSession(req);
    req.session.renter = {
      id: String(renter._id),
      username: renter.username,
      at: Date.now(),
      // A password reset / suspend bumps the renter's epoch and ends this
      // session (middleware/renterAuth).
      epoch: Number(renter.sessionEpoch) || 0,
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

// Lightweight identity check for the dashboard bootstrap — the renter's own
// view (no operator notes, host or config file).
router.get("/renter/whoami", requireRenter, (req, res) => {
  res.json({ success: true, renter: portalRenter(req.renter) });
});

module.exports = router;
module.exports._resetLoginLocks = () => failures.clear();
