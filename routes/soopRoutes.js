const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const farm = require("../utils/soopFarm");

const router = express.Router();

function fail(res, code, message) {
  return res.status(code).json({ success: false, error: message, message });
}

// Everything the panel polls: accounts + running sessions + bots + the meter.
router.get("/api/soop/state", requireSuperadmin, async (req, res) => {
  try {
    const accounts = await farm.loadAccounts();
    res.json({
      success: true,
      accounts,
      sessions: farm.sessionsView(),
      tasks: farm.tasksView(),
      metrics: farm.snapshot(),
      started: farm.started,
    });
  } catch (err) {
    console.error("soop state error:", err.message);
    fail(res, 500, "Server error");
  }
});

// Import (or replace) one account from a Cookie-Editor export.
router.post("/api/soop/import", requireSuperadmin, async (req, res) => {
  try {
    const cookies = String(req.body.cookies || "");
    if (!cookies.trim()) return fail(res, 400, "Paste a cookie export first");
    const out = await farm.importAccount(cookies);
    res.json({ success: true, ...out });
  } catch (err) {
    console.error("soop import error:", err.message);
    fail(res, 400, err.message);
  }
});

// Re-run the health probe for one or many accounts.
router.post("/api/soop/check", requireSuperadmin, async (req, res) => {
  try {
    const list = (req.body.ids || [req.body.id]).filter(Boolean);
    if (!list.length) return fail(res, 400, "no account given");
    const results = [];
    for (const id of list) {
      try {
        results.push({ id, check: await farm.checkAccount(id) });
      } catch (e) {
        results.push({ id, error: e.message });
      }
    }
    res.json({ success: true, results, check: results[0]?.check || null });
  } catch (err) {
    console.error("soop check error:", err.message);
    fail(res, 500, "Server error");
  }
});

router.post("/api/soop/delete", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.body.id || "");
    if (!id) return fail(res, 400, "no account given");
    await farm.deleteAccount(id);
    res.json({ success: true });
  } catch (err) {
    console.error("soop delete error:", err.message);
    fail(res, 500, "Server error");
  }
});

// Live + remembered (delisted) campaigns for the current account.
router.post("/api/soop/campaigns", requireSuperadmin, async (req, res) => {
  const id = String(req.body.id || "");
  if (!id) return fail(res, 400, "no account given");
  try {
    await farm.ensureClient(id);
  } catch (e) {
    return fail(res, 404, e.message);
  }
  try {
    const campaigns = await farm.campaignRows();
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("soop campaigns error:", err.message);
    fail(res, 502, err.message);
  }
});

// Start a bot: one campaign + N accounts.
router.post("/api/soop/task/start", requireSuperadmin, async (req, res) => {
  try {
    const { dropsIdx, ids, target, label, targetMinutes } = req.body;
    const out = await farm.startTask({
      dropsIdx,
      ids,
      target,
      label,
      targetMinutes,
    });
    if (!out.ok) return fail(res, 400, out.error);
    res.json({ success: true, ...out });
  } catch (err) {
    console.error("soop task start error:", err.message);
    fail(res, 500, "Server error");
  }
});

router.post("/api/soop/task/stop", requireSuperadmin, async (req, res) => {
  try {
    const { taskId, all } = req.body;
    if (all) {
      const stopped = await farm.stopAllTasks();
      return res.json({ success: true, stopped });
    }
    const ok = await farm.stopTask(String(taskId || ""));
    res.json({ success: true, stopped: ok ? [taskId] : [] });
  } catch (err) {
    console.error("soop task stop error:", err.message);
    fail(res, 500, "Server error");
  }
});

// Loose farm (no bot grouping): watch a campaign with these accounts.
router.post("/api/soop/farm/start", requireSuperadmin, async (req, res) => {
  try {
    const list = (req.body.ids || [req.body.id]).filter(Boolean);
    if (!list.length) return fail(res, 400, "no account given");
    const results = [];
    for (const id of list) {
      const r = await farm.startSession(id, {
        drops: req.body.drops || "auto",
        target: req.body.target || "all",
      });
      results.push({ id, ...r });
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error("soop farm start error:", err.message);
    fail(res, 500, "Server error");
  }
});

router.post("/api/soop/farm/stop", requireSuperadmin, async (req, res) => {
  try {
    const { id, all } = req.body;
    res.json({
      success: true,
      stopped: all ? farm.stopAll() : farm.stop(String(id || "")) ? [id] : [],
    });
  } catch (err) {
    console.error("soop farm stop error:", err.message);
    fail(res, 500, "Server error");
  }
});

// Inventory read. Never claims — the no-claim rule means unclaimed drops stay
// unclaimed; this only shows what is there and how it would be redeemed.
router.post("/api/soop/inventory", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.body.id || "");
    const division = req.body.division || null;
    if (!id) return fail(res, 400, "no account given");
    let client;
    try {
      client = await farm.ensureClient(id);
    } catch (e) {
      return fail(res, 404, e.message);
    }
    try {
      const [counts, all] = await Promise.all([
        client.inventoryCounts(),
        client.inventoryTagged(),
      ]);
      const items = (
        division ? all.filter((i) => i.division === division) : all
      ).map((i) => ({
        itemType: i.itemType,
        itemName: i.itemName,
        division: i.division,
        expiry: i.expDate || i.useExpDate || null,
        sentAt: i.sendDate || null,
        receivedAt: i.receiveDate || null,
        linkPath: i.acctLinkPath || i.loginPath || null,
        typeNm: i.typeNm || i.type || null,
        gameNo: i.gameNo || null,
        image: i.image || null,
        needsLink: i.ingameGiveYn === "Y" && i.acctConn === false,
        used: i.useFlag === "Y",
        code: i.itemCode || i.code || i.pinNo || i.couponNo || null,
        raw: i,
      }));
      res.json({ success: true, counts, items, total: all.length });
    } catch (e) {
      const stale = /log in|login|401/i.test(e.message);
      res.json({
        success: false,
        error: stale
          ? "the drops site rejected this session (401) — re-export the cookie while logged in to drops.sooplive.com"
          : e.message,
      });
    }
  } catch (err) {
    console.error("soop inventory error:", err.message);
    fail(res, 500, "Server error");
  }
});

module.exports = router;
