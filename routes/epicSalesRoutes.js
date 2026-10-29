// Admin API for the Epic accounts page's "Listings & sales" tab
// (public/epic-sales.js). Superadmin only, like the rest of the Epic page.
// All the logic lives in utils/epicSales.js; this file only parses input and
// maps errors to status codes.

const express = require("express");
const { requireSuperadmin } = require("../middleware/auth");
const sales = require("../utils/epicSales");

const router = express.Router();

router.use("/api/epic/sales", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function actorOf(req) {
  const a = (req.session && req.session.admin) || {};
  return String(a.username || a.name || a.id || "admin");
}

function handle(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json({ success: true, ...(out || {}) });
    } catch (e) {
      const status = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500 && !(e && e.user)) console.error("[epic-sales]", req.method, req.path, e);
      if (!res.headersSent) {
        res.status(status).json({ success: false, message: (e && e.message) || "Server error" });
      }
    }
  };
}

function ids(v) {
  return (Array.isArray(v) ? v : [v]).map((x) => String(x || "")).filter((x) => /^[a-f\d]{24}$/i.test(x));
}

function listingOpts(b) {
  return {
    accountIds: ids(b.accountIds),
    title: b.title != null ? String(b.title) : "",
    priceUsd: b.priceUsd,
    description: b.description != null ? String(b.description) : "",
    hasOriginalEmail: b.hasOriginalEmail === true,
    coverUrl: b.coverUrl != null ? String(b.coverUrl) : "",
    allowMixed: b.allowMixed === true,
  };
}

router.get(
  "/api/epic/sales/overview",
  requireSuperadmin,
  handle(async (req) => sales.overview({ withOthers: req.query.others !== "0" })),
);

router.get(
  "/api/epic/sales/market",
  requireSuperadmin,
  handle(async (req) => ({ market: await sales.marketCheck(req.query.q || "") })),
);

router.post(
  "/api/epic/sales/preview",
  requireSuperadmin,
  handle(async (req) => ({ preview: await sales.previewListing(listingOpts(req.body || {})) })),
);

router.post(
  "/api/epic/sales/listings",
  requireSuperadmin,
  handle(async (req) => {
    const b = req.body || {};
    if (b.confirm !== true) {
      const e = new Error("Publishing needs confirm: true");
      e.status = 400;
      throw e;
    }
    return { listing: await sales.createListing(listingOpts(b), actorOf(req)) };
  }),
);

router.post(
  "/api/epic/sales/listings/:id/accounts",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.addAccounts(req.params.id, ids((req.body || {}).accountIds), actorOf(req)) })),
);

router.delete(
  "/api/epic/sales/listings/:id/accounts/:accountId",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.removeAccount(req.params.id, req.params.accountId, actorOf(req)) })),
);

router.post(
  "/api/epic/sales/listings/:id/price",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.setPrice(req.params.id, (req.body || {}).priceUsd) })),
);

router.post(
  "/api/epic/sales/listings/:id/text",
  requireSuperadmin,
  handle(async (req) => {
    const b = req.body || {};
    return {
      listing: await sales.updateText(req.params.id, {
        title: b.title != null ? String(b.title) : null,
        description: b.description != null ? String(b.description) : null,
      }),
    };
  }),
);

router.post(
  "/api/epic/sales/listings/:id/pause",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.pauseListing(req.params.id) })),
);

router.post(
  "/api/epic/sales/listings/:id/resume",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.resumeListing(req.params.id) })),
);

router.post(
  "/api/epic/sales/listings/:id/delete",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.deleteListing(req.params.id, actorOf(req)) })),
);

router.post(
  "/api/epic/sales/listings/:id/link",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.linkOffer(req.params.id, (req.body || {}).offerId) })),
);

router.post(
  "/api/epic/sales/sync",
  requireSuperadmin,
  handle(async () => ({ result: await sales.tick({ force: true }) })),
);

router.post(
  "/api/epic/sales/config",
  requireSuperadmin,
  handle(async (req) => ({ config: await sales.setConfig(req.body || {}, actorOf(req)) })),
);

router.post(
  "/api/epic/sales/sales/:orderId/resend",
  requireSuperadmin,
  handle(async (req) => ({ access: await sales.resendAccess(req.params.orderId, actorOf(req), (req.body || {}).days) })),
);

// ---- G2G: offers made by hand on g2g.com, delivered by utils/epicG2g -------

function g2g() {
  return require("../utils/epicG2g");
}

router.post(
  "/api/epic/sales/g2g/link",
  requireSuperadmin,
  handle(async (req) => {
    const b = req.body || {};
    return {
      offer: await g2g().linkOffer(
        {
          offerId: String(b.offerId || ""),
          gameKey: b.gameKey != null ? String(b.gameKey) : "",
          games: Array.isArray(b.games) ? b.games.map(String) : [],
          sessionDays: b.sessionDays,
          enabled: b.enabled !== false,
        },
        actorOf(req),
      ),
    };
  }),
);

router.post(
  "/api/epic/sales/g2g/:offerId/settings",
  requireSuperadmin,
  handle(async (req) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (typeof b.syncStock === "boolean") patch.syncStock = b.syncStock;
    if (b.sessionDays != null) patch.sessionDays = b.sessionDays;
    return { offer: await g2g().setLink(req.params.offerId, patch) };
  }),
);

router.post(
  "/api/epic/sales/g2g/:offerId/unlink",
  requireSuperadmin,
  handle(async (req) => g2g().unlinkOffer(req.params.offerId)),
);

router.post(
  "/api/epic/sales/g2g/sales/:orderId/details",
  requireSuperadmin,
  handle(async (req) => ({ details: await g2g().deliveryDetails(req.params.orderId) })),
);

module.exports = router;
