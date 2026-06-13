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

// Public-safe view of an admin (never expose the password hash).
function sanitizeAdmin(admin) {
  return { id: admin.id, username: admin.username, role: admin.role };
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

module.exports = {
  ROLES,
  loadAdmins,
  saveAdmins,
  sanitizeAdmin,
  addAdmin,
  updateAdmin,
  deleteAdmin,
};
