// Renter store — the auth + record layer for rented bot slots. Mongo-backed and
// completely separate from utils/admins.js (admins.json): renters never share a
// store, a session key, or a login endpoint with operator admins.
const bcrypt = require("bcrypt");

const Renter = require("../models/Renter");

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 8;

// Compared against when the username is unknown, so a missing account takes the
// same time as a wrong password (no username enumeration) — same trick as
// routes/adminAuthRoutes.js.
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8Diq1oV7l0nF1iJ9Z6Kx4z3qK4kHe";

function normUsername(u) {
  return String(u || "").trim();
}

// A lease is expired when accessEnd is set and in the past.
function isExpired(renter) {
  return !!(renter && renter.accessEnd && new Date(renter.accessEnd) <= new Date());
}

// A renter is blocked (no access, bot should be stopped) when suspended or
// expired. This is the single source of truth used by the middleware, the login
// route, and the expiry sweep.
function isBlocked(renter) {
  return !renter || renter.status === "suspended" || isExpired(renter);
}

// Public-safe view — never leaks the password hash.
function sanitizeRenter(renter) {
  if (!renter) return null;
  return {
    id: String(renter._id),
    username: renter.username,
    displayName: renter.displayName || "",
    status: renter.status,
    botHost: renter.botHost || "",
    botFile: renter.botFile || "",
    maxAccounts: Number(renter.maxAccounts) || 0,
    accessStart: renter.accessStart || null,
    accessEnd: renter.accessEnd || null,
    expired: isExpired(renter),
    blocked: isBlocked(renter),
    lastLoginAt: renter.lastLoginAt || null,
    notes: renter.notes || "",
    createdAt: renter.createdAt,
    updatedAt: renter.updatedAt,
  };
}

function getById(id) {
  return Renter.findById(id);
}

async function createRenter({
  username,
  password,
  displayName,
  botHost,
  botFile,
  maxAccounts,
  accessStart,
  accessEnd,
  notes,
  createdBy,
}) {
  username = normUsername(username);
  password = String(password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error(
      "Username must be 3–32 chars: letters, numbers, and . _ - only",
    );
  }
  if (password.length < MIN_PASSWORD) {
    throw new Error("Password must be at least " + MIN_PASSWORD + " characters");
  }
  const usernameLower = username.toLowerCase();
  if (await Renter.exists({ usernameLower })) {
    throw new Error("A renter with that username already exists");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const renter = await Renter.create({
    username,
    usernameLower,
    passwordHash,
    displayName: String(displayName || "").slice(0, 80),
    botHost: String(botHost || ""),
    botFile: String(botFile || ""),
    maxAccounts: Math.max(0, Math.floor(Number(maxAccounts) || 0)),
    accessStart: accessStart ? new Date(accessStart) : null,
    accessEnd: accessEnd ? new Date(accessEnd) : null,
    notes: String(notes || "").slice(0, 500),
    createdBy: String(createdBy || ""),
  });
  return renter;
}

// Verify a login. Always runs a bcrypt compare (real or dummy) so the response
// time doesn't reveal whether the username exists. Returns the renter doc on
// success, else null. Does NOT check the lease/suspension — the caller decides
// what to do with a blocked-but-valid login.
async function authenticate(username, password) {
  const usernameLower = normUsername(username).toLowerCase();
  const renter = usernameLower
    ? await Renter.findOne({ usernameLower })
    : null;
  const ok = await bcrypt.compare(
    String(password || ""),
    renter ? renter.passwordHash : DUMMY_HASH,
  );
  return renter && ok ? renter : null;
}

async function setPassword(id, password) {
  password = String(password || "");
  if (password.length < MIN_PASSWORD) {
    throw new Error("Password must be at least " + MIN_PASSWORD + " characters");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const renter = await Renter.findByIdAndUpdate(
    id,
    { $set: { passwordHash } },
    { new: true },
  );
  if (!renter) throw new Error("Renter not found");
  return renter;
}

module.exports = {
  MIN_PASSWORD,
  isExpired,
  isBlocked,
  sanitizeRenter,
  getById,
  createRenter,
  authenticate,
  setPassword,
};
