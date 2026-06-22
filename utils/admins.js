const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const adminsFile = path.join(__dirname, "admins.json");

const ROLES = ["admin", "superadmin"];
const BCRYPT_ROUNDS = 10;

// How long a generated Telegram link code stays valid before it must be
// regenerated (the admin has to open the bot and confirm within this window).
const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;

function normalizeRole(role) {
  return role === "superadmin" ? "superadmin" : "admin";
}

// Telegram usernames are case-insensitive and may be entered with a leading
// "@" or a full t.me link; normalise to the bare lowercase handle.
function normalizeTelegramUsername(username) {
  let u = String(username || "").trim();
  u = u.replace(/^https?:\/\/t\.me\//i, "");
  u = u.replace(/^@/, "");
  return u.toLowerCase();
}

function loadAdmins() {
  try {
    const list = JSON.parse(fs.readFileSync(adminsFile, "utf8"));
    if (!Array.isArray(list)) {
      return [];
    }
    // Default any legacy admin without a role to "admin".
    return list.map((a) => ({ ...a, role: normalizeRole(a.role) }));
  } catch (err) {
    console.error("loadAdmins error:", err.message);
    return [];
  }
}

async function saveAdmins(admins) {
  const text = JSON.stringify(admins, null, 2);
  const tmp = adminsFile + ".tmp-" + process.pid;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, adminsFile);
}

// Serialise every read-modify-write of admins.json. Without this, two
// overlapping writers (e.g. a purchase debit and a superadmin top-up) both load
// the same snapshot and the last save clobbers the other's change — silently
// losing a balance update. All mutating helpers run their load → mutate → save
// inside this single in-process queue so writes never interleave.
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive regardless of whether this task resolved or threw.
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Run `fn(admins)` against a freshly-loaded list and persist the result, all
// under the write lock. `fn` may mutate the array and return any value to pass
// back to the caller; it can throw to abort without saving.
function mutate(fn) {
  return withLock(async () => {
    const admins = loadAdmins();
    const result = await fn(admins);
    await saveAdmins(admins);
    return result;
  });
}

// Public-safe view of an admin (never expose the password hash or 2FA secret).
function sanitizeAdmin(admin) {
  return {
    id: admin.id,
    username: admin.username,
    role: admin.role,
    totpEnabled: !!admin.totpEnabled,
    backupCodesRemaining: Array.isArray(admin.backupCodes)
      ? admin.backupCodes.length
      : 0,
    telegramUsername: admin.telegramUsername || "",
    telegramLinked: !!admin.telegramChatId,
    balance: Number(admin.balance) || 0,
  };
}

function findByUsername(admins, username) {
  return admins.find(
    (a) => a.username.toLowerCase() === String(username).toLowerCase(),
  );
}

async function addAdmin({ username, password, role }) {
  username = String(username || "").trim();
  password = String(password || "");

  if (!username) {
    throw new Error("Username is required");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return mutate((admins) => {
    if (findByUsername(admins, username)) {
      throw new Error("An admin with that username already exists");
    }
    const admin = {
      id: "admin_" + crypto.randomBytes(6).toString("hex"),
      username,
      password: hash,
      role: normalizeRole(role),
    };
    admins.push(admin);
    return sanitizeAdmin(admin);
  });
}

async function updateAdmin(id, { username, password, role }) {
  // Hash outside the lock (bcrypt is slow) so we don't hold up other writers.
  let newHash = null;
  if (password !== undefined && password !== "") {
    if (String(password).length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    newHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  }
  const nextUsername =
    username !== undefined ? String(username).trim() : undefined;
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) {
      throw new Error("Admin not found");
    }
    if (nextUsername !== undefined) {
      if (!nextUsername) {
        throw new Error("Username cannot be empty");
      }
      const clash = findByUsername(admins, nextUsername);
      if (clash && clash.id !== id) {
        throw new Error("An admin with that username already exists");
      }
      admin.username = nextUsername;
    }
    if (newHash) admin.password = newHash;
    if (role !== undefined) admin.role = normalizeRole(role);
    return sanitizeAdmin(admin);
  });
}

async function deleteAdmin(id) {
  return withLock(async () => {
    const admins = loadAdmins();
    const admin = admins.find((a) => a.id === id);
    if (!admin) {
      throw new Error("Admin not found");
    }
    const remaining = admins.filter((a) => a.id !== id);
    // Never allow deleting the last superadmin (would lock everyone out).
    if (
      admin.role === "superadmin" &&
      !remaining.some((a) => a.role === "superadmin")
    ) {
      throw new Error("Cannot delete the only superadmin");
    }
    await saveAdmins(remaining);
    return sanitizeAdmin(admin);
  });
}

// --- Two-factor (TOTP) helpers ---------------------------------------------

function getAdminById(id) {
  return loadAdmins().find((a) => a.id === id) || null;
}

// Store an encrypted secret as "pending" (enrolment started, not yet confirmed).
async function setTotpPending(id, encSecret) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    admin.totpPending = encSecret;
  });
}

// Confirm enrolment: promote the pending secret to active and store backup codes.
async function enableTotp(id, encSecret, backupHashes) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    admin.totpSecret = encSecret;
    admin.totpEnabled = true;
    admin.backupCodes = Array.isArray(backupHashes) ? backupHashes : [];
    delete admin.totpPending;
    return sanitizeAdmin(admin);
  });
}

// Turn off 2FA and wipe all related material.
async function disableTotp(id) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    admin.totpEnabled = false;
    delete admin.totpSecret;
    delete admin.totpPending;
    delete admin.backupCodes;
    return sanitizeAdmin(admin);
  });
}

// Consume (remove) a used backup code by index.
async function consumeBackupCode(id, index) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin || !Array.isArray(admin.backupCodes)) return;
    admin.backupCodes.splice(index, 1);
  });
}

// --- Telegram linking -------------------------------------------------------
//
// Each admin can link a personal Telegram chat so notifications for the orders
// they created are delivered to them. A bot can't message a user by @username
// (the Bot API only sends to a numeric chat_id, and the user must have messaged
// the bot first), so linking is a two-step "confirm in Telegram" flow: we
// generate a short code, the admin sends it to the bot (via a deep link or
// /link <code>), and the bot listener captures their chat_id.

// Save the @username the admin typed in. Purely for display/identification —
// the chat_id captured at confirm time is what actually receives messages.
async function setTelegramUsername(id, username) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    admin.telegramUsername = normalizeTelegramUsername(username);
    return sanitizeAdmin(admin);
  });
}

// Begin linking: generate a fresh code bound to this admin and return it. The
// admin then confirms it inside Telegram so we can capture their chat_id.
async function startTelegramLink(id) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    admin.telegramLinkCode = code;
    admin.telegramLinkExpires = Date.now() + TELEGRAM_LINK_TTL_MS;
    return code;
  });
}

// Confirm a link from an incoming Telegram message. Finds the admin whose
// pending code matches (case-insensitively, and not expired), stores their
// chat_id, and clears the pending code. Returns the linked admin or null when
// no valid pending code matches.
async function linkTelegramByCode(code, chatId, fromUsername) {
  const wanted = String(code || "")
    .trim()
    .toUpperCase();
  if (!wanted || chatId === undefined || chatId === null) return null;

  return mutate((admins) => {
    const admin = admins.find(
      (a) =>
        a.telegramLinkCode &&
        a.telegramLinkCode.toUpperCase() === wanted &&
        typeof a.telegramLinkExpires === "number" &&
        a.telegramLinkExpires > Date.now(),
    );
    if (!admin) return null;
    admin.telegramChatId = String(chatId);
    if (fromUsername && !admin.telegramUsername) {
      admin.telegramUsername = normalizeTelegramUsername(fromUsername);
    }
    delete admin.telegramLinkCode;
    delete admin.telegramLinkExpires;
    return sanitizeAdmin(admin);
  });
}

// Remove the linked chat (and any pending code) so the admin stops receiving
// notifications until they link again.
async function unlinkTelegram(id) {
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    delete admin.telegramChatId;
    delete admin.telegramLinkCode;
    delete admin.telegramLinkExpires;
    return sanitizeAdmin(admin);
  });
}

// The linked chat_id for a seller, or null. Used when fanning out a
// notification to the admin who created an order.
function getTelegramChatId(id) {
  const admin = loadAdmins().find((a) => a.id === id);
  return admin && admin.telegramChatId ? String(admin.telegramChatId) : null;
}

// --- Wallet / balance -------------------------------------------------------
//
// Each admin has a spendable balance (in whatever currency unit the operator
// uses) held in admins.json. Superadmins top it up; the shop debits it on a
// purchase. Balances are plain numbers and never go negative.

function getBalance(id) {
  const admin = loadAdmins().find((a) => a.id === id);
  return admin ? Number(admin.balance) || 0 : 0;
}

// Apply a signed delta to an admin's balance atomically (load → mutate →
// save). Rejects a debit that would overdraw unless allowNegative is set.
// Returns the new balance.
async function adjustBalance(id, delta, { allowNegative = false } = {}) {
  const amount = Number(delta);
  if (!Number.isFinite(amount)) throw new Error("Invalid amount");
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    const current = Number(admin.balance) || 0;
    const next = current + amount;
    if (next < 0 && !allowNegative) {
      throw new Error("Insufficient balance");
    }
    admin.balance = Math.round(next * 100) / 100;
    return admin.balance;
  });
}

// Set an admin's balance to an exact value (superadmin override). Returns the
// public view of the updated admin.
async function setBalance(id, value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Invalid balance");
  }
  return mutate((admins) => {
    const admin = admins.find((a) => a.id === id);
    if (!admin) throw new Error("Admin not found");
    admin.balance = Math.round(amount * 100) / 100;
    return sanitizeAdmin(admin);
  });
}

module.exports = {
  ROLES,
  loadAdmins,
  saveAdmins,
  sanitizeAdmin,
  addAdmin,
  updateAdmin,
  deleteAdmin,
  getAdminById,
  setTotpPending,
  enableTotp,
  disableTotp,
  consumeBackupCode,
  normalizeTelegramUsername,
  setTelegramUsername,
  startTelegramLink,
  linkTelegramByCode,
  unlinkTelegram,
  getTelegramChatId,
  getBalance,
  adjustBalance,
  setBalance,
};
