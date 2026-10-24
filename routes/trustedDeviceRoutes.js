const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const trustedDevices = require("../utils/trustedDevices");

const router = express.Router();

// The signed-in admin's remembered devices (Settings → Remembered devices).
router.get("/me/devices", requireAdmin, async (req, res) => {
  try {
    const devices = await trustedDevices.listDevices(req.session.admin.id, req);
    res.json({ success: true, devices, idleDays: trustedDevices.IDLE_DAYS });
  } catch (err) {
    console.error("me/devices list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Forget one device. Scoped to the signed-in admin's own devices.
router.post("/me/devices/:id/remove", requireAdmin, async (req, res) => {
  try {
    const removed = await trustedDevices.removeDevice(
      req.session.admin.id,
      req.params.id,
      req,
      res,
    );
    if (!removed) {
      return res
        .status(404)
        .json({ success: false, message: "Device not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("me/devices remove error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Forget every device of the signed-in admin (this one included).
router.post("/me/devices/remove-all", requireAdmin, async (req, res) => {
  try {
    const removed = await trustedDevices.removeAllDevices(
      req.session.admin.id,
      req,
      res,
    );
    res.json({ success: true, removed });
  } catch (err) {
    console.error("me/devices remove-all error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
