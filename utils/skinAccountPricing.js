// Public, anonymous price evidence only. This module never writes a listing.
const SEARCH_URL = "https://www.eldorado.gg/api/flexibleOffers";
const CACHE_MS = 15 * 60 * 1000;
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
const cache = new Map();
const GROWTH_RATES = Object.freeze({
  basicDropUsd: 0.1,
  premiumDropUsd: 0.2,
  cosmeticUsd: 0.5,
  duplicateCosmeticUsd: 0.1,
  apexUsd: 1,
});
const PAINTS = [
  "titanium white",
  "burnt sienna",
  "forest green",
  "sky blue",
  "black",
  "cobalt",
  "crimson",
  "grey",
  "lime",
  "orange",
  "pink",
  "purple",
  "saffron",
];
const CERTS = [
  "acrobat",
  "aviator",
  "goalkeeper",
  "guardian",
  "juggler",
  "paragon",
  "playmaker",
  "scorer",
  "show off",
  "sniper",
  "striker",
  "sweeper",
  "tactician",
  "turtle",
  "victor",
];
const REWARDS = new Set([
  "apex collection",
  "deluxe drop",
  "import drop",
  "exotic drop",
  "sport drop",
  "rare drop",
  "very rare drop",
  "uncommon drop",
]);

function words(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bpoint\s+break\b/g, "pointbreak")
    .replace(/\bgray\b/g, "grey")
    .replace(/\btw\b/g, "titanium white")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function money(value) {
  const n = typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function dateValue(now) {
  const d =
    now === undefined
      ? new Date()
      : new Date(typeof now === "function" ? now() : now);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function itemIdentity(item, requireRewardCount = false) {
  if (!item || typeof item.name !== "string") return null;
  let name = words(item.name);
  const count = item.count;
  if (!name || !Number.isSafeInteger(count) || count < 1 || count > 100000)
    return null;
  const unknown = /\b(painted|random|unknown|unverified|assorted|mystery)\b/;
  if (
    unknown.test(name) ||
    unknown.test(words(item.paint)) ||
    unknown.test(words(item.certification))
  )
    return null;
  let paint = words(item.paint).replace(/^(standard|unpainted|none)$/, "");
  let certification = words(item.certification).replace(
    /^(standard|uncertified|none)$/,
    "",
  );
  for (const candidate of PAINTS) {
    const re = new RegExp(`(?:^| )${candidate}(?= |$)`);
    if (!re.test(name)) continue;
    if (paint && paint !== candidate) return null;
    paint = candidate;
    name = name.replace(re, " ").trim();
  }
  for (const candidate of CERTS) {
    const re = new RegExp(`(?:^| )${candidate}(?= |$)`);
    if (!re.test(name)) continue;
    if (certification && certification !== candidate) return null;
    certification = candidate;
    name = name.replace(re, " ").trim();
  }
  if (
    (paint && !PAINTS.includes(paint)) ||
    (certification && !CERTS.includes(certification))
  )
    return null;
  name = name
    .replace(/\b(standard|unpainted|uncertified|certified|unopened)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "viled decal") name = "viled";
  const reward = REWARDS.has(name) || item.kind === "reward";
  if (requireRewardCount && reward && !item.explicitCount) return null;
  if (!name) return null;
  return {
    name,
    paint,
    certification,
    count,
    kind: reward ? "reward" : "item",
  };
}

function signature(items, remote = false) {
  if (!Array.isArray(items) || !items.length || items.length > 250) return null;
  const counts = new Map();
  for (const item of items) {
    const value = itemIdentity(item, remote);
    if (!value) return null;
    const key = JSON.stringify([
      value.name,
      value.kind,
      value.paint,
      value.certification,
    ]);
    counts.set(key, (counts.get(key) || 0) + value.count);
  }
  return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function plainDescription(value) {
  return String(value || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&");
}

// Only an explicit item-list section is evidence. A title mentioning two rare
// items says nothing about the rest of the bundle, its counts or its variants.
function parseInventory(description) {
  const lines = plainDescription(description)
    .split(/\r?\n/)
    .map((l) => l.trim());
  const heading =
    /^(?:(?:full|complete|verified|exact|in[ -]game)\s+)*(?:inventory|items included|included items|all items)(?:\s*\([^)]*\))?\s*:?$/i;
  const starts = lines.flatMap((line, i) => (heading.test(line) ? [i] : []));
  if (starts.length !== 1) return null;
  const items = [];
  for (const raw of lines.slice(starts[0] + 1)) {
    if (!raw) continue;
    if (
      /^(?:end (?:of )?inventory|account details|delivery(?: details)?|access(?: details)?|email access|notes)\s*:?$/i.test(
        raw,
      )
    )
      break;
    let name = raw.replace(/^[•*\-–]\s*/, "");
    let count = 1;
    let explicitCount = false;
    let match = name.match(/^(\d+)\s*(?:[x×]\s*|[-–:]\s*)(.+)$/i);
    if (match) {
      count = Number(match[1]);
      name = match[2];
      explicitCount = true;
    } else {
      match = name.match(/^(.+?)\s*(?:[x×]\s*(\d+)|\(\s*(\d+)\s*x\s*\))$/i);
      if (match) {
        name = match[1];
        count = Number(match[2] || match[3]);
        explicitCount = true;
      }
    }
    if (
      name.length > 160 ||
      /https?:|@|\b(?:and more|etc|bonus|random|up to|at least)\b/i.test(name)
    )
      return null;
    items.push({ name, count, explicitCount });
  }
  return signature(items, true);
}

function attribute(offer, id) {
  const a = (offer.attributes || []).find((x) => x.id === id);
  if (!a) return undefined;
  return typeof a.value === "object" ? a.value?.name : a.value;
}

function metadata(description, label) {
  const re = new RegExp(`^\\s*(?:[-•]\\s*)?${label}\\s*:\\s*([^\\n|]+)`, "im");
  return plainDescription(description).match(re)?.[1]?.trim();
}

function region(value) {
  const v = words(value);
  return (
    {
      japan: "jp",
      "united states": "us",
      usa: "us",
      "united kingdom": "gb",
      uk: "gb",
    }[v] || v
  );
}

function exactNumber(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value)
    : null;
}

function ownProfile(skin) {
  const p = skin.profile || skin.accountDetails || {};
  return {
    region: region(p.region || skin.epic?.region || skin.region),
    platform: words(p.platform || skin.platform || "PC"),
    level: exactNumber(p.level ?? skin.level),
    rank: words(p.rank || skin.rank),
    credits: exactNumber(p.credits ?? skin.credits),
  };
}

function sameProfile(skin, offer) {
  const ours = ownProfile(skin);
  // Ranges such as level 0–9 or credits 0–299 do not establish exact equality.
  const theirs = {
    region: region(metadata(offer.description, "(?:account )?region")),
    platform: words(
      (offer.tradeEnvironmentValues || []).find((v) => v.name === "Device")
        ?.value,
    ),
    level: exactNumber(
      attribute(offer, "rocket-league-level-numeric") ??
        metadata(offer.description, "(?:account )?level"),
    ),
    rank: words(
      attribute(offer, "rocket-league-current-rank") ||
        metadata(offer.description, "(?:current )?rank"),
    ),
    credits: exactNumber(
      attribute(offer, "rocket-league-credits-numeric") ??
        metadata(offer.description, "credits"),
    ),
  };
  return (
    ours.region &&
    ours.platform &&
    ours.rank &&
    ours.level !== null &&
    ours.credits !== null &&
    Object.keys(ours).every((key) => ours[key] === theirs[key])
  );
}

function isWholeGameAccount(offer) {
  if (
    String(offer.gameId) !== "1" ||
    offer.category !== "Account" ||
    offer.offerState !== "Active"
  )
    return false;
  if (!(offer.quantity >= 1) || offer.minQuantity !== 1) return false;
  const text = words(
    `${offer.offerTitle} ${plainDescription(offer.description)}`,
  );
  if (
    !/\brocket league\b/.test(text) ||
    !/\bepic(?: games)? account\b/.test(text)
  )
    return false;
  if (
    /\b(?:on your own account|link (?:it |this |the purchased twitch account )?to your|twitch only|twitch account only|unlinked twitch|boosting|rank boost|farming service|rental|rent account|(?:fresh|empty|starter|random)(?: rocket league| epic(?: games)?)? account|random inventory|guide only)\b/.test(
      text,
    )
  )
    return false;
  return /\b(?:epic(?: games)? (?:account )?(?:login|credentials)|full (?:game )?account|whole (?:epic )?account|game account included)\b/.test(
    text,
  );
}

function ownOfferIds(skin) {
  return new Set(
    [
      skin.remoteOfferId,
      skin.externalOfferId,
      skin.eldoradoOfferId,
      skin.listing?.offerId,
      skin.listing?.externalOfferId,
      skin.listing?.id,
      skin.listingUrl?.split("/oa/")[1],
      skin.listing?.url?.split("/oa/")[1],
    ]
      .filter(Boolean)
      .map(String),
  );
}

function comparable(skin, row, wanted) {
  const offer = row?.offer || row;
  if (!offer || !/^[\da-f]{8}-[\da-f-]{27}$/i.test(offer.id || "")) return null;
  if (
    ownOfferIds(skin).has(String(offer.id)) ||
    (skin.sellerId && String(offer.userId) === String(skin.sellerId))
  )
    return null;
  const usd = offer.pricePerUnitInUSD;
  const priceUsd = usd?.currency === "USD" ? money(usd.amount) : null;
  if (
    !priceUsd ||
    !isWholeGameAccount(offer) ||
    !sameProfile(skin, offer) ||
    parseInventory(offer.description) !== wanted
  )
    return null;
  return {
    id: offer.id,
    title: String(offer.offerTitle || "").slice(0, 220),
    url: `https://www.eldorado.gg/rocket-league-accounts-for-sale/oa/${offer.id}`,
    priceUsd,
    basis:
      "Same disclosed inventory, counts, variants, region, platform, level, rank and credits; single-account price",
  };
}

function searchTerms(items) {
  const normalized = items.map((item) => itemIdentity(item)).filter(Boolean);
  const names = [
    ...new Set(
      normalized
        .sort(
          (a, b) =>
            (a.kind === "reward") - (b.kind === "reward") ||
            b.name.length - a.name.length,
        )
        .map((v) => v.name),
    ),
  ];
  return names.slice(0, 2);
}

async function fetchQuery(term) {
  const rows = [];
  const seen = new Set();
  let pages, count;
  for (let page = 1; page <= (pages || 1); page++) {
    const url = new URL(SEARCH_URL);
    url.search = new URLSearchParams({
      gameId: "1",
      category: "Account",
      searchQuery: term,
      pageIndex: String(page),
      pageSize: String(PAGE_SIZE),
      offerSortingCriterion: "Price",
      isAscending: "true",
    });
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Public market search unavailable");
    const data = await response.json();
    if (
      !Array.isArray(data.results) ||
      data.pageIndex !== page ||
      !Number.isInteger(data.totalPages) ||
      !Number.isInteger(data.recordCount) ||
      data.recordCount < 0
    )
      throw new Error("Incomplete public market response");
    if (page === 1) {
      pages = data.totalPages;
      count = data.recordCount;
    }
    if (
      pages > MAX_PAGES ||
      pages < 0 ||
      data.totalPages !== pages ||
      data.recordCount !== count ||
      data.results.length > PAGE_SIZE
    )
      throw new Error(
        "Public market search exceeded its bound or changed while reading",
      );
    for (const row of data.results) {
      const id = row?.offer?.id;
      if (!id || seen.has(id))
        throw new Error("Incomplete public market pages");
      seen.add(id);
      rows.push(row);
    }
  }
  if (rows.length !== count) throw new Error("Incomplete public market search");
  return rows;
}

async function fetchSnapshot(terms, checkedAt) {
  const key = terms.join("\n");
  const cached = cache.get(key);
  const clock = Date.now();
  if (cached && clock < cached.expiresAt) return cached.promise;
  const entry = { expiresAt: clock + CACHE_MS };
  entry.promise = (async () => {
    try {
      const byId = new Map();
      // Sequential bounded reads avoid a public-market request burst.
      for (const term of terms)
        for (const row of await fetchQuery(term)) byId.set(row.offer.id, row);
      return { results: [...byId.values()], complete: true, checkedAt };
    } catch (_) {
      entry.expiresAt = Date.now() + 60000;
      return { results: [], complete: false, checkedAt };
    }
  })();
  cache.set(key, entry);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return entry.promise;
}

function suppliedSnapshot(offers, checkedAt) {
  if (Array.isArray(offers))
    return { results: offers, complete: true, checkedAt };
  if (!offers || !Array.isArray(offers.results))
    return { results: [], complete: false, checkedAt };
  const completePage =
    offers.pageIndex === 1 &&
    (offers.totalPages === 1 ||
      (offers.totalPages === 0 && offers.results.length === 0)) &&
    offers.recordCount === offers.results.length;
  return {
    results: offers.results,
    complete:
      offers.complete === true || (offers.complete !== false && completePage),
    checkedAt,
  };
}

// These are operator-selected additions to the starting bundle price, not
// estimates of the market value of an unrevealed paint or unopened reward.
function growthKind(item) {
  const name = words(item.name);
  if (/\bapex collection\b/.test(name))
    return { bucket: "apexUsd", family: "apex collection" };
  if (/\bdrops?\b/.test(name)) {
    if (/\b(import|exotic|black market)\b/.test(name))
      return { bucket: "premiumDropUsd", family: name };
    if (/\b(rare|deluxe|sport|uncommon)\b/.test(name))
      return { bucket: "basicDropUsd", family: name };
    return null;
  }
  const cosmetic = name.match(
    /\b(nemesis|tactical nuke|pointbreak|viled|torque tx)\b/,
  );
  if (cosmetic) return { bucket: "cosmeticUsd", family: cosmetic[1] };
  if (["body", "goal", "decal"].includes(item.kind))
    return { bucket: "cosmeticUsd", family: name };
  return null;
}

function growthAdditions(skin) {
  const pricing = skin.pricing || {};
  const baseline = pricing.growthBaseline;
  const highWater = skin.inventory?.highWater;
  if (
    !pricing.growthBaselineAt ||
    !baseline ||
    !highWater ||
    Array.isArray(baseline) ||
    Array.isArray(highWater)
  ) {
    return {
      error:
        "Confirm the starting inventory and its reward baseline before using growth pricing.",
    };
  }
  const rates = { ...GROWTH_RATES, ...(pricing.growthRates || {}) };
  for (const key of Object.keys(GROWTH_RATES)) {
    if (
      typeof rates[key] !== "number" ||
      !Number.isFinite(rates[key]) ||
      rates[key] < 0 ||
      rates[key] > 1000
    )
      return {
        error: "Invalid reward addition prices; current price retained.",
      };
    rates[key] = Math.round(rates[key] * 100) / 100;
  }
  const valid = (item) =>
    item &&
    typeof item.name === "string" &&
    item.name.trim() &&
    Number.isSafeInteger(item.count) &&
    item.count > 0;
  for (const [key, item] of Object.entries(baseline)) {
    if (
      !valid(item) ||
      !valid(highWater[key]) ||
      highWater[key].count < item.count ||
      words(highWater[key].name) !== words(item.name)
    ) {
      return {
        error:
          "Reward counts or identities disagree with the starting baseline; current price retained.",
      };
    }
  }
  const groups = new Map();
  let unknown = 0;
  for (const [key, item] of Object.entries(highWater)) {
    if (!valid(item))
      return {
        error: "Reward count evidence is incomplete; current price retained.",
      };
    const initial = baseline[key]?.count || 0;
    const added = item.count - initial;
    const type = growthKind(item);
    if (!type) {
      unknown += added;
      continue;
    }
    const groupKey = `${type.bucket}:${type.family}`;
    const group = groups.get(groupKey) || { ...type, baseline: 0, added: 0 };
    group.baseline += initial;
    group.added += added;
    groups.set(groupKey, group);
  }
  const counts = Object.fromEntries(
    Object.keys(GROWTH_RATES).map((key) => [key, 0]),
  );
  for (const group of groups.values()) {
    if (group.bucket === "cosmeticUsd") {
      const first = group.baseline ? 0 : Math.min(1, group.added);
      counts.cosmeticUsd += first;
      counts.duplicateCosmeticUsd += group.added - first;
    } else counts[group.bucket] += group.added;
  }
  const additionUsd =
    Math.round(
      Object.keys(counts).reduce(
        (sum, key) => sum + counts[key] * rates[key],
        0,
      ) * 100,
    ) / 100;
  const labels = {
    basicDropUsd: "basic drops",
    premiumDropUsd: "premium drops",
    cosmeticUsd: "new cosmetic rewards",
    duplicateCosmeticUsd: "additional cosmetic rewards",
    apexUsd: "Apex Collection rewards",
  };
  const parts = Object.keys(counts)
    .filter((key) => counts[key])
    .map(
      (key) =>
        `${counts[key]} ${labels[key]} +$${(counts[key] * rates[key]).toFixed(2)}`,
    );
  return { additionUsd, unknown, text: parts.join(", ") };
}

async function quoteGrowth(skin, result, { floor, ceiling, now, offers }) {
  const addition = growthAdditions(skin);
  if (addition.error) return { ...result, reason: addition.error };
  const base = money(skin.pricing.basePriceUsd);
  if (!base)
    return {
      ...result,
      reason: "Set the starting bundle price before using growth pricing.",
    };
  if (ceiling < result.currentUsd)
    return {
      ...result,
      reason:
        "Current price exceeds the ceiling; growth pricing never lowers an existing price.",
    };
  let proposed = Math.max(
    result.currentUsd,
    floor,
    Math.min(ceiling, money(base + addition.additionUsd)),
  );
  let evidence = null;
  if (proposed > result.currentUsd) {
    evidence = await quotePrice(
      { ...skin, pricing: { ...skin.pricing, mode: "market" } },
      { now, offers },
    );
    result.comparables = evidence.comparables;
    result.checkedAt = evidence.checkedAt;
    if (evidence.comparables.length) {
      const comparableCap =
        Math.round((evidence.comparables[0].priceUsd - 0.01) * 100) / 100;
      proposed =
        comparableCap < floor
          ? result.currentUsd
          : Math.max(result.currentUsd, Math.min(proposed, comparableCap));
    }
  }
  result.proposedUsd = money(proposed);
  result.changed = result.proposedUsd !== result.currentUsd;
  result.reason = addition.text
    ? `Configured additions since the starting bundle: ${addition.text}. These are pricing rules, not market valuations.`
    : "No priced reward additions since the starting bundle; the configured starting price and bounds apply without lowering the existing price.";
  if (addition.unknown)
    result.reason += ` ${addition.unknown} unclassified rewards have no automatic addition.`;
  if (skin.inventory?.pending?.length)
    result.reason +=
      " Claimed rewards awaiting game check are priced without assuming a painted colour or certification.";
  if (evidence?.comparables.length)
    result.reason +=
      " A matching full-account offer caps further increases; existing prices never decrease.";
  else if (evidence)
    result.reason +=
      " No reliable market ceiling was found; configured bounds apply.";
  if (proposed === ceiling) result.reason += " Price ceiling reached.";
  return result;
}

/**
 * Quote only; caller applies its own sale/ownership guards before updating.
 * `offers` is an optional complete public dataset (array), or {results,complete}.
 * Partial datasets must explicitly carry complete:false. No credentials needed.
 */
async function quotePrice(skin, { now, offers } = {}) {
  skin ||= {};
  const pricing = skin.pricing || {};
  const currentUsd =
    [
      skin.listingPriceUsd,
      skin.listing?.priceUsd,
      pricing.currentUsd,
      pricing.basePriceUsd,
    ]
      .map(money)
      .find((v) => v !== null) ?? null;
  const result = {
    currentUsd,
    proposedUsd: currentUsd,
    reason: "",
    comparables: [],
    checkedAt: dateValue(now).toISOString(),
    changed: false,
  };
  const hold = (reason) => ({ ...result, reason });
  if (!currentUsd)
    return hold("Current price is missing; set a base price first.");
  if (!["market", "growth"].includes(pricing.mode))
    return hold("Manual pricing; current price retained.");
  const floor = pricing.floorUsd == null ? 0.01 : money(pricing.floorUsd);
  const ceiling =
    pricing.ceilingUsd == null ? Infinity : money(pricing.ceilingUsd);
  if (!floor || !ceiling || floor > ceiling)
    return hold("Invalid price bounds; current price retained.");
  if (pricing.mode === "growth")
    return quoteGrowth(skin, result, { floor, ceiling, now, offers });
  if (Array.isArray(skin.inventory?.pending) && skin.inventory.pending.length)
    return hold(
      "Rewards await an in-game check; their contents and variants cannot set the price yet.",
    );
  const wanted = signature(skin.inventory?.verified);
  if (!wanted)
    return hold(
      "Verified inventory is missing or ambiguous; current price retained.",
    );
  const profile = ownProfile(skin);
  if (
    !profile.region ||
    !profile.rank ||
    profile.level === null ||
    profile.credits === null
  )
    return hold(
      "Region, level, rank and credits must be known for a comparable full account.",
    );
  const snapshot =
    offers === undefined
      ? await fetchSnapshot(
          searchTerms(skin.inventory.verified),
          result.checkedAt,
        )
      : suppliedSnapshot(offers, result.checkedAt);
  result.checkedAt = snapshot.checkedAt;
  if (!snapshot.complete)
    return hold(
      "Public market search failed or was incomplete; current price retained.",
    );
  result.comparables = [
    ...new Map(
      snapshot.results
        .map((row) => comparable(skin, row, wanted))
        .filter(Boolean)
        .map((c) => [c.id, c]),
    ).values(),
  ]
    .sort((a, b) => a.priceUsd - b.priceUsd)
    .slice(0, 20);
  if (!result.comparables.length)
    return hold(
      "No reliable same-inventory full game account with matching account details; current price retained.",
    );
  const lowest = result.comparables[0].priceUsd;
  const target = Math.max(
    floor,
    Math.min(ceiling, Math.max(0.01, Math.round((lowest - 0.01) * 100) / 100)),
  );
  result.proposedUsd = money(target);
  result.changed = result.proposedUsd !== currentUsd;
  result.reason = `One cent below the lowest matching single-account offer found in the completed search ($${lowest.toFixed(2)}), within your price bounds.`;
  if (result.proposedUsd >= lowest)
    result.reason = `Your price floor prevents undercutting the lowest matching single-account offer found ($${lowest.toFixed(2)}).`;
  return result;
}

module.exports = {
  quotePrice,
  GROWTH_RATES,
  _internals: {
    signature,
    parseInventory,
    searchTerms,
    clearCache: () => cache.clear(),
  },
};
