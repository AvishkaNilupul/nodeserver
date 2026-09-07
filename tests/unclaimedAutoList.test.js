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
  uniqueDrops,
  dropsFromSet,
  shouldExpire,
  ledgerCampaignsEnded,
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

test("plainPassword: decrypts secretBox and strips legacy plain: prefix", () => {
  // A plain (non-encrypted) value is returned as-is.
  assert.strictEqual(plainPassword("hunter2"), "hunter2");
  // Legacy rows carry "plain:" + pass.
  assert.strictEqual(plainPassword("plain:hunter2"), "hunter2");
  assert.strictEqual(plainPassword(""), "");
  assert.strictEqual(plainPassword(null), "");
});

test("listing copy: title is auto-lister style and description is the house template, per-marketplace", () => {
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
  // The description now reuses the auto-lister's house template: an "Includes:"
  // item list + the connect-and-claim block + a support line that names the
  // marketplace the buyer is actually on.
  const desc = listingDescription("Overwatch", [
    { name: "Lootbox", game: "Overwatch" },
  ], "gameflip");
  assert.ok(desc.includes("Includes:"));
  assert.ok(desc.includes("- Lootbox"));
  assert.ok(/press Connect/i.test(desc));
  assert.ok(desc.includes("message me here on Gameflip"));
  // Per-marketplace support line — never the wrong site's name.
  const ggselDesc = listingDescription("Overwatch", [
    { name: "Lootbox", game: "Overwatch" },
  ], "ggsel");
  assert.ok(ggselDesc.includes("message me here on GGSel"));
  assert.ok(!ggselDesc.includes("message me here on Gameflip"));
  // SECURITY: the public description must never name the account — credentials
  // only travel as the platform auto-delivery code after the order.
  assert.ok(!desc.includes("Account:"));
  assert.ok(!/(^|\s)acct_[0-9a-z]+/i.test(desc));
});

test("listing copy: duplicate drops are COPIES — one qty-aware item in title and description (v3)", () => {
  const drops = [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
  ];
  // Item count = sum of copies; the item is prefixed with its copy count.
  const title = listingTitle("Rainbow Six Siege", drops);
  assert.strictEqual(
    title,
    "Rainbow Six Siege Twitch Drops (4 Items) — 4× Alpha Pack",
  );
  assert.ok(title.length <= 120);
  const desc = listingDescription("Rainbow Six Siege", drops, "gameflip");
  assert.ok(desc.includes("Includes:\n- 4× Alpha Pack"));
  // ONE item line for the four copies (the bundle "Copies:" lead-in, when the
  // bundles module is present, may name the item once more above the list).
  const itemLines = desc.split("\n").filter((l) => l.startsWith("- "));
  assert.deepStrictEqual(itemLines, ["- 4× Alpha Pack"]);
  const includesAt = desc.indexOf("Includes:");
  assert.ok(includesAt >= 0);
  assert.ok(/press Connect/i.test(desc));
  assert.ok(desc.includes("message me here on Gameflip"));
});

test("listing copy: no-event qty title matches the contract form", () => {
  // Contract: "(5 Items) — 4× Alpha Pack + SMELLS LIKE BURNING"
  const drops = [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "SMELLS LIKE BURNING", itemKey: "smells like burning|rainbow six siege" },
  ];
  const title = listingTitle("Rainbow Six Siege", drops);
  assert.strictEqual(
    title,
    "Rainbow Six Siege Twitch Drops (5 Items) — 4× Alpha Pack + SMELLS LIKE BURNING",
  );
  // A classification with no event must not change the no-event form.
  assert.strictEqual(listingTitle("Rainbow Six Siege", drops, null), title);
  assert.strictEqual(
    listingTitle("Rainbow Six Siege", drops, { event: null, waves: [], full: false, bundleKey: "", bundleLabel: "" }),
    title,
  );
  // Drops rebuilt from a stored set carry qty and produce the same title as
  // the raw copies did — a successor publish never loses the "4×".
  const set = {
    coverGame: "Rainbow Six Siege",
    items: [
      { itemKey: "alpha pack|rainbow six siege", name: "Alpha Pack", game: "Rainbow Six Siege", qty: 4 },
      { itemKey: "smells like burning|rainbow six siege", name: "SMELLS LIKE BURNING", game: "Rainbow Six Siege", qty: 1 },
    ],
  };
  assert.strictEqual(listingTitle("Rainbow Six Siege", dropsFromSet(set)), title);
  assert.strictEqual(signatureFor("Rainbow Six Siege", dropsFromSet(set)).key, signatureFor("Rainbow Six Siege", drops).key);
});

test("uniqueDrops: one entry per key with qty, input untouched", () => {
  const drops = [
    { name: "Alpha Pack", itemKey: "alpha pack|r6" },
    { name: "Alpha Pack", itemKey: "Alpha Pack|R6" },
    { name: "Charm", itemKey: "charm|r6" },
    { name: "", itemKey: "" },
  ];
  const out = uniqueDrops(drops);
  assert.deepStrictEqual(
    out.map((d) => [d.itemKey, d.qty]),
    [["alpha pack|r6", 2], ["charm|r6", 1]],
  );
  assert.strictEqual(drops[0].qty, undefined);
  assert.deepStrictEqual(uniqueDrops(null), []);
  assert.deepStrictEqual(uniqueDrops("acct_1"), []);
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

test("signatureFor: copies count — 4× Alpha Pack and 1× Alpha Pack are different items (v3)", () => {
  const one = signatureFor("Rainbow Six Siege", [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
  ]);
  const four = signatureFor("Rainbow Six Siege", [
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
    { name: "Alpha Pack", itemKey: "alpha pack|rainbow six siege" },
  ]);
  assert.notStrictEqual(one.key, four.key);
  // qty-1 keys are undecorated (a pre-v3 signature is unchanged); qty>1 keys
  // are written itemKey×qty.
  assert.deepStrictEqual(one.keys, ["alpha pack|rainbow six siege"]);
  assert.strictEqual(one.key, "rainbow six siege|alpha pack|rainbow six siege");
  assert.deepStrictEqual(four.keys, ["alpha pack|rainbow six siege×4"]);
  assert.strictEqual(four.key, "rainbow six siege|alpha pack|rainbow six siege×4");
  // The $all prefilter still sees plain keys; the exact match sees pairs.
  assert.deepStrictEqual(four.itemKeys, ["alpha pack|rainbow six siege"]);
  assert.deepStrictEqual(four.pairs, [["alpha pack|rainbow six siege", 4]]);
  // Order-agnostic across mixed copies, and a drop carrying qty counts as that
  // many copies (set-derived drops).
  const mixed = signatureFor("R6", [
    { name: "Charm", itemKey: "charm|r6" },
    { name: "Alpha Pack", itemKey: "alpha pack|r6" },
    { name: "Alpha Pack", itemKey: "alpha pack|r6" },
  ]);
  const viaQty = signatureFor("r6", [
    { name: "Alpha Pack", itemKey: "alpha pack|r6", qty: 2 },
    { name: "Charm", itemKey: "charm|r6", qty: 1 },
  ]);
  assert.strictEqual(mixed.key, viaQty.key);
  assert.strictEqual(mixed.key, "r6|alpha pack|r6×2,charm|r6");
});

test("shouldExpire: strikes — one empty read never expires, the confirming read must be 20 min later", () => {
  const T0 = Date.UTC(2026, 8, 5, 18, 29);
  const MIN = 60 * 1000;
  // First empty read: strike 1, firstEmptyAt stamped, no expiry.
  const s1 = shouldExpire({ emptyReads: 0, firstEmptyAt: null }, T0, { confirmPasses: 2 });
  assert.strictEqual(s1.expire, false);
  assert.strictEqual(s1.emptyReads, 1);
  assert.strictEqual(new Date(s1.firstEmptyAt).getTime(), T0);
  // Second empty read only 10 min later: passes reached but the gap is not.
  const s2 = shouldExpire(
    { emptyReads: s1.emptyReads, firstEmptyAt: s1.firstEmptyAt },
    T0 + 10 * MIN,
    { confirmPasses: 2 },
  );
  assert.strictEqual(s2.expire, false);
  assert.strictEqual(s2.emptyReads, 2);
  assert.strictEqual(new Date(s2.firstEmptyAt).getTime(), T0, "firstEmptyAt is kept, not re-stamped");
  // Third empty read at +20 min: confirmed.
  const s3 = shouldExpire(
    { emptyReads: s2.emptyReads, firstEmptyAt: s2.firstEmptyAt },
    T0 + 20 * MIN,
    { confirmPasses: 2 },
  );
  assert.strictEqual(s3.expire, true);
  assert.strictEqual(s3.emptyReads, 3);
  // Two reads 20+ min apart is enough with confirmPasses 2.
  const direct = shouldExpire({ emptyReads: 1, firstEmptyAt: new Date(T0) }, T0 + 25 * MIN, { confirmPasses: 2 });
  assert.strictEqual(direct.expire, true);
  // Higher confirmPasses needs more strikes even after the gap.
  const strict = shouldExpire({ emptyReads: 1, firstEmptyAt: new Date(T0) }, T0 + 60 * MIN, { confirmPasses: 3 });
  assert.strictEqual(strict.expire, false);
  assert.strictEqual(strict.emptyReads, 2);
  // Default confirmPasses is 2 when the option is missing/invalid.
  assert.strictEqual(shouldExpire({ emptyReads: 1, firstEmptyAt: new Date(T0) }, T0 + 25 * MIN, {}).expire, true);
  assert.strictEqual(shouldExpire({ emptyReads: 0 }, T0).expire, false);
});

test("shouldExpire: campaignEnded never shortcuts the strikes (post-event stock is the norm)", () => {
  const T0 = Date.UTC(2026, 8, 5, 18, 29);
  const r = shouldExpire({ emptyReads: 0, firstEmptyAt: null }, T0, { confirmPasses: 2, campaignEnded: true });
  assert.strictEqual(r.expire, false);
  assert.strictEqual(r.emptyReads, 1);
  // Confirmed strikes + gap still expire, and the reason notes the ended campaign.
  const done = shouldExpire({ emptyReads: 1, firstEmptyAt: new Date(T0) }, T0 + 25 * 60 * 1000, {
    confirmPasses: 2,
    campaignEnded: true,
  });
  assert.strictEqual(done.expire, true);
  assert.match(done.reason, /campaign ended/);
  // campaignEnded alone (no empty read) never expires — the non-empty read
  // path wins and resets.
  const live = shouldExpire({ emptyReads: 3, firstEmptyAt: new Date(T0) }, T0, {
    confirmPasses: 2,
    campaignEnded: true,
    empty: false,
  });
  assert.strictEqual(live.expire, false);
  assert.strictEqual(live.emptyReads, 0);
  assert.strictEqual(live.firstEmptyAt, null);
});

test("shouldExpire: a non-empty read resets both strike fields", () => {
  const T0 = Date.UTC(2026, 8, 5, 18, 29);
  const r = shouldExpire({ emptyReads: 2, firstEmptyAt: new Date(T0) }, T0 + 30 * 60 * 1000, {
    confirmPasses: 2,
    empty: false,
  });
  assert.deepStrictEqual(
    { expire: r.expire, emptyReads: r.emptyReads, firstEmptyAt: r.firstEmptyAt },
    { expire: false, emptyReads: 0, firstEmptyAt: null },
  );
  // Garbage stored values are tolerated (NaN emptyReads, invalid date).
  const g = shouldExpire({ emptyReads: "x", firstEmptyAt: "not a date" }, T0, { confirmPasses: 2 });
  assert.strictEqual(g.expire, false);
  assert.strictEqual(g.emptyReads, 1);
  assert.strictEqual(new Date(g.firstEmptyAt).getTime(), T0);
});

test("ledgerCampaignsEnded: every named campaign must be in the ended set", () => {
  const ledger = {
    game: "Overwatch",
    drops: [
      { name: "A", campaign: "CAH Championship Week 1" },
      { name: "B", campaign: "CAH Championship Finals" },
    ],
  };
  const g = "overwatch";
  assert.strictEqual(ledgerCampaignsEnded(ledger, new Set([g + "|cah championship week 1"])), false);
  assert.strictEqual(
    ledgerCampaignsEnded(
      ledger,
      new Set([g + "|cah championship week 1", g + "|cah championship finals"]),
    ),
    true,
  );
  // No campaign names on the drops → never "ended" (conservative).
  assert.strictEqual(ledgerCampaignsEnded({ game: "Overwatch", drops: [{ name: "A" }] }, new Set(["overwatch|x"])), false);
  assert.strictEqual(ledgerCampaignsEnded(ledger, new Set()), false);
  assert.strictEqual(ledgerCampaignsEnded(null, new Set(["overwatch|x"])), false);
});

test("dedupeSetItems: duplicate drops collapse to one item per key WITH qty", () => {
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
  assert.strictEqual(items[0].qty, 4);
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

test("manualSoldKey: owner key for a no-claim pool row (p:)", () => {
  assert.strictEqual(
    manualSoldKey({ source: "noclaim", poolAccountId: "abc123" }),
    "p:abc123",
  );
  // No owner ref or unknown source => no key (never treated as marked).
  assert.strictEqual(manualSoldKey({ source: "noclaim" }), "");
  assert.strictEqual(manualSoldKey({ source: "reseller", poolAccountId: "abc" }), "");
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
    { _id: "3", source: "noclaim", poolAccountId: "c" },
    { _id: "4", source: "noclaim", poolAccountId: "d" },
  ];
  const marked = new Set(["p:b", "p:d"]);
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
