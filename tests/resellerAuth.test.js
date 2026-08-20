/* global fetch, setImmediate */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "reseller-auth-test-session-secret";

const Reseller = require("../models/Reseller");
const ResellerAudit = require("../models/ResellerAudit");
const ResellerAccount = require("../models/ResellerAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const {
  createReseller,
  revealPassword,
  parseAccessDate,
  isBeforeStart,
  isExpired,
} = require("../utils/resellers");
const { requireAdmin } = require("../middleware/auth");
const { requireRenter } = require("../middleware/renterAuth");
const resellerAuthRoutes = require("../routes/resellerAuthRoutes");

let mongod;
let server;
let baseUrl;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("reseller-auth-test"));

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/seed", (req, res) => {
    req.session.seed = true;
    res.json({ success: true });
  });
  app.get("/test/admin", requireAdmin, (req, res) =>
    res.json({ success: true }),
  );
  app.get("/test/renter", requireRenter, (req, res) =>
    res.json({ success: true }),
  );
  app.use(resellerAuthRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
});

test("date-only reseller access follows Japan calendar days", () => {
  const start = parseAccessDate("2026-08-21");
  const end = parseAccessDate("2026-09-21", { endOfDay: true });

  assert.equal(start.toISOString(), "2026-08-20T15:00:00.000Z");
  assert.equal(end.toISOString(), "2026-09-21T14:59:59.999Z");
  assert.equal(
    isBeforeStart(
      { accessStart: start },
      new Date("2026-08-20T15:01:00.000Z"),
    ),
    false,
  );
  assert.equal(
    isExpired({ accessEnd: end }, new Date("2026-09-21T14:00:00.000Z")),
    false,
  );
  assert.equal(
    isExpired({ accessEnd: end }, new Date("2026-09-21T15:00:00.000Z")),
    true,
  );
});

async function request(
  path,
  { method = "GET", body, cookie, ip = "10.0.0.1" } = {},
) {
  const headers = { Accept: "application/json", "X-Forwarded-For": ip };
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  let payload = null;
  if ((response.headers.get("content-type") || "").includes("application/json"))
    payload = await response.json();
  return {
    response,
    payload,
    cookie: setCookie ? setCookie.split(";", 1)[0] : cookie,
  };
}

test("create stores a hash and encrypted reveal while whoami stays sanitized", async () => {
  const reseller = await createReseller({
    username: "Acme.Reseller",
    password: "correct horse",
    displayName: "Acme",
  });
  assert.notEqual(reseller.passwordHash, "correct horse");
  assert.match(reseller.passwordEnc, /^enc:v1:/);
  assert.equal(revealPassword(reseller), "correct horse");

  const login = await request("/reseller-login", {
    method: "POST",
    body: { username: "acme.reseller", password: "correct horse" },
    ip: "10.0.0.2",
  });
  assert.equal(login.response.status, 200);
  const who = await request("/reseller/whoami", {
    cookie: login.cookie,
    ip: "10.0.0.2",
  });
  assert.equal(who.response.status, 200);
  assert.equal(who.payload.reseller.username, "Acme.Reseller");
  for (const secret of [
    "passwordHash",
    "passwordEnc",
    "clientSecret",
    "password",
    "email",
  ])
    assert.equal(secret in who.payload.reseller, false);
  assert.equal("notes" in who.payload.reseller, false);
});

test("inventory and reservation schemas contain the Phase 1 isolation markers", () => {
  for (const path of [
    "reseller",
    "botAccount",
    "clientSecret",
    "resellerStatus",
    "needsConnect",
    "connectSummary",
  ]) {
    assert.ok(
      ResellerAccount.schema.path(path),
      `missing ResellerAccount.${path}`,
    );
  }
  assert.ok(BotAccount.schema.path("resellerId"));
  assert.ok(DropLog.schema.path("soldResellerId"));
});

test("successful login regenerates the session id and writes only reseller realm state", async () => {
  const reseller = await createReseller({
    username: "session-test",
    password: "password1",
  });
  const seeded = await request("/test/seed", { ip: "10.0.0.3" });
  const oldCookie = seeded.cookie;
  const login = await request("/reseller-login", {
    method: "POST",
    cookie: oldCookie,
    body: { username: "session-test", password: "password1" },
    ip: "10.0.0.3",
  });
  assert.equal(login.response.status, 200);
  assert.notEqual(login.cookie, oldCookie);

  assert.equal(
    (await request("/test/admin", { cookie: login.cookie, ip: "10.0.0.3" }))
      .response.status,
    401,
  );
  assert.equal(
    (await request("/test/renter", { cookie: login.cookie, ip: "10.0.0.3" }))
      .response.status,
    401,
  );
  assert.equal(
    (
      await request("/reseller/whoami", {
        cookie: login.cookie,
        ip: "10.0.0.3",
      })
    ).response.status,
    200,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await ResellerAudit.countDocuments({
      reseller: reseller._id,
      action: "login",
    }),
    1,
  );
});

test("post-login bookkeeping failure does not turn a saved session into a 500", async () => {
  await createReseller({
    username: "bookkeeping-test",
    password: "password1",
  });
  const originalCreate = ResellerAudit.create;
  ResellerAudit.create = async () => {
    throw new Error("audit unavailable");
  };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const login = await request("/reseller-login", {
      method: "POST",
      body: { username: "bookkeeping-test", password: "password1" },
      ip: "10.0.0.6",
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.payload.success, true);
    assert.equal(
      (
        await request("/reseller/whoami", {
          cookie: login.cookie,
          ip: "10.0.0.6",
        })
      ).response.status,
      200,
    );
    assert.ok(
      logged.some((line) => line.includes("reseller login bookkeeping")),
    );
  } finally {
    ResellerAudit.create = originalCreate;
    console.error = originalError;
  }
});

test("suspension and access expiry destroy an existing session on the next request", async () => {
  const reseller = await createReseller({
    username: "instant-lock",
    password: "password1",
  });
  const login = await request("/reseller-login", {
    method: "POST",
    body: { username: "instant-lock", password: "password1" },
    ip: "10.0.0.4",
  });
  await Reseller.updateOne(
    { _id: reseller._id },
    { $set: { status: "suspended" } },
  );
  const blocked = await request("/reseller/whoami", {
    cookie: login.cookie,
    ip: "10.0.0.4",
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.payload.code, "blocked");
  assert.equal(
    (
      await request("/reseller/whoami", {
        cookie: login.cookie,
        ip: "10.0.0.4",
      })
    ).response.status,
    401,
  );

  const expired = await createReseller({
    username: "expired-now",
    password: "password1",
    accessEnd: new Date(Date.now() - 1000),
  });
  assert.ok(expired);
  const denied = await request("/reseller-login", {
    method: "POST",
    body: { username: "expired-now", password: "password1" },
    ip: "10.0.0.5",
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.code, "blocked");
});

test("reseller login is rate-limited", async () => {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await request("/reseller-login", {
      method: "POST",
      body: { username: "missing", password: "incorrect" },
      ip: "10.0.0.99",
    });
    assert.equal(result.response.status, 401);
  }
  const limited = await request("/reseller-login", {
    method: "POST",
    body: { username: "missing", password: "incorrect" },
    ip: "10.0.0.99",
  });
  assert.equal(limited.response.status, 429);
});
