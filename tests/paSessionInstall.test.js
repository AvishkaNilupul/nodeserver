// The one-click PlayerAuctions cookie hand-off route.
//
// This is a token-gated credential-install endpoint that sits OUTSIDE the admin
// session / 2fa cascade, so its access rules are the whole point of the test:
//   * off (404) until a secret is configured,
//   * 404 (not 401/403) on a wrong secret, so it never confirms its own
//     existence or the secret length to a prober,
//   * a junk paste is refused before it can overwrite a working session,
//   * the happy path stores the cookie and reports the new expiry.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

const mp = require("../utils/marketplaces");
const settings = require("../utils/settings");
const systemLog = require("../utils/systemLog");
const router = require("../routes/paSessionInstallRoutes");

const GOOD_COOKIE =
  "Production_access_token=aaa.bbb.ccc; Production_refresh_token=ddd.eee.fff; sid=xyz";

// A real signed-in server behind the router, driven over HTTP so the actual
// middleware chain (rate limiter, JSON body parser, the route) runs.
function serve() {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(router);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: "http://127.0.0.1:" + port });
    });
  });
}

function stub({ secret }) {
  const orig = {
    load: settings.loadSettings,
    setKeys: mp.setKeys,
    test: mp.playerauctionsTest,
    exp: mp.playerauctionsTokenExpiry,
    log: systemLog.logEvent,
  };
  const installed = { cookie: null };
  settings.loadSettings = () => ({ playerauctionsInstallSecret: secret });
  mp.setKeys = async (_m, v) => {
    installed.cookie = v.cookie;
  };
  mp.playerauctionsTest = async () => ({ ok: true, detail: "Connected as avishkarex2 (seller)" });
  mp.playerauctionsTokenExpiry = () => ({
    access: new Date(Date.now() + 30 * 60000),
    refresh: new Date(Date.now() + 24 * 3600000),
  });
  systemLog.logEvent = () => {}; // no DB in unit tests
  const restore = () =>
    Object.assign(mp, { setKeys: orig.setKeys, playerauctionsTest: orig.test, playerauctionsTokenExpiry: orig.exp }) &&
    Object.assign(settings, { loadSettings: orig.load }) &&
    Object.assign(systemLog, { logEvent: orig.log });
  return { installed, restore };
}

async function post(base, { secret, body }) {
  const headers = { "content-type": "application/json" };
  if (secret != null) headers["x-pa-install-secret"] = secret;
  const r = await fetch(base + "/playerauctions/session/install", {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* 404/204 have no body */
  }
  return { status: r.status, json };
}

test("route is 404 (off) when no secret is configured", async () => {
  const { server, base } = await serve();
  const s = stub({ secret: "" });
  try {
    const r = await post(base, { secret: "anything", body: { cookie: GOOD_COOKIE } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(s.installed.cookie, null, "nothing is installed");
  } finally {
    s.restore();
    server.close();
  }
});

test("a wrong secret is 404, not 401 — the route never confirms itself", async () => {
  const { server, base } = await serve();
  const s = stub({ secret: "the-real-long-secret-value" });
  try {
    const r = await post(base, { secret: "wrong", body: { cookie: GOOD_COOKIE } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(s.installed.cookie, null);
  } finally {
    s.restore();
    server.close();
  }
});

test("a junk paste is refused before it can overwrite a working session", async () => {
  const { server, base } = await serve();
  const s = stub({ secret: "secret123" });
  try {
    const r = await post(base, { secret: "secret123", body: { cookie: "hello world not a cookie" } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.message, /PlayerAuctions cookie/i);
    assert.strictEqual(s.installed.cookie, null, "the bad cookie is not stored");
  } finally {
    s.restore();
    server.close();
  }
});

test("the happy path stores the cookie and reports the new expiry", async () => {
  const { server, base } = await serve();
  const s = stub({ secret: "secret123" });
  try {
    const r = await post(base, { secret: "secret123", body: { cookie: GOOD_COOKIE } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.match(r.json.detail, /Connected as/);
    assert.ok(r.json.refreshExpiry, "returns when the session next expires");
    assert.strictEqual(s.installed.cookie, GOOD_COOKIE, "the cookie is installed verbatim");
  } finally {
    s.restore();
    server.close();
  }
});
