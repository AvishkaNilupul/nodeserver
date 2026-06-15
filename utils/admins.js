const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const adminsFile = path.join(__dirname, "admins.json");

const ROLES = ["admin", "superadmin"];
const BCRYPT_ROUNDS = 10;

function normalizeRole(role) {
  return role === "superadmin" ? "superadmin" : "admin";
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

  const admins = loadAdmins();
  if (findByUsername(admins, username)) {
    throw new Error("An admin with that username already exists");
  }

  const admin = {
    id: "admin_" + crypto.randomBytes(6).toString("hex"),
    username,
    password: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role: normalizeRole(role),
  };

  admins.push(admin);
  await saveAdmins(admins);
  return sanitizeAdmin(admin);
}

async function updateAdmin(id, { username, password, role }) {
  const admins = loadAdmins();
  const admin = admins.find((a) => a.id === id);
  if (!admin) {
    throw new Error("Admin not found");
  }

  if (username !== undefined) {
    username = String(username).trim();
    if (!username) {
      throw new Error("Username cannot be empty");
    }
    const clash = findByUsername(admins, username);
    if (clash && clash.id !== id) {
      throw new Error("An admin with that username already exists");
    }
    admin.username = username;
  }

  if (password !== undefined && password !== "") {
    if (String(password).length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    admin.password = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  }

  if (role !== undefined) {
    admin.role = normalizeRole(role);
  }

  await saveAdmins(admins);
  return sanitizeAdmin(admin);
}

async function deleteAdmin(id) {
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
}

// --- Two-factor (TOTP) helpers ---------------------------------------------

function getAdminById(id) {
  return loadAdmins().find((a) => a.id === id) || null;
}

// Store an encrypted secret as "pending" (enrolment started, not yet confirmed).
async function setTotpPending(id, encSecret) {
  const admins = loadAdmins();
  const admin = admins.find((a) => a.id === id);
  if (!admin) throw new Error("Admin not found");
  admin.totpPending = encSecret;
  await saveAdmins(admins);
}

// Confirm enrolment: promote the pending secret to active and store backup codes.
async function enableTotp(id, encSecret, backupHashes) {
  const admins = loadAdmins();
  const admin = admins.find((a) => a.id === id);
  if (!admin) throw new Error("Admin not found");
  admin.totpSecret = encSecret;
  admin.totpEnabled = true;
  admin.backupCodes = Array.isArray(backupHashes) ? backupHashes : [];
  delete admin.totpPending;
  await saveAdmins(admins);
  return sanitizeAdmin(admin);
}

// Turn off 2FA and wipe all related material.
async function disableTotp(id) {
  const admins = loadAdmins();
  const admin = admins.find((a) => a.id === id);
  if (!admin) throw new Error("Admin not found");
  admin.totpEnabled = false;
  delete admin.totpSecret;
  delete admin.totpPending;
  delete admin.backupCodes;
  await saveAdmins(admins);
  return sanitizeAdmin(admin);
}

// Consume (remove) a used backup code by index.
async function consumeBackupCode(id, index) {
  const admins = loadAdmins();
  const admin = admins.find((a) => a.id === id);
  if (!admin || !Array.isArray(admin.backupCodes)) return;
  admin.backupCodes.splice(index, 1);
  await saveAdmins(admins);
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
};
