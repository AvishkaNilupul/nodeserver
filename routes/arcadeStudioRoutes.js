const express = require("express");
const { createHmac, timingSafeEqual } = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const nodePath = require("node:path");
const { requireSuperadmin, enforce2fa } = require("../middleware/auth");

const MOUNT = "/admin/arcade-studio";
const STATUS = "/api/status";
const FRAME = "/api/frame";
const START = "/api/start";
const STOP = "/api/stop";
const PROVISION = "/api/provision";
const CHANNELS = Object.freeze({ aviskarex: 8819, wiznims: 8820 });
const DASHBOARD = nodePath.join(__dirname, "../admin-pages/arcade-studio");
const PAGES = new Map([["/", "index.html"], ["/studio.css", "studio.css"], ["/studio.js", "studio.js"]]);
const MEDIA = new Map([[FRAME, "image/jpeg"],
  ...["standby", "marble", "word", "echo", "route", "orbit", "forge"].map(name => [`/images/${name}.webp`, "image/webp"])]);
const CONFIRMATIONS = "/etc/twitch-arcade/site-confirmations.json";
const CHANNEL_NAMES = Object.keys(CHANNELS);
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

function siteToken(secret, id, channel) {
  if (!TOKEN.test(secret || "") || !id) throw new Error("Studio status is unavailable");
  return createHmac("sha256", secret).update("arcade-studio\0").update(channel).update("\0").update(id).digest("base64url");
}

function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(body, allowed) {
  return object(body) && Object.keys(body).every(key => allowed.includes(key));
}
function validSettings(body) {
  return onlyKeys(body, ["mode", "duration", "fps", "volume"]) &&
    ["live", "test"].includes(body.mode) && Number.isInteger(body.duration) && body.duration >= 60 && body.duration <= 18000 &&
    (body.fps === undefined || [30, 60].includes(body.fps)) &&
    (body.volume === undefined || (Number.isInteger(body.volume) && body.volume >= 0 && body.volume <= 100));
}
function sameToken(input, expected) {
  return typeof input === "string" && TOKEN.test(input) &&
    timingSafeEqual(Buffer.from(input), Buffer.from(expected));
}
function problem(status, message) {
  return Object.assign(new Error(message), { status });
}
function privateConfirmations() {
  // This owner-managed file is outside the checkout and is never served.
  try { return JSON.parse(fs.readFileSync(CONFIRMATIONS, "utf8")); }
  catch { return {}; }
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

function readState(response, channel) {
  if (response.status !== 200 || response.type !== "application/json") throw problem(503, `Studio is unavailable for ${channel}.`);
  const state = JSON.parse(response.body);
  if (state.channel !== channel || !TOKEN.test(state.csrf || "")) throw problem(503, `Could not verify the Studio for ${channel}.`);
  return state;
}

function publicState(state, channel, sessionID) {
  // The original main service predates the key-setup endpoint. Its key was
  // provisioned at deploy. The new service always supplies explicit readiness.
  return { ...state, key_ready: state.key_ready ?? (channel === "aviskarex"),
    csrf: siteToken(state.csrf, sessionID, channel) };
}

function allowedStatusError(upstream, fallback) {
  if (upstream.status >= 400 && upstream.status <= 503 && upstream.type === "application/json") {
    const { error } = JSON.parse(upstream.body);
    if (typeof error === "string" && error.length <= 240 && !/live_\d+_/i.test(error)) return problem(upstream.status, error);
  }
  return problem(503, fallback);
}

function startInputs(aggregate, body, channel, token) {
  if (!object(body)) throw problem(400, "Invalid Studio control settings.");
  let rows, settings;
  if (aggregate) {
    ({ channels: rows, ...settings } = body);
  } else {
    const { confirmationCode, ...values } = body;
    settings = values;
    rows = [{ channel, csrf: token, confirmationCode }];
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > CHANNEL_NAMES.length || !validSettings(settings) ||
      rows.some(row => !onlyKeys(row, ["channel", "csrf", "confirmationCode"]) || !CHANNEL_NAMES.includes(row.channel)) ||
      new Set(rows.map(row => row.channel)).size !== rows.length) throw problem(400, "Choose valid channels and stream settings.");
  return { rows, settings };
}

function planChannel(row, state, settings, codes, sessionID) {
  const channel = row.channel;
  const view = publicState(state, channel, sessionID);
  if (!sameToken(row.csrf, view.csrf)) throw problem(403, `Refresh ${channel} to renew its control token.`);
  if (view.can_stop && ["live", "starting"].includes(view.state) && view.mode === settings.mode) {
    return { channel, state, alreadyRunning: true };
  }
  if (view.can_stop || !["idle", "error"].includes(view.state)) throw problem(409, `${channel} is busy or unavailable for this mode.`);
  if (!view.key_ready) throw problem(409, `Connect the broadcast key for ${channel} before starting.`);
  const configured = codes?.[channel];
  if (typeof configured !== "string" || !/^\d{3}$/.test(configured)) throw problem(503, `Confirmation is unavailable for ${channel}.`);
  if (typeof row.confirmationCode !== "string" || !/^\d{3}$/.test(row.confirmationCode) ||
      !timingSafeEqual(Buffer.from(configured), Buffer.from(row.confirmationCode))) {
    throw problem(403, `Enter the confirmation code for ${channel}.`);
  }
  return { channel, state, alreadyRunning: false };
}

function createRouter({ ports = CHANNELS, origin, confirmations = privateConfirmations } = {}) {
  const status = async channel => readState(await studioRequest(ports[channel], STATUS), channel);
  const router = express.Router({ strict: true, caseSensitive: true });
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
    next();
  });
  router.use(requireSuperadmin, enforce2fa);
  router.use(async (req, res) => {
    const error = (code, message) => res.status(code).json({ error: message });
    const suffix = req.originalUrl.slice(MOUNT.length);
    if (!req.originalUrl.startsWith(MOUNT)) return error(404, "Studio route not found.");
    if ((suffix === "" || /^\/(aviskarex|wiznims)$/.test(suffix)) && req.method === "GET") return res.redirect(302, MOUNT + suffix + "/");
    const named = /^\/(aviskarex|wiznims)(\/.*)$/.exec(suffix);
    // Existing bookmarked main read endpoints still work. All old/new starts
    // use the same checked preflight and the same channel-specific token.
    const channel = named ? named[1] : "aviskarex";
    const resource = named ? named[2] : suffix;
    const path = /^\/api\/frame\?t=\d{1,16}$/.test(resource) ? FRAME : resource;
    const listing = !named && path === "/api/channels";
    const aggregate = !named && path === "/api/start-selected";
    const provision = !!named && channel === "wiznims" && path === PROVISION;
    const mutation = path === START || path === STOP || aggregate || provision;
    if (!PAGES.has(path) && !MEDIA.has(path) && path !== STATUS && !listing && !mutation) return error(404, "Studio route not found.");
    const method = mutation ? "POST" : "GET";
    if (req.method !== method) {
      res.set("Allow", method);
      return error(405, "Unsupported Studio method.");
    }
    const site = req.get("Sec-Fetch-Site"), incoming = req.get("Origin");
    if (mutation && (!origin || incoming !== origin || site !== "same-origin")) return error(403, "Use the controls on this Studio page.");
    if (!mutation && ((incoming && incoming !== origin) || (path !== "/" && site && site !== "same-origin"))) {
      return error(403, "Open the Studio page to access this resource.");
    }
    if (PAGES.has(path)) return res.sendFile(nodePath.join(DASHBOARD, PAGES.get(path)), { cacheControl: false, lastModified: false });
    if (mutation && !req.is("application/json")) return error(415, "Use a JSON request.");
    const id = req.sessionID;
    const token = req.get("X-Studio-Token");
    let forwarded = false;
    try {
      if (listing) {
        const channels = await Promise.all(CHANNEL_NAMES.map(async slug => {
          try { return publicState(await status(slug), slug, id); }
          catch { return { channel: slug, state: "unavailable", message: "Studio unavailable.", mode: null, can_stop: false, key_ready: false, csrf: null }; }
        }));
        return res.json({ channels });
      }
      if (path === STATUS) return res.json(publicState(await status(channel), channel, id));
      if (MEDIA.has(path)) {
        const result = await studioRequest(ports[channel], path);
        if (result.status !== 200 || result.type !== MEDIA.get(path)) throw allowedStatusError(result, "Studio media is unavailable.");
        return res.type(result.type).send(result.body);
      }
      if (aggregate || path === START) {
        const { rows, settings } = startInputs(aggregate, req.body, channel, token);
        const codes = confirmations();
        const plans = await Promise.all(rows.map(async row => planChannel(row, await status(row.channel), settings, codes, id)));
        const results = await Promise.all(plans.map(async plan => {
          const slug = plan.channel;
          if (plan.alreadyRunning) return { channel: slug, outcome: "already_running", state: plan.state };
          try {
            const result = await studioRequest(ports[slug], START, settings, plan.state.csrf);
            if (result.status !== 200) {
              const issue = allowedStatusError(result, "Could not confirm the start. Refresh its status.");
              return { channel: slug, outcome: result.status < 500 ? "failed" : "unconfirmed", message: issue.message, code: issue.status };
            }
            return { channel: slug, outcome: "started", state: readState(result, slug) };
          } catch {
            return { channel: slug, outcome: "unconfirmed", message: "Could not confirm the start. Refresh its status.", code: 503 };
          }
        }));
        if (!aggregate) {
          const result = results[0];
          return result.state ? res.json(publicState(result.state, channel, id)) : error(result.code, result.message);
        }
        return res.status(results.some(row => !row.state) ? 207 : 200).json({
          results: results.map(({ channel, outcome, message }) => ({ channel, outcome, message: message || "" })),
        });
      }
      if (provision) {
        if (!onlyKeys(req.body, ["streamKey"]) || typeof req.body.streamKey !== "string" ||
            !/^live_975369828_[A-Za-z0-9_-]{12,240}$/.test(req.body.streamKey)) {
          return error(400, "Enter the primary broadcast key from the WizNims Twitch dashboard.");
        }
      } else if (!onlyKeys(req.body, [])) return error(400, "Invalid stop request.");
      const current = await status(channel);
      if (!sameToken(token, siteToken(current.csrf, id, channel))) return error(403, "Refresh Studio to renew the control token.");
      forwarded = true;
      const result = await studioRequest(ports[channel], path, req.body, current.csrf);
      if (result.status !== 200) {
        // Provisioning errors can originate during key parsing. Never relay the
        // raw response or form fields to the browser, logs or site storage.
        if (provision) return error(result.status === 409 ? 409 : 400, result.status === 409 ?
          "WizNims already has a key or an active session." : "The broadcast key could not be saved.");
        throw allowedStatusError(result, "Studio could not confirm the action.");
      }
      const nextState = readState(result, channel);
      if (provision) {
        if (nextState.key_ready !== true) throw problem(503, "Refresh Studio to verify key setup.");
        return res.json({ channel, key_ready: true });
      }
      return res.json(publicState(nextState, channel, id));
    } catch (issue) {
      return error(issue.status || 503, issue.status ? issue.message : forwarded ?
        "Studio could not confirm the action. Refresh its status before retrying." : "Studio is unavailable. Refresh to try again.");
    }
  });
  return router;
}

module.exports = createRouter({ origin: process.env.TWITCH_CONTROLLER_PUBLIC_ORIGIN });
module.exports.createRouter = createRouter;
module.exports.bodyParser = bodyParser;
module.exports.MOUNT = MOUNT;
