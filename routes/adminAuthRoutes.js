const express = require("express");
const bcrypt = require("bcrypt");

const { loadAdmins } = require("../utils/admins");
const settings = require("../utils/settings");
const { loginLimiter } = require("../utils/rateLimit");

const router = express.Router();

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

    const admin = loadAdmins().find((a) => a.username === username);

    if (!admin) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, admin.password);

    if (!ok) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    // If this admin has 2FA on, don't create the real session yet — stash a
    // short-lived pending state and make them pass the code step (/admin-2fa).
    if (admin.totpEnabled) {
      req.session.pending2fa = {
        id: admin.id,
        username: admin.username,
        role: admin.role === "superadmin" ? "superadmin" : "admin",
        at: Date.now(),
      };
      return res.json({ success: true, twofa: true });
    }

    req.session.admin = {
      id: admin.id,
      username: admin.username,
      role: admin.role === "superadmin" ? "superadmin" : "admin",
      tfa: false,
    };

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
