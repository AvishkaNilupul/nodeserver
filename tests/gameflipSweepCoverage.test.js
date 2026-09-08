// The Gameflip watcher must look at every listing it owns, not half of them.
//
// `syncOnce` filtered its sweep to `autoDeliver: true`. The owner's hand-made
// listings carry `autoDeliver: false` (68 rows) or nothing at all (3), so they
// were never polled. Their sales were never seen: `status` stayed "active" for
// months, the price never reached the pricing evidence, and they kept counting
// as live stock in every stock and quantity calculation.
//
// Measured on prod 2026-09-09: 26 of those rows had ALREADY SOLD — $51.80 of
// revenue the system had no record of, the oldest unnoticed since 14 July. It is
// the same defect as the `.limit(100)` documented above the query: a condition
// that silently excludes a population rather than failing loudly.
//
// Reconciling is for every row. RELISTING stays auto-delivery only — republishing
// a hand-made listing would be spending the owner's stock for them.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "gameflipFulfiller.js"),
  "utf8",
);

// The sweep query, as written in syncOnce.
function sweepQuery() {
  const m = SRC.match(
    /const rows = await MarketplaceListing\.find\(\{([\s\S]*?)\}\)\.lean\(\);/,
  );
  assert.ok(m, "could not find the sweep query in syncOnce");
  return m[1];
}

test("REGRESSION: the sweep is not filtered to auto-delivery rows", () => {
  const q = sweepQuery();
  assert.match(q, /marketplace: "gameflip"/);
  assert.match(q, /status: "active"/);
  assert.doesNotMatch(
    q,
    /autoDeliver/,
    "the sweep must cover hand-made listings too — filtering them out lost 26 sales",
  );
});

test("relisting is still gated to auto-delivery rows", () => {
  // Widening the sweep without this guard would let the relist chain republish
  // the owner's own listings.
  assert.match(
    SRC,
    /if \(!row\.autoDeliver\) continue;/,
    "a hand-made listing must never be auto-republished",
  );
});

test("the relist guard sits BEFORE the qtyRemaining check, not after", () => {
  // Order matters: qtyRemaining is 0 on every hand-made row today, so a guard
  // placed after it would look like it worked while doing nothing, and would
  // silently stop working the day an import set a quantity.
  const guard = SRC.indexOf("if (!row.autoDeliver) continue;");
  const qty = SRC.indexOf("if ((Number(row.qtyRemaining) || 0) <= 0) continue;");
  assert.ok(guard > 0 && qty > 0, "both guards should exist");
  assert.ok(guard < qty, "the autoDeliver guard must come first");
});

test("the sale is still recorded and announced for every swept row", () => {
  // Reconciling without learning would fix the status and still lose the price,
  // which is half the value of noticing at all.
  const soldBlock = SRC.slice(
    SRC.indexOf('if (status !== "sold") continue;'),
    SRC.indexOf("if (!row.autoDeliver) continue;"),
  );
  assert.match(soldBlock, /status: "sold"/, "the row must be marked sold");
  assert.match(soldBlock, /recordListingSale\(/, "the sale must reach the pricing evidence");
  assert.match(soldBlock, /sendTelegram\(/, "the owner should be told a sale happened");
});

test("the reason the filter was removed is written down", () => {
  // This filter looked deliberate and survived a long time. The next person to
  // see a slow sweep and reach for a narrowing condition needs the history.
  const q = SRC.slice(Math.max(0, SRC.indexOf("const rows = await MarketplaceListing.find({") - 1400));
  assert.match(q, /hand-made|HAND-MADE/i);
  assert.match(q, /26/, "the measured cost belongs in the comment");
});
