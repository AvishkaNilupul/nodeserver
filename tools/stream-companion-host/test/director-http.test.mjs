import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostStore } from '../lib/store.mjs';
import { createHostServer } from '../server.mjs';
import { digest } from '../lib/bank.mjs';

const clients = ['primary', 'test', 'third'].map((id, i) => ({ id, account: `${id}_account`, token: String(i + 1).repeat(48) }));
const remoteToken = 'test-only-private-remote-pairing'.repeat(2);
async function fixture(t) {
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true });
  const server = createHostServer({ store, clients, port: 0, csrfToken: 'test-csrf', remoteToken,
    accounts: { snapshot: async () => ({ instances: [] }), command: async (_, body) => ({ ok: true, command: { id: body.requestId } }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const port = server.address().port;
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, data }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { store, request, browser: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, paired: { Authorization: `Bearer ${clients[0].token}`, 'X-Companion-Id': 'primary' } };
}

test('director routes retain origin, CSRF, private pairing, remote exact paths and response bounds', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/director')).status, 403);
  const status = await f.request('/api/director', { headers: f.browser }); assert.equal(status.status, 200); assert.equal(status.data.csrfToken, 'test-csrf');
  const input = { requestId: 'bank-http', expectedRevision: status.data.revision, bank: status.data.bank };
  assert.equal((await f.request('/api/director/bank', { method: 'POST', headers: f.browser, body: input })).status, 403);
  const saved = await f.request('/api/director/bank', { method: 'POST', headers: { ...f.browser, 'X-CSRF-Token': 'test-csrf' }, body: input }); assert.equal(saved.status, 200);
  const fresh = await f.request('/api/director', { headers: f.browser }); assert.deepEqual(fresh.data.lastMutation, { requestId: 'bank-http', revision: saved.data.revision });
  assert.equal(JSON.stringify(fresh.data).includes('authorityEpoch'), false); assert.ok(Buffer.byteLength(JSON.stringify(fresh.data)) < 262144);
  for (const path of ['/api/director?all=true', '/api/director/history/foreign/0', '/api/director/retry', '/api/director/force', '/api/director/clear']) assert.equal((await f.request(path, { headers: f.browser })).status, 404, path);
  assert.equal((await f.request('/api/director/history/all/0', { headers: f.browser })).status, 200);
  assert.equal((await f.request('/admin/stream-companion/api/director', { headers: f.browser })).status, 403);
  assert.equal((await f.request('/admin/stream-companion/api/director', { headers: { ...f.browser, Authorization: `Bearer ${remoteToken}` } })).status, 200);
  assert.equal((await f.request('/admin/stream-companion/internal/director/import', { method: 'POST', headers: { ...f.paired, Authorization: `Bearer ${remoteToken}` }, body: {} })).status, 404);
});

test('paired migration endpoint accepts own durable pages and refuses browser-origin or foreign account records', async t => {
  const f = await fixture(t), records = [], body = { source: 'helper', importId: 'helper-import', page: 0, final: true, records, digest: digest(JSON.stringify({ records, preferences: null })) };
  assert.equal((await f.request('/internal/director/import', { method: 'POST', body, headers: f.browser })).status, 403);
  assert.equal((await f.request('/internal/director/import', { method: 'POST', body, headers: { ...f.paired, ...f.browser } })).status, 403);
  const accepted = await f.request('/internal/director/import', { method: 'POST', body, headers: f.paired }); assert.equal(accepted.status, 200); assert.equal(accepted.data.complete, true);
  assert.deepEqual((await f.request('/internal/director/import', { method: 'POST', body, headers: f.paired })).data, accepted.data);
  const bad = [{ recordId: 'a'.repeat(64), type: 'handled', key: 'test_account:friend_channel:message-one' }];
  const foreign = { source: 'browser', importId: 'browser-import', page: 0, final: true, records: bad, digest: digest(JSON.stringify({ records: bad, preferences: null })) };
  assert.equal((await f.request('/internal/director/import', { method: 'POST', body: foreign, headers: f.paired })).status, 403);
  assert.equal(f.store.director.imports('primary').browser, false);
});

test('maximal legal account control identifiers never collide when central preferences are recorded', async t => {
  const f = await fixture(t), headers = { ...f.browser, 'X-CSRF-Token': 'test-csrf' }, prefix = 'x'.repeat(159);
  for (const [suffix, chatMode] of [['a', 'participate'], ['b', 'mentions']]) {
    const result = await f.request('/api/accounts/primary/command', { method: 'POST', headers, body: { requestId: prefix + suffix, action: 'settings', params: { chatMode, replySource: 'local', autoResume: false } } });
    assert.equal(result.status, 200); assert.equal(f.store.director.profile('primary').chatMode, chatMode);
  }
});
