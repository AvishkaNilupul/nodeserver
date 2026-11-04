const express = require("express");
const mongoose = require("mongoose");
const path = require("node:path");
const fs = require("node:fs/promises");
const { requireSuperadmin } = require("../middleware/auth");
const logic = require("../utils/rivalsAccounts");
const proofRoot = () =>
  process.env.RIVALS_PROOF_DIR || path.join(__dirname, "../.rivals-proof");
function createRouter({
  getDb = () => mongoose.connection.db,
  eld = () => require("../utils/eldoradoAccountOffers"),
} = {}) {
  const router = express.Router();
  router.use("/api/rivals", requireSuperadmin, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      try {
        if (
          req.get("origin") &&
          new URL(req.get("origin")).host !== req.get("host")
        )
          return res.sendStatus(403);
      } catch {
        return res.sendStatus(403);
      }
      if (req.get("sec-fetch-site") === "cross-site")
        return res.sendStatus(403);
    }
    next();
  });
  router.get("/api/rivals/preparations", async (_req, res) => {
    try {
      const db = getDb();
      const [preps, permission] = await Promise.all([
        db
          .collection("rivalspreparations")
          .find(
            {},
            {
              projection: {
                _id: 1,
                status: 1,
                steamId: 1,
                twitchId: 1,
                twitchLogin: 1,
                expectedRewards: 1,
                gameReport: 1,
                draftPriceUsd: 1,
                listingId: 1,
                publishState: 1,
                deliveryAudit: 1,
                presentation: 1,
                rewardAudit: 1,
              },
            },
          )
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray(),
        db.collection("rivalssalesstates").findOne({ _id: "eldorado" }),
      ]);
      const ids = preps.map((p) => p.steamId);
      const steam = await db
        .collection("steamaccounts")
        .find(
          { _id: { $in: ids } },
          {
            projection: {
              _id: 1,
              stage: 1,
              notes: 1,
              soldAt: 1,
              storeCountry: 1,
              signupCountry: 1,
            },
          },
        )
        .toArray();
      const map = new Map(steam.map((s) => [String(s._id), s]));
      const listingIds = preps.map((p) => p.listingId).filter(Boolean);
      const listings = listingIds.length
        ? await db
            .collection("steamlistings")
            .find(
              { _id: { $in: listingIds } },
              { projection: { _id: 1, url: 1, status: 1, priceUsd: 1 } },
            )
            .toArray()
        : [];
      const listingMap = new Map(listings.map((l) => [String(l._id), l]));
      const accounts = preps.map((p) =>
        logic.publicRow(
          p,
          map.get(String(p.steamId)),
          permission,
          listingMap.get(String(p.listingId)),
        ),
      );
      res.json({
        success: true,
        accounts,
        permission: permission || { canSell: null },
        summary: {
          total: accounts.length,
          verified: accounts.filter(
            (a) => a.verifiedCount === a.expectedCount && a.expectedCount > 0,
          ).length,
        },
        publishEnabled: true,
      });
    } catch {
      res
        .status(500)
        .json({ success: false, message: "Could not load Rivals accounts" });
    }
  });
  router.get("/api/rivals/preparations/:id/proof/:file", async (req, res) => {
    if (
      !logic.validId(req.params.id) ||
      !/^[a-z0-9-]+\.png$/.test(req.params.file)
    )
      return res.sendStatus(400);
    try {
      const p = await getDb()
        .collection("rivalspreparations")
        .findOne(
          { _id: req.params.id },
          { projection: { gameReport: 1, presentation: 1 } },
        );
      const proof = [
        ...(p?.gameReport?.proofs || []),
        ...(p?.presentation?.images || []),
      ].find((x) => x.file === req.params.file);
      if (!proof) return res.sendStatus(404);
      const bytes = await fs.readFile(
        path.join(proofRoot(), req.params.id, proof.file),
      );
      if (logic.digest(bytes) !== proof.sha256)
        return res
          .status(409)
          .json({ success: false, message: "Evidence file changed" });
      res.type("png").send(bytes);
    } catch {
      res.sendStatus(404);
    }
  });
  router.patch("/api/rivals/preparations/:id/draft", async (req, res) => {
    const price = req.body?.priceUsd;
    if (
      !logic.validId(req.params.id) ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0.05 ||
      price > 10000 ||
      Math.abs(price * 100 - Math.round(price * 100)) > 1e-7
    )
      return res
        .status(400)
        .json({ success: false, message: "Enter a USD price in cents" });
    try {
      const r = await getDb()
        .collection("rivalspreparations")
        .updateOne(
          {
            _id: req.params.id,
            status: "held",
            $or: [
              { "gameReport.state": "ready", "gameReport.phase": "logged-out" },
              {
                "gameReport.state": "verified",
                "gameReport.phase": "verified",
                "gameReport.sessionRetention.mode": "owner-retained",
              },
            ],
            listingId: { $exists: false },
          },
          { $set: { draftPriceUsd: price } },
        );
      if (!r.matchedCount)
        return res.status(409).json({
          success: false,
          message:
            "Only verified, unlisted held accounts can change draft price",
        });
      res.json({ success: true });
    } catch {
      res
        .status(500)
        .json({ success: false, message: "Could not save draft price" });
    }
  });
  let checking = false;
  async function refreshSellerAccess({ onlyMissing = false } = {}) {
    if (checking) return null;
    if (onlyMissing) {
      const db = getDb();
      const [prep, saved] = await Promise.all([
        db
          .collection("rivalspreparations")
          .findOne(
            {
              status: "held",
              "gameReport.state": { $in: ["ready", "verified"] },
            },
            { projection: { _id: 1 } },
          ),
        db
          .collection("rivalssalesstates")
          .findOne({ _id: "eldorado" }, { projection: { checkedAt: 1 } }),
      ]);
      if (!prep || saved?.checkedAt) return null;
    }
    checking = true;
    try {
      const p = await eld().epicPermission("227");
      const permission = {
        canSell: p.error ? null : p.canSell,
        restricted: p.epicIsHighRisk,
        allowHighRiskOffers: p.allowHighRiskOffers,
        checkedAt: new Date(),
        error: p.error ? "Eldorado access check incomplete" : "",
      };
      await getDb()
        .collection("rivalssalesstates")
        .updateOne({ _id: "eldorado" }, { $set: permission }, { upsert: true });
      return permission;
    } finally {
      checking = false;
    }
  }
  router.refreshSellerAccess = refreshSellerAccess;
  router.post("/api/rivals/eldorado/check", async (_req, res) => {
    try {
      const permission = await refreshSellerAccess();
      if (!permission) return res.sendStatus(409);
      res.json({ success: true, permission });
    } catch {
      res
        .status(502)
        .json({ success: false, message: "Could not check Eldorado access" });
    }
  });
  for (const [action, fn] of [
    ["delivery/check", "checkDelivery"],
    ["publish", "publish"],
    ["update-listing", "updatePresentation"],
  ]) {
    router.post("/api/rivals/preparations/:id/" + action, async (req, res) => {
      try {
        const sales = require("../utils/rivalsSales");
        const result = await sales[fn](
          req.params.id,
          String(req.session.admin.username || req.session.admin.id || "admin"),
        );
        res.json({ success: true, result });
      } catch (e) {
        res.status(e.user ? e.status || 409 : 502).json({
          success: false,
          message: e.user
            ? e.message
            : "Rivals operation failed; account remains reserved for review",
        });
      }
    });
  }
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
