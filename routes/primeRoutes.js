const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const PrimeOffer = require("../models/PrimeOffer");
const PrimeKey = require("../models/PrimeKey");
const primeWatcher = require("../utils/primeWatcher");
const { encrypt, decrypt } = require("../utils/secretBox");

const router = express.Router();

function publicKey(k) {
  return {
    id: k._id,
    offerId: k.offerId,
    title: k.title,
    image: k.image,
    platform: k.platform,
    claimedAt: k.claimedAt,
    claimedFrom: k.claimedFrom,
    status: k.status,
    soldAt: k.soldAt,
    soldToUsername: k.soldToUsername,
    soldPrice: k.soldPrice,
    note: k.note,
    hasCode: !!k.code,
  };
}

// Current catalog + watcher status for the Prime Gaming tab.
router.get("/api/prime/offers", requireSuperadmin, async (req, res) => {
  try {
    const showEnded = String(req.query.ended || "") === "1";
    const offers = await PrimeOffer.find(showEnded ? {} : { active: true })
      .sort({ active: -1, endTime: 1, title: 1 })
      .limit(500)
      .lean();
    res.json({ success: true, offers, status: primeWatcher.status() });
  } catch (err) {
    console.error("prime offers error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Manual "check now" from the tab.
router.post("/api/prime/check", requireSuperadmin, async (req, res) => {
  try {
    const counts = await primeWatcher.runOnce();
    res.json({ success: true, counts, status: primeWatcher.status() });
  } catch (err) {
    res
      .status(502)
      .json({ success: false, message: err.message || "Check failed" });
  }
});

// ------------------------------------------------------------------
// Key vault — manually-claimed Prime Gaming codes (mostly GOG), kept for
// resale. Title/image/platform are denormalized at add-time from PrimeOffer
// (or typed by hand) so the vault survives an offer expiring/aging out.
// ------------------------------------------------------------------
router.get("/api/prime/keys", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    const status = String(req.query.status || "").trim();
    if (["unused", "listed", "sold"].includes(status)) q.status = status;
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ title: re }, { claimedFrom: re }, { note: re }];
    }
    const keys = await PrimeKey.find(q)
      .sort({ claimedAt: -1 })
      .limit(1000)
      .lean();
    res.json({ success: true, keys: keys.map(publicKey) });
  } catch (err) {
    console.error("prime keys list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/api/prime/keys", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.code || "").trim();
    if (!code) {
      return res
        .status(400)
        .json({ success: false, message: "Code is required" });
    }

    let title = String(body.title || "").trim();
    let image = "";
    let platform = String(body.platform || "gog").trim() || "gog";
    let offerId = "";
    if (body.offerId) {
      const offer = await PrimeOffer.findOne({
        itemId: String(body.offerId),
      }).lean();
      if (offer) {
        offerId = offer.itemId;
        title = title || offer.title;
        image = offer.image || "";
        platform = offer.platform || platform;
      }
    }
    if (!title) {
      return res
        .status(400)
        .json({ success: false, message: "Pick a game or enter a title" });
    }

    const key = await PrimeKey.create({
      offerId,
      title,
      image,
      platform,
      code: encrypt(code),
      claimedFrom: String(body.claimedFrom || "").trim(),
      note: String(body.note || "").trim(),
    });
    res.json({ success: true, key: publicKey(key) });
  } catch (err) {
    console.error("prime key add error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/api/prime/keys/:id/reveal",
  requireSuperadmin,
  async (req, res) => {
    try {
      const key = await PrimeKey.findById(req.params.id).lean();
      if (!key) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      res.json({ success: true, code: decrypt(key.code) });
    } catch (err) {
      console.error("prime key reveal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put("/api/prime/keys/:id", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if (body.status !== undefined) {
      if (!["unused", "listed", "sold"].includes(body.status)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      }
      update.status = body.status;
      if (body.status === "sold") {
        update.soldAt = new Date();
        update.soldToUsername = String(body.soldToUsername || "").trim();
        update.soldPrice = Number(body.soldPrice) || 0;
      } else {
        update.soldAt = null;
        update.soldToUsername = "";
        update.soldPrice = 0;
      }
    }
    if (body.note !== undefined) update.note = String(body.note).trim();
    if (body.claimedFrom !== undefined) {
      update.claimedFrom = String(body.claimedFrom).trim();
    }
    const key = await PrimeKey.findByIdAndUpdate(req.params.id, update, {
      new: true,
    }).lean();
    if (!key) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.json({ success: true, key: publicKey(key) });
  } catch (err) {
    console.error("prime key update error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/api/prime/keys/:id", requireSuperadmin, async (req, res) => {
  try {
    const r = await PrimeKey.findByIdAndDelete(req.params.id);
    if (!r) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("prime key delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
