import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { LocalControlBridge, controlState, typedCommand } from '../extension/local-control.js';
import { LocalControl } from '../lib/local-control.mjs';
import { createHelper } from '../server.mjs';

const now = 1_800_000_000_000;
const command = (extra = {}) => ({ id: 'command-1', requestId: 'request-1', action: 'send', params: { text: 'hello there' },
  generation: 'generation-1', state: 'running', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString(), ...extra });
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the browser accepts only exact typed, current commands and safe reviewed text', () => {
  assert.ok(typedCommand(command(), now));
  for (const change of [{ action: 'authorize' }, { id: 123 }, { generation: 123 }, { state: 'queued' }, { params: { text: 'hello', token: 'secret' } },
    { params: { text: '/ban alice' } }, { params: { text: 'https://example.com' } }, { params: { text: 'hello\nthere' } },
    { params: { text: ' hello' } }, { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 90_001).toISOString() },
    { action: 'settings', params: { chatMode: 'mentions', replySource: 'local', autoResume: true, account: 'someone_else' } },
    { action: 'start', params: { channel: 'https://example.com', chatMode: 'mentions', replySource: 'local', autoResume: true } }]) {
    assert.equal(typedCommand(command(change), now), null, JSON.stringify(change));
  }
});

test('the browser state boundary removes credentials, private Chrome identifiers and unbounded objects', () => {
  const raw = { settings: { account: 'companion_test', pairingToken: 'pairing-secret-value', clientId: 'client-secret-value',
    allowedChannel: 'friend_channel', paused: false, autoReply: true },
    watch: { enabled: true, tabId: 7, sessionId: 'browser-session-secret', documentId: 'private-document', error: 'pairing-secret-value' },
    chat: { account: 'companion_test', connected: true, messages: Array.from({ length: 150 }, (_, i) => ({ id: String(i), author: 'alice', text: 'hello', at: now, credentials: 'private-oauth' })),
      coordination: { available: true, token: 'host-secret', accounts: ['companion_test'] } },
    drops: { enabled: true, tabId: 9, permit: 'secret-permit', history: [{ id: 'claim-1', name: 'reward', key: 'private-key', delivery: 'confirmed', at: now }] },
    activity: { state: 'waiting', reason: 'client-secret-value' }, credentials: { accessToken: 'private-oauth' }, apiKey: 'private-api-key' };
  const state = controlState(raw), text = JSON.stringify(state);
  assert.deepEqual(state.chat.messages, []); assert.deepEqual(state.sent, []);
  for (const hidden of ['pairingToken', 'clientId', 'tabId', 'sessionId', 'documentId', 'credentials', 'apiKey', 'permit', 'private-key',
    'pairing-secret-value', 'client-secret-value', 'private-oauth', 'host-secret']) assert.equal(text.includes(hidden), false, hidden);
  assert.equal(state.watch.error, '[redacted]'); assert.equal(state.activity.reason, '[redacted]');
});

test('multibyte busy-chat snapshots leave enough space under the helper60k request cap for completion', () => {
  const long = '界'.repeat(600);
  const state = controlState({ settings: { account: 'companion_test' }, chat: { messages: Array.from({ length: 120 }, () => ({ text: long })) },
    sent: Array.from({ length: 100 }, () => ({ text: long })), drops: { history: Array.from({ length: 100 }, () => ({ id: long, name: long, reason: long, delivery: 'confirmed', at: now })) },
    watch: { error: long }, activity: { reason: long }, streamContext: { title: long, gameName: long }, coordination: { reason: long } });
  const body = { sessionId: 's'.repeat(160), controlGeneration: 'g'.repeat(160), state,
    completion: { id: 'c'.repeat(160), generation: 'g'.repeat(160), state: 'completed', result: { ok: true, text: '界'.repeat(4000), reason: '界'.repeat(300) } } };
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 32_000);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 60_000);
});

test('lost completion responses retry the same outcome without re-executing a command', async t => {
  let executed = 0, drop = true; const delivered = [];
  const broker = new LocalControl({ twitch: { status: () => ({ account: 'companion_test' }) }, now: () => now });
  const bridge = new LocalControlBridge({ sessionId: 'browser-1', now: () => now, state: async () => ({}), execute: async () => { executed++; return { ok: true, text: 'reviewed draft' }; },
    transport: async input => { if (input.completion) delivered.push(input.completion); const result = broker.bridge(input);
      if (input.completion && drop) { drop = false; throw Error('response lost after completion'); } return result; } });
  t.after(() => bridge.close()); await bridge.poll();
  const queued = broker.command({ requestId: 'draft-request', action: 'draft', params: { mode: 'reply' } });
  await bridge.poll(); await flush(); await bridge.poll(); await flush(); await bridge.poll();
  assert.equal(executed, 1); assert.equal(broker.status().controls.recent.find(x => x.id === queued.command.id).state, 'completed');
  assert.ok(delivered.length >= 2); assert.deepEqual(delivered[0], delivered[1]);
});

test('a newer Stop fences a slow command and a changed worker never replays its send', async t => {
  let release, executed = 0;
  const broker = new LocalControl({ twitch: { status: () => ({ account: 'companion_test' }), disconnect() {} }, now: () => now });
  const bridge = new LocalControlBridge({ sessionId: 'browser-old', now: () => now, state: async () => ({}),
    transport: async input => broker.bridge(input), execute: async (command, check) => { if (command.action === 'stop') return { ok: true };
      await new Promise(resolve => { release = resolve; }); check(); executed++; return { ok: true }; } });
  t.after(() => bridge.close()); await bridge.poll();
  const queued = broker.command({ requestId: 'manual-send', action: 'send', params: { text: 'reviewed message' } });
  await bridge.poll(); await flush(); assert.ok(release);
  broker.command({ requestId: 'stop-newer', action: 'stop', params: {} }); await bridge.poll();
  release(); await flush(); assert.equal(executed, 0);
  const replacement = new LocalControlBridge({ sessionId: 'browser-new', now: () => now, state: async () => ({}),
    transport: async input => broker.bridge(input), execute: async command => { if (command.action === 'send') executed++; } });
  t.after(() => replacement.close()); await replacement.poll(); await flush();
  assert.equal(broker.status().controls.recent.find(x => x.id === queued.command.id).state, 'cancelled'); assert.equal(executed, 0);
});

test('expired commands do not execute and polling survives a temporary outage', async t => {
  let time = now, online = false, executed = 0;
  const bridge = new LocalControlBridge({ now: () => time, state: async () => ({}), execute: async () => { executed++; },
    transport: async () => { if (!online) throw Error('offline'); return { ok: true, intent: { generation: 'generation-1', stopped: false }, command: command() }; } });
  t.after(() => bridge.close()); assert.equal(await bridge.poll(), false);
  time += 90_001; online = true; assert.equal(await bridge.poll(), true); await flush(); assert.equal(executed, 0);
});

test('the real paired helper accepts bridge state, executes one fenced send and retains the result after a lost response', async t => {
  let sends = 0, connected = true;
  const twitch = { status: () => ({ account: 'companion_test', authorized: true, connected, channel: 'friend_channel', messages: [], sent: [] }),
    coordinator: { currentPlan: (id, binding) => id === 'reviewed-central-plan' ? { planId: id, authorityEpoch: 'central-authority', source: 'manual', text: 'one reviewed message', binding } : null },
    disconnect() { connected = false; }, async send(input) { sends++; return { delivery: 'confirmed', text: input.text, messageId: 'provider-1' }; } };
  const config = { extensionId: 'extension-test', pairingToken: 'local-pairing-test-token' };
  const server = createHelper({ config, twitch, now: () => now }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = (path, input) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: {
      Host: '127.0.0.1:8796', Origin: `chrome-extension://${config.extensionId}`, Authorization: `Bearer ${config.pairingToken}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { const result = JSON.parse(text); res.statusCode === 200 ? resolve(result) : reject(Error(result.error)); });
    }); req.on('error', reject); req.end(JSON.stringify(input));
  });
  let bridge, loseCompletion = true;
  bridge = new LocalControlBridge({ now: () => now, sessionId: 'real-browser', state: async () => ({ settings: { account: 'companion_test', pairingToken: config.pairingToken, allowedChannel: 'friend_channel' } }),
    transport: async input => { const result = await request('/api/control/bridge', input); if (input.completion && loseCompletion) { loseCompletion = false; throw Error('lost completion response'); } return result; },
    execute: async (command, check) => { check(); const result = await request('/api/twitch/send', { account: 'companion_test', channel: 'friend_channel', text: command.params.text, ...bridge.binding(), controlCommandId: command.id, settingsRevision: 0, planId: 'reviewed-central-plan', authorityEpoch: 'central-authority', binding: { generation: bridge.binding().controlGeneration, sessionId: bridge.binding().controlSessionId, settingsRevision: 0 } });
      return { ok: result.delivery === 'confirmed', text: result.text, reason: 'Twitch confirmed the message.' }; } });
  t.after(async () => { bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await bridge.poll();
  const queued = await request('/api/control/command', { requestId: 'reviewed-once', action: 'send', params: { text: 'one reviewed message' } });
  await bridge.poll(); await flush(); await bridge.poll(); await flush(); await bridge.poll();
  const status = await request('/api/control/status', {});
  assert.equal(sends, 1); assert.equal(status.controls.recent.find(x => x.id === queued.command.id).state, 'completed');
  assert.equal(JSON.stringify(status).includes(config.pairingToken), false);
});
