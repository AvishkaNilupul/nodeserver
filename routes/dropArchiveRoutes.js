const express = require("express");
const fsp = require("fs/promises");
const path = require("path");

const { requireSuperadmin } = require("../middleware/auth");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
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
      if (typeof body.username === "string")
        acc.credUsername = body.username.trim();
      if (typeof body.email === "string")
        acc.credEmail = encrypt(body.email.trim());
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
        const token =
          typeof u.ClientSecret === "string" ? u.ClientSecret.trim() : "";
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
        if (item.email != null)
          acc.credEmail = encrypt(String(item.email).trim());
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

// Aggregation expression for the grouping key: stored itemKey when present,
// else a computed name|game (handles rows logged before itemKey existed).
const itemKeyExpr = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ["$itemKey", ""] } }, 0] },
    "$itemKey",
    {
      $concat: [
        { $toLower: { $trim: { input: { $ifNull: ["$name", ""] } } } },
        "|",
        { $toLower: { $trim: { input: { $ifNull: ["$game", ""] } } } },
      ],
    },
  ],
};

// High-level totals for the dashboard header.
router.get("/drops-archive/overview", requireSuperadmin, async (req, res) => {
  try {
    const [accounts, totalDrops, totalItemsHeld, games, items] =
      await Promise.all([
        BotAccount.countDocuments({}),
        DropLog.countDocuments({}),
        DropLog.aggregate([{ $group: { _id: null, n: { $sum: "$count" } } }]),
        DropLog.distinct("game"),
        DropLog.aggregate([
          { $addFields: { _k: itemKeyExpr } },
          { $group: { _id: "$_k" } },
          { $count: "n" },
        ]),
      ]);
    res.json({
      success: true,
      overview: {
        accounts,
        totalDrops,
        totalItemsHeld: (totalItemsHeld[0] && totalItemsHeld[0].n) || 0,
        games: games.filter(Boolean).length,
        items: (items[0] && items[0].n) || 0,
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
      { $addFields: { _k: itemKeyExpr } },
      {
        $group: {
          _id: "$game",
          drops: { $sum: 1 },
          totalCount: { $sum: "$count" },
          accounts: { $addToSet: "$account" },
          items: { $addToSet: "$_k" },
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
      // Fall back to a computed name|game key for any row whose itemKey
      // wasn't backfilled yet, so items never merge into one bucket.
      { $addFields: { _k: itemKeyExpr } },
      {
        $group: {
          _id: "$_k",
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
        { $addFields: { _k: itemKeyExpr } },
        { $match: { _k: itemKey } },
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
            name: 1,
            game: 1,
            campaign: 1,
            imageLocal: 1,
            imageURL: 1,
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
      const first = rows[0];
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

// ------------------------------------------------------------------
// Sets / bundles — group items sold together as one order
// ------------------------------------------------------------------

// Resolve display metadata (name/game/image) for a list of itemKeys from the
// logged drops, so a set always shows accurate names/images.
async function resolveItemsMeta(keys) {
  const uniq = [
    ...new Set(keys.map((k) => String(k || "").trim()).filter(Boolean)),
  ];
  if (!uniq.length) return [];
  const rows = await DropLog.aggregate([
    { $addFields: { _k: itemKeyExpr } },
    { $match: { _k: { $in: uniq } } },
    {
      $group: {
        _id: "$_k",
        name: { $first: "$name" },
        game: { $first: "$game" },
        imageLocal: { $max: "$imageLocal" },
        imageURL: { $first: "$imageURL" },
      },
    },
  ]);
  const byKey = new Map(rows.map((r) => [r._id, r]));
  return uniq.map((k) => {
    const m = byKey.get(k) || {};
    return {
      itemKey: k,
      name: m.name || k.split("|")[0] || "Reward",
      game: m.game || k.split("|")[1] || "",
      image: m.imageLocal || m.imageURL || "",
    };
  });
}

function publicSet(s) {
  return {
    id: String(s._id),
    name: s.name,
    note: s.note || "",
    items: s.items || [],
    itemCount: (s.items || []).length,
    price: Number(s.price) || 0,
    listed: !!s.listed,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// List all sets (lightweight).
router.get("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const sets = await DropSet.find({}).sort({ updatedAt: -1 }).lean();
    res.json({
      success: true,
      sets: sets.map((s) => ({
        id: String(s._id),
        name: s.name,
        note: s.note || "",
        items: s.items || [],
        itemCount: (s.items || []).length,
        price: Number(s.price) || 0,
        listed: !!s.listed,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (err) {
    console.error("drops-archive sets list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a set.
router.post("/drops-archive/sets", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, message: "Name required" });
    }
    const keys = Array.isArray(body.itemKeys) ? body.itemKeys : [];
    const items = await resolveItemsMeta(keys);
    const set = await DropSet.create({
      name,
      note: String(body.note || "").trim(),
      items,
    });
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update a set: rename, note, replace/add/remove items.
router.put("/drops-archive/sets/:id", requireSuperadmin, async (req, res) => {
  try {
    const set = await DropSet.findById(req.params.id);
    if (!set) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const body = req.body || {};
    if (typeof body.name === "string" && body.name.trim()) {
      set.name = body.name.trim();
    }
    if (typeof body.note === "string") set.note = body.note.trim();

    // Shop listing controls (superadmin only — this whole route is guarded by
    // requireSuperadmin). Price is a flat amount; listed toggles visibility in
    // the Shop tab for regular admins.
    if (body.price !== undefined) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid price" });
      }
      set.price = Math.round(price * 100) / 100;
    }
    if (body.listed !== undefined) set.listed = !!body.listed;

    let keys = set.items.map((i) => i.itemKey);
    if (Array.isArray(body.itemKeys)) keys = body.itemKeys;
    if (Array.isArray(body.addItemKeys)) keys = keys.concat(body.addItemKeys);
    if (Array.isArray(body.removeItemKeys)) {
      const rm = new Set(body.removeItemKeys);
      keys = keys.filter((k) => !rm.has(k));
    }
    set.items = await resolveItemsMeta(keys);
    await set.save();
    res.json({ success: true, set: publicSet(set) });
  } catch (err) {
    console.error("drops-archive set update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delete a set.
router.delete(
  "/drops-archive/sets/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      await DropSet.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error("drops-archive set delete error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Fulfillment: which accounts can deliver the whole bundle, plus per-item stock.
router.get(
  "/drops-archive/sets/:id/fulfillment",
  requireSuperadmin,
  async (req, res) => {
    try {
      const set = await DropSet.findById(req.params.id).lean();
      if (!set) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      const keys = (set.items || []).map((i) => i.itemKey);
      if (!keys.length) {
        return res.json({
          success: true,
          set: {
            id: String(set._id),
            name: set.name,
            note: set.note || "",
            price: Number(set.price) || 0,
            listed: !!set.listed,
          },
          items: set.items || [],
          accounts: [],
          fullAccounts: 0,
          bundlesAvailable: 0,
        });
      }

      // Per account: which of the set's items they hold and the count of each.
      const rows = await DropLog.aggregate([
        { $addFields: { _k: itemKeyExpr } },
        { $match: { _k: { $in: keys } } },
        {
          $group: {
            _id: { account: "$account", k: "$_k" },
            count: { $sum: "$count" },
            state: { $first: "$state" },
          },
        },
        {
          $group: {
            _id: "$_id.account",
            items: {
              $push: { itemKey: "$_id.k", count: "$count", state: "$state" },
            },
          },
        },
        {
          $lookup: {
            from: "botaccounts",
            localField: "_id",
            foreignField: "_id",
            as: "acc",
          },
        },
        { $unwind: { path: "$acc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            accountId: "$_id",
            login: "$acc.login",
            container: "$acc.container",
            configFile: "$acc.configFile",
            soldAt: "$acc.soldAt",
            hasPassword: {
              $gt: [{ $strLenCP: { $ifNull: ["$acc.credPassword", ""] } }, 0],
            },
            items: 1,
          },
        },
      ]);

      const total = keys.length;
      const accounts = rows
        .map((r) => {
          const have = r.items.length;
          const complete = have === total;
          const minCount = complete
            ? Math.min(...r.items.map((i) => i.count || 0))
            : 0;
          return {
            accountId: r.accountId,
            login: r.login || "",
            container: r.container || "",
            configFile: r.configFile || "",
            hasPassword: !!r.hasPassword,
            sold: !!r.soldAt,
            have,
            total,
            complete,
            minCount,
            haveKeys: r.items.map((i) => i.itemKey),
          };
        })
        .sort((a, b) => b.have - a.have || b.minCount - a.minCount);

      // Per-item stock across all accounts.
      const perItem = await DropLog.aggregate([
        { $addFields: { _k: itemKeyExpr } },
        { $match: { _k: { $in: keys } } },
        {
          $group: {
            _id: "$_k",
            totalCount: { $sum: "$count" },
            accounts: { $addToSet: "$account" },
          },
        },
      ]);
      const stockByKey = new Map(
        perItem.map((p) => [
          p._id,
          { totalCount: p.totalCount, accounts: p.accounts.length },
        ]),
      );
      const items = (set.items || []).map((it) => {
        const s = stockByKey.get(it.itemKey) || { totalCount: 0, accounts: 0 };
        return { ...it, totalCount: s.totalCount, accounts: s.accounts };
      });

      const fullAccounts = accounts.filter((a) => a.complete);
      // One deliverable bundle per account that holds the whole set and is
      // actually sellable (has a stored password and hasn't been sold). This
      // matches the Shop's "in stock" exactly — a buyer receives the whole
      // account, so duplicate copies on one account are not counted twice.
      const bundlesAvailable = fullAccounts.filter(
        (a) => a.hasPassword && !a.sold,
      ).length;

      res.json({
        success: true,
        set: {
          id: String(set._id),
          name: set.name,
          note: set.note || "",
          price: Number(set.price) || 0,
          listed: !!set.listed,
        },
        items,
        accounts,
        fullAccounts: fullAccounts.length,
        bundlesAvailable,
      });
    } catch (err) {
      console.error("drops-archive fulfillment error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
