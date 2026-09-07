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
const DropSet = require("../models/DropSet");
const MarketResearch = require("../models/MarketResearch");

const router = express.Router();

// v3 helper modules (docs/UNCLAIMED-BUNDLES-CONTRACT.md) are required lazily
// inside the handlers so this router still mounts (and the v2 panel still
// works) while a sibling module is missing or broken; the v3 endpoints then
// answer 503 with the load error instead of taking the whole server down.
function optionalModule(name) {
  try {
    return { mod: require(name) };
  } catch (err) {
    return { error: err };
  }
}
function moduleUnavailable(res, name, err) {
  return res.status(503).json({
    success: false,
    code: "module_unavailable",
    module: name,
    message: name + " is not available: " + (err && err.message ? err.message : String(err)),
  });
}

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
    if (source === "noclaim") filter.source = source;
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

// ?source=: "noclaim" restricts to the farm; anything else = unrestricted.
function archiveSourceParam(req) {
  const s = String(req.query.source || "").trim().toLowerCase();
  return s === "noclaim" ? s : "";
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

// ---------------------------------------------------------------------------
// v3 — bundles, repricing, lots, pricing settings
// (docs/UNCLAIMED-BUNDLES-CONTRACT.md, "Auto-list routes (agent R)").
// ---------------------------------------------------------------------------

const UNCLAIMED_BUNDLES_MODULE = "../utils/unclaimedBundles";
const UNCLAIMED_LOTS_MODULE = "../utils/unclaimedLots";

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round2(n) {
  return Math.round(toNum(n) * 100) / 100;
}
function gameKeyOf(game) {
  return settings.normGameName(String(game || ""));
}

// Resolve the MarketResearch doc for a game: exact name first (that is how
// autoLister keys it), then a normalised-name match so "Overwatch 2" and
// "overwatch 2" land on the same row.
function researchFor(rows, game) {
  const exact = rows.find((r) => r.game === game);
  if (exact) return exact;
  const gk = gameKeyOf(game);
  return rows.find((r) => gameKeyOf(r.game) === gk) || null;
}

function researchSummary(r) {
  const gf = (r && r.markets && r.markets.gameflip) || {};
  const lowest = toNum(gf.lowest, 0);
  const lowestOther = gf.lowestOther == null ? lowest : toNum(gf.lowestOther, lowest);
  return {
    demandScore: round2(r ? r.demandScore : 0),
    avgSoldPrice: round2(gf.avgSoldPrice),
    lowestOther: round2(lowestOther),
    ownSales: toNum(r ? r.ownSales : 0),
    unclaimedStock: toNum(r ? r.unclaimedStock : 0),
    unclaimedSold: toNum(r ? r.unclaimedSold : 0),
  };
}

// Catalog entries (buildEventCatalog values) that belong to one game. The
// contract keys events by normGame + "|" + eventName; match on gameKey or the
// normalised display game so either spelling lands.
function eventsForGame(catalog, game, now) {
  const gk = gameKeyOf(game);
  const out = [];
  for (const ev of catalog.values()) {
    if (!ev) continue;
    if (ev.gameKey !== gk && gameKeyOf(ev.game) !== gk) continue;
    out.push({
      name: ev.name || "",
      key: ev.key || "",
      startAt: ev.startAt || null,
      endAt: ev.endAt || null,
      waves: (ev.waves || []).map((w) => ({
        waveLabel: w.waveLabel || "",
        campaignId: w.campaignId || "",
        startAt: w.startAt || null,
        endAt: w.endAt || null,
        itemCount: (w.items || []).reduce((s, it) => s + Math.max(1, toNum(it.qty, 1)), 0),
        ended: !!(w.endAt && new Date(w.endAt).getTime() < now),
      })),
    });
  }
  out.sort((a, b) => new Date(b.startAt || 0) - new Date(a.startAt || 0));
  return out;
}

// Drops to classify a set with. Prefer a real ledger's drops (they carry the
// campaign name, which is how classifyHoldings resolves the wave); fall back
// to the set's items expanded by qty (itemKey fallback inside the classifier).
function dropsForClassification(set, ledger, game) {
  if (ledger && Array.isArray(ledger.drops) && ledger.drops.length) {
    return ledger.drops.map((d) => ({
      name: d.name || "",
      game: d.game || game,
      campaign: d.campaign || "",
      itemKey: d.itemKey || "",
    }));
  }
  const out = [];
  for (const it of (set && set.items) || []) {
    const qty = Math.max(1, Math.floor(toNum(it.qty, 1)));
    for (let i = 0; i < qty; i++)
      out.push({ name: it.name || "", game: it.game || game, campaign: "", itemKey: it.itemKey || "" });
  }
  return out;
}

// Everything the Bundles panel needs, grouped per game -> events + sets.
// Built from projected finds and grouped in JS (never $group: Atlas shared
// tier). Prices are recomputed live with the analytics pricer so the panel
// shows "current -> suggested (drift %)" without touching any row.
router.get("/api/unclaimed-auto/bundles", requireSuperadmin, async (req, res) => {
  const { mod: unclaimedBundles, error } = optionalModule(UNCLAIMED_BUNDLES_MODULE);
  if (!unclaimedBundles) return moduleUnavailable(res, UNCLAIMED_BUNDLES_MODULE, error);
  try {
    const now = Date.now();
    const pricing = settings.getUnclaimedPricing();
    const gameFilter = String(req.query.game || "").trim();

    const ledgerFilter = { status: { $in: ["listed", "sold", "skipped"] } };
    // ?game= is matched on the normalised label (case/punctuation-insensitive,
    // like every other game lookup here) — an exact Mongo match on "overwatch"
    // silently missed every "Overwatch" ledger.
    if (gameFilter) {
      const esc = gameFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      ledgerFilter.game = new RegExp("^\\s*" + esc + "\\s*$", "i");
    }
    const rowFilter = { origin: engine.ORIGIN, status: "active" };

    const [ledgers, activeRows] = await Promise.all([
      UnclaimedAccount.find(ledgerFilter, {
        _id: 1,
        game: 1,
        set: 1,
        market: 1,
        status: 1,
        lotId: 1,
        bundleKey: 1,
        bundleLabel: 1,
        drops: 1,
        loginLower: 1,
        login: 1,
        listedAt: 1,
      })
        .sort({ listedAt: -1 })
        .lean(),
      MarketplaceListing.find(rowFilter, {
        _id: 1,
        set: 1,
        marketplace: 1,
        price: 1,
        lotSize: 1,
        lotId: 1,
        accountLogin: 1,
        externalId: 1,
        units: 1,
      }).lean(),
    ]);

    // Sets referenced by either side.
    const setIds = new Set();
    for (const l of ledgers) if (l.set) setIds.add(String(l.set));
    for (const r of activeRows) if (r.set) setIds.add(String(r.set));
    const sets = setIds.size
      ? await DropSet.find(
          { _id: { $in: [...setIds] } },
          {
            _id: 1,
            name: 1,
            items: 1,
            price: 1,
            minPriceUsd: 1,
            sourceType: 1,
            sourceEventKey: 1,
            sourceEventName: 1,
            sourceCampaignIds: 1,
          },
        ).lean()
      : [];
    const setById = new Map(sets.map((s) => [String(s._id), s]));

    // set -> game: from its ledgers first, else the first item's game.
    const setGame = new Map();
    for (const l of ledgers)
      if (l.set && l.game && !setGame.has(String(l.set))) setGame.set(String(l.set), l.game);
    for (const s of sets) {
      const id = String(s._id);
      if (!setGame.has(id)) {
        const g = (s.items || []).map((it) => it.game).find(Boolean) || "";
        if (g) setGame.set(id, g);
      }
    }

    // Distinct games (display names) in first-seen order.
    const games = [];
    const seenGames = new Set();
    const addGame = (g) => {
      const key = gameKeyOf(g);
      if (!g || !key || seenGames.has(key)) return;
      seenGames.add(key);
      games.push(g);
    };
    for (const l of ledgers) addGame(l.game);
    for (const g of setGame.values()) addGame(g);
    if (gameFilter) {
      const want = gameKeyOf(gameFilter);
      for (let i = games.length - 1; i >= 0; i--) if (gameKeyOf(games[i]) !== want) games.splice(i, 1);
    }

    const [rawCatalog, researchRows] = await Promise.all([
      games.length ? unclaimedBundles.loadCatalog({ games }) : new Map(),
      MarketResearch.find(
        {},
        { game: 1, demandScore: 1, ownSales: 1, markets: 1, unclaimedStock: 1, unclaimedSold: 1 },
      ).lean(),
    ]);
    const catalog =
      rawCatalog instanceof Map
        ? rawCatalog
        : new Map(Object.entries(rawCatalog && typeof rawCatalog === "object" ? rawCatalog : {}));

    // Group ledgers / rows by set (and per-game totals) in JS.
    const ledgersBySet = new Map();
    const perGameTotals = new Map();
    for (const l of ledgers) {
      const gk = gameKeyOf(l.game);
      const t = perGameTotals.get(gk) || { listed: 0, sold: 0, held: 0 };
      if (l.status === "listed") t.listed++;
      else if (l.status === "sold") t.sold++;
      else if (l.status === "skipped") t.held++;
      perGameTotals.set(gk, t);
      // "held" (skipped) ledgers hold their drops but sit on no listing —
      // they are the manual bulk-sale stock, not set units.
      if (l.status === "skipped") continue;
      if (!l.set) continue;
      const id = String(l.set);
      if (!ledgersBySet.has(id)) ledgersBySet.set(id, []);
      ledgersBySet.get(id).push(l);
    }
    const rowsBySet = new Map();
    for (const r of activeRows) {
      if (!r.set) continue;
      const id = String(r.set);
      if (!rowsBySet.has(id)) rowsBySet.set(id, []);
      rowsBySet.get(id).push(r);
    }

    const out = [];
    for (const game of games) {
      const gk = gameKeyOf(game);
      const research = researchFor(researchRows, game);
      const totals = perGameTotals.get(gk) || { listed: 0, sold: 0, held: 0 };
      const setRows = [];

      for (const [setId, set] of setById) {
        if (gameKeyOf(setGame.get(setId) || "") !== gk) continue;
        const sl = ledgersBySet.get(setId) || [];
        const rows = rowsBySet.get(setId) || [];
        const rep = sl.find((l) => l.status === "listed") || sl[0] || null;

        let cls = null;
        try {
          cls = unclaimedBundles.classifyHoldings(
            game,
            dropsForClassification(set, rep, game),
            catalog,
            now,
          );
        } catch (e) {
          cls = null;
        }

        const items = (set.items || []).length
          ? (set.items || []).map((it) => ({
              name: it.name || "",
              itemKey: it.itemKey || "",
              qty: Math.max(1, Math.floor(toNum(it.qty, 1))),
            }))
          : ((cls && cls.items) || []).map((it) => ({
              name: it.name || "",
              itemKey: it.itemKey || "",
              qty: Math.max(1, Math.floor(toNum(it.qty, 1))),
            }));

        const singleRows = rows.filter((r) => !(toNum(r.lotSize, 0) > 0));
        const lotRows = rows.filter((r) => toNum(r.lotSize, 0) > 0);
        const liveGf = singleRows.filter((r) => r.marketplace === "gameflip");
        const liveLogins = new Set(
          liveGf.map((r) => String(r.accountLogin || "").toLowerCase()).filter(Boolean),
        );
        const listedLedgers = sl.filter((l) => l.status === "listed");
        const gfWaiting = listedLedgers.filter(
          (l) =>
            l.market === "gameflip" &&
            !l.lotId &&
            !liveLogins.has(String(l.loginLower || l.login || "").toLowerCase()),
        ).length;

        const current = toNum(set.price, 0) || toNum((singleRows[0] || {}).price, 0);
        let suggested = { price: null, anchorSource: "", floor: null, anchor: null, totalQty: 0, full: false };
        try {
          const p = unclaimedBundles.bundlePrice({ research, game, items, classification: cls, pricing });
          if (p)
            suggested = {
              price: round2(p.price),
              anchor: round2(p.anchor),
              anchorSource: p.anchorSource || "",
              floor: round2(p.floor),
              totalQty: toNum(p.totalQty, 0),
              full: !!p.full,
            };
        } catch (e) {
          suggested.error = e.message;
        }
        const driftPct =
          current > 0 && suggested.price != null
            ? Math.round(((suggested.price - current) / current) * 1000) / 10
            : null;

        setRows.push({
          setId,
          title: set.name || "",
          bundleLabel:
            (cls && cls.bundleLabel) || (rep && rep.bundleLabel) || set.sourceEventName || "",
          full: !!(cls && cls.full),
          wavesHeld: cls ? toNum(cls.wavesHeld, 0) : 0,
          wavesTotal: cls ? toNum(cls.wavesTotal, 0) : 0,
          eventKey: (cls && cls.event && cls.event.key) || set.sourceEventKey || "",
          eventName: (cls && cls.event && cls.event.name) || set.sourceEventName || "",
          items: items.map((it) => ({ name: it.name, qty: it.qty })),
          price: round2(current),
          minPriceUsd: round2(set.minPriceUsd),
          suggested,
          listed: {
            gameflip: { live: liveGf.length, waiting: gfWaiting },
            digiseller: listedLedgers.filter((l) => l.market === "digiseller").length,
            ggsel: listedLedgers.filter((l) => l.market === "ggsel").length,
          },
          lots: lotRows.length,
          sold: sl.filter((l) => l.status === "sold").length,
          driftPct,
        });
      }
      setRows.sort((a, b) => (b.listed.gameflip.live + b.listed.gameflip.waiting + b.listed.digiseller + b.listed.ggsel) - (a.listed.gameflip.live + a.listed.gameflip.waiting + a.listed.digiseller + a.listed.ggsel));

      out.push({
        game,
        noClaim: settings.isNoClaimGame(game),
        research: researchSummary(research),
        listed: totals.listed,
        sold: totals.sold,
        held: totals.held || 0,
        cap: engine.capForGame ? engine.capForGame(game) : engine.GAME_CAP,
        markets: settings.gameMarketsFor ? settings.gameMarketsFor(game) : null,
        events: eventsForGame(catalog, game, now),
        sets: setRows,
      });
    }

    res.json({ success: true, games: out, pricing, generatedAt: new Date(now) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reprice live unclaimed rows against the analytics pricer. {apply:false}
// (default) is a dry-run that only returns the plan; {apply:true} patches
// rows whose drift is at/over unclaimedRepriceDriftPct. Manual/auto-origin
// rows are never touched (the engine scopes to origin "unclaimed").
router.post("/api/unclaimed-auto/reprice", requireSuperadmin, async (req, res) => {
  if (typeof engine.repriceUnclaimedRows !== "function")
    return moduleUnavailable(
      res,
      "../utils/unclaimedAutoList#repriceUnclaimedRows",
      new Error("engine export missing"),
    );
  try {
    const apply = req.body && (req.body.apply === true || req.body.apply === "true");
    const pricing = settings.getUnclaimedPricing();
    const r = await engine.repriceUnclaimedRows({ apply });
    const plan = Array.isArray(r) ? r : r && Array.isArray(r.plan) ? r.plan : [];
    const driftPct = pricing.repriceDriftPct;
    const actionable = plan.filter((p) => Math.abs(toNum(p.driftPct, 0)) >= driftPct).length;
    if (apply)
      logEvent({
        category: "unclaimed",
        action: "manual_reprice",
        actor: actorFromReq(req),
        subject: "unclaimed rows",
        detail:
          "operator applied analytics repricing: " + actionable + "/" + plan.length +
          " rows at/over " + driftPct + "% drift",
        meta: { planned: plan.length, actionable, driftPct },
      });
    res.json({
      success: true,
      apply,
      driftPct,
      planned: plan.length,
      actionable,
      plan,
      result: Array.isArray(r) ? undefined : r,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Gameflip lot listings + the flag state that governs them.
router.get("/api/unclaimed-auto/lots", requireSuperadmin, async (req, res) => {
  const pricing = settings.getUnclaimedPricing();
  const flags = {
    enabled: !!pricing.lots,
    lotSize: pricing.lotSize,
    lotDiscountPct: pricing.lotDiscountPct,
  };
  const { mod: unclaimedLots, error } = optionalModule(UNCLAIMED_LOTS_MODULE);
  if (!unclaimedLots || typeof unclaimedLots.lotsSummary !== "function")
    return res.status(503).json({
      success: false,
      code: "module_unavailable",
      module: UNCLAIMED_LOTS_MODULE,
      message:
        UNCLAIMED_LOTS_MODULE + " is not available: " +
        (error && error.message ? error.message : "lotsSummary export missing"),
      ...flags,
      lots: [],
    });
  try {
    const lots = await unclaimedLots.lotsSummary();
    res.json({ success: true, ...flags, lots: Array.isArray(lots) ? lots : [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pricing settings. GET returns the merged accessor view plus the raw
// autoFarm keys the form posts back; POST validates a partial patch of ONLY
// the unclaimed* keys below and persists via setAutoFarm (audited).
const UNCLAIMED_PRICING_KEYS = {
  // key: [type, min, max, integer, accessor alias]
  unclaimedPriceFloorUsd: ["number", 0, 10000, false, "floorUsd"],
  unclaimedGameFloors: ["floors", null, null, false, "gameFloors"],
  unclaimedItemStepPct: ["number", 0, 1000, false, "itemStepPct"],
  unclaimedItemCapMult: ["number", 1, 100, false, "itemCapMult"],
  unclaimedFullEventBonusPct: ["number", 0, 1000, false, "fullEventBonusPct"],
  unclaimedRepriceExisting: ["boolean", null, null, false, "repriceExisting"],
  unclaimedRepriceDriftPct: ["number", 1, 1000, false, "repriceDriftPct"],
  unclaimedGameflipLots: ["boolean", null, null, false, "lots"],
  unclaimedLotSize: ["number", 2, 100, true, "lotSize"],
  unclaimedLotDiscountPct: ["number", 0, 90, false, "lotDiscountPct"],
  unclaimedExpiryConfirmPasses: ["number", 1, 50, true, "expiryConfirmPasses"],
  unclaimedGameMarkets: ["markets", null, null, false, "gameMarkets"],
  unclaimedGameCaps: ["caps", null, null, false, "gameCaps"],
};
const UNCLAIMED_ALIAS_TO_KEY = Object.fromEntries(
  Object.entries(UNCLAIMED_PRICING_KEYS).map(([k, spec]) => [spec[4], k]),
);

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "off" || v === "no" || v === "") return false;
  return null;
}

// Validate a partial patch. Returns { patch, ignored, errors }.
function validatePricingPatch(body) {
  const patch = {};
  const ignored = [];
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { patch, ignored, errors: ["body must be a JSON object"] };
  for (const [rawKey, value] of Object.entries(body)) {
    const key = UNCLAIMED_PRICING_KEYS[rawKey] ? rawKey : UNCLAIMED_ALIAS_TO_KEY[rawKey];
    if (!key) {
      ignored.push(rawKey);
      continue;
    }
    const [type, min, max, integer] = UNCLAIMED_PRICING_KEYS[key];
    if (type === "boolean") {
      const b = parseBool(value);
      if (b === null) errors.push(key + " must be a boolean");
      else patch[key] = b;
    } else if (type === "number") {
      const n = typeof value === "string" ? Number(value.trim()) : Number(value);
      if (value === "" || value === null || !Number.isFinite(n)) errors.push(key + " must be a number");
      else if (integer && !Number.isInteger(n)) errors.push(key + " must be an integer");
      else if (min != null && n < min) errors.push(key + " must be >= " + min);
      else if (max != null && n > max) errors.push(key + " must be <= " + max);
      else patch[key] = n;
    } else if (type === "floors") {
      // { "overwatch": 1.5, ... } — substring keys like noClaimGames; values
      // are USD floors. Accepts numeric strings; drops blank keys; a value of
      // 0 / "" removes the floor for that key.
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(key + " must be an object of { game: priceUsd }");
        continue;
      }
      const floors = {};
      for (const [g, v] of Object.entries(value)) {
        const name = String(g || "").trim();
        if (!name) continue;
        if (v === "" || v === null || v === 0 || v === "0") continue;
        const n = typeof v === "string" ? Number(v.trim()) : Number(v);
        if (!Number.isFinite(n) || n < 0) {
          errors.push(key + "." + name + " must be a number >= 0");
          continue;
        }
        floors[name] = n;
      }
      patch[key] = floors;
    } else if (type === "markets") {
      // { "overwatch": ["gameflip"] } — allowed marketplaces per game; an
      // empty list / "" removes the restriction for that key.
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(key + " must be an object of { game: [markets] }");
        continue;
      }
      const out = {};
      for (const [g, v] of Object.entries(value)) {
        const name = String(g || "").trim();
        if (!name) continue;
        const arr = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
        const list = [...new Set(arr.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean))];
        if (!list.length) continue;
        const bad = list.filter((m) => !settings.UNCLAIMED_MARKETS.includes(m));
        if (bad.length) {
          errors.push(key + "." + name + ": unknown market(s) " + bad.join(", "));
          continue;
        }
        out[name] = list;
      }
      patch[key] = out;
    } else if (type === "caps") {
      // { "overwatch": 25 } — per-game auto-list cap; 0 / "" removes it.
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(key + " must be an object of { game: cap }");
        continue;
      }
      const out = {};
      for (const [g, v] of Object.entries(value)) {
        const name = String(g || "").trim();
        if (!name) continue;
        if (v === "" || v === null || v === 0 || v === "0") continue;
        const n = typeof v === "string" ? Number(v.trim()) : Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 5000) {
          errors.push(key + "." + name + " must be an integer 1..5000");
          continue;
        }
        out[name] = n;
      }
      patch[key] = out;
    }
  }
  return { patch, ignored, errors };
}

function rawPricingKeys() {
  const af = settings.getAutoFarm() || {};
  const raw = {};
  for (const k of Object.keys(UNCLAIMED_PRICING_KEYS)) raw[k] = af[k];
  return raw;
}

router.get("/api/unclaimed-auto/pricing", requireSuperadmin, (req, res) => {
  try {
    res.json({
      success: true,
      pricing: settings.getUnclaimedPricing(),
      raw: rawPricingKeys(),
      keys: Object.keys(UNCLAIMED_PRICING_KEYS),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/unclaimed-auto/pricing", requireSuperadmin, async (req, res) => {
  try {
    const { patch, ignored, errors } = validatePricingPatch(req.body);
    if (errors.length)
      return res.status(400).json({ success: false, message: errors.join("; "), errors, ignored });
    if (!Object.keys(patch).length)
      return res.status(400).json({
        success: false,
        message: "no unclaimed* pricing keys in body",
        ignored,
        keys: Object.keys(UNCLAIMED_PRICING_KEYS),
      });
    await settings.setAutoFarm(patch, { actor: actorFromReq(req) });
    res.json({
      success: true,
      changed: Object.keys(patch),
      ignored,
      pricing: settings.getUnclaimedPricing(),
      raw: rawPricingKeys(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Bulk credential export for hand sales: the HELD (status "skipped") ledgers
// of one game — accounts that still hold their unclaimed drops but sit on no
// auto-listing (over the cap, or freed from a marketplace). text/plain
// `login:password` lines, audited by count only. Optional ?source=noclaim
// and ?status=skipped|listed (default skipped — listed accounts are on sale and
// must not be hand-sold without the manual-sold tick).
router.post("/api/unclaimed-auto/export-creds", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const game = String(body.game || "").trim();
    if (!game) return res.status(400).json({ success: false, message: "game required" });
    const status = body.status === "listed" ? "listed" : "skipped";
    const source = body.source === "noclaim" ? body.source : "";
    const limit = Math.min(2000, Math.max(1, parseInt(body.limit, 10) || 500));
    const want = settings.normGameName(game);
    const filter = { status };
    if (source) filter.source = source;
    const ledgers = await UnclaimedAccount.find(filter, {
      login: 1,
      game: 1,
      source: 1,
      poolAccountId: 1,
      drops: 1,
      bundleLabel: 1,
    })
      .sort({ updatedAt: -1 })
      .limit(4000)
      .lean();
    const mine = ledgers.filter((l) => settings.normGameName(l.game) === want).slice(0, limit);
    const lines = [];
    let skippedNoPw = 0;
    for (const l of mine) {
      let cred = null;
      try {
        cred = await engine.credentialForLedger(l);
      } catch {
        cred = null;
      }
      if (!cred || !cred.login || !cred.password) {
        skippedNoPw++;
        continue;
      }
      lines.push(cred.login + ":" + cred.password);
    }
    logEvent({
      category: "unclaimed",
      action: "creds_exported",
      actor: (req.session && req.session.admin && req.session.admin.username) || "admin",
      game,
      count: lines.length,
      detail: status + " " + (source || "all") + " accounts exported for manual bulk sale (" + lines.length + ", " + skippedNoPw + " without password)",
    });
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.set("X-Exported-Count", String(lines.length));
    res.set("X-Skipped-No-Password", String(skippedNoPw));
    res.send(lines.join("\n") + (lines.length ? "\n" : ""));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
