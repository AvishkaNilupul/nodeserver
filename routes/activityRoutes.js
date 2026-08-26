const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const SystemEvent = require("../models/SystemEvent");
const FleetSnapshot = require("../models/FleetSnapshot");

const router = express.Router();

function escapeRegex(v) {
  return String(v || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unified activity feed — filter the audit log by category / actor / action /
// subject / severity and a time window. Read pattern mirrors
// routes/autoFarmRoutes.js's AutoFarmEvent.find(match).
router.get("/activity/events", requireSuperadmin, async (req, res) => {
  try {
    const match = {};
    const { category, actor, action, subject, severity, from, to } = req.query;
    if (category) match.category = String(category);
    if (action) match.action = String(action);
    if (severity) match.severity = String(severity);
    if (actor) match.actor = new RegExp(escapeRegex(actor), "i");
    if (subject) match.subject = new RegExp(escapeRegex(subject), "i");
    if (from || to) {
      match.at = {};
      if (from) match.at.$gte = new Date(from);
      if (to) match.at.$lte = new Date(to);
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const events = await SystemEvent.find(match)
      .sort({ at: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, events });
  } catch (err) {
    console.error("activity events error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Distinct categories present in the last week, for the filter dropdown.
router.get("/activity/facets", requireSuperadmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const categories = await SystemEvent.distinct("category", {
      at: { $gte: since },
    });
    res.json({ success: true, categories: categories.filter(Boolean).sort() });
  } catch (err) {
    console.error("activity facets error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Fleet metric time series for the trend chart.
router.get("/activity/metrics", requireSuperadmin, async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 72, 24 * 400);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const snapshots = await FleetSnapshot.find({ at: { $gte: since } })
      .sort({ at: 1 })
      .lean();
    res.json({ success: true, snapshots });
  } catch (err) {
    console.error("activity metrics error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
