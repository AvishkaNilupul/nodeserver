import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsTransport } from '../lib/usa-transport.mjs';
import { UsaBrowserRelay } from '../extension/usa-transport.js';
import { TRACE_URL } from '../extension/usa-policy.js';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';
import { installDirectorFixture } from './director-fixture.mjs';

const credentials = { clientId: 'testclient1234', account: 'companion_test', userId: '123', accessToken: 'test-only-access', refreshToken: 'test-only-refresh', scopes: chatScopes };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.fail('Bounded synthetic roundtrip did not complete.'); }
function harness(t, { country = 'US', trace, network } = {}) {
  const helper = createUsTransport(), calls = [], sockets = [], operations = []; let number = 0;
  class BrowserSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, wasClean: true })); }
    send(data) { this.lastSent = data; }
  }
  const browser = new UsaBrowserRelay({
    settings: async () => ({ account: credentials.account, pairingToken: 'synthetic-pairing-only' }), access: async () => true,
    sessionId: () => `synthetic-browser-${String(++number).padStart(4, '0')}`,
    post: async (path, input) => { operations.push({ action: path.split('/').at(-1), id: input.id }); return helper[path.split('/').at(-1)](input); },
    WebSocketImpl: BrowserSocket,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === TRACE_URL) return trace ? trace() : new Response(`ip=203.0.113.1\nloc=${country}\n`);
      if (network) return network(url, options);
      if (url.endsWith('/validate')) return response({ client_id: credentials.clientId, login: credentials.account, user_id: credentials.userId, scopes: chatScopes });
      if (url.includes('/users?')) return response({ data: [{ id: '456', login: 'friend_channel' }] });
      if (url.endsWith('/eventsub/subscriptions')) return response({ data: [{ status: 'enabled' }] });
      if (url.includes('/shared_chat/session?')) return response({ data: [] });
      if (url.endsWith('/chat/messages')) return response({ data: [{ is_sent: true, message_id: 'confirmed-before-transfer' }] });
      return response({ device_code: 'test-only-device', user_code: 'ABCD', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
    }
  });
  const twitch = new TwitchChat({ credentials: structuredClone(credentials), fetchImpl: helper.fetch, WebSocketImpl: helper.WebSocket, transport: helper });
  helper.bind({ getGeneration: () => twitch.generation });
  t.after(() => { browser.stop(); twitch.disconnect(); helper.close(); });
  async function tick() { await browser.tick(); await flush(); }
  return { helper, browser, twitch, calls, sockets, operations, tick };
}

test('real helper and browser modules relay OAuth and EventSub without Node provider traffic', async t => {
  const h = harness(t); await h.tick(); await h.tick();
  const authorization = h.twitch.startAuthorization(credentials.clientId, credentials.account); let auth;
  authorization.then(value => { auth = value; });
  for (let i = 0; i < 20 && !auth; i++) await h.tick();
  assert.equal((await authorization).userCode, 'ABCD');
  assert.equal(h.calls.filter(row => row.url.endsWith('/device')).length, 1);
  const deviceCall = h.calls.find(row => row.url.endsWith('/device'));
  assert.equal(deviceCall.options.credentials, 'omit'); assert.equal(deviceCall.options.redirect, 'error');
  // A real reconnect creates a new exact allowed browser socket, never Node WSS.
  const socket = new h.helper.WebSocket('wss://eventsub.wss.twitch.tv/ws?session=reconnect');
  for (let i = 0; i < 10 && socket.readyState === 0; i++) await h.tick();
  await until(() => socket.readyState === 1);
  assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].url, socket.url);
  let messages = 0; socket.addEventListener('message', event => { assert.equal(event.data, 'test-event'); messages++; });
  h.sockets[0].dispatchEvent(new MessageEvent('message', { data: 'test-event' })); await until(() => messages === 1);
  assert.equal(h.operations.filter(row => row.action === 'begin' && row.id === h.operations.find(row => row.action === 'begin').id).length, 1);
  for (const row of h.calls.filter(row => row.url !== TRACE_URL)) assert.equal(row.options.cache, 'no-store');
});

test('real USA relay transfers an official root reconnect without resubscription or replay', async t => {
  const h = harness(t); installDirectorFixture(h.twitch);
  async function pumpUntil(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await h.tick();
    assert.ok(predicate(), 'Synthetic root reconnect did not settle.');
  }
  async function drive(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await pumpUntil(() => settled); return promise;
  }
  const emit = (socket, type, payload) => socket.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ metadata: { message_type: type, message_timestamp: new Date().toISOString() }, payload })
  }));
  await h.tick(); await h.tick();
  await drive(h.twitch.connect(credentials.account, 'friend_channel'));
  await pumpUntil(() => h.sockets.length === 1 && h.sockets[0].readyState === 1);
  const old = h.sockets[0];
  emit(old, 'session_welcome', { session: { id: 'initial-session', keepalive_timeout_seconds: 10 } });
  await pumpUntil(() => h.twitch.connected);
  const input = { account: credentials.account, channel: 'friend_channel', text: 'a distinct pre-transfer reply' };
  assert.equal((await drive(h.twitch.send(input))).delivery, 'confirmed');
  const generation = h.twitch.generation;
  const raw = 'wss://eventsub.wss.twitch.tv?session_id=opaque&token=abc%2Bdef&x=1';
  const reconnect = { session: { reconnect_url: raw } };
  emit(old, 'session_reconnect', reconnect); emit(old, 'session_reconnect', reconnect);
  await pumpUntil(() => h.sockets.length === 2 && h.sockets[1].readyState === 1);
  const replacement = h.sockets[1];
  assert.equal(replacement.url, new URL(raw).href);
  assert.equal(old.readyState, 1); assert.equal(h.twitch.connected, true);
  emit(replacement, 'session_welcome', { session: { id: 'replacement-session', keepalive_timeout_seconds: 10 } });
  await pumpUntil(() => old.readyState === 3);
  old.dispatchEvent(Object.assign(new Event('close'), { code: 4004, wasClean: true }));
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.twitch.generation, generation); assert.equal(h.twitch.connected, true);
  assert.equal(h.helper.status().sockets, 1); assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.calls.filter(row => row.url.endsWith('/eventsub/subscriptions')).map(row => JSON.parse(row.options.body).type), ['channel.chat.message', 'channel.chat.notification']);
  assert.equal(h.calls.filter(row => row.url.endsWith('/chat/messages')).length, 1);
  await assert.rejects(h.twitch.send(input));
  assert.equal(h.calls.filter(row => row.url.endsWith('/chat/messages')).length, 1);
  assert.equal(h.twitch.history.length, 1); assert.equal(h.twitch.history[0].delivery, 'confirmed');
});

test('non-USA browser proof retires work and never dispatches an authenticated request', async t => {
  const h = harness(t, { country: 'CA' }); await h.tick();
  const operation = h.helper.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth test-only-secret' } }); operation.catch(() => {});
  await h.tick(); await h.tick();
  await assert.rejects(operation, error => error.notSubmitted === true);
  assert.equal(h.calls.filter(row => row.url !== TRACE_URL).length, 0);
});

test('Stop during fresh browser attestation prevents actual OAuth dispatch', async t => {
  let release, stall = false;
  const h = harness(t, { trace: () => stall ? new Promise(resolve => { release = () => resolve(new Response('ip=203.0.113.1\nloc=US\n')); }) : new Response('ip=203.0.113.1\nloc=US\n') });
  await h.tick(); await h.tick(); stall = true;
  const operation = h.helper.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth test-only-secret' } }); operation.catch(() => {});
  await h.tick(); await until(() => !!release);
  h.twitch.disconnect(); release(); await flush(); await h.tick();
  await assert.rejects(operation, error => error.notSubmitted === true);
  assert.equal(h.calls.filter(row => row.url !== TRACE_URL).length, 0);
});

test('lost successful BEGIN response never dispatches the operation or retries BEGIN', async t => {
  const h = harness(t); await h.tick(); await h.tick();
  const original = h.browser.post; let lost;
  h.browser.post = async (path, input, settings) => { const result = await original(path, input, settings); if (path.endsWith('/begin')) { lost = input.id; throw Error('synthetic ACK loss'); } return result; };
  const operation = h.helper.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth test-only-secret' } }); operation.catch(() => {});
  await h.tick(); await until(() => !!lost); await h.tick();
  await assert.rejects(operation, error => error.notSubmitted === false);
  assert.equal(h.operations.filter(row => row.action === 'begin' && row.id === lost).length, 1);
  assert.equal(h.calls.filter(row => row.url !== TRACE_URL).length, 0);
});

test('paired heartbeat restores a 1006 receive socket under the posting hold without a new Start', async t => {
  const h = harness(t);
  h.twitch.coordinator = { snapshot: () => ({ available: true, paused: true }) };
  const { createHelper } = await import('../server.mjs');
  const http = await import('node:http');
  const server = createHelper({ config: { extensionId: 'fixture-browser', pairingToken: 'fixture-pair' }, twitch: h.twitch, usaTransport: h.helper });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { Host: '127.0.0.1:8797', Origin: 'chrome-extension://fixture-browser', Authorization: 'Bearer fixture-pair', 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', part => { data += part; }); res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error(data)); resolve(JSON.parse(data));
      });
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const pump = async check => {
    for (let n = 0; n < 200 && !check(); n++) await h.tick();
    assert.ok(check(), 'Synthetic USA relay did not settle');
  };
  const welcome = (socket, name) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    metadata: { message_type: 'session_welcome' }, payload: { session: { id: name, keepalive_timeout_seconds: 10 } }
  }) }));
  const account = credentials.account, channel = 'friend_channel', sessionId = 'receive-browser-session';
  const state = { account, settings: { allowedChannel: channel, paused: false, autoReply: true, autoResume: false, revision: 2 },
    watch: { channel, enabled: true, status: 'playing' } };
  const { intent } = await post('/api/control/bridge', { sessionId });
  const binding = { controlGeneration: intent.generation, controlSessionId: sessionId };
  const heartbeat = () => post('/api/control/bridge', { sessionId, controlGeneration: intent.generation, state });
  await h.tick();
  const connected = h.twitch.connect(account, channel); await pump(() => h.sockets.length === 1); await connected;
  welcome(h.sockets[0], 'first-session'); await pump(() => h.twitch.eventFeed.status === 'enabled');
  await heartbeat();
  h.sockets[0].readyState = 3;
  h.sockets[0].dispatchEvent(Object.assign(new Event('close'), { code: 1006, wasClean: false }));
  await pump(() => !h.twitch.connected);
  assert.equal(h.helper.status().lastSocketClose.code, 1006);
  const statusReader = h.helper.status;
  await pump(() => statusReader().state === 'ready');
  for (const invalidProof of [{ checkedAt: Date.now() - 60_000 }, { country: 'CA' }]) {
    h.helper.status = () => ({ ...statusReader(), ...invalidProof });
    await heartbeat(); await h.tick();
    assert.equal((await post('/api/control/status', {})).recovery.state, 'held');
    assert.equal(h.sockets.length, 1);
  }
  h.helper.status = statusReader;
  await heartbeat(); await pump(() => h.sockets.length === 2);
  const legacyAlarm = await post('/api/twitch/connect', { account, channel, ...binding });
  assert.equal(legacyAlarm.connecting, true);
  await heartbeat();
  welcome(h.sockets[1], 'second-session'); await pump(() => h.twitch.eventFeed.status === 'enabled');
  await heartbeat();
  const status = await post('/api/control/status', {});
  assert.equal(status.connected, true); assert.equal(status.coordination.paused, true);
  assert.equal(status.recovery.state, 'recovered'); assert.ok(status.recovery.lastAttemptAt > 0);
  assert.equal(status.recovery.nextAttemptAt, 0); assert.equal(h.sockets.length, 2);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('losing the US lease between a successful lookup and receive socket creation is recoverable', async t => {
  const h = harness(t);
  h.twitch.ensureIdentity = async () => {};
  h.twitch.api = async () => ({ data: [{ login: 'friend_channel', id: '456' }] });
  // The preceding lookup succeeded, but there is no longer a paired relay
  // lease at the WebSocket constructor. No provider operation can be queued.
  await assert.rejects(h.twitch.connect(credentials.account, 'friend_channel'), { code: 'usa_transport_held' });
  assert.equal(h.sockets.length, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.twitch.status().recoverable, true);
  await h.tick(); await h.tick(); await h.twitch.connect(credentials.account, 'friend_channel');
  for (let n = 0; n < 30 && h.sockets.length === 0; n++) await h.tick();
  assert.equal(h.sockets.length, 1);
});
