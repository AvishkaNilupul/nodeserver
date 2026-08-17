const ARCHIVE_WARMUP_PLAN = Object.freeze([
  Object.freeze({ path: "/drops-archive/by-item", delayMs: 0 }),
  Object.freeze({ path: "/drops-archive/by-game", delayMs: 5000 }),
  Object.freeze({ path: "/drops-archive/overview", delayMs: 10000 }),
]);

module.exports = { ARCHIVE_WARMUP_PLAN };
