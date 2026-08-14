// Competitor price research across the marketplaces we publish to.
// Each scout returns [{ title, price (USD), url, sold }] for a search term;
// competitorPrices() runs them in parallel and adds per-market stats plus a
// recommended price (undercut the lowest credible competitor by ~5%).
const axios = require("axios");
const remoteHttp = require("./remoteHttp");

const TIMEOUT = 12000;
const CACHE_MS = 10 * 60 * 1000;
// How many rows to pull per market. This was 20, which was not a page size so
// much as a ceiling on how much demand the research scanner could ever see:
// its heaviest signal is the count of recent Gameflip sales, so every game with
// 20+ sales in the window scored identically and the best games were
// indistinguishable from merely good ones. Measured live, Gameflip returns 40
// sold rows for a busy game at limit=100 and a GGSel search page carries ~36.
// Plati caps itself at 20 whatever we ask (pagenum returns nothing), which is
// fine — its value is the lifetime numsold counter, not the row count.
const MAX_ROWS = 100;
// Rows kept for display in the price-check modal, where a long list is noise.
const SHOW_ROWS = 8;
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
  // Offloaded to the Raspberry Pi when online (idle CPU + a second IP for
  // marketplace rate limits); transparent server fallback inside remoteHttp.
  const r = await remoteHttp.fetchJson(
    "https://production-gameflip.fingershock.com/api/v1/listing",
    {
      params: { term, status, limit: limit || MAX_ROWS },
      timeout: TIMEOUT,
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
      // Who is selling it. One seller listing the same bundle 20 times is one
      // competitor, not 20 — see competitionOf in utils/marketResearch.js.
      seller: String(x.owner || ""),
      sellerName: "",
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
  const r = await remoteHttp.fetchJson("https://plati.io/api/search.ashx", {
    params: { query: term, response: "json", pagesize: MAX_ROWS },
    timeout: TIMEOUT,
  });
  const rows = (r.data && r.data.items) || [];
  return rows
    .filter((x) => x && Number(x.price_usd) > 0)
    .map((x) => ({
      title: String(x.name_eng || x.name || ""),
      price: round2(Number(x.price_usd)),
      url: String(x.url || "https://plati.market/itm/" + x.id),
      seller: String(x.seller_id || ""),
      sellerName: String(x.seller_name || ""),
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
  const r = await remoteHttp.fetchText(
    "https://ggsel.net/en/search/" + encodeURIComponent(term),
    { timeout: TIMEOUT },
  );
  const objs = extractJsonObjects(String(r.text || ""), '{"id_goods"');
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
      seller: String(o.id_seller || ""),
      sellerName: String(o.seller_name || ""),
      sold: Number(o.cnt_sell) || 0,
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

// FunPay has no API and no cross-game search, but it does not need one: each
// game's Twitch-drop category ("node") is its own public page, and everything
// on that page is that game's market. That makes it a cleaner signal than the
// text searches the other markets need — no relevance filtering, no bleed from
// unrelated products. The page is served without the golden_key, so this reads
// as an anonymous visitor and never touches the seller session.
//
// Prices are shown in the page's own currency (EUR on /en/), so they are
// converted to USD by the caller-supplied rate.
const FP_ROW = /class="tc-item"/g;

// Titles come out of raw HTML, so entities are still encoded ("Jynxzi&#039;s").
// They matter because titles are one of the keys competition dedupes on.
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function fpField(chunk, re) {
  const m = chunk.match(re);
  return m ? decodeEntities(String(m[1])).trim() : "";
}

function parseFunpayRows(html, usdPerUnit) {
  const text = String(html || "");
  const out = [];
  // Split on the row marker: each chunk holds exactly one offer's markup.
  const parts = text.split(FP_ROW).slice(1);
  for (const chunk of parts) {
    const price = Number(fpField(chunk, /class="tc-price"[^>]*data-s="([0-9.]+)"/));
    if (!(price > 0)) continue;
    const title = fpField(chunk, /class="tc-desc-text">([\s\S]*?)<\/div>/)
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      title,
      price: round2(price * (Number(usdPerUnit) || 1)),
      url: "",
      seller: fpField(chunk, /\/users\/(\d+)\//),
      sellerName: fpField(chunk, /class="media-user-name">([\s\S]*?)<\/div>/)
        .replace(/\s+/g, " ")
        .trim(),
      // FunPay publishes no per-offer sale counter.
      sold: undefined,
    });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

async function funpayScout(nodeId, usdPerUnit) {
  const node = String(nodeId || "").trim();
  if (!node) return [];
  const r = await remoteHttp.fetchText(
    "https://funpay.com/en/lots/" + encodeURIComponent(node) + "/",
    { timeout: TIMEOUT },
  );
  return parseFunpayRows(r.text, usdPerUnit);
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
      seller: String(x.seller_id || x.user_id || ""),
      sellerName: String(x.username || ""),
      sold: undefined,
    }));
}

async function runScout(key, fn) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const listings = await fn();
  listings.sort((a, b) => a.price - b.price);
  const data = {
    ...priceStats(listings),
    listings: listings.slice(0, SHOW_ROWS),
  };
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
  funpayScout,
  g2gScout,
  parseFunpayRows,
};
