const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const twitchClaim = require("../utils/twitchClaim");

const router = express.Router();

// Cap the frontend-triggered burst so a fat-fingered "10000000" can't take the
// process's file-descriptor budget with it. 10k matches the python's limit;
// bigger runs should ship from the CLI on a box with a raised ulimit.
const MAX_PARALLEL = 10000;

function bail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

// GET /admin/twitch-claim/health — trivial keepalive the page pings on load
// so the operator sees the router is mounted before they paste a token.
router.get("/admin/twitch-claim/health", requireAdmin, (req, res) => {
  res.json({ success: true, ready: true, maxParallel: MAX_PARALLEL });
});

// POST /admin/twitch-claim/inventory — auth-token in, list of claimable drops
// out. Never persists the token; every request stands on its own.
router.post("/admin/twitch-claim/inventory", requireAdmin, async (req, res) => {
  const token = String((req.body && req.body.authToken) || "").trim();
  if (!token) return bail(res, 400, "authToken required");
  try {
    const { login, drops } = await twitchClaim.fetchClaimableDrops(token);
    res.json({ success: true, login, drops });
  } catch (err) {
    res
      .status(400)
      .json({ success: false, message: err.message || String(err) });
  }
});

// POST /admin/twitch-claim/fire — the actual race. Takes the auth-token, the
// dropInstanceID to hit, and the number of parallel workers. Returns the full
// per-worker table plus the aggregated stats block the UI renders.
router.post("/admin/twitch-claim/fire", requireAdmin, async (req, res) => {
  const token = String((req.body && req.body.authToken) || "").trim();
  const dropInstanceId = String(
    (req.body && req.body.dropInstanceId) || "",
  ).trim();
  const requested = Number((req.body && req.body.nParallel) || 20);
  if (!token) return bail(res, 400, "authToken required");
  if (!dropInstanceId) return bail(res, 400, "dropInstanceId required");
  if (!Number.isFinite(requested) || requested < 1)
    return bail(res, 400, "nParallel must be a positive number");
  const nParallel = Math.min(MAX_PARALLEL, Math.floor(requested));
  try {
    const out = await twitchClaim.spamClaim(token, dropInstanceId, nParallel);
    res.json({ success: true, ...out });
  } catch (err) {
    res
      .status(400)
      .json({ success: false, message: err.message || String(err) });
  }
});

// POST /admin/twitch-claim/check — post-fire truth check: re-query inventory
// and see whether Twitch flipped isClaimed on the drop we just spammed.
router.post("/admin/twitch-claim/check", requireAdmin, async (req, res) => {
  const token = String((req.body && req.body.authToken) || "").trim();
  const dropId = String((req.body && req.body.dropId) || "").trim();
  if (!token) return bail(res, 400, "authToken required");
  if (!dropId) return bail(res, 400, "dropId required");
  try {
    const out = await twitchClaim.checkClaimState(token, dropId);
    res.json({ success: true, ...out });
  } catch (err) {
    res
      .status(400)
      .json({ success: false, message: err.message || String(err) });
  }
});

module.exports = router;
