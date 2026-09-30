/* global fetch */
// Rent-farm orders the buyer walked away from (2026-10-01): a cancelled,
// refunded or disputed order left its account farming for up to two years for
// someone who had their money back. farmOrderWatch pages on POSITIVE evidence
// only (never closes); the operator closes the order, which ends the windows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "farm-walkaway-test";
process.env.CRED_SECRET ||= "farm-walkaway-cred";

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const watch = require("../utils/farmOrderWatch");
const renterAdminRoutes = require("../routes/renterAdminRoutes");

let mongod;
let server;
let baseUrl;
let cookie;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("farm-walkaway"));
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

const NOW = Date.UTC(2026, 9, 1, 12);
async function seed() {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({}), FarmServiceOrder.deleteMany({})]);
  const holder = await Renter.create({ username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x" });
  await RenterAccount.create({ renter: holder._id, clientSecret: "c1", login: "Buyer1", host: "contabo", configFile: "config_02.json", farmUntil: new Date(NOW + 300 * 86400000) });
  await FarmServiceOrder.create({ orderId: "eld-cancel-1", market: "eldorado", buyerUsername: "JumpyPage", game: "Overwatch", days: 365, state: "delivered", accounts: [{ login: "buyer1" }] });
  await FarmServiceOrder.create({ orderId: "eld-ok-2", market: "eldorado", game: "Rust", days: 180, state: "delivered", accounts: [{ login: "other" }] });
  await FarmServiceOrder.create({ orderId: "g2g:777", market: "g2g", game: "Rust", days: 120, state: "delivered", accounts: [{ login: "g2gbuyer" }], createdAt: new Date(NOW - 5 * 86400000) });
  return holder;
}

test("REGRESSION: an order Eldorado lists as Canceled pages with its logins — and nothing is closed", async () => {
  await seed();
  const sent = [];
  watch._reset();
  let clock = NOW;
  watch.__setDeps({
    now: () => clock,
    mp: () => ({
      eldoradoOrders: async ({ orderState }) => (orderState === "Canceled" ? [{ id: "eld-cancel-1" }] : []),
      g2gOrder: async () => ({ purchased_qty: 1, delivered_qty: 1, refunded_qty: 0, status: "completed" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 1);
  assert.match(sent[0], /Eldorado eld-canc is CANCELED \(buyer JumpyPage\) — Overwatch 365d — still farming: buyer1/);
  const row = await FarmServiceOrder.findOne({ orderId: "eld-cancel-1" }).lean();
  assert.equal(row.state, "delivered", "never closed automatically");
  // Same hour again: quiet; a day later: reminded.
  clock += 3600000;
  await watch.checkOnce();
  assert.equal(sent.length, 1);
  clock += 24 * 3600000;
  await watch.checkOnce();
  assert.equal(sent.length, 2);
  watch._reset();
});

test("a G2G order with a refunded quantity pages; an unreadable list is a note, not an alarm", async () => {
  await seed();
  const sent = [];
  watch._reset();
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({
      eldoradoOrders: async () => { throw new Error("401"); },
      g2gOrder: async () => ({ purchased_qty: 1, delivered_qty: 1, refunded_qty: 1 }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 1);
  assert.match(sent[0], /G2G 777 is REFUNDED \(1\)/);
  assert.equal(r.notes.length, 2, "both Eldorado lists noted as unreadable");
  watch._reset();
});

test("closing an order ends its windows (renterExpiry then pulls the accounts) and is idempotent", async () => {
  await seed();
  const res = await fetch(baseUrl + "/renters/farm-orders/eld-cancel-1/close", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ reason: "refunded on Eldorado" }),
  });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.ended, 1);
  const acc = await RenterAccount.findOne({ clientSecret: "c1" }).lean();
  assert.ok(acc.farmUntil <= new Date(), "window ended now");
  const row = await FarmServiceOrder.findOne({ orderId: "eld-cancel-1" }).lean();
  assert.equal(row.state, "cancelled");
  const again = await (await fetch(baseUrl + "/renters/farm-orders/eld-cancel-1/close", {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
  })).json();
  assert.equal(again.already, true);
});

test("REGRESSION: every farm service treats a cancelled row as closed (never provisions it)", () => {
  for (const f of ["eldoradoFarmService.js", "g2gFarmService.js", "playerauctionsFarmService.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "utils", f), "utf8");
    assert.match(src, /if \(row && \(row\.state === "delivered" \|\| row\.state === "cancelled"\)\) \{/, f);
  }
});
