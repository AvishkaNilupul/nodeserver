import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelper, savePrivate } from '../server.mjs';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

async function harness(t, overrides = {}) {
  const calls = [];
  const twitch = Object.fromEntries(['status', 'disconnect', 'startAuthorization', 'pollAuthorization', 'connect', 'send'].map(name => [name, (...args) => { calls.push({ name, args }); return { ok: true }; }]));
  Object.assign(twitch, overrides);
  const server = createHelper({ config: { extensionId: 'unit-test', pairingToken: 'local-test' }, twitch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, body = {}, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Host: '127.0.0.1:8793', Origin: 'chrome-extension://unit-test', Authorization: 'Bearer local-test', 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  return { request, calls };
}

test('all official-chat operations require the paired extension origin and token', async t => {
  const h = await harness(t);
  for (const path of ['/api/twitch/status', '/api/twitch/authorize', '/api/twitch/authorization', '/api/twitch/connect', '/api/twitch/send', '/api/twitch/disconnect']) {
    assert.equal((await h.request(path, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.request(path, {}, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await h.request(path, {}, { Host: 'evil.example' })).status, 403);
  }
  assert.equal(h.calls.length, 0);
});

test('paired status refreshes only its own coordinator presence before returning cached status', async t => {
  const order = [];
  const observation = { channel: 'friend_channel', paused: false, autoReply: true,
    playback: { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: Date.now() } };
  const h = await harness(t, { refreshCoordination: async value => { order.push('refresh'); assert.deepEqual(value, observation); },
    status: () => { order.push('status'); return { connected: true }; } });
  assert.equal((await h.request('/api/twitch/status', { observation })).status, 200);
  assert.deepEqual(order, ['refresh', 'status']);
});

test('helper dispatches chat-only actions and rejects legacy watch endpoints', async t => {
  const h = await harness(t);
  for (const path of ['/api/twitch/status', '/api/twitch/authorize', '/api/twitch/authorization', '/api/twitch/connect', '/api/twitch/disconnect']) assert.equal((await h.request(path, { account: 'companion_test', channel: 'friend_channel', clientId: 'testclient1234' })).status, 200);
  assert.deepEqual(h.calls.map(c => c.name), ['status', 'startAuthorization', 'pollAuthorization', 'connect', 'disconnect']);
  assert.equal((await h.request('/api/twitch/send', { text: 'unplanned message' })).status, 409);
  for (const path of ['/api/watch', '/api/follow', '/api/browser-input', '/api/player/open', '/api/player/close', '/api/player/state', '/api/player/stop']) assert.equal((await h.request(path)).status, 404);
});

test('private token writes are atomic, owner-only, and preserve exact credential characters', async t => {
  const dir = await mkdtemp(`${tmpdir()}/companion-test-`); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = pathToFileURL(`${dir}/oauth.json`);
  await savePrivate(file, { refreshToken: 'one-time+token%with&characters' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'one-time+token%with&characters');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await savePrivate(file, { refreshToken: 'rotated' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'rotated');
});

test('disconnect interrupts current work and invalidates requests queued before it', async t => {
  let release, sends = 0;
  const h = await harness(t, {
    connect: () => new Promise(resolve => { release = resolve; }),
    send: () => { sends++; return { ok: true }; }
  });
  const connecting = h.request('/api/twitch/connect');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const sending = h.request('/api/twitch/send', { text: 'hello' });
  // Let the queued request reach the server before disconnect.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.request('/api/twitch/disconnect')).status, 200);
  release({ connecting: true }); await connecting;
  assert.match((await sending).data.error, /cancelled/);
  assert.equal(sends, 0);
});
