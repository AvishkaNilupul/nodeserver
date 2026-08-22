const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const autoFarmer = require("../utils/autoFarmer");
const settings = require("../utils/settings");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");
const suspendedAccounts = require("../utils/suspendedAccounts");
const AutoFarmSnapshot = require("../models/AutoFarmSnapshot");
const AutoFarmEvent = require("../models/AutoFarmEvent");
const BotAccount = require("../models/BotAccount");
const autoFarmSnapshot = require("../utils/autoFarmSnapshot");
const { recordAutoFarmEvent } = require("../utils/autoFarmEventLog");

const router = express.Router();

function watcherEtag(builtAt) {
  const time = builtAt ? new Date(builtAt).getTime() : 0;
  return 'W/"auto-farm-' + (Number.isFinite(time) ? time : 0) + '"';
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One persisted-document read. No aggregation, task join or host access is
// allowed on this request path; the background snapshot builder owns all of it.
router.get("/auto-farm/watcher", requireSuperadmin, async (req, res) => {
  try {
    const snapshot = await AutoFarmSnapshot.findOne({ key: "auto-farm" }).lean();
    if (!snapshot || !snapshot.builtAt) {
      autoFarmSnapshot.refreshFast().catch(() => {});
      return res.status(503).json({
        success: false,
        message: "Auto-farm watcher is warming up",
      });
    }
    const etag = watcherEtag(snapshot.builtAt);
    const since = req.query.since ? new Date(req.query.since).getTime() : null;
    const builtMs = new Date(snapshot.builtAt).getTime();
    res.set("ETag", etag);
    res.set("Cache-Control", "private, no-cache");
    if (
      req.get("If-None-Match") === etag ||
      (Number.isFinite(since) && since >= builtMs)
    ) {
      return res.status(304).end();
    }
    res.json({
      success: true,
      builtAt: snapshot.builtAt,
      stale: Date.now() - builtMs > autoFarmSnapshot.FAST_INTERVAL_MS * 3,
      snapshot,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Enqueue a deduplicated DB-only rebuild. The request never waits for SSH.
router.post(
  "/auto-farm/watcher/refresh",
  requireSuperadmin,
  async (req, res) => {
    const current = await AutoFarmSnapshot.findOne(
      { key: "auto-farm" },
      { builtAt: 1 },
    )
      .lean()
      .catch(() => null);
    autoFarmSnapshot.refreshFast().catch((err) =>
      console.error("auto-farm watcher refresh failed:", err.message),
    );
    res.status(202).json({
      success: true,
      queued: true,
      builtAt: current && current.builtAt,
    });
  },
);

router.get(
  "/auto-farm/watcher/bots/:host/:container/accounts",
  requireSuperadmin,
  async (req, res) => {
    try {
      const host = String(req.params.host || "");
      const container = String(req.params.container || "");
      const file = String(req.query.file || "");
      const rows = await BotAccount.find(
        {
          host,
          $or: [
            { container },
            ...(file ? [{ configFile: file }] : []),
          ],
        },
        {
          login: 1,
          enabled: 1,
          host: 1,
          container: 1,
          configFile: 1,
          lastScanAt: 1,
          lastScanStatus: 1,
          lastScanError: 1,
          inProgressCount: 1,
          inProgressGames: 1,
          farmingProgress: 1,
          farmingCompleteAt: 1,
          suspendedAt: 1,
          dropCount: 1,
        },
      )
        .sort({ login: 1 })
        .lean();
      res.json({
        success: true,
        accounts: rows.map((row) => ({
          ...row,
          state:
            row.lastScanStatus === "suspended"
              ? "suspended"
              : row.lastScanStatus === "token_invalid"
                ? "dead_token"
                : row.lastScanStatus === "error"
                  ? "scan_error"
                  : row.inProgressCount > 0
                    ? "progressing"
                    : row.lastScanStatus === "ok"
                      ? "idle_or_done"
                      : "unknown",
        })),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.get(
  "/auto-farm/watcher/decisions",
  requireSuperadmin,
  async (req, res) => {
    try {
      const match = {};
      if (req.query.decision === "failed") match.status = "failed";
      else if (req.query.decision)
        match.decision = String(req.query.decision);
      if (req.query.q) {
        const re = new RegExp(escapeRegex(req.query.q), "i");
        match.$or = [
          { game: re },
          { campaignName: re },
          { campaignId: re },
          { reason: re },
        ];
      }
      const limit = Math.max(
        1,
        Math.min(200, Math.floor(Number(req.query.limit) || 100)),
      );
      const tasks = await AutoFarmTask.find(match, taskProjectionForWatcher())
        .sort({ decidedAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();
      res.json({ success: true, tasks });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.get(
  "/auto-farm/watcher/events",
  requireSuperadmin,
  async (req, res) => {
    try {
      const match = {};
      if (req.query.type) match.type = String(req.query.type);
      if (req.query.game) {
        match.game = new RegExp(escapeRegex(req.query.game), "i");
      }
      const limit = Math.max(
        1,
        Math.min(300, Math.floor(Number(req.query.limit) || 100)),
      );
      const events = await AutoFarmEvent.find(match)
        .sort({ at: -1 })
        .limit(limit)
        .lean();
      res.json({ success: true, events });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

function taskProjectionForWatcher() {
  return {
    game: 1,
    campaignId: 1,
    campaignName: 1,
    campaignEndAt: 1,
    decision: 1,
    reason: 1,
    status: 1,
    dryRun: 1,
    error: 1,
    plannedAccounts: 1,
    targetAccounts: 1,
    decidedAt: 1,
    createdAt: 1,
    executedAt: 1,
    completedAt: 1,
    "listing.externalId": 1,
    "listing.url": 1,
    "listing.title": 1,
    "listing.price": 1,
    "listing.qty": 1,
    "listing.heldBack": 1,
    "listing.postEvent": 1,
    "listing.error": 1,
    "listing.plati": 1,
    "listing.ggsel": 1,
    "listing.zeusx": 1,
    wouldList: 1,
  };
}

// ENGINE STATE + settings + pool budget, one call for the whole tab header.
router.get("/auto-farm/status", requireSuperadmin, async (req, res) => {
  try {
    const af = settings.getAutoFarm();
    const ready = await AvailableAccount.countDocuments({
      status: "available",
      clientSecret: { $gt: "" },
      lastCheckStatus: { $in: ["", "ok"] },
    });
    const farmHost = autoFarmer.resolveFarmHost(af);
    res.json({
      success: true,
      settings: af,
      engine: autoFarmer.status(),
      pool: {
        ready,
        reserve: af.poolReserve,
        spendable: Math.max(0, ready - af.poolReserve),
      },
      host: farmHost ? { id: farmHost.id, label: farmHost.label } : null,
      hosts: hosts.listHosts(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DECISION LOG + active/planned tasks (newest first).
//
// Every non-terminal task is returned unconditionally, and only the historical
// log is capped. A flat .limit(200) sorted newest-first dropped the OLDEST rows
// once the log passed 200 — which is precisely the long-running active tasks
// and the oldest plans awaiting approval. They kept running on the Pi but
// vanished from the UI, losing their Stop / Delist / Approve / Delete controls
// with nothing to indicate it. There are 134 rows today, so this was days away.
const HISTORY_LIMIT = 200;
router.get("/auto-farm/tasks", requireSuperadmin, async (req, res) => {
  try {
    const [liveTasks, history] = await Promise.all([
      AutoFarmTask.find({ status: { $in: ["planned", "active"] } })
        .sort({ createdAt: -1 })
        .lean(),
      AutoFarmTask.find({ status: { $nin: ["planned", "active"] } })
        .sort({ createdAt: -1 })
        .limit(HISTORY_LIMIT)
        .lean(),
    ]);
    const tasks = liveTasks
      .concat(history)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPDATE settings. maxPerGame is clamped to 30 — the hard business cap.
router.post("/auto-farm/settings", requireSuperadmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if ("enabled" in b) patch.enabled = !!b.enabled;
    if ("dryRun" in b) patch.dryRun = !!b.dryRun;
    if ("consolidate" in b) patch.consolidate = !!b.consolidate;
    if ("deleteFinishedBots" in b)
      patch.deleteFinishedBots = !!b.deleteFinishedBots;
    if ("stopFinishedBots" in b)
      patch.stopFinishedBots = !!b.stopFinishedBots;
    if ("recycleSoldAccounts" in b)
      patch.recycleSoldAccounts = !!b.recycleSoldAccounts;
    if ("recycleCooldownDays" in b)
      patch.recycleCooldownDays = clamp(b.recycleCooldownDays, 1, 90);
    if ("hostId" in b) {
      const id = String(b.hostId || "");
      if (id && !hosts.resolveHost(id)) {
        return res
          .status(400)
          .json({ success: false, message: "Unknown host" });
      }
      patch.hostId = id;
    }
    const clamp = (v, lo, hi) =>
      Math.max(lo, Math.min(hi, Math.floor(Number(v))));
    if ("maxPerGame" in b) patch.maxPerGame = clamp(b.maxPerGame, 1, 30);
    // Accounts per container. The ceiling is high on purpose: a container costs
    // a fixed ~130 MB of .NET baseline and only ~1.2 MB per account, so packing
    // MORE accounts into each one is the RAM fix, not a risk. The old ceiling of
    // 30 was a trap — prod runs 70 (set directly in settings.json), and any save
    // from the settings page would silently clamp it back to 30 and let the
    // container sprawl grow straight back.
    if ("accountsPerBot" in b)
      patch.accountsPerBot = clamp(b.accountsPerBot, 1, 200);
    if ("poolReserve" in b) patch.poolReserve = clamp(b.poolReserve, 0, 500);
    if ("probeSize" in b) patch.probeSize = clamp(b.probeSize, 1, 30);
    if ("perMarketStock" in b)
      patch.perMarketStock = clamp(b.perMarketStock, 1, 10);
    if ("maxAutoBots" in b) patch.maxAutoBots = clamp(b.maxAutoBots, 1, 50);
    if ("minHoursLeft" in b) patch.minHoursLeft = clamp(b.minHoursLeft, 0, 168);
    // Permanently delete accounts Twitch has deleted. Irreversible, so it is an
    // explicit opt-in; the classify/release half of the sweep always runs.
    if ("purgeSuspended" in b) patch.purgeSuspended = !!b.purgeSuspended;
    if ("suspendCheckLimit" in b)
      patch.suspendCheckLimit = clamp(b.suspendCheckLimit, 0, 100000);
    // Multi-market category ids: numeric strings, empty = unset/auto.
    if ("platiCategoryId" in b)
      patch.platiCategoryId = String(b.platiCategoryId || "").replace(
        /[^0-9]/g,
        "",
      );
    if ("ggselCategoryId" in b)
      patch.ggselCategoryId = String(b.ggselCategoryId || "").replace(
        /[^0-9]/g,
        "",
      );
    if ("zeusxAuto" in b) patch.zeusxAuto = !!b.zeusxAuto;
    // Per-game ZeusX placement, pasted as JSON:
    //   { "overwatch": { "serviceCategoryId": "1",
    //                    "serviceCategoryBaseId": "269" } }
    if ("zeusxGames" in b) {
      const raw = b.zeusxGames;
      let map = raw;
      if (typeof raw === "string") {
        const text = raw.trim();
        if (!text) map = {};
        else {
          try {
            map = JSON.parse(text);
          } catch {
            return res.status(400).json({
              success: false,
              message: "ZeusX game map must be valid JSON",
            });
          }
        }
      }
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        return res
          .status(400)
          .json({ success: false, message: "ZeusX game map must be an object" });
      }
      const clean = {};
      for (const [game, cfg] of Object.entries(map)) {
        if (!cfg || typeof cfg !== "object") continue;
        const baseId = String(
          cfg.serviceCategoryBaseId || cfg.baseId || "",
        ).replace(/[^0-9]/g, "");
        if (!baseId) continue;
        clean[String(game).trim().toLowerCase()] = {
          serviceCategoryId: String(cfg.serviceCategoryId || "1").replace(
            /[^0-9]/g,
            "",
          ),
          serviceCategoryBaseId: baseId,
          attributes: Array.isArray(cfg.attributes) ? cfg.attributes : [],
        };
      }
      patch.zeusxGames = clean;
    }
    for (const k of Object.keys(patch)) {
      if (typeof patch[k] === "number" && isNaN(patch[k])) delete patch[k];
    }
    const saved = await settings.setAutoFarm(patch);
    res.json({ success: true, settings: saved });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// APPROVE a dry-run plan: execute it for real, right now.
router.post(
  "/auto-farm/tasks/:id/approve",
  requireSuperadmin,
  async (req, res) => {
    try {
      const task = await AutoFarmTask.findById(req.params.id);
      if (!task)
        return res
          .status(404)
          .json({ success: false, message: "Task not found" });
      if (task.status !== "planned") {
        return res.status(400).json({
          success: false,
          message: "Only planned tasks can be approved",
        });
      }
      if (task.decision === "reuse_existing") {
        // Approving a reuse plan = restart the existing containers.
        const started = [];
        const failed = [];
        for (const b of task.bots || []) {
          try {
            const h = hosts.resolveHost(b.host);
            if (!h) throw new Error("unknown host " + b.host);
            await botFactory.startContainer(h, b.container);
            started.push(b.container);
          } catch (e) {
            failed.push(b.container + ": " + e.message);
          }
        }
        task.status = started.length ? "active" : "failed";
        task.dryRun = false;
        task.error = failed.join("; ");
        task.executedAt = new Date();
        await task.save();
        return res.json({ success: true, started, failed });
      }
      const result = await autoFarmer.executeTask(task);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// STOP a task's bots now (accounts stay deployed as inventory).
router.post(
  "/auto-farm/tasks/:id/stop",
  requireSuperadmin,
  async (req, res) => {
    try {
      const task = await AutoFarmTask.findById(req.params.id);
      if (!task)
        return res
          .status(404)
          .json({ success: false, message: "Task not found" });
      const stopped = [];
      const failed = [];
      for (const b of task.bots || []) {
        try {
          const h = hosts.resolveHost(b.host);
          if (!h) throw new Error("unknown host " + b.host);
          await botFactory.stopContainer(h, b.container);
          stopped.push(b.container);
        } catch (e) {
          failed.push(b.container + ": " + e.message);
        }
      }
      task.status = "stopped";
      task.completedAt = new Date();
      if (failed.length) task.error = failed.join("; ");
      await task.save();
      res.json({ success: true, stopped, failed });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// DISMISS a planned/skipped task from the log (it may be re-decided next tick
// only if its skip reason is retryable; final skips stay dismissed because
// the campaignId check still finds the tombstone... so we really delete it).
router.delete("/auto-farm/tasks/:id", requireSuperadmin, async (req, res) => {
  try {
    const task = await AutoFarmTask.findById(req.params.id);
    if (!task)
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    if (task.status === "active") {
      return res
        .status(400)
        .json({ success: false, message: "Stop the task before deleting it" });
    }
    await task.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELIST a task's Gameflip listing: remove it from Gameflip (ignoring
// already-gone errors), retire the DB listing row, and clear the task's
// listing record so the next scan can publish a fresh one if wanted.
router.post(
  "/auto-farm/tasks/:id/delist",
  requireSuperadmin,
  async (req, res) => {
    try {
      const task = await AutoFarmTask.findById(req.params.id);
      if (!task)
        return res
          .status(404)
          .json({ success: false, message: "Task not found" });
      if (!task.listing || !task.listing.externalId) {
        return res
          .status(400)
          .json({ success: false, message: "Task has no listing" });
      }
      const mp = require("../utils/marketplaces");
      const MarketplaceListing = require("../models/MarketplaceListing");
      // The relist chain mints a new external id on every sale and the task's
      // stored task.listing.externalId is never updated — so delisting that id
      // would take down an already-sold row and leave the LIVE successor
      // selling. Resolve every live gameflip row for this set (same set-based
      // lookup the reprice uses) and delist each; fall back to the stored id if
      // none is live.
      const liveRows = task.listing.setId
        ? await MarketplaceListing.find({
            set: task.listing.setId,
            marketplace: "gameflip",
            status: "active",
            origin: "auto",
          })
            .select("externalId")
            .lean()
        : [];
      const gfIds = liveRows.map((r) => r.externalId).filter(Boolean);
      if (!gfIds.length && task.listing.externalId) {
        gfIds.push(task.listing.externalId);
      }
      let remote = "removed";
      for (const id of gfIds) {
        try {
          await mp.gameflipDelist(id);
        } catch (e) {
          // Already deleted on Gameflip (or never existed) is fine — the goal
          // is a clean local record either way.
          if (/404|not.?found/i.test(String(e.message || ""))) {
            remote = "was already gone";
          } else {
            throw e;
          }
        }
      }
      await MarketplaceListing.updateMany(
        {
          set: task.listing.setId,
          marketplace: "gameflip",
          status: "active",
          origin: "auto",
        },
        { $set: { status: "removed" } },
      );
      // Secondary markets ride along: best-effort removal on Plati + GGSel,
      // their DB rows retired the same way.
      const plId =
        task.listing.plati && task.listing.plati.externalId
          ? task.listing.plati.externalId
          : "";
      if (plId) {
        await mp.digisellerDelist(plId).catch(() => {});
        await MarketplaceListing.updateOne(
          {
            set: task.listing.setId,
            marketplace: "digiseller",
            externalId: plId,
          },
          { $set: { status: "removed" } },
        );
      }
      const ggId =
        task.listing.ggsel && task.listing.ggsel.externalId
          ? task.listing.ggsel.externalId
          : "";
      if (ggId) {
        await mp.ggselDelist(ggId).catch(() => {});
        await MarketplaceListing.updateOne(
          { set: task.listing.setId, marketplace: "ggsel", externalId: ggId },
          { $set: { status: "removed" } },
        );
      }
      task.listing = undefined;
      task.wouldList = undefined;
      await task.save();
      await recordAutoFarmEvent({
        type: "delisted",
        game: task.game,
        campaignId: task.campaignId,
        taskId: task._id,
        count: 1,
        reason: "manually delisted from the Auto Farm watcher",
        actor: "autoFarmRoutes.delist",
      });
      res.json({ success: true, remote });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// RUN the brain once on demand (the "Scan now" button).
router.post("/auto-farm/tick", requireSuperadmin, async (req, res) => {
  // Fire-and-forget: the scan can take a while (research + SSH), so return
  // immediately and let the UI follow along via the progress log in /status.
  const st = autoFarmer.status();
  if (st.running) {
    return res.status(202).json({ ok: true, alreadyRunning: true });
  }
  autoFarmer.runOnce().catch((err) => {
    console.error("auto-farm tick error:", err.message);
  });
  res.status(202).json({ ok: true, started: true });
});

// Fresh full rescan: clear terminal decisions for every live campaign, then
// re-run the scan so everything is decided from scratch with fresh research.
router.post("/auto-farm/rescan", requireSuperadmin, async (req, res) => {
  try {
    const st = autoFarmer.status();
    if (st.running) {
      return res.status(202).json({ ok: true, alreadyRunning: true });
    }
    const cleared = await autoFarmer.rescanAll();
    autoFarmer.runOnce().catch((err) => {
      console.error("auto-farm rescan error:", err.message);
    });
    res.status(202).json({ ok: true, started: true, ...cleared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run the suspended-account sweep on demand, without waiting for a tick.
// `dryRun` reports what a purge WOULD delete and touches nothing; `purge` is the
// irreversible one and must be asked for explicitly even when the setting is on.
router.post(
  "/auto-farm/suspended-sweep",
  requireSuperadmin,
  async (req, res) => {
    try {
      const b = req.body || {};
      const report = await suspendedAccounts.sweep({
        purge: !!b.purge,
        dryRun: !!b.dryRun,
        limit: Math.max(0, Math.floor(Number(b.limit) || 0)),
      });
      res.json({ ok: true, ...report });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = router;
