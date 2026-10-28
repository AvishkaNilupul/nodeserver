#!/usr/bin/env node
// Mac-local Outlook mail proxy for the buyer-facing /mail viewer on prod.
// Credentials never leave this machine — prod reaches us through the reverse
// SSH tunnel in run-tunnel.sh (mirrors the auto-claim worker: see memory note
// project_epic_worker_on_mac_1022).
//
// Self-contained on purpose: no npm packages (Node's own fetch), so a copy can
// run from ~/epic-mail-proxy/ and keeps working whatever branch the project
// checkout is on. The two data files it reads are found through env, falling
// back to the project's scripts/ folder:
//   EPIC_MAIL_PROXY_OUTLOOKS  scripts/outlooks.txt   — email : password : refresh_token : client_id
//   EPIC_MAIL_PROXY_USAGE     scripts/mail-usage.json — which inboxes other sites use
//   EPIC_MAIL_PROXY_TOKEN     bearer token prod sends (required)
//   EPIC_MAIL_PROXY_PORT      default 4123
//
// Endpoints (all require `Authorization: Bearer $EPIC_MAIL_PROXY_TOKEN`):
//   GET  /health            → { ok, inboxes }
//   POST /check             → { ok, sellable, sharedWith, uses, status }
//   POST /list              → { ok, inboxAddress, messages[] }   (Epic senders only)
//   POST /message           → { ok, message }                    (Epic senders only)
//
// Binds loopback only. The LaunchAgent at ~/Library/LaunchAgents/
// com.redeemer.epic-mail-proxy.plist keeps it running; the reverse tunnel
// (com.redeemer.epic-mail-tunnel) forwards prod:18124 → mac:4123.

const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.EPIC_MAIL_PROXY_PORT || 4123);
const TOKEN = process.env.EPIC_MAIL_PROXY_TOKEN || "";
if (!TOKEN) {
  console.error("[epic-mail-proxy] EPIC_MAIL_PROXY_TOKEN not set — refusing to start");
  process.exit(1);
}

const PROJECT_SCRIPTS = path.resolve(__dirname);
const OUT_FILE = process.env.EPIC_MAIL_PROXY_OUTLOOKS || path.join(PROJECT_SCRIPTS, "outlooks.txt");
const USAGE_FILE = process.env.EPIC_MAIL_PROXY_USAGE || path.join(PROJECT_SCRIPTS, "mail-usage.json");

const AUTHORITY_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPES = "offline_access Mail.ReadWrite User.Read";
const GRAPH = "https://graph.microsoft.com/v1.0";
const HTTP_TIMEOUT_MS = 20000;
// Mail newer than the cutoff is read page by page until this many messages
// were looked at — an inbox that also gets SOOP mail can bury Epic's under it.
const MAX_SCANNED = 150;
const PAGE_SIZE = 50;

// Same allow-list the server-side client enforces — repeated here so a
// prod-side bug can never cause SOOP/Microsoft mail to leave this proxy.
const EPIC_SENDER_DOMAINS = [
  "epicgames.com",
  "accounts.epicgames.com",
  "mail.epicgames.com",
  "e.mail.epicgames.com",
  "em.epicgames.com",
];

function isEpicSender(address) {
  if (!address) return false;
  const addr = String(address).toLowerCase();
  return EPIC_SENDER_DOMAINS.some((d) => addr === d || addr.endsWith("@" + d) || addr.endsWith("." + d));
}

function readAccounts() {
  if (!fs.existsSync(OUT_FILE)) return [];
  const out = [];
  for (const raw of fs.readFileSync(OUT_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(line.includes("|") ? "|" : ":");
    if (parts.length < 4) continue;
    out.push({
      email: parts[0].trim().toLowerCase(),
      refreshToken: parts[2],
      clientId: parts[3].trim(),
    });
  }
  return out;
}

function readUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return {};
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function findAccount(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  return readAccounts().find((a) => a.email === key) || null;
}

// Every site that has this inbox on record ("epic" included).
function usesOf(email) {
  const uses = readUsage()[String(email || "").toLowerCase()] || {};
  return Object.keys(uses).filter((k) => !!uses[k]);
}

async function fetchJson(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      const e = new Error(
        (body && (body.error_description || (body.error && body.error.message) || body.error)) || "HTTP " + r.status,
      );
      e.status = r.status;
      throw e;
    }
    return body;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Access tokens live ~60-90 min; one per inbox is kept until 5 min before it
// ends, so a buyer refreshing the page doesn't mint a token every time.
const tokenCache = new Map();
async function accessTokenFor(acct) {
  const hit = tokenCache.get(acct.email);
  if (hit && hit.refreshToken === acct.refreshToken && hit.until > Date.now()) return hit.token;
  const body = new URLSearchParams({
    client_id: acct.clientId,
    grant_type: "refresh_token",
    refresh_token: acct.refreshToken,
    scope: SCOPES,
  }).toString();
  const data = await fetchJson(AUTHORITY_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!data || !data.access_token) throw new Error("no access_token");
  const life = Math.max(300, Number(data.expires_in) || 3600);
  tokenCache.set(acct.email, {
    token: data.access_token,
    refreshToken: acct.refreshToken,
    until: Date.now() + (life - 300) * 1000,
  });
  return data.access_token;
}

function shape(m) {
  return {
    id: m.id,
    subject: m.subject || "(no subject)",
    from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || "",
    receivedDateTime: m.receivedDateTime,
    bodyPreview: m.bodyPreview || "",
    body: (m.body && m.body.content) || m.bodyPreview || "",
    isRead: !!m.isRead,
  };
}

async function listEpicMessages({ accessToken, sinceIso, top = 20 }) {
  let url =
    GRAPH +
    "/me/messages?$top=" +
    PAGE_SIZE +
    "&$orderby=receivedDateTime desc" +
    "&$filter=" +
    encodeURIComponent("receivedDateTime ge " + sinceIso) +
    "&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,body";
  const out = [];
  let scanned = 0;
  while (url && scanned < MAX_SCANNED && out.length < top) {
    const data = await fetchJson(url, {
      headers: { Authorization: "Bearer " + accessToken, Prefer: 'outlook.body-content-type="text"' },
    });
    const page = Array.isArray(data && data.value) ? data.value : [];
    scanned += page.length;
    for (const m of page) {
      if (isEpicSender(m && m.from && m.from.emailAddress && m.from.emailAddress.address)) out.push(shape(m));
    }
    url = (data && data["@odata.nextLink"]) || "";
  }
  return out.slice(0, top);
}

async function fetchOneMessage({ accessToken, id }) {
  const data = await fetchJson(
    GRAPH + "/me/messages/" + encodeURIComponent(id) + "?$select=id,subject,from,receivedDateTime,bodyPreview,isRead,body",
    { headers: { Authorization: "Bearer " + accessToken, Prefer: 'outlook.body-content-type="text"' } },
  );
  if (!isEpicSender(data && data.from && data.from.emailAddress && data.from.emailAddress.address)) {
    const err = new Error("message not found");
    err.code = "not_found";
    throw err;
  }
  return shape(data);
}

// ----- tiny HTTP server (one handler per method+path) -----------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorised(req) {
  return (req.headers["authorization"] || "") === "Bearer " + TOKEN;
}

async function handle(req, res) {
  // Loopback only. If anything but 127.0.0.1 / ::1 ever reaches us, refuse.
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (remote !== "127.0.0.1" && remote !== "::1") return send(res, 403, { ok: false, error: "loopback only" });
  if (!authorised(req)) return send(res, 401, { ok: false, error: "unauthorized" });
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && route === "/health") {
    return send(res, 200, { ok: true, inboxes: readAccounts().length });
  }

  let body;
  if (req.method === "POST") {
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && route === "/check") {
    const email = String(body.email || "").toLowerCase();
    const acct = findAccount(email);
    if (!acct) return send(res, 200, { ok: true, sellable: false, status: "unknown", sharedWith: [], uses: [] });
    const uses = usesOf(email);
    // The inbox's own Epic account is not "another site".
    const shared = uses.filter((u) => u !== "epic");
    return send(res, 200, { ok: true, sellable: shared.length === 0, sharedWith: shared, uses, status: "live" });
  }

  if (req.method === "POST" && route === "/list") {
    const acct = findAccount(body.email);
    if (!acct) return send(res, 404, { ok: false, error: "unknown inbox" });
    const sinceIso = String(body.sinceIso || new Date(0).toISOString());
    if (!Number.isFinite(Date.parse(sinceIso))) return send(res, 400, { ok: false, error: "bad sinceIso" });
    const top = Math.min(50, Math.max(1, Number(body.top) || 20));
    try {
      const token = await accessTokenFor(acct);
      const messages = await listEpicMessages({ accessToken: token, sinceIso: new Date(sinceIso).toISOString(), top });
      return send(res, 200, { ok: true, inboxAddress: acct.email, messages });
    } catch (err) {
      if (err && err.status === 401) tokenCache.delete(acct.email);
      return send(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }

  if (req.method === "POST" && route === "/message") {
    const acct = findAccount(body.email);
    if (!acct) return send(res, 404, { ok: false, error: "unknown inbox" });
    try {
      const token = await accessTokenFor(acct);
      const message = await fetchOneMessage({ accessToken: token, id: String(body.id || "") });
      return send(res, 200, { ok: true, message });
    } catch (err) {
      if (err && err.code === "not_found") return send(res, 404, { ok: false, code: "not_found", error: "not found" });
      if (err && err.status === 404) return send(res, 404, { ok: false, code: "not_found", error: "not found" });
      if (err && err.status === 401) tokenCache.delete(acct.email);
      return send(res, 200, { ok: false, error: (err && err.message) || String(err) });
    }
  }

  return send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[epic-mail-proxy] handler threw", err);
    try {
      send(res, 500, { ok: false, error: "internal" });
    } catch (_) {}
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[epic-mail-proxy] listening on 127.0.0.1:${PORT}, ${readAccounts().length} inbox(es) available ` +
      `(outlooks: ${OUT_FILE}, usage: ${USAGE_FILE})`,
  );
});
