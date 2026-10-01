// What EXACTLY is a listing selling?
//
// The owner's rule for the price tracker: compare prices only between listings
// that carry the same items, in the same amounts — "exact orders, exact listings,
// exact items". Three things in this codebase make that harder than it looks:
//
//  1. The same drops are published as many DropSet rows. Measured 2026-10-01: a
//     dozen Gameflip rows titled "Albion Online ... (2 Items) — Radiant Wilds
//     Chest + Noble Community Chest" point at a dozen DIFFERENT set ids. Keying
//     on the set id would call every one of them a unique product and no
//     cross-market comparison would ever find a sibling. Identity is therefore
//     the CONTENT: the sorted multiset of (itemKey x qty).
//  2. A set grows after a listing was published (later event waves). The title
//     still promises "(3 Items)" while the set now holds 29. The buyer paid for
//     the PROMISE, so such a row is NOT an exact match for either the 3-item or
//     the 29-item product: it is flagged `titleMismatch` and only ever compared
//     at the looser game + size-band tier.
//  3. Quantity / no-claim rows carry no DropSet at all. They fall back to the
//     advertised title, which is honest but weaker — flagged `basis: "title"`.
//
// Pure: no DB, no network, no settings.
const crypto = require("crypto");
const { classifyKind, parseAdvertisedCount } = require("../marketPricing");

// Half-to-double bands, the same idea as marketPricing.comparableRivals: wide
// enough that the weak price/size relationship does not fragment the sample,
// narrow enough that a 1-item row never prices a 44-item one.
const SIZE_BANDS = [
  { name: "1", min: 1, max: 1 },
  { name: "2-3", min: 2, max: 3 },
  { name: "4-6", min: 4, max: 6 },
  { name: "7-12", min: 7, max: 12 },
  { name: "13-30", min: 13, max: 30 },
  { name: "31+", min: 31, max: Infinity },
];

function sizeBand(n) {
  const c = Number(n);
  if (!Number.isFinite(c) || c < 1) return "?";
  const b = SIZE_BANDS.find((x) => c >= x.min && c <= x.max);
  return b ? b.name : "?";
}

// "Albion Online Twitch Drops (2 Items) — ..." -> "Albion Online". Same pattern
// marketPricing documents ("recovers 1142 of 1164").
function gameFromTitle(title) {
  const m = /^(.+?)\s+twitch\s+(?:drops?|bundle)/i.exec(String(title || "").trim());
  return m ? m[1].trim() : "";
}

function normGame(g) {
  return String(g || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

// The game a set mostly belongs to: by reward count, ties broken alphabetically
// so the answer never depends on array order.
function dominantGame(items) {
  const tally = new Map();
  for (const it of items || []) {
    const g = String((it && it.game) || "").trim();
    if (!g) continue;
    tally.set(g, (tally.get(g) || 0) + (Number(it.qty) > 0 ? Number(it.qty) : 1));
  }
  let best = "";
  let bestN = -1;
  for (const [g, n] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = g;
      bestN = n;
    }
  }
  return best;
}

/**
 * Identify what a listing sells.
 *
 * @param {object} listing  MarketplaceListing-like: title, set, unclaimedGame,
 *                          rentFarm, bulkOfferId
 * @param {object|null} set the DropSet it points at (items[]), if any
 * @returns {{
 *   kind: "drops"|"farm"|"bulk",
 *   game: string, gameKey: string,
 *   contentKey: string|null,   // exact content identity (null = not knowable)
 *   bandKey: string,           // game|size-band — the looser, honest tier
 *   basis: "set"|"title",
 *   itemCount: number|null,    // distinct items actually in the set
 *   rewardCount: number|null,  // sum of qty
 *   advertisedCount: number|null,
 *   countForBand: number|null,
 *   titleMismatch: boolean,
 *   exact: boolean             // true only when contentKey may be compared
 * }}
 */
function identify(listing, set) {
  const title = String((listing && listing.title) || "");
  const advertisedCount = parseAdvertisedCount(title);
  let kind = classifyKind(title);
  if (listing && listing.rentFarm) kind = "farm";
  if (listing && listing.bulkOfferId) kind = "bulk";

  const items = set && Array.isArray(set.items) ? set.items.filter((i) => i && i.itemKey) : [];
  let game = items.length ? dominantGame(items) : "";
  if (!game && listing && listing.unclaimedGame) game = String(listing.unclaimedGame);
  if (!game) game = gameFromTitle(title);
  const gameKey = normGame(game);

  let contentKey = null;
  let itemCount = null;
  let rewardCount = null;
  let basis = "title";
  if (items.length) {
    basis = "set";
    // Multiset: duplicate itemKeys are summed so ["a","a"] and [{a,qty 2}] agree.
    const m = new Map();
    for (const it of items) {
      const q = Number(it.qty) > 0 ? Math.floor(Number(it.qty)) : 1;
      m.set(String(it.itemKey), (m.get(String(it.itemKey)) || 0) + q);
    }
    itemCount = m.size;
    rewardCount = [...m.values()].reduce((a, b) => a + b, 0);
    contentKey =
      "s:" +
      hash(
        [...m.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([k, q]) => k + "x" + q)
          .join("|"),
      );
  }

  // The listing promised `advertisedCount`. Titles count REWARDS (quantity
  // included): "(7 Items) — 6x Esports Pack + OL' CLANKER" is 7 rewards across
  // 2 distinct items, and is correct. Measured 2026-10-01: treating distinct
  // items as the only valid count flagged 416 of 2271 listings, most of them
  // perfectly honest. The title agrees with the content if it matches EITHER
  // the distinct-item count or the reward count; only a count matching neither
  // is real drift (the set grew or shrank after the listing was written).
  const titleMismatch = !!(
    advertisedCount &&
    itemCount &&
    advertisedCount !== itemCount &&
    advertisedCount !== rewardCount
  );
  // What the BUYER was told they are buying wins for banding.
  const countForBand = advertisedCount || itemCount || null;
  const exact = basis === "set" && !titleMismatch && kind === "drops";

  // A title-only identity is still a stable key inside one title family, which
  // is useful for "this exact offer, repeatedly" but never merges with a set key.
  if (!contentKey && title) contentKey = "t:" + hash(normTitle(title).replace(/\b\d{6,}\b/g, ""));

  return {
    kind,
    game,
    gameKey,
    contentKey,
    bandKey: gameKey + "|" + sizeBand(countForBand),
    basis,
    itemCount,
    rewardCount,
    advertisedCount,
    countForBand,
    titleMismatch,
    exact,
  };
}

module.exports = { SIZE_BANDS, sizeBand, gameFromTitle, normGame, identify };
