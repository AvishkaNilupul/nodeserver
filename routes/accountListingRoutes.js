// ---------------------------------------------------------------------------
// Account listings API (superadmin) — docs/ACCOUNT-LISTINGS-CONTRACT.md B6.
//
// An "account listing" is a product the owner defines by hand and backs with an
// explicit, pasted list of accounts (models/AccountOffer + models/SuppliedAccount).
// Those exact accounts are the stock; one sale hands over one account. It is
// deliberately NOT a DropSet: no items, no DropLog rows, no reservation, and it
// must never reach the Shop tab, the public catalog or the Drop Archive.
//
// This router is the panel's thin CRUD + ingest layer. Every claim, release and
// decrypt goes through utils/suppliedStock — no route here reads a credential
// field itself, and GET .../accounts NEVER returns one (see the aggregation
// below: the ciphertext never leaves Mongo).
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");

const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const settings = require("../utils/settings");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const { buildPromoCoverImage } = require("../utils/setImage");

const router = express.Router();

// The feature's own modules are required lazily inside the handlers, the way
// unclaimedAutoRoutes.js does it for the v3 helpers: a missing or broken
// sibling then answers 503 on these endpoints instead of stopping the whole
// server from booting with live markets on sale.
const MODULES = {
  AccountOffer: "../models/AccountOffer",
  SuppliedAccount: "../models/SuppliedAccount",
  stock: "../utils/suppliedStock",
};

function moduleUnavailable(res, name, err) {
  return res.status(503).json({
    success: false,
    code: "module_unavailable",
    module: name,
    message:
      name + " is not available: " + (err && err.message ? err.message : String(err)),
  });
}

// Returns { AccountOffer, SuppliedAccount, stock } or null after answering 503.
function deps(res) {
  const out = {};
  for (const [key, name] of Object.entries(MODULES)) {
    try {
      out[key] = require(name);
    } catch (err) {
      moduleUnavailable(res, name, err);
      return null;
    }
  }
  return out;
}

// The owner's kill switch covers "the tab + routes" (settings
// ACCOUNT_LISTING_DEFAULTS.enabled); delivery has its own gate in
// utils/suppliedStock. Path-scoped on purpose: this router is mounted at "/",
// so a bare router.use() would run requireSuperadmin against every request in
// the app that falls through to it, including the 404s.
router.use("/account-listings", requireSuperadmin, (req, res, next) => {
  let on = true;
  try {
    on = settings.getAccountListingSettings().enabled !== false;
  } catch {
    on = true; // a settings read must never take the panel down
  }
  if (on) return next();
  return res.status(503).json({
    success: false,
    code: "account_listings_disabled",
    message: "Account listings are switched off in settings",
  });
});

const OFFER_STATUSES = ["draft", "active", "archived"];
const ACCOUNT_STATUSES = ["available", "fed", "sold", "removed"];
// Same promo defaults the custom-listing form uses; the helpers there are
// private to routes/marketplaceRoutes.js (:32-63), so the two constants and the
// tile lookup are mirrored rather than exported out of that file.
const PROMO_BULLETS_DEFAULT = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];
const PROMO_SERVICE_DEFAULT = "180 Days Service";

function isId(v) {
  return /^[a-f0-9]{24}$/i.test(String(v || ""));
}
// createdBy is read by a human on the panel, so it stores the login name;
// actorFromReq ("admin:<objectid>") stays the audit-log identity.
function usernameFromReq(req) {
  return (req.session && req.session.admin && req.session.admin.username) || "admin";
}
function num(v, d = 0) {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : d;
}
function strList(v, cap, maxLen) {
  return (Array.isArray(v) ? v : [])
    .map((s) => String(s == null ? "" : s).trim())
    .filter(Boolean)
    .slice(0, cap)
    .map((s) => s.slice(0, maxLen));
}

// Field-by-field, never a spread: {...doc} on a Mongoose document yields
// undefined for every schema field, and that is what shipped
// "Username: undefined" to a paying buyer.
function offerOut(o) {
  return {
    id: String(o._id),
    title: o.title || "",
    description: o.description || "",
    game: o.game || "",
    note: o.note || "",
    priceUsd: num(o.priceUsd, 0),
    minPriceUsd: num(o.minPriceUsd, 0),
    status: o.status || "draft",
    autoDeliver: o.autoDeliver !== false,
    deliveryTemplate: o.deliveryTemplate || "",
    coverStyle: o.coverStyle || "promo",
    coverServiceText: o.coverServiceText || "",
    coverBullets: strList(o.coverBullets, 8, 120),
    coverImages: strList(o.coverImages, 60, 500),
    createdBy: o.createdBy || "",
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

// PATCH semantics: only keys present in the body are touched, so a partial save
// from one half of the form can never blank the other half. Returns errors.
function applyOfferBody(doc, body, create) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  if (create || b.title !== undefined) {
    const t = String(b.title || "").trim();
    if (!t) errors.push("title is required");
    else doc.title = t.slice(0, 200);
  }
  if (b.description !== undefined)
    doc.description = String(b.description || "").slice(0, 8000);
  if (b.game !== undefined) doc.game = String(b.game || "").trim().slice(0, 120);
  if (b.note !== undefined) doc.note = String(b.note || "").slice(0, 2000);
  for (const key of ["priceUsd", "minPriceUsd"]) {
    if (b[key] === undefined) continue;
    const n = num(b[key], NaN);
    if (!Number.isFinite(n) || n < 0) errors.push(key + " must be a number >= 0");
    else doc[key] = Math.round(n * 100) / 100;
  }
  if (b.status !== undefined) {
    const s = String(b.status || "").trim();
    if (!OFFER_STATUSES.includes(s))
      errors.push("status must be one of " + OFFER_STATUSES.join(", "));
    else doc.status = s;
  }
  if (b.autoDeliver !== undefined) doc.autoDeliver = !!b.autoDeliver;
  if (b.deliveryTemplate !== undefined)
    doc.deliveryTemplate = String(b.deliveryTemplate || "").slice(0, 4000);
  if (b.coverStyle !== undefined)
    doc.coverStyle = String(b.coverStyle) === "grid" ? "grid" : "promo";
  if (b.coverServiceText !== undefined)
    doc.coverServiceText = String(b.coverServiceText || "").slice(0, 200);
  if (b.coverBullets !== undefined) doc.coverBullets = strList(b.coverBullets, 8, 120);
  if (b.coverImages !== undefined) doc.coverImages = strList(b.coverImages, 60, 500);
  return errors;
}

// Per-offer stock counts, in bounded batches. offerStats is the one definition
// of available/fed/sold (utils/suppliedStock) — recomputing it here with a
// second query would let the list and the detail view disagree about what is
// claimable, so it is called, not reimplemented.
//
// Its object is handed to the browser VERBATIM, keys and all (S7): claimable /
// heldBack reach public/listings.html's alClaimable the moment offerStats
// starts returning them, and nothing here has to be edited in step. Do not
// re-shape it into a whitelist of fields — that is how the panel ends up
// falling back to `available − conflicts` and under-counting a full shelf.
async function statsForOffers(stock, ids) {
  const out = new Map();
  const CHUNK = 8;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = await Promise.all(
      slice.map((id) =>
        Promise.resolve()
          .then(() => stock.offerStats(id))
          .catch(() => null),
      ),
    );
    slice.forEach((id, k) => out.set(id, rows[k] || null));
  }
  return out;
}

// Where each offer is published, for the rows list. One query for the page.
//
// autoPaused/lastError are part of that answer (S8): every marketplace stock
// sync pauses an offer-backed row — Eldorado pause, PA hide, G2G delist, Z2U
// off_line — while leaving status:"active", so a row the offer is HIDDEN on is
// indistinguishable from a live one unless these two travel with it. This is
// the only page that lists account listings, and the owner finds problems by
// looking at pages. `autoPaused` is the flag to trust: g2gFulfiller.js:927
// pauses without writing a lastError, so an empty reason does NOT mean live.
async function listingsForOffers(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await MarketplaceListing.find(
    { accountOffer: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
    {
      accountOffer: 1,
      marketplace: 1,
      status: 1,
      externalId: 1,
      url: 1,
      price: 1,
      qtyRemaining: 1,
      autoPaused: 1,
      lastError: 1,
      updatedAt: 1,
    },
  )
    .sort({ updatedAt: -1 })
    .limit(600)
    .lean();
  for (const r of rows) {
    const key = String(r.accountOffer || "");
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      id: String(r._id),
      marketplace: r.marketplace || "",
      status: r.status || "",
      externalId: r.externalId || "",
      url: r.url || "",
      price: num(r.price, 0),
      qtyRemaining: num(r.qtyRemaining, 0),
      autoPaused: !!r.autoPaused,
      // Capped the same 400 chars the write side uses
      // (routes/marketplaceRoutes.js:1716), so one marketplace's essay of a
      // stack trace cannot bloat a 600-row list response.
      lastError: String(r.lastError || "").slice(0, 400),
      updatedAt: r.updatedAt || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

// ?status=draft|active|archived|all — archived offers are hidden by default so
// a deleted (= archived, see DELETE below) offer disappears from the tab.
router.get("/account-listings", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const status = String(req.query.status || "").trim().toLowerCase();
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const filter = {};
    if (OFFER_STATUSES.includes(status)) filter.status = status;
    else if (status !== "all") filter.status = { $ne: "archived" };
    const offers = await d.AccountOffer.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
    const ids = offers.map((o) => String(o._id));
    const [stats, listings] = await Promise.all([
      statsForOffers(d.stock, ids),
      listingsForOffers(ids),
    ]);
    res.json({
      success: true,
      offers: offers.map((o) => {
        const id = String(o._id);
        return {
          ...offerOut(o),
          stats: stats.get(id),
          listings: listings.get(id) || [],
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/account-listings", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const doc = new d.AccountOffer({});
    const errors = applyOfferBody(doc, req.body, true);
    if (errors.length)
      return res.status(400).json({ success: false, message: errors.join("; "), errors });
    doc.createdBy = usernameFromReq(req);
    await doc.save();
    logEvent({
      category: "listings",
      action: "account_offer_created",
      actor: actorFromReq(req),
      subject: doc.title || String(doc._id),
      subjectId: doc._id,
      game: doc.game || "",
      detail: "account listing created (" + (doc.status || "draft") + ")",
    });
    res.json({ success: true, offer: offerOut(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/account-listings/:id", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const id = String(req.params.id || "");
    if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const offer = await d.AccountOffer.findById(id).lean();
    if (!offer)
      return res.status(404).json({ success: false, message: "no such offer" });
    const [stats, listings] = await Promise.all([
      Promise.resolve()
        .then(() => d.stock.offerStats(id))
        .catch(() => null),
      listingsForOffers([id]),
    ]);
    res.json({
      success: true,
      offer: offerOut(offer),
      stats,
      listings: listings.get(id) || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/account-listings/:id", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const id = String(req.params.id || "");
    if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const doc = await d.AccountOffer.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: "no such offer" });
    const errors = applyOfferBody(doc, req.body, false);
    if (errors.length)
      return res.status(400).json({ success: false, message: errors.join("; "), errors });
    const changed = doc.modifiedPaths();
    await doc.save();
    logEvent({
      category: "listings",
      action: "account_offer_updated",
      actor: actorFromReq(req),
      subject: doc.title || id,
      subjectId: doc._id,
      game: doc.game || "",
      detail: "account listing edited: " + (changed.join(", ") || "no change"),
    });
    res.json({ success: true, offer: offerOut(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// "Delete" is an ARCHIVE, never a destructive drop: the offer's sold/fed ledger
// rows are the sales history for accounts a buyer already has, and removing the
// offer would orphan them. Refused outright while any listing is still active —
// that row is on sale right now and its stock lives here.
router.delete("/account-listings/:id", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const id = String(req.params.id || "");
    if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const doc = await d.AccountOffer.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: "no such offer" });
    const active = await MarketplaceListing.find(
      { accountOffer: doc._id, status: "active" },
      { marketplace: 1, externalId: 1, url: 1 },
    )
      .limit(20)
      .lean();
    if (active.length)
      return res.status(409).json({
        success: false,
        code: "listing_active",
        message:
          "Delist it on " +
          [...new Set(active.map((r) => r.marketplace || "?"))].join(", ") +
          " first — " + active.length + " listing(s) still on sale",
        listings: active.map((r) => ({
          id: String(r._id),
          marketplace: r.marketplace || "",
          externalId: r.externalId || "",
          url: r.url || "",
        })),
      });
    doc.status = "archived";
    await doc.save();
    logEvent({
      category: "listings",
      action: "account_offer_archived",
      actor: actorFromReq(req),
      subject: doc.title || id,
      subjectId: doc._id,
      game: doc.game || "",
      detail: "account listing archived (delete)",
    });
    res.json({ success: true, archived: true, offer: offerOut(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stock ledger
// ---------------------------------------------------------------------------

// NEVER returns a password, token or email — not even masked. The booleans are
// computed inside Mongo by the $project below, so the ciphertext is not even
// read into this process, and no future edit here can turn a field into a leak.
router.get("/account-listings/:id/accounts", requireSuperadmin, async (req, res) => {
  const d = deps(res);
  if (!d) return;
  try {
    const id = String(req.params.id || "");
    if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
    const status = String(req.query.status || "").trim().toLowerCase();
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const match = { offer: new mongoose.Types.ObjectId(id) };
    if (ACCOUNT_STATUSES.includes(status)) match.status = status;
    else if (status === "conflict" || status === "conflicts")
      match.conflict = { $ne: "" };
    const nonEmpty = (f) => ({ $ne: [{ $ifNull: ["$" + f, ""] }, ""] });
    const rows = await d.SuppliedAccount.aggregate([
      { $match: match },
      { $sort: { createdAt: 1, _id: 1 } },
      { $limit: limit },
      {
        $project: {
          login: 1,
          status: 1,
          market: 1,
          conflict: 1,
          orderId: 1,
          listing: 1,
          note: 1,
          fedAt: 1,
          soldAt: 1,
          deliveredAt: 1,
          hasPassword: nonEmpty("password"),
          hasToken: nonEmpty("clientSecret"),
          hasEmail: nonEmpty("email"),
        },
      },
    ]);
    res.json({
      success: true,
      accounts: rows.map((a) => ({
        id: String(a._id),
        login: a.login || "",
        status: a.status || "",
        market: a.market || "",
        conflict: a.conflict || "",
        orderId: a.orderId || "",
        listing: a.listing ? String(a.listing) : "",
        note: a.note || "",
        fedAt: a.fedAt || null,
        soldAt: a.soldAt || null,
        deliveredAt: a.deliveredAt || null,
        hasPassword: !!a.hasPassword,
        hasToken: !!a.hasToken,
        hasEmail: !!a.hasEmail,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ingest. Accepts the contract's JSON body { accounts: "<pasted text>" } and,
// for a big paste, a raw text/plain body: express.json is capped at 100kb
// app-wide (server.js:183), and the audit middleware stores the first 40 chars
// of every string body value (middleware/auditRequest.js:31-33) — which for a
// JSON paste is the first login:password pair. Nothing here logs the text.
router.post(
  "/account-listings/:id/accounts",
  requireSuperadmin,
  express.text({ type: ["text/plain"], limit: "5mb" }),
  async (req, res) => {
    const d = deps(res);
    if (!d) return;
    try {
      const id = String(req.params.id || "");
      if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
      const body = req.body;
      const text =
        typeof body === "string"
          ? body
          : String((body && (body.accounts != null ? body.accounts : body.text)) || "");
      if (!text.trim())
        return res
          .status(400)
          .json({ success: false, message: "accounts text required" });
      const offer = await d.AccountOffer.findById(id).lean();
      if (!offer)
        return res.status(404).json({ success: false, message: "no such offer" });
      const r = (await d.stock.addAccounts(id, text, { actor: actorFromReq(req) })) || {};
      const out = {
        added: num(r.added, 0),
        duplicates: Array.isArray(r.duplicates) ? r.duplicates : [],
        conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
        badLines: Array.isArray(r.badLines) ? r.badLines : [],
      };
      logEvent({
        category: "listings",
        action: "account_offer_stock_added",
        actor: actorFromReq(req),
        subject: offer.title || id,
        subjectId: offer._id,
        game: offer.game || "",
        count: out.added,
        // Counts only — the pasted text is credentials.
        detail:
          "supplied stock added: " + out.added + " new, " +
          out.duplicates.length + " duplicate, " +
          out.conflicts.length + " already in the archive, " +
          out.badLines.length + " unparsable",
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// Remove one row from the stock — only while it is still "available": a fed or
// sold row is a buyer's account and stays in the ledger as history.
router.delete(
  "/account-listings/:id/accounts/:accId",
  requireSuperadmin,
  async (req, res) => {
    const d = deps(res);
    if (!d) return;
    try {
      const id = String(req.params.id || "");
      const accId = String(req.params.accId || "");
      if (!isId(id) || !isId(accId))
        return res.status(400).json({ success: false, message: "bad id" });
      // The status guard is IN the query, not a read-then-write: a concurrent
      // claim must not be able to slip between the two.
      const row = await d.SuppliedAccount.findOneAndUpdate(
        { _id: accId, offer: id, status: "available" },
        { $set: { status: "removed" } },
        { returnDocument: "after" },
      )
        .select("login status")
        .lean();
      if (!row) {
        const exists = await d.SuppliedAccount.findOne(
          { _id: accId, offer: id },
          { login: 1, status: 1 },
        ).lean();
        if (!exists)
          return res.status(404).json({ success: false, message: "no such account" });
        return res.status(409).json({
          success: false,
          code: "not_available",
          message: "account is " + (exists.status || "?") + ", not available",
        });
      }
      logEvent({
        category: "listings",
        action: "account_offer_stock_removed",
        actor: actorFromReq(req),
        subject: row.login || accId,
        detail: "supplied account removed from offer " + id,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// "Allow anyway": clear the conflict flag so the row becomes claimable. The
// flag exists because the login is ALSO in the Drop Archive, where the archive
// path could sell the same account — so this is the owner explicitly taking
// the double-sell risk, and it is audited as such.
router.post(
  "/account-listings/:id/accounts/:accId/allow",
  requireSuperadmin,
  async (req, res) => {
    const d = deps(res);
    if (!d) return;
    try {
      const id = String(req.params.id || "");
      const accId = String(req.params.accId || "");
      if (!isId(id) || !isId(accId))
        return res.status(400).json({ success: false, message: "bad id" });
      const row = await d.SuppliedAccount.findOneAndUpdate(
        { _id: accId, offer: id, conflict: { $ne: "" } },
        { $set: { conflict: "" } },
        { returnDocument: "after" },
      )
        .select("login status conflict")
        .lean();
      if (!row) {
        const exists = await d.SuppliedAccount.findOne(
          { _id: accId, offer: id },
          { login: 1 },
        ).lean();
        if (!exists)
          return res.status(404).json({ success: false, message: "no such account" });
        return res.json({ success: true, alreadyClear: true });
      }
      logEvent({
        category: "listings",
        action: "account_offer_conflict_allowed",
        actor: actorFromReq(req),
        severity: "warn",
        subject: row.login || accId,
        detail:
          "operator cleared an in-archive conflict — this login can now be " +
          "sold by both the archive path and offer " + id,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Cover preview — the same promo generator the custom-listing form uses
// (routes/marketplaceRoutes.js "/marketplaces/custom/preview"). Nothing is
// persisted; the temp PNG is removed after encoding.
// ---------------------------------------------------------------------------

// Most-cached-first drop images for a game, so an offer with no custom images
// still gets a full tile grid. Read-only; mirrors gameDropImages in
// routes/marketplaceRoutes.js:39-53.
async function gameDropImages(game, limit) {
  const g = String(game || "").trim();
  if (!g) return [];
  const re = new RegExp("^" + g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
  const rows = await DropLog.aggregate([
    { $match: { game: re, imageLocal: { $ne: "" } } },
    { $group: { _id: "$imageLocal", accounts: { $sum: 1 } } },
    { $sort: { accounts: -1 } },
    { $limit: Math.max(1, Math.min(60, limit || 30)) },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
}

router.post(
  "/account-listings/:id/cover-preview",
  requireSuperadmin,
  async (req, res) => {
    const d = deps(res);
    if (!d) return;
    try {
      const id = String(req.params.id || "");
      if (!isId(id)) return res.status(400).json({ success: false, message: "bad id" });
      const offer = await d.AccountOffer.findById(id).lean();
      if (!offer)
        return res.status(404).json({ success: false, message: "no such offer" });
      const b = req.body && typeof req.body === "object" ? req.body : {};
      // The body (the unsaved form) wins over what is stored, so the owner sees
      // what they are typing, not what they last saved.
      const title = String(b.coverTitle || b.title || offer.title || "").trim();
      if (!title)
        return res.status(400).json({ success: false, message: "Title required" });
      const serviceText = String(
        b.coverServiceText != null
          ? b.coverServiceText
          : offer.coverServiceText || PROMO_SERVICE_DEFAULT,
      ).trim();
      const bulletSrc =
        b.coverBullets !== undefined ? b.coverBullets : offer.coverBullets;
      const bullets = strList(bulletSrc, 4, 120);
      const imageSrc =
        b.coverImages !== undefined ? b.coverImages : offer.coverImages;
      const custom = strList(imageSrc, 60, 500);
      const game = String(b.coverGame || b.game || offer.game || "").trim();
      const file = await buildPromoCoverImage({
        title,
        serviceText,
        bullets: bullets.length ? bullets : PROMO_BULLETS_DEFAULT,
        itemImages: custom.length ? custom : await gameDropImages(game, 30),
        twitchTiles: b.twitchTiles !== false,
      });
      const buf = await fsp.readFile(file);
      await fsp.unlink(file).catch(() => {});
      res.json({
        success: true,
        dataUrl: "data:image/png;base64," + buf.toString("base64"),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
