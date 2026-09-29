// ---------------------------------------------------------------------------
// Bulk packs API (docs/bulk-packs/API-UI.md "Router", CONTRACT.md §3/§4/§8 H3).
//
// A thin layer over utils/bulkPacks/*. The page reads proposals, live offers
// and settings here, and every write is an owner click forwarded to send.js —
// this router never publishes, reserves or releases anything itself.
//
// Wiring (server.js, hook H3): mounted AFTER the requireAdmin blanket as
// app.use(enforce2fa, bulkPackRoutes), and every route below carries its own
// requireSuperadmin. Per route, never a path-less router.use(): a guard like
// that would run for EVERY request that reaches this router (the
// adminManageRoutes trap described in middleware/auth.js).
//
// send.js, loop.js, proposals.js and farmCapacity.js are reached lazily through
// `deps`, so this file loads — and the server boots — while one of them is
// missing or broken; an endpoint that needs it answers 503
// "module_unavailable" instead. Tests swap every dependency with __setDeps
// (CONTRACT §9) and never touch the real utils/settings.json.
// ---------------------------------------------------------------------------
const express = require("express");
const { requireSuperadmin } = require("../middleware/auth");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const config = require("../utils/bulkPacks/config");
const BulkOffer = require("../models/BulkOffer");

const router = express.Router();

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (err) => (err && err.message) || String(err);

// ---------------------------------------------------------------------------
// Lazy dependencies (CONTRACT §9)
// ---------------------------------------------------------------------------
const MODULE_NAMES = {
  settings: "utils/settings.js",
  send: "utils/bulkPacks/send.js",
  loop: "utils/bulkPacks/loop.js",
  proposals: "utils/bulkPacks/proposals.js",
  farmCapacity: "utils/bulkPacks/farmCapacity.js",
};
let depOverrides = {};
function pick(name, load) {
  return own(depOverrides, name) ? depOverrides[name] : load();
}
const deps = {
  get settings() {
    return pick("settings", () => require("../utils/settings"));
  },
  get send() {
    return pick("send", () => require("../utils/bulkPacks/send"));
  },
  get loop() {
    return pick("loop", () => require("../utils/bulkPacks/loop"));
  },
  get proposals() {
    return pick("proposals", () => require("../utils/bulkPacks/proposals"));
  },
  get farmCapacity() {
    return pick("farmCapacity", () =>
      require("../utils/bulkPacks/farmCapacity"),
    );
  },
};
function __setDeps(partial) {
  for (const k of Object.keys(partial || {})) {
    if (!own(MODULE_NAMES, k))
      throw new Error("bulkPackRoutes: unknown dep " + k);
  }
  depOverrides = { ...depOverrides, ...(partial || {}) };
}
function __resetDeps() {
  depOverrides = {};
}

// { mod } when the module loads and has every named function, else { error }.
function loadDep(name, fns) {
  let mod;
  try {
    mod = deps[name];
  } catch (err) {
    return { error: err };
  }
  for (const fn of fns) {
    if (!mod || typeof mod[fn] !== "function") {
      return { error: new Error(MODULE_NAMES[name] + " has no " + fn + "()") };
    }
  }
  return { mod };
}
function unavailable(res, name, err) {
  return res.status(503).json({
    success: false,
    code: "module_unavailable",
    module: MODULE_NAMES[name],
    message: MODULE_NAMES[name] + " is not available: " + errMsg(err),
  });
}

// Coalesce identical concurrent calls (a double-clicked "Run check now", a
// burst of proposal refreshes) into one run: bounded DB work (CONTRACT I12),
// and two manual maintenance passes never overlap from here.
const inflight = new Map();
function singleFlight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// After anything that changes stock, live offers or settings, drop the cached
// proposals so liveOfferId / free counts are not five minutes stale.
function invalidateProposals() {
  try {
    const p = deps.proposals;
    if (p && typeof p.invalidate === "function") p.invalidate();
  } catch {
    /* proposals module unavailable: there is no cache to drop */
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const MAX_UNITS = 500; // sanity bound on units / add; send.js checks real stock
const MAX_GAME_LEN = 200;
const LIST_DEFAULT = 100;
const LIST_MAX = 500;
const HISTORY_KEEP = 60;
const WITHDRAW_ALL_CONFIRM = "WITHDRAW";
const OFF_MESSAGE = "Bulk packs are switched off";
const BLOCK_NOTE = "owner block since 2026-09-28";

function bodyOf(req) {
  return isPlainObject(req.body) ? req.body : {};
}
// A number, or a non-blank numeric string; anything else (null, booleans,
// arrays, objects, "") is NaN rather than the 0/1 Number() would make of it.
function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v.trim());
  return NaN;
}
function clampInt(v, d, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function isFlagOn(v) {
  return v === true || v === "1" || v === "true";
}
function isBlockedMarket(m) {
  return config.BLOCKED_MARKETS.includes(
    String(m == null ? "" : m)
      .trim()
      .toLowerCase(),
  );
}
function blockedMessage(m) {
  return (
    String(m) + " is blocked (" + BLOCK_NOTE + ") — no bulk pack goes there"
  );
}
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Answer with a send.js result: `status` is the HTTP code send.js chose
// (MODULES §send.js), `success` is kept consistent with it.
function replyWith(res, r, what) {
  if (!isPlainObject(r)) {
    return res
      .status(500)
      .json({ success: false, message: what + " returned no result" });
  }
  let status = Number(r.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    status = r.success === true ? 200 : 500;
  }
  const success = r.success === true && status < 400;
  const out = { ...r, success };
  if (!success && !out.message) out.message = what + " failed";
  return res.status(status).json(out);
}

// Settings snapshot for one request: one read of each store, so the gates, the
// master switch and bp all describe the same moment. A failed read degrades to
// "closed / off", never to "open".
function readSettings() {
  const s = deps.settings;
  let af = null;
  try {
    af = s.getAutoFarm();
  } catch {
    af = null;
  }
  if (!isPlainObject(af)) af = null;
  let noclaimShop = null;
  try {
    noclaimShop = s.getNoclaimShopSettings();
  } catch {
    noclaimShop = null;
  }
  return { af, noclaimShop, bp: s.getBulkPacks(af || {}) };
}

// CONTRACT I8: while switched off, send / refill / resume are refused here as
// well as in send.js — the router is the API boundary, so "ships dark" holds
// even if a caller or a sibling module misbehaves.
function refuseWhileOff(res) {
  let enabled = false;
  try {
    enabled = deps.settings.getBulkPacks().enabled === true;
  } catch {
    enabled = false;
  }
  if (enabled) return false;
  res.status(409).json({ success: false, message: OFF_MESSAGE });
  return true;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

// { [market]: { dropset, noclaim, farm } } — each { ok, reason } — for every
// supported market, including the pairs a market does not carry (config's
// deliveryGate names those "Gameflip does not carry no-claim packs"), so
// gates[m][source] always exists. Blocked markets: { blocked: true }.
function buildGates(af, noclaimShop) {
  const gates = {};
  for (const market of config.SUPPORTED_MARKETS) {
    const row = {};
    for (const source of Object.keys(config.SOURCE_MARKETS)) {
      try {
        const g = config.deliveryGate({ market, source, af, noclaimShop });
        row[source] = { ok: g.ok === true, reason: String(g.reason || "") };
      } catch (err) {
        row[source] = {
          ok: false,
          reason: "gate check failed: " + errMsg(err),
        };
      }
    }
    gates[market] = row;
  }
  for (const market of config.BLOCKED_MARKETS) {
    gates[market] = {
      blocked: true,
      reason: market + " is blocked (" + BLOCK_NOTE + ")",
    };
  }
  return gates;
}

async function offerCounts() {
  const byState = {};
  for (const st of [...config.OPEN_STATES, ...config.CLOSED_STATES])
    byState[st] = 0;
  const [open, rows] = await Promise.all([
    BulkOffer.countDocuments({ open: true }),
    BulkOffer.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }]),
  ]);
  for (const r of rows) {
    const k = String(r._id);
    byState[k] = (byState[k] || 0) + (Number(r.n) || 0);
  }
  return { open, byState };
}

function loopStatus() {
  const { mod, error } = loadDep("loop", ["status"]);
  if (error) {
    return {
      running: false,
      error: "maintenance loop unavailable: " + errMsg(error),
    };
  }
  try {
    const st = mod.status();
    return isPlainObject(st) ? st : { running: false };
  } catch (err) {
    return { running: false, error: errMsg(err) };
  }
}

// farmCapacity.read() is cached in its module (10 min) and never throws by
// contract; a missing module or a bad read still yields a zero capacity with
// the reason, so the overview itself never fails over it.
async function capacityView(bp) {
  const zero = (err) => ({
    bestStackRoom: 0,
    totalFree: 0,
    pristine: 0,
    at: null,
    error: "farm capacity unavailable: " + errMsg(err),
    advertisable: 0,
  });
  const { mod, error } = loadDep("farmCapacity", ["read", "advertisable"]);
  if (error) return zero(error);
  try {
    const cap = await mod.read();
    const c = isPlainObject(cap) ? cap : {};
    let advertisable = 0;
    try {
      advertisable = Math.max(
        0,
        Math.floor(Number(mod.advertisable(c, bp)) || 0),
      );
    } catch {
      advertisable = 0;
    }
    return { ...c, advertisable };
  } catch (err) {
    return zero(err);
  }
}

router.get("/api/bulk-packs/overview", requireSuperadmin, async (req, res) => {
  try {
    const { af, noclaimShop, bp } = readSettings();
    const [counts, capacity] = await Promise.all([
      offerCounts(),
      capacityView(bp),
    ]);
    res.json({
      success: true,
      settings: bp,
      gates: buildGates(af, noclaimShop),
      loop: loopStatus(),
      counts,
      capacity,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
});

// ---------------------------------------------------------------------------
// Proposals (cached 5 min in proposals.js; ?refresh=1 bypasses)
// ---------------------------------------------------------------------------
function proposalsRoute(kind, fn) {
  return async (req, res) => {
    const { mod, error } = loadDep("proposals", [fn]);
    if (error) return unavailable(res, "proposals", error);
    const refresh = isFlagOn(req.query.refresh);
    try {
      const r = await singleFlight(
        "proposals:" + kind + ":" + (refresh ? "refresh" : "cached"),
        () => mod[fn]({ refresh }),
      );
      if (!isPlainObject(r))
        throw new Error(kind + " proposals returned nothing");
      res.json({ ...r, success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: errMsg(err) });
    }
  };
}
router.get(
  "/api/bulk-packs/proposals/accounts",
  requireSuperadmin,
  proposalsRoute("accounts", "accountProposals"),
);
router.get(
  "/api/bulk-packs/proposals/farming",
  requireSuperadmin,
  proposalsRoute("farming", "farmProposals"),
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

// Counts that stand in for reserved[] in the list view:
//   reservedCount  entries in reserved[] (every account ever put behind it)
//   freeCount      state on_offer (reserved, on sale, not known sold)
//   retiringCount  state retiring (pulled, waiting for the phase-2 re-read)
// plus deliveredCount / releasedCount so the page never needs the array.
function reservedCounts(reserved) {
  const c = {
    reservedCount: 0,
    freeCount: 0,
    retiringCount: 0,
    deliveredCount: 0,
    releasedCount: 0,
  };
  for (const r of Array.isArray(reserved) ? reserved : []) {
    c.reservedCount++;
    const st = r && r.state;
    if (st === "on_offer") c.freeCount++;
    else if (st === "retiring") c.retiringCount++;
    else if (st === "delivered") c.deliveredCount++;
    else if (st === "released") c.releasedCount++;
  }
  return c;
}

// The list never ships logins, history or buyer copy: only reserved[].state
// leaves the database, to be counted.
const LIST_PROJECTION = {
  history: 0,
  description: 0,
  "reserved.accountId": 0,
  "reserved.login": 0,
  "reserved.orderId": 0,
  "reserved.reason": 0,
  "reserved.at": 0,
  "reserved.changedAt": 0,
};

function scopeFilter(scope) {
  if (scope === "open") return { open: true };
  if (scope === "closed") return { open: false };
  if (scope === "all") return {};
  return null;
}

router.get("/api/bulk-packs/offers", requireSuperadmin, async (req, res) => {
  try {
    const raw = req.query.scope;
    const scope =
      raw == null || raw === "" ? "all" : String(raw).trim().toLowerCase();
    const filter = scopeFilter(scope);
    if (!filter) {
      return res
        .status(400)
        .json({ success: false, message: "scope must be open, closed or all" });
    }
    const limit = clampInt(req.query.limit, LIST_DEFAULT, 1, LIST_MAX);
    const [rows, totalsRows] = await Promise.all([
      BulkOffer.find(filter, LIST_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean(),
      BulkOffer.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            offers: { $sum: 1 },
            orders: { $sum: "$ordersCount" },
            accounts: { $sum: "$unitsDelivered" },
            revenueUsd: { $sum: "$revenueUsd" },
          },
        },
      ]),
    ]);
    const offers = rows.map((o) => {
      const out = { ...o, id: String(o._id), ...reservedCounts(o.reserved) };
      delete out.reserved;
      return out;
    });
    const t = totalsRows[0] || {};
    res.json({
      success: true,
      scope,
      limit,
      offers,
      // Over the whole scope, not just this page of rows.
      totals: {
        offers: Number(t.offers) || 0,
        orders: Number(t.orders) || 0,
        accounts: Number(t.accounts) || 0,
        revenueUsd: round2(t.revenueUsd),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
});

function offerNotFound(res) {
  return res
    .status(404)
    .json({ success: false, message: "Bulk offer not found" });
}
function offerIdOf(req) {
  const id = String(req.params.id || "");
  return OBJECT_ID_RE.test(id) ? id : null;
}

// One offer with reserved[] (logins are fine — superadmin only; the model holds
// no passwords) and its last 60 history entries.
router.get(
  "/api/bulk-packs/offers/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = offerIdOf(req);
      if (!id) return offerNotFound(res);
      const o = await BulkOffer.findById(id).lean();
      if (!o) return offerNotFound(res);
      const history = Array.isArray(o.history)
        ? o.history.slice(-HISTORY_KEEP)
        : [];
      res.json({
        success: true,
        offer: {
          ...o,
          id: String(o._id),
          history,
          ...reservedCounts(o.reserved),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: errMsg(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

// Only whitelisted primitives reach send.js: every field is type-checked, so an
// operator object ({"$ne": …}) can never ride into a query, `actor` always
// comes from the session, and a source only carries the fields its slot uses
// (a farm send never carries a setId: slotKey would key on it — CONTRACT I6).
function parseSendBody(body) {
  const errors = [];
  const source =
    typeof body.source === "string" ? body.source.trim().toLowerCase() : "";
  if (!own(config.SOURCE_MARKETS, source)) {
    errors.push(
      "source must be one of: " + Object.keys(config.SOURCE_MARKETS).join(", "),
    );
  }
  const market =
    typeof body.market === "string" ? body.market.trim().toLowerCase() : "";
  if (isBlockedMarket(market)) {
    errors.push(blockedMessage(market));
  } else if (!config.SUPPORTED_MARKETS.includes(market)) {
    errors.push(
      "market must be one of: " + config.SUPPORTED_MARKETS.join(", "),
    );
  }
  const minQty = toNum(body.minQty);
  if (!Number.isInteger(minQty) || minQty < 2 || minQty > 100) {
    errors.push(
      "minQty must be a whole number 2..100 (one of the configured tiers)",
    );
  }
  let units;
  if (body.units !== undefined && body.units !== null && body.units !== "") {
    units = toNum(body.units);
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) {
      errors.push("units must be a whole number 1.." + MAX_UNITS);
    }
  }
  let setId;
  let game;
  let days;
  if (source === "dropset" || source === "noclaim") {
    setId = typeof body.setId === "string" ? body.setId.trim() : "";
    if (!OBJECT_ID_RE.test(setId)) errors.push("setId must be a bundle id");
  } else if (source === "farm") {
    game = typeof body.game === "string" ? body.game.trim() : "";
    if (!game || game.length > MAX_GAME_LEN) {
      errors.push("game is required (at most " + MAX_GAME_LEN + " characters)");
    }
    days = toNum(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 730) {
      errors.push("days must be a whole number 1..730");
    }
  }
  return { errors, args: { source, setId, game, days, market, minQty, units } };
}

router.post("/api/bulk-packs/send", requireSuperadmin, async (req, res) => {
  if (refuseWhileOff(res)) return;
  const { errors, args } = parseSendBody(bodyOf(req));
  if (errors.length) {
    return res
      .status(400)
      .json({ success: false, message: errors.join("; "), errors });
  }
  const { mod, error } = loadDep("send", ["sendOffer"]);
  if (error) return unavailable(res, "send", error);
  let r;
  try {
    r = await mod.sendOffer({ ...args, actor: actorFromReq(req) });
  } catch (err) {
    r = { success: false, status: 500, message: errMsg(err) };
  }
  invalidateProposals();
  return replyWith(res, r, "send");
});

// ---------------------------------------------------------------------------
// Offer actions
// ---------------------------------------------------------------------------
router.post(
  "/api/bulk-packs/offers/:id/refill",
  requireSuperadmin,
  async (req, res) => {
    const offerId = offerIdOf(req);
    if (!offerId) return offerNotFound(res);
    if (refuseWhileOff(res)) return;
    const add = toNum(bodyOf(req).add);
    if (!Number.isInteger(add) || add < 1 || add > MAX_UNITS) {
      return res
        .status(400)
        .json({
          success: false,
          message: "add must be a whole number 1.." + MAX_UNITS,
        });
    }
    const { mod, error } = loadDep("send", ["refillOffer"]);
    if (error) return unavailable(res, "send", error);
    let r;
    try {
      r = await mod.refillOffer({ offerId, add, actor: actorFromReq(req) });
    } catch (err) {
      r = { success: false, status: 500, message: errMsg(err) };
    }
    invalidateProposals();
    return replyWith(res, r, "refill");
  },
);

// pause / resume / withdraw take no body. Pause and withdraw stay available
// while switched off (they only take things down); resume is refused (I8).
function offerAction(
  fn,
  what,
  { publishes = false, invalidates = false } = {},
) {
  return async (req, res) => {
    const offerId = offerIdOf(req);
    if (!offerId) return offerNotFound(res);
    if (publishes && refuseWhileOff(res)) return;
    const { mod, error } = loadDep("send", [fn]);
    if (error) return unavailable(res, "send", error);
    let r;
    try {
      r = await mod[fn]({ offerId, actor: actorFromReq(req) });
    } catch (err) {
      r = { success: false, status: 500, message: errMsg(err) };
    }
    if (invalidates) invalidateProposals();
    return replyWith(res, r, what);
  };
}
router.post(
  "/api/bulk-packs/offers/:id/pause",
  requireSuperadmin,
  offerAction("pauseOffer", "pause"),
);
router.post(
  "/api/bulk-packs/offers/:id/resume",
  requireSuperadmin,
  offerAction("resumeOffer", "resume", { publishes: true }),
);
router.post(
  "/api/bulk-packs/offers/:id/withdraw",
  requireSuperadmin,
  offerAction("withdrawOffer", "withdraw", { invalidates: true }),
);

// Takes every open offer down. The exact, case-sensitive word is required.
router.post(
  "/api/bulk-packs/withdraw-all",
  requireSuperadmin,
  async (req, res) => {
    if (bodyOf(req).confirm !== WITHDRAW_ALL_CONFIRM) {
      return res.status(400).json({
        success: false,
        message:
          'Type WITHDRAW (in capitals) as "confirm" to withdraw every open bulk offer',
      });
    }
    const { mod, error } = loadDep("send", ["withdrawAll"]);
    if (error) return unavailable(res, "send", error);
    let r;
    try {
      r = await mod.withdrawAll({ actor: actorFromReq(req) });
    } catch (err) {
      r = { success: false, status: 500, message: errMsg(err) };
    }
    invalidateProposals();
    return replyWith(res, r, "withdraw all");
  },
);

// ---------------------------------------------------------------------------
// Maintenance pass on demand
// ---------------------------------------------------------------------------
const RUN_NOW_KEY = "run-now";

function summaryLine(s) {
  const n = (k) => Number(s[k]) || 0;
  return (
    "open " +
    n("open") +
    " (acct " +
    n("accounts") +
    ", farm " +
    n("farming") +
    ") | sold +" +
    n("sold") +
    " | paused " +
    n("paused") +
    " | retiring " +
    n("retiring") +
    " | released " +
    n("released") +
    " | errors " +
    n("errors")
  );
}

// Allowed while switched off: the loop only does safety maintenance then (I8).
router.post("/api/bulk-packs/run-now", requireSuperadmin, async (req, res) => {
  const { mod, error } = loadDep("loop", ["runOnce"]);
  if (error) return unavailable(res, "loop", error);
  const joined = inflight.has(RUN_NOW_KEY);
  try {
    const summary = await singleFlight(RUN_NOW_KEY, () => mod.runOnce());
    const s = isPlainObject(summary) ? summary : {};
    if (!joined) {
      logEvent({
        category: "bulk",
        action: "run_now",
        actor: actorFromReq(req),
        subject: "bulk packs",
        detail: "manual maintenance pass: " + summaryLine(s),
        meta: s,
      });
    }
    res.json({ ...s, success: true, summary: s, loop: loopStatus() });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
});

// ---------------------------------------------------------------------------
// Settings (autoFarm bulk* keys only)
// ---------------------------------------------------------------------------
// key: [type, min, max, accessor alias (the getBulkPacks field name)]
const SETTINGS_KEYS = {
  bulkPacksEnabled: ["boolean", null, null, "enabled"],
  bulkPacksMarkets: ["markets", null, null, "markets"],
  bulkPackTiers: ["tiers", null, null, "tiers"],
  bulkPackReserveSingles: ["int", 0, 100, "reserveSingles"],
  bulkPackUnitsPerOffer: ["int", 1, 80, "unitsPerOffer"],
  bulkFarmPrices: ["farmPrices", null, null, "farmPrices"],
  bulkFarmDurations: ["durations", null, null, "farmDurations"],
  bulkFarmReserveSlots: ["int", 0, 500, "farmReserveSlots"],
  bulkFarmReservePristine: ["int", 0, 500, "farmReservePristine"],
  bulkFarmMaxQty: ["int", 1, 100, "farmMaxQty"],
  bulkPacksLoopMinutes: ["int", 2, 60, "loopMinutes"],
  bulkFarmSyncMinutes: ["int", 5, 120, "farmSyncMinutes"],
};
const ALIAS_TO_KEY = Object.fromEntries(
  Object.entries(SETTINGS_KEYS).map(([k, spec]) => [spec[3], k]),
);

function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "on" || v === "yes")
    return true;
  if (
    v === 0 ||
    v === "0" ||
    v === "false" ||
    v === "off" ||
    v === "no" ||
    v === ""
  )
    return false;
  return null;
}

// Subset of eldorado / g2g / gameflip, lowercased, deduped, order kept. An empty
// list is allowed (no market). Plati/Digiseller/GGSel are refused by name.
function parseMarkets(value, key, errors) {
  if (!Array.isArray(value)) {
    errors.push(
      key +
        " must be an array of markets (" +
        config.SUPPORTED_MARKETS.join(", ") +
        ")",
    );
    return null;
  }
  const out = [];
  let bad = false;
  for (const raw of value) {
    const m = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (isBlockedMarket(m)) {
      errors.push(key + ": " + blockedMessage(m));
      bad = true;
    } else if (!config.SUPPORTED_MARKETS.includes(m)) {
      errors.push(
        key +
          ': unknown market "' +
          String(raw) +
          '" (allowed: ' +
          config.SUPPORTED_MARKETS.join(", ") +
          ")",
      );
      bad = true;
    } else if (!out.includes(m)) {
      out.push(m);
    }
  }
  return bad ? null : out;
}

// 1..4 tiers, integer minQty 2..100 (unique), discountPct 0..60; stored sorted.
function parseTiers(value, key, errors) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    errors.push(key + " must be a list of 1 to 4 tiers {minQty, discountPct}");
    return null;
  }
  const out = [];
  const seen = new Set();
  let bad = false;
  value.forEach((t, i) => {
    const at = key + "[" + i + "]";
    if (!isPlainObject(t)) {
      errors.push(at + " must be {minQty, discountPct}");
      bad = true;
      return;
    }
    const minQty = toNum(t.minQty);
    const discountPct = toNum(t.discountPct);
    let entryBad = false;
    if (!Number.isInteger(minQty) || minQty < 2 || minQty > 100) {
      errors.push(at + ".minQty must be a whole number 2..100");
      entryBad = true;
    } else if (seen.has(minQty)) {
      errors.push(key + ": minQty " + minQty + " is listed twice");
      entryBad = true;
    } else {
      seen.add(minQty);
    }
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 60) {
      errors.push(at + ".discountPct must be a number 0..60");
      entryBad = true;
    }
    if (entryBad) bad = true;
    else out.push({ minQty, discountPct });
  });
  if (bad) return null;
  return out.sort((a, b) => a.minQty - b.minQty);
}

// { eldorado|g2g: { "<days>": priceUsd 0.5..100 } }. The whole table is
// replaced, so a market left out has no farm prices. A blank cell ("" / null)
// means "no price for that term".
function parseFarmPrices(value, key, errors) {
  const farmMarkets = config.SOURCE_MARKETS.farm;
  if (!isPlainObject(value)) {
    errors.push(
      key + ' must be an object like {"eldorado": {"120": 3}, "g2g": {…}}',
    );
    return null;
  }
  const out = {};
  let bad = false;
  for (const [rawMarket, table] of Object.entries(value)) {
    const m = String(rawMarket).trim().toLowerCase();
    if (isBlockedMarket(m)) {
      errors.push(key + ": " + blockedMessage(m));
      bad = true;
      continue;
    }
    if (!farmMarkets.includes(m)) {
      errors.push(
        key +
          ': "' +
          rawMarket +
          '" has no farming packs (allowed: ' +
          farmMarkets.join(", ") +
          ")",
      );
      bad = true;
      continue;
    }
    if (own(out, m)) {
      errors.push(key + ": " + m + " is listed twice");
      bad = true;
      continue;
    }
    if (!isPlainObject(table)) {
      errors.push(key + "." + m + " must be an object of {days: price}");
      bad = true;
      continue;
    }
    const prices = {};
    for (const [rawDays, rawPrice] of Object.entries(table)) {
      const d = String(rawDays).trim();
      const days = /^\d+$/.test(d) ? Number(d) : NaN;
      if (!(days >= 1 && days <= 730)) {
        errors.push(
          key + "." + m + ': "' + rawDays + '" is not a term in days 1..730',
        );
        bad = true;
        continue;
      }
      if (rawPrice === "" || rawPrice === null || rawPrice === undefined)
        continue;
      const price = toNum(rawPrice);
      if (!Number.isFinite(price) || price < 0.5 || price > 100) {
        errors.push(key + "." + m + "." + days + " must be a price 0.5..100");
        bad = true;
        continue;
      }
      if (own(prices, String(days))) {
        errors.push(key + "." + m + ": " + days + " days is listed twice");
        bad = true;
        continue;
      }
      prices[String(days)] = price;
    }
    out[m] = prices;
  }
  return bad ? null : out;
}

// 1..6 whole-day terms 1..730; deduped and sorted.
function parseDurations(value, key, errors) {
  if (!Array.isArray(value)) {
    errors.push(key + " must be a list of 1 to 6 terms in days");
    return null;
  }
  const days = new Set();
  let bad = false;
  for (const raw of value) {
    const n = toNum(raw);
    if (!Number.isInteger(n) || n < 1 || n > 730) {
      errors.push(
        key +
          ": " +
          JSON.stringify(raw) +
          " must be a whole number of days 1..730",
      );
      bad = true;
    } else {
      days.add(n);
    }
  }
  if (bad) return null;
  if (days.size < 1 || days.size > 6) {
    errors.push(key + " must list 1 to 6 different terms");
    return null;
  }
  return [...days].sort((a, b) => a - b);
}

// Validate a partial patch of autoFarm bulk* keys (the validatePricingPatch
// pattern of routes/unclaimedAutoRoutes.js). Accepts the raw autoFarm key or
// its getBulkPacks alias ("enabled" -> bulkPacksEnabled). Returns
// { patch, ignored, errors }: unknown keys are reported in `ignored`, never
// written; any error means nothing may be written.
function validateSettingsPatch(body) {
  const patch = {};
  const ignored = [];
  const errors = [];
  if (!isPlainObject(body)) {
    return { patch, ignored, errors: ["patch must be a JSON object"] };
  }
  for (const [rawKey, value] of Object.entries(body)) {
    const key = own(SETTINGS_KEYS, rawKey)
      ? rawKey
      : own(ALIAS_TO_KEY, rawKey)
        ? ALIAS_TO_KEY[rawKey]
        : null;
    if (!key) {
      ignored.push(rawKey);
      continue;
    }
    if (own(patch, key)) {
      errors.push(key + " is given twice");
      continue;
    }
    const [type, min, max] = SETTINGS_KEYS[key];
    let v = null;
    if (type === "boolean") {
      v = parseBool(value);
      if (v === null) errors.push(key + " must be true or false");
    } else if (type === "int") {
      const n = toNum(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        errors.push(key + " must be a whole number " + min + ".." + max);
        v = null;
      } else {
        v = n;
      }
    } else if (type === "markets") {
      v = parseMarkets(value, key, errors);
    } else if (type === "tiers") {
      v = parseTiers(value, key, errors);
    } else if (type === "farmPrices") {
      v = parseFarmPrices(value, key, errors);
    } else if (type === "durations") {
      v = parseDurations(value, key, errors);
    }
    if (v !== null) patch[key] = v;
  }
  return { patch, ignored, errors };
}

// The bulk* keys as stored (getAutoFarm merges the shipped defaults over a
// settings.json written before they existed).
function rawSettingsKeys(s) {
  let af = {};
  try {
    const a = s.getAutoFarm();
    if (isPlainObject(a)) af = a;
  } catch {
    af = {};
  }
  const raw = {};
  for (const k of Object.keys(SETTINGS_KEYS))
    raw[k] = af[k] === undefined ? null : af[k];
  return raw;
}

router.get("/api/bulk-packs/settings", requireSuperadmin, (req, res) => {
  try {
    const s = deps.settings;
    res.json({
      success: true,
      settings: s.getBulkPacks(),
      raw: rawSettingsKeys(s),
      keys: Object.keys(SETTINGS_KEYS),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
});

router.post("/api/bulk-packs/settings", requireSuperadmin, async (req, res) => {
  try {
    const body = bodyOf(req);
    if (!isPlainObject(body.patch)) {
      return res.status(400).json({
        success: false,
        message: 'Send {"patch": {…}} with the bulk-pack settings to change',
        keys: Object.keys(SETTINGS_KEYS),
      });
    }
    const { patch, ignored, errors } = validateSettingsPatch(body.patch);
    if (errors.length) {
      return res
        .status(400)
        .json({ success: false, message: errors.join("; "), errors, ignored });
    }
    const changed = Object.keys(patch);
    if (!changed.length) {
      return res.status(400).json({
        success: false,
        message: "No bulk-pack settings in the patch",
        ignored,
        keys: Object.keys(SETTINGS_KEYS),
      });
    }
    const actor = actorFromReq(req);
    const s = deps.settings;
    await s.setAutoFarm(patch, { actor });
    invalidateProposals();
    logEvent({
      category: "bulk",
      action: "settings_changed",
      actor,
      subject: "bulk packs",
      count: changed.length,
      detail:
        "bulk-pack settings changed: " +
        changed.join(", ") +
        (own(patch, "bulkPacksEnabled")
          ? " (master switch " + (patch.bulkPacksEnabled ? "ON" : "OFF") + ")"
          : ""),
      meta: { patch },
    });
    res.json({
      success: true,
      changed,
      ignored,
      settings: s.getBulkPacks(),
      raw: rawSettingsKeys(s),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: errMsg(err) });
  }
});

module.exports = router;
module.exports.validateSettingsPatch = validateSettingsPatch;
module.exports.SETTINGS_KEYS = SETTINGS_KEYS;
module.exports.__setDeps = __setDeps;
module.exports.__resetDeps = __resetDeps;
