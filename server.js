const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;
const helmet = require("helmet");
const multer = require("multer");
const validator = require("validator");
const { Server } = require("socket.io");
const { createProxyMiddleware } = require("http-proxy-middleware");

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
const { getOrderByOrderId, authorizeBuyer } = require("./utils/orderIds");
const { sendTelegram } = require("./utils/telegram");
const { submitLimiter, uploadLimiter } = require("./utils/rateLimit");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.disable("x-powered-by");
// Trust a single proxy hop (the reverse proxy in front of the app) so client
// IPs and `secure` cookie detection are based on the real edge, not on a
// header any client can spoof.
app.set("trust proxy", 1);

// =========================
// Core middleware (must come before any route)
// =========================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Inline scripts/styles are used throughout the static pages.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Chat messages may embed externally hosted images.
        imgSrc: ["'self'", "data:", "https:"],
        // Socket.IO uses same-origin HTTP(S) and WebSocket connections.
        connectSrc: ["'self'", "ws:", "wss:"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Persist sessions in MongoDB so admins stay logged in across server
  // restarts (the default in-memory store is wiped on every restart, which
  // silently de-authenticates open admin sockets).
  store: MongoStore.create({
    mongoUrl: config.MONGO_URI,
    collectionName: "sessions",
    ttl: 60 * 60 * 12,
  }),
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

// Only an authenticated admin, or a buyer who presents a valid gamertag +
// chat token, may upload. Buyers send these via headers (available before the
// multipart body is parsed) so we can reject before writing any file. This
// stops the endpoint from being open, unauthenticated file hosting.
async function requireUploader(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  const gamerTag = req.get("x-gamer-tag");
  const token = req.get("x-chat-token");
  try {
    const order = await authorizeBuyer(gamerTag, token);
    if (order) {
      return next();
    }
  } catch (err) {
    console.error("upload auth error:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}

app.post(
  "/upload-image",
  uploadLimiter,
  requireUploader,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Image file required" });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
  },
);

// =========================
// Submit Gamer Tag (buyer redeem -> Telegram alert)
// =========================
// Throttling is per-IP (see submitLimiter). The previous global counter
// rate-limited every buyer with a single shared bucket and counted invalid
// requests, so a handful of junk submissions could lock out all real buyers.
app.post("/submit-gamertag", submitLimiter, async (req, res) => {
  try {
    let { gamerTag, orderId } = req.body;

    gamerTag = validator.escape(String(gamerTag || "")).trim();
    orderId = String(orderId || "").trim();

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

// =========================
// Marketplace tab (all admins)
// =========================
// The marketplace runs as a local FastAPI sidecar (default 127.0.0.1:8001),
// reached only through this authenticated reverse proxy — it is never exposed
// publicly on its own port. The wrapper page keeps the admin sidebar and embeds
// the app in an iframe pointed at the proxied "/marketplace/" path.
const MARKETPLACE_TARGET =
  process.env.MARKETPLACE_URL || "http://127.0.0.1:8001";
const marketplaceProxy = createProxyMiddleware({
  target: MARKETPLACE_TARGET,
  changeOrigin: true,
  pathRewrite: { "^/marketplace": "" },
  ws: false,
});

app.get("/marketplace.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "marketplace.html"));
});
app.use("/marketplace", requireAdmin, marketplaceProxy);

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
