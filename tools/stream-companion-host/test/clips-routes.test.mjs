import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostStore } from '../lib/store.mjs';
import { createHostServer, REMOTE_PREFIX } from '../server.mjs';

const clients = [{ id: 'primary', account: 'first_account', token: 'a'.repeat(48) }];
const remoteToken = 'clip-route-remote-fixture-'.repeat(3), csrfToken = 'clip-route-csrf-fixture';
async function fixture(t) {
  const calls = [], store = new HostStore({ file: ':memory:', clients });
  const clips = { snapshot: () => ({ ok: true, jobs: [], settings: { enabled: false } }), permit: (id, body) => { calls.push({ action: 'permit', id, body }); return { ok: true }; } };
  for (const action of ['configure', 'create', 'authorize']) clips[action] = async body => { calls.push({ action, body }); return { ok: true }; };
  const server = createHostServer({ store, clients, clips, remoteToken, csrfToken,
    readFileImpl: async () => Buffer.from('fixture asset'), accounts: { snapshot: async () => ({ instances: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const defaultHeaders = { Host: '127.0.0.1:8795', Origin: 'http://127.0.0.1:8795', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers };
    for (const key of Object.keys(defaultHeaders)) if (defaultHeaders[key] === null) delete defaultHeaders[key];
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: defaultHeaders }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, data }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { calls, request, store };
}

test('clip reads are side-effect free and local/remote mutations need pairing, origin and CSRF', async t => {
  const f = await fixture(t);
  for (const prefix of ['', REMOTE_PREFIX]) {
    const remote = prefix ? { Authorization: `Bearer ${remoteToken}` } : {};
    const readsBefore = f.calls.length;
    const read = await f.request(prefix + '/api/clips', { headers: remote });
    assert.equal(read.status, 200); assert.equal(read.data.csrfToken, csrfToken); assert.equal(f.calls.length, readsBefore);
    for (const [suffix, action] of [['settings', 'configure'], ['create', 'create'], ['authorization', 'authorize']]) {
      const path = prefix + '/api/clips/' + suffix;
      const before = f.calls.length;
      assert.equal((await f.request(path, { headers: remote })).status, 405);
      assert.equal((await f.request(path, { method: 'POST', body: {}, headers: remote })).status, 403);
      assert.equal((await f.request(path, { method: 'POST', body: {}, headers: { ...remote, 'X-CSRF-Token': csrfToken, Origin: 'https://outside.example' } })).status, 403);
      assert.equal(f.calls.length, before);
      assert.equal((await f.request(path, { method: 'POST', body: { fixture: suffix }, headers: { ...remote, 'X-CSRF-Token': csrfToken } })).status, 200);
      assert.deepEqual(f.calls.at(-1), { action, body: { fixture: suffix } });
    }
    for (const path of ['/clips.js', '/clips.css']) assert.equal((await f.request(prefix + path, { headers: remote })).status, 200);
  }
  assert.equal((await f.request(REMOTE_PREFIX + '/api/clips')).status, 403);
  assert.equal((await f.request('/api/clips', { headers: { Origin: 'https://outside.example' } })).status, 403);
  assert.equal(f.store.paused, false);
});


test('final clip permit is private helper-only and cannot be reached through the remote prefix', async t => {
  const f = await fixture(t), body = { requestId: 'clip-moment' };
  const internal = { Authorization: `Bearer ${clients[0].token}`, 'X-Companion-Id': 'primary', Origin: null, 'Sec-Fetch-Site': null };
  assert.equal((await f.request('/internal/clips/permit', { method: 'POST', body, headers: internal })).status, 200);
  assert.deepEqual(f.calls.at(-1), { action: 'permit', id: 'primary', body });
  const before = f.calls.length;
  assert.equal((await f.request('/internal/clips/permit', { method: 'POST', body, headers: { ...internal, Origin: 'http://127.0.0.1:8795' } })).status, 403);
  assert.equal((await f.request('/internal/clips/permit', { method: 'POST', body, headers: { ...internal, Authorization: `Bearer ${remoteToken}` } })).status, 403);
  assert.equal((await f.request(REMOTE_PREFIX + '/internal/clips/permit', { method: 'POST', body, headers: { Authorization: `Bearer ${remoteToken}`, 'X-CSRF-Token': csrfToken } })).status, 404);
  assert.equal(f.calls.length, before);
});
