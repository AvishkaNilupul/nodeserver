const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const Reseller = require("../models/Reseller");
const ResellerAccount = require("../models/ResellerAccount");
const ResellerAudit = require("../models/ResellerAudit");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const {
  createReseller,
  setPassword,
  revealPassword,
  sanitizeReseller,
  parseAccessDate,
} = require("../utils/resellers");
const { decrypt } = require("../utils/secretBox");

const router = express.Router();
const MAX_LIST = 500;

function badId(id) {
  return !mongoose.isValidObjectId(id);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loginRegex(login) {
  return new RegExp("^" + escapeRegex(login) + "$", "i");
}

function listTokenRegex(value) {
  return new RegExp("(^|[,\\s])" + escapeRegex(value) + "($|[,\\s])", "i");
}

function parseLogins(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^login\s*:\s*(.*)$/i);
      return (match ? match[1] : line).trim();
    })
    .filter(Boolean)
    .map((login) => login.slice(0, 200));
}

function sessionAdmin(req) {
  return String(req.session?.admin?.username || req.session?.admin?.id || "");
}

async function audit({ reseller, action, accountLogin = "", ip = "", meta }) {
  return ResellerAudit.create({
    reseller,
    action,
    accountLogin: String(accountLogin || ""),
    ip: String(ip || ""),
    ...(meta === undefined ? {} : { meta }),
  });
}

async function countByReseller() {
  const rows = await ResellerAccount.aggregate([
    {
      $group: {
        _id: "$reseller",
        held: { $sum: 1 },
        needsConnect: {
          $sum: { $cond: [{ $eq: ["$needsConnect", true] }, 1, 0] },
        },
        sold: {
          $sum: { $cond: [{ $eq: ["$resellerStatus", "sold"] }, 1, 0] },
        },
      },
    },
  ]);
  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        held: row.held || 0,
        needsConnect: row.needsConnect || 0,
        sold: row.sold || 0,
      },
    ]),
  );
}

async function botCredentialView(row, botsById, resellersById) {
  const bot = botsById.get(String(row.botAccount));
  return {
    id: String(row._id),
    resellerId: String(row.reseller),
    reseller: resellersById.get(String(row.reseller)) || "",
    botAccountId: bot ? String(bot._id) : String(row.botAccount),
    login: row.login || bot?.login || "",
    password: bot?.credPassword ? decrypt(bot.credPassword) || "" : "",
    email: bot?.credEmail ? decrypt(bot.credEmail) || "" : "",
    token: row.showcaseOnly ? "" : row.clientSecret || bot?.clientSecret || "",
    clientSecret: row.showcaseOnly
      ? ""
      : row.clientSecret || bot?.clientSecret || "",
    game: row.game || "",
    resellerStatus: row.resellerStatus,
    showcaseOnly: row.showcaseOnly === true,
    resellerSoldAt: row.resellerSoldAt || null,
    resellerNote: row.resellerNote || "",
    receivedAt: row.receivedAt || null,
    needsConnect: row.needsConnect === true,
    connectSummary: row.connectSummary || [],
    lastVerifiedAt: row.lastVerifiedAt || null,
  };
}

async function rosterForRows(rows) {
  const ids = rows.map((row) => row.botAccount).filter(Boolean);
  const resellerIds = [
    ...new Set(rows.map((row) => String(row.reseller)).filter(Boolean)),
  ];
  const [bots, resellers] = await Promise.all([
    BotAccount.find({ _id: { $in: ids } }).lean(),
    Reseller.find({ _id: { $in: resellerIds } }, { username: 1 }).lean(),
  ]);
  const byId = new Map(bots.map((bot) => [String(bot._id), bot]));
  const resellerById = new Map(
    resellers.map((reseller) => [String(reseller._id), reseller.username]),
  );
  return Promise.all(
    rows.map((row) => botCredentialView(row, byId, resellerById)),
  );
}

async function connectSnapshot(botAccountId) {
  const drops = await DropLog.find({ account: botAccountId }).lean();
  const groups = new Map();
  let needsConnect = false;
  for (const drop of drops) {
    const game = String(drop.game || "");
    const requiredAccountLink = String(drop.requiredAccountLink || "");
    const key = game + "\u0000" + requiredAccountLink;
    if (!groups.has(key)) {
      groups.set(key, {
        game,
        requiredAccountLink,
        total: 0,
        connected: 0,
      });
    }
    const group = groups.get(key);
    const count = Math.max(1, Number(drop.count) || 1);
    group.total += count;
    if (drop.connected === true || drop.state === "connected") {
      group.connected += count;
    }
    if (drop.state === "connect" && drop.connected !== true)
      needsConnect = true;
  }
  const connectSummary = [...groups.values()].sort(
    (a, b) =>
      String(a.game).localeCompare(String(b.game)) ||
      String(a.requiredAccountLink).localeCompare(
        String(b.requiredAccountLink),
      ),
  );
  const primary = [...connectSummary].sort(
    (a, b) => b.total - a.total || String(a.game).localeCompare(String(b.game)),
  )[0];
  return { needsConnect, connectSummary, game: primary?.game || "" };
}

async function activeListingFor(bot) {
  const idPattern = listTokenRegex(String(bot._id));
  const loginPattern = listTokenRegex(String(bot.login || ""));
  return MarketplaceListing.findOne({
    status: "active",
    $or: [
      { accountId: idPattern },
      { accountLogin: loginPattern },
      { "units.accountId": idPattern },
      { "units.login": loginPattern },
    ],
  }).lean();
}

async function eligibility(login, reseller, planned = new Set()) {
  const original = String(login || "").trim();
  const bot = original
    ? await BotAccount.findOne({ login: loginRegex(original) }).lean()
    : null;
  if (!bot) return { login: original, ok: false, reason: "not found" };
  const clientSecret = String(bot.clientSecret || "");
  if (planned.has(clientSecret) || bot.resellerId) {
    return { login: original, ok: false, reason: "already assigned" };
  }
  const existing = await ResellerAccount.findOne({
    $or: [{ botAccount: bot._id }, { clientSecret }],
  }).lean();
  if (existing)
    return { login: original, ok: false, reason: "already assigned" };
  if (bot.soldBulkOrderId) {
    return { login: original, ok: false, reason: "reserved for bulk order" };
  }
  if (bot.soldAt) return { login: original, ok: false, reason: "already sold" };
  if (await DropLog.exists({ account: bot._id, soldAt: { $ne: null } })) {
    return { login: original, ok: false, reason: "has sold or reserved drops" };
  }
  if (await activeListingFor(bot)) {
    return {
      login: original,
      ok: false,
      reason: "attached to active marketplace listing",
    };
  }
  const snapshot = await connectSnapshot(bot._id);
  return {
    login: original,
    ok: true,
    bot,
    clientSecret,
    snapshot,
    drops: await DropLog.countDocuments({ account: bot._id }),
    reseller,
  };
}

function quotaReason(reseller, held, accepted) {
  const max = Math.max(0, Number(reseller.maxAccounts) || 0);
  return max > 0 && held + accepted >= max ? "account limit reached" : "";
}

async function assignOne(reseller, check, req) {
  const now = new Date();
  let row;
  let claimedBot = false;
  try {
    row = await ResellerAccount.create({
      reseller: reseller._id,
      botAccount: check.bot._id,
      clientSecret: check.clientSecret,
      login: check.bot.login || check.login,
      game: check.snapshot.game,
      receivedAt: now,
      needsConnect: check.snapshot.needsConnect,
      connectSummary: check.snapshot.connectSummary,
    });
    const owner = "reseller:" + reseller.username;
    if (await activeListingFor(check.bot)) {
      const unavailable = new Error("account no longer available");
      unavailable.code = "no_longer_available";
      throw unavailable;
    }
    const claim = await BotAccount.updateOne(
      {
        _id: check.bot._id,
        soldAt: null,
        soldBulkOrderId: { $in: ["", null] },
        resellerId: { $in: ["", null] },
      },
      {
        $set: {
          soldAt: now,
          soldToUsername: owner,
          resellerId: String(reseller._id),
        },
      },
    );
    if (claim.modifiedCount !== 1) {
      const unavailable = new Error("account no longer available");
      unavailable.code = "no_longer_available";
      throw unavailable;
    }
    claimedBot = true;
    await DropLog.updateMany(
      { account: check.bot._id, soldAt: null },
      {
        $set: {
          soldAt: now,
          soldToUsername: owner,
          soldResellerId: String(reseller._id),
        },
      },
    );
    const foreignReservation = await DropLog.exists({
      account: check.bot._id,
      soldAt: { $ne: null },
      soldResellerId: { $ne: String(reseller._id) },
    });
    if (foreignReservation) {
      const unavailable = new Error("account no longer available");
      unavailable.code = "no_longer_available";
      throw unavailable;
    }
    await audit({
      reseller: reseller._id,
      action: "assign",
      accountLogin: row.login,
      ip: req.ip || req.socket?.remoteAddress,
    });
    return row;
  } catch (err) {
    if (row) {
      if (claimedBot) {
        await BotAccount.updateOne(
          { _id: check.bot._id, resellerId: String(reseller._id) },
          { $set: { soldAt: null, soldToUsername: "", resellerId: "" } },
        ).catch(() => {});
      }
      await DropLog.updateMany(
        { account: check.bot._id, soldResellerId: String(reseller._id) },
        { $set: { soldAt: null, soldToUsername: "", soldResellerId: "" } },
      ).catch(() => {});
      await ResellerAccount.deleteOne({ _id: row._id }).catch(() => {});
    }
    if (err?.code === 11000) {
      const duplicate = new Error("already assigned");
      duplicate.code = "already_assigned";
      throw duplicate;
    }
    if (err?.code === "no_longer_available") throw err;
    throw err;
  }
}

async function reclaimRow(row, reseller, req) {
  if (row.showcaseOnly === true) {
    await ResellerAccount.deleteOne({ _id: row._id, reseller: reseller._id });
    await audit({
      reseller: reseller._id,
      action: "reclaim_showcase",
      accountLogin: row.login,
      ip: req.ip || req.socket?.remoteAddress,
    });
    return;
  }
  const resellerId = String(reseller._id);
  const bot = await BotAccount.findById(row.botAccount, {
    resellerId: 1,
  }).lean();
  if (bot && String(bot.resellerId || "") !== resellerId) {
    const mismatch = new Error("account reservation owner mismatch");
    mismatch.code = "reservation_mismatch";
    throw mismatch;
  }
  await DropLog.updateMany(
    { account: row.botAccount, soldResellerId: resellerId },
    { $set: { soldAt: null, soldToUsername: "", soldResellerId: "" } },
  );
  const released = await BotAccount.updateOne(
    { _id: row.botAccount, resellerId },
    { $set: { soldAt: null, soldToUsername: "", resellerId: "" } },
  );
  if (bot && released.matchedCount !== 1) {
    const mismatch = new Error("account reservation owner mismatch");
    mismatch.code = "reservation_mismatch";
    throw mismatch;
  }
  await ResellerAccount.deleteOne({ _id: row._id, reseller: reseller._id });
  await audit({
    reseller: reseller._id,
    action: "reclaim",
    accountLogin: row.login,
    ip: req.ip || req.socket?.remoteAddress,
  });
}

router.get("/resellers", requireSuperadmin, async (req, res) => {
  try {
    const [resellers, counts] = await Promise.all([
      Reseller.find({}).sort({ createdAt: -1 }).limit(MAX_LIST).lean(),
      countByReseller(),
    ]);
    res.json({
      success: true,
      resellers: resellers.map((reseller) => ({
        ...sanitizeReseller(reseller, { includeNotes: true }),
        ...(counts.get(String(reseller._id)) || {
          held: 0,
          needsConnect: 0,
          sold: 0,
        }),
      })),
    });
  } catch (err) {
    console.error("resellers list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/resellers", requireSuperadmin, async (req, res) => {
  try {
    const reseller = await createReseller({
      ...(req.body || {}),
      createdBy: sessionAdmin(req),
    });
    await audit({
      reseller: reseller._id,
      action: "create",
      ip: req.ip,
      meta: { createdBy: sessionAdmin(req) },
    });
    res.status(201).json({
      success: true,
      reseller: sanitizeReseller(reseller, { includeNotes: true }),
    });
  } catch (err) {
    const duplicate = /already exists/i.test(err.message || "");
    res
      .status(duplicate ? 409 : 400)
      .json({ success: false, message: err.message || "Invalid reseller" });
  }
});

router.get("/resellers/:id", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id).lean();
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    const [rows, auditRows] = await Promise.all([
      ResellerAccount.find({ reseller: reseller._id })
        .sort({ receivedAt: -1 })
        .limit(MAX_LIST)
        .lean(),
      ResellerAudit.find({ reseller: reseller._id })
        .sort({ at: -1 })
        .limit(MAX_LIST)
        .lean(),
    ]);
    res.json({
      success: true,
      reseller: {
        ...sanitizeReseller(reseller, { includeNotes: true }),
        held: rows.length,
        needsConnect: rows.filter((row) => row.needsConnect === true).length,
        sold: rows.filter((row) => row.resellerStatus === "sold").length,
      },
      accounts: await rosterForRows(rows),
      audit: auditRows,
    });
  } catch (err) {
    console.error("reseller detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/resellers/:id", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    const body = req.body || {};
    if (body.displayName !== undefined)
      reseller.displayName = String(body.displayName).slice(0, 80);
    if (body.notes !== undefined)
      reseller.notes = String(body.notes).slice(0, 500);
    if (body.maxAccounts !== undefined)
      reseller.maxAccounts = Math.max(
        0,
        Math.floor(Number(body.maxAccounts) || 0),
      );
    if (body.accessStart !== undefined)
      reseller.accessStart = parseAccessDate(body.accessStart);
    if (body.accessEnd !== undefined)
      reseller.accessEnd = parseAccessDate(body.accessEnd, { endOfDay: true });
    await reseller.save();
    await audit({
      reseller: reseller._id,
      action: "update",
      ip: req.ip,
      meta: {
        fields: Object.keys(body).filter((key) =>
          [
            "displayName",
            "notes",
            "maxAccounts",
            "accessStart",
            "accessEnd",
          ].includes(key),
        ),
      },
    });
    res.json({
      success: true,
      reseller: sanitizeReseller(reseller, { includeNotes: true }),
    });
  } catch (err) {
    console.error("reseller update error:", err.message);
    res
      .status(400)
      .json({ success: false, message: err.message || "Invalid update" });
  }
});

router.post("/resellers/:id/password", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await setPassword(req.params.id, req.body?.password);
    await audit({
      reseller: reseller._id,
      action: "password_reset",
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    res
      .status(/not found/i.test(err.message || "") ? 404 : 400)
      .json({ success: false, message: err.message || "Invalid password" });
  }
});

router.get("/resellers/:id/password", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    res.json({ success: true, password: revealPassword(reseller) });
  } catch (err) {
    console.error("reseller password reveal error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

async function setSuspended(req, res, suspended) {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findByIdAndUpdate(
      req.params.id,
      { $set: { status: suspended ? "suspended" : "active" } },
      { new: true },
    );
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    await audit({
      reseller: reseller._id,
      action: suspended ? "suspend" : "unsuspend",
      ip: req.ip,
    });
    res.json({
      success: true,
      reseller: sanitizeReseller(reseller, { includeNotes: true }),
    });
  } catch (err) {
    console.error("reseller suspension error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

router.post("/resellers/:id/suspend", requireSuperadmin, (req, res) =>
  setSuspended(req, res, true),
);
router.post("/resellers/:id/unsuspend", requireSuperadmin, (req, res) =>
  setSuspended(req, res, false),
);

async function assignmentReport(req, res, commit) {
  if (badId(req.params.id))
    return res.status(400).json({ success: false, message: "Bad reseller id" });
  const reseller = await Reseller.findById(req.params.id);
  if (!reseller)
    return res
      .status(404)
      .json({ success: false, message: "Reseller not found" });
  const logins = parseLogins(req.body?.logins);
  if (!logins.length)
    return res
      .status(400)
      .json({ success: false, message: "Paste at least one login" });
  const held = await ResellerAccount.countDocuments({ reseller: reseller._id });
  const assigned = [];
  const skipped = [];
  const preview = [];
  const planned = new Set();
  let accepted = 0;
  for (const login of logins) {
    let check;
    try {
      check = await eligibility(login, reseller, planned);
    } catch (err) {
      console.error("reseller assignment check error:", err.message);
      check = { login, ok: false, reason: "check failed" };
    }
    if (!check.ok) {
      skipped.push({ login, reason: check.reason });
      preview.push({
        login,
        status: "skipped",
        reason: check.reason,
        drops: 0,
      });
      continue;
    }
    const quota = quotaReason(reseller, held, accepted);
    if (quota) {
      skipped.push({ login, reason: quota });
      preview.push({
        login,
        status: "skipped",
        reason: quota,
        drops: check.drops,
      });
      continue;
    }
    preview.push({
      login,
      status: "assignable",
      reason: "ready",
      drops: check.drops,
      needsConnect: check.snapshot.needsConnect,
    });
    if (!commit) {
      accepted += 1;
      planned.add(check.clientSecret);
      continue;
    }
    try {
      const row = await assignOne(reseller, check, req);
      accepted += 1;
      planned.add(check.clientSecret);
      assigned.push({
        id: String(row._id),
        login: row.login,
        drops: check.drops,
      });
    } catch (err) {
      if (err.code === "already_assigned")
        skipped.push({ login, reason: "already assigned" });
      else if (err.code === "no_longer_available")
        skipped.push({ login, reason: "account no longer available" });
      else {
        console.error("reseller assignment error:", err.message);
        skipped.push({ login, reason: "assignment failed" });
      }
    }
  }
  if (!commit)
    return res.json({
      success: true,
      preview,
      held,
      maxAccounts: Number(reseller.maxAccounts) || 0,
    });
  res.json({ success: true, assigned, skipped });
}

// Resolve one username against the live BotAccount/DropLog collections before
// the operator commits an assignment. The response intentionally omits
// credentials; those remain behind the existing protected reveal flow.
router.get(
  "/resellers/:id/assign/lookup",
  requireSuperadmin,
  async (req, res) => {
    try {
      if (badId(req.params.id))
        return res
          .status(400)
          .json({ success: false, message: "Bad reseller id" });
      const reseller = await Reseller.findById(req.params.id);
      if (!reseller)
        return res
          .status(404)
          .json({ success: false, message: "Reseller not found" });
      const login = String(req.query.login || "").trim().slice(0, 200);
      if (!login || /[\r\n]/.test(login))
        return res
          .status(400)
          .json({ success: false, message: "Enter one username" });
      const bot = await BotAccount.findOne({ login: loginRegex(login) }).lean();
      if (!bot)
        return res.status(404).json({
          success: false,
          message: "Account not found",
          reason: "not found",
          login,
        });
      const check = await eligibility(login, reseller);
      const snapshot = check.snapshot || (await connectSnapshot(bot._id));
      const drops =
        check.drops ?? (await DropLog.countDocuments({ account: bot._id }));
      const held = await ResellerAccount.countDocuments({
        reseller: reseller._id,
      });
      const quota = check.ok ? quotaReason(reseller, held, 0) : "";
      const reason = check.ok ? quota || "" : check.reason;
      const assignable = !reason;
      return res.json({
        success: true,
        account: {
          login: bot.login || login,
          game: snapshot.game,
          drops,
          needsConnect: snapshot.needsConnect,
          connectSummary: snapshot.connectSummary,
          assignable,
          status: assignable ? "assignable" : reason,
        },
      });
    } catch (err) {
      console.error("reseller assignment lookup error:", err.message);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.post("/resellers/:id/showcase", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res.status(400).json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller)
      return res.status(404).json({ success: false, message: "Reseller not found" });
    const login = String(req.body?.login || "").trim().slice(0, 200);
    if (!login || /[\r\n]/.test(login))
      return res.status(400).json({ success: false, message: "Enter one username" });
    const bot = await BotAccount.findOne({ login: loginRegex(login) }).lean();
    if (!bot)
      return res.status(404).json({ success: false, message: "Account not found" });
    const existing = await ResellerAccount.findOne({
      reseller: reseller._id,
      botAccount: bot._id,
    });
    if (existing)
      return res.json({
        success: true,
        existing: true,
        account: { id: String(existing._id), login: existing.login },
      });
    const snapshot = await connectSnapshot(bot._id);
    const drops = await DropLog.countDocuments({ account: bot._id });
    const row = await ResellerAccount.create({
      reseller: reseller._id,
      botAccount: bot._id,
      clientSecret: `showcase:${reseller._id}:${bot.clientSecret}`,
      login: bot.login || login,
      game: snapshot.game,
      showcaseOnly: true,
      needsConnect: snapshot.needsConnect,
      connectSummary: snapshot.connectSummary,
    });
    await audit({
      reseller: reseller._id,
      action: "showcase",
      accountLogin: row.login,
      ip: req.ip || req.socket?.remoteAddress,
      meta: { drops },
    });
    return res.status(201).json({
      success: true,
      existing: false,
      account: { id: String(row._id), login: row.login, drops },
    });
  } catch (err) {
    if (err?.code === 11000)
      return res.status(409).json({
        success: false,
        message: "This account is already attached to a reseller",
      });
    console.error("reseller showcase error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post(
  "/resellers/:id/assign/preview",
  requireSuperadmin,
  async (req, res) => {
    try {
      return await assignmentReport(req, res, false);
    } catch (err) {
      console.error("reseller assignment preview error:", err.message);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);
router.post("/resellers/:id/assign", requireSuperadmin, async (req, res) => {
  try {
    return await assignmentReport(req, res, true);
  } catch (err) {
    console.error("reseller assignment error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/resellers/:id/reclaim", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    const ids = Array.isArray(req.body?.accountIds)
      ? [...new Set(req.body.accountIds.map(String))]
      : [];
    if (!ids.length || ids.some(badId))
      return res
        .status(400)
        .json({ success: false, message: "accountIds must contain valid ids" });
    const rows = await ResellerAccount.find({
      _id: { $in: ids },
      reseller: reseller._id,
    }).lean();
    if (rows.length !== ids.length)
      return res
        .status(404)
        .json({ success: false, message: "Reseller account not found" });
    for (const row of rows) await reclaimRow(row, reseller, req);
    res.json({
      success: true,
      reclaimed: rows.map((row) => ({ id: String(row._id), login: row.login })),
    });
  } catch (err) {
    console.error("reseller reclaim error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete(
  "/resellers/:id/accounts/:accountId",
  requireSuperadmin,
  async (req, res) => {
    try {
      if (badId(req.params.id) || badId(req.params.accountId)) {
        return res.status(400).json({ success: false, message: "Bad id" });
      }
      const reseller = await Reseller.findById(req.params.id);
      if (!reseller) {
        return res
          .status(404)
          .json({ success: false, message: "Reseller not found" });
      }
      const row = await ResellerAccount.findOne({
        _id: req.params.accountId,
        reseller: reseller._id,
      }).lean();
      if (!row) {
        return res
          .status(404)
          .json({ success: false, message: "Reseller account not found" });
      }
      await reclaimRow(row, reseller, req);
      return res.json({
        success: true,
        reclaimed: { id: String(row._id), login: row.login },
      });
    } catch (err) {
      console.error("single reseller reclaim error:", err.message);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.delete("/resellers/:id", requireSuperadmin, async (req, res) => {
  try {
    if (badId(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Bad reseller id" });
    const reseller = await Reseller.findById(req.params.id);
    if (!reseller)
      return res
        .status(404)
        .json({ success: false, message: "Reseller not found" });
    const rows = await ResellerAccount.find({ reseller: reseller._id }).lean();
    for (const row of rows) await reclaimRow(row, reseller, req);
    await audit({
      reseller: reseller._id,
      action: "delete",
      ip: req.ip,
      meta: { reclaimed: rows.length },
    });
    await Reseller.deleteOne({ _id: reseller._id });
    res.json({ success: true, reclaimed: rows.length });
  } catch (err) {
    console.error("reseller delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/reseller-accounts", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    if (req.query.reseller && req.query.reseller !== "all") {
      if (badId(req.query.reseller))
        return res
          .status(400)
          .json({ success: false, message: "Bad reseller id" });
      q.reseller = req.query.reseller;
    }
    const rows = await ResellerAccount.find(q)
      .sort({ login: 1 })
      .limit(MAX_LIST)
      .lean();
    res.json({ success: true, accounts: await rosterForRows(rows) });
  } catch (err) {
    console.error("reseller accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/reseller-audit", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    if (req.query.reseller && req.query.reseller !== "all") {
      if (badId(req.query.reseller))
        return res
          .status(400)
          .json({ success: false, message: "Bad reseller id" });
      q.reseller = req.query.reseller;
    }
    const rows = await ResellerAudit.find(q)
      .sort({ at: -1 })
      .limit(MAX_LIST)
      .lean();
    res.json({ success: true, audit: rows });
  } catch (err) {
    console.error("reseller audit list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
