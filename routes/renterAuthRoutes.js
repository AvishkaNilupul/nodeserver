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

// Failed renter logins (2026-10-01).
//   - per (username, address): LOCK_AFTER failures inside LOCK_WINDOW_MS lock
//     that PAIR for LOCK_MS — the right password from that address waits too.
//     A lock on the username alone let anyone who knew it lock the renter out
//     from a single address, again and again.
//   - per username, across addresses: past ALERT_AFTER failures inside the
//     window the operator is told once — guessing spread over many addresses
//     is seen, without ever refusing the renter's own correct password.
// In-process (the server is one process, as utils/fileLock assumes); a restart
// clears it. Both maps are pruned, so failures for made-up usernames cannot
// grow them without bound.
const LOCK_AFTER = 10;
const ALERT_AFTER = 20;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const MAX_KEYS = 5000;
const pairFailures = new Map(); // "user|ip" -> { n, first, lockedUntil }
const userFailures = new Map(); // user -> { n, first, ips, alerted }

function liveEntry(map, key, now) {
  const f = map.get(key);
  if (!f) return null;
  if (f.lockedUntil && f.lockedUntil > now) return f;
  if (now - f.first > LOCK_WINDOW_MS) {
    map.delete(key);
    return null;
  }
  return f;
}

function prune(map, now) {
  if (map.size <= MAX_KEYS) return;
  for (const [k, f] of map) {
    if (!(f.lockedUntil > now) && now - f.first > LOCK_WINDOW_MS) map.delete(k);
  }
  for (const k of map.keys()) {
    if (map.size <= MAX_KEYS) break;
    map.delete(k); // oldest first (insertion order)
  }
}

function recordFailure(user, ip, now) {
  const addr = String(ip || "?");
  const pk = user + "|" + addr;
  let p = liveEntry(pairFailures, pk, now);
  if (!p) {
    p = { n: 0, first: now, lockedUntil: 0 };
    pairFailures.set(pk, p);
  }
  p.n += 1;
  if (p.n >= LOCK_AFTER && !(p.lockedUntil > now)) p.lockedUntil = now + LOCK_MS;
  let u = liveEntry(userFailures, user, now);
  if (!u) {
    u = { n: 0, first: now, ips: new Set(), alerted: false };
    userFailures.set(user, u);
  }
  u.n += 1;
  if (u.ips.size < 100) u.ips.add(addr);
  if (u.n >= ALERT_AFTER && !u.alerted) {
    u.alerted = true;
    require("../utils/telegram")
      .sendTelegram(
        "🔒 Renter login '" + user + "': " + u.n + " failed passwords in " +
          Math.max(1, Math.round((now - u.first) / 60000)) + " min from " + u.ips.size +
          " address(es) (last " + addr + "). Each address is locked out after " + LOCK_AFTER +
          " failures; the renter's own correct password still works.",
      )
      .catch(() => {});
  }
  prune(pairFailures, now);
  prune(userFailures, now);
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
    const pairKey = key + "|" + String(req.ip || "?");
    const lock = liveEntry(pairFailures, pairKey, now);
    if (lock && lock.lockedUntil > now) {
      return res
        .status(429)
        .json({ success: false, message: "Too many login attempts. Please try again later." });
    }
    const renter = await authenticate(username, password);
    // The rent-farm holder never logs in (same answer as a wrong password).
    if (!renter || isOperatorHolder(renter)) {
      if (!renter) recordFailure(key, req.ip, now);
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }
    pairFailures.delete(pairKey);
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
          "Your access starts on " +
            new Date(new Date(renter.accessStart).getTime() + 9 * 3600000).toISOString().slice(0, 10) +
            " (Japan time).",
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
module.exports._resetLoginLocks = () => {
  pairFailures.clear();
  userFailures.clear();
};
module.exports._loginLockSizes = () => ({ pairs: pairFailures.size, users: userFailures.size });
