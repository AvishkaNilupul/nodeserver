const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(12));
}

function isComparableRun(meta) {
  const config = meta?.config || {};
  const execution = config.execution || {};
  return (config.startingCapitalSol ?? meta?.startingCapitalSol) === 2
    && Number.isFinite(execution.entryFeeBps)
    && Number.isFinite(execution.exitFeeBps)
    && Number.isFinite(execution.entrySlippageBps)
    && Number.isFinite(execution.exitSlippageBps)
    && Number.isFinite(config.filter?.maxPriceDeviationRatio);
}

function buildLeaderboard(runsDir) {
  const trades = [];
  let earliestStartedAt = null;
  let runCount = 0;
  for (const runId of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    if (!runId.startsWith('dashboard-')) continue;
    const dir = path.join(runsDir, runId);
    const meta = readJson(path.join(dir, 'run-meta.json'));
    if (!isComparableRun(meta)) continue;
    runCount += 1;
    if (meta.startedAt && (!earliestStartedAt || meta.startedAt < earliestStartedAt)) earliestStartedAt = meta.startedAt;
    for (const order of readJsonLines(path.join(dir, 'paper-orders.jsonl'))) {
      if (order.type !== 'exit') continue;
      trades.push({ ...order, runId });
    }
  }

  const tokenMap = new Map();
  for (const trade of trades) {
    const row = tokenMap.get(trade.mint) || { mint: trade.mint, trades: 0, wins: 0, netPnlSol: 0, feesSol: 0, bestTradeSol: -Infinity, worstTradeSol: Infinity };
    row.trades += 1;
    if (trade.pnlSol > 0) row.wins += 1;
    row.netPnlSol = rounded(row.netPnlSol + (trade.pnlSol || 0));
    row.feesSol = rounded(row.feesSol + (trade.totalFeesSol || 0));
    row.bestTradeSol = Math.max(row.bestTradeSol, trade.pnlSol || 0);
    row.worstTradeSol = Math.min(row.worstTradeSol, trade.pnlSol || 0);
    tokenMap.set(trade.mint, row);
  }

  const totalPnlSol = rounded(trades.reduce((sum, trade) => sum + (trade.pnlSol || 0), 0));
  const totalFeesSol = rounded(trades.reduce((sum, trade) => sum + (trade.totalFeesSol || 0), 0));
  const wins = trades.filter((trade) => trade.pnlSol > 0).length;
  const tokens = [...tokenMap.values()].sort((a, b) => b.netPnlSol - a.netPnlSol);
  return {
    generatedAt: new Date().toISOString(),
    earliestStartedAt,
    runCount,
    tradeCount: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnlSol,
    totalFeesSol,
    bestHits: trades.slice().sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 10),
    worstHits: trades.slice().sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 5),
    topTokens: tokens.slice(0, 10),
  };
}

module.exports = { buildLeaderboard, isComparableRun, readJsonLines };
