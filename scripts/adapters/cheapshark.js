/**
 * CheapShark adapter — free public API aggregating deals across ~30 stores.
 * Docs: apidocs.cheapshark.com. Pulls current free deals + big discounts.
 */

const { normalize } = require('../normalize');

const STORE_LOOKUP_URL = 'https://www.cheapshark.com/api/1.0/stores';
const DEALS_URL = 'https://www.cheapshark.com/api/1.0/deals';

let storeIdToName = null;

// CheapShark rejects generic User-Agents outright, and their server sometimes
// returns HTTP 400 with a valid JSON body — ignore the status and try to parse.
const UA = 'Mozilla/5.0 (compatible; NewsCollectorBot/0.1; +https://github.com/AvishkaNilupul/nodeserver)';

async function safeJson(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': UA } });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`cheapshark ${url} unparseable (HTTP ${res.status})`); }
  if (parsed && parsed.error) throw new Error(`cheapshark: ${parsed.error}`);
  return parsed;
}

async function loadStores() {
  if (storeIdToName) return storeIdToName;
  const list = await safeJson(STORE_LOOKUP_URL);
  storeIdToName = new Map(list.map(s => [String(s.storeID), s.storeName]));
  return storeIdToName;
}

// Two pulls: literal free (upperPrice=0) + huge discounts (savings>=75%).
async function fetchAll() {
  const items = [];
  const errors = [];
  try {
    const stores = await loadStores();

    const freeUrl = `${DEALS_URL}?upperPrice=0&sortBy=recent&pageSize=25`;
    const dealsUrl = `${DEALS_URL}?onSale=1&sortBy=recent&AAA=1&pageSize=25`;

    const [freeRes, dealsRes] = await Promise.all([
      safeJson(freeUrl),
      safeJson(dealsUrl),
    ]);

    for (const d of [...freeRes, ...dealsRes]) {
      const storeName = stores.get(String(d.storeID)) || 'CheapShark';
      const savings = Number(d.savings || 0).toFixed(0);
      const price = Number(d.salePrice);
      const normalPrice = Number(d.normalPrice);
      const dealUrl = `https://www.cheapshark.com/redirect?dealID=${d.dealID}`;
      const text = price === 0
        ? `Free on ${storeName} (was $${normalPrice.toFixed(2)})`
        : `$${price.toFixed(2)} on ${storeName} — was $${normalPrice.toFixed(2)} (-${savings}%)`;
      items.push(normalize({
        id: d.dealID,
        source: 'cheapshark',
        sourceHandle: storeName,
        author: `CheapShark · ${storeName}`,
        createdAt: new Date((d.lastChange || 0) * 1000 || Date.now()).toISOString(),
        title: d.title,
        text,
        urls: [dealUrl],
        postUrl: dealUrl,
        media: d.thumb ? [{ type: 'photo', url: d.thumb }] : [],
        metrics: {},
      }));
    }
  } catch (err) {
    errors.push({ handle: 'CheapShark', error: err.message });
  }
  return { items, errors };
}

module.exports = { fetchAll };
