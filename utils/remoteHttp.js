// HTTP GET that offloads to the Raspberry Pi (the auto-farm host) when it's
// online: the request runs as `curl` on the Pi over SSH, using its idle CPU
// and — usefully — its separate residential IP for marketplace rate limits.
// Falls back to plain axios from the server on any failure, so market
// research never breaks because the Pi is down.
const { URL } = require("node:url");
const axios = require("axios");
const hosts = require("./botHosts");
const settings = require("./settings");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DEFAULT_TIMEOUT = 15000;

// Online-check cache so a research sweep of N games doesn't SSH-probe N times.
const probe = { hostId: null, online: false, at: 0 };
const PROBE_TTL = 60000;

function offloadHost() {
  try {
    const af = settings.getAutoFarm();
    const all = hosts.listHosts();
    const h = af.hostId
      ? all.find((x) => x.id === af.hostId)
      : all.find((x) => x.transport === "ssh");
    return h && h.transport === "ssh" ? hosts.resolveHost(h.id) : null;
  } catch {
    return null;
  }
}

async function piOnline(host) {
  const now = Date.now();
  if (probe.hostId === host.id && now - probe.at < PROBE_TTL) {
    return probe.online;
  }
  probe.hostId = host.id;
  probe.at = now;
  try {
    await hosts.runShell(host, "true", { timeout: 6000 });
    probe.online = true;
  } catch {
    probe.online = false;
  }
  return probe.online;
}

function buildUrl(url, params) {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// GET a URL and return the body text. Tries the Pi first (when online),
// falls back to axios locally. Never throws for "Pi unavailable" — only for
// a request that failed on BOTH paths.
async function fetchText(url, { params, timeout = DEFAULT_TIMEOUT } = {}) {
  const full = buildUrl(url, params);
  const host = offloadHost();
  if (host && (await piOnline(host))) {
    try {
      const cmd =
        "curl -sL --compressed --max-time " +
        Math.ceil(timeout / 1000) +
        " -A " +
        hosts.shq(UA) +
        " " +
        hosts.shq(full);
      const { stdout } = await hosts.runShell(host, cmd, {
        timeout: timeout + 5000,
      });
      if (stdout && stdout.length) return { text: stdout, via: "pi" };
    } catch {
      /* fall through to local */
    }
  }
  const r = await axios.get(full, {
    timeout,
    headers: { "User-Agent": UA },
    responseType: "text",
    transformResponse: [(d) => d],
  });
  return { text: r.data, via: "server" };
}

// GET a URL and parse JSON.
async function fetchJson(url, opts) {
  const { text, via } = await fetchText(url, opts);
  return { data: JSON.parse(text), via };
}

module.exports = { fetchText, fetchJson };
