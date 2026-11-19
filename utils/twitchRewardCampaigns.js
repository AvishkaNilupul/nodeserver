const axios = require("axios");

// This feed contains public campaign metadata. Viewer eligibility and awards
// are available in the viewer's signed-in Twitch inventory.
const FEED_URL = "https://drops.sunkwi.com/api/twitch/rewards";
const SNAPSHOT_URL =
  "https://raw.githubusercontent.com/SunkwiBOT/twitch-drops-api/main/rewards.json";
const CAMPAIGNS_URL = "https://www.twitch.tv/drops/campaigns";
const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
const GTA_ID = "b7669f9e-c69c-4a9b-a3b2-36266c1bdfc0";
const GTA_RULES =
  "https://blog.twitch.tv/en/2026/11/17/the-wait-is-over-gtavi-is-live/";
const GTA_CATEGORY = {
  name: "Grand Theft Auto VI",
  slug: "grand-theft-auto-vi",
};
const GTA_GIVEAWAY = {
  id: "gtavi-ultimate-edition-giveaway-2026",
  name: "GTA VI Ultimate Edition game code",
  endsAt: "2026-12-01T07:59:59.999Z",
  claimBy: "2026-12-08T07:59:59.999Z",
  detailsUrl: GTA_RULES,
  inventoryUrl: INVENTORY_URL,
};
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

function getGiveaway(now = Date.now()) {
  if (
    now < Date.parse("2026-11-18T11:00:00Z") ||
    now > Date.parse(GTA_GIVEAWAY.claimBy)
  )
    return null;
  return { ...GTA_GIVEAWAY, claimOnly: now > Date.parse(GTA_GIVEAWAY.endsAt) };
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeUrl(value, domains) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return "";
    if (
      domains &&
      !domains.some((d) => url.hostname === d || url.hostname.endsWith("." + d))
    )
      return "";
    return url.href;
  } catch {
    return "";
  }
}

function categoriesFor(categories) {
  const links = new Map();
  for (const category of categories) {
    const slug = clean(category?.slug);
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      links.set(slug, {
        name: clean(category.displayName || category.name) || slug,
        url: "https://www.twitch.tv/directory/category/" + slug,
      });
    }
  }
  return [...links.values()];
}

function requirementText(goals = {}, repeat) {
  const parts = [];
  const quantities = [
    [goals.minuteWatchedGoal, "minute of viewing", "minutes of viewing"],
    [goals.subsGoal, "subscription", "subscriptions"],
    [goals.turboSubsGoal, "Turbo subscription", "Turbo subscriptions"],
    [goals.eventTriggerGoal, "event trigger", "event triggers"],
  ];
  for (const [count, single, plural] of quantities) {
    if (Number.isInteger(count) && count > 0)
      parts.push(count + " " + (count === 1 ? single : plural));
  }
  if (Number.isInteger(repeat?.times) && repeat.times > 1) {
    const interval =
      repeat.everyHours === 24
        ? "once per day"
        : repeat.everyHours > 0
          ? "every " + repeat.everyHours + " hours"
          : "repeatable";
    parts.push(interval + " · " + repeat.times + " times");
  }
  return parts.join(" · ") || "See campaign rules on Twitch.";
}

// Twitch's grouped feed publishes chest names and a watch-time field even on
// the final badge. The campaign card gives the contents and completion rule.
function gtaGroups() {
  return [
    {
      rewards: [
        "Purple Chain",
        "Bronze Chain",
        "Silver Chain",
        "Gold Chain",
        "Diamond Chain",
        "Miami Chain",
      ],
      label: "GTA DVD Chest · Chat badges",
      requirement:
        "Watch a participating GTA VI stream for 60 minutes on each of six different days. Each day earns one badge.",
    },
    {
      rewards: [
        "Welcome 2 Miami",
        "Scored Big",
        "Bleed Miami",
        "BustedPlz",
        "DinoBusted",
        "SabaBusted",
      ],
      label: "Heist · Badges and emotes",
      requirement:
        "Each new paid or gifted subscription earns one random badge and emote pair. Three unlock all six. Prime subscriptions are excluded.",
    },
    {
      rewards: ["Golden Iguana"],
      label: "Collection reward",
      requirement:
        "Collect all six watch badges and all six subscription rewards.",
    },
  ];
}

function normalizeCampaign(raw) {
  const id = clean(raw?.id);
  const name = clean(raw?.name);
  const starts = Date.parse(raw?.startsAt);
  const ends = Date.parse(raw?.endsAt);
  if (
    !id ||
    !name ||
    !Number.isFinite(starts) ||
    !Number.isFinite(ends) ||
    ends <= starts
  )
    return null;
  if (!["ACTIVE", "UPCOMING"].includes(raw.status)) return null;
  const groups = raw.rewardGroups?.length ? raw.rewardGroups : [raw];
  const data = {
    id,
    name,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
    summary: clean(raw.summary) || clean(raw.instructions),
    image: safeUrl(raw.image?.image1xURL, ["jtvnw.net", "twitchcdn.net"]),
    detailsUrl: safeUrl(raw.aboutURL) || CAMPAIGNS_URL,
    categories: categoriesFor(raw.game ? [raw.game] : []),
    groups: [],
  };
  if (id === GTA_ID) {
    data.categories = categoriesFor([GTA_CATEGORY]);
    data.detailsUrl = GTA_RULES;
    data.groups = gtaGroups();
    data.summary = "";
    return data;
  }
  for (const group of groups) {
    const rewards = [
      ...new Set(
        (group.rewards || []).map((item) => clean(item?.name)).filter(Boolean),
      ),
    ];
    data.groups.push({
      rewards,
      requirement: requirementText(
        group.unlockRequirements || raw.unlockRequirements,
        group.repeat,
      ),
      categories: categoriesFor(group.categories || []),
    });
  }
  return data;
}

function parseSnapshot(body) {
  if (
    !Array.isArray(body?.campaigns) ||
    !Number.isFinite(Date.parse(body.refreshedAt))
  ) {
    throw new Error("Invalid Twitch rewards feed");
  }
  const byId = new Map();
  for (const raw of body.campaigns) {
    const campaign = normalizeCampaign(raw);
    if (campaign) byId.set(campaign.id, campaign);
  }
  return {
    campaigns: [...byId.values()],
    refreshedAt: new Date(body.refreshedAt).toISOString(),
    publishedSnapshot: body.publishedSnapshot === true,
  };
}

async function fetchFeed() {
  const options = {
    timeout: 8000,
    maxRedirects: 0,
    maxContentLength: 2 * 1024 * 1024,
    headers: { Accept: "application/json" },
  };
  try {
    const response = await axios.get(FEED_URL, options);
    if (!Array.isArray(response.data?.campaigns) || !response.data.refreshedAt)
      throw new Error("Incomplete live feed");
    return response.data;
  } catch (liveError) {
    // The provider publishes this same feed to GitHub when its data changes.
    // It also covers a cold start during the anonymous API's rate limit.
    try {
      const response = await axios.get(SNAPSHOT_URL, options);
      return { ...response.data, publishedSnapshot: true };
    } catch {
      throw liveError;
    }
  }
}

function createRewardCatalog(read = fetchFeed, clock = Date.now) {
  let snapshot = null;
  let pending = null;
  let nextCheck = 0;
  let stale = false;

  async function refresh() {
    try {
      snapshot = parseSnapshot(await read());
      stale = false;
      nextCheck = clock() + CACHE_MS;
    } catch (err) {
      stale = true;
      const retrySeconds = Number(err.response?.headers?.["retry-after"]);
      nextCheck =
        clock() +
        Math.max(
          RETRY_MS,
          Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0,
        );
    } finally {
      pending = null;
    }
  }

  return async function getCatalog() {
    if (clock() >= nextCheck) {
      if (!pending) pending = Promise.resolve().then(refresh);
      await pending;
    }
    if (!snapshot) throw new Error("Reward feed unavailable");
    const now = clock();
    const campaigns = snapshot.campaigns
      .filter((item) => Date.parse(item.endsAt) >= now)
      .map((item) => ({
        ...item,
        status: Date.parse(item.startsAt) > now ? "Upcoming" : "Live",
      }))
      .sort(
        (a, b) =>
          a.status.localeCompare(b.status) ||
          b.startsAt.localeCompare(a.startsAt) ||
          a.name.localeCompare(b.name),
      );
    return {
      campaigns,
      giveaway: getGiveaway(now),
      refreshedAt: snapshot.refreshedAt,
      publishedSnapshot: snapshot.publishedSnapshot,
      stale,
    };
  };
}

module.exports = {
  GTA_ID,
  GTA_GIVEAWAY,
  createRewardCatalog,
  getGiveaway,
  getRewardCatalog: createRewardCatalog(),
};
