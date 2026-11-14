const test = require("node:test");
const assert = require("node:assert/strict");
const { quotePrice, _internals } = require("../utils/skinAccountPricing");
const NOW = "2026-11-15T10:00:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function skin() {
  return {
    profile: {
      region: "JP",
      level: 9,
      rank: "Unranked",
      credits: 0,
      platform: "PC",
    },
    inventory: {
      verified: [
        {
          key: "nemesis-tw",
          name: "Nemesis",
          kind: "body",
          count: 1,
          paint: "Titanium White",
        },
        {
          key: "pointbreak-black",
          name: "Pointbreak",
          kind: "decal",
          count: 1,
          paint: "Black",
          certification: "Sweeper",
        },
        { key: "import", name: "Import Drop", kind: "reward", count: 7 },
      ],
      pending: [],
    },
    pricing: {
      mode: "market",
      basePriceUsd: 4.99,
      floorUsd: 1,
      ceilingUsd: 10,
    },
    listingPriceUsd: 4.99,
  };
}

function offer(price = 7, overrides = {}) {
  return {
    offer: {
      id: ID,
      gameId: "1",
      category: "Account",
      offerState: "Active",
      quantity: 1,
      minQuantity: 1,
      offerTitle: "Rocket League full Epic account | TW Nemesis",
      description:
        "Rocket League full game account. Epic account credentials included.\nComplete in-game inventory:\n- Titanium White Nemesis x1\n- Black Point Break (Sweeper certified) x1\n- Import Drop x7\nAccount details:\nRegion: Japan\nLevel: 9\nRank: Unranked\nCredits: 0",
      tradeEnvironmentValues: [{ name: "Device", value: "PC" }],
      attributes: [
        { id: "rocket-league-current-rank", value: { name: "Unranked" } },
      ],
      pricePerUnitInUSD: { amount: price, currency: "USD" },
      ...overrides,
    },
  };
}

async function quote(offers, value = skin()) {
  return quotePrice(value, { now: NOW, offers });
}
async function withFetch(fake, fn) {
  const original = global.fetch;
  global.fetch = fake;
  _internals.clearCache();
  try {
    return await fn();
  } finally {
    global.fetch = original;
    _internals.clearCache();
  }
}

test("same disclosed item counts and profile produce a bounded single-account quote", async () => {
  const result = await quote([offer()]);
  assert.equal(result.currentUsd, 4.99);
  assert.equal(result.proposedUsd, 6.99);
  assert.equal(result.changed, true);
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.comparables.length, 1);
  assert.match(result.reason, /completed search/);
  assert.deepEqual(Object.keys(result.comparables[0]).sort(), [
    "basis",
    "id",
    "priceUsd",
    "title",
    "url",
  ]);
});

test("counts, colours, certification and additional items must all match", async () => {
  const base = offer();
  for (const description of [
    base.offer.description.replace("Import Drop x7", "Import Drop x6"),
    base.offer.description.replace("Titanium White Nemesis", "Crimson Nemesis"),
    base.offer.description.replace("Sweeper certified", "Striker certified"),
    base.offer.description.replace("Sweeper certified", "uncertified"),
    base.offer.description.replace(
      "Account details:",
      "- Atomizer x1\nAccount details:",
    ),
    base.offer.description.replace("Import Drop x7", "Import Drop"),
    base.offer.description.replace(
      "Titanium White Nemesis",
      "Nemesis (Painted)",
    ),
    base.offer.description.replace("Import Drop x7", "Import Drop x70"),
  ]) {
    const result = await quote([offer(2, { description })]);
    assert.equal(result.changed, false, description);
    assert.equal(result.comparables.length, 0);
  }
});

test("item aliases and explicit painted/certified variants normalize without substring matches", async () => {
  const base = offer();
  const description = base.offer.description
    .replace("Titanium White Nemesis x1", "1 × TW Nemesis")
    .replace(
      "Black Point Break (Sweeper certified) x1",
      "1 × Pointbreak (Black, Sweeper)",
    )
    .replace("Import Drop x7", "Import Drop (7x)");
  assert.equal((await quote([offer(7, { description })])).changed, true);
  assert.equal(
    (
      await quote([
        offer(7, {
          description: description.replace("Nemesis", "Nemesis Pro"),
        }),
      ])
    ).changed,
    false,
  );
});

test("a reward box never matches the resulting cosmetic", async () => {
  const value = skin();
  value.inventory.verified.push({
    name: "Apex Collection",
    count: 1,
    kind: "reward",
  });
  const base = offer();
  const description = base.offer.description.replace(
    "Account details:",
    "- Apex x1\nAccount details:",
  );
  assert.equal(
    (await quote([offer(7, { description })], value)).changed,
    false,
  );
});

test("Twitch-only accounts, services, fresh accounts, wrong games and inactive offers are excluded", async () => {
  const base = offer();
  const variants = [
    {
      description: `${base.offer.description}\nTwitch account only. Link the purchased Twitch account to your Epic account.`,
    },
    { description: `${base.offer.description}\nUnlinked Twitch account.` },
    { offerTitle: "Rocket League boosting farming service" },
    { offerTitle: "Fresh Epic account" },
    { category: "CustomItem" },
    { gameId: "108" },
    { offerState: "Paused" },
    { quantity: 0 },
    { minQuantity: 10 },
    {
      description: base.offer.description.replace(
        "Rocket League full game account. Epic account credentials included.",
        "Rocket League Twitch drops. Epic account required.",
      ),
    },
  ];
  for (const overrides of variants)
    assert.equal(
      (await quote([offer(0.25, overrides)])).changed,
      false,
      JSON.stringify(overrides),
    );
});

test("title-only and incomplete item summaries cannot establish identical inventory", async () => {
  for (const description of [
    "Titanium White Nemesis x1, Black Pointbreak Sweeper x1, Import Drop x7. Full Epic account.",
    offer().offer.description.replace(
      "Complete in-game inventory:",
      "Highlights:",
    ),
    offer().offer.description.replace(
      "Import Drop x7",
      "Import Drop x7 and more",
    ),
  ])
    assert.equal((await quote([offer(7, { description })])).changed, false);
});

test("region, level, rank, credits and platform differences or unknowns hold the price", async () => {
  for (const [field, replacement] of [
    ["region", "US"],
    ["level", 10],
    ["rank", "Champion"],
    ["credits", 100],
    ["platform", "Xbox"],
  ]) {
    const value = skin();
    value.profile[field] = replacement;
    assert.equal((await quote([offer()], value)).changed, false, field);
  }
  for (const field of ["region", "level", "rank", "credits"]) {
    const value = skin();
    delete value.profile[field];
    assert.equal((await quote([offer()], value)).changed, false, field);
  }
  const description = offer().offer.description.replace(
    "Level: 9",
    "Level: 0-9",
  );
  assert.equal((await quote([offer(7, { description })])).changed, false);
  assert.equal(
    (
      await quote([
        offer(7, {
          description: description.replace("Region: Japan", "Region: Global"),
        }),
      ])
    ).changed,
    false,
  );
});

test("pending unknown variants and unverified inventory never move the price", async () => {
  const value = skin();
  value.inventory.pending = [
    { name: "Nemesis (Painted)", count: 1, kind: "body" },
  ];
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      throw new Error("unexpected");
    },
    async () => {
      const result = await quotePrice(value, { now: NOW });
      assert.equal(result.changed, false);
      assert.match(result.reason, /in-game check/);
      assert.equal(calls, 0);
    },
  );
  value.inventory.pending = [];
  value.inventory.verified[0].paint = "unknown";
  assert.equal((await quote([offer()], value)).changed, false);
  value.inventory.verified = [];
  assert.equal((await quote([offer()], value)).changed, false);
});

test("manual mode and missing current price cause no network request", async () => {
  const value = skin();
  value.pricing.mode = "manual";
  await withFetch(
    () => {
      throw new Error("unexpected");
    },
    async () => {
      assert.equal((await quotePrice(value)).changed, false);
      delete value.listingPriceUsd;
      delete value.pricing.basePriceUsd;
      value.pricing.mode = "market";
      assert.equal((await quotePrice(value)).proposedUsd, null);
    },
  );
});

test("bounds are applied without claiming the bounded price undercuts when it does not", async () => {
  const value = skin();
  value.pricing.floorUsd = 8;
  const highFloor = await quote([offer()], value);
  assert.equal(highFloor.proposedUsd, 8);
  assert.match(highFloor.reason, /floor prevents/);
  value.pricing.floorUsd = 1;
  value.pricing.ceilingUsd = 6;
  assert.equal((await quote([offer()], value)).proposedUsd, 6);
  value.pricing.floorUsd = 7;
  assert.equal((await quote([offer()], value)).changed, false);
  value.pricing.floorUsd = -1;
  assert.equal((await quote([offer()], value)).changed, false);
});

test("single-account USD prices ignore local currency and volume discounts", async () => {
  const result = await quote([
    offer(7, {
      quantity: 20,
      pricePerUnit: { amount: 1150, currency: "JPY" },
      pricePerUnitWithDiscount: { amount: 1, currency: "USD" },
      volumeDiscounts: [{ quantity: 10, discountPercentage: 90 }],
    }),
  ]);
  assert.equal(result.proposedUsd, 6.99);
  assert.equal(
    (
      await quote([
        offer(7, { pricePerUnitInUSD: { amount: 1150, currency: "JPY" } }),
      ])
    ).changed,
    false,
  );
});

test("own offer and seller are excluded; public output contains no raw credentials", async () => {
  const value = skin();
  value.remoteOfferId = ID;
  assert.equal((await quote([offer()], value)).changed, false);
  delete value.remoteOfferId;
  value.sellerId = "ours";
  assert.equal(
    (await quote([offer(7, { userId: "ours" })], value)).changed,
    false,
  );
  const o = offer(7, {
    userId: "them",
    accountPassword: "not-public",
    secretToken: "private",
  });
  o.user = { email: "private@example.invalid", password: "private" };
  const result = await quote([o], value);
  assert.doesNotMatch(
    JSON.stringify(result),
    /not-public|secretToken|private@example|password/,
  );
});

test("complete result selects the cheapest reliable full account, not irrelevant cheaper offers", async () => {
  const result = await quote([
    offer(7),
    offer(6, { id: OTHER_ID }),
    offer(0.25, { offerTitle: "Rocket League farming service" }),
  ]);
  assert.equal(result.proposedUsd, 5.99);
  assert.equal(result.comparables[0].id, OTHER_ID);
});

test("caller-supplied partial pages never produce a quote", async () => {
  for (const offers of [
    { results: [offer()], complete: false },
    { results: [offer()], pageIndex: 1, totalPages: 2, recordCount: 51 },
    { results: [offer()], pageIndex: 1, totalPages: -1, recordCount: 1 },
    { results: [offer()] },
    null,
  ]) {
    const result = await quote(offers);
    assert.equal(result.changed, false);
    assert.match(result.reason, /incomplete/);
  }
});

test("failed fetch and partial later page keep the current price", async () => {
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const result = await quotePrice(skin());
      assert.equal(result.changed, false);
      assert.match(result.reason, /failed or was incomplete/);
    },
  );
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 2) throw new Error("page two failed");
      return {
        ok: true,
        json: async () => ({
          results: [offer()],
          pageIndex: 1,
          totalPages: 2,
          recordCount: 2,
        }),
      };
    },
    async () => {
      const result = await quotePrice(skin());
      assert.equal(result.changed, false);
      assert.equal(result.comparables.length, 0);
      assert.equal(calls, 2);
    },
  );
});

test("bounded anonymous requests cache complete snapshots and deduplicate overlapping searches", async () => {
  const requests = [];
  await withFetch(
    async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => ({
          results: [offer()],
          pageIndex: 1,
          totalPages: 1,
          recordCount: 1,
        }),
      };
    },
    async () => {
      const first = await quotePrice(skin(), { now: NOW });
      const second = await quotePrice(skin(), { now: "2026-11-15T10:01:00Z" });
      assert.equal(first.proposedUsd, 6.99);
      assert.equal(first.comparables.length, 1);
      assert.equal(
        second.checkedAt,
        NOW,
        "cached quote retains actual snapshot time",
      );
      assert.equal(requests.length, 2);
      for (const request of requests) {
        const url = new URL(request.url);
        assert.equal(url.origin, "https://www.eldorado.gg");
        assert.equal(url.searchParams.get("category"), "Account");
        assert.equal(url.searchParams.get("gameId"), "1");
        assert.deepEqual(request.options.headers, {
          Accept: "application/json",
        });
        assert.equal(request.options.redirect, "error");
      }
    },
  );
});

test("searches exceeding the page cap, malformed responses and repeated pages hold", async () => {
  for (const data of [
    { results: [offer()], pageIndex: 1, totalPages: 4, recordCount: 151 },
    { results: [offer()], pageIndex: 1, totalPages: 1, recordCount: 2 },
    {
      results: [offer(), offer()],
      pageIndex: 1,
      totalPages: 1,
      recordCount: 2,
    },
    { error: "unavailable" },
  ])
    await withFetch(
      async () => ({ ok: true, json: async () => data }),
      async () => {
        assert.equal((await quotePrice(skin())).changed, false);
      },
    );
});

function growthSkin() {
  const value = skin();
  value.pricing.mode = "growth";
  value.pricing.growthBaselineAt = NOW;
  value.pricing.growthBaseline = {
    import: { name: "Import RLCS 2025 Drop", count: 7, kind: "other" },
    nemesis: { name: "Nemesis (Painted)", count: 1, kind: "other" },
    apex: { name: "Apex Collection", count: 1, kind: "other" },
  };
  value.inventory.highWater = structuredClone(value.pricing.growthBaseline);
  return value;
}

test("growth mode adds configured reward prices while preserving unknown paint status", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count++;
  value.inventory.highWater.apex.count++;
  value.inventory.highWater.newBasic = {
    name: "Very Rare RLCS 2025 Drop",
    count: 2,
    kind: "other",
  };
  value.inventory.highWater.moreNemesis = {
    name: "Nemesis (Painted)",
    count: 2,
    kind: "other",
  };
  value.inventory.highWater.newPointbreak = {
    name: "Point Break (Painted)",
    count: 1,
    kind: "other",
  };
  value.inventory.pending = [
    { name: "Nemesis (Painted)", count: 2, kind: "other" },
  ];
  const result = await quote([], value);
  assert.equal(result.proposedUsd, 7.09); // .20 + 1.00 + .20 + .20 + .50
  assert.match(result.reason, /not market valuations/);
  assert.match(result.reason, /without assuming a painted colour/);
  assert.equal(result.comparables.length, 0);
});

test("confirming game receipt, repainting the verified list or repeating a scan never charges twice", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count += 2;
  value.inventory.pending = [
    { name: "Import RLCS 2025 Drop", count: 2, kind: "other" },
  ];
  const first = await quote([], value);
  assert.equal(first.proposedUsd, 5.39);
  value.listingPriceUsd = first.proposedUsd;
  value.inventory.pending = [];
  value.inventory.verified[2].count += 2;
  value.inventory.baseline = structuredClone(value.inventory.highWater); // Receipt baseline may advance.
  const second = await quote([], value);
  assert.equal(second.proposedUsd, 5.39);
  assert.equal(second.changed, false);
  assert.equal((await quote([], value)).changed, false);
});

test("growth distinguishes first cosmetic rewards and repeats across different benefit keys", async () => {
  const value = growthSkin();
  value.inventory.highWater.pointA = {
    name: "Point Break",
    count: 1,
    kind: "other",
  };
  value.inventory.highWater.pointB = {
    name: "Point Break (Painted)",
    count: 3,
    kind: "other",
  };
  assert.equal((await quote([], value)).proposedUsd, 5.79); // One new family .50, three further rewards .30.
});

test("growth rates are configurable, permit zero and reject invalid settings", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count++;
  value.pricing.growthRates = { premiumDropUsd: 0.75 };
  assert.equal((await quote([], value)).proposedUsd, 5.74);
  value.pricing.growthRates.premiumDropUsd = 0;
  assert.equal((await quote([], value)).changed, false);
  value.pricing.growthRates.premiumDropUsd = -1;
  assert.equal((await quote([], value)).changed, false);
  assert.match((await quote([], value)).reason, /Invalid/);
});

test("growth ceiling limits increases and prices never fall even when settings or market are lower", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count += 20;
  value.pricing.ceilingUsd = 6;
  assert.equal((await quote([], value)).proposedUsd, 6);
  value.listingPriceUsd = 6;
  assert.equal((await quote([offer(5.5)], value)).proposedUsd, 6);
  value.pricing.ceilingUsd = 5;
  assert.equal((await quote([], value)).proposedUsd, 6);
  assert.match((await quote([], value)).reason, /never lowers/);
});

test("a defensible full-account comparison caps growth while irrelevant Twitch prices do not", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count += 20;
  assert.equal((await quote([offer(7)], value)).proposedUsd, 6.99);
  assert.equal(
    (
      await quote(
        [offer(0.25, { offerTitle: "Rocket League Twitch account only" })],
        value,
      )
    ).proposedUsd,
    8.99,
  );
  value.pricing.floorUsd = 8;
  assert.equal(
    (await quote([offer(7)], value)).proposedUsd,
    4.99,
    "floor above comparison cap cannot force a speculative increase",
  );
});

test("growth uses addition rules when the market is unavailable, with an explicit explanation", async () => {
  const value = growthSkin();
  value.inventory.highWater.import.count++;
  const result = await quote({ results: [], complete: false }, value);
  assert.equal(result.proposedUsd, 5.19);
  assert.match(result.reason, /No reliable market ceiling/);
});

test("missing baseline, regressed high-water counts and renamed reward IDs hold growth pricing", async () => {
  const value = growthSkin();
  delete value.pricing.growthBaselineAt;
  assert.equal((await quote([], value)).changed, false);
  value.pricing.growthBaselineAt = NOW;
  value.inventory.highWater.import.count = 6;
  assert.equal((await quote([], value)).changed, false);
  value.inventory.highWater.import.count = 8;
  value.inventory.highWater.import.name = "Exotic Drop";
  assert.equal((await quote([], value)).changed, false);
});

test("unclassified future rewards have no invented automatic value", async () => {
  const value = growthSkin();
  value.inventory.highWater.unknown = {
    name: "Unspecified bonus",
    count: 1,
    kind: "other",
  };
  const result = await quote([], value);
  assert.equal(result.changed, false);
  assert.match(result.reason, /1 unclassified rewards/);
});
