/* global fetch */
// Route-level tests for GET /drops-archive/account-token — the username ->
// client-token lookup behind the Twitch inventory checker's "Look up & check"
// box. Run against mongodb-memory-server with a hand-seeded superadmin session.
//
// What these exist to prevent:
//
//  1. AN OPEN TOKEN TAP. The endpoint hands back a live Twitch auth token, so
//     an anonymous or merely-admin caller must be refused. A token is the
//     account: whoever holds it can claim, connect and drain its drops.
//  2. A CREDENTIAL LEAK. The lookup deliberately asks accountLookup for NO
//     credentials. The assertion is on the SERIALISED body, so a future field
//     addition that spreads a source row wholesale trips it, the way a
//     field-by-field check would not.
//  3. AN EPIC TOKEN OFFERED TO TWITCH. EpicAccount rows match on displayName
//     and carry an Epic *refresh* token. Handing one to this page would send
//     it to Twitch's GQL, which can only reject it — so an Epic-only match
//     must read as "not found" here, not as a token.
//  4. A SILENT WRONG ANSWER. One login can exist in several collections with
//     DIFFERENT tokens (a pool secret rotated after the account was deployed).
//     The bot row wins, and the other tokens still have to come back as
//     options, or a dead token leaves the operator stuck.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "inventory-token-lookup-test-secret";
process.env.CRED_SECRET ||= "inventory-token-lookup-test-cred";

const { encrypt } = require("../utils/secretBox");
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const EpicAccount = require("../models/EpicAccount");
const dropArchiveRoutes = require("../routes/dropArchiveRoutes");

// Distinctive enough that a substring search over the whole body is a real
// leak test and not a coincidence.
const LEAK = {
  password: "Pw-SENTINEL-4tz8",
  email: "sentinel-2qm5@leak.test",
};

let mongod;
let server;
let baseUrl;
let cookie; // superadmin
let plainCookie; // authenticated, but role !== "superadmin"

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("inventory-token-lookup-test"));

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/session", (req, res) => {
    req.session.admin = {
      id: "root",
      username: "root",
      role: "superadmin",
      tfa: true,
    };
    res.json({ success: true });
  });
  app.get("/test/session-plain", (req, res) => {
    req.session.admin = { id: "helper", username: "helper", role: "admin" };
    res.json({ success: true });
  });
  app.use(dropArchiveRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  cookie = (await fetch(baseUrl + "/test/session")).headers
    .get("set-cookie")
    .split(";")[0];
  plainCookie = (await fetch(baseUrl + "/test/session-plain")).headers
    .get("set-cookie")
    .split(";")[0];

  // FarmGuy lives in two places with two different tokens — the case the
  // `options` list exists for.
  await BotAccount.create({
    clientSecret: "cs-bot-farmguy",
    login: "FarmGuy",
    host: "contabo",
    container: "twitchbotx2",
    configFile: "config_02.json",
    credPassword: encrypt(LEAK.password),
    credEmail: encrypt(LEAK.email),
  });
  await AvailableAccount.create({
    username: "farmguy",
    usernameLower: "farmguy",
    clientSecret: "cs-pool-farmguy-stale",
    password: encrypt(LEAK.password),
    email: encrypt(LEAK.email),
  });
  await AvailableAccount.create({
    username: "FarmGirl",
    usernameLower: "farmgirl",
    clientSecret: "cs-pool-farmgirl",
  });
  // A no-claim ledger row with no pool parent: it exists, but no token can be
  // resolved for it.
  await UnclaimedAccount.create({
    source: "noclaim",
    login: "FarmlessRow",
    loginLower: "farmlessrow",
    game: "Overwatch 2",
  });
  await EpicAccount.create({
    accountId: "epic-acct-1",
    displayName: "EpicDude",
    refreshToken: encrypt("epic-refresh-token-value"),
  });
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // The route fires logEvent without awaiting it (an audit write must never be
  // able to fail a request), so let those writes land before the connection
  // goes away.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function lookup(username, opts = {}) {
  const headers = { Accept: "application/json" };
  if (!opts.noAuth) headers.Cookie = opts.cookie || cookie;
  return fetch(
    baseUrl +
      "/drops-archive/account-token?username=" +
      encodeURIComponent(username),
    { headers },
  );
}

test("refuses anonymous and non-superadmin callers", async () => {
  assert.equal((await lookup("farmguy", { noAuth: true })).status, 401);
  assert.equal((await lookup("farmguy", { cookie: plainCookie })).status, 403);
});

test("requires a username", async () => {
  const res = await fetch(baseUrl + "/drops-archive/account-token", {
    headers: { Accept: "application/json", Cookie: cookie },
  });
  assert.equal(res.status, 400);
});

test("resolves a login case-insensitively and prefers the bot token", async () => {
  const res = await lookup("FARMGUY");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.found, true);
  assert.equal(body.primarySource, "bot");
  assert.equal(body.clientToken, "cs-bot-farmguy");
  assert.equal(body.login, "FarmGuy");

  // Both homes are reported, with enough detail to tell them apart.
  const sources = body.sources.map((s) => s.source).sort();
  assert.deepEqual(sources, ["bot", "pool"]);
  const bot = body.sources.find((s) => s.source === "bot");
  assert.equal(bot.hasToken, true);
  assert.match(bot.detail, /contabo/);

  // The stale pool token is still offered, for when the primary one is dead.
  assert.equal(body.options.length, 2);
  assert.deepEqual(body.options.map((o) => o.clientToken).sort(), [
    "cs-bot-farmguy",
    "cs-pool-farmguy-stale",
  ]);
});

test("never serialises a password or email", async () => {
  const raw = await (await lookup("farmguy")).text();
  assert.ok(!raw.includes(LEAK.password), "password must not be serialised");
  assert.ok(!raw.includes(LEAK.email), "email must not be serialised");
  assert.ok(!raw.includes("credentials"), "no credentials block at all");
});

test("reports a match that has no stored token instead of guessing", async () => {
  const res = await lookup("farmlessrow");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, true);
  assert.equal(body.clientToken, "");
  assert.equal(body.options.length, 0);
  assert.equal(body.sources[0].hasToken, false);
});

test("an Epic-only match is not offered as a Twitch token", async () => {
  const res = await lookup("EpicDude");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.code, "not_found");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("epic-refresh-token-value"));
});

test("a miss comes back with prefix suggestions", async () => {
  const res = await lookup("farmg");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.found, false);
  const logins = body.suggestions.map((s) => s.login).sort();
  assert.deepEqual(logins, ["FarmGirl", "FarmGuy"]);
  // One entry per login, listing every collection it turned up in.
  const guy = body.suggestions.find((s) => s.login === "FarmGuy");
  assert.deepEqual(guy.sources.sort(), ["bot", "pool"]);
  assert.equal(guy.hasToken, true);
  // A suggestion is a name, never a token.
  assert.ok(!JSON.stringify(body).includes("cs-bot-farmguy"));
});

test("a too-short prefix suggests nothing rather than dumping the fleet", async () => {
  const body = await (await lookup("f")).json();
  assert.deepEqual(body.suggestions, []);
});
