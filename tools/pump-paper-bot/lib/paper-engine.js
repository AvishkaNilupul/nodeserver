const fs = require('node:fs');
const path = require('node:path');
const { MarketState } = require('./market-state');
const { shouldEnter } = require('./filter');

class PaperEngine {
  constructor(config, outputDir) {
    this.config = config;
    this.outputDir = outputDir;
    this.market = new MarketState(30);
    this.positions = new Map();
    this.closed = [];
    this.lastExitByMint = new Map();
    this.entryCountByMint = new Map();
    this.realizedSol = 0;
    this.paperCapitalSol = config.startingCapitalSol ?? config.paperCapitalSol;
    this.ordersFile = outputDir ? path.join(outputDir, 'paper-orders.jsonl') : null;
    this.eventsFile = outputDir ? path.join(outputDir, 'market-events.jsonl') : null;
    this.decisionsFile = outputDir ? path.join(outputDir, 'decisions.jsonl') : null;
    this.metaFile = outputDir ? path.join(outputDir, 'run-meta.json') : null;
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
    this.write(this.metaFile, {
      type: 'run-start',
      startedAt: new Date().toISOString(),
      startingCapitalSol: this.paperCapitalSol,
      config,
    });
  }

  write(file, value) {
    if (!file) return;
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  }

  logDecision(event, features, decision, gate = null) {
    this.write(this.decisionsFile, {
      type: 'decision',
      time: event.time,
      mint: event.mint,
      signature: event.signature,
      action: event.action,
      features,
      decision,
      gate,
      openPositions: this.positions.size,
      availableCapitalSol: this.paperCapitalSol,
    });
  }

  onMarketEvent(event) {
    this.write(this.eventsFile, event);
    const features = this.market.observe(event);
    if (!features) return;
    const current = this.positions.get(event.mint);
    if (current) return this.updatePosition(current, event, features);
    if (event.action !== 'buy' || !event.priceSol) return;
    if (this.positions.size >= this.config.maxOpenPositions) {
      this.logDecision(event, features, { enter: false, score: 0, reason: 'max-open-positions' }, 'capacity');
      return;
    }
    if ((this.entryCountByMint.get(event.mint) || 0) >= (this.config.maxEntriesPerMint || Infinity)) {
      this.logDecision(event, features, { enter: false, score: 0, reason: 'max-entries-per-mint' }, 'repeat-limit');
      return;
    }
    const lastExit = this.lastExitByMint.get(event.mint);
    if (lastExit != null && event.time - lastExit < (this.config.cooldownSec || 0)) {
      this.logDecision(event, features, { enter: false, score: 0, reason: 'cooldown' }, 'cooldown');
      return;
    }
    const decision = shouldEnter(features, this.config);
    const execution = this.config.execution || {};
    const entryFeeSol = this.config.entrySizeSol * (execution.entryFeeBps || 0) / 10000;
    const entryNetworkFeeSol = execution.networkFeeSol || 0;
    const entrySlippageBps = execution.entrySlippageBps || 0;
    const entryCostSol = entryFeeSol + entryNetworkFeeSol;
    this.logDecision(event, features, decision, decision.enter ? null : 'filter');
    if (!decision.enter) return;
    if (this.paperCapitalSol < this.config.entrySizeSol + entryCostSol) {
      this.logDecision(event, features, { enter: false, score: decision.score, reason: 'insufficient-capital' }, 'capital-limit');
      return;
    }
    const position = {
      mint: event.mint,
      entryTime: event.time,
      entrySlot: event.slot ?? null,
      entryPriceSol: event.priceSol * (1 + entrySlippageBps / 10000),
      entryMarketPriceSol: event.priceSol,
      sizeSol: this.config.entrySizeSol,
      entryCostSol,
      entryFeeSol,
      entryNetworkFeeSol,
      entrySlippageBps,
      peakPriceSol: event.priceSol,
      troughPriceSol: event.priceSol,
      lastPriceSol: event.priceSol,
      score: decision.score,
      entrySignature: event.signature,
    };
    this.paperCapitalSol -= position.sizeSol + position.entryCostSol;
    this.positions.set(event.mint, position);
    this.entryCountByMint.set(event.mint, (this.entryCountByMint.get(event.mint) || 0) + 1);
    this.write(this.ordersFile, { type: 'entry', ...position, reason: decision.reason });
  }

  updatePosition(position, event, features = {}) {
    if (!event.priceSol) return;
    const predatesEntry = event.time < position.entryTime
      || (event.time === position.entryTime
        && position.entrySlot != null
        && event.slot != null
        && event.slot < position.entrySlot);
    if (predatesEntry) {
      this.logDecision(event, features, { enter: false, score: position.score, reason: 'pre-entry-event' }, 'event-order');
      return;
    }
    const maxDeviation = this.config.filter?.maxPriceDeviationRatio;
    if (maxDeviation && features.referencePriceSol && features.priceDeviationRatio > maxDeviation) {
      this.logDecision(event, features, { enter: false, score: position.score, reason: 'price-outlier' }, 'price-quality');
      return;
    }
    position.lastPriceSol = event.priceSol;
    position.peakPriceSol = Math.max(position.peakPriceSol, event.priceSol);
    position.troughPriceSol = Math.min(position.troughPriceSol, event.priceSol);
    const age = event.time - position.entryTime;
    const changeBps = ((event.priceSol / position.entryPriceSol) - 1) * 10000;
    const drawdownBps = ((position.troughPriceSol / position.entryPriceSol) - 1) * 10000;
    const peakGainBps = ((position.peakPriceSol / position.entryPriceSol) - 1) * 10000;
    const dropFromPeakBps = ((event.priceSol / position.peakPriceSol) - 1) * 10000;
    const e = this.config.exit;
    let reason = null;
    if (changeBps >= e.takeProfitBps) reason = 'take-profit';
    else if (e.trailingActivateBps && peakGainBps >= e.trailingActivateBps && dropFromPeakBps <= -e.trailingStopBps) reason = 'trailing-stop';
    else if (drawdownBps <= -e.recoveryAfterDrawdownBps && changeBps >= -e.recoveryBps) reason = 'recovery';
    else if (changeBps <= -e.stopLossBps) reason = 'stop-loss';
    else if (age >= e.hardTimeoutSec) reason = 'hard-timeout';
    else if (age >= e.maxHoldSec && changeBps >= -e.recoveryBps) reason = 'max-hold-recovery';
    if (reason) this.closePosition(position, event, reason, changeBps);
  }

  tick(time = Math.floor(Date.now() / 1000)) {
    for (const position of [...this.positions.values()]) {
      const age = time - position.entryTime;
      const price = position.lastPriceSol || position.entryPriceSol;
      const changeBps = ((price / position.entryPriceSol) - 1) * 10000;
      if (age >= this.config.exit.hardTimeoutSec) {
        this.closePosition(position, { time, priceSol: price, signature: null }, 'hard-timeout', changeBps);
      } else if (age >= this.config.exit.maxHoldSec && changeBps >= -this.config.exit.recoveryBps) {
        this.closePosition(position, { time, priceSol: price, signature: null }, 'max-hold-recovery', changeBps);
      }
    }
  }

  closePosition(position, event, reason, changeBps) {
    const execution = this.config.execution || {};
    const exitFeeSol = position.sizeSol * (execution.exitFeeBps || 0) / 10000;
    const exitNetworkFeeSol = execution.networkFeeSol || 0;
    const exitSlippageBps = execution.exitSlippageBps || 0;
    const effectiveExitPriceSol = event.priceSol * (1 - exitSlippageBps / 10000);
    const effectiveChangeBps = ((effectiveExitPriceSol / position.entryPriceSol) - 1) * 10000;
    const effectiveGrossPnlSol = position.sizeSol * (effectiveChangeBps / 10000);
    const exitCostSol = exitFeeSol + exitNetworkFeeSol;
    const pnlSol = effectiveGrossPnlSol - (position.entryCostSol || 0) - exitCostSol;
    this.paperCapitalSol += position.sizeSol + effectiveGrossPnlSol - exitCostSol;
    this.realizedSol += pnlSol;
    const close = { type: 'exit', mint: position.mint, exitTime: event.time, exitPriceSol: effectiveExitPriceSol, marketExitPriceSol: event.priceSol, grossPnlSol: effectiveGrossPnlSol, entryCostSol: position.entryCostSol || 0, exitFeeSol, exitNetworkFeeSol, exitSlippageBps, exitCostSol, totalFeesSol: (position.entryCostSol || 0) + exitCostSol, totalSlippageBps: (position.entrySlippageBps || 0) + exitSlippageBps, pnlSol, holdSec: event.time - position.entryTime, reason, entrySignature: position.entrySignature, exitSignature: event.signature };
    this.closed.push(close);
    this.positions.delete(position.mint);
    this.lastExitByMint.set(position.mint, event.time);
    this.write(this.ordersFile, close);
  }

  summary() {
    const wins = this.closed.filter((item) => item.pnlSol > 0).length;
    const execution = this.config.execution || {};
    const unrealizedSol = [...this.positions.values()].reduce((sum, position) => {
      const markPrice = (position.lastPriceSol || position.entryMarketPriceSol || position.entryPriceSol) * (1 - (execution.exitSlippageBps || 0) / 10000);
      const gross = position.sizeSol * ((markPrice / position.entryPriceSol) - 1);
      const exitCosts = position.sizeSol * (execution.exitFeeBps || 0) / 10000 + (execution.networkFeeSol || 0);
      return sum + gross - (position.entryCostSol || 0) - exitCosts;
    }, 0);
    return { closed: this.closed.length, open: this.positions.size, wins, losses: this.closed.length - wins, winRate: this.closed.length ? wins / this.closed.length : 0, realizedSol: this.realizedSol, unrealizedSol, totalPnlSol: this.realizedSol + unrealizedSol, paperCapitalSol: this.paperCapitalSol, startingCapitalSol: this.config.startingCapitalSol ?? this.config.paperCapitalSol };
  }
}

module.exports = { PaperEngine };
