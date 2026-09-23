const test = require("node:test");
const assert = require("node:assert");

// The router is required whole (it exports bustTargets for exactly this), which
// is safe: nothing at module scope opens a DB connection or starts the rollup
// timer — archiveSnapshot.start() only runs from warmArchiveViews().
const { bustTargets } = require("../routes/dropArchiveRoutes");

// The prefix sets the mutation middleware actually passes, kept verbatim so a
// change on either side shows up here.
const COPIED = ["accounts:"];
const PASSWORD = ["accounts:", "bad-tokens"];
const MARK_SOLD = ["by-item:", "sets:"];
const CATCH_ALL = [
  "overview",
  "by-game",
  "by-item:",
  "accounts:",
  "bad-tokens",
  "sets:",
  "archive:",
];

test("mark-sold drops the exclusions cache, not just the rollup", () => {
  // The regression: soldAt un-excludes a sold shadow duplicate, so a rebuild
  // triggered by this bust must not reuse the pre-write exclusion set.
  assert.deepEqual(bustTargets(MARK_SOLD), {
    exclusions: true,
    snapshot: true,
  });
});

test("an archive-prefix bust invalidates the rollup too", () => {
  assert.deepEqual(bustTargets(["archive:"]), {
    exclusions: true,
    snapshot: true,
  });
});

test("the catch-all mutation bust drops both", () => {
  assert.deepEqual(bustTargets(CATCH_ALL), {
    exclusions: true,
    snapshot: true,
  });
});

test("a bust with no prefixes means everything", () => {
  for (const nothing of [undefined, null, []]) {
    assert.deepEqual(
      bustTargets(nothing),
      { exclusions: true, snapshot: true },
      "prefixes=" + JSON.stringify(nothing),
    );
  }
});

test("copy-count and password writes leave both caches alone", () => {
  // Neither touches scan status, placement or soldAt, so the exclusion set is
  // unchanged — and recomputing it is the expensive part of every heavy read.
  assert.deepEqual(bustTargets(COPIED), {
    exclusions: false,
    snapshot: false,
  });
  assert.deepEqual(bustTargets(PASSWORD), {
    exclusions: false,
    snapshot: false,
  });
});

test("a prefix is matched whole, never as a substring", () => {
  // "by-item:" is a real trigger; "by-items" is not one, and startsWith-style
  // matching would have quietly made it one.
  assert.equal(bustTargets(["by-items"]).snapshot, false);
  assert.equal(bustTargets(["archive"]).snapshot, false);
});

test("the rollup and the exclusion set it reads never disagree", () => {
  const vocabulary = [
    "archive:",
    "overview",
    "by-game",
    "by-item:",
    "accounts:",
    "bad-tokens",
    "sets:",
    "unknown:",
  ];
  // Every subset of the prefixes any caller could pass.
  for (let mask = 0; mask < 1 << vocabulary.length; mask++) {
    const prefixes = vocabulary.filter((_, i) => mask & (1 << i));
    if (!prefixes.length) continue; // covered above as "means everything"
    const t = bustTargets(prefixes);
    assert.equal(
      t.exclusions,
      t.snapshot,
      "disagreed on " + JSON.stringify(prefixes),
    );
  }
});
