// FunPay resale API (docs/FUNPAY-RESALE-CONTRACT.md §8) — every route superadmin.
//
// The page behind it (public/funpay-resale.html) holds the FunPay login box and
// the buttons that spend money, so three rules shape every handler:
//   - Secrets never leave. The cookie jar is only ever written here (POST
//     /session) and a bought login is only ever read through POST
//     /purchases/:id/reveal, which writes an audit line naming the purchase and
//     nothing else. Every other answer is built from whitelisted fields, so a
//     field added to a model or to an ops result later cannot ride out on a
//     spread.
//   - Money waits for a human. A purchase starts only from POST .../buy, one at a
//     time in this process; auto-buy and new listings stay refused until one test
//     purchase has worked (settings.commissioned).
//   - Live listings stay coherent: one active Eldorado offer per deal, published
//     one at a time, never a title already on sale, never linked onto a row that
//     another stock mode owns, and never unlinked or deleted out from under an
//     Eldorado order still being worked.
//
// server.js mounts this at "/" behind enforce2fa, so every route spells its full
// path and carries requireSuperadmin itself: a bare router.use() would gate every
// request in the app that falls through to it. The feature's modules are
// required lazily through `deps`, so a missing one answers 503 on its routes
// instead of keeping the server from starting, and tests swap them.

const fs = require("fs");
const path = require("path");
const express = require("express");
const { requireSuperadmin } = require("../middleware/auth");

const router = express.Router();
const BASE = "/api/funpay-resale";

// ------------------------------------------------------------------ deps
// Lazy getters: assigning a value swaps the dependency, assigning undefined
// puts the real module back.
const deps = {};
function lazy(name, load) {
  let swapped;
  Object.defineProperty(deps, name, {
    enumerable: true,
    get: () => (swapped !== undefined ? swapped : load()),
    set: (v) => {
      swapped = v;
    },
  });
}
lazy("Source", () => require("../models/FunpaySource"));
lazy("Purchase", () => require("../models/FunpayPurchase"));
lazy("Listing", () => require("../models/MarketplaceListing"));
lazy("DropLog", () => require("../models/DropLog"));
lazy("settings", () => require("../utils/settings"));
lazy("mp", () => require("../utils/marketplaces"));
lazy("ops", () => require("../utils/funpayResaleOps"));
lazy("watch", () => require("../utils/funpayWatch"));
lazy("engine", () => require("../utils/funpayResale"));
lazy("systemLog", () => require("../utils/systemLog"));
// Cover images must be files under here (served publicly anyway).
deps.publicDir = path.join(__dirname, "..", "public");

// ------------------------------------------------------------------ constants
const DELIVERY_TIMES = ["Minute20", "Hour1", "Hour2", "Hour3", "Hour5", "Hour8", "Hour12", "Day1"];
// §4 owner-editable keys; utils/settings clamps the numbers to their ranges.
const SETTING_NUMBERS = [
  "watchMinutes", "perUnitMaxUsd", "dailyCapUsd", "maxBuysPerHour", "maxUnitsPerOrder",
  "minProfitUsd", "eldoradoFeePct", "sellerWaitMinutes", "giveUpHours",
];
const SETTING_BOOLS = ["watchEnabled", "autoBuy", "dryRun", "pauseListingWhenSourceDown"];
// Order purchases still being worked. The engine needs the deal AND its link to
// finish one: unlinked or deleted mid-way, a bought login never reaches the buyer.
const OPEN_ORDER_STATES = ["new", "waiting_chat", "buying", "bought", "received", "needs_review"];
const PURCHASE_FIELDS = [
  "_id", "source", "offerId", "kind", "eldoradoOrderId", "unit", "listing", "state", "funpayOrderId",
  "chargedUsd", "maxPriceUsd", "login", "reason", "buyingAt", "boughtAt", "receivedAt", "deliveredAt",
  "createdAt", "updatedAt",
];
const LISTING_PROJECTION = { externalId: 1, title: 1, price: 1, status: 1, autoPaused: 1, url: 1, lastError: 1, funpaySource: 1, createdAt: 1 };
// Titles another path claims before the FunPay branch of deliverOrder runs:
// utils/eldoradoFarmService takes "Automatic Farming" orders as rent-farm
// windows, and bulkPacks/packMath.packMismatch refuses a pack title on any row
// that is not a pack. Such a row could never reach the FunPay engine.
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;
const PACK_TITLE = /\bPACK\s+OF\s+\d+\s+ACCOUNTS\b/i;
function titleClaimedElsewhere(title) {
  const t = String(title || "");
  if (FARM_TITLE.test(t)) return "the title reads as a farming-service offer (its orders go to the rent-farm path)";
  if (PACK_TITLE.test(t)) return "the title reads as a bulk pack (its orders are refused as a pack mismatch)";
  return "";
}
// The refusal codes a lower layer may hand up (an Error's `.status`, or an ops
// result's `status`); anything else from below is a 500.
const PASS_STATUS = new Set([400, 404, 409]);
const passStatus = (s, fallback) => (PASS_STATUS.has(Number(s)) ? Number(s) : fallback);
const NOT_COMMISSIONED = "finish a test purchase first (Buy 1 now) — this stays locked until one works end to end";
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUNPAY_ID = /^[1-9]\d{0,14}$/;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const SECRETISH_SETTING = /cookie|secret|password|token|golden/i;
const DEFAULT_COVER = "/listing-default-cover.png";
const MAX_COMPETITORS = 20;
const MAX_COVERS = 40;
const MAX_DESCRIPTION = 2000; // Eldorado's limit (eldoradoPublish cuts there)

// One manual purchase and one Eldorado publish at a time: a double click must
// never become two purchases or two live offers.
const busy = { buying: false, publishing: false };

// ------------------------------------------------------------------ plumbing
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badInput = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);
const refused = (m) => new HttpError(409, m);

// Every handler answers {success:true,…} or {success:false,error} (plus
// `message`, which older pages read).
function route(fn) {
  return async (req, res) => {
    try {
      const out = (await fn(req, res)) || {};
      if (!res.headersSent) res.json(Object.assign({ success: true }, out, { success: true }));
    } catch (err) {
      // utils/funpayResaleOps throws plain Errors carrying `.status` (400/404/409).
      let status = err instanceof HttpError ? err.status : passStatus(err && err.status, 500);
      if (err && err.code === "MODULE_NOT_FOUND") status = 503;
      const error = String((err && err.message) || err || "failed").slice(0, 400);
      if (status >= 500) console.error("funpay-resale " + req.method + " " + req.path + ":", error);
      if (!res.headersSent) res.status(status).json({ success: false, error, message: error });
    }
  };
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const given = (b, k) => hasOwn(b, k) && b[k] !== undefined;
function bodyOf(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}
function actor(req) {
  try {
    return deps.systemLog.actorFromReq(req);
  } catch {
    return "anon";
  }
}

function text(b, k, { max, min = 0, required = false, multiline = false } = {}) {
  if (!given(b, k)) {
    if (required) throw badInput(k + " is required");
    return undefined;
  }
  if (typeof b[k] !== "string") throw badInput(k + " must be text");
  const s = b[k].replace(/\r\n?/g, "\n").trim();
  if (!multiline && s.includes("\n")) throw badInput(k + " must be a single line");
  if (s.length < min || s.length > max) {
    throw badInput(min > 0 ? k + " must be " + min + "–" + max + " characters" : k + " is longer than " + max + " characters");
  }
  return s;
}

// A number (or a plain numeric string from a form), unranged and unrounded.
function numeric(b, k, required = false) {
  if (!given(b, k)) {
    if (required) throw badInput(k + " is required");
    return undefined;
  }
  let v = b[k];
  if (typeof v === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v)) throw badInput(k + " must be a number");
  return v;
}

function number(b, k, { min, max, int = false, required = false } = {}) {
  const v = numeric(b, k, required);
  if (v === undefined) return undefined;
  if (int && !Number.isInteger(v)) throw badInput(k + " must be a whole number");
  if (v < min || v > max) throw badInput(k + " must be between " + min + " and " + max);
  return int ? v : Math.round(v * 100) / 100;
}

function flag(b, k) {
  if (!given(b, k)) return undefined;
  if (typeof b[k] !== "boolean") throw badInput(k + " must be true or false");
  return b[k];
}

// ------------------------------------------------------------------ parsers
// A FunPay offer id from a bare number or a funpay.com …/lots/offer?id=<n> link.
function parseFunpayOfferId(input) {
  if (typeof input === "number") return Number.isSafeInteger(input) && input > 0 ? String(input) : "";
  if (typeof input !== "string") return "";
  const s = input.trim();
  if (FUNPAY_ID.test(s)) return s;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || (host !== "funpay.com" && !host.endsWith(".funpay.com"))) return "";
  if (!/^\/(?:[a-z]{2}\/)?lots\/offer\/?$/i.test(url.pathname)) return "";
  const id = url.searchParams.get("id") || "";
  return FUNPAY_ID.test(id) ? id : "";
}

// One Eldorado offer id (lower-case GUID) from a bare GUID or a link carrying
// offerId=<GUID>; "" for anything else.
function eldoradoOfferIdOf(token) {
  const t = String(token || "").trim();
  if (GUID.test(t)) return t.toLowerCase();
  const m = /(?:^|[?&#])offerId=([^&#\s]+)/i.exec(t);
  if (!m) return "";
  let v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch {
    return "";
  }
  return GUID.test(v) ? v.toLowerCase() : "";
}

// Same-set Eldorado offers from a list or free text, one id or link per token.
// A token that is neither is refused rather than dropped: a pasted link without
// offerId= would otherwise vanish and the deal silently watch nothing.
function parseCompetitorIds(input) {
  if (input === null) return [];
  let tokens;
  if (Array.isArray(input)) {
    tokens = [];
    for (const v of input) {
      if (typeof v !== "string") throw badInput("competitorOfferIds must hold Eldorado offer ids or links");
      tokens.push(...v.split(/[\s,;]+/));
    }
  } else if (typeof input === "string") {
    tokens = input.split(/[\s,;]+/);
  } else {
    throw badInput("competitorOfferIds must be a list or text");
  }
  const ids = [];
  for (const t of tokens.map((x) => x.trim()).filter(Boolean)) {
    const id = eldoradoOfferIdOf(t);
    if (!id) {
      throw badInput('could not read an Eldorado offer id from "' + t.slice(0, 80) + '" — use offer ids or links with offerId=');
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_COMPETITORS) throw badInput("at most " + MAX_COMPETITORS + " same-set Eldorado offers per deal");
  return ids;
}

// ------------------------------------------------------------------ views
function plain(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : { ...(doc || {}) };
}
function sourceView(doc) {
  const out = plain(doc);
  delete out.competitorHistory; // the watcher's raw series: bulky, and the page never reads it
  return out;
}
function purchaseView(doc) {
  const p = plain(doc);
  const out = {};
  for (const k of PURCHASE_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
function listingView(l) {
  return {
    externalId: l.externalId || "",
    title: l.title || "",
    price: Number(l.price) || 0,
    status: l.status || "",
    autoPaused: !!l.autoPaused,
    url: l.url || "",
    lastError: l.lastError || "",
  };
}
function publicSettings(s) {
  const out = { ...(s || {}) };
  delete out.session;
  for (const k of Object.keys(out)) if (SECRETISH_SETTING.test(k)) delete out[k];
  return out;
}

// Never echo a pasted cookie back, even inside an error from further down.
function scrub(message, secretText) {
  let out = String(message || "");
  // "=" splits too, so a value is caught with or without its "name=".
  for (const t of String(secretText || "").split(/[^A-Za-z0-9%._~+/-]+/)) {
    if (t.length >= 12 && out.includes(t)) out = out.split(t).join("[redacted]");
  }
  return out;
}

const titleKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path under public/ that is an existing image file, as an absolute path.
function publicImage(rel) {
  if (typeof rel !== "string" || !rel.trim()) return "";
  const dir = path.resolve(deps.publicDir);
  const p = path.normalize(path.join(dir, rel.trim().split(/[?#]/)[0]));
  if (!p.startsWith(dir + path.sep) || !IMAGE_FILE.test(p)) return "";
  try {
    return fs.statSync(p).isFile() ? p : "";
  } catch {
    return "";
  }
}
function coverPathFor(rel) {
  const p = publicImage(rel) || publicImage(DEFAULT_COVER);
  if (!p) throw new Error("no cover image: public" + DEFAULT_COVER + " is missing");
  return p;
}

// ------------------------------------------------------------------ lookups
async function findSource(id, projection) {
  if (!OBJECT_ID.test(String(id || ""))) throw notFound("deal not found");
  const s = await deps.Source.findById(id, projection).lean();
  if (!s) throw notFound("deal not found");
  return s;
}
async function findPurchase(id) {
  if (!OBJECT_ID.test(String(id || ""))) throw notFound("purchase not found");
  const p = await deps.Purchase.findById(id, { credentials: 0, trace: 0 }).lean();
  if (!p) throw notFound("purchase not found");
  return p;
}
async function freshPurchase(id) {
  return purchaseView(await deps.Purchase.findById(id, { credentials: 0, trace: 0 }).lean());
}
async function freshSource(id) {
  const s = await deps.Source.findById(id, { competitorHistory: 0 }).lean();
  return s ? sourceView(s) : null;
}
async function openOrderPurchases(sourceId) {
  return deps.Purchase.countDocuments({ source: sourceId, kind: "order", state: { $in: OPEN_ORDER_STATES } });
}
async function activeLinkedCount(sourceId) {
  return deps.Listing.countDocuments({ marketplace: "eldorado", funpaySource: sourceId, status: "active" });
}

// The linked listing per deal: an active row wins, then the newest.
async function linkedListings(sourceIds) {
  const out = new Map();
  if (!sourceIds.length) return out;
  const rows = await deps.Listing.find(
    { marketplace: "eldorado", funpaySource: { $in: sourceIds } },
    LISTING_PROJECTION,
  ).lean();
  rows.sort(
    (a, b) =>
      (b.status === "active") - (a.status === "active") ||
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  );
  for (const r of rows) {
    const k = String(r.funpaySource);
    if (!out.has(k)) out.set(k, listingView(r));
  }
  return out;
}

function watcherState() {
  try {
    const st = deps.watch.state;
    return st && typeof st === "object" ? { ...st } : null;
  } catch {
    return null; // the watcher module is optional for this page
  }
}

// An ops refusal ({ok:false, reason, status?}) keeps its 400/404, else is a 409.
function okOrRefused(r, fallback) {
  if (r && r.ok === false) throw new HttpError(passStatus(r.status, 409), String(r.reason || r.error || fallback));
  return r;
}

// Typed deal fields from a create/update body (unknown keys ignored).
function sourceFields(b, { update = false } = {}) {
  const out = {};
  const label = text(b, "label", { max: 80 });
  if (label !== undefined) out.label = label;
  const itemsText = text(b, "itemsText", { max: 4000, multiline: true });
  if (itemsText !== undefined) out.itemsText = itemsText;
  const max = number(b, "maxBuyPriceUsd", { min: 0, max: 50 });
  if (max !== undefined) out.maxBuyPriceUsd = max;
  if (given(b, "competitorOfferIds")) out.competitorOfferIds = parseCompetitorIds(b.competitorOfferIds);
  const qty = number(b, "listingQuantity", { min: 1, max: 100, int: true });
  if (qty !== undefined) out.listingQuantity = qty;
  const game = text(b, "game", { min: 1, max: 80 });
  if (game !== undefined) out.game = game;
  if (update) {
    const autoBuy = flag(b, "autoBuy");
    if (autoBuy !== undefined) out.autoBuy = autoBuy;
  }
  return out;
}

// Why an existing Eldorado row cannot take FunPay stock ("" = it can). Every
// other stock mode is picked by a fulfiller branch of its own, a row that holds
// units or an attached account carries somebody's stock or sales, and some
// titles are claimed by another path before the FunPay branch. The link writes
// funpaySource and nothing else, so a row is linked only when it is plain.
function linkBlocker(row) {
  if (row.set) return "it sells a drop set";
  if ((row.units || []).length) return "it already holds units (stock or past deliveries)";
  if (row.accountOffer) return "it is an account listing";
  if (row.noclaimStock) return "it is a no-claim shop listing";
  if (row.unclaimedGame) return "its stock is the no-claim farm";
  if (row.autoClaimSet) return "it claims its stock from the drop archive";
  if (row.bulkOfferId || Number(row.bulkPackSize) > 0) return "it belongs to a bulk pack";
  if (row.rentFarm) return "it is a rent-farm offer";
  if (row.accountId || row.accountLogin) return "an account is attached to it";
  if (row.autoDeliver) return "it is an auto-delivery listing";
  if ((row.requiredDrops || []).length) return "it declares required drops for another stock source";
  return titleClaimedElsewhere(row.title);
}

// §1: buyer text never names FunPay or the seller (the page checks the same).
function buyerTextProblem(source, t) {
  const low = String(t || "").toLowerCase();
  if (low.includes("funpay")) return "the buyer text must not mention FunPay";
  const seller = String(source.sellerName || "").trim().toLowerCase();
  if (seller.length >= 3 && new RegExp("(^|[^a-z0-9])" + escapeRe(seller) + "([^a-z0-9]|$)").test(low)) {
    return "the buyer text must not name the FunPay seller";
  }
  return "";
}

function defaultDescription(source) {
  const guide = String(deps.engine.BUYER_GUIDE || "");
  const items = String(source.itemsText || "").trim();
  return [items, guide].filter(Boolean).join("\n\n");
}

// ================================================================== routes

router.get(
  BASE + "/state",
  requireSuperadmin,
  route(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { Source, Purchase, engine } = deps;
    const settings = publicSettings(deps.settings.getFunpayResale());
    const sources = await Source.find({}, { competitorHistory: 0 }).sort({ createdAt: 1 }).lean();
    const linked = await linkedListings(sources.map((s) => s._id));
    // The ciphertext never leaves Mongo for a list, and the view drops it again.
    const purchases = await Purchase.find({}, { credentials: 0, trace: 0 }).sort({ createdAt: -1 }).limit(50).lean();
    return {
      settings,
      sources: sources.map((s) => ({ ...sourceView(s), linkedListing: linked.get(String(s._id)) || null })),
      purchases: purchases.map(purchaseView),
      spent24h: await engine.spentLast24h(),
      buys1h: await engine.buysLastHour(),
      watcher: watcherState(),
    };
  }),
);

// ------------------------------------------------------------------ FunPay login

router.post(
  BASE + "/session",
  requireSuperadmin,
  route(async (req) => {
    let cookies = bodyOf(req).cookies;
    // A cookie-export JSON the page parsed before sending is still a paste.
    if (cookies && typeof cookies === "object") cookies = JSON.stringify(cookies);
    if (typeof cookies !== "string" || !cookies.trim()) throw badInput("paste your FunPay cookies first");
    if (cookies.length > 50000) throw badInput("that paste is too long for a FunPay cookie list");
    let r;
    try {
      r = (await deps.ops.saveSession(cookies, { actor: actor(req) })) || {};
    } catch (e) {
      throw new Error(scrub((e && e.message) || e, cookies));
    }
    if (!r.ok) throw badInput(scrub(r.error || "FunPay did not accept this login — nothing was saved", cookies));
    return { ok: true, user: String(r.user || "") };
  }),
);

router.post(
  BASE + "/session/check",
  requireSuperadmin,
  route(async () => {
    const r = (await deps.ops.checkSession()) || {};
    return {
      ok: !!r.ok,
      user: String(r.user || ""),
      userId: Number(r.userId) || 0,
      balanceUsd: Number.isFinite(r.balanceUsd) ? r.balanceUsd : null,
      error: String(r.error || ""),
    };
  }),
);

router.delete(
  BASE + "/session",
  requireSuperadmin,
  route(async (req) => {
    await deps.settings.setFunpaySessionCookies(null, { actor: actor(req) });
    return {};
  }),
);

// ------------------------------------------------------------------ settings

router.put(
  BASE + "/settings",
  requireSuperadmin,
  route(async (req) => {
    const b = bodyOf(req);
    const patch = {};
    for (const k of SETTING_NUMBERS) {
      // Clamped to its range by setFunpayResale; the answer carries the result.
      const v = numeric(b, k);
      if (v !== undefined) patch[k] = v;
    }
    for (const k of SETTING_BOOLS) {
      const v = flag(b, k);
      if (v !== undefined) patch[k] = v;
    }
    if (!Object.keys(patch).length) throw badInput("no setting to change in the request");
    let out;
    try {
      out = await deps.settings.setFunpayResale(patch, { actor: actor(req) });
    } catch (e) {
      if (e && e.code === "FUNPAY_NOT_COMMISSIONED") throw refused(e.message);
      throw e;
    }
    return { settings: publicSettings(out) };
  }),
);

// ------------------------------------------------------------------ deals

router.post(
  BASE + "/sources",
  requireSuperadmin,
  route(async (req) => {
    const b = bodyOf(req);
    const offerId = parseFunpayOfferId(b.offer);
    if (!offerId) throw badInput("offer must be a FunPay offer id or a funpay.com/…/lots/offer?id=… link");
    // autoBuy is not a create field: a new deal always starts off.
    const doc = { offerId, ...sourceFields(b) };
    const already = "this FunPay offer is already on the deals list";
    if (await deps.Source.findOne({ offerId }, { _id: 1 }).lean()) throw refused(already);
    let created;
    try {
      created = await deps.Source.create(doc);
    } catch (e) {
      if (e && e.code === 11000) throw refused(already);
      throw e;
    }
    return { source: sourceView(created) };
  }),
);

router.put(
  BASE + "/sources/:id",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id);
    const patch = sourceFields(bodyOf(req), { update: true });
    if (!Object.keys(patch).length) throw badInput("nothing to change");
    if (patch.autoBuy === true && !deps.settings.getFunpayResale().commissioned) throw refused(NOT_COMMISSIONED);
    if (patch.competitorOfferIds) {
      const before = (src.competitorOfferIds || []).map((x) => String(x).toLowerCase());
      const keep = new Set(patch.competitorOfferIds);
      if (before.length !== keep.size || before.some((x) => !keep.has(x))) {
        // Readings of an offer no longer listed must not keep pricing the deal;
        // the derived prices are unknown until the next refresh.
        const kept = (x) => keep.has(String((x && x.offerId) || "").toLowerCase());
        patch.competitors = (src.competitors || []).filter(kept);
        patch.competitorHistory = (src.competitorHistory || []).filter(kept);
        Object.assign(patch, { lowestCompetitorUsd: null, suggestedPriceUsd: null, estProfitUsd: null });
      }
    }
    await deps.Source.updateOne({ _id: src._id }, { $set: patch });
    return { source: await freshSource(src._id) };
  }),
);

router.delete(
  BASE + "/sources/:id",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id, { _id: 1 });
    if (await activeLinkedCount(src._id)) {
      throw refused("an active Eldorado listing is linked to this deal — unlink it or take it off sale first");
    }
    const open = await openOrderPurchases(src._id);
    if (open) throw refused(open + " Eldorado order purchase(s) of this deal are still open — finish or close them first");
    await deps.Source.deleteOne({ _id: src._id });
    return { deleted: true };
  }),
);

router.post(
  BASE + "/sources/:id/refresh",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id, { _id: 1 });
    const result = await deps.watch.runOnce({ onlySourceId: String(src._id) });
    if (result && result.skipped) throw refused("not refreshed: " + result.skipped + " — try again in a minute");
    // The watcher never throws: a run that broke says so in its result.
    if (result && result.ok === false) {
      const why = String(result.error || "the watcher failed");
      throw new HttpError(why === "source not found" ? 404 : 500, "not refreshed: " + why);
    }
    return { result: result || null, source: await freshSource(src._id) };
  }),
);

router.post(
  BASE + "/sources/:id/test",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id, { _id: 1 });
    const r = (await deps.ops.testSource(String(src._id))) || {};
    if (Number(r.status) === 404) throw notFound(String(r.reason || "deal not found"));
    // Any other ok:false is the test's verdict, shown on the page, not an error.
    return {
      ok: !!r.ok,
      signedIn: !!r.signedIn,
      user: String(r.user || ""),
      priceUsd: Number.isFinite(r.priceUsd) ? r.priceUsd : null,
      balanceUsd: Number.isFinite(r.balanceUsd) ? r.balanceUsd : null,
      maxPriceUsd: Number.isFinite(r.maxPriceUsd) ? r.maxPriceUsd : null,
      buyFormFound: !!r.buyFormFound,
      reason: String(r.reason || ""),
    };
  }),
);

router.post(
  BASE + "/sources/:id/buy",
  requireSuperadmin,
  route(async (req) => {
    // Passed on exactly as sent (never rounded): it must BE the deal's max buy
    // price the owner was shown in the confirm box, not something near it.
    const confirmMaxUsd = numeric(bodyOf(req), "confirmMaxUsd", true);
    if (!(confirmMaxUsd > 0)) throw badInput("confirmMaxUsd must be above 0");
    const src = await findSource(req.params.id, { _id: 1, maxBuyPriceUsd: 1 });
    const dealMax = Number(src.maxBuyPriceUsd) || 0;
    if (!(dealMax > 0)) throw refused("this deal has no max buy price — set one first");
    if (Math.abs(confirmMaxUsd - dealMax) > 1e-9) {
      throw refused("this deal's max buy price is $" + dealMax.toFixed(2) + ", not the $" + confirmMaxUsd.toFixed(2) + " confirmed — reload and confirm again");
    }
    if (busy.buying) throw refused("a FunPay purchase is already running — wait for it to finish");
    busy.buying = true;
    let r;
    try {
      r = await deps.ops.manualBuy(String(src._id), { confirmMaxUsd, actor: actor(req) });
    } finally {
      busy.buying = false;
    }
    if (!r) throw new Error("the purchase returned nothing — check the purchases table before buying again");
    // Refused before any purchase row existed: nothing was spent.
    if (!r.ok && !r.purchaseId) throw new HttpError(passStatus(r.status, 409), String(r.reason || "purchase refused"));
    return {
      ok: !!r.ok,
      purchaseId: r.purchaseId ? String(r.purchaseId) : "",
      state: String(r.state || ""),
      reason: String(r.reason || ""),
      funpayOrderId: String(r.funpayOrderId || ""),
      commissioned: r.commissioned === true,
      trace: Array.isArray(r.trace) ? r.trace : [],
    };
  }),
);

router.post(
  BASE + "/sources/:id/listing",
  requireSuperadmin,
  route(async (req) => {
    if (!deps.settings.getFunpayResale().commissioned) throw refused(NOT_COMMISSIONED);
    const src = await findSource(req.params.id, { competitorHistory: 0 });
    const b = bodyOf(req);
    const title = text(b, "title", { min: 10, max: 160, required: true });
    const description = text(b, "description", { max: MAX_DESCRIPTION, multiline: true }) || defaultDescription(src);
    if (description.length > MAX_DESCRIPTION) {
      throw badInput("the description is over Eldorado's " + MAX_DESCRIPTION + " characters — shorten the items text");
    }
    const priceUsd = number(b, "priceUsd", { min: 0.01, max: 1000, required: true });
    // eldoradoPublish would quietly list a lower price at the minimum, and this
    // row would then record a price the offer does not have.
    const minPrice = Number(deps.mp.ELD_MIN_PRICE) > 0 ? Number(deps.mp.ELD_MIN_PRICE) : 0.5;
    if (priceUsd < minPrice) throw badInput("Eldorado's lowest price is $" + minPrice.toFixed(2));
    let quantity = number(b, "quantity", { min: 1, max: 100, int: true });
    if (quantity === undefined) quantity = Math.min(100, Math.max(1, parseInt(src.listingQuantity, 10) || 5));
    const deliveryTime = given(b, "deliveryTime") ? b.deliveryTime : "Hour1";
    if (!DELIVERY_TIMES.includes(deliveryTime)) throw badInput("deliveryTime must be one of " + DELIVERY_TIMES.join(", "));
    if (given(b, "coverImage") && typeof b.coverImage !== "string") throw badInput("coverImage must be a path");
    const claimed = titleClaimedElsewhere(title);
    if (claimed) throw refused(claimed + " — choose another title");
    const problem = buyerTextProblem(src, title + "\n" + description);
    if (problem) throw badInput(problem);
    if (!(Number(src.maxBuyPriceUsd) > 0)) {
      throw refused("set a max buy price on this deal first — an order could not be bought without one");
    }
    const coverImagePath = coverPathFor(b.coverImage);

    if (busy.publishing) throw refused("another listing is being published — wait for it to finish");
    busy.publishing = true;
    try {
      const { Listing, mp } = deps;
      const live = await Listing.find({ marketplace: "eldorado", status: "active" }, { title: 1, externalId: 1, funpaySource: 1 }).lean();
      if (live.some((l) => String(l.funpaySource || "") === String(src._id))) {
        throw refused("this deal already has an active Eldorado listing — unlink it or take it off sale first");
      }
      const twin = live.find((l) => titleKey(l.title) === titleKey(title));
      if (twin) {
        throw refused("the same title is already on sale on Eldorado (offer " + twin.externalId + ") — Eldorado does not allow duplicate offers");
      }
      const published = await mp.eldoradoPublish({
        game: src.game || "Rocket League",
        title,
        description,
        priceUsd,
        quantity,
        deliveryTime,
        coverImagePath,
      });
      const externalId = String((published && (published.externalId || published.id)) || "");
      if (!externalId) {
        throw new HttpError(502, "Eldorado answered without an offer id — check your Eldorado offers before trying again");
      }
      let row;
      try {
        row = await Listing.create({
          marketplace: "eldorado",
          externalId,
          url: (published && published.url) || "",
          title,
          description,
          price: priceUsd,
          status: "active",
          origin: "manual",
          funpaySource: src._id,
        });
      } catch (e) {
        // Live on Eldorado with no row here: its orders would be skipped as "no
        // listing row for offer". Take it off sale rather than leave it selling.
        let paused = false;
        try {
          await mp.eldoradoDelist(externalId);
          paused = true;
        } catch {
          paused = false;
        }
        throw new Error(
          "Eldorado offer " + externalId + " was created but saving it here failed (" + ((e && e.message) || e) + ")" +
            (paused ? " — it was paused on Eldorado" : " — pause it on Eldorado by hand now"),
        );
      }
      // The watcher holds the offer at the deal's listing quantity: make that the
      // quantity just chosen, or the next run would quietly change it.
      if (quantity !== Number(src.listingQuantity)) {
        try {
          await deps.Source.updateOne({ _id: src._id }, { $set: { listingQuantity: quantity } });
        } catch (e) {
          console.error("funpay-resale listing quantity:", e && e.message);
        }
      }
      return { listing: listingView(row) };
    } finally {
      busy.publishing = false;
    }
  }),
);

router.post(
  BASE + "/sources/:id/link",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id, { _id: 1 });
    const raw = bodyOf(req).externalId;
    if (typeof raw !== "string" || !raw.trim()) throw badInput("externalId (the Eldorado offer id) is required");
    const externalId = eldoradoOfferIdOf(raw);
    if (!externalId) throw badInput("externalId must be an Eldorado offer id or a link with offerId=");
    // Every row for this offer, whatever its status: the fulfiller takes the first
    // findOne({marketplace, externalId}) hit, which need not be the one linked here.
    const rows = await deps.Listing.find({ marketplace: "eldorado", externalId: new RegExp("^" + externalId + "$", "i") }).lean();
    if (!rows.length) throw notFound("no Eldorado listing with that offer id on the Listings page");
    if (rows.length > 1) throw refused("more than one listing row carries this Eldorado offer — tidy them up on the Listings page first");
    const row = rows[0];
    if (row.funpaySource) {
      if (String(row.funpaySource) === String(src._id)) return { listing: listingView(row), already: true };
      throw refused("this listing is already linked to another deal");
    }
    const why = linkBlocker(row);
    if (why) throw refused("this listing cannot be linked: " + why);
    if (await activeLinkedCount(src._id)) throw refused("this deal already has an active Eldorado listing — unlink it first");
    const r = await deps.Listing.updateOne({ _id: row._id, funpaySource: null }, { $set: { funpaySource: src._id } });
    if (!r || !(r.matchedCount || r.n)) throw refused("the listing changed meanwhile — reload and try again");
    return { listing: listingView(row) };
  }),
);

router.post(
  BASE + "/sources/:id/unlink",
  requireSuperadmin,
  route(async (req) => {
    const src = await findSource(req.params.id, { _id: 1 });
    const open = await openOrderPurchases(src._id);
    if (open) {
      throw refused(open + " Eldorado order purchase(s) of this deal are still open — finish or close them first, or the buyer never gets the login");
    }
    const r = await deps.Listing.updateMany({ marketplace: "eldorado", funpaySource: src._id }, { $set: { funpaySource: null } });
    return { unlinked: Number((r && (r.modifiedCount ?? r.nModified)) || 0) };
  }),
);

// ------------------------------------------------------------------ covers

router.get(
  BASE + "/covers",
  requireSuperadmin,
  route(async (req) => {
    const covers = [DEFAULT_COVER];
    const game = typeof req.query.game === "string" ? req.query.game.trim().slice(0, 80) : "";
    if (!game) return { covers };
    // Most-cached first, the way routes/marketplaceRoutes.js gameDropImages reads
    // them: one group per distinct image, so the stage stays small.
    const rows = await deps.DropLog.aggregate([
      { $match: { game: new RegExp("^" + escapeRe(game) + "$", "i"), imageLocal: { $ne: "" } } },
      { $group: { _id: "$imageLocal", n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: 200 },
    ]);
    const dir = path.resolve(deps.publicDir);
    for (const r of rows) {
      if (covers.length > MAX_COVERS) break;
      const abs = typeof r._id === "string" && r._id.startsWith("/") ? publicImage(r._id) : "";
      if (!abs) continue;
      const rel = "/" + path.relative(dir, abs).split(path.sep).join("/");
      if (!covers.includes(rel)) covers.push(rel);
    }
    return { covers };
  }),
);

// ------------------------------------------------------------------ purchases

router.post(
  BASE + "/purchases/:id/reveal",
  requireSuperadmin,
  route(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const p = await findPurchase(req.params.id);
    if (!(await deps.Purchase.countDocuments({ _id: p._id, credentials: { $gt: "" } }))) {
      throw refused("no login is stored for this purchase");
    }
    const c = await deps.ops.revealCredentials(String(p._id));
    if (!c || !c.username) throw refused("the stored login could not be read");
    // Who looked, and at which purchase — never what they saw.
    try {
      await deps.systemLog.logEvent({
        category: "funpay-resale",
        action: "credentials_revealed",
        actor: actor(req),
        subject: "FunPay purchase",
        detail: "showed the login of a bought account",
        meta: { purchaseId: String(p._id) },
      });
    } catch {
      /* an audit write never fails the request */
    }
    const credentials = { username: String(c.username), password: String(c.password || "") };
    if (c.token) credentials.token = String(c.token);
    return { credentials };
  }),
);

router.post(
  BASE + "/purchases/:id/credential",
  requireSuperadmin,
  route(async (req) => {
    const p = await findPurchase(req.params.id);
    const b = bodyOf(req);
    const login = text(b, "login", { min: 1, max: 64, required: true });
    if (/\s/.test(login)) throw badInput("the login cannot contain spaces");
    const password = text(b, "password", { min: 1, max: 128, required: true });
    if (p.kind !== "order") throw refused("a login is entered by hand only for a purchase made for an Eldorado order");
    if (!["bought", "needs_review", "failed"].includes(p.state)) {
      throw refused("this purchase is " + p.state + " — a login can be entered only while it is bought, needs review or failed");
    }
    okOrRefused(await deps.ops.setManualCredential(String(p._id), { login, password }), "the login was not saved");
    return { purchase: await freshPurchase(p._id) };
  }),
);

// "Check again" on a bought purchase: one more read of its FunPay order, in case
// the seller delivered since the last look. Buys nothing; a login that arrived
// stays in the row (Show login reveals it) and is never part of this answer.
router.post(
  BASE + "/purchases/:id/check",
  requireSuperadmin,
  route(async (req) => {
    const p = await findPurchase(req.params.id);
    if (p.state !== "bought") {
      throw refused('only a bought purchase waiting for the seller can be checked again (this one is "' + p.state + '")');
    }
    const ops = deps.ops;
    if (typeof ops.recheckPurchase !== "function") throw new HttpError(503, "this server's FunPay tools cannot re-check a purchase yet");
    const r = (await ops.recheckPurchase(String(p._id))) || {};
    // A refusal carries its status; ok:false without one is the read's verdict.
    if (r.ok === false && PASS_STATUS.has(Number(r.status))) throw new HttpError(Number(r.status), String(r.reason || "not checked"));
    return { ok: !!r.ok, state: String(r.state || ""), reason: String(r.reason || ""), purchase: await freshPurchase(p._id) };
  }),
);

router.post(
  BASE + "/purchases/:id/retry",
  requireSuperadmin,
  route(async (req) => {
    const p = await findPurchase(req.params.id);
    if (p.kind !== "order" || p.state !== "failed") throw refused("only a failed purchase for an Eldorado order can be retried");
    okOrRefused(await deps.ops.retryPurchase(String(p._id)), "not retried");
    return { purchase: await freshPurchase(p._id) };
  }),
);

router.post(
  BASE + "/purchases/:id/close",
  requireSuperadmin,
  route(async (req) => {
    const p = await findPurchase(req.params.id);
    const note = text(bodyOf(req), "note", { max: 200 }) || "";
    if (p.state === "delivered") throw refused("this purchase was delivered — there is nothing to close");
    okOrRefused(await deps.ops.closePurchase(String(p._id), { note }), "not closed");
    return { purchase: await freshPurchase(p._id) };
  }),
);

module.exports = router;
module.exports.deps = deps;
// Exported for tests.
module.exports.parseFunpayOfferId = parseFunpayOfferId;
module.exports.parseCompetitorIds = parseCompetitorIds;
module.exports.eldoradoOfferIdOf = eldoradoOfferIdOf;
