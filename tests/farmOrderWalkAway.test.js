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
  await RenterAccount.create({ renter: holder._id, clientSecret: "c3", login: "g2gbuyer", host: "contabo", configFile: "config_02.json", farmUntil: new Date(NOW + 100 * 86400000) });
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
  assert.match(sent[0], /Eldorado order eld-cancel-1 is CANCELED \(buyer JumpyPage\) — Overwatch 365d — still farming: Buyer1/);
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
  assert.match(sent[0], /G2G order g2g:777 is REFUNDED \(1\)/);
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

// ---- review 3 (2026-10-01) ----------------------------------------------
test("REGRESSION: a failed read does not re-arm the daily latch (no re-page of every order next hour)", async () => {
  await seed();
  const sent = [];
  watch._reset();
  let clock = NOW;
  let eldDown = false;
  watch.__setDeps({
    now: () => clock,
    mp: () => ({
      eldoradoOrders: async ({ orderState }) => {
        if (eldDown) throw new Error("503");
        return orderState === "Canceled" ? [{ id: "eld-cancel-1" }] : [];
      },
      g2gOrder: async () => ({ purchased_qty: 1, delivered_qty: 1, refunded_qty: 0, order_item_status: "completed" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  await watch.checkOnce({ force: true });
  assert.equal(sent.length, 1);
  clock += 3600000;
  eldDown = true;
  await watch.checkOnce(); // unreadable: the order is simply not seen this hour
  eldDown = false;
  clock += 3600000;
  await watch.checkOnce();
  assert.equal(sent.length, 1, "the latch from the first page still holds");
  watch._reset();
});

test("REGRESSION: an order whose windows already ENDED is not paged (nothing left to stop)", async () => {
  const holder = await seed();
  await RenterAccount.updateOne({ renter: holder._id, login: "Buyer1" }, { $set: { farmEndedAt: new Date(NOW - 86400000), enabled: false } });
  const sent = [];
  watch._reset();
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({
      eldoradoOrders: async ({ orderState }) => (orderState === "Canceled" ? [{ id: "eld-cancel-1" }] : []),
      g2gOrder: async () => ({ refunded_qty: 0, order_item_status: "completed" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 0);
  assert.equal(sent.length, 0);
  watch._reset();
});

test("G2G's own status field (order_item_status) is read", async () => {
  await seed();
  const sent = [];
  watch._reset();
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({
      eldoradoOrders: async () => [],
      g2gOrder: async () => ({ refunded_qty: 0, order_item_status: "cancelled" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 1);
  assert.match(sent[0], /G2G order g2g:777 is CANCELLED/);
  watch._reset();
});

test("a huge batch stays under Telegram's message limit", async () => {
  const holder = await seed();
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const logins = Array.from({ length: 30 }, (_, j) => "bulk" + i + "x" + j + "-averyveryverylongloginname");
    await FarmServiceOrder.create({
      orderId: "eld-bulk-" + i + "-0000-1111-2222-333333333333", market: "eldorado", buyerUsername: "BulkBuyer" + i,
      game: "Overwatch", days: 30, state: "delivered", accounts: logins.map((l) => ({ login: l })),
    });
    for (const l of logins.slice(0, 8)) {
      await RenterAccount.create({ renter: holder._id, clientSecret: "s-" + l, login: l, host: "contabo", configFile: "config_02.json", farmUntil: new Date(NOW + 9e9) });
    }
    ids.push({ id: "eld-bulk-" + i + "-0000-1111-2222-333333333333" });
  }
  const sent = [];
  watch._reset();
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({ eldoradoOrders: async ({ orderState }) => (orderState === "Canceled" ? ids : []), g2gOrder: async () => ({}) }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  await watch.checkOnce({ force: true });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 3800, "length " + sent[0].length);
  assert.match(sent[0], /\+3 more/, "logins per order are capped");
  watch._reset();
});

test("REGRESSION: closing an OLD order leaves a re-sold login farming for its NEWER order", async () => {
  const holder = await seed();
  // Buyer1's account was recycled and sold again under a newer order.
  await FarmServiceOrder.create({
    orderId: "eld-newer-9", market: "eldorado", game: "Overwatch", days: 30, state: "delivered",
    accounts: [{ login: "BUYER1" }], createdAt: new Date(Date.now() + 1000),
  });
  const res = await fetch(baseUrl + "/renters/farm-orders/eld-cancel-1/close", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ reason: "refunded" }),
  });
  const d = await res.json();
  assert.equal(res.status, 200, JSON.stringify(d));
  assert.equal(d.ended, 0);
  assert.match(d.keptForNewer.join(" "), /buyer1 \(now order eld-newer-9\)/);
  const row = await RenterAccount.findOne({ renter: holder._id, login: "Buyer1" }).lean();
  assert.ok(new Date(row.farmUntil) > new Date(), "the newer buyer keeps farming");
});

test("closing ends EVERY live holder row of a login (duplicates included)", async () => {
  const holder = await seed();
  await RenterAccount.create({ renter: holder._id, clientSecret: "c1b", login: "buyer1", host: "contabo", configFile: "config_03.json", farmUntil: new Date(NOW + 300 * 86400000) });
  const res = await fetch(baseUrl + "/renters/farm-orders/eld-cancel-1/close", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  });
  const d = await res.json();
  assert.equal(d.ended, 2);
});

// ---- review 5 (2026-10-01) ----------------------------------------------
test("REGRESSION: a page recorded before a restart still holds the day (SystemEvent.at)", async () => {
  await seed();
  const SystemEvent = require("../models/SystemEvent");
  await SystemEvent.deleteMany({});
  await SystemEvent.create({
    category: "marketplace", action: "farm_order_walked_away_page", actor: "farmOrderWatch",
    subject: "eld-cancel-1|CANCELED", at: new Date(NOW - 3600000),
  });
  const sent = [];
  watch._reset(); // a fresh process
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({
      eldoradoOrders: async ({ orderState }) => (orderState === "Canceled" ? [{ id: "eld-cancel-1" }] : []),
      g2gOrder: async () => ({ refunded_qty: 0, order_item_status: "completed" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 0, "paged an hour before the restart: not again today");
  await SystemEvent.deleteMany({});
  watch._reset();
});

test("REGRESSION: an old cancelled order whose login was SOLD AGAIN is not paged (the newer buyer owns it)", async () => {
  await seed();
  await FarmServiceOrder.create({
    orderId: "eld-newer-2", market: "eldorado", game: "Overwatch", days: 30, state: "delivered",
    accounts: [{ login: "Buyer1" }], createdAt: new Date(Date.now() + 1000),
  });
  const sent = [];
  watch._reset();
  watch.__setDeps({
    now: () => NOW,
    mp: () => ({
      eldoradoOrders: async ({ orderState }) => (orderState === "Canceled" ? [{ id: "eld-cancel-1" }] : []),
      g2gOrder: async () => ({ refunded_qty: 0, order_item_status: "completed" }),
    }),
    sendTelegram: async (m) => sent.push(m),
    logEvent: () => {},
  });
  const r = await watch.checkOnce({ force: true });
  assert.equal(r.paged, 0);
  assert.equal(sent.length, 0);
  watch._reset();
});
