// World of Tanks and UFL sell too thin to be worth burning fresh pool
// accounts, so the auto-farmer only ever REUSES accounts already used for those
// games (existing bots + their own "recycled after <game>" pool entries) and
// never claims a brand-new one. settings.isReuseOnlyGame is the gate that flips
// that behaviour on per game; these lock in exactly which labels it catches.
//
// The match is EXACT-normalised on purpose, not substring like isNoClaimGame:
// the list carries the three-letter token "ufl", and a substring test could
// catch it inside an unrelated game name. The false-positive test below is the
// reason that choice exists.
const test = require("node:test");
const assert = require("node:assert");

const settings = require("../utils/settings");

test("the two configured games match, through case and formatting drift", () => {
  assert.ok(settings.isReuseOnlyGame("World of Tanks"));
  assert.ok(settings.isReuseOnlyGame("world of tanks"));
  assert.ok(settings.isReuseOnlyGame("World of Tanks ")); // trailing space
  assert.ok(settings.isReuseOnlyGame("World  of  Tanks")); // double spaces
  assert.ok(settings.isReuseOnlyGame("World-of-Tanks")); // punctuation
  assert.ok(settings.isReuseOnlyGame("UFL"));
  assert.ok(settings.isReuseOnlyGame("ufl"));
});

test("unrelated games are never reuse-only", () => {
  assert.ok(!settings.isReuseOnlyGame("Overwatch"));
  assert.ok(!settings.isReuseOnlyGame("EVE Online"));
  assert.ok(!settings.isReuseOnlyGame("Escape from Tarkov"));
});

test("the short 'ufl' token must not match as a substring of another game", () => {
  // Exact-match, not substring — a hypothetical game whose normalised label
  // merely CONTAINS "ufl" must not be swept into the reuse-only path.
  assert.ok(!settings.isReuseOnlyGame("Shuffle Cats"));
  assert.ok(!settings.isReuseOnlyGame("uflow"));
  assert.ok(!settings.isReuseOnlyGame("beautiful"));
  // ...and a WoT variant Twitch lists under its own label is NOT the same game.
  assert.ok(!settings.isReuseOnlyGame("World of Tanks Blitz"));
});

test("blank / missing labels are not reuse-only", () => {
  assert.ok(!settings.isReuseOnlyGame(""));
  assert.ok(!settings.isReuseOnlyGame("   "));
  assert.ok(!settings.isReuseOnlyGame(null));
  assert.ok(!settings.isReuseOnlyGame(undefined));
});

test("reuse-only and no-claim are independent lists", () => {
  // A no-claim game (handled by the standalone system) is not reuse-only, and
  // the reuse-only games are not no-claim.
  assert.ok(!settings.isReuseOnlyGame("Rainbow Six Siege"));
  assert.ok(!settings.isNoClaimGame("World of Tanks"));
  assert.ok(!settings.isNoClaimGame("UFL"));
});
