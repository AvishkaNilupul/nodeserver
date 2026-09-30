/* global fetch */
// Fix 11 (2026-10-01): the market console's rent-farm Orders tab carries each
// account's LIVE window from the ledger (end date, ended, on a bot) — what an
// operator needs before closing or extending an order.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "market-console-orders-test";

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const routes = require("../routes/marketplaceConsoleRoutes");

let mongod;
let server;
let baseUrl;
let cookie;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("market-console-orders"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(routes);
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

test("each order's accounts carry their live window from the ledger", async () => {
  const holder = await Renter.create({ username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x" });
  const until = new Date(Date.now() + 20 * 86400000);
  await RenterAccount.create({ renter: holder._id, clientSecret: "a", login: "OnBot1", host: "contabo", configFile: "config_03.json", farmUntil: until });
  await RenterAccount.create({ renter: holder._id, clientSecret: "b", login: "offbot2", host: "contabo", configFile: "", farmUntil: until });
  await RenterAccount.create({ renter: holder._id, clientSecret: "c", login: "ended3", host: "contabo", configFile: "", enabled: false, farmEndedAt: new Date() });
  await FarmServiceOrder.create({
    orderId: "eld-1", market: "eldorado", game: "Overwatch", days: 30, state: "delivered",
    accounts: [{ login: "onbot1" }, { login: "offbot2" }, { login: "ended3" }, { login: "ghost4" }],
  });
  const res = await fetch(baseUrl + "/api/market-console/eldorado/orders", { headers: { Cookie: cookie, Accept: "application/json" } });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  const row = (d.items || d.rows || []).find((o) => o.orderId === "eld-1");
  assert.ok(row, JSON.stringify(d));
  const by = Object.fromEntries(row.live.map((a) => [a.login, a]));
  assert.equal(by.onbot1.onBot, true);
  assert.equal(new Date(by.onbot1.farmUntil).getTime(), until.getTime());
  assert.equal(by.offbot2.onBot, false);
  assert.equal(by.ended3.ended, true);
  assert.equal(by.ghost4.known, false);
});
