import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHelper } from '../server.mjs';

// These credentials exist only in this test. No runtime configuration, OAuth
// files, Twitch sockets, or non-loopback network endpoints are used.
const CONFIGS = [
  { extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pairingToken: 'isolation-test-first' },
  { extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', pairingToken: 'isolation-test-second' }
];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fakeTwitch(label) {
  const state = { account: '', channel: '', connected: false, history: [], disconnects: 0 };
  const calls = [];
  let heldConnection;
  const snapshot = () => structuredClone(state);
  const twitch = {
    status() { calls.push('status'); return snapshot(); },
    async connect(account, channel) {
      calls.push('connect');
      const held = heldConnection; heldConnection = undefined;
      if (held) { held.started.resolve(); await held.release.promise; }
      Object.assign(state, { account, channel, connected: true });
      return snapshot();
    },
    disconnect() {
      calls.push('disconnect');
      Object.assign(state, { connected: false, channel: '', disconnects: state.disconnects + 1 });
    },
    send(input) {
      calls.push('send');
      assert.equal(state.connected, true, 'fake Twitch must be connected before a test send');
      assert.equal(input.account, state.account);
      assert.equal(input.channel, state.channel);
      const { beforeSubmit, ...publicInput } = input;
      beforeSubmit?.();
      const item = { ...publicInput, messageId: `${label}-${state.history.length + 1}`, delivery: 'confirmed' };
      state.history.push(item);
      return structuredClone(item);
    },
    startAuthorization() { calls.push('authorize'); return { fake: true }; },
    pollAuthorization() { calls.push('authorization'); return { fake: true }; },
    inspectChannel() { calls.push('channel'); return { fake: true }; }
  };
  return {
    twitch, calls, snapshot,
    holdNextConnection() {
      assert.equal(heldConnection, undefined);
      heldConnection = { started: deferred(), release: deferred() };
      return heldConnection;
    }
  };
}

async function helper(t, config, fake) {
  const server = createHelper({ config, twitch: fake.twitch,
    generateImpl: async () => { throw new Error('Model generation must not run in isolation tests.'); } });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(close);
  const port = server.address().port;
  const request = (path, body = {}, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    // Provision an explicit central manual command in this transport fixture;
    // production rejects these operations without their paired plan identity.
    if (path === '/api/twitch/connect' || path === '/api/twitch/send') {
      body = { ...body, controlGeneration: body.controlGeneration || server.control.generation,
        controlSessionId: body.controlSessionId || server.control.sessionId };
      if (path === '/api/twitch/send') {
        const binding = { generation: body.controlGeneration, sessionId: body.controlSessionId, settingsRevision: 0 };
        const plan = { planId: `isolation-plan-${fake.snapshot().history.length}`, authorityEpoch: 'isolation-authority', source: 'manual',
          account: body.account, channel: body.channel, text: body.text, binding };
        fake.twitch.coordinator = { currentPlan: id => id === plan.planId ? plan : null };
        body = { ...body, settingsRevision: 0, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding };
      }
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { Host: '127.0.0.1:8797', Origin: `chrome-extension://${config.extensionId}`,
        Authorization: `Bearer ${config.pairingToken}`, 'Content-Type': 'application/json', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Local isolation test request timed out.')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  await request('/api/control/bridge', { sessionId: `isolation-${config.extensionId}`, controlGeneration: server.control.generation,
    state: { settings: { revision: 0, paused: false, autoReply: false } } });
  return { server, port, request, close };
}

async function pair(t) {
  const fakes = [fakeTwitch('first'), fakeTwitch('second')];
  const helpers = await Promise.all(CONFIGS.map((config, i) => helper(t, config, fakes[i])));
  assert.notEqual(helpers[0].port, helpers[1].port);
  return { fakes, helpers };
}

test('disconnecting, closing and restarting the second helper preserves the first live state', async t => {
  const { fakes: [first, second], helpers: [a, b] } = await pair(t);
  const firstIdentity = { account: 'first_account', channel: 'first_channel' };
  const secondIdentity = { account: 'second_account', channel: 'second_channel' };
  assert.equal((await a.request('/api/twitch/connect', firstIdentity)).status, 200);
  assert.equal((await b.request('/api/twitch/connect', secondIdentity)).status, 200);
  assert.equal((await a.request('/api/twitch/send', { ...firstIdentity, text: 'first fake message' })).status, 200);
  assert.equal((await b.request('/api/twitch/send', { ...secondIdentity, text: 'second fake message' })).status, 200);
  const original = first.snapshot();

  assert.equal((await b.request('/api/twitch/disconnect')).status, 200);
  assert.equal(second.snapshot().connected, false);
  assert.deepEqual((await a.request('/api/twitch/status')).data, original);
  assert.equal((await b.request('/api/twitch/connect', { ...secondIdentity, channel: 'new_second_channel' })).status, 409, 'Stop holds even a later unbound connect');
  const bridge = await b.request('/api/control/bridge', { sessionId: 'second-isolation-session' });
  assert.equal((await b.request('/api/twitch/connect', { ...secondIdentity, channel: 'new_second_channel', explicitStart: true,
    controlGeneration: bridge.data.intent.generation, controlSessionId: 'second-isolation-session' })).status, 200);
  assert.deepEqual(first.snapshot(), original);

  await b.close();
  assert.equal(second.snapshot().connected, false, 'server close disconnects its own fake client');
  assert.equal(second.snapshot().disconnects, 3, 'Stop, explicit native reconnect disarm, and server close affect only this instance');
  assert.deepEqual((await a.request('/api/twitch/status')).data, original);
  const restarted = await helper(t, CONFIGS[1], second);
  assert.equal((await restarted.request('/api/twitch/connect', secondIdentity)).status, 200);
  assert.deepEqual((await a.request('/api/twitch/status')).data, original);
  assert.equal((await a.request('/api/twitch/send', { ...firstIdentity, text: 'first still works' })).status, 200);
  assert.equal(first.snapshot().history.length, 2);
  assert.equal(second.snapshot().history.length, 1);
  assert.equal(first.snapshot().disconnects, 0);
});

test('each helper rejects the other instance origin and pairing token before dispatch', async t => {
  const { fakes, helpers } = await pair(t);
  const paths = ['/api/twitch/status', '/api/twitch/connect', '/api/twitch/disconnect',
    '/api/twitch/send', '/api/twitch/channel', '/api/twitch/authorize', '/api/twitch/authorization', '/api/compose',
    '/api/director/import', '/api/director/sync', '/api/director/draft', '/api/director/manual', '/api/director/preferences'];
  for (let i = 0; i < helpers.length; i++) {
    const own = CONFIGS[i], other = CONFIGS[1 - i];
    const h = helpers[i];
    for (const path of paths) {
      const wrongOrigin = await h.request(path, {}, { Origin: `chrome-extension://${other.extensionId}` });
      assert.equal(wrongOrigin.status, 403, `${i} ${path} rejects another extension`);
      assert.equal(wrongOrigin.headers['access-control-allow-origin'], undefined);
      assert.equal((await h.request(path, {}, { Authorization: `Bearer ${other.pairingToken}` })).status, 401,
        `${i} ${path} rejects another token with its own origin`);
      assert.equal((await h.request(path, {}, { Origin: `chrome-extension://${other.extensionId}`,
        Authorization: `Bearer ${other.pairingToken}` })).status, 403);
      assert.equal((await h.request(path, {}, { Host: '127.0.0.1:8792' })).status, 403);
    }
    assert.equal((await h.request('/api/twitch/connect', {}, {
      Origin: `chrome-extension://${other.extensionId}` }, 'OPTIONS')).status, 403);
    const preflight = await h.request('/api/twitch/connect', {}, {}, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], `chrome-extension://${own.extensionId}`);
    assert.deepEqual(fakes[i].calls, [], 'rejected requests cannot invoke even read-only fake methods');
    assert.equal((await h.request('/api/twitch/status')).status, 200, 'its own pairing still works');
  }
});

test('pending connection work and disconnect cancellation are local to their helper instance', async t => {
  const { fakes: [first, second], helpers: [a, b] } = await pair(t);
  const firstIdentity = { account: 'first_account', channel: 'first_channel' };
  const secondIdentity = { account: 'second_account', channel: 'second_channel' };
  const held = first.holdNextConnection();
  t.after(() => held.release.resolve());
  const connecting = a.request('/api/twitch/connect', firstIdentity);
  await held.started.promise;

  // Observe receipt of the queued first-instance send without reaching into
  // the helper's private serial queue or waiting on wall-clock sleeps.
  const received = deferred();
  const observe = req => {
    if (req.url === '/api/twitch/send') req.once('end', () => received.resolve());
  };
  a.server.on('request', observe);
  const sending = a.request('/api/twitch/send', { ...firstIdentity, text: 'queued first fake message' });
  await received.promise;
  a.server.off('request', observe);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.calls.includes('send'), false, 'first send is held behind its own connect');

  // The second instance must remain usable despite the first instance's lock,
  // and its generation change must not invalidate the first instance's queue.
  assert.equal((await b.request('/api/twitch/connect', secondIdentity)).status, 200);
  assert.equal((await b.request('/api/twitch/disconnect')).status, 200);
  assert.equal(second.snapshot().connected, false);
  held.release.resolve();
  assert.equal((await connecting).status, 200);
  const sent = await sending;
  assert.equal(sent.status, 200);
  assert.equal(sent.data.delivery, 'confirmed');
  assert.equal(first.snapshot().connected, true);
  assert.equal(first.snapshot().disconnects, 0);
  assert.equal(first.snapshot().history.length, 1);
});
