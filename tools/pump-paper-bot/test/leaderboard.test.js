const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLeaderboard } = require('../lib/leaderboard');

test('leaderboard includes only corrected comparable runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-leaderboard-'));
  const good = path.join(root, 'dashboard-good');
  const old = path.join(root, 'dashboard-old');
  fs.mkdirSync(good); fs.mkdirSync(old);
  const comparableConfig = { startingCapitalSol: 2, execution: { entryFeeBps: 40, exitFeeBps: 40, entrySlippageBps: 50, exitSlippageBps: 50 }, filter: { maxPriceDeviationRatio: 0.65 } };
  fs.writeFileSync(path.join(good, 'run-meta.json'), JSON.stringify({ startedAt: '2026-01-01T00:00:00.000Z', config: comparableConfig }));
  fs.writeFileSync(path.join(good, 'paper-orders.jsonl'), [
    JSON.stringify({ type: 'exit', mint: 'winner', pnlSol: 0.1, totalFeesSol: 0.01 }),
    JSON.stringify({ type: 'exit', mint: 'loser', pnlSol: -0.04, totalFeesSol: 0.01 }),
  ].join('\n'));
  fs.writeFileSync(path.join(old, 'run-meta.json'), JSON.stringify({ startedAt: '2025-01-01T00:00:00.000Z', config: { startingCapitalSol: 10 } }));
  fs.writeFileSync(path.join(old, 'paper-orders.jsonl'), JSON.stringify({ type: 'exit', mint: 'fake', pnlSol: 22 }));
  const result = buildLeaderboard(root);
  assert.equal(result.tradeCount, 2);
  assert.equal(result.totalPnlSol, 0.06);
  assert.equal(result.bestHits[0].mint, 'winner');
  assert.equal(result.topTokens.some((row) => row.mint === 'fake'), false);
});
