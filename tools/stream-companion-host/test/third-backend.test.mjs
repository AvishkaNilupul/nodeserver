import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HostStore } from '../lib/store.mjs';
import { createClipController } from '../lib/clips.mjs';
import { createHostServer, REMOTE_PREFIX } from '../server.mjs';
import { validateCommand } from '../lib/accounts.mjs';
import { EXCHANGE_POLICY } from '../lib/exchanges.mjs';

const IDS = ['primary', 'test', 'third'], NOW = 1800000000000;
const clients = IDS.map((id, i) => ({ id, account: `${id}_companion`, token: String.fromCharCode(97 + i).repeat(48) }));
function clipsFixture(t) {
  let time = NOW, paused = true;
  const store = new HostStore({ file: ':memory:', clients, now: () => time });
  const messages = [], calls = [], clipStates = new Map(clients.map(c => [c.id, { ok: true, authorized: true, account: c.account, jobs: [] }]));
  const patches = new Map();
  const accounts = {
    async snapshot() { return { instances: clients.map(c => ({ id: c.id, account: c.account, available: true, authorized: true,
      connected: !paused, channel: 'live_channel', settings: { allowedChannel: 'live_channel', paused },
      browser: { online: true, lastSeenAt: time }, watch: { enabled: true, channel: 'live_channel', status: 'playing', checkedAt: time },
      streamContext: { channel: 'live_channel', streamId: '123', checkedAt: time, isLive: true },
      coordination: { available: true, paused }, controls: { pending: null }, chat: { messages }, ...patches.get(c.id) })) }; },
    async clipStatus(id) { return structuredClone(clipStates.get(id)); },
    async clipCreate(id, body) {
      calls.push({ id, body });
      const job = { ...body, account: clipStates.get(id).account, createdAt: time, updatedAt: time, state: 'queued', clipId: '', url: '', error: '' };
      clipStates.get(id).jobs.push(job); return { ok: true, job };
    },
    async clipAuthorization(id) { return { ok: true, pending: true, account: clipStates.get(id).account, pollAfterMs: 5000 }; }
  };
  const controller = createClipController({ db: store.db, accounts, isPaused: () => paused, now: () => time });
  t.after(async () => { await controller.close(); store.close(); });
  return { controller, clipStates, patches, messages, calls, get time() { return time; }, advance(ms) { time += ms; }, resume() { paused = false; } };
}

test('three creator subsets stay exact and manual creation still chooses only one account', async t => {
  const f = clipsFixture(t), c = f.controller;
  for (let mask = 1; mask < 8; mask++) {
    const accountIds = IDS.filter((_, i) => mask & (1 << i));
    c.configure({ enabled: true, channel: 'live_channel', accountIds });
    assert.deepEqual(c.snapshot().settings.accountIds, accountIds);
  }
  assert.throws(() => c.configure({ enabled: true, channel: 'live_channel', accountIds: [...IDS, 'fourth'] }));
  assert.throws(() => c.configure({ enabled: true, channel: 'live_channel', accountIds: ['third', 'third'] }));
  const result = await c.create({ requestId: 'third-moment', channel: 'live_channel', accountIds: ['third'] });
  assert.equal(result.job.accountId, 'third'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'third');
  const duplicate = await c.create({ requestId: 'all-same-moment', channel: 'live_channel', accountIds: IDS });
  assert.equal(duplicate.job.requestId, result.job.requestId); assert.equal(f.calls.length, 1);
  const state = c.snapshot(); assert.deepEqual(state.accounts.map(a => a.id), IDS); assert.equal(state.accounts[2].canAuthorize, true);
});

test('the third companion cannot become human highlight evidence when unavailable', async t => {
  const f = clipsFixture(t); f.resume(); f.controller.configure({ enabled: true, channel: 'live_channel', accountIds: ['primary', 'test'] });
  await f.controller.tick(); f.advance(90000);
  f.patches.set('third', { available: false }); f.clipStates.delete('third');
  for (let i = 0; i < 8; i++) f.messages.push({ id: `third-${i}`, author: 'third_companion', text: 'wow', at: f.time - i * 100, channel: 'live_channel' });
  for (let i = 0; i < 3; i++) f.messages.push({ id: `few-viewers-${i}`, author: `viewer_${i}`, text: 'wow', at: f.time - i * 100, channel: 'live_channel' });
  await f.controller.tick(); assert.equal(f.calls.length, 0); assert.equal(f.controller.snapshot().accounts[2].available, false);
  for (let i = 0; i < 8; i++) f.messages.push({ id: `viewers-${i}`, author: `other_${i % 4}`, text: 'wow', at: f.time - i * 100, channel: 'live_channel' });
  await f.controller.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.source, 'automatic');
});

test('a third automatic creator receives only its own final permission', async t => {
  const f = clipsFixture(t); f.resume();
  f.patches.set('primary', { connected: false }); f.patches.set('test', { connected: false });
  f.controller.configure({ enabled: true, channel: 'live_channel', accountIds: IDS });
  await f.controller.tick(); f.advance(90000);
  for (let i = 0; i < 8; i++) f.messages.push({ id: `viewer-${i}`, author: `viewer_${i % 4}`, text: 'wow', at: f.time - i * 100, channel: 'live_channel' });
  await f.controller.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'third');
  const requestId = f.controller.snapshot().jobs[0].requestId;
  assert.equal(f.controller.permit('primary', { requestId }).ok, false);
  assert.equal(f.controller.permit('third', { requestId }).ok, true);
  assert.equal(f.controller.permit('third', { requestId }).ok, false);
});

test('third live presence leaves the original pair exchange eligible and never substitutes for a missing original', t => {
  let time = NOW;
  const store = new HostStore({ file: ':memory:', clients, now: () => time, random: () => 0 }); t.after(() => store.close());
  const sync = (id, extra = {}) => store.sync(id, { channel: 'live_channel', connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, exchangeContext: { streamId: id === 'third' ? '999' : '123', checkedAt: time, lastHumanAt: 0 }, ...extra });
  for (const id of IDS) sync(id);
  store.setExchangesEnabled(true);
  const schedule = store.status().exchanges.channels.find(x => x.channel === 'live_channel');
  assert.equal(Date.parse(schedule.nextAt) - time, EXCHANGE_POLICY.intervalMinMs);
  const due = Date.parse(schedule.nextAt);
  while (time < due) { time = Math.min(time + 20000, due); for (const id of IDS) sync(id); }
  const offers = IDS.map(id => ({ id, offer: store.snapshot(id, 'live_channel').exchange })).filter(x => x.offer);
  assert.equal(offers.length, 1); assert.ok(['primary', 'test'].includes(offers[0].id));
  assert.match(offers[0].offer.text, /@(primary|test)_companion/);
  assert.equal(store.snapshot('third', 'live_channel').exchange, undefined);
  sync('primary', { connected: false });
  for (const id of IDS) assert.equal(store.snapshot(id, 'live_channel').exchange, undefined);
});

async function hostFixture(t) {
  const calls = [], store = new HostStore({ file: ':memory:', clients });
  const remoteToken = 'third-remote-fixture-token-'.repeat(3), csrfToken = 'third-csrf';
  const accounts = { snapshot: async () => ({ updatedAt: new Date().toISOString(), instances: clients.map(c => ({ id: c.id, browser: {} })) }),
    command: async (id, input) => { validateCommand(input); calls.push({ action: 'command', id, input }); return { ok: true }; } };
  const browserLauncher = { available: id => id === 'third', open: async (id, requestId) => { calls.push({ action: 'browser', id, requestId }); return { ok: true, state: 'opening' }; } };
  const server = createHostServer({ store, clients, accounts, browserLauncher, remoteToken, csrfToken, readFileImpl: async () => Buffer.from('<main>Fixture account</main>') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: '127.0.0.1:8795', Origin: 'http://127.0.0.1:8795', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, data }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { calls, request, remoteToken, csrfToken };
}

test('third page, browser and command routes stay finite and protected locally and remotely', async t => {
  const f = await hostFixture(t);
  for (const prefix of ['', REMOTE_PREFIX]) {
    const remote = prefix ? { Authorization: `Bearer ${f.remoteToken}` } : {};
    const mutation = { ...remote, 'X-CSRF-Token': f.csrfToken };
    const before = f.calls.length;
    assert.equal((await f.request(prefix + '/accounts/third', { headers: remote })).status, 200);
    assert.equal(f.calls.length, before, 'page reads do not open or start the third companion');
    const command = { requestId: 'third-stop', action: 'stop', params: {} };
    assert.equal((await f.request(prefix + '/api/accounts/third/command', { method: 'POST', body: command, headers: remote })).status, 403);
    assert.equal((await f.request(prefix + '/api/accounts/third/command', { method: 'POST', body: command, headers: mutation })).status, 200);
    assert.deepEqual(f.calls.at(-1), { action: 'command', id: 'third', input: command });
    assert.equal((await f.request(prefix + '/api/accounts/third/browser', { method: 'POST', body: { requestId: 'third-open' }, headers: mutation })).status, 200);
    assert.deepEqual(f.calls.at(-1), { action: 'browser', id: 'third', requestId: 'third-open' });
    const after = f.calls.length;
    for (const path of ['/api/accounts/fourth/browser', '/api/accounts/third/browser/', '/api/accounts/third/browser?x=1']) {
      assert.ok((await f.request(prefix + path, { method: 'POST', body: { requestId: 'no-action' }, headers: mutation })).status >= 400);
    }
    assert.equal(f.calls.length, after);
  }
  assert.equal((await f.request(REMOTE_PREFIX + '/accounts/third')).status, 403);
  const state = await f.request('/api/accounts'); assert.equal(state.data.instances[2].browser.canOpen, true);
});
