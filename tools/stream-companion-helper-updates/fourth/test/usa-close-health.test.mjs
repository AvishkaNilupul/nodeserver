import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsTransport } from '../lib/usa-transport.mjs';
import { createUsaHealthLogger } from '../lib/usa-health-log.mjs';
import { TwitchChat } from '../lib/twitch.mjs';
const NOW = 1_800_000_000_000, SESSION = 'synthetic-browser-session';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let at = NOW, epoch;
  const relay = createUsTransport({ now: () => at }); t.after(() => relay.close());
  const proof = () => ({ ip: '203.0.113.17', loc: 'US', checkedAt: at });
  const poll = () => { const result = relay.poll({ sessionId: SESSION, ...(epoch ? { epoch } : {}), proof: proof() }); epoch = result.epoch; return result; };
  const completeOpen = socket => {
    const job = poll().job; assert.equal(job.socketId, socket.socketId);
    relay.begin({ sessionId: SESSION, epoch, id: job.id, proof: proof() }); relay.complete({ sessionId: SESSION, epoch, id: job.id, result: { ok: true } });
    relay.event({ sessionId: SESSION, epoch, socketId: job.socketId, seq: 1, event: { type: 'open' } }); return socket;
  };
  const open = () => completeOpen(new relay.WebSocket('wss://eventsub.wss.twitch.tv/ws'));
  const browserClose = (socket, code = 4005, wasClean = false) => relay.event({ sessionId: SESSION, epoch, socketId: socket.socketId, seq: 2, event: { type: 'close', code, wasClean } });
  poll(); return { relay, poll, open, completeOpen, browserClose, advance: value => { at += value; }, now: () => at };
}

test('browser close is cached before callbacks and generic Twitch disconnect cannot overwrite it during cascading cleanup', async t => {
  const f = fixture(t), client = new TwitchChat({ transport: f.relay, WebSocketImpl: f.relay.WebSocket, now: f.now,
    setTimer: () => ({ unref() {} }), clearTimer: () => {}, credentials: { account: 'synthetic_companion' } });
  f.relay.bind({ getGeneration: () => client.generation }); client.connected = true;
  client.openSocket('wss://eventsub.wss.twitch.tv/ws', client.generation);
  const first = f.completeOpen([...client.sockets][0]);
  client.openSocket('wss://eventsub.wss.twitch.tv/ws?reconnect_token=fixture', client.generation, first);
  const second = f.completeOpen([...client.sockets][1]);
  let seen;
  first.addEventListener('close', () => { seen = f.relay.status().lastSocketClose; });
  f.browserClose(first, 4005, false);
  assert.deepEqual(f.relay.status().lastSocketClose, { source: 'browser-close', at: NOW, code: 4005, wasClean: false });
  await flush(); assert.equal(client.connected, false); assert.equal(client.error, 'Twitch chat disconnected.'); assert.equal(second.readyState, 3);
  assert.deepEqual(seen, { source: 'browser-close', at: NOW, code: 4005, wasClean: false });
  assert.deepEqual(f.relay.status().lastSocketClose, seen);
  f.relay.invalidate(); assert.deepEqual(f.relay.status().lastSocketClose, seen);
});

test('first proof-expiry and lease-expiry causes survive callback invalidation and later reconnect', async t => {
  for (const [elapsed, source] of [[5001, 'proof-expiry'], [15001, 'lease-expiry']]) {
    const f = fixture(t), socket = f.open(); socket.addEventListener('close', () => f.relay.invalidate());
    f.advance(elapsed); const close = f.relay.status().lastSocketClose;
    assert.deepEqual(close, { source, at: NOW + elapsed, code: 1006, wasClean: false }); await flush();
    assert.deepEqual(f.relay.status().lastSocketClose, close); f.poll(); f.open();
    assert.deepEqual(f.relay.status().lastSocketClose, close); f.relay.close();
  }
});

test('a later independent browser close replaces old cached metadata, and status returns a defensive copy', async t => {
  const f = fixture(t), first = f.open(); f.browserClose(first, 4000, true); await flush();
  f.advance(1000); const second = f.open(); f.browserClose(second, 4006, false); await flush();
  const value = f.relay.status().lastSocketClose;
  assert.deepEqual(value, { source: 'browser-close', at: NOW + 1000, code: 4006, wasClean: false });
  value.source = 'private-override'; assert.equal(f.relay.status().lastSocketClose.source, 'browser-close');
});

test('local reset records one initiating cause across multiple sockets without IDs or URL/reason data', async t => {
  const f = fixture(t); f.open(); f.open(); f.relay.invalidate('Bearer private-reason'); await flush();
  assert.deepEqual(f.relay.status().lastSocketClose, { source: 'local-reset', at: NOW, code: 1006, wasClean: false });
  assert.deepEqual(Object.keys(f.relay.status().lastSocketClose).sort(), ['source', 'at', 'code', 'wasClean'].sort());
});

test('durable health rows retain recovered short close events and whitelist all close metadata', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'fourth-close-health-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let at = NOW, value = { state: 'ready', countryRequired: 'US', country: 'US', browserOnline: true, checkedAt: NOW, pending: 0, sockets: 1 };
  const logger = createUsaHealthLogger({ transport: { status: () => value }, directory: root, now: () => at, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  logger.start(); at += 5000; value = { ...value, checkedAt: at, lastSocketClose: { source: 'proof-expiry', at: at - 250, code: 1006, wasClean: false,
    url: 'https://private.example', reason: 'Bearer secret-reason', ip: '203.0.113.19', socketId: 'private-id' } }; logger.sample();
  const rows = () => fs.readFileSync(join(root, 'usa-health.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows().at(-1).event, 'transition'); assert.equal(rows().at(-1).state, 'ready');
  assert.deepEqual(rows().at(-1).lastSocketClose, { source: 'proof-expiry', at: NOW + 4750, code: 1006, wasClean: false });
  assert.doesNotMatch(JSON.stringify(rows()), /private|secret-reason|203\.0\.113\.19/);
  at += 1000; value = { ...value, checkedAt: at, lastSocketClose: { source: 'Bearer secret', at, code: Infinity, wasClean: 'private' } }; logger.sample();
  assert.deepEqual(rows().at(-1).lastSocketClose, { source: 'unknown', at, code: null, wasClean: null });
  at += 1000; value = { ...value, checkedAt: at, lastSocketClose: { source: 'browser-close', at: at + 1, code: 4005, wasClean: true } }; logger.sample();
  assert.equal(rows().at(-1).lastSocketClose, null); logger.close();
});
