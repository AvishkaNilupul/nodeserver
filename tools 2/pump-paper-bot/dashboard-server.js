const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { PaperEngine } = require('./lib/paper-engine');
const { PUMP_FUN_PROGRAM, rpc, parseTrade } = require('./lib/solana');
const { buildLeaderboard } = require('./lib/leaderboard');

const root = __dirname;
const port = Number(process.env.PUMP_DASHBOARD_PORT || 4177);
const httpUrl = process.env.PUMP_RPC_HTTP || 'https://solana-rpc.publicnode.com';
const wsUrl = process.env.PUMP_RPC_WS || 'wss://api.mainnet-beta.solana.com';
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const runsDir = path.join(root, 'runs');
const runId = `dashboard-${Date.now()}`;
const runDir = path.join(runsDir, runId);
const engine = new PaperEngine(config, runDir);
const tuningReportFile = path.join(runsDir, 'tuning-report.json');
const leaderboardFile = path.join(runsDir, 'leaderboard.json');
const heartbeatFile = path.join(runsDir, 'heartbeat.json');
const clients = new Set();
let activeLookups = 0;
const lookupQueue = [];
const queuedSignatures = new Set();
let observerSocket = null;
let reconnectTimer = null;
let tuningRunning = false;
const lookupConcurrency = Number(process.env.PUMP_LOOKUP_CONCURRENCY || 8);
const maxLookupQueue = Number(process.env.PUMP_LOOKUP_QUEUE || 500);
let leaderboard = buildLeaderboard(runsDir);
const state = {
  connected: false,
  startedAt: Date.now(),
  lastEventAt: null,
  lastError: null,
  eventsSeen: 0,
  candidates: 0,
  entries: 0,
  exits: 0,
  recentSignals: [],
  notificationsSeen: 0,
  tradeNotificationsSeen: 0,
  lookupsStarted: 0,
  lookupNullResults: 0,
  lookupThrottles: 0,
  decodedTrades: 0,
};
setInterval(() => {
  const before = engine.closed.length;
  engine.tick();
  if (engine.closed.length !== before) {
    state.exits = engine.closed.length;
    refreshLeaderboard();
    broadcast(snapshot());
  }
}, 1000).unref();

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function refreshLeaderboard() {
  leaderboard = buildLeaderboard(runsDir);
  writeJsonAtomic(leaderboardFile, leaderboard);
}

function writeHeartbeat() {
  writeJsonAtomic(heartbeatFile, {
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    runId,
    connected: state.connected,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    eventsSeen: state.eventsSeen,
    decodedTrades: state.decodedTrades,
    entries: state.entries,
    exits: state.exits,
    openPositions: engine.positions.size,
    summary: engine.summary(),
  });
}

function snapshot() {
  let tuning = null;
  try {
    const report = JSON.parse(fs.readFileSync(tuningReportFile, 'utf8'));
    tuning = {
      generatedAt: report.generatedAt,
      eventCount: report.eventCount,
      note: report.note,
      base: report.base,
      selected: report.selected,
    };
  } catch (_) { /* report is optional */ }
  return {
    type: 'state',
    now: Date.now(),
    state: { ...state, ...engine.summary() },
    positions: [...engine.positions.values()],
    trades: engine.closed.slice(-100).reverse(),
    signals: state.recentSignals,
    config,
    tuning,
    leaderboard,
    heartbeat: readJsonFile(heartbeatFile),
  };
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function refreshTuningReport() {
  if (tuningRunning) return;
  tuningRunning = true;
  const child = spawn(process.execPath, [path.join(root, 'tune.js')], { stdio: 'ignore' });
  child.on('close', () => {
    tuningRunning = false;
    broadcast(snapshot());
  });
  child.on('error', () => { tuningRunning = false; });
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
}

function observe(event) {
  state.eventsSeen += 1;
  state.lastEventAt = Date.now();
  state.recentSignals.unshift(event);
  state.recentSignals = state.recentSignals.slice(0, 40);
  const before = engine.positions.size;
  engine.onMarketEvent(event);
  const after = engine.positions.size;
  if (after > before) state.entries += after - before;
  if (engine.closed.length > state.exits) {
    state.exits = engine.closed.length;
    refreshLeaderboard();
  }
  broadcast({ ...snapshot(), type: 'event', event });
}

function startObserver() {
  if (observerSocket && (observerSocket.readyState === WebSocket.OPEN || observerSocket.readyState === WebSocket.CONNECTING)) return;
  const socket = new WebSocket(wsUrl);
  observerSocket = socket;
  let openedAt = 0;
  let lastNotificationAt = Date.now();
  const watchdog = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastNotificationAt < 30000) return;
    state.connected = false;
    state.lastError = 'Observer went quiet; reconnecting subscription';
    broadcast(snapshot());
    clearInterval(watchdog);
    socket.terminate();
  }, 10000);
  socket.on('open', () => {
    openedAt = Date.now();
    lastNotificationAt = Date.now();
    state.connected = true;
    state.lastError = null;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_FUN_PROGRAM] }, { commitment: 'confirmed' }] }));
    broadcast(snapshot());
  });
  socket.on('message', async (raw) => {
    lastNotificationAt = Date.now();
    try {
      const message = JSON.parse(raw.toString());
      if (message.id === 1 && message.result) {
        state.lastError = null;
        broadcast(snapshot());
        return;
      }
      const signature = message.params?.result?.value?.signature;
      if (!signature || message.params?.result?.value?.err) return;
      state.notificationsSeen += 1;
      const logs = message.params.result.value.logs || [];
      if (!logs.some((line) => line.includes('Instruction: Buy') || line.includes('Instruction: Sell'))) return;
      state.tradeNotificationsSeen += 1;
      if (queuedSignatures.has(signature)) return;
      queuedSignatures.add(signature);
      lookupQueue.push(signature);
      while (lookupQueue.length > maxLookupQueue) queuedSignatures.delete(lookupQueue.shift());
      drainLookupQueue();
    } catch (error) {
      state.lastError = error.message;
      broadcast(snapshot());
    }
  });
  socket.on('close', () => {
    clearInterval(watchdog);
    observerSocket = null;
    state.connected = false;
    state.lastError = 'RPC observer disconnected; retrying in 3 seconds';
    broadcast(snapshot());
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startObserver(); }, 3000);
    reconnectTimer.unref();
  });
  socket.on('error', (error) => {
    state.connected = false;
    state.lastError = error.message;
    broadcast(snapshot());
  });
}

async function drainLookupQueue() {
  while (activeLookups < lookupConcurrency && lookupQueue.length) processLookup(lookupQueue.shift());
}

async function processLookup(signature) {
  activeLookups += 1;
  state.lookupsStarted += 1;
  try {
    let transaction = null;
    // logsSubscribe can beat the HTTP indexer by a few seconds. Keep the
    // signature queued briefly instead of permanently dropping a null result.
    for (let attempt = 0; attempt < 9 && !transaction; attempt += 1) {
      transaction = await rpc(httpUrl, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!transaction && attempt < 8) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    if (!transaction) state.lookupNullResults += 1;
    const event = parseTrade(transaction, signature);
    if (event) {
      state.decodedTrades += 1;
      observe(event);
    }
    state.lastError = null;
  } catch (error) {
    if (error.message.includes('Too many requests')) state.lookupThrottles += 1;
    state.lastError = error.message.includes('Too many requests') ? 'Public RPC is throttling lookups; set PUMP_RPC_HTTP for a dedicated endpoint' : error.message;
    broadcast(snapshot());
    if (error.message.includes('Too many requests')) await new Promise((resolve) => setTimeout(resolve, 1200));
  } finally {
    activeLookups -= 1;
    queuedSignatures.delete(signature);
    setImmediate(drainLookupQueue);
  }
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/state') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(snapshot()));
    return;
  }
  if (request.url === '/api/config') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(config));
    return;
  }
  const requested = request.url === '/' ? '/dashboard.html' : request.url;
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    response.writeHead(404); response.end('Not found'); return;
  }
  const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(file));
});

const wss = new WebSocket.Server({ server, path: '/stream' });
wss.on('connection', (client) => { clients.add(client); client.send(JSON.stringify(snapshot())); client.on('close', () => clients.delete(client)); });

server.listen(port, '127.0.0.1', () => {
  console.log(`Pump paper dashboard: http://127.0.0.1:${port}`);
  startObserver();
  refreshLeaderboard();
  writeHeartbeat();
  setInterval(writeHeartbeat, 15000).unref();
  setInterval(refreshLeaderboard, 30000).unref();
  setTimeout(refreshTuningReport, 15000).unref();
  setInterval(refreshTuningReport, 10 * 60 * 1000).unref();
});

module.exports = { server, engine, state, snapshot };
