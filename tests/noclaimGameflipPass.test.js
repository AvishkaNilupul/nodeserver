/* global fetch */
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
//
// The last section is a NO-CLAIM BOT's account on a cancelled (refunded)
// listing: retired like an auto-farm one, and followed through that farm's own
// post-sale path for real — noclaimStock.spendPending and the engine's
// spendAccount / retireSoldFromBots over an in-memory fleet host — down to the
// owner's message, the spent view and the demand model.
process.env.CRED_SECRET ||= "noclaim-gameflip-pass-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Every message to the owner's phone, captured. Swapped in BEFORE anything
// that keeps its own reference to sendTelegram is loaded (the engine and the
// sale watcher both take it at load), so nothing here can reach Telegram.
const telegram = require("../utils/telegram");
const told = [];
const realSendTelegram = telegram.sendTelegram;
telegram.sendTelegram = async (text) => {
  told.push(String(text));
};

const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const SaleSignal = require("../models/SaleSignal");
const RenterBotStack = require("../models/RenterBotStack");
const AutoFarmTask = require("../models/AutoFarmTask");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");
const SystemEvent = require("../models/SystemEvent");
const mp = require("../utils/marketplaces");
const settings = require("../utils/settings");
const hosts = require("../utils/botHosts");
const afs = require("../utils/autofarmStock");
const gf = require("../utils/gameflipFulfiller");
const nl = require("../utils/noclaimListings");
const ncs = require("../utils/noclaimStock");
const ual = require("../utils/unclaimedAutoList");
const farmDemand = require("../utils/farmDemand");

let mem;
const HOUR = 60 * 60 * 1000;
const TAG = "unclaimed-sale:gameflip";

// The no-claim fleet's host, in memory: bot id -> its config. It understands
// exactly what the engine's clean-up does there — list the configs, read one,
// write one (the guarded write) — and answers nothing to the rest (docker, the
// bot markers), as a parked bot's host would.
const fleet = new Map();
const FLEET_DIR = "/home/ubuntu/twitchbot-noclaim/bots";
const fleetPath = (id) => FLEET_DIR + "/" + id + "/Configuration/config.json";
const fleetId = (file) => String(file).slice(FLEET_DIR.length + 1).split("/")[0];
const fleetWrites = [];
function fleetAdd(botId, user, game = "Overwatch") {
  if (!fleet.has(botId)) fleet.set(botId, { FavouriteGames: [game], TwitchSettings: { TwitchUsers: [] } });
  fleet.get(botId).TwitchSettings.TwitchUsers.push(user);
}
const fleetLogins = (botId) =>
  ((fleet.get(botId) || { TwitchSettings: { TwitchUsers: [] } }).TwitchSettings.TwitchUsers || []).map((u) => u.Login);

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
  resolveHost: hosts.resolveHost,
  runShell: hosts.runShell,
  readFiles: hosts.readFiles,
  guardedWriteScript: hosts.guardedWriteScript,
  attachListing: ncs.attachListing,
  markSold: ncs.markSold,
  inventoryForCandidate: ual.inventoryForCandidate,
};

function http(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("noclaim-gameflip-pass"));
  // (A listing may also be held as { status, expired, expiration }: one whose
  // date has passed while Gameflip still shows it under another status.)
  mp.gameflipListingStatus = async (id) => {
    calls.status.push(id);
    if (!gameflip.has(id)) throw http(404, 'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}');
    const st = gameflip.get(id);
    if (st instanceof Error) throw st;
    return st && typeof st === "object" ? st.status : st;
  };
  mp.gameflipEndListing = async (id, opts) => {
    calls.end.push([id, opts && opts.status]);
    if (endMode === "swallow") throw http(409, "Gameflip end listing: " + id + " still exists after the delete");
    gameflip.delete(id);
    return { deleted: true, confirmed: true };
  };
  // The sale watcher's two views of Gameflip: the bulk sweeps, and one listing.
  mp.gameflipListingIdsByStatus = async (status) =>
    new Set([...gameflip].filter(([, st]) => st === status).map(([id]) => id));
  mp.gameflipListingState = async (id) => {
    if (!gameflip.has(id)) throw http(404, 'Gameflip listing status: {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}');
    const st = gameflip.get(id);
    if (st instanceof Error) throw st;
    if (st && typeof st === "object") return st;
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
  // The fleet host (see `fleet`). The engine reaches it through these four.
  hosts.resolveHost = (id) => (id === "contabo" ? { id: "contabo", name: "contabo" } : real.resolveHost(id));
  hosts.guardedWriteScript = (dest) => "WRITE " + dest;
  hosts.runShell = async (host, script, { input } = {}) => {
    const s = String(script);
    if (s.startsWith("WRITE ")) {
      fleet.set(fleetId(s.slice(6)), JSON.parse(input));
      fleetWrites.push(fleetId(s.slice(6)));
      return { stdout: "" };
    }
    if (s.startsWith("ls -1d ")) return { stdout: [...fleet.keys()].map(fleetPath).join("\n") };
    const cat = /&& cat '([^']+)'/.exec(s);
    if (cat) return { stdout: fleet.has(fleetId(cat[1])) ? JSON.stringify(fleet.get(fleetId(cat[1]))) : "" };
    return { stdout: "" };
  };
  hosts.readFiles = async (host, files) =>
    Object.fromEntries(
      files.map((f) => [
        f,
        fleet.has(fleetId(f)) ? { ok: true, text: JSON.stringify(fleet.get(fleetId(f))) } : { ok: false, error: "Not found" },
      ]),
    );
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
  hosts.resolveHost = real.resolveHost;
  hosts.runShell = real.runShell;
  hosts.readFiles = real.readFiles;
  hosts.guardedWriteScript = real.guardedWriteScript;
  ncs.attachListing = real.attachListing;
  ncs.markSold = real.markSold;
  ual.inventoryForCandidate = real.inventoryForCandidate;
  telegram.sendTelegram = realSendTelegram;
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
  fleet.clear();
  fleetWrites.length = 0;
  told.length = 0;
  gf.resetRenewalAlert(); // the watcher's "said once" latches
  await Promise.all([
    SystemEvent.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    UnclaimedAccount.deleteMany({}),
    AvailableAccount.deleteMany({}),
    BotAccount.deleteMany({}),
    DropLog.deleteMany({}),
    DropSet.deleteMany({}),
    SaleSignal.deleteMany({}),
    NoclaimSpentAccount.deleteMany({}),
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

test("sale watcher: retired as CANCELLED — its buyer saw the login — an auto-farm account is retired, never stock", async () => {
  const farm = await heldUnit({ goneInHours: 100 });
  gameflip.set(farm.ext, "cancelled"); // paid, then refunded
  await gf.syncOnce();
  const row = await rowNow(farm);
  assert.equal(row.status, "removed", "nobody bought it: the row is not called sold");
  assert.equal(row.units[0].orderId, "gameflip-cancelled");
  const led = await ledgerNow(farm);
  assert.equal(led.status, "sold", "closed like a sale: out of stock, and its clean-up takes it out of its bot");
  assert.equal(led.soldPriceUsd, 0);
  assert.match(led.note, /cancelled after delivery — its login was seen/);
  assert.ok(led.manualDeliveredAt);
  assert.equal((await botNow(farm)).soldToUsername, TAG, "never back in the archive as unsold");
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

// ---------------------------------------------------------------------------
// A NO-CLAIM BOT's account on a Gameflip listing
// ---------------------------------------------------------------------------

// One no-claim bot account on its Gameflip listing, as the claim layer leaves
// it: the ledger "manual" (no farm), the pool row the fleet's own and ticked
// listed, and the account in bot 7's config on the fleet host.
async function fleetUnit({ game = "Overwatch", attached = true, ledger = {}, row = {} } = {}) {
  const n = ++seq;
  const login = "fleet" + n;
  const ext = "gf-" + n;
  const secret = "cs-" + login;
  const set = await DropSet.create({
    name: game + " bundle " + n,
    stockSource: "noclaim",
    coverGame: game,
    items: [{ itemKey: "a|" + game.toLowerCase(), name: "A", game, qty: 1 }],
  });
  const pool = await AvailableAccount.create({
    username: login,
    usernameLower: login,
    clientSecret: secret,
    status: "claimed",
    claimedNote: "noclaim-farm:" + game,
    listed: true,
  });
  const heldAt = new Date(Date.now() - 2 * HOUR);
  const listing = await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: ext,
    title: game + " Twitch Drops (1 Item)",
    price: 1.49,
    status: "active",
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
    login,
    loginLower: login,
    game,
    poolAccountId: String(pool._id),
    botId: "7",
    container: "noclaim-bot-7",
    status: "manual",
    market: "gameflip",
    set: set._id,
    manualListing: attached ? String(listing._id) : "",
    manualAt: heldAt,
    manualPriorStatus: "",
    listedAt: heldAt,
    note: "manual no-claim listing — gameflip",
    drops: [{ name: "A", game, itemKey: "a|" + game.toLowerCase() }],
    ...ledger,
  });
  gameflip.set(ext, "onsale");
  fleetAdd("7", { Login: login, ClientSecret: secret, Id: "id-" + n }, game);
  return { n, login, ext, secret, set, pool, listing, led };
}

const spentViewOf = (u) => NoclaimSpentAccount.findOne({ loginLower: u.login }).lean();
// The games the fleet farms, as prod's settings name them: what the demand
// model (utils/farmDemand) buckets by. Restored to this file's quiet stub.
async function withNoClaimGames(list, fn) {
  const quiet = settings.getAutoFarm;
  settings.getAutoFarm = () => ({ noClaimGames: list });
  try {
    return await fn();
  } finally {
    settings.getAutoFarm = quiet;
  }
}

test("fleet, CANCELLED: its buyer saw the login — retired, never stock; its own farm says 'retired, not sold' and nothing counts a sale", async () => {
  await withNoClaimGames(["overwatch"], async () => {
    const refunded = await fleetUnit();
    // The control: a unit that really sold, through the very same paths.
    const bought = await fleetUnit();
    fleetAdd("7", { Login: "bystander", ClientSecret: "cs-bystander", Id: "id-b" });
    gameflip.set(refunded.ext, "cancelled"); // paid, then refunded
    gameflip.set(bought.ext, "sold");
    const r = await gf.syncOnce();
    assert.equal(r.sold, 1);

    // --- The watcher's own look: retired on the spot, never handed back. ---
    const row = await rowNow(refunded);
    assert.equal(row.status, "removed", "nobody bought it: the row is not called sold");
    assert.equal(row.units[0].orderId, "gameflip-cancelled");
    let led = await ledgerNow(refunded);
    assert.ok(led, "NOT released: before this, a claim made straight from stock was simply dropped here");
    assert.equal(led.status, "sold", "closed like a sale — the status no claim can take an account from");
    assert.ok(!ncs.FREE_STATUSES.includes(led.status));
    assert.equal(led.note, nl.BURNED_REASON);
    assert.equal(led.soldPriceUsd, 0);
    assert.equal(led.soldMarket, "gameflip");
    assert.ok(led.manualDeliveredAt, "what hands it to its farm's post-sale pass");
    assert.deepEqual(calls.end, [], "a listing a buyer paid for is never deleted by us");
    assert.equal(await SaleSignal.countDocuments({ login: refunded.login }), 0, "a refund is not demand");
    assert.equal(await SaleSignal.countDocuments({ source: "listing_sold", login: bought.login }), 1);
    assert.equal(told.filter((m) => m.includes(refunded.login)).length, 0, "the watcher announces sales only");
    // Still in its bot until its farm's clean-up runs — and already not stock.
    assert.deepEqual(fleetLogins("7"), [refunded.login, bought.login, "bystander"]);
    assert.notEqual(ncs.poolBlockReason(await poolNow(refunded), ["overwatch"]), "");

    // --- The fleet's post-sale pass, for real (noclaimStock.spendPending). ---
    told.length = 0;
    assert.equal(await ncs.spendPending({ limit: 10 }), 2);
    assert.deepEqual(fleetLogins("7"), ["bystander"], "both have left the bot; nobody else has");
    // The owner's phone: one message each, and the refund is not called a sale.
    assert.deepEqual(told.filter((m) => m.includes(refunded.login)), [
      "⚠️ RETIRED, not sold (manual no-claim listing)\n\n" + refunded.login +
        "\nGame: Overwatch\nSource: noclaim\nReason: " + nl.BURNED_REASON,
    ]);
    assert.deepEqual(told.filter((m) => m.includes(bought.login)), [
      "💰 SOLD (manual no-claim listing)\n\n" + bought.login + "\nGame: Overwatch\nSource: noclaim\nReason: gameflip sale",
    ]);
    assert.equal(told.length, 2);
    // The spent view: the refund carries neither flag, and says why it left.
    let view = await spentViewOf(refunded);
    assert.equal(view.sold, false);
    assert.equal(view.connected, false);
    assert.equal(view.soldWhy, "retired, not sold — manual no-claim listing: " + nl.BURNED_REASON);
    assert.equal(view.botId, "7");
    assert.equal(view.game, "Overwatch");
    const viewBought = await spentViewOf(bought);
    assert.equal(viewBought.sold, true);
    assert.equal(viewBought.soldWhy, "manual no-claim listing: gameflip sale");
    // Out of stock for good, exactly as a sold one is.
    const pool = await poolNow(refunded);
    assert.equal(pool.status, "claimed", "never back in the pool");
    assert.equal(pool.claimedNote, "spent — manual no-claim listing (" + nl.BURNED_REASON + ")");
    assert.deepEqual(pool.soldGames, ["overwatch"]);
    assert.equal(pool.listed, false);
    assert.equal(ncs.poolBlockReason(pool, ["overwatch"]), "sold for this game");
    led = await ledgerNow(refunded);
    assert.equal(led.status, "sold");
    assert.equal(led.note, nl.BURNED_REASON, "the words every later reader tells a refund from a sale by");
    assert.equal(led.soldPriceUsd, 0, "closed at no price, and it stays that way");
    assert.ok(led.manualSpentAt);
    // Once: a second pass has nothing to do and nothing to say.
    told.length = 0;
    assert.equal(await ncs.spendPending({ limit: 10 }), 0);
    assert.deepEqual(told, []);

    // --- The demand model that sizes the fleet: ONE sale, the real one. ---
    let ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.deepEqual([...ev.units.get("overwatch").keys()], [bought.login]);
    assert.deepEqual([...ev.units.get("overwatch").get(bought.login).sources].sort(), ["ledger", "listing_sold", "swept"]);
    assert.equal(ev.undated.get("overwatch"), 0, "nor an undated one");
    assert.equal((await farmDemand.timeToSaleByBucket({ days: 90 })).get("overwatch").n, 1);
    // An operator's hand sweep of the same account flags its row "sold" like
    // any other (routes/noclaimFarmRoutes): it is still no witness of a sale.
    await NoclaimSpentAccount.updateOne({ loginLower: refunded.login }, { $set: { sold: true, soldWhy: "sold on gameflip" } });
    ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.deepEqual([...ev.units.get("overwatch").keys()], [bought.login]);
    assert.equal(ev.undated.get("overwatch"), 0);
    // A swept row that says so itself is none either, whatever became of its
    // ledger — while the same row worded as a sale is a (confirming) witness.
    const ghost = { login: "ghost", loginLower: "ghost", game: "Overwatch", sold: true, sweptAt: new Date() };
    await NoclaimSpentAccount.create({ ...ghost, soldWhy: "retired, not sold — " + nl.BURNED_REASON });
    ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.equal(ev.undated.get("overwatch"), 0);
    await NoclaimSpentAccount.updateOne({ loginLower: "ghost" }, { $set: { soldWhy: "sold on gameflip" } });
    ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.equal(ev.undated.get("overwatch"), 1);
    await NoclaimSpentAccount.deleteOne({ loginLower: "ghost" });
    // …and the owner's own counters agree: one sold, at its price.
    const line = (await require("../routes/unclaimedAutoRoutes").gamesSummary()).games.find((g) => g.game === "overwatch");
    assert.deepEqual(line.sold30, { n: 1, usd: 1.49 });
    assert.deepEqual(line.sold7, { n: 1, usd: 1.49 });
    assert.equal((await require("../utils/marketResearch").unclaimedStats("Overwatch")).overwatch.sold, 1);

    // What all of the above rests on: the very same ledger, worded as a sale,
    // IS one — so it is the burn's words, and nothing else, that kept it out.
    await UnclaimedAccount.updateOne({ _id: refunded.led._id }, { $set: { note: "gameflip sale" } });
    ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.deepEqual([...ev.units.get("overwatch").keys()].sort(), [bought.login, refunded.login].sort());
  });
});

test("fleet, CANCELLED: a claim that never reached its row is tied to it by the burn; if even that does not land, the fleet's net retires it — as retired", async () => {
  await withNoClaimGames(["overwatch"], async () => {
    // 1. The attach that should have followed the publish never landed.
    const loose = await fleetUnit({ attached: false });
    gameflip.set(loose.ext, "cancelled");
    await gf.syncOnce();
    let led = await ledgerNow(loose);
    assert.equal(led.status, "sold");
    assert.equal(led.manualListing, String(loose.listing._id), "tied to the row whose listing was refunded");
    assert.equal(await ncs.spendPending({ limit: 10 }), 1, "so the post-sale pass sees it");
    assert.deepEqual(fleetLogins("7"), []);
    assert.match(told[told.length - 1], /^⚠️ RETIRED, not sold \(manual no-claim listing\)/);

    // 2. The attach does not land at the burn either.
    const lost = await fleetUnit({ attached: false });
    ncs.attachListing = async () => 0;
    try {
      gameflip.set(lost.ext, "cancelled");
      await gf.syncOnce();
    } finally {
      ncs.attachListing = real.attachListing;
    }
    led = await ledgerNow(lost);
    assert.equal(led.status, "sold", "closed all the same — never released");
    assert.equal(led.manualListing, "");
    assert.equal(led.note, nl.BURNED_REASON);
    told.length = 0;
    assert.equal(await ncs.spendPending({ limit: 10 }), 0, "a ledger with no listing is not the post-sale pass's");
    assert.deepEqual(fleetLogins("7"), [lost.login], "still in its bot");
    // The net under every sale (the engine's own pass, after each scan): the
    // account as the scan read it out of bot 7, and its pool row.
    const cands = [{ source: "noclaim", clientSecret: lost.secret, login: lost.login, twitchId: "", game: "Overwatch", botId: "7" }];
    const poolBySecret = new Map([[lost.secret, await poolNow(lost)]]);
    let net = await ual.retireSoldFromBots(cands, poolBySecret);
    assert.equal(net.retired, 0);
    assert.equal(net.waiting, 1, "inside the hour a sale is given to settle");
    assert.deepEqual(fleetLogins("7"), [lost.login]);
    await UnclaimedAccount.updateOne({ _id: lost.led._id }, { $set: { soldAt: new Date(Date.now() - 61 * 60 * 1000) } });
    net = await ual.retireSoldFromBots(cands, poolBySecret);
    assert.deepEqual(net.errors, []);
    assert.equal(net.retired, 1);
    assert.deepEqual(fleetLogins("7"), [], "out of its bot");
    const view = await spentViewOf(lost);
    assert.equal(view.sold, false);
    assert.equal(view.soldWhy, "retired, not sold — " + nl.BURNED_REASON + " — taken out of its bot, handed to the recycler");
    const pool = await poolNow(lost);
    assert.equal(pool.claimedNote, "spent — " + nl.BURNED_REASON + " (taken out of no-claim bot 7)");
    assert.deepEqual(pool.soldGames, ["overwatch"]);
    assert.equal(pool.listed, false);
    led = await ledgerNow(lost);
    assert.equal(led.status, "sold");
    assert.equal(led.note, nl.BURNED_REASON, "the net keeps the refund's words — a sale's it rewrites");
    assert.equal(led.soldPriceUsd, 0);
    // Neither of the two is a sale to the demand model.
    const ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.equal((ev.units.get("overwatch") || new Map()).size, 0);
    assert.equal(ev.undated.get("overwatch") || 0, 0);
  });
});

test("fleet: the net words a refunded sale as itself, a sale as a sale, and waits for either to settle", () => {
  const old = new Date(Date.now() - 2 * HOUR);
  const base = { status: "sold", soldAt: old, market: "gameflip", soldMarket: "gameflip" };
  assert.equal(ual.soldRetireReason({}, { ...base, note: nl.BURNED_REASON }), nl.BURNED_REASON);
  assert.equal(ual.soldRetireReason({}, { ...base, note: "gameflip sale" }), "gameflip sale");
  // An owner listing's unit settles 30 minutes after its delivery was recorded.
  const fresh = { ...base, note: nl.BURNED_REASON, manualListing: "x", manualDeliveredAt: new Date() };
  assert.equal(ual.soldRetireReason({}, fresh), "");
  assert.equal(ual.soldRetireReason({}, { ...fresh, manualDeliveredAt: old }), nl.BURNED_REASON);
  // One reading of those words, everywhere a "sold" ledger is read as a sale.
  assert.equal(farmDemand.isRetiredUnsold(nl.BURNED_REASON), true);
  assert.equal(farmDemand.isRetiredUnsold("gameflip sale"), false);
  assert.equal(farmDemand.isRetiredUnsold(""), false);
});

test("fleet, EXPIRED or gone: the old rule — handed back at once, still farming in its bot", async () => {
  const expired = await fleetUnit();
  const gone = await fleetUnit();
  gameflip.set(expired.ext, "expired");
  gameflip.delete(gone.ext); // deleted on Gameflip by hand: its own 404
  await gf.syncOnce();
  for (const u of [expired, gone]) {
    assert.equal((await rowNow(u)).status, "removed");
    assert.equal(await ledgerNow(u), null, "released (a claim made straight from stock is dropped)");
    const pool = await poolNow(u);
    assert.equal(pool.claimedNote, "noclaim-farm:Overwatch");
    assert.equal(pool.listed, false);
    assert.equal(ncs.poolBlockReason({ ...pool, password: "x" }, ["overwatch"]), "", "stock again");
  }
  assert.deepEqual(fleetLogins("7"), [expired.login, gone.login], "nobody was taken out of the bot");
  assert.deepEqual(fleetWrites, []);
  assert.deepEqual(told, []);
  assert.equal(await NoclaimSpentAccount.countDocuments({}), 0);
});

test("the No-claim page's Removed list shows a retired account's reason — and never calls it sold", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "noclaim-farm.html"), "utf8");
  const src = /function reasonChips\(a\)\{[^]*?\n\}/.exec(html);
  assert.ok(src, "reasonChips is where it was");
  const reasonChips = new Function("esc", src[0] + "; return reasonChips;")((s) => String(s));
  const retired = reasonChips({ sold: false, connected: false, soldWhy: "retired, not sold — manual no-claim listing: " + nl.BURNED_REASON, tokenStatus: "ok" });
  assert.match(retired, /^<span class="chip warn">retired, not sold — manual no-claim listing: gameflip sale cancelled after delivery — its login was seen<\/span> $/);
  // The rows it already drew are drawn as they were.
  assert.equal(reasonChips({ sold: true, soldWhy: "manual no-claim listing: gameflip sale", tokenStatus: "ok" }), '<span class="chip off">sold · manual no-claim listing: gameflip sale</span> ');
  assert.equal(reasonChips({ sold: false, connected: false, soldWhy: "", tokenStatus: "ok" }), '<span class="muted">—</span>');

  // The Unclaimed-farms page draws an account's status as a chip, and offers it as a filter.
  const farms = fs.readFileSync(path.join(__dirname, "..", "public", "unclaimed-farms.html"), "utf8");
  const chipSrc = /function chipFor\(status\)\{[^]*?\n\}/.exec(farms);
  assert.ok(chipSrc, "chipFor is where it was");
  const chipFor = new Function(chipSrc[0] + "; return chipFor;")();
  assert.equal(chipFor("retired"), '<span class="chip warn">retired · refunded</span>');
  assert.equal(chipFor("sold"), '<span class="chip off">sold</span>');
  assert.equal((farms.match(/<option value="retired">Retired \(refunded sale\)<\/option>/g) || []).length, 2);
});

// ---------------------------------------------------------------------------
// The refund is booked BEFORE the row is retired
// ---------------------------------------------------------------------------

test("fleet, CANCELLED: a refund that cannot be booked is on record at once — the row stays on sale in our books, nothing can release the account, and the next look finishes it", async () => {
  // 1. The ledger write does not land.
  const u = await fleetUnit();
  gameflip.set(u.ext, "cancelled");
  ncs.markSold = async () => 0;
  try {
    await gf.syncOnce();
  } finally {
    ncs.markSold = real.markSold;
  }
  let row = await rowNow(u);
  assert.equal(row.status, "active", "not retired before its refund is booked");
  assert.equal(row.units[0].orderId, "gameflip-cancelled", "the refund is on the row itself: seen…");
  assert.equal(row.units[0].deliveredAt, null, "…and still to be booked");
  assert.equal((await ledgerNow(u)).status, "manual", "still committed: sold nowhere");
  assert.deepEqual(told, [], "one blip is finished by the next look — nobody is paged for it");
  // Nobody can hand it back meanwhile: a live listing still carries the login
  // (what the hand-release route refuses on), and the claim layer itself
  // refuses a ledger whose listing was refunded.
  assert.equal((await ual.activeListingsForLogin(u.login)).length, 1);
  assert.equal(await ncs.releaseClaim([u.led._id], { reason: "released by hand" }), 0);
  assert.equal(await ncs.releaseClaim([u.led._id], { reason: "released by hand", listingGone: true }), 0);
  assert.equal((await ledgerNow(u)).status, "manual");
  assert.deepEqual(calls.end, [], "a listing a buyer paid for is never deleted by us");
  // The next look.
  await gf.syncOnce();
  row = await rowNow(u);
  assert.equal(row.status, "removed");
  assert.ok(row.units[0].deliveredAt);
  let led = await ledgerNow(u);
  assert.equal(led.status, "sold");
  assert.equal(led.note, nl.BURNED_REASON);

  // 2. A read fails in the middle of it.
  const v = await fleetUnit();
  gameflip.set(v.ext, "cancelled");
  const realFind = UnclaimedAccount.find;
  let failed = 0;
  UnclaimedAccount.find = function (filter, ...rest) {
    if (!failed && filter && filter.loginLower && filter.loginLower.$in) {
      failed++;
      throw new Error("MongoNetworkTimeoutError: connection timed out");
    }
    return realFind.call(this, filter, ...rest);
  };
  try {
    await gf.syncOnce();
  } finally {
    UnclaimedAccount.find = realFind;
  }
  assert.equal(failed, 1);
  assert.equal((await rowNow(v)).status, "active");
  assert.equal((await rowNow(v)).units[0].orderId, "gameflip-cancelled");
  assert.equal((await ledgerNow(v)).status, "manual");
  await gf.syncOnce();
  assert.equal((await rowNow(v)).status, "removed");
  led = await ledgerNow(v);
  assert.equal(led.status, "sold");
  assert.equal(led.note, nl.BURNED_REASON);

  // 3. The lifecycle pass gets there before the watcher's next look: it books
  // the refund, and the same pass takes the account out of its bot.
  assert.equal(await ncs.spendPending({ limit: 10 }), 2); // the two above, out of the way
  const w = await fleetUnit();
  gameflip.set(w.ext, "cancelled");
  ncs.markSold = async () => 0;
  try {
    await gf.syncOnce();
  } finally {
    ncs.markSold = real.markSold;
  }
  assert.equal((await ledgerNow(w)).status, "manual");
  told.length = 0;
  const out = await nl.runPass();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.refunds, { booked: 1, waiting: 0 });
  assert.equal(out.spend, 1);
  assert.equal((await ledgerNow(w)).note, nl.BURNED_REASON);
  assert.ok(!fleetLogins("7").includes(w.login), "out of its bot in the same pass");
  assert.equal(told.length, 1);
  assert.match(told[0], /^⚠️ RETIRED, not sold \(manual no-claim listing\)/);
  assert.equal((await rowNow(w)).status, "active", "the row is still the watcher's to retire…");
  await gf.syncOnce();
  assert.equal((await rowNow(w)).status, "removed", "…and it does, on its next look");
  assert.equal(told.length, 1);
});

test("fleet, CANCELLED: a refund that KEEPS failing is said by the pass — after half an hour, once — and still releases nothing", async () => {
  const u = await fleetUnit();
  gameflip.set(u.ext, "cancelled");
  const realNow = Date.now;
  const t0 = realNow();
  ncs.markSold = async () => 0;
  try {
    await gf.syncOnce();
    let out = await nl.runPass();
    assert.deepEqual(out.refunds, { booked: 0, waiting: 1 });
    assert.ok(out.errors.some((e) => e === "refund " + u.login + ": could not be booked as retired — still committed, tried again next pass"));
    Date.now = () => t0 + 20 * 60 * 1000;
    await gf.syncOnce();
    await nl.runPass();
    assert.deepEqual(told, [], "not yet: it may still clear by itself");
    Date.now = () => t0 + 31 * 60 * 1000;
    await gf.syncOnce();
    await nl.runPass();
    assert.equal(told.length, 1);
    assert.match(told[0], /^⚠️ A refunded Gameflip sale is still not booked/);
    assert.ok(told[0].includes(u.login + " (Overwatch): its Gameflip listing " + u.ext + " was paid for and then cancelled"));
    assert.match(told[0], /stays committed, so it is sold nowhere, and nothing hands it back/);
    Date.now = () => t0 + 5 * 60 * 60 * 1000;
    await gf.syncOnce();
    out = await nl.runPass();
    assert.equal(told.length, 1, "once");
    assert.deepEqual(out.refunds, { booked: 0, waiting: 1 });
  } finally {
    Date.now = realNow;
    ncs.markSold = real.markSold;
  }
  assert.equal((await rowNow(u)).status, "active");
  assert.equal((await ledgerNow(u)).status, "manual");
  assert.equal(await NoclaimSpentAccount.countDocuments({}), 0);
  // The day the write lands again it is finished like any other.
  await gf.syncOnce();
  assert.equal((await rowNow(u)).status, "removed");
  assert.equal((await ledgerNow(u)).note, nl.BURNED_REASON);
});

test("fleet, CANCELLED: nothing that comes later turns the refund back into a sale — a health read begun before it, a second look, the Sold tick", async () => {
  await withNoClaimGames(["overwatch"], async () => {
    // 1. The lifecycle pass is in the middle of a live read of the account —
    // whose refunded buyer had claimed a drop — when the watcher books the refund.
    const u = await fleetUnit();
    gameflip.set(u.ext, "sale_pending"); // paid: the buyer has the login
    await gf.syncOnce();
    assert.equal((await rowNow(u)).status, "active");
    const quiet = settings.getNoclaimShopSettings;
    settings.getNoclaimShopSettings = () => ({ ...quiet(), healthPerPass: 20 });
    ual.inventoryForCandidate = async (cand) => {
      gameflip.set(u.ext, "cancelled");
      await gf.syncOnce();
      return {
        login: cand.login,
        sellable: [],
        inv: { inProgress: [{ name: "A", game: "Overwatch", claimed: true, percent: 100 }], drops: [] },
      };
    };
    try {
      await nl.runPass();
    } finally {
      settings.getNoclaimShopSettings = quiet;
      ual.inventoryForCandidate = real.inventoryForCandidate;
    }
    let led = await ledgerNow(u);
    assert.equal(led.status, "sold");
    assert.equal(led.note, nl.BURNED_REASON, "the read that came back saying 'a drop was claimed' did not re-word it");
    assert.equal(led.soldPriceUsd, 0);

    // 2. The claim layer's own rule, asked directly: a ledger closed over a
    // refund is not re-priced, re-worded or counted by a later "sale" of it…
    assert.equal(await ncs.markSold([u.led._id], { market: "gameflip", priceUsd: 1.49, reason: "buyer claimed a listed drop" }), 0);
    assert.equal(await ncs.markSold([u.led._id], { market: "gameflip", priceUsd: 0, reason: nl.BURNED_REASON }), 0);
    led = await ledgerNow(u);
    assert.equal(led.note, nl.BURNED_REASON);
    assert.equal(led.soldPriceUsd, 0);
    // …while a real sale keeps the rule it had: a repeat with a price records it.
    const sale = await fleetUnit();
    gameflip.set(sale.ext, "sold");
    await gf.syncOnce();
    assert.equal(await ncs.markSold([sale.led._id], { market: "gameflip", priceUsd: 2.5 }), 1);
    assert.equal((await ledgerNow(sale)).soldPriceUsd, 2.5);
    assert.equal((await ledgerNow(sale)).note, "gameflip sale");

    // 3. The owner ticks it Sold before its own clean-up has run, and the
    // fleet's net takes it out of its bot on that tick ("sold by hand").
    await AvailableAccount.updateOne({ _id: u.pool._id }, { $set: { manualSold: true } });
    const cands = [{ source: "noclaim", clientSecret: u.secret, login: u.login, twitchId: "", game: "Overwatch", botId: "7" }];
    const net = await ual.retireSoldFromBots(cands, new Map([[u.secret, await poolNow(u)]]));
    assert.deepEqual(net.errors, []);
    assert.equal(net.retired, 1);
    led = await ledgerNow(u);
    assert.equal(led.note, nl.BURNED_REASON, "the net rewrites a sale's note — never a refund's");
    // The tick changed WHEN it left its bot, never what it is: not a hand sale.
    const view = await spentViewOf(u);
    assert.equal(view.sold, false);
    assert.equal(view.soldWhy, "retired, not sold — " + nl.BURNED_REASON + " — taken out of its bot, handed to the recycler");
    assert.equal(ual.soldRetireReason({ manualSold: true }, { status: "sold", soldAt: new Date(), note: nl.BURNED_REASON }), nl.BURNED_REASON);
    assert.equal(ual.soldRetireReason({ manualSold: true }, { status: "sold", soldAt: new Date(), note: "gameflip sale" }), "sold by hand");
    assert.equal(ual.soldRetireReason({ manualSold: true }, null), "sold by hand");
    const ev = await farmDemand.saleEvidenceByBucket({ days: 30 });
    assert.deepEqual([...ev.units.get("overwatch").keys()], [sale.login], "one sale: the real one");

    // 4. The claim layer's rule is about a CLOSED ledger only: a held claim is
    // booked whatever its note happens to say.
    const held = await fleetUnit({ ledger: { note: "manual no-claim listing — gameflip (its login was seen by nobody)" } });
    assert.equal(await ncs.markSold([held.led._id], { market: "gameflip", priceUsd: 1.49, reason: "gameflip sale" }), 1);
    assert.equal((await ledgerNow(held)).status, "sold");
    assert.equal((await ledgerNow(held)).soldPriceUsd, 1.49);
  });
});

test("fleet, CANCELLED: booked, with its row not retired yet (the row write is what failed) — still no delivery on the owner's summary", async () => {
  await withNoClaimGames(["overwatch"], async () => {
    const u = await fleetUnit();
    gameflip.set(u.ext, "cancelled");
    // The lifecycle's own hook, as the watcher calls it before it retires the row.
    assert.deepEqual(await nl.onGameflipCancelled(u.listing), { burned: 1, pending: 0 });
    const row = await rowNow(u);
    assert.equal(row.status, "active");
    assert.ok(row.units[0].deliveredAt);
    const line = (await require("../routes/unclaimedAutoRoutes").gamesSummary()).games.find((g) => g.game === "overwatch");
    assert.deepEqual(line.shopOffers.map((o) => o.delivered7), [0]);
    assert.deepEqual(line.sold7, { n: 0, usd: 0 });
    // Nothing in the pass, and no button, hands it back or sells it meanwhile.
    const out = await nl.runPass();
    assert.deepEqual(out.errors, []);
    assert.equal((await ledgerNow(u)).status, "sold");
    assert.equal(await ncs.releaseClaim([u.led._id], { reason: "released by hand" }), 0);
    // The watcher's next look retires the row, and that is all it does.
    await gf.syncOnce();
    assert.equal((await rowNow(u)).status, "removed");
    assert.equal((await ledgerNow(u)).note, nl.BURNED_REASON);
  });
});

// The real routers behind the owner's pages, on a loopback port, as a signed-in
// superadmin.
async function withApp(routerPaths, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: { id: "test", username: "test", role: "superadmin", tfa: true } };
    next();
  });
  for (const p of routerPaths) app.use(require(p));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  try {
    return await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("fleet, CANCELLED: no page of the owner's counts or calls the refund a sale — the console, the Unclaimed-farms page, the No-claim page, the activity log", async () => {
  const twitchInventory = require("../utils/twitchInventory");
  const realFetchInventory = twitchInventory.fetchInventory;
  twitchInventory.fetchInventory = async () => ({ inProgress: [], drops: [] });
  try {
    await withNoClaimGames(["overwatch"], () =>
      withApp(
        ["../routes/unclaimedAutoRoutes", "../routes/noclaimFarmRoutes", "../routes/marketplaceConsoleRoutes"],
        async (call) => {
          const refunded = await fleetUnit();
          gameflip.set(refunded.ext, "cancelled");
          await gf.syncOnce();
          const WHY = "retired, not sold — " + nl.BURNED_REASON;

          // --- The marketplace console: not a delivered unit, not revenue. ---
          const card = (await call("GET", "/api/market-console/summary")).markets.find((m) => m.market === "gameflip");
          assert.deepEqual(
            { units: card.deliveredUnits, usd: card.deliveredRevenueUsd, sold: card.soldTotal, revenue: card.revenueUsd },
            { units: 0, usd: 0, sold: 0, revenue: 0 },
          );
          assert.deepEqual((await call("GET", "/api/market-console/gameflip/deliveries")).items, []);

          // --- The Unclaimed-farms page: the Sold stat, the Bundles table, the archive. ---
          assert.equal((await call("GET", "/api/unclaimed-auto/state")).counts.sold, 0);
          const bundles = await call("GET", "/api/unclaimed-auto/bundles");
          assert.deepEqual(bundles.games.map((g) => g.sold), [0]);
          assert.deepEqual(bundles.games.flatMap((g) => g.sets.map((x) => x.sold)), [0]);
          const byGame = (await call("GET", "/api/unclaimed-auto/archive/by-game?status=all")).games;
          assert.equal(byGame[0].byStatus.sold, 0);
          assert.equal(byGame[0].byStatus.retired, 1, "shown as what it is");
          assert.deepEqual((await call("GET", "/api/unclaimed-auto/archive/by-game?status=sold")).games, []);
          assert.equal((await call("GET", "/api/unclaimed-auto/archive/by-game?status=retired")).games[0].accounts, 1);
          const holders = (await call("GET", "/api/unclaimed-auto/archive/item-accounts?status=all&itemKey=" + encodeURIComponent("a|overwatch"))).accounts;
          assert.deepEqual(holders.map((a) => a.status), ["retired"]);
          // …and the Accounts list, whose chip is drawn from this status.
          const list = (q) => call("GET", "/api/unclaimed-auto/accounts" + q).then((j) => j.accounts.map((a) => a.login + ":" + a.status));
          assert.deepEqual(await list(""), [refunded.login + ":retired"]);
          assert.deepEqual(await list("?status=sold"), []);
          assert.deepEqual(await list("?status=retired"), [refunded.login + ":retired"]);

          // --- The No-claim page, while the account is still in its bot. ---
          const bought = await fleetUnit(); // the control: a real sale
          gameflip.set(bought.ext, "sold");
          await gf.syncOnce();
          const scan = await call("GET", "/api/noclaim-farm/spent/scan?botId=7");
          const flagged = Object.fromEntries(scan.spent.map((a) => [a.login, { sold: a.sold, soldWhy: a.soldWhy }]));
          assert.deepEqual(flagged[refunded.login], { sold: false, soldWhy: WHY }, "spent — it must leave the bot — but not sold");
          assert.deepEqual(flagged[bought.login], { sold: true, soldWhy: "sold on gameflip" });
          const drawer = (await call("GET", "/api/noclaim-farm/bots/7/accounts")).accounts;
          const notForSale = Object.fromEntries(drawer.map((a) => [a.login, a.notForSale]));
          assert.equal(notForSale[refunded.login], WHY, "never offered to a buyer, and not called sold");
          assert.equal(notForSale[bought.login], "sold on gameflip");
          // The owner sweeps the bot by hand before the farm's own clean-up has run.
          const swept = await call("POST", "/api/noclaim-farm/spent/remove", { botId: "7", accounts: scan.spent });
          assert.equal(swept.removed, 2);
          let view = await spentViewOf(refunded);
          assert.equal(view.sold, false);
          assert.equal(view.soldWhy, WHY);
          assert.equal((await spentViewOf(bought)).sold, true);
          // …and the farm's own pass after it changes none of that.
          await ncs.spendPending({ limit: 10 });
          view = await spentViewOf(refunded);
          assert.equal(view.sold, false);
          assert.match(view.soldWhy, /^retired, not sold — /);

          // --- The Unclaimed-farms page again, with the real sale beside it. ---
          assert.deepEqual(await list("?status=sold"), [bought.login + ":sold"]);
          assert.equal((await call("GET", "/api/unclaimed-auto/state")).counts.sold, 1);
          const after = (await call("GET", "/api/unclaimed-auto/archive/by-game?status=all")).games[0].byStatus;
          assert.deepEqual({ sold: after.sold, retired: after.retired }, { sold: 1, retired: 1 });

          // --- The activity log: the sale is "sold", the refund never is. ---
          await new Promise((r) => setTimeout(r, 150)); // logEvent writes are not awaited
          const sold = await SystemEvent.find({ action: "sold" }).lean();
          assert.ok(sold.length >= 1);
          for (const e of sold) assert.doesNotMatch(String(e.subject) + " " + String(e.detail), new RegExp(refunded.login + "|login was seen"));
          const retired = (await SystemEvent.find({ action: "retired" }).lean()).map((e) => e.category + ": " + e.detail);
          assert.ok(retired.includes("noclaim_shop: 1 no-claim account(s) retired, not sold (gameflip) — " + nl.BURNED_REASON));
          assert.ok(retired.some((d) => d.startsWith("unclaimed: retired, not sold (" + nl.BURNED_REASON + ") — noclaim account " + refunded.login)));
        },
      ),
    );
  } finally {
    twitchInventory.fetchInventory = realFetchInventory;
  }
});

test("a refund that was seen is never handed back, whatever Gameflip or the owner says about the listing afterwards — and the pass books it", async () => {
  // Seen cancelled, the booking failing. Then the row is retired by an
  // ORDINARY answer — each of which hands an account back.
  const pendingRefund = async (make = fleetUnit) => {
    const u = await make();
    gameflip.set(u.ext, "cancelled");
    ncs.markSold = async () => 0;
    try {
      await gf.syncOnce();
    } finally {
      ncs.markSold = real.markSold;
    }
    assert.equal((await rowNow(u)).status, "active");
    assert.equal((await ledgerNow(u)).status, "manual");
    return u;
  };
  const stillCommitted = async (u) => {
    const led = await ledgerNow(u);
    assert.ok(led, "NOT released");
    assert.equal(led.status, "manual");
  };
  const failingStill = async (fn) => {
    ncs.markSold = async () => 0;
    try {
      return await fn();
    } finally {
      ncs.markSold = real.markSold;
    }
  };

  // The listing is deleted on Gameflip: its own 404.
  const gone = await pendingRefund();
  gameflip.delete(gone.ext);
  await failingStill(() => gf.syncOnce());
  assert.equal((await rowNow(gone)).status, "removed", "the listing is gone: its row is retired");
  await stillCommitted(gone);
  // The listing reads expired.
  const expired = await pendingRefund();
  gameflip.set(expired.ext, "expired");
  await failingStill(() => gf.syncOnce());
  assert.equal((await rowNow(expired)).status, "removed");
  await stillCommitted(expired);
  // The owner delists what is left, once Gameflip no longer has the listing.
  const delisted = await pendingRefund();
  gameflip.delete(delisted.ext);
  await nl.beforeDelist(delisted.listing);
  await MarketplaceListing.updateOne({ _id: delisted.listing._id }, { $set: { status: "delisted" } });
  assert.deepEqual(await nl.afterDelist(delisted.listing, { outcome: "", gone: true }), { released: 0, sold: 0, held: 0 });
  await stillCommitted(delisted);
  // An auto-farm account: its limbo step would ask Gameflip, hear "gone" and release.
  const farm = await pendingRefund(() => heldUnit({ goneInHours: 100 }));
  gameflip.delete(farm.ext);
  await failingStill(() => gf.syncOnce());
  assert.equal((await rowNow(farm)).status, "removed");
  let out = await failingStill(() => nl.runPass());
  assert.deepEqual(out.limbo, { released: 0, sold: 0, retried: 0 });
  assert.equal(out.refunds.waiting, 4);
  await assertStillHeld(farm);
  // A hand release of any of them is refused by the claim layer itself.
  for (const u of [gone, expired, delisted, farm]) {
    assert.equal(await ncs.releaseClaim([u.led._id], { reason: "released by hand", listingGone: true }), 0);
    await stillCommitted(u);
  }
  assert.deepEqual(told, [], "nothing is said while it may still clear by itself");

  // The write lands: the pass books every one of them, wherever its row ended up.
  out = await nl.runPass();
  assert.deepEqual(out.refunds, { booked: 4, waiting: 0 });
  for (const u of [gone, expired, delisted, farm]) {
    const led = await ledgerNow(u);
    assert.equal(led.status, "sold");
    assert.equal(led.note, nl.BURNED_REASON);
    assert.equal(led.soldPriceUsd, 0);
    const unit = (await rowNow(u)).units[0];
    assert.equal(unit.orderId, "gameflip-cancelled");
    assert.ok(unit.deliveredAt);
  }
  assert.equal(out.spend, 3, "and the same pass takes the three no-claim bot accounts out of their bot");
  assert.deepEqual(fleetLogins("7"), []);
  out = await nl.runPass();
  assert.deepEqual(out.refunds, { booked: 0, waiting: 0 });

  // A listing that was never seen cancelled and is simply gone: the old rule.
  const plain = await fleetUnit();
  gameflip.delete(plain.ext);
  await gf.syncOnce();
  assert.equal(await ledgerNow(plain), null, "handed back");
});

test("a refund that was seen survives the lapsed lane too — the row's units are cleared there, the refund's mark is not", async () => {
  // Seen cancelled, the booking failing; then the listing's date passes and
  // the watcher ends and settles it as LAPSED — the lane that empties a row.
  const u = await fleetUnit();
  gameflip.set(u.ext, "cancelled");
  ncs.markSold = async () => 0;
  try {
    await gf.syncOnce();
    assert.equal((await rowNow(u)).units[0].orderId, "gameflip-cancelled");
    gameflip.set(u.ext, { status: "onsale", expired: true, expiration: "2026-10-01T00:00:00.000Z" });
    await gf.syncOnce();
  } finally {
    ncs.markSold = real.markSold;
  }
  const row = await rowNow(u);
  assert.equal(row.status, "removed", "settled as lapsed");
  assert.deepEqual(row.units.map((x) => [x.login, x.orderId, x.deliveredAt]), [[u.login, "gameflip-cancelled", null]]);
  assert.equal((await ledgerNow(u)).status, "manual", "NOT handed back");
  assert.equal(await ncs.releaseClaim([u.led._id], { reason: "released by hand", listingGone: true }), 0);
  // …so the pass can still book it.
  const out = await nl.runPass();
  assert.deepEqual(out.refunds, { booked: 1, waiting: 0 });
  assert.equal((await ledgerNow(u)).note, nl.BURNED_REASON);

  // An ordinary lapsed listing is what it was: its account handed back, its row emptied.
  const plain = await fleetUnit();
  gameflip.set(plain.ext, { status: "onsale", expired: true, expiration: "2026-10-01T00:00:00.000Z" });
  await gf.syncOnce();
  assert.equal((await rowNow(plain)).status, "removed");
  assert.deepEqual((await rowNow(plain)).units, []);
  assert.equal(await ledgerNow(plain), null, "released");
});

test("the claim layer's own rule: a refunded account is never released — found by its login when its claim points at no row, and a check that cannot be made is not a yes", async () => {
  // A claim whose attach never landed (it points at no listing), its refund seen and not booked.
  const loose = await fleetUnit({ attached: false });
  await MarketplaceListing.updateOne({ _id: loose.listing._id }, { $set: { status: "removed", "units.0.orderId": "gameflip-cancelled" } });
  assert.equal(await ncs.refundSeenFor(await ledgerNow(loose)), true);
  assert.equal(await ncs.releaseClaim([loose.led._id], { reason: "released by hand", listingGone: true }), 0);
  assert.equal((await ledgerNow(loose)).status, "manual");
  // Booked: its own row says so for good — and a "sold" ledger is not releasable anyway.
  const booked = await fleetUnit();
  gameflip.set(booked.ext, "cancelled");
  await gf.syncOnce();
  assert.equal(await ncs.refundSeenFor(await ledgerNow(booked)), true);
  // An ordinary committed account: not a refund, released as ever…
  const plain = await fleetUnit();
  await MarketplaceListing.updateOne({ _id: plain.listing._id }, { $set: { status: "delisted" } });
  assert.equal(await ncs.refundSeenFor(await ledgerNow(plain)), false);
  // …unless whether it was refunded cannot be read: then the release waits.
  const realFindOne = MarketplaceListing.findOne;
  MarketplaceListing.findOne = function (filter, ...rest) {
    if (filter && filter.noclaimStock === true && filter.$or) throw new Error("MongoNetworkTimeoutError");
    return realFindOne.call(this, filter, ...rest);
  };
  try {
    assert.equal(await ncs.releaseClaim([plain.led._id], { reason: "listing delisted" }), 0);
  } finally {
    MarketplaceListing.findOne = realFindOne;
  }
  assert.equal((await ledgerNow(plain)).status, "manual");
  assert.equal(await ncs.releaseClaim([plain.led._id], { reason: "listing delisted" }), 1);
  assert.equal(await ledgerNow(plain), null);
  // One failed read is asked again before the release is given up…
  const once = await fleetUnit();
  await MarketplaceListing.updateOne({ _id: once.listing._id }, { $set: { status: "delisted" } });
  let reads = 0;
  MarketplaceListing.findOne = function (filter, ...rest) {
    if (filter && filter.noclaimStock === true && filter.$or && reads++ === 0) throw new Error("MongoNetworkTimeoutError");
    return realFindOne.call(this, filter, ...rest);
  };
  try {
    assert.equal(await ncs.releaseClaim([once.led._id], { reason: "listing delisted" }), 1);
  } finally {
    MarketplaceListing.findOne = realFindOne;
  }
  assert.equal(reads, 2);
  // …and a unit stored under another letter case of the login is the same account.
  const cased = await fleetUnit({ attached: false });
  await MarketplaceListing.updateOne(
    { _id: cased.listing._id },
    { $set: { status: "removed", "units.0.orderId": "gameflip-cancelled", "units.0.login": cased.login.toUpperCase() } },
  );
  assert.equal(await ncs.refundSeenFor(await ledgerNow(cased)), true);
  assert.equal(await ncs.releaseClaim([cased.led._id], { reason: "released by hand" }), 0);
  // An older, BOOKED refund of the same login on some other row does not hold a later claim.
  const again = await fleetUnit();
  await MarketplaceListing.create({
    set: again.set._id, marketplace: "gameflip", externalId: "gf-old-life", title: "old", price: 1, status: "removed",
    origin: "manual", noclaimStock: true, autoDeliver: true, accountId: "", accountLogin: again.login,
    units: [{ contentId: "", accountId: "", login: again.login, addedAt: new Date(1), deliveredAt: new Date(2), orderId: "gameflip-cancelled" }],
  });
  assert.equal(await ncs.refundSeenFor(await ledgerNow(again)), false);
});
