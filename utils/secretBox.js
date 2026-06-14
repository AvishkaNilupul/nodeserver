// Reversible encryption for sensitive credentials (Twitch account passwords /
// emails) stored at rest. We need the plaintext back to actually log in to the
// accounts, so this is symmetric encryption — not hashing.
//
// Key material comes from CRED_SECRET (preferred) or falls back to
// SESSION_SECRET so the feature works without extra setup. A stable per-process
// key is derived with scrypt. Ciphertext is tagged with a version prefix so we
// can recognise our own values and migrate later if needed.
const crypto = require("crypto");

const VERSION = "v1";
const PREFIX = "enc:" + VERSION + ":";

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.CRED_SECRET || process.env.SESSION_SECRET || "";
  if (!secret) {
    throw new Error(
      "CRED_SECRET (or SESSION_SECRET) must be set to store credentials securely",
    );
  }
  // Fixed salt: the secret itself is the entropy; we just need a deterministic
  // 32-byte key for AES-256 across restarts.
  cachedKey = crypto.scryptSync(secret, "redeemer-cred-box", 32);
  return cachedKey;
}

// Returns true for strings produced by encrypt() below.
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// Encrypt a UTF-8 string. Empty/falsy input returns "" (nothing to protect).
function encrypt(plain) {
  if (plain == null || plain === "") return "";
  const text = String(plain);
  if (isEncrypted(text)) return text; // already encrypted, don't double-wrap
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    iv.toString("base64") +
    ":" +
    tag.toString("base64") +
    ":" +
    enc.toString("base64")
  );
}

// Decrypt a value produced by encrypt(). Plain (non-prefixed) values are
// returned as-is so legacy/plaintext rows still display. Returns "" on failure.
function decrypt(value) {
  if (value == null || value === "") return "";
  const text = String(value);
  if (!isEncrypted(text)) return text;
  try {
    const [, , payload] = [PREFIX, "", text.slice(PREFIX.length)];
    const [ivB64, tagB64, dataB64] = payload.split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
