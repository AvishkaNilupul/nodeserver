// Refill exact per-game/tier shelves after confirmed worker logout.
const SteamAccount = require('../models/SteamAccount');
const SteamBoost = require('../models/SteamBoost');
const SteamListing = require('../models/SteamListing');
const sales = require('./steamSales');
const boost = require('./steamBoost');
const products = require('./steamProducts');
let running = false;
async function run() {
  if (running) return { placed: 0 };
  running = true;
  const result = { placed: 0, errors: [] };
  try {
    const cfg = await boost.settings();
    const stock = await SteamAccount.find({ stage: 'stock', 'games.verifiedAt': { $ne: null } }).sort({ createdAt: 1 }).limit(20).lean();
    for (const acc of stock) {
      if (await SteamBoost.exists({ steamAccountId: acc._id, state: { $in: ['queued', 'boosting', 'stopping'] } })) continue;
      const prepared = await SteamBoost.findOne({ steamAccountId: acc._id, state: 'ready' }).sort({ updatedAt: -1 }).lean();
      const game = prepared ? (acc.games || []).find(g => g.appId === prepared.saleAppId) : (acc.games || []).find(g => g.verifiedAt && g.playtimeMinutes >= 2);
      if (!game) continue;
      // A manually stopped boost is held for operator review, never sold as a
      // completed tier just because another game happens to have some hours.
      if (acc.boostedAt && !prepared) continue;
      const hours = Math.floor(Number(game.playtimeMinutes || 0) / 60);
      const minHours = prepared?.purpose === 'boost' ? (hours >= 1000 ? 1000 : hours >= 500 ? 500 : 0) : 0;
      if (prepared?.purpose === 'boost' && !minHours) continue;
      const p = products.normalize({ kind: minHours ? 'boosted' : 'game', appId: game.appId, minHours });
      if (products.blockers(acc, p).length) continue;
      const region = sales._shared.regionOf(acc);
      if (!region) continue;
      const existing = await SteamListing.findOne({ region, ...p, status: { $ne: 'removed' } }).sort({ createdAt: -1 }).lean();
      if (existing && !['active', 'sold_out'].includes(existing.status)) continue;
      try {
        if (existing) await sales.addAccounts(String(existing._id), [String(acc._id)], 'steam-shelf');
        else await sales.createListing({ region, ...p, priceUsd: minHours ? cfg.boostPriceUsd : cfg.gamePriceUsd, accountIds: [String(acc._id)] }, 'steam-shelf');
        result.placed++;
      } catch (e) { result.errors.push({ id: String(acc._id), message: String(e.message).slice(0, 200) }); }
    }
    return result;
  } finally { running = false; }
}
module.exports = { run };
