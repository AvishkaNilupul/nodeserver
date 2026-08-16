// A renter drop has two identities and the scanner must never write either one
// blank: `benefitId` is the (account, benefitId) upsert key, `itemKey` is what
// /renter/drops and the superadmin renter-drops view $group on. Twitch can send
// a reward with no benefit id AND no drop id (utils/twitchInventory.js's
// buildDrops defaults the NAME but leaves benefitId undefined), which used to
// mean the drop either clobbered an unrelated row or merged into a single
// itemKey:"" bucket. These cover the fallback chains that close both — pure
// derivation only, no DB and no Twitch.
const test = require("node:test");
const assert = require("node:assert");
const { dropIdentity } = require("../utils/renterDropScanner");
const { itemKeyFor } = require("../utils/twitchInventory");

// A drop shaped like buildDrops' output; overrides strip fields Twitch omitted.
function drop(over) {
  return {
    benefitId: "benefit-1",
    dropId: "drop-1",
    name: "Golden Crate",
    game: "Rust",
    itemKey: itemKeyFor("Golden Crate", "Rust"),
    ...over,
  };
}

test("a fully-formed drop keeps its own benefit id and item key", () => {
  const id = dropIdentity(drop());
  assert.equal(id.benefitId, "benefit-1");
  assert.equal(id.itemKey, "golden crate|rust");
});

test("a drop with no benefit id falls back to the drop id", () => {
  assert.equal(dropIdentity(drop({ benefitId: undefined })).benefitId, "drop-1");
  assert.equal(dropIdentity(drop({ benefitId: "" })).benefitId, "drop-1");
});

test("a drop with neither id falls back to the item key", () => {
  const id = dropIdentity(drop({ benefitId: undefined, dropId: undefined }));
  assert.equal(id.benefitId, "golden crate|rust");
});

test("benefitId is never empty, even for a drop with no identity at all", () => {
  // The clobber regression: Mongoose strips an undefined filter value, so an
  // empty benefitId turns { account, benefitId } into { account } and the upsert
  // overwrites whatever drop the account already had.
  for (const d of [
    {},
    { name: "", game: "" },
    { benefitId: "", dropId: "", itemKey: "" },
  ]) {
    const { benefitId } = dropIdentity(d);
    assert.equal(typeof benefitId, "string");
    assert.ok(benefitId.length > 0, "benefitId must never be blank: " + JSON.stringify(d));
  }
});

test("a missing item key is recomputed as the normalised name|game", () => {
  const id = dropIdentity(drop({ itemKey: "", name: "  Golden Crate ", game: "RUST" }));
  assert.equal(id.itemKey, "golden crate|rust");
});

test("the recomputed key matches the shared helper exactly", () => {
  // Parity guard: the renter scanner and utils/dropScanner.js must derive the
  // same key or the same reward would group differently on the two sides.
  const id = dropIdentity(drop({ itemKey: undefined, name: "Weapon Skin", game: "VALORANT" }));
  assert.equal(id.itemKey, itemKeyFor("Weapon Skin", "VALORANT"));
});

test("two different keyless rewards never collapse into one row", () => {
  // The double-count regression: with itemKey:"" both rewards landed in one
  // $group bucket whose count was their sum, and one of them disappeared.
  const a = dropIdentity({ name: "Crate", game: "Rust", count: 2 });
  const b = dropIdentity({ name: "Skin", game: "Rust", count: 3 });
  assert.notEqual(a.itemKey, b.itemKey);
  assert.notEqual(a.benefitId, b.benefitId, "distinct rewards need distinct upsert keys");
});

test("the same reward seen on two scans derives one stable identity", () => {
  // Idempotent upsert: a re-scan must hit the existing row, not insert a second.
  const first = dropIdentity({ name: "Crate", game: "Rust" });
  const second = dropIdentity({ name: "crate ", game: " RUST" });
  assert.equal(first.itemKey, second.itemKey);
  assert.equal(first.benefitId, second.benefitId);
});

test("a real benefit id still wins over both fallbacks", () => {
  // Twitch's own id must stay the key whenever it exists, so rows written before
  // this fix keep matching instead of being re-inserted under a computed key.
  const id = dropIdentity(drop({ itemKey: "", name: "", game: "" }));
  assert.equal(id.benefitId, "benefit-1");
});
