/* global fetch */
// Plati and GGSel are BLOCKED by the owner (2026-09-28): both seller accounts
// are blocked, and the owner asked for "a block on those two — no listing and
// no accounts spent there — until they are fixed". The automatic listers honour
// the switches (tests/platiOffSwitch.test.js); this pins the manual side: the
// Listings page publish and the manual Plati content upload must refuse a
// switched-off market BEFORE any account is claimed or any platform is called.
process.env.CRED_SECRET ||= "market-block-publish-test-cred-secret";
process.env.SESSION_SECRET ||= "market-block-publish-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const mp = require("../utils/marketplaces");

let mem;
let server;
let baseUrl;
let cookie;
const calls = [];
const open = { digiseller: false, ggsel: false };

const real = {
  dsTakes: mp.digisellerTakesNewStock,
  ggTakes: mp.ggselTakesNewStock,
  dsPublish: mp.digisellerPublish,
  dsAdd: mp.digisellerAddContent,
  ggPublish: mp.ggselPublish,
};

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("market-block-publish"));
  mp.digisellerTakesNewStock = () => open.digiseller;
  mp.ggselTakesNewStock = () => open.ggsel;
  mp.digisellerPublish = async (a) => {
    calls.push(["digisellerPublish", a && a.title]);
    throw new Error("the platform must not be called");
  };
  mp.digisellerAddContent = async (id) => {
    calls.push(["digisellerAddContent", id]);
    throw new Error("the platform must not be called");
  };
  mp.ggselPublish = async (a) => {
    calls.push(["ggselPublish", a && a.title]);
    throw new Error("the platform must not be called");
  };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(require("../routes/marketplaceRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  Object.assign(mp, {
    digisellerTakesNewStock: real.dsTakes,
    ggselTakesNewStock: real.ggTakes,
    digisellerPublish: real.dsPublish,
    digisellerAddContent: real.dsAdd,
    ggselPublish: real.ggPublish,
  });
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test("publishing to a blocked Plati or GGSel is refused per market, before anything is claimed", async () => {
  const set = await DropSet.create({ name: "Rocket League drops bundle", price: 3, coverGame: "Rocket League" });
  calls.length = 0;
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      setId: String(set._id),
      title: "Rocket League drops bundle",
      description: "Instant delivery",
      price: 3,
      marketplaces: ["digiseller", "ggsel"],
      digiseller: { categoryId: "34187", qty: 2 },
      ggsel: { categoryId: "32450", qty: 2 },
    }),
  });
  const json = await res.json();
  assert.equal(json.success, true, "the request itself is answered per market");
  assert.equal(json.results.digiseller.success, false);
  assert.match(json.results.digiseller.message, /Plati is blocked/);
  assert.equal(json.results.ggsel.success, false);
  assert.match(json.results.ggsel.message, /GGSel is blocked/);
  assert.deepEqual(calls, [], "neither platform is called");
  assert.equal(await MarketplaceListing.countDocuments({}), 0, "no listing row is created");
});

test("a manual Plati content upload is refused while Plati is blocked", async () => {
  const row = await MarketplaceListing.create({
    marketplace: "digiseller",
    externalId: "6100009",
    status: "active",
    origin: "manual",
    title: "t",
    price: 2,
    set: new mongoose.Types.ObjectId(),
  });
  calls.length = 0;
  const res = await fetch(baseUrl + "/marketplaces/listings/" + row._id + "/content", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ lines: ["Login: a\nPassword: b"] }),
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.match(json.message, /Plati is blocked/);
  assert.deepEqual(calls, []);
});
