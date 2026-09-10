/* global fetch */
// The failure this file exists to prevent: a live G2G offer assembled from TWO
// different games (F4 of docs/ACCOUNT-LISTINGS-FIXES.md).
//
// On G2G the brand IS the game, and the product under it supplies relation_id
// and the required offer attributes. POST /marketplaces/publish merged the two
// sources field by field — `g.brandId || cat.brandId`, `productId: g.productId`
// — so a body carrying only the product the owner drilled to (which is all the
// modal ever sent) went live under the AUTO-RESOLVED brand while carrying
// another game's product. The offer that reaches a buyer is then filed under a
// game it is not, which is the same class of failure as the Siege bundles that
// ended up under Rainbow Six Mobile.
//
// So the placement is one unit: all of the owner's pick, or none of it. These
// tests run the real router against mongodb-memory-server with only
// mp.g2gPublish stubbed, so what is asserted is exactly the argument object a
// live publish would send to G2G.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "marketplace-publish-g2g-test-secret";

const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const { resolveCategory } = require("../utils/listingCategory");

let mongod;
let server;
let baseUrl;
let cookie;
let setId;
let sent; // the last argument object mp.g2gPublish was called with
const realG2gPublish = mp.g2gPublish;

// A game utils/g2gGames really maps (the resolver answers from the static
// catalog, so no network and no stub) and one it deliberately calls
// NOT_LISTABLE — the case where drilling by hand is the ONLY way to publish.
const AUTO_GAME = "Rocket League";
const UNLISTABLE_GAME = "Overwatch 2";

// What the owner drilled to in the modal: a different game's service, brand,
// product and product attributes, sent together as F3's picker now does.
const PICK = {
  serviceId: "svc-picked-by-owner",
  brandId: "lgc_game_picked_by_owner",
  productId: "prod-picked-by-owner",
  offerAttributes: [
    { attribute_group_id: "grp-1", attribute_id: "attr-1" },
  ],
};

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("marketplace-publish-g2g-test"));

  // Stubbed on the shared module object the router already holds, so the
  // route's own `mp.g2gPublish(...)` lookup finds it. No live G2G call, and
  // the returned shape is what the real one answers.
  mp.g2gPublish = async (args) => {
    sent = args;
    return { externalId: "g2g-offer-1", url: "https://www.g2g.com/offer/1" };
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

  const set = await DropSet.create({ name: "Drops bundle", price: 12 });
  setId = String(set._id);
});

test.after(async () => {
  mp.g2gPublish = realG2gPublish;
  if (server) await new Promise((r) => server.close(r));
  // The route logs through logEvent without awaiting it, so let those writes
  // land before the connection goes away.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function publish(g2g, game = AUTO_GAME) {
  sent = null;
  const body = {
    setId,
    marketplaces: ["g2g"],
    game,
    title: "Twitch drops account",
    description: "Instant delivery",
    price: 12,
  };
  if (g2g) body.g2g = g2g;
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()).results.g2g;
}

test("REGRESSION: a product with no picked brand never mixes two games", async () => {
  // Exactly what the modal sent before F3: the owner drilled to a product,
  // nothing said which game it belongs to. The resolved brand must not be
  // paired with it — g2gPublish resolves the relation and the required
  // attributes from the brand itself (utils/marketplaces.js:3019-3024).
  const r = await publish({
    productId: "prod-from-another-game",
    offerAttributes: [{ attribute_group_id: "g", attribute_id: "a" }],
    qty: 2,
  });
  assert.equal(r.success, true);
  const auto = await resolveCategory("g2g", AUTO_GAME);
  assert.equal(auto.ok, true);
  assert.equal(sent.brandId, auto.value.brandId);
  assert.equal(sent.serviceId, auto.value.serviceId);
  assert.equal(sent.productId, undefined);
  assert.equal(sent.offerAttributes, undefined);
  assert.equal(sent.deliveryMethodIds, undefined);
  // Everything that is not part of the placement still goes through.
  assert.equal(sent.qty, 2);
});

test("an explicit G2G pick beats the auto-resolved brand", async () => {
  const r = await publish({ ...PICK, qty: 1 });
  assert.equal(r.success, true);
  const auto = await resolveCategory("g2g", AUTO_GAME);
  assert.equal(auto.ok, true);
  // The owner's whole quartet, and not one field of the resolution.
  assert.equal(sent.serviceId, PICK.serviceId);
  assert.equal(sent.brandId, PICK.brandId);
  assert.equal(sent.productId, PICK.productId);
  assert.deepEqual(sent.offerAttributes, PICK.offerAttributes);
  assert.notEqual(sent.brandId, auto.value.brandId);
  assert.notEqual(sent.serviceId, auto.value.serviceId);
});

test("a pick publishes a game the resolver refuses to place", async () => {
  // brandForGame() calls Overwatch NOT_LISTABLE on purpose, so without a pick
  // this market is refused (and must stay refused — picking "the nearest
  // brand" is how a bundle lands on another game's shelf).
  const refused = await publish(null, UNLISTABLE_GAME);
  assert.equal(refused.success, false);
  assert.match(refused.message, /does not list/i);
  assert.equal(sent, null);

  const r = await publish({ ...PICK }, UNLISTABLE_GAME);
  assert.equal(r.success, true);
  assert.equal(sent.brandId, PICK.brandId);
  assert.equal(sent.productId, PICK.productId);
});

test("with nothing picked the resolved placement still publishes alone", async () => {
  const r = await publish(null);
  assert.equal(r.success, true);
  const auto = await resolveCategory("g2g", AUTO_GAME);
  assert.equal(sent.brandId, auto.value.brandId);
  assert.equal(sent.serviceId, auto.value.serviceId);
  assert.equal(sent.productId, undefined);
  // The row that records the offer is written either way.
  const row = await MarketplaceListing.findById(r.id).lean();
  assert.equal(row.marketplace, "g2g");
  assert.equal(row.externalId, "g2g-offer-1");
});
