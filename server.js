const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const validator = require("validator");
const { Server } = require("socket.io");

require("dotenv").config();

const config = require("./config/config");
const { requireAdmin, requireSuperadmin } = require("./middleware/auth");
const adminAuthRoutes = require("./routes/adminAuthRoutes");
const adminManageRoutes = require("./routes/adminManageRoutes");
const redeemRoutes = require("./routes/redeemRoutes");
const chatRoutes = require("./routes/chatRoutes");
const itemRoutes = require("./routes/itemRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const orderRoutes = require("./routes/orderRoutes");
const botConfigRoutes = require("./routes/botConfigRoutes");
const chatSocket = require("./socket/chatSocket");
const { getOrderByOrderId } = require("./utils/orderIds");
const { sendTelegram } = require("./utils/telegram");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.disable("x-powered-by");
app.set("trust proxy", true);

// =========================
// Core middleware (must come before any route)
// =========================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: "auto",
    sameSite: "strict",
    maxAge: 1000 * 60 * 60 * 12,
  },
});

app.use(sessionMiddleware);
// Share the session with Socket.IO so admin sockets are authenticated.
io.engine.use(sessionMiddleware);

// =========================
// Image upload (image types only)
// =========================
const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

const upload = multer({
  dest: "public/uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_IMAGE_TYPES.includes(file.mimetype));
  },
});

app.post("/upload-image", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "Image file required" });
  }
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// =========================
// Submit Gamer Tag (buyer redeem -> Telegram alert)
// =========================
let globalEntries = [];
const MAX_USERS = 5;
const WINDOW_MS = 10 * 60 * 1000;

app.post("/submit-gamertag", async (req, res) => {
  try {
    let { gamerTag, orderId } = req.body;

    gamerTag = validator.escape(String(gamerTag || "")).trim();
    orderId = String(orderId || "").trim();

    // Global limit (intentionally left unchanged)
    const now = Date.now();
    globalEntries = globalEntries.filter((time) => now - time < WINDOW_MS);

    if (globalEntries.length >= MAX_USERS) {
      return res.status(429).json({
        success: false,
        message: "Server busy. Please try again later.",
      });
    }
    globalEntries.push(now);

    if (!gamerTag || !orderId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing gamer tag or order ID" });
    }

    const order = await getOrderByOrderId(orderId);

    if (!order) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid Order ID" });
    }

    if (order.used) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID already used" });
    }

    const ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "Unknown";

    await sendTelegram(
      `🎮NEW GAMER TAG

Tag: ${gamerTag}

Order ID:
${orderId}

IP:
${ip}

Time:
${new Date().toISOString()}`,
    );

    order.used = true;
    order.gamerTag = gamerTag;
    order.usedAt = new Date();
    // Per-buyer secret returned to the client; required to authenticate
    // the chat socket so a gamertag alone can't impersonate the buyer.
    order.chatToken = crypto.randomBytes(24).toString("hex");
    await order.save();

    res.json({ success: true, token: order.chatToken });
  } catch (err) {
    console.error("SUBMIT ERROR:", err.message);
    res.status(500).json({ success: false });
  }
});

// =========================
// Admin auth routes
// =========================
app.use(adminAuthRoutes);
app.use(adminManageRoutes);

// =========================
// Admin-only pages
// =========================
app.get("/orders", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-pages", "orders.html"));
});

app.get("/admin.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/items", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-pages", "items.html"));
});

app.get("/inventory", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-pages", "inventory.html"));
});

// =========================
// Superadmin-only pages
// =========================
app.get("/superadmin.html", requireSuperadmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "superadmin.html"));
});

app.get("/twitch-inventory.html", requireSuperadmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "twitch-inventory.html"));
});

app.get("/bots.html", requireSuperadmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bots.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// =========================
// Home
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =========================
// Routes
// =========================
app.use(redeemRoutes);
app.use(chatRoutes);
app.use(requireAdmin, itemRoutes);
app.use(requireAdmin, inventoryRoutes);
app.use(requireAdmin, orderRoutes);
app.use(botConfigRoutes);

// =========================
// Socket.IO
// =========================
chatSocket(io);

// =========================
// 404
// =========================
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// =========================
// MongoDB + start
// =========================
mongoose
  .connect(config.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    server.listen(config.PORT, "0.0.0.0", () => {
      console.log(`Server started on http://0.0.0.0:${config.PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
