const express = require("express");
const bcrypt = require("bcrypt");

const { loadAdmins } = require("../utils/admins");
const settings = require("../utils/settings");
const { loginLimiter } = require("../utils/rateLimit");

const router = express.Router();

// A precomputed bcrypt hash compared against when the username is unknown, so
// a missing account takes the same time as a wrong password (no enumeration).
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8Diq1oV7l0nF1iJ9Z6Kx4z3qK4kHe";

// Promisified session regeneration to prevent session fixation: a new session
// id is issued on successful authentication.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// After regenerate() + writing session data, the client is about to redirect
// and immediately re-authenticate (whoami fetch, socket handshake) against
// that same session. express-session normally saves before the response
// flushes, but that auto-save can race a fresh session id from regenerate()
// against a cold session-store connection (e.g. right after a server
// restart) — so save explicitly and await it before responding, to guarantee
// the session is durably written before the client can act on the response.
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function requireAdmin(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}

// LOGIN
router.post("/admin-login", loginLimiter, async (req, res) => {
  try {
    const password = req.body?.password;
    const username = req.body?.username;

    if (!password) {
      return res
        .status(400)
        .json({ success: false, message: "Password required" });
    }

    if (!username) {
      return res
        .status(400)
        .json({ success: false, message: "Username required" });
    }

    const admin = loadAdmins().find(
      (a) => a.username.toLowerCase() === String(username).toLowerCase(),
    );

    // Always run a bcrypt comparison so the response time doesn't reveal
    // whether the username exists.
    const ok = await bcrypt.compare(
      password,
      admin ? admin.password : DUMMY_HASH,
    );

    if (!admin || !ok) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    // Issue a fresh session id now that the password is verified.
    await regenerateSession(req);

    // If this admin has 2FA on, don't create the real session yet — stash a
    // short-lived pending state and make them pass the code step (/admin-2fa).
    if (admin.totpEnabled) {
      req.session.pending2fa = {
        id: admin.id,
        username: admin.username,
        role: admin.role === "superadmin" ? "superadmin" : "admin",
        at: Date.now(),
      };
      await saveSession(req);
      return res.json({ success: true, twofa: true });
    }

    req.session.admin = {
      id: admin.id,
      username: admin.username,
      role: admin.role === "superadmin" ? "superadmin" : "admin",
      tfa: false,
    };
    await saveSession(req);

    // When 2FA is mandatory site-wide but this admin hasn't set it up, let them
    // in only to enrol — the UI sends them to the security page.
    if (settings.getRequire2fa()) {
      return res.json({ success: true, mustEnroll: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Admin login error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// WHOAMI (requires an active admin session)
router.get("/whoami", requireAdmin, (req, res) => {
  res.json({ admin: req.session.admin });
});

// LOGOUT
router.post("/admin-logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false });
    }
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

module.exports = router;
