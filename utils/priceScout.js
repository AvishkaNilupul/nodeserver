// Competitor price research across the marketplaces we publish to.
// Each scout returns [{ title, price (USD), url, sold }] for a search term;
// competitorPrices() runs them in parallel and adds per-market stats plus a
// recommended price (undercut the lowest credible competitor by ~5%).
const axios = require("axios");

const TIMEOUT = 12000;
const CACHE_MS = 10 * 60 * 1000;
const MAX_ROWS = 20;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0 Safari/537.36";

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Stats + recommendation over one marketplace's listings. Prices far away
// from the median (giant bundles, junk $0.01 listings) are not credible
// competitors, so they are ignored for the recommendation.
function priceStats(listings) {
  const prices = listings
    .map((l) => Number(l.price))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return { count: 0 };
  const median = prices[Math.floor(prices.length / 2)];
  let credible = prices.filter(
    (p) => p >= 0.2 && p <= median * 5 && p >= median / 10,
  );
  if (!credible.length) credible = prices;
  const lowest = credible[0];
  return {
    count: credible.length,
    lowest: round2(lowest),
    median: round2(credible[Math.floor(credible.length / 2)]),
    recommended: Math.max(0.2, round2(lowest * 0.95)),
  };
}

async function gameflipSearch(term, status, limit) {
  const r = await axios.get(
    "https://production-gameflip.fingershock.com/api/v1/listing",
    {
      params: { term, status, limit: limit || MAX_ROWS },
      timeout: TIMEOUT,
      headers: { "User-Agent": UA },
    },
  );
  const rows = (r.data && r.data.data) || [];
  return rows
    .filter((x) => x && x.name && Number(x.price) > 0)
    .map((x) => ({
      title: String(x.name),
      price: round2(Number(x.price) / 100),
      url: "https://gameflip.com/item/" + x.id,
      updated: x.updated || null,
      sold: undefined,
    }));
}

function gameflipScout(term) {
  return gameflipSearch(term, "onsale");
}

// Recently sold Gameflip listings: real demand, with sale dates + prices.
function gameflipSoldScout(term, limit) {
  return gameflipSearch(term, "sold", limit);
}

async function platiScout(term) {
  const r = await axios.get("https://plati.io/api/search.ashx", {
    params: { query: term, response: "json", pagesize: MAX_ROWS },
    timeout: TIMEOUT,
    headers: { "User-Agent": UA },
  });
  const rows = (r.data && r.data.items) || [];
  return rows
    .filter((x) => x && Number(x.price_usd) > 0)
    .map((x) => ({
      title: String(x.name_eng || x.name || ""),
      price: round2(Number(x.price_usd)),
      url: String(x.url || "https://plati.market/itm/" + x.id),
      sold: Number(x.numsold) || 0,
    }));
}

// GGSel has no public search API, but its search page ships the results as
// dehydrated JSON inside the HTML. Extract every {"id_goods":...} object by
// brace-matching (regex alone breaks on nested objects).
function extractJsonObjects(html, marker) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at === -1 || out.length >= 60) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = at; i < html.length && i < at + 20000; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      out.push(JSON.parse(html.slice(at, end + 1)));
    } catch {
      // skip unparseable fragment
    }
    from = end + 1;
  }
  return out;
}

async function ggselScout(term) {
  const r = await axios.get(
    "https://ggsel.net/en/search/" + encodeURIComponent(term),
    {
      timeout: TIMEOUT,
      headers: { "User-Agent": UA, Accept: "text/html" },
      maxContentLength: 20 * 1024 * 1024,
      responseType: "text",
    },
  );
  const objs = extractJsonObjects(String(r.data || ""), '{"id_goods"');
  const seen = new Set();
  const rows = [];
  for (const o of objs) {
    if (!o || !o.id_goods || seen.has(o.id_goods)) continue;
    seen.add(o.id_goods);
    if (o.is_active === false || o.hidden_from_search) continue;
    const price = Number(o.price_wmz); // WMZ tracks USD
    if (!(price > 0)) continue;
    rows.push({
      title: String(o.name || ""),
      price: round2(price),
      url: "https://ggsel.net/en/catalog/product/" + (o.url || o.id_goods),
      sold: Number(o.cnt_sell) || 0,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

// G2G's public storefront search needs the catalog service + brand (game);
// the publish modal already knows both once the seller picks them.
async function g2gScout(term, serviceId, brandId) {
  const r = await axios.get("https://sls.g2g.com/offer/search", {
    params: {
      service_id: serviceId,
      brand_id: brandId,
      q: term,
      page_size: MAX_ROWS,
      sort: "lowest_price",
      currency: "USD",
      country: "US",
      v: "v2",
    },
    timeout: TIMEOUT,
    headers: { "User-Agent": UA },
    validateStatus: (s) => s === 200 || s === 404,
  });
  const rows = (r.data && r.data.payload && r.data.payload.results) || [];
  return rows
    .filter((x) => x && Number(x.converted_unit_price) > 0)
    .map((x) => ({
      title: String(x.title || ""),
      price: round2(Number(x.converted_unit_price)),
      url: "https://www.g2g.com/offer/" + (x.offer_id || x.offer_group || ""),
      sold: undefined,
    }));
}

async function runScout(key, fn) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const listings = await fn();
  listings.sort((a, b) => a.price - b.price);
  const data = { ...priceStats(listings), listings: listings.slice(0, 8) };
  cacheSet(key, data);
  return data;
}

// term: free-text search (e.g. "rainbow six twitch")
// g2g: optional { serviceId, brandId } from the publish modal
async function competitorPrices({ term, g2g }) {
  const t = String(term || "").trim();
  const jobs = {
    gameflip: runScout("gameflip:" + t, () => gameflipScout(t)),
    digiseller: runScout("plati:" + t, () => platiScout(t)),
    ggsel: runScout("ggsel:" + t, () => ggselScout(t)),
  };
  if (g2g && g2g.serviceId && g2g.brandId) {
    jobs.g2g = runScout(
      "g2g:" + g2g.serviceId + ":" + g2g.brandId + ":" + t,
      () => g2gScout(t, g2g.serviceId, g2g.brandId),
    );
  }
  const out = {};
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((n) => jobs[n]));
  settled.forEach((s, i) => {
    out[names[i]] =
      s.status === "fulfilled"
        ? s.value
        : { count: 0, listings: [], error: s.reason?.message || "failed" };
  });
  return out;
}

module.exports = {
  competitorPrices,
  gameflipScout,
  gameflipSoldScout,
  platiScout,
  ggselScout,
};
