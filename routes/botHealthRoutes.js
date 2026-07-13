const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const botHealthMonitor = require("../utils/botHealthMonitor");

const router = express.Router();

router.get("/api/bot-health/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...botHealthMonitor.status() });
});

module.exports = router;
