const express = require("express");
const { createHmac, randomUUID } = require("node:crypto");
const Account = require("../models/TwitchRewardAccount");
const Receipt = require("../models/TwitchRewardReceipt");
const { GTA_ID, GTA_GIVEAWAY } = require("../utils/twitchRewardCampaigns");
const { encrypt, decrypt, isEncrypted } = require("../utils/secretBox");

const router = express.Router();
const pageSize = 25;
const emptyTotals = {
  tracked: 0,
  farmed: 0,
  rewards: 0,
  codes: 0,
  redeemed: 0,
};
const giveaway = {
  campaignId: GTA_GIVEAWAY.id,
  campaignName: "GTA VI Ultimate Edition giveaway",
  reward: GTA_GIVEAWAY.name,
};

router.get("/accounts", async (req, res) => {
  const { q = "", filter = "all", page = "1" } = req.query;
  if (
    typeof q !== "string" ||
    !/^[a-z0-9_]{0,25}$/i.test(q) ||
    !["all", "farmed", "codes"].includes(filter) ||
    typeof page !== "string" ||
    !/^[1-9]\d{0,5}$/.test(page)
  ) {
    return res
      .status(400)
      .json({ message: "Choose a valid account search, filter and page." });
  }
  const adminId = String(req.session.admin.id);
  const matches = {};
  if (q) matches._id = { $regex: q.toLowerCase() };
  if (filter === "farmed") matches.rewards = { $gt: 0 };
  if (filter === "codes") matches.codes = { $gt: 0 };
  const filtered = [{ $match: matches }];
  // Receipt-only viewers predate the roster. Combine both sources before
  // counting, so adding one of those viewers never counts the account twice.
  const [result] = await Receipt.aggregate([
    { $match: { adminId } },
    {
      $group: {
        _id: "$viewer",
        rewards: { $sum: 1 },
        codes: { $sum: { $cond: ["$codeSavedAt", 1, 0] } },
        redeemed: { $sum: { $cond: ["$codeRedeemedAt", 1, 0] } },
        firstSeen: { $min: "$recordedAt" },
        lastSeen: {
          $max: {
            $max: [
              "$recordedAt",
              "$changedAt",
              "$codeSavedAt",
              "$codeRedeemedAt",
            ],
          },
        },
      },
    },
    {
      $unionWith: {
        coll: Account.collection.name,
        pipeline: [
          { $match: { adminId } },
          {
            $project: {
              _id: "$viewer",
              firstSeen: "$addedAt",
              lastSeen: "$addedAt",
            },
          },
        ],
      },
    },
    {
      $group: {
        _id: "$_id",
        rewards: { $sum: "$rewards" },
        codes: { $sum: "$codes" },
        redeemed: { $sum: "$redeemed" },
        firstSeen: { $min: "$firstSeen" },
        lastSeen: { $max: "$lastSeen" },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              tracked: { $sum: 1 },
              farmed: { $sum: { $cond: [{ $gt: ["$rewards", 0] }, 1, 0] } },
              rewards: { $sum: "$rewards" },
              codes: { $sum: "$codes" },
              redeemed: { $sum: "$redeemed" },
            },
          },
          { $unset: "_id" },
        ],
        matched: [...filtered, { $count: "n" }],
        rows: [
          ...filtered,
          { $sort: { lastSeen: -1, _id: 1 } },
          { $skip: (Number(page) - 1) * pageSize },
          { $limit: pageSize },
          {
            $project: {
              _id: 0,
              viewer: "$_id",
              rewards: 1,
              codes: 1,
              redeemed: 1,
              firstSeen: 1,
              lastSeen: 1,
            },
          },
        ],
      },
    },
  ]).option({ maxTimeMS: 6000 });
  res.json({
    totals: result.totals[0] || emptyTotals,
    matched: result.matched[0]?.n || 0,
    rows: result.rows,
    page: Number(page),
    pageSize,
    giveaway,
    chatCampaignId: GTA_ID,
  });
});

router.put("/viewers/:viewer", async (req, res) => {
  const key = { adminId: req.session.admin.id, viewer: req.rewardViewer };
  try {
    await Account.updateOne(key, { $setOnInsert: key }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000 || !(await Account.exists(key))) throw err;
  }
  res.json({ viewer: req.rewardViewer });
});

router.delete("/viewers/:viewer", async (req, res) => {
  const key = { adminId: req.session.admin.id, viewer: req.rewardViewer };
  if (await Receipt.exists(key))
    return res
      .status(409)
      .json({
        message: "This account has confirmed rewards and stays in the list.",
      });
  await Account.deleteOne(key);
  res.json({ removed: true });
});

function shortText(value, max) {
  return (
    typeof value === "string" &&
    value.length <= max &&
    /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]*$/u.test(value)
  );
}

router.use("/viewers/:viewer/code", (req, res, next) => {
  const { campaignId, reward } = req.body || {};
  if (
    !shortText(campaignId, 140) ||
    !campaignId ||
    !shortText(reward, 300) ||
    !reward
  )
    return res
      .status(400)
      .json({ message: "Choose a reward for this account." });
  req.codeKey = {
    adminId: req.session.admin.id,
    viewer: req.rewardViewer,
    campaignId,
    reward,
  };
  if (req.method !== "PUT") {
    const version = req.body.version;
    if (typeof version !== "string" || !/^[a-f0-9-]{36}$/.test(version))
      return res
        .status(400)
        .json({ message: "Refresh the saved code details and retry." });
    req.codeKey.codeVersion = version;
  }
  next();
});

router.put("/viewers/:viewer/code", async (req, res) => {
  const key = req.codeKey;
  // The global request audit redacts secret-prefixed keys before persistence.
  const { secretCode: code, platform = "", region = "" } = req.body;
  if (
    typeof code !== "string" ||
    !/^[\x21-\x7e][\x20-\x7e]{2,158}[\x21-\x7e]$/.test(code.trim()) ||
    isEncrypted(code.trim()) ||
    !shortText(platform, 60) ||
    !shortText(region, 60)
  ) {
    return res.status(400).json({
      message:
        "Enter an issued code of 4–160 characters. Platform and region may have up to 60 characters each.",
    });
  }
  const known =
    key.campaignId === giveaway.campaignId && key.reward === giveaway.reward;
  if (
    key.campaignId === GTA_ID ||
    (key.campaignId === giveaway.campaignId && !known)
  )
    return res
      .status(400)
      .json({ message: "Choose the game-code giveaway for GTA VI." });

  const secret = process.env.CRED_SECRET || process.env.SESSION_SECRET;
  if (!secret)
    return res.status(503).json({ message: "Code storage is unavailable." });
  const value = code.trim();
  const canonical = known ? value.toUpperCase().replace(/[\s-]/g, "") : value;
  if (!canonical)
    return res.status(400).json({ message: "Enter the issued code." });
  const fingerprint = createHmac("sha256", secret)
    .update("twitch-reward-code\0" + canonical)
    .digest("hex");
  const savedFields = {
    codeSavedAt: new Date(),
    codeVersion: randomUUID(),
    codeCipher: encrypt(value),
    codeFingerprint: fingerprint,
    platform: platform.trim(),
    region: region.trim(),
  };
  // An issued giveaway code itself confirms the award. For other campaigns
  // attach it only to an existing confirmed item in this operator's ledger.
  try {
    const update = { $set: savedFields };
    if (known)
      update.$setOnInsert = { ...key, campaignName: giveaway.campaignName };
    const result = await Receipt.updateOne(
      { ...key, codeSavedAt: { $exists: false } },
      update,
      { upsert: known },
    );
    if (result.matchedCount || result.upsertedCount)
      return res.json({ saved: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  if (await Receipt.exists({ ...key, codeFingerprint: fingerprint }))
    return res.json({ saved: true });
  return res.status(409).json({
    message:
      "Confirm this reward first and check whether a code is already saved for this reward or account list.",
  });
});

router.post("/viewers/:viewer/code/reveal", async (req, res) => {
  const row = await Receipt.findOne(req.codeKey).select("codeCipher").lean();
  if (!row)
    return res
      .status(404)
      .json({ message: "The saved code has changed or is unavailable." });
  const code = isEncrypted(row.codeCipher) && decrypt(row.codeCipher);
  if (!code)
    return res
      .status(503)
      .json({ message: "The saved code could not be opened." });
  res.json({ code });
});

router.patch("/viewers/:viewer/code", async (req, res) => {
  const redeemed = req.body.redeemed;
  if (typeof redeemed !== "boolean")
    return res.status(400).json({ message: "Choose a redemption status." });
  const result = await Receipt.updateOne(
    { ...req.codeKey, codeRedeemedAt: { $exists: !redeemed } },
    redeemed
      ? { $set: { codeRedeemedAt: new Date(), changedAt: new Date() } }
      : { $unset: { codeRedeemedAt: 1 }, $set: { changedAt: new Date() } },
  );
  if (!result.matchedCount && !(await Receipt.exists(req.codeKey)))
    return res
      .status(404)
      .json({ message: "The saved code has changed or is unavailable." });
  res.json({ redeemed });
});

router.delete("/viewers/:viewer/code", async (req, res) => {
  const result = await Receipt.updateOne(req.codeKey, {
    $set: { changedAt: new Date() },
    $unset: {
      codeSavedAt: 1,
      codeVersion: 1,
      codeRedeemedAt: 1,
      codeCipher: 1,
      codeFingerprint: 1,
      platform: 1,
      region: 1,
    },
  });
  if (!result.matchedCount)
    return res
      .status(404)
      .json({ message: "The saved code has changed or is unavailable." });
  res.json({ removed: true });
});

module.exports = router;
