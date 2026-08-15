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
  // Games that CANNOT be sold via the normal click-claim-then-sell flow
  // (Overwatch, Rainbow Six): the auto-farmer must NOT farm OR list them — they
  // are handled by the standalone no-claim farming system instead. These are
  // loose keywords matched as a SUBSTRING of the normalised game label (see
  // isNoClaimGame), so "overwatch" also catches "Overwatch 2" and "rainbow six"
  // catches "Tom Clancy's Rainbow Six Siege". Editable from that tab.
  noClaimGames: ["overwatch", "rainbow six"],
  // Suspended-account retirement (utils/suspendedAccounts.js). Classifying and
  // releasing runs every tick and is reversible, so it has no switch; the
  // permanent delete does, and ships OFF. Turning it on removes every account
  // Twitch has deleted that is unsold and not on a listing, plus its drop rows.
  purgeSuspended: false,
  // Cap on how many bad-token accounts are re-probed per tick (0 = all). A first
  // sweep faces thousands of rows; a cap spreads them over several ticks.
  suspendCheckLimit: 0,
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
  // FunPay category ("node") per game, for market research only — FunPay has
  // no cross-game search, so a game is invisible there until its node is
  // known. The research scanner already learns nodes from our own FunPay
  // listings (each one records the node it was published to), so this is only
  // needed for games we have not published there yet.
  //   { "overwatch 2": "2430", "rainbow six siege": "1813" }
  funpayNodes: {},
  // ZeusX auto-listing. Off unless the owner turns it on; a game only
  // lists when zeusxGames has its category, e.g.
  //   { overwatch: { serviceCategoryId: "1", serviceCategoryBaseId: "269" } }
  zeusxAuto: false,
  zeusxGames: {},
  // Deliver ZeusX sales automatically (native "Automatic" delivery: the account
  // credential rides on the offer and ZeusX hands it to the buyer the instant
  // they pay). ZeusX only carries ONE credential per offer, so each farmed
  // account becomes its own single-stock listing. OFF => the legacy behaviour:
  // one "Coordinated" offer for the whole share, handed over by hand and marked
  // sold from the Drop Archive. Only matters when zeusxAuto is also on.
  zeusxAutoDeliver: false,
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
  // Reap dead-token accounts out of a task's assignedAccounts each tick so the
  // backfill sweep can refill the freed slots with healthy farmers (a dead
  // token can't farm, so left in place it silently pins the task at target and
  // it stops producing sellable stock). Only accounts holding NO drops for the
  // task's game are unassigned; ones that already farmed drops are kept and the
  // owner is nudged by Telegram to re-mint their token. Never deletes anything.
  // ON by default. See reapDeadTokenAssignments in utils/autoFarmer.js.
  reapDeadAssignments: true,
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

// Normalise a game label for tolerant comparison ("Rainbow Six Siege",
// "rainbow-six siege", "RainbowSix  Siege" all collapse to the same key).
function normGameName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// True when a game is on the no-claim list — i.e. it must be excluded from the
// normal auto-farmer's farm + list paths and handled by the standalone no-claim
// farming system instead. Single source of truth for both systems. Each entry
// is a keyword matched as a SUBSTRING of the normalised label, so "rainbow six"
// catches "Tom Clancy's Rainbow Six Siege" and "overwatch" catches "Overwatch 2".
function isNoClaimGame(game) {
  const list = getAutoFarm().noClaimGames || [];
  const g = normGameName(game);
  if (!g) return false;
  return list.some((x) => {
    const key = normGameName(x);
    return key && g.includes(key);
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  getRequire2fa,
  setRequire2fa,
  getAutoFarm,
  setAutoFarm,
  normGameName,
  isNoClaimGame,
};
