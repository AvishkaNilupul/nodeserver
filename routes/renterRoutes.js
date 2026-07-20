// Renter dashboard API. Every route is behind requireRenter, and every route
// derives its scope from req.renter (loaded from the DB by the middleware) —
// never from a path/param/body the client controls. A renter can therefore only
// ever see and control their own bot, their own accounts, and their own
// submissions. They can start/stop their bot and check drops; they can never
// modify accounts, settings, or reach any other bot/renter/operator surface.
const express = require("express");

const { requireRenter } = require("../middleware/renterAuth");
const {
  renterSubmitLimiter,
  renterBotControlLimiter,
} = require("../utils/rateLimit");
const { isExpired } = require("../utils/renters");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const RenterSubmission = require("../models/RenterSubmission");
const hosts = require("../utils/botHosts");
const { encrypt } = require("../utils/secretBox");
const { parseAccountList } = require("../utils/parseAccountList");
const {
  containerForFile,
  countConfigAccounts,
  startConfigContainer,
  stopConfigContainer,
} = require("./botConfigRoutes");

const router = express.Router();

// The renter's accounts are the ones the operator deployed onto their dedicated
// bot config. Scope is built from req.renter (host + configFile) — never client
// input — so a renter can only ever see their own bot's accounts.
function accountFilter(renter) {
  if (!renter.botFile) return null;
  return { host: renter.botHost || "local", configFile: renter.botFile };
}

// Normalise a BotAccount scan status into a renter-friendly bucket.
function botStatus(s) {
  if (s === "ok") return "active";
  if (s === "token_invalid" || s === "error") return "issue";
  return "pending"; // not scanned yet / just added
}

// Sum of accounts still waiting in pending submissions (counts against quota).
async function pendingAccountCount(renterId) {
  const rows = await RenterSubmission.find(
    { renter: renterId, status: "pending" },
    { count: 1 },
  ).lean();
  return rows.reduce((s, r) => s + (r.count || 0), 0);
}

// Resolve the renter's own bot host, or null. Used by the bot-control routes so
// the target is always the renter's assigned bot — no host/file ever comes from
// the request.
function ownBot(renter) {
  if (!renter.botFile) return null;
  const host = hosts.resolveHost(renter.botHost);
  if (!host) return null;
  return { host, file: renter.botFile };
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

// GET /renter/accounts — their bot's accounts (login + status + drop count).
// Never returns tokens or passwords.
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
        status: botStatus(a.lastScanStatus),
        dropCount: a.dropCount || 0,
        lastScanAt: a.lastScanAt || null,
      })),
    });
  } catch (err) {
    console.error("renter/accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /renter/drops — drops their bot's accounts have farmed, grouped by reward.
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

// POST /renter/bot/start | /renter/bot/stop — control ONLY their own bot. The
// container is derived from req.renter's assigned config (never from the
// request), so a renter can never touch another bot. Rate-limited so start/stop
// can't be spammed against the host.
async function botControl(action, req, res) {
  const bot = ownBot(req.renter);
  if (!bot) {
    return res
      .status(400)
      .json({ success: false, message: "No bot assigned yet." });
  }
  try {
    if (action === "start") {
      await startConfigContainer(bot.host, bot.file);
    } else {
      await stopConfigContainer(bot.host, bot.file);
    }
    res.json({ success: true, running: action === "start" });
  } catch (e) {
    if (e.code === "disabled") {
      return res
        .status(403)
        .json({ success: false, message: "Bot control is disabled." });
    }
    if (e.code === "no_accounts") {
      return res.status(400).json({
        success: false,
        message: "Your bot has no accounts yet — ask the operator to add them.",
      });
    }
    if (e.unreachable) {
      return res
        .status(502)
        .json({ success: false, message: "The bot host is offline right now." });
    }
    console.error("renter bot " + action + " error:", e.message);
    res.status(500).json({ success: false, message: "Could not " + action + " the bot." });
  }
}
router.post("/renter/bot/start", renterBotControlLimiter, requireRenter, (req, res) =>
  botControl("start", req, res),
);
router.post("/renter/bot/stop", renterBotControlLimiter, requireRenter, (req, res) =>
  botControl("stop", req, res),
);

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
    // Quota: accounts already on their bot + already-pending + this batch must fit.
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

// GET /renter/submissions — their own submission history (no tokens/passwords).
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

// Renters cannot change their own password — it is set and viewable only by the
// operator (see routes/renterAdminRoutes.js). There is deliberately no renter
// password-change endpoint.

module.exports = router;
