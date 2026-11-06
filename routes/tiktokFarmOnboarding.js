const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { decrypt, encrypt } = require("../utils/secretBox");

const PREFIX = "/api/tiktok-farm";
const SETUP_SLOT = /^tiktok-(0[3-9]|[1-9][0-9])$/;
const RUNNING = ["booting", "installing", "signing-in", "verifying", "registering"];
const TERMINAL = ["ready", "attention", "failed"];
const REASONS = new Set(["verification-required", "login-rejected", "unsupported-input", "trace-permission",
  "capacity", "disk-space", "sdk-assets", "boot-timeout", "no-profile", "session-check", "worker-error",
  "app-not-ready", "unexpected-ui", "credentials-unavailable"]);
const SETUP_LEASE_MS = 6 * 60_000;
const hash = (value) => createHash("sha256").update(value).digest();

function parseCredential(input) {
  const { username, password } = input || {};
  if (typeof username !== "string" || !username.trim() || username.length > 254 ||
      typeof password !== "string" || !password.length || password.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(username + password)) return null;
  return { username: username.trim(), password };
}

function mountOnboarding(router, { Automation, Model, admin, jsonOnly, wrap, now, setupKey, online }) {
  let seenAt = null;
  const log = (state, reason) => ({ $each: [{ at: new Date(now()), state, reason }], $slice: -24 });
  const authenticate = (req, res, next) => {
    const key = setupKey();
    if (!key || key.length < 32 ||
        !timingSafeEqual(hash(req.get("authorization") || ""), hash("Bearer " + key))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  router.post(PREFIX + "/accounts/:account/setup", ...admin, wrap(async (req, res) => {
    const { account } = req.params;
    const credential = parseCredential(req.body?.credential);
    if (!SETUP_SLOT.test(account) || !credential) {
      return res.status(400).json({ error: "Use a new slot from tiktok-03 to tiktok-99 and enter its login" });
    }
    if (online(account) || await Model.exists({ account })) {
      return res.status(409).json({ error: "This slot already belongs to a farm worker" });
    }
    await Automation.init();
    try {
      await Automation.updateOne({
        account, enabled: { $ne: true }, setupState: { $exists: false },
      }, {
        $set: { credentials: encrypt(JSON.stringify(credential)), credentialsSavedAt: new Date(now()),
          setupState: "queued", enabled: false },
        $push: { setupLog: log("queued") },
      }, { upsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      return res.status(409).json({ error: "This slot already has a setup. Use Resume setup if it is paused." });
    }
    res.status(202).json({ account, state: "queued" });
  }));

  router.post(PREFIX + "/accounts/:account/setup/resume", ...admin, wrap(async (req, res) => {
    const { account } = req.params;
    if (!SETUP_SLOT.test(account)) return res.status(400).json({ error: "Invalid setup slot" });
    const result = await Automation.updateOne({ account, setupState: { $in: ["attention", "failed"] } }, {
      $set: { setupState: "queued" }, $unset: { setupReason: 1, setupLease: 1, setupLeaseUntil: 1 },
      $push: { setupLog: log("queued") },
    });
    if (!result.matchedCount) return res.status(409).json({ error: "Setup is not paused" });
    res.status(202).json({ account, state: "queued" });
  }));

  router.post(PREFIX + "/worker/setup/poll", authenticate, jsonOnly, wrap(async (_req, res) => {
    seenAt = now();
    const lease = randomUUID();
    const record = await Automation.findOneAndUpdate({
      setupState: { $in: ["queued", ...RUNNING] },
      $or: [{ setupLeaseUntil: { $exists: false } }, { setupLeaseUntil: { $lte: new Date(now()) } }],
    }, {
      $set: { setupState: "booting", setupLease: lease, setupLeaseUntil: new Date(now() + SETUP_LEASE_MS) },
      $push: { setupLog: log("booting") },
    }, { sort: { credentialsSavedAt: 1 }, returnDocument: "after" }).select("+credentials").lean();
    if (!record) return res.json({ job: null });
    const clear = decrypt(record.credentials);
    const credential = clear && parseCredential(JSON.parse(clear));
    if (!credential) {
      await Automation.updateOne({ account: record.account, setupLease: lease }, {
        $set: { setupState: "failed", setupReason: "credentials-unavailable" },
        $unset: { setupLease: 1, setupLeaseUntil: 1 },
        $push: { setupLog: log("failed", "credentials-unavailable") },
      });
      return res.json({ job: null });
    }
    res.json({ job: { account: record.account, lease, credential } });
  }));

  router.post(PREFIX + "/worker/setup/update", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account, lease, state, reason, serial, handle } = req.body || {};
    if (typeof account !== "string" || !SETUP_SLOT.test(account) ||
        typeof lease !== "string" || lease.length !== 36 || ![...RUNNING, ...TERMINAL].includes(state) ||
        (reason !== undefined && !REASONS.has(reason)) ||
        (serial !== undefined && (typeof serial !== "string" || !/^emulator-\d{4,5}$/.test(serial))) ||
        (handle !== undefined && (state !== "ready" || typeof handle !== "string" || !/^@[a-zA-Z0-9_.]{1,32}$/.test(handle))) ||
        (state === "ready" && (!serial || !handle))) {
      return res.status(400).json({ error: "Invalid setup status" });
    }
    seenAt = now();
    const ended = TERMINAL.includes(state);
    const result = await Automation.updateOne({
      account, setupLease: lease, setupLeaseUntil: { $gt: new Date(now()) }, setupState: { $in: RUNNING },
    }, {
      $set: { setupState: state, ...(serial && { setupSerial: serial }), ...(reason && { setupReason: reason }),
        ...(!ended && { setupLeaseUntil: new Date(now() + SETUP_LEASE_MS) }),
        ...(state === "ready" && { setupHandle: handle, enabled: true, nextScanAt: new Date(now()) }) },
      ...(ended && { $unset: { setupLease: 1, setupLeaseUntil: 1 } }),
      $push: { setupLog: log(state, reason) },
    });
    if (!result.matchedCount) return res.status(409).json({ error: "Setup lease unavailable" });
    res.json({ ok: true });
  }));
  return () => seenAt !== null && now() - seenAt < SETUP_LEASE_MS;
}

module.exports = { mountOnboarding, parseCredential };
