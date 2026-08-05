// GGSel's 100-character title limit killed three live auto-lists outright
// (FAILED_TO_SAVE: "Title (EN) too long"), so the cap is pinned here.
const test = require("node:test");
const assert = require("node:assert");
const { ggselTitle } = require("../utils/marketplaces");

test("a short title is passed through untouched", () => {
  const t = "Rust Twitch Drops (1 Item) — Charity Box";
  assert.strictEqual(ggselTitle(t), t);
});

test("a long title is cut to GGSel's limit on a word boundary", () => {
  const t =
    "Overwatch Twitch Drops (9 Items) — Dev Lifeguard Lucio, OWCS MSC Gilded " +
    "Weapon Charm, Esports Pack 2026 S1.2, Storm Spray";
  const out = ggselTitle(t);
  assert.ok(out.length <= 100, "still over the limit: " + out.length);
  assert.ok(!out.endsWith(" "));
  assert.ok(t.startsWith(out), "must be a prefix of the original");
  // Cut between words, not mid-word.
  assert.strictEqual(
    t[out.length] === " " || t[out.length] === undefined,
    true,
  );
});

test("a single 100+ character word is cut hard rather than emptied", () => {
  const out = ggselTitle("x".repeat(140));
  assert.strictEqual(out.length, 100);
});

test("nothing in, empty string out", () => {
  assert.strictEqual(ggselTitle(""), "");
  assert.strictEqual(ggselTitle(null), "");
});
