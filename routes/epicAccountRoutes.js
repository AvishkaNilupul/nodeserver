const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const epic = require("../utils/epicClient");
const epicClaimer = require("../utils/epicClaimer");
const { accountAccessToken } = require("../utils/epicAccountToken");
const epicAutoClaim = require("../utils/epicAutoClaim");
const settings = require("../utils/settings");
const { encrypt, decrypt } = require("../utils/secretBox");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const BuyerMailSession = require("../models/BuyerMailSession");
const outlookProxy = require("../utils/outlookGraphReader");

const router = express.Router();

// How long a buyer-mail session lives on the server. The design in
// project_epic_store_el9in_scan_1028 is ~5-7 days; we pick 7 and let the
// admin pass {days} to override per-order.
const DEFAULT_BUYER_SESSION_DAYS = 7;
const MAX_BUYER_SESSION_DAYS = 14;
const BUYER_PASSWORD_BYTES = 10; // → 16-char base64url, easy to paste

// Pick-and-say random password. base64url with "-" / "_" / "=" trimmed so a
// buyer can read it over chat without "is that a dash or underscore" games.
function mintBuyerPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function publicLoginUrl(req) {
  const envUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (envUrl) return envUrl + "/mail/";
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/mail/`;
}

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
      autoClaim: epicAutoClaim.getStatus(),
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
    let tok;
    try {
      tok = await epic.exchangeAuthCode(code);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message:
          "Epic rejected the code (they're single-use and expire in ~5 min " +
          "— grab a fresh one): " +
          err.message,
      });
    }
    const acc = await EpicAccount.findOneAndUpdate(
      { accountId: tok.account_id },
      {
        $set: {
          displayName: tok.displayName || "",
          refreshToken: encrypt(tok.refresh_token),
          refreshExpiresAt: tok.refresh_expires_at
            ? new Date(tok.refresh_expires_at)
            : null,
          status: "ok",
          lastError: "",
          ...(label ? { label } : {}),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    // Populate the library right away so the row isn't empty.
    epicClaimer.runOnce({ notify: false }).catch(() => {});
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
    // An account on a live instant-delivery listing is sold BY Eldorado; a
    // hand-made "sold" here would leave it on sale there too.
    if (upd.sold === true) {
      const listed = await require("../utils/epicSales").listingForAccount(req.params.id);
      if (listed) {
        return res.status(409).json({
          success: false,
          message:
            "This account is on sale in “" + listed.title + "”. Remove it from that listing first (Listings & sales tab).",
        });
      }
    }
    if (typeof req.body.label === "string") upd.label = req.body.label.trim();
    const acc = await EpicAccount.findByIdAndUpdate(
      req.params.id,
      { $set: upd },
      { returnDocument: "after" },
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
      const accessToken = await accountAccessToken(acc);
      const code = await epic.exchangeCode(accessToken);
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

// ---- Auto-claim controls -------------------------------------------------

// Read the current epicAutoClaim settings + a short recent-outcomes trail.
router.get(
  "/api/epic/auto-claim/settings",
  requireSuperadmin,
  (req, res) => {
    const cfg = settings.getEpicAutoClaim();
    res.json({
      success: true,
      settings: {
        enabled: !!cfg.enabled,
        captchaProvider: cfg.captchaProvider || "",
        captchaKeyConfigured: !!cfg.captchaKey,
        perAccountCooldownH: cfg.perAccountCooldownH,
        dailyCap: cfg.dailyCap,
      },
      status: epicAutoClaim.getStatus(),
    });
  },
);

// Update the epicAutoClaim block. captchaKey is encrypted at rest; pass "" to
// clear it, omit the field to leave the current key in place.
router.post(
  "/api/epic/auto-claim/settings",
  requireSuperadmin,
  async (req, res) => {
    try {
      const patch = {};
      const b = req.body || {};
      if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
      if (typeof b.captchaProvider === "string") {
        const p = b.captchaProvider.trim().toLowerCase();
        if (p && p !== "2captcha" && p !== "capsolver") {
          return res.status(400).json({
            success: false,
            message: "captchaProvider must be '2captcha' or 'capsolver'",
          });
        }
        patch.captchaProvider = p;
      }
      if (typeof b.captchaKey === "string") patch.captchaKey = b.captchaKey;
      if (b.perAccountCooldownH != null)
        patch.perAccountCooldownH = Number(b.perAccountCooldownH);
      if (b.dailyCap != null) patch.dailyCap = Number(b.dailyCap);
      const next = await settings.setEpicAutoClaim(patch, {
        actor: (req.session && req.session.username) || "admin",
      });
      res.json({
        success: true,
        settings: {
          enabled: !!next.enabled,
          captchaProvider: next.captchaProvider || "",
          captchaKeyConfigured: !!next.captchaKey,
          perAccountCooldownH: next.perAccountCooldownH,
          dailyCap: next.dailyCap,
        },
      });
    } catch (err) {
      res
        .status(500)
        .json({ success: false, message: err.message || "Save failed" });
    }
  },
);

// Manual one-off: try the direct-API auto-claim RIGHT NOW for one
// (account, offer). Bypasses the enabled flag — this is the operator-driven
// path from the Epic tab's "Auto-claim" button — but still respects the fact
// that a solver key is required if Talon shows up.
router.post(
  "/api/epic/accounts/:id/auto-claim",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acc = await EpicAccount.findById(req.params.id);
      if (!acc) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      const freebie = await EpicFreebie.findOne({
        offerId: String((req.body && req.body.offerId) || ""),
      }).lean();
      if (!freebie) {
        return res
          .status(404)
          .json({ success: false, message: "Unknown offer" });
      }
      const accessToken = await accountAccessToken(acc);
      const result = await epicAutoClaim.attemptAutoClaim(acc, freebie, accessToken, { manual: true });
      if (["claimed", "already_owned"].includes(result.status) && !result.tokenNeedsLogin) {
        try {
          const prices = new Map((await EpicFreebie.find({}).lean()).map(f => [
            f.namespace, parseFloat(String(f.originalPrice || "").replace(/[^0-9.]/g, "")) || 0,
          ]));
          await epicClaimer.syncLibrary(acc, await accountAccessToken(acc), prices);
          acc.lastCheckedAt = new Date();
          await acc.save();
        } catch { result.librarySyncPending = true; }
      }
      res.json({ success: true, result });
    } catch (err) {
      console.error("epic auto-claim error:", err.message);
      res.status(500).json({
        success: false,
        message: err.message || "Auto-claim failed",
      });
    }
  },
);

// Mint a BuyerMailSession for a given Epic account. The response carries the
// plaintext password EXACTLY ONCE (we only store the bcrypt hash), so the
// operator must copy it into the delivery message right away. See
// project_epic_store_el9in_scan_1028 for the design.
//
// Guards:
//   - EpicAccount must exist, carry an email+password, not be marked sold.
//   - The Mac Outlook proxy must know about the inbox (its ledger says it is
//     NOT shared with any other site). The proxy is the authoritative "safe
//     to hand to a buyer" check — see utils/outlookGraphReader.
//   - Any still-live BuyerMailSession for this inbox is revoked first
//     (reason=replaced), so a prior buyer loses access.
router.post(
  "/api/epic/accounts/:id/buyer-session",
  requireSuperadmin,
  async (req, res) => {
    try {
      const acct = await EpicAccount.findById(req.params.id);
      if (!acct) {
        return res.status(404).json({ success: false, message: "Account not found" });
      }
      if (acct.sold) {
        return res.status(400).json({ success: false, message: "Account is marked sold" });
      }
      const email = acct.email ? decrypt(acct.email) : "";
      if (!email) {
        return res
          .status(400)
          .json({ success: false, message: "Account has no stored email (not sellable)" });
      }
      const epicPassword = acct.password ? decrypt(acct.password) : "";
      if (!epicPassword) {
        return res
          .status(400)
          .json({ success: false, message: "Account has no stored password (not sellable)" });
      }
      const epicSales = require("../utils/epicSales");
      // On a live instant-delivery listing, Eldorado sells it: a hand-made
      // delivery here would sell the same account twice.
      const listed = await epicSales.listingForAccount(acct._id);
      if (listed) {
        return res.status(409).json({
          success: false,
          message: "This account is on sale in “" + listed.title + "”. Remove it from that listing first (Listings & sales tab).",
        });
      }
      // The Outlook refresh-token fleet lives on the owner's Mac, so prod
      // consults the reverse-tunnelled proxy for both "is this inbox known?"
      // and "is it safe to hand over?". The rule is the one the listings use
      // (utils/epicSales inboxVerdict): the account's own "epic" use never
      // counts, an inbox shared with SOOP is allowed while that switch is on
      // (the buyer only ever sees Epic's mail), anything else needs force.
      let check;
      try {
        check = await outlookProxy.checkInbox(email);
      } catch (err) {
        return res.status(502).json({
          success: false,
          message:
            err.code === "proxy_unconfigured"
              ? "Outlook mail proxy not configured on this server. Set OUTLOOK_PROXY_URL / OUTLOOK_PROXY_TOKEN."
              : "Mac mail proxy did not respond: " + (err.message || "error"),
        });
      }
      const verdict = epicSales.inboxVerdict(check, await epicSales.getConfig());
      if (!verdict.ok && !(req.body?.force && verdict.code === "shared")) {
        return res.status(400).json({
          success: false,
          message:
            verdict.text +
            (verdict.code === "shared" ? ". Tick “force” to hand it over anyway." : ""),
          sharedWith: verdict.shared || [],
        });
      }

      // Revoke any still-live sessions for the same inbox so only one buyer
      // can ever read it at a time.
      await BuyerMailSession.updateMany(
        {
          inboxAddress: email.toLowerCase(),
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        },
        { $set: { revokedAt: new Date(), revokedReason: "replaced" } },
      );

      const days = Math.min(
        MAX_BUYER_SESSION_DAYS,
        Math.max(1, Number(req.body?.days) || DEFAULT_BUYER_SESSION_DAYS),
      );
      const password = mintBuyerPassword();
      const passwordHash = await bcrypt.hash(password, 10);
      const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      const session = await BuyerMailSession.create({
        epicAccountId: acct._id,
        inboxAddress: email.toLowerCase(),
        passwordHash,
        expiresAt,
        marketplace: String(req.body?.marketplace || "").toLowerCase(),
        orderRef: String(req.body?.orderRef || ""),
        createdByUserId: String(req.user?.id || req.session?.user?.id || ""),
        note: String(req.body?.note || ""),
      });

      const loginUrl = publicLoginUrl(req);
      // Everything the buyer needs in one message: the Epic login itself, and
      // the mail page for the codes Epic sends while they take it over.
      const deliveryTemplate =
        `Thanks for your order! Here is your Epic Games account:\n\n` +
        `Epic login (email): ${email}\n` +
        `Epic password: ${epicPassword}\n\n` +
        `Epic emails (security codes, verification links):\n` +
        `Mail page: ${loginUrl}\n` +
        `Email login: ${email}\n` +
        `Email password: ${password}\n\n` +
        `The email password only opens the mail page — it is not the Epic ` +
        `password. The mail page shows the emails Epic sends to this account ` +
        `for ${days} days.\n\n` +
        `Please change the account email to your own right after you log in ` +
        `(epicgames.com > Account > Personal details). The mail page closes ` +
        `then, or after ${days} days.`;

      return res.json({
        success: true,
        session: {
          id: String(session._id),
          inboxAddress: session.inboxAddress,
          expiresAt: session.expiresAt,
          marketplace: session.marketplace,
          orderRef: session.orderRef,
        },
        buyerPassword: password, // ONLY TIME we return this
        loginUrl,
        deliveryTemplate,
      });
    } catch (err) {
      console.error("[epic/buyer-session] mint failed", err);
      return res
        .status(500)
        .json({ success: false, message: err.message || "Mint failed" });
    }
  },
);

// List sessions for one account — purely for the admin UI, so operator can
// see "did this buyer log in?" and "has anything already been revoked?".
router.get(
  "/api/epic/accounts/:id/buyer-sessions",
  requireSuperadmin,
  async (req, res) => {
    try {
      const rows = await BuyerMailSession.find({ epicAccountId: req.params.id })
        .sort({ createdAt: -1 })
        .limit(25)
        .lean();
      return res.json({
        success: true,
        sessions: rows.map((r) => ({
          id: String(r._id),
          inboxAddress: r.inboxAddress,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          revokedReason: r.revokedReason,
          marketplace: r.marketplace,
          orderRef: r.orderRef,
          firstViewAt: r.firstViewAt,
          lastViewAt: r.lastViewAt,
          viewCount: r.viewCount,
          note: r.note,
        })),
      });
    } catch (err) {
      return res
        .status(500)
        .json({ success: false, message: err.message || "List failed" });
    }
  },
);

// Revoke a specific session — operator uses this when a buyer reports a lost
// password, when email-change is detected manually, or when a refund kicks in.
router.post(
  "/api/epic/buyer-sessions/:sessionId/revoke",
  requireSuperadmin,
  async (req, res) => {
    try {
      const reason = String(req.body?.reason || "manual");
      const allowed = ["manual", "email_changed", "expired", "replaced"];
      const final = allowed.includes(reason) ? reason : "manual";
      const row = await BuyerMailSession.findByIdAndUpdate(
        req.params.sessionId,
        { $set: { revokedAt: new Date(), revokedReason: final } },
        { returnDocument: "after" },
      );
      if (!row) {
        return res.status(404).json({ success: false, message: "Session not found" });
      }
      return res.json({ success: true, revokedAt: row.revokedAt, revokedReason: row.revokedReason });
    } catch (err) {
      return res
        .status(500)
        .json({ success: false, message: err.message || "Revoke failed" });
    }
  },
);


router.use(require("./epicAccountDetailsRoutes"));
// Listings & sales tab (Eldorado instant-delivery listings, sale records).
router.use(require("./epicSalesRoutes"));

module.exports = router;
