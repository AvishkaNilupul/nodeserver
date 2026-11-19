const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { createRewardCatalog } = require("../utils/twitchRewardCampaigns");

const start = Date.parse("2026-11-18T11:00:00Z");
const end = Date.parse("2026-12-01T07:59:59.999Z");
const gta = {
  id: "b7669f9e-c69c-4a9b-a3b2-36266c1bdfc0",
  name: "GTAVI Launch Celebration",
  status: "ACTIVE",
  startsAt: new Date(start).toISOString(),
  endsAt: new Date(end).toISOString(),
};
const other = {
  ...gta,
  id: "partner",
  name: "Partner reward",
  aboutURL: "javascript:alert(1)",
  rewardGroups: [
    {
      rewards: [{ name: "Gift" }],
      categories: [{ displayName: "Game", slug: "game" }, { slug: "../bad" }],
      unlockRequirements: { minuteWatchedGoal: 20, subsGoal: 1 },
      repeat: { times: 3, everyHours: 24 },
    },
  ],
};
const snapshot = (campaigns) => ({
  campaigns,
  refreshedAt: new Date(start).toISOString(),
});

test("GTA's thirteen chat items belong to three distinct rules and the surprise prize stays separate", async () => {
  const get = createRewardCatalog(
    async () => snapshot([gta]),
    () => start,
  );
  const {
    campaigns: [row],
    giveaway,
  } = await get();
  assert.equal(row.groups.flatMap((g) => g.rewards).length, 13);
  assert.match(row.groups[0].requirement, /six different days/);
  assert.match(row.groups[1].requirement, /paid or gifted/);
  assert.deepEqual(row.groups[2].rewards, ["Golden Iguana"]);
  assert.match(
    row.groups[2].requirement,
    /all six watch badges and all six subscription/,
  );
  assert.equal(
    row.categories[0].url,
    "https://www.twitch.tv/directory/category/grand-theft-auto-vi",
  );
  assert.ok(giveaway.id !== row.id);
  assert.equal(giveaway.inventoryUrl, "https://www.twitch.tv/drops/inventory");
});

test("new campaign groups carry their requirements and safe category URLs, and legacy flat campaigns survive", async () => {
  const flat = {
    ...gta,
    id: "flat",
    rewards: [{ name: "Badge" }],
    unlockRequirements: { subsGoal: 1 },
  };
  const get = createRewardCatalog(
    async () => snapshot([other, flat, other]),
    () => start,
  );
  const rows = (await get()).campaigns;
  assert.equal(rows.length, 2);
  const partner = rows.find((row) => row.id === other.id);
  assert.equal(partner.detailsUrl, "https://www.twitch.tv/drops/campaigns");
  assert.deepEqual(partner.groups[0].categories, [
    { name: "Game", url: "https://www.twitch.tv/directory/category/game" },
  ]);
  assert.match(
    partner.groups[0].requirement,
    /20 minutes of viewing · 1 subscription · once per day · 3 times/,
  );
  assert.equal(
    rows.find((row) => row.id === "flat").groups[0].requirement,
    "1 subscription",
  );
});

test("active and upcoming campaign windows are recalculated on cached data; claim window survives feed removal", async () => {
  let now = start - 5000;
  const get = createRewardCatalog(
    async () => snapshot([gta]),
    () => now,
  );
  assert.equal((await get()).campaigns[0].status, "Upcoming");
  now = start;
  assert.equal((await get()).campaigns[0].status, "Live");
  now = end + 1;
  assert.equal((await get()).campaigns.length, 0);
  assert.equal(
    (
      await createRewardCatalog(
        async () => snapshot([]),
        () => now,
      )()
    ).giveaway.claimOnly,
    true,
  );
  now = Date.parse("2026-12-08T08:00:00Z");
  assert.equal((await get()).giveaway, null);
});

test("coalesces concurrent refreshes and preserves the last good snapshot across malformed replies and backoff", async () => {
  let calls = 0,
    now = start;
  const get = createRewardCatalog(
    async () => (++calls === 1 ? snapshot([other]) : {}),
    () => now,
  );
  await Promise.all([get(), get(), get()]);
  assert.equal(calls, 1);
  now += 600000;
  const fallback = await get();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.campaigns[0].id, "partner");
  await get();
  assert.equal(calls, 2);
});

test("cold upstream failures differ from an empty catalog and retry after the feed's backoff", async () => {
  let calls = 0,
    now = start;
  const get = createRewardCatalog(
    async () => {
      if (++calls === 1)
        throw Object.assign(new Error("limited"), {
          response: { headers: { "retry-after": "120" } },
        });
      return snapshot([]);
    },
    () => now,
  );
  await assert.rejects(get(), /unavailable/);
  now += 65000;
  await assert.rejects(get(), /unavailable/);
  assert.equal(calls, 1);
  now += 60000;
  assert.deepEqual((await get()).campaigns, []);
});

test("a fresh server can show the provider's published snapshot if the live feed is rate limited", async (t) => {
  const urls = [];
  t.mock.method(axios, "get", async (url) => {
    urls.push(url);
    if (url.startsWith("https://drops.sunkwi.com/"))
      throw Object.assign(new Error("429"), { response: { status: 429 } });
    return { data: snapshot([gta]) };
  });
  const catalog = await createRewardCatalog(undefined, () => start)();
  assert.equal(catalog.publishedSnapshot, true);
  assert.equal(catalog.campaigns[0].id, gta.id);
  assert.equal(
    urls[1],
    "https://raw.githubusercontent.com/SunkwiBOT/twitch-drops-api/main/rewards.json",
  );
});
