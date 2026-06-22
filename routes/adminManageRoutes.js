const express = require("express");

const {
  loadAdmins,
  sanitizeAdmin,
  addAdmin,
  updateAdmin,
  deleteAdmin,
  adjustBalance,
  setBalance,
  getAdminById,
} = require("../utils/admins");
const { requireSuperadmin } = require("../middleware/auth");

const router = express.Router();

// Every admin-management endpoint is superadmin-only. The guard is applied
// per-route (not via router.use) because this router is mounted at "/", so a
// router-level guard would intercept unrelated requests and redirect them.

// LIST admins (never returns password hashes).
router.get("/admins", requireSuperadmin, (req, res) => {
  res.json({ success: true, admins: loadAdmins().map(sanitizeAdmin) });
});

// CREATE a new admin.
router.post("/admins", requireSuperadmin, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const admin = await addAdmin({ username, password, role });
    res.status(201).json({ success: true, admin });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// UPDATE an admin (username / password / role). Empty password = unchanged.
router.put("/admins/:id", requireSuperadmin, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const admin = await updateAdmin(req.params.id, {
      username,
      password,
      role,
    });
    res.json({ success: true, admin });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// TOP UP / SET an admin's wallet balance (superadmin only). Pass either
// `amount` (a signed delta to add, e.g. 50 to credit or -10 to deduct) or
// `set` (an absolute new balance). Returns the updated admin.
router.post("/admins/:id/balance", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (!getAdminById(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, message: "Admin not found" });
    }
    if (body.set !== undefined) {
      const admin = await setBalance(req.params.id, body.set);
      return res.json({ success: true, admin });
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid amount" });
      }
      // Superadmin adjustments may push a balance negative (e.g. a correction).
      await adjustBalance(req.params.id, amount, { allowNegative: true });
      return res.json({
        success: true,
        admin: sanitizeAdmin(getAdminById(req.params.id)),
      });
    }
    res
      .status(400)
      .json({ success: false, message: "Provide `amount` or `set`" });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// DELETE an admin.
router.delete("/admins/:id", requireSuperadmin, async (req, res) => {
  // Guard against a superadmin deleting their own account mid-session.
  if (req.session.admin.id === req.params.id) {
    return res
      .status(400)
      .json({ success: false, message: "You cannot delete your own account" });
  }
  try {
    const admin = await deleteAdmin(req.params.id);
    res.json({ success: true, admin });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
