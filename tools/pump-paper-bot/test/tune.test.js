const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config.json');
const { replay, rank } = require('../tune');

test('historical replay includes configured execution costs', () => {
  const events = [
    { type: 'market', mint: 'tune-demo', trader: 'a', time: 1, action: 'buy', solVolume: 0.7, priceSol: 1 },
    { type: 'market', mint: 'tune-demo', trader: 'b', time: 2, action: 'buy', solVolume: 0.7, priceSol: 1 },
    { type: 'market', mint: 'tune-demo', trader: 'c', time: 3, action: 'buy', solVolume: 0.7, priceSol: 1 },
    { type: 'market', mint: 'tune-demo', trader: 'd', time: 4, action: 'buy', solVolume: 0.7, priceSol: 1.05 },
  ];
  const result = replay(events, config);
  assert.equal(result.trades, 1);
  assert.ok(result.realizedSol < config.entrySizeSol * 0.05);
});

test('historical rank rejects tiny samples', () => {
  assert.equal(rank({ trades: 4, realizedSol: 10, maxDrawdownSol: 0 }), -Infinity);
});
