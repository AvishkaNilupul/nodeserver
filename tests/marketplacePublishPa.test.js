// The failure this file exists to prevent: S5 of
// docs/ACCOUNT-LISTINGS-FIXES-3.md — THE PLAYERAUCTIONS BRANCH PUBLISHED A LIVE
// OFFER WITH NO STOCK BEHIND IT.
//
// The branch added in round 1 published a real PlayerAuctions Item offer for a
// DropSet-backed listing and then wrote a MarketplaceListing with no units[],
// no autoClaimSet and no reservation — neither of the two stock modes
// utils/playerauctionsFulfiller understands for an archive-backed row
// (:935 skips it as a "manual-delivery listing", :943 is the archive claim). So
// every PAID order against it was skipped undelivered while the offer stayed
// live at full quantity and more buyers kept paying.
//
// The fix gives it the real archive mode (claim at delivery, quantity clamped
// to what the archive can actually hand over) and refuses rather than publish
// an offer nothing can fill. An OFFER-backed PlayerAuctions publish keeps its
// own ledger stock and must be untouched.
//
// Real router, real Mongo (mongodb-memory-server): only the PlayerAuctions API
// call and the archive stock count are stubbed.
process.env.CRED_SECRET ||= "marketplace-publish-pa-test-cred-secret";
process.env.SESSION_SECRET ||= "marketplace-publish-pa-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const supplied = require("../utils/suppliedStock");
const mp = require("../utils/marketplaces");
const paFulfiller = require("../utils/playerauctionsFulfiller");

let mem;
let server;
let baseUrl;
let cookie;
const calls = { pa: [], stockFor: [] };
let archiveStock = 0;

const real = {
  paPublish: mp.playerauctionsPublish,
  paStockFor: paFulfiller.stockFor,
};

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("marketplace-publish-pa"));

  mp.playerauctionsPublish = async (args) => {
    calls.pa.push(args);
    return {
      offerId: "pa-" + calls.pa.length,
      id: "pa-" + calls.pa.length,
      url: "https://playerauctions.com/pa-" + calls.pa.length,
      raw: {},
    };
  };
  // The real one runs an availableAccountsForSet aggregation over the Drop
  // Archive; what matters here is that the route asks it BEFORE publishing and
  // believes the answer.
  paFulfiller.stockFor = async (listing) => {
    calls.stockFor.push(listing);
    return archiveStock;
  };

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/session", (req, res) => {
    req.session.admin = {
      id: "root",
      username: "root",
      role: "superadmin",
      tfa: true,
    };
    res.json({ success: true });
  });
  app.use(require("../routes/marketplaceRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers
    .get("set-cookie")
    .split(";")[0];
});

test.after(async () => {
  mp.playerauctionsPublish = real.paPublish;
  paFulfiller.stockFor = real.paStockFor;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function publish(body) {
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "Rocket League drops bundle",
      description: "Instant delivery",
      price: 12,
      marketplaces: ["playerauctions"],
      ...body,
    }),
  });
  const json = await res.json();
  assert.equal(json.success, true);
  return json.results.playerauctions;
}

test("S5: an archive-backed PlayerAuctions offer is published with a stock mode the fulfiller understands", async () => {
  const set = await DropSet.create({
    name: "Rocket League drops bundle",
    price: 12,
    coverGame: "Rocket League",
  });
  archiveStock = 5;
  calls.pa.length = 0;

  const r = await publish({
    setId: String(set._id),
    playerauctions: { quantity: 3, game: "Rocket League" },
  });

  assert.equal(r.success, true);
  const row = await MarketplaceListing.findById(r.id).lean();
  // The whole point: without this the row had no units, no autoClaimSet and no
  // reservation, so deliverOrder skipped every paid order as a
  // "manual-delivery listing".
  assert.equal(row.autoClaimSet, true);
  assert.equal(String(row.set), String(set._id));
  assert.equal(row.accountOffer, null);
  assert.equal(row.externalId, "pa-" + calls.pa.length);
  assert.equal(row.qtyTarget, 3);
  assert.equal(calls.pa[0].totalUnit, 3);
});

test("S5: the advertised quantity is clamped to what the archive can actually hand over", async () => {
  const set = await DropSet.create({ name: "Short bundle", price: 12 });
  archiveStock = 2;
  calls.pa.length = 0;

  const r = await publish({
    setId: String(set._id),
    playerauctions: { quantity: 9, game: "Rocket League" },
  });

  assert.equal(r.success, true);
  // Nine units advertised over two deliverable accounts is seven buyers who
  // have paid for nothing.
  assert.equal(calls.pa[0].totalUnit, 2);
  const row = await MarketplaceListing.findById(r.id).lean();
  assert.equal(row.qtyTarget, 2);
});

test("S5: an empty archive is refused instead of published", async () => {
  const set = await DropSet.create({ name: "Empty bundle", price: 12 });
  archiveStock = 0;
  calls.pa.length = 0;

  const r = await publish({
    setId: String(set._id),
    playerauctions: { quantity: 4, game: "Rocket League" },
  });

  assert.equal(r.success, false);
  assert.match(r.message, /Out of stock/i);
  // Nothing reached PlayerAuctions and no row was written: a live offer that
  // cannot be filled is worse than no offer.
  assert.equal(calls.pa.length, 0);
  assert.equal(await MarketplaceListing.countDocuments({ set: set._id }), 0);
});

test("S5: an offer-backed PlayerAuctions publish still works and never consults the archive", async () => {
  const offer = await AccountOffer.create({
    title: "Twitch drops account",
    game: "Rocket League",
    priceUsd: 12,
    status: "active",
  });
  const added = await supplied.addAccounts(
    String(offer._id),
    ["pa_supplied_1:pw1", "pa_supplied_2:pw2"].join("\n"),
  );
  assert.equal(added.added, 2);
  archiveStock = 0;
  calls.pa.length = 0;
  calls.stockFor.length = 0;

  const r = await publish({
    offerId: String(offer._id),
    playerauctions: { quantity: 2, game: "Rocket League" },
  });

  assert.equal(r.success, true);
  // The ledger is this row's stock; asking the archive would have refused a
  // perfectly stocked account listing on an empty-archive answer.
  assert.equal(calls.stockFor.length, 0);
  assert.equal(calls.pa[0].totalUnit, 2);
  const row = await MarketplaceListing.findById(r.id).lean();
  assert.equal(row.autoClaimSet, false);
  assert.equal(String(row.accountOffer), String(offer._id));
  assert.equal(row.set, null);
  assert.equal(row.origin, "manual");
  // Claim-at-sale market: the accounts stay on the shelf until an order lands.
  assert.equal(await supplied.stockFor(String(offer._id)), 2);
});

test("S5: the no-claim refusal still fires before anything is published", async () => {
  const set = await DropSet.create({ name: "OW bundle", price: 12 });
  archiveStock = 9;
  calls.pa.length = 0;

  const r = await publish({
    setId: String(set._id),
    playerauctions: { quantity: 1, game: "Overwatch 2" },
  });

  assert.equal(r.success, false);
  assert.match(r.message, /no-claim game/i);
  assert.equal(calls.pa.length, 0);
});
