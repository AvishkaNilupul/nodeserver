// Coverage-gate arithmetic. These are the numbers that decide whether a
// campaign gets farmed at all, and a silent 100% block hid in them for a day:
// ~1615 "farms everything" accounts were credited in full against every game
// simultaneously, so `uncovered` was 0 for all 127 live campaigns.
//
// The gate lives inside processCampaign (Mongo + hosts), so these tests pin the
// pure arithmetic rather than the function, mirroring it exactly.
const test = require("node:test");
const assert = require("node:assert");

const WILDCARD_CREDIT_CAP = 0; // must match utils/autoFarmer.js

// Mirrors the gate: credit is capped, a non-finite total fails closed to 0.
function coverage({ gameSpecific, wildcards, archive }) {
  const wildcardCredit = Math.min(wildcards, WILDCARD_CREDIT_CAP);
  const raw = gameSpecific + wildcardCredit + archive;
  return Number.isFinite(raw) ? raw : 0;
}

function uncovered({ wanted, ...c }) {
  return Math.max(0, wanted - coverage(c));
}

test("the live prod case: 1615 wildcards no longer block a fresh campaign", () => {
  // Mir Tankov as recorded on prod: manualFarmers 1615, archiveHolders 0,
  // wanted 18. Before the cap this produced uncovered = 0 -> skip.
  const args = { gameSpecific: 0, wildcards: 1615, archive: 0, wanted: 18 };
  assert.strictEqual(coverage(args), 0, "wildcards must not count as coverage");
  assert.strictEqual(uncovered(args), 18, "the full target should be farmable");
});

test("accounts farming the game SPECIFICALLY still count in full", () => {
  const args = { gameSpecific: 12, wildcards: 1615, archive: 0, wanted: 18 };
  assert.strictEqual(coverage(args), 12);
  assert.strictEqual(uncovered(args), 6);
});

test("unsold archive stock counts, so we don't farm what we already hold", () => {
  // Overwatch on prod: 297 unsold holders. Previously read as 0 because the
  // query filtered on DropLog.campaign, which is set on only 1.81% of rows.
  const args = { gameSpecific: 0, wildcards: 1615, archive: 297, wanted: 30 };
  assert.strictEqual(coverage(args), 297);
  assert.strictEqual(uncovered(args), 0, "already covered by real stock");
});

test("coverage never goes negative and never exceeds the ask", () => {
  assert.strictEqual(uncovered({ gameSpecific: 500, wildcards: 0, archive: 500, wanted: 30 }), 0);
  assert.strictEqual(uncovered({ gameSpecific: 0, wildcards: 0, archive: 0, wanted: 30 }), 30);
});

test("a non-finite coverage term fails CLOSED, not open", () => {
  // NaN would make every `< 1` comparison false and slip past both the coverage
  // gate and the pool gate, persisting plannedAccounts: NaN through Mongoose.
  const args = { gameSpecific: NaN, wildcards: 10, archive: 0, wanted: 18 };
  assert.strictEqual(coverage(args), 0);
  assert.ok(Number.isFinite(uncovered(args)));
  assert.strictEqual(uncovered(args), 18);
});

test("target guard rejects NaN as well as sub-1", () => {
  const ok = (target) => Number.isFinite(target) && target >= 1;
  assert.strictEqual(ok(NaN), false);
  assert.strictEqual(ok(0), false);
  assert.strictEqual(ok(0.4), false);
  assert.strictEqual(ok(1), true);
});

// Backfill ordering: highest demand first, and never top up a campaign that
// ends inside the same window that blocks new farming.
test("backfill serves proven sellers before whichever ran first", () => {
  const tasks = [
    { game: "Shakes and Fidget", demandScore: 12, executedAt: 1 },
    { game: "Marvel Rivals", demandScore: 254.9, executedAt: 9 },
    { game: "Rust", demandScore: 212.4, executedAt: 5 },
  ];
  const sorted = tasks
    .slice()
    .sort((a, b) => b.demandScore - a.demandScore || a.executedAt - b.executedAt);
  assert.deepStrictEqual(
    sorted.map((t) => t.game),
    ["Marvel Rivals", "Rust", "Shakes and Fidget"],
  );
});

test("backfill skips campaigns ending inside minHoursLeft", () => {
  const minHoursLeft = 12;
  const hoursLeft = (end) => (end - 0) / 3600000;
  const tasks = [
    { game: "ending soon", campaignEndAt: 4 * 3600000 },
    { game: "plenty left", campaignEndAt: 72 * 3600000 },
    { game: "no end date", campaignEndAt: null },
  ];
  const kept = tasks.filter(
    (t) => !t.campaignEndAt || hoursLeft(t.campaignEndAt) >= minHoursLeft,
  );
  assert.deepStrictEqual(
    kept.map((t) => t.game),
    ["plenty left", "no end date"],
  );
});
