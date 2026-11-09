const express = require("express");
const path = require("node:path");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const { decrypt, encrypt, isEncrypted } = require("../utils/secretBox");
const Run = require("../models/TikTokFarmRun");
const Schedule = require("../models/TikTokFarmSchedule");
const { parseRuntime, groupHosts, summaryPipeline } = require("../utils/tiktokFarmDashboard");
const { mountOnboarding, parseCredential } = require("./tiktokFarmOnboarding");
const farmShop = require("./tiktokFarmShop");

const SLOT = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^\d{1,22}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;
// Android can suspend between otherwise healthy polls. Keep a bounded grace
// window without permitting a stale worker to authorize a claim.
const LEASE_MS = 180_000;
const ONLINE_MS = 45_000;
const CATALOG_MS = 15 * 60_000;
const UPCOMING_MS = 30 * 60_000;
const SCAN_MS = 4 * 60_000;
const CATALOG_LIMIT = 100;
const MAX_WATCH_SECONDS = 3600;
const AUTO_SCAN_MS = 10 * 60_000;
const SCAN_RETRY_MS = 2 * 60_000;
const AUTO_RETRY_MS = 30 * 60_000;
const MAX_AUTO_ATTEMPTS = 3;
const PHASES = new Set(["bootstrap", "watching", "claiming"]);
const FAILURE_PHASES = new Set([
  "ineligible", "session-required", "room-ended", "worker-error", "claim-uncertain", "capture-timeout", "reward-read-failed",
]);
const hash = (value) => createHash("sha256").update(value).digest();

function createRouter({ Model = Run, Automation = Schedule, workerKey = () => process.env.TIKTOK_WORKER_KEY,
  setupKey = () => process.env.TIKTOK_SETUP_KEY, now = Date.now } = {}) {
  const router = express.Router();
  const seen = new Map();
  const capabilities = new Set();
  const apiRoutes = new Map();
  const catalogs = new Map();
  const upcomingFeeds = new Map();
  const scans = new Map();
  const runtimes = new Map();
  const heartbeatSaved = new Map();
  const online = (account) => seen.has(account) && now() - seen.get(account) < ONLINE_MS;
  const fresh = (account) => {
    const catalog = catalogs.get(account);
    return catalog && now() - catalog.updatedAt < CATALOG_MS ? catalog : null;
  };
  const validAccounts = (accounts) => Array.isArray(accounts) && accounts.length >= 1 &&
    accounts.length <= 20 && accounts.every((slot) => typeof slot === "string" && SLOT.test(slot)) &&
    new Set(accounts).size === accounts.length;
  const validDate = (value) => value == null ||
    (Number.isSafeInteger(value) && value >= 946684800000 && value < 4102444800000);
  const validEvent = (event) => event && [event.campaign, event.room, event.anchor, event.task]
    .every((id) => typeof id === "string" && ID.test(id)) &&
    typeof event.name === "string" && event.name.trim().length > 0 && event.name.length <= 100 &&
    Number.isInteger(event.duration) && event.duration >= 1 && event.duration <= MAX_WATCH_SECONDS &&
    Number.isInteger(event.remaining) && event.remaining >= 0 && event.remaining <= event.duration && validDate(event.endsAt);
  const validUpcoming = (event) => event && typeof event.campaign === "string" && ID.test(event.campaign) &&
    typeof event.name === "string" && event.name.trim().length > 0 && event.name.length <= 100 &&
    (event.game === undefined || typeof event.game === "string" && event.game.length <= 100) &&
    [event.startsAt, event.endsAt].every(validDate);
  const validCampaign = (event) => validUpcoming(event) &&
    ["eligible", "no-live-room", "no-eligible-task", "incomplete"].includes(event.status) &&
    typeof event.otherTasks === "boolean" &&
    (event.watchSeconds === undefined || Array.isArray(event.watchSeconds) && event.watchSeconds.length <= 20 &&
      event.watchSeconds.every((seconds) => Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400));
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
    if (req.body?.runtime !== undefined) {
      req.workerRuntime = parseRuntime(req.body.runtime);
      if (!req.workerRuntime) return res.status(400).json({ error: "Invalid worker health report" });
    }
    next();
  };
  async function heartbeat(account, runtime) {
    seen.set(account, now());
    if (runtime) runtimes.set(account, { ...runtime, reportedAt: now() });
    if (!heartbeatSaved.has(account) || now() - heartbeatSaved.get(account) >= 60_000) {
      heartbeatSaved.set(account, now());
      try {
        await Automation.updateOne({ account }, { $set: { lastHeartbeatAt: new Date(now()),
          ...(runtime && { runtime: runtimes.get(account) }) } }, { upsert: true });
      } catch (error) { heartbeatSaved.delete(account); throw error; }
    }
  }
  const sweep = async (account) => {
    const expired = { ...(account && { account }), active: true, state: "running",
      leaseUntil: { $lte: new Date(now()) } };
    // Only positively known pre-claim runs may enter the normal capped retry
    // path. An authorized or ambiguous claim still requires review.
    await Model.updateMany({ ...expired, claimAuthorized: false, stopRequested: false,
      phase: { $in: ["bootstrap", "watching"] }, code: { $exists: false } },
    { $set: { active: false, state: "failed", phase: "lease-expired" } });
    await Model.updateMany(expired,
      { $set: { active: false, state: "review", phase: "lease-expired" } });
  };
  async function discoveryRoom(account) {
    const recent = await Model.findOne({ account, state: "completed" }).sort({ updatedAt: -1 }).select("room updatedAt").lean();
    if (recent && now() - recent.updatedAt < 2 * 60 * 60_000 && ID.test(recent.room)) return recent.room;
    const latest = await Model.findOne({ state: "completed" }).sort({ updatedAt: -1 }).select("room").lean();
    return latest && ID.test(latest.room) ? latest.room : process.env.TIKTOK_CATALOG_SEED_ROOM || "7704940109955353374";
  }
  const setupOnline = mountOnboarding(router, { Automation, Model, admin, jsonOnly, wrap, now, setupKey, online, discoveryRoom, authenticate });
  farmShop.mount(router, { Model, authenticate, jsonOnly, wrap, admin, now });

  router.get("/admin/tiktok-farm", ...admin, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "../views/tiktok-farm.html"));
  });
  router.get("/api/tiktok-farm/state", ...admin, wrap(async (_req, res) => {
    await sweep();
    const [history, active, codes, schedules, statistics] = await Promise.all([
      Model.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      Model.find({ active: true }).sort({ createdAt: -1 }).lean(),
      Model.find({ state: "completed", code: { $exists: true } })
        .select("account campaign task eventName duration updatedAt").sort({ updatedAt: -1 }).limit(200).lean(),
      Automation.find({}).select("account enabled nextScanAt lastScanAt lastResult lastApiRoute lastHeartbeatAt runtime lastCatalog credentialsSavedAt setupState setupSerial setupHandle setupReason setupLog -_id").lean(),
      Model.aggregate(summaryPipeline(now())),
    ]);
    const runs = [...new Map([...active, ...history].map((run) => [String(run._id), run])).values()];
    const scheduled = new Map(schedules.map((schedule) => [schedule.account, schedule]));
    const stats = new Map(statistics.map(({ _id, ...values }) => [_id, values]));
    const accounts = [];
    for (const account of new Set([...seen.keys(), ...scheduled.keys(), ...stats.keys()])) {
      const scan = scans.get(account);
      const record = scheduled.get(account) || {};
      const { credentialsSavedAt, setupState, setupSerial, setupHandle, setupReason, setupLog,
        runtime, lastHeartbeatAt, lastCatalog, ...schedule } = record;
      const feed = upcomingFeeds.get(account);
      const catalog = fresh(account) || (lastCatalog && { ...lastCatalog, stale: true });
      accounts.push({ account, lastSeen: seen.get(account) || lastHeartbeatAt, online: online(account),
        canScan: capabilities.has(account), scanning: Boolean(scan && scan.expiresAt > now()), catalog,
        upcoming: feed && now() - feed.updatedAt < UPCOMING_MS ? feed.events : lastCatalog?.upcoming || [],
        runtime: runtimes.get(account) || runtime, statistics: stats.get(account) || { codes: 0, claimed24h: 0, review: 0, failed: 0 },
        apiRoute: apiRoutes.get(account) || schedule.lastApiRoute, credentialsSavedAt, schedule,
        setup: setupState && { state: setupState, serial: setupSerial, handle: setupHandle, reason: setupReason, log: setupLog },
        automation: schedule.enabled ? schedule : undefined });
    }
    accounts.sort((a, b) => a.account.localeCompare(b.account));
    const totals = statistics.reduce((result, row) => ({ codes: result.codes + row.codes,
      claimed24h: result.claimed24h + row.claimed24h, review: result.review + row.review,
      lastClaimAt: row.lastClaimAt && (!result.lastClaimAt || row.lastClaimAt > result.lastClaimAt) ? row.lastClaimAt : result.lastClaimAt,
    }), { codes: 0, claimed24h: 0, review: 0, lastClaimAt: null });
    res.json({ accounts, runs, codes, codeCount: totals.codes, totals, hosts: groupHosts(accounts),
      serverTime: now(), setupOnline: setupOnline(), autoScanMinutes: AUTO_SCAN_MS / 60_000 });
  }));
  router.get("/api/tiktok-farm/inventory", ...admin, wrap(async (req, res) => {
    const { account = "", q = "", page = "1" } = req.query;
    if (typeof account !== "string" || account && !SLOT.test(account) || typeof q !== "string" || q.length > 100 ||
        typeof page !== "string" || !/^[1-9][0-9]{0,5}$/.test(page)) return res.status(400).json({ error: "Invalid inventory filter" });
    const filter = { state: "completed", code: { $exists: true }, ...(account && { account }) };
    if (q.trim()) {
      const pattern = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = ["account", "eventName", "campaign", "task", "reward.gameName", "reward.items.name"].map((field) => ({ [field]: { $regex: pattern, $options: "i" } }));
    }
    const total = await Model.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / 50)), current = Math.min(Number(page), pages);
    const codes = await Model.find(filter).select("account campaign task eventName duration updatedAt reward revealedAt rewardBlocked")
      .sort({ updatedAt: -1, _id: -1 }).skip((current - 1) * 50).limit(50).lean();
    res.json({ codes: await farmShop.inventoryStatus(codes, now()), total, page: current, pages });
  }));
  router.post("/api/tiktok-farm/accounts/:account/credentials", ...admin, wrap(async (req, res) => {
    const { account } = req.params;
    const credential = parseCredential(req.body?.credential);
    if (!SLOT.test(account) || !credential) {
      return res.status(400).json({ error: "Enter a valid account slot, username, and password" });
    }
    await Automation.init();
    const setup = await Automation.findOne({ account }).select("setupTarget setupState +sessionPacket").lean();
    if (setup?.setupTarget === "phone" && (setup.sessionPacket ||
        ["booting", "installing", "signing-in", "verifying", "capturing", "registering", "transferring", "phone-check"].includes(setup.setupState)))
      return res.status(409).json({ error: "Wait for the current account setup before changing its login" });
    const credentials = encrypt(JSON.stringify(credential));
    await Automation.updateOne({ account }, {
      $set: { credentials, credentialsSavedAt: new Date(now()) },
    }, { upsert: true });
    res.json({ ok: true });
  }));
  router.get("/api/tiktok-farm/accounts/:account/credentials", ...admin, wrap(async (req, res) => {
    if (!SLOT.test(req.params.account)) return res.status(400).json({ error: "Invalid account slot" });
    const record = await Automation.findOne({ account: req.params.account }).select("+credentials").lean();
    if (!record?.credentials) return res.status(404).json({ error: "No saved login for this slot" });
    const credential = decrypt(record.credentials);
    if (!credential) return res.status(503).json({ error: "Saved login could not be opened" });
    res.json(JSON.parse(credential));
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
    const time = now();
    const candidates = events.filter((event) => !automatic || event.endsAt == null ||
      event.endsAt > time + event.remaining * 1000).sort((a, b) =>
      Number(a.remaining > 0) - Number(b.remaining > 0) ||
      (automatic && (a.endsAt ?? Number.MAX_SAFE_INTEGER) - (b.endsAt ?? Number.MAX_SAFE_INTEGER)) ||
      a.remaining - b.remaining || a.duration - b.duration);
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

  async function createScan(account, { auto, batch, scheduleToken, retrySoon }) {
    if (scans.get(account)?.expiresAt > now()) return { account, reason: "Scan already running" };
    if (await Model.exists({ account, active: true })) return { account, reason: "Worker busy" };
    // The seed only prompts a fresh authenticated discovery request.
    const room = await discoveryRoom(account);
    if (!ID.test(room)) return { account, reason: "No discovery room available" };
    const alternative = await Model.findOne({ state: "completed", room: { $ne: room } })
      .sort({ updatedAt: -1 }).select("room").lean();
    const fallbackRoom = alternative?.room || process.env.TIKTOK_CATALOG_SEED_ROOM;
    if (scans.get(account)?.expiresAt > now()) return { account, reason: "Scan already running" };
    scans.set(account, { id: randomUUID(), room, fallbackRoom: fallbackRoom !== room && ID.test(fallbackRoom) ? fallbackRoom : undefined,
      auto, batch, scheduleToken, retrySoon, expiresAt: now() + SCAN_MS });
    return { account, scanning: true };
  }

  async function scheduleScan(account) {
    if (scans.get(account)?.expiresAt > now()) return;
    const due = { account, enabled: true, nextScanAt: { $lte: new Date(now()) } };
    if (!await Automation.exists(due)) return;
    await sweep(account);
    if (await Model.exists({ account, active: true })) return;
    const token = randomUUID();
    const reserved = await Automation.findOneAndUpdate(due, {
      $set: { nextScanAt: new Date(now() + AUTO_SCAN_MS), scanToken: token, lastResult: "Scan started" },
    }, { returnDocument: "before" }).select("lastResult").lean();
    if (!reserved) return;
    const retrySoon = !["Scan failed", "Scan incomplete", "Sign-in check needed"].includes(reserved.lastResult);
    const result = await createScan(account, { auto: true, batch: randomUUID(), scheduleToken: token, retrySoon });
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
    const result = await farmShop.reveal(Model, req.params.id, now());
    res.status(result.status || 200).json(result.error ? { error: result.error } : { code: result.code });
  }));
  router.post("/api/tiktok-farm/worker/poll", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account, scanCapable, jobId, apiRoute } = req.body || {};
    if (typeof account !== "string" || !SLOT.test(account) ||
        (jobId !== undefined && (typeof jobId !== "string" || !OBJECT_ID.test(jobId)))) {
      return res.status(400).json({ error: "Invalid account slot or run ID" });
    }
    for (const [slot, lastSeen] of seen) {
      if (now() - lastSeen >= ONLINE_MS && !(scans.get(slot)?.expiresAt > now())) {
        seen.delete(slot);
        capabilities.delete(slot);
        apiRoutes.delete(slot);
        runtimes.delete(slot);
        catalogs.delete(slot);
        upcomingFeeds.delete(slot);
        scans.delete(slot);
      }
    }
    if (seen.size >= 50 && !seen.has(account)) return res.status(429).json({ error: "Worker slot limit reached" });
    await heartbeat(account, req.workerRuntime);
    if (["phone", "mac"].includes(apiRoute)) apiRoutes.set(account, apiRoute);
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
        return res.json({ job: null, scan: { id: scan.id, room: scan.room, fallbackRoom: scan.fallbackRoom } });
      }
    }
    if (!run && !jobId && req.body.stockCapable === true && !await Model.exists({ account, active: true })) {
      const stock = await Model.findOneAndUpdate({ account, state: "completed", code: { $exists: true },
        $or: [{ rewardNextCheckAt: { $exists: false } }, { rewardNextCheckAt: { $lte: new Date(now()) } }] },
      { $set: { rewardNextCheckAt: new Date(now() + 3600e3) } },
      { returnDocument: "after", sort: { rewardNextCheckAt: 1, createdAt: 1 }, timestamps: false })
        .select("account campaign room task anchor +codeHash").lean();
      if (stock) return res.json({ job: null, stock: { id: String(stock._id), account, campaign: stock.campaign,
        room: stock.room, task: stock.task, anchor: stock.anchor || "0", codeHash: stock.codeHash } });
    }
    res.json({ job: run ? { id: String(run._id), account, campaign: run.campaign, room: run.room, task: run.task,
      anchor: run.anchor, automatic: run.automatic === true, lease } : null });
  }));
  router.post("/api/tiktok-farm/worker/catalog", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account, id, events, upcoming = [], campaigns = [], partial = false, error, apiRoute } = req.body || {};
    const scan = scans.get(account);
    if (!scan?.sent || scan.id !== id || scan.expiresAt <= now()) {
      return res.status(409).json({ error: "Scan unavailable" });
    }
    if (!Array.isArray(events) || events.length > CATALOG_LIMIT || !events.every(validEvent) ||
        !Array.isArray(upcoming) || upcoming.length > CATALOG_LIMIT || !upcoming.every(validUpcoming) ||
        !Array.isArray(campaigns) || campaigns.length > CATALOG_LIMIT || !campaigns.every(validCampaign) ||
        typeof partial !== "boolean" ||
        (error !== undefined && (!["scan-failed", "session-required"].includes(error) || events.length ||
          upcoming.length || campaigns.length || partial))) {
      return res.status(400).json({ error: "Invalid catalog" });
    }
    scans.delete(account);
    await heartbeat(account, req.workerRuntime);
    if (["phone", "mac"].includes(apiRoute)) apiRoutes.set(account, apiRoute);
    const candidates = events.map(({ campaign, room, anchor, task, name, duration, remaining, endsAt }) =>
      ({ campaign, room, anchor, task, name, duration, remaining, endsAt }));
    const campaignInfo = ({ campaign, name, game, startsAt, endsAt }) => ({ campaign, name, game, startsAt, endsAt });
    const catalog = { events: candidates, campaigns: campaigns.map((event) => ({
      ...campaignInfo(event), status: event.status, otherTasks: event.otherTasks, watchSeconds: event.watchSeconds,
    })), partial, updatedAt: now(), error };
    if (!error) upcomingFeeds.set(account, { updatedAt: now(), events: upcoming.map(campaignInfo) });
    catalogs.set(account, catalog);
    if (scan.scheduleToken) {
      const current = { account, enabled: true, scanToken: scan.scheduleToken };
      if (!error && await Automation.exists(current)) catalog.result = await pick(account, candidates, scan.batch, true);
      const lastResult = error === "session-required" ? "Sign-in check needed" : error ? "Scan failed" :
        catalog.result?.queued ? "Queued " + catalog.result.event : partial ? "Scan incomplete" :
          catalog.result?.reason || "Scan finished";
      const checkAgain = scan.retrySoon && !catalog.result?.queued && (error === "scan-failed" || partial);
      await Automation.updateOne(current, {
        $set: { lastScanAt: new Date(now()), lastResult,
          ...(checkAgain && { nextScanAt: new Date(now() + SCAN_RETRY_MS) }),
          ...(!error && ["phone", "mac"].includes(apiRoute) && { lastApiRoute: apiRoute }) },
        $unset: { scanToken: 1 },
      });
    } else if (scan.auto && !error) {
      catalog.result = await pick(account, candidates, scan.batch);
    }
    if (!error) await Automation.updateOne({ account }, { $set: { lastCatalog: { ...catalog,
      upcoming: upcoming.map(campaignInfo) }, lastScanAt: new Date(now()),
      ...(["phone", "mac"].includes(apiRoute) && { lastApiRoute: apiRoute }) } }, { upsert: true });
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
      await heartbeat(row.account, req.workerRuntime);
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
