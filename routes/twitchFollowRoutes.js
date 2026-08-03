const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const TwitchFollowJob = require("../models/TwitchFollowJob");
const TwitchFollowLog = require("../models/TwitchFollowLog");
const twitchFollow = require("../utils/twitchFollow");
const runner = require("../utils/twitchFollowRunner");
const hosts = require("../utils/botHosts");
const secretBox = require("../utils/secretBox");

const router = express.Router();

// The follow-bot UI needs any working account token to look up a channel
// (resolve login -> id + display name). This picks the freshest 'ok'-scanned
// account that still has a token — same account that a scan would use next.
async function pickResolveAccount() {
  return BotAccount.findOne({
    enabled: true,
    soldAt: null,
    clientSecret: { $gt: "" },
    lastScanStatus: "ok",
  })
    .sort({ lastScanAt: -1 })
    .select("clientSecret host")
    .lean();
}

// Turn a raw resolve/preview failure into something worth showing in a UI:
// transport errors expose the full SSH command (including key paths and host
// IPs), and Twitch's own error strings often carry stack noise. Everything
// else falls through unchanged.
function sanitizeResolveError(err) {
  if (err && err.transportFailed) {
    return "Resolve host unreachable — the account we tried to look up the channel with is behind a scan host that's down. Try again in a moment.";
  }
  const code = err && err.code;
  if (code === "channel_not_found") return err.message;
  if (code === "bad_input") return err.message;
  if (code === "token_invalid") {
    return "Every account we tried to resolve the channel with has a dead token — refresh a token via the token-fetcher tool and retry.";
  }
  if (code === "integrity_failed") {
    return "Twitch integrity gate rejected our lookup — no live account can query at the moment.";
  }
  return (err && err.message) || String(err);
}

function safeToken(raw) {
  if (!raw) return "";
  try {
    return secretBox.decrypt(raw);
  } catch {
    return raw;
  }
}

// GET /admin/twitch-follow/hosts — enabled hosts + a quick capacity read the
// UI uses to populate the host-filter checkboxes.
router.get("/admin/twitch-follow/hosts", requireAdmin, (req, res) => {
  res.json({ success: true, hosts: hosts.listHosts() });
});

// POST /admin/twitch-follow/resolve — { channel } -> { id, login, displayName }
// Lets the operator paste a URL and see who they're about to hit before
// committing to a job. Always egresses from the local server: the user()
// lookup carries no integrity concerns, so binding it to the picked
// account's home host would just break resolve whenever the Pi is down.
router.post("/admin/twitch-follow/resolve", requireAdmin, async (req, res) => {
  try {
    const raw = String(req.body?.channel || "").trim();
    if (!raw) {
      return res
        .status(400)
        .json({ success: false, message: "channel required" });
    }
    const login = twitchFollow.parseChannelInput(raw);
    if (!login) {
      return res
        .status(400)
        .json({ success: false, message: "could not parse channel" });
    }
    const acct = await pickResolveAccount();
    if (!acct) {
      return res.status(503).json({
        success: false,
        message: "no working bot accounts available to resolve the channel",
      });
    }
    const info = await twitchFollow.resolveChannel(login, {
      token: safeToken(acct.clientSecret),
      host: hosts.resolveHost("local"),
    });
    res.json({ success: true, channel: info });
  } catch (err) {
    res.status(400).json({
      success: false,
      code: err.code || "error",
      message: sanitizeResolveError(err),
    });
  }
});

// GET /admin/twitch-follow/preview?channel=<login>&integrityOnly=1&hosts=pi,local
// How many accounts are still available for THIS channel, given the same
// filters the create form uses. Answers "how many follows can I realistically
// ask for right now" before the operator picks a count.
router.get("/admin/twitch-follow/preview", requireAdmin, async (req, res) => {
  try {
    const rawChannel = String(req.query.channel || "").trim();
    if (!rawChannel) {
      return res
        .status(400)
        .json({ success: false, message: "channel required" });
    }
    const login = twitchFollow.parseChannelInput(rawChannel);
    if (!login) {
      return res
        .status(400)
        .json({ success: false, message: "could not parse channel" });
    }
    const acct = await pickResolveAccount();
    if (!acct) {
      return res.status(503).json({
        success: false,
        message: "no working bot accounts available to resolve the channel",
      });
    }
    const info = await twitchFollow.resolveChannel(login, {
      token: safeToken(acct.clientSecret),
      host: hosts.resolveHost("local"),
    });

    const integrityOnly = String(req.query.integrityOnly || "1") !== "0";
    const hostList = String(req.query.hosts || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const already = await TwitchFollowLog.distinct("botAccountId", {
      channelId: info.id,
      status: { $in: ["ok", "already_following"] },
    });
    const filter = {
      enabled: true,
      soldAt: null,
      clientSecret: { $gt: "" },
      _id: { $nin: already },
    };
    if (integrityOnly) filter.lastScanStatus = "ok";
    if (hostList.length) filter.host = { $in: hostList };
    const [available, alreadyCount, total] = await Promise.all([
      BotAccount.countDocuments(filter),
      Promise.resolve(already.length),
      BotAccount.countDocuments({
        enabled: true,
        soldAt: null,
        clientSecret: { $gt: "" },
      }),
    ]);
    res.json({
      success: true,
      channel: info,
      available,
      alreadyFollowed: alreadyCount,
      totalAccounts: total,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      code: err.code || "error",
      message: sanitizeResolveError(err),
    });
  }
});

// POST /admin/twitch-follow/jobs — create + start a job.
// Body:
//   channel:         string (URL or login)
//   count:           integer, how many follows to deliver
//   spreadHours:     float, how long to spread over (converted to avgGapMs)
//   jitter:          float 0..1 (default 0.4)
//   idlePauseChance: float 0..1 (default 0.08)
//   hosts:           optional array of host ids to restrict egress to
//   integrityOnly:   optional bool (default true)
//   disableNotifications: optional bool (default true; passthrough to Twitch)
router.post("/admin/twitch-follow/jobs", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const channelInput = String(b.channel || "").trim();
    const count = Math.floor(Number(b.count));
    if (!channelInput) {
      return res
        .status(400)
        .json({ success: false, message: "channel required" });
    }
    if (!(count > 0)) {
      return res
        .status(400)
        .json({ success: false, message: "count must be a positive integer" });
    }
    const spreadHours = Math.max(0.01, Number(b.spreadHours) || 1);
    const jitter = Math.max(0, Math.min(1, Number(b.jitter ?? 0.4)));
    const idlePauseChance = Math.max(
      0,
      Math.min(1, Number(b.idlePauseChance ?? 0.08)),
    );
    const hostIds = Array.isArray(b.hosts)
      ? b.hosts.map(String).filter(Boolean)
      : [];
    const integrityOnly = b.integrityOnly !== false;
    const concurrency = Math.max(
      1,
      Math.min(runner.MAX_CONCURRENCY || 5, Math.floor(Number(b.concurrency) || 1)),
    );

    const acct = await pickResolveAccount();
    if (!acct) {
      return res.status(503).json({
        success: false,
        message: "no working bot accounts available to resolve the channel",
      });
    }
    const info = await twitchFollow.resolveChannel(channelInput, {
      token: safeToken(acct.clientSecret),
      host: hosts.resolveHost("local"),
    });

    // Convert "spread over N hours" into an average per-follow gap so the
    // runner's jitter math has a single knob to work from.
    const avgGapMs = Math.max(
      1000,
      Math.round((spreadHours * 3600 * 1000) / count),
    );

    const admin = req.session?.admin || {};
    const doc = await TwitchFollowJob.create({
      channelId: info.id,
      channelLogin: info.login,
      channelDisplayName: info.displayName,
      channelInput,
      requestedCount: count,
      avgGapMs,
      jitter,
      idlePauseChance,
      hostIds,
      integrityOnly,
      concurrency,
      createdBy: admin.username || admin._id || "",
    });
    runner.enqueueJob(doc._id);
    res.json({ success: true, job: doc.toObject() });
  } catch (err) {
    res.status(400).json({
      success: false,
      code: err.code || "error",
      message: err.message || String(err),
    });
  }
});

// GET /admin/twitch-follow/jobs — recent jobs, newest first (default 50).
router.get("/admin/twitch-follow/jobs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const jobs = await TwitchFollowJob.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, jobs, runner: runner.status() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/twitch-follow/jobs/:id — job doc + up to 200 recent log rows.
router.get("/admin/twitch-follow/jobs/:id", requireAdmin, async (req, res) => {
  try {
    const job = await TwitchFollowJob.findById(req.params.id).lean();
    if (!job) {
      return res.status(404).json({ success: false, message: "not found" });
    }
    const logs = await TwitchFollowLog.find({ jobId: job._id })
      .sort({ at: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, job, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/twitch-follow/jobs/:id/cancel — flag + signal.
router.post(
  "/admin/twitch-follow/jobs/:id/cancel",
  requireAdmin,
  async (req, res) => {
    try {
      const job = await TwitchFollowJob.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, message: "not found" });
      }
      if (job.status === "done" || job.status === "cancelled" || job.status === "failed") {
        return res.json({ success: true, job: job.toObject() });
      }
      job.cancelRequested = true;
      await job.save();
      runner.cancelJob(job._id);
      res.json({ success: true, job: job.toObject() });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
