const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldEnter } = require('../lib/filter');
const config = require('../config.json');

test('filter rejects thin activity', () => {
  const result = shouldEnter({ ageSec: 4, recentBuys: 1, recentSells: 0, recentBuyVolumeSol: 0.2, uniqueBuyers: 1, creatorSold: false }, config);
  assert.equal(result.enter, false);
});

test('filter accepts strong early flow', () => {
  const result = shouldEnter({ ageSec: 5, recentBuys: 6, recentSells: 0, recentBuyVolumeSol: 2.1, uniqueBuyers: 5, creatorSold: false }, config);
  assert.equal(result.enter, true);
});

test('filter rejects creator selling', () => {
  const result = shouldEnter({ ageSec: 5, recentBuys: 8, recentSells: 0, recentBuyVolumeSol: 3, uniqueBuyers: 8, creatorSold: true }, config);
  assert.equal(result.enter, false);
});

test('filter rejects an isolated transaction-price outlier', () => {
  const result = shouldEnter({ ageSec: 5, recentBuys: 8, recentSells: 0, recentBuyVolumeSol: 3, uniqueBuyers: 8, medianBuySol: 0.2, largestBuyShare: 0.3, recentSellVolumeSol: 0, creatorSold: false, referencePriceSol: 0.0000003, priceDeviationRatio: 0.97 }, config);
  assert.equal(result.enter, false);
  assert.equal(result.reason, 'price-outlier');
});
