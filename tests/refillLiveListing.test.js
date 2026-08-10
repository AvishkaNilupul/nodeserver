// An auto-farm task can outlive its listings: a Plati product gets deleted or
// a GGSel offer is delisted while the task that created it stays active. The
// refill sweep addressed those markets by external id alone, so it kept
// reading stock for products the platform had already dropped — in production
// one deleted Digiseller product (6010335) logged "stock unreadable" over a
// thousand times, once per sweep, forever, with no live listing to feed.
//
// listingIsLive is the gate that stops it: refill only touches a market whose
// listing row is still active. It is a DB read, so the model is stubbed here
// rather than reaching for a live Mongo.
const test = require("node:test");
const assert = require("node:assert");
const MarketplaceListing = require("../models/MarketplaceListing");
const { listingIsLive } = require("../utils/autoLister");

// Minimal stand-in for the findOne(...).select(...).lean() chain the helper
// uses. Records the query it was handed so the market/id scoping is checked
// too, not just the boolean.
function stubFindOne(rowByQuery) {
  const calls = [];
  const original = MarketplaceListing.findOne;
  MarketplaceListing.findOne = (query) => {
    calls.push(query);
    return {
      select: () => ({ lean: async () => rowByQuery(query) }),
    };
  };
  return {
    calls,
    restore: () => {
      MarketplaceListing.findOne = original;
    },
  };
}

test("an active listing is live", async () => {
  const stub = stubFindOne(() => ({ status: "active" }));
  try {
    assert.strictEqual(await listingIsLive("digiseller", "5985164"), true);
  } finally {
    stub.restore();
  }
});

test("a delisted listing is not live — the refill must skip it", async () => {
  // The exact production case: the row is already marked delisted, but the
  // task still carried the id and kept polling the dead product.
  const stub = stubFindOne(() => ({ status: "delisted" }));
  try {
    assert.strictEqual(await listingIsLive("digiseller", "6010335"), false);
  } finally {
    stub.restore();
  }
});

test("sold and removed listings are not live either", async () => {
  for (const status of ["sold", "removed"]) {
    const stub = stubFindOne(() => ({ status }));
    try {
      assert.strictEqual(await listingIsLive("ggsel", "102664302"), false);
    } finally {
      stub.restore();
    }
  }
});

test("a listing row that no longer exists is not live", async () => {
  // Hard-deleted rows must not throw and must not be treated as feedable.
  const stub = stubFindOne(() => null);
  try {
    assert.strictEqual(await listingIsLive("ggsel", "999999999"), false);
  } finally {
    stub.restore();
  }
});

test("a missing external id short-circuits without hitting the DB", async () => {
  // A task with no listing for a market must not cost a query per sweep.
  const stub = stubFindOne(() => ({ status: "active" }));
  try {
    assert.strictEqual(await listingIsLive("digiseller", ""), false);
    assert.strictEqual(await listingIsLive("digiseller", null), false);
    assert.strictEqual(await listingIsLive("digiseller", undefined), false);
    assert.strictEqual(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("the lookup is scoped to the right market and id", async () => {
  // Ids are only unique per marketplace, so a query missing either half could
  // match another market's listing and wrongly green-light a dead one.
  const stub = stubFindOne(() => ({ status: "active" }));
  try {
    await listingIsLive("ggsel", 102664302);
    assert.deepStrictEqual(stub.calls[0], {
      marketplace: "ggsel",
      externalId: "102664302", // numeric ids are normalised to string
    });
  } finally {
    stub.restore();
  }
});
