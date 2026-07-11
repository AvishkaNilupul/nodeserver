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
const {
  requireAdmin,
  requireSuperadmin,
  enforce2fa,
} = require("./middleware/auth");
const adminAuthRoutes = require("./routes/adminAuthRoutes");
const adminManageRoutes = require("./routes/adminManageRoutes");
const redeemRoutes = require("./routes/redeemRoutes");
const chatRoutes = require("./routes/chatRoutes");
const itemRoutes = require("./routes/itemRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const orderRoutes = require("./routes/orderRoutes");
const botConfigRoutes = require("./routes/botConfigRoutes");
const dropArchiveRoutes = require("./routes/dropArchiveRoutes");
const marketplaceRoutes = require("./routes/marketplaceRoutes");
const backupRoutes = require("./routes/backupRoutes");
const shopRoutes = require("./routes/shopRoutes");
const primeRoutes = require("./routes/primeRoutes");
const radarRoutes = require("./routes/radarRoutes");
const epicAccountRoutes = require("./routes/epicAccountRoutes");
const twoFactorRoutes = require("./routes/twoFactorRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const dropScanner = require("./utils/dropScanner");
const backup = require("./utils/backup");
const gameflipFulfiller = require("./utils/gameflipFulfiller");
const marketplaceGuardian = require("./utils/marketplaceGuardian");
const primeWatcher = require("./utils/primeWatcher");
const campaignWatcher = require("./utils/campaignWatcher");
const epicWatcher = require("./utils/epicWatcher");
const epicClaimer = require("./utils/epicClaimer");
const telegramBot = require("./utils/telegramBot");
const chatSocket = require("./socket/chatSocket");
const {
  getOrderByOrderId,
  authorizeBuyerByOrder,
  buildChatId,
} = require("./utils/orderIds");
const { sendTelegramToSeller } = require("./utils/telegram");
const {
  globalLimiter,
  submitLimiter,
  uploadLimiter,
} = require("./utils/rateLimit");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// engine.io's socket handshake runs sessionMiddleware (below) as one of its
// own middlewares — the session lookup is an async MongoStore round-trip, so
// a client that disconnects mid-handshake can have engine.io try to abort an
// already-dead response by the time that lookup resolves. Node's http
// internals throw ERR_HTTP_HEADERS_SENT for that (not fixed upstream as of
// engine.io 6.6.9), which — with no handler here — took the whole process
// down for every other connected admin/buyer over one abandoned handshake.
// Only this specific, already-understood race is swallowed; anything else
// still crashes and lets PM2 restart the process as before, so a genuinely
// unknown bug doesn't get silently masked.
process.on("uncaughtException", (err) => {
  if (
    err &&
    err.code === "ERR_HTTP_HEADERS_SENT" &&
    typeof err.stack === "string" &&
    err.stack.includes("engine.io")
  ) {
    console.error(
      "[engine.io] ignored a stale-handshake abort race:",
      err.message,
    );
    return;
  }
  console.error("Uncaught exception, exiting:", err);
  process.exit(1);
});

app.disable("x-powered-by");
// Trust a single proxy hop (the reverse proxy in front of the app) so client
// IPs and `secure` cookie detection are based on the real edge, not on a
// header any client can spoof.
app.set("trust proxy", 1);

// Site-wide rate limit: a blanket per-IP ceiling across every route, in front
// of the stricter per-endpoint limiters. Skips Socket.IO so live chat isn't
// throttled.
app.use(globalLimiter);

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
        // Pages wire up buttons with inline on* handlers (onclick=...), which
        // helmet otherwise blocks via its default `script-src-attr 'none'`.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Chat messages may embed externally hosted images.
        imgSrc: ["'self'", "data:", "https:"],
        // Socket.IO uses same-origin HTTP(S) and WebSocket connections.
        connectSrc: ["'self'", "ws:", "wss:", "https://gql.twitch.tv"],
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
  const orderId = req.get("x-order-id");
  const token = req.get("x-chat-token");
  try {
    const order = await authorizeBuyerByOrder(orderId, token);
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

    // Already claimed: only the original buyer (same gamertag) may resume their
    // chat. Anyone else presenting this order id is rejected, so a used order
    // id is never available to a different person.
    if (order.used) {
      if (order.gamerTag !== gamerTag) {
        return res.status(400).json({
          success: false,
          message: "This order ID is already in use",
        });
      }
      // Backfill the chat id for orders claimed before this field existed.
      if (!order.chatId) {
        order.chatId = buildChatId(order.gamerTag, order.orderId);
        await order.save();
      }
      return res.json({ success: true, token: order.chatToken, resumed: true });
    }

    const ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "Unknown";

    order.used = true;
    order.gamerTag = gamerTag;
    order.usedAt = new Date();
    // Stable per-order chat identity so a reused gamertag never overlaps a
    // previous order's chat.
    order.chatId = buildChatId(gamerTag, orderId);
    // Per-buyer secret returned to the client; required to authenticate
    // the chat socket so a gamertag alone can't impersonate the buyer.
    order.chatToken = crypto.randomBytes(24).toString("hex");
    await order.save();

    // Notify out-of-band so the buyer's response isn't delayed by the
    // Telegram API round-trip (errors are handled inside the sender).
    sendTelegramToSeller(
      order.sellerId,
      `🎮NEW GAMER TAG

Tag: ${gamerTag}

Order ID:
${orderId}

IP:
${ip}

Time:
${new Date().toISOString()}`,
    ).catch((e) => console.error("telegram notify error:", e.message));

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
// 2FA setup + login second step. Mounted before the enforcement guard so an
// admin who hasn't enrolled yet can still reach these to set it up.
app.use(twoFactorRoutes);
// Per-admin self-service settings (e.g. linking a personal Telegram chat).
// Each route guards with requireAdmin; kept out of the 2FA enforcement gate so
// it stays reachable like the security page.
app.use(settingsRoutes);
app.use(enforce2fa, adminManageRoutes);

// =========================
// Admin-only pages
// =========================
app.get("/orders", requireAdmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-pages", "orders.html"));
});

app.get("/admin.html", requireAdmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Legacy security page: 2FA now lives inside Settings, so redirect any old
// bookmarks / links there.
app.get("/security.html", (req, res) => {
  res.redirect("/settings.html");
});

// Settings (any admin; not behind enforce2fa so a not-yet-enrolled admin can
// reach it to set up 2FA). Hosts both the 2FA panel and the per-admin "My
// Telegram" linking panel.
app.get("/settings.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.get("/inventory", requireAdmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "admin-pages", "inventory.html"));
});

// =========================
// Superadmin-only pages
// =========================
app.get("/superadmin.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "superadmin.html"));
});

app.get("/twitch-inventory.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "twitch-inventory.html"));
});

app.get("/bots.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bots.html"));
});

app.get("/backup.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "backup.html"));
});

app.get("/drops-archive.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "drops-archive.html"));
});

// Marketplace integrity guard (superadmin only) — review queue for the
// background checker's findings.
app.get("/integrity.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "integrity.html"));
});

// Prime Gaming watcher (superadmin only) — tracked offers + alerts.
app.get("/prime.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "prime.html"));
});

// Drops radar (superadmin only) — Twitch campaigns + Epic free games.
app.get("/radar.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "radar.html"));
});

// Epic accounts manager (superadmin only) — stock accounts + auto-claim.
app.get("/epic-accounts.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "epic-accounts.html"));
});

// Shop listings manager (superadmin only) — build/publish manual listings.
app.get("/listings.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "listings.html"));
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

app.get("/marketplace.html", requireAdmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "marketplace.html"));
});
app.use("/marketplace", requireAdmin, enforce2fa, marketplaceProxy);

// =========================
// Shop (in-app bundle store, all admins)
// =========================
// A second, fully in-app marketplace: superadmins price and list bundles
// (DropSets); regular admins browse them and buy with their balance, getting a
// matching account in return. Separate from the FastAPI Marketplace above.
app.get("/shop.html", requireAdmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "shop.html"));
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
app.use(enforce2fa, chatRoutes);
app.use(requireAdmin, enforce2fa, itemRoutes);
app.use(requireAdmin, enforce2fa, inventoryRoutes);
app.use(requireAdmin, enforce2fa, orderRoutes);
app.use(enforce2fa, botConfigRoutes);
app.use(enforce2fa, dropArchiveRoutes);
app.use(enforce2fa, marketplaceRoutes);
app.use(enforce2fa, backupRoutes);
app.use(enforce2fa, shopRoutes);
app.use(enforce2fa, primeRoutes);
app.use(enforce2fa, radarRoutes);
app.use(enforce2fa, epicAccountRoutes);

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
    // Begin the background drop-archive scanner (gentle, one account at a
    // time). Safe no-op until accounts are synced from the bot configs.
    dropScanner.start();
    // Listen for admins confirming a Telegram link from inside the app's bot.
    // No-op when TG_TOKEN is unset.
    telegramBot.start();
    // Schedule the daily full-site backup (DB + uploads + config). Wrapped
    // internally so a backup failure can never crash the server.
    backup.start();
    // Watch live Gameflip auto-delivery listings: mark sales and relist the
    // next unit of multi-quantity chains. No-op without Gameflip listings.
    gameflipFulfiller.start();
    // Marketplace guardian: auto-feeds sold-down Plati/GGSel listings with
    // fresh accounts and flags cross-platform integrity issues for review.
    marketplaceGuardian.start();
    // Prime Gaming watcher: polls Amazon's public offer catalog and alerts
    // on new / expiring offers via Telegram + the Prime Gaming tab.
    primeWatcher.start();
    // Drops radar: Twitch drop-campaign watcher (new farmable campaigns)
    // and Epic free-games watcher, both alerting via Telegram + the tab.
    campaignWatcher.start();
    epicWatcher.start();
    // Epic accounts: refreshes stock-account tokens, re-syncs libraries and
    // sends one-tap claim links when live giveaways are missing.
    epicClaimer.start();
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
