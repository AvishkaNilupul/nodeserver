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
  dedupeSetItems,
  pickListingGroup,
  gameCapKey,
  chooseCapReleases,
  allocateCapKeep,
  manualSoldKey,
  filterManualSoldLedgers,
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

test("webbot inventory: drop image URL is carried into the sellable drop", () => {
  const img = "https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/abc.png";
  const out = sellableDropsFromWebbotInv({
    drops: [
      { name: "Daredevil Costume", game: "Marvel Rivals", percent: 100, farmedUnclaimed: true, imageURL: img },
    ],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].imageURL, img);
  // A drop with no image yields an empty URL (text tile fallback), never junk.
  const none = sellableDropsFromWebbotInv({
    drops: [{ name: "No Art", game: "R6", percent: 100, farmedUnclaimed: true }],
  });
  assert.strictEqual(none[0].imageURL, "");
});

test("plainPassword: decrypts secretBox and strips legacy plain: prefix", () => {
  // A plain (non-encrypted) value is returned as-is.
  assert.strictEqual(plainPassword("hunter2"), "hunter2");
  // Legacy webbot rows carry "plain:" + pass.
  assert.strictEqual(plainPassword("plain:hunter2"), "hunter2");
  assert.strictEqual(plainPassword(""), "");
  assert.strictEqual(plainPassword(null), "");
});

test("listing copy: title is auto-lister style and description carries the claim steps", () => {
  const title = listingTitle("Overwatch", [
    { name: "Pachimonarch Icon" },
    { name: "Battle Pass Tier Skip" },
    { name: "Crown Jewels Spray" },
  ]);
  assert.strictEqual(
    title,
    "Overwatch Twitch Drops (3 Items) — Pachimonarch Icon + Battle Pass Tier Skip +1 more",
  );
  assert.ok(title.length <= 120);
  assert.strictEqual(listingTitle("Overwatch", []), "Overwatch drop account — unclaimed");
  assert.strictEqual(listingTitle("Overwatch", "acct_1"), "Overwatch drop account — unclaimed");
  const desc = listingDescription("Overwatch", [
    { name: "Lootbox", game: "Overwatch" },
  ]);
  assert.ok(desc.includes("Lootbox"));
  assert.ok(desc.includes("UNCLAIMED"));
  assert.ok(desc.includes("twitch.tv/drops/inventory"));
  // SECURITY: the public description must never name the account — credentials
  // only travel as the platform auto-delivery code after the order.
  assert.ok(!desc.includes("Account:"));
  assert.ok(!/(^|\s)acct_[0-9a-z]+/i.test(desc));
});

test("listing copy: duplicate-name drops collapse to one item in the title", () => {
  const drops = [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
  ];
  const title = listingTitle("Rainbow Six Siege", drops);
  assert.strictEqual(
    title,
    "Rainbow Six Siege Twitch Drops (1 Item) — Alpha Pack",
  );
  const desc = listingDescription("Rainbow Six Siege", drops, "acct_1");
  assert.ok(desc.includes("Unclaimed drops (1):\nAlpha Pack"));
  assert.strictEqual(desc.match(/Alpha Pack/g).length, 1);
});

test("cap key normalises game labels: Overwatch and overwatch are one game", () => {
  assert.strictEqual(gameCapKey("Overwatch"), gameCapKey("overwatch"));
  assert.strictEqual(
    gameCapKey("Tom Clancy's Rainbow Six Siege"),
    "tom clancy s rainbow six siege",
  );
  assert.strictEqual(gameCapKey("Call of Duty: Black Ops 7"), "call of duty black ops 7");
  assert.strictEqual(gameCapKey(""), "");
  assert.strictEqual(gameCapKey(null), "");
  assert.strictEqual(gameCapKey("   "), "");
});

test("cap trim keeps live units and the oldest listed, releases the newest", () => {
  const ledgers = [
    { loginLower: "a", listedAt: new Date("2026-08-01"), market: "gameflip" },
    { loginLower: "b", listedAt: new Date("2026-08-02"), market: "gameflip" },
    { loginLower: "c", listedAt: new Date("2026-08-03"), market: "ggsel" },
    { loginLower: "d", listedAt: new Date("2026-08-04"), market: "digiseller" },
    { loginLower: "e", listedAt: new Date("2026-08-05"), market: "ggsel" },
  ];
  const releases = chooseCapReleases(ledgers, 3, new Set(["b"]));
  assert.ok(releases.has("d"));
  assert.ok(releases.has("e"));
  assert.ok(!releases.has("a"));
  assert.ok(!releases.has("b"));
  assert.ok(!releases.has("c"));
});

test("cap trim releases everything when cap is zero", () => {
  const ledgers = [
    { loginLower: "a", listedAt: new Date("2026-08-01"), market: "gameflip" },
    { loginLower: "b", listedAt: new Date("2026-08-02"), market: "ggsel" },
  ];
  // Live units are never released (they are on sale right now); everything
  // else is, no matter how small the cap.
  const releases = chooseCapReleases(ledgers, 0, new Set(["a"]));
  assert.deepStrictEqual(releases, new Set(["b"]));
  assert.deepStrictEqual(chooseCapReleases([], 10, new Set()), new Set());
});

test("cap trim keeps every set alive with a fair share of the cap", () => {
  const ledgers = [
    { loginLower: "a1", set: "s1", listedAt: new Date("2026-08-01") },
    { loginLower: "a2", set: "s1", listedAt: new Date("2026-08-02") },
    { loginLower: "a3", set: "s1", listedAt: new Date("2026-08-03") },
    { loginLower: "b1", set: "s2", listedAt: new Date("2026-08-01") },
    { loginLower: "b2", set: "s2", listedAt: new Date("2026-08-02") },
    { loginLower: "b3", set: "s2", listedAt: new Date("2026-08-03") },
    { loginLower: "b4", set: "s2", listedAt: new Date("2026-08-04") },
    { loginLower: "c1", set: "s3", listedAt: new Date("2026-08-01") },
    { loginLower: "c2", set: "s3", listedAt: new Date("2026-08-02") },
    { loginLower: "c3", set: "s3", listedAt: new Date("2026-08-03") },
  ];
  // 10 listed, cap 6: s1 keeps ~2, s2 keeps ~2-3, s3 keeps ~1-2; the oldest in
  // each set win. Live unit "b1" is always kept.
  const keep = allocateCapKeep(ledgers, 6, new Set(["b1"]));
  assert.strictEqual(keep.size, 6);
  assert.ok(keep.has("b1"));
  // Every set still has at least one account on sale.
  assert.ok(["a1", "a2", "a3"].some((x) => keep.has(x)));
  assert.ok(["b2", "b3", "b4"].some((x) => keep.has(x)));
  assert.ok(["c1", "c2", "c3"].some((x) => keep.has(x)));
  // Oldest-first inside a set: with one s3 slot, c1 (oldest) wins and the
  // newest (c3) is released.
  assert.ok(keep.has("c1"));
  assert.ok(!keep.has("c3"));
});

test("cap keep with zero slots only keeps live units", () => {
  const ledgers = [
    { loginLower: "a", set: "s1", listedAt: new Date("2026-08-01") },
    { loginLower: "b", set: "s1", listedAt: new Date("2026-08-02") },
  ];
  assert.deepStrictEqual(allocateCapKeep(ledgers, 0, new Set(["a"])), new Set(["a"]));
  assert.deepStrictEqual(allocateCapKeep(ledgers, 0, new Set()), new Set());
});

test("dedupeSetItems: keys are lowercased like signatureFor (case-safe dedupe)", () => {
  const items = dedupeSetItems(
    [
      { name: "Alpha Pack", itemKey: "Alpha Pack|R6" },
      { name: "Alpha Pack", itemKey: "alpha pack|r6" },
      { name: "Charm", itemKey: "Charm|R6" },
    ],
    "R6",
  );
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(
    items.map((i) => i.itemKey),
    ["alpha pack|r6", "charm|r6"],
  );
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

test("dedupeSetItems: duplicate drops collapse to one item per key", () => {
  const drops = [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
  ];
  const items = dedupeSetItems(drops, "Rainbow Six Siege");
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].itemKey, "alpha pack|rainbow six siege");
  assert.strictEqual(items[0].name, "Alpha Pack");
  assert.strictEqual(items[0].game, "Rainbow Six Siege");
  // Keeps distinct items; a drop without an itemKey is keyed by name (same
  // fallback as signatureFor), and a drop with neither is dropped.
  const mixed = dedupeSetItems(
    [
      { name: "Alpha Pack", itemKey: "alpha pack|r6" },
      { name: "Charm", itemKey: "charm|r6" },
      { name: "No key drop", itemKey: "" },
      { name: "", itemKey: "" },
    ],
    "R6",
  );
  assert.strictEqual(mixed.length, 3);
  assert.deepStrictEqual(
    mixed.map((i) => i.name),
    ["Alpha Pack", "Charm", "No key drop"],
  );
});

test("manualSoldKey: owner key per source (p: pool / w: webbot)", () => {
  assert.strictEqual(
    manualSoldKey({ source: "noclaim", poolAccountId: "abc123" }),
    "p:abc123",
  );
  assert.strictEqual(
    manualSoldKey({ source: "webbot", webBotAccountId: "xyz789" }),
    "w:xyz789",
  );
  // No owner ref or unknown source => no key (never treated as marked).
  assert.strictEqual(manualSoldKey({ source: "noclaim" }), "");
  assert.strictEqual(manualSoldKey({ source: "webbot", poolAccountId: "abc" }), "");
  assert.strictEqual(manualSoldKey(null), "");
});

test("pickListingGroup: one listing = one game — the account's configured game wins", () => {
  const sellable = [
    { name: "Alpha Pack", game: "Rainbow Six Siege" },
    { name: "Armament Voucher", game: "Delta Force" },
    { name: "Ammo Selection Pack Lv.4", game: "Delta Force" },
  ];
  const { game, drops } = pickListingGroup("Rainbow Six Siege", sellable);
  assert.strictEqual(game, "Rainbow Six Siege");
  assert.deepStrictEqual(
    drops.map((d) => d.name),
    ["Alpha Pack"],
  );
});

test("pickListingGroup: configured game has no drops -> largest group wins", () => {
  const sellable = [
    { name: "Get Tactical Emblem", game: "Call of Duty: Modern Warfare 4" },
    { name: "Clearing House CC", game: "Call of Duty: Modern Warfare 4" },
    { name: "Alpha Pack", game: "Rainbow Six Siege" },
  ];
  // The bot was configured for Black Ops 7, but every drop is MW4 — the
  // listing must be labeled by the drops' real game, not the config.
  const { game, drops } = pickListingGroup("Call of Duty: Black Ops 7", sellable);
  assert.strictEqual(game, "Call of Duty: Modern Warfare 4");
  assert.strictEqual(drops.length, 2);
  assert.ok(drops.every((d) => d.game === "Call of Duty: Modern Warfare 4"));
});

test("pickListingGroup: game labels are normalized before comparing", () => {
  const sellable = [
    { name: "Alpha Pack", game: "rainbow six siege" },
    { name: "Charm", game: "Delta Force" },
  ];
  const { game, drops } = pickListingGroup("Rainbow Six Siege", sellable);
  assert.strictEqual(drops.length, 1);
  assert.strictEqual(drops[0].name, "Alpha Pack");
});

test("pickListingGroup: unlabeled drops fall back to the configured game", () => {
  const sellable = [
    { name: "Mystery Drop", game: "" },
    { name: "Other Drop", game: "" },
  ];
  const { game, drops } = pickListingGroup("Overwatch", sellable);
  assert.strictEqual(game, "Overwatch");
  assert.strictEqual(drops.length, 2);
  // Empty input / no drops => no crash, same game back.
  assert.deepStrictEqual(pickListingGroup("Overwatch", []), { game: "Overwatch", drops: [] });
  assert.deepStrictEqual(pickListingGroup("", []), { game: "", drops: [] });
});

test("filterManualSoldLedgers: drops ledgers whose owner is manual-sold", () => {
  const ledgers = [
    { _id: "1", source: "noclaim", poolAccountId: "a" },
    { _id: "2", source: "noclaim", poolAccountId: "b" },
    { _id: "3", source: "webbot", webBotAccountId: "w1" },
    { _id: "4", source: "webbot", webBotAccountId: "w2" },
  ];
  const marked = new Set(["p:b", "w:w2"]);
  const kept = filterManualSoldLedgers(ledgers, marked);
  assert.deepStrictEqual(
    kept.map((l) => l._id),
    ["1", "3"],
  );
  // Empty / null marked set keeps everything; null ledgers yields [].
  assert.strictEqual(filterManualSoldLedgers(ledgers, null).length, 4);
  assert.strictEqual(filterManualSoldLedgers(ledgers, new Set()).length, 4);
  assert.deepStrictEqual(filterManualSoldLedgers(null, marked), []);
});
