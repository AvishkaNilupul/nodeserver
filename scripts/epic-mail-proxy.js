#!/usr/bin/env node
// Mac-local Outlook mail proxy for the buyer-facing /mail viewer on prod.
// Credentials never leave this machine — prod reaches us through the reverse
// SSH tunnel in run-tunnel.sh (mirrors the auto-claim worker: see memory note
// project_epic_worker_on_mac_1022).
//
// Reads the same two files mail-dashboard.js already maintains:
//   scripts/outlooks.txt      — email : password : refresh_token : client_id
//   scripts/mail-usage.json   — which inboxes are claimed by other sites
//
// Endpoints (all require `Authorization: Bearer $EPIC_MAIL_PROXY_TOKEN`):
//   GET  /health            → { ok, inboxes }
//   POST /check             → { ok, sellable, sharedWith, status }
//   POST /list              → { ok, inboxAddress, messages[] }
//   POST /message           → { ok, message }
//
// Binds loopback only. The LaunchAgent at ~/Library/LaunchAgents/
// com.redeemer.epic-mail-proxy.plist keeps it running; the reverse tunnel
// (com.redeemer.epic-mail-tunnel) forwards prod:18124 → mac:4123.

const fs = require("fs");
const path = require("path");
const http = require("http");
const axios = require("axios");

const PORT = Number(process.env.EPIC_MAIL_PROXY_PORT || 4123);
const TOKEN = process.env.EPIC_MAIL_PROXY_TOKEN || "";
if (!TOKEN) {
  console.error("[epic-mail-proxy] EPIC_MAIL_PROXY_TOKEN not set — refusing to start");
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(PROJECT_ROOT, "scripts", "outlooks.txt");
const USAGE_FILE = path.join(PROJECT_ROOT, "scripts", "mail-usage.json");

const AUTHORITY_TOKEN =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPES = "offline_access Mail.ReadWrite User.Read";
const GRAPH = "https://graph.microsoft.com/v1.0";

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
  return EPIC_SENDER_DOMAINS.some(
    (d) => addr === d || addr.endsWith("@" + d) || addr.endsWith("." + d),
  );
}

function readAccounts() {
  if (!fs.existsSync(OUT_FILE)) return [];
  const lines = fs
    .readFileSync(OUT_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const delim = line.includes("|") ? "|" : ":";
    const parts = line.split(delim);
    if (parts.length < 4) continue;
    out.push({
      email: parts[0].trim().toLowerCase(),
      pass: parts[1],
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

function sharedWith(email) {
  const uses = readUsage()[String(email || "").toLowerCase()] || {};
  // Any entry at all = this inbox already serves another site. We don't look
  // at status because even a 'fail' means the OTHER site has learned this
  // email address — handing it to a buyer leaks that association.
  return Object.keys(uses).filter((k) => !!uses[k]);
}

async function mintAccessToken(acct) {
  const body = new URLSearchParams({
    client_id: acct.clientId,
    grant_type: "refresh_token",
    refresh_token: acct.refreshToken,
    scope: SCOPES,
  }).toString();
  const { data } = await axios.post(AUTHORITY_TOKEN, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  if (!data?.access_token) throw new Error("no access_token");
  return data.access_token;
}

async function listEpicMessages({ accessToken, sinceIso, top = 20 }) {
  const pageSize = Math.min(50, Math.max(top, 20));
  const url =
    GRAPH +
    "/me/messages?$top=" +
    pageSize +
    "&$orderby=receivedDateTime desc" +
    "&$filter=" +
    encodeURIComponent("receivedDateTime ge " + sinceIso) +
    "&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,body";
  const { data } = await axios.get(url, {
    headers: {
      Authorization: "Bearer " + accessToken,
      Prefer: 'outlook-body-content-type="text"',
    },
    timeout: 20000,
  });
  const raw = Array.isArray(data?.value) ? data.value : [];
  return raw
    .filter((m) => isEpicSender(m?.from?.emailAddress?.address))
    .slice(0, top)
    .map((m) => ({
      id: m.id,
      subject: m.subject || "(no subject)",
      from: m?.from?.emailAddress?.address || "",
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview || "",
      body: (m.body && m.body.content) || m.bodyPreview || "",
      isRead: !!m.isRead,
    }));
}

async function fetchOneMessage({ accessToken, id }) {
  const url =
    GRAPH +
    "/me/messages/" +
    encodeURIComponent(id) +
    "?$select=id,subject,from,receivedDateTime,bodyPreview,isRead,body";
  const { data } = await axios.get(url, {
    headers: {
      Authorization: "Bearer " + accessToken,
      Prefer: 'outlook-body-content-type="text"',
    },
    timeout: 20000,
  });
  if (!isEpicSender(data?.from?.emailAddress?.address)) {
    const err = new Error("message not found");
    err.code = "not_found";
    throw err;
  }
  return {
    id: data.id,
    subject: data.subject || "(no subject)",
    from: data?.from?.emailAddress?.address || "",
    receivedDateTime: data.receivedDateTime,
    bodyPreview: data.bodyPreview || "",
    body: (data.body && data.body.content) || data.bodyPreview || "",
    isRead: !!data.isRead,
  };
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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function authorised(req) {
  const h = req.headers["authorization"] || "";
  return h === "Bearer " + TOKEN;
}

async function handle(req, res) {
  // Loopback only. If anything but 127.0.0.1 / ::1 ever reaches us, refuse.
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (remote !== "127.0.0.1" && remote !== "::1") {
    return send(res, 403, { ok: false, error: "loopback only" });
  }
  if (!authorised(req)) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    return send(res, 200, { ok: true, inboxes: readAccounts().length });
  }

  if (req.method === "POST" && path === "/check") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
    const email = String(body.email || "").toLowerCase();
    const acct = findAccount(email);
    if (!acct) {
      return send(res, 200, {
        ok: true,
        sellable: false,
        status: "unknown",
        sharedWith: [],
      });
    }
    const shared = sharedWith(email);
    return send(res, 200, {
      ok: true,
      sellable: shared.length === 0,
      sharedWith: shared,
      status: "live",
    });
  }

  if (req.method === "POST" && path === "/list") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
    const acct = findAccount(body.email);
    if (!acct) return send(res, 404, { ok: false, error: "unknown inbox" });
    const sinceIso = String(body.sinceIso || new Date(0).toISOString());
    const top = Math.min(50, Math.max(1, Number(body.top) || 20));
    try {
      const token = await mintAccessToken(acct);
      const messages = await listEpicMessages({
        accessToken: token,
        sinceIso,
        top,
      });
      return send(res, 200, {
        ok: true,
        inboxAddress: acct.email,
        messages,
      });
    } catch (err) {
      const detail =
        err.response?.data?.error_description ||
        err.response?.data?.error ||
        err.errorMessage ||
        err.message ||
        String(err);
      return send(res, 200, { ok: false, error: detail });
    }
  }

  if (req.method === "POST" && path === "/message") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
    const acct = findAccount(body.email);
    if (!acct) return send(res, 404, { ok: false, error: "unknown inbox" });
    try {
      const token = await mintAccessToken(acct);
      const message = await fetchOneMessage({ accessToken: token, id: body.id });
      return send(res, 200, { ok: true, message });
    } catch (err) {
      if (err.code === "not_found") {
        return send(res, 404, { ok: false, code: "not_found", error: "not found" });
      }
      const detail =
        err.response?.data?.error_description ||
        err.response?.data?.error ||
        err.message ||
        String(err);
      return send(res, 200, { ok: false, error: detail });
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
    `[epic-mail-proxy] listening on 127.0.0.1:${PORT}, ${readAccounts().length} inbox(es) available`,
  );
});
