/* global fetch */
// The rent-farm holder (operator-selffarm) is not a renter (2026-10-01).
//
// Its RenterAccounts are PAID rent-farm buyers spread over many stacks, but the
// Renters page showed it with the same Start / Stop / Suspend / Delete buttons
// as any renter, and the server did whatever was asked:
//   - Start re-added every holder account missing from its CURRENT stack — i.e.
//     copied ~257 buyers already farming elsewhere into one config (each then
//     farming in two bots) and repointed their ledger rows;
//   - Stop / Suspend stopped a whole stack of buyers;
//   - Delete erased every paid window's ledger row (the accounts kept farming,
//     never expired, and dropped out of the "never sell a rented account" index);
//   - a lease date put on it would have had the expiry sweep stop its stack.
// The owner still raises its Account limit from the same form (09-28 outage),
// so that — and name / notes — must keep working.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "renter-holder-guard-test-secret";
process.env.CRED_SECRET ||= "renter-holder-guard-test-cred";

const Renter = require("../models/Renter");
const renterAdminRoutes = require("../routes/renterAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-holder-guard"));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(renterAdminRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function call(method, path, body) {
  const init = { method, headers: { Accept: "application/json", Cookie: cookie } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(baseUrl + path, init);
}

async function holder() {
  await Renter.deleteMany({});
  return Renter.create({
    username: "operator-selffarm",
    usernameLower: "operator-selffarm",
    passwordHash: "x",
    displayName: "Operator (self-farm)",
    botHost: "contabo",
    botFile: "config_54.json",
    maxAccounts: 2000,
    accessStart: new Date("2026-09-08T06:08:11Z"),
    accessEnd: null,
  });
}

for (const [action, done] of [["start", "started"], ["stop", "stopped"], ["restart", "restarted"]]) {
  test("REGRESSION: the holder's bot cannot be " + done + " as a renter", async () => {
    const h = await holder();
    const res = await call("POST", "/renters/" + h._id + "/bot/" + action);
    assert.equal(res.status, 409);
    const d = await res.json();
    assert.equal(d.holder, true);
    assert.match(d.message, /operator-selffarm/);
  });
}

test("REGRESSION: the holder cannot be suspended", async () => {
  const h = await holder();
  const res = await call("POST", "/renters/" + h._id + "/suspend");
  assert.equal(res.status, 409);
  const after = await Renter.findById(h._id).lean();
  assert.equal(after.status, "active");
  assert.equal(after.botStoppedAt, null);
});

test("REGRESSION: the holder cannot be deleted", async () => {
  const h = await holder();
  const res = await call("DELETE", "/renters/" + h._id);
  assert.equal(res.status, 409);
  assert.ok(await Renter.findById(h._id).lean(), "holder row survives");
});

test("the Account limit (and name) still save from the modal — with every field the form posts", async () => {
  const h = await holder();
  // Exactly what public/renters/detail.js saveRenter() sends for the holder:
  // dates round-trip as YYYY-MM-DD, games as the (empty) comma list.
  const res = await call("PUT", "/renters/" + h._id, {
    maxAccounts: 2500,
    displayName: "Operator (self-farm)",
    farmGames: "",
    accessStart: "2026-09-08",
    accessEnd: null,
  });
  assert.equal(res.status, 200, await res.text());
  const after = await Renter.findById(h._id).lean();
  assert.equal(after.maxAccounts, 2500);
  assert.equal(after.botFile, "config_54.json");
  assert.equal(after.accessEnd, null);
  assert.equal(new Date(after.accessStart).toISOString(), "2026-09-08T06:08:11.000Z", "not rewritten to midnight");
});

test("REGRESSION: the holder cannot be given a lease, games or another bot", async () => {
  for (const body of [
    { maxAccounts: 2000, accessEnd: "2026-12-01" },
    { farmGames: "Overwatch" },
    { botHost: "contabo", botFile: "config_02.json" },
  ]) {
    const h = await holder();
    const res = await call("PUT", "/renters/" + h._id, body);
    assert.equal(res.status, 409, JSON.stringify(body));
    const after = await Renter.findById(h._id).lean();
    assert.equal(after.accessEnd, null);
    assert.equal(after.botFile, "config_54.json");
    assert.deepEqual(after.farmGames, []);
  }
});

test("an ordinary renter is unaffected by the holder guard", async () => {
  await Renter.deleteMany({});
  const r = await Renter.create({
    username: "rainbowsix",
    usernameLower: "rainbowsix",
    passwordHash: "x",
    maxAccounts: 10,
  });
  const res = await call("PUT", "/renters/" + r._id, { maxAccounts: 12, accessEnd: "2027-08-19" });
  assert.equal(res.status, 200);
  const after = await Renter.findById(r._id).lean();
  assert.equal(after.maxAccounts, 12);
  assert.equal(new Date(after.accessEnd).toISOString().slice(0, 10), "2027-08-19");
});
