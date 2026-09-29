/**
 * Epic Games Store adapter — free-games-promotions endpoint.
 * Public, unauthenticated, returns current + upcoming weekly free games.
 */

const { normalize } = require('../normalize');

const ENDPOINT = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';

async function fetchAll() {
  const items = [];
  const errors = [];
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) throw new Error(`epic HTTP ${res.status}`);
    const body = await res.json();
    const games = body?.data?.Catalog?.searchStore?.elements || [];
    for (const g of games) {
      const promo = pickActivePromo(g);
      if (!promo) continue;
      const slug = g.catalogNs?.mappings?.[0]?.pageSlug || g.productSlug || g.urlSlug;
      const storeUrl = slug ? `https://store.epicgames.com/en-US/p/${slug}` : null;
      const image = g.keyImages?.find(k => k.type === 'OfferImageWide' || k.type === 'DieselStoreFrontWide')?.url;
      items.push(normalize({
        id: g.id,
        source: 'epic',
        sourceHandle: 'EpicStore',
        author: 'Epic Games Store',
        createdAt: (promo.startDate || new Date().toISOString()),
        title: g.title,
        text: `${g.description || ''}\nFree until ${new Date(promo.endDate).toUTCString()}`,
        urls: storeUrl ? [storeUrl] : [],
        postUrl: storeUrl,
        media: image ? [{ type: 'photo', url: image }] : [],
        metrics: {},
      }));
    }
  } catch (err) {
    errors.push({ handle: 'EpicStore', error: err.message });
  }
  return { items, errors };
}

function pickActivePromo(g) {
  const promos = g?.promotions?.promotionalOffers || [];
  const now = Date.now();
  for (const p of promos) {
    for (const o of p.promotionalOffers || []) {
      const isFree = o.discountSetting?.discountPercentage === 0;
      const start = new Date(o.startDate).getTime();
      const end = new Date(o.endDate).getTime();
      if (isFree && start <= now && end >= now) {
        return { startDate: o.startDate, endDate: o.endDate };
      }
    }
  }
  return null;
}

module.exports = { fetchAll };
