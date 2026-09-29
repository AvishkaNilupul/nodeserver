const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrade } = require('../lib/solana');

function routedBuy({ signerDeltaSol, routeOutSol, poolInSol, tokenDelta }) {
  return {
    blockTime: 100,
    slot: 200,
    transaction: { message: { accountKeys: [
      { pubkey: 'trader', signer: true, writable: true },
      { pubkey: 'route', signer: false, writable: true },
      { pubkey: 'pool', signer: false, writable: true },
    ] } },
    meta: {
      err: null,
      logMessages: ['Program log: Instruction: Buy'],
      preBalances: [10e9, 100e9, 50e9],
      postBalances: [(10 + signerDeltaSol) * 1e9, (100 - routeOutSol) * 1e9, (50 + poolInSol) * 1e9],
      preTokenBalances: [{ owner: 'trader', mint: 'meme', uiTokenAmount: { uiAmount: 0 } }],
      postTokenBalances: [{ owner: 'trader', mint: 'meme', uiTokenAmount: { uiAmount: tokenDelta } }],
    },
  };
}

test('routed swap price uses dominant SOL flow instead of the signer fee delta', () => {
  const event = parseTrade(routedBuy({ signerDeltaSol: -0.007, routeOutSol: 0.727, poolInSol: 0.711, tokenDelta: 9_303_026 }), 'routed');
  assert.equal(event.priceSource, 'dominant-lamport-flow');
  assert.ok(Math.abs(event.solVolume - 0.711) < 1e-9);
  assert.ok(event.priceSol > 7e-8 && event.priceSol < 8e-8);
});

test('direct swap retains the ordinary payer-to-pool SOL amount', () => {
  const event = parseTrade(routedBuy({ signerDeltaSol: -1.01, routeOutSol: 0, poolInSol: 1, tokenDelta: 5_000_000 }), 'direct');
  assert.ok(Math.abs(event.solVolume - 1) < 1e-9);
  assert.ok(Math.abs(event.priceSol - 2e-7) < 1e-15);
});
