// Discord HTTP client bound to a specific HOST (local server or an SSH-reached
// Pi) so a session's requests all exit from the same IP. Discord's hCaptcha
// Enterprise challenge (used on quest claims and some other gated endpoints)
// binds the solved captcha token to the solve-IP; if we POST from a different
// IP than the solver used, the token is rejected as "invalid-response". This
// client therefore pairs with utils/discordFarm/solverProxy.js to keep the
// solver and the HTTP call on the same egress IP.
//
// Transport: on `local` the request runs via axios here on the server. On an
// SSH host (a Raspberry Pi), the request is marshalled into a one-shot `curl`
// invocation executed on the Pi via botHosts.runShell — the body goes through
// stdin (`--data-binary @-`) so there's zero shell-escaping risk for the JSON
// payload, and headers are passed as `-H` args.
//
// Returns a uniform shape: { status, headers, data } where `data` is parsed
// JSON when the Content-Type is JSON (or the body looks like JSON), else the
// raw text. For non-2xx responses the parsed body is still returned so callers
// can read the error.code / error.message that Discord puts in a 400.

const axios = require("axios");
const hosts = require("../botHosts");

const DEFAULT_TIMEOUT_MS = 30000;
const DISCORD_API_BASE = "https://discord.com";

// External-IP probe cache — one lookup per host per 10 minutes is plenty.
const IP_CACHE = new Map(); // hostId -> { ip, at }
const IP_TTL_MS = 10 * 60 * 1000;

// Shell-quote a single value for /bin/sh.
function shq(s) { return hosts.shq(String(s)); }

// Build the array of `-H "Name: value"` flags for curl. Multi-value headers
// aren't needed by Discord so we accept a flat object.
function headerArgs(headers = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    parts.push("-H " + shq(k + ": " + String(v)));
  }
  return parts.join(" ");
}

function parseMaybeJson(text, contentType = "") {
  if (!text) return null;
  const t = String(text).trim();
  const looksJson = /^[{[]/.test(t) || /json/i.test(contentType);
  if (!looksJson) return t;
  try { return JSON.parse(t); } catch { return t; }
}

// Local path — just use axios. Shape the response to match the remote path.
// When `proxy` is set, axios tunnels through it (same IP for every request in
// the session) so a captcha solver using the same proxy credentials solves
// from a matching egress IP. The CONNECT tunnel is axios-built-in for HTTPS
// targets; no new dependency needed.
async function requestLocal({ method, path, headers, body, timeout, proxy }) {
  const url = DISCORD_API_BASE + path;
  const axiosOpts = {
    method,
    url,
    headers,
    data: body == null ? undefined : body,
    timeout,
    responseType: "text",
    transformResponse: [(d) => d],
    validateStatus: () => true,
  };
  if (proxy && proxy.host && proxy.port) {
    axiosOpts.proxy = {
      host: proxy.host,
      port: Number(proxy.port),
      protocol: (proxy.protocol || "http").toLowerCase(),
    };
    if (proxy.user) axiosOpts.proxy.auth = { username: proxy.user, password: proxy.pass || "" };
  }
  const r = await axios(axiosOpts);
  return {
    status: r.status,
    headers: r.headers || {},
    data: parseMaybeJson(r.data, r.headers && r.headers["content-type"]),
    via: proxy && proxy.host ? "proxy:" + proxy.host : "local",
  };
}

// Remote path — one-shot curl on the Pi, body piped via stdin so we never have
// to escape JSON into the shell. curl writes:
//   <body>
//   \n---META---\n
//   HTTP_CODE <code>
//   CONTENT_TYPE <content-type>
// so we can split the output and recover status + content-type without a
// second SSH roundtrip.
async function requestRemote(host, { method, path, headers, body, timeout }) {
  const url = DISCORD_API_BASE + path;
  const hdrs = headerArgs(headers);
  const dataFlag = body == null ? "" : " --data-binary @-";
  // The sentinel pattern below is written to stdout BY CURL, not by us — we use
  // -w to append the metadata after the response body.
  const cmd =
    "curl -sS --compressed" +
    " --max-time " + Math.ceil((timeout || DEFAULT_TIMEOUT_MS) / 1000) +
    " -X " + shq(method) +
    " " + hdrs +
    dataFlag +
    " -w " + shq("\n---META---\nHTTP_CODE %{http_code}\nCONTENT_TYPE %{content_type}\n") +
    " " + shq(url);
  const { stdout, stderr } = await hosts.runShell(host, cmd, {
    timeout: (timeout || DEFAULT_TIMEOUT_MS) + 5000,
    input: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = String(stdout || "");
  const idx = text.lastIndexOf("\n---META---\n");
  if (idx < 0) {
    // curl failed hard — stderr likely has the DNS/TLS error
    throw new Error("pi curl failed (no meta): " + (stderr || text).slice(0, 300));
  }
  const bodyText = text.slice(0, idx);
  const meta = text.slice(idx + "\n---META---\n".length);
  const status = parseInt(((meta.match(/HTTP_CODE\s+(\d+)/) || [])[1]) || "0", 10);
  const contentType = ((meta.match(/CONTENT_TYPE\s+(.+)/) || [])[1] || "").trim();
  return {
    status,
    headers: contentType ? { "content-type": contentType } : {},
    data: parseMaybeJson(bodyText, contentType),
    via: "pi:" + host.id,
  };
}

// Public: do a Discord API request. `host` is a resolved host object (from
// botHosts.resolveHost / listHosts). `path` starts with "/" (e.g.
// "/api/v9/users/@me"). Pass `body` as an object (we'll JSON.stringify it) or
// a prepared string.
async function discordRequest(host, { method = "GET", path, headers = {}, body, timeout = DEFAULT_TIMEOUT_MS, proxy } = {}) {
  if (!path || path[0] !== "/") throw new Error("discordRequest: path must start with /");
  // Ensure Content-Type when there's a body (callers often forget).
  if (body != null && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers = { ...headers, "Content-Type": "application/json" };
  }
  // Normalise body to a string (so stdin size matches what we tell curl).
  const bodyStr = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const opts = { method, path, headers, body: bodyStr, timeout, proxy };
  // When a proxy is supplied, always route through it from this process (the
  // whole point is a known shared egress IP). Pi hosts take precedence only
  // when no proxy is specified — in that case the Pi IS the proxy.
  if (proxy && proxy.host) return requestLocal(opts);
  if (!host || host.transport === "local") return requestLocal(opts);
  return requestRemote(host, opts);
}

// Probe the Pi's current external IPv4. Cached for 10 min per host so the
// quest runner can call it freely. On local host returns null — the caller
// uses Proxyless solving in that case.
async function externalIp(host) {
  if (!host || host.transport === "local") return null;
  const cached = IP_CACHE.get(host.id);
  const now = Date.now();
  if (cached && now - cached.at < IP_TTL_MS) return cached.ip;
  const cmd = "curl -sS --max-time 10 https://api.ipify.org || curl -sS --max-time 10 https://ifconfig.me";
  const { stdout } = await hosts.runShell(host, cmd, { timeout: 15000 });
  const ip = String(stdout || "").trim().split(/\s+/)[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error("externalIp: unexpected response: " + stdout);
  }
  IP_CACHE.set(host.id, { ip, at: now });
  return ip;
}

// Convenience: build the standard super-properties base64 payload with the
// most-current client_build_number. Discord bumps this ~weekly; a stale number
// still works (the client gets a soft update prompt) but it's a weak
// anomaly-flag signal. 641004 is from 2026-10 Chrome client traffic.
function buildSuperProperties({ userAgent, locale = "en-US", browserVersion = "155.0.0.0", osVersion = "10.15.7", os = "Mac OS X", buildNumber = 641004 } = {}) {
  const sp = {
    os,
    browser: "Chrome",
    device: "",
    device_model_name: "",
    system_locale: locale,
    has_client_mods: false,
    browser_user_agent: userAgent,
    browser_version: browserVersion,
    os_version: osVersion,
    referrer: "",
    referring_domain: "",
    referrer_current: "https://discord.com/",
    referring_domain_current: "discord.com",
    release_channel: "stable",
    client_build_number: buildNumber,
    client_event_source: null,
  };
  return Buffer.from(JSON.stringify(sp)).toString("base64");
}

function fingerprintForUserAgent(ua, { locale = "en-US", timezone = "Etc/UTC" } = {}) {
  const windows = /Windows NT ([\d.]+)/.exec(ua);
  const mac = /Mac OS X ([\d_]+)/.exec(ua);
  const os = windows ? "Windows" : mac ? "Mac OS X" : "Linux";
  const osVersion = windows?.[1] || mac?.[1]?.replace(/_/g, ".") || "";
  const browserVersion = /Chrome\/([\d.]+)/.exec(ua)?.[1] || "";
  return { ua, locale, timezone, xsp: buildSuperProperties({ userAgent: ua, locale, browserVersion, osVersion, os }) };
}

module.exports = {
  fingerprintForUserAgent,
  discordRequest,
  externalIp,
  buildSuperProperties,
  DISCORD_API_BASE,
};
