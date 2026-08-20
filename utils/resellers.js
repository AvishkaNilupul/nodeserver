const bcrypt = require("bcrypt");
const Reseller = require("../models/Reseller");
const { encrypt, decrypt } = require("./secretBox");

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 8;
// The reseller console is operated in Japan and its HTML date inputs contain
// calendar dates without a timezone. JavaScript otherwise parses YYYY-MM-DD
// as UTC, which makes a selected start date begin at 09:00 JST. Keep the
// operator-facing lease window aligned with the calendar shown in the UI.
const ACCESS_UTC_OFFSET_MINUTES = 9 * 60;
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8Diq1oV7l0nF1iJ9Z6Kx4z3qK4kHe";

function normUsername(username) {
  return String(username || "").trim();
}

function parseAccessDate(value, { endOfDay = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (Number.isNaN(copy.getTime())) throw new Error("Invalid access date");
    return copy;
  }

  const text = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let parsed;
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
    parsed = new Date(utcMs - ACCESS_UTC_OFFSET_MINUTES * 60 * 1000);
  } else {
    parsed = new Date(text);
  }

  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid access date");
  return parsed;
}

function isBeforeStart(reseller, now = new Date()) {
  return !!(
    reseller?.accessStart && new Date(reseller.accessStart) > new Date(now)
  );
}
function isExpired(reseller, now = new Date()) {
  return !!(
    reseller?.accessEnd && new Date(reseller.accessEnd) <= new Date(now)
  );
}
function isBlocked(reseller, now = new Date()) {
  return (
    !reseller ||
    reseller.status === "suspended" ||
    isBeforeStart(reseller, now) ||
    isExpired(reseller, now)
  );
}

function sanitizeReseller(reseller, { includeNotes = false } = {}) {
  if (!reseller) return null;
  const safe = {
    id: String(reseller._id),
    username: reseller.username,
    displayName: reseller.displayName || "",
    status: reseller.status,
    maxAccounts: Number(reseller.maxAccounts) || 0,
    accessStart: reseller.accessStart || null,
    accessEnd: reseller.accessEnd || null,
    notStarted: isBeforeStart(reseller),
    expired: isExpired(reseller),
    blocked: isBlocked(reseller),
    lastLoginAt: reseller.lastLoginAt || null,
    createdAt: reseller.createdAt,
    updatedAt: reseller.updatedAt,
  };
  if (includeNotes) safe.notes = reseller.notes || "";
  return safe;
}

function getById(id) {
  return Reseller.findById(id);
}

async function createReseller({
  username,
  password,
  displayName,
  notes,
  status,
  maxAccounts,
  accessStart,
  accessEnd,
  createdBy,
}) {
  username = normUsername(username);
  password = String(password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username))
    throw new Error(
      "Username must be 3-32 chars: letters, numbers, and . _ - only",
    );
  if (password.length < MIN_PASSWORD)
    throw new Error(
      "Password must be at least " + MIN_PASSWORD + " characters",
    );
  const usernameLower = username.toLowerCase();
  if (await Reseller.exists({ usernameLower }))
    throw new Error("A reseller with that username already exists");
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return Reseller.create({
    username,
    usernameLower,
    passwordHash,
    passwordEnc: encrypt(password),
    displayName: String(displayName || "").slice(0, 80),
    notes: String(notes || "").slice(0, 500),
    status: status === "suspended" ? "suspended" : "active",
    maxAccounts: Math.max(0, Math.floor(Number(maxAccounts) || 0)),
    accessStart: parseAccessDate(accessStart),
    accessEnd: parseAccessDate(accessEnd, { endOfDay: true }),
    createdBy: String(createdBy || ""),
  });
}

async function authenticate(username, password) {
  const usernameLower = normUsername(username).toLowerCase();
  const reseller = usernameLower
    ? await Reseller.findOne({ usernameLower })
    : null;
  const ok = await bcrypt.compare(
    String(password || ""),
    reseller ? reseller.passwordHash : DUMMY_HASH,
  );
  return reseller && ok ? reseller : null;
}

async function setPassword(id, password) {
  password = String(password || "");
  if (password.length < MIN_PASSWORD)
    throw new Error(
      "Password must be at least " + MIN_PASSWORD + " characters",
    );
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const reseller = await Reseller.findByIdAndUpdate(
    id,
    { $set: { passwordHash, passwordEnc: encrypt(password) } },
    { new: true },
  );
  if (!reseller) throw new Error("Reseller not found");
  return reseller;
}

function revealPassword(reseller) {
  if (!reseller?.passwordEnc) return "";
  try {
    return decrypt(reseller.passwordEnc) || "";
  } catch {
    return "";
  }
}

module.exports = {
  MIN_PASSWORD,
  ACCESS_UTC_OFFSET_MINUTES,
  normUsername,
  parseAccessDate,
  isBeforeStart,
  isExpired,
  isBlocked,
  sanitizeReseller,
  getById,
  createReseller,
  authenticate,
  setPassword,
  revealPassword,
};
