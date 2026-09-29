/* global fetch */
// POST /account-pool/import with a bulk paste (routes/accountPoolRoutes.js).
//
// The Import modal used to post { accounts: "<paste>" } as JSON, and server.js
// caps express.json at 100kb app-wide — about 180 token-fetcher lines — so a
// bulk paste was refused with a bare "HTTP 413" and nothing was imported. The
// page now posts raw text/plain, which the route reads up to 25mb. These pin:
//   - a paste far past 100kb imports when sent as text/plain (the page's path),
//     through an app that mounts express.json the way server.js does;
//   - a small JSON body still imports, for any other caller;
//   - a paste past the per-import account cap is refused before a row is
//     written;
//   - the session check runs before the big body is read.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "account-pool-import-test-secret";
process.env.CRED_SECRET ||= "account-pool-import-test-cred";

const { decrypt } = require("../utils/secretBox");
const AvailableAccount = require("../models/AvailableAccount");
const accountPoolChecker = require("../utils/accountPoolChecker");

// An imported account with a token is queued for a live Twitch check. Record
// the ids instead, so this never calls Twitch.
const enqueued = [];
accountPoolChecker.enqueue = (ids) => {
  for (const id of ids) enqueued.push(String(id));
  return ids.length;
};
const accountPoolRoutes = require("../routes/accountPoolRoutes");

let mongod;
let server;
let baseUrl;
let cookie;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("account-pool-import-test"));
  await AvailableAccount.init();

  const app = express();
  // Keeps Express's default handler from printing the expected JSON 413.
  app.set("env", "test");
  // Same cap as server.js, so the JSON 413 below is the real one.
  app.use(express.json({ limit: "100kb" }));
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
  app.use(accountPoolRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  cookie = (await fetch(baseUrl + "/test/session")).headers
    .get("set-cookie")
    .split(";")[0];
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await AvailableAccount.deleteMany({});
  enqueued.length = 0;
});

function post(body, contentType, opts = {}) {
  const headers = { Accept: "application/json", "Content-Type": contentType };
  if (!opts.noAuth) headers.Cookie = cookie;
  return fetch(baseUrl + "/account-pool/import", {
    method: "POST",
    headers,
    body,
  });
}

// One line of the token fetcher's output, the shape pasted in bulk.
function fetcherLine(i) {
  return JSON.stringify({
    ClientSecret: "cs" + String(i).padStart(28, "0"),
    UniqueId: "u" + String(i).padStart(31, "0"),
    Login: "bulkuser" + i,
    Id: String(900000000 + i),
    Enabled: true,
    FavouriteGames: [],
    integrityOk: true,
    integrityNote: "validated as bulkuser" + i + " (" + (900000000 + i) + ")",
    mintedAt: "2026-09-29T06:40:34.891Z",
    mintedIP: "203.0.113.7",
    mintedUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    scriptVersion: "1.3.0",
    savedAt: "2026-09-29T06:40:35.012Z",
  });
}

test("a bulk token-fetcher paste past the 100kb JSON cap imports as text/plain", async () => {
  const paste = Array.from({ length: 400 }, (_, i) => fetcherLine(i)).join("\n");
  assert.ok(
    Buffer.byteLength(paste) > 150 * 1024,
    "the paste must be well past express.json's 100kb",
  );

  // The old request shape: refused by the app-wide JSON cap, nothing imported.
  const asJson = await post(JSON.stringify({ accounts: paste }), "application/json");
  assert.equal(asJson.status, 413);
  assert.equal(await AvailableAccount.countDocuments(), 0);

  // What the page sends now.
  const res = await post(paste, "text/plain; charset=utf-8");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 400);
  assert.equal(body.badLineCount, 0);
  assert.equal(
    await AvailableAccount.countDocuments({ source: "manual-import" }),
    400,
  );
  const row = await AvailableAccount.findOne({ usernameLower: "bulkuser123" }).lean();
  assert.equal(row.clientSecret, "cs" + "123".padStart(28, "0"));
  assert.equal(row.uniqueId, "u" + "123".padStart(31, "0"));
  assert.equal(row.twitchId, "900000123");
  // Every row that came with a token is queued for its Twitch check.
  assert.equal(body.autoChecking, 400);
  assert.equal(enqueued.length, 400);
});

test("a small JSON body still imports", async () => {
  const res = await post(
    JSON.stringify({ accounts: "jsonuser:pw-json-1" }),
    "application/json",
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 1);
  const row = await AvailableAccount.findOne({ usernameLower: "jsonuser" }).lean();
  assert.equal(row.hasPassword, true);
  assert.equal(decrypt(row.password), "pw-json-1");
});

test("a paste past the per-import account cap is refused before anything is written", async () => {
  const paste = Array.from({ length: 10001 }, (_, i) => "capuser" + i + ":pw").join("\n");
  const res = await post(paste, "text/plain");
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(
    body.message,
    "10,001 accounts in one paste — import at most 10,000 at a time",
  );
  assert.equal(await AvailableAccount.countDocuments(), 0);
  assert.equal(enqueued.length, 0);
});

test("an unauthenticated bulk paste is refused before it is read", async () => {
  const paste = Array.from({ length: 400 }, (_, i) => fetcherLine(i)).join("\n");
  const res = await post(paste, "text/plain", { noAuth: true });
  assert.equal(res.status, 401);
  assert.equal(await AvailableAccount.countDocuments(), 0);
});
