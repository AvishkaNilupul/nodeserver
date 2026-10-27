const express = require("express");
const axios = require("axios");
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
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const SESSION_BEARER_BYTES = 32;


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
  // Guard against capturing an account already signed into this browser.
  // Never attach generated credentials unless Epic confirms the same inbox.
  const { data: profile } = await axios.get(
    "https://account-public-service-prod.ol.epicgames.com/account/api/public/account/" + encodeURIComponent(tok.account_id),
    { headers: { Authorization: "bearer " + tok.access_token }, timeout: 10000 },
  );
  if (!profile.email || profile.email.toLowerCase() !== credentials.email.toLowerCase()) {
    throw new Error("Epic is signed into a different account. Sign out in Chrome and start again.");
  }
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
    { $set: set, $setOnInsert: { accountDetails: encrypt(JSON.stringify({ ...credentials.profile, country: profile.country || credentials.profile?.country || "", notes: "Created with the local Outlook signup extension." })), detailsUpdatedAt: new Date() } },
    { upsert: true, returnDocument: "after" },
  );
  // The normal scheduled library sync picks up the new account.
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
    if (!session || session.expiresAt <= new Date()) {
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

// ------- Extension-driven signup pipeline -------

router.get('/api/epic/signup/health', requireSuperadmin, (req,res) => {
  if (require('mongoose').connection.readyState !== 1) return res.status(503).json({success:false,message:'Signup database is unavailable'});
  res.json({success:true,provider:'outlook-local',extensionVersion:'1.3.0'});
});

// Start with the Outlook inbox reserved locally by the extension.
router.post(
  "/api/epic/signup/start",
  requireSuperadmin,
  async (req, res) => {
    let mailbox = null;
    try {
      const identity = epicIdentity.build();
      mailbox = await epicMailbox.allocate(req.body.mailbox);
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
        password: encrypt(identity.password),
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

// Resume an interrupted attempt without allocating a second inbox. A fresh
// bearer invalidates the abandoned extension instance; credentials stay intact.
router.post("/api/epic/signup/:sessionId/resume", requireSuperadmin, async (req, res) => {
  try {
    const s = await EpicSignupSession.findOne({ sessionId: req.params.sessionId });
    if (!s || s.expiresAt <= new Date()) return res.status(404).json({ success: false, message: "Signup expired or not found" });
    if (s.status === "verified" || s.epicAccountId) return res.status(409).json({ success: false, message: "This account is already saved" });
    const bearer = crypto.randomBytes(SESSION_BEARER_BYTES).toString("base64url");
    s.bearerHash = await bcrypt.hash(bearer, 10);
    s.status = "identity_ready";
    s.lastError = "";
    s.otpCode = "";
    s.otpReceivedAt = null;
    s.providerMeta = { ...s.providerMeta, reservedAt: new Date().toISOString() };
    await s.save();
    res.json({ success: true, session: { sessionId: s.sessionId, bearer,
      identity: { firstName: s.firstName, lastName: s.lastName, displayName: s.displayName,
        dateOfBirth: s.dateOfBirth, country: s.country, email: s.email, password: decrypt(s.password) },
      redirectUrl: epic.REDIRECT_URL,
      mailbox: { address: s.email, provider: "outlook-local", reservedAt: s.providerMeta.reservedAt },
      login: req.body.mode === "login",
    } });
  } catch { res.status(500).json({ success: false, message: "Could not resume signup" }); }
});

// Update session status from the extension (e.g. wizard_open,
// awaiting_captcha, awaiting_otp, sms_required, throttled, failed).
router.post(
  "/api/epic/signup/:sessionId/status",
  requireSessionBearer,
  async (req, res) => {
    try {
      const s = req.epicSession;
      const status = String(req.body.status || "").trim();
      const allowed = ["wizard_open", "awaiting_captcha", "awaiting_otp", "awaiting_eula", "sms_required", "throttled", "failed"];
      if (!allowed.includes(status) || s.status === "verified") {
        return res.status(400).json({ success: false, message: "Invalid session transition" });
      }
      s.status = status;
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
      if (s.status === "verified") return res.json({ success: true, account: { _id: s.epicAccountId } });
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
          password: decrypt(s.password),
          totpSecret,
          profile: {firstName:s.firstName,lastName:s.lastName,dateOfBirth:s.dateOfBirth,country:s.country},
        },
      });
      if (totpSecret) s.totpSecret = totpSecret;
      s.status = "verified";
      s.epicAccountId = String(acc._id);
      s.lastError = "";
      await s.save();
      // Free the mailbox — we no longer need to receive mail on it.
      // Outlook remains available for account recovery; extension finalizes pool usage.
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

router.get("/api/epic/accounts/:id/credentials", requireSuperadmin, async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid account ID" });
    const account = await EpicAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, email: decrypt(account.email), password: decrypt(account.password), totpSecret: decrypt(account.totpSecret) });
  } catch { res.status(500).json({ success: false, message: "Could not read credentials" }); }
});
module.exports = router;
