// Pure-function coverage for the unclaimed-farms auto-lister — no docker, no
// Mongo, no network:
//   1. sellable-drops parsing for BOTH farms (100% + unclaimed only).
//   2. plainPassword (secretBox + legacy "plain:" rows).
//   3. listing copy (title/description never leak, always carry claim steps).
// See utils/unclaimedAutoList.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  sellableDropsFromNoClaimInv,
  sellableDropsFromWebbotInv,
  plainPassword,
  listingTitle,
  listingDescription,
  signatureFor,
} = require("../utils/unclaimedAutoList");

test("no-claim inventory: only 100%-unclaimed drops are sellable", () => {
  const inv = {
    inProgress: [
      { name: "Ready drop", game: "Overwatch", percent: 100, claimed: false },
      { name: "Still farming", game: "Overwatch", percent: 61, claimed: false },
      { name: "Claimed already", game: "Overwatch", percent: 100, claimed: true },
      { name: "Campaign ended", game: "Rainbow Six", percent: 0, claimed: false },
    ],
  };
  const out = sellableDropsFromNoClaimInv(inv);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, "Ready drop");
  assert.ok(out[0].itemKey.includes("overwatch"));
});

test("no-claim inventory: missing/empty inventory yields no drops", () => {
  assert.deepStrictEqual(sellableDropsFromNoClaimInv(null), []);
  assert.deepStrictEqual(sellableDropsFromNoClaimInv({}), []);
});

test("webbot inventory: only farmedUnclaimed drops are sellable", () => {
  const inv = {
    drops: [
      { name: "Spray", game: "Marvel Rivals", percent: 100, farmedUnclaimed: true },
      { name: "Ticker", game: "Marvel Rivals", percent: 40, farmedUnclaimed: false },
      { name: "Done+claimed", game: "Marvel Rivals", percent: 100, farmedUnclaimed: false, claimed: true },
    ],
  };
  const out = sellableDropsFromWebbotInv(inv);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, "Spray");
});

test("plainPassword: decrypts secretBox and strips legacy plain: prefix", () => {
  // A plain (non-encrypted) value is returned as-is.
  assert.strictEqual(plainPassword("hunter2"), "hunter2");
  // Legacy webbot rows carry "plain:" + pass.
  assert.strictEqual(plainPassword("plain:hunter2"), "hunter2");
  assert.strictEqual(plainPassword(""), "");
  assert.strictEqual(plainPassword(null), "");
});

test("listing copy: title is short and description carries the claim steps", () => {
  const title = listingTitle("Overwatch", "acct_1");
  assert.ok(title.includes("Overwatch"));
  assert.ok(title.length <= 120);
  const desc = listingDescription(
    "Overwatch",
    [{ name: "Lootbox", game: "Overwatch" }],
    "acct_1",
  );
  assert.ok(desc.includes("Lootbox"));
  assert.ok(desc.includes("UNCLAIMED"));
  assert.ok(desc.includes("twitch.tv/drops/inventory"));
  assert.ok(desc.includes("acct_1"));
});

test("signatureFor: same game + same drops = same item; order and case agnostic", () => {
  const a = signatureFor("Overwatch", [
    { name: "Crown Jewels Spray", itemKey: "crown jewels spray|overwatch" },
    { name: "Pachimonarch Icon", itemKey: "pachimonarch icon|overwatch" },
  ]);
  const b = signatureFor("overwatch", [
    { name: "Pachimonarch Icon", itemKey: "pachimonarch icon|overwatch" },
    { name: "Crown Jewels Spray", itemKey: "crown jewels spray|overwatch" },
  ]);
  assert.strictEqual(a.key, b.key);
  assert.ok(a.key.startsWith("overwatch|"));
  assert.ok(a.key.includes("crown jewels spray|overwatch"));
  assert.ok(a.key.includes("pachimonarch icon|overwatch"));
});

test("signatureFor: a different drop makes it a different item", () => {
  const withSkip = signatureFor("Overwatch", [
    { name: "Battle Pass Tier Skip", itemKey: "battle pass tier skip|overwatch" },
    { name: "Pachimonarch Icon", itemKey: "pachimonarch icon|overwatch" },
  ]);
  const withoutSkip = signatureFor("Overwatch", [
    { name: "Pachimonarch Icon", itemKey: "pachimonarch icon|overwatch" },
  ]);
  assert.notStrictEqual(withSkip.key, withoutSkip.key);
  assert.strictEqual(signatureFor("", []).key, "|");
});
