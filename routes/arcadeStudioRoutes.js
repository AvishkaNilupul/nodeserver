const express = require("express");
const { createHmac, timingSafeEqual } = require("node:crypto");
const http = require("node:http");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");

const MOUNT = "/admin/arcade-studio";
const STATUS = "/api/status";
const FRAME = "/api/frame";
const START = "/api/start";
const STOP = "/api/stop";
const STATIC = new Map([
  ["/", "text/html"], ["/studio.css", "text/css"], ["/studio.js", "text/javascript"],
  ...["standby", "marble", "word", "echo", "route", "orbit", "forge"]
    .map(name => [`/images/${name}.webp`, "image/webp"]),
]);
const TYPES = new Map([...STATIC, [FRAME, "image/jpeg"], [STATUS, "application/json"],
  [START, "application/json"], [STOP, "application/json"]]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

const parseJson = express.json({ limit: 512, inflate: false });
function bodyParser(req, res, next) {
  parseJson(req, res, error => {
    if (!error) return next();
    return res.status(error.status || 400).set("Cache-Control", "no-store").json({ error: "Invalid Studio JSON request." });
  });
}

function siteToken(secret, id) {
  if (!TOKEN.test(secret || "") || !id) throw new Error("Studio status is unavailable");
  return createHmac("sha256", secret).update("arcade-studio\0").update(id).digest("base64url");
}

function validControl(path, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (path === STOP) return keys.length === 0;
  return keys.every(key => ["mode", "duration", "fps", "volume"].includes(key)) &&
    ["live", "test"].includes(body.mode) && Number.isInteger(body.duration) && body.duration >= 60 && body.duration <= 18000 &&
    (body.fps === undefined || [30, 60].includes(body.fps)) &&
    (body.volume === undefined || (Number.isInteger(body.volume) && body.volume >= 0 && body.volume <= 100));
}

// The private renderer accepts only its own loopback Origin and token. Rebuild
// each request so browser cookies, credentials and forwarding headers stay here.
function studioRequest(port, path, body, secret) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = data ? {
    Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json",
    "Content-Length": data.length, "X-Studio-Token": secret,
  } : {};
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, method: data ? "POST" : "GET", headers }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2_000_000) return request.destroy(new Error("Studio response exceeds limit"));
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode, type: (response.headers["content-type"] || "").split(";")[0],
        body: Buffer.concat(chunks),
      }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Studio unavailable")), 5000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
    request.end(data);
  });
}

function createRouter({ port = 8819, origin } = {}) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
    next();
  });
  router.use(requireSuperadmin, enforce2fa);
  router.use(async (req, res) => {
    const error = (status, message) => res.status(status).json({ error: message });
    const suffix = req.originalUrl.slice(MOUNT.length);
    if (!req.originalUrl.startsWith(MOUNT)) return error(404, "Studio route not found.");
    if (suffix === "" && req.method === "GET") return res.redirect(302, MOUNT + "/");
    const path = /^\/api\/frame\?t=\d{1,16}$/.test(suffix) ? FRAME : suffix;
    if (!TYPES.has(path)) return error(404, "Studio route not found.");
    const mutation = path === START || path === STOP;
    const method = mutation ? "POST" : "GET";
    if (req.method !== method) {
      res.set("Allow", method);
      return error(405, "Unsupported Studio method.");
    }
    const site = req.get("Sec-Fetch-Site");
    const incoming = req.get("Origin");
    if (mutation && (!origin || incoming !== origin || site !== "same-origin")) return error(403, "Use the controls on this Studio page.");
    if (!mutation && ((incoming && incoming !== origin) || (path !== "/" && site && site !== "same-origin"))) {
      return error(403, "Open the Studio page to access this resource.");
    }
    const browserToken = req.get("X-Studio-Token") || "";
    if (mutation) {
      if (!TOKEN.test(browserToken)) return error(403, "Refresh Studio to renew the control token.");
      if (!req.is("application/json")) return error(415, "Use a JSON request.");
      if (!validControl(path, req.body)) return error(400, "Invalid Studio control settings.");
    }
    let commandSent = false;
    try {
      let upstream;
      if (mutation) {
        const status = await studioRequest(port, STATUS);
        if (status.status !== 200 || status.type !== "application/json") throw new Error("Studio status unavailable");
        const current = JSON.parse(status.body);
        const expected = siteToken(current.csrf, req.sessionID);
        if (!timingSafeEqual(Buffer.from(browserToken), Buffer.from(expected))) return error(403, "Refresh Studio to renew the control token.");
        commandSent = true;
        upstream = await studioRequest(port, path, req.body, current.csrf);
      } else {
        upstream = await studioRequest(port, path);
      }
      if (upstream.status !== 200) {
        if (upstream.status >= 400 && upstream.status <= 503 && upstream.type === "application/json") {
          const message = JSON.parse(upstream.body).error;
          if (typeof message === "string" && message.length <= 240) return error(upstream.status, message);
        }
        throw new Error("Studio response unavailable");
      }
      if (upstream.type !== TYPES.get(path)) throw new Error("Unexpected Studio response");
      if (upstream.type === "application/json") {
        const state = JSON.parse(upstream.body);
        state.csrf = siteToken(state.csrf, req.sessionID);
        return res.json(state);
      }
      return res.type(upstream.type).send(upstream.body);
    } catch {
      return error(503, commandSent ? "Studio could not confirm the action. Refresh its status before retrying."
        : "The server Studio is unavailable. Refresh to try again.");
    }
  });
  return router;
}

module.exports = createRouter({ origin: process.env.TWITCH_CONTROLLER_PUBLIC_ORIGIN });
module.exports.createRouter = createRouter;
module.exports.bodyParser = bodyParser;
module.exports.MOUNT = MOUNT;
