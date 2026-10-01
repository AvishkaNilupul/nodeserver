/* global fetch */
// Renter portal security (fix 15, 2026-10-01):
//   - a password reset, or a suspend, ends every open portal session (session
//     epoch) — a stolen cookie or the old password's holder does not outlive it;
//   - failed logins are limited per USERNAME too (the IP limiter alone let one
//     renter's password be guessed from many addresses), with one alert;
//   - whoami is the renter's own view: no operator notes, host or config file;
//   - a lease that has not started yet opens nothing;
//   - the portal shows an ended window as ended, not "active".
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-portal-security-test";
process.env.CRED_SECRET ||= "renter-portal-security-cred";

const pages = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/routes[\\/]renterAuthRoutes\.js$/.test(from) && request === "../utils/telegram") {
    return { sendTelegram: async (m) => { pages.push(m); } };
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const { createRenter, setPassword } = require("../utils/renters");
const renterAuthRoutes = require("../routes/renterAuthRoutes");
const renterRoutes = require("../routes/renterRoutes");

let mongod;
let server;
let baseUrl;
let ipSeq = 0;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-portal-security"));
  const app = express();
  // Every request can present its own address, so the per-IP limiter never
  // hides the per-username lock under test.
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.use(renterAuthRoutes);
  app.use(renterRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  Module._load = realLoad;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  pages.length = 0;
  renterAuthRoutes._resetLoginLocks();
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
}

function login(username, password, ip = null) {
  ipSeq += 1;
  return fetch(baseUrl + "/renter-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Forwarded-For": ip || "10.0." + (ipSeq >> 8) + "." + (ipSeq & 255),
    },
    body: JSON.stringify({ username, password }),
  });
}

async function session4(username, password) {
  const res = await login(username, password);
  assert.equal(res.status, 200, await res.text());
  return res.headers.get("set-cookie").split(";")[0];
}

function get(path, cookie) {
  ipSeq += 1;
  return fetch(baseUrl + path, { headers: { Cookie: cookie, Accept: "application/json", "X-Forwarded-For": "10.1.0." + (ipSeq & 255) } });
}

async function mkRenter(username, extra = {}) {
  const r = await createRenter({ username, password: "Passw0rd!long", maxAccounts: 5 });
  if (Object.keys(extra).length) await Renter.updateOne({ _id: r._id }, { $set: extra });
  return Renter.findById(r._id);
}

test("REGRESSION: a password reset ends every open portal session", async () => {
  await reset();
  const r = await mkRenter("tenant1");
  const cookie = await session4("tenant1", "Passw0rd!long");
  assert.equal((await get("/renter/me", cookie)).status, 200);
  await setPassword(r._id, "N3wPassword!long");
  const after = await get("/renter/me", cookie);
  assert.equal(after.status, 401, "the old session is over (sign in again — not 'access ended')");
  assert.equal((await login("tenant1", "N3wPassword!long")).status, 200, "the new password works");
});

test("REGRESSION: a suspend ends sessions for good — an unsuspend does not revive them", async () => {
  await reset();
  const r = await mkRenter("tenant2");
  const cookie = await session4("tenant2", "Passw0rd!long");
  // What POST /renters/:id/suspend + /unsuspend do to the record, without a request in between.
  await Renter.updateOne({ _id: r._id }, { $set: { status: "suspended" }, $inc: { sessionEpoch: 1 } });
  await Renter.updateOne({ _id: r._id }, { $set: { status: "active" } });
  assert.equal((await get("/renter/me", cookie)).status, 401);
});

test("REGRESSION: 10 wrong passwords from ONE address lock that address out — not the renter, who still signs in from elsewhere", async () => {
  await reset();
  await mkRenter("tenant3");
  for (let i = 0; i < 10; i++) {
    const res = await login("tenant3", "wrong" + i, "10.9.9.9");
    assert.equal(res.status, 401);
  }
  const locked = await login("tenant3", "Passw0rd!long", "10.9.9.9");
  assert.equal(locked.status, 429, "that address waits out its lock, even with the right password");
  assert.equal((await login("tenant3", "Passw0rd!long", "10.8.8.8")).status, 200, "the renter is not locked out");
  assert.equal(pages.length, 0, "ten failures from one address is the IP limiter's business, not a page");
  // Another renter is unaffected. (That one address has also used up the
  // per-IP limiter's budget, which is the limiter's own, older rule.)
  await mkRenter("tenant4");
  assert.equal((await login("tenant4", "Passw0rd!long", "10.7.7.7")).status, 200);
});

test("REGRESSION: guessing spread over many addresses pages the operator once — and never refuses the right password", async () => {
  await reset();
  await mkRenter("tenant3b");
  for (let i = 0; i < 25; i++) {
    assert.equal((await login("tenant3b", "wrong" + i)).status, 401);
  }
  assert.equal(pages.length, 1, "told once");
  assert.match(pages[0], /Renter login 'tenant3b': 20 failed passwords .* from 20 address/);
  assert.equal((await login("tenant3b", "Passw0rd!long")).status, 200);
});

test("failures for made-up usernames cannot grow the lock maps without bound", async () => {
  await reset();
  const sizes = () => renterAuthRoutes._loginLockSizes();
  for (let i = 0; i < 40; i++) await login("nobody" + i, "x");
  assert.equal(sizes().pairs, 40);
  assert.equal(sizes().users, 40);
});

test("a successful login clears the failure count", async () => {
  await reset();
  await mkRenter("tenant5");
  for (let i = 0; i < 9; i++) await login("tenant5", "wrong" + i);
  assert.equal((await login("tenant5", "Passw0rd!long")).status, 200);
  for (let i = 0; i < 9; i++) await login("tenant5", "wrong" + i);
  assert.equal((await login("tenant5", "Passw0rd!long")).status, 200, "9 + 9 is not 10 in a row");
});

test("whoami is the renter's own view: no operator notes, host or config file", async () => {
  await reset();
  await mkRenter("tenant6", { notes: "late payer — do not extend", botHost: "contabo", botFile: "config_16.json" });
  const cookie = await session4("tenant6", "Passw0rd!long");
  const d = await (await get("/renter/whoami", cookie)).json();
  assert.equal(d.renter.username, "tenant6");
  for (const k of ["notes", "botHost", "botFile", "passwordHash", "passwordEnc"]) {
    assert.ok(!(k in d.renter), k + " leaked to the renter");
  }
});

test("a lease that has not started yet opens nothing", async () => {
  await reset();
  const r = await mkRenter("tenant7", { accessStart: new Date(Date.now() + 3 * 86400000) });
  const res = await login("tenant7", "Passw0rd!long");
  assert.equal(res.status, 403);
  const d = await res.json();
  assert.equal(d.code, "not_started");
  assert.match(d.message, /Your access starts on \d{4}-\d{2}-\d{2}/);
  // A session opened before the start was moved later is closed as well.
  await Renter.updateOne({ _id: r._id }, { $set: { accessStart: new Date(Date.now() - 1000) } });
  const cookie = await session4("tenant7", "Passw0rd!long");
  await Renter.updateOne({ _id: r._id }, { $set: { accessStart: new Date(Date.now() + 86400000) } });
  assert.equal((await get("/renter/me", cookie)).status, 403);
});

test("the portal shows an ENDED window as ended, not 'active'", async () => {
  await reset();
  const r = await mkRenter("tenant8");
  await RenterAccount.create({ renter: r._id, clientSecret: "e1", login: "endedacct", lastScanStatus: "ok", enabled: false, farmEndedAt: new Date() });
  await RenterAccount.create({ renter: r._id, clientSecret: "l1", login: "liveacct", lastScanStatus: "ok", farmUntil: new Date(Date.now() + 9e8) });
  const cookie = await session4("tenant8", "Passw0rd!long");
  const d = await (await get("/renter/accounts", cookie)).json();
  const by = Object.fromEntries(d.accounts.map((a) => [a.login, a]));
  assert.equal(by.endedacct.status, "ended");
  assert.equal(by.liveacct.status, "active");
  assert.ok(by.liveacct.farmUntil);
  for (const a of d.accounts) assert.ok(!("clientSecret" in a) && !("token" in a), "no token reaches the renter");
});

test("REGRESSION: an access start picked as a date opens at 00:00 JST that day, not 09:00", async () => {
  const { parseAccessStart } = require("../utils/renters");
  assert.equal(parseAccessStart("2026-10-01").toISOString(), "2026-09-30T15:00:00.000Z");
  assert.equal(parseAccessStart("2026-10-01T05:00:00Z").toISOString(), "2026-10-01T05:00:00.000Z", "a full timestamp is kept");
  assert.equal(parseAccessStart(""), null);
  await reset();
  // "From today" (JST) — open now, whatever the UTC hour.
  const todayJst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  await createRenter({ username: "tenant9", password: "Passw0rd!long", maxAccounts: 5, accessStart: todayJst });
  assert.equal((await login("tenant9", "Passw0rd!long")).status, 200);
});
