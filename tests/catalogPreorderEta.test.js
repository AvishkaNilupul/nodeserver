const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computePreorderEta,
  STALE_PROGRESS_MS,
} = require("../utils/catalogPreorder");

test("preorder ETA uses the first account to finish and mean progress", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const snapshot = new Date(now.getTime() - 30 * 60000);
  const result = computePreorderEta(
    [
      {
        farmingSnapshotAt: snapshot,
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 100,
            required: 200,
            percent: 50,
          },
        ],
      },
      {
        farmingSnapshotAt: snapshot,
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 80,
            required: 200,
            percent: 40,
          },
        ],
      },
    ],
    "Event",
    now,
  );
  assert.equal(result.progressPercent, 45);
  assert.equal(result.readyInMinutes, 70);
});

test("preorder ETA adjusts each account from its own snapshot", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const result = computePreorderEta(
    [
      {
        farmingSnapshotAt: new Date(now.getTime() - 10 * 60000),
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 100,
            required: 200,
            percent: 50,
          },
        ],
      },
      {
        farmingSnapshotAt: new Date(now.getTime() - 40 * 60000),
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 80,
            required: 200,
            percent: 40,
          },
        ],
      },
    ],
    "Event",
    now,
  );
  assert.equal(result.readyInMinutes, 80);
});

test("preorder ETA reports zero when all campaign rows are complete", () => {
  const now = new Date();
  const result = computePreorderEta(
    [
      {
        farmingSnapshotAt: now,
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 10,
            required: 10,
            percent: 100,
          },
        ],
      },
    ],
    "Event",
    now,
  );
  assert.equal(result.progressPercent, 100);
  assert.equal(result.readyInMinutes, 0);
});

test("stale progress keeps percent but suppresses ETA", () => {
  const now = new Date();
  const result = computePreorderEta(
    [
      {
        farmingSnapshotAt: new Date(now.getTime() - STALE_PROGRESS_MS - 1),
        farmingProgress: [
          {
            game: "Game",
            campaign: "Event",
            current: 1,
            required: 10,
            percent: 10,
          },
        ],
      },
    ],
    "Event",
    now,
  );
  assert.equal(result.progressPercent, 10);
  assert.equal(Object.hasOwn(result, "readyInMinutes"), false);
});

test("empty farming progress is safe", () => {
  assert.deepEqual(computePreorderEta([{ farmingProgress: [] }], "Event"), {});
});
