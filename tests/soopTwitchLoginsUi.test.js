// public/soop/twitch-logins.js — the pure file parser the dialog uses to turn a
// web-twitch-cookies.json (or a paste of it) into one entry per Twitch login.
// The page script ships as-is and is loaded into a DOM-less context, same as
// tests/soopAccountImport.test.js; only the pure helper is exercised here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "soop", "twitch-logins.js"), "utf8");

function load() {
  const sandbox = {
    Soop: { state: null, el: () => ({ hidden: true, classList: { add() {}, remove() {} }, addEventListener() {} }), ui: { icon: () => ({}), button: () => ({}), progress: () => ({ set() {} }) }, fmt: { num: String, ago: () => "now" }, modal: () => ({ setActions() {}, setTitle() {}, close() {} }) },
    window: { addEventListener() {} },
    document: { body: {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "public/soop/twitch-logins.js" });
  return sandbox.Soop._twitchLogins;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

const cookie = (name, value, extra = {}) => ({ domain: ".twitch.tv", name, value, ...extra });
const jar = (login, { auth = true, persistent = true } = {}) =>
  [
    cookie("login", login),
    auth ? cookie("auth-token", "A-" + login, { expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400 }) : null,
    persistent ? cookie("persistent", "P-" + login, { expirationDate: Math.floor(Date.now() / 1000) + 300 * 86400 }) : null,
    cookie("unique_id", "u"),
  ].filter(Boolean);

test("parses the harvester's object-keyed file", () => {
  const { parseTwitchFile } = load();
  const file = {
    gamerone: { capturedAt: "2026-10-21T01:00:00.000Z", soopId: "carljb353", source: "harvester", cookies: jar("gamerone") },
    gamertwo: { soopId: null, cookies: jar("gamertwo", { persistent: false }) },
  };
  const out = plain(parseTwitchFile(JSON.stringify(file)));
  assert.equal(out.length, 2);
  const one = out.find((e) => e.login === "gamerone");
  assert.equal(one.soopId, "carljb353");
  assert.equal(one.source, "harvester");
  assert.equal(one.cookies.length, 4);
  const two = out.find((e) => e.login === "gamertwo");
  assert.equal(two.soopId, "", "null soopId becomes empty");
});

test("takes the login from the jar's own cookie when the key is not a login", () => {
  const { parseTwitchFile } = load();
  // Array shape, and the key/field missing — fall back to the `login` cookie.
  const out = plain(parseTwitchFile(JSON.stringify([{ cookies: jar("fromcookie") }])));
  assert.deepEqual(out.map((e) => e.login), ["fromcookie"]);
  // A single export object also works.
  assert.deepEqual(plain(parseTwitchFile(JSON.stringify({ cookies: jar("single") }))).map((e) => e.login), ["single"]);
});

test("keeps only twitch.tv cookies and drops entries with none", () => {
  const { parseTwitchFile } = load();
  const file = {
    good: { cookies: [cookie("login", "good"), cookie("auth-token", "x"), { domain: ".sooplive.com", name: "AuthTicket", value: "nope" }] },
    empty: { cookies: [{ domain: ".sooplive.com", name: "AuthTicket", value: "nope" }] },
    nocookies: { soopId: "x" },
  };
  const out = plain(parseTwitchFile(JSON.stringify(file)));
  assert.deepEqual(out.map((e) => e.login), ["good"]);
  assert.deepEqual(out[0].cookies.map((c) => c.name), ["login", "auth-token"]);
});

test("a repeated login collapses to the last entry", () => {
  const { parseTwitchFile } = load();
  const out = plain(parseTwitchFile(JSON.stringify([
    { login: "dup", soopId: "first", cookies: jar("dup") },
    { login: "DUP", soopId: "second", cookies: jar("dup") },
  ])));
  assert.equal(out.length, 1);
  assert.equal(out[0].soopId, "second");
});

test("junk and bad login names yield nothing", () => {
  const { parseTwitchFile } = load();
  assert.deepEqual(plain(parseTwitchFile("not json")), []);
  assert.deepEqual(plain(parseTwitchFile("")), []);
  assert.deepEqual(plain(parseTwitchFile("123")), []);
  assert.deepEqual(plain(parseTwitchFile(JSON.stringify({ "bad login!": { cookies: jar("realname") } }))).map((e) => e.login), ["realname"], "the jar's own login cookie wins over a junk key");
  assert.deepEqual(plain(parseTwitchFile(JSON.stringify([{ login: "has space", cookies: [cookie("x", "y")] }]))), []);
});
