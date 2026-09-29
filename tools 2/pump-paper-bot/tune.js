const fs = require('node:fs');
const path = require('node:path');
const { PaperEngine } = require('./lib/paper-engine');

const root = __dirname;
const runsDir = path.join(root, 'runs');
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

function readEvents() {
  const seen = new Set();
  const events = [];
  for (const dir of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    if (!dir.startsWith('dashboard-')) continue;
    const file = path.join(runsDir, dir, 'market-events.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const key = event.signature || `${event.time}:${event.mint}:${event.action}:${event.trader}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.sort((a, b) => a.time - b.time || (a.slot || 0) - (b.slot || 0));
}

function mergeConfig(overrides) {
  return {
    ...baseConfig,
    ...overrides,
    execution: { ...baseConfig.execution, ...(overrides.execution || {}) },
    filter: { ...baseConfig.filter, ...(overrides.filter || {}) },
    exit: { ...baseConfig.exit, ...(overrides.exit || {}) },
  };
}

function replay(events, config) {
  const engine = new PaperEngine(config, null);
  let peak = config.paperCapitalSol;
  let maxDrawdown = 0;
  for (const event of events) {
    engine.onMarketEvent(event);
    const equity = config.paperCapitalSol + engine.summary().totalPnlSol;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  if (events.length) engine.tick(events[events.length - 1].time + config.exit.hardTimeoutSec + 1);
  const summary = engine.summary();
  return {
    ...summary,
    trades: summary.closed,
    maxDrawdownSol: maxDrawdown,
    expectancySol: summary.closed ? summary.realizedSol / summary.closed : 0,
  };
}

function candidates() {
  const output = [];
  for (const minRecentBuys of [3, 4, 5]) {
    for (const minUniqueBuyers of [2, 3, 4]) {
      for (const minRecentBuyVolumeSol of [0.8, 1.2, 1.8]) {
        for (const takeProfitBps of [300, 450, 650]) {
          for (const stopLossBps of [600, 800, 1000]) {
            output.push({ filter: { minRecentBuys, minUniqueBuyers, minRecentBuyVolumeSol }, exit: { takeProfitBps, stopLossBps } });
          }
        }
      }
    }
  }
  return output;
}

function rank(result) {
  if (result.trades < 5) return -Infinity;
  return result.realizedSol - 1.5 * result.maxDrawdownSol + Math.min(result.trades, 20) * 0.001;
}

function main() {
  const events = readEvents();
  if (events.length < 100) throw new Error(`Need at least 100 historical events; found ${events.length}`);
  const split = Math.floor(events.length * 0.7);
  const train = events.slice(0, split);
  const test = events.slice(split);
  const evaluated = candidates().map((overrides) => {
    const config = mergeConfig(overrides);
    return { overrides, train: replay(train, config), test: replay(test, config) };
  }).filter((row) => Number.isFinite(rank(row.train)))
    .sort((a, b) => rank(b.train) - rank(a.train));
  const robust = evaluated.find((row) => row.train.trades >= 5
    && row.test.trades >= 3
    && row.train.realizedSol > 0.05
    && row.test.realizedSol > 0.05
    && row.test.maxDrawdownSol <= Math.max(0.1, row.train.maxDrawdownSol * 1.5));
  const report = {
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    trainEventCount: train.length,
    testEventCount: test.length,
    base: { train: replay(train, baseConfig), test: replay(test, baseConfig) },
    selected: robust || null,
    topTrainingCandidates: evaluated.slice(0, 10),
    note: robust ? 'Candidate passed the held-out minimums. Review it before changing config.json.' : 'No candidate passed held-out validation; keep collecting paper data.',
  };
  const output = path.join(root, 'runs', 'tuning-report.json');
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = { readEvents, mergeConfig, replay, rank };
