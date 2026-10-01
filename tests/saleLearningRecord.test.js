// recordListingSale must write a sale signal for EVERY unit a listing sells.
//
// Found 2026-10-01 reading production read-only: 31 listings had fewer
// `sold:<listingId>:...` SaleSignal rows than their own `unitsSold` counter (78 units),
// and 75 of those units sat on GGSel / Digiseller quantity listings whose `accountId` is
// a COMMA-JOINED list of the several accounts attached to the listing
// ("<hex24>,<hex24>,<hex24>"). recordListingSale copied that string into
// SaleSignal.account, which is an ObjectId: the cast threw inside updateOne, the
// surrounding `catch` (written so that "demand learning is best-effort") swallowed it,
// and no signal was written while `unitsSold` had already been incremented.
//
// What those 78 units were matters, so it is recorded here: 66 of them are the 09-28
// GGSel block (the audit log shows 236 "sold" units logged in that one hour against a
// normal 1-3 a day: stock read as zero and was recorded as sold), so the cast error
// happened to HIDE that phantom demand on multi-account listings. The real exposure is
// forward-looking: 65 of the 79 live GGSel offers are multi-account, so without this fix
// every REAL sale on them would be dropped.
//
// The fix: only a value that really is ONE ObjectId may be stored as the account. The
// listing's `accountLogin` (which carries the whole delivery pool for such a listing)
// is still recorded in `login`, and an account-less unit is counted individually by
// internalSalesForGame through its dedupeKey, exactly as the function's own comment
// describes for quantity listings.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MarketplaceListing = require("../models/MarketplaceListing");
const SaleSignal = require("../models/SaleSignal");
const { recordListingSale } = require("../utils/saleLearning");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("salelearningrecord"));
  await SaleSignal.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const oid = () => String(new mongoose.Types.ObjectId());
const SET = { items: [{ game: "Alpha", itemKey: "a" }] };

async function makeListing(over = {}) {
  return MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "ggsel",
    externalId: "ext-" + oid(),
    title: "Alpha Twitch Drops (1 Item) — X",
    price: 1.25,
    qtyTarget: 3,
    ...over,
  });
}

const signalsOf = (listing) => SaleSignal.find({ dedupeKey: new RegExp("^sold:" + String(listing._id) + ":") }).sort({ dedupeKey: 1 }).lean();

test("a listing carrying SEVERAL accounts still records its sales (the swallowed CastError)", async () => {
  const ids = [oid(), oid(), oid()];
  const listing = await makeListing({ accountId: ids.join(","), accountLogin: "alice, bob, carol" });
  const written = await recordListingSale({ listing, set: SET, units: 2, priceUsd: 1.25 });
  assert.equal(written, 2, "both units must be written, not silently dropped");
  const rows = await signalsOf(listing);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    // A comma-joined list is not an account: the unit is anonymous (account null) and
    // the pool stays in `login`, which is what every reader already expects.
    assert.equal(r.account == null, true, "account must be empty, not a joined string");
    assert.equal(r.login, "alice, bob, carol");
    assert.equal(r.source, "listing_sold");
    assert.equal(r.marketplace, "ggsel");
    assert.equal(r.priceUsd, 1.25);
  }
  // The unit counter and the signals now agree, which is the whole invariant.
  const fresh = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(fresh.unitsSold, 2);
});

test("each of those units counts as its OWN sale in the engine's grouping", async () => {
  const listing = await makeListing({ accountId: oid() + "," + oid(), accountLogin: "x, y" });
  await recordListingSale({ listing, set: SET, units: 3, priceUsd: 1 });
  // utils/autoFarmer.js internalSalesForGame groups by `$ifNull: [account, dedupeKey]`.
  const rows = await SaleSignal.aggregate([
    { $match: { dedupeKey: new RegExp("^sold:" + String(listing._id) + ":") } },
    { $group: { _id: { $ifNull: ["$account", "$dedupeKey"] } } },
  ]);
  assert.equal(rows.length, 3, "three units are three sales, not one collapsed group");
});

test("a listing with ONE account still stores that account", async () => {
  const id = oid();
  const listing = await makeListing({ accountId: id, accountLogin: "solo", qtyTarget: 1 });
  const written = await recordListingSale({ listing, set: SET, units: 1, priceUsd: 2 });
  assert.equal(written, 1);
  const [row] = await signalsOf(listing);
  assert.equal(String(row.account), id, "a real single account id is kept (Gameflip auto-delivery pins one)");
  assert.equal(row.login, "solo");
});

test("a listing with no account id records an anonymous unit", async () => {
  const listing = await makeListing({ accountId: "", accountLogin: "" });
  assert.equal(await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 }), 1);
  const [row] = await signalsOf(listing);
  assert.equal(row.account == null, true);
});

test("junk in accountId (not an id at all) is treated as no account, never an error", async () => {
  for (const junk of ["not-an-id", "12345", "abc,def", " ", "<hex>,", oid() + "," + "zz"]) {
    const listing = await makeListing({ accountId: junk, accountLogin: "l" });
    assert.equal(await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 }), 1, "accountId " + JSON.stringify(junk));
    const [row] = await signalsOf(listing);
    assert.equal(row.account == null, true, JSON.stringify(junk));
  }
});

test("recording is still idempotent per unit and the counter keeps numbering", async () => {
  const listing = await makeListing({ accountId: oid() + "," + oid(), accountLogin: "a, b" });
  assert.equal(await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 }), 1);
  assert.equal(await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 }), 1);
  const rows = await signalsOf(listing);
  assert.deepEqual(rows.map((r) => r.dedupeKey.split(":").pop()), ["0", "1"], "units 0 and 1, never a repeated key");
});

test("a bundle covering two games writes one signal per game per unit, multi-account or not", async () => {
  const listing = await makeListing({ accountId: oid() + "," + oid(), accountLogin: "a, b" });
  const two = { items: [{ game: "Alpha", itemKey: "a" }, { game: "Beta", itemKey: "b" }] };
  assert.equal(await recordListingSale({ listing, set: two, units: 1, priceUsd: 1 }), 2);
});

test("a listing that is gone writes nothing and does not throw", async () => {
  const ghost = { _id: new mongoose.Types.ObjectId(), marketplace: "ggsel", title: "t", price: 1, accountId: oid() + "," + oid() };
  assert.equal(await recordListingSale({ listing: ghost, set: SET, units: 1 }), 0);
});

// ---------------------------------------------------------------- not silent

// Run `fn` with SaleSignal.updateOne failing, console.warn captured and the clock
// under test control. The module's throttle is process state, so each caller moves
// the clock far enough forward that an earlier test cannot suppress its warning.
let fakeNow = Date.now() + 10 * 60 * 1000;
async function withFailingWrites(err, fn) {
  const realUpdate = SaleSignal.updateOne;
  const realWarn = console.warn;
  const realNow = Date.now;
  const warnings = [];
  fakeNow += 10 * 60 * 1000;
  SaleSignal.updateOne = async () => {
    throw err;
  };
  console.warn = (m) => warnings.push(String(m));
  Date.now = () => fakeNow;
  try {
    return await fn(warnings, (ms) => {
      fakeNow += ms;
    });
  } finally {
    SaleSignal.updateOne = realUpdate;
    console.warn = realWarn;
    Date.now = realNow;
  }
}

test("a write that really fails is reported once, and still cannot fail the sale", async () => {
  const listing = await makeListing({ accountLogin: "l" });
  await withFailingWrites(new Error("boom"), async (warnings) => {
    const written = await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 });
    assert.equal(written, 0, "nothing written, nothing thrown");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[saleLearning\] sale signal NOT recorded for sold:/);
    assert.match(warnings[0], /boom/);
  });
});

test("the benign duplicate-key race is NOT reported: nothing was lost", async () => {
  const listing = await makeListing({ accountLogin: "l" });
  const dup = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  await withFailingWrites(dup, async (warnings) => {
    assert.equal(await recordListingSale({ listing, set: SET, units: 3, priceUsd: 1 }), 0);
    assert.equal(warnings.length, 0);
  });
});

test("a database outage prints one line a minute, not one per unit", async () => {
  const listing = await makeListing({ accountLogin: "l" });
  await withFailingWrites(new Error("connection lost"), async (warnings, advance) => {
    await recordListingSale({ listing, set: SET, units: 5, priceUsd: 1 });
    assert.equal(warnings.length, 1, "five failed units, one line");
    advance(30 * 1000);
    await recordListingSale({ listing, set: SET, units: 2, priceUsd: 1 });
    assert.equal(warnings.length, 1, "still inside the minute");
    advance(31 * 1000);
    await recordListingSale({ listing, set: SET, units: 1, priceUsd: 1 });
    assert.equal(warnings.length, 2, "a minute later it speaks again");
  });
});
