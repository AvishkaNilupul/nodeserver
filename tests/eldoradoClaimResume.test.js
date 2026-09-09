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
// unclaimed path calls `reserveOnListing(row, orderId, picked)` BEFORE handOver,
// so the anchor exists before anything can throw.
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

test("a fully-resumable order claims NOTHING new", () => {
  // The whole point: if the previous attempt already took everything the order
  // needs, the walk below must not run at all.
  assert.match(claimFn, /if \(resumed\.length >= n\) return resumed\.slice\(0, n\);/);
  assert.ok(
    claimFn.indexOf("if (resumed.length >= n) return") <
      claimFn.indexOf("const candidates = await UnclaimedAccount.find"),
    "the early return must come BEFORE the candidate scan, or it still spends reads",
  );
});

test("a partial resume tops up only the difference", () => {
  // Seeding the accumulator is what makes the `out.length >= n` break count the
  // resumed accounts. Starting from [] again would re-claim the full quantity.
  assert.match(claimFn, /const out = resumed\.slice\(\);/);
  assert.doesNotMatch(claimFn, /\n  const out = \[\];/, "out must not start empty");
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

test("the note really is the only anchor a failed send leaves behind", () => {
  // If the claim ever stops writing the order id into `note`, the resume above
  // silently finds nothing and the bug is back with no test failing.
  assert.match(claimFn, /note: market \+ " order " \+ \(orderId \|\| ""\)/);
});

test("PlayerAuctions still reserves BEFORE it sends", () => {
  // The contrast that proves the diagnosis, and a guard on the safer design:
  // if this ordering is ever flipped, PA grows the same bug.
  const at = PA.indexOf("if (row.unclaimedGame) {");
  const seg = PA.slice(at, at + 3000);
  const reserve = seg.indexOf("await reserveOnListing(row, orderId, picked)");
  const send = seg.indexOf("await handOver({");
  assert.ok(reserve > 0 && send > 0, "both calls should be present");
  assert.ok(reserve < send, "the units must be reserved before the credential is sent");
});
