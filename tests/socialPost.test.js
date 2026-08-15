// The social-post copy templater is the one piece of the No-claim "social post
// generator" that can be tested without a network / DB / Pi, so it carries the
// correctness proof for the feature: every game's headline + hashtags, the
// generic fallback, the highest-count-first ordering that puts stacked packs on
// top, and a clean post even when an account has nothing sellable.
const test = require("node:test");
const assert = require("node:assert");

const { buildSocialPost } = require("../utils/socialPost");

// Kept in lockstep with utils/socialPost.js — asserted verbatim so a change to
// the sell line is a deliberate, visible edit.
const ESCROW_LINE = "Delivered safely via escrow (Gameflip). DM for price 👇";

const items = (...counts) =>
  counts.map((count, i) => ({ name: "Item " + (i + 1), count }));

test("Rainbow Six template: headline + tags, and R6/keyword aliases fold in", () => {
  for (const game of ["Rainbow Six Siege", "R6", "rainbow six"]) {
    const post = buildSocialPost({ game, items: items(1) });
    assert.match(post.title, /Rainbow Six Siege/, game);
    assert.deepStrictEqual(post.hashtags, [
      "#R6Siege",
      "#RainbowSixSiege",
      "#TwitchDrops",
    ]);
  }
});

test("Overwatch template: OW / Overwatch / Overwatch 2 / OW2 all match", () => {
  for (const game of ["Overwatch", "Overwatch 2", "OW2", "OW"]) {
    const post = buildSocialPost({ game, items: items(1) });
    assert.match(post.title, /Overwatch 2/, game);
    assert.deepStrictEqual(post.hashtags, [
      "#Overwatch2",
      "#OverwatchTrading",
      "#TwitchDrops",
    ]);
  }
});

test("Rocket League template: RL alias folds in", () => {
  for (const game of ["Rocket League", "RL"]) {
    const post = buildSocialPost({ game, items: items(1) });
    assert.match(post.title, /Rocket League/, game);
    assert.deepStrictEqual(post.hashtags, [
      "#RocketLeague",
      "#RLtrading",
      "#TwitchDrops",
    ]);
  }
});

test("unknown game falls back to the generic template, no game name leaks in", () => {
  const post = buildSocialPost({ game: "Fortnite", items: items(1) });
  assert.doesNotMatch(post.title, /Fortnite|Rainbow|Overwatch|Rocket/);
  assert.deepStrictEqual(post.hashtags, ["#TwitchDrops", "#GameDrops"]);
  // Missing/blank game must not throw and lands on generic too.
  assert.deepStrictEqual(buildSocialPost({ items: [] }).hashtags, [
    "#TwitchDrops",
    "#GameDrops",
  ]);
  assert.deepStrictEqual(buildSocialPost().hashtags, [
    "#TwitchDrops",
    "#GameDrops",
  ]);
});

test("items are ordered highest-count first, with a ×N prefix only above 1", () => {
  const post = buildSocialPost({
    game: "r6",
    items: [
      { name: "Charm", count: 1 },
      { name: "Loot Box", count: 10 },
      { name: "Skin", count: 3 },
    ],
  });
  assert.deepStrictEqual(post.body.split("\n"), [
    "• 10× Loot Box",
    "• 3× Skin",
    "• Charm",
  ]);
  // The stacked pack must precede the escrow line in the assembled post.
  assert.ok(
    post.text.indexOf("10× Loot Box") < post.text.indexOf(ESCROW_LINE),
  );
});

test("assembled text is title → items → fixed escrow line → hashtags", () => {
  const post = buildSocialPost({ game: "Overwatch 2", items: items(2, 1) });
  const blocks = post.text.split("\n\n");
  assert.strictEqual(blocks[0], post.title);
  assert.strictEqual(blocks[blocks.length - 1], post.hashtags.join(" "));
  assert.strictEqual(blocks[blocks.length - 2], ESCROW_LINE);
  assert.ok(post.text.includes(ESCROW_LINE));
});

test("empty items: clean post with no item lines but still title + line + tags", () => {
  const post = buildSocialPost({ game: "r6", items: [] });
  assert.strictEqual(post.body, "");
  assert.ok(!post.text.includes("•"), "no bullet lines when there are no drops");
  assert.deepStrictEqual(post.text.split("\n\n"), [
    post.title,
    ESCROW_LINE,
    post.hashtags.join(" "),
  ]);
});

test("returned hashtags are a copy — a caller mutating them can't poison the template", () => {
  const a = buildSocialPost({ game: "r6", items: [] });
  a.hashtags.push("#oops");
  const b = buildSocialPost({ game: "r6", items: [] });
  assert.deepStrictEqual(b.hashtags, [
    "#R6Siege",
    "#RainbowSixSiege",
    "#TwitchDrops",
  ]);
});

test("blank and whitespace item names are dropped", () => {
  const post = buildSocialPost({
    game: "rl",
    items: [{ name: "  ", count: 5 }, { name: "Boost", count: 2 }, { count: 9 }],
  });
  assert.deepStrictEqual(post.body.split("\n"), ["• 2× Boost"]);
});
