// The post-event markup must not compound while it waits for a Gameflip relist
// (utils/autoLister.js onCampaignEnded).
//
// onCampaignEnded defers marking a task done while a relist is pending: a
// `sold` Gameflip row that still owes units means a fresh listing is about to
// land, and the +50% belongs on that one. The deferral only withheld the
// postEvent flag — the marked-up price was already saved on the task and the
// set. autoFarmer.repriceEndedTasks retries every tick, and each retry marked
// up the price the last one had stored.
//
// On prod (2026-10-05/06) one MARVEL Contest of Champions task whose chain
// stayed pending went from $1.75 to $1.5e82 in 465 ticks, with a Telegram
// "Post-event reprice" notice for each.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const autoLister = require("../utils/autoLister");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    AutoFarmTask.deleteMany({}),
    DropSet.deleteMany({}),
    MarketplaceListing.deleteMany({}),
  ]);
});

// A completed task whose only Gameflip row has SOLD and still owes units — the
// exact prod shape. `price` is what the task was listed at before the event
// ended.
async function seed({ price = 1.75, soldRowAgeMs = 0, relistAttempts = 1 } = {}) {
  const set = await DropSet.create({
    name: "MARVEL Contest of Champions — September Week 4",
    price,
    items: [{ itemKey: "mcoc-1", name: "Crystal", game: "MARVEL Contest of Champions", qty: 1 }],
  });
  const task = await AutoFarmTask.create({
    game: "MARVEL Contest of Champions",
    campaignId: "camp-" + set._id,
    campaignName: "September Week 4",
    status: "completed",
    decision: "farm",
    listing: {
      setId: String(set._id),
      externalId: "gf-original",
      price,
      qty: 4,
      heldBack: 6,
    },
  });
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: "gf-original",
    origin: "auto",
    status: "sold",
    price,
    qtyRemaining: 3,
    relistAttempts,
  });
  if (soldRowAgeMs) {
    // Raw collection write: a model update would restamp updatedAt to now.
    await MarketplaceListing.collection.updateOne(
      { _id: row._id },
      { $set: { updatedAt: new Date(Date.now() - soldRowAgeMs) } },
    );
  }
  return { set, task, row };
}

test("REGRESSION: a pending relist writes nothing, however many ticks retry it", async () => {
  const { set, task } = await seed({ price: 1.75 });
  for (let tick = 0; tick < 12; tick++) {
    const r = await autoLister.onCampaignEnded(task._id);
    assert.match(r.skipped || "", /relist pending/, "tick " + tick + " defers");
    assert.equal(r.repriced, undefined, "no reprice result, so no Telegram notice");
  }
  const t = await AutoFarmTask.findById(task._id).lean();
  const s = await DropSet.findById(set._id).lean();
  assert.equal(t.listing.price, 1.75, "the task price is the untouched base");
  assert.equal(s.price, 1.75, "the set price is the untouched base");
  assert.equal(t.listing.postEvent, false, "still queued for the real markup");
  assert.equal(t.listing.repricedAt, null);
  assert.equal(t.listing.heldBack, 6, "held-back stock is not released early");
});

test("once the relist stops being pending the markup lands exactly once", async () => {
  // A chain that never relisted: its sold row is older than the grace window.
  const { set, task } = await seed({ price: 1.75, soldRowAgeMs: 25 * 60 * 60 * 1000 });
  const r = await autoLister.onCampaignEnded(task._id);
  assert.equal(r.repriced.price, 2.75, "$1.75 +50%, rounded to a quarter");
  assert.equal(r.repriced.live, false);
  let t = await AutoFarmTask.findById(task._id).lean();
  assert.equal(t.listing.price, 2.75);
  assert.equal(t.listing.postEvent, true, "marked done in the same save as the price");
  assert.equal((await DropSet.findById(set._id).lean()).price, 2.75);

  const again = await autoLister.onCampaignEnded(task._id);
  assert.equal(again.skipped, "already repriced");
  t = await AutoFarmTask.findById(task._id).lean();
  assert.equal(t.listing.price, 2.75, "a second call cannot raise it again");
});

test("REGRESSION: a chain that keeps failing to relist does not hold the task", async () => {
  // The prod row: 19 failed relists ("out of stock"), re-saved by every retry
  // so its updatedAt is always fresh. The 24h recency window never closes on
  // it; the attempt count is what says no listing is about to land.
  const { task } = await seed({ price: 1.75, relistAttempts: 19 });
  const r = await autoLister.onCampaignEnded(task._id);
  assert.equal(r.repriced.price, 2.75);
  const t = await AutoFarmTask.findById(task._id).lean();
  assert.equal(t.listing.postEvent, true, "leaves the retry queue");
});

test("a sold row from before the attempt counter existed still defers", async () => {
  const { task, row } = await seed({ price: 1.75 });
  await MarketplaceListing.collection.updateOne(
    { _id: row._id },
    { $unset: { relistAttempts: "" } },
  );
  const r = await autoLister.onCampaignEnded(task._id);
  assert.match(r.skipped || "", /relist pending/);
});

test("a waiting task is marked up from its base when the wait ends", async () => {
  // The whole point of deferring: N skipped ticks, then one +50% on $1.75 —
  // not on whatever the skipped ticks would have left behind.
  const { task, row } = await seed({ price: 1.75 });
  for (let tick = 0; tick < 5; tick++) await autoLister.onCampaignEnded(task._id);
  await MarketplaceListing.collection.updateOne(
    { _id: row._id },
    { $set: { updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } },
  );
  const r = await autoLister.onCampaignEnded(task._id);
  assert.equal(r.repriced.price, 2.75);
});

test("a corrupt stored price is refused, not saved or published", async () => {
  const { set, task } = await seed({ price: 1.499784164180969e82, soldRowAgeMs: 25 * 60 * 60 * 1000 });
  await assert.rejects(
    () => autoLister.onCampaignEnded(task._id),
    /over the \$25 ceiling/,
  );
  const t = await AutoFarmTask.findById(task._id).lean();
  assert.equal(t.listing.price, 1.499784164180969e82, "left for a human to repair");
  assert.equal(t.listing.postEvent, false);
  assert.equal((await DropSet.findById(set._id).lean()).price, 1.499784164180969e82);
});
