// A PlayerAuctions refresh token past its 24h ceiling is never spent again.
//
// 2026-09-30 14:16Z the stored refresh token reached its hard ceiling (it keeps
// the expiry it was minted with at sign-in; a refresh renews only the 30-minute
// access half). The first refresh after that answered 401. Every later one —
// the 60s fulfiller tick, the session refresher, the session watch, the hourly
// health probe — POSTed the same dead token again, and within minutes
// PlayerAuctions' Cloudflare edge answered 429 "Just a moment..." pages. For 14
// hours the health page said "rate-limited — not measured" instead of "the
// session is dead", and every call taught Cloudflare to distrust the one IP a
// fresh cookie has to work from.
//
// marketplaces.js is loaded with axios and settings faked, so a network call is
// a recorded failure rather than a real request.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

process.env.SESSION_SECRET ||= "pa-session-expiry-test";
process.env.CRED_SECRET ||= "pa-session-expiry-cred";

const calls = [];
let statusReply = 401;
function fakeAxios(cfg) {
  calls.push(String(cfg.method || "GET").toUpperCase() + " " + cfg.url);
  if (/SignIn\/RefreshToken/.test(cfg.url)) {
    const e = new Error("Request failed with status code 401");
    e.response = { status: 401, data: {}, headers: {} };
    return Promise.reject(e);
  }
  if (statusReply !== 200) {
    const e = new Error("Request failed with status code " + statusReply);
    e.response = { status: statusReply, data: {}, headers: {} };
    return Promise.reject(e);
  }
  return Promise.resolve({ data: { isSuccess: true, data: {} }, headers: {} });
}
for (const m of ["get", "post", "put", "patch", "delete"]) {
  fakeAxios[m] = (url, ...rest) => fakeAxios({ method: m, url, ...(rest[rest.length - 1] || {}) });
}
fakeAxios.interceptors = { request: { use() {} }, response: { use() {} } };

let settingsObj = { marketplaces: {} };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]marketplaces\.js$/.test(parent.filename || "")) {
    if (request === "axios") return fakeAxios;
    if (request === "./settings") {
      return {
        loadSettings: () => settingsObj,
        saveSettings: async (s) => {
          settingsObj = s;
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const { encrypt } = require("../utils/secretBox");
const mp = require("../utils/marketplaces");

const jwt = (expMs) =>
  "h." + Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64") + ".s";

function storeCookie({ accessExp, refreshExp }) {
  settingsObj = {
    marketplaces: {
      playerauctions: {
        cookie: encrypt(
          "Production_access_token=" + jwt(accessExp) + "; Production_refresh_token=" + jwt(refreshExp),
        ),
      },
    },
  };
}

test("the lapse rule: past the grace is lapsed; inside it, or unreadable, is not", () => {
  const now = Date.parse("2026-10-01T04:00:00Z");
  assert.ok(mp.paRefreshTokenLapsed(now, new Date("2026-09-30T14:16:42Z")));
  assert.strictEqual(mp.paRefreshTokenLapsed(now, new Date(now - 60 * 1000)), null);
  assert.strictEqual(mp.paRefreshTokenLapsed(now, new Date(now + 3600 * 1000)), null);
  assert.strictEqual(mp.paRefreshTokenLapsed(now, null), null);
  assert.strictEqual(mp.paRefreshTokenLapsed(now, new Date("not a date")), null);
  assert.ok(mp.PA_REFRESH_EXPIRED_GRACE_MS >= 60 * 1000, "a grace for clock skew");
});

test("REGRESSION 2026-10-01: a lapsed refresh token is refused locally, as an HTTP 401, with no call", async () => {
  calls.length = 0;
  const past = Date.now() - 14 * 3600 * 1000;
  storeCookie({ accessExp: past, refreshExp: past });
  await assert.rejects(mp.playerauctionsRefreshSession(), (e) => {
    assert.strictEqual(e.status, 401);
    assert.strictEqual(e.retryable, false);
    assert.strictEqual(e.paSessionExpired, true);
    assert.match(e.message, /\(HTTP 401\): session expired/);
    assert.match(e.message, /paste a fresh PlayerAuctions cookie/);
    return true;
  });
  assert.deepStrictEqual(calls, [], "no request may reach PlayerAuctions for a dead token");
});

test("end to end: the probe the health page runs reads the dead session as a 401, without spending a refresh", async () => {
  calls.length = 0;
  statusReply = 401;
  const past = Date.now() - 14 * 3600 * 1000;
  storeCookie({ accessExp: past, refreshExp: past });
  const r = await mp.playerauctionsTest();
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /HTTP 401/);
  assert.match(r.detail, /session expired/);
  assert.ok(calls.length >= 1 && calls.every((c) => !/RefreshToken/.test(c)), calls.join(" | "));
});

test("a refresh token still inside its 24h is spent exactly as before", async () => {
  calls.length = 0;
  const future = Date.now() + 6 * 3600 * 1000;
  storeCookie({ accessExp: Date.now() - 60 * 1000, refreshExp: future });
  await assert.rejects(mp.playerauctionsRefreshSession(), /HTTP 401/);
  assert.ok(
    calls.some((c) => /POST .*SignIn\/RefreshToken/.test(c)),
    "an unexpired refresh token must still be presented: " + calls.join(" | "),
  );
});
