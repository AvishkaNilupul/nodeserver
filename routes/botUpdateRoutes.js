const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const botUpdater = require("../utils/botUpdater");

const router = express.Router();

// Latest upstream release + what each host currently has applied, so the
// Bots page can show "you're on vX, latest is vY" before offering to roll out.
router.get("/api/bot-update/latest", requireSuperadmin, async (req, res) => {
  try {
    const repo = req.query.repo ? String(req.query.repo) : undefined;
    const [release, applied] = await Promise.all([
      botUpdater.latestRelease(repo),
      botUpdater.appliedVersions(),
    ]);
    res.json({ success: true, release, applied });
  } catch (err) {
    res
      .status(502)
      .json({ success: false, message: err.message || "Lookup failed" });
  }
});

// Body may include { repo, ref } to build from a fork branch/tag/commit
// instead of the latest upstream release — the fast path for an emergency
// patch pushed ahead of an upstream fix.
router.post("/api/bot-update/start", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const repo = body.repo ? String(body.repo) : undefined;
    const ref = body.ref ? String(body.ref) : undefined;
    const r = await botUpdater.start({ repo, ref });
    res.json({ success: true, repo: r.repo, tag: r.tag });
  } catch (err) {
    res.status(409).json({ success: false, message: err.message });
  }
});

router.get("/api/bot-update/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...botUpdater.status() });
});

module.exports = router;
