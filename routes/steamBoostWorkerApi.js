// The hour-boost worker's API (workers/steam-boost on contabo2). Its own HTTP
// listener on 127.0.0.1 only — nginx never routes to it; the worker reaches it
// through steam-boost-tunnel.service (ssh -R from prod to contabo2). Every call
// needs `Authorization: Bearer $STEAM_BOOST_WORKER_TOKEN`. Not started at all
// while that token is unset. Contract: docs/STEAM-BOOST.md.
const crypto = require("crypto");
const http = require("http");
const express = require("express");

const boost = require("../utils/steamBoost");

const PREFIX = "/boost-worker/v1";

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header || ""));
  if (!m || !token) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function createApp({ token, service = boost } = {}) {
  if (!token || token.length < 32) throw new Error("STEAM_BOOST_WORKER_TOKEN must be at least 32 characters");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!tokenOk(req.headers.authorization, token)) return res.status(401).json({ ok: false, message: "unauthorized" });
    next();
  });

  const handle = (fn) => async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req.body && typeof req.body === "object" ? req.body : {}, req)) });
    } catch (e) {
      const status = e && e.user ? e.status || 400 : 500;
      if (status === 500) console.error("[steamBoostWorkerApi]", req.method, req.path, (e && e.message) || e);
      res.status(status).json({ ok: false, message: (e && e.message) || "failed" });
    }
  };

  app.get(PREFIX + "/assignments", handle(() => service.assignments()));
  app.post(PREFIX + "/login", handle((b) => service.login(b.id, b.gen)));
  app.post(PREFIX + "/token", handle((b) => service.saveToken(b.id, b.refreshToken, b.gen)));
  app.post(PREFIX + "/token/clear", handle((b) => service.clearToken(b.id, b.gen)));
  app.post(PREFIX + "/guard-code", handle((b) => service.guardCode(b.id, b.since, b.exclude, b.gen)));
  app.post(PREFIX + "/report", handle((b) => service.report(b)));
  app.use((req, res) => res.status(404).json({ ok: false, message: "not found" }));
  return app;
}

let server = null;
function start({ token = process.env.STEAM_BOOST_WORKER_TOKEN, port = Number(process.env.STEAM_BOOST_WORKER_PORT) || 3011 } = {}) {
  if (server) return server;
  if (!token) {
    console.log("[steamBoostWorkerApi] off (no STEAM_BOOST_WORKER_TOKEN)");
    return null;
  }
  const app = createApp({ token });
  server = http.createServer(app);
  server.on("error", (e) => console.error("[steamBoostWorkerApi] listener error:", (e && e.message) || e));
  server.listen(port, "127.0.0.1", () => console.log("[steamBoostWorkerApi] listening on 127.0.0.1:" + port));
  return server;
}

module.exports = { createApp, start, tokenOk, PREFIX };
