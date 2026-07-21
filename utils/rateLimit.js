const rateLimit = require("express-rate-limit");

// Shared rate limiters. Each one is keyed by client IP (Express resolves this
// from the configured `trust proxy` setting). Responses are JSON so API
// clients get a consistent shape.
function jsonLimiter({ windowMs, limit, message, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: (req, res) => {
      res.status(429).json({ success: false, message });
    },
  });
}

// Site-wide safety net: caps total requests per IP across every route. The
// ceiling is high on purpose so a normal page load (HTML + assets + a few API
// calls) never trips it; it only catches a single IP flooding the server.
// Socket.IO is skipped because its polling transport makes many background
// requests and would otherwise get throttled, breaking live chat.
const globalLimiter = jsonLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: "Too many requests. Please slow down and try again later.",
  // Skip Socket.IO (its polling makes many background requests) AND logged-in
  // admins — an authenticated operator bulk-posting listings to stores fires a
  // lot of requests in a short window and shouldn't hit the blanket per-IP
  // ceiling. Anonymous IPs are still capped. (Relies on this limiter being
  // mounted after the session middleware in server.js, so req.session exists.)
  skip: (req) =>
    req.path.startsWith("/socket.io") || !!(req.session && req.session.admin),
});

// Admin login: slow brute-force of passwords.
const loginLimiter = jsonLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many login attempts. Please try again later.",
});

// Redeem code validation: codes are short, so cap enumeration attempts.
const validateLimiter = jsonLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: "Too many attempts. Please try again later.",
});

// Redeem code generation (admin-key gated).
const generateLimiter = jsonLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: "Too many attempts. Please try again later.",
});

// Gamer-tag submission (buyer redeem -> Telegram alert).
const submitLimiter = jsonLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: "Too many submissions. Please try again later.",
});

// Image uploads.
const uploadLimiter = jsonLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: "Too many uploads. Please try again later.",
});

// Buyer-portal health re-check (bulk orders). Each run fans out a Twitch call
// per account, so cap how often a buyer can trigger one.
const portalCheckLimiter = jsonLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 6,
  message: "Too many health checks. Please wait a bit and try again.",
});

// Renter account submissions. Submissions queue for operator approval, so a
// modest cap is plenty and blunts spam from a compromised renter account.
const renterSubmitLimiter = jsonLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: "Too many submissions. Please wait a bit and try again.",
});

// Renter start/stop of their own bot. Each call SSHes to the host, so cap how
// fast a renter can bounce their container (protects the host from start/stop
// spam).
const renterBotControlLimiter = jsonLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  message: "Too many start/stop actions. Please wait a moment.",
});

// Renter "watch live farming" — each call hits Twitch's API for one account, so
// cap how often the dashboard can poll it (still generous enough to refresh a
// couple of accounts every few seconds).
const renterLiveLimiter = jsonLimiter({
  windowMs: 60 * 1000,
  limit: 40,
  message: "Checking too fast — give it a few seconds.",
});

module.exports = {
  globalLimiter,
  loginLimiter,
  validateLimiter,
  generateLimiter,
  submitLimiter,
  uploadLimiter,
  portalCheckLimiter,
  renterSubmitLimiter,
  renterBotControlLimiter,
  renterLiveLimiter,
};
