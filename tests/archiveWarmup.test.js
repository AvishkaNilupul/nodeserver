const test = require("node:test");
const assert = require("node:assert/strict");

const { ARCHIVE_WARMUP_PLAN } = require("../utils/archiveWarmup");

test("archive warm-up prioritizes the item inventory", () => {
  assert.deepEqual(ARCHIVE_WARMUP_PLAN, [
    { path: "/drops-archive/by-item", delayMs: 0 },
    { path: "/drops-archive/by-game", delayMs: 5000 },
    { path: "/drops-archive/overview", delayMs: 10000 },
  ]);
});
