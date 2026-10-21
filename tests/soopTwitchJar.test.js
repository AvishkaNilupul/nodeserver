// utils/soop/twitchJar.js — the pure helpers that turn a harvested Twitch jar
// into what is stored, and the link rules. The DB writers (saveJar/linkJar)
// are exercised through the route in tests/soopRoutes.test.js; here we pin the
// parsing that decides which login a jar is for and which cookies are kept.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CRED_SECRET ||= "soop-twitchjar-test-cred";
const { twitchCookies, loginOf, describe, daysLeft, LOGIN_RE } = require("../utils/soop/twitchJar");

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

test("twitchCookies keeps twitch.tv cookies and drops everything else", () => {
  const list = [
    { domain: ".twitch.tv", name: "auth-token", value: "a" },
    { domain: "twitch.tv", name: "login", value: "x" },
    { domain: ".sooplive.com", name: "AuthTicket", value: "nope" },
    { domain: ".nottwitch.tv.evil.com", name: "login", value: "nope" },
    { domain: ".twitch.tv", name: "no-value" }, // value null -> dropped
    null,
    "garbage",
  ];
  const kept = twitchCookies(list);
  assert.deepEqual(kept.map((c) => c.name), ["auth-token", "login"]);
  assert.deepEqual(twitchCookies(null), []);
  assert.deepEqual(twitchCookies("x"), []);
});

test("loginOf reads the login cookie and validates the name", () => {
  assert.equal(loginOf([{ name: "login", value: "GamerOne" }]), "gamerone");
  assert.equal(loginOf([{ name: "login", value: "  Spaced_42 " }]), "spaced_42");
  assert.equal(loginOf([{ name: "other", value: "x" }]), "");
  assert.equal(loginOf([{ name: "login", value: "" }]), "");
  assert.equal(loginOf([{ name: "login", value: "has spaces" }]), "");
  assert.equal(loginOf([{ name: "login", value: "a".repeat(40) }]), "");
  assert.equal(loginOf([]), "");
});

test("describe summarises a jar without leaking values", () => {
  const full = describe([
    { name: "auth-token", value: "secret", expirationDate: now + 30 * DAY },
    { name: "persistent", value: "secret2", expirationDate: now + 300 * DAY },
    { name: "login", value: "x" },
  ]);
  assert.equal(full.cookieCount, 3);
  assert.equal(full.hasAuthToken, true);
  assert.equal(full.shortLived, false);
  assert.ok(full.persistentExpiresAt instanceof Date);
  assert.equal(daysLeft(full.persistentExpiresAt) > 299, true);
  assert.equal(JSON.stringify(full).includes("secret"), false);

  const thin = describe([{ name: "auth-token", value: "x" }]);
  assert.equal(thin.hasAuthToken, true);
  assert.equal(thin.shortLived, true, "no persistent cookie = short-lived");
  assert.equal(thin.persistentExpiresAt, null);

  const none = describe([{ name: "login", value: "x" }]);
  assert.equal(none.hasAuthToken, false);
});

test("daysLeft is null for a missing date", () => {
  assert.equal(daysLeft(null), null);
  assert.equal(typeof daysLeft(new Date(Date.now() + DAY * 1000)), "number");
});

test("LOGIN_RE matches real logins and rejects junk", () => {
  for (const ok of ["ab", "gamerone", "spaced_42", "a1_b2_c3"]) assert.ok(LOGIN_RE.test(ok), ok);
  for (const no of ["a", "has space", "bad-dash", "t, $ne", "x".repeat(26)]) assert.ok(!LOGIN_RE.test(no), no);
});
