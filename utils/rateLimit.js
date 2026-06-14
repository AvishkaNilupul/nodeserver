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
  skip: (req) => req.path.startsWith("/socket.io"),
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

module.exports = {
  globalLimiter,
  loginLimiter,
  validateLimiter,
  generateLimiter,
  submitLimiter,
  uploadLimiter,
};
