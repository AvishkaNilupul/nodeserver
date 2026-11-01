// Which egress a SOOP login leaves through.
//
// SOOP_PROXY_URL is the farm's egress. SOOP_PROXY_ALT_URL together with
// SOOP_PROXY_ALT_LOGINS moves the named logins to a second egress — a canary:
// a few logins try a new tunnel for some days before it replaces the first.
// The alternate gets its own transport (same fail-closed rules: if that tunnel
// is down, those logins stop; they never fall back to the main egress or go
// direct) and its own geo resolver, because the country belongs to the egress.
const { createTransport } = require("./http");
const { createGeoResolver } = require("./geo");

// "a, b\nc" -> Set {"a","b","c"}. SOOP login ids are case-insensitive.
function parseLogins(text) {
  return new Set(
    String(text || "")
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function createEgressRouter({
  env = process.env,
  transportFactory = createTransport,
  geoFactory = createGeoResolver,
} = {}) {
  const url = String(env.SOOP_PROXY_ALT_URL || "").trim();
  const logins = url ? parseLogins(env.SOOP_PROXY_ALT_LOGINS) : new Set();
  let alt = null; // built on first use, then shared by every alternate login
  const altParts = () => {
    if (!alt) alt = { transport: transportFactory({ proxyUrl: url }), geo: geoFactory({ env }) };
    return alt;
  };

  return {
    // Extra makeClient() options for this login; {} keeps the farm's egress.
    optionsFor(id) {
      if (!logins.size || id == null) return {};
      return logins.has(String(id).trim().toLowerCase()) ? altParts() : {};
    },
    // For the status page: null when no login is moved.
    describe() {
      if (!logins.size) return null;
      const { transport, geo } = altParts();
      const g = geo.peek();
      return {
        via: transport.describe(),
        ready: transport.ready,
        country: (g && g.cc) || null,
        logins: [...logins],
        stats: transport.stats(),
      };
    },
  };
}

module.exports = { createEgressRouter, parseLogins };
