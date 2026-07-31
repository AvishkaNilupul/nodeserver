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
const COUNT_MANUAL_AS_COVERAGE = false; // must match utils/autoFarmer.js

// Mirrors the gate: manual farmers are measured but not credited, and the
// archive count arrives with the manual stash already subtracted out.
function coverage({ gameSpecific, wildcards, archive }) {
  const wildcardCredit = Math.min(wildcards, WILDCARD_CREDIT_CAP);
  const raw = COUNT_MANUAL_AS_COVERAGE
    ? gameSpecific + wildcardCredit + archive
    : archive;
  return Number.isFinite(raw) ? raw : 0;
}

function uncovered({ wanted, ...c }) {
  return Math.max(0, wanted - coverage(c));
}

// Mirrors utils/autoFarmer.js splitHolders: a game's unsold holders sorted into
// stock this system can sell, stock parked on a manual bot, and stock that
// belongs to no auto task. `owned === null` means ownership is unknown.
function splitHolders(all, stash, owned) {
  const s = stash === null ? null : new Set(stash.map((x) => x.toLowerCase()));
  const o = owned === null ? null : new Set(owned.map((x) => x.toLowerCase()));
  let holders = 0;
  let stashed = 0;
  let other = 0;
  for (const raw of all) {
    const l = String(raw).toLowerCase();
    if (s && s.has(l)) stashed++;
    else if (!o || o.has(l)) holders++;
    else other++;
  }
  return { holders, stashed, other };
}

test("the live prod case: 1615 wildcards no longer block a fresh campaign", () => {
  // Mir Tankov as recorded on prod: manualFarmers 1615, archiveHolders 0,
  // wanted 18. Before the cap this produced uncovered = 0 -> skip.
  const args = { gameSpecific: 0, wildcards: 1615, archive: 0, wanted: 18 };
  assert.strictEqual(coverage(args), 0, "wildcards must not count as coverage");
  assert.strictEqual(uncovered(args), 18, "the full target should be farmable");
});

test("manual bots farming a game do NOT block auto-farming it", () => {
  // EVE Online / Ravendawn on prod: 31 accounts on a hand-made bot against a
  // target of 18, so uncovered was 0 and the game could never be auto-farmed.
  // Those accounts are the owner's long-term stash — they hoard many campaigns
  // of items for a premium bundle later — so they are not stock for today.
  const args = { gameSpecific: 31, wildcards: 0, archive: 0, wanted: 18 };
  assert.strictEqual(coverage(args), 0);
  assert.strictEqual(uncovered(args), 18, "farm it anyway, alongside the stash");
});

test("archive holders parked on a manual bot are stash, not stock", () => {
  // Dead by Daylight on prod: 140 unsold holders, of which the manual Lost
  // Ark/DbD container holds most. Only the rest can be coverage.
  const r = splitHolders(["a", "b", "c", "d", "e"], ["B", "c", "D"], null);
  assert.strictEqual(r.stashed, 3, "case-insensitive stash match");
  assert.strictEqual(r.holders, 2);
  assert.strictEqual(uncovered({ gameSpecific: 0, wildcards: 0, archive: r.holders, wanted: 18 }), 16);
});

test("only stock the auto system OWNS counts as its coverage", () => {
  // Its listings deliver from task.assignedAccounts and nothing else, so an
  // archive account belonging to no auto task can never reach one of its
  // buyers. Prod: Overwatch had 110 such holders and the system owned 0 —
  // blocked from farming stock it could actually have sold.
  const holders = ["mine1", "mine2", "somebodyelses", "stashed1"];
  const r = splitHolders(holders, ["stashed1"], ["mine1", "mine2"]);
  assert.deepStrictEqual(r, { holders: 2, stashed: 1, other: 1 });
  assert.strictEqual(
    uncovered({ gameSpecific: 0, wildcards: 0, archive: r.holders, wanted: 18 }),
    16,
    "the 1 unsellable holder must not reduce what it farms",
  );
});

test("unknown ownership fails CONSERVATIVE, crediting every non-stashed holder", () => {
  // ownedAccounts() returns null when its lookup fails. An empty Set there
  // would read as "owns nothing" — zero coverage, maximum spend — so null must
  // mean "count them all", the lower-spend reading.
  const holders = ["a", "b", "c", "d"];
  const unknown = splitHolders(holders, ["a"], null);
  assert.strictEqual(unknown.holders, 3, "credited, so less is farmed");
  assert.strictEqual(unknown.other, 0);
  const ownsNothing = splitHolders(holders, ["a"], []);
  assert.strictEqual(ownsNothing.holders, 0, "an empty set is the fail-open case");
  assert.ok(
    unknown.holders > ownsNothing.holders,
    "null must never be treated as an empty set",
  );
});

test("unsold archive stock still counts when it is genuinely sellable", () => {
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
  const args = { gameSpecific: 0, wildcards: 10, archive: NaN, wanted: 18 };
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
