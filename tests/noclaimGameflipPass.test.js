// The lifecycle pass over HELD auto-farm accounts on Gameflip, on a real
// MongoDB (mongodb-memory-server) with the real claim layer and the real
// auto-farm stock rules — only Gameflip itself and the bot hosts are stubbed.
//
// tests/noclaimListings.test.js and tests/autofarmStock.test.js cover these
// steps one module at a time over hand-written in-memory models. This file is
// the other half: the same steps end to end, so a query that only a fake model
// accepts (a missing field against `$nin`, `$and` beside `$or`, a
// compare-and-set on `null`) cannot hide, and so that "handed back" means what
// it has to mean — the ledger gone, the hold's stamps off, the pool row's note
// back — and not just "releaseClaim was called".
process.env.CRED_SECRET ||= "noclaim-gameflip-pass-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const SaleSignal = require("../models/SaleSignal");
const RenterBotStack = require("../models/RenterBotStack");
const AutoFarmTask = require("../models/AutoFarmTask");
const mp = require("../utils/marketplaces");
const settings = require("../utils/settings");
const afs = require("../utils/autofarmStock");
const gf = require("../utils/gameflipFulfiller");
const nl = require("../utils/noclaimListings");

let mem;
const HOUR = 60 * 60 * 1000;
const TAG = "unclaimed-sale:gameflip";

// What Gameflip holds, per listing id: a status, or absent = it 404s.
const gameflip = new Map();
const calls = { status: [], end: [] };
let endMode = "ok"; // "ok" deletes; "swallow" answers and changes nothing

const real = {
  gameflipListingStatus: mp.gameflipListingStatus,
  gameflipEndListing: mp.gameflipEndListing,
  gameflipListingIdsByStatus: mp.gameflipListingIdsByStatus,
  gameflipListingState: mp.gameflipListingState,
  getNoclaimShopSettings: settings.getNoclaimShopSettings,
  getAutoFarm: settings.getAutoFarm,
  parkHeld: afs.parkHeld,
  retirePending: afs.retirePending,
  relistNoclaimSuccessor: gf.relistNoclaimSuccessor,
};

function http(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("noclaim-gameflip-pass"));
  mp.gameflipListingStatus = async (id) => {
    calls.status.push(id);
    if (!gameflip.has(id)) throw http(404, 'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}');
    const st = gameflip.get(id);
    if (st instanceof Error) throw st;
    return st;
  };
  mp.gameflipEndListing = async (id, opts) => {
    calls.end.push([id, opts && opts.status]);
    if (endMode === "swallow") throw http(409, "Gameflip end listing: " + id + " still exists after the delete");
    gameflip.delete(id);
    return { deleted: true };
  };
  // The sale watcher's two views of Gameflip: the bulk sweeps, and one listing.
  mp.gameflipListingIdsByStatus = async (status) =>
    new Set([...gameflip].filter(([, st]) => st === status).map(([id]) => id));
  mp.gameflipListingState = async (id) => {
    if (!gameflip.has(id)) throw http(404, 'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}');
    const st = gameflip.get(id);
    if (st instanceof Error) throw st;
    return { status: st, expiration: null, expired: st === "expired" };
  };
  // The pass with nothing but its Gameflip steps doing work: no live Twitch
  // re-checks, no top-up, the lister off — and no bot host is ever read (the
  // park and the sold clean-up have their own tests; the real park is run
  // further down against an empty fleet).
  settings.getNoclaimShopSettings = () => ({ enabled: true, autoDeliver: true, topUp: false, healthPerPass: 0, passEveryMin: 10 });
  settings.getAutoFarm = () => ({});
  afs.parkHeld = async () => ({ pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] });
  afs.retirePending = async () => ({ pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] });
  gf.relistNoclaimSuccessor = async () => null;
});

test.after(async () => {
  mp.gameflipListingStatus = real.gameflipListingStatus;
  mp.gameflipEndListing = real.gameflipEndListing;
  mp.gameflipListingIdsByStatus = real.gameflipListingIdsByStatus;
  mp.gameflipListingState = real.gameflipListingState;
  settings.getNoclaimShopSettings = real.getNoclaimShopSettings;
  settings.getAutoFarm = real.getAutoFarm;
  afs.parkHeld = real.parkHeld;
  afs.retirePending = real.retirePending;
  gf.relistNoclaimSuccessor = real.relistNoclaimSuccessor;
  // logEvent writes are not awaited by the modules; let them land.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  gameflip.clear();
  calls.status.length = 0;
  calls.end.length = 0;
  endMode = "ok";
  await Promise.all([
    MarketplaceListing.deleteMany({}),
    UnclaimedAccount.deleteMany({}),
    AvailableAccount.deleteMany({}),
    BotAccount.deleteMany({}),
    DropLog.deleteMany({}),
    DropSet.deleteMany({}),
    SaleSignal.deleteMany({}),
  ]);
});

let seq = 0;
// One held auto-farm account on its Gameflip listing, exactly as a claim
// leaves it: the ledger "manual", its claimed drop and bot record stamped with
// the hold's tag, a pending note on its pool row.
async function heldUnit({ rowStatus = "active", goneInHours = 20, parked = false, attached = true, ledger = {}, row = {} } = {}) {
  const n = ++seq;
  const login = "held" + n;
  const ext = "gf-" + n;
  const set = await DropSet.create({
    name: "Brawl bundle " + n,
    stockSource: "noclaim",
    coverGame: "Brawlhalla",
    items: [{ itemKey: "a|brawlhalla", name: "A", game: "Brawlhalla", qty: 1 }],
  });
  const pool = await AvailableAccount.create({
    username: login,
    usernameLower: login,
    clientSecret: "cs-" + login,
    status: "claimed",
    claimedNote: "unclaimed sale pending — gameflip",
    listed: true,
  });
  const heldAt = new Date(Date.now() - 2 * HOUR);
  const bot = await BotAccount.create({ login, clientSecret: "cs-" + login, soldAt: heldAt, soldToUsername: TAG });
  const drop = await DropLog.create({ account: bot._id, benefitId: "benefit-" + n, name: "Old claimed drop", game: "Brawlhalla", soldAt: heldAt, soldToUsername: TAG });
  const listing = await MarketplaceListing.create({
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
    units: [{ contentId: "", accountId: "", login, addedAt: heldAt, deliveredAt: null, orderId: "" }],
    ...row,
  });
  const led = await UnclaimedAccount.create({
    source: "noclaim",
    farm: "autofarm",
    login,
    loginLower: login,
    game: "Brawlhalla",
    poolAccountId: String(pool._id),
    status: "manual",
    market: "gameflip",
    set: set._id,
    manualListing: attached ? String(listing._id) : "",
    manualAt: heldAt,
    manualPriorStatus: "",
    note: "manual no-claim listing — gameflip",
    farmPoolNote: "auto-farm: Brawlhalla (c-" + n + ")",
    farmParkedAt: parked ? new Date(Date.now() - HOUR) : null,
    farmGoneAt: goneInHours == null ? null : new Date(Date.now() + goneInHours * HOUR),
    drops: [{ name: "A", game: "Brawlhalla", itemKey: "a|brawlhalla" }],
    ...ledger,
  });
  gameflip.set(ext, "onsale");
  return { n, login, ext, set, pool, bot, drop, listing, led };
}

const ledgerNow = (u) => UnclaimedAccount.findById(u.led._id).lean();
const rowNow = (u) => MarketplaceListing.findById(u.listing._id).lean();
const poolNow = (u) => AvailableAccount.findById(u.pool._id).lean();
const botNow = (u) => BotAccount.findById(u.bot._id).lean();
const dropNow = (u) => DropLog.findById(u.drop._id).lean();

// Handed back, for real: no ledger, the hold's stamps off, the pool row stock again.
async function assertBackInStock(u, note) {
  assert.equal(await ledgerNow(u), null, "the hold's ledger is gone");
  const bot = await botNow(u);
  assert.equal(bot.soldAt, null);
  assert.equal(bot.soldToUsername, "");
  const drop = await dropNow(u);
  assert.equal(drop.soldAt, null, "its claimed drop is back in the archive");
  const pool = await poolNow(u);
  assert.equal(pool.claimedNote, note);
  assert.equal(pool.listed, false);
}
// Still held, for real: everything a hold put in place is in place.
async function assertStillHeld(u) {
  const led = await ledgerNow(u);
  assert.equal(led.status, "manual");
  assert.equal((await botNow(u)).soldToUsername, TAG);
  assert.equal((await dropNow(u)).soldToUsername, TAG);
  assert.equal((await poolNow(u)).claimedNote, "unclaimed sale pending — gameflip");
}

test("expiry: a held unit a day from losing its drops comes off Gameflip and is back in stock — one a pass, the one tried longest ago first", async () => {
  const soon = await heldUnit({ goneInHours: 5 });
  const later = await heldUnit({ goneInHours: 9 });
  const safe = await heldUnit({ goneInHours: 100 });
  const undated = await heldUnit({ goneInHours: null });

  let out = await nl.runPass();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.expiring, { due: 2, removed: 1 });
  assert.deepEqual(calls.end, [[soon.ext, "onsale"]]);
  assert.equal((await rowNow(soon)).status, "delisted");
  assert.equal((await rowNow(soon)).lastError, "drops leave within 24 h");
  // Still in its bot (never parked): the note it carried goes back.
  await assertBackInStock(soon, "auto-farm: Brawlhalla (c-" + soon.n + ")");
  await assertStillHeld(later);

  out = await nl.runPass();
  assert.deepEqual(out.expiring, { due: 1, removed: 1 });
  await assertBackInStock(later, "auto-farm: Brawlhalla (c-" + later.n + ")");

  out = await nl.runPass();
  assert.deepEqual(out.expiring, { due: 0, removed: 0 });
  for (const u of [safe, undated]) {
    assert.equal((await rowNow(u)).status, "active");
    await assertStillHeld(u);
  }
});

test("expiry: a parked unit goes back as a stock hold; one Gameflip will not let go of stays held and does not block the next", async () => {
  const stuck = await heldUnit({ goneInHours: 3 });
  const parked = await heldUnit({ goneInHours: 6, parked: true });
  gameflip.set(stuck.ext, "sale_pending"); // a buyer is in the middle of paying

  let out = await nl.runPass();
  assert.deepEqual(out.expiring, { due: 2, removed: 0 });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^expiry held\d+: gameflip listing is sale_pending — not taking it down now$/);
  assert.deepEqual(calls.end, [], "a listing a buyer is paying for is never deleted");
  await assertStillHeld(stuck);
  assert.ok((await ledgerNow(stuck)).farmDownTriedAt, "its own clock was stamped");

  // Next pass: not the stuck one again — the one behind it.
  out = await nl.runPass();
  assert.deepEqual(out.expiring, { due: 2, removed: 1 });
  assert.deepEqual(calls.end, [[parked.ext, "onsale"]]);
  // In no bot any more: held as stock, in the pool check's own words.
  await assertBackInStock(parked, "unclaimed stock — 1 drop(s) (Brawlhalla) held out of the pool until sold");
  await assertStillHeld(stuck);
});

test("limbo: a row that came down while Gameflip still had the listing — finished, sold, burned or waited for, by Gameflip's word", async () => {
  // 1. Our row says delisted, Gameflip still has a draft: ended as a draft, then handed back.
  const draft = await heldUnit({ rowStatus: "delisted", goneInHours: null, ledger: { lastCheckedAt: new Date(1) } });
  gameflip.set(draft.ext, "draft");
  let out = await nl.runPass();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.deepEqual(calls.end, [[draft.ext, "draft"]]);
  await assertBackInStock(draft, "auto-farm: Brawlhalla (c-" + draft.n + ")");

  // 2. It SOLD while our books said it was down: booked, and the demand model told once.
  const sold = await heldUnit({ rowStatus: "delisted", goneInHours: null });
  gameflip.set(sold.ext, "sold");
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 1, retried: 0 });
  let led = await ledgerNow(sold);
  assert.equal(led.status, "sold");
  assert.equal(led.soldMarket, "gameflip");
  assert.equal(led.soldPriceUsd, 1.09);
  assert.ok(led.manualDeliveredAt, "so the sold clean-up takes it out of farming");
  let row = await rowNow(sold);
  assert.equal(row.status, "sold");
  assert.equal(row.units[0].orderId, "gameflip-sale");
  assert.equal((await botNow(sold)).soldToUsername, TAG, "a sold account keeps its stamps");
  const signals = await SaleSignal.find({ source: "listing_sold" }).lean();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].marketplace, "gameflip");
  assert.equal(signals[0].priceUsd, 1.09);
  // …and a second pass adds nothing: the ledger is no longer held.
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold" }), 1);

  // 3. Paid, then cancelled: its buyer saw the login. Retired, not sold, not stock.
  const burned = await heldUnit({ rowStatus: "removed", goneInHours: null });
  gameflip.set(burned.ext, "cancelled");
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0, burned: 1 });
  led = await ledgerNow(burned);
  assert.equal(led.status, "sold");
  assert.equal(led.soldPriceUsd, 0);
  assert.equal(led.note, "gameflip sale cancelled after delivery — its login was seen");
  row = await rowNow(burned);
  assert.equal(row.status, "removed", "nobody bought it: the row is not called sold");
  assert.equal(row.units[0].orderId, "gameflip-cancelled");
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold" }), 1, "a refund is not demand");
  assert.equal((await botNow(burned)).soldToUsername, TAG);

  // 4. The take-down does not take (the limiter): still held, asked again next pass.
  const sticky = await heldUnit({ rowStatus: "delisted", goneInHours: null });
  endMode = "swallow";
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 1 });
  await assertStillHeld(sticky);
  endMode = "ok";
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  await assertBackInStock(sticky, "auto-farm: Brawlhalla (c-" + sticky.n + ")");
});

test("limbo: mid-park the listing still comes down, but the account waits for the park; a missing row is pinned, never released", async () => {
  // Its bot removal is under way: Gameflip is cleared of the login now, the hand-back waits.
  const mid = await heldUnit({ rowStatus: "delisted", goneInHours: null, ledger: { farmParkStartedAt: new Date() } });
  let out = await nl.runPass();
  assert.deepEqual(calls.end, [[mid.ext, "onsale"]]);
  assert.equal(gameflip.has(mid.ext), false);
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  await assertStillHeld(mid);
  // The park proves it out of its bot: the next look hands it back, as a stock hold.
  await UnclaimedAccount.updateOne({ _id: mid.led._id }, { $set: { farmParkedAt: new Date() } });
  out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  await assertBackInStock(mid, "unclaimed stock — 1 drop(s) (Brawlhalla) held out of the pool until sold");

  // The row that named its listing is gone: nobody can ask Gameflip which listing.
  const lost = await heldUnit({ rowStatus: "delisted", goneInHours: null });
  await MarketplaceListing.deleteOne({ _id: lost.listing._id });
  out = await nl.runPass();
  assert.equal(out.limbo.pinned, 1);
  assert.equal(out.limbo.released, 0);
  const led = await ledgerNow(lost);
  assert.equal(led.status, "manual");
  assert.match(led.note, /^unrecorded publish — /);
  await assertStillHeld(lost);
  // Pinned once; later passes leave it to the owner.
  out = await nl.runPass();
  assert.equal(out.limbo.pinned || 0, 0);
});

test("manual-sold tick: a held account is booked sold by hand only once Gameflip no longer has its listing", async () => {
  // The row is "delisted" in our books; Gameflip still shows the listing on sale.
  const u = await heldUnit({ rowStatus: "delisted", goneInHours: null });
  await AvailableAccount.updateOne({ _id: u.pool._id }, { $set: { manualSold: true } });
  endMode = "swallow"; // …and its take-down keeps not taking
  let out = await nl.runPass();
  assert.ok(out.errors.some((e) => /^manual-sold held\d+: not booked as sold by hand yet — its Gameflip listing still exists \(onsale\)/.test(e)), JSON.stringify(out.errors));
  assert.equal((await ledgerNow(u)).status, "manual", "still held — so the limbo step keeps working on the listing");
  // The limiter lets go: limbo takes the listing down in a later pass…
  endMode = "ok";
  out = await nl.runPass();
  // …the manual-sold step ran first in that pass (listing still there), limbo
  // then deleted it and — the account being ticked sold — its release is the
  // one thing that must NOT happen to an account somebody already owns.
  const led = await ledgerNow(u);
  assert.ok(led, "a sold-by-hand account is never simply handed back to stock");
  out = await nl.runPass();
  const done = await ledgerNow(u);
  assert.equal(done.status, "sold");
  assert.equal(done.note, "sold by hand");
});

test("park (real query): only a held claim whose listing exists in our books, or one old enough that no publish is running", async () => {
  const attached = await heldUnit({ ledger: { manualAt: new Date() } });
  const midPublish = await heldUnit({ attached: false, ledger: { manualAt: new Date() } });
  const orphan = await heldUnit({ attached: false, ledger: { manualAt: new Date(Date.now() - 45 * 60 * 1000) } });
  const already = await heldUnit({ parked: true });
  const fleet = await heldUnit({ ledger: { farm: "" } });
  // The real park, on real models, against a fleet with no host to read.
  const deps = {
    AvailableAccount, BotAccount, DropLog, AutoFarmTask, UnclaimedAccount, SaleSignal, MarketplaceListing, RenterBotStack,
    hosts: { listHosts: () => [], resolveHost: () => null, readdir: async () => [], readFiles: async () => ({}) },
    recordPoolUsage: async () => {},
    logEvent: async () => {},
    sendTelegram: async () => {},
    removeAccountFromConfig: async () => 0,
    reloadConfig: async () => ({ done: true }),
    containerForFile: () => "",
    listingStatus: async () => "onsale",
  };
  const r = await real.parkHeld({ deps });
  assert.deepEqual(r.errors, []);
  assert.equal(r.pending, 2, "the attached one and the old orphan — nobody else");
  assert.equal(r.retired, 2);
  assert.ok((await ledgerNow(attached)).farmParkedAt);
  assert.ok((await ledgerNow(orphan)).farmParkedAt);
  const mid = await ledgerNow(midPublish);
  assert.equal(mid.farmParkStartedAt, null, "a claim inside its publish is not touched");
  assert.equal(mid.farmParkedAt, null);
  assert.equal((await ledgerNow(fleet)).farmParkStartedAt, null, "a no-claim bot's ledger is never this pass's");
  assert.ok((await ledgerNow(already)).farmParkedAt < new Date(Date.now() - 30 * 60 * 1000), "parked once, not again");
});

// ---------------------------------------------------------------------------
// The sale watcher (utils/gameflipFulfiller.syncOnce) over a held unit
// ---------------------------------------------------------------------------

test("sale watcher: a held unit that SELLS is booked once — ledger sold, stamps kept, the demand model told", async () => {
  const u = await heldUnit({ goneInHours: 100 });
  gameflip.set(u.ext, "sold");
  const r = await gf.syncOnce();
  assert.equal(r.sold, 1);
  assert.equal(r.relisted, 0, "a chain of one owes nothing more");
  const row = await rowNow(u);
  assert.equal(row.status, "sold");
  assert.equal(row.units[0].orderId, "gameflip-sale");
  const led = await ledgerNow(u);
  assert.equal(led.status, "sold");
  assert.equal(led.soldMarket, "gameflip");
  assert.equal(led.soldPriceUsd, 1.09);
  assert.ok(led.manualDeliveredAt);
  assert.equal((await botNow(u)).soldToUsername, TAG);
  assert.equal((await poolNow(u)).claimedNote, "unclaimed sale pending — gameflip", "until its clean-up says spent");
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold", marketplace: "gameflip" }), 1);
  // Seen again on the next look: nothing more happens.
  const again = await gf.syncOnce();
  assert.equal(again.sold, 0);
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold" }), 1);
  // …and the pass has nothing to release, sell or retry.
  const out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  assert.deepEqual(out.expiring, { due: 0, removed: 0 });
});

test("sale watcher: a listing Gameflip no longer has (404) retires the row and the account is back in stock on that answer", async () => {
  const u = await heldUnit({ goneInHours: 100 });
  gameflip.delete(u.ext); // deleted on Gameflip by hand
  await gf.syncOnce();
  assert.equal((await rowNow(u)).status, "removed");
  await assertBackInStock(u, "auto-farm: Brawlhalla (c-" + u.n + ")");
  // The watcher's own 404 was the proof: Gameflip was not asked a second time by the release.
  assert.deepEqual(calls.status, []);
});

test("sale watcher: retired as CANCELLED — its buyer saw the login — the account is retired, never stock, whichever farm it came from", async () => {
  const farm = await heldUnit({ goneInHours: 100 });
  const fleet = await heldUnit({ goneInHours: null, ledger: { farm: "", farmPoolNote: "" } });
  gameflip.set(farm.ext, "cancelled"); // paid, then refunded
  gameflip.set(fleet.ext, "cancelled");
  await gf.syncOnce();
  for (const u of [farm, fleet]) {
    const row = await rowNow(u);
    assert.equal(row.status, "removed", "nobody bought it: the row is not called sold");
    assert.equal(row.units[0].orderId, "gameflip-cancelled");
    const led = await ledgerNow(u);
    assert.equal(led.status, "sold", "closed like a sale: out of stock, and its clean-up takes it out of its bot");
    assert.equal(led.soldPriceUsd, 0);
    assert.match(led.note, /cancelled after delivery — its login was seen/);
    assert.ok(led.manualDeliveredAt);
    assert.equal((await botNow(u)).soldToUsername, TAG, "never back in the archive as unsold");
  }
  assert.deepEqual(calls.end, [], "a listing a buyer paid for is never deleted by us");
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold" }), 0, "a refund is not demand");
  // Nothing left for the pass to settle.
  const out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
});

test("sale watcher: retired as EXPIRED the listing still holds the login — held until the pass has deleted it, then back in stock", async () => {
  const u = await heldUnit({ goneInHours: 100 });
  gameflip.set(u.ext, "expired");
  await gf.syncOnce();
  assert.equal((await rowNow(u)).status, "removed");
  await assertStillHeld(u);
  const out = await nl.runPass();
  assert.deepEqual(out.limbo, { released: 1, sold: 0, retried: 0 });
  assert.deepEqual(calls.end, [[u.ext, "expired"]]);
  await assertBackInStock(u, "auto-farm: Brawlhalla (c-" + u.n + ")");
});

test("sale watcher + pass: a sale that lands while the pass is taking the unit down is booked by the watcher — once", async () => {
  // Inside its last day: the pass goes to take it down, and a buyer gets there first.
  const u = await heldUnit({ goneInHours: 5, row: { qtyRemaining: 0 } });
  let looks = 0;
  const realStatus = mp.gameflipListingStatus;
  mp.gameflipListingStatus = async (id) => {
    calls.status.push(id);
    return looks++ === 0 ? "onsale" : "sold";
  };
  endMode = "swallow";
  try {
    const out = await nl.runPass();
    assert.deepEqual(out.expiring, { due: 1, removed: 0 });
    assert.deepEqual(out.errors, []);
    // Nothing booked by the pass: the row is still active, which is what the watcher looks for.
    assert.equal((await rowNow(u)).status, "active");
    await assertStillHeld(u);
  } finally {
    mp.gameflipListingStatus = realStatus;
  }
  gameflip.set(u.ext, "sold");
  const r = await gf.syncOnce();
  assert.equal(r.sold, 1);
  assert.equal((await ledgerNow(u)).status, "sold");
  assert.equal(await SaleSignal.countDocuments({ source: "listing_sold" }), 1);
  assert.equal(await MarketplaceListing.countDocuments({}), 1, "one sale, no second listing");
});
