const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const botUpdater = require("../utils/botUpdater");

const router = express.Router();

// Latest upstream release + what each host currently has applied, so the
// Bots page can show "you're on vX, latest is vY" before offering to roll out.
router.get("/api/bot-update/latest", requireSuperadmin, async (req, res) => {
  try {
    const [release, applied] = await Promise.all([
      botUpdater.latestRelease(),
      botUpdater.appliedVersions(),
    ]);
    res.json({ success: true, release, applied });
  } catch (err) {
    res
      .status(502)
      .json({ success: false, message: err.message || "Lookup failed" });
  }
});

router.post("/api/bot-update/start", requireSuperadmin, async (req, res) => {
  try {
    const r = await botUpdater.start();
    res.json({ success: true, tag: r.tag });
  } catch (err) {
    res.status(409).json({ success: false, message: err.message });
  }
});

router.get("/api/bot-update/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...botUpdater.status() });
});

module.exports = router;
