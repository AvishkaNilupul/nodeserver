// CHZZK transport: one request path for proxied and direct traffic
// (docs/CHZZK-FARM.md §3).
//
// CHZZK only credits watch time to viewers in supported countries, so in
// production every call leaves through a SOCKS5 egress (CHZZK_PROXY_URL — an
// `ssh -D` tunnel to a host in a supported country, or the shared
// SOOP_PROXY_URL). The transport FAILS CLOSED: an unconfigured egress, or a
// proxy that is configured but unusable, refuses every call rather than going
// direct. v1 of the SOOP farm fell back to a direct connection and would have
// sent every login from the US server IP. Local tests opt into direct by
// setting CHZZK_DIRECT=1 or passing direct:true.
//
// The transport does NOT judge status codes — it returns { status, json, text,
// headers } and client.js decides what to do with them.
const https = require("https");
const { ChzzkError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 20000;

function defaultAgentFactory(proxyUrl) {
  // Required lazily: this package must never block app boot.
  const { SocksProxyAgent } = require("socks-proxy-agent");
  return new SocksProxyAgent(proxyUrl);
}

// What may be shown of a proxy URL (never its user:pass) and what to scrub
// from any text that could echo it. A string that does not parse into scheme
// + host is shown as a bare "proxy" and scrubbed whole: "user:pass@host"
// parses with the user name as its scheme.
function readProxy(proxyUrl) {
  let u = null;
  try {
    u = new URL(proxyUrl);
  } catch {
    // handled below
  }
  if (!u || !u.host) return { via: "proxy", secrets: [proxyUrl], valid: false };
  const raw = [u.username, u.password].filter(Boolean);
  // Both spellings (percent-encoded and plain); nothing so short that
  // replacing it would shred ordinary error text.
  const secrets = [...new Set([...raw, ...raw.map(safeDecode)])]
    .filter((s) => s.length >= 3)
    .sort((a, b) => b.length - a.length);
  return { via: `${u.protocol}//${u.host}`, secrets, valid: true };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// https.request only writes strings and Buffers. The contract (§3) sends a
// JS object as JSON and leaves string/Buffer bodies alone; a caller's
// content-type is kept whatever its case.
function encodeBody(body, headers) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) {
    headers["content-length"] = body.length;
    return body;
  }
  if (typeof body === "string") {
    const buf = Buffer.from(body, "utf8");
    headers["content-length"] = buf.length;
    return buf;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  headers["content-length"] = buf.length;
  return buf;
}

function createTransport({
  proxyUrl = process.env.CHZZK_PROXY_URL || process.env.SOOP_PROXY_URL || "",
  direct = process.env.CHZZK_DIRECT === "1",
  agentFactory = defaultAgentFactory,
  request = https.request,
} = {}) {
  const proxied = Boolean(proxyUrl);
  let via;
  let secrets = [];
  let valid = true;
  if (proxied) {
    const parsed = readProxy(String(proxyUrl));
    via = parsed.via;
    secrets = parsed.secrets;
    valid = parsed.valid;
  } else if (direct) {
    via = "direct";
  } else {
    via = "none";
    valid = false;
  }
  // Error text can end up in logs and on the admin page; a proxy library that
  // echoes its URL must never carry the credentials there.
  const scrub = (text) =>
    secrets.reduce((t, s) => t.split(s).join("***"), String(text));

  let agent = null;
  let notReadyMessage = "";
  if (proxied) {
    try {
      agent = agentFactory(proxyUrl) || null;
      if (!agent) notReadyMessage = "agent factory returned nothing";
    } catch (err) {
      // Libraries complaining about a malformed URL tend to quote parts of it.
      notReadyMessage = valid
        ? scrub((err && err.message) || err)
        : "not a valid proxy URL";
    }
    if (!agent) {
      console.error(
        `[chzzk] proxy ${via} is configured but no agent could be built (${notReadyMessage}); CHZZK calls are refused, not sent direct`,
      );
      notReadyMessage = `CHZZK proxy ${via} is not usable: ${notReadyMessage}`;
    }
  } else if (!direct) {
    notReadyMessage =
      "No egress configured: set CHZZK_PROXY_URL (or CHZZK_DIRECT=1 for local tests)";
  }
  const ready = proxied ? Boolean(agent) : direct;

  const counters = {
    requests: 0,
    failures: 0,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  const notReady = () =>
    new ChzzkError(notReadyMessage, { code: "EGRESS" });

  function fail(err) {
    counters.failures += 1;
    counters.lastErrorAt = Date.now();
    counters.lastError = `${err.code}: ${err.message}`.slice(0, 300);
    return err;
  }

  function doRequest(
    url,
    { method = "GET", headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
  ) {
    counters.requests += 1;
    if (!ready) return Promise.reject(fail(notReady()));

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let req = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(fail(err));
        else {
          counters.lastOkAt = Date.now();
          resolve(value);
        }
      };
      const egress = (err) =>
        finish(
          new ChzzkError(
            `${url} -> ${scrub((err && (err.message || err.code)) || "network error")}`,
            { code: "EGRESS", cause: err },
          ),
        );

      try {
        const u = new URL(url);
        const out = {};
        for (const [k, v] of Object.entries(headers || {})) {
          if (v != null) out[k.toLowerCase()] = v;
        }
        const payload = encodeBody(body, out);
        const options = {
          host: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          headers: out,
        };
        if (proxied) options.agent = agent;

        req = request(options, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("error", egress);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                // Non-JSON is not a transport failure; client.js may still
                // care about the status and the raw text (e.g. a 502 page).
              }
            }
            // headers: client.js reads `set-cookie` from them, so a cookie
            // Naver renews (NID_SES on getUserStatus) is kept, not dropped.
            finish(null, { status: res.statusCode, json, text, headers: res.headers || {} });
          });
        });
        req.on("error", egress);
        // One budget for the whole exchange (connect, send, full body), not a
        // per-socket idle timer: a tunnel that trickles bytes must still end.
        timer = setTimeout(() => {
          finish(
            new ChzzkError(`${url} -> timeout after ${timeoutMs} ms`, {
              code: "TIMEOUT",
            }),
          );
          req.destroy();
        }, timeoutMs);
        if (payload && payload.length) req.write(payload);
        req.end();
      } catch (err) {
        // A bad URL or a header Node refuses to send: nothing left the machine.
        if (req) req.destroy();
        finish(
          new ChzzkError(
            `${url} -> request could not be sent: ${scrub((err && err.message) || err)}`,
            { code: "HTTP", cause: err },
          ),
        );
      }
    });
  }

  return {
    proxied,
    ready,
    describe: () => via,
    request: doRequest,
    stats: () => ({ ...counters }),
  };
}

let shared = null;
function getTransport() {
  if (!shared) shared = createTransport();
  return shared;
}

module.exports = { createTransport, getTransport };
