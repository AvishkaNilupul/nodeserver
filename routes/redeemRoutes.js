const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const Code = require("../models/Code");
const config = require("../config/config");
const generateRedeemCode = require("../utils/codeGenerator");
const { validateLimiter, generateLimiter } = require("../utils/rateLimit");

// Constant-time comparison so the admin key can't be recovered via timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post("/validate", validateLimiter, async (req, res) => {
  try {
    const { code, deviceToken } = req.body;

    if (!code) {
      return res
        .status(400)
        .json({ success: false, message: "Code is required" });
    }

    // A device token is required so a redeemed code stays locked to the
    // browser that first claimed it. Without this an empty token bypassed
    // the device lock entirely.
    if (typeof deviceToken !== "string" || !deviceToken.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Device token is required" });
    }

    const found = await Code.findOne({ code });

    if (!found) {
      return res.json({ success: false, message: "Invalid code" });
    }

    if (!found.deviceToken) {
      found.deviceToken = deviceToken;
      found.redeemedAt = new Date();
      await found.save();
    }

    if (found.deviceToken !== deviceToken) {
      return res.json({
        success: false,
        message: "This code has already been redeemed",
      });
    }

    if (found.redeemedAt) {
      const twoDays = 2 * 24 * 60 * 60 * 1000;
      const expired =
        Date.now() - new Date(found.redeemedAt).getTime() > twoDays;

      if (expired) {
        return res.json({ success: false, message: "This code has expired" });
      }
    }

    return res.json({
      success: true,
      account: found.account,
      password: found.password,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/generate", generateLimiter, async (req, res) => {
  try {
    const { account, password, key } = req.body;

    if (!key || !safeEqual(key, config.ADMIN_KEY)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid admin key" });
    }

    let code;
    let exists = true;

    while (exists) {
      code = generateRedeemCode();
      exists = await Code.findOne({ code });
    }

    const newCode = new Code({ code, account, password });
    await newCode.save();

    return res.json({ success: true, code });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
