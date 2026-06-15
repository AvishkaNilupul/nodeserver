const express = require("express");

const {
  getAdminById,
  setTotpPending,
  enableTotp,
  disableTotp,
  consumeBackupCode,
} = require("../utils/admins");
const totp = require("../utils/totp");
const settings = require("../utils/settings");
const { requireAdmin, requireSuperadmin } = require("../middleware/auth");
const { loginLimiter } = require("../utils/rateLimit");

const router = express.Router();

// Status of the current admin's 2FA (and whether the site enforces it).
router.get("/admin/2fa/status", requireAdmin, (req, res) => {
  const admin = getAdminById(req.session.admin.id);
  res.json({
    success: true,
    enabled: !!(admin && admin.totpEnabled),
    backupCodesRemaining:
      admin && Array.isArray(admin.backupCodes) ? admin.backupCodes.length : 0,
    require2fa: settings.getRequire2fa(),
    role: req.session.admin.role,
  });
});

// Begin enrolment: generate a secret, store it pending (encrypted), return the
// QR + manual key for the authenticator app.
router.post("/admin/2fa/setup", requireAdmin, async (req, res) => {
  try {
    const admin = getAdminById(req.session.admin.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }
    const { secret, uri } = await totp.newSecret(admin.username);
    await setTotpPending(admin.id, totp.encrypt(secret));
    const qr = await totp.qrSvg(uri);
    res.json({ success: true, secret, uri, qr });
  } catch (err) {
    console.error("2fa setup error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Confirm enrolment with a code from the app, then hand back one-time backup codes.
router.post("/admin/2fa/enable", requireAdmin, async (req, res) => {
  try {
    const admin = getAdminById(req.session.admin.id);
    if (!admin || !admin.totpPending) {
      return res
        .status(400)
        .json({ success: false, message: "Start setup first" });
    }
    const secret = totp.decrypt(admin.totpPending);
    if (!totp.verifyToken(req.body?.token, secret)) {
      return res
        .status(400)
        .json({ success: false, message: "Incorrect code — try again" });
    }
    const backupCodes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(backupCodes);
    await enableTotp(admin.id, totp.encrypt(secret), hashes);
    req.session.admin.tfa = true;
    res.json({ success: true, backupCodes });
  } catch (err) {
    console.error("2fa enable error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Disable own 2FA — requires a valid current code (or backup code) to do so.
router.post("/admin/2fa/disable", requireAdmin, async (req, res) => {
  try {
    const admin = getAdminById(req.session.admin.id);
    if (!admin || !admin.totpEnabled) {
      return res.json({ success: true });
    }
    const secret = totp.decrypt(admin.totpSecret);
    const code = req.body?.token;
    const okCode = totp.verifyToken(code, secret);
    const backupIdx = okCode
      ? -1
      : await totp.matchBackupCode(code, admin.backupCodes || []);
    if (!okCode && backupIdx < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Incorrect code" });
    }
    await disableTotp(admin.id);
    req.session.admin.tfa = false;
    res.json({ success: true });
  } catch (err) {
    console.error("2fa disable error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Superadmin: toggle whether 2FA is mandatory for every admin.
router.post("/admin/2fa/require", requireSuperadmin, async (req, res) => {
  try {
    const value = await settings.setRequire2fa(!!req.body?.value);
    res.json({ success: true, require2fa: value });
  } catch (err) {
    console.error("2fa require error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Superadmin: reset (disable) another admin's 2FA if they're locked out.
router.post(
  "/admins/:id/2fa-reset",
  requireSuperadmin,
  async (req, res) => {
    try {
      const admin = getAdminById(req.params.id);
      if (!admin) {
        return res
          .status(404)
          .json({ success: false, message: "Admin not found" });
      }
      await disableTotp(admin.id);
      res.json({ success: true });
    } catch (err) {
      console.error("2fa reset error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Second step of login: verify the 6-digit code (or a backup code) against the
// pending login established by /admin-login, then create the real session.
router.post("/admin-2fa", loginLimiter, async (req, res) => {
  try {
    const pending = req.session?.pending2fa;
    if (!pending || Date.now() - pending.at > 5 * 60 * 1000) {
      delete req.session.pending2fa;
      return res
        .status(401)
        .json({ success: false, message: "Login expired — start again" });
    }
    const admin = getAdminById(pending.id);
    if (!admin || !admin.totpEnabled) {
      delete req.session.pending2fa;
      return res.status(401).json({ success: false, message: "Try again" });
    }
    const secret = totp.decrypt(admin.totpSecret);
    const code = req.body?.token;
    const okCode = totp.verifyToken(code, secret);
    const backupIdx = okCode
      ? -1
      : await totp.matchBackupCode(code, admin.backupCodes || []);
    if (!okCode && backupIdx < 0) {
      return res
        .status(401)
        .json({ success: false, message: "Incorrect code" });
    }
    if (backupIdx >= 0) {
      await consumeBackupCode(admin.id, backupIdx);
    }
    delete req.session.pending2fa;
    req.session.admin = {
      id: admin.id,
      username: admin.username,
      role: admin.role === "superadmin" ? "superadmin" : "admin",
      tfa: true,
    };
    res.json({ success: true, usedBackupCode: backupIdx >= 0 });
  } catch (err) {
    console.error("admin-2fa error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
