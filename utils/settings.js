// Tiny JSON-backed settings store for small site-wide flags (currently just the
// "require two-factor for all admins" switch). Kept separate from admins.json so
// toggling a setting never rewrites credential data.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const settingsFile = path.join(__dirname, "settings.json");

const DEFAULTS = { require2fa: false };

function loadSettings() {
  try {
    const obj = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    return { ...DEFAULTS, ...(obj && typeof obj === "object" ? obj : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(settings) {
  const text = JSON.stringify({ ...DEFAULTS, ...settings }, null, 2);
  const tmp = settingsFile + ".tmp-" + process.pid;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, settingsFile);
}

function getRequire2fa() {
  return !!loadSettings().require2fa;
}

async function setRequire2fa(value) {
  const s = loadSettings();
  s.require2fa = !!value;
  await saveSettings(s);
  return s.require2fa;
}

module.exports = { loadSettings, saveSettings, getRequire2fa, setRequire2fa };
