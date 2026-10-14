// Server-side Twitch SNS OAuth round-trip for SOOP cookie auto-renewal.
//
// Given a Twitch web-session cookie jar (harvested once per account via the
// Cookie-Editor hybrid flow and stored in `TwitchWebCookie`), this module
// re-plays SOOP's own OAuth hop through a residential proxy egress and returns
// the fresh SOOP cookie array ready to drop straight into `SoopAccount.cookies`
// via farm.importAccount().
//
// Why this lives here instead of calling emailnator-proxy over HTTP:
//   - prod runs the nodeserver, not emailnator-proxy
//   - one source of truth for SOOP cookies (Mongo), not a disk file bridge
//   - no network indirection, no second process to deploy
//
// Residential proxy credentials come from env ONLY (`RES_HOST`/`RES_PORT`/
// `RES_USER`/`RES_PASS`); no hardcoded defaults because this repo is public.
// Set them in .env on every box this runs on. See emailnator-proxy.js on the
// Mac for the live values (don't commit them).

const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { URL } = require("url");

const RES_HOST = process.env.RES_HOST || "";
const RES_PORT = parseInt(process.env.RES_PORT || "0", 10);
const RES_USER = process.env.RES_USER || "";
const RES_PASS = process.env.RES_PASS || "";

const SOOP_SNS_URL =
  "https://login.sooplive.com/afreeca/connect.php?sns_code=24&view=login";
const SOOP_HOST_RE = /sooplive\.com|afreeca/i;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function residentialConfigured() {
  return !!(RES_HOST && RES_PORT && RES_USER && RES_PASS);
}

// ---- cookie jar ------------------------------------------------------------

// Minimal RFC-6265-ish jar. Enough for the SOOP + Twitch OAuth flow; not a
// general-purpose jar. Exported so callers can test with it.
class CookieJar {
  constructor() {
    this.jar = [];
  }
  _parseExpires(s) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  _domainMatch(cd, host) {
    const d = String(cd).replace(/^\./, "").toLowerCase();
    const h = String(host).toLowerCase();
    return d === h || h.endsWith("." + d);
  }
  _pathMatch(cp, rp) {
    if (!cp || cp === "/") return true;
    const r = rp || "/";
    return r === cp || r.startsWith(cp.endsWith("/") ? cp : cp + "/");
  }
  ingest(url, setCookie) {
    if (!setCookie) return;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    const u = new URL(url);
    for (const header of headers) {
      const parts = header.split(";").map((s) => s.trim());
      if (!parts.length) continue;
      const first = parts.shift();
      const eq = first.indexOf("=");
      if (eq < 0) continue;
      const c = {
        name: first.slice(0, eq).trim(),
        value: first.slice(eq + 1).trim(),
        domain: u.hostname,
        hostOnly: true,
        path: "/",
        expires: null,
        secure: false,
        httpOnly: false,
        sameSite: null,
      };
      for (const attr of parts) {
        const idx = attr.indexOf("=");
        const k = (idx < 0 ? attr : attr.slice(0, idx)).trim().toLowerCase();
        const v = idx < 0 ? null : attr.slice(idx + 1).trim();
        if (k === "domain" && v) {
          c.domain = v.replace(/^\./, "");
          c.hostOnly = false;
        } else if (k === "path" && v) c.path = v;
        else if (k === "expires" && v) c.expires = this._parseExpires(v);
        else if (k === "max-age" && v) {
          const s = parseInt(v, 10);
          if (Number.isFinite(s)) c.expires = Date.now() + s * 1000;
        } else if (k === "secure") c.secure = true;
        else if (k === "httponly") c.httpOnly = true;
        else if (k === "samesite" && v) c.sameSite = v.toLowerCase();
      }
      this.jar = this.jar.filter(
        (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path),
      );
      if (c.expires && c.expires <= Date.now()) continue;
      this.jar.push(c);
    }
  }
  header(url) {
    const u = new URL(url);
    const now = Date.now();
    const matches = this.jar.filter((c) => {
      if (c.expires && c.expires < now) return false;
      if (c.secure && u.protocol !== "https:") return false;
      if (!this._domainMatch(c.domain, u.hostname)) return false;
      if (!this._pathMatch(c.path, u.pathname || "/")) return false;
      return true;
    });
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  exportMatching(re) {
    const now = Date.now();
    return this.jar
      .filter((c) => (!c.expires || c.expires >= now) && re.test(c.domain))
      .map((c) => ({
        domain: c.hostOnly ? c.domain : c.domain.startsWith(".") ? c.domain : "." + c.domain,
        ...(c.expires ? { expirationDate: Math.floor(c.expires / 1000) } : {}),
        hostOnly: !!c.hostOnly,
        httpOnly: !!c.httpOnly,
        name: c.name,
        path: c.path || "/",
        sameSite: c.sameSite || null,
        secure: !!c.secure,
        session: !c.expires,
        storeId: null,
        value: c.value,
      }));
  }
}

// Seed the jar from a cookie-editor shape (what TwitchWebCookie.cookies decrypts
// into). Skips expired entries.
function seedJarFromExport(jar, cookies) {
  const nowMs = Date.now();
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const expMs = c.expirationDate
      ? Math.floor(c.expirationDate * 1000)
      : null;
    if (expMs && expMs <= nowMs) continue;
    jar.jar.push({
      name: c.name,
      value: String(c.value),
      domain: String(c.domain || "").replace(/^\./, ""),
      hostOnly: !!c.hostOnly,
      path: c.path || "/",
      expires: expMs,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || null,
    });
  }
}

// ---- residential HTTPS via CONNECT tunnel ---------------------------------

function dechunk(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const crlf = buf.indexOf("\r\n", i);
    if (crlf === -1) break;
    const sizeHex = buf.slice(i, crlf).toString("ascii").split(";")[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    i = crlf + 2;
    if (i + size > buf.length) break;
    parts.push(buf.slice(i, i + size));
    i += size + 2;
  }
  return Buffer.concat(parts);
}

// Residential request with a sticky session (`sessid-X` in the user) so every
// leg of one refresh egresses from the same IP — Twitch's integrity check
// hates IP changes mid-session. Session id is derived from the SOOP login
// upstream so the same account always uses the same egress across refreshes.
function residentialRequest({ method, targetUrl, headers, body, sessionId }) {
  if (!residentialConfigured()) {
    return Promise.reject(
      new Error("residential proxy not configured (set RES_HOST/RES_PORT/RES_USER/RES_PASS in .env)"),
    );
  }
  const user = sessionId ? `${RES_USER}-sessid-${sessionId}` : RES_USER;
  const u = new URL(targetUrl);
  const port = u.port ? parseInt(u.port, 10) : 443;
  const auth = Buffer.from(`${user}:${RES_PASS}`).toString("base64");

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const sock = net.connect(RES_PORT, RES_HOST);
    sock.setTimeout(30_000, () => {
      sock.destroy();
      fail(new Error("proxy socket timeout"));
    });

    sock.once("connect", () => {
      sock.write(
        `CONNECT ${u.hostname}:${port} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          `User-Agent: Mozilla/5.0\r\n` +
          `\r\n`,
      );
    });

    let connectBuf = "";
    const onInitial = (chunk) => {
      connectBuf += chunk.toString("binary");
      const end = connectBuf.indexOf("\r\n\r\n");
      if (end === -1) return;
      sock.removeListener("data", onInitial);
      const statusLine = connectBuf.slice(0, connectBuf.indexOf("\r\n"));
      if (!/\s2\d\d\s/.test(statusLine)) {
        sock.destroy();
        return fail(new Error(`CONNECT failed: ${statusLine}`));
      }

      const tlsSock = tls.connect({
        socket: sock,
        servername: u.hostname,
        ALPNProtocols: ["http/1.1"],
      });
      tlsSock.setTimeout(30_000, () => {
        tlsSock.destroy();
        fail(new Error("tls timeout"));
      });

      tlsSock.once("secureConnect", () => {
        const bodyBuf = Buffer.isBuffer(body)
          ? body
          : Buffer.from(body || "", "utf8");
        const hasBody =
          bodyBuf.length > 0 ||
          method === "POST" ||
          method === "PUT" ||
          method === "PATCH";
        const forced = { Host: u.hostname, Connection: "close" };
        if (hasBody) forced["Content-Length"] = String(bodyBuf.length);
        const lines = [`${method} ${u.pathname}${u.search || ""} HTTP/1.1`];
        const seen = new Set(["host", "connection"]);
        if (hasBody) seen.add("content-length");
        for (const [k, v] of Object.entries(forced)) lines.push(`${k}: ${v}`);
        for (const [k, v] of Object.entries(headers || {})) {
          if (v === undefined || v === null) continue;
          if (seen.has(k.toLowerCase())) continue;
          lines.push(`${k}: ${v}`);
        }
        tlsSock.write(lines.join("\r\n") + "\r\n\r\n");
        if (bodyBuf.length) tlsSock.write(bodyBuf);
      });

      const chunks = [];
      tlsSock.on("data", (c) => chunks.push(c));
      tlsSock.on("end", () => {
        const raw = Buffer.concat(chunks);
        const sepIdx = raw.indexOf("\r\n\r\n");
        if (sepIdx === -1) return fail(new Error("malformed upstream response"));
        const headPart = raw.slice(0, sepIdx).toString("utf8");
        let bodyPart = raw.slice(sepIdx + 4);
        const headLines = headPart.split("\r\n");
        const statusParts = headLines[0].split(" ");
        const statusCode = parseInt(statusParts[1], 10);
        const resHeaders = {};
        for (const line of headLines.slice(1)) {
          const i = line.indexOf(":");
          if (i > 0) {
            const name = line.slice(0, i).trim().toLowerCase();
            const val = line.slice(i + 1).trim();
            if (name === "set-cookie") {
              if (!Array.isArray(resHeaders[name])) resHeaders[name] = [];
              resHeaders[name].push(val);
            } else if (resHeaders[name]) {
              resHeaders[name] += ", " + val;
            } else {
              resHeaders[name] = val;
            }
          }
        }
        if ((resHeaders["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
          bodyPart = dechunk(bodyPart);
        }
        done({
          status: statusCode,
          headers: resHeaders,
          body: bodyPart.toString("utf8"),
        });
      });
      tlsSock.on("error", fail);
    };
    sock.on("data", onInitial);
    sock.on("error", fail);
  });
}

function baseNavHeaders(referer, origin) {
  return {
    "User-Agent": BROWSER_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "cross-site" : "none",
    "Sec-Fetch-User": "?1",
    "Sec-Ch-Ua":
      '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    ...(referer ? { Referer: referer } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

async function flowRequest({ sessionId, jar, method, url, headers, body }) {
  const h = { ...headers };
  const cookie = jar.header(url);
  if (cookie) h["Cookie"] = cookie;
  const r = await residentialRequest({
    method,
    targetUrl: url,
    headers: h,
    body,
    sessionId,
  });
  jar.ingest(url, r.headers["set-cookie"]);
  return r;
}

async function followRedirects({ sessionId, jar, method, url, headers = {}, body, max = 15 }) {
  let curMethod = method,
    curUrl = url,
    curBody = body;
  let curHeaders = { ...headers };
  const chain = [];
  for (let i = 0; i < max; i++) {
    const r = await flowRequest({
      sessionId,
      jar,
      method: curMethod,
      url: curUrl,
      headers: curHeaders,
      body: curBody,
    });
    chain.push({ method: curMethod, url: curUrl, status: r.status });
    const loc = r.headers["location"];
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, curUrl).toString();
      if (r.status === 303 || (curMethod !== "GET" && curMethod !== "HEAD")) {
        curMethod = "GET";
        curBody = undefined;
        delete curHeaders["Content-Type"];
        delete curHeaders["Content-Length"];
      }
      const prevHost = new URL(curUrl).host;
      const nextHost = new URL(next).host;
      curHeaders["Referer"] = curUrl;
      curHeaders["Sec-Fetch-Site"] =
        prevHost === nextHost ? "same-origin" : "cross-site";
      curUrl = next;
      continue;
    }
    return { ...r, finalUrl: curUrl, chain };
  }
  throw new Error("too many redirects (" + chain.length + ")");
}

// Dedup SOOP cookies — each cookie is often set under both `.sooplive.com` and
// `sooplive.com` in one round. Keep the broader (non-hostOnly) copy per name.
function dedupeSoopCookies(list) {
  const byName = new Map();
  for (const c of list) {
    const key = `${c.name}|${c.path}`;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, c);
      continue;
    }
    if (!prev.hostOnly && c.hostOnly) continue;
    if (prev.hostOnly && !c.hostOnly) {
      byName.set(key, c);
      continue;
    }
    const pExp = prev.expirationDate || 0;
    const cExp = c.expirationDate || 0;
    if (cExp > pExp) byName.set(key, c);
  }
  return [...byName.values()];
}

// Deterministic sticky-session id per SOOP login so the same account always
// egresses from the same residential IP (same anti-detection reasoning as the
// standalone proxy).
function sessionIdFor(soopId) {
  return crypto
    .createHash("sha256")
    .update("soop:" + String(soopId))
    .digest("hex")
    .slice(0, 16);
}

// Core API: given a SOOP login id and the Twitch web cookies for the Twitch
// login it's linked to, replay SOOP's OAuth round-trip and return the fresh
// SOOP cookie-editor array (NOT persisted anywhere — caller handles that).
async function refreshSoopCookies({ soopId, twitchCookies }) {
  if (!soopId) return { ok: false, reason: "bad_args", detail: "no soopId" };
  if (!Array.isArray(twitchCookies) || !twitchCookies.length) {
    return { ok: false, reason: "bad_args", detail: "no twitch cookies" };
  }
  if (!residentialConfigured()) {
    return {
      ok: false,
      reason: "no_residential",
      detail: "RES_HOST/RES_PORT/RES_USER/RES_PASS not set in env",
    };
  }
  const sessionId = sessionIdFor(soopId);
  const jar = new CookieJar();
  seedJarFromExport(jar, twitchCookies);
  const started = Date.now();

  let final;
  try {
    final = await followRedirects({
      sessionId,
      jar,
      method: "GET",
      url: SOOP_SNS_URL,
      headers: baseNavHeaders(),
      max: 20,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "soop_oauth_fail",
      detail: e.message,
      took_ms: Date.now() - started,
    };
  }

  if (/twitch\.tv\/login/i.test(final.finalUrl)) {
    return {
      ok: false,
      reason: "twitch_session_expired",
      detail:
        "id.twitch.tv/oauth2/authorize bounced to twitch.tv/login — the stored Twitch cookies for this account have expired or lost persistent. Re-harvest.",
      finalUrl: final.finalUrl,
      took_ms: Date.now() - started,
    };
  }

  // Trailing SOOP home hit so any remaining cookies the home sets land too.
  try {
    await followRedirects({
      sessionId,
      jar,
      method: "GET",
      url: "https://www.sooplive.com/",
      headers: baseNavHeaders(
        "https://login.sooplive.com/",
        "https://login.sooplive.com",
      ),
      max: 10,
    });
  } catch {
    // best-effort
  }

  let soopCookies = jar.exportMatching(SOOP_HOST_RE);
  soopCookies = dedupeSoopCookies(soopCookies);
  const names = soopCookies.map((c) => c.name);
  const hasAuth = names.some((n) => /^AuthTicket$/i.test(n));
  const hasUser = names.some((n) => /^UserTicket$/i.test(n));
  if (!hasAuth || !hasUser) {
    return {
      ok: false,
      reason: "missing_tickets",
      hasAuthTicket: hasAuth,
      hasUserTicket: hasUser,
      cookieNames: names,
      finalUrl: final.finalUrl,
      took_ms: Date.now() - started,
    };
  }

  // Verify the UserTicket's uid actually matches the requested soopId — a stale
  // Twitch session can mint cookies for the wrong account; never save those.
  const userTicket = soopCookies.find((c) => /^UserTicket$/i.test(c.name));
  const uidMatch = userTicket
    ? decodeURIComponent(userTicket.value).match(/uid=([^&]+)/)
    : null;
  const identity = uidMatch ? uidMatch[1] : null;
  if (identity && identity !== soopId) {
    return {
      ok: false,
      reason: "identity_mismatch",
      expected: soopId,
      actual: identity,
      took_ms: Date.now() - started,
    };
  }

  return {
    ok: true,
    soopId,
    identity,
    cookies: soopCookies,
    cookieCount: soopCookies.length,
    took_ms: Date.now() - started,
  };
}

module.exports = {
  residentialConfigured,
  CookieJar,
  refreshSoopCookies,
};
