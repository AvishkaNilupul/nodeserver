// Renter store — the auth + record layer for rented bot slots. Mongo-backed and
// completely separate from utils/admins.js (admins.json): renters never share a
// store, a session key, or a login endpoint with operator admins.
const bcrypt = require("bcrypt");

const Renter = require("../models/Renter");
const { encrypt, decrypt } = require("./secretBox");

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

// Normalise a games list (array or comma-separated string) into a clean,
// bounded string array — the shape stored on Renter.farmGames.
function normGames(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  return list
    .map((g) => String(g).trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((g) => g.slice(0, 100));
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

// An access START from the console's date input. A bare "YYYY-MM-DD" is the
// start of that calendar day in JST (the console is operated in Japan) — as UTC
// midnight it opened at 09:00 JST, and a renter told "from today" could not log
// in all morning. Anything else (a full timestamp, a Date) is taken as given.
// accessEnd keeps its own, older parse: existing leases are timed by it.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
function parseAccessStart(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS);
  return new Date(value);
}

// A lease that has not STARTED yet (accessStart in the future). The portal is
// closed until then; the bots are not touched by this (isBlocked is what the
// expiry sweep acts on, and it does not include it).
function notStarted(renter) {
  return !!(renter && renter.accessStart && new Date(renter.accessStart) > new Date());
}

// The internal holder renter every rent-farm ("Automatic Farming") sale is
// provisioned under (utils/operatorFarm.js OPERATOR_USERNAME). It is NOT a
// renter: its accounts are paid buyers spread over many stacks, so renter-level
// start / stop / suspend / delete / lease / bot changes must never touch it.
const OPERATOR_HOLDER_USERNAME = "operator-selffarm";
function isOperatorHolder(renter) {
  if (!renter) return false;
  const u = String(renter.usernameLower || renter.username || "").toLowerCase();
  return u === OPERATOR_HOLDER_USERNAME;
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
    farmGames: Array.isArray(renter.farmGames) ? renter.farmGames : [],
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

// The renter's OWN view of their record (portal): no operator notes, and no
// host / config file — those are the operator's business.
function portalRenter(renter) {
  if (!renter) return null;
  return {
    id: String(renter._id),
    username: renter.username,
    displayName: renter.displayName || "",
    status: renter.status,
    farmGames: Array.isArray(renter.farmGames) ? renter.farmGames : [],
    maxAccounts: Number(renter.maxAccounts) || 0,
    accessStart: renter.accessStart || null,
    accessEnd: renter.accessEnd || null,
    expired: isExpired(renter),
    blocked: isBlocked(renter),
    notStarted: notStarted(renter),
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
  farmGames,
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
    passwordEnc: encrypt(password),
    displayName: String(displayName || "").slice(0, 80),
    botHost: String(botHost || ""),
    botFile: String(botFile || ""),
    farmGames: normGames(farmGames),
    maxAccounts: Math.max(0, Math.floor(Number(maxAccounts) || 0)),
    accessStart: parseAccessStart(accessStart),
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

// Set (or reset) a renter's password — superadmin only, callers enforce that.
// Updates both the bcrypt hash (login) and the encrypted copy (operator view).
async function setPassword(id, password) {
  password = String(password || "");
  if (password.length < MIN_PASSWORD) {
    throw new Error("Password must be at least " + MIN_PASSWORD + " characters");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const renter = await Renter.findByIdAndUpdate(
    id,
    // The epoch bump ends every session opened with the old password.
    { $set: { passwordHash, passwordEnc: encrypt(password) }, $inc: { sessionEpoch: 1 } },
    { new: true },
  );
  if (!renter) throw new Error("Renter not found");
  return renter;
}

// Decrypt a renter's stored password for the operator to view. Returns "" for a
// renter created before viewable passwords existed (reset it to make it viewable).
function revealPassword(renter) {
  if (!renter || !renter.passwordEnc) return "";
  try {
    return decrypt(renter.passwordEnc) || "";
  } catch {
    return "";
  }
}

module.exports = {
  parseAccessStart,
  MIN_PASSWORD,
  normGames,
  isExpired,
  isBlocked,
  OPERATOR_HOLDER_USERNAME,
  isOperatorHolder,
  sanitizeRenter,
  getById,
  createRenter,
  authenticate,
  setPassword,
  revealPassword,
  notStarted,
  portalRenter,
};
