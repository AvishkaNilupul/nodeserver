// ---------------------------------------------------------------------------
// Unclaimed-farms AUTO-LIST panel API (superadmin).
//
// Backs the "Auto-list" section of the combined Unclaimed farms tab
// (public/unclaimed-farms.html). The engine itself lives in
// utils/unclaimedAutoList.js — this is a thin, read-mostly layer: state,
// ledger, manual scan/refresh, pause, and the two operator overrides
// (mark-sold for a manual hand-over, delist+release).
// ---------------------------------------------------------------------------
const express = require("express");
const { requireSuperadmin } = require("../middleware/auth");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const settings = require("../utils/settings");
const engine = require("../utils/unclaimedAutoList");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");

const router = express.Router();

// Everything the panel's summary row needs: engine state + ledger counts +
// live unclaimed rows.
router.get("/api/unclaimed-auto/state", requireSuperadmin, async (req, res) => {
  try {
    const [listed, sold, expired, released, skipped, activeRows, soldRows] =
      await Promise.all([
        UnclaimedAccount.countDocuments({ status: "listed" }),
        UnclaimedAccount.countDocuments({ status: "sold" }),
        UnclaimedAccount.countDocuments({ status: "expired" }),
        UnclaimedAccount.countDocuments({ status: "released" }),
        UnclaimedAccount.countDocuments({ status: "skipped" }),
        MarketplaceListing.countDocuments({ origin: engine.ORIGIN, status: "active" }),
        MarketplaceListing.countDocuments({ origin: engine.ORIGIN, status: "sold" }),
      ]);
    res.json({
      success: true,
      state: engine.status(),
      counts: { listed, sold, expired, released, skipped, activeRows, soldRows },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ledger view (paged, optional ?status= and ?q= login search).
router.get("/api/unclaimed-auto/accounts", requireSuperadmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const status = String(req.query.status || "").trim();
    const q = String(req.query.q || "").trim().toLowerCase();
    const filter = {};
    if (status) filter.status = status;
    if (q) filter.loginLower = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const total = await UnclaimedAccount.countDocuments(filter);
    const rows = await UnclaimedAccount.find(filter)
      .sort({ listedAt: -1, updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();
    res.json({
      success: true,
      accounts: rows.map((a) => ({
        id: String(a._id),
        source: a.source,
        login: a.login,
        twitchId: a.twitchId,
        game: a.game,
        botId: a.botId,
        status: a.status,
        note: a.note,
        drops: a.drops || [],
        listedAt: a.listedAt,
        soldAt: a.soldAt,
        expiredAt: a.expiredAt,
        releasedAt: a.releasedAt,
        lastCheckedAt: a.lastCheckedAt,
      })),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Live unclaimed listing rows (for the panel's "on sale now" table).
router.get("/api/unclaimed-auto/listings", requireSuperadmin, async (req, res) => {
  try {
    const rows = await MarketplaceListing.find({ origin: engine.ORIGIN })
      .sort({ updatedAt: -1 })
      .limit(300)
      .select(
        "marketplace externalId url title price status accountLogin qtyRemaining qtyTarget lastError updatedAt",
      )
      .lean();
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual "list now" — runs the candidate scan + publish pass only.
router.post("/api/unclaimed-auto/scan", requireSuperadmin, async (req, res) => {
  try {
    const r = await engine.runOnce({ scan: true, check: false });
    res.json({ success: true, result: r });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual "check now" — expiry + sale pass only.
router.post("/api/unclaimed-auto/refresh", requireSuperadmin, async (req, res) => {
  try {
    const r = await engine.runOnce({ scan: false, check: true });
    res.json({ success: true, result: r });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pause / resume the automatic watcher (the manual buttons still work).
router.post("/api/unclaimed-auto/pause", requireSuperadmin, async (req, res) => {
  try {
    const paused = !!req.body.paused;
    await settings.setAutoFarm(
      { unclaimedAutoListPaused: paused },
      { actor: actorFromReq(req) },
    );
    res.json({ success: true, paused });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mark an account sold by hand (e.g. a ZeusX chat hand-over). Takes it down
// the spent path: stops farming it, stamps the pool row, never pool-returns.
router.post("/api/unclaimed-auto/sell/:id", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{24}$/i.test(id))
      return res.status(400).json({ success: false, message: "bad id" });
    const ledger = await UnclaimedAccount.findById(id).lean();
    if (!ledger)
      return res.status(404).json({ success: false, message: "no such account" });
    if (ledger.status !== "listed")
      return res
        .status(409)
        .json({ success: false, message: "account is not listed (" + ledger.status + ")" });
    const rows = await MarketplaceListing.find({
      origin: engine.ORIGIN,
      accountLogin: ledger.login,
    }).lean();
    await engine.spendAccount(ledger, "manual mark sold", { rows });
    logEvent({
      category: "unclaimed",
      action: "manual_sold",
      actor: actorFromReq(req),
      subject: ledger.login || id,
      game: ledger.game || "",
      detail: "operator marked unclaimed account sold by hand",
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Operator override: delist every row for the account NOW and (if the account
// has no sellable drops left, i.e. a forced expiry) return it to the pool.
router.post("/api/unclaimed-auto/delist/:id", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^[a-f0-9]{24}$/i.test(id))
      return res.status(400).json({ success: false, message: "bad id" });
    const ledger = await UnclaimedAccount.findById(id).lean();
    if (!ledger)
      return res.status(404).json({ success: false, message: "no such account" });
    const rows = await MarketplaceListing.find({
      origin: engine.ORIGIN,
      accountLogin: ledger.login,
    }).lean();
    const active = rows.filter((r) => r.status === "active");
    const results = await engine.delistRowsForAccount(active);
    const allOk = results.every((r) => r.ok);
    const release = !!req.body.release;
    if (release && allOk) {
      const ok = await engine.releaseToPool(ledger);
      await UnclaimedAccount.updateOne(
        { _id: ledger._id },
        {
          $set: {
            status: ok ? "released" : "expired",
            expiredAt: new Date(),
            releasedAt: ok ? new Date() : null,
            note: "operator delisted" + (ok ? " + returned to pool" : ""),
          },
        },
      );
    } else {
      await UnclaimedAccount.updateOne(
        { _id: ledger._id },
        { $set: { status: allOk ? "expired" : "listed", note: "operator delisted" } },
      );
    }
    logEvent({
      category: "unclaimed",
      action: "manual_delist",
      actor: actorFromReq(req),
      subject: ledger.login || id,
      game: ledger.game || "",
      detail: "operator delisted " + active.length + " row(s)" + (release ? " + pool return" : ""),
    });
    res.json({ success: true, delisted: results.length, allOk, released: release && allOk });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
