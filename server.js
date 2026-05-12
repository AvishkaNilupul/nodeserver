const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

const Code = require("./models/Code");

const app = express();

// =========================
// CONFIG
// =========================

const ADMIN_KEY = "Avishka123";

// =========================
// Middleware
// =========================

app.use(express.json());

app.use(express.urlencoded({
  extended: true
}));

// Serve public folder

app.use(express.static(
  path.join(__dirname, "public")
));

// =========================
// MongoDB Connection
// =========================

mongoose.connect(
  "mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer"
)

.then(() => {

  console.log("✅ MongoDB connected");

})

.catch((err) => {

  console.error(
    "❌ MongoDB connection error:",
    err
  );

});

// =========================
// Redeem Code Generator
// =========================

function generateRedeemCode() {

  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function part(length) {

    let result = "";

    for (let i = 0; i < length; i++) {

      result += chars.charAt(
        Math.floor(Math.random() * chars.length)
      );

    }

    return result;
  }

  // Format:
  // XXXX-XXXXX-XXXX-XXXX

  return `${part(4)}-${part(5)}-${part(4)}-${part(4)}`;
}

// =========================
// Home Route
// =========================

app.get("/", (req, res) => {

  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );

});

// =========================
// Validate Route
// =========================

app.post("/validate", async (req, res) => {

  try {

    const {
      code,
      deviceToken
    } = req.body;

    // =========================
    // Validate input
    // =========================

    if (!code) {

      return res.status(400).json({
        success: false,
        message: "Code is required"
      });

    }

    // =========================
    // Find code
    // =========================

    const found = await Code.findOne({
      code
    });

    // Invalid code

    if (!found) {

      return res.json({
        success: false,
        message: "Invalid code"
      });

    }

    // =========================
    // Expiration check
    // =========================

    if (found.redeemedAt) {

      const now = Date.now();

      const redeemedTime =
        new Date(found.redeemedAt).getTime();

      const twoDays =
        2 * 24 * 60 * 60 * 1000;

      // Expired

      if (now - redeemedTime > twoDays) {

        await Code.deleteOne({
          _id: found._id
        });

        console.log(
          `🗑️ Expired code deleted: ${found.code}`
        );

        return res.json({
          success: false,
          message:
            "This code has expired"
        });

      }

    }

    // =========================
    // First redeem
    // =========================

    if (!found.deviceToken) {

      found.deviceToken = deviceToken;

      found.redeemedAt = new Date();

      await found.save();

      console.log(
        "🔒 Locked to device:",
        deviceToken
      );

    }

    // =========================
    // Block other devices
    // =========================

    if (
      String(found.deviceToken) !==
      String(deviceToken)
    ) {

      return res.json({
        success: false,
        message:
          "This code has already been redeemed on another device"
      });

    }

    // =========================
    // Success
    // =========================

    return res.json({
      success: true,
      account: found.account,
      password: found.password
    });

  } catch (err) {

    console.error(
      "❌ Validate error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

});

// =========================
// Generate Route
// =========================

app.post("/generate", async (req, res) => {

  try {

    const {
      account,
      password,
      key
    } = req.body;

    // =========================
    // Validate admin key
    // =========================

    if (key !== ADMIN_KEY) {

      return res.status(403).json({
        success: false,
        message: "Invalid admin key"
      });

    }

    // =========================
    // Validate fields
    // =========================

    if (!account || !password) {

      return res.status(400).json({
        success: false,
        message:
          "Account and password are required"
      });

    }

    // =========================
    // Generate UNIQUE code
    // =========================

    let code;
    let exists = true;

    while (exists) {

      code = generateRedeemCode();

      exists = await Code.findOne({
        code
      });

    }

    // =========================
    // Save code
    // =========================

    const newCode = new Code({
      code,
      account,
      password,
      redeemedAt: null,
      deviceToken: null
    });

    await newCode.save();

    console.log(
      `🎟️ Generated code: ${code}`
    );

    // =========================
    // Success response
    // =========================

    return res.json({
      success: true,
      code
    });

  } catch (err) {

    console.error(
      "❌ Generate error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

});

// =========================
// 404 Route
// =========================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    message: "Route not found"
  });

});

// =========================
// Start Server
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `🚀 Server started on http://0.0.0.0:${PORT}`
  );

});