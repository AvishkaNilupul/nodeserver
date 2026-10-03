// A task's G2G share record must survive a save.
//
// utils/autoLister.js records every secondary market's share on the task
// (`task.listing.<market> = { externalId, url, qty, error }`) and
// retryMissingSecondaries reads it back to decide whether that market still
// needs a share: `g2gMissing = !(L.g2g && L.g2g.externalId)`.
//
// `listing.g2g` was never declared in models/AutoFarmTask.js, and Mongoose's
// strict mode drops an undeclared path on save (the model says so itself, at
// `bots.shared` and `rescanRequested`). So the record was written, saved, and
// gone: G2G read as "missing" on every sweep, and with autoFarm.g2gAuto on a
// listed task was handed ANOTHER G2G share — its own new offer — each time it
// had spare accounts, the half held back for the post-event price included.
//
// These drive the real model through the two write shapes the lister uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("autofarmtaskg2gshare"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// What publishG2gShare returns, and what the lister stores for a failure.
const share = (id, qty) => ({ externalId: id, url: "https://g2g.example/offer/" + id, qty });
const noShare = (error) => ({ externalId: "", url: "", qty: 0, error });

// The exact test retryMissingSecondaries applies to the stored record.
const g2gMissing = (task) => {
  const L = task.listing || {};
  return !(L.g2g && L.g2g.externalId);
};

let seq = 0;
async function listedTask(listing) {
  seq += 1;
  const task = await AutoFarmTask.create({
    game: "Share Record Game " + seq,
    campaignId: "camp-" + seq,
    decision: "farm",
  });
  // The shape listActivatedTask assigns in one go.
  task.listing = {
    setId: "set-" + seq,
    externalId: "GF-" + seq,
    url: "",
    title: "Share Record Game Twitch Drops",
    price: 1.25,
    qty: 2,
    heldBack: 3,
    plati: noShare("Plati is switched off in auto-farm settings"),
    ggsel: share("GG-" + seq, 1),
    zeusx: noShare("ZeusX auto-listing is switched off"),
    eldorado: share("EL-" + seq, 1),
    playerauctions: noShare("no spare account for this market yet"),
    listedAt: new Date(),
    repricedAt: null,
    postEvent: false,
    error: "",
    ...listing,
  };
  await task.save();
  return task;
}

const MARKETS = ["plati", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];

test("every market's share record is declared, each with the same four fields", () => {
  for (const m of MARKETS) {
    for (const f of ["externalId", "url", "qty", "error"]) {
      assert.ok(AutoFarmTask.schema.path("listing." + m + "." + f), "listing." + m + "." + f + " is not in the schema");
    }
  }
});

test("first publish: the G2G share listActivatedTask records is still there after the save", async () => {
  const task = await listedTask({ g2g: share("G2G-first", 2) });
  const stored = await AutoFarmTask.findById(task._id).lean();
  assert.equal(stored.listing.g2g && stored.listing.g2g.externalId, "G2G-first");
  assert.equal(stored.listing.g2g.qty, 2);
  assert.equal(g2gMissing(stored), false, "a task that HAS a G2G offer must not read as missing one");
});

test("retry: a share recorded on a reloaded task is kept, so the next sweep leaves G2G alone", async () => {
  const created = await listedTask({ g2g: noShare("no spare account for this market yet") });
  // The sweep loads the task, publishes, then writes exactly this.
  const task = await AutoFarmTask.findById(created._id);
  assert.equal(g2gMissing(task), true, "no G2G offer yet: this sweep may publish one");
  task.listing.g2g = { ...share("G2G-retry", 4), error: "" };
  task.markModified("listing");
  await task.save();

  const next = await AutoFarmTask.findById(created._id);
  assert.equal(next.listing.g2g.externalId, "G2G-retry");
  assert.equal(next.listing.g2g.qty, 4);
  assert.equal(g2gMissing(next), false, "the next sweep must see the offer it just published");
  // The other markets' records are untouched by the G2G write.
  assert.equal(next.listing.ggsel.externalId, created.listing.ggsel.externalId);
  assert.equal(next.listing.heldBack, 3);
});

test("a failed G2G publish keeps its reason, and still reads as missing (it may be retried)", async () => {
  const created = await listedTask({});
  const task = await AutoFarmTask.findById(created._id);
  task.listing.g2g = noShare("no G2G brand for Share Record Game");
  task.markModified("listing");
  await task.save();
  const stored = await AutoFarmTask.findById(created._id).lean();
  assert.equal(stored.listing.g2g.error, "no G2G brand for Share Record Game");
  assert.equal(g2gMissing(stored), true);
});

test("a task listed before the field existed reads as having no G2G share, not as broken", async () => {
  const created = await listedTask({});
  const stored = await AutoFarmTask.findById(created._id);
  assert.equal(stored.listing.g2g.externalId, "");
  assert.equal(g2gMissing(stored), true);
});

/* ------------------- the one-time repair: scripts/backfill-task-g2g-share.js ------------------- */

const MarketplaceListing = require("../models/MarketplaceListing");
const { planBackfill, unitsOf, SHARE_ROWS } = require("../scripts/backfill-task-g2g-share");

const oid = () => new mongoose.Types.ObjectId();
const at = (iso) => new Date(iso);
const row = (set, externalId, createdAt, extra = {}) => ({ set, externalId, url: "https://g2g.example/offer/" + externalId, createdAt: at(createdAt), ...extra });

test("repair plan: one record per unrecorded task, from the NEWEST live offer of its set", () => {
  const sprawl = oid();
  const single = oid();
  const rows = [
    row(sprawl, "OLD", "2026-09-25T16:51:00Z", { units: [{}, {}, {}] }),
    row(sprawl, "NEWEST", "2026-09-26T07:49:00Z", { units: [{}, {}] }),
    row(sprawl, "MID", "2026-09-26T01:00:00Z", { units: [{}] }),
    row(single, "ONLY", "2026-10-03T01:56:00Z", { accountLogin: "a, b , c" }),
    row(null, "NOSET", "2026-10-03T01:56:00Z"),
    row(oid(), "", "2026-10-03T01:56:00Z"),
  ];
  const tasks = [
    { _id: oid(), game: "Sprawl Game", status: "completed", listing: { setId: String(sprawl) } },
    { _id: oid(), game: "Single Game", status: "active", listing: { setId: String(single), g2g: { externalId: "", url: "", qty: 0, error: "" } } },
    { _id: oid(), game: "Recorded Game", status: "active", listing: { setId: String(single), g2g: { externalId: "KEEP", url: "", qty: 1, error: "" } } },
    { _id: oid(), game: "Other Game", status: "active", listing: { setId: String(oid()) } },
  ];
  const plan = planBackfill(rows, tasks);
  assert.deepEqual(plan.sets, [
    { setId: String(sprawl), offers: 3, units: 6 },
    { setId: String(single), offers: 1, units: 3 },
  ]);
  assert.equal(plan.recorded, 1, "a task that already holds a record is counted, never planned");
  assert.deepEqual(
    plan.updates.map((u) => [u.game, u.record.externalId, u.record.qty, u.offers]),
    [
      ["Sprawl Game", "NEWEST", 2, 3],
      ["Single Game", "ONLY", 3, 1],
    ],
  );
  assert.equal(plan.updates[0].record.error, "");
  assert.equal(unitsOf({ units: [], accountLogin: "" }), 0);
  assert.deepEqual(planBackfill([], tasks), { sets: [], updates: [], recorded: 0 });
});

test("repair query: only the auto-lister's own live G2G shares are read", async () => {
  const set = oid();
  const base = { set, marketplace: "g2g", origin: "auto", status: "active", title: "t", price: 1, createdAt: new Date() };
  await MarketplaceListing.collection.insertMany([
    { ...base, externalId: "share-1", units: [{ login: "a" }] },
    { ...base, externalId: "share-2", accountLogin: "b" },
    { ...base, externalId: "bundle", autoClaimSet: true },
    { ...base, externalId: "farm", rentFarm: true },
    { ...base, externalId: "hand", origin: "manual" },
    { ...base, externalId: "nc", origin: "unclaimed" },
    { ...base, externalId: "gone", status: "delisted" },
    { ...base, externalId: "sold", status: "sold" },
    { ...base, externalId: "elsewhere", marketplace: "eldorado" },
    { ...base, externalId: "" },
  ]);
  const found = await MarketplaceListing.find({ ...SHARE_ROWS, set }, { externalId: 1 }).lean();
  assert.deepEqual(found.map((r) => r.externalId).sort(), ["share-1", "share-2"]);
});

test("repair write: stamps a task stored the old way, never overwrites a record, and is a no-op the second time", async () => {
  const setId = String(oid());
  // Exactly what production holds today: a listed task with no `listing.g2g` key at all.
  const old = await AutoFarmTask.collection.insertOne({ game: "Stored The Old Way", campaignId: "old-1", decision: "farm", status: "active", listing: { setId, externalId: "GF-old", heldBack: 2 } });
  const kept = await listedTask({ setId, g2g: share("ALREADY", 1) });
  const record = { externalId: "LIVE-OFFER", url: "https://g2g.example/offer/LIVE-OFFER", qty: 2, error: "" };
  const stamp = (id) =>
    AutoFarmTask.updateOne({ _id: id, "listing.setId": setId, "listing.g2g.externalId": { $in: ["", null] } }, { $set: { "listing.g2g": record } });

  assert.equal((await stamp(old.insertedId)).modifiedCount, 1);
  assert.equal((await stamp(kept._id)).modifiedCount, 0, "a real record is left alone");
  assert.equal((await stamp(old.insertedId)).modifiedCount, 0, "a second run changes nothing");

  const after = await AutoFarmTask.findById(old.insertedId);
  assert.equal(after.listing.g2g.externalId, "LIVE-OFFER");
  assert.equal(g2gMissing(after), false, "the first sweep after the deploy leaves this task's G2G alone");
  assert.equal(after.listing.heldBack, 2, "nothing else on the task moved");
  assert.equal((await AutoFarmTask.findById(kept._id)).listing.g2g.externalId, "ALREADY");
});

// The bug was a market the lister wrote and the schema did not know. Hold the
// two files together: every `task.listing.<market> =` in the lister, and every
// market record in the object it assigns on first publish, is a declared path.
test("every share record utils/autoLister.js writes on a task is a declared schema path", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "autoLister.js"), "utf8");
  const written = new Set();
  for (const m of src.matchAll(/\btask\.(listing|stackListing)\.([A-Za-z0-9_]+)\s*=[^=]/g)) written.add(m[1] + "." + m[2]);
  for (const kind of ["listing", "stackListing"]) {
    for (const lit of src.matchAll(new RegExp("\\btask\\." + kind + " = \\{([\\s\\S]*?)\\n  \\};", "g"))) {
      for (const k of lit[1].matchAll(/^\s{4}([A-Za-z0-9_]+)\s*[,:]/gm)) written.add(kind + "." + k[1]);
    }
  }
  assert.ok(written.has("listing.g2g"), "the scan no longer finds the G2G write: the lister changed shape, re-check this test");
  assert.ok(written.size >= 12, "the scan found only " + written.size + " paths: " + [...written].join(", "));
  const undeclared = [...written].filter((p) => {
    const s = AutoFarmTask.schema;
    return !s.path(p) && s.pathType(p) !== "nested";
  });
  assert.deepEqual(undeclared, [], "written by the lister but dropped by strict mode on save: " + undeclared.join(", "));
});
