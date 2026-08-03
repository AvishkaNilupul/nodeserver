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
  // Multi-market auto-listing categories.
  // Plati (Digiseller) cataloguer placement for Twitch-drop accounts:
  //   Digital Goods and Access > Services and social networks > Twitch,
  //   with the required "Content type" attribute = "Twitch Drops Accounts".
  //   Category 34187 + attribute 91328->183570 lands products in the
  //   plati.market storefront section 203508 (verified live 2026-07-28).
  //   GOTCHA: 203508 is the STOREFRONT section id, NOT a cataloguer id — the
  //   create API rejects it ("category 203508 does not exist"). The cataloguer
  //   id is 34187 and it REQUIRES the Content-type attribute below, or the
  //   create fails "marketplace-1: you can not add goods".
  // GGSel picks per game automatically; this is only a manual override.
  platiCategoryId: "34187",
  platiAttributes: [{ attributeId: 91328, attributeValueId: 183570 }],
  ggselCategoryId: "",
  // ZeusX auto-listing. Off unless the owner turns it on; a game only
  // lists when zeusxGames has its category, e.g.
  //   { overwatch: { serviceCategoryId: "1", serviceCategoryBaseId: "269" } }
  zeusxAuto: false,
  zeusxGames: {},
  // RAM saver (Raspberry Pi): pack new accounts into free seats of already-
  // running auto-bots (per-account FavouriteGames) before creating another
  // container, and delete a bot's container+compose service once its campaign
  // ends and no other task shares it (config is renamed, never deleted, so
  // tokens survive; accounts return to the pool for the next event).
  consolidate: true,
  deleteFinishedBots: true,
  // Park a running bot once every one of its accounts has finished its
  // ASSIGNED games (utils/farmCompletion.js), instead of waiting for the
  // campaign to expire — accounts finish drops in hours but campaigns run for
  // weeks, so the container idles fully paid-for in between. Measured on prod
  // 2026-07-29: 15 of 35 running containers were in exactly that state, about
  // 2 GB of RAM held by bots with nothing left to do.
  //
  // ON by default. The verdict is deliberately hard to obtain — it refuses
  // while any account is unscanned, stale (>6h), still working or not yet
  // started, when the config names no games at all, and when a campaign for one
  // of its games started after the scan the verdict rests on. Waking is NOT
  // gated by this and always runs — see utils/botWaker.js.
  stopFinishedBots: true,
  // Stock floor: keep at least this many sellable accounts per ENABLED market
  // (gameflip + plati + ggsel). The planner doubles it so the 50% post-event
  // holdback stays intact. 3 markets x 3 x 2 = 18 accounts on a full-market
  // game - the pool (180+ ready) supports this comfortably.
  perMarketStock: 3,
  // Recycle sold-out accounts back into farming. OFF by default (opt-in): a
  // sold account's login:password is in the buyer's hands, so it is only reused
  // once it is fully spent, every drop the buyer bought is connected, the
  // cooldown has passed AND a fresh rescan confirms the token still works (a
  // buyer who changed the password fails the rescan and is skipped, never
  // recycled). See utils/recycleEligibility.js + recycleSoldOutAccounts.
  recycleSoldAccounts: false,
  recycleCooldownDays: 14,
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
  const out = { ...AUTO_FARM_DEFAULTS, ...cur };
  // A saved empty Plati category means "use the default" — Plati's Twitch
  // drops section is fixed, so blank should never silently disable Plati.
  if (!out.platiCategoryId)
    out.platiCategoryId = AUTO_FARM_DEFAULTS.platiCategoryId;
  return out;
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
