const express = require("express");
const path = require("node:path");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const { decrypt, encrypt, isEncrypted } = require("../utils/secretBox");
const Run = require("../models/TikTokFarmRun");

const SLOT = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^\d{1,22}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const LEASE_MS = 60_000;
const ONLINE_MS = 45_000;
const PHASES = new Set(["bootstrap", "watching", "claiming"]);
const FAILURE_PHASES = new Set(["ineligible", "session-required", "room-ended", "worker-error", "claim-uncertain"]);
const hash = (value) => createHash("sha256").update(value).digest();

function createRouter({ Model = Run, workerKey = () => process.env.TIKTOK_WORKER_KEY, now = Date.now } = {}) {
  const router = express.Router();
  const seen = new Map();
  const jsonOnly = (req, res, next) => {
    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({ error: "JSON required" });
    }
    next();
  };
  const admin = [requireSuperadmin, enforce2fa, jsonOnly];
  const wrap = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch {
      res.status(503).json({ error: "TikTok farm operation unavailable" });
    }
  };
  const authenticate = (req, res, next) => {
    const key = workerKey();
    const provided = req.get("authorization") || "";
    if (!key || key.length < 32 || !timingSafeEqual(hash(provided), hash("Bearer " + key))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
  const sweep = () => Model.updateMany(
    { active: true, state: "running", leaseUntil: { $lte: new Date(now()) } },
    { $set: { active: false, state: "review", phase: "lease-expired" } },
  );

  router.get("/admin/tiktok-farm", ...admin, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "../views/tiktok-farm.html"));
  });
  router.get("/api/tiktok-farm/state", ...admin, wrap(async (_req, res) => {
    await sweep();
    const accounts = [];
    for (const [account, lastSeen] of seen) {
      if (now() - lastSeen < ONLINE_MS) accounts.push({ account, lastSeen });
    }
    const [runs, codes] = await Promise.all([
      Model.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      Model.find({ state: "completed", code: { $exists: true } })
        .select("account campaign task updatedAt").sort({ updatedAt: -1 }).limit(200).lean(),
    ]);
    res.json({ accounts, runs, codes });
  }));
  router.post("/api/tiktok-farm/start", ...admin, wrap(async (req, res) => {
    const { accounts, campaign, room, task } = req.body || {};
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 20 ||
        accounts.some((slot) => typeof slot !== "string" || !SLOT.test(slot)) ||
        new Set(accounts).size !== accounts.length ||
        [campaign, room].some((id) => typeof id !== "string" || !ID.test(id)) ||
        (task !== "auto" && (typeof task !== "string" || !ID.test(task)))) {
      return res.status(400).json({ error: "Choose up to 20 distinct accounts and enter the campaign and room IDs, plus a task ID or auto" });
    }
    if (accounts.some((slot) => !seen.has(slot) || now() - seen.get(slot) >= ONLINE_MS)) {
      return res.status(409).json({ error: "An account worker is offline" });
    }
    await Model.init();
    await sweep();
    const batch = randomUUID();
    const results = await Promise.all(accounts.map(async (account) => {
      const target = { account, campaign, task };
      try {
        const retried = await Model.findOneAndUpdate(
          { ...target, active: false, state: { $in: ["failed", "cancelled"] } },
          {
            $set: { room, batch, active: true, state: "queued", phase: "queued", seconds: 0,
              stopRequested: false, claimAuthorized: false },
            $unset: { lease: 1, leaseUntil: 1 },
          },
          { returnDocument: "after" },
        );
        const run = retried || await Model.create({ ...target, room, batch });
        return { account, queued: true, id: run.id };
      } catch (error) {
        if (error.code !== 11000) throw error;
        return { account, queued: false, reason: "account is busy or this reward is already stored or awaiting review" };
      }
    }));
    res.status(202).json({ batch, results });
  }));
  router.post("/api/tiktok-farm/runs/:id/stop", ...admin, wrap(async (req, res) => {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ error: "Invalid run ID" });
    const _id = req.params.id;
    const cancelled = await Model.updateOne(
      { _id, active: true, state: "queued" },
      { $set: { state: "cancelled", active: false, phase: "cancelled" } },
    );
    const stopped = cancelled.modifiedCount || (await Model.updateOne(
      { _id, active: true, state: "running", phase: { $ne: "claiming" } },
      { $set: { stopRequested: true } },
    )).matchedCount;
    res.status(stopped ? 200 : 409).json(stopped ? { ok: true } : { error: "Run is finished or already claiming" });
  }));
  router.get("/api/tiktok-farm/codes/:id", ...admin, wrap(async (req, res) => {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ error: "Invalid code ID" });
    const row = await Model.findOne({ _id: req.params.id, state: "completed" }).select("+code").lean();
    if (!row?.code) return res.status(404).json({ error: "Code not found" });
    res.json({ code: decrypt(row.code) });
  }));
  router.post("/api/tiktok-farm/worker/poll", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account } = req.body || {};
    if (typeof account !== "string" || !SLOT.test(account)) return res.status(400).json({ error: "Invalid account slot" });
    for (const [slot, lastSeen] of seen) if (now() - lastSeen >= ONLINE_MS) seen.delete(slot);
    if (seen.size >= 50 && !seen.has(account)) return res.status(429).json({ error: "Worker slot limit reached" });
    seen.set(account, now());
    const lease = randomUUID();
    const run = await Model.findOneAndUpdate(
      { account, active: true, state: "queued" },
      { $set: { lease, leaseUntil: new Date(now() + LEASE_MS), state: "running", phase: "bootstrap" } },
      { returnDocument: "after" },
    ).lean();
    res.json({ job: run ? { id: String(run._id), account, campaign: run.campaign, room: run.room, task: run.task, lease } : null });
  }));
  router.post("/api/tiktok-farm/worker/update", authenticate, jsonOnly, wrap(async (req, res) => {
    const { id, lease, phase, seconds, status, code } = req.body || {};
    if (typeof id !== "string" || !OBJECT_ID.test(id) || typeof lease !== "string" || lease.length !== 36 ||
        !Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
      return res.status(400).json({ error: "Invalid worker update" });
    }
    const current = { _id: id, lease, active: true, state: "running", leaseUntil: { $gt: new Date(now()) } };
    if (!status && PHASES.has(phase)) {
      const next = phase === "claiming" ? { ...current, stopRequested: false } : { ...current, phase: { $ne: "claiming" } };
      const row = await Model.findOneAndUpdate(next, {
        $set: { phase, leaseUntil: new Date(now() + LEASE_MS), ...(phase === "claiming" ? { claimAuthorized: true } : {}) },
        $max: { seconds },
      }, { returnDocument: "after" }).select("account stopRequested").lean();
      if (!row) return res.status(409).json({ error: "Lease expired or stop requested" });
      seen.set(row.account, now());
      return res.json({ stop: row.stopRequested });
    }
    let set;
    if (status === "completed" && typeof code === "string" && !isEncrypted(code) && /^[\x21-\x7e]{1,512}$/.test(code)) {
      delete current.active;
      delete current.state;
      delete current.leaseUntil;
      current.claimAuthorized = true;
      current.$or = [{ state: "running", phase: "claiming" }, { state: "review", phase: "lease-expired" }];
      set = { state: status, phase: "stored", code: encrypt(code), codeHash: hash(code).toString("hex") };
    } else if (status === "cancelled" && !code) {
      current.stopRequested = true;
      current.phase = { $ne: "claiming" };
      set = { state: status, phase: status };
    } else if (status === "failed" && !code && FAILURE_PHASES.has(phase)) {
      const row = await Model.findOne(current).select("phase").lean();
      if (!row) return res.status(409).json({ error: "Lease expired" });
      current.phase = row.phase;
      set = { state: row.phase === "claiming" || phase === "claim-uncertain" ? "review" : "failed", phase };
    } else {
      return res.status(400).json({ error: "Invalid worker result" });
    }
    try {
      const result = await Model.updateOne(current, { $set: { ...set, active: false }, $max: { seconds } });
      if (!result.matchedCount) {
        const saved = status === "completed" && await Model.exists({ _id: id, lease, state: status, codeHash: set.codeHash });
        if (!saved) return res.status(409).json({ error: "Lease expired" });
      }
    } catch (error) {
      if (error.code !== 11000) throw error;
      await Model.updateOne(current, { $set: { state: "review", phase: "duplicate-code", active: false } });
      return res.status(409).json({ error: "Code already exists in inventory" });
    }
    res.json({ ok: true });
  }));
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
