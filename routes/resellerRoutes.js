const express = require("express");
const mongoose = require("mongoose");

const { requireReseller } = require("../middleware/resellerAuth");
const {
  resellerRevealLimiter,
  resellerLiveLimiter,
} = require("../utils/rateLimit");
const { isExpired } = require("../utils/resellers");
const { decrypt } = require("../utils/secretBox");
const twitchInventory = require("../utils/twitchInventory");
const ResellerAccount = require("../models/ResellerAccount");
const ResellerAudit = require("../models/ResellerAudit");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const resellerFarmingForecast = require("../utils/resellerFarmingForecast");

const router = express.Router();
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_DETAIL_DROPS = 500;
const STATUSES = new Set(["received", "listed", "sold", "returned"]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "");
}

async function ownAccount(reseller, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return ResellerAccount.findOne({ _id: id, reseller: reseller._id });
}

function connectionSnapshot(drops) {
  const groups = new Map();
  let needsConnect = false;
  for (const drop of drops) {
    const game = String(drop.game || "");
    const requiredAccountLink = String(drop.requiredAccountLink || "");
    const key = game + "\u0000" + requiredAccountLink;
    if (!groups.has(key)) {
      groups.set(key, { game, requiredAccountLink, total: 0, connected: 0 });
    }
    const group = groups.get(key);
    const count = Math.max(1, Number(drop.count) || 1);
    group.total += count;
    if (drop.connected === true || drop.state === "connected") {
      group.connected += count;
    }
    if (drop.state === "connect" && drop.connected !== true) {
      needsConnect = true;
    }
  }
  const connectSummary = [...groups.values()].sort(
    (a, b) =>
      a.game.localeCompare(b.game) ||
      a.requiredAccountLink.localeCompare(b.requiredAccountLink),
  );
  const primary = [...connectSummary].sort(
    (a, b) => b.total - a.total || a.game.localeCompare(b.game),
  )[0];
  return { needsConnect, connectSummary, game: primary?.game || "" };
}

async function audit(req, action, account, meta = {}) {
  return ResellerAudit.create({
    reseller: req.reseller._id,
    action,
    accountLogin: account?.login || "",
    ip: clientIp(req),
    meta,
  });
}

router.get("/reseller/me", requireReseller, async (req, res) => {
  try {
    const [counts, loginAudits] = await Promise.all([
      ResellerAccount.aggregate([
        { $match: { reseller: req.reseller._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            received: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "received"] }, 1, 0] },
            },
            listed: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "listed"] }, 1, 0] },
            },
            sold: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "sold"] }, 1, 0] },
            },
            returned: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "returned"] }, 1, 0] },
            },
          },
        },
      ]),
      ResellerAudit.find(
        { reseller: req.reseller._id, action: "login" },
        { at: 1 },
      )
        .sort({ at: -1 })
        .limit(2)
        .lean(),
    ]);
    const previousLoginAt =
      loginAudits[1]?.at || req.reseller.lastLoginAt || new Date(0);
    const funnel = counts[0] || {
      total: 0,
      received: 0,
      listed: 0,
      sold: 0,
      returned: 0,
      fresh: 0,
    };
    const fresh = await ResellerAccount.countDocuments({
      reseller: req.reseller._id,
      receivedAt: { $gt: previousLoginAt },
    });
    res.json({
      success: true,
      me: {
        username: req.reseller.username,
        displayName: req.reseller.displayName || "",
        status: req.reseller.status,
        accountCount: funnel.total || 0,
        funnel: {
          received: funnel.received || 0,
          listed: funnel.listed || 0,
          sold: funnel.sold || 0,
          returned: funnel.returned || 0,
        },
        freshAccounts: fresh,
        lease: {
          start: req.reseller.accessStart || null,
          end: req.reseller.accessEnd || null,
          expired: isExpired(req.reseller),
        },
      },
    });
  } catch (err) {
    console.error("reseller me error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/reseller/summary", requireReseller, async (req, res) => {
  try {
    const [totals, games] = await Promise.all([
      ResellerAccount.aggregate([
        { $match: { reseller: req.reseller._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            needsConnect: {
              $sum: { $cond: [{ $eq: ["$needsConnect", true] }, 1, 0] },
            },
            sold: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "sold"] }, 1, 0] },
            },
          },
        },
      ]),
      ResellerAccount.aggregate([
        { $match: { reseller: req.reseller._id } },
        {
          $group: {
            _id: { $ifNull: ["$game", ""] },
            total: { $sum: 1 },
            needsConnect: {
              $sum: { $cond: [{ $eq: ["$needsConnect", true] }, 1, 0] },
            },
            sold: {
              $sum: { $cond: [{ $eq: ["$resellerStatus", "sold"] }, 1, 0] },
            },
          },
        },
        { $sort: { total: -1, _id: 1 } },
        { $limit: 100 },
      ]),
    ]);
    const total = totals[0]?.total || 0;
    const needsConnect = totals[0]?.needsConnect || 0;
    res.json({
      success: true,
      summary: {
        total,
        received: total,
        needsConnect,
        connected: Math.max(0, total - needsConnect),
        sold: totals[0]?.sold || 0,
        games: games.map((row) => ({
          game: row._id || "Unspecified",
          total: row.total || 0,
          needsConnect: row.needsConnect || 0,
          sold: row.sold || 0,
        })),
      },
    });
  } catch (err) {
    console.error("reseller summary error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Read-only aggregate view of the operator's active farming pipeline. It is
// intentionally not account-scoped data: no login, token, host, config file,
// or individual bot identity crosses the reseller boundary.
router.get("/reseller/farming-forecast", requireReseller, async (req, res) => {
  try {
    res.json({
      success: true,
      forecast: await resellerFarmingForecast.getForecast(),
    });
  } catch (err) {
    console.error("reseller farming forecast error:", err.message);
    res.status(503).json({
      success: false,
      code: "forecast_unavailable",
      message: "Farming forecast is temporarily unavailable. Try again shortly.",
    });
  }
});

router.get("/reseller/accounts", requireReseller, async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = Math.min(
      MAX_PAGE_SIZE,
      positiveInt(req.query.limit, DEFAULT_PAGE_SIZE),
    );
    const filter = { reseller: req.reseller._id };
    if (STATUSES.has(String(req.query.status || ""))) {
      filter.resellerStatus = String(req.query.status);
    }
    if (req.query.needsConnect === "true") filter.needsConnect = true;
    if (req.query.needsConnect === "false") filter.needsConnect = false;
    const game = String(req.query.game || "")
      .trim()
      .slice(0, 100);
    if (game) filter.game = new RegExp("^" + escapeRegex(game) + "$", "i");
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 100);
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ login: re }, { game: re }];
    }

    const [total, rows] = await Promise.all([
      ResellerAccount.countDocuments(filter),
      ResellerAccount.find(filter, {
        login: 1,
        game: 1,
        resellerStatus: 1,
        showcaseOnly: 1,
        needsConnect: 1,
        receivedAt: 1,
        lastVerifiedAt: 1,
        botAccount: 1,
      })
        .sort({ receivedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const botIds = rows.map((row) => row.botAccount).filter(Boolean);
    const summaries = botIds.length
      ? await DropLog.aggregate([
          { $match: { account: { $in: botIds } } },
          { $sort: { awardedAt: -1, createdAt: -1 } },
          {
            $group: {
              _id: "$account",
              count: { $sum: { $ifNull: ["$count", 1] } },
              name: { $first: "$name" },
              imageLocal: { $first: "$imageLocal" },
              imageURL: { $first: "$imageURL" },
            },
          },
        ])
      : [];
    const dropsByAccount = new Map(
      summaries.map((item) => [String(item._id), item]),
    );
    res.json({
      success: true,
      accounts: rows.map((row) => {
        const drops = dropsByAccount.get(String(row.botAccount));
        return {
          id: String(row._id),
          login: row.login || "",
          game: row.game || "",
          resellerStatus: row.resellerStatus,
          showcaseOnly: row.showcaseOnly === true,
          needsConnect: row.needsConnect === true,
          receivedAt: row.receivedAt || null,
          lastVerifiedAt: row.lastVerifiedAt || null,
          drops: {
            count: drops?.count || 0,
            topReward: drops
              ? {
                  name: drops.name || "Reward",
                  image: drops.imageLocal || drops.imageURL || "",
                }
              : null,
          },
        };
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("reseller accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/reseller/accounts/:id", requireReseller, async (req, res) => {
  try {
    const account = await ownAccount(req.reseller, req.params.id);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }
    const drops = await DropLog.find(
      { account: account.botAccount },
      {
        name: 1,
        game: 1,
        imageLocal: 1,
        imageURL: 1,
        count: 1,
        state: 1,
        connected: 1,
        requiredAccountLink: 1,
        awardedAt: 1,
      },
    )
      .sort({ game: 1, name: 1 })
      .limit(MAX_DETAIL_DROPS)
      .lean();
    const groups = new Map();
    for (const drop of drops) {
      const game = drop.game || "Other";
      if (!groups.has(game)) groups.set(game, []);
      groups.get(game).push({
        id: String(drop._id),
        name: drop.name || "Reward",
        image: drop.imageLocal || drop.imageURL || "",
        count: Math.max(1, Number(drop.count) || 1),
        state: drop.state || "claimed",
        connected: drop.connected === true,
        requiredAccountLink: drop.requiredAccountLink || "",
        awardedAt: drop.awardedAt || null,
      });
    }
    res.json({
      success: true,
      account: {
        id: String(account._id),
        login: account.login || "",
        game: account.game || "",
        resellerStatus: account.resellerStatus,
        showcaseOnly: account.showcaseOnly === true,
        resellerNote: account.resellerNote || "",
        resellerSoldAt: account.resellerSoldAt || null,
        receivedAt: account.receivedAt || null,
        needsConnect: account.needsConnect === true,
        connectSummary: account.connectSummary || [],
        lastVerifiedAt: account.lastVerifiedAt || null,
        dropCount: drops.reduce(
          (sum, drop) => sum + Math.max(1, Number(drop.count) || 1),
          0,
        ),
        dropGroups: [...groups].map(([game, rewards]) => ({ game, rewards })),
      },
    });
  } catch (err) {
    console.error("reseller account detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/reseller/accounts/:id/credentials",
  requireReseller,
  resellerRevealLimiter,
  async (req, res) => {
    try {
      const account = await ownAccount(req.reseller, req.params.id);
      if (!account) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      if (account.showcaseOnly)
        return res.status(403).json({
          success: false,
          message: "Showcase accounts are read-only",
        });
      const bot = await BotAccount.findById(account.botAccount, {
        login: 1,
        clientSecret: 1,
        credPassword: 1,
        credEmail: 1,
      }).lean();
      if (!bot) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      // Audit before returning the secret. If the audit store is unavailable,
      // fail closed so no credential can be revealed without a durable trail.
      await audit(req, "reveal_creds", account);
      res.json({
        success: true,
        credentials: {
          login: account.login || bot.login || "",
          password: decrypt(bot.credPassword) || "",
          email: decrypt(bot.credEmail) || "",
          token: account.clientSecret || bot.clientSecret || "",
        },
      });
    } catch (err) {
      console.error("reseller credential reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.post(
  "/reseller/accounts/:id/status",
  requireReseller,
  async (req, res) => {
    try {
      const account = await ownAccount(req.reseller, req.params.id);
      if (!account) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      if (account.showcaseOnly)
        return res.status(403).json({
          success: false,
          message: "Showcase accounts are read-only",
        });
      const status = String(req.body?.status || "");
      if (!STATUSES.has(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be received, listed, sold, or returned",
        });
      }
      account.resellerStatus = status;
      if (req.body?.note !== undefined) {
        account.resellerNote = String(req.body.note || "").slice(0, 500);
      }
      account.resellerSoldAt = status === "sold" ? new Date() : null;
      await account.save();
      await audit(
        req,
        status === "sold" ? "mark_sold" : "status_change",
        account,
        {
          status,
        },
      );
      res.json({
        success: true,
        account: {
          id: String(account._id),
          resellerStatus: account.resellerStatus,
          resellerNote: account.resellerNote || "",
          resellerSoldAt: account.resellerSoldAt || null,
        },
      });
    } catch (err) {
      console.error("reseller status error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.post(
  "/reseller/accounts/:id/verify",
  requireReseller,
  resellerLiveLimiter,
  async (req, res) => {
    const account = await ownAccount(req.reseller, req.params.id);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: "Account not found" });
    }
    if (account.showcaseOnly)
      return res.status(403).json({
        success: false,
        message: "Showcase accounts are read-only",
      });
    const checkedAt = new Date();
    try {
      const inventory = await twitchInventory.fetchInventory(
        account.clientSecret,
        { host: null },
      );
      const owner = "reseller:" + req.reseller.username;
      const drops = (inventory.drops || [])
        .filter((drop) => drop && drop.benefitId)
        .slice(0, 1000);
      if (drops.length) {
        await DropLog.bulkWrite(
          drops.map((drop) => ({
            updateOne: {
              filter: {
                account: account.botAccount,
                benefitId: drop.benefitId,
              },
              update: {
                $set: {
                  accountModel: "BotAccount",
                  login: account.login || inventory.login || "",
                  dropId: drop.dropId || "",
                  name: drop.name || "Reward",
                  imageURL: drop.imageURL || "",
                  game: drop.game || "",
                  gameId: drop.gameId || "",
                  campaign: drop.campaign || "",
                  itemKey:
                    drop.itemKey ||
                    twitchInventory.itemKeyFor(drop.name, drop.game),
                  count: Math.max(1, Number(drop.count) || 1),
                  awardedAt: drop.awardedAt || null,
                  connected: drop.connected === true,
                  requiredAccountLink: drop.requiredAccountLink || "",
                  state: drop.state || "claimed",
                  source: drop.source || "gameEventDrop",
                  lastSeenAt: checkedAt,
                  soldAt: account.receivedAt || checkedAt,
                  soldToUsername: owner,
                  soldResellerId: String(req.reseller._id),
                },
                $setOnInsert: { firstSeenAt: checkedAt },
              },
              upsert: true,
            },
          })),
        );
      }
      const storedDrops = await DropLog.find(
        { account: account.botAccount },
        { game: 1, requiredAccountLink: 1, count: 1, connected: 1, state: 1 },
      ).lean();
      const snapshot = connectionSnapshot(storedDrops);
      account.needsConnect = snapshot.needsConnect;
      account.connectSummary = snapshot.connectSummary;
      if (snapshot.game) account.game = snapshot.game;
      account.lastVerifiedAt = checkedAt;
      await account.save();
      await BotAccount.updateOne(
        { _id: account.botAccount, resellerId: String(req.reseller._id) },
        {
          $set: {
            lastScanAt: checkedAt,
            lastScanStatus: "ok",
            lastScanError: "",
            twitchId: inventory.twitchId || "",
            dropCount: storedDrops.reduce(
              (sum, drop) => sum + Math.max(1, Number(drop.count) || 1),
              0,
            ),
          },
        },
      );
      await audit(req, "verify", account, {
        result: "ok",
        drops: storedDrops.length,
      });
      res.json({
        success: true,
        live: true,
        login: inventory.login || account.login || "",
        dropCount: storedDrops.length,
        needsConnect: account.needsConnect,
        connectSummary: account.connectSummary,
        lastVerifiedAt: account.lastVerifiedAt,
      });
    } catch (err) {
      account.lastVerifiedAt = checkedAt;
      await account.save().catch(() => {});
      const tokenInvalid = err.code === "token_invalid";
      await BotAccount.updateOne(
        { _id: account.botAccount, resellerId: String(req.reseller._id) },
        {
          $set: {
            lastScanAt: checkedAt,
            lastScanStatus: tokenInvalid ? "token_invalid" : "error",
            lastScanError: String(err.message || err).slice(0, 500),
          },
        },
      ).catch(() => {});
      await audit(req, "verify", account, {
        result: tokenInvalid ? "token_invalid" : "error",
      }).catch((auditErr) =>
        console.error("reseller verify audit error:", auditErr.message),
      );
      return res.status(tokenInvalid ? 400 : 502).json({
        success: false,
        code: tokenInvalid ? "token_invalid" : "twitch_unavailable",
        message: tokenInvalid
          ? "This account's Twitch token is no longer valid."
          : "Couldn't reach Twitch right now. Try again in a moment.",
      });
    }
  },
);

module.exports = router;
