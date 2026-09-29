/**
 * Shared normalization: turn any post/text/URL into structured tags
 * that the UI filters against. Every adapter produces items in this shape.
 *
 * NewsItem = {
 *   id, source, sourceHandle, author, createdAt, title, text,
 *   url, postUrl, media[], kind, store, platform[], tags[],
 *   metrics: { likes, retweets, comments, upvotes },
 * }
 */

const STORE_MATCHERS = [
  { store: 'steam',    re: /store\.steampowered\.com|steamcommunity\.com|steam\b/i },
  { store: 'epic',     re: /store\.epicgames\.com|epicgames\.com\/store|\bepic games\b|\bepic store\b/i },
  { store: 'gog',      re: /gog\.com/i },
  { store: 'prime',    re: /gaming\.amazon\.com|prime gaming/i },
  { store: 'itch',     re: /itch\.io/i },
  { store: 'ubisoft',  re: /ubisoft\.com|ubi\.li|ubisoft connect/i },
  { store: 'ea',       re: /ea\.com|origin\.com|ea play/i },
  { store: 'battle',   re: /battle\.net|blizzard\.com/i },
  { store: 'gmg',      re: /greenmangaming\.com|gmg\b/i },
  { store: 'fanatical',re: /fanatical\.com/i },
  { store: 'humble',   re: /humblebundle\.com|humble\b/i },
  { store: 'indiegala',re: /indiegala\.com/i },
  { store: 'gamejolt', re: /gamejolt\.com/i },
  { store: 'xbox',     re: /xbox\.com|microsoft\.com\/.*\/store|game pass/i },
  { store: 'psn',      re: /playstation\.com|store\.playstation\.com|psn\b/i },
  { store: 'nintendo', re: /nintendo\.com|eshop/i },
  { store: 'gg',       re: /gg\.deals|isthereanydeal\.com/i },
];

const PLATFORM_MATCHERS = [
  { platform: 'pc',      re: /\b(pc|steam|epic|gog|itch|windows|linux|mac)\b/i },
  { platform: 'ps',      re: /\b(ps5|ps4|playstation|psn|ps\+)\b/i },
  { platform: 'xbox',    re: /\b(xbox|xbla|series x|series s|game pass)\b/i },
  { platform: 'switch',  re: /\b(switch|nintendo|eshop)\b/i },
  { platform: 'mobile',  re: /\b(android|ios|iphone|mobile|google play|app store)\b/i },
];

// Kind is coarse: what bucket this post belongs to.
function classifyKind({ text, title, url }) {
  const t = `${title || ''} ${text || ''} ${url || ''}`.toLowerCase();
  if (
    /\bdrops?\b|twitch drop|campaign drops|reward drops|watch to earn|in-game reward|earn.*by watching|watch.*on twitch|drops enabled/.test(t)
  ) return 'drops';
  if (/\bfree\b|\bfreebie\b|giveaway|100% off|\$0(?!\.\d)|free to (keep|play)|free for a limited time/.test(t)) return 'free';
  if (/%\s*off|\bdeal\b|discount|\bsale\b|\bbundle\b|save \d+%|from \$\d|\bcheapest\b|price drop|historical low/.test(t)) return 'deal';
  return 'other';
}

// Cross-reference against the user's actively-farmed games list — so drops
// items about games we care about float to the top.
function detectFarmable({ text, title, url }, activeGames = []) {
  if (!activeGames.length) return null;
  const hay = `${title || ''} ${text || ''} ${url || ''}`.toLowerCase();
  for (const g of activeGames) {
    const pattern = g.toLowerCase().replace(/\s+/g, '\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(hay)) return g;
  }
  return null;
}

function detectStore({ text, title, url }) {
  const t = `${title || ''} ${text || ''} ${url || ''}`;
  for (const m of STORE_MATCHERS) if (m.re.test(t)) return m.store;
  return null;
}

function detectPlatforms({ text, title, url }) {
  const t = `${title || ''} ${text || ''} ${url || ''}`;
  const hits = new Set();
  for (const m of PLATFORM_MATCHERS) if (m.re.test(t)) hits.add(m.platform);
  return [...hits];
}

// Best external URL is a store link, not just the source's own post link.
function pickPrimaryUrl(urls = []) {
  if (!urls.length) return null;
  const scored = urls.map(u => {
    let score = 0;
    for (const m of STORE_MATCHERS) if (m.re.test(u)) { score += 100; break; }
    if (/reddit\.com\/r\/\w+\/comments/.test(u)) score += 20;
    if (/redd\.it\//.test(u)) score += 20;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].u;
}

function normalize({
  id, source, sourceHandle, author, createdAt,
  title = '', text = '', urls = [], postUrl = null, media = [],
  metrics = {},
}) {
  const primaryUrl = pickPrimaryUrl(urls);
  const ctx = { text, title, url: (urls || []).join(' ') };
  return {
    id: `${source}:${id}`,
    source,
    sourceHandle,
    author,
    createdAt,
    title,
    text,
    url: primaryUrl,
    urls,
    postUrl,
    media,
    kind: classifyKind(ctx),
    store: detectStore(ctx),
    platform: detectPlatforms(ctx),
    farmable: null,
    metrics: {
      likes: metrics.likes || 0,
      retweets: metrics.retweets || 0,
      comments: metrics.comments || 0,
      upvotes: metrics.upvotes || 0,
    },
  };
}

function enrichFarmable(items, activeGames) {
  if (!activeGames || !activeGames.length) return items;
  for (const it of items) {
    const ctx = { text: it.text, title: it.title, url: (it.urls || []).join(' ') };
    it.farmable = detectFarmable(ctx, activeGames);
  }
  return items;
}

module.exports = { normalize, enrichFarmable, classifyKind, detectStore, detectPlatforms, detectFarmable, pickPrimaryUrl };
