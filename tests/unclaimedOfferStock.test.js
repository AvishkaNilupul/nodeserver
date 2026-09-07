// The two ways an unclaimed-farm offer stops selling while the farm is still
// full — both found on production on 2026-09-07, both invisible to every check
// the system had. No Mongo, no network.
//
//   1. Stock. An offer backed by `unclaimedGame` resolves its accounts out of
//      the no-claim ledger at DELIVERY time, so everything in its `units[]` is
//      a record of a hand-over that already happened. PlayerAuctions' stock
//      sync counted `undeliveredUnits` anyway, which is 0 the instant the first
//      order lands: the very first sale advertised the offer down to zero while
//      seventeen sellable Overwatch accounts sat in the farm. Eldorado never
//      had the bug (its unclaimed branch returns before the quantity call) and
//      that asymmetry is what made the rule visible.
//
//   2. Activation. GGSel answers batch_activate 2xx and can still leave the
//      offer in "draft". `ggselFinalizeStock` is the only thing that re-reads
//      the status and reports it, and both call sites threw the verdict away
//      (`.catch(() => {})`), so offer 102819378 held 16 Call of Duty accounts
//      in draft for six days with nothing able to see it.
const test = require("node:test");
const assert = require("node:assert");

const pa = require("../utils/playerauctionsFulfiller");
const { finalizeGgselOffer, GGSEL_STUCK_PREFIX } = require("../utils/unclaimedAutoList");

/* ------------------------------- 1. stock ------------------------------- */

test("a pre-reserved offer still advertises the units nobody has been given", async () => {
  const listing = {
    externalId: "1",
    units: [
      { login: "a", deliveredAt: new Date() },
      { login: "b", deliveredAt: null },
      { login: "c", deliveredAt: null },
    ],
  };
  assert.strictEqual(await pa.stockFor(listing), 2);
});

test("an unclaimed-backed offer asks the ledger, not its own delivery history", async () => {
  // Exactly the live shape after one order: every unit delivered, so the old
  // undeliveredUnits count is 0 — and the farm still holds sixteen.
  const listing = {
    externalId: "295599462",
    unclaimedGame: "Overwatch",
    units: [{ login: "sold-already", deliveredAt: new Date(), orderId: "1" }],
  };
  assert.strictEqual(pa.undeliveredUnits(listing).length, 0, "precondition");

  const claim = async (game, want, opts) => {
    assert.strictEqual(game, "Overwatch");
    assert.ok(want > 1, "must ask for more than one so stock can exceed 1");
    assert.strictEqual(opts.dryRun, true, "a stock probe must never claim");
    return new Array(16).fill(0).map((_, i) => ({ login: "free" + i }));
  };
  assert.strictEqual(await pa.stockFor(listing, claim), 16);
});

test("an unclaimed-backed offer with an empty farm advertises nothing", async () => {
  const listing = {
    externalId: "295599462",
    unclaimedGame: "Overwatch",
    units: [{ login: "x", deliveredAt: new Date() }],
  };
  assert.strictEqual(await pa.stockFor(listing, async () => []), 0);
});

/* ---------------------------- 2. activation ---------------------------- */

test("a GGSel offer that really went live reports ok", async () => {
  const out = await finalizeGgselOffer("102819378", null, async () => ({
    stock: 16,
    reactivated: true,
    activationStuck: false,
    activationStatus: "",
  }));
  assert.deepStrictEqual(out, { ok: true, status: "active", error: "" });
});

test("an accepted-but-ignored activation is a failure, not a success", async () => {
  // GGSel returned 2xx and left it in draft. The old code could not tell the
  // difference because it discarded this object entirely.
  const out = await finalizeGgselOffer("102819378", null, async () => ({
    stock: 16,
    reactivated: true,
    activationStuck: true,
    activationStatus: "draft",
  }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, "draft");
});

test("a paused offer is reported as paused, not conflated with draft", async () => {
  // "draft" = published and never went live; "paused" = was live and came down.
  // A reader chasing the wrong one looks in the wrong place.
  const out = await finalizeGgselOffer("102819378", null, async () => ({
    activationStuck: true,
    activationStatus: "paused",
  }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, "paused");
});

test("a finalize that throws is a failure, not silence", async () => {
  const out = await finalizeGgselOffer("102819378", null, async () => {
    throw new Error("429 Too many attempts");
  });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /429/);
});

test("the stuck marker is a stable prefix the panel and consistencyIssues match on", () => {
  // consistencyIssues reads this off the row instead of making a network call,
  // and reconcileRowsPass clears it once the offer is active again — so the
  // string is load-bearing in three places.
  assert.ok(typeof GGSEL_STUCK_PREFIX === "string" && GGSEL_STUCK_PREFIX.length > 0);
  assert.ok(!GGSEL_STUCK_PREFIX.includes("undefined"));
});
