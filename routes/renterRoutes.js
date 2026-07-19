// Renter dashboard API. Every route is behind requireRenter, and every route
// derives its scope from req.renter (loaded from the DB by the middleware) —
// never from a path/param/body the client controls. A renter can therefore only
// ever see their own bot, their own accounts, and their own submissions.
const express = require("express");
const bcrypt = require("bcrypt");

const { requireRenter } = require("../middleware/renterAuth");
const { renterSubmitLimiter } = require("../utils/rateLimit");
const { isExpired, setPassword, MIN_PASSWORD } = require("../utils/renters");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const RenterSubmission = require("../models/RenterSubmission");
const hosts = require("../utils/botHosts");
const { encrypt } = require("../utils/secretBox");
const {
  parseAccounts,
  countConfigAccounts,
  containerForFile,
} = require("./botConfigRoutes");

const router = express.Router();

// Sum of accounts still waiting in pending submissions (counts against quota).
async function pendingAccountCount(renterId) {
  const rows = await RenterSubmission.find(
    { renter: renterId, status: "pending" },
    { count: 1 },
  ).lean();
  return rows.reduce((s, r) => s + (r.count || 0), 0);
}

// The renter's accounts: exactly the ones sitting in their assigned config,
// resolved from req.renter (host + configFile), no client input.
function accountFilter(renter) {
  if (!renter.botFile) return null;
  return { host: renter.botHost || "local", configFile: renter.botFile };
}

// GET /renter/me — their bot status, quota, lease.
router.get("/renter/me", requireRenter, async (req, res) => {
  try {
    const r = req.renter;
    const host = hosts.resolveHost(r.botHost);
    let used = 0;
    let running = null; // null = unknown (host offline / not assigned)
    if (r.botFile && host) {
      used = await countConfigAccounts(host, r.botFile);
      try {
        const states = await hosts.dockerPs(host);
        const st = states[containerForFile(r.botFile)];
        running = !!(st && /^running/i.test(st.state || ""));
      } catch {
        running = null;
      }
    }
    const pending = await pendingAccountCount(r._id);
    const max = Number(r.maxAccounts) || 0;
    res.json({
      success: true,
      me: {
        username: r.username,
        displayName: r.displayName || "",
        status: r.status,
        bot: { assigned: !!r.botFile, running },
        quota: {
          used,
          pending,
          max,
          remaining: Math.max(0, max - used - pending),
        },
        lease: {
          start: r.accessStart || null,
          end: r.accessEnd || null,
          expired: isExpired(r),
        },
      },
    });
  } catch (err) {
    console.error("renter/me error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /renter/accounts — their account list (login + scan status + drop count).
// Never returns tokens.
router.get("/renter/accounts", requireRenter, async (req, res) => {
  try {
    const filter = accountFilter(req.renter);
    if (!filter) return res.json({ success: true, accounts: [] });
    const accs = await BotAccount.find(filter, {
      login: 1,
      lastScanStatus: 1,
      dropCount: 1,
      lastScanAt: 1,
    })
      .sort({ login: 1 })
      .lean();
    res.json({
      success: true,
      accounts: accs.map((a) => ({
        login: a.login || "",
        status: a.lastScanStatus || "pending",
        dropCount: a.dropCount || 0,
        lastScanAt: a.lastScanAt || null,
      })),
    });
  } catch (err) {
    console.error("renter/accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /renter/drops — drops their accounts have farmed, grouped by reward.
router.get("/renter/drops", requireRenter, async (req, res) => {
  try {
    const filter = accountFilter(req.renter);
    if (!filter) return res.json({ success: true, drops: [], total: 0 });
    const ids = (await BotAccount.find(filter, { _id: 1 }).lean()).map(
      (a) => a._id,
    );
    if (!ids.length) return res.json({ success: true, drops: [], total: 0 });
    const rows = await DropLog.aggregate([
      { $match: { account: { $in: ids }, accountModel: "BotAccount" } },
      {
        $group: {
          _id: "$itemKey",
          name: { $first: "$name" },
          game: { $first: "$game" },
          image: { $first: "$imageLocal" },
          imageURL: { $first: "$imageURL" },
          count: { $sum: "$count" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 500 },
    ]);
    const drops = rows.map((d) => ({
      name: d.name || "Reward",
      game: d.game || "",
      image: d.image || d.imageURL || "",
      count: d.count || 0,
    }));
    res.json({
      success: true,
      drops,
      total: drops.reduce((s, d) => s + d.count, 0),
    });
  } catch (err) {
    console.error("renter/drops error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /renter/submit — queue a batch of accounts for operator approval. Never
// writes a live config; the parsed tokens are encrypted at rest.
router.post("/renter/submit", renterSubmitLimiter, requireRenter, async (req, res) => {
  try {
    const r = req.renter;
    if (!r.botFile) {
      return res.status(400).json({
        success: false,
        message: "No bot assigned yet — contact the operator.",
      });
    }
    const parsed = parseAccounts(req.body && req.body.accounts, []);
    if (!parsed.length) {
      return res.status(400).json({
        success: false,
        message: "No valid accounts found. Paste tokens or login:token lines.",
      });
    }
    // Quota: current config accounts + already-pending + this batch must fit.
    const host = hosts.resolveHost(r.botHost);
    const used = host ? await countConfigAccounts(host, r.botFile) : 0;
    const pending = await pendingAccountCount(r._id);
    const max = Number(r.maxAccounts) || 0;
    const remaining = max - used - pending;
    if (parsed.length > remaining) {
      return res.status(400).json({
        success: false,
        message:
          "Over your limit: you can submit " +
          Math.max(0, remaining) +
          " more account(s) (limit " +
          max +
          ", " +
          used +
          " active, " +
          pending +
          " pending).",
      });
    }
    const logins = parsed.map((a) => a.Login || "").filter(Boolean).slice(0, 100);
    await RenterSubmission.create({
      renter: r._id,
      status: "pending",
      accountsEnc: encrypt(JSON.stringify(parsed)),
      count: parsed.length,
      logins,
    });
    res.json({
      success: true,
      submitted: parsed.length,
      message:
        "Submitted " +
        parsed.length +
        " account(s) for approval. They go live once the operator approves.",
    });
  } catch (err) {
    console.error("renter/submit error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /renter/submissions — their own submission history (no tokens).
router.get("/renter/submissions", requireRenter, async (req, res) => {
  try {
    const rows = await RenterSubmission.find(
      { renter: req.renter._id },
      { accountsEnc: 0 },
    )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({
      success: true,
      submissions: rows.map((s) => ({
        id: String(s._id),
        status: s.status,
        count: s.count,
        added: s.added || 0,
        logins: s.logins || [],
        rejectReason: s.rejectReason || "",
        createdAt: s.createdAt,
        reviewedAt: s.reviewedAt || null,
      })),
    });
  } catch (err) {
    console.error("renter/submissions error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /renter/password — change their own password (must prove the current one).
router.post("/renter/password", requireRenter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const ok = await bcrypt.compare(
      String(currentPassword || ""),
      req.renter.passwordHash,
    );
    if (!ok) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect" });
    }
    if (String(newPassword || "").length < MIN_PASSWORD) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least " + MIN_PASSWORD + " characters",
      });
    }
    await setPassword(req.renter._id, newPassword);
    res.json({ success: true });
  } catch (err) {
    console.error("renter/password error:", err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
