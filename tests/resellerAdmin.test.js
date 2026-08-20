/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "reseller-admin-test-session-secret";

const Reseller = require("../models/Reseller");
const ResellerAccount = require("../models/ResellerAccount");
const ResellerAudit = require("../models/ResellerAudit");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const { createReseller } = require("../utils/resellers");
const resellerAdminRoutes = require("../routes/resellerAdminRoutes");

let mongod;
let server;
let baseUrl;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("reseller-admin-test"));
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
  app.get("/test/session/:realm", (req, res) => {
    if (req.params.realm === "superadmin") {
      req.session.admin = {
        id: "root",
        username: "root",
        role: "superadmin",
        tfa: true,
      };
    } else if (req.params.realm === "reseller") {
      req.session.reseller = {
        id: new mongoose.Types.ObjectId().toString(),
        username: "tenant",
        at: Date.now(),
      };
    }
    res.json({ success: true });
  });
  app.use(resellerAdminRoutes);
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

async function request(path, { method = "GET", body, cookie } = {}) {
  const headers = { Accept: "application/json" };
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

async function sessionCookie(realm = "superadmin") {
  return (await request("/test/session/" + realm)).cookie;
}

async function makeAccount(login, fields = {}) {
  return BotAccount.create({
    clientSecret: "token-" + login,
    login,
    credPassword: "password-" + login,
    credEmail: login + "@example.test",
    ...fields,
  });
}

async function addDrop(account, fields = {}) {
  return DropLog.create({
    account: account._id,
    login: account.login,
    benefitId: fields.benefitId || new mongoose.Types.ObjectId().toString(),
    name: fields.name || "Reward",
    game: fields.game || "VALORANT",
    count: fields.count || 1,
    state: fields.state || "claimed",
    connected: fields.connected === true,
    requiredAccountLink: fields.requiredAccountLink || "",
  });
}

async function assign(cookie, reseller, logins) {
  return request(`/resellers/${reseller._id}/assign`, {
    method: "POST",
    cookie,
    body: { logins },
  });
}

test("assign reserves valid stock and computes the connection snapshot", async () => {
  const cookie = await sessionCookie();
  const reseller = await createReseller({
    username: "snapshot-reseller",
    password: "password1",
  });
  const account = await makeAccount("snapshot-login");
  await addDrop(account, {
    benefitId: "connect-1",
    game: "VALORANT",
    state: "connect",
    requiredAccountLink: "Riot",
    count: 2,
  });
  await addDrop(account, {
    benefitId: "connected-1",
    game: "VALORANT",
    state: "connected",
    connected: true,
    requiredAccountLink: "Riot",
  });

  const preview = await request(`/resellers/${reseller._id}/assign/preview`, {
    method: "POST",
    cookie,
    body: { logins: "snapshot-login" },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.preview[0].status, "assignable");
  assert.equal(
    await ResellerAccount.countDocuments({ reseller: reseller._id }),
    0,
  );
  assert.equal((await BotAccount.findById(account._id).lean()).soldAt, null);

  const result = await assign(cookie, reseller, "login: snapshot-login");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.skipped, []);
  assert.equal(result.payload.assigned.length, 1);

  const row = await ResellerAccount.findOne({ reseller: reseller._id }).lean();
  assert.equal(row.needsConnect, true);
  assert.equal(row.game, "VALORANT");
  const summary = row.connectSummary.find(
    (item) => item.game === "VALORANT" && item.requiredAccountLink === "Riot",
  );
  assert.deepEqual(
    { total: summary.total, connected: summary.connected },
    { total: 3, connected: 1 },
  );

  const bot = await BotAccount.findById(account._id).lean();
  assert.equal(bot.resellerId, String(reseller._id));
  assert.ok(bot.soldAt);
  assert.equal(
    await BotAccount.countDocuments({ _id: account._id, soldAt: null }),
    0,
  );
  const drops = await DropLog.find({ account: account._id }).lean();
  assert.ok(
    drops.every((drop) => drop.soldResellerId === String(reseller._id)),
  );
  assert.ok(drops.every((drop) => drop.soldAt));
  assert.equal(
    await DropLog.countDocuments({ account: account._id, soldAt: null }),
    0,
  );
  assert.equal(
    await ResellerAudit.countDocuments({
      reseller: reseller._id,
      action: "assign",
    }),
    1,
  );
});

test("assign reports sold, assigned, bulk-held and active-listing accounts and continues", async () => {
  const cookie = await sessionCookie();
  const reseller = await createReseller({
    username: "mixed",
    password: "password1",
  });
  const other = await createReseller({
    username: "other",
    password: "password1",
  });
  const sold = await makeAccount("sold-login", { soldAt: new Date() });
  const assignedAccount = await makeAccount("assigned-login");
  await ResellerAccount.create({
    reseller: other._id,
    botAccount: assignedAccount._id,
    clientSecret: assignedAccount.clientSecret,
    login: assignedAccount.login,
  });
  const bulk = await makeAccount("bulk-login", { soldBulkOrderId: "bulk-1" });
  const listed = await makeAccount("listed-login");
  await MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "gameflip",
    externalId: "listing-1",
    status: "active",
    accountLogin: listed.login,
  });
  const valid = await makeAccount("valid-login");
  for (const account of [sold, assignedAccount, bulk, listed, valid]) {
    await addDrop(account);
  }

  const result = await assign(
    cookie,
    reseller,
    "sold-login\nassigned-login\nbulk-login\nlisted-login\nvalid-login",
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.payload.assigned.map((item) => item.login),
    ["valid-login"],
  );
  const reasons = new Map(
    result.payload.skipped.map((item) => [item.login, item.reason]),
  );
  assert.match(reasons.get("sold-login"), /sold/);
  assert.match(reasons.get("assigned-login"), /assigned/);
  assert.match(reasons.get("bulk-login"), /bulk/);
  assert.match(reasons.get("listed-login"), /marketplace listing/);
  assert.equal(
    await ResellerAccount.countDocuments({ reseller: reseller._id }),
    1,
  );
});

test("maxAccounts caps assignments while zero remains unlimited", async () => {
  const cookie = await sessionCookie();
  const limited = await createReseller({
    username: "limited",
    password: "password1",
    maxAccounts: 1,
  });
  await makeAccount("limit-a");
  await makeAccount("limit-b");
  const limitedResult = await assign(cookie, limited, "limit-a\nlimit-b");
  assert.equal(limitedResult.payload.assigned.length, 1);
  assert.match(limitedResult.payload.skipped[0].reason, /limit/);

  const unlimited = await createReseller({
    username: "unlimited",
    password: "password1",
    maxAccounts: 0,
  });
  await makeAccount("unlimited-a");
  await makeAccount("unlimited-b");
  await makeAccount("unlimited-c");
  const unlimitedResult = await assign(
    cookie,
    unlimited,
    "unlimited-a\nunlimited-b\nunlimited-c",
  );
  assert.equal(unlimitedResult.payload.assigned.length, 3);
  assert.equal(unlimitedResult.payload.skipped.length, 0);
});

test("reclaim and delete reseller fully reverse reservations without stranding stock", async () => {
  const cookie = await sessionCookie();
  const reseller = await createReseller({
    username: "reclaimer",
    password: "password1",
  });
  const first = await makeAccount("reclaim-one");
  const second = await makeAccount("reclaim-two");
  await addDrop(first);
  await addDrop(second);
  await assign(cookie, reseller, "reclaim-one\nreclaim-two");
  const rows = await ResellerAccount.find({ reseller: reseller._id })
    .sort({ login: 1 })
    .lean();

  const reclaimed = await request(`/resellers/${reseller._id}/reclaim`, {
    method: "POST",
    cookie,
    body: { accountIds: [String(rows[0]._id)] },
  });
  assert.equal(reclaimed.response.status, 200);
  assert.equal(await ResellerAccount.countDocuments({ _id: rows[0]._id }), 0);
  const firstBot = await BotAccount.findById(first._id).lean();
  assert.equal(firstBot.soldAt, null);
  assert.equal(firstBot.resellerId, "");
  assert.equal(
    await DropLog.countDocuments({
      account: first._id,
      soldResellerId: { $ne: "" },
    }),
    0,
  );

  const deleted = await request(`/resellers/${reseller._id}`, {
    method: "DELETE",
    cookie,
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(await Reseller.countDocuments({ _id: reseller._id }), 0);
  assert.equal(
    await ResellerAccount.countDocuments({ reseller: reseller._id }),
    0,
  );
  const secondBot = await BotAccount.findById(second._id).lean();
  assert.equal(secondBot.soldAt, null);
  assert.equal(secondBot.resellerId, "");
  assert.equal(
    await DropLog.countDocuments({
      account: second._id,
      soldResellerId: { $ne: "" },
    }),
    0,
  );
  assert.equal(
    await ResellerAudit.countDocuments({
      reseller: reseller._id,
      action: "delete",
    }),
    1,
  );
});

test("reclaim refuses an account id owned by another reseller", async () => {
  const cookie = await sessionCookie();
  const owner = await createReseller({
    username: "owner",
    password: "password1",
  });
  const attacker = await createReseller({
    username: "wrong-owner",
    password: "password1",
  });
  const account = await makeAccount("owned-account");
  await assign(cookie, owner, "owned-account");
  const row = await ResellerAccount.findOne({ reseller: owner._id }).lean();
  const result = await request(`/resellers/${attacker._id}/reclaim`, {
    method: "POST",
    cookie,
    body: { accountIds: [String(row._id)] },
  });
  assert.equal(result.response.status, 404);
  assert.equal(await ResellerAccount.countDocuments({ _id: row._id }), 1);
  assert.equal(
    (await BotAccount.findById(account._id).lean()).resellerId,
    String(owner._id),
  );
});

test("a reseller session cannot access any reseller administration route", async () => {
  const resellerCookie = await sessionCookie("reseller");
  const id = new mongoose.Types.ObjectId().toString();
  const accountId = new mongoose.Types.ObjectId().toString();
  const probes = [
    ["GET", "/resellers"],
    ["POST", "/resellers", {}],
    ["GET", `/resellers/${id}`],
    ["PUT", `/resellers/${id}`, {}],
    ["POST", `/resellers/${id}/password`, {}],
    ["GET", `/resellers/${id}/password`],
    ["POST", `/resellers/${id}/suspend`, {}],
    ["POST", `/resellers/${id}/unsuspend`, {}],
    ["POST", `/resellers/${id}/assign/preview`, { logins: "x" }],
    ["POST", `/resellers/${id}/assign`, { logins: "x" }],
    ["POST", `/resellers/${id}/reclaim`, { accountIds: [accountId] }],
    ["DELETE", `/resellers/${id}/accounts/${accountId}`],
    ["DELETE", `/resellers/${id}`],
    ["GET", "/reseller-accounts"],
    ["GET", "/reseller-audit"],
  ];
  for (const [method, path, body] of probes) {
    const result = await request(path, {
      method,
      cookie: resellerCookie,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(result.response.status, 401, `${method} ${path}`);
  }
});

test("operator roster decrypts credentials and CRUD actions are audited", async () => {
  const cookie = await sessionCookie();
  const created = await request("/resellers", {
    method: "POST",
    cookie,
    body: {
      username: "crud-reseller",
      password: "password1",
      displayName: "CRUD reseller",
      maxAccounts: 2,
    },
  });
  assert.equal(created.response.status, 201);
  const resellerId = created.payload.reseller.id;
  const updated = await request(`/resellers/${resellerId}`, {
    method: "PUT",
    cookie,
    body: { displayName: "Updated", maxAccounts: 0, notes: "review" },
  });
  assert.equal(updated.response.status, 200);
  const account = await makeAccount("crud-account");
  await assign(cookie, { _id: resellerId }, "crud-account");
  const roster = await request(`/reseller-accounts?reseller=${resellerId}`, {
    cookie,
  });
  assert.equal(roster.response.status, 200);
  assert.equal(roster.payload.accounts[0].password, "password-crud-account");
  assert.equal(roster.payload.accounts[0].reseller, "crud-reseller");
  assert.equal(roster.payload.accounts[0].email, "crud-account@example.test");
  assert.equal(roster.payload.accounts[0].token, account.clientSecret);
  const password = await request(`/resellers/${resellerId}/password`, {
    cookie,
  });
  assert.equal(password.payload.password, "password1");
  const reset = await request(`/resellers/${resellerId}/password`, {
    method: "POST",
    cookie,
    body: { password: "password2" },
  });
  assert.equal(reset.response.status, 200);
  assert.equal(
    (
      await request(`/resellers/${resellerId}/suspend`, {
        method: "POST",
        cookie,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(`/resellers/${resellerId}/unsuspend`, {
        method: "POST",
        cookie,
      })
    ).response.status,
    200,
  );
  const actions = await ResellerAudit.find({ reseller: resellerId }).distinct(
    "action",
  );
  for (const action of [
    "create",
    "update",
    "assign",
    "password_reset",
    "suspend",
    "unsuspend",
  ]) {
    assert.ok(actions.includes(action), action);
  }
});
