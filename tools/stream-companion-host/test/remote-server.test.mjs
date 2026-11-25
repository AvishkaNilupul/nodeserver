import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostStore } from '../lib/store.mjs';
import { validateCommand } from '../lib/accounts.mjs';
import { createHostServer, loadRemoteToken, REMOTE_PREFIX } from '../server.mjs';

const clients = [{ id: 'primary', account: 'first_account', token: 'a'.repeat(48) },
  { id: 'test', account: 'second_account', token: 'b'.repeat(48) }];
const remoteToken = 'remote-controller-test-pairing-not-real-1234567890';
const local = { Origin: 'http://127.0.0.1:8795', 'Sec-Fetch-Site': 'same-origin' };
const remote = { ...local, Authorization: `Bearer ${remoteToken}` };
const mutation = { ...remote, 'X-CSRF-Token': 'host-only-csrf' };
const prefixed = path => `${REMOTE_PREFIX}${path}`;

async function harness(t, options = {}) {
  const store = new HostStore({ file: ':memory:', clients });
  const calls = { snapshots: 0, commands: [], assets: [], sync: 0, channels: [], browsers: [] };
  const sync = store.sync.bind(store); store.sync = (...args) => { calls.sync++; return sync(...args); };
  const accounts = {
    async snapshot() { calls.snapshots++; return { updatedAt: new Date().toISOString(), instances: [] }; },
    async command(id, body) { const input = validateCommand(body); calls.commands.push({ id, input });
      return { ok: true, command: { id: 'accepted-command', requestId: input.requestId, action: input.action, state: 'queued' } }; }
  };
  const channels = {
    async snapshot() { calls.channels.push('directory'); return { updatedAt: new Date().toISOString(), channels: [{ login: 'aviskarex', isLive: false }] }; },
    async lookup(login) { calls.channels.push(login); return { login, isLive: true }; }
  };
  const browserLauncher = { available: id => ['primary', 'test'].includes(id),
    async open(id, requestId) { calls.browsers.push({ id, requestId }); return { ok: true, state: 'opening' }; } };
  const server = createHostServer({ store, clients, accounts, channels, browserLauncher, remoteToken, csrfToken: 'host-only-csrf',
    readFileImpl: async file => { calls.assets.push(file.pathname);
      return Buffer.from(file.pathname.endsWith('.html')
        ? '<link href="__COMPANION_BASE__/style.css"><a href="__COMPANION_BASE__/accounts">Accounts</a>'
        : 'export const marker="__COMPANION_BASE__";'); }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, { method = 'GET', body, rawBody, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: '127.0.0.1:8795', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, headers: res.headers, data }); });
    }); req.on('error', reject); req.end(payload);
  });
  return { request, store, calls };
}

test('remote pairing loader accepts only the exact bounded optional config and never reveals its contents', async () => {
  assert.equal(await loadRemoteToken({ readFileImpl: async () => JSON.stringify({ token: remoteToken }) }), remoteToken);
  assert.equal(await loadRemoteToken({ readFileImpl: async () => { throw Object.assign(Error('private path'), { code: 'ENOENT' }); } }), undefined);
  for (const text of ['not-json-with-private-content', 'null', '[]', '{}', JSON.stringify({ token: 123 }),
    JSON.stringify({ token: 'short-secret' }), JSON.stringify({ token: remoteToken, upstream: 'http://elsewhere' }),
    JSON.stringify({ token: `${remoteToken} whitespace` }), ' '.repeat(4097)]) {
    await assert.rejects(loadRemoteToken({ readFileImpl: async () => text }), error => {
      assert.equal(error.message, 'Remote controller pairing is invalid.');
      assert.equal(error.message.includes(remoteToken), false); return true;
    });
  }
  await assert.rejects(loadRemoteToken({ readFileImpl: async () => { throw Error(remoteToken); } }), /^Error: Remote controller pairing is invalid\.$/);
});

test('remote pairing cannot reuse either coordination token or accept malformed values', () => {
  const store = new HostStore({ file: ':memory:', clients });
  try {
    for (const token of [null, '', 'short', 'bad token'.repeat(8), clients[0].token, clients[1].token]) {
      assert.throws(() => createHostServer({ store, clients, remoteToken: token }), /pairing must be valid and separate/);
    }
  } finally { store.close(); }
});

test('missing remote pairing disables the entire prefix while root and internal routes retain compatibility', async t => {
  const { request } = await harness(t, { remoteToken: undefined });
  for (const path of ['/', '/accounts', '/controller-path.js', '/api/status', '/api/accounts', '/api/channels', '/api/channels/aviskarex']) {
    assert.equal((await request(prefixed(path), { headers: remote })).status, 404, path);
  }
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/status', { headers: local })).status, 200);
  const result = await request('/internal/sync', { method: 'POST', body: { connected: false, channel: '', ready: false },
    headers: { Authorization: `Bearer ${clients[0].token}`, 'X-Companion-Id': 'primary' } });
  assert.equal(result.status, 200);
});

test('every remote asset and API requires its separate bearer and remote credentials cannot impersonate a helper', async t => {
  const { request, calls } = await harness(t);
  for (const path of ['/', '/accounts', '/app.js', '/accounts.js', '/controller-path.js', '/api/status', '/api/accounts', '/api/channels', '/api/channels/aviskarex']) {
    for (const authorization of [undefined, 'Bearer wrong-pairing', `Bearer ${clients[0].token}`, `Bearer ${clients[1].token}`]) {
      const headers = { ...local, ...(authorization ? { Authorization: authorization } : {}) };
      assert.equal((await request(prefixed(path), { headers })).status, 403, path);
    }
  }
  assert.equal(calls.assets.length, 0); assert.equal(calls.snapshots, 0); assert.equal(calls.channels.length, 0);
  const result = await request('/internal/sync', { method: 'POST', body: {}, headers: { Authorization: `Bearer ${remoteToken}`, 'X-Companion-Id': 'primary' } });
  assert.equal(result.status, 403); assert.equal(calls.sync, 0);
});

test('HTML alone renders the trusted fixed base while scripts and strict security headers remain unchanged', async t => {
  const { request } = await harness(t);
  for (const path of ['/', '/accounts', '/accounts/primary', '/accounts/test']) {
    const root = await request(path), hosted = await request(prefixed(path), { headers: remote });
    assert.equal(root.status, 200); assert.equal(hosted.status, 200);
    assert.match(root.data, /href="\/accounts"/); assert.match(hosted.data, /href="\/admin\/stream-companion\/accounts"/);
    assert.equal(root.data.includes('__COMPANION_BASE__'), false); assert.equal(hosted.data.includes('__COMPANION_BASE__'), false);
    assert.equal(hosted.headers['content-security-policy'], root.headers['content-security-policy']);
    assert.match(hosted.headers['content-security-policy'], /base-uri 'none'.*frame-ancestors 'none'/);
    assert.equal(hosted.headers['x-frame-options'], 'DENY'); assert.equal(hosted.headers['cache-control'], 'no-store');
    assert.equal(hosted.headers['access-control-allow-origin'], undefined);
    for (const hidden of [remoteToken, ...clients.map(x => x.token)]) assert.equal(hosted.data.includes(hidden), false);
  }
  for (const path of ['/app.js', '/style.css', '/accounts.js', '/accounts.css', '/controller-path.js']) {
    const asset = await request(prefixed(path), { headers: remote });
    assert.equal(asset.status, 200); assert.equal(asset.data, 'export const marker="__COMPANION_BASE__";');
  }
});

test('remote status and mutations retain local canonical origin and host CSRF checks', async t => {
  const { request, calls, store } = await harness(t);
  for (const headers of [{ Authorization: remote.Authorization }, { ...remote, Origin: 'https://public.example' },
    { ...remote, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(prefixed('/api/accounts'), { headers })).status, 403);
  }
  assert.equal(calls.snapshots, 0);
  const accountState = await request(prefixed('/api/accounts'), { headers: remote });
  assert.equal(accountState.status, 200); assert.equal(accountState.data.csrfToken, 'host-only-csrf');
  const hostState = await request(prefixed('/api/status'), { headers: remote });
  assert.equal(hostState.status, 200);
  for (const hidden of [remoteToken, ...clients.map(x => x.token)]) assert.equal(JSON.stringify([accountState.data, hostState.data]).includes(hidden), false);
  for (const headers of [remote, { ...mutation, 'X-CSRF-Token': 'outside-session-csrf' },
    { ...mutation, Origin: 'https://public.example' }, { ...mutation, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(prefixed('/api/control'), { method: 'POST', body: { paused: true }, headers })).status, 403);
    assert.equal((await request(prefixed('/api/accounts/primary/command'), { method: 'POST', body: { requestId: 'stop-1', action: 'stop', params: {} }, headers })).status, 403);
  }
  assert.equal(store.paused, false); assert.equal(calls.commands.length, 0);
  assert.equal((await request(prefixed('/api/control'), { method: 'POST', body: { paused: true }, headers: mutation })).status, 200);
  assert.equal(store.paused, true);
});

test('only literal prefixed public paths are reachable, including under traversal and query spellings', async t => {
  const { request, calls } = await harness(t);
  const paths = ['', '/health', '/internal/sync', '/internal/reserve', '/internal/begin', '/internal/finish', '/private/remote.json',
    '/server.mjs', '/api/proxy', '/api/accounts/foreign/command', '/accounts/primary/', '/accounts/%70rimary',
    '/accounts/../api/status', '/../internal/sync', '/%2e%2e/internal/sync', '/%2Finternal/sync', '//api/status',
    '/api/status?x=1', '/app.js?base=elsewhere', '/api/accounts%2fprimary%2fcommand', '/accounts\\primary',
    '/api/channels/ab', '/api/channels/aviskarex?x=1', '/api/channels/%61viskarex', '/api/channels/aviskarex/', '/api/channels/aviskarex/extra'];
  for (const path of paths) assert.equal((await request(prefixed(path), { headers: remote })).status, 404, path);
  for (const path of ['/admin/%73tream-companion/api/status', '//admin/stream-companion/api/status',
    'http://127.0.0.1:8795/admin/stream-companion/api/status']) {
    assert.equal((await request(path, { headers: remote })).status, 404, path);
  }
  assert.equal(calls.assets.length, 0); assert.equal(calls.snapshots, 0); assert.equal(calls.commands.length, 0); assert.equal(calls.sync, 0);
});

test('channel directory and exact lookup are read-only, paired and same-origin in root and remote routes', async t => {
  const { request, calls, store } = await harness(t);
  const before = store.paused;
  for (const prefix of ['', REMOTE_PREFIX]) {
    const headers = prefix ? remote : local;
    const denied = await request(prefix + '/api/channels', { headers: prefix ? { Authorization: remote.Authorization } : {} });
    assert.equal(denied.status, 403);
    const directory = await request(prefix + '/api/channels', { headers });
    assert.equal(directory.status, 200); assert.equal(directory.data.channels[0].login, 'aviskarex');
    assert.equal(directory.data.channels[0].isLive, false); assert.equal(directory.data.csrfToken, 'host-only-csrf');
    const lookup = await request(prefix + '/api/channels/live_friend', { headers });
    assert.equal(lookup.status, 200); assert.equal(lookup.data.channels[0].login, 'live_friend');
    assert.equal(lookup.data.channels[0].isLive, true);
    assert.equal((await request(prefix + '/api/channels/live_friend', { method: 'POST', body: {}, headers })).status, 405);
  }
  assert.deepEqual(calls.channels, ['directory', 'live_friend', 'directory', 'live_friend']);
  assert.equal(calls.commands.length, 0); assert.equal(store.paused, before);
});

test('only explicit paired CSRF browser requests launch the fixed selected account and never start chat', async t => {
  const { request, calls, store } = await harness(t, { accounts: { snapshot: async () => ({ updatedAt: new Date().toISOString(), instances: [{ id: 'primary', browser: { online: false } }] }) } });
  for (const prefix of ['', REMOTE_PREFIX]) {
    const headers = prefix ? remote : local;
    const state = await request(prefix + '/api/accounts', { headers });
    assert.equal(state.data.instances[0].browser.canOpen, true);
    assert.equal(state.data.instances[0].browser.online, false);
    assert.equal(calls.browsers.length, prefix ? 1 : 0, 'reads must never launch a browser');
    const path = prefix + '/api/accounts/test/browser';
    assert.equal((await request(path, { headers })).status, 405);
    for (const invalidHeaders of [headers, { ...headers, 'X-CSRF-Token': 'wrong' }, { ...mutation, Origin: 'https://foreign.example' }]) {
      assert.equal((await request(path, { method: 'POST', body: { requestId: 'open-test' }, headers: invalidHeaders })).status, 403);
    }
    for (const body of [{ requestId: 'x', profile: 'Default' }, { requestId: 'x', url: 'https://outside.example' }, {}, { requestId: '../unsafe' }]) {
      assert.equal((await request(path, { method: 'POST', body, headers: mutation })).status, 400);
    }
    const result = await request(path, { method: 'POST', body: { requestId: 'open-test' }, headers: mutation });
    assert.equal(result.status, 200); assert.deepEqual(result.data, { ok: true, state: 'opening' });
  }
  assert.deepEqual(calls.browsers, [{ id: 'test', requestId: 'open-test' }, { id: 'test', requestId: 'open-test' }]);
  assert.equal(calls.commands.length, 0); assert.equal(calls.sync, 0); assert.equal(store.paused, false);
});

test('unsupported methods and upgrade headers never reach a prefixed public action', async t => {
  const { request, calls, store } = await harness(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']) {
    assert.equal((await request(prefixed('/accounts'), { method, headers: mutation })).status, 405, method);
  }
  assert.equal((await request(prefixed('/api/control'), { headers: mutation })).status, 405);
  assert.equal((await request(prefixed('/api/status'), { method: 'POST', body: {}, headers: mutation })).status, 405);
  assert.equal((await request(prefixed('/api/accounts'), { headers: { ...remote, Upgrade: 'websocket' } })).status, 405);
  assert.equal(store.paused, false); assert.equal(calls.snapshots, 0); assert.equal(calls.commands.length, 0);
});

test('prefixed JSON requests enforce type, UTF8 byte bound, exact controls and typed account parameters', async t => {
  const { request, calls, store } = await harness(t), path = prefixed('/api/control');
  for (const body of [[], null, {}, { paused: true, exchangesEnabled: true }, { paused: 'true' }]) {
    assert.equal((await request(path, { method: 'POST', body, headers: mutation })).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(path, { method: 'POST', rawBody: '{bad', headers: mutation })).status, 400);
  assert.equal((await request(path, { method: 'POST', body: { paused: true }, headers: { ...mutation, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(path, { method: 'POST', body: { text: '界'.repeat(24000) }, headers: mutation })).status, 413);
  const commandPath = prefixed('/api/accounts/test/command');
  assert.equal((await request(commandPath, { method: 'POST', body: { requestId: 'bad-settings', action: 'settings', params: { account: 'other_account' } }, headers: mutation })).status, 400);
  assert.equal(store.paused, false); assert.equal(calls.commands.length, 0);
  const body = { requestId: 'remote-safe-settings', action: 'settings', params: { chatMode: 'mentions', replySource: 'local', autoResume: false } };
  const result = await request(commandPath, { method: 'POST', body, headers: mutation });
  assert.equal(result.status, 200); assert.equal(result.data.command.state, 'queued'); assert.deepEqual(calls.commands, [{ id: 'test', input: body }]);
});

test('the loopback Host gate and sanitized failures apply equally to the paired prefix', async t => {
  const { request, calls } = await harness(t, { accounts: { snapshot: async () => { throw Error(`Private failure ${remoteToken}`); } } });
  assert.equal((await request(prefixed('/api/accounts'), { headers: { ...remote, Host: 'outside.example' } })).status, 403);
  assert.equal(calls.snapshots, 0);
  const result = await request(prefixed('/api/accounts'), { headers: remote });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'The coordination host is temporarily unavailable.');
  assert.equal(JSON.stringify(result.data).includes(remoteToken), false);
});
