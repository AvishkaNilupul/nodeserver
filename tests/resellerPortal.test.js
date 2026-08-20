/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "reseller-portal-test-session-secret";

const ResellerAccount = require("../models/ResellerAccount");
const ResellerAudit = require("../models/ResellerAudit");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const { createReseller } = require("../utils/resellers");
const { encrypt } = require("../utils/secretBox");
const twitchInventory = require("../utils/twitchInventory");
const resellerFarmingForecast = require("../utils/resellerFarmingForecast");

const originalFetchInventory = twitchInventory.fetchInventory;
const originalGetForecast = resellerFarmingForecast.getForecast;
twitchInventory.fetchInventory = async (token) => ({
  twitchId: "twitch-" + token,
  login: token.replace(/^token-/, ""),
  inProgress: [],
  drops: [
    {
      benefitId: "live-connected",
      dropId: "live-drop",
      name: "Live reward",
      imageURL: "https://example.test/live.png",
      game: "VALORANT",
      gameId: "1",
      campaign: "Live campaign",
      itemKey: "live reward|valorant",
      count: 1,
      awardedAt: new Date("2026-01-01T00:00:00Z"),
      connected: true,
      requiredAccountLink: "Riot",
      state: "connected",
      source: "gameEventDrop",
    },
  ],
});
resellerFarmingForecast.getForecast = async () => ({
  generatedAt: new Date("2026-08-21T00:00:00Z"),
  freshness: { newestScanAt: new Date("2026-08-20T23:00:00Z"), stale: false },
  runtime: { available: true, checkedAt: new Date("2026-08-21T00:00:00Z") },
  summary: { activeAccounts: 12, items: 2, readySoon: 1, availableNow: 3 },
  games: [{ game: "VALORANT", farmingAccounts: 12, items: 2, readySoon: 1 }],
  items: [
    {
      name: "Forecast reward",
      game: "VALORANT",
      farmingAccounts: 12,
      averagePercent: 82,
      readySoon: true,
      availableNow: { accounts: 3, units: 3 },
      confidence: "high",
    },
  ],
});
const resellerRoutes = require("../routes/resellerRoutes");

let mongod;
let server;
let baseUrl;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("reseller-portal-test"));
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
  const seedSession = (req, res) => {
    if (req.params.realm === "reseller") {
      req.session.reseller = {
        id: req.params.id,
        username: "tenant",
        at: Date.now(),
      };
    } else if (req.params.realm === "renter") {
      req.session.renter = {
        id: req.params.id || new mongoose.Types.ObjectId().toString(),
        username: "renter",
        at: Date.now(),
      };
    } else if (req.params.realm === "admin") {
      req.session.admin = {
        id: "root",
        username: "root",
        role: "superadmin",
        tfa: true,
      };
    }
    res.json({ success: true });
  };
  app.get("/test/session/:realm", seedSession);
  app.get("/test/session/:realm/:id", seedSession);
  app.use(resellerRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  twitchInventory.fetchInventory = originalFetchInventory;
  resellerFarmingForecast.getForecast = originalGetForecast;
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

async function request(
  path,
  { method = "GET", body, cookie, ip = "10.30.0.1" } = {},
) {
  const headers = { Accept: "application/json", "X-Forwarded-For": ip };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  let payload = null;
  if (
    (response.headers.get("content-type") || "").includes("application/json")
  ) {
    payload = await response.json();
  }
  return {
    response,
    payload,
    cookie: setCookie ? setCookie.split(";", 1)[0] : cookie,
  };
}

async function resellerCookie(reseller) {
  return (
    await request(`/test/session/reseller/${reseller._id}`, {
      ip: "10.30.0.2",
    })
  ).cookie;
}

async function makeOwnedAccount(reseller, login, fields = {}) {
  const bot = await BotAccount.create({
    clientSecret: "token-" + login,
    login,
    credPassword: encrypt("password-" + login),
    credEmail: encrypt(login + "@example.test"),
    soldAt: new Date(),
    soldToUsername: "reseller:" + reseller.username,
    resellerId: String(reseller._id),
  });
  const row = await ResellerAccount.create({
    reseller: reseller._id,
    botAccount: bot._id,
    clientSecret: bot.clientSecret,
    login,
    game: "VALORANT",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    ...fields,
  });
  return { bot, row };
}

async function addDrop(bot, fields = {}) {
  return DropLog.create({
    account: bot._id,
    benefitId: fields.benefitId || new mongoose.Types.ObjectId().toString(),
    login: bot.login,
    name: "Reward",
    game: "VALORANT",
    count: 1,
    state: "connect",
    connected: false,
    requiredAccountLink: "Riot",
    soldAt: new Date(),
    soldToUsername: bot.soldToUsername,
    soldResellerId: bot.resellerId,
    ...fields,
  });
}

function assertNoSecretKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    assert.equal(
      [
        "clientSecret",
        "password",
        "email",
        "token",
        "credPassword",
        "credEmail",
      ].includes(key),
      false,
      `list payload exposed ${key}`,
    );
    assertNoSecretKeys(value[key]);
  }
}

test("inventory, detail, me and summary stay scoped to the session reseller", async () => {
  const resellerA = await createReseller({
    username: "portal-a",
    password: "password1",
    displayName: "Portal A",
  });
  const resellerB = await createReseller({
    username: "portal-b",
    password: "password1",
  });
  const owned = await makeOwnedAccount(resellerA, "owned-login", {
    needsConnect: true,
    connectSummary: [
      { game: "VALORANT", requiredAccountLink: "Riot", total: 1, connected: 0 },
    ],
  });
  await addDrop(owned.bot, { imageLocal: "/drop-images/reward.png" });
  await makeOwnedAccount(resellerB, "foreign-login");
  const cookie = await resellerCookie(resellerA);

  const list = await request(
    `/reseller/accounts?reseller=${resellerB._id}&all=1&q=[`,
    { cookie },
  );
  assert.equal(list.response.status, 200);
  assert.deepEqual(
    list.payload.accounts.map((account) => account.login),
    [],
  );
  const unfiltered = await request(
    `/reseller/accounts?reseller=${resellerB._id}&all=1`,
    { cookie },
  );
  assert.deepEqual(
    unfiltered.payload.accounts.map((account) => account.login),
    ["owned-login"],
  );
  assertNoSecretKeys(unfiltered.payload);

  const detail = await request(`/reseller/accounts/${owned.row._id}`, {
    cookie,
  });
  assert.equal(detail.response.status, 200);
  assert.equal(
    detail.payload.account.dropGroups[0].rewards[0].state,
    "connect",
  );
  assertNoSecretKeys(detail.payload);

  const me = await request("/reseller/me?reseller=ignored", { cookie });
  const summary = await request("/reseller/summary?all=1", { cookie });
  assert.equal(me.payload.me.accountCount, 1);
  assert.equal(me.payload.me.displayName, "Portal A");
  assert.equal(summary.payload.summary.total, 1);
  assert.equal(summary.payload.summary.needsConnect, 1);
});

test("farming forecast requires the reseller realm and exposes aggregates only", async () => {
  const reseller = await createReseller({
    username: "forecast-reseller",
    password: "password1",
  });
  const cookie = await resellerCookie(reseller);
  const result = await request("/reseller/farming-forecast", { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.forecast.summary.activeAccounts, 12);
  assert.equal(result.payload.forecast.items[0].name, "Forecast reward");
  assertNoSecretKeys(result.payload);
  const text = JSON.stringify(result.payload);
  for (const forbidden of [
    "clientSecret",
    "login",
    "host",
    "configFile",
    "container",
    "accountId",
  ]) {
    assert.equal(text.includes(forbidden), false, `forecast exposed ${forbidden}`);
  }

  const unauth = await request("/reseller/farming-forecast");
  assert.equal(unauth.response.status, 401);
  const renter = await request("/test/session/renter");
  const wrongRealm = await request("/reseller/farming-forecast", {
    cookie: renter.cookie,
  });
  assert.equal(wrongRealm.response.status, 401);
});

test("all per-account IDOR probes return 404 and leave the foreign row unchanged", async () => {
  const resellerA = await createReseller({
    username: "idor-a",
    password: "password1",
  });
  const resellerB = await createReseller({
    username: "idor-b",
    password: "password1",
  });
  const foreign = await makeOwnedAccount(resellerB, "idor-foreign");
  const cookie = await resellerCookie(resellerA);
  const probes = [
    ["GET", `/reseller/accounts/${foreign.row._id}`],
    ["GET", `/reseller/accounts/${foreign.row._id}/credentials`],
    [
      "POST",
      `/reseller/accounts/${foreign.row._id}/status`,
      { status: "sold", reseller: resellerB._id },
    ],
    [
      "POST",
      `/reseller/accounts/${foreign.row._id}/verify`,
      { reseller: resellerB._id },
    ],
  ];
  for (const [method, path, body] of probes) {
    const result = await request(path, {
      method,
      cookie,
      ...(body === undefined ? {} : { body }),
      ip: "10.30.0.3",
    });
    assert.equal(result.response.status, 404, `${method} ${path}`);
  }
  const unchanged = await ResellerAccount.findById(foreign.row._id).lean();
  assert.equal(unchanged.resellerStatus, "received");
  assert.equal(
    await ResellerAudit.countDocuments({ reseller: resellerA._id }),
    0,
  );
});

test("owned credential reveal is audited before returning decrypted secrets", async () => {
  const reseller = await createReseller({
    username: "reveal-owner",
    password: "password1",
  });
  const owned = await makeOwnedAccount(reseller, "reveal-login");
  const cookie = await resellerCookie(reseller);
  const reveal = await request(
    `/reseller/accounts/${owned.row._id}/credentials`,
    { cookie, ip: "10.30.0.4" },
  );
  assert.equal(reveal.response.status, 200);
  assert.deepEqual(reveal.payload.credentials, {
    login: "reveal-login",
    password: "password-reveal-login",
    email: "reveal-login@example.test",
    token: "token-reveal-login",
  });
  assert.equal(
    await ResellerAudit.countDocuments({
      reseller: reseller._id,
      action: "reveal_creds",
      accountLogin: "reveal-login",
    }),
    1,
  );

  const originalCreate = ResellerAudit.create;
  ResellerAudit.create = async () => {
    throw new Error("audit unavailable");
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const blocked = await request(
      `/reseller/accounts/${owned.row._id}/credentials`,
      { cookie, ip: "10.30.0.5" },
    );
    assert.equal(blocked.response.status, 500);
    assert.equal("credentials" in blocked.payload, false);
  } finally {
    ResellerAudit.create = originalCreate;
    console.error = originalError;
  }
});

test("status changes and live verification refresh only the owned account and audit both actions", async () => {
  const reseller = await createReseller({
    username: "workflow-owner",
    password: "password1",
  });
  const owned = await makeOwnedAccount(reseller, "workflow-login", {
    needsConnect: true,
  });
  await addDrop(owned.bot, { benefitId: "live-connected" });
  const cookie = await resellerCookie(reseller);

  const status = await request(`/reseller/accounts/${owned.row._id}/status`, {
    method: "POST",
    cookie,
    body: {
      status: "sold",
      note: "buyer delivered",
      reseller: new mongoose.Types.ObjectId().toString(),
    },
  });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.account.resellerStatus, "sold");
  assert.ok(status.payload.account.resellerSoldAt);

  const verified = await request(`/reseller/accounts/${owned.row._id}/verify`, {
    method: "POST",
    cookie,
    body: { all: true },
    ip: "10.30.0.6",
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.payload.live, true);
  assert.equal(verified.payload.needsConnect, false);
  assert.equal("token" in verified.payload, false);
  assert.equal("clientSecret" in verified.payload, false);

  const row = await ResellerAccount.findById(owned.row._id).lean();
  assert.equal(row.resellerStatus, "sold");
  assert.equal(row.needsConnect, false);
  assert.ok(row.lastVerifiedAt);
  const drop = await DropLog.findOne({
    account: owned.bot._id,
    benefitId: "live-connected",
  }).lean();
  assert.equal(drop.connected, true);
  assert.equal(drop.state, "connected");
  assert.equal(drop.soldResellerId, String(reseller._id));
  assert.equal(drop.soldToUsername, "reseller:workflow-owner");
  const actions = await ResellerAudit.find({ reseller: reseller._id }).distinct(
    "action",
  );
  assert.ok(actions.includes("mark_sold"));
  assert.ok(actions.includes("verify"));
});

test("renter and admin sessions cannot enter the reseller tenant API", async () => {
  const renterCookie = (await request("/test/session/renter/unused")).cookie;
  const adminCookie = (await request("/test/session/admin/unused")).cookie;
  for (const cookie of [renterCookie, adminCookie]) {
    for (const path of [
      "/reseller/me",
      "/reseller/summary",
      "/reseller/accounts",
    ]) {
      const result = await request(path, { cookie, ip: "10.30.0.7" });
      assert.equal(result.response.status, 401, path);
    }
  }
});

test("credential reveal is rate-limited per IP", async () => {
  const reseller = await createReseller({
    username: "reveal-limit",
    password: "password1",
  });
  const owned = await makeOwnedAccount(reseller, "limited-reveal");
  const cookie = await resellerCookie(reseller);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await request(
      `/reseller/accounts/${owned.row._id}/credentials`,
      { cookie, ip: "10.30.0.99" },
    );
    assert.equal(result.response.status, 200);
  }
  const limited = await request(
    `/reseller/accounts/${owned.row._id}/credentials`,
    { cookie, ip: "10.30.0.99" },
  );
  assert.equal(limited.response.status, 429);
});
