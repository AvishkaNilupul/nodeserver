function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function scoreCandidate(features, config) {
  const f = config.filter;
  const age = clamp(1 - features.ageSec / f.maxTokenAgeSec);
  const buys = clamp(features.recentBuys / Math.max(1, f.minRecentBuys));
  const volume = clamp(features.recentBuyVolumeSol / Math.max(0.0001, f.minRecentBuyVolumeSol));
  const buyers = clamp(features.uniqueBuyers / Math.max(1, f.minUniqueBuyers));
  const ratio = features.recentSells === 0 ? 1 : features.recentBuys / features.recentSells;
  const flow = clamp(ratio / Math.max(1, f.maxBuySellRatio));
  const noDump = features.creatorSold ? 0 : 1;
  return 0.2 * age + 0.25 * buys + 0.25 * volume + 0.15 * buyers + 0.1 * flow + 0.05 * noDump;
}

function shouldEnter(features, config) {
  const f = config.filter;
  if (features.ageSec > f.maxTokenAgeSec) return { enter: false, score: 0, reason: 'token-too-old' };
  if (f.maxPriceDeviationRatio && features.referencePriceSol && features.priceDeviationRatio > f.maxPriceDeviationRatio) return { enter: false, score: 0, reason: 'price-outlier' };
  if (features.recentBuyVolumeSol < f.minRecentBuyVolumeSol) return { enter: false, score: 0, reason: 'low-buy-volume' };
  if (features.recentBuys < f.minRecentBuys) return { enter: false, score: 0, reason: 'few-buys' };
  if (features.uniqueBuyers < f.minUniqueBuyers) return { enter: false, score: 0, reason: 'few-buyers' };
  if (f.minMedianBuySol && features.medianBuySol < f.minMedianBuySol) return { enter: false, score: 0, reason: 'small-median-buy' };
  if (f.maxLargestBuyShare && features.largestBuyShare > f.maxLargestBuyShare) return { enter: false, score: 0, reason: 'buyer-concentration' };
  if (f.minBuySellVolumeRatio && features.recentSellVolumeSol > 0 && features.recentBuyVolumeSol / features.recentSellVolumeSol < f.minBuySellVolumeRatio) return { enter: false, score: 0, reason: 'weak-net-flow' };
  if (features.creatorSold) return { enter: false, score: 0, reason: 'creator-sold' };
  const score = scoreCandidate(features, config);
  return score >= f.minScore ? { enter: true, score, reason: 'filter-pass' } : { enter: false, score, reason: 'score-too-low' };
}

module.exports = { clamp, scoreCandidate, shouldEnter };
