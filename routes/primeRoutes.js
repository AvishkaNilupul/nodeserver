const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const PrimeOffer = require("../models/PrimeOffer");
const primeWatcher = require("../utils/primeWatcher");

const router = express.Router();

// Current catalog + watcher status for the Prime Gaming tab.
router.get("/api/prime/offers", requireSuperadmin, async (req, res) => {
  try {
    const showEnded = String(req.query.ended || "") === "1";
    const offers = await PrimeOffer.find(showEnded ? {} : { active: true })
      .sort({ active: -1, endTime: 1, title: 1 })
      .limit(500)
      .lean();
    res.json({ success: true, offers, status: primeWatcher.status() });
  } catch (err) {
    console.error("prime offers error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Manual "check now" from the tab.
router.post("/api/prime/check", requireSuperadmin, async (req, res) => {
  try {
    const counts = await primeWatcher.runOnce();
    res.json({ success: true, counts, status: primeWatcher.status() });
  } catch (err) {
    res
      .status(502)
      .json({ success: false, message: err.message || "Check failed" });
  }
});

module.exports = router;
