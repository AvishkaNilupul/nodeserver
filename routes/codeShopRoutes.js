"use strict";
// HTTP API of the code shop (docs/code-shop/04-OPS.md, "routes/codeShopRoutes.js").
//
// Thin handlers: check the shape of the input, call the code shop service
// (utils/codeShop/service.js) and answer what it said. Every route is
// superadmin-only and answers { success: true, ... } or
// { success: false, message } with a 4xx/5xx.
//
// The product routes (make a custom draft, merge drafts, edit, delete, reset
// texts) write CodeProduct here, always guarded on the status they expect, so
// an approved product's slots can never change under its live offer.
//
// A reward code leaves through exactly ONE route — POST /units/:id/replace —
// answered `Cache-Control: no-store`. Nothing here logs a request body.
//
// Review fixes (docs/code-shop/05-REVIEW-FIXES.md):
// - R1: products are made and edited for Eldorado only; GGSel is refused.
// - R3: approve, publish, resume, retire, adopt (apply) and held-release run in
//   the service's tick queue (service.exclusive), never beside a tick.
// - R5: an edit of an approved product sends the offer and the live Eldorado
//   offers only the fields sent AND changed; a price only when priceUsd changed.
// - R6: POST /held/:id/release hands a held code back to stock.
// - R8: CODE_SHOP=0 answers 503 everywhere; a 401/403 from a market is a 502
//   (a 401 to the browser would sign the owner out); a scan per product at
//   most once per 10 minutes (429).
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const { slotSetHash } = require("../utils/codeShop/slots");
const { defaultLabel, defaultTexts } = require("../utils/codeShop/texts");
const { checkBuyerText } = require("../utils/codeShop/textGuard");
const { eventStarts } = require("../utils/codeShop/eventDates");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { priceOf } = require("../utils/codeShop/publish");
const games = require("../utils/codeShop/games");

const PREFIX = "/api/code-shop";
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const LEVELS = ["info", "warn", "error"];
// The shop sells only here (Gameflip and Plati/Digiseller are blocked; GGSel is
// not used for codes yet, R1).
const MARKETS = ["eldorado", "playerauctions"];
const GGSEL_REFUSED = "GGSel is not used for codes yet: it never reports which code it sold, so a code could be sold twice";
const MIN_USD = 0.5;
const HOUR_MS = 3600 * 1000;
const SCAN_EVERY_MS = 10 * 60 * 1000;
const OFF_MESSAGE = "The code shop is switched off";
const MAX_SLOTS = 50;
const MAX_MERGE = 20;
const MAX_LIMIT = 1000;
// Storage caps only. The buyer-text limits (textGuard) are checked when a
// draft is approved, and before an approved product's texts are saved.
const TEXT_CAPS = {
  title: 1000,
  description: 10000,
  deliveryTemplate: 10000,
  coverTitle: 500,
  coverServiceText: 500,
};
const BULLETS_MAX = 20;
const BULLET_CAP = 500;
const LABEL_CAP = 200;
const PRICING_KEYS = ["mode", "priceUsd", "floorUsd", "clearance", "followCompetitors"];
// What the ledger read for a custom draft may see: never codeHash or a code.
const SLOT_ROW_FIELDS = {
  _id: 1,
  gameNo: 1,
  gameName: 1,
  groupKey: 1,
  slotKey: 1,
  nameRaw: 1,
  name: 1,
  image: 1,
  campaignTitle: 1,
  earnedAt: 1,
};

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (message, extra) => {
  throw new HttpError(400, message, extra);
};

const str = (v) => (v === undefined || v === null ? "" : String(v));
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const cents = (n) => Math.round(n * 100) / 100;
const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// Ascending, null last.
function cmpNullLast(a, b) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

// A list of strings from an error or a result, for an answer body.
function strList(v, max = 50) {
  return Array.isArray(v) ? v.slice(0, max).map((x) => str(x).slice(0, 500)) : [];
}

function fail(res, status, message, extra) {
  const body = { ...(isPlain(extra) ? extra : {}) };
  body.success = false;
  body.error = message;
  body.message = message;
  return res.status(status).json(body);
}

// ---- input ------------------------------------------------------------------

// A trimmed string, or undefined when the field was not sent.
function text(value, name, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null) {
    if (required) bad(`${name} is required`);
    return undefined;
  }
  const ok = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  if (!ok) bad(`${name} must be text`);
  const s = String(value).trim();
  if (required && !s) bad(`${name} is required`);
  if (s.length > max) bad(`${name} is too long (${max} characters at most)`);
  return s;
}

function flag(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") bad(`${name} must be true or false`);
  return value;
}

function objectId(value, name) {
  if (typeof value !== "string" || !OBJECT_ID_RE.test(value.trim())) bad(`${name} is not a valid id`);
  return value.trim().toLowerCase();
}

// An optional id from a query string ("" = not sent).
function optionalId(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  return objectId(typeof value === "string" ? value : null, name);
}

function idList(value, name, { min = 1, max = MAX_MERGE } = {}) {
  if (!Array.isArray(value)) bad(`${name} must be a list of ids`);
  if (value.length > max) bad(`${name} can hold ${max} entries at most`);
  const out = [];
  for (const v of value) {
    const id = objectId(v, name + " entry");
    if (!out.includes(id)) out.push(id);
  }
  if (out.length < min) bad(`${name}: pick at least ${min}`);
  return out;
}

// Slot keys: non-empty strings, trimmed, repeats dropped, order kept.
function keyList(value, name, { required = false, max = MAX_SLOTS } = {}) {
  if (value === undefined || value === null) {
    if (required) bad(`${name} is required`);
    return undefined;
  }
  if (!Array.isArray(value)) bad(`${name} must be a list`);
  if (value.length > max) bad(`${name} can hold ${max} entries at most`);
  const out = [];
  for (const v of value) {
    if (typeof v !== "string" || !v.trim() || v.length > 200) bad(`${name} must be a list of slot keys`);
    if (!out.includes(v.trim())) out.push(v.trim());
  }
  if (required && !out.length) bad(`${name} is empty — pick at least one`);
  return out;
}

function limitOf(value, fallback) {
  const s = text(value, "limit", { max: 9 });
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) bad("limit must be a whole number above zero");
  return Math.min(n, MAX_LIMIT);
}

// A 0-based slot index from a JSON body (number or digit string).
function slotOf(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,4}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0) bad("slot must be the place of the code in the bundle (0, 1, ...)");
  return n;
}

// texts -> only the fields sent; unknown fields refused so a typo is never a silent no-op.
function textsPatch(value) {
  if (value === undefined || value === null) return null;
  if (!isPlain(value)) bad("texts must be an object");
  const known = [...Object.keys(TEXT_CAPS), "coverBullets"];
  const unknown = Object.keys(value).filter((k) => !known.includes(k));
  if (unknown.length) bad("texts has unknown fields: " + unknown.join(", "));
  const out = {};
  for (const [k, cap] of Object.entries(TEXT_CAPS)) {
    if (value[k] === undefined) continue;
    if (typeof value[k] !== "string") bad(`texts.${k} must be text`);
    if (value[k].length > cap) bad(`texts.${k} is too long (${cap} characters at most)`);
    out[k] = value[k];
  }
  if (value.coverBullets !== undefined) {
    const b = value.coverBullets;
    if (!Array.isArray(b) || b.some((x) => typeof x !== "string")) bad("texts.coverBullets must be a list of lines");
    if (b.length > BULLETS_MAX) bad(`texts.coverBullets can hold ${BULLETS_MAX} lines at most`);
    if (b.some((x) => x.length > BULLET_CAP)) bad(`a cover bullet is too long (${BULLET_CAP} characters at most)`);
    out.coverBullets = [...b];
  }
  return Object.keys(out).length ? out : null;
}

// pricing -> only the fields sent, typed; the merged result is checked by the caller.
function pricingPatch(value) {
  if (value === undefined || value === null) return null;
  if (!isPlain(value)) bad("pricing must be an object");
  const unknown = Object.keys(value).filter((k) => !PRICING_KEYS.includes(k));
  if (unknown.length) bad("pricing has unknown fields: " + unknown.join(", "));
  const out = {};
  if (value.mode !== undefined) {
    if (value.mode !== "fixed" && value.mode !== "auto") bad('pricing.mode must be "fixed" or "auto"');
    out.mode = value.mode;
  }
  for (const k of ["priceUsd", "floorUsd"]) {
    if (value[k] === undefined) continue;
    const n = value[k];
    if (typeof n !== "number" || !Number.isFinite(n)) bad(`pricing.${k} must be an amount in dollars`);
    if (n < MIN_USD) bad(`pricing.${k} must be at least $${MIN_USD.toFixed(2)} (the market minimum)`);
    out[k] = cents(n);
  }
  for (const k of ["clearance", "followCompetitors"]) {
    const f = flag(value[k], "pricing." + k);
    if (f !== undefined) out[k] = f;
  }
  return Object.keys(out).length ? out : null;
}

function checkPrice(pricing) {
  const price = Number(pricing && pricing.priceUsd);
  const floor = Number(pricing && pricing.floorUsd);
  if (Number.isFinite(price) && Number.isFinite(floor) && floor > price) {
    bad(`The floor ($${floor.toFixed(2)}) is above the price ($${price.toFixed(2)})`);
  }
}

// R5: the fields of `patch` whose value differs from `stored` (texts or pricing),
// each compared in the shape the schema stores it.
function sameField(key, a, b) {
  if (key === "coverBullets") {
    const list = (v) => (Array.isArray(v) ? v.map(str) : []);
    return JSON.stringify(list(a)) === JSON.stringify(list(b));
  }
  if (key === "priceUsd" || key === "floorUsd") {
    const n = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : cents(Number(v)));
    return n(a) === n(b);
  }
  if (key === "clearance" || key === "followCompetitors") return !!a === !!b;
  return str(a) === str(b);
}
function changedFields(patch, stored) {
  const out = {};
  const s = isPlain(stored) ? stored : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!sameField(k, v, s[k])) out[k] = v;
  }
  return out;
}

// What a released stock row may show the browser: never codeHash or a code.
function rowOut(r) {
  if (!isPlain(r)) return null;
  const at = (d) => (toMs(d) === null ? null : new Date(toMs(d)).toISOString());
  return {
    id: str(r._id || r.id),
    loginId: str(r.loginId),
    gameNo: str(r.gameNo),
    gameName: str(r.gameName),
    slotKey: str(r.slotKey),
    name: str(r.name),
    nameRaw: str(r.nameRaw),
    codeShape: str(r.codeShape),
    state: str(r.state),
    problem: str(r.problem),
    useBy: at(r.useBy),
  };
}

function marketList(value) {
  if (!Array.isArray(value)) bad("markets must be a list");
  const out = [];
  for (const m of value) {
    if (m === "ggsel") bad(GGSEL_REFUSED);
    if (typeof m !== "string" || !MARKETS.includes(m)) {
      bad("markets may only contain " + MARKETS.join(", ") + " (got " + JSON.stringify(m).slice(0, 40) + ")");
    }
    if (!out.includes(m)) out.push(m);
  }
  if (!out.length) bad("Pick at least one market");
  return MARKETS.filter((m) => out.includes(m));
}

function labelList(value, count) {
  if (!Array.isArray(value)) bad("labels must be a list");
  if (value.length !== count) bad(`labels must hold one entry per reward of the bundle (${count}); reload and try again`);
  return value.map((l, i) => {
    if (typeof l !== "string") bad(`label ${i + 1} must be text`);
    if (l.length > LABEL_CAP) bad(`label ${i + 1} is too long (${LABEL_CAP} characters at most)`);
    return l;
  });
}

// ---- results ----------------------------------------------------------------

// A publisher answer of { ok: false } becomes an HTTP error carrying the whole
// answer, so the panel never reports a refused action as done.
function refuseUnlessOk(r, lead = "") {
  if (!r || r.ok !== false) return;
  const problems = strList(r.problems);
  const errors = strList(r.errors);
  const why = str(r.error) || problems.join("; ") || errors.join("; ") || "the code shop refused it";
  let status = 400;
  if (/\bnot found\b/i.test(why)) status = 404;
  else if (!r.error && !problems.length && errors.length) status = 502; // a market call failed
  throw new HttpError(status, (lead ? lead + ": " : "") + why, { ...r, problems });
}

// ---- the router ---------------------------------------------------------------

const switchedOff = () => str(process.env.CODE_SHOP).trim() === "0";

// `service` is the code shop service, or a function returning it (resolved on
// every request, so mounting the router never loads the service).
// `createHeld(deps)` builds the held-code releaser (utils/codeShop/held.js by
// default; tests pass a fake).
function createCodeShopRoutes({ service, createHeld } = {}) {
  if (!service) throw new TypeError("createCodeShopRoutes needs { service }");
  const router = express.Router();
  const makeHeld = typeof createHeld === "function" ? createHeld : (deps) => require("../utils/codeShop/held").createHeld(deps);

  const svc = () => {
    const s = typeof service === "function" ? service() : service;
    if (!s || !s.modules) throw new HttpError(503, "The code shop is not running");
    return s;
  };
  // R3: owner actions that can fill, publish or hand stock back run in the
  // same queue as the ticks, so they never overlap one.
  const exclusive = (fn) => {
    const s = svc();
    if (typeof s.exclusive !== "function") throw new HttpError(503, "The code shop queue is not available; nothing was done");
    return s.exclusive(fn);
  };
  // R6: built on first use from the service's deps (rebuilt if the service changes).
  let heldApi = null;
  let heldOf = null;
  const held = () => {
    const s = svc();
    if (!heldApi || heldOf !== s) {
      const h = makeHeld(s.deps || {});
      if (!h || typeof h.release !== "function") throw new HttpError(503, "The held-code module is not available");
      heldApi = h;
      heldOf = s;
    }
    return heldApi;
  };
  // R8: product id -> when its last scan was asked for (this process).
  const scannedAt = new Map();
  const mod = (name) => {
    const m = svc().modules[name];
    if (!m) throw new HttpError(503, `The code shop ${name} module is not available`);
    return m;
  };
  const deps = () => svc().deps || {};
  const model = (name) => (deps().models && deps().models[name]) || require("../models/" + name);
  const now = () => {
    const t = typeof deps().now === "function" ? toMs(deps().now()) : null;
    return t === null ? Date.now() : t;
  };
  const guideFor = (gameNo, cfg) =>
    (typeof deps().guideFor === "function" ? deps().guideFor : games.guideFor)(gameNo, cfg);
  const mp = () => (typeof deps().mp === "function" ? deps().mp() : require("../utils/marketplaces"));

  async function getConfig() {
    const cfg = await mod("config").get();
    return isPlain(cfg) ? cfg : deepMerge(DEFAULTS, null);
  }

  // Events are best-effort: a failed write never fails the action.
  async function note(entry) {
    try {
      const ev = svc().modules.events;
      if (ev && typeof ev.log === "function") await ev.log(entry);
    } catch (err) {
      console.error("[code-shop] event not saved: " + str(err && err.message));
    }
  }

  // handler({ body, query, params, req, res, actor }) returns the payload
  // (without `success`).
  function route(method, path, handler) {
    const name = method.toUpperCase() + " " + path;
    router[method](PREFIX + path, requireSuperadmin, async (req, res) => {
      // R8: CODE_SHOP=0 turns the API off as well as the ticks.
      if (switchedOff()) return fail(res, 503, OFF_MESSAGE);
      try {
        const b = req.body;
        const body = isPlain(b) ? b : {};
        const admin = (req.session && req.session.admin) || {};
        const actor = str(admin.username || admin.id || "").slice(0, 80);
        const out = await handler({ body, query: req.query || {}, params: req.params || {}, req, res, actor });
        if (res.headersSent) return undefined;
        const payload = { success: true, ...(isPlain(out) ? out : {}) };
        payload.success = true;
        return res.json(payload);
      } catch (err) {
        if (res.headersSent) return undefined;
        let status = err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 0;
        if (status) {
          const extra = err instanceof HttpError ? err.extra : null;
          const lists = {};
          if (!extra && Array.isArray(err.errors)) lists.errors = strList(err.errors);
          if (!extra && Array.isArray(err.problems)) lists.problems = strList(err.problems);
          let message = str(err.message) || "That could not be done";
          // R8: a 401/403 here is a market refusing the shop, not the owner's
          // session; passed on as is it would sign the owner out of the panel.
          if (status === 401 || status === 403) {
            lists.marketStatus = status;
            message = "A marketplace refused the call (HTTP " + status + "): " + message;
            status = 502;
          }
          if (status === 429 && Number.isFinite(err.retryAfterSec) && err.retryAfterSec > 0) {
            res.set("Retry-After", String(Math.ceil(err.retryAfterSec)));
          }
          return fail(res, status, message, extra ? { ...extra, ...(lists.marketStatus ? { marketStatus: lists.marketStatus } : {}) } : lists);
        }
        // The message only: a request body is never logged.
        console.error(`[code-shop] ${name} error:`, err && err.message);
        return fail(res, 500, "Server error");
      }
    });
  }

  // ---- product helpers --------------------------------------------------------

  async function loadProduct(id, projection) {
    const p = await model("CodeProduct").findById(id, projection).lean();
    if (!p) throw new HttpError(404, "No code shop product with that id");
    return p;
  }

  const productView = async (id) => (await mod("views").product(id)).product;

  // The start dates of the events a product's codes come from (buyer texts
  // name an event by its date only).
  const eventStartsOf = (groupKeys) =>
    eventStarts({ SoopCampaign: model("SoopCampaign"), ChzzkCampaign: model("ChzzkCampaign"), CodeStock: model("CodeStock") }, groupKeys);

  const sourceWordsOf = (cfg) => (Array.isArray(cfg.sourceWords) ? cfg.sourceWords : DEFAULTS.sourceWords);
  const enabledMarkets = (cfg) => MARKETS.filter((m) => cfg.markets && cfg.markets[m] === true);

  // The earliest use-by of the free codes that are still usable past the
  // expiry lead: the date the default texts print (as the planner does).
  async function freeUseBy(slotKeys, cfg) {
    const keys = slotKeys.filter(Boolean);
    if (!keys.length) return null;
    const leadH = Number(cfg.expiryLeadHours);
    const lead = Number.isFinite(leadH) && leadH >= 0 ? leadH : DEFAULTS.expiryLeadHours;
    const [r] = await model("CodeStock").aggregate([
      { $match: { state: "in_stock", slotKey: { $in: keys }, useBy: { $gt: new Date(now() + lead * HOUR_MS) } } },
      { $group: { _id: null, at: { $min: "$useBy" } } },
    ]);
    return r && r.at ? r.at : null;
  }

  // slotKey -> { slotKey, label, image, nameRaw, campaignTitle, firstEarnedAt, gameNo, gameName, groupKey }
  // from ledger rows read oldest first, so "first non-empty" is the oldest row's.
  function slotMetas(rows, sourceWords) {
    const sorted = rows
      .slice()
      .sort((a, b) => cmpNullLast(toMs(a.earnedAt), toMs(b.earnedAt)) || cmpStr(str(a._id), str(b._id)));
    const out = new Map();
    for (const r of sorted) {
      const key = str(r.slotKey);
      if (!key) continue;
      let s = out.get(key);
      if (!s) {
        s = { slotKey: key, label: "", image: "", nameRaw: "", campaignTitle: "", firstEarnedAt: null, gameNo: str(r.gameNo), gameName: "", groupKey: "" };
        out.set(key, s);
      }
      const earned = toMs(r.earnedAt);
      if (s.firstEarnedAt === null && earned !== null) s.firstEarnedAt = earned;
      if (!s.label) s.label = defaultLabel(r, { sourceWords });
      if (!s.image) s.image = str(r.image);
      if (!s.nameRaw) s.nameRaw = str(r.nameRaw);
      if (!s.campaignTitle) s.campaignTitle = str(r.campaignTitle);
      if (!s.gameName) s.gameName = str(r.gameName);
      if (!s.groupKey) s.groupKey = str(r.groupKey);
    }
    return out;
  }

  const slotOut = (s) => ({
    slotKey: str(s.slotKey),
    label: str(s.label),
    image: str(s.image),
    nameRaw: str(s.nameRaw),
    campaignTitle: str(s.campaignTitle),
  });

  // A non-retired product (other than `except`) that owns exactly this set -> 409.
  async function refuseDuplicateSet(hash, except = []) {
    const q = { slotSetHash: hash, status: { $ne: "retired" } };
    if (except.length) q._id = { $nin: except };
    const other = await model("CodeProduct").findOne(q, { _id: 1, name: 1, status: 1 }).lean();
    if (other) {
      throw new HttpError(
        409,
        `A product with exactly these rewards already exists: "${str(other.name)}" (${str(other.status)})`,
        { productId: String(other._id) },
      );
    }
  }

  async function createDraft({ name, slots, gameNo, gameName, marketGame, groupKeys, markets, cfg, actor, how }) {
    const guide = guideFor(gameNo, cfg);
    const keys = slots.map((s) => s.slotKey);
    const useBy = await freeUseBy(keys, cfg);
    const starts = await eventStartsOf(groupKeys);
    const n = slots.length;
    const titles = [...new Set(slots.map((s) => s.campaignTitle).filter(Boolean))];
    const display = gameName || guide.displayName;
    const product = await model("CodeProduct").create({
      name:
        name ||
        `${display} - ${titles.length === 1 ? titles[0] : "custom bundle"} (${plural(n, "code")})`,
      gameNo,
      gameName,
      marketGame: marketGame || guide.marketGame,
      groupKeys,
      slots,
      slotSetHash: slotSetHash(keys),
      status: "draft",
      origin: "manual",
      kind: "custom",
      edited: true,
      stale: false,
      texts: defaultTexts({ slots, guide, useBy, now: now(), eventStarts: starts }),
      pricing: { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
      // PlayerAuctions only for a game allowed there (Overwatch, not Delta Force).
      markets: require("../utils/codeShop/config").marketsForGame(markets, gameNo, cfg),
    });
    await note({
      kind: "draft",
      product: product._id,
      msg: `${actor || "an admin"} made the draft "${product.name}" (${plural(n, "reward")}, ${how})`,
      data: { actor, slots: n },
    });
    return product;
  }

  // ---- state and views --------------------------------------------------------

  route("get", "/state", async () => ({ ...(await mod("views").state()) }));

  route("get", "/stock", async () => ({ ...(await mod("views").stock()) }));

  route("get", "/logins", async () => ({ ...(await mod("views").logins()) }));

  route("get", "/sold", async ({ query }) => {
    const limit = limitOf(query.limit, 100);
    const productId = optionalId(query.product, "product");
    return { sold: await mod("afterSale").sold({ limit, productId }) };
  });

  route("get", "/events", async ({ query }) => {
    const limit = limitOf(query.limit, 100);
    const kind = text(query.kind, "kind", { max: 40 }) || undefined;
    const level = text(query.level, "level", { max: 10 }) || undefined;
    if (level && !LEVELS.includes(level)) bad("level must be info, warn or error");
    const product = optionalId(query.product, "product");
    return { events: await mod("events").recent({ limit, kind, level, product }) };
  });

  // ---- products -----------------------------------------------------------------

  route("get", "/products/:id", async ({ params }) => {
    const id = objectId(params.id, "product id");
    return { ...(await mod("views").product(id)) };
  });

  // A custom draft from rewards picked in the Stock view (one game only).
  route("post", "/products", async ({ body, actor }) => {
    const keys = keyList(body.slotKeys, "slotKeys", { required: true });
    const name = text(body.name, "name", { max: 120 }) || "";
    const cfg = await getConfig();
    const rows = await model("CodeStock").find({ slotKey: { $in: keys } }, SLOT_ROW_FIELDS).lean();
    const metas = slotMetas(rows, sourceWordsOf(cfg));
    const missing = keys.filter((k) => !metas.has(k));
    if (missing.length) bad(`${plural(missing.length, "reward")} not found in stock: ${missing.slice(0, 5).join(", ")}`);
    const gameNos = [...new Set(rows.map((r) => str(r.gameNo)))];
    if (gameNos.length !== 1) bad("A bundle holds rewards of one game only (these are of " + gameNos.length + " games)");

    const picked = keys
      .map((k) => metas.get(k))
      .sort((a, b) => cmpNullLast(a.firstEarnedAt, b.firstEarnedAt) || cmpStr(a.nameRaw, b.nameRaw) || cmpStr(a.slotKey, b.slotKey));
    await refuseDuplicateSet(slotSetHash(keys));

    const product = await createDraft({
      name,
      slots: picked.map(slotOut),
      gameNo: gameNos[0],
      gameName: (picked.find((s) => s.gameName) || {}).gameName || "",
      marketGame: "",
      groupKeys: [...new Set(picked.map((s) => s.groupKey).filter(Boolean))],
      markets: enabledMarkets(cfg),
      cfg,
      actor,
      how: "picked from stock",
    });
    return { product: { id: String(product._id), name: product.name } };
  });

  // Registered before /products/:id, which would otherwise take "merge" as an id.
  route("post", "/products/merge", async ({ body, actor }) => {
    const ids = idList(body.ids, "ids", { min: 2 });
    const name = text(body.name, "name", { max: 120 }) || "";
    const found = await model("CodeProduct").find({ _id: { $in: ids } }).lean();
    const byId = new Map(found.map((p) => [String(p._id), p]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new HttpError(404, "No code shop product with id " + missing.join(", "));
    const list = ids.map((id) => byId.get(id));
    const notDraft = list.filter((p) => p.status !== "draft" || p.offer);
    if (notDraft.length) {
      bad(`Only drafts can be merged: "${str(notDraft[0].name)}" is ${notDraft[0].offer ? "approved" : str(notDraft[0].status)}`);
    }
    if (new Set(list.map((p) => str(p.gameNo))).size !== 1) bad("Only drafts of one game can be merged");

    // Union in the order the drafts were picked; the first label of a slot wins.
    const slots = [];
    const seen = new Set();
    for (const p of list) {
      for (const s of Array.isArray(p.slots) ? p.slots : []) {
        const key = str(s && s.slotKey);
        if (!key) bad(`"${str(p.name)}" has a reward without a slot key; it cannot be merged`);
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push(slotOut(s));
      }
    }
    if (!slots.length) bad("These drafts hold no rewards");
    if (slots.length > MAX_SLOTS) bad(`A bundle can hold ${MAX_SLOTS} rewards at most`);

    // The merged planner drafts are deleted below, so they do not count as
    // owners of the set; a hand-made draft (or any live product) does.
    const autos = list.filter((p) => p.origin === "auto").map((p) => p._id);
    await refuseDuplicateSet(slotSetHash(slots.map((s) => s.slotKey)), autos);

    const cfg = await getConfig();
    const picked = MARKETS.filter((m) => list.some((p) => Array.isArray(p.markets) && p.markets.includes(m)));
    const product = await createDraft({
      name,
      slots,
      gameNo: str(list[0].gameNo),
      gameName: str((list.find((p) => p.gameName) || {}).gameName),
      marketGame: str((list.find((p) => p.marketGame) || {}).marketGame),
      groupKeys: [...new Set(list.flatMap((p) => (Array.isArray(p.groupKeys) ? p.groupKeys : [])).map(str).filter(Boolean))],
      markets: picked.length ? picked : enabledMarkets(cfg),
      cfg,
      actor,
      how: "merged from " + plural(list.length, "draft"),
    });

    let deleted = 0;
    for (const _id of autos) {
      // Guarded: a draft approved in the meantime is never deleted.
      const r = await model("CodeProduct").deleteOne({ _id, status: "draft", origin: "auto", offer: null });
      deleted += Number(r && r.deletedCount) || 0;
    }
    return { product: { id: String(product._id), name: product.name }, deleted };
  });

  route("post", "/products/:id", async ({ params, body, actor }) => {
    const id = objectId(params.id, "product id");
    const p = await loadProduct(id);
    if (p.status === "retired") throw new HttpError(409, "A retired product cannot be edited");
    const draft = p.status === "draft";

    const name = text(body.name, "name", { max: 120 });
    const noteText = text(body.note, "note", { max: 1000 });
    const textsP = textsPatch(body.texts);
    const pricingP = pricingPatch(body.pricing);
    const pricing = { ...(p.pricing || {}), ...(pricingP || {}) };
    if (pricingP) checkPrice(pricing);
    if (name !== undefined && !name) bad("name cannot be empty");
    // R5: an adopted listing keeps the price its owner set.
    if (p.origin === "adopted" && pricingP && pricingP.mode === "auto") {
      bad("An adopted product keeps a fixed price: it cannot switch to auto pricing");
    }

    const $set = {};
    if (name !== undefined) $set.name = name;
    if (noteText !== undefined) $set.note = noteText;
    for (const [k, v] of Object.entries(textsP || {})) $set["texts." + k] = v;
    for (const [k, v] of Object.entries(pricingP || {})) $set["pricing." + k] = v;

    if (draft) {
      const slotsChange = body.labels !== undefined || body.removeSlots !== undefined || body.slotOrder !== undefined;
      if (body.markets !== undefined) $set.markets = marketList(body.markets);
      if (slotsChange) {
        let slots = (Array.isArray(p.slots) ? p.slots : []).map(slotOut);
        if (body.labels !== undefined) {
          const labels = labelList(body.labels, slots.length);
          slots = slots.map((s, i) => ({ ...s, label: labels[i] }));
        }
        const remove = keyList(body.removeSlots, "removeSlots");
        if (remove && remove.length) {
          const unknown = remove.filter((k) => !slots.some((s) => s.slotKey === k));
          if (unknown.length) bad("removeSlots names a reward that is not in the bundle: " + unknown[0]);
          slots = slots.filter((s) => !remove.includes(s.slotKey));
          if (!slots.length) bad("A bundle needs at least one reward");
        }
        if (body.slotOrder !== undefined) {
          if (!Array.isArray(body.slotOrder) || body.slotOrder.some((k) => typeof k !== "string")) {
            bad("slotOrder must be a list of slot keys");
          }
          const order = body.slotOrder;
          const left = slots.map((s) => s.slotKey);
          const same = order.length === left.length && [...order].sort().join("\n") === [...left].sort().join("\n");
          if (!same) bad("slotOrder must list every reward left in the bundle exactly once; reload and try again");
          // A queue per key keeps a repeated key's slots in their stored order.
          const queues = new Map();
          for (const s of slots) {
            if (!queues.has(s.slotKey)) queues.set(s.slotKey, []);
            queues.get(s.slotKey).push(s);
          }
          slots = order.map((k) => queues.get(k).shift());
        }
        const keys = slots.map((s) => s.slotKey);
        const hash = slotSetHash(keys);
        if (hash !== p.slotSetHash) await refuseDuplicateSet(hash, [p._id]);
        const groups = (Array.isArray(p.groupKeys) ? p.groupKeys : []).filter((g) => keys.some((k) => k.startsWith(g + ":")));
        $set.slots = slots;
        $set.slotSetHash = hash;
        if (groups.length) $set.groupKeys = groups;
      }
      if (!Object.keys($set).length) bad("Nothing to change");
      $set.edited = true;
      $set.stale = false;
      const r = await model("CodeProduct").updateOne({ _id: p._id, status: "draft", offer: null }, { $set });
      if (!r.matchedCount) throw new HttpError(409, "The draft changed (it may have been approved); reload and try again");
      await note({ kind: "edit", product: p._id, msg: `${actor || "an admin"} edited the draft "${str($set.name || p.name)}"`, data: { actor } });
      return { product: await productView(id) };
    }

    // Active / paused: the rewards and markets are fixed once approved.
    for (const k of ["labels", "slotOrder", "removeSlots", "markets"]) {
      if (body[k] !== undefined) bad(`${k} can only change on a draft (this product is ${p.status})`);
    }
    const pushLive = flag(body.pushLive, "pushLive") === true;

    // R5: only what was sent AND differs from what is stored is written, to
    // the product, its offer and (with pushLive) its live Eldorado offers; an
    // unchanged price is never pushed. (The panel sends only the fields the
    // owner touched, so a stale form value is not sent at all.)
    const textsC = changedFields(textsP, p.texts);
    const pricingC = changedFields(pricingP, p.pricing);
    const live$set = {};
    if (name !== undefined && name !== str(p.name)) live$set.name = name;
    if (noteText !== undefined && noteText !== str(p.note)) live$set.note = noteText;
    for (const [k, v] of Object.entries(textsC)) live$set["texts." + k] = v;
    for (const [k, v] of Object.entries(pricingC)) live$set["pricing." + k] = v;
    if (!Object.keys(live$set).length) {
      bad(pushLive ? "Nothing to change: no field differs from what is saved, so nothing is sent to Eldorado" : "Nothing to change");
    }

    const texts = { ...(p.texts || {}), ...textsC };
    // These texts reach buyers without an approval step (the offer's delivery
    // message, and the live listing with pushLive): guard them now.
    if (Object.keys(textsC).length) {
      const cfg = await getConfig();
      const problems = checkBuyerText(
        { ...texts, labels: (Array.isArray(p.slots) ? p.slots : []).map((s) => str(s && s.label)) },
        { sourceWords: sourceWordsOf(cfg) },
      );
      if (problems.length) bad("Not saved: " + problems.join("; "), { problems });
    }

    const r = await model("CodeProduct").updateOne({ _id: p._id, status: { $in: ["active", "paused"] } }, { $set: live$set });
    if (!r.matchedCount) throw new HttpError(409, "The product changed (it may have been retired); reload and try again");

    const merged = { ...p, texts, pricing: { ...(p.pricing || {}), ...pricingC } };
    const offerSet = {};
    for (const k of ["title", "description", "deliveryTemplate", "coverServiceText"]) {
      if (textsC[k] !== undefined) offerSet[k] = str(textsC[k]);
    }
    if (textsC.coverBullets !== undefined) offerSet.coverBullets = textsC.coverBullets.map(str);
    if (pricingC.priceUsd !== undefined) offerSet.priceUsd = Number(pricingC.priceUsd) || 0;
    if (pricingC.floorUsd !== undefined) offerSet.minPriceUsd = Number(pricingC.floorUsd) || 0;
    if (p.offer && Object.keys(offerSet).length) {
      await model("AccountOffer").updateOne({ _id: p.offer }, { $set: offerSet });
    }

    // Eldorado gets the changed title and description, and a price only when
    // pricing.priceUsd itself changed; anything not sent keeps its live value.
    const patch = {};
    if (textsC.title !== undefined) patch.title = str(texts.title);
    if (textsC.description !== undefined) patch.description = str(texts.description);
    if (pricingC.priceUsd !== undefined) patch.priceUsd = priceOf(merged);
    const rowSet = {};
    if (patch.title !== undefined) rowSet.title = patch.title;
    if (patch.description !== undefined) rowSet.description = patch.description;
    if (patch.priceUsd !== undefined) rowSet.price = patch.priceUsd;
    const sendLive = pushLive && !!p.offer && Object.keys(patch).length > 0;

    const live = [];
    if (sendLive) {
      const rows = await model("MarketplaceListing")
        .find({ accountOffer: p.offer, marketplace: "eldorado", status: "active" }, { _id: 1, externalId: 1 })
        .sort({ _id: 1 })
        .lean();
      // One at a time: these are live offers.
      for (const row of rows) {
        const entry = { listingId: String(row._id), externalId: str(row.externalId) };
        try {
          await mp().eldoradoUpdateOffer(row.externalId, { ...patch });
        } catch (err) {
          live.push({ ...entry, ok: false, error: str(err && err.message).slice(0, 300) || "Eldorado refused the change" });
          continue;
        }
        try {
          await model("MarketplaceListing").updateOne({ _id: row._id }, { $set: rowSet });
          live.push({ ...entry, ok: true });
        } catch (err) {
          live.push({ ...entry, ok: false, error: "Eldorado was updated but the listing row was not: " + str(err && err.message).slice(0, 200) });
        }
      }
    }
    const failed = live.filter((x) => !x.ok);
    const label = str(live$set.name || p.name);
    const sent = Object.keys(patch);
    await note({
      level: failed.length ? "warn" : "info",
      kind: "edit",
      product: p._id,
      msg:
        `${actor || "an admin"} edited "${label}" (${Object.keys(live$set).join(", ")})` +
        (sendLive ? `; ${live.length - failed.length} of ${plural(live.length, "live Eldorado offer")} updated (${sent.join(", ")})` : "") +
        (failed.length ? ` (${failed.map((x) => x.externalId + ": " + x.error).join("; ")})` : ""),
      data: { actor, pushLive, fields: Object.keys(live$set), sent, live: live.length, failed: failed.length },
    });
    const out = { product: await productView(id), changed: Object.keys(live$set) };
    if (pushLive) {
      out.live = live;
      out.sent = sent;
    }
    if (failed.length) {
      out.message = `Saved, but ${plural(failed.length, "live Eldorado offer")} could not be updated: ${failed[0].error}`;
    } else if (pushLive && !sent.length) {
      out.message = "Saved. Nothing was sent to Eldorado: the title, description and price did not change";
    }
    return out;
  });

  // Only a draft that was never approved: anything else may own a live offer.
  route("delete", "/products/:id", async ({ params, actor }) => {
    const id = objectId(params.id, "product id");
    const p = await loadProduct(id, { _id: 1, name: 1, status: 1, offer: 1 });
    if (p.status !== "draft" || p.offer) {
      throw new HttpError(409, `Only a draft can be deleted (this product is ${p.offer && p.status === "draft" ? "approved" : p.status}); retire it instead`);
    }
    const r = await model("CodeProduct").deleteOne({ _id: p._id, status: "draft", offer: null });
    if (!r.deletedCount) throw new HttpError(409, "The draft changed (it may have been approved); reload and try again");
    await note({ kind: "draft", msg: `${actor || "an admin"} deleted the draft "${str(p.name)}"`, data: { actor, product: id } });
    return { deleted: 1 };
  });

  route("post", "/products/:id/approve", async ({ params, body, actor }) => {
    const id = objectId(params.id, "product id");
    const rebalance = flag(body.rebalance, "rebalance");
    const publish = flag(body.publish, "publish");
    const publisher = mod("publisher");
    const r = await exclusive(() => publisher.approve(id, { actor, rebalance, publish }));
    refuseUnlessOk(r, "Not approved");
    return { ...(r || {}) };
  });

  route("post", "/products/:id/publish", async ({ params, actor }) => {
    const id = objectId(params.id, "product id");
    const publisher = mod("publisher");
    const r = (await exclusive(() => publisher.publishProduct(id, { actor }))) || {};
    if (r.error && !(Array.isArray(r.results) && r.results.length)) {
      throw new HttpError(/\bnot found\b/i.test(r.error) ? 404 : 400, str(r.error), { results: [] });
    }
    return { ...r };
  });

  // Pause only takes stock off sale; resume and retire can list or hand codes
  // back, so they wait for the tick queue (R3).
  const QUEUED = new Set(["resume", "retire"]);
  for (const action of ["pause", "resume", "retire"]) {
    route("post", `/products/:id/${action}`, async ({ params, actor }) => {
      const id = objectId(params.id, "product id");
      const publisher = mod("publisher");
      const go = () => publisher[action](id, { actor });
      const r = QUEUED.has(action) ? await exclusive(go) : await go();
      refuseUnlessOk(r);
      return { ...(r || {}) };
    });
  }

  // R8: one scan per product per 10 minutes; each scan reads Eldorado.
  route("post", "/products/:id/scan", async ({ params }) => {
    const id = objectId(params.id, "product id");
    await loadProduct(id, { _id: 1 });
    const t = now();
    for (const [k, at] of scannedAt) if (t - at >= SCAN_EVERY_MS || at > t) scannedAt.delete(k);
    const last = scannedAt.get(id);
    if (last !== undefined) {
      const waitMs = SCAN_EVERY_MS - (t - last);
      const mins = Math.max(1, Math.ceil(waitMs / 60000));
      const err = new HttpError(429, `This product was scanned less than 10 minutes ago; scan it again in ${plural(mins, "minute")}`, {
        retryAfterSec: Math.ceil(waitMs / 1000),
      });
      err.retryAfterSec = Math.ceil(waitMs / 1000);
      throw err;
    }
    scannedAt.set(id, t);
    return { competitors: await mod("competitors").scan(id) };
  });

  // Fresh default texts from the SAVED slots and labels (drafts only).
  route("post", "/products/:id/texts/reset", async ({ params, actor }) => {
    const id = objectId(params.id, "product id");
    const p = await loadProduct(id);
    if (p.status !== "draft" || p.offer) throw new HttpError(409, `Texts are reset on drafts only (this product is ${p.status})`);
    const cfg = await getConfig();
    const slots = Array.isArray(p.slots) ? p.slots : [];
    const useBy = await freeUseBy(slots.map((s) => str(s && s.slotKey)), cfg);
    const starts = await eventStartsOf(Array.isArray(p.groupKeys) ? p.groupKeys : []);
    const texts = defaultTexts({ slots, guide: guideFor(p.gameNo, cfg), useBy, now: now(), eventStarts: starts });
    const r = await model("CodeProduct").updateOne({ _id: p._id, status: "draft", offer: null }, { $set: { texts } });
    if (!r.matchedCount) throw new HttpError(409, "The draft changed (it may have been approved); reload and try again");
    await note({ kind: "edit", product: p._id, msg: `${actor || "an admin"} reset the texts of "${str(p.name)}"`, data: { actor } });
    return { product: await productView(id) };
  });

  // ---- after sale -------------------------------------------------------------

  route("post", "/units/:id/report", async ({ params, body, actor }) => {
    const id = objectId(params.id, "bundle id");
    const slot = slotOf(body.slot);
    const status = text(body.status, "status", { required: true, max: 10 });
    if (status !== "dead" && status !== "ok") bad('status must be "dead" or "ok"');
    const why = text(body.note, "note", { max: 500 }) || "";
    return { ...((await mod("afterSale").report(id, { slot, status, note: why, actor })) || {}) };
  });

  // The ONE answer that holds a code: never cached, never logged.
  route("post", "/units/:id/replace", async ({ params, body, res, actor }) => {
    res.set("Cache-Control", "no-store");
    const id = objectId(params.id, "bundle id");
    const slot = slotOf(body.slot);
    const r = (await mod("afterSale").replace(id, { slot, actor })) || {};
    if (typeof r.code !== "string" || !r.code) {
      throw new HttpError(500, "No replacement code came back; look at the order before trying again");
    }
    return { code: r.code, label: str(r.label), codeShape: str(r.codeShape) };
  });

  // ---- adopt ------------------------------------------------------------------

  route("get", "/adopt/candidates", async () => ({ candidates: await mod("adopt").candidates() }));

  // A check (apply false) only reads; an adoption writes stock, so it waits
  // for the tick queue (R3).
  route("post", "/adopt", async ({ body, actor }) => {
    const offerId = objectId(body.offerId, "offerId");
    const apply = flag(body.apply, "apply") === true;
    const adopt = mod("adopt");
    const go = () => adopt.adopt(offerId, { apply, actor });
    return { ...((apply ? await exclusive(go) : await go()) || {}) };
  });

  // ---- held codes ---------------------------------------------------------------

  // R6: the owner vouches that a held code was never given to anyone; held.js
  // re-reads and re-checks it and refuses (with a status) what it cannot release.
  route("post", "/held/:id/release", async ({ params, actor }) => {
    const id = objectId(params.id, "stock row id");
    const h = held();
    const r = await exclusive(() => h.release(id, { actor }));
    const row = isPlain(r) && isPlain(r.row) ? r.row : r;
    return { row: rowOut(row) };
  });

  // ---- settings and engine --------------------------------------------------------

  route("post", "/config", async ({ body, actor }) => {
    const patch = body.patch ?? body;
    if (!isPlain(patch)) bad("Send the settings to change as an object");
    return { config: await mod("config").set(patch, { actor }) };
  });

  route("post", "/run", async ({ body }) => {
    const step = text(body.step, "step", { required: true, max: 40 });
    return { result: await svc().runStep(step) };
  });

  return router;
}

module.exports = createCodeShopRoutes;
module.exports.createCodeShopRoutes = createCodeShopRoutes;

// The router on the service singleton, built on first use; the service itself
// is only required by the first request.
let singleton = null;
Object.defineProperty(module.exports, "router", {
  enumerable: true,
  get() {
    if (!singleton) {
      singleton = createCodeShopRoutes({ service: () => require("../utils/codeShop/service").service });
    }
    return singleton;
  },
});
