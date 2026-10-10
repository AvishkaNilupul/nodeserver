// SOOP transport: one request path for proxied and direct traffic.
//
// SOOP only credits watch time to viewers in supported countries, so in
// production every call leaves through a SOCKS5 egress (SOOP_PROXY_URL, an
// `ssh -D` tunnel to a host in a supported country). v1 sent direct calls with
// fetch() and proxied ones with https.request, so the two paths carried
// different headers, and it fell back to a direct connection when the proxy
// agent could not be built — which would have sent every account from the US
// server IP. This module always uses https.request and FAILS CLOSED: a proxy
// that is configured but unusable rejects every call rather than going direct.
const https = require("https");
const { SoopError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 20000;

function defaultAgentFactory(proxyUrl) {
  // Required lazily: this package must never be able to stop the app booting.
  const { SocksProxyAgent } = require("socks-proxy-agent");
  return new SocksProxyAgent(proxyUrl);
}

// What may be shown of a proxy URL (never its user:pass) and what must be
// scrubbed from any text that could echo it. A string that does not parse into
// scheme + host is shown as a bare "proxy" and scrubbed whole: "user:pass@host"
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
  // Both spellings (percent-encoded and plain); nothing so short that replacing
  // it would shred ordinary error text.
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

// https.request only writes strings and Buffers; a URLSearchParams body is
// flattened and given the content-type fetch() would have set for it.
function encodeBody(body, headers) {
  if (body == null) return null;
  let buf;
  if (Buffer.isBuffer(body)) {
    buf = body;
  } else {
    if (body instanceof URLSearchParams && !headers["content-type"]) {
      headers["content-type"] =
        "application/x-www-form-urlencoded;charset=UTF-8";
    }
    buf = Buffer.from(String(body), "utf8");
  }
  headers["content-length"] = buf.length;
  return buf;
}

function createTransport({
  proxyUrl = process.env.SOOP_PROXY_URL || "",
  agentFactory = defaultAgentFactory,
} = {}) {
  const proxied = Boolean(proxyUrl);
  const { via, secrets, valid } = proxied
    ? readProxy(String(proxyUrl))
    : { via: "direct", secrets: [], valid: true };
  // Error text can end up in logs and on the admin page; a proxy library that
  // echoes its URL must not carry the credentials there.
  const scrub = (text) =>
    secrets.reduce((t, s) => t.split(s).join("***"), String(text));

  let agent = null;
  let buildError = "";
  if (proxied) {
    try {
      agent = agentFactory(proxyUrl) || null;
      if (!agent) buildError = "agent factory returned nothing";
    } catch (err) {
      // A library complaining about a malformed URL tends to quote parts of it.
      buildError = valid
        ? scrub((err && err.message) || err)
        : "not a valid proxy URL";
    }
    if (!agent) {
      console.error(
        `[soop] proxy ${via} is configured but no agent could be built (${buildError}); SOOP calls are refused, not sent direct`,
      );
    }
  }
  const ready = !proxied || Boolean(agent);

  const counters = {
    requests: 0,
    failures: 0,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  const notReady = () =>
    new SoopError(`SOOP proxy ${via} is not usable: ${buildError}`, {
      code: "EGRESS",
    });

  function fail(err) {
    counters.failures += 1;
    counters.lastErrorAt = Date.now();
    counters.lastError = `${err.code}: ${err.message}`.slice(0, 300);
    return err;
  }

  function requestJson(
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
          new SoopError(
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

        // Called through the module object so tests can stub https.request.
        req = https.request(options, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("error", egress);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              finish(null, JSON.parse(text));
            } catch (err) {
              finish(
                new SoopError(
                  `${url} -> HTTP ${res.statusCode}: ${text.slice(0, 160)}`,
                  { code: "HTTP", cause: err },
                ),
              );
            }
          });
        });
        req.on("error", egress);
        // One budget for the whole exchange (connect, send, full body), not a
        // per-socket idle timer: a tunnel that trickles bytes must still end.
        timer = setTimeout(() => {
          finish(
            new SoopError(`${url} -> timeout after ${timeoutMs} ms`, {
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
          new SoopError(
            `${url} -> request could not be sent: ${scrub((err && err.message) || err)}`,
            { code: "HTTP", cause: err },
          ),
        );
      }
    });
  }

  function wsOptions() {
    if (!ready) throw notReady();
    return proxied ? { agent } : {};
  }

  return {
    proxied,
    ready,
    describe: () => via,
    requestJson,
    wsOptions,
    stats: () => ({ ...counters }),
  };
}

let shared = null;
function getTransport() {
  if (!shared) shared = createTransport();
  return shared;
}

module.exports = { createTransport, getTransport };
