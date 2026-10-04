/* global fetch */
// Route-level tests for the SOOP farm API (docs/SOOP-FARM.md).
//
// Two failures these exist to prevent:
//  1. A COOKIE LEAK. The SOOP account rows hold live AuthTicket session cookies
//     — the whole account. GET /api/soop/state is polled by the panel every two
//     seconds, so the assertion here is on the SERIALISED body, not on a field
//     list: any future spread that forgets to strip `cookies` fails loudly.
//  2. AN OPEN PANEL. The endpoints can start/stop farming and read inventory,
//     so every one must refuse an unauthenticated or non-superadmin caller.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-routes-test-cred-secret";

const SoopAccount = require("../models/SoopAccount");
const SoopCampaign = require("../models/SoopCampaign");
const soopFarm = require("../utils/soopFarm");
const { encrypt } = require("../utils/secretBox");
const soopRoutes = require("../routes/soopRoutes");

const SENTINEL = "AuthTicket-SENTINEL-4kz9";
const COOKIES = JSON.stringify([{ name: "AuthTicket", value: SENTINEL }]);

let mongod;
let server;
let baseUrl;

function harness(admin) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = admin ? { admin } : {};
    next();
  });
  app.use(soopRoutes);
  return app;
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await SoopAccount.create({
    loginId: "tester01",
    nickname: "Tester",
    country: "KR",
    cookies: encrypt(COOKIES),
    status: "ok",
  });
  await SoopCampaign.create({
    dropsIdx: "13337",
    title: "OWCS Korea Stage 3",
    giveCon: "term",
    live: true,
  });
  server = harness({ id: "verify", role: "superadmin" }).listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

test("state never serialises the stored cookies", async () => {
  const res = await fetch(`${baseUrl}/api/soop/state`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes(SENTINEL), "response leaked the AuthTicket value");
  const json = JSON.parse(body);
  assert.equal(json.accounts.length, 1);
  assert.equal(json.accounts[0].id, "tester01");
  assert.equal(json.accounts[0].cookies, undefined);
  assert.ok(json.metrics && typeof json.metrics.rssMB === "number");
});

test("the API is closed to anonymous and non-superadmin callers", async () => {
  const anon = express();
  anon.use(express.json());
  anon.use((req, _res, next) => {
    req.session = {};
    next();
  });
  anon.use(soopRoutes);
  const anonServer = anon.listen(0);
  const anonUrl = `http://127.0.0.1:${anonServer.address().port}`;
  try {
    const r = await fetch(`${anonUrl}/api/soop/state`);
    assert.equal(r.status, 401);
  } finally {
    await new Promise((r) => anonServer.close(r));
  }

  const seller = harness({ id: "seller", role: "seller" }).listen(0);
  const sellerUrl = `http://127.0.0.1:${seller.address().port}`;
  try {
    const r = await fetch(`${sellerUrl}/api/soop/state`);
    assert.equal(r.status, 403);
  } finally {
    await new Promise((r) => seller.close(r));
  }
});

test("a campaign that left the event list is still resolvable by id", async () => {
  const rec = await soopFarm.resolveCampaign("13337");
  assert.ok(rec, "expected the remembered campaign");
  assert.equal(rec.title, "OWCS Korea Stage 3");
  const missing = await soopFarm.resolveCampaign("999999");
  assert.equal(missing, null);
});
