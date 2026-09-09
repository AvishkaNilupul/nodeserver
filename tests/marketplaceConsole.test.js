// Paging the marketplace console without dropping or repeating a row.
//
// The console lists sales, deliveries, listings, rent-farm orders, errors and
// audit rows — every one of them 25 at a time, on a bytes-bound Atlas shared
// tier where `skip()` walks everything it skips. So paging is keyset ("give me
// rows older than this one"), and keyset paging has one classic way to be
// wrong: ordering by a timestamp alone, with no tiebreak.
//
// That is not a corner case here. Bulk-published listings share a `createdAt`
// to the millisecond — prod has 388 GGSel rows and 571 Gameflip rows, published
// in batches — so a page boundary landing inside a group of equal timestamps is
// the NORMAL case. Without the `_id` tiebreak the boundary row is either shown
// twice or never shown at all, and "never shown" is invisible: the operator
// scrolls to the end and believes they have seen everything.
//
// These tests run the real cursor helpers against a simulated collection.
const test = require("node:test");
const assert = require("node:assert");

const routes = require("../routes/marketplaceConsoleRoutes");
const { parseCursor, makeCursor, clampLimit, paginate, MARKETS } = routes;

// A stand-in collection: rows sorted newest-first by (at, _id), paged with the
// same predicate the route builds.
function makeRows(n, sharedTimestamps) {
  const rows = [];
  const base = Date.parse("2026-09-01T00:00:00Z");
  for (let i = 0; i < n; i += 1) {
    rows.push({
      _id: String(i).padStart(24, "0"),
      // Every row shares one timestamp when asked — the bulk-publish shape.
      at: new Date(sharedTimestamps ? base : base + i * 1000),
      n: i,
    });
  }
  return rows;
}

// Mirrors the route: sort { at:-1, _id:-1 }, filter strictly older than cursor.
function query(rows, cur, limit) {
  const sorted = rows.slice().sort((a, b) => {
    const d = b.at - a.at;
    return d !== 0 ? d : (a._id < b._id ? 1 : a._id > b._id ? -1 : 0);
  });
  const after = cur
    ? sorted.filter(
        (r) => r.at < cur.at || (r.at.getTime() === cur.at.getTime() && r._id < cur.id),
      )
    : sorted;
  return paginate(after.slice(0, limit + 1), limit, "at");
}

function pageAll(rows, limit) {
  const seen = [];
  let cur = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const out = query(rows, cur, limit);
    for (const r of out.items) seen.push(r._id);
    if (!out.hasMore) break;
    cur = parseCursor(out.nextCursor);
    assert.ok(cur, "every nextCursor must parse back");
  }
  return seen;
}

/* --------------------------- the classic failure ------------------------- */

test("REGRESSION: rows sharing one timestamp page exactly once each", () => {
  // 60 rows, ALL with the same `at` — a bulk publish. Page size 25, so two
  // boundaries land inside the group.
  const rows = makeRows(60, true);
  const seen = pageAll(rows, 25);
  assert.strictEqual(seen.length, 60, "every row must appear");
  assert.strictEqual(new Set(seen).size, 60, "and none of them twice");
});

test("distinct timestamps page exactly once each too", () => {
  const rows = makeRows(60, false);
  const seen = pageAll(rows, 25);
  assert.strictEqual(seen.length, 60);
  assert.strictEqual(new Set(seen).size, 60);
});

test("a mix of shared and distinct timestamps still covers everything", () => {
  const rows = makeRows(30, false).concat(makeRows(30, true).map((r, i) => ({
    _id: String(1000 + i).padStart(24, "0"),
    at: r.at,
    n: r.n,
  })));
  const seen = pageAll(rows, 7);
  assert.strictEqual(new Set(seen).size, rows.length);
});

test("paging is stable across page sizes", () => {
  const rows = makeRows(41, true);
  for (const size of [1, 2, 5, 25, 40, 41, 100]) {
    const seen = pageAll(rows, size);
    assert.strictEqual(new Set(seen).size, 41, "page size " + size + " lost rows");
  }
});

test("the last page reports hasMore false and no cursor", () => {
  const out = query(makeRows(10, true), null, 25);
  assert.strictEqual(out.hasMore, false);
  assert.strictEqual(out.nextCursor, null);
  assert.strictEqual(out.items.length, 10);
});

test("the extra probe row is never returned to the caller", () => {
  // paginate reads limit+1 to learn hasMore; returning that row would show 26
  // items for a limit of 25 and then repeat it at the top of the next page.
  const out = query(makeRows(60, true), null, 25);
  assert.strictEqual(out.items.length, 25);
  assert.strictEqual(out.hasMore, true);
});

/* ------------------------------ the cursor ------------------------------- */

test("a cursor round-trips", () => {
  const at = new Date("2026-09-09T12:34:56.789Z");
  const id = "0123456789abcdef01234567";
  const cur = parseCursor(makeCursor(at, id));
  assert.strictEqual(cur.at.toISOString(), at.toISOString());
  assert.strictEqual(cur.id, id);
});

test("a hostile or malformed cursor is rejected, not obeyed", () => {
  // A cursor that throws is a 500; one that silently becomes "no cursor" would
  // restart paging from the top forever. Both are worse than rejecting it.
  for (const bad of [
    "", "garbage", "|", "|abc", "2026-09-09T00:00:00Z|", "notadate|0123456789abcdef01234567",
    "2026-09-09T00:00:00Z|../../etc/passwd",
    "2026-09-09T00:00:00Z|" + "z".repeat(24),
    '2026-09-09T00:00:00Z|{"$ne":null}',
    null, undefined,
  ]) {
    assert.strictEqual(parseCursor(bad), null, JSON.stringify(bad) + " should not parse");
  }
});

test("an id that is not a real ObjectId never reaches the query", () => {
  // The id half is interpolated into a Mongo filter. Anything but 24 hex is
  // refused outright rather than trusted.
  assert.strictEqual(parseCursor("2026-09-09T00:00:00Z|0123456789abcdef0123456"), null, "23 chars");
  assert.strictEqual(parseCursor("2026-09-09T00:00:00Z|0123456789abcdef012345678"), null, "25 chars");
  assert.ok(parseCursor("2026-09-09T00:00:00Z|0123456789ABCDEF01234567"), "uppercase hex is fine");
});

/* ------------------------------- the limit ------------------------------- */

test("limit is clamped, and junk falls back to the default", () => {
  assert.strictEqual(clampLimit(undefined), 25);
  assert.strictEqual(clampLimit("50"), 50);
  assert.strictEqual(clampLimit("100000"), 100, "an unbounded page would blow the Atlas byte budget");
  assert.strictEqual(clampLimit("0"), 25);
  assert.strictEqual(clampLimit("-5"), 25);
  assert.strictEqual(clampLimit("abc"), 25, "NaN must not become the limit");
  assert.strictEqual(clampLimit(null), 25);
});

/* ------------------------------- the scope ------------------------------- */

test("z2u is not a marketplace this console knows", () => {
  assert.ok(!MARKETS.includes("z2u"), "z2u is excluded by explicit instruction");
});

test("every other live marketplace is present", () => {
  for (const m of ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g", "funpay"]) {
    assert.ok(MARKETS.includes(m), m + " should have a card");
  }
});

/* ---------------------------- cost guardrails ---------------------------- */

test("no query in the console uses skip()", () => {
  // skip() makes Mongo walk every row it skips. On a bytes-bound shared tier
  // that is the exact shape that has bitten this codebase before.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "marketplaceConsoleRoutes.js"),
    "utf8",
  );
  assert.doesNotMatch(src, /\.skip\(/, "use the keyset cursor, never skip()");
});

test("every find() is bounded by a limit", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "marketplaceConsoleRoutes.js"),
    "utf8",
  );
  const finds = (src.match(/\.find\(/g) || []).length;
  const limits = (src.match(/\.limit\(/g) || []).length;
  assert.ok(limits >= finds, finds + " find() calls but only " + limits + " limit() calls");
});

test("the console never calls a marketplace", () => {
  // Opening a page must not be able to disturb a live market, and must not be
  // usable as a way to hammer one by refreshing.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "marketplaceConsoleRoutes.js"),
    "utf8",
  );
  assert.doesNotMatch(src, /require\(["']\.\.\/utils\/marketplaces["']\)/);
  assert.doesNotMatch(src, /\bfetch\(/);
});

test("every route is superadmin + 2FA", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "routes", "marketplaceConsoleRoutes.js"),
    "utf8",
  );
  // Check each route's own argument list rather than counting occurrences —
  // the import line `const { requireSuperadmin, enforce2fa } = ...` matches a
  // naive count and would make a completely unguarded route look fine.
  const blocks = src.split("router.get(").slice(1);
  assert.ok(blocks.length >= 3, "expected the console's routes");
  for (const b of blocks) {
    const head = b.slice(0, b.indexOf("async ("));
    assert.match(head, /requireSuperadmin/, "a route is missing requireSuperadmin");
    assert.match(head, /enforce2fa/, "a route is missing enforce2fa");
  }
});
