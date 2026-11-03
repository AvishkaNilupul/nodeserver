const express = require("express");
const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");

function createRouter(target = "http://127.0.0.1:3999") {
  const router = express.Router();
  router.use(requireSuperadmin, enforce2fa);
  router.get("/", (req, res, next) => {
    if (req.originalUrl.split("?")[0] === "/outlook") return res.redirect(302, "/outlook/");
    next();
  });
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.get("origin");
      if (origin && origin !== req.protocol + "://" + req.get("host")) return res.sendStatus(403);
    }
    res.set("Cache-Control", "no-store");
    next();
  }, createProxyMiddleware({target, changeOrigin: true, ws: false,
    on: {proxyReq: fixRequestBody, error: (_err, _req, res) => {
      res.writeHead(503, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ok: false, error: "Outlook service unavailable"}));
    }}
  }));
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
