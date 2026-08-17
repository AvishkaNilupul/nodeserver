const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const TwitchCampaign = require("../models/TwitchCampaign");
const EpicFreebie = require("../models/EpicFreebie");
const AutoFarmTask = require("../models/AutoFarmTask");
const DropLog = require("../models/DropLog");
const campaignWatcher = require("../utils/campaignWatcher");
const epicWatcher = require("../utils/epicWatcher");
const { buildRadarEvents } = require("../utils/radarEvents");

const router = express.Router();

// Twitch campaigns + Epic giveaways for the Radar tab.
router.get("/api/radar/list", requireSuperadmin, async (req, res) => {
  try {
    const showEnded = String(req.query.ended || "") === "1";
    const [campaigns, epic] = await Promise.all([
      TwitchCampaign.find(showEnded ? {} : { active: true })
        .sort({ active: -1, status: 1, endAt: 1 })
        .limit(500)
        .lean(),
      EpicFreebie.find(showEnded ? {} : { active: true })
        .sort({ active: -1, upcoming: 1, endDate: 1 })
        .limit(200)
        .lean(),
    ]);
    const campaignIds = campaigns.map((campaign) => campaign.campaignId);
    const campaignNames = [
      ...new Set(campaigns.map((campaign) => campaign.name).filter(Boolean)),
    ];
    const [tasks, dropStats] = await Promise.all([
      campaignIds.length
        ? AutoFarmTask.find(
            { campaignId: { $in: campaignIds } },
            {
              campaignId: 1,
              status: 1,
              decision: 1,
              reason: 1,
              assignedAccounts: 1,
              bots: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          ).lean()
        : [],
      campaignNames.length
        ? DropLog.aggregate([
            { $match: { campaign: { $in: campaignNames } } },
            {
              $group: {
                _id: { campaign: "$campaign", game: "$game" },
                dropRows: { $sum: 1 },
                totalCount: { $sum: { $ifNull: ["$count", 1] } },
                accounts: { $addToSet: "$account" },
                items: { $addToSet: "$itemKey" },
              },
            },
            {
              $project: {
                _id: 0,
                campaign: "$_id.campaign",
                game: "$_id.game",
                dropRows: 1,
                totalCount: 1,
                accounts: 1,
                items: 1,
              },
            },
          ])
        : [],
    ]);
    res.json({
      success: true,
      campaigns,
      events: buildRadarEvents(campaigns, tasks, dropStats),
      epic,
      status: {
        twitch: campaignWatcher.status(),
        epic: epicWatcher.status(),
      },
    });
  } catch (err) {
    console.error("radar list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Manual "check now" — runs both watchers; either failing is reported but
// doesn't hide the other's result.
router.post("/api/radar/check", requireSuperadmin, async (req, res) => {
  const out = { success: true, twitch: null, epic: null, errors: [] };
  try {
    out.twitch = await campaignWatcher.runOnce();
  } catch (err) {
    out.errors.push("Twitch: " + (err.message || "check failed"));
  }
  try {
    out.epic = await epicWatcher.runOnce();
  } catch (err) {
    out.errors.push("Epic: " + (err.message || "check failed"));
  }
  out.status = { twitch: campaignWatcher.status(), epic: epicWatcher.status() };
  res.json(out);
});

module.exports = router;
