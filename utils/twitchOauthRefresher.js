// Server-side Twitch SNS OAuth round-trip for SOOP cookie auto-renewal.
//
// Given a Twitch web-session cookie jar (harvested once per account via the
// Cookie-Editor hybrid flow and stored in TwitchWebCookie), this module
// re-plays SOOP's own OAuth hop and returns the fresh SOOP cookie array ready
// to drop straight into SoopAccount.cookies.
//
// Egress is the local Pi SOCKS5 tunnel (soop-socks.service on prod, binding
// 127.0.0.1:1080 ssh -D through the Pi) so every request leaves on the same
// residential IP the Twitch jars were harvested from. No paid residential
// proxy, no per-account IP rotation, no sticky-session key — one IP is the
// matching fingerprint for all 27 accounts.
//
// SOCKS5 hand-rolled on net.Socket + tls.connect: no new npm dependency.

const net = require("node:net");
const tls = require("node:tls");
const { URL } = require("url");

const SOCKS_HOST = process.env.SOOP_SOCKS_HOST || "127.0.0.1";
const SOCKS_PORT = parseInt(process.env.SOOP_SOCKS_PORT || "1080", 10);
const SOCKS_TIMEOUT_MS = parseInt(process.env.SOOP_SOCKS_TIMEOUT_MS || "30000", 10);

const SOOP_SNS_URL = "https://login.sooplive.com/afreeca/connect.php?sns_code=24&view=login";
const SOOP_HOST_RE = /sooplive\.com|afreeca/i;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

// ---- cookie jar ------------------------------------------------------------

// Minimal RFC-6265-ish jar. Enough for the SOOP + Twitch OAuth flow; not a
// general-purpose jar.
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
    const expMs = c.expirationDate ? Math.floor(c.expirationDate * 1000) : null;
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

// ---- SOCKS5 CONNECT then TLS ----------------------------------------------

// RFC 1928. Hand-rolled, no auth, DOMAINNAME target. All egress goes through
// one tunnel so TLS SNI is set with the target's hostname.
function socks5Connect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      reject(e);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const sock = net.connect(SOCKS_PORT, SOCKS_HOST);
    sock.setTimeout(SOCKS_TIMEOUT_MS, () => fail(new Error("socks5 socket timeout")));
    sock.once("error", fail);

    // Phase 1: greeting (version=5, nmethods=1, method=no-auth)
    sock.once("connect", () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let phase = "greet";
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          return fail(new Error(`socks5 greeting rejected (ver=${buf[0]} method=${buf[1]})`));
        }
        // Phase 2: CONNECT request. Address type 0x03 = DOMAINNAME.
        const host = Buffer.from(targetHost, "utf8");
        if (host.length > 255) return fail(new Error("socks5 host too long"));
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        phase = "connect";
        buf = buf.slice(2);
        sock.write(req);
        return;
      }
      if (phase === "connect") {
        // Reply: VER REP RSV ATYP BND.ADDR BND.PORT
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) return fail(new Error("socks5 bad version in reply"));
        if (buf[1] !== 0x00) return fail(new Error(`socks5 CONNECT refused (rep=${buf[1]})`));
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x03) addrLen = buf.length >= 5 ? buf[4] + 1 : null;
        else if (atyp === 0x04) addrLen = 16;
        else return fail(new Error(`socks5 unknown atyp ${atyp}`));
        if (addrLen == null) return;
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        sock.removeAllListeners("data");
        sock.setTimeout(0);
        done(sock);
      }
    });
  });
}

// One HTTPS request through the SOCKS5 tunnel: dial, upgrade to TLS, write a
// Connection: close HTTP/1.1 request, read the full response, parse headers +
// body + chunked transfer-encoding.
async function socksRequest({ method, targetUrl, headers, body }) {
  const u = new URL(targetUrl);
  const port = u.port ? parseInt(u.port, 10) : 443;
  const rawSock = await socks5Connect(u.hostname, port);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        tlsSock.destroy();
      } catch {}
      reject(e);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const tlsSock = tls.connect({
      socket: rawSock,
      servername: u.hostname,
      ALPNProtocols: ["http/1.1"],
    });
    tlsSock.setTimeout(SOCKS_TIMEOUT_MS, () => fail(new Error("tls timeout")));
    tlsSock.on("error", fail);

    tlsSock.once("secureConnect", () => {
      const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || "", "utf8");
      const hasBody = bodyBuf.length > 0 || /^(POST|PUT|PATCH)$/i.test(method);
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
      done({ status: statusCode, headers: resHeaders, body: bodyPart.toString("utf8") });
    });
  });
}

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

async function flowRequest({ jar, method, url, headers, body, transport }) {
  const h = { ...headers };
  const cookie = jar.header(url);
  if (cookie) h["Cookie"] = cookie;
  const r = await transport({ method, targetUrl: url, headers: h, body });
  jar.ingest(url, r.headers["set-cookie"]);
  return r;
}

async function followRedirects({ jar, method, url, headers = {}, body, max = 15, transport }) {
  let curMethod = method,
    curUrl = url,
    curBody = body;
  let curHeaders = { ...headers };
  const chain = [];
  for (let i = 0; i < max; i++) {
    const r = await flowRequest({
      jar,
      method: curMethod,
      url: curUrl,
      headers: curHeaders,
      body: curBody,
      transport,
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
      curHeaders["Sec-Fetch-Site"] = prevHost === nextHost ? "same-origin" : "cross-site";
      curUrl = next;
      continue;
    }
    return { ...r, finalUrl: curUrl, chain };
  }
  throw new Error("too many redirects (" + chain.length + ")");
}

// Dedup SOOP cookies — each cookie is often set under both .sooplive.com and
// sooplive.com in one round. Keep the broader (non-hostOnly) copy per name.
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

// Core API: given a SOOP login id and the Twitch web cookies for the Twitch
// login it's linked to, replay SOOP's OAuth round-trip and return the fresh
// SOOP cookie-editor array (NOT persisted anywhere — caller handles that).
// Pass { transport } to inject a mocked request function in tests.
async function refreshSoopCookies({ soopId, twitchCookies, transport = socksRequest }) {
  if (!soopId) return { ok: false, reason: "bad_args", detail: "no soopId" };
  if (!Array.isArray(twitchCookies) || !twitchCookies.length) {
    return { ok: false, reason: "bad_args", detail: "no twitch cookies" };
  }
  const jar = new CookieJar();
  seedJarFromExport(jar, twitchCookies);
  const started = Date.now();

  let final;
  try {
    final = await followRedirects({
      jar,
      method: "GET",
      url: SOOP_SNS_URL,
      headers: baseNavHeaders(),
      max: 20,
      transport,
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
      jar,
      method: "GET",
      url: "https://www.sooplive.com/",
      headers: baseNavHeaders("https://login.sooplive.com/", "https://login.sooplive.com"),
      max: 10,
      transport,
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
  const uidMatch = userTicket ? decodeURIComponent(userTicket.value).match(/uid=([^&]+)/) : null;
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
  CookieJar,
  refreshSoopCookies,
  // test / dev-harness surface
  seedJarFromExport,
  dedupeSoopCookies,
  socks5Connect,
  socksRequest,
};
