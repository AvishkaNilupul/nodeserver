const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const autoFarmer = require("../utils/autoFarmer");
const settings = require("../utils/settings");
const hosts = require("../utils/botHosts");
const botFactory = require("../utils/botFactory");

const router = express.Router();

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
      let remote = "removed";
      try {
        await mp.gameflipDelist(task.listing.externalId);
      } catch (e) {
        // Already deleted on Gameflip (or never existed) is fine — the goal
        // is a clean local record either way.
        if (/404|not.?found/i.test(String(e.message || ""))) {
          remote = "was already gone";
        } else {
          throw e;
        }
      }
      await MarketplaceListing.updateOne(
        {
          set: task.listing.setId,
          marketplace: "gameflip",
          externalId: task.listing.externalId,
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

module.exports = router;
