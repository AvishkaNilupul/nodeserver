/* global fetch */
// Reseller integrity (2026-10-01):
//   - assign never checked the renter ledger, so a leased renter account — or a
//     paid rent-farm window, whose buyer holds the login — could be handed to a
//     reseller, who reveals and resells it;
//   - reclaim / delete-reseller cleared the sale off accounts the reseller had
//     already SOLD, putting sold credentials back into stock.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "reseller-integrity-test";
process.env.CRED_SECRET ||= "reseller-integrity-cred";

const Reseller = require("../models/Reseller");
const ResellerAccount = require("../models/ResellerAccount");
const ResellerAudit = require("../models/ResellerAudit");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const rented = require("../utils/rentedAccounts");
const resellerAdminRoutes = require("../routes/resellerAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("reseller-integrity"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(resellerAdminRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  rented.__resetCache();
  await Promise.all([
    Reseller.deleteMany({}), ResellerAccount.deleteMany({}), ResellerAudit.deleteMany({}),
    BotAccount.deleteMany({}), DropLog.deleteMany({}), Renter.deleteMany({}), RenterAccount.deleteMany({}),
  ]);
  return Reseller.create({ username: "resA", usernameLower: "resa", passwordHash: "x", maxAccounts: 100 });
}

test("REGRESSION: a rented / paid rent-farm account cannot be assigned to a reseller", async () => {
  const reseller = await reset();
  await BotAccount.create({ login: "buyer1", clientSecret: "cs-b1" });
  const holder = await Renter.create({ username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x" });
  await RenterAccount.create({ renter: holder._id, clientSecret: "cs-b1", login: "buyer1" });

  const res = await fetch(baseUrl + "/resellers/" + reseller._id + "/assign/lookup?login=buyer1", {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.account.assignable, false);
  assert.match(d.account.status, /rented to a renter/);
});

test("an account nobody rents is still assignable", async () => {
  const reseller = await reset();
  await BotAccount.create({ login: "free1", clientSecret: "cs-f1" });
  const d = await (await fetch(baseUrl + "/resellers/" + reseller._id + "/assign/lookup?login=free1", {
    headers: { Cookie: cookie, Accept: "application/json" },
  })).json();
  assert.equal(d.account.assignable, true, JSON.stringify(d));
});

async function heldBy(reseller, status) {
  const bot = await BotAccount.create({
    login: "held1", clientSecret: "cs-h1", soldAt: new Date(), soldToUsername: "reseller:resA", resellerId: String(reseller._id),
  });
  await new DropLog({ account: bot._id, login: "held1", benefitId: "b1", soldAt: new Date(), soldToUsername: "reseller:resA", soldResellerId: String(reseller._id) }).save({ validateBeforeSave: false });
  const row = await ResellerAccount.create({
    reseller: reseller._id, botAccount: bot._id, clientSecret: "cs-h1", login: "held1", resellerStatus: status,
  });
  return { bot, row };
}

test("REGRESSION: reclaiming an account the reseller SOLD keeps it sold", async () => {
  const reseller = await reset();
  const { bot, row } = await heldBy(reseller, "sold");
  const res = await fetch(baseUrl + "/resellers/" + reseller._id + "/accounts/" + row._id, {
    method: "DELETE", headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const b = await BotAccount.findById(bot._id).lean();
  assert.ok(b.soldAt, "still sold — never back into stock");
  assert.equal(b.soldToUsername, "reseller-sold:resA");
  assert.equal(b.resellerId, "");
  const drop = await DropLog.findOne({ account: bot._id }).lean();
  assert.ok(drop.soldAt);
  assert.equal(await ResellerAccount.countDocuments({}), 0);
  assert.ok(await ResellerAudit.findOne({ action: "reclaim_sold_kept" }).lean(), "audited with its own action");
});

test("reclaiming an account the reseller did NOT sell releases it, as before", async () => {
  const reseller = await reset();
  const { bot, row } = await heldBy(reseller, "received");
  const res = await fetch(baseUrl + "/resellers/" + reseller._id + "/accounts/" + row._id, {
    method: "DELETE", headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(res.status, 200);
  const b = await BotAccount.findById(bot._id).lean();
  assert.equal(b.soldAt, null);
  assert.equal(b.soldToUsername, "");
});
