// Pure-function coverage for utils/unclaimedBundles.js — no Mongo, no network.
// Contract: docs/UNCLAIMED-BUNDLES-CONTRACT.md ("Tests" + the frozen API).
const test = require("node:test");
const assert = require("node:assert/strict");

const { splitEventWave } = require("../utils/radarEvents");
const {
  parseWave,
  eventKeyFor,
  buildEventCatalog,
  classifyHoldings,
  bundleTitle,
  bundleDescriptionLines,
  bundlePrice,
  lotPrice,
} = require("../utils/unclaimedBundles");

const PRICING = {
  floorUsd: 0.75,
  gameFloors: {},
  itemStepPct: 15,
  itemCapMult: 2.5,
  fullEventBonusPct: 25,
  repriceExisting: false,
  repriceDriftPct: 20,
  lots: false,
  lotSize: 5,
  lotDiscountPct: 10,
  expiryConfirmPasses: 2,
};

/* ------------------------------ parseWave ------------------------------- */

test("parseWave is a strict superset of radarEvents.splitEventWave", () => {
  const cases = [
    "KORD BREACH S1 Day 1",
    "KORD BREACH S1 (Wave II)",
    "Season 4 Launch",
    "KORD BREACH S1",
    "KORD BREACH S1 Drops",
    "S4 Heroes of Busan Launch Week 1",
    "S4 Heroes of Busan Launch - Week 2",
    "S&F Drops",
    "Launch Party Week 2",
    "Done",
    "",
  ];
  for (const name of cases) {
    const radar = splitEventWave(name);
    const ours = parseWave(name);
    assert.equal(ours.eventName, radar.eventName, name);
    assert.equal(ours.waveLabel, radar.waveLabel, name);
  }
  assert.deepEqual(parseWave("KORD BREACH S1 (Wave II)"), {
    eventName: "KORD BREACH S1",
    waveLabel: "Wave II",
    order: 2,
  });
  assert.deepEqual(parseWave("Season 4 Launch"), {
    eventName: "Season 4 Launch",
    waveLabel: "",
    order: 0,
  });
});

test("parseWave handles every real campaign form from the contract", () => {
  // Overwatch
  assert.deepEqual(parseWave("CAH Championship Week 1"), {
    eventName: "CAH Championship",
    waveLabel: "Week 1",
    order: 1,
  });
  assert.deepEqual(parseWave("CAH Championship Finals"), {
    eventName: "CAH Championship",
    waveLabel: "Finals",
    order: 1000,
  });
  assert.deepEqual(parseWave("OWWC 2026 Groups Day 1 &2"), {
    eventName: "OWWC 2026 Groups",
    waveLabel: "Day 1-2",
    order: 1,
  });
  assert.deepEqual(parseWave("OWWC 2026 Groups Day 3"), {
    eventName: "OWWC 2026 Groups",
    waveLabel: "Day 3",
    order: 3,
  });
  assert.deepEqual(parseWave("OWCS MSC Day 5"), {
    eventName: "OWCS MSC",
    waveLabel: "Day 5",
    order: 5,
  });
  // Rainbow Six
  assert.deepEqual(parseWave("EWC 2026 DAY 10"), {
    eventName: "EWC 2026",
    waveLabel: "DAY 10",
    order: 10,
  });
  assert.deepEqual(parseWave("R6S S1 2026 9"), {
    eventName: "R6S S1 2026",
    waveLabel: "Wave 9",
    order: 9,
  });
  assert.deepEqual(parseWave("R6S S1 2026 13"), {
    eventName: "R6S S1 2026",
    waveLabel: "Wave 13",
    order: 13,
  });
  assert.deepEqual(parseWave("R6S S2 2026"), {
    eventName: "R6S S2 2026",
    waveLabel: "",
    order: 0,
  });
  assert.deepEqual(parseWave("R6S S2 2026 1"), {
    eventName: "R6S S2 2026",
    waveLabel: "Wave 1",
    order: 1,
  });
  // Call of Duty
  assert.deepEqual(parseWave("Modern Warfare 4 Beta W1"), {
    eventName: "Modern Warfare 4 Beta",
    waveLabel: "W1",
    order: 1,
  });
  assert.deepEqual(parseWave("Modern Warfare 4 Beta W2"), {
    eventName: "Modern Warfare 4 Beta",
    waveLabel: "W2",
    order: 2,
  });
  assert.deepEqual(parseWave("CDL Championship - Day 4"), {
    eventName: "CDL Championship",
    waveLabel: "Day 4",
    order: 4,
  });
  assert.deepEqual(parseWave("Monster Last Chance PT. 1"), {
    eventName: "Monster Last Chance",
    waveLabel: "PT. 1",
    order: 1,
  });
  // Finals family
  assert.equal(parseWave("Some Cup Grand Finals").waveLabel, "Grand Finals");
  assert.equal(parseWave("Some Cup Grand Finals").order, 1000);
  assert.equal(parseWave("Some Cup Playoffs").order, 1000);
  assert.equal(parseWave("Some Cup Final").eventName, "Some Cup");
  // Guards: never split a bare word that merely ends in a marker, never read a
  // year as a wave, never leave an empty event name.
  assert.deepEqual(parseWave("Holiday 1"), { eventName: "Holiday 1", waveLabel: "", order: 0 });
  assert.equal(parseWave("R6S S1 2026").waveLabel, "");
  assert.equal(parseWave("Finals").waveLabel, "");
  assert.equal(parseWave("Week 1").waveLabel, "");
});

test("eventKeyFor normalises the game and lowercases the event", () => {
  assert.equal(
    eventKeyFor("Tom Clancy's Rainbow Six Siege", "EWC 2026"),
    "tom clancy s rainbow six siege|ewc 2026",
  );
  assert.equal(eventKeyFor("Overwatch 2", "CAH Championship"), "overwatch 2|cah championship");
});

/* ---------------------------- buildEventCatalog ------------------------- */

const R6 = "Tom Clancy's Rainbow Six Siege";
const OW = "Overwatch 2";
const ALPHA = "alpha pack|" + R6.toLowerCase();
const BURN = "smells like burning|" + R6.toLowerCase();
const ICON = "pachimonarch icon|" + OW.toLowerCase();
const SKIP = "battle pass tier skip|" + OW.toLowerCase();
const SPRAY = "finals spray|" + OW.toLowerCase();

function fixtures() {
  const campaigns = [
    {
      campaignId: "ow-finals",
      name: "CAH Championship Finals",
      game: OW,
      startAt: "2026-08-20T00:00:00Z",
      endAt: "2026-08-24T00:00:00Z",
    },
    {
      campaignId: "ow-w1",
      name: "CAH Championship Week 1",
      game: OW,
      startAt: "2026-08-10T00:00:00Z",
      endAt: "2026-08-14T00:00:00Z",
    },
    {
      campaignId: "r6-cc",
      name: "Community Checkpoint",
      game: R6,
      startAt: "2026-08-01T00:00:00Z",
      endAt: "2026-08-05T00:00:00Z",
    },
    // no manifest for this one
    {
      campaignId: "r6-ewc-1",
      name: "EWC 2026 DAY 1",
      game: R6,
      startAt: "2026-08-15T00:00:00Z",
      endAt: "2026-08-16T00:00:00Z",
    },
  ];
  const manifests = [
    {
      campaignId: "ow-w1",
      name: "CAH Championship Week 1",
      game: OW,
      drops: [
        { itemKey: ICON, name: "Pachimonarch Icon" },
        { itemKey: SKIP, name: "Battle Pass Tier Skip" },
      ],
    },
    {
      campaignId: "ow-finals",
      name: "CAH Championship Finals",
      game: OW,
      drops: [
        { itemKey: SPRAY, name: "Finals Spray" },
        { itemKey: SKIP, name: "Battle Pass Tier Skip" },
      ],
    },
    {
      campaignId: "r6-cc",
      name: "Community Checkpoint",
      game: R6,
      drops: [
        { itemKey: ALPHA, name: "Alpha Pack" },
        { itemKey: ALPHA, name: "Alpha Pack" },
        { itemKey: ALPHA, name: "Alpha Pack" },
        { itemKey: ALPHA, name: "Alpha Pack" },
        { itemKey: BURN, name: "SMELLS LIKE BURNING" },
      ],
    },
  ];
  return { campaigns, manifests };
}

test("buildEventCatalog groups waves per event, orders them, and counts copies", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  assert.equal(catalog.size, 3);

  const cah = catalog.get(eventKeyFor(OW, "CAH Championship"));
  assert.ok(cah);
  assert.equal(cah.name, "CAH Championship");
  assert.equal(cah.gameKey, "overwatch 2");
  assert.deepEqual(
    cah.waves.map((w) => [w.waveLabel, w.order, w.campaignId]),
    [
      ["Week 1", 1, "ow-w1"],
      ["Finals", 1000, "ow-finals"],
    ],
  );
  assert.equal(cah.startAt, "2026-08-10T00:00:00Z");
  assert.equal(cah.endAt, "2026-08-24T00:00:00Z");

  const cc = catalog.get(eventKeyFor(R6, "Community Checkpoint"));
  assert.equal(cc.waves.length, 1);
  const alpha = cc.waves[0].items.find((i) => i.itemKey === ALPHA);
  assert.equal(alpha.qty, 4);
  assert.equal(cc.waves[0].items.length, 2);

  const ewc = catalog.get(eventKeyFor(R6, "EWC 2026"));
  assert.equal(ewc.waves[0].waveLabel, "DAY 1");
  assert.deepEqual(ewc.waves[0].items, []);
});

test("buildEventCatalog sorts by order then startAt and folds a Drops alias", () => {
  const catalog = buildEventCatalog(
    [
      { campaignId: "b", name: "KORD BREACH S1 Day 2", game: "Tarkov", startAt: "2026-08-12T00:00:00Z" },
      { campaignId: "a", name: "KORD BREACH S1 Day 1", game: "Tarkov", startAt: "2026-08-11T00:00:00Z" },
      { campaignId: "c", name: "KORD BREACH S1 Drops", game: "Tarkov", startAt: "2026-08-11T00:00:00Z" },
    ],
    [],
  );
  assert.equal(catalog.size, 1);
  const [event] = [...catalog.values()];
  assert.deepEqual(
    event.waves.map((w) => w.campaignId),
    ["c", "a", "b"],
  );
});

/* ----------------------------- classifyHoldings ------------------------- */

const NOW = new Date("2026-09-01T00:00:00Z").getTime();

test("classifyHoldings: full event bundle across two waves", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Pachimonarch Icon", game: OW, campaign: "CAH Championship Week 1", itemKey: ICON },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Week 1", itemKey: SKIP },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Finals", itemKey: SKIP },
    { name: "Finals Spray", game: OW, campaign: "CAH Championship Finals", itemKey: SPRAY },
  ];
  const cls = classifyHoldings(OW, drops, catalog, NOW);
  assert.deepEqual(cls.event, { key: eventKeyFor(OW, "CAH Championship"), name: "CAH Championship" });
  assert.equal(cls.full, true);
  assert.equal(cls.wavesHeld, 2);
  assert.equal(cls.wavesTotal, 2);
  assert.deepEqual(
    cls.waves.map((w) => [w.waveLabel, w.complete, w.missing]),
    [
      ["Week 1", true, []],
      ["Finals", true, []],
    ],
  );
  // Duplicates ARE copies: the tier skip from both waves is qty 2.
  assert.deepEqual(
    cls.items.map((i) => [i.name, i.qty]),
    [
      ["Battle Pass Tier Skip", 2],
      ["Finals Spray", 1],
      ["Pachimonarch Icon", 1],
    ],
  );
  assert.equal(cls.bundleKey, eventKeyFor(OW, "CAH Championship") + "|week 1+finals");
  assert.equal(cls.bundleLabel, "CAH Championship — Week 1 + Finals (complete)");
});

test("classifyHoldings: partial when a started wave is missing", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Pachimonarch Icon", game: OW, campaign: "CAH Championship Week 1", itemKey: ICON },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Week 1", itemKey: SKIP },
  ];
  const cls = classifyHoldings(OW, drops, catalog, NOW);
  assert.equal(cls.full, false);
  assert.equal(cls.wavesHeld, 1);
  assert.equal(cls.wavesTotal, 2);
  assert.equal(cls.bundleLabel, "CAH Championship — Week 1 (partial)");
  assert.equal(cls.bundleKey, eventKeyFor(OW, "CAH Championship") + "|week 1");
  const finals = cls.waves.find((w) => w.waveLabel === "Finals");
  assert.equal(finals.complete, false);
  assert.deepEqual(finals.held, []);
  assert.deepEqual(finals.missing.sort(), [SPRAY, SKIP].sort());
});

test("classifyHoldings: a wave that has not started does not block full", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const duringWeek1 = new Date("2026-08-12T00:00:00Z").getTime();
  const drops = [
    { name: "Pachimonarch Icon", game: OW, campaign: "CAH Championship Week 1", itemKey: ICON },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Week 1", itemKey: SKIP },
  ];
  const cls = classifyHoldings(OW, drops, catalog, duringWeek1);
  assert.equal(cls.wavesTotal, 1);
  assert.equal(cls.full, true);
  assert.equal(cls.bundleLabel, "CAH Championship — Week 1 (complete)");
});

test("classifyHoldings: no event resolves → empty bundle, qty-aware items", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Mystery Skin", game: OW, campaign: "Unknown Promo", itemKey: "mystery skin|overwatch 2" },
    { name: "Mystery Skin", game: OW, campaign: "Unknown Promo", itemKey: "mystery skin|overwatch 2" },
  ];
  const cls = classifyHoldings(OW, drops, catalog, NOW);
  assert.equal(cls.event, null);
  assert.equal(cls.full, false);
  assert.equal(cls.bundleKey, "");
  assert.equal(cls.bundleLabel, "");
  assert.deepEqual(cls.items, [{ itemKey: "mystery skin|overwatch 2", name: "Mystery Skin", qty: 2 }]);
  // Empty catalog / empty drops are safe too.
  assert.equal(classifyHoldings(OW, drops, new Map(), NOW).event, null);
  assert.deepEqual(classifyHoldings(OW, [], catalog, NOW).items, []);
});

test("classifyHoldings: itemKey fallback when the campaign name is unknown", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Alpha Pack", game: R6, campaign: "", itemKey: ALPHA },
    { name: "Alpha Pack", game: R6, campaign: "", itemKey: ALPHA },
    { name: "Alpha Pack", game: R6, campaign: "renamed later", itemKey: ALPHA },
    { name: "Alpha Pack", game: R6, campaign: "renamed later", itemKey: ALPHA },
    { name: "SMELLS LIKE BURNING", game: R6, campaign: "renamed later", itemKey: BURN },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  assert.equal(cls.event.name, "Community Checkpoint");
  assert.equal(cls.full, true);
  assert.equal(cls.items.find((i) => i.itemKey === ALPHA).qty, 4);
  assert.equal(cls.bundleLabel, "Community Checkpoint (complete)");
  assert.equal(cls.bundleKey, eventKeyFor(R6, "Community Checkpoint") + "|");
});

test("classifyHoldings: fewer copies than the manifest grants is not complete", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Alpha Pack", game: R6, campaign: "Community Checkpoint", itemKey: ALPHA },
    { name: "SMELLS LIKE BURNING", game: R6, campaign: "Community Checkpoint", itemKey: BURN },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  assert.equal(cls.full, false);
  assert.deepEqual(cls.waves[0].held.sort(), [ALPHA, BURN].sort());
  assert.deepEqual(cls.waves[0].missing, [ALPHA]);
});

test("classifyHoldings: a wave with no manifest is complete once anything is held", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "EWC Charm", game: R6, campaign: "EWC 2026 DAY 1", itemKey: "ewc charm|" + R6.toLowerCase() },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  assert.equal(cls.event.name, "EWC 2026");
  assert.equal(cls.full, true);
  assert.equal(cls.bundleLabel, "EWC 2026 — DAY 1 (complete)");
});

test("classifyHoldings: an unmarked base wave beside a numbered one is 'Main'", () => {
  const catalog = buildEventCatalog(
    [
      { campaignId: "s2", name: "R6S S2 2026", game: R6, startAt: "2026-08-01T00:00:00Z" },
      { campaignId: "s2-1", name: "R6S S2 2026 1", game: R6, startAt: "2026-08-08T00:00:00Z" },
    ],
    [],
  );
  const drops = [
    { name: "S2 Charm", game: R6, campaign: "R6S S2 2026", itemKey: "s2 charm|x" },
    { name: "S2 Skin", game: R6, campaign: "R6S S2 2026 1", itemKey: "s2 skin|x" },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  assert.equal(cls.bundleLabel, "R6S S2 2026 — Main + Wave 1 (complete)");
  assert.equal(cls.bundleKey, eventKeyFor(R6, "R6S S2 2026") + "|main+wave 1");
  // Single event → events lists just the primary, complete matches full.
  assert.deepEqual(cls.events, [{ key: eventKeyFor(R6, "R6S S2 2026"), name: "R6S S2 2026", complete: true }]);
});

// Live dry-run 2026-09-06: an account held one item from "R6S Y11S3" and one
// from "R6S S2 2026 1" and was titled "R6S Y11S3 COMPLETE BUNDLE (2 Items)".
const Y11 = "y11s3 charm|" + R6.toLowerCase();
const Y11B = "y11s3 banner|" + R6.toLowerCase();
const S2SKIN = "s2 skin|" + R6.toLowerCase();

function twoEventCatalog({ y11Items = [{ itemKey: Y11, name: "Y11S3 Charm" }] } = {}) {
  return buildEventCatalog(
    [
      { campaignId: "y11", name: "R6S Y11S3", game: R6, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-10T00:00:00Z" },
      { campaignId: "s2-1", name: "R6S S2 2026 1", game: R6, startAt: "2026-08-20T00:00:00Z", endAt: "2026-08-27T00:00:00Z" },
    ],
    [
      { campaignId: "y11", name: "R6S Y11S3", game: R6, drops: y11Items },
      { campaignId: "s2-1", name: "R6S S2 2026 1", game: R6, drops: [{ itemKey: S2SKIN, name: "S2 Skin" }] },
    ],
  );
}

test("classifyHoldings: holdings spanning two events — full only when every event is complete", () => {
  const catalog = twoEventCatalog();
  const drops = [
    { name: "Y11S3 Charm", game: R6, campaign: "R6S Y11S3", itemKey: Y11 },
    { name: "S2 Skin", game: R6, campaign: "R6S S2 2026 1", itemKey: S2SKIN },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  // Primary: tie on hits → earliest start.
  assert.deepEqual(cls.event, { key: eventKeyFor(R6, "R6S Y11S3"), name: "R6S Y11S3" });
  assert.deepEqual(cls.events, [
    { key: eventKeyFor(R6, "R6S Y11S3"), name: "R6S Y11S3", complete: true },
    { key: eventKeyFor(R6, "R6S S2 2026"), name: "R6S S2 2026", complete: true },
  ]);
  assert.equal(cls.full, true);
  assert.equal(cls.bundleLabel, "R6S Y11S3 + R6S S2 2026 (complete)");
  // waves/heldLabels/bundleKey still describe the primary event.
  assert.equal(cls.wavesHeld, 1);
  assert.equal(cls.bundleKey, eventKeyFor(R6, "R6S Y11S3") + "|");
  assert.deepEqual(cls.items.map((i) => i.name), ["S2 Skin", "Y11S3 Charm"]);

  const title = bundleTitle({ game: "Rainbow Six Siege", items: cls.items, classification: cls });
  assert.equal(
    title,
    "Rainbow Six Siege Twitch Drops — R6S Y11S3 + R6S S2 2026 COMPLETE BUNDLE (2 Items)",
  );
  assert.deepEqual(
    bundleDescriptionLines({ game: R6, items: cls.items, classification: cls, marketplace: "zeusx" }),
    ["Event: R6S Y11S3 + R6S S2 2026, complete bundle"],
  );
});

test("classifyHoldings: two events with one partial → partial, title makes no event claim", () => {
  const catalog = twoEventCatalog({
    y11Items: [
      { itemKey: Y11, name: "Y11S3 Charm" },
      { itemKey: Y11B, name: "Y11S3 Banner" },
    ],
  });
  const drops = [
    { name: "Y11S3 Charm", game: R6, campaign: "R6S Y11S3", itemKey: Y11 },
    { name: "S2 Skin", game: R6, campaign: "R6S S2 2026 1", itemKey: S2SKIN },
  ];
  const cls = classifyHoldings(R6, drops, catalog, NOW);
  assert.equal(cls.event.name, "R6S Y11S3");
  assert.deepEqual(
    cls.events.map((e) => [e.name, e.complete]),
    [
      ["R6S Y11S3", false],
      ["R6S S2 2026", true],
    ],
  );
  assert.equal(cls.full, false);
  assert.equal(cls.bundleLabel, "R6S Y11S3 + R6S S2 2026 (partial)");
  assert.deepEqual(cls.waves[0].missing, [Y11B]);

  assert.equal(
    bundleTitle({ game: "Rainbow Six Siege", items: cls.items, classification: cls }),
    "Rainbow Six Siege Twitch Drops (2 Items) — S2 Skin + Y11S3 Charm",
  );
  assert.deepEqual(
    bundleDescriptionLines({ game: R6, items: cls.items, classification: cls, marketplace: "gameflip" }),
    ["Event: R6S Y11S3 + R6S S2 2026, partial bundle"],
  );
});

/* ------------------------------ bundleTitle ----------------------------- */

test("bundleTitle: full bundle names the event and its waves", () => {
  const { campaigns, manifests } = fixtures();
  const catalog = buildEventCatalog(campaigns, manifests);
  const drops = [
    { name: "Pachimonarch Icon", game: OW, campaign: "CAH Championship Week 1", itemKey: ICON },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Week 1", itemKey: SKIP },
    { name: "Battle Pass Tier Skip", game: OW, campaign: "CAH Championship Finals", itemKey: SKIP },
    { name: "Finals Spray", game: OW, campaign: "CAH Championship Finals", itemKey: SPRAY },
  ];
  // classifyHoldings is given "Overwatch" while the catalog game is
  // "Overwatch 2" — the same substring tolerance isNoClaimGame has.
  const cls = classifyHoldings("Overwatch", drops, catalog, NOW);
  assert.equal(cls.full, true);
  const title = bundleTitle({ game: "Overwatch", items: cls.items, classification: cls });
  assert.equal(
    title,
    "Overwatch Twitch Drops — CAH Championship COMPLETE BUNDLE (Week 1 + Finals · 4 Items)",
  );
  assert.ok(title.length <= 120);
});

test("bundleTitle: partial bundle carries the wave, qty prefix and +N more", () => {
  const cls = {
    game: OW,
    event: { key: "k", name: "CAH Championship" },
    full: false,
    heldLabels: ["Week 1"],
    bundleLabel: "CAH Championship — Week 1 (partial)",
    items: [],
  };
  const items = [
    { itemKey: ICON, name: "Pachimonarch Icon", qty: 1 },
    { itemKey: SKIP, name: "Battle Pass Tier Skip", qty: 2 },
    { itemKey: SPRAY, name: "Finals Spray", qty: 1 },
  ];
  assert.equal(
    bundleTitle({ game: "Overwatch", items, classification: cls }),
    "Overwatch Twitch Drops — CAH Championship Week 1 (4 Items) — Pachimonarch Icon + 2× Battle Pass Tier Skip +1 more",
  );
});

test("bundleTitle: no event → house style, qty-aware count and prefix", () => {
  const items = [
    { itemKey: ALPHA, name: "Alpha Pack", qty: 4 },
    { itemKey: BURN, name: "SMELLS LIKE BURNING", qty: 1 },
  ];
  assert.equal(
    bundleTitle({ game: "Rainbow Six Siege", items, classification: null }),
    "Rainbow Six Siege Twitch Drops (5 Items) — 4× Alpha Pack + SMELLS LIKE BURNING",
  );
  assert.equal(
    bundleTitle({ game: "Overwatch", items: [{ name: "Spray", qty: 1 }] }),
    "Overwatch Twitch Drops (1 Item) — Spray",
  );
});

test("bundleTitle: a one-item bundle reads '(1 Item)' in every title form", () => {
  const one = [{ itemKey: "charm|x", name: "Charm", qty: 1 }];
  const event = { key: "k", name: "R6S Y11S3" };
  // full, no wave labels (the live dry-run case: "R6S Y11S3 COMPLETE BUNDLE (1 Items)")
  assert.equal(
    bundleTitle({ game: "Rainbow Six Siege", items: one, classification: { event, full: true, heldLabels: [] } }),
    "Rainbow Six Siege Twitch Drops — R6S Y11S3 COMPLETE BUNDLE (1 Item)",
  );
  // full, with a wave label
  assert.equal(
    bundleTitle({ game: "Rainbow Six Siege", items: one, classification: { event, full: true, heldLabels: ["DAY 1"] } }),
    "Rainbow Six Siege Twitch Drops — R6S Y11S3 COMPLETE BUNDLE (DAY 1 · 1 Item)",
  );
  // full, long event name → falls back to the "(1 Item)" form, never "(1 Items)"
  const longEvent = { key: "k", name: "Esports World Cup 2026 Rainbow Six Siege Invitational Championship Series" };
  const long = bundleTitle({
    game: "Tom Clancy's Rainbow Six Siege",
    items: one,
    classification: { event: longEvent, full: true, heldLabels: ["DAY 1", "DAY 2", "DAY 3", "DAY 4", "DAY 5"] },
  });
  assert.ok(long.length <= 120, long);
  assert.ok(long.includes("(1 Item)"), long);
  // partial + multi-event full
  assert.equal(
    bundleTitle({ game: "Rainbow Six Siege", items: one, classification: { event, full: false, heldLabels: ["DAY 1"] } }),
    "Rainbow Six Siege Twitch Drops — R6S Y11S3 DAY 1 (1 Item) — Charm",
  );
  assert.equal(
    bundleTitle({
      game: "Rainbow Six Siege",
      items: one,
      classification: { event, full: true, events: [{ key: "k", name: "R6S Y11S3", complete: true }, { key: "k2", name: "R6S S2 2026", complete: true }] },
    }),
    "Rainbow Six Siege Twitch Drops — R6S Y11S3 + R6S S2 2026 COMPLETE BUNDLE (1 Item)",
  );
  for (const t of [long]) assert.ok(!/\b1 Items\b/.test(t), t);
});

test("bundleTitle never exceeds 120 characters", () => {
  const longName = "An Extraordinarily Long Reward Name That Keeps Going And Going";
  const items = Array.from({ length: 6 }, (_, i) => ({
    itemKey: "k" + i,
    name: longName + " " + i,
    qty: 3,
  }));
  const noEvent = bundleTitle({ game: "Tom Clancy's Rainbow Six Siege", items });
  assert.ok(noEvent.length <= 120, noEvent);
  assert.ok(noEvent.includes("(18 Items)"));
  const partial = bundleTitle({
    game: "Tom Clancy's Rainbow Six Siege",
    items,
    classification: {
      event: { key: "k", name: "Esports World Cup 2026 Rainbow Six Siege Invitational" },
      full: false,
      heldLabels: ["DAY 1", "DAY 2", "DAY 3", "DAY 4", "DAY 5", "DAY 6", "DAY 7"],
    },
  });
  assert.ok(partial.length <= 120, partial);
  const full = bundleTitle({
    game: "Tom Clancy's Rainbow Six Siege",
    items,
    classification: {
      event: { key: "k", name: "Esports World Cup 2026 Rainbow Six Siege Invitational" },
      full: true,
      heldLabels: ["DAY 1", "DAY 2", "DAY 3", "DAY 4", "DAY 5", "DAY 6", "DAY 7", "DAY 8", "DAY 9", "DAY 10"],
    },
  });
  assert.ok(full.length <= 120, full);
  assert.ok(full.includes("COMPLETE BUNDLE"));
});

/* ------------------------- bundleDescriptionLines ----------------------- */

test("bundleDescriptionLines: event, copies and per-marketplace bulk lines", () => {
  const cls = {
    event: { key: "k", name: "CAH Championship" },
    full: true,
    heldLabels: ["Week 1", "Finals"],
    wavesHeld: 2,
    wavesTotal: 2,
  };
  const items = [
    { name: "Battle Pass Tier Skip", qty: 2 },
    { name: "Finals Spray", qty: 1 },
  ];
  const dg = bundleDescriptionLines({ game: OW, items, classification: cls, marketplace: "digiseller" });
  assert.equal(dg[0], "Event: CAH Championship — Week 1 + Finals, complete bundle");
  assert.ok(dg[1].startsWith("Copies: 2× Battle Pass Tier Skip"));
  assert.equal(dg[2], "Bulk: buy several units in one order — quantity is available on this page.");
  assert.equal(
    bundleDescriptionLines({ items, classification: cls, marketplace: "ggsel" }).at(-1),
    "Bulk: buy several units in one order — quantity is available on this page.",
  );

  const gfLots = bundleDescriptionLines({
    items,
    classification: cls,
    marketplace: "gameflip",
    lotsEnabled: true,
    lotSize: 5,
  });
  assert.equal(gfLots.at(-1), "Bulk: lots of 5 accounts are listed separately at a discount.");
  const gfNoLots = bundleDescriptionLines({ items, classification: cls, marketplace: "gameflip" });
  assert.ok(!gfNoLots.some((l) => l.startsWith("Bulk:")));

  const partial = bundleDescriptionLines({
    items: [{ name: "Spray", qty: 1 }],
    classification: { event: { key: "k", name: "EWC 2026" }, full: false, heldLabels: ["DAY 1"], wavesHeld: 1, wavesTotal: 3 },
    marketplace: "zeusx",
  });
  assert.deepEqual(partial, ["Event: EWC 2026 — DAY 1, partial bundle (1 of 3 waves)"]);

  assert.deepEqual(bundleDescriptionLines({ items: [{ name: "Spray", qty: 1 }], classification: null, marketplace: "gameflip" }), []);
});

/* ------------------------------ bundlePrice ----------------------------- */

function research(gameflip, extra = {}) {
  return { markets: { gameflip, ...extra } };
}
const ONE = [{ name: "Spray", qty: 1 }];

test("bundlePrice: anchor selection order", () => {
  const sold = bundlePrice({
    research: research({ soldRecent: 5, avgSoldPrice: 2.35, lowestOther: 1.2, median: 3, lowest: 0.75 }),
    game: OW,
    items: ONE,
    pricing: PRICING,
  });
  assert.equal(sold.anchorSource, "gameflip.avgSoldPrice");
  assert.equal(sold.anchor, 2.35);
  assert.equal(sold.price, 2.25);

  // The anchor cap came DOWN from $10 to $2.50 on 2026-09-08, and a separate
  // $4.50 ceiling was added over the final price. $10 was set from what rivals
  // ask; $2.50 sits just above every median we are actually PAID (gameflip
  // $1.25, digiseller $1.28, ggsel $0.75). The old cap let a $8.08 anchor —
  // averaged over rival "SI 2026 Bundle CODE" rows, a different product
  // entirely — become a live $11.75 listing.
  const capped = bundlePrice({
    research: research({ soldRecent: 3, avgSoldPrice: 40 }),
    game: OW,
    items: ONE,
    pricing: PRICING,
  });
  assert.equal(capped.anchor, 2.5);
  assert.equal(capped.price, 2.5);
  assert.equal(capped.ceilingHit, false, "the anchor cap bound first, not the ceiling");

  const other = bundlePrice({
    research: research({ soldRecent: 2, avgSoldPrice: 9, lowestOther: 1.9, median: 3 }),
    game: OW,
    items: ONE,
    pricing: PRICING,
  });
  assert.equal(other.anchorSource, "gameflip.lowestOther");
  assert.equal(other.price, 2);

  const median = bundlePrice({
    research: research({ soldRecent: 0, lowestOther: 0, median: 3.1 }),
    game: OW,
    items: ONE,
    pricing: PRICING,
  });
  assert.equal(median.anchorSource, "gameflip.median");
  // $3.10 is above the $2.50 anchor cap, so it is capped before the multiplier.
  assert.equal(median.anchor, 2.5);
  assert.equal(median.price, 2.5);

  const ru = bundlePrice({
    research: research({}, { ggsel: { median: 1.6 }, plati: { median: 1.3 } }),
    game: OW,
    items: ONE,
    pricing: PRICING,
  });
  assert.equal(ru.anchorSource, "plati.median");
  assert.equal(ru.anchor, 1.3);
  assert.equal(ru.price, 1.25);

  const none = bundlePrice({ research: null, game: OW, items: ONE, pricing: PRICING });
  assert.equal(none.anchorSource, "default");
  assert.equal(none.anchor, 1);
  assert.equal(none.price, 1);
});

test("bundlePrice: per-item step, cap, full-event bonus and rounding", () => {
  const r = research({ soldRecent: 5, avgSoldPrice: 2 });
  // 3 items → 2 * (1 + 0.15*2) = 2.6 → 2.5
  const three = bundlePrice({
    research: r,
    game: OW,
    items: [{ name: "a", qty: 1 }, { name: "b", qty: 2 }],
    pricing: PRICING,
  });
  assert.equal(three.totalQty, 3);
  assert.equal(three.price, 2.5);
  // 20 items → multiplier 1 + 0.15*19 = 3.85, capped at 2.5 → 5.00, and then
  // clamped to the $4.50 ceiling. Nothing has ever sold above $4.50 here, and
  // the measured evidence is that big bundles sell for LESS than small ones
  // (ggsel: <=5 items median $0.75, >=10 items $0.595), so a 20-item bundle is
  // the last thing that should be carrying the top price in the shop.
  const many = bundlePrice({
    research: r,
    game: OW,
    items: [{ name: "a", qty: 20 }],
    pricing: PRICING,
  });
  assert.equal(many.price, 4.5);
  assert.equal(many.ceilingHit, true);
  // full bundle: 3 items 2.6 * 1.25 = 3.25
  const full = bundlePrice({
    research: r,
    game: OW,
    items: [{ name: "a", qty: 1 }, { name: "b", qty: 2 }],
    classification: { full: true, items: [] },
    pricing: PRICING,
  });
  assert.equal(full.full, true);
  assert.equal(full.price, 3.25);
  // items omitted → classification.items are used
  const fromCls = bundlePrice({
    research: r,
    game: OW,
    classification: { full: false, items: [{ name: "a", qty: 2 }] },
    pricing: PRICING,
  });
  assert.equal(fromCls.totalQty, 2);
  assert.equal(fromCls.price, 2.25);
});

test("bundlePrice: global and per-game floors, never below floor", () => {
  const low = research({ soldRecent: 5, avgSoldPrice: 0.3 });
  const g = bundlePrice({ research: low, game: OW, items: ONE, pricing: PRICING });
  assert.equal(g.floor, 0.75);
  assert.equal(g.price, 0.75);

  const perGame = bundlePrice({
    research: low,
    game: "Overwatch 2",
    items: ONE,
    pricing: { ...PRICING, gameFloors: { overwatch: 1.5, "call of duty": 2 } },
  });
  assert.equal(perGame.floor, 1.5);
  assert.equal(perGame.price, 1.5);

  const offGrid = bundlePrice({
    research: low,
    game: "Call of Duty: Modern Warfare 4",
    items: ONE,
    pricing: { ...PRICING, gameFloors: { "call of duty": 2.1 } },
  });
  assert.equal(offGrid.floor, 2.1);
  assert.ok(offGrid.price >= 2.1);
  assert.equal(offGrid.price, 2.25);

  const unrelated = bundlePrice({
    research: low,
    game: "Marvel Rivals",
    items: ONE,
    pricing: { ...PRICING, gameFloors: { overwatch: 1.5 } },
  });
  assert.equal(unrelated.floor, 0.75);
});

test("bundlePrice: soldFloorUsd never lets a reprice drop below a proven sale price", () => {
  const r = research({ soldRecent: 5, avgSoldPrice: 2 }); // → $2.00 for one item
  // default: no sold floor, price unchanged, soldFloor reported as 0
  const none = bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING });
  assert.equal(none.price, 2);
  assert.equal(none.soldFloor, 0);
  // sold floor above the analytics price wins, ceil'd to the $0.25 grid
  const lifted = bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING, soldFloorUsd: 2.6 });
  assert.equal(lifted.price, 2.75);
  assert.equal(lifted.soldFloor, 2.6);
  assert.equal(lifted.floor, 0.75);
  // an on-grid sold floor is kept as is
  assert.equal(bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING, soldFloorUsd: 3.5 }).price, 3.5);
  // sold floor below the analytics price changes nothing
  assert.equal(bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING, soldFloorUsd: 1.2 }).price, 2);
  // sold floor beats the game floor when higher; garbage values are ignored
  const low = research({ soldRecent: 5, avgSoldPrice: 0.3 });
  assert.equal(
    bundlePrice({ research: low, game: "Overwatch 2", items: ONE, pricing: { ...PRICING, gameFloors: { overwatch: 1.5 } }, soldFloorUsd: 1.9 }).price,
    2,
  );
  assert.equal(bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING, soldFloorUsd: "nope" }).price, 2);
  assert.equal(bundlePrice({ research: r, game: OW, items: ONE, pricing: PRICING, soldFloorUsd: -4 }).soldFloor, 0);
});

/* -------------------------------- lotPrice ------------------------------ */

test("lotPrice discounts the multiplied unit price and floors at N × floor", () => {
  // 2.25 * 5 * 0.9 = 10.125 → 10.25 (round to nearest 0.25)
  assert.equal(lotPrice(2.25, 5, PRICING), 10.25);
  // 0.75 * 5 * 0.9 = 3.375 → 3.5, but floor is 5 × 0.75 = 3.75
  assert.equal(lotPrice(0.75, 5, PRICING), 3.75);
  assert.equal(lotPrice(4, 3, { ...PRICING, lotDiscountPct: 0 }), 12);
  assert.equal(lotPrice(1, 4, { ...PRICING, lotDiscountPct: 50 }), 3);
});

test("classifyHoldings: manifest benefit names vs inventory drop names — complete by count", () => {
  const camps = [
    { campaignId: "mr95", name: "Season 9.5 Twitch Drops", game: "Marvel Rivals", startAt: new Date("2026-08-20"), endAt: new Date("2026-09-20"), status: "ACTIVE", active: true },
  ];
  const manifests = [
    { campaignId: "mr95", name: "Season 9.5 Twitch Drops", game: "Marvel Rivals", drops: [
      { itemKey: "elsa bloodstone spray|marvel rivals", name: "Elsa Bloodstone Spray" },
      { itemKey: "elsa bloodstone nameplate|marvel rivals", name: "Elsa Bloodstone Nameplate" },
    ] },
  ];
  const catalog = buildEventCatalog(camps, manifests);
  const drops = [
    { name: "Elsa Bloodstone「Will of Galacta」Spray", game: "Marvel Rivals", campaign: "Season 9.5 Twitch Drops", itemKey: "elsa bloodstone「will of galacta」spray|marvel rivals" },
    { name: "Elsa Bloodstone「Will of Galacta」Nameplate", game: "Marvel Rivals", campaign: "Season 9.5 Twitch Drops", itemKey: "elsa bloodstone「will of galacta」nameplate|marvel rivals" },
  ];
  const cls = classifyHoldings("Marvel Rivals", drops, catalog, Date.UTC(2026, 8, 6));
  assert.strictEqual(cls.full, true, "two held drops vs two manifest benefits = complete by count");
  assert.strictEqual(cls.waves[0].missing.length, 0);
  // Holding fewer drops than the manifest lists stays partial.
  const one = classifyHoldings("Marvel Rivals", drops.slice(0, 1), catalog, Date.UTC(2026, 8, 6));
  assert.strictEqual(one.full, false);
});
