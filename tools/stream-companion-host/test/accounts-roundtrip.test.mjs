import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createHelper } from '../../stream-companion/server.mjs';
import { createHelper as createSecondHelper } from '../../stream-companion-test/server.mjs';
import { createAccountManager } from '../lib/accounts.mjs';
import { createHostServer } from '../server.mjs';
import { HostStore } from '../lib/store.mjs';

test('real public host to two authenticated helpers routes Start and interrupting Stop to only the chosen account', async t => {
  let time = 1800000000000;
  const configs = [{ extensionId: 'a'.repeat(32), pairingToken: 'a'.repeat(48) }, { extensionId: 'b'.repeat(32), pairingToken: 'b'.repeat(48) }];
  const clients = [{ id: 'primary', account: 'first_account', token: 'a'.repeat(48) }, { id: 'test', account: 'second_account', token: 'b'.repeat(48) }];
  const twitches = clients.map(c => ({ connected: false, channel: '', sends: 0,
    status() { return { authorized: true, connected: this.connected, channel: this.channel, account: c.account, messages: [], sent: [], coordination: { available: true, paused: false } }; },
    disconnect() { this.connected = false; this.channel = ''; },
    async connect(account, channel) { assert.equal(account, c.account); this.connected = true; this.channel = channel; return { ok: true }; },
    async send() { this.sends++; return { delivery: 'confirmed', messageId: 'simulated-only' }; }
  }));
  const helpers = [createHelper({ config: configs[0], twitch: twitches[0], now: () => time }), createSecondHelper({ config: configs[1], twitch: twitches[1], now: () => time })];
  let store, host;
  t.after(async () => { const servers = [host, ...helpers].filter(server => server?.listening); for (const server of servers) server.closeAllConnections(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); store?.close(); });
  for (const server of helpers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  // Fixed-port production helpers validate Host. Use native HTTP in this test
  // adapter because Fetch rewrites Host when targeting ephemeral fixture ports.
  const fixtureFetch = (url, options) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method, headers: options.headers, signal: options.signal }, res => {
      const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
  const call = async (i, path, body) => {
    const response = await fixtureFetch(`http://127.0.0.1:${helpers[i].address().port}${path}`, { method: 'POST', headers: {
      Host: `127.0.0.1:${8792 + i}`, Origin: `chrome-extension://${configs[i].extensionId}`, Authorization: `Bearer ${configs[i].pairingToken}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const state = i => ({ settings: { account: clients[i].account, allowedChannel: 'live_channel', paused: !twitches[i].connected,
    autoReply: twitches[i].connected, autoResume: false, chatMode: 'participate', replySource: 'local' }, permissions: { playbackAccess: true },
    watch: { enabled: twitches[i].connected, status: 'playing', channel: 'live_channel', checkedAt: time } });
  for (const i of [0, 1]) {
    const first = await call(i, '/api/control/bridge', { sessionId: `browser-${i}` });
    await call(i, '/api/control/bridge', { sessionId: `browser-${i}`, controlGeneration: first.data.intent.generation, state: state(i) });
  }
  const accounts = createAccountManager({ sources: [{ id: 'primary', configPath: '0' }, { id: 'test', configPath: '1' }], now: () => time,
    readFileImpl: async path => JSON.stringify(configs[Number(path)]), fetchImpl: (url, options) => {
      const original = new URL(url), index = original.port === '8792' ? 0 : 1;
      return fixtureFetch(`http://127.0.0.1:${helpers[index].address().port}${original.pathname}`, { ...options, headers: { ...options.headers, Host: original.host } });
    } });
  store = new HostStore({ file: ':memory:', clients, now: () => time });
  host = createHostServer({ store, clients, accounts, port: 0, csrfToken: 'fixture-csrf' });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const publicCall = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${host.address().port}${path}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  const initial = await publicCall('/api/accounts'); assert.equal(initial.instances.every(x => x.browser.online), true);
  const start = await publicCall('/api/accounts/test/command', { requestId: 'start-selected', action: 'start', params: { channel: 'live_channel', chatMode: 'participate', replySource: 'local', autoResume: false } });
  assert.equal(start.command.state, 'queued'); assert.equal(twitches[0].connected, false);
  const claimed = (await call(1, '/api/control/bridge', { sessionId: 'browser-1' })).data;
  assert.equal(claimed.command.id, start.command.id);
  const binding = { controlGeneration: claimed.intent.generation, controlSessionId: 'browser-1' };
  assert.equal((await call(1, '/api/twitch/disconnect', { ...binding, disarmOnly: true })).status, 200);
  assert.equal((await call(1, '/api/twitch/connect', { ...binding, account: 'second_account', channel: 'live_channel' })).status, 200);
  await call(1, '/api/control/bridge', { sessionId: 'browser-1', controlGeneration: claimed.intent.generation, state: state(1),
    completion: { id: start.command.id, generation: claimed.intent.generation, state: 'completed', result: { ok: true } } });
  time += 2000;
  const running = await publicCall('/api/accounts');
  assert.equal(running.instances[0].connected, false); assert.equal(running.instances[1].connected, true);
  assert.equal(running.instances[1].settings.autoReply, true); assert.equal(running.instances[1].controls.pending, null);
  const stopped = await publicCall('/api/accounts/test/command', { requestId: 'stop-selected', action: 'stop', params: {} });
  assert.equal(stopped.command.state, 'queued'); assert.equal(twitches[1].connected, false, 'helper stops immediately, before the browser polls');
  const staleSend = await call(1, '/api/twitch/send', { ...binding, account: 'second_account', channel: 'live_channel', text: 'never sent' });
  assert.equal(staleSend.status, 409); assert.equal(twitches[1].sends, 0);
  const stopClaim = (await call(1, '/api/control/bridge', { sessionId: 'browser-1' })).data;
  assert.equal(stopClaim.command.action, 'stop');
  await call(1, '/api/control/bridge', { sessionId: 'browser-1', controlGeneration: stopClaim.intent.generation, state: state(1),
    completion: { id: stopped.command.id, generation: stopClaim.intent.generation, state: 'completed', result: { ok: true } } });
  time += 2000;
  const final = await publicCall('/api/accounts'); assert.equal(final.instances[1].settings.paused, true); assert.equal(final.instances[1].controls.pending, null);
  const rendered = JSON.stringify(final); for (const config of configs) for (const value of Object.values(config)) assert.equal(rendered.includes(value), false);
  assert.equal(rendered.includes(claimed.intent.generation), false);
});
