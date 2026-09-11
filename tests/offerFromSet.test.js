// utils/offerFromSet — copying a Shop / Custom listing (a DropSet) into a
// draft account listing, the path behind the Twitch-inventory page's "Create
// listing" and the Listings page's "Account listing" button.
//
// Failures these exist to prevent:
//
//  1. THE SET'S STOCK OR VISIBILITY LEAKING INTO THE OFFER. A copy is a
//     whitelist of AccountOffer fields; an `items`, an account scope, a
//     `listed` or a `publicCatalog` riding along would either put archive
//     accounts on a supplied shelf (one account sold by both paths) or push
//     owner-supplied stock onto the public storefront.
//  2. A DESCRIPTION THAT FORGETS THE DROPS. An account listing has no items,
//     so its description is the whole contract with the buyer; a copy that
//     dropped the item list would sell an account without saying what is on
//     it. A note that already lists them must not get the list twice.
//  3. A COPY THAT GOES LIVE. It must always be a draft — the shelf is empty.
//  4. A COVER THAT DOWNLOADS AT PUBLISH TIME. Remote tile URLs are fetched
//     serially inside every publish, so only hosted paths are copied.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DropSet = require("../models/DropSet");
const AccountOffer = require("../models/AccountOffer");
const {
  COVER_IMAGES_MAX,
  offerFieldsFromSet,
  offerDescriptionFromSet,
  coverImagesFromSet,
} = require("../utils/offerFromSet");

// What POST /drops-archive/sets/from-items stores for a Twitch-inventory
// "Create listing": a note that lists every item (buildSetNote), cached
// /drop-images paths, no coverGame, price 0.
function twitchSet(extra = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: "Rust bundle — Hoodie, Pants +1 more (4 items)",
    note: [
      "This account includes 4 items from Rust:",
      "• Hoodie (Rust)",
      "• 2× Pants (Rust)",
      "• Hood (Rust)",
      "",
      "Buyer receives one in-stock account holding every item listed above.",
    ].join("\n"),
    items: [
      { itemKey: "hoodie|rust", name: "Hoodie", game: "Rust", image: "/drop-images/a.png", qty: 1 },
      { itemKey: "pants|rust", name: "Pants", game: "Rust", image: "/drop-images/b.png", qty: 2 },
      { itemKey: "hood|rust", name: "Hood", game: "Rust", image: "/drop-images/a.png", qty: 1 },
    ],
    price: 0,
    minPriceUsd: 0,
    listed: true,
    publicCatalog: true,
    custom: false,
    coverStyle: "grid",
    coverGame: "",
    coverServiceText: "",
    coverBullets: [],
    coverImages: [],
    accountScopeLogins: ["archive_login_1"],
    accountScopeIds: ["64f000000000000000000001"],
    sourceType: "radar-event",
    ...extra,
  };
}

test("a copy is exactly the AccountOffer whitelist — no stock, no visibility", () => {
  const set = twitchSet();
  const out = offerFieldsFromSet(set);
  assert.deepEqual(Object.keys(out).sort(), [
    "coverBullets",
    "coverImages",
    "coverServiceText",
    "coverStyle",
    "description",
    "game",
    "minPriceUsd",
    "priceUsd",
    "sourceSet",
    "status",
    "title",
  ]);
  // And every key is a real AccountOffer path, so nothing is silently dropped
  // by strict mode either — what is built here is what gets stored.
  for (const key of Object.keys(out)) {
    assert.ok(AccountOffer.schema.path(key), key + " is an AccountOffer field");
  }
  assert.equal(out.status, "draft", "a copy never goes live: its shelf is empty");
  assert.equal(String(out.sourceSet), String(set._id));
  assert.equal(out.title, set.name);
  assert.equal(out.game, "Rust", "the game comes from the items when the set has no coverGame");
  assert.equal(out.coverStyle, "promo", "the grid collage needs items an offer does not have");
});

test("a note that already lists every item is kept exactly as written", () => {
  const set = twitchSet();
  assert.equal(offerDescriptionFromSet(set), set.note);
});

test("a note that does not list the items gets the Includes block appended", () => {
  const set = twitchSet({ note: "Great starter account, instant delivery." });
  assert.equal(
    offerDescriptionFromSet(set),
    [
      "Great starter account, instant delivery.",
      "",
      "Includes:",
      "- Hoodie (Rust)",
      "- 2× Pants (Rust)",
      "- Hood (Rust)",
    ].join("\n"),
  );
});

test('"Hoodie" in the note does not count as listing "Hood"', () => {
  const set = twitchSet({ note: "Comes with the Hoodie and the Pants." });
  const desc = offerDescriptionFromSet(set);
  assert.ok(desc.includes("Includes:"), "Hood is not in the note, so the list is appended");
  assert.ok(desc.includes("- Hood (Rust)"));
});

test("an empty note becomes just the item list; no items and no note is empty", () => {
  const set = twitchSet({ note: "" });
  assert.equal(
    offerDescriptionFromSet(set),
    "Includes:\n- Hoodie (Rust)\n- 2× Pants (Rust)\n- Hood (Rust)",
  );
  assert.equal(offerDescriptionFromSet({ name: "x", note: "", items: [] }), "");
  assert.equal(offerDescriptionFromSet({ name: "x", note: "  Only text  " }), "Only text");
});

test("item names with regex characters are matched literally", () => {
  const set = twitchSet({
    note: "Includes C++ Skin (x2) and [Rare] Crate.",
    items: [
      { itemKey: "a", name: "C++ Skin (x2)", game: "Rust", qty: 1 },
      { itemKey: "b", name: "[Rare] Crate", game: "Rust", qty: 1 },
    ],
  });
  assert.equal(offerDescriptionFromSet(set), set.note);
});

test("the set's own cover images win, else the items' hosted images, deduped", () => {
  const custom = twitchSet({ coverImages: ["/uploads/one.png", "https://cdn.example/x.png"] });
  assert.deepEqual(coverImagesFromSet(custom), ["/uploads/one.png"]);

  // No own images: the items' images, first appearance only.
  assert.deepEqual(coverImagesFromSet(twitchSet()), ["/drop-images/a.png", "/drop-images/b.png"]);

  // Remote and protocol-relative URLs are never copied — they would be
  // downloaded, one at a time, inside every publish.
  const remote = twitchSet({
    items: [
      { itemKey: "a", name: "A", image: "https://static-cdn.jtvnw.net/a.png" },
      { itemKey: "b", name: "B", image: "//evil.example/b.png" },
      { itemKey: "c", name: "C", image: "" },
    ],
  });
  assert.deepEqual(coverImagesFromSet(remote), []);

  const many = twitchSet({
    items: Array.from({ length: 50 }, (_, i) => ({
      itemKey: "k" + i,
      name: "Item " + i,
      image: "/drop-images/" + i + ".png",
    })),
  });
  assert.equal(coverImagesFromSet(many).length, COVER_IMAGES_MAX);
});

test("price, floor and cover text are copied and capped like a hand-made offer", () => {
  const out = offerFieldsFromSet(
    twitchSet({
      price: 12.345,
      minPriceUsd: "7.5",
      coverServiceText: "  Lifetime  ",
      coverBullets: ["a", " ", "b", "c", "d", "e"],
    }),
  );
  assert.equal(out.priceUsd, 12.35);
  assert.equal(out.minPriceUsd, 7.5);
  assert.equal(out.coverServiceText, "Lifetime");
  assert.deepEqual(out.coverBullets, ["a", "b", "c", "d"]);

  const junk = offerFieldsFromSet(twitchSet({ price: -3, minPriceUsd: "abc" }));
  assert.equal(junk.priceUsd, 0);
  assert.equal(junk.minPriceUsd, 0);
});

test("a custom listing's coverGame outranks its items for the game", () => {
  const out = offerFieldsFromSet(twitchSet({ coverGame: "Rust Console Edition" }));
  assert.equal(out.game, "Rust Console Edition");
});

test("a hydrated DropSet document copies through its getters, never undefined", () => {
  // The "Username: undefined" class: spreading a Mongoose sub-document yields
  // undefined for every schema field. A real document must copy the same as a
  // lean object.
  const doc = new DropSet(twitchSet({ note: "Nothing listed here." }));
  const out = offerFieldsFromSet(doc);
  assert.equal(out.title, doc.name);
  assert.equal(out.game, "Rust");
  assert.ok(out.description.includes("- 2× Pants (Rust)"));
  assert.ok(!out.description.includes("undefined"));
  assert.deepEqual(out.coverImages, ["/drop-images/a.png", "/drop-images/b.png"]);
  assert.equal(String(out.sourceSet), String(doc._id));
});

test("junk input never throws and still yields a savable draft", () => {
  for (const junk of [null, undefined, 7, "set", {}, { items: "nope", coverImages: {} }]) {
    const out = offerFieldsFromSet(junk);
    assert.equal(out.status, "draft");
    assert.equal(out.title, "Account listing");
    assert.deepEqual(out.coverImages, []);
    assert.equal(out.sourceSet, null);
  }
});
