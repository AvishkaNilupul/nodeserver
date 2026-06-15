const express = require("express");
const fsp = require("fs/promises");
const path = require("path");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const { encrypt, decrypt } = require("../utils/secretBox");
const scanner = require("../utils/dropScanner");

const router = express.Router();

// Same directory + filename rules as the bot manager.
const BOT_DIR = process.env.TWITCHBOT_DIR || "/root/twitchbot";
const FILE_RE = /^config(_\d{1,3})?\.json$/;

function containerForFile(file) {
  const m = file.match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  if (file === "config.json") return "twitchbot";
  return "";
}

function publicAccount(a) {
  return {
    id: a._id,
    login: a.login,
    twitchId: a.twitchId,
    configFile: a.configFile,
    container: a.container,
    enabled: a.enabled,
    dropCount: a.dropCount,
    lastScanAt: a.lastScanAt,
    lastScanStatus: a.lastScanStatus,
    lastScanError: a.lastScanError,
    hasPassword: a.hasPassword,
    credUsername: a.credUsername || "",
    credEmail: decrypt(a.credEmail),
  };
}

// ------------------------------------------------------------------
// Progress (for the global progress bar)
// ------------------------------------------------------------------
router.get("/drops-archive/progress", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, progress: await scanner.getProgress() });
  } catch (err) {
    console.error("drops-archive progress error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Account list
// ------------------------------------------------------------------
router.get("/drops-archive/accounts", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ login: re }, { credUsername: re }, { configFile: re }];
    }
    const status = String(req.query.status || "").trim();
    if (["ok", "token_invalid", "error", "pending"].includes(status)) {
      q.lastScanStatus = status;
    }
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const accounts = await BotAccount.find(q)
      .sort({ login: 1 })
      .limit(limit)
      .lean();
    res.json({ success: true, accounts: accounts.map(publicAccount) });
  } catch (err) {
    console.error("drops-archive accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// One account + its drops grouped by game
// ------------------------------------------------------------------
router.get(
  "/drops-archive/accounts/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const drops = await DropLog.find({ account: acc._id })
        .sort({ awardedAt: -1, lastSeenAt: -1 })
        .lean();
      const byGame = new Map();
      for (const d of drops) {
        const g = d.game || "Other rewards";
        if (!byGame.has(g)) byGame.set(g, []);
        byGame.get(g).push({
          benefitId: d.benefitId,
          itemKey: d.itemKey,
          name: d.name,
          image: d.imageLocal || d.imageURL,
          game: d.game,
          campaign: d.campaign,
          count: d.count,
          awardedAt: d.awardedAt,
          state: d.state,
          connected: d.connected,
          requiredAccountLink: d.requiredAccountLink,
          firstSeenAt: d.firstSeenAt,
          lastSeenAt: d.lastSeenAt,
        });
      }
      const games = [...byGame.entries()].map(([game, items]) => ({
        game,
        items,
      }));
      res.json({
        success: true,
        account: publicAccount(acc),
        totalDrops: drops.length,
        games,
      });
    } catch (err) {
      console.error("drops-archive account detail error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Reveal the decrypted password for one account (superadmin only, on demand).
router.get(
  "/drops-archive/accounts/:id/password",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id).lean();
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      res.json({ success: true, password: decrypt(acc.credPassword) });
    } catch (err) {
      console.error("drops-archive reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Manually edit credentials for one account.
router.put(
  "/drops-archive/accounts/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await BotAccount.findById(req.params.id);
      if (!acc) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const body = req.body || {};
      if (typeof body.username === "string") acc.credUsername = body.username.trim();
      if (typeof body.email === "string") acc.credEmail = encrypt(body.email.trim());
      if (typeof body.password === "string") {
        acc.credPassword = encrypt(body.password);
        acc.hasPassword = !!body.password;
      }
      await acc.save();
      res.json({ success: true, account: publicAccount(acc) });
    } catch (err) {
      console.error("drops-archive edit error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Force-scan one account immediately.
router.post(
  "/drops-archive/accounts/:id/scan",
  requireSuperadmin,
  async (req, res) => {
    try {
      const result = await scanner.scanAccountNow(req.params.id);
      res.json({ success: !!result.ok, result });
    } catch (err) {
      console.error("drops-archive scan error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Sync accounts from the bot config files
// ------------------------------------------------------------------
router.post("/drops-archive/sync", requireSuperadmin, async (req, res) => {
  try {
    let files;
    try {
      files = await fsp.readdir(BOT_DIR);
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Config directory not found: " + BOT_DIR + " (" + e.code + ")",
      });
    }
    const configs = files.filter((f) => FILE_RE.test(f)).sort();
    let found = 0;
    let inserted = 0;
    let updated = 0;
    for (const file of configs) {
      let data;
      try {
        data = JSON.parse(await fsp.readFile(path.join(BOT_DIR, file), "utf8"));
      } catch {
        continue;
      }
      const users =
        (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
      for (const u of users) {
        const token = typeof u.ClientSecret === "string" ? u.ClientSecret.trim() : "";
        if (!token) continue;
        found++;
        const r = await BotAccount.updateOne(
          { clientSecret: token },
          {
            $set: {
              login: u.Login || "",
              twitchId: u.Id == null ? "" : String(u.Id),
              uniqueId: u.UniqueId || "",
              configFile: file,
              container: containerForFile(file),
              enabled: u.Enabled !== false,
            },
          },
          { upsert: true },
        );
        if (r.upsertedCount) inserted++;
        else if (r.modifiedCount) updated++;
      }
    }
    res.json({
      success: true,
      filesRead: configs.length,
      accountsFound: found,
      inserted,
      updated,
    });
  } catch (err) {
    console.error("drops-archive sync error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Import credentials ({username, password, email}[]), match by login
// ------------------------------------------------------------------
router.post(
  "/drops-archive/credentials",
  requireSuperadmin,
  async (req, res) => {
    try {
      let list = req.body && req.body.accounts;
      if (typeof list === "string") {
        // Tolerate a pasted loose object sequence like the bot manager does.
        const trimmed = list.trim().replace(/,\s*$/, "");
        try {
          list = JSON.parse("[" + trimmed.replace(/^\[|\]$/g, "") + "]");
        } catch {
          try {
            list = JSON.parse(trimmed);
          } catch {
            return res
              .status(400)
              .json({ success: false, message: "Could not parse JSON" });
          }
        }
      }
      if (!Array.isArray(list)) {
        return res
          .status(400)
          .json({ success: false, message: "Expected an array of accounts" });
      }
      let matched = 0;
      const unmatched = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const username = String(item.username || "").trim();
        if (!username) continue;
        const re = new RegExp(
          "^" + username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
          "i",
        );
        const acc = await BotAccount.findOne({
          $or: [{ login: re }, { credUsername: re }],
        });
        if (!acc) {
          unmatched.push(username);
          continue;
        }
        acc.credUsername = username;
        if (item.email != null) acc.credEmail = encrypt(String(item.email).trim());
        if (item.password != null) {
          acc.credPassword = encrypt(String(item.password));
          acc.hasPassword = !!String(item.password);
        }
        await acc.save();
        matched++;
      }
      res.json({
        success: true,
        matched,
        unmatched,
        unmatchedCount: unmatched.length,
      });
    } catch (err) {
      console.error("drops-archive credentials error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Scheduler controls (pause/resume, rate)
// ------------------------------------------------------------------
router.post("/drops-archive/scheduler", requireSuperadmin, (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled === "boolean") scanner.setEnabled(body.enabled);
  if (body.intervalMs != null) scanner.setIntervalMs(body.intervalMs);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// Aggregated / cross-account views (for building sell orders)
// ------------------------------------------------------------------
function searchRegex(s) {
  return new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

// High-level totals for the dashboard header.
router.get("/drops-archive/overview", requireSuperadmin, async (req, res) => {
  try {
    const [accounts, totalDrops, totalItemsHeld, games, items] =
      await Promise.all([
        BotAccount.countDocuments({}),
        DropLog.countDocuments({}),
        DropLog.aggregate([
          { $group: { _id: null, n: { $sum: "$count" } } },
        ]),
        DropLog.distinct("game"),
        DropLog.distinct("itemKey"),
      ]);
    res.json({
      success: true,
      overview: {
        accounts,
        totalDrops,
        totalItemsHeld: (totalItemsHeld[0] && totalItemsHeld[0].n) || 0,
        games: games.filter(Boolean).length,
        items: items.filter(Boolean).length,
      },
    });
  } catch (err) {
    console.error("drops-archive overview error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One row per game: how many rewards, distinct items, accounts, total held.
router.get("/drops-archive/by-game", requireSuperadmin, async (req, res) => {
  try {
    const rows = await DropLog.aggregate([
      {
        $group: {
          _id: "$game",
          drops: { $sum: 1 },
          totalCount: { $sum: "$count" },
          accounts: { $addToSet: "$account" },
          items: { $addToSet: "$itemKey" },
        },
      },
      {
        $project: {
          _id: 0,
          game: "$_id",
          drops: 1,
          totalCount: 1,
          accounts: { $size: "$accounts" },
          items: { $size: "$items" },
        },
      },
      { $sort: { totalCount: -1 } },
    ]);
    res.json({ success: true, games: rows });
  } catch (err) {
    console.error("drops-archive by-game error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One row per distinct item (reward), collapsed across all accounts. This is
// the inventory view for selling: name, game, image, total held, # accounts.
router.get("/drops-archive/by-item", requireSuperadmin, async (req, res) => {
  try {
    const match = {};
    const game = String(req.query.game || "").trim();
    if (game) match.game = game === "Other rewards" ? "" : game;
    const search = String(req.query.search || "").trim();
    if (search) match.name = searchRegex(search);

    const rows = await DropLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$itemKey",
          name: { $first: "$name" },
          game: { $first: "$game" },
          imageLocal: { $max: "$imageLocal" },
          imageURL: { $first: "$imageURL" },
          campaign: { $first: "$campaign" },
          totalCount: { $sum: "$count" },
          accounts: { $addToSet: "$account" },
          claimed: {
            $sum: { $cond: [{ $eq: ["$state", "claimed"] }, 1, 0] },
          },
          connect: {
            $sum: { $cond: [{ $eq: ["$state", "connect"] }, 1, 0] },
          },
          connected: {
            $sum: { $cond: [{ $eq: ["$state", "connected"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          itemKey: "$_id",
          name: 1,
          game: 1,
          // Prefer the locally cached image; fall back to the live URL. Note
          // imageLocal defaults to "" (not null), so test its length.
          image: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$imageLocal", ""] } }, 0] },
              "$imageLocal",
              "$imageURL",
            ],
          },
          imageURL: 1,
          campaign: 1,
          totalCount: 1,
          accounts: { $size: "$accounts" },
          claimed: 1,
          connect: 1,
          connected: 1,
        },
      },
      { $sort: { accounts: -1, totalCount: -1 } },
      { $limit: 2000 },
    ]);
    res.json({ success: true, items: rows });
  } catch (err) {
    console.error("drops-archive by-item error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Which accounts hold a given item (by itemKey) — the delivery picker.
router.get(
  "/drops-archive/item-accounts",
  requireSuperadmin,
  async (req, res) => {
    try {
      const itemKey = String(req.query.itemKey || "").trim();
      if (!itemKey) {
        return res
          .status(400)
          .json({ success: false, message: "itemKey required" });
      }
      const rows = await DropLog.aggregate([
        { $match: { itemKey } },
        {
          $lookup: {
            from: "botaccounts",
            localField: "account",
            foreignField: "_id",
            as: "acc",
          },
        },
        { $unwind: { path: "$acc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            accountId: "$account",
            login: { $ifNull: ["$acc.login", "$login"] },
            container: "$acc.container",
            configFile: "$acc.configFile",
            hasPassword: "$acc.hasPassword",
            count: 1,
            state: 1,
            connected: 1,
            requiredAccountLink: 1,
            awardedAt: 1,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        },
        { $sort: { state: 1, login: 1 } },
      ]);
      const first = await DropLog.findOne({ itemKey })
        .select("name game imageLocal imageURL campaign")
        .lean();
      res.json({
        success: true,
        item: first
          ? {
              name: first.name,
              game: first.game,
              campaign: first.campaign,
              image: first.imageLocal || first.imageURL,
            }
          : {},
        accounts: rows,
      });
    } catch (err) {
      console.error("drops-archive item-accounts error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
