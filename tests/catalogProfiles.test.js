const test = require("node:test");
const assert = require("node:assert/strict");

const {
  signatureForItems,
  sourceEventKeyFor,
  profileTitle,
  collapseSubsetProfiles,
} = require("../utils/catalogProfiles");
const { thumbnailUrl } = require("../utils/catalogImage");
const { recommendedProfilePrice } = require("../routes/catalogRoutes");

test("catalog profile signatures group by item type, order and count independent", () => {
  const left = signatureForItems([
    { itemKey: "rare|game", count: 2 },
    { itemKey: "common|game", count: 1 },
  ]);
  const right = signatureForItems([
    { itemKey: "COMMON|GAME", count: 1 },
    { itemKey: "rare|game", count: 2 },
  ]);
  assert.equal(left, right);
  // Copy counts no longer affect grouping — same item TYPES => same signature,
  // so accounts farmed at different times bundle together.
  assert.equal(
    left,
    signatureForItems([
      { itemKey: "rare|game", count: 1 },
      { itemKey: "common|game", count: 1 },
    ]),
  );
  // A different set of item TYPES still produces a different signature.
  assert.notEqual(
    left,
    signatureForItems([{ itemKey: "rare|game", count: 1 }]),
  );
});

test("catalog profile source keys are deterministic and game scoped", () => {
  const signature = "item|game:2";
  assert.equal(
    sourceEventKeyFor("Rocket League", signature),
    sourceEventKeyFor("rocket league", signature),
  );
  assert.notEqual(
    sourceEventKeyFor("Rocket League", signature),
    sourceEventKeyFor("Warframe", signature),
  );
});

test("profile titles use campaigns or neutral tier names, never item names", () => {
  assert.equal(
    profileTitle(
      "Rocket League",
      [{ campaigns: ["Summer Event"], name: "Secret Drop" }],
      "Starter",
    ),
    "Rocket League — Summer Event",
  );
  const title = profileTitle(
    "Rocket League",
    [{ name: "Secret Drop" }],
    "Standard",
  );
  assert.equal(title, "Rocket League Drops — Standard Bundle");
  assert.equal(title.includes("Secret Drop"), false);
});

test("strict subset profiles are removed when the larger profile has equal stock", () => {
  const item = (itemKey) => ({ itemKey });
  const profiles = [
    {
      signature: "a",
      items: [item("a")],
      accountIds: ["1", "2"],
      totalRewards: 1,
    },
    {
      signature: "a|b",
      items: [item("a"), item("b")],
      accountIds: ["1", "2"],
      totalRewards: 2,
    },
    {
      signature: "c",
      items: [item("c")],
      accountIds: ["3", "4"],
      totalRewards: 1,
    },
  ];
  const result = collapseSubsetProfiles(profiles, 6);
  assert.deepEqual(result.map((profile) => profile.signature).sort(), [
    "a|b",
    "c",
  ]);
});

test("subset collapse honors the per-game cap", () => {
  const profiles = Array.from({ length: 8 }, (_, index) => ({
    signature: String(index),
    items: [{ itemKey: String(index) }],
    accountIds: [String(index), `${index}-b`],
    totalRewards: 1,
  }));
  assert.equal(collapseSubsetProfiles(profiles, 6).length, 6);
});

test("profile pricing scales observed account sales by reward volume", () => {
  assert.equal(recommendedProfilePrice({ totalRewards: 30 }, 3), 2.82);
  assert.equal(recommendedProfilePrice({ totalRewards: 15 }, 3), 1.41);
  assert.equal(recommendedProfilePrice({ totalRewards: 5 }, 0), 0.71);
});

test("profile pricing prefers approved catalog price per reward", () => {
  assert.equal(recommendedProfilePrice({ totalRewards: 30 }, 0.75, 0.1), 2.82);
  assert.equal(recommendedProfilePrice({ totalRewards: 15 }, 10, 0.1), 1.41);
});

test("catalog thumbnails accept only cached hash image paths", () => {
  const hash = "a".repeat(40);
  assert.equal(
    thumbnailUrl(`/drop-images/${hash}.png`),
    `/catalog/thumb/${hash}.png`,
  );
  assert.equal(thumbnailUrl("/drop-images/../../server.js"), "");
  assert.equal(thumbnailUrl("https://example.com/image.png"), "");
});
