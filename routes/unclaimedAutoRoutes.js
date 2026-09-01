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
    const [listed, sold, expired, released, skipped, removed, activeRows, soldRows, integrity] =
      await Promise.all([
        UnclaimedAccount.countDocuments({ status: "listed" }),
        UnclaimedAccount.countDocuments({ status: "sold" }),
        UnclaimedAccount.countDocuments({ status: "expired" }),
        UnclaimedAccount.countDocuments({ status: "released" }),
        UnclaimedAccount.countDocuments({ status: "skipped" }),
        UnclaimedAccount.countDocuments({ status: "removed" }),
        MarketplaceListing.countDocuments({ origin: engine.ORIGIN, status: "active" }),
        MarketplaceListing.countDocuments({ origin: engine.ORIGIN, status: "sold" }),
        engine.consistencyIssues(),
      ]);
    res.json({
      success: true,
      state: engine.status(),
      counts: { listed, sold, expired, released, skipped, removed, activeRows, soldRows },
      integrity,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ledger view (paged, optional ?status=, ?q= login search, ?game= filter).
// "held" maps to the listed+skipped bucket so the Drop archive's default
// filter works here too.
router.get("/api/unclaimed-auto/accounts", requireSuperadmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const status = String(req.query.status || "").trim();
    const q = String(req.query.q || "").trim().toLowerCase();
    const game = String(req.query.game || "").trim();
    const source = String(req.query.source || "").trim().toLowerCase();
    const filter = {};
    if (status === "held") filter.status = { $in: ["listed", "skipped"] };
    else if (status && status !== "all") filter.status = status;
    if (q) filter.loginLower = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (game) filter.game = game;
    if (source === "noclaim" || source === "webbot") filter.source = source;
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
        set: a.set ? String(a.set) : "",
        market: a.market || "",
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

// ---------------------------------------------------------------------------
// Unclaimed Drop archive — read-only browsing over UnclaimedAccount rows
// (no-claim + web-token farms). Grouping is done in JS over a projected
// find() (the collection is small; Atlas shared tier has allowDiskUse OFF),
// and credentials are resolved per-account on demand only.
// ---------------------------------------------------------------------------

const ARCHIVE_ACCOUNT_PROJECTION = {
  _id: 1,
  login: 1,
  source: 1,
  game: 1,
  drops: 1,
  status: 1,
  market: 1,
  listedAt: 1,
  soldAt: 1,
};

// ?status=: "held" (default, listed+skipped) | a raw status | "all"/empty.
function archiveStatusParam(req) {
  return String(req.query.status || "").trim().toLowerCase();
}

// ?source=: "noclaim" | "webbot" restricts to one farm; anything else = both.
function archiveSourceParam(req) {
  const s = String(req.query.source || "").trim().toLowerCase();
  return s === "noclaim" || s === "webbot" ? s : "";
}

// By-item rollup: one row per distinct item key, with distinct-account and
// total-unit counts (4x a drop on one account = accounts 1, units 4). The
// per-status breakdown is only meaningful when the view is unfiltered.
router.get("/api/unclaimed-auto/archive/by-item", requireSuperadmin, async (req, res) => {
  try {
    const status = archiveStatusParam(req);
    const filter = engine.archiveStatusFilter(status) || {};
    const src = archiveSourceParam(req);
    if (src) filter.source = src;
    const rows = await UnclaimedAccount.find(filter, {
      _id: 1,
      source: 1,
      game: 1,
      status: 1,
      drops: 1,
    }).lean();
    const withStatus = status === "all";
    res.json({ success: true, items: engine.groupArchiveByItem(rows, withStatus) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// By-game rollup: accounts + distinct item keys per game.
router.get("/api/unclaimed-auto/archive/by-game", requireSuperadmin, async (req, res) => {
  try {
    const status = archiveStatusParam(req);
    const filter = engine.archiveStatusFilter(status) || {};
    const src = archiveSourceParam(req);
    if (src) filter.source = src;
    const rows = await UnclaimedAccount.find(filter, {
      _id: 1,
      source: 1,
      game: 1,
      status: 1,
      drops: 1,
    }).lean();
    const withStatus = status === "all";
    res.json({ success: true, games: engine.groupArchiveByGame(rows, withStatus) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Which accounts hold a given item (by item key). NO credentials here — the
// frontend fetches them per account on click.
router.get("/api/unclaimed-auto/archive/item-accounts", requireSuperadmin, async (req, res) => {
  try {
    const itemKey = String(req.query.itemKey || "").trim();
    if (!itemKey)
      return res.status(400).json({ success: false, message: "itemKey required" });
    const filter = engine.archiveStatusFilter(archiveStatusParam(req)) || {};
    const src = archiveSourceParam(req);
    if (src) filter.source = src;
    // Match with the SAME key logic as the by-item rollup (engine.archiveItemKey)
    // rather than a raw `drops.itemKey` query, so a legacy drop with no stored
    // itemKey still drills down under its normalized game|name fallback key.
    const candidates = await UnclaimedAccount.find(filter, ARCHIVE_ACCOUNT_PROJECTION)
      .sort({ listedAt: 1, _id: 1 })
      .lean();
    const rows = candidates.filter((a) =>
      (a.drops || []).some((d) => engine.archiveItemKey(d, a.game) === itemKey),
    );
    res.json({
      success: true,
      accounts: rows.map((a) => ({
        id: String(a._id),
        login: a.login,
        source: a.source,
        status: a.status,
        market: a.market || "",
        game: a.game,
        drops: (a.drops || []).map((d) => d.name || ""),
        listedAt: a.listedAt,
        soldAt: a.soldAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// On-demand credential for one account (copy-password click only). Decrypts
// with prod's CRED_SECRET via the engine helper — never in a list payload.
router.get(
  "/api/unclaimed-auto/archive/account/:id/credential",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!/^[a-f0-9]{24}$/i.test(id))
        return res.status(400).json({ success: false, message: "bad id" });
      const ledger = await UnclaimedAccount.findById(id).lean();
      if (!ledger)
        return res.status(404).json({ success: false, message: "no such account" });
      const cred = await engine.credentialForLedger(ledger);
      res.json({
        success: true,
        login: cred.login,
        password: cred.password,
        email: cred.email || "",
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

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
    await engine.spendAccount(ledger, "manual mark sold");
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
    const release = !!req.body.release;
    const ok = await engine.expireAccount(ledger, { release });
    logEvent({
      category: "unclaimed",
      action: "manual_delist",
      actor: actorFromReq(req),
      subject: ledger.login || id,
      game: ledger.game || "",
      detail:
        "operator removed " + (ledger.market || "?") + " unit" +
        (release ? " + pool return" : ""),
    });
    res.json({ success: true, released: ok });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
