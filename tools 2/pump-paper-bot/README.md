# Pump paper bot

This is a research-only prototype for studying the wallet pattern discussed in this thread. It observes public Solana/Pump.fun activity and records simulated orders. It does **not** load private keys, create a signer, submit transactions, or spend SOL.

## Run

```bash
node tools/pump-paper-bot/dashboard-server.js
node tools/pump-paper-bot/index.js replay /path/to/events.jsonl
node tools/pump-paper-bot/index.js live
node tools/pump-paper-bot/tune.js
node --test tools/pump-paper-bot/test/*.test.js
```

Open `http://127.0.0.1:4177` for the live local dashboard.

`live` uses the public Solana WebSocket/RPC endpoints by default. Set `PUMP_RPC_HTTP` and `PUMP_RPC_WS` to use a provider with better rate limits. The live observer writes `paper-trades.jsonl` and `market-events.jsonl` in this directory.

The replay format is one JSON object per line:

```json
{"type":"market","time":1787747872,"mint":"...pump","action":"buy","priceSol":0.0000001,"solVolume":0.42,"trader":"...","tokenAgeSec":8}
```

The filter is deliberately configurable and conservative. It is an approximation of the observed behavior, not a claim that it is the target wallet's private filter. Tune it only with out-of-sample data.

`tune.js` deduplicates saved dashboard events, trains candidate parameters on the oldest 70%, and validates them on the newest 30%. It never edits `config.json` automatically. A candidate is reported only when it remains profitable on the held-out slice after the configured execution costs.

Each run also writes `run-meta.json`, `decisions.jsonl`, `market-events.jsonl`, and `paper-orders.jsonl`. Decisions include the filter features and the reason a buy was accepted or rejected, so future tuning can inspect both wins and missed entries. The default paper wallet starts with 2 SOL. Entry/exit fees, slippage, and a fixed network fee are deducted from simulated accounting.

The default live observer is read-only. It parses confirmed Pump.fun transactions from the stream; it does not reconstruct every pool price tick, so use replay with decoded swap events for realistic exit-path testing.
