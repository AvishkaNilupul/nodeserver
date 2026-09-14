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

// POST /admin/twitch-claim/fire — kicks off the race in the background and
// returns a jobId immediately. The browser then polls /fire/:jobId for the
// result. We used to run the race synchronously inside the request, but at
// big N (10k) the fire takes minutes and the reverse-proxy times the request
// out with an HTML page long before spamClaim finishes.
router.post("/admin/twitch-claim/fire", requireAdmin, (req, res) => {
  const token = String((req.body && req.body.authToken) || "").trim();
  const dropInstanceId = String(
    (req.body && req.body.dropInstanceId) || "",
  ).trim();
  const requested = Number((req.body && req.body.nParallel) || 20);
  const who = req.session?.admin?.username || "?";
  if (!token) return bail(res, 400, "authToken required");
  if (!dropInstanceId) return bail(res, 400, "dropInstanceId required");
  if (!Number.isFinite(requested) || requested < 1)
    return bail(res, 400, "nParallel must be a positive number");
  const nParallel = Math.min(MAX_PARALLEL, Math.floor(requested));
  const jobId = twitchClaim.startClaimJob(token, dropInstanceId, nParallel);
  // Rare, admin-triggered, expensive — always log. Every phase inside
  // spamClaim also logs on its own so we can trace warmup vs race.
  console.log(
    `[twitch-claim] fire start user=${who} n=${nParallel} drop=${dropInstanceId} job=${jobId}`,
  );
  res.json({ success: true, jobId, n: nParallel });
});

// GET /admin/twitch-claim/fire/:jobId — poll for a background job. Returns
// the full spamClaim payload once status flips to "done".
router.get(
  "/admin/twitch-claim/fire/:jobId",
  requireAdmin,
  (req, res) => {
    const job = twitchClaim.getClaimJob(String(req.params.jobId || ""));
    if (!job) return bail(res, 404, "job not found (or expired)");
    if (job.status === "running") {
      return res.json({
        success: true,
        status: "running",
        elapsedMs: Date.now() - job.startedAt,
        n: job.n,
        dropInstanceId: job.dropInstanceId,
      });
    }
    if (job.status === "error") {
      return res.json({
        success: false,
        status: "error",
        message: job.error || "unknown error",
        n: job.n,
        dropInstanceId: job.dropInstanceId,
      });
    }
    return res.json({
      success: true,
      status: "done",
      ...job.result,
    });
  },
);

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
