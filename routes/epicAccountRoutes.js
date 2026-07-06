const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const epic = require("../utils/epicClient");
const epicClaimer = require("../utils/epicClaimer");
const { encrypt, decrypt } = require("../utils/secretBox");

const router = express.Router();

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
      { upsert: true, new: true },
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

module.exports = router;
