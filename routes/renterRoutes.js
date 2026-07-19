// Renter dashboard API. Every route is behind requireRenter, and every route
// derives its scope from req.renter (loaded from the DB by the middleware) —
// never from a path/param/body the client controls. A renter can therefore only
// ever see their own bot, their own accounts, and their own submissions.
const express = require("express");
const bcrypt = require("bcrypt");

const { requireRenter } = require("../middleware/renterAuth");
const { renterSubmitLimiter } = require("../utils/rateLimit");
const { isExpired, setPassword, MIN_PASSWORD } = require("../utils/renters");
const DropLog = require("../models/DropLog");
const RenterSubmission = require("../models/RenterSubmission");
const AvailableAccount = require("../models/AvailableAccount");
const hosts = require("../utils/botHosts");
const { encrypt } = require("../utils/secretBox");
const { parseAccountList } = require("../utils/parseAccountList");
const { containerForFile } = require("./botConfigRoutes");

const router = express.Router();

// A renter's accounts live in the account pool tagged with their id. Raw
// username:password credentials (what renters submit) can't farm until they're
// device-authed, and the pool is exactly the staging area the operator's
// device-auth + deploy tooling already works from — so approved renter accounts
// land there, keyed by renterId.
function renterAccountsQuery(renter) {
  return { renterId: String(renter._id) };
}
function poolAccountCount(renter) {
  return AvailableAccount.countDocuments(renterAccountsQuery(renter));
}

// Sum of accounts still waiting in pending submissions (counts against quota).
async function pendingAccountCount(renterId) {
  const rows = await RenterSubmission.find(
    { renter: renterId, status: "pending" },
    { count: 1 },
  ).lean();
  return rows.reduce((s, r) => s + (r.count || 0), 0);
}

// Renter-facing status for one pool account: honest about the device-auth step.
function poolStatus(a) {
  const s = a.lastCheckStatus;
  if (s === "ok") return "active";
  if (s === "token_invalid" || s === "integrity_failed" || s === "error")
    return "issue";
  return "pending"; // no valid token yet — awaiting activation
}

// GET /renter/me — their bot status, quota, lease.
router.get("/renter/me", requireRenter, async (req, res) => {
  try {
    const r = req.renter;
    const host = hosts.resolveHost(r.botHost);
    let running = null; // null = unknown (host offline / not assigned)
    if (r.botFile && host) {
      try {
        const states = await hosts.dockerPs(host);
        const st = states[containerForFile(r.botFile)];
        running = !!(st && /^running/i.test(st.state || ""));
      } catch {
        running = null;
      }
    }
    const used = await poolAccountCount(r);
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

// GET /renter/accounts — their account list (login + status + drop count).
// Sourced from the account pool by renterId. Never returns passwords or tokens.
router.get("/renter/accounts", requireRenter, async (req, res) => {
  try {
    const accs = await AvailableAccount.find(renterAccountsQuery(req.renter), {
      username: 1,
      lastCheckStatus: 1,
      dropCount: 1,
      lastCheckAt: 1,
    })
      .sort({ username: 1 })
      .lean();
    res.json({
      success: true,
      accounts: accs.map((a) => ({
        login: a.username || "",
        status: poolStatus(a),
        dropCount: a.dropCount || 0,
        lastScanAt: a.lastCheckAt || null,
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
    const ids = (
      await AvailableAccount.find(renterAccountsQuery(req.renter), {
        _id: 1,
      }).lean()
    ).map((a) => a._id);
    if (!ids.length) return res.json({ success: true, drops: [], total: 0 });
    const rows = await DropLog.aggregate([
      { $match: { account: { $in: ids }, accountModel: "AvailableAccount" } },
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
// touches a live bot; the parsed credentials are encrypted at rest. Accepts the
// same colon-delimited format suppliers use (utils/parseAccountList):
//   username:password  |  username:password:email  |  username:password:token
router.post("/renter/submit", renterSubmitLimiter, requireRenter, async (req, res) => {
  try {
    const r = req.renter;
    if (!r.botFile) {
      return res.status(400).json({
        success: false,
        message: "No bot assigned yet — contact the operator.",
      });
    }
    const { accounts: parsed, badLines } = parseAccountList(
      (req.body && req.body.accounts) || "",
    );
    if (!parsed.length) {
      return res.status(400).json({
        success: false,
        message:
          "No valid accounts found. Use username:password, one per line" +
          (badLines.length ? " (" + badLines.length + " line(s) couldn't be read)." : "."),
      });
    }
    // Quota: accounts already in the pool for this renter + pending + this batch.
    const used = await poolAccountCount(r);
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
    const logins = parsed.map((a) => a.username || "").filter(Boolean).slice(0, 200);
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
      skipped: badLines.length,
      message:
        "Submitted " +
        parsed.length +
        " account(s) for approval." +
        (badLines.length ? " " + badLines.length + " line(s) were skipped." : ""),
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
