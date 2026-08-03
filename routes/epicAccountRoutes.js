const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const EpicSignupSession = require("../models/EpicSignupSession");
const epic = require("../utils/epicClient");
const epicClaimer = require("../utils/epicClaimer");
const epicIdentity = require("../utils/epicIdentityFactory");
const epicMailbox = require("../utils/epicMailbox");
const { encrypt, decrypt } = require("../utils/secretBox");

const router = express.Router();

const SESSION_BEARER_BYTES = 32;
const OTP_LONG_POLL_MS = 4500; // fits inside the extension's 5s XHR window

function publicAccount(a, liveFreebies) {
  const owned = new Set(
    (a.library || []).map((g) => g.namespace).filter(Boolean),
  );
  const missing = (liveFreebies || []).filter((f) => !owned.has(f.namespace));
  return {
    _id: a._id,
    accountId: a.accountId,
    displayName: a.displayName,
    label: a.label,
    status: a.status,
    lastError: a.lastError,
    lastCheckedAt: a.lastCheckedAt,
    refreshExpiresAt: a.refreshExpiresAt,
    library: a.library || [],
    libraryCount: a.libraryCount,
    libraryValueUsd: a.libraryValueUsd,
    sold: a.sold,
    source: a.source || "manual",
    email: a.email ? decrypt(a.email) : "",
    hasCredentials: Boolean(a.password),
    missingLive: missing.map((f) => ({
      offerId: f.offerId,
      title: f.title,
      namespace: f.namespace,
      originalPrice: f.originalPrice,
      endDate: f.endDate,
    })),
    createdAt: a.createdAt,
  };
}

function publicSession(s) {
  return {
    _id: s._id,
    sessionId: s.sessionId,
    email: s.email,
    displayName: s.displayName,
    status: s.status,
    lastError: s.lastError,
    epicAccountId: s.epicAccountId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// Shared upsert used by both manual paste (POST /api/epic/accounts) and
// extension-driven signup (POST /api/epic/accounts/from-extension).
// `credentials` may include { email, password, totpSecret, source } — only
// the extension path passes these; manual paste leaves them empty.
async function upsertFromAuthCode(code, { label = "", credentials = {} } = {}) {
  const tok = await epic.exchangeAuthCode(code);
  const set = {
    displayName: tok.displayName || "",
    refreshToken: encrypt(tok.refresh_token),
    refreshExpiresAt: tok.refresh_expires_at
      ? new Date(tok.refresh_expires_at)
      : null,
    status: "ok",
    lastError: "",
  };
  if (label) set.label = label;
  if (credentials.source) set.source = credentials.source;
  if (credentials.email) set.email = encrypt(credentials.email);
  if (credentials.password) set.password = encrypt(credentials.password);
  if (credentials.totpSecret) set.totpSecret = encrypt(credentials.totpSecret);
  const acc = await EpicAccount.findOneAndUpdate(
    { accountId: tok.account_id },
    { $set: set },
    { upsert: true, new: true },
  );
  // Populate the library right away so the row isn't empty.
  epicClaimer.runOnce({ notify: false }).catch(() => {});
  return acc;
}

// Bearer-auth guard for extension-originated endpoints. Bearer is per
// session; the extension gets it once from POST /signup/start and carries
// it on every follow-up. bcrypt-compare against the stored hash so a
// leaked DB dump doesn't hand attackers session takeover.
async function requireSessionBearer(req, res, next) {
  try {
    const sessionId =
      String(req.params.sessionId || req.body.sessionId || "").trim();
    const authHeader = String(req.get("Authorization") || "");
    const bearer = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (!sessionId || !bearer) {
      return res
        .status(401)
        .json({ success: false, message: "Missing session or bearer" });
    }
    const session = await EpicSignupSession.findOne({ sessionId });
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Unknown session" });
    }
    const ok = await bcrypt.compare(bearer, session.bearerHash);
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, message: "Bad bearer" });
    }
    req.epicSession = session;
    next();
  } catch (err) {
    console.error("epic bearer auth error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

// Accounts + per-account live-claim gaps + claimer status.
router.get("/api/epic/accounts", requireSuperadmin, async (req, res) => {
  try {
    const [accounts, liveFreebies] = await Promise.all([
      EpicAccount.find({}).sort({ createdAt: 1 }).lean(),
      EpicFreebie.find({ active: true, upcoming: false }).lean(),
    ]);
    res.json({
      success: true,
      accounts: accounts.map((a) => publicAccount(a, liveFreebies)),
      redirectUrl: epic.REDIRECT_URL,
      status: epicClaimer.status(),
    });
  } catch (err) {
    console.error("epic accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Add (or re-login) an account from a one-time authorization code.
router.post("/api/epic/accounts", requireSuperadmin, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const label = String(req.body.label || "").trim();
    if (!/^[0-9a-f]{32}$/i.test(code)) {
      return res.status(400).json({
        success: false,
        message: "That doesn't look like an authorization code (32 hex chars)",
      });
    }
    let acc;
    try {
      acc = await upsertFromAuthCode(code, { label });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message:
          "Epic rejected the code (they're single-use and expire in ~5 min " +
          "— grab a fresh one): " +
          err.message,
      });
    }
    res.json({ success: true, account: publicAccount(acc, []) });
  } catch (err) {
    console.error("epic account add error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Toggle sold / edit label.
router.patch("/api/epic/accounts/:id", requireSuperadmin, async (req, res) => {
  try {
    const upd = {};
    if (typeof req.body.sold === "boolean") upd.sold = req.body.sold;
    if (typeof req.body.label === "string") upd.label = req.body.label.trim();
    const acc = await EpicAccount.findByIdAndUpdate(
      req.params.id,
      { $set: upd },
      { new: true },
    );
    if (!acc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.json({ success: true, account: publicAccount(acc, []) });
  } catch (err) {
    console.error("epic account update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/api/epic/accounts/:id", requireSuperadmin, async (req, res) => {
  try {
    await EpicAccount.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("epic account delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Sync all accounts now (library refresh + claim pings).
router.post("/api/epic/accounts/sync", requireSuperadmin, async (req, res) => {
  try {
    const counts = await epicClaimer.runOnce();
    res.json({ success: true, counts, status: epicClaimer.status() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || "Sync failed" });
  }
});

// Reveal saved credentials for a generator-created account (for handoff to
// a buyer). Returns "" for fields the account doesn't have.
router.get(
  "/api/epic/accounts/:id/credentials",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await EpicAccount.findById(req.params.id);
      if (!acc) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      res.json({
        success: true,
        email: acc.email ? decrypt(acc.email) : "",
        password: acc.password ? decrypt(acc.password) : "",
        totpSecret: acc.totpSecret ? decrypt(acc.totpSecret) : "",
      });
    } catch (err) {
      console.error("epic credentials reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Fresh one-tap claim link for a specific account + offer (used by the tab's
// "Claim" buttons; the link logs the browser into that account).
router.post(
  "/api/epic/accounts/:id/claim-link",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await EpicAccount.findById(req.params.id);
      if (!acc) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      const freebie = await EpicFreebie.findOne({
        offerId: String(req.body.offerId || ""),
      }).lean();
      if (!freebie) {
        return res
          .status(404)
          .json({ success: false, message: "Unknown offer" });
      }
      const tok = await epic.refresh(decrypt(acc.refreshToken));
      acc.refreshToken = encrypt(tok.refresh_token);
      acc.refreshExpiresAt = tok.refresh_expires_at
        ? new Date(tok.refresh_expires_at)
        : null;
      acc.status = "ok";
      await acc.save();
      const code = await epic.exchangeCode(tok.access_token);
      res.json({
        success: true,
        url: epic.claimLink(code, freebie.namespace, freebie.offerId),
        expiresInSeconds: 299,
      });
    } catch (err) {
      console.error("epic claim link error:", err.message);
      res.status(500).json({
        success: false,
        message: err.message || "Could not create claim link",
      });
    }
  },
);

// ------- Extension-driven signup pipeline -------

// Start a new signup: server generates identity, provisions a mail.tm
// mailbox, mints a bearer for the extension, persists the session.
router.post(
  "/api/epic/signup/start",
  requireSuperadmin,
  async (req, res) => {
    let mailbox = null;
    try {
      const identity = epicIdentity.build();
      mailbox = await epicMailbox.allocate();
      const bearer = crypto
        .randomBytes(SESSION_BEARER_BYTES)
        .toString("base64url");
      const bearerHash = await bcrypt.hash(bearer, 10);
      const session = await EpicSignupSession.create({
        sessionId: crypto.randomUUID(),
        bearerHash,
        firstName: identity.firstName,
        lastName: identity.lastName,
        displayName: identity.displayName,
        dateOfBirth: identity.dateOfBirth,
        country: identity.country,
        email: mailbox.address,
        password: identity.password,
        provider: mailbox.provider,
        providerMeta: mailbox.providerMeta,
        status: "identity_ready",
      });
      res.json({
        success: true,
        session: {
          sessionId: session.sessionId,
          bearer,
          identity: {
            firstName: identity.firstName,
            lastName: identity.lastName,
            displayName: identity.displayName,
            dateOfBirth: identity.dateOfBirth,
            country: identity.country,
            email: mailbox.address,
            password: identity.password,
          },
          redirectUrl: epic.REDIRECT_URL,
        },
      });
    } catch (err) {
      console.error("epic signup start error:", err.message);
      if (mailbox) {
        epicMailbox.release(mailbox).catch(() => {});
      }
      res.status(500).json({
        success: false,
        message: err.message || "Could not start signup",
      });
    }
  },
);

// Update session status from the extension (e.g. wizard_open,
// awaiting_captcha, awaiting_otp, sms_required, throttled, failed).
router.post(
  "/api/epic/signup/:sessionId/status",
  requireSessionBearer,
  async (req, res) => {
    try {
      const s = req.epicSession;
      const status = String(req.body.status || "").trim();
      if (status) s.status = status;
      if (typeof req.body.lastError === "string") {
        s.lastError = req.body.lastError.slice(0, 500);
      }
      await s.save();
      res.json({ success: true });
    } catch (err) {
      console.error("epic signup status error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Long-poll for the signup OTP. Extension calls this repeatedly with the
// session bearer; we poll mail.tm for up to OTP_LONG_POLL_MS and return
// { code } on success or { status: "waiting" } to prompt another call.
router.get(
  "/api/epic/signup/:sessionId/otp",
  requireSessionBearer,
  async (req, res) => {
    try {
      const s = req.epicSession;
      if (s.otpCode) {
        return res.json({
          success: true,
          code: s.otpCode,
          receivedAt: s.otpReceivedAt,
        });
      }
      const hit = await epicMailbox.waitForOtp(s, {
        timeoutMs: OTP_LONG_POLL_MS,
      });
      if (!hit) {
        return res.json({ success: true, status: "waiting" });
      }
      s.otpCode = hit.code;
      s.otpReceivedAt = new Date(hit.receivedAt);
      s.status = "otp_delivered";
      await s.save();
      res.json({ success: true, code: hit.code, receivedAt: hit.receivedAt });
    } catch (err) {
      console.error("epic signup otp error:", err.message);
      res.status(500).json({
        success: false,
        message: err.message || "OTP fetch failed",
      });
    }
  },
);

// Finalise the signup: extension has scraped a 32-hex authorizationCode
// from Epic's /id/api/redirect endpoint. We exchange it for a refresh
// token and upsert an EpicAccount row with the credentials so the account
// is a whole handoff-able package.
router.post(
  "/api/epic/accounts/from-extension",
  requireSessionBearer,
  async (req, res) => {
    const s = req.epicSession;
    try {
      const code = String(req.body.authorizationCode || "").trim();
      if (!/^[0-9a-f]{32}$/i.test(code)) {
        return res.status(400).json({
          success: false,
          message: "authorizationCode must be 32 hex chars",
        });
      }
      const totpSecret = String(req.body.totpSecret || "").trim();
      const label = String(
        req.body.label || `gen-${new Date().toISOString().slice(0, 10)}`,
      ).trim();
      const acc = await upsertFromAuthCode(code, {
        label,
        credentials: {
          source: "generated",
          email: s.email,
          password: s.password,
          totpSecret,
        },
      });
      if (totpSecret) s.totpSecret = totpSecret;
      s.status = "verified";
      s.epicAccountId = String(acc._id);
      s.lastError = "";
      await s.save();
      // Free the mailbox — we no longer need to receive mail on it.
      epicMailbox.release(s).catch(() => {});
      res.json({
        success: true,
        account: publicAccount(acc, []),
      });
    } catch (err) {
      console.error("epic from-extension error:", err.message);
      s.status = "failed";
      s.lastError = String(err.message || "").slice(0, 500);
      await s.save().catch(() => {});
      res.status(500).json({
        success: false,
        message: err.message || "Finalisation failed",
      });
    }
  },
);

// Recent signup sessions for the admin UI's live progress + audit list.
router.get(
  "/api/epic/signup/recent",
  requireSuperadmin,
  async (req, res) => {
    try {
      const limit = Math.max(
        1,
        Math.min(100, parseInt(req.query.limit, 10) || 25),
      );
      const sessions = await EpicSignupSession.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      res.json({
        success: true,
        sessions: sessions.map(publicSession),
      });
    } catch (err) {
      console.error("epic signup recent error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
