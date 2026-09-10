// Why a listing gets filed under the wrong marketplace category.
//
// "What game is this listing" had four spellings scattered across the publish
// route and the auto-lister, and `DropSet` has no `game` field at all — so
// `set.game` in the zeusx and eldorado publish branches has always evaluated to
// undefined (docs/ACCOUNT-LISTINGS-CONTRACT.md A4). Each caller then
// re-invented the rest of the chain slightly differently. When one of them came
// up empty, the category resolver was handed "" and published into whatever the
// market's search returned first — a wrong category is silent, unlike a refusal.
//
// utils/listingGame.js is the ONE chain. These tests pin it end to end:
//
//   * the precedence order, so replacing the old ad-hoc chains with this
//     function is provably a no-op and not a quiet reordering;
//   * that an EMPTY value at one step never shadows the next — the live case is
//     AccountOffer.game, whose schema default is "" (contract B1:282);
//   * a LIGHT set row (GET /drops-archive/sets?light=1 returns coverGame and a
//     thumb strip, and NO `items` array) must answer from coverGame rather than
//     throw, and its "" means "not known YET" — the caller re-runs after
//     hydration (contract A5);
//   * a hydrated Mongoose set reads item.game through its GETTER. `{...item}`
//     on a sub-document yields undefined for every schema field; that is the
//     bug that shipped "Username: undefined" to a paying buyer.
//
// Pure module, so this runs the real logic on real shapes. No source-text
// matching — that is what failed to catch the G2G credential bug
// (tests/g2gCredentialShape.test.js, and see tests/farmProvisioning.test.js).
const test = require("node:test");
const assert = require("node:assert");

const { listingGame } = require("../utils/listingGame");
// A real hydrated bundle, built in memory. `new DropSet(...)` touches no
// connection — only a query would, and an un-stubbed query stalls rather than
// failing, so there are none here.
const DropSet = require("../models/DropSet");

/* ----------------------------- the precedence ---------------------------- */

test("an explicit game wins over every other source", () => {
  const answer = listingGame({
    game: "Overwatch 2",
    offer: { game: "Rainbow Six Siege" },
    set: { game: "SMITE 2", coverGame: "EVE Online", items: [{ game: "Dota 2" }] },
    listing: { unclaimedGame: "Fallout 76", rentFarmGame: "War Thunder" },
  });
  assert.strictEqual(answer, "Overwatch 2");
});

test("an explicit game is trimmed, and whitespace alone is not an answer", () => {
  assert.strictEqual(
    listingGame({ game: "  Overwatch 2  ", set: { coverGame: "EVE Online" } }),
    "Overwatch 2",
  );
  // A form field the owner tabbed through must not win with a blank.
  assert.strictEqual(
    listingGame({ game: "   ", set: { coverGame: "EVE Online" } }),
    "EVE Online",
  );
});

test("offer.game beats the set — an account listing states its own game", () => {
  const answer = listingGame({
    offer: { game: "Rainbow Six Siege" },
    set: { coverGame: "EVE Online", items: [{ game: "Dota 2" }] },
  });
  assert.strictEqual(answer, "Rainbow Six Siege");
});

test("an offer carrying the schema default \"\" falls through to the set", () => {
  // AccountOffer.game defaults to "" (contract B1), so the ordinary offer-backed
  // row arrives with an empty game. If "" shadowed the set, every such listing
  // would resolve to no game and get published into a guessed category.
  const answer = listingGame({
    offer: { game: "", title: "5x Twitch Drops Bundle" },
    set: { coverGame: "EVE Online" },
  });
  assert.strictEqual(answer, "EVE Online");
});

test("set.game — the dead spelling — still outranks coverGame", () => {
  // DropSet has no `game` field, so in production this step never fires. It is
  // kept, and pinned here, so that swapping the old
  // `set.game || set.coverGame || items…` chains for listingGame() is provably
  // a no-op rather than a reordering.
  const answer = listingGame({
    set: { game: "SMITE 2", coverGame: "EVE Online", items: [{ game: "Dota 2" }] },
  });
  assert.strictEqual(answer, "SMITE 2");
});

test("coverGame answers when there is no explicit game and no offer", () => {
  const answer = listingGame({
    set: { coverGame: "EVE Online", items: [{ game: "Dota 2" }] },
  });
  assert.strictEqual(answer, "EVE Online");
});

test("the FIRST NON-EMPTY items[i].game wins; blank items are skipped", () => {
  // Item.game defaults to "" too, and a set's first item is often the one with
  // no game snapshot. Stopping at the first item — rather than the first
  // non-empty one — is how a full bundle resolved to no game at all.
  const answer = listingGame({
    set: {
      coverGame: "",
      items: [
        { itemKey: "a", game: "" },
        { itemKey: "b", game: null },
        { itemKey: "c", game: "   " },
        { itemKey: "d", game: "Rainbow Six Siege" },
        { itemKey: "e", game: "Overwatch 2" },
      ],
    },
  });
  assert.strictEqual(answer, "Rainbow Six Siege");
});

test("holes and non-object entries in items never throw", () => {
  const answer = listingGame({
    set: { items: [null, undefined, "Overwatch 2", 7, { game: "Dota 2" }] },
  });
  // The bare string is data we cannot trust as an item, so it is skipped.
  assert.strictEqual(answer, "Dota 2");
});

/* ------------------------- the light (unhydrated) row -------------------- */

test("LIGHT set row with items undefined answers from coverGame, not a throw", () => {
  // Exactly the shape GET /drops-archive/sets?light=1 serialises: a count and
  // four thumbnail URLs, no item arrays.
  const lightRow = {
    id: "68c0f1a2b3c4d5e6f7a8b9c0",
    name: "OW2 wave 3",
    note: "",
    itemCount: 12,
    price: 4.5,
    listed: true,
    custom: true,
    coverStyle: "grid",
    coverGame: "Overwatch 2",
    thumbs: ["/img/a.png", "/img/b.png"],
  };
  assert.strictEqual(listingGame({ set: lightRow }), "Overwatch 2");
});

test("LIGHT set row with nothing knowable is \"\" — not known YET", () => {
  // The caller must re-run listingGame after ensureSetItems() hydrates the row
  // (contract A5) instead of caching this answer. An items array that has not
  // loaded is indistinguishable from one that is genuinely empty, so the only
  // safe answer is the refusal.
  const lightRow = { id: "abc", name: "custom promo", itemCount: 9, coverGame: "" };
  assert.strictEqual(listingGame({ set: lightRow }), "");
  assert.strictEqual(listingGame({ set: { itemCount: 9 } }), "");
});

/* --------------------- a real hydrated Mongoose bundle ------------------- */

test("a hydrated set reads item.game through the getter, never a spread", () => {
  const set = new DropSet({
    name: "OW2 wave 3",
    coverGame: "",
    items: [
      { itemKey: "ow2:blank", name: "Loot box", game: "" },
      { itemKey: "ow2:skin", name: "Skin", game: "Overwatch 2" },
    ],
  });

  // The trap itself, asserted so this test fails loudly if anyone "simplifies"
  // the loop into a spread: a sub-document has no OWN schema properties.
  assert.strictEqual({ ...set.items[1] }.game, undefined);
  assert.strictEqual(set.items[1].game, "Overwatch 2");

  assert.strictEqual(listingGame({ set }), "Overwatch 2");
  // And a hydrated doc has no `game` field at all — strict mode drops it — so
  // the dead step really is dead against the real model.
  assert.strictEqual(set.game, undefined);
});

test("a hydrated set's coverGame outranks its own items", () => {
  const set = new DropSet({
    name: "custom promo",
    coverGame: "EVE Online",
    items: [{ itemKey: "d2:hat", game: "Dota 2" }],
  });
  assert.strictEqual(listingGame({ set }), "EVE Online");
});

/* ------------------------------ the listing tail ------------------------- */

test("listing.unclaimedGame / rentFarmGame answer only when no set can", () => {
  assert.strictEqual(
    listingGame({ listing: { unclaimedGame: "Fallout 76" } }),
    "Fallout 76",
  );
  assert.strictEqual(
    listingGame({ listing: { unclaimedGame: "", rentFarmGame: "War Thunder" } }),
    "War Thunder",
  );
  // A set-backed row carries neither field, so this tail must never outrank a
  // set that does know.
  assert.strictEqual(
    listingGame({
      set: { coverGame: "Overwatch 2" },
      listing: { unclaimedGame: "Fallout 76" },
    }),
    "Overwatch 2",
  );
});

/* ------------------------------ the refusals ----------------------------- */

test("\"\" whenever nothing is knowable, for every junk input", () => {
  assert.strictEqual(listingGame(), "");
  assert.strictEqual(listingGame(null), "");
  assert.strictEqual(listingGame(undefined), "");
  assert.strictEqual(listingGame({}), "");
  assert.strictEqual(listingGame("Overwatch 2"), "");
  assert.strictEqual(listingGame(0), "");
  assert.strictEqual(listingGame({ set: null, offer: null, listing: null }), "");
  assert.strictEqual(listingGame({ set: {}, offer: {}, listing: {} }), "");
  assert.strictEqual(listingGame({ set: { items: [] } }), "");
});

test("a non-string game is never stringified — a wrong game beats no game", () => {
  // "[object Object]" or "123" reaching the category resolver would publish
  // into a guessed category, which is the exact failure this module exists to
  // stop. Each of these must fall through, not coerce.
  assert.strictEqual(
    listingGame({ game: 123, set: { coverGame: "EVE Online" } }),
    "EVE Online",
  );
  assert.strictEqual(listingGame({ offer: { game: ["Overwatch 2"] } }), "");
  assert.strictEqual(listingGame({ set: { coverGame: {} } }), "");
  assert.strictEqual(listingGame({ set: { items: [{ game: 5 }] } }), "");
});

test("pure: the same input answers the same, and is never mutated", () => {
  const src = {
    offer: { game: "" },
    set: { coverGame: "", items: [{ itemKey: "a", game: "Overwatch 2" }] },
    listing: { unclaimedGame: "" },
  };
  const before = JSON.stringify(src);
  assert.strictEqual(listingGame(src), "Overwatch 2");
  assert.strictEqual(listingGame(src), "Overwatch 2");
  assert.strictEqual(JSON.stringify(src), before, "listingGame must not mutate");
});
