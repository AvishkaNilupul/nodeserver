/* global fetch */
// The two owner buttons that can end a Gameflip no-claim unit by hand, run
// through the real routers:
//
//   DELETE /marketplaces/listings/:id          (the Listings page's Delist)
//   POST   /noclaim-stock/ledgers/:id/release  (hand a committed account back)
//
// A Gameflip no-claim listing carries a whole account's login in its delivery
// code, and Gameflip answers a take-down with 200 under its rate limiter and
// changes nothing. So neither button may believe its own call:
//   - Delist marks the row delisted, and hands its account back, only once
//     Gameflip no longer HAS the listing. Before, the row went "delisted" on
//     the 200, the account went back to stock, and the listing stayed buyable;
//   - an AUTO-FARM account (sold whole wherever it is free) is handed back by
//     hand only on Gameflip's own word too — and where nobody can ask (its
//     listing row is missing, it was never attached to one) only when the
//     owner says they looked: `confirmGone: true`.
//
// Real routers, real Mongo (mongodb-memory-server), real claim layer; only the
// outbound Gameflip calls are stubbed.
process.env.CRED_SECRET ||= "noclaim-gameflip-routes-test-cred-secret";
process.env.SESSION_SECRET ||= "noclaim-gameflip-routes-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const AvailableAccount = require("../models/AvailableAccount");
const DropSet = require("../models/DropSet");
const mp = require("../utils/marketplaces");
const settings = require("../utils/settings");

let mem;
let server;
let baseUrl;
let cookie;

// What Gameflip holds, per listing id: a status, or absent = it 404s.
const gameflip = new Map();
const calls = { status: [], end: [], delist: [] };
// How the next take-downs behave: "ok" deletes; "swallow" answers and changes
// nothing (the limiter); "limited" refuses outright.
let endMode = "ok";

const real = {
  gameflipListingStatus: mp.gameflipListingStatus,
  gameflipEndListing: mp.gameflipEndListing,
  gameflipDelist: mp.gameflipDelist,
  getNoclaimShopSettings: settings.getNoclaimShopSettings,
};

function http(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("noclaim-gameflip-routes"));

  mp.gameflipListingStatus = async (id) => {
    calls.status.push(id);
    if (!gameflip.has(id)) throw http(404, 'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}');
    const st = gameflip.get(id);
    if (st instanceof Error) throw st;
    return st;
  };
  mp.gameflipEndListing = async (id, opts) => {
    calls.end.push([id, opts && opts.status]);
    if (endMode === "limited") throw http(429, "Gameflip end listing (off sale): Too many attempts - Retry later");
    if (endMode === "swallow") throw http(409, "Gameflip end listing: " + id + " still exists after the delete");
    gameflip.delete(id);
    return { deleted: true, confirmed: true };
  };
  mp.gameflipDelist = async (id) => {
    calls.delist.push(id);
    gameflip.delete(id);
  };
  settings.getNoclaimShopSettings = () => ({ enabled: true, autoDeliver: true });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(require("../routes/marketplaceRoutes"));
  app.use(require("../routes/noclaimStockRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  Object.assign(mp, {
    gameflipListingStatus: real.gameflipListingStatus,
    gameflipEndListing: real.gameflipEndListing,
    gameflipDelist: real.gameflipDelist,
  });
  settings.getNoclaimShopSettings = real.getNoclaimShopSettings;
  if (server) await new Promise((r) => server.close(r));
  // The routes log through logEvent without awaiting it; let those writes land.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(() => {
  gameflip.clear();
  calls.status.length = 0;
  calls.end.length = 0;
  calls.delist.length = 0;
  endMode = "ok";
});

let seq = 0;
// One Gameflip no-claim listing with its one account, on sale.
//   farm: "" = a no-claim bot's account, "autofarm" = an auto-farm account
//   held for the unit (the stamps and the pool note of a hold).
async function unit({ farm = "", attached = true, rowStatus = "active" } = {}) {
  const n = ++seq;
  const login = "gfacct" + n;
  const ext = "gf-live-" + n;
  const set = await DropSet.create({
    name: "Brawl bundle " + n,
    stockSource: "noclaim",
    coverGame: "Brawlhalla",
    items: [{ itemKey: "a|brawlhalla", name: "A", game: "Brawlhalla", qty: 1 }],
  });
  const pool = await AvailableAccount.create({
    username: login,
    usernameLower: login,
    status: "claimed",
    claimedNote: farm ? "unclaimed sale pending — gameflip" : "no-claim farm",
    listed: true,
  });
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: ext,
    title: "Brawlhalla Twitch Drops (1 Item)",
    price: 1.09,
    status: rowStatus,
    origin: "manual",
    noclaimStock: true,
    autoDeliver: true,
    accountId: "",
    accountLogin: login,
    units: [{ contentId: "", accountId: "", login, addedAt: new Date(), deliveredAt: null, orderId: "" }],
  });
  const ledger = await UnclaimedAccount.create({
    source: "noclaim",
    login,
    loginLower: login,
    game: "Brawlhalla",
    poolAccountId: String(pool._id),
    farm,
    status: "manual",
    market: "gameflip",
    set: set._id,
    manualListing: attached ? String(row._id) : "",
    manualAt: new Date(Date.now() - 60 * 60 * 1000),
    manualPriorStatus: "",
    note: "manual no-claim listing — gameflip",
    farmPoolNote: farm ? "auto-farm: Brawlhalla (c-" + n + ")" : "",
    drops: [{ name: "A", game: "Brawlhalla", itemKey: "a|brawlhalla" }],
  });
  gameflip.set(ext, "onsale");
  return { set, pool, row, ledger, login, ext };
}

const delist = async (row) => {
  const res = await fetch(baseUrl + "/marketplaces/listings/" + row._id, { method: "DELETE", headers: { Cookie: cookie } });
  return { status: res.status, body: await res.json() };
};
const release = async (ledger, body) => {
  const res = await fetch(baseUrl + "/noclaim-stock/ledgers/" + ledger._id + "/release", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
};
const rowNow = (u) => MarketplaceListing.findById(u.row._id).lean();
const ledgerNow = (u) => UnclaimedAccount.findById(u.ledger._id).lean();
const poolNow = (u) => AvailableAccount.findById(u.pool._id).lean();

// ---------------------------------------------------------------------------
// Delist
// ---------------------------------------------------------------------------

test("Delist: the listing really comes down on Gameflip, then the row is delisted and its account handed back", async () => {
  const u = await unit();
  const r = await delist(u.row);
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.noclaim, { released: 1, sold: 0 });
  // Ended from the status just read; Gameflip's own 404 is the proof.
  assert.deepEqual(calls.end, [[u.ext, "onsale"]]);
  assert.deepEqual(calls.delist, [], "not the unverified patch-then-delete");
  assert.equal(gameflip.has(u.ext), false);
  assert.equal((await rowNow(u)).status, "delisted");
  assert.equal(await ledgerNow(u), null, "a claim made straight from stock is simply dropped");
});

test("Delist: Gameflip answered and changed nothing — NOT delisted, the account is NOT handed back", async () => {
  for (const mode of ["swallow", "limited"]) {
    endMode = mode;
    const u = await unit();
    const r = await delist(u.row);
    assert.equal(r.body.success, false, mode);
    assert.match(r.body.message, /Gameflip still has this listing \("onsale"\) — NOT taken down yet/, mode);
    assert.equal(gameflip.get(u.ext), "onsale", "a buyer can still pay for it");
    const row = await rowNow(u);
    assert.equal(row.status, "active", "the row keeps saying what is true: it is on sale");
    assert.match(row.lastError, /NOT taken down yet/);
    const led = await ledgerNow(u);
    assert.equal(led.status, "manual", "its login is still in a live listing: never back to stock");
    // …and the same click a little later, once the limiter lets go, finishes it.
    endMode = "ok";
    const again = await delist(u.row);
    assert.equal(again.body.success, true, mode);
    assert.equal((await rowNow(u)).status, "delisted");
    assert.equal(await ledgerNow(u), null);
  }
});

test("Delist: Gameflip would not answer at all — nothing is changed", async () => {
  const u = await unit();
  gameflip.set(u.ext, http(429, "Gameflip listing status: Too many attempts - Retry later"));
  const r = await delist(u.row);
  assert.equal(r.body.success, false);
  assert.match(r.body.message, /Gameflip did not answer, so nothing was changed/);
  assert.deepEqual(calls.end, [], "an unread listing is never touched");
  assert.equal((await rowNow(u)).status, "active");
  assert.equal((await ledgerNow(u)).status, "manual");
});

test("Delist: an error that only SAYS 'not found' is not a 404 — the listing is not called gone", async () => {
  const u = await unit();
  gameflip.set(u.ext, http(401, 'Gameflip listing status: {"error":{"message":"Api key not found"}}'));
  const r = await delist(u.row);
  assert.equal(r.body.success, false, JSON.stringify(r.body));
  assert.equal((await rowNow(u)).status, "active");
  assert.equal((await ledgerNow(u)).status, "manual", "handed back on those words, it was sold twice");
});

test("Delist: a listing that already SOLD is booked as the sale it is", async () => {
  const u = await unit();
  gameflip.set(u.ext, "sold");
  const r = await delist(u.row);
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.match(r.body.message, /Already sold on the marketplace/);
  assert.deepEqual(r.body.noclaim, { released: 0, sold: 1 });
  assert.deepEqual(calls.end, [], "a sold listing is never deleted");
  assert.equal((await rowNow(u)).status, "sold");
  const led = await ledgerNow(u);
  assert.equal(led.status, "sold");
  assert.equal(led.soldMarket, "gameflip");
});

test("Delist: a buyer in the middle of paying — not taken down, not handed back", async () => {
  const u = await unit();
  gameflip.set(u.ext, "sale_pending");
  const r = await delist(u.row);
  assert.equal(r.body.success, false);
  assert.match(r.body.message, /still has this listing \("sale_pending"\)/);
  assert.deepEqual(calls.end, []);
  assert.equal((await rowNow(u)).status, "active");
  assert.equal((await ledgerNow(u)).status, "manual");
});

test("Delist: an AUTO-FARM account goes back with Gameflip's 404 as its proof — note and listed tick restored", async () => {
  const u = await unit({ farm: "autofarm" });
  const r = await delist(u.row);
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.noclaim, { released: 1, sold: 0 });
  assert.equal(await ledgerNow(u), null);
  const pool = await poolNow(u);
  assert.equal(pool.claimedNote, "auto-farm: Brawlhalla (c-" + seq + ")", "still in its bot: the note it carried");
  assert.equal(pool.listed, false);
  // Read once, ended with its own proof — and the release goes on that:
  // Gameflip is not asked again.
  assert.equal(calls.status.length, 1);
});

test("Delist: an ordinary (archive) Gameflip listing takes the path it always took", async () => {
  const set = await DropSet.create({ name: "Archive set", coverGame: "X", items: [{ itemKey: "x|x", name: "X", game: "X", qty: 1 }] });
  const row = await MarketplaceListing.create({ set: set._id, marketplace: "gameflip", externalId: "gf-arch-1", title: "T", price: 2, status: "active", origin: "manual" });
  gameflip.set("gf-arch-1", "onsale");
  const r = await delist(row);
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.deepEqual(calls.delist, ["gf-arch-1"]);
  assert.deepEqual(calls.end, []);
  assert.deepEqual(calls.status, [], "no extra Gameflip reads for a row that is not a no-claim one");
  assert.equal((await MarketplaceListing.findById(row._id).lean()).status, "delisted");
});

// ---------------------------------------------------------------------------
// Hand release
// ---------------------------------------------------------------------------

test("hand release: a no-claim bot's committed account is released as before", async () => {
  const u = await unit({ rowStatus: "delisted" });
  const r = await release(u.ledger);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, released: 1 });
  assert.equal(await ledgerNow(u), null);
  assert.deepEqual(calls.status, [], "that farm's rule is untouched: Gameflip is not asked");
});

test("hand release: an auto-farm account whose Gameflip listing still exists is refused — and says why", async () => {
  const u = await unit({ farm: "autofarm", rowStatus: "delisted" });
  // Our row says delisted; Gameflip still has the listing.
  let r = await release(u.ledger);
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.match(r.body.message, /Not released — its Gameflip listing still exists \(onsale\)/);
  assert.equal(r.body.needsConfirm, false);
  // The owner's word does not outweigh Gameflip's: this is not theirs to lift.
  r = await release(u.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /still exists \(onsale\)/);
  assert.equal((await ledgerNow(u)).status, "manual");
  // Sold on Gameflip: never stock.
  gameflip.set(u.ext, "sold");
  r = await release(u.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /SOLD/);
  // Gone on Gameflip: released, no confirmation needed.
  gameflip.delete(u.ext);
  r = await release(u.ledger);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, released: 1 });
  assert.equal(await ledgerNow(u), null);
  assert.equal((await poolNow(u)).claimedNote, "auto-farm: Brawlhalla (c-" + seq + ")");
});

test("hand release: where nobody can ask Gameflip, only the owner's own look lifts the hold", async () => {
  // Its listing row is gone — nothing says which listing held its login.
  const lost = await unit({ farm: "autofarm", rowStatus: "delisted" });
  await MarketplaceListing.deleteOne({ _id: lost.row._id });
  let r = await release(lost.ledger);
  assert.equal(r.status, 409, "never the silent `success, released 0` this used to answer");
  assert.equal(r.body.needsConfirm, true);
  assert.match(r.body.message, /Not released — its listing row is missing\. Check gameflip for a listing carrying this account, delete it, then send this again with \{ "confirmGone": true \}/);
  assert.equal((await ledgerNow(lost)).status, "manual");
  r = await release(lost.ledger, { confirmGone: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, released: 1 });
  assert.equal(await ledgerNow(lost), null);
  assert.equal((await poolNow(lost)).claimedNote, "auto-farm: Brawlhalla (c-" + seq + ")");

  // Never attached to a row (its publish never recorded one).
  const loose = await unit({ farm: "autofarm", attached: false, rowStatus: "delisted" });
  r = await release(loose.ledger);
  assert.equal(r.status, 409);
  assert.equal(r.body.needsConfirm, true);
  assert.match(r.body.message, /it is attached to no listing row/);
  // "confirmGone" must be exactly true — a truthy string is not the owner's word.
  r = await release(loose.ledger, { confirmGone: "yes" });
  assert.equal(r.status, 409);
  r = await release(loose.ledger, { confirmGone: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await ledgerNow(loose), null);
});

test("hand release: confirmGone is refused while the claim may still be inside its publish — unless the pass has pinned it", async () => {
  // Claimed seconds ago, no listing row yet: the publish is on its way to
  // Gameflip. Released now — even on the owner's word — it would go on to put
  // the login on sale behind an account that is stock again.
  const fresh = await unit({ farm: "autofarm", attached: false, rowStatus: "delisted" });
  await UnclaimedAccount.updateOne({ _id: fresh.ledger._id }, { $set: { manualAt: new Date() } });
  let r = await release(fresh.ledger);
  assert.equal(r.status, 409);
  assert.equal(r.body.needsConfirm, false, "it does not invite a confirmation it would refuse");
  assert.match(r.body.message, /it is attached to no listing row, and it was claimed 0 min ago: its publish may still be running\. Try again in 30 min/);
  r = await release(fresh.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /its publish may still be running/);
  assert.equal((await ledgerNow(fresh)).status, "manual");

  // Twenty-nine minutes: still not. Thirty-one: no publish is at it any more.
  await UnclaimedAccount.updateOne({ _id: fresh.ledger._id }, { $set: { manualAt: new Date(Date.now() - 29 * 60 * 1000) } });
  r = await release(fresh.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Try again in 1 min/);
  await UnclaimedAccount.updateOne({ _id: fresh.ledger._id }, { $set: { manualAt: new Date(Date.now() - 31 * 60 * 1000) } });
  r = await release(fresh.ledger, { confirmGone: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await ledgerNow(fresh), null);

  // Pinned by the pass (it only pins a claim nothing is publishing): its age is not asked.
  const pinned = await unit({ farm: "autofarm", attached: false, rowStatus: "delisted" });
  await UnclaimedAccount.updateOne(
    { _id: pinned.ledger._id },
    { $set: { manualAt: new Date(), note: "unrecorded publish — Gameflip (offer unknown) holds this account but no listing row records it — delist it by hand, then release" } },
  );
  r = await release(pinned.ledger);
  assert.equal(r.status, 409);
  assert.equal(r.body.needsConfirm, true);
  r = await release(pinned.ledger, { confirmGone: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("hand release: a no-claim bot's claim with no listing row yet is not released while its publish may be running", async () => {
  const u = await unit({ attached: false, rowStatus: "delisted" });
  await UnclaimedAccount.updateOne({ _id: u.ledger._id }, { $set: { manualAt: new Date() } });
  let r = await release(u.ledger);
  assert.equal(r.status, 409);
  assert.match(r.body.message, /claimed 0 min ago and has no listing row yet: its publish may still be running\. Try again in 30 min/);
  assert.equal((await ledgerNow(u)).status, "manual");
  // Old enough, or attached to its row: released as it always was.
  await UnclaimedAccount.updateOne({ _id: u.ledger._id }, { $set: { manualAt: new Date(Date.now() - 31 * 60 * 1000) } });
  r = await release(u.ledger);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = await unit({ rowStatus: "delisted" });
  await UnclaimedAccount.updateOne({ _id: fresh.ledger._id }, { $set: { manualAt: new Date() } });
  r = await release(fresh.ledger);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("Delist: a 404 that is not Gameflip's own answer does not take a listing off the books", async () => {
  const u = await unit();
  gameflip.set(u.ext, http(404, 'Gameflip listing status: "<html><h1>404 Not Found</h1><hr>nginx</html>"'));
  const r = await delist(u.row);
  assert.equal(r.body.success, false, JSON.stringify(r.body));
  assert.match(r.body.message, /Gameflip did not answer, so nothing was changed/);
  assert.equal((await rowNow(u)).status, "active");
  assert.equal((await ledgerNow(u)).status, "manual");
});

test("hand release: an account whose bot removal is under way waits — whatever is confirmed", async () => {
  const u = await unit({ farm: "autofarm", rowStatus: "delisted" });
  gameflip.delete(u.ext);
  await UnclaimedAccount.updateOne({ _id: u.ledger._id }, { $set: { farmParkStartedAt: new Date() } });
  const r = await release(u.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /its bot removal is still under way/);
  assert.equal(r.body.needsConfirm, false);
  assert.equal((await ledgerNow(u)).status, "manual");
});

test("hand release / Delist: an account ticked sold by hand is never handed back — not even with its listing gone", async () => {
  // By hand: Gameflip has no such listing any more, and the owner even confirms it.
  let u = await unit({ farm: "autofarm", rowStatus: "delisted" });
  gameflip.delete(u.ext);
  await AvailableAccount.updateOne({ _id: u.pool._id }, { $set: { manualSold: true } });
  let r = await release(u.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Not released — it is ticked sold by hand/);
  assert.equal(r.body.needsConfirm, false);
  assert.equal((await ledgerNow(u)).status, "manual", "it stays held until the pass books the hand sale");
  assert.equal((await poolNow(u)).claimedNote, "unclaimed sale pending — gameflip");

  // The Delist button on its live listing: the listing comes down, the account does not come back.
  u = await unit({ farm: "autofarm" });
  await AvailableAccount.updateOne({ _id: u.pool._id }, { $set: { manualSold: true } });
  r = await delist(u.row);
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.noclaim, { released: 0, sold: 0 });
  assert.equal((await rowNow(u)).status, "delisted");
  assert.equal((await ledgerNow(u)).status, "manual");
  assert.equal((await poolNow(u)).claimedNote, "unclaimed sale pending — gameflip");
});

test("hand release: still refused while any live listing carries the login", async () => {
  const u = await unit({ farm: "autofarm" }); // row active
  const r = await release(u.ledger, { confirmGone: true });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Still on sale: gameflip /);
  assert.equal((await ledgerNow(u)).status, "manual");
});
