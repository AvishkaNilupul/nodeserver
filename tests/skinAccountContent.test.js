const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateItems,
  validateProfile,
  marketplaceSection,
  claimedSnapshot,
  reconcileRewards,
  content,
  contentHash,
  RL_ID,
} = require("../utils/skinAccountContent");
const identity = { twitchId: "12345", twitchLogin: "test_viewer" };
const NOW = new Date("2026-11-15T10:00:00Z");
function drop(overrides = {}) {
  return {
    gameId: RL_ID,
    benefitId: "benefit-1",
    name: "Nemesis (Painted)",
    count: 1,
    connected: true,
    source: "gameEventDrop",
    ...overrides,
  };
}
function scan(drops = [drop()], overrides = {}) {
  return { twitchId: "12345", login: "test_viewer", drops, ...overrides };
}
function snapshot(drops = [drop()]) {
  return claimedSnapshot(scan(drops), identity);
}
function skin(overrides = {}) {
  return {
    state: "listed",
    ownershipStatus: "owned",
    link: { status: "verified" },
    profile: {
      region: "JP",
      level: 9,
      rank: "Unranked",
      credits: 0,
      platform: "PC",
    },
    inventory: {
      verified: validateItems([
        { name: "Nemesis", count: 1, kind: "body", paint: "Titanium White" },
        { name: "Apex Collection", count: 1, kind: "reward" },
      ]),
      verifiedAt: NOW,
      baselineAt: NOW,
      pending: [],
    },
    listingPriceUsd: 4.99,
    ...overrides,
  };
}

test("fresh snapshot requires exact Twitch identity and exact game ID", () => {
  assert.throws(
    () => claimedSnapshot(scan([], { twitchId: "999" }), identity),
    /different identity/,
  );
  assert.throws(
    () => claimedSnapshot(scan([], { login: "other" }), identity),
    /different identity/,
  );
  assert.throws(
    () => claimedSnapshot({ drops: [] }, {}),
    /complete Twitch identity/,
  );
  assert.throws(
    () => claimedSnapshot(scan(undefined, { drops: null }), identity),
    /live inventory/,
  );
  assert.deepEqual(
    claimedSnapshot(
      scan([drop({ gameId: "309210" })], { login: "TEST_VIEWER" }),
      identity,
    ),
    {},
  );
});

test("only connected awarded inventory contributes quantities; entitlement limits are excluded", () => {
  const result = snapshot([
    drop({ source: "inProgressClaimed", count: 100, benefitId: "limit" }),
    drop({ count: 2 }),
    drop({ connected: undefined, benefitId: "unknown-link" }),
    drop({ name: "Expired Reward", benefitId: "expired" }),
  ]);
  assert.equal(Object.values(result).length, 1);
  assert.equal(Object.values(result)[0].count, 2);
  assert.equal(Object.values(result)[0].kind, "other");
  assert.equal(Object.hasOwn(Object.values(result)[0], "paint"), false);
});

test("an explicitly disconnected Rocket League reward stops the scan even without a link URL", () => {
  assert.throws(
    () =>
      snapshot([
        drop(),
        drop({ connected: false, benefitId: "old", requiredAccountLink: "" }),
      ]),
    /disconnected/,
  );
  assert.throws(
    () => snapshot([drop({ connected: false, source: "inProgressClaimed" })]),
    /disconnected/,
  );
  assert.doesNotThrow(() =>
    snapshot([drop({ gameId: "other-game", connected: false })]),
  );
});

test("duplicate benefit rows cannot multiply claims and conflicting totals are rejected", () => {
  assert.equal(Object.values(snapshot([drop(), drop()])).length, 1);
  assert.throws(
    () => snapshot([drop(), drop({ count: 2 })]),
    /conflicting reward counts/,
  );
  assert.throws(
    () => snapshot([drop(), drop({ name: "Another Item" })]),
    /conflicting reward counts/,
  );
});

test("baseline capture does not advertise existing claims as newly earned", () => {
  const s = snapshot([drop({ count: 24 })]);
  const inventory = reconcileRewards({}, s, { baseline: true, now: NOW });
  assert.deepEqual(inventory.pending, []);
  assert.equal(Object.values(inventory.highWater)[0].count, 24);
  assert.equal(Object.values(inventory.highWater)[0].observedAt, NOW);
  assert.equal(inventory.baselineAt, NOW);
});

test("new claims are cumulative and repeated scans are idempotent", () => {
  const initial = reconcileRewards({}, snapshot([drop({ count: 3 })]), {
    baseline: true,
    now: NOW,
  });
  const next = reconcileRewards(initial, snapshot([drop({ count: 5 })]), {
    now: NOW,
  });
  const repeat = reconcileRewards(next, snapshot([drop({ count: 5 })]), {
    now: NOW,
  });
  assert.equal(next.pending[0].count, 2);
  assert.deepEqual(repeat.pending, next.pending);
  assert.equal(Object.values(repeat.highWater)[0].count, 5);
});

test("disappearance, lower counts and reappearance preserve durable claim evidence without incrementing it", () => {
  let inv = reconcileRewards({}, snapshot([drop({ count: 3 })]), {
    baseline: true,
    now: NOW,
  });
  inv = reconcileRewards(inv, snapshot([drop({ count: 5 })]), { now: NOW });
  const expected = inv.pending;
  for (const current of [
    {},
    snapshot([drop({ count: 2 })]),
    snapshot([drop({ count: 5 })]),
    {},
  ]) {
    inv = reconcileRewards(inv, current, { now: NOW });
    assert.deepEqual(inv.pending, expected);
    assert.equal(Object.values(inv.highWater)[0].count, 5);
  }
  inv = reconcileRewards(inv, snapshot([drop({ count: 6 })]), { now: NOW });
  assert.equal(inv.pending[0].count, 3);
});

test("one new benefit cannot reset or duplicate the old benefit ledger", () => {
  let inv = reconcileRewards({}, snapshot([drop({ count: 3 })]), {
    baseline: true,
    now: NOW,
  });
  inv = reconcileRewards(
    inv,
    snapshot([
      drop({ count: 4 }),
      drop({ benefitId: "second", name: "Import Drop", count: 2 }),
    ]),
    { now: NOW },
  );
  assert.equal(
    inv.pending.reduce((n, i) => n + i.count, 0),
    3,
  );
  const second = inv.pending.find((i) => i.name === "Import Drop");
  assert.equal(second.count, 2);
  assert.equal(
    inv.pending.find((i) => i.name === "Nemesis (Painted)").count,
    1,
  );
});

test("an explicit full inventory confirmation advances baseline while keeping original observations immutable", () => {
  const original = reconcileRewards({}, snapshot([drop()]), {
    baseline: true,
    now: NOW,
  });
  const pending = reconcileRewards(original, snapshot([drop({ count: 2 })]), {
    now: NOW,
  });
  const reset = reconcileRewards(pending, snapshot([drop({ count: 2 })]), {
    baseline: true,
    now: new Date("2026-11-15T11:00:00Z"),
  });
  assert.deepEqual(reset.pending, []);
  assert.equal(pending.pending[0].count, 1);
  assert.equal(Object.values(original.highWater)[0].count, 1);
});

test("observed inventory preserves exact variants and rejects duplicates or invented structure", () => {
  const items = validateItems([
    {
      name: "Pointbreak",
      count: 1,
      kind: "decal",
      paint: "Black",
      certification: "Sweeper",
    },
  ]);
  assert.equal(items[0].paint, "Black");
  assert.equal(items[0].certification, "Sweeper");
  assert.throws(() => validateItems([null]), /Every inventory item/);
  assert.throws(
    () => validateItems([{ name: "Import Drop", count: 1.5 }]),
    /whole quantity/,
  );
  assert.throws(
    () =>
      validateItems([
        { name: "Import Drop", count: 1 },
        { name: "import drop", count: 1 },
      ]),
    /duplicate/,
  );
  assert.throws(
    () => validateItems([{ name: "Import Drop\nPASSWORD: secret", count: 1 }]),
    /one line/,
  );
  assert.throws(
    () => validateItems([{ name: "<script>", count: 1 }]),
    /plain text/,
  );
});

test("profile never silently supplies unknown zero credits, level or unranked status", () => {
  for (const bad of [null, "", undefined, false]) {
    assert.throws(
      () =>
        validateProfile({
          region: "JP",
          level: bad,
          credits: 0,
          rank: "Unranked",
        }),
      /observed account level/,
    );
    assert.throws(
      () =>
        validateProfile({
          region: "JP",
          level: 9,
          credits: bad,
          rank: "Unranked",
        }),
      /observed credits/,
    );
  }
  assert.throws(
    () => validateProfile({ region: "JP", level: 9, credits: 0 }),
    /observed rank/,
  );
  assert.deepEqual(
    validateProfile({ region: "jp", level: 9, credits: 0, rank: "Unranked" }),
    { region: "JP", level: 9, credits: 0, rank: "Unranked", platform: "PC" },
  );
});

test("public content keeps pending claims distinct and never advertises unobserved paint or opened outcomes", () => {
  const value = skin();
  value.inventory.pending = [
    {
      name: "Tactical Nuke (Painted)",
      count: 1,
      paint: "Invented Crimson",
      certification: "Invented Striker",
    },
  ];
  const preview = content(value);
  assert.equal(preview.canPublish, true);
  assert.match(
    preview.description,
    /ADDITIONAL TWITCH REWARDS — AWAITING GAME CHECK/,
  );
  assert.match(
    preview.description,
    /expected in Rocket League after the next login, not yet checked in-game/,
  );
  assert.match(
    preview.description,
    /Apex Collection is unopened; its resulting item\/colour is unknown/,
  );
  assert.doesNotMatch(preview.description, /Invented Crimson|Invented Striker/);
  assert.match(preview.description, /Titanium White Nemesis/);
});

test("public text never serializes delivery credentials, internal IDs or operator evidence", () => {
  const value = skin({
    password: "password-marker",
    twitchToken: "token-marker",
    epicAccountId: "internal-id-marker",
    link: { status: "verified", detail: "link-evidence-marker" },
    listingMeta: { private: "private-marker" },
  });
  value.inventory.evidence = "operator-evidence-marker";
  value.privateDelivery = { password: "delivery-marker" };
  const serialized = JSON.stringify(content(value));
  assert.doesNotMatch(
    serialized,
    /password-marker|token-marker|internal-id-marker|link-evidence-marker|private-marker|operator-evidence-marker|delivery-marker/,
  );
});

test("missing profile is visibly unverified and cannot be published", () => {
  const preview = content(skin({ profile: {} }));
  assert.equal(preview.canPublish, false);
  assert.match(preview.description, /Rank unverified/);
  assert.match(preview.description, /Credits unverified/);
  assert.doesNotMatch(preview.description, /\| Unranked \| 0 credits/);
});

test("missing link, unverified inventory, sold and quarantined records block publication", () => {
  for (const input of [
    skin({ link: { status: "pending" } }),
    skin({ ownershipStatus: "sold" }),
    skin({ state: "sold" }),
    skin({ ownershipStatus: "quarantined" }),
    skin({ inventory: { verified: [], pending: [] } }),
  ])
    assert.equal(content(input).canPublish, false);
});

test("content hash changes only for public copy, with deterministic repeated snapshots", () => {
  const first = content(skin());
  assert.equal(
    contentHash(first),
    contentHash({ ...first, priceUsd: 99, private: "secret" }),
  );
  assert.notEqual(
    contentHash(first),
    contentHash({
      ...first,
      description: first.description + "\nOne new claim",
    }),
  );
});

test("marketplace level ranges follow official boundaries and keep the exact numeric value", () => {
  for (const [level, expected] of [
    [0, "level-09"],
    [9, "level-09"],
    [10, "level-1049"],
    [49, "level-1049"],
    [50, "level-5099"],
    [99, "level-5099"],
    [100, "level-100499"],
    [499, "level-100499"],
    [500, "level-5001000"],
    [1000, "level-5001000"],
    [1001, "level-other"],
    [5000, "level-other"],
  ]) {
    const section = marketplaceSection({ ...skin().profile, level });
    assert.equal(section.gameId, "1");
    assert.equal(section.tradeEnvironmentId, "0");
    assert.deepEqual(
      section.offerAttributes.find((a) => a.id === "rocket-league-level")
        .values,
      [expected],
    );
    assert.equal(
      section.offerAttributes.find(
        (a) => a.id === "rocket-league-level-numeric",
      ).value,
      level,
    );
  }
  assert.throws(
    () => marketplaceSection({ ...skin().profile, level: 5001 }),
    /0 to 5000/,
  );
});

test("marketplace credit brackets and K-unit rounding preserve exact credits in description", () => {
  for (const [credits, expected, numeric] of [
    [0, "credits-0299", 0],
    [299, "credits-0299", 0.3],
    [300, "credits-300999", 0.3],
    [999, "credits-300999", 1],
    [1000, "credits-1000plus", 1],
    [10000, "credits-1000plus", 10],
  ]) {
    const profile = { ...skin().profile, credits };
    const attrs = marketplaceSection(profile).offerAttributes;
    assert.deepEqual(attrs.find((a) => a.id === "rl-credits").values, [
      expected,
    ]);
    assert.equal(
      attrs.find((a) => a.id === "rocket-league-credits-numeric").value,
      numeric,
    );
    assert.match(
      content(skin({ profile })).description,
      new RegExp("\\| " + credits + " credits"),
    );
  }
  assert.throws(
    () => marketplaceSection({ ...skin().profile, credits: 10001 }),
    /0 to 10000/,
  );
});

test("marketplace maps known ranks only and does not fabricate seasonal title tags", () => {
  for (const [rank, id] of [
    ["Unranked", "rank-unranked"],
    ["Bronze", "rank-bronze"],
    ["Silver", "rank-silver"],
    ["Gold", "rank-gold"],
    ["Platinum", "rank-platinum"],
    ["Diamond", "rank-diamond"],
    ["Champion", "rank-champion"],
    ["Grand Champion", "rank-grand-champion"],
    ["Supersonic Legend", "rank-supersonic-legend"],
  ]) {
    const attrs = marketplaceSection({
      ...skin().profile,
      rank,
    }).offerAttributes;
    assert.deepEqual(
      attrs.find((a) => a.id === "rocket-league-current-rank").values,
      [id],
    );
    assert.deepEqual(
      attrs.find((a) => a.id === "rocket-league-tags-titles").values,
      ["tag-other"],
    );
  }
  assert.throws(
    () => marketplaceSection({ ...skin().profile, rank: "Other" }),
    /supported exact rank/,
  );
  assert.equal(
    content(
      skin({
        profile: {
          ...skin().profile,
          rank: "Champion",
          level: 150,
          credits: 1500,
        },
      }),
    ).canPublish,
    true,
  );
});
