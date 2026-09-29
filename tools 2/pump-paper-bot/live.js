const WebSocket = require('ws');
const { PaperEngine } = require('./lib/paper-engine');
const { PUMP_FUN_PROGRAM, rpc, parseTrade } = require('./lib/solana');
const path = require('node:path');

async function live(config) {
  const http = process.env.PUMP_RPC_HTTP || 'https://api.mainnet-beta.solana.com';
  const wsUrl = process.env.PUMP_RPC_WS || 'wss://api.mainnet-beta.solana.com';
  const engine = new PaperEngine(config, path.join(__dirname, 'runs', `live-${Date.now()}`));
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_FUN_PROGRAM] }, { commitment: 'confirmed' }] })));
  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const signature = message.params?.result?.value?.signature;
      if (!signature || message.params?.result?.value?.err) return;
      const tx = await rpc(http, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const event = parseTrade(tx, signature);
      if (event) {
        engine.onMarketEvent(event);
        process.stdout.write(`${JSON.stringify({ ...event, summary: engine.summary() })}\n`);
      }
    } catch (error) { process.stderr.write(`observer error: ${error.message}\n`); }
  });
  ws.on('close', () => process.stderr.write('observer disconnected\n'));
  process.on('SIGINT', () => { ws.close(); console.log(JSON.stringify(engine.summary(), null, 2)); });
}

module.exports = { live };
