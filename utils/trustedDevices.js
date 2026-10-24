// "Remember this device" for the admin login.
//
// When an admin ticks the box at login, the browser gets a long-lived httpOnly
// cookie holding `<deviceId>.<secret>`. Whenever that browser shows up without
// an admin session (the normal session lasts 12 h), restoreTrustedSession()
// checks the cookie against models/TrustedDevice and signs the admin straight
// back in — no password, no 2FA code.
//
// A remembered device stops working when:
//   - it goes unused for IDLE_DAYS (sliding: every sign-in pushes it forward),
//   - the admin logs out on it, or removes it on the Settings page,
//   - the admin's password changes (pwFingerprint no longer matches),
//   - 2FA was turned on after the device was trusted (viaTotp is false),
//   - the admin is deleted from admins.json.

const crypto = require("crypto");
const mongoose = require("mongoose");

const TrustedDevice = require("../models/TrustedDevice");
const admins = require("./admins");
const systemLog = require("./systemLog");

const COOKIE_NAME = "rh_device";
const IDLE_DAYS = 90;
const IDLE_MS = IDLE_DAYS * 24 * 60 * 60 * 1000;
// Oldest devices beyond this many per admin are dropped when a new one is added.
const MAX_PER_ADMIN = 10;

const COOKIE_RE = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function pwFingerprint(admin) {
  return sha256("pw:" + String((admin && admin.password) || ""));
}

// undefined = no cookie at all; null = a cookie that isn't ours/well-formed.
function readCookie(req) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return undefined;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    let raw = part.slice(eq + 1).trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const m = COOKIE_RE.exec(raw);
    return m ? { id: m[1], token: m[2] } : null;
  }
  return undefined;
}

// `strict` like the session cookie: a link from another site never signs the
// admin in, so a remembered device adds no cross-site request risk.
function cookieOptions(req) {
  return {
    httpOnly: true,
    secure: !!req.secure,
    sameSite: "strict",
    path: "/",
  };
}

function setCookie(req, res, id, token) {
  res.cookie(COOKIE_NAME, `${id}.${token}`, {
    ...cookieOptions(req),
    maxAge: IDLE_MS,
  });
}

function clearCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

// A short readable name for the Settings list, e.g. "iPhone · Home Screen app".
function describeUserAgent(ua) {
  const s = String(ua || "");
  let device = "Unknown device";
  if (/iPhone/.test(s)) device = "iPhone";
  else if (/iPad/.test(s)) device = "iPad";
  else if (/Android/.test(s))
    device = /Mobile/.test(s) ? "Android phone" : "Android tablet";
  else if (/Macintosh|Mac OS X/.test(s)) device = "Mac";
  else if (/Windows/.test(s)) device = "Windows PC";
  else if (/Linux/.test(s)) device = "Linux";

  let browser = "";
  if (/EdgA?\/|EdgiOS\//.test(s)) browser = "Edge";
  else if (/CriOS\/|Chrome\//.test(s)) browser = "Chrome";
  else if (/FxiOS\/|Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s)) browser = "Safari";
  // An iOS Home Screen web app sends no "Safari/" token.
  else if (/iPhone|iPad/.test(s)) browser = "Home Screen app";
  return browser ? `${device} · ${browser}` : device;
}

function dbReady() {
  return mongoose.connection.readyState === 1;
}

function sameHash(storedHex, token) {
  const a = Buffer.from(String(storedHex || ""), "hex");
  const b = Buffer.from(sha256(token), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionAdmin(admin, viaTotp) {
  return {
    id: admin.id,
    username: admin.username,
    role: admin.role === "superadmin" ? "superadmin" : "admin",
    tfa: !!(admin.totpEnabled && viaTotp),
  };
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function save(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// Delete the device this browser's cookie points at, only if the secret
// matches (knowing a device id alone must not let anyone remove it).
async function deleteCookieDevice(req) {
  const parsed = readCookie(req);
  if (!parsed) return false;
  const doc = await TrustedDevice.findById(parsed.id);
  if (!doc || !sameHash(doc.tokenHash, parsed.token)) return false;
  await TrustedDevice.deleteOne({ _id: doc._id });
  return true;
}

// Called by the login routes once the password (and 2FA code, when on) has
// passed. Never throws — a failure just means the device isn't remembered.
async function rememberDevice(req, res, admin, { viaTotp = false } = {}) {
  try {
    // Re-ticking the box on an already-remembered browser replaces its row.
    await deleteCookieDevice(req).catch(() => {});

    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const ua = String(req.get("user-agent") || "");
    const doc = await TrustedDevice.create({
      adminId: admin.id,
      tokenHash: sha256(token),
      pwFingerprint: pwFingerprint(admin),
      viaTotp: !!viaTotp,
      label: describeUserAgent(ua),
      userAgent: ua.slice(0, 300),
      createdIp: req.ip || "",
      lastIp: req.ip || "",
      lastUsedAt: new Date(now),
      expiresAt: new Date(now + IDLE_MS),
    });

    const extra = await TrustedDevice.find({ adminId: admin.id })
      .sort({ lastUsedAt: -1 })
      .skip(MAX_PER_ADMIN)
      .select("_id")
      .lean();
    if (extra.length) {
      await TrustedDevice.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
    }

    setCookie(req, res, doc._id.toString(), token);
    systemLog.logEvent({
      category: "auth",
      action: "trusted_device_added",
      actor: "admin:" + admin.id,
      subject: doc.label,
      meta: { ip: req.ip, deviceId: doc._id.toString() },
    });
    return true;
  } catch (err) {
    console.error("rememberDevice error:", err.message);
    return false;
  }
}

// Checks a cookie against the store. Returns { admin, doc } on success, or
// null when the cookie is definitely no good (caller clears it). Database
// errors throw, so a hiccup never wipes a good cookie.
async function verifyCookie(parsed, req) {
  const doc = await TrustedDevice.findById(parsed.id);
  if (!doc) return null;
  if (!sameHash(doc.tokenHash, parsed.token)) return null;

  const now = Date.now();
  const admin = admins.getAdminById(doc.adminId);
  const stale =
    !admin ||
    !doc.expiresAt ||
    new Date(doc.expiresAt).getTime() <= now ||
    doc.pwFingerprint !== pwFingerprint(admin) ||
    (admin.totpEnabled && !doc.viaTotp);
  if (stale) {
    await TrustedDevice.deleteOne({ _id: doc._id });
    return null;
  }

  await TrustedDevice.updateOne(
    { _id: doc._id },
    {
      $set: {
        lastUsedAt: new Date(now),
        lastIp: req.ip || "",
        expiresAt: new Date(now + IDLE_MS),
      },
    },
  );
  return { admin, doc };
}

// Express middleware, mounted right after the session middleware.
async function restoreTrustedSession(req, res, next) {
  try {
    if (!req.session || req.session.admin) return next();
    const parsed = readCookie(req);
    if (parsed === undefined) return next();
    if (parsed === null) {
      clearCookie(req, res);
      return next();
    }
    if (!dbReady()) return next();

    const hit = await verifyCookie(parsed, req);
    if (!hit) {
      clearCookie(req, res);
      return next();
    }

    await regenerate(req);
    req.session.admin = sessionAdmin(hit.admin, hit.doc.viaTotp);
    await save(req);
    // Refresh the cookie's own lifetime to match the pushed-forward expiry.
    setCookie(req, res, parsed.id, parsed.token);
    systemLog.logEvent({
      category: "auth",
      action: "trusted_device_login",
      actor: "admin:" + hit.admin.id,
      subject: hit.doc.label,
      meta: { ip: req.ip, deviceId: parsed.id },
    });
  } catch (err) {
    console.error("trusted device restore error:", err.message);
  }
  return next();
}

// Logout on this browser: forget the device and drop the cookie.
async function forgetCurrentDevice(req, res) {
  try {
    await deleteCookieDevice(req);
  } catch (err) {
    console.error("forgetCurrentDevice error:", err.message);
  }
  clearCookie(req, res);
}

async function listDevices(adminId, req) {
  const current = readCookie(req);
  const rows = await TrustedDevice.find({ adminId })
    .sort({ lastUsedAt: -1 })
    .lean();
  return rows.map((d) => ({
    id: d._id.toString(),
    label: d.label || "Unknown device",
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    lastIp: d.lastIp || "",
    expiresAt: d.expiresAt,
    current: !!(current && current.id === d._id.toString()),
  }));
}

async function removeDevice(adminId, deviceId, req, res) {
  if (!mongoose.isValidObjectId(deviceId)) return false;
  const r = await TrustedDevice.deleteOne({ _id: deviceId, adminId });
  const current = readCookie(req);
  if (current && current.id === String(deviceId)) clearCookie(req, res);
  return r.deletedCount > 0;
}

async function removeAllDevices(adminId, req, res) {
  const r = await TrustedDevice.deleteMany({ adminId });
  clearCookie(req, res);
  return r.deletedCount || 0;
}

module.exports = {
  COOKIE_NAME,
  IDLE_DAYS,
  rememberDevice,
  restoreTrustedSession,
  forgetCurrentDevice,
  listDevices,
  removeDevice,
  removeAllDevices,
  // exported for tests
  readCookie,
  describeUserAgent,
  pwFingerprint,
  sha256,
  verifyCookie,
};
