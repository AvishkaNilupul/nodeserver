// Games the owner keeps out of the auto-lister (autoFarm.autoListSkipGames).
//
// Started as "no Gameflip listing for these games" and became "no auto-listing
// at all" once it was clear that Gameflip is what every auto-listing is built
// on (see autoListSkippedFor in utils/autoLister.js).
//
// These tests drive the REAL listActivatedTask, retryMissingSecondaries,
// refillMarkets, listStackedBundle and publishEventBundleFor against an
// in-memory Mongo (real holdings gate, real reservations, real rows); only the
// calls that would leave the process are stubbed: Twitch's campaign read and
// the marketplaces' own calls.
//
// What has to hold:
//   - the list empty (the default): a bundle is listed exactly as before;
//   - a game on the list: nothing is read from Twitch, nothing is published or
//     reserved on ANY market, and the task says why — written once;
//   - what is already listed is left alone, and gets nothing new;
//   - off the list again: the same task lists on the next sweep.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const settings = require("../utils/settings");
const mp = require("../utils/marketplaces");
const twitchInventory = require("../utils/twitchInventory");
const autoLister = require("../utils/autoLister");
const { itemKeyFor } = twitchInventory;

const GAME = "Skip Test Game";
const ITEMS = ["Alpha Skin", "Beta Charm"];
const NOTE = "not listed: Skip Test Game is kept out of the auto-lister (autoFarm.autoListSkipGames)";

let mem;
let AF = {};
let calls = [];
let gfStatus = "onsale";
let seq = 0;
const orig = {};
const STUBBED = ["gameflipPublish", "gameflipListingStatus", "gameflipReprice", "gameflipDelist", "ggselResolveCategoryId", "ggselPublish", "ggselOfferStock", "ggselAddProducts", "ggselFinalizeStock", "zeusxResolveCategory", "eldoradoPublish", "eldoradoDelist"];

// The auto-farm settings the lister reads. Eldorado and GGSel are on, so a
// listed bundle would go to three markets; the skip list is the default (empty)
// unless a test sets it.
function af() {
  return {
    eldoradoAuto: true,
    zeusxAuto: false,
    g2gAuto: false,
    playerauctionsAuto: false,
    platiCategoryId: "",
    platiEnabled: false,
    ggselEnabled: true,
    ggselCategoryId: "",
    autoFarmEventBundles: false,
    perMarketStock: 3,
    ...AF,
  };
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("autolistskip"));
  for (const k of STUBBED) orig[k] = mp[k];
  orig.getAutoFarm = settings.getAutoFarm;
  orig.fetchCampaignDetails = twitchInventory.fetchCampaignDetails;
  settings.getAutoFarm = af;
  twitchInventory.fetchCampaignDetails = async () => {
    calls.push(["twitchCampaignRead"]);
    return {
      game: { displayName: GAME, name: GAME },
      timeBasedDrops: ITEMS.map((name) => ({
        requiredMinutesWatched: 60,
        benefitEdges: [{ benefit: { name, imageAssetURL: "", game: { displayName: GAME, name: GAME } } }],
      })),
    };
  };
  const pub = (market, idKey) => async (o) => {
    calls.push([market + "Publish", o.title]);
    const id = market.slice(0, 3) + "-" + ++seq;
    return { [idKey]: id, url: "https://" + market + ".test/" + id };
  };
  mp.gameflipPublish = pub("gameflip", "externalId");
  mp.eldoradoPublish = pub("eldorado", "id");
  mp.ggselPublish = pub("ggsel", "externalId");
  mp.gameflipListingStatus = async (id) => {
    calls.push(["gameflipListingStatus", id]);
    if (gfStatus instanceof Error) throw gfStatus;
    return gfStatus;
  };
  mp.gameflipReprice = async (id) => void calls.push(["gameflipReprice", id]);
  mp.gameflipDelist = async (id) => void calls.push(["gameflipDelist", id]);
  mp.ggselResolveCategoryId = async () => "777";
  mp.ggselOfferStock = async (id) => {
    calls.push(["ggselOfferStock", id]);
    return 0;
  };
  mp.ggselAddProducts = async (id) => void calls.push(["ggselAddProducts", id]);
  mp.ggselFinalizeStock = async () => {};
  mp.zeusxResolveCategory = async () => null;
  mp.eldoradoDelist = async () => {};
});

test.after(async () => {
  for (const k of STUBBED) mp[k] = orig[k];
  settings.getAutoFarm = orig.getAutoFarm;
  twitchInventory.fetchCampaignDetails = orig.fetchCampaignDetails;
  await mongoose.disconnect();
  await mem.stop();
});

// A task of `n` accounts, each holding every item of the campaign, unsold.
async function seedTask(n, { game = GAME } = {}) {
  await Promise.all([AutoFarmTask.deleteMany({}), BotAccount.deleteMany({}), DropLog.deleteMany({}), DropSet.deleteMany({}), MarketplaceListing.deleteMany({})]);
  calls = [];
  gfStatus = "onsale";
  const logins = [];
  for (let i = 1; i <= n; i++) {
    const login = "holder" + i;
    logins.push(login);
    const acc = await BotAccount.create({ login, clientSecret: "secret-" + i + "-" + ++seq, credPassword: "pw" + i, lastScanStatus: "ok", lastScanAt: new Date() });
    for (const name of ITEMS) {
      await DropLog.create({ account: acc._id, login, benefitId: name + "-" + i, name, game: GAME, itemKey: itemKeyFor(name, GAME), count: 1, connected: false, soldAt: null });
    }
  }
  return AutoFarmTask.create({ game, campaignId: "camp-" + ++seq, campaignName: "Launch Drops", decision: "farm", assignedAccounts: logins });
}

const called = (name) => calls.filter((c) => c[0] === name);
const published = () => calls.filter((c) => /Publish$/.test(c[0]));
const reserved = () => DropLog.countDocuments({ soldAt: { $ne: null } });
const fresh = (id) => AutoFarmTask.findById(id);

/* ------------------------------ the rule itself --------------------------- */

test("the list matches a game by its exact normalised label, and is empty by default", () => {
  const { autoListSkippedFor } = autoLister;
  assert.equal(autoListSkippedFor("World of Tanks", {}), false);
  assert.equal(autoListSkippedFor("World of Tanks", undefined), false);
  assert.equal(autoListSkippedFor("World of Tanks", { autoListSkipGames: [] }), false);
  assert.equal(autoListSkippedFor("World of Tanks", { autoListSkipGames: "World of Tanks" }), false);
  const list = { autoListSkipGames: ["world of tanks", "NARAKA: BLADEPOINT", "Rust"] };
  assert.equal(autoListSkippedFor("World of Tanks", list), true);
  assert.equal(autoListSkippedFor("  WORLD   OF-TANKS ", list), true);
  assert.equal(autoListSkippedFor("Naraka Bladepoint", list), true);
  // exact, never a part of another name
  assert.equal(autoListSkippedFor("World of Tanks Console", list), false);
  assert.equal(autoListSkippedFor("Rustler", list), false);
  assert.equal(autoListSkippedFor("", list), false);
  assert.equal(autoListSkippedFor("Rust", { autoListSkipGames: ["", null] }), false);
});

test('"*" on the list is every game, a new one and a blank label included', () => {
  const { autoListSkippedFor } = autoLister;
  const all = { autoListSkipGames: ["*"] };
  assert.equal(autoListSkippedFor("World of Tanks", all), true);
  assert.equal(autoListSkippedFor("A Game Nobody Has Farmed Yet", all), true);
  assert.equal(autoListSkippedFor("", all), true);
  assert.equal(autoListSkippedFor("Rust", { autoListSkipGames: ["Rust", " * "] }), true);
  assert.equal(autoListSkippedFor("Rustler", { autoListSkipGames: ["Rust", " * "] }), true);
  // only a lone "*" — never a label that merely contains one, nor junk entries
  assert.equal(autoListSkippedFor("Rustler", { autoListSkipGames: ["Rust*"] }), false);
  assert.equal(autoListSkippedFor("Rustler", { autoListSkipGames: ["Rust", null, 7, ["*"]] }), false);
});

test('"*": a fresh bundle of any game is not read, published or reserved', async () => {
  AF = { autoListSkipGames: ["*"] };
  const task = await seedTask(6);
  const r = await autoLister.listActivatedTask(task._id);
  assert.deepEqual(r, { skipped: "game is kept out of the auto-lister", waiting: true });
  assert.deepEqual(calls, []);
  assert.equal(await DropSet.countDocuments({}), 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.equal(await reserved(), 0);
  const t = await fresh(task._id).lean();
  assert.equal(t.listing.error, NOTE);
  assert.ok(!t.listing.externalId);
  AF = {};
});

test("the shipped default is an empty list", () => {
  // The real settings module, not the stub the other tests read through.
  assert.deepEqual(orig.getAutoFarm.call(settings).autoListSkipGames, []);
});

/* ------------------------------ a new bundle ------------------------------ */

test("list empty (the default): the bundle is listed on every market, as before", async () => {
  AF = {};
  const task = await seedTask(6);
  const r = await autoLister.listActivatedTask(task._id);
  assert.ok(r.listed, JSON.stringify(r));
  assert.equal(called("twitchCampaignRead").length, 1);
  assert.deepEqual(published().map((c) => c[0]).sort(), ["eldoradoPublish", "gameflipPublish", "ggselPublish"]);
  const t = await fresh(task._id).lean();
  assert.match(t.listing.externalId, /^gam-/);
  assert.equal(t.listing.error, "");
  assert.equal(t.listing.heldBack, 3);
  assert.deepEqual((await MarketplaceListing.find({}).lean()).map((x) => x.marketplace).sort(), ["eldorado", "gameflip", "ggsel"]);
  assert.equal(await DropSet.countDocuments({}), 1);
  assert.ok((await reserved()) > 0);
});

test("a game on the list: nothing is read, published or reserved, and the task says why", async () => {
  AF = { autoListSkipGames: ["skip   test-game"] };
  const task = await seedTask(6);
  const r = await autoLister.listActivatedTask(task._id);
  assert.deepEqual(r, { skipped: "game is kept out of the auto-lister", waiting: true });
  // not even Twitch is asked: the campaign's items are only needed to list
  assert.deepEqual(calls, []);
  assert.equal(await DropSet.countDocuments({}), 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.equal(await reserved(), 0);
  const t = await fresh(task._id).lean();
  assert.equal(t.listing.error, NOTE);
  // still reads as NOT listed everywhere "is it listed?" is asked
  assert.ok(!t.listing.externalId);
  assert.ok(!t.listing.setId);
});

test("the note is written once, not on every sweep", async () => {
  AF = { autoListSkipGames: [GAME] };
  const task = await seedTask(2);
  await autoLister.listActivatedTask(task._id);
  const first = (await fresh(task._id).lean()).updatedAt.getTime();
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 3; i++) {
    const r = await autoLister.listActivatedTask(task._id);
    assert.equal(r.waiting, true);
  }
  assert.equal((await fresh(task._id).lean()).updatedAt.getTime(), first);
  assert.deepEqual(calls, []);
});

test("a dry run of a game on the list previews nothing and writes nothing", async () => {
  AF = { autoListSkipGames: [GAME] };
  const task = await seedTask(3);
  const before = (await fresh(task._id).lean()).updatedAt.getTime();
  await new Promise((r) => setTimeout(r, 15));
  const r = await autoLister.listActivatedTask(task._id, { dryRun: true });
  assert.equal(r.waiting, true);
  assert.equal(r.wouldList, undefined);
  const t = await fresh(task._id).lean();
  assert.equal(t.updatedAt.getTime(), before);
  assert.ok(!(t.wouldList && t.wouldList.title));
  assert.deepEqual(calls, []);
});

test("off the list again: the same task lists on the next sweep, and the note is gone", async () => {
  AF = { autoListSkipGames: [GAME] };
  const task = await seedTask(6);
  await autoLister.listActivatedTask(task._id);
  assert.equal((await fresh(task._id).lean()).listing.error, NOTE);
  AF = { autoListSkipGames: ["Some Other Game"] };
  const r = await autoLister.listActivatedTask(task._id);
  assert.ok(r.listed, JSON.stringify(r));
  const t = await fresh(task._id).lean();
  assert.match(t.listing.externalId, /^gam-/);
  assert.equal(t.listing.error, "");
  assert.equal(published().length, 3);
});

test("a stale dry-run preview is cleared when the game joins the list", async () => {
  AF = {};
  const task = await seedTask(3);
  await autoLister.listActivatedTask(task._id, { dryRun: true });
  assert.ok((await fresh(task._id).lean()).wouldList.title);
  AF = { autoListSkipGames: [GAME] };
  await autoLister.listActivatedTask(task._id);
  const t = await fresh(task._id).lean();
  assert.ok(!(t.wouldList && t.wouldList.title));
  assert.equal(t.listing.error, NOTE);
});

/* ------------------------- what is already listed ------------------------- */

// A task listed while its game was NOT on the list, then the game joins it.
async function listedThenSkipped(n, { loseEldorado = false } = {}) {
  AF = {};
  const task = await seedTask(n);
  await autoLister.listActivatedTask(task._id);
  if (loseEldorado) {
    // its Eldorado share never landed: a market the task is "missing"
    await MarketplaceListing.deleteMany({ marketplace: "eldorado" });
    await DropLog.updateMany({ soldToUsername: /eldorado/i }, { $set: { soldAt: null, soldToUsername: "", soldSetId: "" } });
    await AutoFarmTask.updateOne({ _id: task._id }, { $set: { "listing.eldorado": { externalId: "", url: "", qty: 0, error: "x" } } });
  }
  AF = { autoListSkipGames: [GAME] };
  calls = [];
  return task;
}

test("an existing listing is left alone: still 'already listed', its rows and reservations untouched", async () => {
  const task = await listedThenSkipped(6);
  const rowsBefore = await MarketplaceListing.find({}).sort({ _id: 1 }).lean();
  const reservedBefore = await reserved();
  const r = await autoLister.listActivatedTask(task._id);
  assert.equal(r.skipped, "already listed");
  // Gameflip is still asked whether the listing is alive, exactly as before
  assert.equal(called("gameflipListingStatus").length, 1);
  assert.equal(published().length, 0);
  assert.deepEqual(await MarketplaceListing.find({}).sort({ _id: 1 }).lean(), rowsBefore);
  assert.equal(await reserved(), reservedBefore);
  const t = await fresh(task._id).lean();
  assert.match(t.listing.externalId, /^gam-/);
  assert.equal(t.listing.error, "");
});

test("no new share on a market the task is missing", async () => {
  const task = await listedThenSkipped(6, { loseEldorado: true });
  // with the game off the list this very call would publish the Eldorado share
  assert.equal(await autoLister.retryMissingSecondaries(await fresh(task._id)), null);
  assert.equal((await autoLister.listActivatedTask(task._id)).skipped, "already listed");
  assert.equal(published().length, 0);
  assert.equal(await MarketplaceListing.countDocuments({ marketplace: "eldorado" }), 0);

  AF = {};
  calls = [];
  const retried = await autoLister.retryMissingSecondaries(await fresh(task._id));
  assert.deepEqual(retried, ["eldorado"]);
  assert.equal(called("eldoradoPublish").length, 1);
});

test("no stock top-up, and never a raised farming target", async () => {
  const task = await listedThenSkipped(6);
  const gfBefore = (await MarketplaceListing.findOne({ marketplace: "gameflip" }).lean()).qtyRemaining;
  assert.equal(await autoLister.refillMarkets(await fresh(task._id), { perMarketStock: 3 }), null);
  assert.deepEqual(calls, []);
  assert.equal((await MarketplaceListing.findOne({ marketplace: "gameflip" }).lean()).qtyRemaining, gfBefore);

  // off the list the same call tops the markets up
  AF = {};
  const acts = await autoLister.refillMarkets(await fresh(task._id), { perMarketStock: 3 });
  assert.ok(Array.isArray(acts) && acts.length > 0, JSON.stringify(acts));
});

test("no stacked or event bundle, even for a task listed before the game joined the list", async () => {
  const task = await listedThenSkipped(4);
  assert.deepEqual(await autoLister.listStackedBundle(task._id), { skipped: "game is kept out of the auto-lister" });
  assert.deepEqual(await autoLister.publishEventBundleFor(await fresh(task._id), { key: "k", taskIds: [], items: [] }, false), { skipped: "game is kept out of the auto-lister" });
  assert.deepEqual(calls, []);
  // off the list both are past that gate again
  AF = {};
  assert.notEqual((await autoLister.listStackedBundle(task._id)).skipped, "game is kept out of the auto-lister");
  assert.notEqual((await autoLister.publishEventBundleFor(await fresh(task._id), { key: "k", taskIds: [], items: [] }, false)).skipped, "game is kept out of the auto-lister");
});

test("a Gameflip listing that is gone is retired as before — and not listed again", async () => {
  const task = await listedThenSkipped(4);
  gfStatus = new Error("Gameflip HTTP 404 not found");
  const r = await autoLister.listActivatedTask(task._id);
  assert.equal(r.waiting, true);
  assert.equal(called("gameflipListingStatus").length, 1);
  assert.equal(published().length, 0);
  assert.equal((await MarketplaceListing.findOne({ marketplace: "gameflip" }).lean()).status, "removed");
  const t = await fresh(task._id).lean();
  assert.ok(!t.listing.externalId);
  assert.equal(t.listing.error, NOTE);
  assert.equal(await DropSet.countDocuments({}), 1);
});

test("a Gameflip status that cannot be read keeps the record, on or off the list", async () => {
  const task = await listedThenSkipped(4);
  gfStatus = new Error("Gameflip HTTP 503 timeout");
  const r = await autoLister.listActivatedTask(task._id);
  assert.match(r.skipped, /already listed \(status check failed/);
  assert.match((await fresh(task._id).lean()).listing.externalId, /^gam-/);
});
