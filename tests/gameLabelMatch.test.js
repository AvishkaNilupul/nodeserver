// The manual mark-sold flow only pulls a sold account out of a listing (and
// lets the auto-feed replace it) when the listing's set sells the sold game.
// That decision runs through sameGame(). A strict === once risked a silent
// miss on formatting drift; these lock in that drift matches while genuinely
// different games never do.
const test = require("node:test");
const assert = require("node:assert");

const { normGame, sameGame } = require("../utils/gameLabel");

test("identical labels match", () => {
  assert.ok(sameGame("Overwatch", "Overwatch"));
});

test("formatting drift still matches (the whole point)", () => {
  assert.ok(sameGame("Overwatch", "overwatch"));
  assert.ok(sameGame("Overwatch", "Overwatch ")); // trailing space
  assert.ok(sameGame("Overwatch", "Overwatch™")); // trademark mark
  assert.ok(sameGame("Rainbow Six Siege", "Rainbow  Six  Siege")); // double spaces
  assert.ok(sameGame("Rainbow Six: Siege", "Rainbow Six Siege")); // punctuation
  assert.ok(sameGame("The First Descendant", "the first descendant "));
});

test("DIFFERENT games must NEVER match — digits are significant", () => {
  assert.ok(!sameGame("Overwatch", "Overwatch 2"));
  assert.ok(!sameGame("Overwatch 2", "Overwatch"));
  assert.ok(!sameGame("Rainbow Six Siege", "Rainbow Six Extraction"));
  assert.ok(!sameGame("SMITE", "SMITE 2"));
  assert.ok(!sameGame("Overwatch", "EVE Online"));
});

test("empty / missing labels canonicalise to empty and only match each other", () => {
  assert.strictEqual(normGame(null), "");
  assert.strictEqual(normGame(undefined), "");
  assert.strictEqual(normGame("   "), "");
  assert.ok(sameGame("", "")); // both "Other rewards"-less blanks
  assert.ok(!sameGame("", "Overwatch"));
});

test("normGame collapses punctuation/whitespace but keeps alphanumerics", () => {
  assert.strictEqual(normGame("  Rainbow  Six: Siege™ "), "rainbow six siege");
  assert.strictEqual(normGame("Overwatch 2"), "overwatch 2");
});
