class MarketState {
  constructor(windowSec = 30) {
    this.windowSec = windowSec;
    this.byMint = new Map();
  }

  observe(event) {
    if (!event.mint || event.time == null || !event.action) return;
    let state = this.byMint.get(event.mint);
    if (!state) {
      state = { firstSeen: event.time, events: [], recentBuyers: new Set(), creatorSold: false };
      this.byMint.set(event.mint, state);
    }
    const priorPrices = state.events
      .map((item) => item.priceSol)
      .filter((price) => Number.isFinite(price) && price > 0)
      .sort((a, b) => a - b);
    const referencePriceSol = priorPrices.length
      ? priorPrices[Math.floor(priorPrices.length / 2)]
      : 0;
    const priceDeviationRatio = referencePriceSol && event.priceSol
      ? Math.abs(event.priceSol / referencePriceSol - 1)
      : 0;
    state.events.push(event);
    if (event.action === 'buy' && event.trader) state.recentBuyers.add(event.trader);
    if (event.action === 'sell' && event.trader === state.creator) state.creatorSold = true;
    const cutoff = event.time - this.windowSec;
    state.events = state.events.filter((item) => item.time >= cutoff);
    const recent = state.events;
    const buys = recent.filter((item) => item.action === 'buy');
    const sells = recent.filter((item) => item.action === 'sell');
    const buyVolumes = buys.map((item) => item.solVolume || 0).sort((a, b) => a - b);
    const totalBuyVolume = buyVolumes.reduce((sum, value) => sum + value, 0);
    const medianBuySol = buyVolumes.length
      ? buyVolumes[Math.floor(buyVolumes.length / 2)]
      : 0;
    const largestBuyShare = totalBuyVolume
      ? Math.max(...buyVolumes) / totalBuyVolume
      : 1;
    return {
      ageSec: Math.max(0, event.time - state.firstSeen),
      recentBuys: buys.length,
      recentSells: sells.length,
      recentBuyVolumeSol: totalBuyVolume,
      recentSellVolumeSol: sells.reduce((sum, item) => sum + (item.solVolume || 0), 0),
      uniqueBuyers: new Set(buys.map((item) => item.trader).filter(Boolean)).size,
      medianBuySol,
      largestBuyShare,
      creatorSold: state.creatorSold,
      lastPriceSol: event.priceSol || 0,
      referencePriceSol,
      priceDeviationRatio,
    };
  }
}

module.exports = { MarketState };
