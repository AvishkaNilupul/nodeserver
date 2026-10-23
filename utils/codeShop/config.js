// Code shop settings (docs/code-shop/01-DATA.md).
//
// One Mongo document (`key: "main"`) holds only what the owner changed; the
// effective config is always deepMerge(DEFAULTS, doc.data), so a key added to
// DEFAULTS later reaches every install without a migration.
//
// Reads are memoised for `memoMs` and NEVER throw: the scheduler calls get() on
// every tick, and a database blip must not stop a tick — it falls back to the
// last config it read, or, before any good read, to SAFE_DEFAULTS: every
// switch that writes stock or talks to a market off (05-REVIEW-FIXES.md, R8).
//
// GGSel is not used for codes (R1): validatePatch refuses `markets.ggsel: true`
// and the effective config always reads it as false. PlayerAuctions is a code
// shop market since 2026-10-18 (06-PLAYERAUCTIONS-PLAN.md), off by default, at
// one fixed price for every bundle (`pricing.playerauctionsUsd`, never under
// PlayerAuctions' own $5 minimum).
//
// Writes go through validatePatch and are applied as one atomic $set of the
// patch's leaves ("data.digest.lastSentDay", ...), not a read-modify-write of
// the whole `data`: the digest and farm-priority jobs write the same document
// the owner edits from the panel, and neither may undo the other's change.

const KEY = "main";
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const GAME_KEY = /^\d+$/;
const MARKETS = ["eldorado", "ggsel", "playerauctions"];
const GGSEL_REFUSED = "GGSel is not used for codes yet: it never reports which code it sold, so a code could be sold twice";

// Bounds (inclusive) by setting name; every number is also finite and >= 0.
// PlayerAuctions refuses a trade under $5 (price x units per order, and the
// shop sells one unit per order).
const PA_MIN_USD = 5;
const RANGES = {
  hourUtc: { max: 23, int: true },
  expiryLeadHours: { max: 720 },
  cutPct: { max: 90 },
  playerauctionsUsd: { min: PA_MIN_USD, max: 500 },
};

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// Frozen so no caller can change the defaults for everyone else by accident;
// every config handed out is a fresh copy built by deepMerge.
const DEFAULTS = deepFreeze({
  autoBuildUnits: true, // grow stock of ACTIVE products from new codes
  autoDraft: true, // planner writes draft products
  autoPublish: false, // publish a ready draft without the owner
  expiryGuard: true,
  expiryLeadHours: 36,
  markets: { eldorado: true, ggsel: false, playerauctions: false },
  games: {
    // gameNo -> { sell, marketGame, displayName }; unknown games do not sell
    "12": { sell: true, marketGame: "Overwatch", displayName: "Overwatch 2" },
    "200": { sell: true, marketGame: "Delta Force", displayName: "Delta Force" },
    // Games only the CHZZK farm earns codes for (utils/codeShop/sources.js).
    // Listed so the owner can tick them; none sells until ticked.
    "910001": { sell: false, marketGame: "Call of Duty", displayName: "Call of Duty: Modern Warfare 4" },
    "910002": { sell: false, marketGame: "World of Warcraft", displayName: "World of Warcraft" },
    "910003": { sell: false, marketGame: "Stella Sora", displayName: "Stella Sora" },
    "910004": { sell: false, marketGame: "Once Human", displayName: "Once Human" },
    "910005": { sell: false, marketGame: "FC Online", displayName: "FC Online" },
  },
  // Where stored codes are read from. SOOP always; CHZZK can be switched off.
  sources: { chzzk: true },
  ready: { graceHours: 4, stallHours: 24, earlyListDays: 7 },
  drafts: { minUnits: 3, maxPerGroup: 2, leftovers: true },
  pricing: {
    clearanceSteps: [
      { days: 7, cutPct: 0 },
      { days: 3, cutPct: 25 },
      { days: 1, cutPct: 50 },
    ],
    cooldownHours: 6,
    undercutUsd: 0.01,
    // PlayerAuctions: one fixed price for every bundle (06-PLAYERAUCTIONS-PLAN C2).
    playerauctionsUsd: PA_MIN_USD,
  },
  // The games whose codes may sell on PlayerAuctions (06 plan, review): Overwatch.
  // Delta Force codes stop working within two weeks and PlayerAuctions has no
  // code market for them.
  playerauctionsGames: ["12"],
  competitorScan: { enabled: true, everyHours: 12 },
  ownEldoradoUserIds: [],
  sourceWords: ["soop", "afreeca", "korea", "\\bkr\\b", "translated", "official [^.\\n]*event", "stage\\s*\\d", "kakao", "chzzk", "naver"],
  claimAlert: { enabled: true, leadHours: 24 },
  digest: { enabled: true, hourUtc: 3, lastSentDay: "" },
  farmPriority: { enabled: false, botIds: [], minHoursBetween: 6, lastChangeAt: null },
});

// What get() hands out before it has ever read the settings: nothing that
// writes stock, publishes, reprices, reads a market or sends a summary runs
// on a guess. expiryGuard stays on — it only ever takes stock OFF sale.
const SAFE_DEFAULTS = deepFreeze(
  deepMerge(DEFAULTS, {
    autoBuildUnits: false,
    autoDraft: false,
    autoPublish: false,
    expiryGuard: true,
    markets: { eldorado: false, ggsel: false, playerauctions: false },
    competitorScan: { enabled: false },
    claimAlert: { enabled: false },
    digest: { enabled: false },
    farmPriority: { enabled: false },
  }),
);

// Shape of one `games` entry and one `pricing.clearanceSteps` element.
const GAME_SHAPE = { sell: false, marketGame: "", displayName: "" };
const STEP_SHAPE = { days: 0, cutPct: 0 };

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v instanceof Date) return new Date(v.getTime());
  if (isPlainObject(v)) return deepMerge({}, v);
  return v;
}

// New object: plain objects merge key by key, everything else in `patch`
// (arrays, Dates, scalars, null) replaces. Neither input is touched, nothing
// shares a reference with them, `undefined` in the patch is "no change", and
// prototype keys are dropped so a JSON body cannot pollute Object.prototype.
function deepMerge(base, patch) {
  const out = {};
  if (isPlainObject(base)) {
    for (const k of Object.keys(base)) if (!BLOCKED_KEYS.has(k)) out[k] = cloneValue(base[k]);
  }
  if (!isPlainObject(patch)) return out;
  for (const k of Object.keys(patch)) {
    if (BLOCKED_KEYS.has(k)) continue;
    const v = patch[k];
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : cloneValue(v);
  }
  return out;
}

// --- validation ------------------------------------------------------------

function isValidDateValue(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime());
  if (typeof v === "number") return Number.isFinite(v) && v >= 0;
  if (typeof v === "string") return v.trim() !== "" && Number.isFinite(Date.parse(v));
  return false;
}

function checkNumber(v, path, name, errors) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    errors.push(`${path}: must be a number >= 0`);
    return;
  }
  const r = RANGES[name];
  if (!r) return;
  if (r.int && !Number.isInteger(v)) errors.push(`${path}: must be a whole number`);
  if (v > r.max || v < (r.min || 0)) errors.push(`${path}: must be between ${r.min || 0} and ${r.max}`);
}

function checkStringList(v, path, errors, { regex = false } = {}) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be a list`);
    return;
  }
  v.forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (typeof s !== "string" || s === "") {
      errors.push(`${p}: must be a non-empty text`);
      return;
    }
    if (regex) {
      try {
        new RegExp(s, "i");
      } catch (err) {
        errors.push(`${p}: not a valid pattern (${err.message})`);
      }
    }
  });
}

function checkObject(value, shape, path, errors) {
  for (const k of Object.keys(value)) {
    const p = path ? `${path}.${k}` : k;
    if (BLOCKED_KEYS.has(k) || !hasOwn(shape, k)) {
      errors.push(path === "markets" ? `${p}: only ${MARKETS.join(", ")} can be set` : `${p}: unknown setting`);
      continue;
    }
    checkValue(value[k], shape[k], p, k, errors);
  }
}

function checkGames(v, path, errors) {
  if (!isPlainObject(v)) {
    errors.push(`${path}: must be an object of game numbers`);
    return;
  }
  for (const gameNo of Object.keys(v)) {
    const p = `${path}.${gameNo}`;
    if (!GAME_KEY.test(gameNo)) {
      errors.push(`${p}: game keys must be game numbers (digits only)`);
      continue;
    }
    if (!isPlainObject(v[gameNo])) {
      errors.push(`${p}: must be an object { sell, marketGame, displayName }`);
      continue;
    }
    checkObject(v[gameNo], GAME_SHAPE, p, errors);
  }
}

function checkSteps(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be a list`);
    return;
  }
  v.forEach((step, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(step)) {
      errors.push(`${p}: must be an object { days, cutPct }`);
      return;
    }
    // A list replaces the old one whole, so every step must be complete.
    for (const k of Object.keys(STEP_SHAPE)) if (!hasOwn(step, k)) errors.push(`${p}.${k}: is required`);
    checkObject(step, STEP_SHAPE, p, errors);
  });
}

function checkValue(v, def, path, name, errors) {
  if (path === "markets.ggsel" && v === true) {
    errors.push(`${path}: ${GGSEL_REFUSED}`);
    return;
  }
  if (path === "games") return checkGames(v, path, errors);
  if (path === "pricing.clearanceSteps") return checkSteps(v, path, errors);
  if (path === "sourceWords") return checkStringList(v, path, errors, { regex: true });
  if (path === "playerauctionsGames") {
    checkStringList(v, path, errors);
    if (Array.isArray(v)) v.forEach((g, i) => typeof g === "string" && g && !GAME_KEY.test(g) && errors.push(`${path}[${i}]: must be a game number (digits only)`));
    return;
  }
  if (Array.isArray(def)) return checkStringList(v, path, errors); // ownEldoradoUserIds, farmPriority.botIds
  if (def === null) {
    // farmPriority.lastChangeAt: a moment (Date, epoch ms or date text) or null
    if (v !== null && !isValidDateValue(v)) errors.push(`${path}: must be a date or null`);
    return;
  }
  if (typeof def === "boolean") {
    if (typeof v !== "boolean") errors.push(`${path}: must be true or false`);
    return;
  }
  if (typeof def === "number") return checkNumber(v, path, name, errors);
  if (typeof def === "string") {
    if (typeof v !== "string") errors.push(`${path}: must be text`);
    return;
  }
  if (isPlainObject(def)) {
    if (!isPlainObject(v)) errors.push(`${path}: must be an object`);
    else checkObject(v, def, path, errors);
  }
}

// Pure. `{ ok, errors[] }`; every error names the setting's path.
function validatePatch(patch) {
  const errors = [];
  if (!isPlainObject(patch)) return { ok: false, errors: ["settings patch must be an object"] };
  checkObject(patch, DEFAULTS, "", errors);
  return { ok: errors.length === 0, errors };
}

// --- store -------------------------------------------------------------------

// Mongoose queries are lean()-ed; a test fake may hand back a plain promise.
function leanOf(q) {
  return q && typeof q.lean === "function" ? q.lean() : q;
}

function isDuplicateKey(err) {
  return !!err && (err.code === 11000 || err.code === 11001);
}

// Patch leaves as one $set ("data.a.b": value). Plain objects recurse (so a
// partial object keeps its siblings); arrays and scalars replace. A moment
// setting (default null) is stored as a Date so `now - lastChangeAt` works.
function flattenInto(patch, shape, prefix, out) {
  for (const k of Object.keys(patch)) {
    if (BLOCKED_KEYS.has(k)) continue;
    const v = patch[k];
    if (v === undefined) continue;
    const p = `${prefix}.${k}`;
    const sub = prefix === "data.games" ? GAME_SHAPE : shape && hasOwn(shape, k) ? shape[k] : undefined;
    if (isPlainObject(v)) flattenInto(v, sub, p, out);
    else if (sub === null && v !== null) out[p] = new Date(v instanceof Date ? v.getTime() : v);
    else out[p] = cloneValue(v);
  }
  return out;
}

// The config a stored document makes: DEFAULTS under the owner's changes,
// with GGSel off whatever was stored before R1.
function effective(data) {
  const value = deepMerge(DEFAULTS, data);
  if (!isPlainObject(value.markets)) value.markets = deepMerge(DEFAULTS.markets, null);
  value.markets.ggsel = false;
  return value;
}

function createConfig({ model, now = Date.now, memoMs = 30000 } = {}) {
  // Resolved on first use so a test can pass its own model and the real one
  // never has to load.
  const getModel = () => model || (model = require("../../models/CodeShopConfig"));
  const ttl = Math.max(0, Number(memoMs) || 0);

  let memo = null; // { value, at }
  let lastGood = null;
  let generation = 0; // bumped by forget()/set() so an older in-flight read cannot re-memo stale data
  let lastErrorLogAt = -Infinity;

  function remember(value) {
    memo = { value, at: now() };
    lastGood = value;
    return value;
  }

  async function get({ fresh = false } = {}) {
    const t = now();
    if (!fresh && memo && t - memo.at < ttl) return memo.value;
    const gen = generation;
    try {
      const doc = await leanOf(getModel().findOne({ key: KEY }));
      const value = effective(doc && doc.data);
      if (gen === generation) return remember(value);
      lastGood = value;
      return value;
    } catch (err) {
      // One line per memo window, not one per caller, while the DB is down.
      if (t - lastErrorLogAt >= ttl) {
        lastErrorLogAt = t;
        console.error("[code-shop] config read failed, using " + (lastGood ? "last good" : "safe defaults (every switch off)") + ": " + (err && err.message));
      }
      return lastGood || deepMerge(SAFE_DEFAULTS, null);
    }
  }

  function forget() {
    generation += 1;
    memo = null;
  }

  async function set(patch, { actor = "" } = {}) {
    const check = validatePatch(patch);
    if (!check.ok) {
      const err = new Error("Invalid code shop settings: " + check.errors.join("; "));
      err.status = 400;
      err.errors = check.errors;
      throw err;
    }
    const $set = flattenInto(patch, DEFAULTS, "data", {});
    $set.updatedBy = String(actor || "").slice(0, 200);
    $set.updatedAt = new Date(now());

    forget();
    let doc = null;
    // Two first-ever writes can race on the upsert; the loser retries as an update.
    for (let attempt = 0; ; attempt += 1) {
      try {
        doc = await leanOf(getModel().findOneAndUpdate({ key: KEY }, { $set }, { upsert: true, returnDocument: "after" }));
        break;
      } catch (err) {
        if (attempt === 0 && isDuplicateKey(err)) continue;
        throw err;
      }
    }
    forget();
    return remember(effective(doc && doc.data));
  }

  return { get, set, forget };
}

// May this game's codes sell on PlayerAuctions? (settings: playerauctionsGames)
function paAllowsGame(cfg, gameNo) {
  const list = cfg && Array.isArray(cfg.playerauctionsGames) ? cfg.playerauctionsGames.map(String) : [];
  return gameNo !== undefined && gameNo !== null && list.includes(String(gameNo));
}

// A product's markets for its game: PlayerAuctions only for a game allowed there.
function marketsForGame(markets, gameNo, cfg) {
  return (Array.isArray(markets) ? markets : []).filter((m) => m !== "playerauctions" || paAllowsGame(cfg, gameNo));
}

module.exports = { DEFAULTS, SAFE_DEFAULTS, GGSEL_REFUSED, PA_MIN_USD, createConfig, validatePatch, deepMerge, paAllowsGame, marketsForGame };
