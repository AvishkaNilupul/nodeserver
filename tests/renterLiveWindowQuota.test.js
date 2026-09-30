/* global fetch */
// Lapsed windows no longer count against account limits (2026-10-01).
//
// renterExpiry keeps a lapsed account's RenterAccount row (farmEndedAt stamped,
// enabled:false) so the roster still shows it. Every quota counted ALL rows, so:
//   - the rent-farm holder's 2000 limit was really a lifetime-sales counter:
//     at ~10 sales a day it would have been reached around March 2027 and every
//     "Automatic Farming" order refused again, exactly as on 2026-09-28;
//   - a direct renter's lapsed accounts kept using its quota;
//   - a buyer changing their password AFTER their term ended showed as a live
//     "token issue";
//   - the renter scanner rescanned ended accounts forever (~11 more a day).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-live-quota-test";
process.env.CRED_SECRET ||= "renter-live-quota-cred";

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const operatorFarm = require("../utils/operatorFarm");
const renterDropScanner = require("../utils/renterDropScanner");
const renterAdminRoutes = require("../routes/renterAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-live-quota"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(renterAdminRoutes);
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

async function seed(username, { live = 0, ended = 0, max = 10, deadLive = 0, deadEnded = 0 } = {}) {
  const r = await Renter.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: "x",
    maxAccounts: max,
  });
  let n = 0;
  const mk = (extra) =>
    RenterAccount.create({ renter: r._id, clientSecret: username + "-" + ++n, login: username + n, ...extra });
  for (let i = 0; i < live; i++) await mk({});
  for (let i = 0; i < ended; i++) await mk({ farmEndedAt: new Date(), enabled: false });
  for (let i = 0; i < deadLive; i++) await mk({ lastScanStatus: "token_invalid" });
  for (let i = 0; i < deadEnded; i++) await mk({ lastScanStatus: "token_invalid", farmEndedAt: new Date(), enabled: false });
  return r;
}

test("REGRESSION: the holder's limit counts live windows, not lifetime sales", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  await seed("operator-selffarm", { live: 3, ended: 7, max: 5 });
  const q = await operatorFarm.holderQuota();
  assert.deepEqual(q, { max: 5, used: 3, remaining: 2 });
});

test("a direct renter's lapsed accounts free their quota (Add from pool preview)", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  const r = await seed("bulksellerhaz", { live: 1, ended: 9, max: 10 });
  const res = await fetch(baseUrl + "/renters/" + r._id + "/accounts/from-pool/preview?count=1", {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const d = await res.json();
  assert.equal(d.quotaRemaining, 9);
});

test("the renters list shows live accounts as 'used'", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  await seed("rainbowsix", { live: 7, ended: 2 });
  const res = await fetch(baseUrl + "/renters", { headers: { Cookie: cookie, Accept: "application/json" } });
  const d = await res.json();
  const row = (d.renters || []).find((x) => x.username === "rainbowsix");
  assert.ok(row, JSON.stringify(d).slice(0, 300));
  assert.equal(row.used, 7);
});

test("a dead token after the window ended is not a live token issue", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  await seed("owbuyers", { deadLive: 2, deadEnded: 5 });
  const res = await fetch(baseUrl + "/renter-bots", { headers: { Cookie: cookie, Accept: "application/json" } });
  const d = await res.json();
  assert.equal(d.tokenIssues, 2, JSON.stringify(d).slice(0, 300));
});

test("the scanner's progress: ended windows are counted as ended, never as due or as issues", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  await seed("mix", { live: 4, ended: 6, deadLive: 1, deadEnded: 3 });
  const p = await renterDropScanner.getProgress();
  assert.equal(p.counts.total, 14);
  assert.equal(p.counts.ended, 9);
  assert.equal(p.counts.due, 5, "only live rows are due");
  assert.equal(p.counts.tokenInvalid, 1);
});

test("the scanner's rotation query leaves ended windows out", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "renterDropScanner.js"), "utf8");
  const fn = src.slice(src.indexOf("async function nextDueAccount()"));
  assert.match(fn.slice(0, 900), /farmEndedAt: null,/);
});
