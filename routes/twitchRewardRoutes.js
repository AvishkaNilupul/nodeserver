const express = require("express");
const path = require("node:path");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const {
  getRewardCatalog,
  getGiveaway,
} = require("../utils/twitchRewardCampaigns");
const TwitchRewardReceipt = require("../models/TwitchRewardReceipt");

const router = express.Router();
const guards = [requireSuperadmin, enforce2fa];

router.get("/twitch-rewards.html", guards, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.sendFile("twitch-rewards.html", {
    root: path.join(__dirname, "../admin-pages"),
    cacheControl: false,
  });
});

router.use("/api/twitch-rewards", guards, (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

router.use("/api/twitch-rewards", require("./twitchRewardFarmRoutes"));

router.get("/api/twitch-rewards/campaigns", async (req, res) => {
  try {
    res.json(await getRewardCatalog());
  } catch {
    res.status(503).json({
      message: "The reward campaign feed is temporarily unavailable.",
      giveaway: getGiveaway(),
    });
  }
});

router.use(
  ["/api/twitch-rewards/viewers", "/api/twitch-rewards/accounts"],
  (req, res, next) => {
    if (!req.session.admin.id)
      return res
        .status(401)
        .json({ message: "Sign in again to manage confirmations." });
    next();
  },
);

router.use("/api/twitch-rewards/viewers/:viewer", (req, res, next) => {
  const viewer = req.params.viewer.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(viewer)) {
    return res.status(400).json({ message: "Enter a Twitch username." });
  }
  req.rewardViewer = viewer;
  next();
});

router.use("/api/twitch-rewards", require("./twitchRewardAccountRoutes"));

router.get("/api/twitch-rewards/viewers/:viewer/receipts", async (req, res) => {
  const rows = await TwitchRewardReceipt.find(
    { adminId: req.session.admin.id, viewer: req.rewardViewer },
    {
      _id: 0,
      campaignId: 1,
      campaignName: 1,
      reward: 1,
      recordedAt: 1,
      codeSavedAt: 1,
      codeVersion: 1,
      codeRedeemedAt: 1,
      platform: 1,
      region: 1,
    },
  )
    .sort({ recordedAt: -1 })
    .lean();
  res.json({ viewer: req.rewardViewer, receipts: rows });
});

router.put("/api/twitch-rewards/viewers/:viewer/receipts", async (req, res) => {
  const { campaignId, reward, confirmed } = req.body || {};
  if (
    typeof campaignId !== "string" ||
    campaignId.length > 140 ||
    !campaignId ||
    typeof reward !== "string" ||
    reward.length > 300 ||
    !reward ||
    typeof confirmed !== "boolean"
  ) {
    return res
      .status(400)
      .json({ message: "Choose a reward from the campaign." });
  }
  const key = {
    adminId: req.session.admin.id,
    viewer: req.rewardViewer,
    campaignId,
    reward,
  };
  if (confirmed) {
    const giveaway = getGiveaway();
    const isGiveaway =
      giveaway && campaignId === giveaway.id && reward === giveaway.name;
    let campaignName = "GTA VI Ultimate Edition giveaway";
    if (!isGiveaway) {
      let catalog;
      try {
        catalog = await getRewardCatalog();
      } catch {
        return res
          .status(503)
          .json({ message: "The reward catalog is temporarily unavailable." });
      }
      const campaign = catalog.campaigns.find(
        (item) => item.id === campaignId && item.status === "Live",
      );
      if (!campaign?.groups.some((group) => group.rewards.includes(reward))) {
        return res.status(400).json({
          message: "This item is outside the current reward catalog.",
        });
      }
      campaignName = campaign.name;
    }
    try {
      await TwitchRewardReceipt.updateOne(
        key,
        { $setOnInsert: { ...key, campaignName } },
        { upsert: true },
      );
    } catch (err) {
      // Concurrent confirmations of the same item converge on its unique row.
      if (err.code !== 11000 || !(await TwitchRewardReceipt.exists(key)))
        throw err;
    }
  } else {
    const removed = await TwitchRewardReceipt.deleteOne({
      ...key,
      codeSavedAt: { $exists: false },
    });
    if (
      !removed.deletedCount &&
      (await TwitchRewardReceipt.exists({
        ...key,
        codeSavedAt: { $exists: true },
      }))
    )
      return res
        .status(409)
        .json({
          message:
            "Remove the saved code in Accounts & codes before undoing this confirmation.",
        });
  }
  res.json({ viewer: req.rewardViewer, campaignId, reward, confirmed });
});

module.exports = router;
