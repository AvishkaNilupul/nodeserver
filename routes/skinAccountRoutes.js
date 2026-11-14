const express = require("express");
const { requireSuperadmin } = require("../middleware/auth");
const service = require("../utils/skinAccounts");
const router = express.Router();
router.use(requireSuperadmin, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "GET") {
    if (!req.is("application/json"))
      return res
        .status(415)
        .json({ success: false, message: "JSON request required" });
    const origin = req.get("origin");
    let expected;
    try {
      expected = process.env.PUBLIC_BASE_URL
        ? new URL(process.env.PUBLIC_BASE_URL).origin
        : `${req.protocol}://${req.get("host")}`;
    } catch {
      return res
        .status(503)
        .json({ success: false, message: "Site origin is not configured" });
    }
    if (
      (origin && origin !== expected) ||
      req.get("sec-fetch-site") === "cross-site"
    )
      return res
        .status(403)
        .json({
          success: false,
          message: "Open Skin Accounts on this site before changing it",
        });
  }
  next();
});
function route(fn) {
  return async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      res
        .status(e.user ? e.status || 400 : 503)
        .json({ success: false, message: service._internals.safeError(e) });
    }
  };
}
function actor(req) {
  return String(
    req.session.admin._id || req.session.admin.username || "superadmin",
  );
}
router.get(
  "/overview",
  route(() => service.overview()),
);
router.get(
  "/candidates",
  route((req) => service.candidates(req.query.q)),
);
router.post(
  "/enroll",
  route(async (req) => ({ row: await service.enroll(req.body, actor(req)) })),
);
router.post(
  "/adopt",
  route(async (req) => ({ row: await service.adopt(req.body, actor(req)) })),
);
router.post(
  "/:id/link",
  route(async (req) => ({
    row: await service.verifyLink(req.params.id, req.body),
  })),
);
router.post(
  "/:id/inventory",
  route(async (req) => ({
    row: await service.confirmInventory(req.params.id, req.body),
  })),
);
router.post(
  "/:id/farm",
  route(async (req) => ({
    row: await service.setFarm(req.params.id, req.body),
  })),
);
router.post(
  "/:id/pricing",
  route(async (req) => ({
    row: await service.setPricing(req.params.id, req.body),
  })),
);
router.post(
  "/:id/refresh",
  route(async (req) => ({ row: await service.refresh(req.params.id) })),
);
router.post(
  "/:id/preview",
  route(async (req) => ({ preview: await service.preview(req.params.id) })),
);
router.post(
  "/:id/publish",
  route(async (req) => ({
    row: await service.publish(req.params.id, req.body, actor(req)),
  })),
);
router.post(
  "/:id/recover",
  route(async (req) => ({
    row: await service.recover(req.params.id, req.body),
  })),
);
router.post(
  "/:id/pause",
  route(async (req) => ({ row: await service.pause(req.params.id) })),
);
router.post(
  "/:id/resume",
  route(async (req) => ({ row: await service.resume(req.params.id) })),
);
module.exports = router;
