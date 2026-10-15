// Unit tests for utils/twitchOauthRefresher.js. No network — SOCKS5 is tested
// against a tiny in-process server that speaks just enough of RFC 1928, and
// refreshSoopCookies is driven with an injected transport that returns
// scripted responses in order.
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const {
  CookieJar,
  refreshSoopCookies,
  seedJarFromExport,
  dedupeSoopCookies,
  socks5Connect,
} = require("../utils/twitchOauthRefresher");

// ---- CookieJar -------------------------------------------------------------

test("CookieJar ingest + header roundtrip (host, path, secure, expires)", () => {
  const jar = new CookieJar();
  jar.ingest("https://a.sooplive.com/", [
    "AuthTicket=abc; Domain=.sooplive.com; Path=/; Secure; HttpOnly",
    "UserTicket=uid%3Dtrevornw82; Domain=sooplive.com; Path=/",
    "junk=1; Domain=other.com; Path=/",
  ]);
  const sent = jar.header("https://login.sooplive.com/afreeca/connect.php");
  assert.match(sent, /AuthTicket=abc/);
  assert.match(sent, /UserTicket=uid%3Dtrevornw82/);
  assert.doesNotMatch(sent, /junk=1/, "cookie from a different domain must not be sent");

  // Secure cookies never go out over http
  assert.doesNotMatch(jar.header("http://a.sooplive.com/"), /AuthTicket/);
});

test("CookieJar replaces by name+domain+path and drops already-expired", () => {
  const jar = new CookieJar();
  jar.ingest("https://x.twitch.tv/", "auth-token=OLD; Domain=.twitch.tv; Path=/");
  jar.ingest("https://x.twitch.tv/", "auth-token=NEW; Domain=.twitch.tv; Path=/");
  assert.match(jar.header("https://x.twitch.tv/"), /auth-token=NEW/);
  assert.doesNotMatch(jar.header("https://x.twitch.tv/"), /auth-token=OLD/);

  const past = new Date(Date.now() - 60_000).toUTCString();
  jar.ingest("https://x.twitch.tv/", `tomb=1; Expires=${past}; Domain=.twitch.tv; Path=/`);
  assert.doesNotMatch(jar.header("https://x.twitch.tv/"), /tomb=1/);
});

test("seedJarFromExport skips expired entries and keeps domain exactly", () => {
  const jar = new CookieJar();
  seedJarFromExport(jar, [
    { name: "fresh", value: "1", domain: ".twitch.tv", expirationDate: Math.floor(Date.now() / 1000) + 3600 },
    { name: "stale", value: "x", domain: ".twitch.tv", expirationDate: Math.floor(Date.now() / 1000) - 10 },
    { name: "session", value: "y", domain: "passport.twitch.tv" }, // no expiry
  ]);
  const sent = jar.header("https://passport.twitch.tv/");
  assert.match(sent, /fresh=1/);
  assert.match(sent, /session=y/);
  assert.doesNotMatch(sent, /stale=/);
});

test("exportMatching builds cookie-editor shape with the right domain prefix", () => {
  const jar = new CookieJar();
  jar.ingest("https://x.sooplive.com/", [
    "AuthTicket=abc; Domain=.sooplive.com; Path=/; Secure",
    "sess=1; Path=/", // hostOnly cookie on x.sooplive.com
  ]);
  const out = jar.exportMatching(/sooplive\.com/).sort((a, b) => a.name.localeCompare(b.name));
  const auth = out.find((c) => c.name === "AuthTicket");
  const sess = out.find((c) => c.name === "sess");
  assert.strictEqual(auth.domain, ".sooplive.com", "Domain= cookie must get a leading dot");
  assert.strictEqual(auth.hostOnly, false);
  assert.strictEqual(auth.secure, true);
  assert.strictEqual(sess.domain, "x.sooplive.com", "hostOnly cookie keeps its origin host");
  assert.strictEqual(sess.hostOnly, true);
});

// ---- dedupeSoopCookies -----------------------------------------------------

test("dedupeSoopCookies keeps the broader (non-hostOnly) copy per name", () => {
  const broad = { name: "AuthTicket", value: "A", path: "/", hostOnly: false, expirationDate: 1 };
  const narrow = { name: "AuthTicket", value: "B", path: "/", hostOnly: true, expirationDate: 999 };
  const out = dedupeSoopCookies([narrow, broad]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].value, "A", "non-hostOnly wins even when hostOnly expires later");
});

test("dedupeSoopCookies prefers the later-expiring copy when both are the same scope", () => {
  const older = { name: "x", value: "old", path: "/", hostOnly: false, expirationDate: 100 };
  const newer = { name: "x", value: "new", path: "/", hostOnly: false, expirationDate: 200 };
  const out = dedupeSoopCookies([older, newer]);
  assert.strictEqual(out[0].value, "new");
});

// ---- refreshSoopCookies with scripted transport ---------------------------

function makeTransport(script) {
  const calls = [];
  async function transport({ method, targetUrl, headers }) {
    calls.push({ method, targetUrl, headers });
    const next = script.shift();
    if (!next) throw new Error("transport script exhausted at " + targetUrl);
    if (typeof next === "function") return await next({ method, targetUrl, headers });
    return next;
  }
  transport.calls = calls;
  return transport;
}

test("refreshSoopCookies: happy path mints AuthTicket + UserTicket and matches identity", async () => {
  const soopId = "trevornw82";
  const transport = makeTransport([
    // 1. SOOP connect.php → 302 Twitch authorize
    {
      status: 302,
      headers: { location: "https://id.twitch.tv/oauth2/authorize?..." },
      body: "",
    },
    // 2. Twitch authorize → 302 back to SOOP callback
    {
      status: 302,
      headers: { location: "https://login.sooplive.com/afreeca/callback?code=xyz" },
      body: "",
    },
    // 3. SOOP callback → 302 to home, dropping the tickets
    {
      status: 302,
      headers: {
        location: "https://www.sooplive.com/",
        "set-cookie": [
          `AuthTicket=live; Domain=.sooplive.com; Path=/; Secure`,
          `UserTicket=uid%3D${soopId}; Domain=.sooplive.com; Path=/`,
        ],
      },
      body: "",
    },
    // 4. SOOP home — 200
    { status: 200, headers: {}, body: "<html></html>" },
    // 5. Trailing SOOP home hit (best-effort)
    { status: 200, headers: {}, body: "<html></html>" },
  ]);
  const r = await refreshSoopCookies({
    soopId,
    twitchCookies: [
      { name: "auth-token", value: "T", domain: ".twitch.tv", expirationDate: Math.floor(Date.now() / 1000) + 86400 },
      { name: "persistent", value: "P", domain: ".twitch.tv", expirationDate: Math.floor(Date.now() / 1000) + 86400 },
    ],
    transport,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.identity, soopId);
  const names = r.cookies.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ["AuthTicket", "UserTicket"]);
});

test("refreshSoopCookies: Twitch session expired bounces to twitch.tv/login", async () => {
  const transport = makeTransport([
    { status: 302, headers: { location: "https://id.twitch.tv/oauth2/authorize?..." }, body: "" },
    { status: 302, headers: { location: "https://www.twitch.tv/login?redirect=1" }, body: "" },
    { status: 200, headers: {}, body: "login page" },
  ]);
  const r = await refreshSoopCookies({
    soopId: "x",
    twitchCookies: [{ name: "auth-token", value: "T", domain: ".twitch.tv" }],
    transport,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "twitch_session_expired");
});

test("refreshSoopCookies: missing tickets is reported with the names it got", async () => {
  const transport = makeTransport([
    {
      status: 200,
      headers: {
        "set-cookie": ["Random=1; Domain=.sooplive.com; Path=/"], // no tickets
      },
      body: "",
    },
    { status: 200, headers: {}, body: "" }, // trailing home hit
  ]);
  const r = await refreshSoopCookies({
    soopId: "x",
    twitchCookies: [{ name: "auth-token", value: "T", domain: ".twitch.tv" }],
    transport,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "missing_tickets");
  assert.strictEqual(r.hasAuthTicket, false);
  assert.strictEqual(r.hasUserTicket, false);
  assert.ok(Array.isArray(r.cookieNames));
});

test("refreshSoopCookies: identity mismatch (stale Twitch session minted the wrong SOOP uid)", async () => {
  const transport = makeTransport([
    {
      status: 200,
      headers: {
        "set-cookie": [
          "AuthTicket=A; Domain=.sooplive.com; Path=/",
          "UserTicket=uid%3DsomeoneElse; Domain=.sooplive.com; Path=/",
        ],
      },
      body: "",
    },
    { status: 200, headers: {}, body: "" },
  ]);
  const r = await refreshSoopCookies({
    soopId: "trevornw82",
    twitchCookies: [{ name: "auth-token", value: "T", domain: ".twitch.tv" }],
    transport,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "identity_mismatch");
  assert.strictEqual(r.expected, "trevornw82");
  assert.strictEqual(r.actual, "someoneElse");
});

test("refreshSoopCookies: bad args are rejected without calling transport", async () => {
  const transport = makeTransport([]);
  const a = await refreshSoopCookies({ twitchCookies: [{ name: "x", value: "1", domain: ".twitch.tv" }], transport });
  assert.strictEqual(a.reason, "bad_args");
  const b = await refreshSoopCookies({ soopId: "x", twitchCookies: [], transport });
  assert.strictEqual(b.reason, "bad_args");
  assert.strictEqual(transport.calls.length, 0);
});

// ---- SOCKS5 CONNECT handshake ---------------------------------------------

// Minimal fake SOCKS5 server that accepts the greeting and the CONNECT request
// and replies with a success. Returns the port it bound to.
function fakeSocksServer({ failGreet = false, failConnect = false, host, port } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let phase = "greet";
      sock.on("data", (data) => {
        if (phase === "greet") {
          // VER=5 NMETHODS=1 METHOD=0
          if (data[0] !== 5 || data[1] !== 1 || data[2] !== 0) return sock.destroy();
          if (failGreet) {
            sock.write(Buffer.from([0x05, 0xff]));
            return sock.destroy();
          }
          sock.write(Buffer.from([0x05, 0x00]));
          phase = "connect";
          return;
        }
        if (phase === "connect") {
          // VER=5 CMD=1 RSV=0 ATYP=3 LEN host port(2)
          if (data[0] !== 5 || data[1] !== 1 || data[3] !== 0x03) return sock.destroy();
          const hostLen = data[4];
          const gotHost = data.slice(5, 5 + hostLen).toString();
          const gotPort = (data[5 + hostLen] << 8) | data[6 + hostLen];
          server._observed = { host: gotHost, port: gotPort };
          if (failConnect) {
            sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // connection refused
            return sock.destroy();
          }
          // Success + bogus bound address 0.0.0.0:0
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          phase = "tunnel";
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, address: server.address() });
    });
    server.on("error", reject);
  });
}

test("socks5Connect: happy handshake returns the tunneled socket", async () => {
  const { server, address } = await fakeSocksServer();
  const prev = { host: process.env.SOOP_SOCKS_HOST, port: process.env.SOOP_SOCKS_PORT };
  process.env.SOOP_SOCKS_HOST = "127.0.0.1";
  process.env.SOOP_SOCKS_PORT = String(address.port);
  // Reload module so the new env is picked up
  delete require.cache[require.resolve("../utils/twitchOauthRefresher")];
  const { socks5Connect: freshConnect } = require("../utils/twitchOauthRefresher");
  try {
    const sock = await freshConnect("example.sooplive.com", 443);
    assert.ok(sock, "socket resolved");
    assert.deepStrictEqual(server._observed, { host: "example.sooplive.com", port: 443 });
    sock.destroy();
  } finally {
    server.close();
    if (prev.host) process.env.SOOP_SOCKS_HOST = prev.host;
    else delete process.env.SOOP_SOCKS_HOST;
    if (prev.port) process.env.SOOP_SOCKS_PORT = prev.port;
    else delete process.env.SOOP_SOCKS_PORT;
  }
});

test("socks5Connect: greeting refusal is reported with the method byte", async () => {
  const { server, address } = await fakeSocksServer({ failGreet: true });
  const prev = { host: process.env.SOOP_SOCKS_HOST, port: process.env.SOOP_SOCKS_PORT };
  process.env.SOOP_SOCKS_HOST = "127.0.0.1";
  process.env.SOOP_SOCKS_PORT = String(address.port);
  delete require.cache[require.resolve("../utils/twitchOauthRefresher")];
  const { socks5Connect: freshConnect } = require("../utils/twitchOauthRefresher");
  try {
    await assert.rejects(() => freshConnect("x", 443), /socks5 greeting rejected/);
  } finally {
    server.close();
    if (prev.host) process.env.SOOP_SOCKS_HOST = prev.host;
    else delete process.env.SOOP_SOCKS_HOST;
    if (prev.port) process.env.SOOP_SOCKS_PORT = prev.port;
    else delete process.env.SOOP_SOCKS_PORT;
  }
});

test("socks5Connect: CONNECT refusal surfaces the rep code", async () => {
  const { server, address } = await fakeSocksServer({ failConnect: true });
  const prev = { host: process.env.SOOP_SOCKS_HOST, port: process.env.SOOP_SOCKS_PORT };
  process.env.SOOP_SOCKS_HOST = "127.0.0.1";
  process.env.SOOP_SOCKS_PORT = String(address.port);
  delete require.cache[require.resolve("../utils/twitchOauthRefresher")];
  const { socks5Connect: freshConnect } = require("../utils/twitchOauthRefresher");
  try {
    await assert.rejects(() => freshConnect("x", 443), /socks5 CONNECT refused \(rep=5\)/);
  } finally {
    server.close();
    if (prev.host) process.env.SOOP_SOCKS_HOST = prev.host;
    else delete process.env.SOOP_SOCKS_HOST;
    if (prev.port) process.env.SOOP_SOCKS_PORT = prev.port;
    else delete process.env.SOOP_SOCKS_PORT;
  }
});
