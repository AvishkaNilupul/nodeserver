// Pure-function coverage for the Unclaimed Drop archive views (By item /
// By game / Accounts) — no DB, no docker, no network. The archive endpoints
// are thin wrappers that feed a projected find() into these helpers.
const test = require("node:test");
const assert = require("node:assert");

const {
  archiveStatusFilter,
  archiveItemKey,
  groupArchiveByItem,
  groupArchiveByGame,
} = require("../utils/unclaimedAutoList");

function ROW(id, game, status, drops) {
  return { _id: id, game, status, drops };
}

test("archive status filter: held = listed+skipped, other statuses excluded", () => {
  assert.deepStrictEqual(archiveStatusFilter("held"), {
    status: { $in: ["listed", "skipped"] },
  });
  assert.deepStrictEqual(archiveStatusFilter("HELD"), {
    status: { $in: ["listed", "skipped"] },
  });
  // Absent status defaults to the held bucket too.
  assert.deepStrictEqual(archiveStatusFilter(""), {
    status: { $in: ["listed", "skipped"] },
  });
  assert.deepStrictEqual(archiveStatusFilter(), {
    status: { $in: ["listed", "skipped"] },
  });
  const held = archiveStatusFilter("held").status.$in;
  for (const s of ["sold", "expired", "released", "removed"]) {
    assert.ok(!held.includes(s), s + " must not be in the held bucket");
  }
});

test("archive status filter: raw status passes through; only 'all' means unfiltered", () => {
  assert.deepStrictEqual(archiveStatusFilter("sold"), { status: "sold" });
  assert.deepStrictEqual(archiveStatusFilter("listed"), { status: "listed" });
  assert.deepStrictEqual(archiveStatusFilter("all"), null);
});

test("archive item key: prefers stored itemKey, falls back to normalized game|name", () => {
  assert.strictEqual(
    archiveItemKey(
      { itemKey: "alpha pack|rainbow six siege", name: "Alpha Pack" },
      "Rainbow Six Siege",
    ),
    "alpha pack|rainbow six siege",
  );
  assert.strictEqual(
    archiveItemKey({ name: "Alpha Pack" }, "Rainbow Six Siege"),
    "rainbow six siege|alpha pack",
  );
  assert.strictEqual(
    archiveItemKey({ name: "  Alpha Pack  " }, " Rainbow Six Siege "),
    "rainbow six siege|alpha pack",
  );
});

test("by item: 4x the same drop on one account is accounts 1, units 4", () => {
  const rows = [
    ROW("a1", "Rainbow Six Siege", "listed", [
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    ]),
  ];
  const items = groupArchiveByItem(rows, false);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].itemKey, "alpha pack|rainbow six siege");
  assert.strictEqual(items[0].name, "Alpha Pack");
  assert.strictEqual(items[0].game, "Rainbow Six Siege");
  assert.strictEqual(items[0].accounts, 1);
  assert.strictEqual(items[0].units, 4);
});

test("by item: distinct accounts vs units, plus the per-status rollup", () => {
  const rows = [
    ROW("a1", "Rainbow Six Siege", "listed", [
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    ]),
    ROW("a2", "Rainbow Six Siege", "listed", [
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    ]),
    ROW("a3", "Rainbow Six Siege", "sold", [
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    ]),
  ];
  const items = groupArchiveByItem(rows, true);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].accounts, 3);
  assert.strictEqual(items[0].units, 4);
  assert.deepStrictEqual(items[0].byStatus, {
    listed: 2,
    sold: 1,
    expired: 0,
    released: 0,
    skipped: 0,
    removed: 0,
  });
});

test("by item: legacy rows without itemKey group under the normalized game|name key", () => {
  const rows = [
    ROW("a1", "Overwatch", "listed", [{ name: "Pachimari Icon" }]),
    ROW("a2", "overwatch", "skipped", [{ name: "Pachimari Icon" }]),
  ];
  const items = groupArchiveByItem(rows, false);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].itemKey, "overwatch|pachimari icon");
  assert.strictEqual(items[0].accounts, 2);
  assert.strictEqual(items[0].units, 2);
});

test("by game: distinct accounts and items per game, with status rollup", () => {
  const rows = [
    ROW("a1", "Overwatch", "listed", [
      { name: "Pachimari Icon", itemKey: "pachimari icon|overwatch" },
      { name: "Lootbox", itemKey: "lootbox|overwatch" },
    ]),
    ROW("a2", "Overwatch", "listed", [
      { name: "Pachimari Icon", itemKey: "pachimari icon|overwatch" },
    ]),
    ROW("a3", "Rainbow Six Siege", "sold", [
      { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    ]),
  ];
  const games = groupArchiveByGame(rows, true);
  assert.strictEqual(games.length, 2);
  const ow = games.find((g) => g.game === "Overwatch");
  assert.strictEqual(ow.accounts, 2);
  assert.strictEqual(ow.items, 2);
  assert.deepStrictEqual(ow.byStatus, {
    listed: 2,
    sold: 0,
    expired: 0,
    released: 0,
    skipped: 0,
    removed: 0,
  });
  const r6 = games.find((g) => g.game === "Rainbow Six Siege");
  assert.strictEqual(r6.accounts, 1);
  assert.strictEqual(r6.items, 1);
  assert.strictEqual(r6.byStatus.sold, 1);
});

test("by item and by game sort by accounts desc", () => {
  const rows = [
    ROW("a1", "Game B", "listed", [{ name: "Item B", itemKey: "item b|game b" }]),
    ROW("a2", "Game A", "listed", [
      { name: "Item A1", itemKey: "item a1|game a" },
      { name: "Item A2", itemKey: "item a2|game a" },
    ]),
    ROW("a3", "Game A", "listed", [{ name: "Item A1", itemKey: "item a1|game a" }]),
  ];
  const games = groupArchiveByGame(rows, false);
  assert.strictEqual(games[0].game, "Game A");
  const items = groupArchiveByItem(rows, false);
  assert.strictEqual(items[0].itemKey, "item a1|game a");
});

function SRC(id, source, game, status, drops) {
  return { _id: id, source, game, status, drops };
}

test("by item: bySource splits distinct accounts into no-claim vs web-token", () => {
  const key = "pachimari icon|overwatch";
  const rows = [
    SRC("a1", "noclaim", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
    SRC("a2", "webbot", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
    SRC("a3", "webbot", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
  ];
  const items = groupArchiveByItem(rows, false);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].accounts, 3);
  assert.deepStrictEqual(items[0].bySource, { noclaim: 1, webbot: 2 });
});

test("by item: an unknown/blank source never inflates the split", () => {
  const key = "pachimari icon|overwatch";
  const rows = [
    SRC("a1", "reseller", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
    SRC("a2", "", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
  ];
  const items = groupArchiveByItem(rows, false);
  assert.strictEqual(items[0].accounts, 2);
  assert.deepStrictEqual(items[0].bySource, { noclaim: 0, webbot: 0 });
});

test("by game: folds game-name casing into ONE row and keeps the nice label", () => {
  const key = "pachimari icon|overwatch";
  const rows = [
    SRC("a1", "noclaim", "Overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
    SRC("a2", "webbot", "overwatch", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
    SRC("a3", "webbot", "OVERWATCH", "listed", [{ name: "Pachimari Icon", itemKey: key }]),
  ];
  const games = groupArchiveByGame(rows, false);
  assert.strictEqual(games.length, 1); // Overwatch / overwatch / OVERWATCH = one game
  assert.strictEqual(games[0].game, "Overwatch"); // nicest spelling wins
  assert.strictEqual(games[0].accounts, 3);
  assert.strictEqual(games[0].items, 1);
  assert.deepStrictEqual(games[0].bySource, { noclaim: 1, webbot: 2 });
});
