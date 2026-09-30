// Guards for scripts/reprice-listings.js — the tool that moves REAL prices on
// REAL marketplaces. These test the decisions about WHICH rows get touched,
// which is where a mistake costs money rather than a retry.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAutoOwned,
  overClaims,
  correctedTitle,
  itemCounts,
  categoryFor,
} = require("../scripts/reprice-listings");

/* -------------------------- the owner boundary --------------------------- */

test("only origin:auto rows may be repriced", () => {
  assert.equal(isAutoOwned({ origin: "auto" }), true);
});

test("the owner's hand-made listings are never touched", () => {
  // The whole point of MarketplaceListing.origin: a manual row is the owner's
  // stock at the owner's price, even when it sits on the same DropSet.
  assert.equal(isAutoOwned({ origin: "manual" }), false);
});

test("unclaimed-farm rows are never touched by this tool", () => {
  // The unclaimed farm has its OWN pricer with a sold-floor rule. Driving it
  // from two engines would fight over the same rows.
  assert.equal(isAutoOwned({ origin: "unclaimed" }), false);
});

test("a row with no origin is treated as NOT ours", () => {
  // The schema defaults origin to "manual" precisely so an unmarked row is
  // treated as the owner's — the safe way to be wrong.
  assert.equal(isAutoOwned({}), false);
  assert.equal(isAutoOwned(null), false);
  assert.equal(isAutoOwned(undefined), false);
});

/* ------------------------------ item counts ------------------------------ */

test("item counts report both conventions", () => {
  const set = { items: [{ qty: 4 }, { qty: 1 }, {}] };
  assert.deepEqual(itemCounts(set), { distinct: 3, total: 6 });
});

test("a missing qty counts as one copy", () => {
  assert.deepEqual(itemCounts({ items: [{}, {}] }), { distinct: 2, total: 2 });
});

test("an empty set counts as zero", () => {
  assert.deepEqual(itemCounts({ items: [] }), { distinct: 0, total: 0 });
  assert.deepEqual(itemCounts({}), { distinct: 0, total: 0 });
});

/* -------------------------------- titles --------------------------------- */

test("a title matching the distinct count is honest", () => {
  const set = { items: [{ qty: 4 }, { qty: 1 }] };
  assert.equal(overClaims("Foo (2 Items)", set), null);
});

test("a title matching the qty-summed count is honest", () => {
  const set = { items: [{ qty: 4 }, { qty: 1 }] };
  assert.equal(overClaims("Foo (5 Items)", set), null);
});

test("an UNDER-claiming title is left alone — the buyer gets more, not less", () => {
  // 114 of the 133 mismatches are this shape. Rewriting them would be churn
  // on live listings for no buyer protection.
  const set = { items: Array.from({ length: 29 }, () => ({ qty: 1 })) };
  assert.equal(overClaims("Marvel Rivals Twitch Drops (3 Items)", set), null);
});

test("an OVER-claiming title IS flagged — that one is a dispute risk", () => {
  const set = { items: Array.from({ length: 47 }, () => ({ qty: 1 })) };
  const out = overClaims("R6 bundle — 51 Esports Packs (53 items+)", set);
  assert.ok(out, "should have flagged an over-claim");
  assert.equal(out.claimed, 53);
  assert.equal(out.total, 47);
});

test("a title with no item count is ignored", () => {
  assert.equal(overClaims("Rust Twitch Drops — Charity Bed", { items: [{}] }), null);
  assert.equal(overClaims("", { items: [{}] }), null);
});

test("the corrected title keeps the wording and only moves the number", () => {
  const set = { items: Array.from({ length: 47 }, () => ({ qty: 1 })) };
  assert.equal(
    correctedTitle("R6 bundle — 51 Esports Packs (53 items+)", set),
    "R6 bundle — 51 Esports Packs (47 items)",
  );
});

test("correcting a title preserves singular/plural as written", () => {
  const set = { items: [{ qty: 1 }] };
  assert.equal(correctedTitle("Rust Drops (5 Item)", set), "Rust Drops (1 Item)");
});

test("a title with nothing to correct is returned unchanged", () => {
  const set = { items: [{ qty: 1 }] };
  assert.equal(correctedTitle("Rust Drops — no count", set), "Rust Drops — no count");
});

/* -------------------------------- category ------------------------------- */

test("the game comes from the first item that names one", () => {
  assert.equal(categoryFor({ items: [{ game: "" }, { game: "Rust" }] }), "Rust");
  assert.equal(categoryFor({ items: [] }), "");
});
