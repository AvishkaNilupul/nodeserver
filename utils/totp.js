// TOTP (Google Authenticator–style) two-factor helpers.
//
// The shared TOTP secret is encrypted at rest with the same AES-256 box used
// for bot credentials (utils/secretBox). One-time backup codes are stored as
// bcrypt hashes so a database leak never exposes a working code.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const otplib = require("otplib");
const QRCode = require("qrcode");

const { encrypt, decrypt } = require("./secretBox");

const ISSUER = process.env.TOTP_ISSUER || "RedeemHub";
const BACKUP_COUNT = 10;

// Generate a new base32 secret and the otpauth:// URI to enrol it.
async function newSecret(accountName) {
  const secret = await otplib.generateSecret();
  const uri = await otplib.generateURI({
    secret,
    label: accountName || "admin",
    issuer: ISSUER,
  });
  return { secret, uri };
}

// Render the otpauth URI as an inline SVG QR code (CSP-safe, no external libs).
async function qrSvg(uri) {
  return QRCode.toString(uri, { type: "svg", margin: 1, width: 196 });
}

// Verify a 6-digit code against a secret, allowing ±1 time step for clock drift.
function verifyToken(token, secret) {
  const clean = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean) || !secret) return false;
  try {
    const r = otplib.verifySync({ token: clean, secret, window: 1 });
    return !!(r && r.valid);
  } catch {
    return false;
  }
}

function generateBackupCodes(n = BACKUP_COUNT) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 10 hex chars, grouped for readability (e.g. "a1b2c-3d4e5").
    const raw = crypto.randomBytes(5).toString("hex");
    codes.push(raw.slice(0, 5) + "-" + raw.slice(5));
  }
  return codes;
}

function normalizeBackup(code) {
  return String(code || "").replace(/\s+/g, "").replace(/-/g, "").toLowerCase();
}

async function hashBackupCodes(codes) {
  return Promise.all(codes.map((c) => bcrypt.hash(normalizeBackup(c), 10)));
}

// Returns the index of the matching hash, or -1.
async function matchBackupCode(code, hashes) {
  const clean = normalizeBackup(code);
  if (!clean || !Array.isArray(hashes)) return -1;
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(clean, hashes[i])) return i;
  }
  return -1;
}

module.exports = {
  encrypt,
  decrypt,
  newSecret,
  qrSvg,
  verifyToken,
  generateBackupCodes,
  hashBackupCodes,
  matchBackupCode,
};
