const ADMIN_KEY = "Avishka123";

const express = require("express");
const mongoose = require("mongoose");
const Code = require("./models/Code");

const app = express();

// =========================
// Middleware
// =========================
app.use(express.json());
app.use(express.static("public"));

// =========================
// MongoDB Connection
// =========================
mongoose.connect(
  "mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer"
)
.then(() => {
  console.log("MongoDB connected");
})
.catch((err) => {
  console.error("MongoDB connection error:", err);
});

// =========================
// Test Route
// =========================
app.get("/", (req, res) => {
  res.send("Server is running");
});

// =========================
// Validate Route
// =========================
app.post("/validate", async (req, res) => {
  try {
    const { code } = req.body;

    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress;

    const found = await Code.findOne({ code });

    if (!found) {
      return res.json({
        success: false,
        message: "Invalid code"
      });
    }

    // Lock first IP
    if (!found.allowedIP) {
      found.allowedIP = ip;
      await found.save();
    }

    // Block other IPs
    if (found.allowedIP !== ip) {
      return res.json({
        success: false,
        message: "This code is already used by another user"
      });
    }

    return res.json({
      success: true,
      account: found.account,
      password: found.password
    });

  } catch (err) {
    console.error("Validate error:", err);

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
    const { account, password, key } = req.body;

    if (key !== ADMIN_KEY) {
      return res.status(403).json({
        success: false,
        message: "Invalid admin key"
      });
    }

    // Generate random code
    const code = Math.random()
      .toString(36)
      .substring(2, 10);

    const newCode = new Code({
      code,
      account,
      password
    });

    await newCode.save();

    return res.json({
      success: true,
      code
    });

  } catch (err) {
    console.error("Generate error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

// =========================
// Start Server
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on http://0.0.0.0:${PORT}`);
});