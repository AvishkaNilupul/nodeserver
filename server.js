const ADMIN_KEY = "Avishka123"; 


const express = require("express");
const mongoose = require("mongoose");
const Code = require("./models/Code");

const app = express();

// ✅ middleware
app.use(express.json());
app.use(express.static("public"));

// ✅ MongoDB connection
mongoose.connect("mongodb://avishka:Avishka123@ac-ufnccre-shard-00-00.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-01.vsigmq3.mongodb.net:27017,ac-ufnccre-shard-00-02.vsigmq3.mongodb.net:27017/codesDB?ssl=true&replicaSet=atlas-ur8a1h-shard-0&authSource=admin&appName=redeemer")
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// ✅ test route
app.get("/", (req, res) => {
  res.send("Server is running");
});

// ✅ validation route
// 🔹 VALIDATE ROUTE
app.post("/validate", async (req, res) => {
  try {
    const { code } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    const found = await Code.findOne({ code });

    if (!found) {
      return res.json({ success: false, message: "Invalid code" });
    }

    // lock first IP
    if (!found.allowedIP) {
      found.allowedIP = ip;
      await found.save();
    }

    // block other IPs
    if (found.allowedIP !== ip) {
      return res.json({
        success: false,
        message: "This code is already used by another user"
      });
    }

    // 🔥 RETURN DATA instead of redirect
    res.json({
      success: true,
      account: found.account,
      password: found.password
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// 🔹 GENERATE ROUTE
app.post("/generate", async (req, res) => {
  try {
    const { account, password, key } = req.body;

    if (key !== ADMIN_KEY) {
      return res.status(403).json({ success: false });
    }

    const code = Math.random().toString(36).substring(2, 10);

    const newCode = new Code({
      code,
      account,
      password
    });

    await newCode.save();

    res.json({ success: true, code });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ✅ start server
app.listen(3000, () => {
  console.log("Server started on http://localhost:3000");
});