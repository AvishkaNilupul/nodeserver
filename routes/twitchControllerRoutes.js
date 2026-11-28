const express = require("express");
const http = require("node:http");
const { createHmac, timingSafeEqual } = require("node:crypto");
const auth = require("../middleware/auth");
const { renderControllerPage } = require("../utils/twitchControllerShell");

const MOUNT = "/admin/stream-companion";
const MAX_BODY = 65536;
const MAX_RESPONSE = 262144;
// This one read aggregates four bounded helper snapshots plus director history and review receipts.
const MAX_ACCOUNTS_RESPONSE = 2 * 1024 * 1024;
const LOCAL_ORIGIN = "http://127.0.0.1:8795";
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const STATIC = new Map([
  ["/", "text/html"], ["/accounts", "text/html"],
  ["/accounts/primary", "text/html"], ["/accounts/test", "text/html"], ["/accounts/third", "text/html"], ["/accounts/fourth", "text/html"],
  ["/app.js", "text/javascript"], ["/accounts.js", "text/javascript"],
  ["/controller-path.js", "text/javascript"],
  ["/messages", "text/html"], ["/messages.js", "text/javascript"], ["/messages.css", "text/css"],
  ["/clips.js", "text/javascript"], ["/clips.css", "text/css"],
  ["/style.css", "text/css"], ["/accounts.css", "text/css"],
]);
const DATA = new Set(["/api/status", "/api/accounts", "/api/channels", "/api/clips", "/api/director"]);
const DIRECTOR_HISTORY = /^\/api\/director\/history\/(all|primary|test|third|fourth)\/([0-9]{1,16})$/;
const DIRECTOR_MUTATIONS = new Set(["/api/director/bank", "/api/director/cancel"]);
const CHANNEL_LOOKUP = /^\/api\/channels\/[a-z0-9_]{3,25}$/;
const COMMAND = /^\/api\/accounts\/(primary|test|third|fourth)\/command$/;
const BROWSER = /^\/api\/accounts\/(primary|test|third|fourth)\/browser$/;
const CLIP = /^\/api\/clips\/(create|settings|authorization)$/;
const object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
const equal = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

function validCommand(body) {
  if (!exact(body, ["requestId", "action", "params"]) || typeof body.requestId !== "string"
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId) || !object(body.params)) return false;
  const p = body.params;
  const mode = (x) => ["mentions", "participate"].includes(x);
  const source = (x) => ["local", "ai"].includes(x);
  switch (body.action) {
    case "start": return exact(p, ["channel", "chatMode", "replySource", "autoResume"])
      && typeof p.channel === "string" && /^[a-z0-9_]{3,25}$/.test(p.channel)
      && mode(p.chatMode) && source(p.replySource) && typeof p.autoResume === "boolean";
    case "settings": return exact(p, ["chatMode", "replySource", "autoResume"])
      && mode(p.chatMode) && source(p.replySource) && typeof p.autoResume === "boolean";
    case "draft": return exact(p, ["mode"]) && ["reply", "summary"].includes(p.mode);
    case "send": return exact(p, ["text"]) && typeof p.text === "string"
      && p.text === p.text.trim() && p.text.length >= 1 && p.text.length <= 300
      && !/^[/.]|[\r\n\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(p.text);
    case "stop": case "watch": case "drops-enable": case "drops-disable": case "drops-check": return exact(p, []);
    default: return false;
  }
}

function validClipAction(path, body) {
  const ids = value => Array.isArray(value) && value.length >= 1 && value.length <= 4
    && new Set(value).size === value.length && value.every(id => ["primary", "test", "third", "fourth"].includes(id));
  const channel = value => typeof value === "string" && /^[a-z0-9_]{3,25}$/.test(value);
  if (path.endsWith("/settings")) return exact(body, ["enabled", "channel", "accountIds"])
    && typeof body.enabled === "boolean" && channel(body.channel) && ids(body.accountIds);
  if (path.endsWith("/create")) return exact(body, ["requestId", "channel", "accountIds"])
    && typeof body.requestId === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId)
    && channel(body.channel) && ids(body.accountIds);
  if (path.endsWith("/authorization")) return exact(body, ["accountId", "action"])
    && ["primary", "test", "third", "fourth"].includes(body.accountId) && ["start", "poll"].includes(body.action);
  return false;
}

function validDirectorAction(path, body) {
  const id = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
  if (path === "/api/director/cancel") return exact(body, ["requestId", "planId"])
    && id(body.requestId) && id(body.planId);
  if (!exact(body, ["requestId", "expectedRevision", "bank"]) || !id(body.requestId)
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
      || !exact(body.bank, ["entries", "profiles"]) || Buffer.byteLength(JSON.stringify(body.bank)) > 60000) return false;
  const ids = ["primary", "test", "third", "fourth"], bank = body.bank;
  if (!Array.isArray(bank.profiles) || bank.profiles.length !== 4
      || new Set(bank.profiles.map(p => p?.id)).size !== 4
      || !bank.profiles.every(p => exact(p, ["id", "chatMode", "replySource"]) && ids.includes(p.id)
        && ["mentions", "participate"].includes(p.chatMode) && ["local", "ai"].includes(p.replySource))) return false;
  const replies = ["greeting", "checkin", "goodday", "roughday", "quietday", "thanks", "farewell", "goodnight", "welcome",
    "dayfollowup", "reciprocal", "quietfollowup", "dayplans", "capabilities", "automation", "game", "streamtitle", "livestatus"];
  return Array.isArray(bank.entries) && bank.entries.length >= 1 && bank.entries.length <= 160
    && new Set(bank.entries.map(e => e?.id)).size === bank.entries.length && bank.entries.every(entry => {
      if (!exact(entry, ["id", "kind", "category", "lines", "accountIds", "enabled"])
          || typeof entry.id !== "string" || !/^[a-z0-9_:-]{1,80}$/.test(entry.id) || typeof entry.enabled !== "boolean"
          || !Array.isArray(entry.accountIds) || entry.accountIds.length < 1 || entry.accountIds.length > 4
          || new Set(entry.accountIds).size !== entry.accountIds.length || !entry.accountIds.every(x => ids.includes(x))
          || !Array.isArray(entry.lines) || entry.lines.length < 1 || entry.lines.length > 16) return false;
      const categoryValid = entry.kind === "topic" ? ["general", "just chatting", "music", "art"].includes(entry.category)
        : entry.kind === "reply" ? replies.includes(entry.category)
        : entry.kind === "event" ? ["bits", "sub", "resub", "gift", "gift_batch"].includes(entry.category)
        : ["greeting", "exchange"].includes(entry.kind) && entry.category === entry.kind;
      if (!categoryValid || entry.kind === "exchange" && entry.lines.length !== 2) return false;
      const placeholders = entry.kind === "topic" || entry.kind === "reply" && entry.category === "game" ? ["{game}"]
        : entry.kind === "reply" && entry.category === "streamtitle" ? ["{title}"] : [];
      return entry.lines.every(line => {
        if (typeof line !== "string" || line !== line.trim() || line.length < 1 || line.length > 260
            || /^[/.]|[\r\n\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(line)) return false;
        let literal = line;
        for (const token of placeholders) literal = literal.split(token).join("");
        return !/[{}]/.test(literal);
      });
    });
}

function publicOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function apiOrigin(req, origin, mutation) {
  const incoming = req.get("origin"), site = req.get("sec-fetch-site");
  if (mutation) return incoming === origin && site === "same-origin";
  return incoming ? incoming === origin && (!site || site === "same-origin") : site === "same-origin";
}

function safeHeaders(res) {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()" });
}

function errorResponse(res, status, code, error) {
  safeHeaders(res);
  return res.status(status).json({ ok: false, error, code });
}

// Mount before the site's general JSON parser so the byte limit applies even
// to chunked JSON and whitespace that disappears during JSON.parse.
const parseControllerJSON = express.json({ limit: MAX_BODY });
function bodyParser(req, res, next) {
  parseControllerJSON(req, res, (error) => {
    if (!error) return next();
    return errorResponse(res, error.status === 413 ? 413 : 400,
      error.status === 413 ? "request_too_large" : "invalid_json",
      error.status === 413 ? "Controller request is too large." : "Invalid controller JSON.");
  });
}

function unavailable(req, res, mutation) {
  if (mutation) return errorResponse(res, 503, "command_unconfirmed", "The connection to your Mac was lost. The command outcome is unconfirmed. Refresh status before taking another action.");
  if (STATIC.get(req.controllerPath) === "text/html") {
    safeHeaders(res);
    const page = renderControllerPage(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twitch Controller unavailable</title></head><body><main class="controller-offline" id="main"><h1>Your Mac is unavailable</h1><p>The controller could not reach the Mac. Keep it awake and signed in, with Chrome and the companion services open.</p><p>No commands will be queued or replayed when the connection returns.</p><p><a href="${MOUNT}/accounts">Retry controller</a></p></main></body></html>`);
    res.set("Content-Security-Policy", page.csp);
    return res.status(503).type("html").send(page.html);
  }
  return errorResponse(res, 503, "mac_unavailable", "Your Mac controller is unavailable. Check that the Mac and its private connection are awake.");
}

function redact(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) if (typeof secret === "string" && secret.length >= 16) value = value.split(secret).join("[redacted]");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

// One fixed private target. Browser/session headers and requested target URLs
// never cross this boundary. A lost POST response is never retried here.
function upstreamRequest({ port, timeoutMs, remoteToken, path, method, body, csrf }) {
  return new Promise((resolve, reject) => {
    const limit = method === "GET" && path === "/api/accounts" ? MAX_ACCOUNTS_RESPONSE : MAX_RESPONSE;
    const headers = { Host: "127.0.0.1:8795", Origin: LOCAL_ORIGIN, "Sec-Fetch-Site": "same-origin",
      Authorization: `Bearer ${remoteToken}`, Accept: "application/json, text/html, text/javascript, text/css" };
    const data = method === "POST" ? JSON.stringify(body) : null;
    if (data !== null) {
      headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data);
      headers["X-CSRF-Token"] = csrf;
    }
    let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(value); };
    const request = http.request({ hostname: "127.0.0.1", port, path: MOUNT + path, method, headers }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) { request.destroy(new Error("Response limit")); return; }
        chunks.push(chunk);
      });
      response.on("aborted", () => done(new Error("Response interrupted")));
      response.on("error", (error) => done(error));
      response.on("end", () => done(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Connection deadline")), timeoutMs);
    request.on("error", (error) => done(error));
    if (data !== null) request.end(data); else request.end();
  });
}

function createRouter({ publicOrigin: configuredOrigin, remoteToken, upstreamPort = 18795, timeoutMs = 8000, guards = auth } = {}) {
  const origin = publicOrigin(configuredOrigin);
  const configured = !!origin && TOKEN.test(remoteToken || "") && Number.isInteger(upstreamPort)
    && upstreamPort >= 1 && upstreamPort <= 65535 && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000;
  let issuedRead = 0, lastObservedRead = 0, hostCsrf = null;
  function observeHostNonce(order, token) {
    if (order > lastObservedRead) { lastObservedRead = order; hostCsrf = token; }
    return token === hostCsrf;
  }
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use(guards.requireSuperadmin, guards.enforce2fa);
  router.use(bodyParser);
  router.use(async (req, res) => {
    safeHeaders(res);
    const raw = String(req.originalUrl || ""), suffix = raw.startsWith(MOUNT) ? raw.slice(MOUNT.length) : null;
    if (suffix === null || /[?%\\\u0000-\u0020\u007f]/.test(suffix)) return errorResponse(res, 404, "not_found", "Controller route not found.");
    if (suffix === "" && req.method === "GET") return res.redirect(302, `${MOUNT}/accounts`);
    req.controllerPath = suffix;
    const history = DIRECTOR_HISTORY.exec(suffix);
    const isData = DATA.has(suffix) || CHANNEL_LOOKUP.test(suffix) || !!history && Number.isSafeInteger(Number(history[2])),
      isControl = suffix === "/api/control", isCommand = COMMAND.test(suffix), isBrowser = BROWSER.test(suffix), isClip = CLIP.test(suffix),
      isDirector = DIRECTOR_MUTATIONS.has(suffix);
    const mutation = isControl || isCommand || isBrowser || isClip || isDirector;
    if (!STATIC.has(suffix) && !isData && !mutation) return errorResponse(res, 404, "not_found", "Controller route not found.");
    if (req.method !== (mutation ? "POST" : "GET") || req.get("upgrade")) return errorResponse(res, 405, "method_not_allowed", "This controller method is not supported.");
    if (!configured) return unavailable(req, res, false);
    if ((isData || mutation) && !apiOrigin(req, origin, mutation)) return errorResponse(res, 403, "origin_required", "Open the controller on this server to use its controls.");
    if (!req.session || typeof req.sessionID !== "string" || !req.sessionID) return errorResponse(res, 503, "session_unavailable", "Sign in again to use the controller.");
    // Express loads a separate copy of the same session for each parallel poll.
    // Give those reads one token without writing back stale copies to the site session store.
    const browserCsrf = TOKEN.test(req.session.companionCsrf || "") ? req.session.companionCsrf
      : createHmac("sha256", remoteToken).update("twitch-controller-csrf\0").update(req.sessionID).digest("base64url");
    if (mutation) {
      if (!equal(req.get("x-csrf-token"), browserCsrf)) return errorResponse(res, 403, "csrf_required", "Refresh the controller before using its controls.");
      if (!req.is("application/json")) return errorResponse(res, 415, "json_required", "JSON required.");
      let valid = false;
      try {
        if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY) return errorResponse(res, 413, "request_too_large", "Controller request is too large.");
        valid = isDirector ? validDirectorAction(suffix, req.body) : isClip ? validClipAction(suffix, req.body) : isBrowser ? exact(req.body, ["requestId"]) && typeof req.body.requestId === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(req.body.requestId)
          : isControl ? object(req.body) && Object.keys(req.body).length === 1
          && ["paused", "exchangesEnabled"].includes(Object.keys(req.body)[0]) && typeof Object.values(req.body)[0] === "boolean" : validCommand(req.body);
      } catch { /* Invalid bodies are rejected before contacting the Mac. */ }
      if (!valid) return errorResponse(res, 400, "invalid_control", "Choose one supported controller action and its exact settings.");
    }
    let actionForwarded = false;
    try {
      const deadline = Date.now() + timeoutMs;
      if (mutation && !hostCsrf) {
        // A reloaded web worker has no Mac nonce yet. Recover it with one status
        // read before forwarding the explicit action, within the original deadline.
        const order = ++issuedRead;
        const status = await upstreamRequest({ port: upstreamPort, timeoutMs, remoteToken, method: "GET", path: "/api/status" });
        const token = status.status === 200 && String(status.headers["content-type"] || "").includes("application/json") && JSON.parse(status.body).csrfToken;
        if (!TOKEN.test(token || "") || Date.now() >= deadline || res.destroyed) return unavailable(req, res, false);
        observeHostNonce(order, token);
      }
      const order = isData ? ++issuedRead : 0, forwardedCsrf = hostCsrf;
      actionForwarded = mutation;
      const upstream = await upstreamRequest({ port: upstreamPort, timeoutMs: Math.max(1, deadline - Date.now()), remoteToken, path: suffix,
        method: req.method, body: req.body, csrf: forwardedCsrf });
      if (upstream.status >= 300 && upstream.status < 400 || upstream.status < 200 || upstream.status >= 500) return unavailable(req, res, mutation);
      if (isData || mutation) {
        if (!String(upstream.headers["content-type"] || "").includes("application/json")) return unavailable(req, res, mutation);
        let value;
        try { value = JSON.parse(upstream.body.toString("utf8")); } catch { return unavailable(req, res, mutation); }
        if (!object(value)) return unavailable(req, res, mutation);
        const secrets = [remoteToken, req.session.companionUpstreamCsrf, forwardedCsrf, hostCsrf];
        if (isData && upstream.status === 200) {
          if (!TOKEN.test(value.csrfToken || "")) return unavailable(req, res, false);
          if (!observeHostNonce(order, value.csrfToken)) return errorResponse(res, 503, "controller_refresh_required", "The Mac controller restarted during this read. Refresh its status.");
          secrets.push(value.csrfToken);
          value = redact(value, secrets);
          value.csrfToken = browserCsrf;
        } else {
          if ([401, 403].includes(upstream.status)) return errorResponse(res, mutation ? 409 : 503, "controller_refresh_required", "The private controller connection needs to refresh. Check status before taking another action.");
          value = redact(value, secrets);
        }
        return res.status(upstream.status).json(value);
      }
      if (upstream.status !== 200 || !String(upstream.headers["content-type"] || "").startsWith(STATIC.get(suffix))) return unavailable(req, res, false);
      for (const name of ["content-security-policy", "permissions-policy"]) if (upstream.headers[name]) res.set(name, upstream.headers[name]);
      const text = redact(upstream.body.toString("utf8"), [remoteToken, req.session.companionUpstreamCsrf, forwardedCsrf, hostCsrf]);
      if (STATIC.get(suffix) === "text/html") {
        const page = renderControllerPage(text, upstream.headers["content-security-policy"]);
        res.set("Content-Security-Policy", page.csp);
        return res.status(200).type("html").send(page.html);
      }
      return res.status(200).type(STATIC.get(suffix)).send(text);
    } catch { return unavailable(req, res, actionForwarded); }
  });
  return router;
}

const router = createRouter({ publicOrigin: process.env.TWITCH_CONTROLLER_PUBLIC_ORIGIN,
  remoteToken: process.env.TWITCH_CONTROLLER_TOKEN,
  upstreamPort: process.env.TWITCH_CONTROLLER_PORT ? Number(process.env.TWITCH_CONTROLLER_PORT) : 18795 });
module.exports = router;
module.exports.createRouter = createRouter;
module.exports.MOUNT = MOUNT;
module.exports.bodyParser = bodyParser;
