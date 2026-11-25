import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostStore } from '../lib/store.mjs';
import { createHostServer } from '../server.mjs';

const clients = [
  { id: 'primary', account: 'first_account', token: 'a'.repeat(48) },
  { id: 'test', account: 'second_account', token: 'b'.repeat(48) }
];
async function harness(t, { accounts } = {}) {
  const store = new HostStore({ file: ':memory:', clients });
  const server = createHostServer({ store, clients, accounts, csrfToken: 'test-csrf', readFileImpl: async () => Buffer.from('<html>local asset</html>') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: '127.0.0.1:8795', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, headers: res.headers, data }); });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { request, store };
}
const paired = { Authorization: `Bearer ${clients[0].token}`, 'X-Companion-Id': 'primary' };
const browser = { Origin: 'http://127.0.0.1:8795', 'Sec-Fetch-Site': 'same-origin' };

test('internal auth binds token to client/account and refuses browser origins', async t => {
  const { request } = await harness(t);
  for (const headers of [{}, { ...paired, 'X-Companion-Id': 'test' }, { ...paired, Origin: 'https://example.com' }, { ...paired, 'Sec-Fetch-Site': 'same-origin' }]) {
    assert.equal((await request('/internal/sync', { method: 'POST', body: {}, headers })).status, 403);
  }
  assert.equal((await request('/internal/sync', { method: 'POST', body: { account: 'second_account' }, headers: paired })).status, 403);
  assert.equal((await request('/internal/sync', { method: 'POST', body: { connected: false, channel: '', ready: false }, headers: paired })).status, 200);
});

test('browser status/control requires same-origin and CSRF, without exposing pairing credentials', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/api/status')).status, 403);
  assert.equal((await request('/api/status', { headers: { Origin: 'http://evil.example' } })).status, 403);
  const state = await request('/api/status', { headers: browser }); assert.equal(state.status, 200);
  assert.equal(state.data.csrfToken, 'test-csrf');
  for (const c of clients) assert.equal(JSON.stringify(state.data).includes(c.token), false);
  assert.equal((await request('/api/control', { method: 'POST', body: { paused: true }, headers: browser })).status, 403);
  assert.equal((await request('/api/control', { method: 'POST', body: { paused: true }, headers: { ...browser, 'X-CSRF-Token': 'test-csrf' } })).data.paused, true);
  assert.equal((await request('/api/status', { headers: browser })).data.paused, true);
});

test('static allowlist, host validation, JSON validation and security headers stay narrow', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/health', { headers: { Host: 'evil.example:8795' } })).status, 403);
  for (const path of ['/private/config.json', '/../private/config.json', '/server.mjs', '/api/proxy', '/app.js?remote=x']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/internal/sync', { method: 'POST', body: [], headers: paired })).status, 400);
  assert.equal((await request('/api/control', { method: 'POST', body: { paused: 'true' }, headers: { ...browser, 'X-CSRF-Token': 'test-csrf' } })).status, 400);
  const page = await request('/'); assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/); assert.equal(page.headers['access-control-allow-origin'], undefined);
});

test('concurrent authenticated proposals receive one permit and permit begin is single-use', async t => {
  const { request } = await harness(t); const at = Date.now(), channel = 'friend_channel';
  const headers = clients.map(c => ({ Authorization: `Bearer ${c.token}`, 'X-Companion-Id': c.id }));
  for (const h of headers) await request('/internal/sync', { method: 'POST', body: { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: at } }, headers: h });
  const proposals = [{ requestId: 'proposal-a', kind: 'topic', streamId: '123', textKey: 'aaaaaaaaaaaaaaaa', channel }, { requestId: 'proposal-b', kind: 'topic', streamId: '123', textKey: 'bbbbbbbbbbbbbbbb', channel }];
  const results = await Promise.all(proposals.map((body, i) => request('/internal/reserve', { method: 'POST', body, headers: headers[i] })));
  assert.equal(results.filter(x => x.data.ok).length, 1);
  const index = results.findIndex(x => x.data.ok), reservationId = results[index].data.reservationId;
  assert.equal((await request('/internal/begin', { method: 'POST', body: { reservationId }, headers: headers[index] })).data.ok, true);
  assert.equal((await request('/internal/begin', { method: 'POST', body: { reservationId }, headers: headers[index] })).data.ok, false);
  assert.equal((await request('/internal/finish', { method: 'POST', body: { reservationId, delivery: 'confirmed', submitted: true }, headers: headers[1 - index] })).status, 403);
  assert.equal((await request('/internal/finish', { method: 'POST', body: { reservationId, delivery: 'confirmed', submitted: true }, headers: headers[index] })).data.ok, true);
});

test('public controls accept one boolean setting and leave other settings unchanged', async t => {
  const { request } = await harness(t);
  const headers = { ...browser, 'X-CSRF-Token': 'test-csrf' };
  const control = body => request('/api/control', { method: 'POST', body, headers });
  const status = async () => (await request('/api/status', { headers: browser })).data;
  assert.equal((await status()).exchanges.enabled, false);
  assert.equal((await control({ paused: true })).status, 200);
  assert.equal((await control({ exchangesEnabled: true })).status, 200);
  let state = await status();
  assert.equal(state.paused, true, 'enabling exchanges cannot resume central coordination');
  assert.equal(state.exchanges.enabled, true);
  assert.equal(state.clients.every(c => !c.connected && !c.ready), true, 'a control cannot arm a stopped companion');
  assert.equal((await control({ paused: false })).status, 200);
  state = await status(); assert.equal(state.paused, false); assert.equal(state.exchanges.enabled, true);
  assert.equal((await control({ exchangesEnabled: false })).status, 200);
  state = await status(); assert.equal(state.paused, false); assert.equal(state.exchanges.enabled, false);
});

test('malformed or combined controls do not partially mutate either setting', async t => {
  const { request } = await harness(t), headers = { ...browser, 'X-CSRF-Token': 'test-csrf' };
  const invalid = [{}, { paused: true, exchangesEnabled: true }, { paused: true, extra: false },
    { exchangesEnabled: true, extra: false }, { exchangesEnabled: 'true' }, { exchangesEnabled: 1 },
    { exchangesEnabled: null }, { paused: 'false' }, { forceSend: true }, { ['__proto__']: true }];
  for (const body of invalid) {
    const result = await request('/api/control', { method: 'POST', body, headers });
    assert.equal(result.status, 400, JSON.stringify(body));
    const state = (await request('/api/status', { headers: browser })).data;
    assert.equal(state.paused, false, JSON.stringify(body));
    assert.equal(state.exchanges.enabled, false, JSON.stringify(body));
  }
});

test('exchange control keeps origin and CSRF isolation and has no send shortcut', async t => {
  const { request } = await harness(t);
  for (const headers of [browser, paired, { ...browser, 'X-CSRF-Token': 'wrong' },
    { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site', 'X-CSRF-Token': 'test-csrf' }]) {
    assert.equal((await request('/api/control', { method: 'POST', body: { exchangesEnabled: true }, headers })).status, 403);
  }
  assert.equal((await request('/api/status', { headers: browser })).data.exchanges.enabled, false);
  for (const path of ['/api/exchanges/send', '/api/exchanges/force', '/api/exchanges/fast-forward']) {
    assert.equal((await request(path, { headers: browser })).status, 404);
  }
});

test('account pages and API keep the same local-only origin and CSRF boundaries', async t => {
  let reads = 0; const calls = [];
  const { request } = await harness(t, { accounts: {
    snapshot: async () => { reads++; return { updatedAt: new Date().toISOString(), instances: [] }; },
    command: async (id, body) => { calls.push({ id, body }); return { ok: true, command: { id: 'command-1', state: 'queued' } }; }
  } });
  for (const path of ['/accounts', '/accounts/primary', '/accounts/test', '/accounts.js', '/accounts.css']) assert.equal((await request(path)).status, 200, path);
  for (const headers of [{}, { Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request('/api/accounts', { headers })).status, 403);
  assert.equal(reads, 0);
  const snapshot = await request('/api/accounts', { headers: browser }); assert.equal(snapshot.status, 200); assert.equal(snapshot.data.csrfToken, 'test-csrf');
  const body = { requestId: 'owner-stop-1', action: 'stop', params: {} };
  for (const headers of [browser, paired, { ...browser, 'X-CSRF-Token': 'wrong' }]) assert.equal((await request('/api/accounts/test/command', { method: 'POST', body, headers })).status, 403);
  assert.equal(calls.length, 0);
  const accepted = await request('/api/accounts/test/command', { method: 'POST', body, headers: { ...browser, 'X-CSRF-Token': 'test-csrf' } });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.command.state, 'queued'); assert.deepEqual(calls, [{ id: 'test', body }]);
  assert.equal((await request('/api/accounts/foreign/command', { headers: browser })).status, 404);
  assert.equal((await request('/api/accounts/test/command', { headers: browser })).status, 405);
  assert.equal((await request('/api/accounts', { headers: { ...browser, Host: 'evil.example:8795' } })).status, 403);
});
