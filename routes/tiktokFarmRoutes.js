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
const CATALOG_MS = 5 * 60_000;
const SCAN_MS = 3 * 60_000;
const PHASES = new Set(["bootstrap", "watching", "claiming"]);
const FAILURE_PHASES = new Set(["ineligible", "session-required", "room-ended", "worker-error", "claim-uncertain"]);
const hash = (value) => createHash("sha256").update(value).digest();

function createRouter({ Model = Run, workerKey = () => process.env.TIKTOK_WORKER_KEY, now = Date.now } = {}) {
  const router = express.Router();
  const seen = new Map();
  const capabilities = new Set();
  const catalogs = new Map();
  const scans = new Map();
  const online = (account) => seen.has(account) && now() - seen.get(account) < ONLINE_MS;
  const fresh = (account) => {
    const catalog = catalogs.get(account);
    return catalog && now() - catalog.updatedAt < CATALOG_MS ? catalog : null;
  };
  const validAccounts = (accounts) => Array.isArray(accounts) && accounts.length >= 1 &&
    accounts.length <= 20 && accounts.every((slot) => typeof slot === "string" && SLOT.test(slot)) &&
    new Set(accounts).size === accounts.length;
  const validEvent = (event) => event && [event.campaign, event.room, event.anchor, event.task]
    .every((id) => typeof id === "string" && ID.test(id)) &&
    typeof event.name === "string" && event.name.trim().length > 0 && event.name.length <= 100 &&
    Number.isInteger(event.duration) && event.duration >= 1 && event.duration <= 1800 &&
    Number.isInteger(event.remaining) && event.remaining >= 0 && event.remaining <= event.duration;
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
      const scan = scans.get(account);
      if (online(account) || scan?.expiresAt > now()) {
        const catalog = fresh(account);
        accounts.push({ account, lastSeen, online: online(account), canScan: capabilities.has(account),
          scanning: Boolean(scan && scan.expiresAt > now()), catalog });
      }
    }
    const [runs, codes] = await Promise.all([
      Model.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      Model.find({ state: "completed", code: { $exists: true } })
        .select("account campaign task eventName updatedAt").sort({ updatedAt: -1 }).limit(200).lean(),
    ]);
    res.json({ accounts, runs, codes });
  }));
  async function enqueue(account, event, batch) {
    const { campaign, room, task, name, duration, anchor } = event;
    const target = { account, campaign, task };
    const metadata = name ? { eventName: name, duration, anchor } : {};
    try {
      const retried = await Model.findOneAndUpdate(
        { ...target, active: false, state: { $in: ["failed", "cancelled"] } },
        {
          $set: { room, batch, ...metadata, active: true, state: "queued", phase: "queued", seconds: 0,
            stopRequested: false, claimAuthorized: false },
          $unset: { lease: 1, leaseUntil: 1, ...(!name && { eventName: 1, duration: 1, anchor: 1 }) },
        },
        { returnDocument: "after" },
      );
      const run = retried || await Model.create({ ...target, room, batch, ...metadata });
      return { account, queued: true, id: run.id, event: name };
    } catch (error) {
      if (error.code !== 11000) throw error;
      return { account, queued: false, reason: "Worker busy, reward stored, or run awaiting review" };
    }
  }

  async function pick(account, events, batch) {
    if (await Model.exists({ account, active: true })) return { account, queued: false, reason: "Worker busy" };
    const candidates = [...events].sort((a, b) => a.remaining - b.remaining || a.duration - b.duration);
    for (const event of candidates) {
      const result = await enqueue(account, event, batch);
      if (result.queued) return result;
    }
    return { account, queued: false, reason: "No eligible new countdown reward" };
  }

  router.post("/api/tiktok-farm/start", ...admin, wrap(async (req, res) => {
    const { accounts, campaign, room, task, mode } = req.body || {};
    const manual = mode === undefined || mode === "manual";
    if (!validAccounts(accounts) || (!manual && mode !== "pick" && mode !== "event") ||
        (manual && ([campaign, room].some((id) => typeof id !== "string" || !ID.test(id)) ||
          (task !== "auto" && (typeof task !== "string" || !ID.test(task))))) ||
        (mode === "event" && [campaign, task].some((id) => typeof id !== "string" || !ID.test(id)))) {
      return res.status(400).json({ error: "Choose up to 20 distinct accounts and a valid farming option" });
    }
    if (manual && accounts.some((account) => !online(account))) {
      return res.status(409).json({ error: "An account worker is offline" });
    }
    await Model.init();
    await sweep();
    const batch = randomUUID();
    const results = await Promise.all(accounts.map(async (account) => {
      if (!online(account)) return { account, queued: false, reason: "Worker offline" };
      if (manual) return enqueue(account, { campaign, room, task }, batch);
      const catalog = fresh(account);
      if (!catalog || catalog.error) return { account, queued: false, reason: "Scan live events first" };
      const events = mode === "event"
        ? catalog.events.filter((event) => event.campaign === campaign && event.task === task)
        : catalog.events;
      return pick(account, events, batch);
    }));
    res.status(202).json({ batch, results });
  }));

  router.post("/api/tiktok-farm/scan", ...admin, wrap(async (req, res) => {
    const { accounts, auto = false } = req.body || {};
    if (!validAccounts(accounts) || typeof auto !== "boolean") return res.status(400).json({ error: "Select account workers" });
    await Model.init();
    await sweep();
    const batch = randomUUID();
    const results = await Promise.all(accounts.map(async (account) => {
      if (!online(account) || !capabilities.has(account)) return { account, reason: "Scanner unavailable" };
      if (await Model.exists({ account, active: true })) return { account, reason: "Worker busy" };
      const pending = scans.get(account);
      if (pending && pending.expiresAt > now()) return { account, reason: "Scan already running" };
      const recent = await Model.findOne({ account, state: "completed" }).sort({ updatedAt: -1 }).select("room").lean();
      // This known room is only a discovery seed for slots with no previous run.
      const room = recent?.room || process.env.TIKTOK_CATALOG_SEED_ROOM || "7704940109955353374";
      if (!ID.test(room)) return { account, reason: "No discovery room available" };
      // Recheck after DB awaits so concurrent clicks do not replace an active scan.
      if (scans.get(account)?.expiresAt > now()) return { account, reason: "Scan already running" };
      scans.set(account, { id: randomUUID(), room, auto, batch, expiresAt: now() + SCAN_MS });
      return { account, scanning: true };
    }));
    res.status(202).json({ results });
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
    const { account, scanCapable, jobId } = req.body || {};
    if (typeof account !== "string" || !SLOT.test(account) ||
        (jobId !== undefined && (typeof jobId !== "string" || !OBJECT_ID.test(jobId)))) {
      return res.status(400).json({ error: "Invalid account slot or run ID" });
    }
    for (const [slot, lastSeen] of seen) {
      if (now() - lastSeen >= ONLINE_MS && !(scans.get(slot)?.expiresAt > now())) {
        seen.delete(slot);
        capabilities.delete(slot);
        catalogs.delete(slot);
        scans.delete(slot);
      }
    }
    if (seen.size >= 50 && !seen.has(account)) return res.status(429).json({ error: "Worker slot limit reached" });
    seen.set(account, now());
    if (scanCapable === true) capabilities.add(account);
    else capabilities.delete(account);
    const lease = randomUUID();
    const run = await Model.findOneAndUpdate(
      { account, active: true, state: "queued", ...(jobId && { _id: jobId }) },
      { $set: { lease, leaseUntil: new Date(now() + LEASE_MS), state: "running", phase: "bootstrap" } },
      { returnDocument: "after" },
    ).lean();
    const scan = scans.get(account);
    if (!run && !jobId && scanCapable === true && scan?.expiresAt > now() && !scan.sent) {
      scan.sent = true;
      return res.json({ job: null, scan: { id: scan.id, room: scan.room } });
    }
    res.json({ job: run ? { id: String(run._id), account, campaign: run.campaign, room: run.room, task: run.task, anchor: run.anchor, lease } : null });
  }));
  router.post("/api/tiktok-farm/worker/catalog", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account, id, events, error } = req.body || {};
    const scan = scans.get(account);
    if (!scan?.sent || scan.id !== id || scan.expiresAt <= now()) {
      return res.status(409).json({ error: "Scan unavailable" });
    }
    if (!Array.isArray(events) || events.length > 30 || !events.every(validEvent) ||
        (error !== undefined && (error !== "scan-failed" || events.length))) {
      return res.status(400).json({ error: "Invalid catalog" });
    }
    scans.delete(account);
    seen.set(account, now());
    const candidates = events.map(({ campaign, room, anchor, task, name, duration, remaining }) =>
      ({ campaign, room, anchor, task, name, duration, remaining }));
    const catalog = { events: candidates, updatedAt: now(), error };
    catalogs.set(account, catalog);
    if (scan.auto && !error) catalog.result = await pick(account, candidates, scan.batch);
    res.json({ ok: true });
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
