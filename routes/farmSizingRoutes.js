// ---------------------------------------------------------------------------
// FLEET SIZING — the API behind "how many accounts should this game get?"
//
// Two systems, one question, and until now neither could answer it:
//
//   * the AUTO-FARM capped every game at maxPerGame*2 (60 on prod) no matter how
//     well it sold, so past ~15 sales a game's own success bought it nothing;
//   * the NO-CLAIM farm had no sizing at all — the account count was a number
//     typed into a form.
//
// These endpoints expose the coverage model (utils/farmSizing.js), the evidence
// behind it (utils/farmDemand.js) and the no-claim allocator
// (utils/unclaimedAllocator.js). Reads are free and always available; the one
// endpoint that spends accounts is POST /apply, and it dry-runs by default.
//
// Settings follow the declarative-table convention from unclaimedAutoRoutes:
// one table maps each raw autoFarm key to [type, min, max, integer, alias], and
// a generic validator returns { patch, ignored, errors } so an unknown key is
// reported rather than silently dropped.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const settings = require("../utils/settings");
const farmDemand = require("../utils/farmDemand");
const farmSizing = require("../utils/farmSizing");
const allocator = require("../utils/unclaimedAllocator");
const autoFarmer = require("../utils/autoFarmer");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const AutoFarmTask = require("../models/AutoFarmTask");

const router = express.Router();

// key: [type, min, max, integer, accessor alias]
const SIZING_KEYS = {
  coverageSizing: ["boolean", null, null, false, "enabled"],
  coverageDays: ["number", 1, 365, true, "coverageDays"],
  coverageSafetyStock: ["number", 0, 500, true, "safetyStock"],
  coverageMaxPerGame: ["number", 1, farmSizing.HARD_MAX_ACCOUNTS, true, "maxPerGame"],
  gameAccountCaps: ["caps", null, null, false, "gameCaps"],
  noclaimAutoSize: ["boolean", null, null, false, "autoSize"],
  noclaimSizeIntervalMin: ["number", 5, 1440, true, "intervalMin"],
  noclaimSizeMaxPerRun: ["number", 1, 1000, true, "maxPerRun"],
  noclaimGameSizing: ["gameSizing", null, null, false, "gameSizing"],
};
const ALIAS_TO_KEY = Object.fromEntries(
  Object.entries(SIZING_KEYS).map(([k, spec]) => [spec[4], k]),
);

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === 0 || v === "0" || v === "false" || v === "off" || v === "no" || v === "")
    return false;
  return null;
}

// { "overwatch": 120 } — a per-game account ceiling. Keys are normalised the
// noClaimGames way so "Overwatch 2" and "overwatch" cannot become two entries
// that shadow each other unpredictably.
function parseCaps(value, errors, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(key + " must be an object of { game: number }");
    return null;
  }
  const out = {};
  for (const [g, v] of Object.entries(value)) {
    const name = settings.normGameName(g);
    if (!name) continue;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > farmSizing.HARD_MAX_ACCOUNTS) {
      errors.push(`${key}.${g} must be 0..${farmSizing.HARD_MAX_ACCOUNTS}`);
      continue;
    }
    // 0 means "automatic" — drop the entry entirely rather than storing a zero
    // that a future reader might treat as "farm nothing".
    if (n > 0) out[name] = n;
  }
  return out;
}

// { "overwatch": { coverageDays, safetyStock, min, max } } — a partial override;
// any omitted field falls back to the global policy.
function parseGameSizing(value, errors, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(key + " must be an object of { game: { ... } }");
    return null;
  }
  const FIELDS = {
    coverageDays: [1, 365],
    safetyStock: [0, 500],
    min: [0, farmSizing.HARD_MAX_ACCOUNTS],
    max: [1, farmSizing.HARD_MAX_ACCOUNTS],
  };
  const out = {};
  for (const [g, entry] of Object.entries(value)) {
    const name = settings.normGameName(g);
    if (!name) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${key}.${g} must be an object`);
      continue;
    }
    const clean = {};
    for (const [f, v] of Object.entries(entry)) {
      const range = FIELDS[f];
      if (!range) {
        errors.push(`${key}.${g}.${f} is not a sizing field`);
        continue;
      }
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
        errors.push(`${key}.${g}.${f} must be ${range[0]}..${range[1]}`);
        continue;
      }
      clean[f] = n;
    }
    if (Object.keys(clean).length) out[name] = clean;
  }
  return out;
}

function validateSizingPatch(body) {
  const patch = {};
  const ignored = [];
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { patch, ignored, errors: ["body must be a JSON object"] };
  for (const [rawKey, value] of Object.entries(body)) {
    const key = SIZING_KEYS[rawKey] ? rawKey : ALIAS_TO_KEY[rawKey];
    if (!key) {
      ignored.push(rawKey);
      continue;
    }
    const [type, min, max, integer] = SIZING_KEYS[key];
    if (type === "boolean") {
      const b = parseBool(value);
      if (b === null) errors.push(key + " must be a boolean");
      else patch[key] = b;
    } else if (type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max)
        errors.push(`${key} must be a number ${min}..${max}`);
      else patch[key] = integer ? Math.floor(n) : n;
    } else if (type === "caps") {
      const caps = parseCaps(value, errors, key);
      if (caps) patch[key] = caps;
    } else if (type === "gameSizing") {
      const gs = parseGameSizing(value, errors, key);
      if (gs) patch[key] = gs;
    }
  }
  return { patch, ignored, errors };
}

function rawSizingKeys() {
  const af = settings.getAutoFarm();
  const out = {};
  for (const k of Object.keys(SIZING_KEYS)) out[k] = af[k];
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get("/api/farm-sizing/settings", requireSuperadmin, (req, res) => {
  try {
    const s = settings.getFarmSizing();
    res.json({
      success: true,
      // The accessor view minus the per-game functions, which do not serialise.
      sizing: {
        enabled: s.enabled,
        coverageDays: s.coverageDays,
        safetyStock: s.safetyStock,
        maxPerGame: s.maxPerGame,
        gameCaps: s.gameCaps,
        autoSize: s.autoSize,
        intervalMin: s.intervalMin,
        maxPerRun: s.maxPerRun,
        gameSizing: s.gameSizing,
      },
      raw: rawSizingKeys(),
      keys: Object.keys(SIZING_KEYS),
      hardMax: farmSizing.HARD_MAX_ACCOUNTS,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/farm-sizing/settings", requireSuperadmin, async (req, res) => {
  try {
    const { patch, ignored, errors } = validateSizingPatch(req.body);
    if (errors.length)
      return res
        .status(400)
        .json({ success: false, message: errors.join("; "), errors, ignored });
    if (!Object.keys(patch).length)
      return res.status(400).json({
        success: false,
        message: "no sizing keys in body",
        ignored,
        keys: Object.keys(SIZING_KEYS),
      });
    await settings.setAutoFarm(patch, { actor: actorFromReq(req) });
    res.json({ success: true, changed: Object.keys(patch), ignored, raw: rawSizingKeys() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// No-claim fleet plan
// ---------------------------------------------------------------------------

// The plan, with its evidence. `?fleet=0` skips the Pi round trip for a fast
// read when the caller only wants the sales/stock numbers.
router.get("/api/farm-sizing/plan", requireSuperadmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const withFleet = req.query.fleet !== "0";
    const plan = await allocator.plan({ days, withFleet });
    res.json({ success: true, plan, status: allocator.status() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// Apply the plan. DRY RUN BY DEFAULT: a caller must send {apply:true} to spend
// an account, so an accidental POST can never claim from the pool.
router.post("/api/farm-sizing/apply", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const dryRun = body.apply !== true;
    const days = Math.min(365, Math.max(1, parseInt(body.days, 10) || 30));
    const games = Array.isArray(body.games) && body.games.length ? body.games : null;
    const out = await allocator.apply({
      days,
      dryRun,
      games,
      // A cap the operator set by hand is a deliberate hold (Overwatch's 28
      // exists because they hand-sell in bulk), so raising one is opt-in.
      raiseExplicit: body.raiseExplicit === true,
      actor: actorFromReq(req),
    });
    if (!dryRun) {
      logEvent({
        category: "noclaim",
        action: "fleet_sizing_applied",
        actor: actorFromReq(req),
        count: out.toppedUp || 0,
        detail:
          `applied fleet sizing: +${out.toppedUp} account(s), ${out.created} bot(s), ` +
          `${out.shelvesRaised} shelf cap(s)`,
      });
    }
    res.json({ success: true, result: out });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto-farm side: what the coverage model WOULD do, per game
// ---------------------------------------------------------------------------

// Read-only preview. Shows, for every game the auto-farm has an active task for
// (plus any game with recorded sales), the ceiling it has today and the ceiling
// the coverage model would give it. Nothing here changes a decision — it exists
// so the operator can see the effect of `coverageSizing` BEFORE turning it on.
router.get("/api/farm-sizing/autofarm", requireSuperadmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 45));
    const af = settings.getAutoFarm();
    const cfg = settings.getFarmSizing();

    const active = await AutoFarmTask.aggregate([
      { $match: { status: { $in: ["active", "planned"] } } },
      {
        $group: {
          _id: "$game",
          tasks: { $sum: 1 },
          assigned: { $sum: { $size: { $ifNull: ["$assignedAccounts", []] } } },
          target: { $max: { $ifNull: ["$targetAccounts", 0] } },
        },
      },
    ]);
    const byGame = new Map(active.map((a) => [a._id, a]));

    const rows = [];
    for (const game of new Set([...byGame.keys()].filter(Boolean))) {
      // Skip the games the auto-farmer does not own — they are the no-claim
      // allocator's, and reporting a ceiling for them would be misleading.
      if (settings.isNoClaimGame(game)) continue;
      const rate = await farmDemand.salesRateForGame(game, { days });
      const sales = { count: rate.count, revenue: rate.revenue, avgPrice: rate.avgPrice };
      // Today's ceiling: what capForGame returns with sizing as configured.
      const capNow = autoFarmer.capForGame(af, sales, game);
      // What it would be with coverage sizing ON, everything else unchanged.
      const legacy = Math.min(
        Math.max(1, Number(af.maxPerGame) || 1) + Math.floor(sales.count * 2),
        Math.max(1, Number(af.maxPerGame) || 1) * 2,
      );
      const covered = farmSizing.coverageTarget({
        salesPerWeek: rate.perWeek,
        coverageDays: cfg.coverageDaysFor(game),
        safetyStock: cfg.safetyStockFor(game),
        min: legacy,
        max: Math.max(legacy, cfg.maxFor(game)),
      });
      const a = byGame.get(game) || { tasks: 0, assigned: 0, target: 0 };
      rows.push({
        game,
        tasks: a.tasks,
        assigned: a.assigned,
        recordedTarget: a.target,
        sales: { ...sales, perWeek: rate.perWeek },
        capNow,
        capLegacy: legacy,
        capCoverage: Math.max(legacy, covered || 0),
        override: settings.gameAccountCapFor(game) || 0,
        wouldChange: Math.max(legacy, covered || 0) !== capNow,
      });
    }
    rows.sort((a, b) => b.sales.perWeek - a.sales.perWeek || b.capCoverage - a.capCoverage);
    res.json({
      success: true,
      windowDays: days,
      enabled: cfg.enabled,
      policy: {
        coverageDays: cfg.coverageDays,
        safetyStock: cfg.safetyStock,
        maxPerGame: cfg.maxPerGame,
      },
      maxPerGame: af.maxPerGame,
      games: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.validateSizingPatch = validateSizingPatch;
module.exports.SIZING_KEYS = SIZING_KEYS;
