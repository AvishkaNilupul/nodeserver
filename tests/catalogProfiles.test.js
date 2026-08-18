const test = require("node:test");
const assert = require("node:assert/strict");

const {
  signatureForItems,
  sourceEventKeyFor,
} = require("../utils/catalogProfiles");
const { thumbnailUrl } = require("../utils/catalogImage");
const { recommendedProfilePrice } = require("../routes/catalogRoutes");

test("catalog profile signatures are exact and order independent", () => {
  const left = signatureForItems([
    { itemKey: "rare|game", count: 2 },
    { itemKey: "common|game", count: 1 },
  ]);
  const right = signatureForItems([
    { itemKey: "COMMON|GAME", count: 1 },
    { itemKey: "rare|game", count: 2 },
  ]);
  assert.equal(left, right);
  assert.notEqual(
    left,
    signatureForItems([
      { itemKey: "rare|game", count: 1 },
      { itemKey: "common|game", count: 1 },
    ]),
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

test("profile pricing scales observed account sales by reward volume", () => {
  assert.equal(recommendedProfilePrice({ totalRewards: 30 }, 3), 2.82);
  assert.equal(recommendedProfilePrice({ totalRewards: 15 }, 3), 1.41);
  assert.equal(recommendedProfilePrice({ totalRewards: 5 }, 0), 0.71);
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
