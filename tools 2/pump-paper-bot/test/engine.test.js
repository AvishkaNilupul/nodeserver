const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PaperEngine } = require('../lib/paper-engine');
const config = JSON.parse(JSON.stringify(require('../config.json')));
config.filter.minRecentBuyVolumeSol = 0.8;
config.filter.minMedianBuySol = 0;
config.filter.maxLargestBuyShare = 1;
config.filter.minBuySellVolumeRatio = 0;
config.execution = { entryFeeBps: 0, exitFeeBps: 0, entrySlippageBps: 0, exitSlippageBps: 0, networkFeeSol: 0 };

test('paper engine records a recovery exit without spending funds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-paper-'));
  const engine = new PaperEngine(config, dir);
  const base = { type: 'market', mint: 'demo', tokenVolume: 1 };
  for (let i = 0; i < 3; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `b${i}` });
  engine.onMarketEvent({ ...base, trader: 'buyer-3', time: 5, action: 'buy', solVolume: 0.4, priceSol: 0.96, signature: 'down' });
  engine.onMarketEvent({ ...base, trader: 'buyer-4', time: 8, action: 'buy', solVolume: 0.4, priceSol: 1.001, signature: 'recover' });
  assert.equal(engine.closed.length, 1);
  assert.equal(engine.closed[0].reason, 'recovery');
  assert.ok(fs.readFileSync(path.join(dir, 'paper-orders.jsonl'), 'utf8').includes('entry'));
});

test('paper engine times out a quiet position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-paper-timeout-'));
  const timeoutConfig = JSON.parse(JSON.stringify(config));
  timeoutConfig.exit.hardTimeoutSec = 5;
  const engine = new PaperEngine(timeoutConfig, dir);
  const base = { type: 'market', mint: 'quiet', tokenVolume: 1 };
  for (let i = 0; i < 4; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `b${i}` });
  engine.tick(10);
  assert.equal(engine.closed.length, 1);
  assert.equal(engine.closed[0].reason, 'hard-timeout');
});

test('paper engine applies execution costs and per-token cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-paper-costs-'));
  const costConfig = JSON.parse(JSON.stringify(config));
  costConfig.cooldownSec = 20;
  costConfig.maxEntriesPerMint = 2;
  costConfig.execution = { entryFeeBps: 100, exitFeeBps: 100, entrySlippageBps: 0, exitSlippageBps: 0, networkFeeSol: 0 };
  const engine = new PaperEngine(costConfig, dir);
  const base = { type: 'market', mint: 'cost-demo', tokenVolume: 1 };
  for (let i = 0; i < 3; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `b${i}` });
  engine.onMarketEvent({ ...base, trader: 'buyer-3', time: 4, action: 'buy', solVolume: 0.4, priceSol: 1.06, signature: 'profit' });
  assert.equal(engine.closed.length, 1);
  assert.ok(engine.closed[0].pnlSol < engine.closed[0].grossPnlSol);
  for (let i = 5; i < 9; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `cool-${i}` });
  assert.equal(engine.positions.size, 0);
});

test('paper engine limits repeated entries for the same mint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-paper-repeat-'));
  const repeatConfig = JSON.parse(JSON.stringify(config));
  repeatConfig.cooldownSec = 0;
  repeatConfig.maxEntriesPerMint = 1;
  const engine = new PaperEngine(repeatConfig, dir);
  const base = { type: 'market', mint: 'once-only', tokenVolume: 1 };
  for (let i = 0; i < 3; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `first-${i}` });
  engine.onMarketEvent({ ...base, trader: 'buyer-3', time: 4, action: 'buy', solVolume: 0.4, priceSol: 1.04, signature: 'close' });
  for (let i = 10; i < 14; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `second-${i}` });
  assert.equal(engine.closed.length, 1);
  assert.equal(engine.positions.size, 0);
});

test('paper engine starts with the configured two SOL limit and logs decisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-paper-logger-'));
  const limitedConfig = JSON.parse(JSON.stringify(config));
  limitedConfig.paperCapitalSol = 2;
  limitedConfig.startingCapitalSol = 2;
  limitedConfig.execution = { entryFeeBps: 100, exitFeeBps: 100, entrySlippageBps: 100, exitSlippageBps: 100, networkFeeSol: 0.001 };
  const engine = new PaperEngine(limitedConfig, dir);
  const base = { type: 'market', mint: 'limited', tokenVolume: 1 };
  for (let i = 0; i < 3; i++) engine.onMarketEvent({ ...base, trader: `buyer-${i}`, time: i, action: 'buy', solVolume: 0.4, priceSol: 1, signature: `b${i}` });
  assert.equal(engine.summary().startingCapitalSol, 2);
  assert.ok(fs.existsSync(path.join(dir, 'decisions.jsonl')));
  assert.ok(fs.existsSync(path.join(dir, 'run-meta.json')));
  assert.ok(engine.positions.size <= 1);
});
