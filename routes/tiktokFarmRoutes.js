const express = require("express");
const path = require("node:path");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const { decrypt, encrypt, isEncrypted } = require("../utils/secretBox");
const Run = require("../models/TikTokFarmRun");
const Schedule = require("../models/TikTokFarmSchedule");

const SLOT = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^\d{1,22}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const LEASE_MS = 60_000;
const ONLINE_MS = 45_000;
const CATALOG_MS = 5 * 60_000;
const SCAN_MS = 3 * 60_000;
const AUTO_SCAN_MS = 10 * 60_000;
const AUTO_RETRY_MS = 30 * 60_000;
const MAX_AUTO_ATTEMPTS = 3;
const PHASES = new Set(["bootstrap", "watching", "claiming"]);
const FAILURE_PHASES = new Set(["ineligible", "session-required", "room-ended", "worker-error", "claim-uncertain"]);
const hash = (value) => createHash("sha256").update(value).digest();

function createRouter({ Model = Run, Automation = Schedule, workerKey = () => process.env.TIKTOK_WORKER_KEY, now = Date.now } = {}) {
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
  const sweep = (account) => Model.updateMany(
    { ...(account && { account }), active: true, state: "running", leaseUntil: { $lte: new Date(now()) } },
    { $set: { active: false, state: "review", phase: "lease-expired" } },
  );

  router.get("/admin/tiktok-farm", ...admin, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "../views/tiktok-farm.html"));
  });
  router.get("/api/tiktok-farm/state", ...admin, wrap(async (_req, res) => {
    await sweep();
    const [runs, codes, schedules] = await Promise.all([
      Model.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      Model.find({ state: "completed", code: { $exists: true } })
        .select("account campaign task eventName updatedAt").sort({ updatedAt: -1 }).limit(200).lean(),
      Automation.find({ enabled: true }).select("account enabled nextScanAt lastScanAt lastResult -_id").lean(),
    ]);
    const scheduled = new Map(schedules.map((schedule) => [schedule.account, schedule]));
    const accounts = [];
    for (const account of new Set([...seen.keys(), ...scheduled.keys()])) {
      const scan = scans.get(account);
      const automation = scheduled.get(account);
      if (online(account) || scan?.expiresAt > now() || automation) {
        accounts.push({ account, lastSeen: seen.get(account), online: online(account), canScan: capabilities.has(account),
          scanning: Boolean(scan && scan.expiresAt > now()), catalog: fresh(account), automation });
      }
    }
    res.json({ accounts, runs, codes, autoScanMinutes: AUTO_SCAN_MS / 60_000 });
  }));
  async function enqueue(account, event, batch, automatic = false) {
    const { campaign, room, task, name, duration, anchor } = event;
    const target = { account, campaign, task };
    const metadata = name ? { eventName: name, duration, anchor } : {};
    const retryable = automatic ? {
      state: "failed", updatedAt: { $lte: new Date(now() - AUTO_RETRY_MS) },
      $or: [{ autoAttempts: { $lt: MAX_AUTO_ATTEMPTS } }, { autoAttempts: { $exists: false } }],
    } : { state: { $in: ["failed", "cancelled"] } };
    try {
      const retried = await Model.findOneAndUpdate(
        { ...target, active: false, ...retryable },
        {
          $set: { room, batch, ...metadata, automatic, active: true, state: "queued", phase: "queued", seconds: 0,
            stopRequested: false, claimAuthorized: false },
          ...(automatic && { $inc: { autoAttempts: 1 } }),
          $unset: { lease: 1, leaseUntil: 1, ...(!name && { eventName: 1, duration: 1, anchor: 1 }) },
        },
        { returnDocument: "after" },
      );
      const run = retried || await Model.create({ ...target, room, batch, ...metadata,
        automatic, autoAttempts: automatic ? 1 : 0 });
      return { account, queued: true, id: run.id, event: name };
    } catch (error) {
      if (error.code !== 11000) throw error;
      return { account, queued: false, reason: "Worker busy, reward stored, or run awaiting review" };
    }
  }

  async function pick(account, events, batch, automatic = false) {
    if (await Model.exists({ account, active: true })) return { account, queued: false, reason: "Worker busy" };
    const candidates = [...events].sort((a, b) => a.remaining - b.remaining || a.duration - b.duration);
    const previous = candidates.length ? await Model.find({
      account, $or: candidates.map(({ campaign, task }) => ({ campaign, task })),
    }).select("campaign task state updatedAt autoAttempts").lean() : [];
    const history = new Map(previous.map((run) => [run.campaign + ":" + run.task, run]));
    for (const event of candidates) {
      const run = history.get(event.campaign + ":" + event.task);
      if (run && !["failed", "cancelled"].includes(run.state)) continue;
      if (automatic && run && (run.state === "cancelled" || (run.autoAttempts || 0) >= MAX_AUTO_ATTEMPTS ||
          now() - run.updatedAt < AUTO_RETRY_MS)) continue;
      const result = await enqueue(account, event, batch, automatic);
      if (result.queued) return result;
    }
    return { account, queued: false, reason: "No eligible new countdown reward" };
  }

  async function createScan(account, { auto, batch, scheduleToken }) {
    if (scans.get(account)?.expiresAt > now()) return { account, reason: "Scan already running" };
    if (await Model.exists({ account, active: true })) return { account, reason: "Worker busy" };
    const recent = await Model.findOne({ account, state: "completed" }).sort({ updatedAt: -1 }).select("room").lean();
    // The seed only prompts a fresh authenticated discovery request.
    const room = recent?.room || process.env.TIKTOK_CATALOG_SEED_ROOM || "7704940109955353374";
    if (!ID.test(room)) return { account, reason: "No discovery room available" };
    if (scans.get(account)?.expiresAt > now()) return { account, reason: "Scan already running" };
    scans.set(account, { id: randomUUID(), room, auto, batch, scheduleToken, expiresAt: now() + SCAN_MS });
    return { account, scanning: true };
  }

  async function scheduleScan(account) {
    if (scans.get(account)?.expiresAt > now()) return;
    const due = { account, enabled: true, nextScanAt: { $lte: new Date(now()) } };
    if (!await Automation.exists(due)) return;
    await sweep(account);
    if (await Model.exists({ account, active: true })) return;
    const token = randomUUID();
    const reserved = await Automation.updateOne(due, {
      $set: { nextScanAt: new Date(now() + AUTO_SCAN_MS), scanToken: token, lastResult: "Scan started" },
    });
    if (!reserved.modifiedCount) return;
    const result = await createScan(account, { auto: true, batch: randomUUID(), scheduleToken: token });
    if (!result.scanning) {
      await Automation.updateOne({ account, scanToken: token }, { $set: { lastResult: result.reason } });
    }
  }

  router.post("/api/tiktok-farm/automation", ...admin, wrap(async (req, res) => {
    const { accounts, enabled } = req.body || {};
    if (!validAccounts(accounts) || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Choose account workers and an automation setting" });
    }
    await Automation.init();
    const results = await Promise.all(accounts.map(async (account) => {
      if (enabled && (!online(account) || !capabilities.has(account))) {
        return { account, reason: "Scanner unavailable" };
      }
      if (enabled) {
        await Automation.updateOne({ account }, [{
          $set: { enabled: true, nextScanAt: { $cond: ["$enabled", "$nextScanAt", new Date(now())] } },
        }], { upsert: true, updatePipeline: true });
      } else {
        await Automation.updateOne({ account }, { $set: { enabled: false }, $unset: { scanToken: 1 } });
        if (scans.get(account)?.scheduleToken) scans.delete(account);
      }
      return { account, enabled };
    }));
    res.json({ results });
  }));

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
      return createScan(account, { auto, batch });
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
    if (!run && !jobId && scanCapable === true) {
      await scheduleScan(account);
      const scan = scans.get(account);
      if (scan?.expiresAt > now() && !scan.sent) {
        scan.sent = true;
        return res.json({ job: null, scan: { id: scan.id, room: scan.room } });
      }
    }
    res.json({ job: run ? { id: String(run._id), account, campaign: run.campaign, room: run.room, task: run.task,
      anchor: run.anchor, automatic: run.automatic === true, lease } : null });
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
    if (scan.scheduleToken) {
      const current = { account, enabled: true, scanToken: scan.scheduleToken };
      if (!error && await Automation.exists(current)) catalog.result = await pick(account, candidates, scan.batch, true);
      const lastResult = error ? "Scan failed" :
        catalog.result?.queued ? "Queued " + catalog.result.event : catalog.result?.reason || "Scan finished";
      await Automation.updateOne(current, { $set: { lastScanAt: new Date(now()), lastResult }, $unset: { scanToken: 1 } });
    } else if (scan.auto && !error) {
      catalog.result = await pick(account, candidates, scan.batch);
    }
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
