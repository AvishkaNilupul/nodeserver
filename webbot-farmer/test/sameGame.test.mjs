// A bot pinned to the Twitch category "Overwatch 2" reads campaigns whose
// inventory game.displayName is "Overwatch". Exact-equal matching meant
// doneCampaignsFromInventory always returned [] for those bots, so they could
// never tell their accounts had finished and cycled channels forever —
// measured on prod 2026-09-07: bots 8, 9 and 10, 150 accounts, every drop at
// 100% and still watching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameGame, doneCampaignsFromInventory } from "../src/channelPool.js";

test("sameGame: category and inventory spellings of one title match", () => {
  assert.ok(sameGame("Overwatch 2", "Overwatch"));
  assert.ok(sameGame("Overwatch", "Overwatch 2"));
  assert.ok(sameGame("overwatch", "Overwatch"));
  assert.ok(sameGame("Rainbow Six Siege", "Rainbow Six Siege"));
});

test("sameGame: unrelated titles and partial words do not match", () => {
  assert.ok(!sameGame("Overwatch", "Overcooked"));
  assert.ok(!sameGame("Rust", "Rustler"));      // not a whole leading word
  assert.ok(!sameGame("Overwatch 2", "Rainbow Six Siege"));
  assert.ok(!sameGame("", "Overwatch"));
  assert.ok(!sameGame("Overwatch", ""));
});

const inv = (campaigns) => ({ data: { currentUser: { inventory: { dropCampaignsInProgress: campaigns } } } });
const drop = (cur, req, claimed = false) => ({
  requiredMinutesWatched: req,
  self: { currentMinutesWatched: cur, isClaimed: claimed },
});

test("a finished campaign is detected even when the bot is pinned 'Overwatch 2'", () => {
  const i = inv([
    { name: "CAH Championship Finals", game: { displayName: "Overwatch" },
      timeBasedDrops: [drop(60, 60), drop(360, 360)] },
  ]);
  assert.deepStrictEqual(doneCampaignsFromInventory(i, "Overwatch 2"), ["CAH Championship Finals"]);
  assert.deepStrictEqual(doneCampaignsFromInventory(i, "Overwatch"), ["CAH Championship Finals"]);
});

test("an unfinished campaign is still not done, and another game is ignored", () => {
  const i = inv([
    { name: "Half watched", game: { displayName: "Overwatch" }, timeBasedDrops: [drop(60, 60), drop(120, 360)] },
    { name: "Other game", game: { displayName: "Rainbow Six Siege" }, timeBasedDrops: [drop(180, 180)] },
    { name: "No drops listed", game: { displayName: "Overwatch" }, timeBasedDrops: [] },
  ]);
  assert.deepStrictEqual(doneCampaignsFromInventory(i, "Overwatch 2"), []);
});
