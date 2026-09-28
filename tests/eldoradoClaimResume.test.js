// Why a failed Eldorado send spent the no-claim ledger again on every retry.
//
// The two facts that combine into the bug:
//
// 1. `claimUnclaimedForGame` claims stock ATOMICALLY AND PERMANENTLY — it flips
//    each UnclaimedAccount to `status: "sold"` with `note: "eldorado order <id>"`.
// 2. The record that links those accounts back to the order is written into
//    `MarketplaceListing.units`, and on the unclaimed path that happens only
//    AFTER `eldoradoSendOrderMessage` has resolved.
//
// So when the send threw — a TalkJS 5xx, a timeout, an order row with no
// conversation id (utils/marketplaces.js throws outright on that) — the accounts
// were sold, no unit row existed, and nothing tied the two together. The
// caller's resume guard asks `listing.units.some(u => u.orderId === orderId)`,
// found nothing, and the next 60-second tick claimed a BRAND NEW set. Order
// e69b19d3 retried 25 times.
//
// The order id was in `note` the whole time. It was simply never read back.
//
// PlayerAuctions does NOT have this bug and the contrast is the proof: its
// claim-at-sale path calls `reserveOnListing(row, orderId, picked)` BEFORE
// handOver, so the anchor exists before anything can throw.
//
// Since 2026-09-28 the by-game path is RETIRED (every no-claim offer sells
// through a no-claim set): claimUnclaimedForGame never claims a new account.
// The resume stays — an order the old claim already took accounts for is still
// owed exactly those accounts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) =>
  fs.readFileSync(path.join(__dirname, "..", "utils", f), "utf8");
const ELD = read("eldoradoFulfiller.js");
const PA = read("playerauctionsFulfiller.js");

const claimFn = ELD.slice(
  ELD.indexOf("async function claimUnclaimedForGame("),
  ELD.indexOf("async function deliverOrder("),
);

/* ---------------------------- the resume path ---------------------------- */

test("REGRESSION: a claim looks for what a previous attempt already took", () => {
  assert.match(
    claimFn,
    /status: "sold",\s*\n\s*market,\s*\n\s*note: market \+ " order " \+ String\(orderId\),/,
    "must query the ledger by this order's own note",
  );
  assert.match(claimFn, /const resumed = \[\];/);
});

test("the retired claim takes NOTHING new — it returns what this order already holds", () => {
  // No candidate scan and no claim write is left: an order with nothing taken
  // yet is held for a hand-over instead of being filled from the ledger.
  assert.match(claimFn, /return resumed\.slice\(0, n\);\n\}/);
  assert.doesNotMatch(claimFn, /const candidates = await UnclaimedAccount\.find/);
  assert.doesNotMatch(claimFn, /findOneAndUpdate|updateOne|updateMany|\.create\(/);
});

test("a partial resume is never topped up — the shortfall says why", () => {
  // Topping up was the old claim's job, and the old claim is gone.
  assert.match(claimFn, /if \(resumed\.length < n && shortfall\) shortfall\.detail = BY_GAME_RETIRED;/);
});

test("the resume is skipped on a dry run", () => {
  // A dry run must not report stock it would not actually claim, and it never
  // wrote a note to resume from in the first place.
  assert.match(claimFn, /if \(orderId && !dryRun\) \{/);
});

test("the resume is bounded", () => {
  // Prod Mongo is a bytes-bound Atlas shared tier; an unbounded find on a
  // permanent collection is the shape that has bitten this codebase before.
  const block = claimFn.slice(claimFn.indexOf("const resumed = []"));
  assert.match(block.slice(0, 700), /\.limit\(n\)/);
});

test("an unreadable resumed account is not silently replaced", () => {
  // It is already spent. Claiming a fresh one to stand in for it is exactly the
  // double-spend this block exists to prevent — so it drops out and the caller
  // reports a shortfall instead.
  const block = claimFn.slice(claimFn.indexOf("const resumed = []"));
  assert.match(block.slice(0, 1600), /if \(!cred\.login \|\| !cred\.password\) continue;/);
});

/* ------------------------- the ordering it fixes ------------------------- */

test("the resume reads the anchor the old claim wrote, per market", () => {
  // The old claim stamped `note: market + " order " + orderId` and `market`
  // (G2G passes market "g2g" through this same function). Reading anything
  // else would find nothing, and a paid order would be held instead of finished.
  assert.match(claimFn, /\{ orderId, dryRun, shortfall, market = "eldorado" \}/);
  assert.match(claimFn, /note: market \+ " order " \+ String\(orderId\)/);
});

test("PlayerAuctions still reserves BEFORE it sends", () => {
  // The contrast that proves the diagnosis, and a guard on the safer design:
  // if this ordering is ever flipped, PA grows the same bug. The no-claim set
  // branch is the claim-at-sale path now (the by-game one is retired).
  const at = PA.indexOf("if (row.noclaimStock) {\n    const ncs");
  const seg = PA.slice(at, at + 3000);
  const reserve = seg.indexOf("await reserveOnListing(row, orderId, picked)");
  const send = seg.indexOf("await handOver({");
  assert.ok(reserve > 0 && send > 0, "both calls should be present");
  assert.ok(reserve < send, "the units must be reserved before the credential is sent");
});
