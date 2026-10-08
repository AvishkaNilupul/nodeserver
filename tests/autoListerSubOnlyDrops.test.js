// Campaigns with a subscriber-only drop, end to end.
//
// Twitch lets a campaign mix watch-time drops with a drop only a paying
// subscriber gets (requiredSubs > 0). The bots drop that one from their own
// list, so no farmed account ever holds it — but the auto-lister built the
// bundle from EVERY drop, and "an account holds the full bundle" never came
// true. On prod, 2026-10-08, all three tasks ever run on such a campaign were
// farmed and never listed: PAYDAY 3 (18 accounts holding all three watch
// drops), CONTROL Resonant (a 15-account probe that could never record a sale)
// and WARDOGS (completed, 13 accounts still holding the item). Their storefront
// pre-order cards advertised the unearnable item too.
//
// Every test here drives the real lister, the real holdings gate, the lane's
// verify and monitor steps and the real pre-order stamp against an in-memory
// Mongo. Twitch is the only stub.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const FarmJob = require("../models/FarmJob");
const twitchInventory = require("../utils/twitchInventory");
const autoLister = require("../utils/autoLister");
const { stampPreorderSet } = require("../utils/catalogPreorder");
const jobs = require("../utils/farm2/jobs");
const monitorStep = require("../utils/farm2/steps/monitor");
const verifyStep = require("../utils/farm2/steps/verify");

const { itemKeyFor } = twitchInventory;

const drop = (minutes, subs, name, game) => ({
  requiredMinutesWatched: minutes,
  requiredSubs: subs,
  benefitEdges: [{ benefit: { name, imageAssetURL: "https://x/" + name + ".png", game: { displayName: game } } }],
});

// The campaigns as Twitch returned them on 2026-10-08.
const CAMPAIGNS = {
  payday: {
    game: { displayName: "PAYDAY 3" },
    timeBasedDrops: [drop(0, 1, "Dallas", "PAYDAY 3"), drop(30, 0, "Chains", "PAYDAY 3"), drop(60, 0, "Hoxton", "PAYDAY 3"), drop(90, 0, "Wolf", "PAYDAY 3")],
  },
  wardogs: {
    game: { displayName: "WARDOGS" },
    timeBasedDrops: [drop(30, 0, "WARDOG", "WARDOGS"), drop(0, 1, "WARLORD", "WARDOGS")],
  },
  badge: {
    game: { displayName: "Metaphor: ReFantazio" },
    timeBasedDrops: [drop(0, 1, "Homo Tenta Badge", "Metaphor: ReFantazio")],
  },
  // The older guard's case: the only "drop" is the game's own title.
  placeholder: {
    game: { displayName: "Some Game" },
    timeBasedDrops: [{ requiredMinutesWatched: 60, requiredSubs: 0, benefitEdges: [{ benefit: { name: "Some Game" } }] }],
  },
};

let mem;
const fetched = [];
const origFetch = twitchInventory.fetchCampaignDetails;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("subonlydrops"));
  await FarmJob.init();
  twitchInventory.fetchCampaignDetails = async (token, id) => {
    fetched.push({ id: String(id), token: String(token) });
    const camp = CAMPAIGNS[id];
    if (!camp) throw new Error("Campaign details unavailable");
    return camp;
  };
});

test.after(async () => {
  twitchInventory.fetchCampaignDetails = origFetch;
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(() => {
  fetched.length = 0;
  autoLister._subOnlyCampaigns.clear();
  monitorStep._postEventChecked.clear();
});

const liveLane = (game) => ({ game, gameKey: game.toLowerCase(), mode: "live" });
const daysAgo = (d) => new Date(Date.now() - d * 864e5);

// An account that has claimed `names` for `game`, unsold and unconnected.
async function account(login, game, names) {
  const acc = await BotAccount.create({ login, clientSecret: "tok-" + login, credPassword: "pw-" + login, lastScanStatus: "ok", lastScanAt: new Date() });
  for (const name of names) {
    await DropLog.create({ account: acc._id, login, benefitId: login + ":" + name, name, game, itemKey: itemKeyFor(name, game), count: 1 });
  }
  return acc;
}

function farmTask(game, campaignId, campaignName, logins, over = {}) {
  return AutoFarmTask.create({
    game,
    campaignId,
    campaignName,
    decision: "farm",
    status: "active",
    assignedAccounts: logins,
    bots: [{ host: "pi", file: "c.json", container: "b" }],
    executedAt: daysAgo(5),
    campaignEndAt: new Date(Date.now() + 48 * 3600e3),
    ...over,
  });
}

test("a campaign that mixes watch drops with a subscriber-only drop lists on the items its accounts can earn", async () => {
  const game = "PAYDAY 3";
  for (const login of ["pd1", "pd2", "pd3"]) await account(login, game, ["Chains", "Hoxton", "Wolf"]);
  await account("pd4", game, ["Chains", "Hoxton"]); // still farming the 90-minute drop
  const task = await farmTask(game, "payday", "PAYDAY 3", ["pd1", "pd2", "pd3", "pd4"]);

  const items = await autoLister.campaignItems("payday", game, "PAYDAY 3");
  assert.deepEqual(
    items.map((i) => i.name),
    ["Chains", "Hoxton", "Wolf"],
  );

  // Why it never listed: the bundle as Twitch describes it, sub drop included,
  // is one nobody holds — while three accounts hold everything they can earn.
  const withSubDrop = [...items, { itemKey: itemKeyFor("Dallas", game), name: "Dallas", game, qty: 1 }];
  assert.equal((await autoLister.verifiedHoldersForItems(task, withSubDrop)).length, 0);
  assert.equal((await autoLister.verifiedHoldersForItems(task, items)).length, 3);

  // The lane's gate, which decides whether a publish job is queued at all.
  const check = await verifyStep.verifyTask(task.toObject());
  assert.equal(check.ok, true);
  assert.equal(check.verified, 3);
  assert.equal(check.assigned, 4);
  assert.deepEqual(
    check.items.map((i) => i.name),
    ["Chains", "Hoxton", "Wolf"],
  );
  const report = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(report.listable, 1);
  assert.equal(report.queuedPrimary, 1);
  const job = await FarmJob.findOne({ lane: game, kind: "publish", market: "primary" }).lean();
  assert.equal(String(job.taskId), String(task._id));
  assert.equal(job.payload.verified, 3);

  // What the listing would say (dry run: no marketplace is contacted).
  const preview = await autoLister.listActivatedTask(task._id, { dryRun: true });
  assert.equal(preview.wouldList.title, "PAYDAY 3 Twitch Drops (3 Items) — Chains + Hoxton +1 more");
  assert.equal(preview.wouldList.qty, 2, "half of the four assigned accounts now, the rest held back");

  // The storefront pre-order card promises the same three items.
  await stampPreorderSet(task.toObject(), { DropSet, campaignItems: autoLister.campaignItems, derivePrice: autoLister.derivePrice, research: null });
  const card = await DropSet.findOne({ sourceType: "autofarm_event", sourceEventKey: "autofarm:payday" }).lean();
  assert.deepEqual(
    card.items.map((i) => i.name),
    ["Chains", "Hoxton", "Wolf"],
  );
  assert.equal(card.catalogState, "preorder");
  assert.equal(card.requiredWatchMinutes, 90);
});

test("a completed task on such a campaign is queued for its post-event listing", async () => {
  const game = "WARDOGS";
  for (const login of ["wd1", "wd2"]) await account(login, game, ["WARDOG"]);
  const task = await farmTask(game, "wardogs", "WARDOGS Beta & Launch", ["wd1", "wd2"], {
    decision: "reuse_existing",
    status: "completed",
    campaignEndAt: daysAgo(8),
    completedAt: daysAgo(8),
  });
  const report = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(report.postEventChecked, 1);
  assert.equal(report.postEventListable, 1);
  assert.equal(report.postEventQueued, 1);
  const job = await FarmJob.findOne({ lane: game, kind: "publish", market: "primary" }).lean();
  assert.equal(String(job.taskId), String(task._id));
  assert.equal(job.payload.postEvent, true);
  assert.equal(job.payload.verified, 2);
});

test("a campaign whose every drop is subscriber-only lists nothing, stamps no pre-order, and asks Twitch once", async () => {
  const game = "Metaphor: ReFantazio";
  await account("mt1", game, []);
  await account("mt2", game, []);
  const task = await farmTask(game, "badge", "Homo Tenta Badge", ["mt1", "mt2"], { decision: "probe" });

  await assert.rejects(autoLister.campaignItems("badge", game, "Homo Tenta Badge"), (e) => {
    assert.equal(e.code, autoLister.SUB_ONLY_CAMPAIGN);
    assert.match(e.message, /only subscriber-only drops/);
    return true;
  });
  assert.equal(fetched.length, 1, "the answer is the campaign's own — no second token is asked");

  // Not listed, and said so — not "waiting for an account to hold the full bundle".
  const check = await verifyStep.verifyTask(task.toObject());
  assert.equal(check.ok, false);
  assert.match(check.reason, /only subscriber-only drops/);
  await assert.rejects(autoLister.listActivatedTask(task._id, { dryRun: true }), { code: autoLister.SUB_ONLY_CAMPAIGN });
  assert.equal((await AutoFarmTask.findById(task._id).lean()).wouldList?.title || "", "");
  const report = await monitorStep.monitorLane(liveLane(game), { jobs, shadow: false, cache: new Map() });
  assert.equal(report.listable, 0);
  assert.equal(report.queuedPrimary, 0);
  assert.equal(await FarmJob.countDocuments({ lane: game }), 0);

  // No storefront card for a reward no account will ever hold.
  const stamped = await stampPreorderSet(task.toObject(), { DropSet, campaignItems: autoLister.campaignItems, derivePrice: autoLister.derivePrice, research: null });
  assert.equal(stamped, null);
  assert.equal(await DropSet.countDocuments({ sourceEventKey: "autofarm:badge" }), 0);

  assert.equal(fetched.length, 1, "every sweep after the first is answered from memory");

  // Remembered for hours, not for good: a campaign can gain a watch drop.
  const ask = () => assert.rejects(autoLister.campaignItems("badge", game, "Homo Tenta Badge"), { code: autoLister.SUB_ONLY_CAMPAIGN });
  autoLister._subOnlyCampaigns.set("badge", Date.now() - 5 * 3600e3);
  await ask();
  assert.equal(fetched.length, 1, "five hours on, still remembered");
  autoLister._subOnlyCampaigns.set("badge", Date.now() - 7 * 3600e3);
  await ask();
  assert.equal(fetched.length, 2, "seven hours on, Twitch is asked again");
});

test("a campaign that gains a watch drop lists once the remembered verdict has lapsed", async () => {
  const game = "Late Game";
  await account("lg1", game, ["Late Emote"]);
  const task = await farmTask(game, "late", "Late Campaign", ["lg1"]);
  CAMPAIGNS.late = { game: { displayName: game }, timeBasedDrops: [drop(0, 1, "Late Badge", game)] };
  try {
    await assert.rejects(autoLister.campaignItems("late", game, "Late Campaign"), { code: autoLister.SUB_ONLY_CAMPAIGN });
    CAMPAIGNS.late.timeBasedDrops.push(drop(60, 0, "Late Emote", game));
    // Still inside the window: the old answer stands.
    assert.equal((await verifyStep.verifyTask(task.toObject())).ok, false);
    autoLister._subOnlyCampaigns.set("late", Date.now() - 7 * 3600e3);
    const check = await verifyStep.verifyTask(task.toObject());
    assert.equal(check.ok, true);
    assert.deepEqual(
      check.items.map((i) => i.name),
      ["Late Emote"],
    );
    assert.equal(autoLister._subOnlyCampaigns.has("late"), false, "the lapsed verdict is dropped, not kept");
  } finally {
    delete CAMPAIGNS.late;
  }
});

test("a title-placeholder campaign still tries every token and reports the placeholder, as before", async () => {
  // Its own tokens, so this holds when the test is run alone.
  for (const login of ["ph1", "ph2", "ph3"]) await account(login, "Some Game", []);
  await assert.rejects(autoLister.campaignItems("placeholder", "Some Game", "Launch"), (e) => {
    assert.match(e.message, /only the campaign\/game title/);
    assert.notEqual(e.code, autoLister.SUB_ONLY_CAMPAIGN);
    return true;
  });
  const tried = new Set(fetched.map((f) => f.token));
  assert.ok(tried.size >= 3, "more than one token was asked: " + tried.size);
  assert.equal(tried.size, fetched.length, "each of them once");
  assert.ok(fetched.every((f) => f.id === "placeholder"));
  assert.equal(autoLister._subOnlyCampaigns.size, 0);
});

// The whole fix reads one field of Twitch's answer. If the query stopped asking
// for it, every drop would look earnable again and every test above would
// still pass on its hand-built campaigns.
test("the campaign-details query still asks Twitch for requiredSubs on each drop", () => {
  const src = fs.readFileSync(path.join(__dirname, "../utils/twitchInventory.js"), "utf8");
  const query = src.slice(src.indexOf("const CAMPAIGN_DETAILS_QUERY"), src.indexOf("async function fetchCampaignDetails"));
  assert.ok(query.length > 100, "the query was found");
  assert.match(query, /timeBasedDrops \{[^}]*\brequiredSubs\b/);
});
