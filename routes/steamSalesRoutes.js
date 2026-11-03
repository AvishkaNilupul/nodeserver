// Steam account sales on Eldorado — the "Selling on Eldorado" card of
// /steam-accounts.html. Every route is superadmin; server.js mounts the router
// behind enforce2fa. Contract: docs/STEAM-SALES.md.
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const sales = require("../utils/steamSales");
const g2g = require("../utils/steamG2g");
const distributor = require("../utils/steamDistributor");
const boost = require("../utils/steamBoost");

const router = express.Router();

function actor(req) {
  const a = req.session && req.session.admin;
  return (a && (a.username || a.id)) || "admin";
}

// Run a handler; user errors come back with their own status and message,
// anything else as a 500 with the message (the panel shows it).
function handle(fn) {
  return async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      const status = e && e.user ? e.status || 400 : (e && e.status >= 400 && e.status < 600 && e.status) || 500;
      if (!(e && e.user)) console.error("[steam-sales]", req.method, req.path, (e && e.message) || e);
      res.status(status).json({ success: false, message: (e && e.message) || "Steam sales request failed" });
    }
  };
}

const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

router.get(
  "/api/steam/sales/overview",
  requireSuperadmin,
  handle(async () => {
    const [base, g2gOffers, dist, boostView] = await Promise.all([sales.overview(), g2g.panelView(), distributor.view(), boost.panelView()]);
    return { ...base, g2gOffers, distributor: dist, boost: boostView };
  }),
);

// The distributor (docs/STEAM-SALES.md v2): on | plan | off, and run it now.
router.patch(
  "/api/steam/sales/distributor",
  requireSuperadmin,
  handle(async (req) => ({ distributor: await distributor.setMode(String(body(req).mode || ""), actor(req)) })),
);

router.post("/api/steam/sales/distribute", requireSuperadmin, handle(async () => ({ result: await distributor.run() })));

// Read G2G now: sales on the Steam offers + stock confirmations.
router.post("/api/steam/sales/g2g/sweep", requireSuperadmin, handle(async () => ({ result: await g2g.sweep() })));

router.post(
  "/api/steam/sales/preview",
  requireSuperadmin,
  handle(async (req) => ({ preview: await sales.previewListing({ region: body(req).region, priceUsd: body(req).priceUsd, kind: body(req).kind, appId: body(req).appId, minHours: body(req).minHours }) })),
);

router.post(
  "/api/steam/sales/listings",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.createListing({ region: body(req).region, priceUsd: body(req).priceUsd, kind: body(req).kind, appId: body(req).appId, minHours: body(req).minHours }, actor(req)) })),
);

router.post(
  "/api/steam/sales/listings/:id/add",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.addAccounts(req.params.id, null, actor(req)) })),
);

router.post(
  "/api/steam/sales/listings/:id/remove",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.removeAccount(req.params.id, String(body(req).accountId || ""), actor(req)) })),
);

router.post(
  "/api/steam/sales/listings/:id/price",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.setPrice(req.params.id, body(req).priceUsd) })),
);

router.post("/api/steam/sales/listings/:id/pause", requireSuperadmin, handle(async (req) => ({ listing: await sales.pauseListing(req.params.id) })));

router.post("/api/steam/sales/listings/:id/resume", requireSuperadmin, handle(async (req) => ({ listing: await sales.resumeListing(req.params.id) })));

router.delete(
  "/api/steam/sales/listings/:id",
  requireSuperadmin,
  handle(async (req) => ({ listing: await sales.deleteListing(req.params.id, actor(req)) })),
);

router.post("/api/steam/sales/sync", requireSuperadmin, handle(async () => ({ result: await sales.tick({ force: true }) })));

router.patch(
  "/api/steam/sales/config",
  requireSuperadmin,
  handle(async (req) => ({ config: await sales.setConfig(body(req), actor(req)) })),
);

// Hour boost (docs/STEAM-BOOST.md): the "Hour boost" tab.
router.get("/api/steam/boost", requireSuperadmin, handle(async () => ({ boost: await boost.panelView() })));

router.patch(
  "/api/steam/boost/settings",
  requireSuperadmin,
  handle(async (req) => ({ settings: await boost.setSettings(body(req), actor(req)) })),
);

router.post(
  "/api/steam/boost/add",
  requireSuperadmin,
  handle(async (req) => ({ result: await boost.add(Array.isArray(body(req).accountIds) ? body(req).accountIds : [], actor(req)) })),
);

router.post(
  "/api/steam/boost/:id/stop",
  requireSuperadmin,
  handle(async (req) => ({ result: await boost.stop(req.params.id, "stopped by " + actor(req) + " on the Hour boost tab", actor(req)) })),
);

router.post("/api/steam/boost/:id/retry", requireSuperadmin, handle(async (req) => ({ result: await boost.retry(req.params.id, actor(req)) })));

module.exports = router;
