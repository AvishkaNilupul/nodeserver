// Tiny JSON-backed settings store for small site-wide flags (currently just the
// "require two-factor for all admins" switch). Kept separate from admins.json so
// toggling a setting never rewrites credential data.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const settingsFile = path.join(__dirname, "settings.json");

const AUTO_FARM_DEFAULTS = {
  enabled: false, // master switch — ships OFF
  dryRun: true, // plan + alert only until the owner flips this off
  hostId: "", // which host auto-bots run on (empty = auto-pick first SSH host, i.e. the Pi)
  maxPerGame: 30, // hard cap of accounts spent on one game (user requirement)
  accountsPerBot: 10, // accounts per container
  poolReserve: 20, // never draw the pool below this many ready accounts
  probeSize: 5, // batch size for unknown games (market test)
  maxAutoBots: 20, // max auto containers on the host at once (total supply is
  // gated by the pool + reserve, NOT by this — raise it if the Pi can handle more)
  minHoursLeft: 12, // skip campaigns ending sooner than this
  // Multi-market auto-listing. Plati needs a cataloguer category id (owner 1
  // on Digiseller) — pick one in Shop > Listings once and paste it here.
  // GGSel: leave empty to copy the category from your newest live offer.
  platiCategoryId: "",
  ggselCategoryId: "",
};

const DEFAULTS = { require2fa: false, autoFarm: AUTO_FARM_DEFAULTS };

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

// autoFarm block accessors. Deep-merged over defaults so a settings.json
// written before a new knob existed still yields every field.
function getAutoFarm() {
  const s = loadSettings();
  const cur = s.autoFarm && typeof s.autoFarm === "object" ? s.autoFarm : {};
  return { ...AUTO_FARM_DEFAULTS, ...cur };
}

async function setAutoFarm(patch) {
  const s = loadSettings();
  const cur = s.autoFarm && typeof s.autoFarm === "object" ? s.autoFarm : {};
  s.autoFarm = { ...AUTO_FARM_DEFAULTS, ...cur, ...(patch || {}) };
  await saveSettings(s);
  return s.autoFarm;
}

module.exports = {
  loadSettings,
  saveSettings,
  getRequire2fa,
  setRequire2fa,
  getAutoFarm,
  setAutoFarm,
};
