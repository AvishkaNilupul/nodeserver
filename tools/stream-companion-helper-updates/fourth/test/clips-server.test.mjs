import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHelper } from '../server.mjs';

async function fixture(t) {
  const calls = [], twitch = { status: () => ({}), disconnect: () => {} };
  const clips = { status: () => { calls.push('status'); return { ok: true, account: 'companion_test', authorized: false, jobs: [] }; },
    create: body => { calls.push(['create', body]); return { ok: true, job: { state: 'queued' } }; },
    authorization: body => { calls.push(['authorization', body]); return { ok: true, pending: true, pollAfterMs: 5000 }; }, close: () => {} };
  const server = createHelper({ config: { extensionId: 'unit-test', pairingToken: 'local-test' }, twitch, clips });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, body = {}, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path,
      headers: { Host: '127.0.0.1:8797', Origin: 'chrome-extension://unit-test', Authorization: 'Bearer local-test', 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', value => { text += value; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body) : undefined);
  });
  return { calls, request };
}

test('all clip endpoints keep loopback, extension-origin, token and POST pairing boundaries', async t => {
  const h = await fixture(t);
  for (const path of ['/api/clips/status', '/api/clips/create', '/api/clips/authorization']) {
    assert.equal((await h.request(path, {}, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await h.request(path, {}, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await h.request(path, {}, { Host: 'evil.invalid' })).status, 403);
    assert.equal((await h.request(path, {}, {}, 'GET')).status, 404);
  }
  assert.equal(h.calls.length, 0);
});

test('paired clip status is read only and creation/authorization use separate typed handlers', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/api/clips/status')).body.authorized, false);
  assert.equal((await h.request('/api/clips/status', { extra: true })).status, 400);
  const clip = { requestId: 'test-moment', channel: 'friend_channel', streamId: '123', source: 'manual' };
  assert.equal((await h.request('/api/clips/create', clip)).body.job.state, 'queued');
  assert.equal((await h.request('/api/clips/authorization', { action: 'start' })).body.pending, true);
  assert.deepEqual(h.calls, ['status', ['create', clip], ['authorization', { action: 'start' }]]);
});
