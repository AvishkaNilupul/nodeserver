const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { decrypt, encrypt } = require("../utils/secretBox");

const { parsePacket } = require("../utils/tiktokSessionPacket");

const PREFIX = "/api/tiktok-farm";
const SETUP_SLOT = /^tiktok-(0[3-9]|[1-9][0-9])$/;
const RUNNING = ["booting", "installing", "signing-in", "verifying", "registering", "capturing"];
const TERMINAL = ["ready", "attention", "failed"];
const REASONS = new Set(["verification-required", "login-rejected", "unsupported-input", "trace-permission",
  "capacity", "disk-space", "sdk-assets", "boot-timeout", "no-profile", "session-check", "worker-error",
  "app-not-ready", "unexpected-ui", "credentials-unavailable", "phone-check-failed", "capture-timeout", "duplicate-account", "no-live-room"]);
const SETUP_LEASE_MS = 6 * 60_000;
const hash = (value) => createHash("sha256").update(value).digest();

function parseCredential(input) {
  const { username, password } = input || {};
  if (typeof username !== "string" || !username.trim() || username.length > 254 ||
      typeof password !== "string" || !password.length || password.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(username + password)) return null;
  return { username: username.trim(), password };
}

function mountOnboarding(router, { Automation, Model, admin, jsonOnly, wrap, now, setupKey, online, discoveryRoom, authenticate: phoneAuth }) {
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
          setupState: "queued", setupTarget: "phone", enabled: false },
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
    const pending = await Automation.findOne({ account }).select("+sessionPacket").lean();
    const next = pending?.sessionPacket ? "transferring" : "queued";
    const result = await Automation.updateOne({ account, enabled: false, setupState: { $in: ["attention", "failed"] } }, {
      $set: { setupState: next }, $unset: { setupReason: 1, setupLease: 1, setupLeaseUntil: 1, deliveryLease: 1, deliveryLeaseUntil: 1 },
      $push: { setupLog: log(next) },
    });
    if (!result.matchedCount) return res.status(409).json({ error: "Setup is not paused" });
    res.status(202).json({ account, state: next });
  }));

  router.post(PREFIX + "/worker/setup/poll", authenticate, jsonOnly, wrap(async (_req, res) => {
    seenAt = now();
    const lease = randomUUID();
    const record = await Automation.findOneAndUpdate({
      setupTarget: "phone", enabled: false, setupState: { $in: ["queued", ...RUNNING] },
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
    res.json({ job: { account: record.account, lease, credentialVersion: record.credentialsSavedAt?.toISOString(), credential, seedRoom: await discoveryRoom(record.account) } });
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
    if (state === "ready") return res.status(409).json({ error: "The phone must verify this account before it is ready" });
    const ended = TERMINAL.includes(state);
    const result = await Automation.updateOne({
      account, setupLease: lease, setupLeaseUntil: { $gt: new Date(now()) }, setupState: { $in: RUNNING },
    }, {
      $set: { setupState: state, ...(serial && { setupSerial: serial }), ...(reason && { setupReason: reason }),
        ...(!ended && { setupLeaseUntil: new Date(now() + SETUP_LEASE_MS) }) },
      ...(ended && { $unset: { setupLease: 1, setupLeaseUntil: 1 } }),
      $push: { setupLog: log(state, reason) },
    });
    if (!result.matchedCount) return res.status(409).json({ error: "Setup lease unavailable" });
    res.json({ ok: true });
  }));

  router.post(PREFIX + "/worker/setup/session", authenticate, jsonOnly, wrap(async (req, res) => {
    const { account, lease, handle, packet, credentialVersion } = req.body || {};
    const parsed = typeof account === "string" && SETUP_SLOT.test(account) && parsePacket(packet, account);
    if (!parsed || typeof lease !== "string" || typeof handle !== "string" || !/^@[a-zA-Z0-9_.]{1,32}$/.test(handle))
      return res.status(400).json({ error: "Invalid session handoff" });
    const record = await Automation.findOne({ account, setupLease: lease, setupTarget: "phone",
      setupLeaseUntil: { $gt: new Date(now()) }, setupState: { $in: RUNNING }, enabled: false }).select("+sessionDigest").lean();
    // A response may have been lost after the encrypted packet was committed.
    if (!record) {
      const saved = await Automation.findOne({ account, setupTarget: "phone", sessionDigest: parsed.digest,
        setupState: { $in: ["transferring", "phone-check", "ready"] } }).lean();
      return saved ? res.json({ ok: true }) : res.status(409).json({ error: "Setup lease unavailable" });
    }
    if (record.credentialsSavedAt?.toISOString() !== credentialVersion || online(account) || await Model.exists({ account }))
      return res.status(409).json({ error: "Account changed during setup" });
    const duplicate = async () => {
      await Automation.updateOne({ account, setupLease: lease, enabled: false }, {
        $set: { setupState: "attention", setupReason: "duplicate-account" },
        $unset: { setupLease: 1, setupLeaseUntil: 1 }, $push: { setupLog: log("attention", "duplicate-account") },
      });
      return res.status(409).json({ error: "This TikTok account is already enrolled" });
    };
    if (await Automation.exists({ account: { $ne: account }, $or: [
      { setupIdentity: handle.toLowerCase() }, { setupHandle: new RegExp("^" + handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") } ] }))
      return duplicate();
    try {
      const changed = await Automation.updateOne({ account, setupLease: lease, enabled: false,
        credentialsSavedAt: record.credentialsSavedAt, setupLeaseUntil: { $gt: new Date(now()) } }, {
        $set: { sessionPacket: encrypt(parsed.text), sessionDigest: parsed.digest,
          setupHandle: handle, setupIdentity: handle.toLowerCase(), setupState: "transferring" },
        $unset: { setupLease: 1, setupLeaseUntil: 1, setupReason: 1 }, $push: { setupLog: log("transferring") },
      });
      if (!changed.matchedCount) return res.status(409).json({ error: "Setup lease unavailable" });
    } catch (error) { if (error.code !== 11000) throw error; return duplicate(); }
    res.json({ ok: true });
  }));

  router.post(PREFIX + "/worker/enrollment/poll", phoneAuth, jsonOnly, wrap(async (_req, res) => {
    const record = await Automation.findOneAndUpdate({ setupTarget: "phone", enabled: false,
      setupState: { $in: ["transferring", "phone-check"] }, sessionPacket: { $type: "string" },
      $or: [{ deliveryLeaseUntil: { $exists: false } }, { deliveryLeaseUntil: { $lte: new Date(now()) } }],
    }, { $set: { setupState: "phone-check", deliveryLease: randomUUID(), deliveryLeaseUntil: new Date(now() + SETUP_LEASE_MS) } },
    { sort: { credentialsSavedAt: 1 }, returnDocument: "after" }).select("+sessionPacket +sessionDigest +deliveryLease").lean();
    if (!record) return res.json({ job: null });
    const clear = decrypt(record.sessionPacket);
    const parsed = clear && parsePacket(JSON.parse(clear), record.account);
    if (!parsed || parsed.digest !== record.sessionDigest) throw new Error("Invalid stored packet");
    res.json({ job: { account: record.account, lease: record.deliveryLease, digest: parsed.digest, packet: parsed.packet } });
  }));

  router.post(PREFIX + "/worker/enrollment/update", phoneAuth, jsonOnly, wrap(async (req, res) => {
    const { account, lease, digest, ok } = req.body || {};
    if (typeof account !== "string" || !SETUP_SLOT.test(account) || typeof lease !== "string" ||
        typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || typeof ok !== "boolean")
      return res.status(400).json({ error: "Invalid enrollment status" });
    if (ok && await Automation.exists({ account, setupState: "ready", sessionDigest: digest, deliveryLease: lease }))
      return res.json({ ok: true });
    const changed = await Automation.updateOne({ account, setupState: "phone-check", enabled: false,
      deliveryLease: lease, sessionDigest: digest, deliveryLeaseUntil: { $gt: new Date(now()) } }, {
      $set: ok ? { setupState: "ready", enabled: true, nextScanAt: new Date(now()), sessionInstalledAt: new Date(now()) }
        : { setupState: "attention", setupReason: "phone-check-failed" },
      $unset: { deliveryLeaseUntil: 1, ...(ok && { sessionPacket: 1, setupReason: 1 }) },
      $push: { setupLog: log(ok ? "ready" : "attention", ok ? undefined : "phone-check-failed") },
    });
    if (!changed.matchedCount) return res.status(409).json({ error: "Enrollment lease unavailable" });
    res.json({ ok: true });
  }));
  return () => seenAt !== null && now() - seenAt < SETUP_LEASE_MS;
}

module.exports = { mountOnboarding, parseCredential };
