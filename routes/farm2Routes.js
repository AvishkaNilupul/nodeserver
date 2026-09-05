// API for the lane engine (utils/farm2/*) and its tab at /farm2.html.
//
// Everything here is superadmin-gated, matching routes/autoFarmRoutes.js. The
// read endpoints are plain indexed finds — no host access and no aggregation on
// a request path.

const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const FarmLane = require("../models/FarmLane");
const FarmJob = require("../models/FarmJob");
const AutoFarmTask = require("../models/AutoFarmTask");
const farm2 = require("../utils/farm2");
const settings = require("../utils/settings");

const router = express.Router();

function actorOf(req) {
  const a = req.session && req.session.admin;
  return (a && (a.username || a.id)) || "superadmin";
}

async function audit(action, subject, detail, meta, actor) {
  try {
    require("../utils/systemLog").logEvent({
      category: "farm2",
      action,
      actor,
      subject,
      detail,
      meta,
    });
  } catch {
    /* auditing must never block the operation it describes */
  }
}

/* --------------------------------- status -------------------------------- */

router.get("/farm2/status", requireSuperadmin, async (req, res) => {
  try {
    const lanes = await FarmLane.find({}).sort({ game: 1 }).lean();
    const laneKeys = lanes.map((l) => l.laneKey || l.gameKey);

    // Per-lane job counts, one grouped query rather than a query per lane.
    const counts = await FarmJob.aggregate([
      { $match: { laneKey: { $in: laneKeys } } },
      { $group: { _id: { lane: "$laneKey", status: "$status" }, n: { $sum: 1 } } },
    ]);
    const byLane = new Map();
    for (const c of counts) {
      const k = c._id.lane;
      if (!byLane.has(k)) byLane.set(k, {});
      byLane.get(k)[c._id.status] = c.n;
    }

    res.json({
      engine: farm2.status(),
      enabled: settings.getAutoFarm().farm2Enabled === true,
      lanes: lanes.map((l) => ({
        ...l,
        jobs: byLane.get(l.gameKey) || {},
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------- lanes --------------------------------- */

router.post("/farm2/lanes", requireSuperadmin, async (req, res) => {
  try {
    const game = String((req.body && req.body.game) || "").trim();
    if (!game) return res.status(400).json({ error: "game is required" });
    const gameKey = settings.normGameName(game);
    const existing = await FarmLane.findOne({ gameKey });
    if (existing) return res.status(409).json({ error: "lane already exists", lane: existing });
    // New lanes always start in shadow. Creating a lane straight into "live"
    // would take a game away from the proven engine with no comparison
    // evidence behind the decision.
    const lane = await FarmLane.create({
      game,
      gameKey,
      mode: "shadow",
      state: "idle",
      nextRunAt: new Date(),
      note: String((req.body && req.body.note) || ""),
    });
    await audit("lane_created", game, "lane created in shadow mode", { game }, actorOf(req));
    farm2.ownership.invalidate();
    res.json({ ok: true, lane });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change a lane's mode. This is THE consequential endpoint: moving to "live"
// transfers a game from the legacy engine to this one.
router.post("/farm2/lanes/:id/mode", requireSuperadmin, async (req, res) => {
  try {
    const mode = String((req.body && req.body.mode) || "");
    if (!["off", "shadow", "live"].includes(mode))
      return res.status(400).json({ error: "mode must be off, shadow or live" });

    const lane = await FarmLane.findById(req.params.id);
    if (!lane) return res.status(404).json({ error: "lane not found" });

    // Promoting to live requires an explicit acknowledgement from the caller.
    // The tab sends it from a confirm dialog; this makes an accidental or
    // scripted promotion impossible with a bare mode change.
    if (mode === "live" && lane.mode !== "live") {
      if (!req.body || req.body.confirm !== true) {
        return res.status(400).json({
          error:
            "promoting a lane to live moves this game off the legacy engine — resend with confirm: true",
        });
      }
      // Readiness gate: the live-mode steps must exist on this host, and there
      // must be shadow evidence to promote on. Overridable with force, which is
      // audited — a guard against promoting by accident, not a lock.
      const readiness = await farm2.laneReadiness(lane);
      if (!readiness.ready && req.body.force !== true) {
        return res.status(409).json({
          error: "lane is not ready to go live",
          blockers: readiness.blockers,
          warnings: readiness.warnings,
          hint: "resend with force: true to override",
        });
      }
      if (!readiness.ready) {
        await audit(
          "lane_promoted_force",
          lane.game,
          "readiness overridden: " + readiness.blockers.join("; "),
          { game: lane.game, blockers: readiness.blockers },
          actorOf(req),
        );
      }
    }

    const from = lane.mode;
    lane.mode = mode;
    // A mode change re-arms the lane: clear the failure backoff so it runs on
    // the next cycle rather than sitting out a stale penalty.
    lane.state = "idle";
    lane.consecutiveFailures = 0;
    lane.nextRunAt = new Date();
    await lane.save();

    // The legacy engine caches ownership for 30s; drop it now so the handoff
    // takes effect on the very next tick of either engine.
    farm2.ownership.invalidate();
    await audit(
      "lane_mode_changed",
      lane.game,
      `mode ${from} -> ${mode}`,
      { game: lane.game, from, to: mode },
      actorOf(req),
    );

    res.json({ ok: true, lane });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/farm2/lanes/:id", requireSuperadmin, async (req, res) => {
  try {
    const lane = await FarmLane.findById(req.params.id);
    if (!lane) return res.status(404).json({ error: "lane not found" });
    // A live lane owns its game; deleting the row would leave the game owned by
    // nobody until the legacy engine's cache expired. Force a demotion first.
    if (lane.mode === "live")
      return res.status(409).json({ error: "set the lane to off or shadow before deleting it" });
    await FarmLane.deleteOne({ _id: lane._id });
    farm2.ownership.invalidate();
    await audit("lane_deleted", lane.game, "lane deleted", { game: lane.game }, actorOf(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Readiness for promotion, so the tab can explain WHY a lane can't go live
// before the operator clicks rather than after.
router.get("/farm2/lanes/:id/readiness", requireSuperadmin, async (req, res) => {
  try {
    const lane = await FarmLane.findById(req.params.id).lean();
    if (!lane) return res.status(404).json({ error: "lane not found" });
    res.json(await farm2.laneReadiness(lane));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/farm2/seed", requireSuperadmin, async (req, res) => {
  try {
    const out = await farm2.seedTrialLanes();
    await audit("lanes_seeded", "trial", JSON.stringify(out), { out }, actorOf(req));
    res.json({ ok: true, lanes: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------- engine --------------------------------- */

router.post("/farm2/enable", requireSuperadmin, async (req, res) => {
  try {
    const on = !!(req.body && req.body.enabled);
    await settings.setAutoFarm({ farm2Enabled: on }, { actor: actorOf(req) });
    farm2.ownership.invalidate();
    await audit(
      "engine_toggled",
      "farm2",
      on ? "enabled" : "disabled",
      { enabled: on },
      actorOf(req),
    );
    res.json({ ok: true, enabled: on });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/farm2/run", requireSuperadmin, async (req, res) => {
  try {
    const summary = await farm2.runCycle({ force: true });
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------- jobs ---------------------------------- */

router.get("/farm2/jobs", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    if (req.query.lane) q.laneKey = settings.normGameName(String(req.query.lane));
    if (req.query.kind) q.kind = String(req.query.kind);
    if (req.query.status) q.status = String(req.query.status);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await FarmJob.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------- compare -------------------------------- */

// The trial's headline view: for every shadow decision, what did the lane
// conclude and what did the legacy engine actually do?
router.get("/farm2/compare", requireSuperadmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const rows = await FarmJob.find({ kind: "decide", status: "done" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = rows
      .map((r) => {
        const v = (r.result && r.result.verdict) || {};
        const d = (r.result && r.result.diff) || null;
        return {
          at: r.finishedAt || r.createdAt,
          lane: r.lane,
          shadow: r.shadow,
          campaignId: r.campaignId,
          campaignName: v.campaignName || "",
          laneDecision: v.decision || "",
          lanePlanned: v.plannedAccounts || 0,
          laneReason: v.reason || "",
          demand: v.effectiveDemand ?? v.demandScore ?? null,
          legacyDecision: d ? d.legacyDecision : null,
          // The honest legacy count (null when the row has none — skip rows
          // never write one); the raw field is legacyPlannedField.
          legacyPlanned: d ? (d.legacyPlanned ?? null) : null,
          agree: d ? d.agree : null,
          accountDelta: d ? (d.accountDelta ?? null) : null,
          // Whether that delta was scored, and if not, why
          // (utils/farm2/accountGap.js). undefined on rows that predate it.
          accountComparable: d ? (d.accountComparable ?? null) : null,
          accountNote: d ? d.accountNote || "" : "",
        };
      })
      .filter((x) => x.laneDecision);

    const compared = items.filter((i) => i.agree !== null);
    res.json({
      items,
      stats: {
        total: items.length,
        compared: compared.length,
        agreeing: compared.filter((i) => i.agree).length,
        disagreeing: compared.filter((i) => !i.agree).length,
        // No legacy row to compare against yet — a normal transient state while
        // the legacy engine has not reached that campaign, not a mismatch.
        pending: items.length - compared.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------- audit --------------------------------- */

// The drop checker's findings for every lane: which active tasks hold what they
// promise, and which verified stock has no live listing.
router.get("/farm2/audit", requireSuperadmin, async (req, res) => {
  try {
    const lanes = await FarmLane.find({ mode: { $ne: "off" } }).lean();
    const verify = require("../utils/farm2/steps/verify");
    const out = [];
    for (const l of lanes) {
      try {
        out.push({ game: l.game, mode: l.mode, ...(await verify.auditLane(l)) });
      } catch (e) {
        out.push({ game: l.game, mode: l.mode, error: e.message });
      }
    }
    res.json({ lanes: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------- legacy view ------------------------------ */

// What the legacy engine currently has for the lane games, so the tab can show
// both sides without the operator switching pages.
router.get("/farm2/legacy-tasks", requireSuperadmin, async (req, res) => {
  try {
    const lanes = await FarmLane.find({}).lean();
    const games = lanes.map((l) => l.game);
    const rows = await AutoFarmTask.find({ game: { $in: games } })
      .select("game campaignId campaignName decision status plannedAccounts assignedAccounts listing.externalId decidedAt")
      .sort({ decidedAt: -1 })
      .limit(200)
      .lean();
    res.json({
      tasks: rows.map((t) => ({
        game: t.game,
        campaignId: t.campaignId,
        campaignName: t.campaignName,
        decision: t.decision,
        status: t.status,
        planned: t.plannedAccounts,
        assigned: (t.assignedAccounts || []).length,
        listed: !!(t.listing && t.listing.externalId),
        decidedAt: t.decidedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
